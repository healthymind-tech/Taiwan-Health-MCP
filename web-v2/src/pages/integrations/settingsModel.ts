/**
 * Settings schema helpers shared by the Integrations and Models pages.
 *
 * Contract (node-server/src/admin/adminSettings.ts):
 *  - GET  /admin/api/settings                → { groups: SettingsGroup[] } (secrets masked as SECRET_MASK, "" when unset)
 *  - POST /admin/api/settings/{group}        { values } → { ok, values }   (only keys present are written;
 *                                               a blank or masked secret means "keep the stored one")
 *  - POST /admin/api/settings/{group}/test   { values } → { ok, message, details? }
 *  - POST /admin/api/settings/{group}/models { values } → { ok, models, message }
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type { SettingsField, SettingsGroup, SettingsPayload } from "@/lib/types";

/** The placeholder the backend sends for a stored secret. */
export const SECRET_MASK = "●●●●●●●●";

/** Groups owned by the Models page (strategy + shared knobs for LLM profiles). */
export const MODEL_GROUPS = new Set(["embedding", "analysis"]);
/** Internal groups that must never be rendered as an editable form. */
export const HIDDEN_GROUPS = new Set(["maintenance"]);

export type FieldValue = string | number | boolean;
export type DraftValues = Record<string, FieldValue>;

export interface ActionResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
  models?: string[];
}

export function useSettings() {
  return useQuery({
    queryKey: qk.settings,
    queryFn: () => api.get<SettingsPayload>("/admin/api/settings"),
    staleTime: 15_000,
  });
}

// ── zh-TW presentation (backend labels/help are English) ─────────────────────

interface GroupMeta {
  label: string;
  description: string;
}

export const GROUP_META: Record<string, GroupMeta> = {
  embedding: { label: "Embedding 共用設定", description: "向量請求如何分配到各 Embedding 端點，以及所有端點共用的逾時、批次大小與並行請求數。" },
  analysis: { label: "分析 LLM 共用設定", description: "藥品仿單分析請求如何分配到各分析 LLM 端點，以及取得合法 JSON 的重試次數。" },
  ocr: {
    label: "OCR 伺服器（MinerU）",
    description: "將藥品仿單 PDF 轉為 Markdown 的 MinerU HTTP 服務。藥品分析流程會把 PDF 上傳到這裡，再讀回 Markdown。",
  },
  minio: {
    label: "物件儲存（MinIO）",
    description: "存放上傳的來源檔與藥品資產（仿單、外觀圖）。由部署環境（.env / compose）管理，這裡僅供檢視與測試連線。",
  },
  tfda: { label: "TFDA 爬蟲", description: "藥品資料補全（drug_enrichment）時抓取食藥署網站所使用的端點與速率。" },
  registry: {
    label: "FHIR 套件 Registry",
    description: "以 packageId@version 自動下載 Implementation Guide 及其相依 IG 時使用的 npm 式 FHIR registry。",
  },
  worker: {
    label: "背景工作程序",
    description: "admin-worker 的輪詢與心跳節奏，只在工作程序啟動時讀取一次。首次啟動時由 .env 種子化並存入 admin.app_settings（群組 worker），之後再改 .env 不會生效；如需調整，請直接更新這些資料列後重啟 worker。",
  },
};

interface FieldMeta {
  label: string;
  help?: string;
}

/** Keyed by `group.key`. Unknown fields fall back to the backend's label/help. */
export const FIELD_META: Record<string, FieldMeta> = {
  "embedding.strategy": { label: "分流策略", help: "failover：永遠使用優先序最高且健康的端點；weighted：依權重隨機分配，失敗時仍會依序備援。" },
  "embedding.timeout": { label: "逾時（秒）", help: "單次 embedding 請求的上限秒數。" },
  "embedding.concurrency": {
    label: "並行請求數",
    help: "同時送出的 embedding 批次數（1–32）。提高可加快嵌入，但需注意供應商的速率限制（RPM／TPM）。執行中的工作約 10 秒內套用新值。",
  },
  "embedding.batch_size": { label: "批次大小", help: "每次送往端點的文字筆數。雲端服務若有 TPM 限制，可調小以避免觸發速率限制。" },
  "analysis.strategy": { label: "分流策略", help: "failover：永遠使用優先序最高且健康的端點；weighted：依權重隨機分配。任一呼叫失敗都會改試下一個端點。" },
  "analysis.max_retries": { label: "最大重試次數", help: "同一端點嘗試取得格式正確 JSON 的次數，用完才換下一個端點。" },
  "ocr.provider": { label: "供應者" },
  "ocr.base_url": { label: "Base URL", help: "MinerU API 根網址，例如 http://10.0.0.5:8000" },
  "ocr.backend": { label: "解析後端", help: "hybrid-engine 對食藥署仿單的文字／表格混合版面效果最好。" },
  "ocr.effort": { label: "解析強度", help: "僅 hybrid 後端適用。high 會額外分析圖片與圖表，速度較慢。" },
  "ocr.parse_method": { label: "解析方式", help: "auto 自動判斷；txt 直接抽取文字層；ocr 強制影像辨識（掃描檔適用）。" },
  "ocr.lang": { label: "語言", help: "僅 pipeline 後端適用。ch 同時涵蓋繁體中文與英文。" },
  "ocr.timeout_seconds": { label: "逾時（秒）", help: "單一 PDF 的處理上限。一般仿單數秒內即可完成。" },
  "minio.endpoint": { label: "Endpoint", help: "host:port，例如 minio:9000" },
  "minio.access_key": { label: "Access key" },
  "minio.secret_key": { label: "Secret key" },
  "minio.bucket": { label: "Bucket" },
  "minio.secure": { label: "使用 TLS（secure）" },
  "minio.presign_ttl": { label: "預簽網址有效期（秒）", help: "下載連結的有效時間。" },
  "tfda.base_url": { label: "Base URL" },
  "tfda.http_timeout": { label: "HTTP 逾時（秒）" },
  "tfda.crawler_concurrency": { label: "爬蟲並行數", help: "同時對食藥署發出的請求數。過高可能被對方限流或封鎖。" },
  "registry.base_url": { label: "Registry 網址", help: "主要的 FHIR 套件 registry，預設 packages.fhir.org；也可指向 Simplifier 或內部鏡像。" },
  "registry.fallback_url": { label: "備援網址", help: "主要 registry 取不到套件時改用此處。留空則停用備援。" },
  "worker.name": { label: "Worker 名稱" },
  "worker.poll_seconds": { label: "輪詢間隔（秒）" },
  "worker.heartbeat_interval": { label: "心跳間隔（秒）" },
  "worker.stale_after": { label: "視為失聯（秒）", help: "超過此時間沒有心跳，worker 會被視為離線，其工作可被重新領取。" },
  "worker.reclaim_interval": { label: "重新領取檢查間隔（秒）" },
};

export function groupLabel(g: Pick<SettingsGroup, "group" | "label">): string {
  return GROUP_META[g.group]?.label ?? g.label ?? g.group;
}

export function groupDescription(g: Pick<SettingsGroup, "group" | "description">): string {
  return GROUP_META[g.group]?.description ?? g.description ?? "";
}

export function fieldLabel(group: string, f: SettingsField): string {
  return FIELD_META[`${group}.${f.key}`]?.label ?? f.label ?? f.key;
}

export function fieldHelp(group: string, f: SettingsField): string {
  return FIELD_META[`${group}.${f.key}`]?.help ?? f.help ?? "";
}

// ── Draft helpers ────────────────────────────────────────────────────────────

/** Initial editable value for a field. Secrets start blank ("keep stored"). */
export function initialValue(f: SettingsField): FieldValue {
  if (f.secret) return "";
  if (f.value === null || f.value === undefined) {
    if (f.type === "bool") return false;
    if (f.type === "int" || f.type === "float") return "";
    return "";
  }
  if (f.type === "bool") return f.value === true || String(f.value).toLowerCase() === "true";
  if (f.type === "int" || f.type === "float") {
    const n = Number(f.value);
    return Number.isFinite(n) ? n : "";
  }
  return String(f.value);
}

export function initialDraft(g: SettingsGroup): DraftValues {
  const out: DraftValues = {};
  for (const f of g.fields) out[f.key] = initialValue(f);
  return out;
}

/** True when a secret is stored server-side (the backend sends the mask). */
export function secretIsSet(f: SettingsField): boolean {
  return f.secret && typeof f.value === "string" && f.value !== "";
}

/** `show_if` = every listed field's current value must be one of the allowed values. */
export function isVisible(f: SettingsField, draft: DraftValues): boolean {
  if (!f.show_if) return true;
  return Object.entries(f.show_if).every(([k, allowed]) => allowed.includes(String(draft[k] ?? "")));
}

export function changedKeys(g: SettingsGroup, initial: DraftValues, draft: DraftValues): string[] {
  return g.fields
    .filter((f) => {
      const a = initial[f.key];
      const b = draft[f.key];
      if (f.secret) return typeof b === "string" && b.trim() !== "";
      return String(a ?? "") !== String(b ?? "");
    })
    .map((f) => f.key);
}

/** Client-side validation mirroring the backend's save rules. Returns key → message. */
export function validateDraft(g: SettingsGroup, draft: DraftValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of g.fields) {
    if (!isVisible(f, draft)) continue;
    const v = draft[f.key];
    if (f.is_url && typeof v === "string" && v.trim() !== "") {
      try {
        const u = new URL(v.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") errors[f.key] = "必須是 http:// 或 https:// 開頭的網址";
      } catch {
        errors[f.key] = "不是有效的網址（需包含 http:// 或 https://）";
      }
    }
    if ((f.type === "int" || f.type === "float") && v === "") errors[f.key] = "請輸入數值";
    if (f.type === "int" && typeof v === "number" && !Number.isInteger(v)) errors[f.key] = "必須是整數";
    if (f.options && !f.options.includes(String(v))) errors[f.key] = `必須是：${f.options.join("、")}`;
  }
  return errors;
}

/** Payload for a save/test: changed keys only for save, the full visible draft for test. */
export function payloadFor(g: SettingsGroup, draft: DraftValues, keys?: string[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of g.fields) {
    if (keys && !keys.includes(f.key)) continue;
    let v = draft[f.key];
    if (typeof v === "string") v = v.trim();
    // A blank secret means "use the stored one" for both save and test.
    if (f.secret && v === "") continue;
    out[f.key] = v;
  }
  return out;
}

/** Map a backend error like "ocr.base_url: 'x' is not a valid http(s) URL" to its field. */
export function fieldFromError(group: string, message: string): string | null {
  const m = new RegExp(`${group}\\.([a-zA-Z0-9_]+):`).exec(message);
  return m ? m[1] : null;
}
