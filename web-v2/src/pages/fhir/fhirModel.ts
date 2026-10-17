/**
 * Local types, labels and form <-> payload mapping for the FHIR server registry.
 * Contracts mirror node-server/src/admin/adminFhirServers.ts (validateServerPayload,
 * runConnectionWorkflow, runFhirTestRequest, discoverFhirMetadata).
 */
import type { FhirAuthProfile, FhirAuthType, FhirCapabilityResource, FhirOperation, FhirServer, FhirTokenAuthMethod } from "@/lib/types";

// ── constants mirrored from the backend validator ─────────────────────────────
export const SERVER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
export const RESOURCE_TYPE_RE = /^[A-Z][A-Za-z0-9]{0,63}$/;
export const READ_OPS: FhirOperation[] = ["metadata", "read", "search"];
export const WRITE_OPS: FhirOperation[] = ["create", "update", "patch", "delete"];
export const ALL_OPS: FhirOperation[] = [...READ_OPS, ...WRITE_OPS];
export const DEFAULT_OPS: FhirOperation[] = ["metadata", "read", "search"];
export const DEFAULT_RESOURCE_TYPES = [
  "Patient", "Observation", "Condition", "Medication", "MedicationRequest",
  "MedicationAdministration", "AllergyIntolerance", "DiagnosticReport",
  "DocumentReference", "Encounter", "Practitioner", "Organization",
];
/** Common FHIR R4 resource types, offered when no CapabilityStatement is known. */
export const COMMON_RESOURCE_TYPES = [
  ...DEFAULT_RESOURCE_TYPES,
  "Bundle", "CarePlan", "CareTeam", "Claim", "Composition", "Consent", "Coverage", "Device",
  "EpisodeOfCare", "FamilyMemberHistory", "Goal", "ImagingStudy", "Immunization", "Location",
  "MedicationDispense", "MedicationStatement", "PractitionerRole", "Procedure", "Provenance",
  "Questionnaire", "QuestionnaireResponse", "RelatedPerson", "ServiceRequest", "Specimen",
].filter((v, i, a) => a.indexOf(v) === i).sort();

export const HMAC_ALGS = ["HS256", "HS384", "HS512"];
export const ASYM_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];
export const IUA_JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

export function isWriteOp(op: string): boolean {
  return (WRITE_OPS as string[]).includes(op);
}

// ── labels ────────────────────────────────────────────────────────────────────
export const ENVIRONMENTS: { value: string; label: string; color: string }[] = [
  { value: "production", label: "正式環境", color: "red" },
  { value: "staging", label: "預備環境", color: "amber" },
  { value: "testing", label: "測試環境", color: "blue" },
  { value: "development", label: "開發環境", color: "teal" },
  { value: "custom", label: "自訂", color: "gray" },
];
export function envMeta(env: string | null | undefined): { label: string; color: string } | null {
  if (!env) return null;
  return ENVIRONMENTS.find((e) => e.value === env) ?? { label: env, color: "gray" };
}

export const AUTH_TYPE_LABEL: Record<FhirAuthType, string> = {
  none: "無認證",
  oauth2_client_credentials: "OAuth2 Client Credentials",
  oauth2_authorization_code: "OAuth2 Authorization Code",
};
export const AUTH_PROFILE_LABEL: Record<FhirAuthProfile, string> = {
  none: "一般 OAuth2",
  iua: "IHE IUA",
  smart: "SMART on FHIR",
};
export const TOKEN_METHOD_LABEL: Record<FhirTokenAuthMethod, string> = {
  client_secret_basic: "client_secret_basic（HTTP Basic）",
  client_secret_post: "client_secret_post（表單欄位）",
  client_secret_jwt: "client_secret_jwt（HMAC 簽章 JWT）",
  private_key_jwt: "private_key_jwt（非對稱金鑰 JWT）",
};
export const OP_LABEL: Record<FhirOperation, string> = {
  metadata: "metadata（能力聲明）",
  read: "read（讀取單筆）",
  search: "search（搜尋）",
  create: "create（新增）",
  update: "update（覆寫）",
  patch: "patch（部分修改）",
  delete: "delete（刪除）",
};
export const OP_HELP: Record<FhirOperation, string> = {
  metadata: "GET [base]/metadata，取得伺服器能力聲明",
  read: "GET [base]/<Type>/<id>",
  search: "GET [base]/<Type>?參數",
  create: "POST [base]/<Type>，在外部伺服器建立新資源",
  update: "PUT [base]/<Type>/<id>，整筆覆寫外部伺服器上的資源",
  patch: "PATCH [base]/<Type>/<id>，修改外部伺服器上的部分欄位",
  delete: "DELETE [base]/<Type>/<id>，從外部伺服器刪除資源",
};

export const OAUTH_STATUS_META: Record<string, { label: string; state: "ok" | "warn" | "error" | "idle" | "running" }> = {
  authorized: { label: "已授權", state: "ok" },
  expired: { label: "權杖已過期", state: "error" },
  not_authorized: { label: "尚未授權", state: "warn" },
  pending: { label: "授權進行中", state: "running" },
};

export const STEP_LABEL: Record<string, string> = {
  oauth: "OAuth2",
  oauth_metadata: "授權伺服器 metadata 探索",
  oauth_token: "取得存取權杖",
  fhir_metadata: "讀取 FHIR CapabilityStatement",
  fhir_test_path: "呼叫測試路徑",
};

// ── API response shapes not in lib/types ──────────────────────────────────────
export interface WorkflowStep {
  name: string;
  status: string; // ok | error | skipped
  message: string;
  duration_ms?: number;
  details?: Record<string, unknown>;
}
export interface CapabilitySummary {
  resourceType?: string;
  fhirVersion?: string;
  software?: Record<string, unknown>;
  implementation?: Record<string, unknown>;
  supported_resource_count?: number;
  supported_resources?: FhirCapabilityResource[];
}
export interface ConnectionTestResult {
  ok: boolean;
  probe: { status: string; message: string; latency_ms: number; details: { steps?: WorkflowStep[]; error?: string } };
  capability_summary: CapabilitySummary;
  raw_result?: Record<string, unknown> | null;
  server?: FhirServer;
}
export interface TestRequestResult {
  ok: boolean;
  error?: string;
  method?: string;
  url?: string;
  status_code?: number;
  reason?: string;
  duration_ms?: number;
  expected_statuses?: number[];
  explanation?: string | null;
  body_preview?: string;
}
export interface DiscoverResult {
  ok: boolean;
  error?: string;
  metadata_url?: string;
  fetched_at?: string;
  issuer?: string;
  token_endpoint?: string;
  authorization_endpoint?: string;
  jwks_uri?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  smart_capabilities?: string[];
}
export interface GeneratedKey {
  ok: boolean;
  private_key_pem: string;
  public_jwk: Record<string, unknown>;
  jwks: { keys: Record<string, unknown>[] };
  kid: string;
  alg: string;
}

// ── form state ────────────────────────────────────────────────────────────────
export interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

export interface FormState {
  server_key: string;
  name: string;
  display_name: string;
  environment: string;
  tags: string[];
  description: string;
  base_url: string;
  test_path: string;
  timeout_seconds: number;
  verify_tls: boolean;
  enabled: boolean;
  is_default: boolean;

  auth_type: FhirAuthType;
  auth_profile: FhirAuthProfile;
  use_metadata: boolean;
  auth_server_url: string;
  metadata_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  client_id: string;
  /** New secret value; empty = keep the stored one (if any). */
  client_secret: string;
  token_auth_method: FhirTokenAuthMethod;
  jwt_signing_alg: string;
  jwt_kid: string;
  /** New private key PEM; empty = keep the stored one (if any). */
  client_private_key: string;
  scope: string;
  resource: string;
  requested_token_type: string;
  default_token_strategy: string;
  metadata_headers: HeaderRow[];
  token_headers: HeaderRow[];
  resource_headers: HeaderRow[];

  allowed_resource_types: string[];
  allowed_operations: FhirOperation[];
}

let rowSeq = 0;
export function newRowId(): string {
  rowSeq += 1;
  return `h${Date.now().toString(36)}${rowSeq}`;
}

export function headersToRows(obj: Record<string, unknown> | null | undefined): HeaderRow[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).map(([key, value]) => ({ id: newRowId(), key, value: String(value ?? "") }));
}

export function rowsToHeaders(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return out;
}

export function emptyForm(): FormState {
  return {
    server_key: "",
    name: "",
    display_name: "",
    environment: "",
    tags: [],
    description: "",
    base_url: "",
    test_path: "",
    timeout_seconds: 30,
    verify_tls: true,
    enabled: true,
    is_default: false,
    auth_type: "none",
    auth_profile: "none",
    use_metadata: true,
    auth_server_url: "",
    metadata_url: "",
    authorization_endpoint: "",
    token_endpoint: "",
    client_id: "",
    client_secret: "",
    token_auth_method: "client_secret_basic",
    jwt_signing_alg: "",
    jwt_kid: "",
    client_private_key: "",
    scope: "",
    resource: "",
    requested_token_type: "",
    default_token_strategy: "",
    metadata_headers: [],
    token_headers: [],
    resource_headers: [],
    allowed_resource_types: [...DEFAULT_RESOURCE_TYPES],
    allowed_operations: [...DEFAULT_OPS],
  };
}

export function serverToForm(s: FhirServer): FormState {
  return {
    server_key: s.server_key ?? "",
    name: s.name ?? "",
    display_name: s.display_name ?? "",
    environment: s.environment ?? "",
    tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
    description: s.description ?? "",
    base_url: s.base_url ?? "",
    test_path: s.test_path ?? "",
    timeout_seconds: Number(s.timeout_seconds) || 30,
    verify_tls: s.verify_tls !== false,
    enabled: Boolean(s.enabled),
    is_default: Boolean(s.is_default),
    auth_type: s.auth_type ?? "none",
    auth_profile: s.auth_profile ?? "none",
    use_metadata: Boolean(s.use_metadata),
    auth_server_url: s.auth_server_url ?? "",
    metadata_url: s.metadata_url ?? "",
    authorization_endpoint: s.authorization_endpoint ?? "",
    token_endpoint: s.token_endpoint ?? "",
    client_id: s.client_id ?? "",
    client_secret: "",
    token_auth_method: s.token_auth_method ?? "client_secret_basic",
    jwt_signing_alg: s.jwt_signing_alg ?? "",
    jwt_kid: s.jwt_kid ?? "",
    client_private_key: "",
    scope: s.scope ?? "",
    resource: s.resource ?? "",
    requested_token_type: s.requested_token_type ?? "",
    default_token_strategy: s.default_token_strategy ?? "",
    metadata_headers: headersToRows(s.metadata_headers_json),
    token_headers: headersToRows(s.token_headers_json),
    resource_headers: headersToRows(s.resource_headers_json),
    allowed_resource_types: Array.isArray(s.allowed_resource_types) ? s.allowed_resource_types.map(String) : [],
    allowed_operations: Array.isArray(s.allowed_operations) ? s.allowed_operations : [...DEFAULT_OPS],
  };
}

/** Stable comparison key for the unsaved-changes guard (ignores header row ids). */
export function formFingerprint(f: FormState): string {
  const strip = (rows: HeaderRow[]) => rows.map((r) => [r.key, r.value]);
  return JSON.stringify({
    ...f,
    metadata_headers: strip(f.metadata_headers),
    token_headers: strip(f.token_headers),
    resource_headers: strip(f.resource_headers),
  });
}

/** Build the request body accepted by POST/PATCH/test (validateServerPayload). */
export function formToPayload(f: FormState): Record<string, unknown> {
  const oauth = f.auth_type !== "none";
  const cc = f.auth_type === "oauth2_client_credentials";
  const jwtMethod = cc && (f.token_auth_method === "private_key_jwt" || f.token_auth_method === "client_secret_jwt");
  const p: Record<string, unknown> = {
    server_key: f.server_key.trim().toLowerCase(),
    name: f.name.trim(),
    display_name: f.display_name.trim(),
    environment: f.environment,
    tags: f.tags,
    description: f.description.trim(),
    base_url: f.base_url.trim().replace(/\/+$/, ""),
    test_path: f.test_path.trim(),
    timeout_seconds: f.timeout_seconds,
    verify_tls: f.verify_tls,
    enabled: f.enabled,
    is_default: f.is_default,
    auth_type: f.auth_type,
    auth_profile: oauth ? f.auth_profile : "none",
    use_metadata: f.use_metadata,
    auth_server_url: oauth ? f.auth_server_url.trim() : "",
    metadata_url: oauth ? f.metadata_url.trim() : "",
    authorization_endpoint: f.auth_type === "oauth2_authorization_code" ? f.authorization_endpoint.trim() : "",
    token_endpoint: oauth ? f.token_endpoint.trim() : "",
    client_id: oauth ? f.client_id.trim() : "",
    token_auth_method: cc ? f.token_auth_method : "client_secret_basic",
    jwt_signing_alg: jwtMethod ? f.jwt_signing_alg : "",
    jwt_kid: jwtMethod ? f.jwt_kid.trim() : "",
    scope: oauth ? f.scope.trim() : "",
    resource: oauth ? f.resource.trim() : "",
    requested_token_type: oauth && f.auth_profile !== "smart" ? f.requested_token_type.trim() : "",
    default_token_strategy: f.default_token_strategy,
    metadata_headers_json: oauth ? rowsToHeaders(f.metadata_headers) : {},
    token_headers_json: oauth ? rowsToHeaders(f.token_headers) : {},
    resource_headers_json: rowsToHeaders(f.resource_headers),
    allowed_resource_types: f.allowed_resource_types,
    allowed_operations: f.allowed_operations,
  };
  // Secrets are write-only: omit to keep the stored value.
  if (oauth && f.client_secret.trim()) p.client_secret = f.client_secret.trim();
  if (cc && f.token_auth_method === "private_key_jwt" && f.client_private_key.trim()) {
    p.client_private_key = f.client_private_key.trim();
  }
  return p;
}

// ── validation ────────────────────────────────────────────────────────────────
export type FieldErrors = Partial<Record<string, string>>;

function httpUrlError(value: string, opts: { allowQuery: boolean }): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "請輸入完整網址，例如 https://fhir.example.org/r4";
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.host) return "只支援 http:// 或 https:// 開頭的網址";
  if (u.hash) return "網址不可包含 # 片段";
  if (!opts.allowQuery && u.search) return "Base URL 不可包含查詢字串（?…）";
  return null;
}

export interface SecretState {
  secretConfigured: boolean;
  privateKeyConfigured: boolean;
  /** Editing an existing server (vs. creating). */
  editing: boolean;
}

function headerErrors(rows: HeaderRow[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (!k && !r.value.trim()) continue;
    if (!k) return "有標頭缺少名稱";
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) return `標頭名稱「${k}」含有不合法字元`;
    if (k.toLowerCase() === "authorization") return "不可自訂 Authorization 標頭（權杖由系統自動附加）";
    if (seen.has(k.toLowerCase())) return `標頭「${k}」重複`;
    seen.add(k.toLowerCase());
  }
  return null;
}

/** Field-level validation mirroring the backend, keyed by form field name. */
export function validateForm(f: FormState, s: SecretState): FieldErrors {
  const e: FieldErrors = {};
  const key = f.server_key.trim();
  if (!key) e.server_key = "必填";
  else if (!SERVER_KEY_RE.test(key)) e.server_key = "2–64 字元，以英數字開頭，只能包含英數字、點、底線、連字號";
  if (!f.name.trim()) e.name = "必填";
  if (!f.base_url.trim()) e.base_url = "必填";
  else {
    const err = httpUrlError(f.base_url.trim(), { allowQuery: false });
    if (err) e.base_url = err;
  }
  if (f.test_path.includes("://")) e.test_path = "請填相對於 Base URL 的路徑（例如 Patient?_count=1），不可是完整網址";
  if (!Number.isInteger(f.timeout_seconds) || f.timeout_seconds < 1 || f.timeout_seconds > 120) e.timeout_seconds = "需介於 1–120 秒";
  if (f.is_default && !f.enabled) e.is_default = "預設伺服器必須為啟用狀態";

  const oauth = f.auth_type !== "none";
  const cc = f.auth_type === "oauth2_client_credentials";
  const ac = f.auth_type === "oauth2_authorization_code";
  if (oauth) {
    const urlFields: ("auth_server_url" | "metadata_url" | "token_endpoint" | "authorization_endpoint")[] = [
      "auth_server_url",
      "metadata_url",
      "token_endpoint",
      ...(ac ? (["authorization_endpoint"] as const) : []),
    ];
    for (const field of urlFields) {
      const v = f[field].trim();
      if (v) {
        const err = httpUrlError(v, { allowQuery: true });
        if (err) e[field] = err;
      }
    }
    if (!f.client_id.trim()) e.client_id = "OAuth2 需要 client_id";
    const discoverable = Boolean(f.metadata_url.trim() || f.auth_server_url.trim());
    if (!f.token_endpoint.trim() && !discoverable) {
      e.token_endpoint = "請填 Token endpoint，或提供 Metadata URL / 授權伺服器 URL 讓系統自動探索";
    }
    if (ac && !f.authorization_endpoint.trim() && !discoverable) {
      e.authorization_endpoint = "請填 Authorization endpoint，或提供 Metadata URL / 授權伺服器 URL";
    }
    const hasSecret = Boolean(f.client_secret.trim()) || s.secretConfigured;
    if (cc) {
      if (f.token_auth_method === "private_key_jwt") {
        if (!f.client_private_key.trim() && !s.privateKeyConfigured) e.client_private_key = "private_key_jwt 需要私鑰：請按「產生金鑰」或貼上 PEM";
        else if (f.client_private_key.trim() && !f.client_private_key.includes("PRIVATE KEY")) e.client_private_key = "看起來不是 PEM 格式的私鑰";
        if (f.jwt_signing_alg && !ASYM_ALGS.includes(f.jwt_signing_alg)) e.jwt_signing_alg = "private_key_jwt 需使用非對稱演算法";
      } else {
        if (!hasSecret) e.client_secret = `${f.token_auth_method} 需要 client secret`;
        if (f.token_auth_method === "client_secret_jwt" && f.jwt_signing_alg && !HMAC_ALGS.includes(f.jwt_signing_alg)) {
          e.jwt_signing_alg = "client_secret_jwt 需使用 HS256 / HS384 / HS512";
        }
      }
    }
    if (ac) {
      // Backend limitation: PATCH on an Authorization Code server drops the stored
      // secret unless it is re-sent (adminFhirServers.ts updateFhirServer keepSecret).
      if (s.editing && s.secretConfigured && !f.client_secret.trim() && f.auth_profile === "iua") {
        e.client_secret = "儲存授權碼（IUA）設定時需重新輸入 client secret，否則已儲存的值會被清除";
      } else if (f.auth_profile === "iua" && !hasSecret) {
        e.client_secret = "IUA 設定檔需要 client secret";
      }
    }
    const mh = headerErrors(f.metadata_headers);
    if (mh) e.metadata_headers = mh;
    const th = headerErrors(f.token_headers);
    if (th) e.token_headers = th;
  }
  const rh = headerErrors(f.resource_headers);
  if (rh) e.resource_headers = rh;

  const badTypes = f.allowed_resource_types.filter((t) => !RESOURCE_TYPE_RE.test(t));
  if (badTypes.length) e.allowed_resource_types = `不是合法的 FHIR 資源類型：${badTypes.join(", ")}`;
  if (f.allowed_operations.length === 0) e.allowed_operations = "至少需允許一種操作";
  return e;
}

export const STEP_FIELDS: string[][] = [
  ["server_key", "name", "display_name", "environment", "tags", "description", "base_url", "test_path", "timeout_seconds", "verify_tls", "is_default", "resource_headers"],
  [
    "auth_type", "auth_profile", "auth_server_url", "metadata_url", "authorization_endpoint", "token_endpoint", "client_id",
    "client_secret", "token_auth_method", "jwt_signing_alg", "client_private_key", "metadata_headers", "token_headers",
  ],
  ["allowed_resource_types", "allowed_operations"],
];

export function stepHasErrors(step: number, errors: FieldErrors): boolean {
  return (STEP_FIELDS[step] ?? []).some((k) => Boolean(errors[k]));
}

/** Map a backend 400 message to a form field (best effort) so it can render inline. */
export function backendErrorField(message: string): string | null {
  const m = message.toLowerCase();
  const fields = [
    "server_key", "base_url", "test_path", "timeout_seconds", "auth_server_url", "metadata_url", "authorization_endpoint",
    "token_endpoint", "client_id", "client_secret", "client_private_key", "jwt_signing_alg", "token_auth_method",
    "auth_profile", "auth_type", "default_token_strategy", "environment",
  ];
  for (const f of fields) if (m.includes(f)) return f;
  if (m.includes("name is required")) return "name";
  if (m.includes("resource_type")) return "allowed_resource_types";
  if (m.includes("operations")) return "allowed_operations";
  if (m.includes("default fhir server must be enabled")) return "is_default";
  if (m.includes("headers") || m.includes("authorization")) return "resource_headers";
  if (m.includes("duplicate key") || m.includes("unique")) return "server_key";
  return null;
}

export function serverTitle(s: Pick<FhirServer, "display_name" | "name" | "server_key">): string {
  return s.display_name || s.name || s.server_key;
}

export function jwksUrl(serverId: string): string {
  return `${window.location.origin}/fhir-client/${encodeURIComponent(serverId)}/jwks.json`;
}
