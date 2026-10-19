import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import * as z from 'zod';
import { GatewayError } from '../errors.ts';

/** How T3 reports a tool failure: `isError: true` with this JSON in the first text block. */
const failureSchema = z.looseObject({
  _tag: z.literal('OrchestratorMcpFailure'),
  code: z.string(),
  message: z.string(),
});

/** A T3 tool ran and refused or failed. `t3Code` is T3's own stable code, for example `target_required`. */
export class T3ToolError extends GatewayError {
  readonly tool: string;
  readonly t3Code: string;

  constructor(tool: string, t3Code: string, message: string) {
    super('t3_tool_failed', `${tool} failed (${t3Code}): ${message}`);
    this.name = 'T3ToolError';
    this.tool = tool;
    this.t3Code = t3Code;
  }
}

/**
 * JSON-RPC errors that mean T3 refused a call before any tool code ran: it does not know the tool, or the arguments
 * fail the tool's input schema (T3 answers those with InvalidParams, not with a tool result). T3 answered, so the
 * session is fine and the call is not a lost response.
 */
const REFUSALS: ReadonlyMap<number, string> = new Map([
  [ProtocolErrorCode.MethodNotFound, 'method_not_found'],
  [ProtocolErrorCode.InvalidParams, 'invalid_params'],
]);
const REFUSAL_CODES = new Set(REFUSALS.values());

export function protocolRefusal(tool: string, error: unknown): T3ToolError | undefined {
  const code = error instanceof ProtocolError ? REFUSALS.get(error.code) : undefined;
  return code === undefined ? undefined : new T3ToolError(tool, code, (error as ProtocolError).message);
}

/**
 * T3 said that what the call named (a thread, say) does not exist: one of its own `*not_found` tool codes. A protocol
 * refusal (`method_not_found`) never reached the tool, so it says nothing about the thread.
 */
export function isT3NotFound(error: T3ToolError): boolean {
  return !REFUSAL_CODES.has(error.t3Code) && /not_found/.test(error.t3Code);
}

interface ToolResultShape {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

function firstText(result: ToolResultShape): string | undefined {
  if (!Array.isArray(result.content)) return undefined;
  const block = result.content.find(
    (item): item is { type: 'text'; text: string } =>
      typeof item === 'object' && item !== null && item.type === 'text' && typeof item.text === 'string',
  );
  return block?.text;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Turn a T3 tool result into a typed value: prefer `structuredContent`, fall back to the JSON text
 * block, and convert `isError` results into T3ToolError with T3's code.
 */
export function parseToolResult<T>(tool: string, result: ToolResultShape, schema: z.ZodType<T>): T {
  if (result.isError === true) {
    const failure = failureSchema.safeParse(result.structuredContent ?? parseJson(firstText(result)));
    if (failure.success) throw new T3ToolError(tool, failure.data.code, failure.data.message);
    throw new T3ToolError(tool, 'unknown', 'T3 returned an error without details');
  }
  const payload = result.structuredContent ?? parseJson(firstText(result));
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new GatewayError('t3_invalid_response', `${tool} returned an unexpected result shape: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
