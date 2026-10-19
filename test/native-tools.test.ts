import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { startFakeT3, type FakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway, type TestGateway } from './helpers/gateway.ts';
import { agentWithToken, type Agent } from './helpers/jobs.ts';
import { signIn } from './helpers/oauthFlow.ts';

/** The read tools the gateway forwards, in the order fleet_t3_tools lists them (docs/design.md, "Native read router"). */
const ALLOWED = [
  't3_environment_read',
  't3_project_list',
  't3_project_read',
  't3_thread_list',
  't3_thread_read',
  't3_thread_search',
  't3_thread_configuration',
  't3_thread_transfers',
  't3_worktree_list',
  't3_queue_list',
  't3_queue_read',
  't3_pending_request_list',
  't3_pending_request_read',
];

interface NativeTool {
  name: string;
  group: string;
  description: string | null;
  inputSchema: { type?: string; properties?: Record<string, unknown> };
  annotations: Record<string, unknown> | null;
}

interface ToolsResult {
  host: string;
  serverVersion: string | null;
  tools: NativeTool[];
  missing: string[];
  note: string;
}

interface CallResult<T = Record<string, unknown>> {
  host: string;
  tool: string;
  result: T;
}

interface ThreadReadResult {
  thread: { threadId: string; title: string; creationSource: string; archived: boolean };
  items: { type: string; text: string }[];
}

interface Fleet {
  mini: FakeT3;
  macbook: FakeT3;
  gw: TestGateway;
  /** Fleet-wide Read. */
  agent: Agent;
}

async function startFleet(t: TestContext, options: { macbook?: Record<string, unknown>; macbookOmits?: string[] } = {}): Promise<Fleet> {
  const mini = await startFakeT3();
  const macbook = await startFakeT3({ serverVersion: '9.9.9-synthetic' });
  t.after(() => mini.close());
  t.after(() => macbook.close());
  for (const name of options.macbookOmits ?? []) macbook.omitTools.add(name);
  const gw = await startTestGateway(t, {
    config: {
      hosts: [
        { id: 'mini', t3Url: mini.url, mintPairingCode: mini.mintCommand() },
        { id: 'macbook', t3Url: macbook.url, mintPairingCode: macbook.mintCommand(), ...options.macbook },
      ],
    },
    jobEngine: { autoStart: false },
  });
  await gw.services.registry.enroll('mini');
  await gw.services.registry.enroll('macbook');
  return { mini, macbook, gw, agent: await connect(t, gw, 'read') };
}

async function connect(t: TestContext, gw: TestGateway, access: 'read' | 'operate', hosts?: string[]): Promise<Agent> {
  const signedIn = await signIn(gw.baseUrl, gw.mintApprovalCode, { access, ...(hosts ? { hosts } : {}) });
  return agentWithToken(t, gw.baseUrl, signedIn.clientId, signedIn.tokens.access_token);
}

async function text(agent: Agent, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await agent.client.callTool({ name, arguments: args });
  return (result.content as { type: string; text: string }[]).map((block) => block.text).join('\n');
}

describe('native reads: on by default', () => {
  test('a host without nativeReads lists its read tools and answers reads of threads the gateway did not start', async (t) => {
    const { mini, agent } = await startFleet(t);
    const { threadId: appThread } = mini.startInApp({ projectId: 'project-1', title: 'Synthetic app thread', message: 'Synthetic message typed in the app' });
    const { threadId: archived } = mini.startInApp({ projectId: 'project-1', title: 'Synthetic archived thread', message: 'Synthetic archived message' });
    mini.archiveThread(archived);

    const listed = await agent.call<ToolsResult>('fleet_t3_tools', { host: 'mini' });
    assert.deepEqual(listed.tools.map((tool) => tool.name), ALLOWED);
    assert.deepEqual(listed.missing, []);

    const threads = await agent.call<CallResult<{ threads: { threadId: string; creationSource: string }[] }>>('fleet_t3_call', {
      host: 'mini',
      tool: 't3_thread_list',
      arguments: { projectId: 'project-1' },
    });
    assert.deepEqual(threads.result.threads.map((thread) => [thread.threadId, thread.creationSource]), [[appThread, 'web']], 'archived threads are not listed');

    const read = await agent.call<CallResult<ThreadReadResult>>('fleet_t3_call', { host: 'mini', tool: 't3_thread_read', arguments: { threadId: appThread } });
    assert.deepEqual([read.host, read.tool, read.result.thread.title], ['mini', 't3_thread_read', 'Synthetic app thread']);
    assert.deepEqual(read.result.items.map((item) => item.text), ['Synthetic message typed in the app']);
    const byId = await agent.call<CallResult<ThreadReadResult>>('fleet_t3_call', { host: 'mini', tool: 't3_thread_read', arguments: { threadId: archived } });
    assert.equal(byId.result.thread.archived, true, 'an archived thread is still readable by id');

    const summary = await text(agent, 'fleet_t3_call', { host: 'mini', tool: 't3_thread_read', arguments: { threadId: appThread } });
    assert.match(summary, /^t3_thread_read on mini:\n\{/);
    assert.ok(summary.includes('Synthetic message typed in the app'), 'clients that read only text get the whole result');
  });

  test('a host that opts out is refused with native_reads_disabled before T3 is asked anything', async (t) => {
    const { macbook, agent } = await startFleet(t, { macbook: { nativeReads: false } });
    const before = [macbook.calls.length, macbook.toolListings];
    for (const [name, args] of [['fleet_t3_tools', { host: 'macbook' }], ['fleet_t3_call', { host: 'macbook', tool: 't3_thread_list', arguments: { projectId: 'project-1' } }]] as const) {
      const refused = await agent.callError(name, args);
      assert.equal(refused.code, 'native_reads_disabled');
    }
    assert.deepEqual([macbook.calls.length, macbook.toolListings], before, 'no listing and no call reached the host');
    assert.equal((await agent.call<ToolsResult>('fleet_t3_tools', { host: 'mini' })).host, 'mini', 'other hosts are unaffected');
  });
});

describe('native reads: the allowlist', () => {
  test('every group is reachable, and anything else is refused with tool_not_allowed before any host or T3 access', async (t) => {
    const { mini, agent } = await startFleet(t);
    const { threadId } = mini.launchDirect({ projectId: 'project-1', title: 'Synthetic thread', message: 'Synthetic', workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: 'fleet/synthetic' } });
    const question = mini.askQuestion(threadId, [{ id: 'q', header: 'Synthetic', question: 'Synthetic question?', options: [] }]);
    const calls: [string, Record<string, unknown>][] = [
      ['t3_environment_read', {}],
      ['t3_project_list', { limit: 10 }],
      ['t3_project_read', { projectId: 'project-1' }],
      ['t3_thread_search', { query: 'Synthetic', projectId: 'project-1' }],
      ['t3_thread_configuration', { threadId }],
      ['t3_thread_transfers', { threadId }],
      ['t3_worktree_list', { threadId }],
      ['t3_queue_list', { threadId }],
      ['t3_pending_request_list', { threadId }],
      ['t3_pending_request_read', { threadId, requestId: question }],
    ];
    for (const [tool, args] of calls) {
      const answered = await agent.call<CallResult>('fleet_t3_call', { host: 'mini', tool, arguments: args });
      assert.equal(answered.tool, tool);
    }
    assert.deepEqual(mini.calls.slice(-calls.length), calls.map(([tool]) => tool));
    const worktrees = await agent.call<CallResult<{ refs: { name: string }[] }>>('fleet_t3_call', { host: 'mini', tool: 't3_worktree_list', arguments: { threadId } });
    assert.deepEqual(worktrees.result.refs.map((ref) => ref.name), ['fleet/synthetic']);

    const before = mini.calls.length;
    for (const tool of ['t3_thread_send', 't3_project_delete', 't3_thread_wait', 'delegate_task', 't3_worktree_status', 't3_synthetic_unknown', 'constructor']) {
      const refused = await agent.callError('fleet_t3_call', { host: 'mini', tool, arguments: { threadId, message: 'Synthetic' } });
      assert.equal(refused.code, 'tool_not_allowed', tool);
      assert.ok(refused.text.includes(JSON.stringify(tool)) && refused.text.includes('work_*') && refused.text.includes('t3_thread_read'), refused.text);
    }
    assert.equal((await agent.callError('fleet_t3_call', { host: 'nowhere', tool: 't3_thread_send' })).code, 'tool_not_allowed', 'the tool is checked first');
    assert.equal(mini.calls.length, before, 'no refused call reached T3');
  });

  test('fleet_t3_tools lists only allowed tools, with live schemas, and names the ones a host lacks', async (t) => {
    const { gw, agent } = await startFleet(t, { macbookOmits: ['t3_thread_transfers', 't3_queue_read'] });
    const advertised = (await gw.services.registry.client('macbook').listTools()).tools.map((tool) => tool.name);
    assert.ok(advertised.includes('t3_thread_send') && advertised.includes('t3_thread_launch'), 'the host advertises writes');

    const listed = await agent.call<ToolsResult>('fleet_t3_tools', { host: 'macbook' });
    assert.deepEqual(listed.tools.map((tool) => tool.name), ALLOWED.filter((name) => name !== 't3_thread_transfers' && name !== 't3_queue_read'));
    assert.deepEqual(listed.missing, ['t3_thread_transfers', 't3_queue_read']);
    assert.equal(listed.serverVersion, '9.9.9-synthetic');
    const read = listed.tools.find((tool) => tool.name === 't3_thread_read');
    assert.equal(read?.group, 'thread');
    assert.ok(read?.inputSchema.properties && ['threadId', 'view', 'afterPosition', 'maxCharsPerItem'].every((field) => field in read.inputSchema.properties!));
    assert.match(listed.note, /work_start/);

    const summary = await text(agent, 'fleet_t3_tools', { host: 'macbook' });
    for (const name of listed.tools.map((tool) => tool.name)) assert.ok(summary.includes(`${name} [`), `${name} is in the text`);
    assert.ok(summary.includes('"threadId"') && summary.includes('Not offered by this host: t3_thread_transfers, t3_queue_read'));
    assert.doesNotMatch(summary, /t3_thread_send|t3_thread_launch/);
  });
});

describe('native reads: authorization and failures', () => {
  test('a read grant for one host cannot reach the other: not_found, and nothing reaches it', async (t) => {
    const { mini, macbook, gw } = await startFleet(t);
    const agent = await connect(t, gw, 'read', ['mini']);
    const before = [macbook.calls.length, macbook.toolListings];
    for (const [name, args] of [['fleet_t3_tools', { host: 'macbook' }], ['fleet_t3_call', { host: 'macbook', tool: 't3_environment_read' }]] as const) {
      const refused = await agent.callError(name, args);
      assert.equal(refused.code, 'not_found');
      assert.match(refused.text, /No host "macbook"\. fleet_status lists the hosts you can use\./);
    }
    assert.equal((await agent.callError('fleet_t3_tools', { host: 'nowhere' })).text, (await agent.callError('fleet_t3_tools', { host: 'macbook' })).text.replace('macbook', 'nowhere'));
    assert.deepEqual([macbook.calls.length, macbook.toolListings], before);
    const own = await agent.call<CallResult<{ serverVersion: string }>>('fleet_t3_call', { host: 'mini', tool: 't3_environment_read' });
    assert.equal(own.result.serverVersion, mini.serverVersion);
  });

  test("T3's refusals surface as t3_tool_failed with T3's code; an oversized result is refused, not cut", async (t) => {
    const { mini, agent } = await startFleet(t, { macbookOmits: ['t3_queue_read'] });
    const missing = await agent.callError('fleet_t3_call', { host: 'mini', tool: 't3_thread_read', arguments: { threadId: 'thread-synthetic-missing' } });
    assert.equal(missing.code, 't3_tool_failed');
    assert.match(missing.text, /thread_not_found/);
    const lacking = await agent.callError('fleet_t3_call', { host: 'macbook', tool: 't3_queue_read', arguments: { queuedRunId: 'run-1' } });
    assert.equal(lacking.code, 't3_tool_failed', 'a tool the host does not offer is its refusal, not a lost response');
    assert.match(lacking.text, /invalid_params/);

    const { threadId } = mini.launchDirect({ projectId: 'project-1', title: 'Synthetic long thread', message: 'Synthetic' });
    for (let index = 0; index < 6; index++) mini.finishTurn(threadId, `${index}`.repeat(50_000));
    const big = await agent.callError('fleet_t3_call', { host: 'mini', tool: 't3_thread_read', arguments: { threadId, limit: 100, maxCharsPerItem: 50_000 } });
    assert.equal(big.code, 'invalid_argument');
    assert.match(big.text, /over the 256 KiB limit\. Ask for less: lower limit or maxCharsPerItem/);
    const page = await agent.call<CallResult<ThreadReadResult>>('fleet_t3_call', { host: 'mini', tool: 't3_thread_read', arguments: { threadId, limit: 2, maxCharsPerItem: 50_000 } });
    assert.equal(page.result.items.length, 2);
  });
});
