/**
 * Helpers shared by provider adapters: reading profile params, JSON POST with
 * error capture, and "drop the knob the server rejected, then retry".
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import { ProviderHttpError, ProviderReplyError, type CallContext } from "./types.js";

type Params = LlmProfile["params"];

export function pNum(params: Params, key: string): number | undefined {
  const raw = params?.[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function pStr(params: Params, key: string): string | undefined {
  const raw = params?.[key];
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s === "" ? undefined : s;
}

export function pBool(params: Params, key: string): boolean | undefined {
  const raw = params?.[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "boolean") return raw;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `…/v1` root for an OpenAI-style base URL that may or may not carry it. */
export function ensureV1(url: string): string {
  const u = trimSlash(url);
  return /\/v\d+[a-z]*$/i.test(u) ? u : `${u}/v1`;
}

export async function postJson(
  ctx: CallContext,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const r = await ctx.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new ProviderHttpError(r.status, text, url);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderHttpError(r.status, `non-JSON reply: ${text.slice(0, 200)}`, url);
  }
}

export async function getJson(
  ctx: CallContext,
  url: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const r = await ctx.fetch(url, { method: "GET", headers });
  const text = await r.text();
  if (!r.ok) throw new ProviderHttpError(r.status, text, url);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Wording servers use when they reject a request parameter. */
const PARAM_ERROR_PATTERN =
  /unrecogni[sz]ed|unsupported|not supported|does not support|doesn't support|unknown (?:field|parameter|argument|name|key)|unknown name|extra (?:fields|inputs|_?forbidden)|not permitted|not allowed|unexpected (?:keyword|field|parameter|argument)|invalid (?:parameter|argument|field|value)|cannot both be|mutually exclusive|only one of|is not (?:a )?valid|cannot be used|can't be used|only supported|is deprecated|use '?max_/i;

/** Rejections that are about the input itself, never about an optional knob. */
const NOT_A_PARAM_ERROR = /context length|context window|maximum context|too many tokens|prompt is too long|input is too long|reduce the length/i;

/**
 * The part of a 4xx body that can describe a rejected parameter: the error
 * message (plus `param` / FastAPI `detail[].loc`), not the whole body — some
 * servers echo the prompt back, and a drug insert mentioning "temperature"
 * must not strip the temperature knob. Returns null when the error is not a
 * parameter rejection at all.
 */
export function parameterErrorText(status: number, body: string): string | null {
  if (status !== 400 && status !== 422) return null;
  let text = "";
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const parts: string[] = [];
    const collect = (e: unknown): void => {
      if (!e) return;
      if (typeof e === "string") parts.push(e);
      else if (Array.isArray(e)) e.forEach(collect);
      else if (typeof e === "object") {
        const o = e as Record<string, unknown>;
        for (const k of ["message", "msg", "param", "code", "type"]) if (typeof o[k] === "string") parts.push(String(o[k]));
        if (Array.isArray(o.loc)) parts.push(o.loc.map(String).join("."));
        if (o.error && o.error !== e) collect(o.error);
        if (o.detail) collect(o.detail);
        if (o.details) collect(o.details);
      }
    };
    collect(json.error ?? json);
    if (json.detail && json.error) collect(json.detail);
    text = parts.join(" \n ");
  } catch {
    // Plain-text error: usable unless it is an HTML page.
    text = /<\s*(?:html|body|head|!doctype)/i.test(body) ? "" : body.slice(0, 1000);
  }
  if (!text || NOT_A_PARAM_ERROR.test(text) || !PARAM_ERROR_PATTERN.test(text)) return null;
  return text.toLowerCase();
}

/** Does `text` name `key` as a word (not as part of a longer identifier)? */
function namesKey(text: string, key: string): boolean {
  const k = key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${k}($|[^a-z0-9_])`).test(text);
}

/**
 * POST, and when the server rejects an optional knob (a 400/422 parameter error
 * whose message names a top-level key listed in `droppable`), delete that key
 * and retry. Returns the reply and the keys that had to be dropped. `adapt` can
 * apply extra rewrites (e.g. max_tokens ↔ max_completion_tokens) and returns a
 * label when it did; it only ever sees the error message of a parameter error.
 */
export async function postAdaptive(
  ctx: CallContext,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  droppable: readonly string[],
  adapt?: (body: Record<string, unknown>, errorText: string) => string | null,
): Promise<{ json: Record<string, unknown>; dropped: string[] }> {
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return { json: await postJson(ctx, url, headers, body), dropped };
    } catch (err) {
      if (!(err instanceof ProviderHttpError)) throw err;
      const low = parameterErrorText(err.status, err.body);
      if (low === null) throw err;
      const special = adapt?.(body, low) ?? null;
      if (special) {
        dropped.push(special);
        continue;
      }
      const key = droppable.find((k) => k in body && namesKey(low, k));
      if (!key) throw err;
      delete body[key];
      dropped.push(key);
    }
  }
  throw new Error(`${url} kept rejecting request parameters (dropped: ${dropped.join(", ")})`);
}

/**
 * Was this reply cut by the output budget?
 *
 * Only a finish reason that names the budget (length / max_tokens / …) — or an
 * empty answer next to reasoning, meaning thinking ate the budget — counts as
 * truncation, which the client answers by re-sending with a larger budget.
 * An empty answer with no such sign is a broken endpoint (proxy page, upstream
 * failure, misconfigured server): it throws `ProviderReplyError`, which counts
 * as an endpoint failure and fails over instead of burning bigger budgets.
 */
export function detectTruncation(opts: {
  provider: string;
  content: string;
  finishReason: string;
  cutReasons: readonly string[];
  reasoningChars?: number;
  reasoningTokens?: number | null;
}): boolean {
  if (opts.cutReasons.includes(opts.finishReason)) return true;
  if (opts.content.trim()) return false;
  if ((opts.reasoningChars ?? 0) > 0 || (opts.reasoningTokens ?? 0) > 0) return true;
  throw new ProviderReplyError(`${opts.provider} returned an empty reply (finish_reason=${opts.finishReason || "none"})`);
}

/** Strip a leading ```json fence some models wrap around JSON replies. */
export function stripJsonFence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
  return m ? m[1] : text;
}

/** Split `<think>…</think>` reasoning that some servers leave inline in content. */
export function splitThink(content: string): { content: string; reasoning: string } {
  const m = /^\s*<think>([\s\S]*?)<\/think>\s*/i.exec(content);
  if (!m) return { content, reasoning: "" };
  return { content: content.slice(m[0].length), reasoning: m[1] };
}

export function positive(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** L2-normalize (Gemini returns non-normalized vectors below its native size). */
export function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm > 0 ? vec.map((x) => x / norm) : vec;
}

/** Shared knob: temperature (most providers). */
export const TEMPERATURE_PARAM = {
  key: "temperature",
  type: "number" as const,
  label: "Temperature",
  help: "越低越穩定。結構化萃取建議 0–0.2。留空使用模型預設。",
  roles: ["analysis" as const],
  group: "generation" as const,
  min: 0,
  max: 2,
  step: 0.1,
  placeholder: "模型預設",
};

export const TOP_P_PARAM = {
  key: "top_p",
  type: "number" as const,
  label: "Top-p",
  help: "留空使用模型預設。與 Temperature 擇一調整即可。",
  roles: ["analysis" as const],
  group: "generation" as const,
  min: 0.01,
  max: 1,
  step: 0.05,
  placeholder: "模型預設",
};
