/**
 * Operator-language text for messages from the LLM admin API.
 *
 * The backend (node-server/src/admin/llmErrorCodes.ts) attaches a stable
 * `code` + `params` to error responses and to result objects that carry a
 * `message` (tests, model listings, fingerprint checks). Translate by code;
 * when there is none, try the known English phrasings, and as a last resort
 * show the server's own text.
 */

import { ApiError, errorMessage } from "@/lib/api";

export type CodeParams = Record<string, unknown>;

/** Anything shaped like a coded backend message. */
export interface Coded {
  code?: string;
  params?: CodeParams;
  message?: string | null;
}

/** Where the switch lives, so messages can point at the real button. */
const SWITCH_HINT = "要改用其他模型，請到「總覽」分頁按「切換模型…」，系統會重建所有向量。";

const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const n = (v: unknown, digits: number): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : s(v));
const roleLabel = (r: unknown): string => (r === "embedding" ? "Embedding" : "分析 LLM（聊天模型）");
const kindLabel = (k: unknown): string => (k === "embedding" ? "Embedding" : "分析 LLM");

/** Why a provider call failed, from the backend's `reason` (+ raw `detail`). */
function providerReason(p: CodeParams): string {
  const detail = s(p.detail);
  switch (p.reason) {
    case "bad_url":
      return "Base URL 格式不正確，無法連線。請確認網址（例如 https://api.example.com/v1）。";
    case "auth":
      return `伺服器拒絕授權，請確認 API 金鑰是否正確、仍有效。（${detail}）`;
    case "not_found":
      return `找不到端點（HTTP 404），請確認 Base URL 的路徑（OpenAI 相容服務通常以 /v1 結尾）。`;
    case "rate_limited":
      return "請求太頻繁或額度用盡（HTTP 429），請稍後再試。";
    case "server_error":
      return `供應商伺服器發生錯誤，請稍後再試。（${detail}）`;
    case "unreachable":
      return "無法連線到伺服器，請確認網址、連接埠與網路。";
    case "timeout":
      return "連線逾時，伺服器沒有及時回應。";
    default:
      return detail;
  }
}

function paramRule(rule: string): string {
  if (rule === "an integer") return "必須是整數";
  if (rule === "a number") return "必須是數字";
  const between = rule.match(/^between (.+) and (.+)$/);
  if (between) return `必須介於 ${between[1]} 與 ${between[2]} 之間`;
  const oneOf = rule.match(/^one of: (.+)$/);
  if (oneOf) return `必須是下列之一：${oneOf[1]}`;
  return rule;
}

const TEXT: Record<string, (p: CodeParams) => string> = {
  // accounts
  invalid_url: (p) => `「${s(p.url)}」不是有效的網址。請輸入以 http:// 或 https:// 開頭的完整網址。`,
  account_in_use: (p) => `這個帳號仍被 Profile「${s(p.profiles).split(", ").join("」「")}」使用。請先從這些 Profile 移除它的模型，再刪除帳號。`,
  account_name_required: () => "請輸入帳號名稱。",
  account_name_too_long: (p) => `帳號名稱太長（最多 ${s(p.max)} 字）。`,
  account_name_taken: (p) => `已有名為「${s(p.name)}」的帳號，請換一個名稱。`,
  account_not_found: () => "找不到這個 Provider 帳號（可能已被刪除），請重新整理頁面。",
  unknown_provider: (p) => `不支援的供應商類型「${s(p.provider)}」。`,
  account_provider_locked: () => "帳號建立後不能更換供應商類型；請另外新增一個帳號。",
  account_oauth_only: (p) => `${s(p.provider)} 帳號需以登入方式連線，不能使用 API 金鑰。`,
  api_key_required: () => "這個供應商需要 API 金鑰。",
  base_url_required: () => "請輸入 Base URL。",
  model_required: () => "請指定模型。",
  rate_limit_invalid: () => "RPM／TPM 上限必須是正整數。",
  enabled_invalid: () => "「啟用」必須是開或關。",
  unknown_role: (p) => `沒有「${s(p.role)}」這個角色（只有分析 LLM 與 Embedding）。`,
  role_no_enabled_model: (p) => `「${s(p.name)}」裡沒有任何啟用中的模型，指定給角色後將無模型可用。請先啟用至少一個成員（或其帳號）。`,
  member_ref_deleted: () => "某個成員引用的 Profile 或帳號剛剛被刪除了，請重新整理後再試。",
  import_malformed: () => "匯入檔的模型設定（llm）格式不正確：需要 providers 與 profiles 清單。現有設定沒有變動。",
  import_profile_refs: () => "匯入檔裡的 Profile 引用了不存在的 Profile，或彼此循環引用。現有設定沒有變動。",
  profile_no_enabled_members: () => "這個 Profile 沒有可用成員：所有成員（或其帳號）都已停用。",
  embedding_incompatible: (p) =>
    `端點有回應，但沒有傳回可用的向量${p.status ? `（HTTP ${s(p.status)}）` : ""}，這個模型可能不支援 Embedding。`,
  embedding_switch_same_model: () => "這個模型產生的向量與系統目前的模型相同，不需要切換；直接把它加進 Embedding Profile 當備援即可。",
  embedding_switch_busy: () => "已有一個 Embedding 模型切換正在進行，請等它完成。",
  profile_name_too_long: (p) => `Profile 名稱太長（最多 ${s(p.max)} 字）。`,
  member_enabled_invalid: (p) => `成員 #${s(p.index)}：「啟用」必須是開或關。`,
  // model listing / test
  models_list_failed: (p) => `無法列出模型：${providerReason(p)}`,
  models_found: (p) => `找到 ${s(p.count)} 個模型。`,
  models_no_listing: () => "此供應商無法列出模型，請直接輸入模型名稱。",
  provider_no_role: (p) => `${s(p.provider)} 不提供 ${roleLabel(p.role)}。`,
  // profiles
  profile_name_required: () => "請輸入 Profile 名稱。",
  profile_name_taken: (p) => `已有名為「${s(p.name)}」的 Profile，請換一個名稱。`,
  profile_needs_member: () => "Profile 至少需要一個成員。",
  profile_single_one_member: () => "「單一模型」策略只能有一個成員；多個成員請改用依序備援、輪詢或加權負載平衡。",
  profile_not_found: () => "找不到這個 Profile（可能已被刪除），請重新整理頁面。",
  profile_loop: (p) => `Profile 之間會形成循環引用：${s(p.path)}。`,
  profile_kind_locked: () => "這個 Profile 正被角色使用中，不能改變它的類型（分析 LLM／Embedding）。",
  profile_delete_needs_confirm: (p) => `刪除「${s(p.name)}」會影響其他 Profile 或角色，請檢視影響並輸入 Profile 名稱確認。`,
  profile_wrong_role: (p) => `「${s(p.name)}」是${kindLabel(p.kind)} Profile，不能用於${kindLabel(p.role)}角色。`,
  embedding_dims_mixed: (p) => `Embedding Profile 裡所有模型必須使用相同的向量維度（目前有 ${s(p.dims)}）。`,
  member_weight_invalid: (p) => `成員 #${s(p.index)}：權重必須是 0 到 ${s(p.max ?? 1000)} 之間的整數。`,
  member_unknown_account: (p) => `成員 #${s(p.index)}：Provider 帳號不存在（可能已被刪除）。`,
  member_model_required: (p) => `成員 #${s(p.index)}：請指定模型。`,
  member_provider_no_role: (p) => `成員 #${s(p.index)}：${s(p.account)}（${s(p.provider)}）不提供 ${roleLabel(p.role)}。`,
  member_dims_invalid: (p) => `成員 #${s(p.index)}：向量維度必須是正整數。`,
  member_unknown_profile: (p) => `成員 #${s(p.index)}：引用的 Profile 不存在（可能已被刪除）。`,
  member_self_reference: (p) => `成員 #${s(p.index)}：Profile 不能包含自己。`,
  member_duplicate_profile: (p) => `成員 #${s(p.index)}：「${s(p.name)}」已經在這個 Profile 裡，同一個 Profile 不能加入兩次。`,
  member_kind_mismatch: (p) => `成員 #${s(p.index)}：「${s(p.name)}」是${kindLabel(p.kind)} Profile，不能放進${kindLabel(p.target)} Profile。`,
  member_unknown_type: (p) => `成員 #${s(p.index)}：未知的成員類型。`,
  param_invalid: (p) => `${s(p.label)} ${paramRule(s(p.rule))}。`,
  // embedding identity
  embedding_dims_mismatch: (p) => `向量維度設為 ${s(p.dims)}，但系統使用 ${s(p.system_dims)} 維。`,
  embedding_dims_returned: (p) => `端點回傳 ${s(p.dims)} 維向量，但系統使用 ${s(p.system_dims)} 維。`,
  embedding_different_model: (p) => `與系統向量的相似度只有 ${n(p.similarity, 3)}（需 ≥ ${s(p.min_similarity)}），不是同一個模型。`,
  embedding_same_model: (p) => `與系統是同一個模型（相似度 ${n(p.min, 4)}–${n(p.max, 4)}）。`,
  embedding_no_identity: () => "系統尚未建立 Embedding 指紋；這個模型會成為系統的指紋。",
  embedding_unreachable: (p) => `端點沒有回應，無法比對指紋。${providerReason(p)}`,
  embedding_rejected_same_model_dims: (p) =>
    `「${s(p.model)}」與系統是同一個模型，但這裡的向量維度設為 ${s(p.dims)}，系統向量是 ${s(p.system_dims)} 維。請把向量維度改回 ${s(p.system_dims)}，維度不同的向量無法互相比對。`,
  embedding_rejected_dims: (p) =>
    `「${s(p.name)}」的向量維度是 ${s(p.dims)}，系統 Embedding 模型（${s(p.system_model)}）是 ${s(p.system_dims)} 維，不能加入。${SWITCH_HINT}`,
  embedding_rejected_different_model: (p) =>
    `「${s(p.name)}」不是系統的 Embedding 模型（${s(p.system_model)}）：相似度只有 ${n(p.similarity, 3)}（需 ≥ ${s(p.min_similarity)}）。所有 Embedding 端點必須產生相同的向量。${SWITCH_HINT}`,
  embedding_rejected: (p) => `「${s(p.name)}」不是系統的 Embedding 模型（${s(p.system_model)}，${s(p.system_dims)} 維）。${SWITCH_HINT}`,
  embedding_unverified: (p) => `無法確認「${s(p.name)}」是否與系統 Embedding 模型相同：端點沒有回應。${providerReason(p)}`,
  embedding_no_seed: () => "系統已有向量，但 Embedding 角色沒有綁定模型，無法建立系統指紋。請先綁定原本產生這些向量的 Embedding Profile。",
  embedding_new_model_unreachable: (p) => `新模型沒有回應。${providerReason(p)}`,
  embedding_new_model_dims: (p) => `新模型回傳 ${s(p.returned)} 維向量，但設定為 ${s(p.dims)} 維。請把向量維度改為 ${s(p.returned)}。`,
  embedding_reindex_confirm: () => "請輸入 REINDEX 確認：所有現有向量都會被刪除並重建。",
  embedding_jobs_busy: () => "向量工作在 2 分鐘內沒有停止，請等它們結束後再試。",
  chatgpt_terms_required: () => "請先勾選所有確認項目。",
};

/** Known English phrasings without a code (older server, sign-in flow). */
const LEGACY: [RegExp, string][] = [
  [/expired or was already used/i, "登入連結已過期或已使用過，請重新按「以 ChatGPT 登入」。"],
  [/not a URL/i, "貼上的不是網址。請複製登入後瀏覽器網址列的完整網址（以 http://127.0.0.1:1455/auth/callback 開頭）。"],
  [/no authorization code/i, "貼上的網址裡沒有授權碼，請確認複製的是登入完成後的網址。"],
  [/did not issue a client id/i, "OpenAI 沒有核發應用程式 ID（註冊未完成），請重新登入。"],
  [/Plan usage was not granted/i, "未授權使用 ChatGPT 方案額度。請重新登入，並在授權頁允許「使用方案額度」。"],
  [/Token exchange failed/i, "與 OpenAI 交換授權失敗，請重新登入。"],
  [/identity could not be verified/i, "無法驗證 ChatGPT 身分（ID token 驗證失敗），請重新登入。"],
  [/sign-in was not completed: access_denied/i, "你在 OpenAI 授權頁拒絕了授權。"],
  [/Confirm the ChatGPT subscription terms/i, "請先勾選所有確認項目。"],
  [/already exists/i, "已有同名的項目，請換一個名稱。"],
  [/Failed to parse URL|Invalid URL/i, "Base URL 格式不正確，無法連線。請確認網址（例如 https://api.example.com/v1）。"],
];

/** Text for a code, or null when the code is unknown here. */
export function codeText(code: string | undefined, params: CodeParams | undefined): string | null {
  const fn = code ? TEXT[code] : undefined;
  if (!fn) return null;
  try {
    return fn(params ?? {});
  } catch {
    return null;
  }
}

/** Localize a bare server message (no code). */
export function localizeMessage(msg: string): string {
  return LEGACY.find(([re]) => re.test(msg))?.[1] ?? msg;
}

/** Text for a coded result field (`message`, or a prefixed pair like `models_code`/`models_message`). */
export function llmText(obj: Coded | null | undefined, fallback = ""): string {
  if (!obj) return fallback;
  return codeText(obj.code, obj.params) ?? (obj.message ? localizeMessage(obj.message) : fallback);
}

/** Text for any thrown value from the LLM admin API. */
export function llmErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = (err.body && typeof err.body === "object" ? err.body : {}) as Record<string, unknown>;
    const coded = codeText(typeof body.code === "string" ? body.code : undefined, body.params as CodeParams | undefined);
    if (coded) return coded;
    // 500s carry the useful text in `detail`; 4xx in the message itself.
    if (err.status >= 500 && err.detail) return `操作失敗：${localizeMessage(err.detail)}`;
    return localizeMessage(err.message);
  }
  return localizeMessage(errorMessage(err));
}
