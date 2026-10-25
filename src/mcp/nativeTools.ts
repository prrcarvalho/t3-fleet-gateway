import * as z from 'zod';
import type { GatewayConfig, HostConfig } from '../config.ts';
import { GatewayError } from '../errors.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import { READ_SCOPE } from '../oauth/scopes.ts';
import { readableHost } from './hostAccess.ts';
import { defineTool, type ToolContext } from './tools.ts';

const GROUPS = ['environment', 'project', 'thread', 'worktree', 'queue', 'pending_request'] as const;
type NativeGroup = (typeof GROUPS)[number];

/**
 * The only T3 tools agents reach through fleet_t3_call, by exact name; every other name is refused, including tools a
 * later T3 adds. Each is wrapped by T3's `McpToolAccess.reads`, so it changes nothing for a client outside a thread
 * (`t3_thread_read` is annotated not read-only for a side effect that applies to thread callers only). Left out on
 * purpose: `t3_thread_wait` (blocks far past the client timeout), `t3_worktree_status` (thread-only), every write
 * (launch, send, interrupt and respond are what the work_* tools exist for) and thread-only, PR and scheduler tools.
 * The gateway's credential is usually full-access, so this table is the only barrier in front of it.
 */
const NATIVE_READ_TOOLS: ReadonlyMap<string, NativeGroup> = new Map([
  ['t3_environment_read', 'environment'],
  ['t3_project_list', 'project'],
  ['t3_project_read', 'project'],
  ['t3_thread_list', 'thread'],
  ['t3_thread_read', 'thread'],
  ['t3_thread_search', 'thread'],
  ['t3_thread_configuration', 'thread'],
  ['t3_thread_transfers', 'thread'],
  ['t3_worktree_list', 'worktree'],
  ['t3_queue_list', 'queue'],
  ['t3_queue_read', 'queue'],
  ['t3_pending_request_list', 'pending_request'],
  ['t3_pending_request_read', 'pending_request'],
]);

/** Results above this, serialized, are refused rather than cut: the agent asks for less. */
export const MAX_NATIVE_RESULT_BYTES = 256 * 1024;

const NOTE =
  'Thread-only tools (delegation, browser preview, devices, HTML) exist only inside T3 threads: reach them by starting work with an ' +
  'outcome (work_start), not by naming tools. Writes go through the work_* tools.';

const hostInput = z.string().min(1).max(32).describe('Host id from fleet_status');

const nativeToolSchema = z.object({
  name: z.string().describe('Pass as tool to fleet_t3_call'),
  group: z.enum(GROUPS),
  description: z.string().nullable().describe("T3's own description"),
  inputSchema: z.record(z.string(), z.unknown()).describe('JSON Schema for arguments, as this host advertises it'),
  annotations: z.record(z.string(), z.unknown()).nullable().describe("T3's hints about the tool"),
});

export interface NativeToolDeps {
  config: GatewayConfig;
  registry: HostRegistry;
}

/** Authorization, then the host's opt-out, before anything reaches the registry or T3. */
function nativeHost(deps: NativeToolDeps, context: ToolContext, hostId: string): HostConfig {
  const host = readableHost(deps.config, context, hostId);
  if (!host.nativeReads) {
    throw new GatewayError(
      'native_reads_disabled',
      `Host ${host.id} does not allow native reads (the operator set nativeReads false). Its jobs are still reachable with the work_* tools.`,
    );
  }
  return host;
}

export function nativeTools(deps: NativeToolDeps) {
  const fleetT3Tools = defineTool({
    name: 'fleet_t3_tools',
    title: 'List T3 read tools',
    description:
      "List the T3 read tools you can call on one host through fleet_t3_call, with each tool's input schema read live from that " +
      "host's T3, so arguments always match the version it runs. They read any T3 thread on the host, including threads the " +
      'gateway did not start: list and search threads in a project, read a thread\'s messages or activity, its configuration, ' +
      'queue and pending questions, the host\'s projects and worktrees. missing names tools the gateway allows that this host ' +
      'does not offer (an older or newer T3). Writes are never listed: start, continue, answer and cancel work with the work_* ' +
      'tools. To import a thread the gateway did not launch, use fleet_threads and work_adopt { host, projectId, threadId, requestId } ' +
      '(discovery enabled, plus threads:read and threads:control). A host the operator opted out fails with native_reads_disabled. Read-only.',
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({ host: hostInput }),
    outputSchema: z.object({
      host: z.string(),
      serverVersion: z.string().nullable().describe('The T3 version the host reported'),
      tools: z.array(nativeToolSchema),
      missing: z.array(z.string()).describe('Allowed tools this host does not advertise'),
      note: z.string(),
    }),
    async run(input, context) {
      const host = nativeHost(deps, context, input.host);
      const listed = await deps.registry.client(host.id).listTools();
      const advertised = new Map(listed.tools.map((tool) => [tool.name, tool]));
      const tools = [...NATIVE_READ_TOOLS].flatMap(([name, group]) => {
        const tool = advertised.get(name);
        return tool ? [{ name, group, description: tool.description ?? null, inputSchema: tool.inputSchema, annotations: tool.annotations ?? null }] : [];
      });
      const missing = [...NATIVE_READ_TOOLS.keys()].filter((name) => !advertised.has(name));
      const summary = [
        `${host.id}${listed.serverVersion ? ` (T3 ${listed.serverVersion})` : ''}: ${tools.length} read tool(s) for fleet_t3_call. ${NOTE}`,
        ...tools.map((tool) => `${tool.name} [${tool.group}]: ${tool.description ?? ''}\n  arguments: ${JSON.stringify(tool.inputSchema)}`),
        ...(missing.length > 0 ? [`Not offered by this host: ${missing.join(', ')}`] : []),
      ].join('\n');
      return { structured: { host: host.id, serverVersion: listed.serverVersion, tools, missing, note: NOTE }, summary };
    },
  });

  const fleetT3Call = defineTool({
    name: 'fleet_t3_call',
    title: 'Call a T3 read tool',
    description:
      "Call one T3 read tool on one host and get T3's answer unchanged, for example t3_thread_list { projectId } to find threads, " +
      't3_thread_search { query, projectId } to search them, or t3_thread_read { threadId, view?, afterPosition?, limit?, maxCharsPerItem? } ' +
      'to read one, including threads a person started in the T3 app. fleet_t3_tools lists the tools and their exact input schemas for ' +
      'the host; T3 checks arguments strictly, and its refusals come back as t3_tool_failed with T3\'s own code. Only those read tools ' +
      'are accepted (tool_not_allowed otherwise): send, launch, interrupt and answer through the work_* tools. Import a thread with ' +
      `work_adopt after fleet_threads, not through this tool. Results above ${MAX_NATIVE_RESULT_BYTES / 1024} KiB are refused with invalid_argument: ask for less ` +
      '(a lower limit or maxCharsPerItem) and page. Archived threads are readable by id but T3 does not list or search them. Read-only.',
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({
      host: hostInput,
      tool: z.string().describe('A tool name from fleet_t3_tools'),
      arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments, as its input schema in fleet_t3_tools describes; default {}"),
    }),
    outputSchema: z.object({
      host: z.string(),
      tool: z.string(),
      result: z.unknown().describe("T3's structured result, unchanged"),
    }),
    async run(input, context) {
      if (!NATIVE_READ_TOOLS.has(input.tool)) {
        throw new GatewayError(
          'tool_not_allowed',
          `${JSON.stringify(input.tool.slice(0, 100))} is not a T3 read tool this gateway forwards. Writes go through the work_* tools ` +
            `(work_start, work_adopt, work_continue, work_respond, work_cancel). Allowed: ${[...NATIVE_READ_TOOLS.keys()].join(', ')}.`,
        );
      }
      const host = nativeHost(deps, context, input.host);
      const result = await deps.registry.client(host.id).callTool(input.tool, input.arguments ?? {}, z.unknown(), { readOnly: true });
      const json = JSON.stringify(result) ?? 'null';
      const bytes = Buffer.byteLength(json);
      if (bytes > MAX_NATIVE_RESULT_BYTES) {
        throw new GatewayError(
          'invalid_argument',
          `${input.tool} on host ${host.id} answered with ${Math.ceil(bytes / 1024)} KiB, over the ${MAX_NATIVE_RESULT_BYTES / 1024} KiB limit. ` +
            'Ask for less: lower limit or maxCharsPerItem, and page with the cursor or position the tool returns.',
        );
      }
      return { structured: { host: host.id, tool: input.tool, result }, summary: `${input.tool} on ${host.id}:\n${json}` };
    },
  });

  return [fleetT3Tools, fleetT3Call];
}
