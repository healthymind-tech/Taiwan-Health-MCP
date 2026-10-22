/**
 * Per-request raw body context, so a tool can re-read one of its arguments losslessly
 * (losslessJson.ts) after express.json / the MCP transport have already parsed the body
 * with JSON.parse.
 *
 * server.ts captures the raw body bytes (express.json `verify`) and runs each of the three
 * entry points inside `runWithRawRequest`:
 *   - `POST /tools/<name>`                       kind "tools": the body is the argument object
 *   - `POST /admin/api/mcp/tools/<name>/invoke`  kind "admin": `{ arguments: {...} }`
 *   - `POST /mcp` (JSON-RPC)                     kind "mcp":   `tools/call` message(s); a batch is
 *                                                                matched to the handler by request id
 * A tool asks for `losslessToolArgument(tool, arg, requestId)`; it gets `undefined` (and the
 * tool keeps the ordinary value) whenever there is no context, the body cannot be parsed,
 * or the argument cannot be located — never an error. The lossless parse happens at most once
 * per request, lazily.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isRawNumber, parseLossless } from "./losslessJson.js";

export type RawBodyKind = "tools" | "admin" | "mcp";

interface RawRequestStore {
  kind: RawBodyKind;
  raw: Buffer | string | null | undefined;
  parsed?: unknown;
  parseFailed?: boolean;
}

const als = new AsyncLocalStorage<RawRequestStore>();

/** Run `fn` with the raw request body available to `losslessToolArgument`. */
export function runWithRawRequest<T>(kind: RawBodyKind, raw: Buffer | string | null | undefined, fn: () => T): T {
  return als.run({ kind, raw }, fn);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !isRawNumber(v);
}

function parsedBody(store: RawRequestStore): unknown {
  if (store.parseFailed) return undefined;
  if (store.parsed !== undefined) return store.parsed;
  if (store.raw === null || store.raw === undefined) {
    store.parseFailed = true;
    return undefined;
  }
  try {
    const text = typeof store.raw === "string" ? store.raw : store.raw.toString("utf8");
    store.parsed = parseLossless(text);
    return store.parsed;
  } catch {
    store.parseFailed = true;
    return undefined;
  }
}

function sameId(a: unknown, b: unknown): boolean {
  if (isRawNumber(a)) a = Number(a.text);
  if (a === b) return true;
  return (typeof a === "string" || typeof a === "number") && (typeof b === "string" || typeof b === "number") && String(a) === String(b);
}

/**
 * The lossless tree of argument `arg` of the current call of `tool`, or `undefined`.
 * `requestId` (the MCP handler's `extra.requestId`) disambiguates a JSON-RPC batch.
 */
export function losslessToolArgument(tool: string, arg: string, requestId?: string | number | null): unknown {
  const store = als.getStore();
  if (!store) return undefined;
  const body = parsedBody(store);
  if (body === undefined) return undefined;
  let args: unknown;
  if (store.kind === "tools") {
    args = body;
  } else if (store.kind === "admin") {
    args = isObj(body) ? body.arguments : undefined;
  } else {
    const messages = Array.isArray(body) ? body : [body];
    const calls = messages.filter((m) => isObj(m) && m.method === "tools/call" && isObj(m.params) && m.params.name === tool);
    let call: Record<string, unknown> | undefined;
    if (calls.length === 1) call = calls[0] as Record<string, unknown>;
    else if (requestId !== undefined && requestId !== null) call = calls.find((m) => sameId((m as Record<string, unknown>).id, requestId)) as Record<string, unknown> | undefined;
    const params = call ? (call.params as Record<string, unknown>) : undefined;
    args = params ? params.arguments : undefined;
  }
  if (!isObj(args) || !Object.prototype.hasOwnProperty.call(args, arg)) return undefined;
  return args[arg];
}
