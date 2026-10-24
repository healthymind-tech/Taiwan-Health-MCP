/**
 * Response envelopes of the authoring tools: the same `{ok, data, warnings, provenance}` /
 * `{ok: false, data: null, warnings: [], error: {code, message, hint, …}}` shape as the other
 * fhir_* tools (toolErrors.ts conventions), with `message_zh` / `hint_zh` on every error so the
 * calling model can explain it to a Chinese-speaking user. Errors are complete or nothing: a
 * CONTEXT_EXPIRED error never carries partial results.
 */

import { ContextConflictError, ContextExpiredError, CONTEXT_IDLE_TTL_SECONDS } from "./contextStore.js";
import { AssembleRefusedError, AuthoringArgumentError } from "./service.js";
import { toolVersion } from "../toolVersions.js";

export interface AuthoringError {
  code: string;
  message: string;
  message_zh: string;
  hint: string;
  hint_zh: string;
  retryable: boolean;
  [k: string]: unknown;
}

export function okEnvelope(tool: string, data: unknown, warnings: string[] = [], provenance: Record<string, unknown> | null = null): Record<string, unknown> {
  return { ok: true, data, warnings, provenance: { ...(provenance ?? {}), tool, toolVersion: safeToolVersion(tool) } };
}

export function errorEnvelope(error: AuthoringError): Record<string, unknown> {
  return { ok: false, data: null, warnings: [], error };
}

function safeToolVersion(tool: string): string {
  try {
    return toolVersion(tool);
  } catch {
    return "0.0.0"; // registered by the coordinator in toolVersions.ts
  }
}

const TTL_MIN = CONTEXT_IDLE_TTL_SECONDS / 60;

export function contextExpiredError(contextId: string): AuthoringError {
  return {
    code: "CONTEXT_EXPIRED",
    message: `Authoring context ${contextId} does not exist or expired (idle TTL ${TTL_MIN} min, refreshed on every call) — the resources stored in it are gone.`,
    message_zh: `找不到或已過期的 authoring context ${contextId}（閒置 ${TTL_MIN} 分鐘後清除，每次呼叫都會延長），其中儲存的資源已不存在。`,
    hint: "Do not retry with this context_id. Call fhir_author_resources again WITHOUT context_id to start a new context, re-author every resource of the task (same keys and fields), then assemble.",
    hint_zh: "請勿用這個 context_id 重試。改呼叫 fhir_author_resources 且不要帶 context_id 以建立新的 context，用相同的 key 與欄位重新建立這個任務的所有資源，再組裝 Bundle。",
    retryable: false,
    context_id: contextId,
  };
}

export function invalidArgumentError(message: string, extra: Record<string, unknown> = {}): AuthoringError {
  return {
    code: "INVALID_ARGUMENT",
    message,
    message_zh: `參數錯誤：${message}`,
    hint: "Check the arguments against this tool's description and input schema, then call again.",
    hint_zh: "請對照工具說明與輸入格式修正參數後再呼叫。",
    retryable: true,
    ...extra,
  };
}

const REFUSAL_TEXT: Record<string, { message: string; message_zh: string; hint: string; hint_zh: string }> = {
  KEY_NOT_FOUND: {
    message: "Some keys are not in the context.",
    message_zh: "部分 key 不在 context 中。",
    hint: "fhir_context action=list shows the stored keys; author the missing ones with fhir_author_resources (same context_id) or remove them from keys.",
    hint_zh: "用 fhir_context action=list 查看已儲存的 key；用 fhir_author_resources（同一個 context_id）補建缺少的資源，或從 keys 移除。",
  },
  UNRESOLVED_REFERENCE: {
    message: "A stored resource references a key that is not in the list (or not in the context); the Bundle was not built.",
    message_zh: "有資源參照到不在 keys 清單（或不在 context）中的 key，未建立 Bundle。",
    hint: "error.refused lists key + field + ref_key. Either add ref_key to keys (if it is stored), author it with fhir_author_resources, or resend the field with merge=true pointing at a key you will include.",
    hint_zh: "error.refused 列出 key、field 與 ref_key。請把 ref_key 加進 keys（若已儲存）、用 fhir_author_resources 建立它，或以 merge=true 重送該欄位改指向會納入的 key。",
  },
  INVALID_RESOURCE: {
    message: "A stored resource has validation errors; the Bundle was not built.",
    message_zh: "有資源尚有驗證錯誤，未建立 Bundle。",
    hint: "error.refused lists key + field + error. Fix each with fhir_author_resources (same context_id, same key, merge=true, only the changed fields), then assemble again. Pass allow_invalid=true only if the user explicitly accepts an invalid Bundle.",
    hint_zh: "error.refused 列出 key、field 與錯誤。請用 fhir_author_resources（同一 context_id、同一 key、merge=true、只送修改的欄位）修正後再組裝。除非使用者明確接受不合規的 Bundle，否則不要用 allow_invalid=true。",
  },
  MISSING_COMPOSITION: {
    message: "A document Bundle needs an authored Composition as its first entry; none of the keys is one. It is not invented.",
    message_zh: "document 型 Bundle 需要一個 Composition 作為第一個 entry，keys 中沒有；系統不會自行捏造。",
    hint: "error.missing.fields lists what the Composition needs (profile in error.missing.profile). Author it with fhir_author_resources from the record (sections referencing the other keys with {ref}), then assemble with its key first.",
    hint_zh: "error.missing.fields 列出 Composition 需要的欄位（profile 在 error.missing.profile）。請依病歷用 fhir_author_resources 建立（section 用 {ref} 參照其他 key），再把它的 key 放在 keys 第一個重新組裝。",
  },
};

export function refusalError(e: AssembleRefusedError): AuthoringError {
  const r = e.refusal;
  const t = REFUSAL_TEXT[r.code];
  return { code: r.code, ...t, retryable: false, refused: r.refused, ...("missing" in r ? { missing: r.missing } : {}) };
}

/** Map any thrown error of the authoring layer to its envelope; rethrow unknown errors (mcp.ts' boundary classifies them). */
export function authoringErrorEnvelope(e: unknown): Record<string, unknown> | null {
  if (e instanceof ContextExpiredError) return errorEnvelope(contextExpiredError(e.contextId));
  if (e instanceof AssembleRefusedError) return errorEnvelope(refusalError(e));
  if (e instanceof AuthoringArgumentError) return errorEnvelope(invalidArgumentError(e.message, e.extra));
  if (e instanceof ContextConflictError) {
    return errorEnvelope({
      code: "CONTEXT_CONFLICT",
      message: e.message,
      message_zh: "同一個 context 同時被多個呼叫更新，這次寫入未完成。",
      hint: "Retry the same call once; author the resources of one context from one place at a time.",
      hint_zh: "請重試一次；同一個 context 的資源請依序建立，不要同時從多處寫入。",
      retryable: true,
    });
  }
  return null;
}
