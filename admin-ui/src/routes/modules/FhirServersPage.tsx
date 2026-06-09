import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { formatRelative } from "../../lib/time";
import { toast } from "../../components/toast";
import { Modal } from "../../components/Modal";
import { StatusBadge } from "../../components/StatusBadge";
import type {
  FhirAuthProfile,
  FhirAuthType,
  FhirOAuthAuthorizePayload,
  FhirOAuthStatus,
  FhirOperation,
  FhirServer,
  FhirServerPayload,
  FhirServerProbePayload,
  FhirServersPayload,
  FhirTokenAuthMethod,
} from "../../lib/types";

const AUTH_TYPE_OPTIONS: { value: FhirAuthType; label: string }[] = [
  { value: "none", label: "None (no auth)" },
  { value: "oauth2_client_credentials", label: "OAuth2 Client Credentials" },
  { value: "oauth2_authorization_code", label: "OAuth2 Authorization Code (+PKCE)" },
];

const AUTH_PROFILE_OPTIONS: { value: FhirAuthProfile; label: string }[] = [
  { value: "none", label: "None (plain OAuth2)" },
  { value: "iua", label: "IUA" },
  { value: "smart", label: "SMART on FHIR" },
];

const TOKEN_AUTH_METHOD_OPTIONS: { value: FhirTokenAuthMethod; label: string }[] = [
  { value: "client_secret_basic", label: "client_secret_basic (HTTP Basic)" },
  { value: "client_secret_post", label: "client_secret_post (form body)" },
  { value: "client_secret_jwt", label: "client_secret_jwt (HMAC assertion)" },
  { value: "private_key_jwt", label: "private_key_jwt (asymmetric assertion)" },
];

const HMAC_SIGNING_ALGS = ["HS256", "HS384", "HS512"];
const ASYMMETRIC_SIGNING_ALGS = [
  "RS256", "RS384", "RS512",
  "ES256", "ES384", "ES512",
  "PS256", "PS384", "PS512",
];

function oauthBadgeTone(status: FhirOAuthStatus): string {
  switch (status) {
    case "authorized":
      return "badge--ok";
    case "expired":
      return "badge--bad";
    case "pending":
      return "badge--muted";
    default:
      return "badge--warn";
  }
}

function oauthBadgeLabel(status: FhirOAuthStatus): string {
  switch (status) {
    case "authorized":
      return "Authorized";
    case "expired":
      return "Token expired";
    case "pending":
      return "Authorizing…";
    default:
      return "Not authorized";
  }
}

// A 1-second ticking clock, only running while `active` (avoids idle timers).
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function formatCountdown(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function TokenCountdown({
  label,
  expiresAt,
  fallback,
}: {
  label: string;
  expiresAt: string | null;
  // Shown when there is no expiry timestamp (e.g. a non-expiring offline refresh
  // token). When omitted, the row is hidden entirely.
  fallback?: string;
}): JSX.Element | null {
  const now = useNow(Boolean(expiresAt));
  if (!expiresAt) {
    if (!fallback) return null;
    return (
      <div className="fhir-token-countdown fhir-token-countdown--ok">
        <span className="fhir-token-countdown__label">{label}</span>
        <span className="fhir-token-countdown__value">{fallback}</span>
      </div>
    );
  }
  const ms = new Date(expiresAt).getTime() - now;
  const tone = ms <= 0 ? "bad" : ms < 60_000 ? "warn" : "ok";
  return (
    <div className={`fhir-token-countdown fhir-token-countdown--${tone}`}>
      <span className="fhir-token-countdown__label">{label}</span>
      <span className="fhir-token-countdown__value">
        {ms <= 0 ? "expired" : `expires in ${formatCountdown(ms)}`}
      </span>
    </div>
  );
}

function signingAlgOptions(method: FhirTokenAuthMethod): string[] {
  return method === "private_key_jwt" ? ASYMMETRIC_SIGNING_ALGS : HMAC_SIGNING_ALGS;
}

function defaultSigningAlg(method: FhirTokenAuthMethod): string {
  return method === "private_key_jwt" ? "RS384" : "HS384";
}

function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  } catch {
    toast.error("Copy failed — your browser blocked clipboard access");
  }
}

interface GeneratedKey {
  private_key_pem: string;
  public_jwk: Record<string, unknown>;
  kid: string;
  alg: string;
}

function normalizeTokenAuthMethod(value: unknown): FhirTokenAuthMethod {
  return value === "client_secret_post" ||
    value === "client_secret_jwt" ||
    value === "private_key_jwt"
    ? value
    : "client_secret_basic";
}

const SCOPE_PLACEHOLDER: Record<FhirAuthProfile, string> = {
  none: "system/*.read system/*.write",
  iua: "(scope is profile-specific; optional)",
  smart: "system/*.rs system/Patient.rs",
};

function normalizeAuthProfile(value: unknown): FhirAuthProfile {
  return value === "iua" || value === "smart" ? value : "none";
}

const OPERATIONS: FhirOperation[] = [
  "metadata",
  "read",
  "search",
  "create",
  "update",
  "patch",
  "delete",
];

const DEFAULT_RESOURCE_TYPES =
  "Patient, Observation, Condition, Medication, MedicationRequest, DiagnosticReport, DocumentReference, Encounter, Practitioner, Organization";

interface HeaderRow {
  id: string;
  enabled: boolean;
  key: string;
  value: string;
}

type ImportResolution = "skip" | "overwrite" | "copy";

interface ImportRow {
  id: string;
  form: FormState;
  selected: boolean;
  conflict: FhirServer | null;
  resolution: ImportResolution;
  status?: "ok" | "error" | "skipped";
  message?: string;
}

interface FormState {
  fhir_server_id?: string;
  // The id to reuse when CREATING from an imported config, so the published
  // JWKS URL (/fhir-client/{id}/jwks.json) stays identical across export→import.
  // Unset for normal new servers and copies (they get a fresh id).
  preserved_id?: string;
  server_key: string;
  name: string;
  description: string;
  base_url: string;
  test_path: string;
  default_token_strategy: string;
  enabled: boolean;
  is_default: boolean;
  auth_type: FhirAuthType;
  auth_profile: FhirAuthProfile;
  auth_server_url: string;
  metadata_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  use_metadata: boolean;
  client_id: string;
  client_secret: string;
  token_auth_method: FhirTokenAuthMethod;
  client_private_key: string;
  client_private_key_configured: boolean;
  client_public_jwk_configured: boolean;
  jwt_signing_alg: string;
  jwt_kid: string;
  scope: string;
  resource: string;
  requested_token_type: string;
  metadata_headers: HeaderRow[];
  token_headers: HeaderRow[];
  resource_headers: HeaderRow[];
  verify_tls: boolean;
  timeout_seconds: number;
  allowed_resource_types: string;
  allowed_operations: FhirOperation[];
}

function newHeaderRow(key = "", value = "", enabled = true): HeaderRow {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    enabled,
    key,
    value,
  };
}

function headersObjectToRows(headers: Record<string, unknown> | null | undefined): HeaderRow[] {
  const rows = Object.entries(headers || {}).map(([key, value]) =>
    newHeaderRow(key, String(value ?? ""), true),
  );
  return rows.length ? rows : [newHeaderRow()];
}

function headerRowsToObject(rows: HeaderRow[], label: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!row.enabled && !key && !row.value.trim()) continue;
    if (!row.enabled) continue;
    if (!key) {
      if (row.value.trim()) throw new Error(`${label} header key is required`);
      continue;
    }
    if (key.toLowerCase() === "authorization") {
      throw new Error(`${label} cannot set Authorization; it is managed automatically`);
    }
    result[key] = row.value;
  }
  return result;
}

type ExportServer = FhirServer & {
  client_secret?: string;
  client_private_key?: string;
};

function exportPayload(servers: ExportServer[]): string {
  return JSON.stringify(
    {
      format: "taiwan-health-mcp-fhir-servers",
      version: 1,
      exported_at: new Date().toISOString(),
      servers: servers.map((server) => ({
        // Preserved so a re-import reuses the same id → stable JWKS URL.
        fhir_server_id: server.fhir_server_id,
        server_key: server.server_key,
        name: server.name,
        description: server.description,
        base_url: server.base_url,
        test_path: server.test_path,
        default_token_strategy: server.default_token_strategy,
        enabled: server.enabled,
        is_default: server.is_default,
        auth_type: server.auth_type,
        auth_profile: server.auth_profile,
        auth_server_url: server.auth_server_url,
        metadata_url: server.metadata_url,
        authorization_endpoint: server.authorization_endpoint,
        token_endpoint: server.token_endpoint,
        use_metadata: server.use_metadata,
        client_id: server.client_id,
        client_secret: server.client_secret ?? "",
        token_auth_method: server.token_auth_method,
        client_private_key: server.client_private_key ?? "",
        jwt_signing_alg: server.jwt_signing_alg,
        jwt_kid: server.jwt_kid,
        scope: server.scope,
        resource: server.resource,
        requested_token_type: server.requested_token_type,
        metadata_headers_json: server.metadata_headers_json || {},
        token_headers_json: server.token_headers_json || {},
        resource_headers_json: server.resource_headers_json || {},
        verify_tls: server.verify_tls,
        timeout_seconds: server.timeout_seconds,
        allowed_resource_types: server.allowed_resource_types || [],
        allowed_operations: server.allowed_operations || [],
      })),
    },
    null,
    2,
  );
}

function importedServerToForm(payload: Record<string, unknown>): FormState {
  const metadataHeaders = payload.metadata_headers_json;
  const tokenHeaders = payload.token_headers_json;
  const resourceHeaders = payload.resource_headers_json;
  return {
    fhir_server_id: undefined,
    // Reuse the exported id on create so the JWKS URL is unchanged.
    preserved_id: payload.fhir_server_id ? String(payload.fhir_server_id) : undefined,
    server_key: String(payload.server_key || ""),
    name: String(payload.name || ""),
    description: String(payload.description || ""),
    base_url: String(payload.base_url || ""),
    test_path: String(payload.test_path || ""),
    default_token_strategy: String(payload.default_token_strategy || ""),
    enabled: payload.enabled !== false,
    is_default: Boolean(payload.is_default),
    auth_type:
      payload.auth_type === "oauth2_client_credentials" ||
      payload.auth_type === "oauth2_authorization_code"
        ? payload.auth_type
        : "none",
    auth_profile:
      payload.auth_profile != null
        ? normalizeAuthProfile(payload.auth_profile)
        : payload.enable_iua
          ? "iua"
          : "none",
    auth_server_url: String(payload.auth_server_url || ""),
    metadata_url: String(payload.metadata_url || ""),
    authorization_endpoint: String(payload.authorization_endpoint || ""),
    token_endpoint: String(payload.token_endpoint || ""),
    use_metadata: payload.use_metadata !== false,
    client_id: String(payload.client_id || ""),
    client_secret: String(payload.client_secret || ""),
    token_auth_method: normalizeTokenAuthMethod(payload.token_auth_method),
    client_private_key: String(payload.client_private_key || ""),
    client_private_key_configured: Boolean(payload.client_private_key),
    client_public_jwk_configured: Boolean(payload.client_public_jwk_configured),
    jwt_signing_alg: String(payload.jwt_signing_alg || ""),
    jwt_kid: String(payload.jwt_kid || ""),
    scope: String(payload.scope || ""),
    resource: String(payload.resource || ""),
    requested_token_type: String(payload.requested_token_type || ""),
    metadata_headers: headersObjectToRows(
      metadataHeaders && typeof metadataHeaders === "object" && !Array.isArray(metadataHeaders)
        ? (metadataHeaders as Record<string, unknown>)
        : {},
    ),
    token_headers: headersObjectToRows(
      tokenHeaders && typeof tokenHeaders === "object" && !Array.isArray(tokenHeaders)
        ? (tokenHeaders as Record<string, unknown>)
        : {},
    ),
    resource_headers: headersObjectToRows(
      resourceHeaders && typeof resourceHeaders === "object" && !Array.isArray(resourceHeaders)
        ? (resourceHeaders as Record<string, unknown>)
        : {},
    ),
    verify_tls: payload.verify_tls !== false,
    timeout_seconds: Number(payload.timeout_seconds) || 30,
    allowed_resource_types: Array.isArray(payload.allowed_resource_types)
      ? payload.allowed_resource_types.map(String).join(", ")
      : DEFAULT_RESOURCE_TYPES,
    allowed_operations: Array.isArray(payload.allowed_operations)
      ? (payload.allowed_operations.filter((op) =>
          OPERATIONS.includes(op as FhirOperation),
        ) as FhirOperation[])
      : ["metadata", "read", "search"],
  };
}

function parseServersFromFile(text: string): Record<string, unknown>[] {
  const parsed = JSON.parse(text);
  const raw: unknown = Array.isArray(parsed?.servers) ? parsed.servers : parsed;
  const list = Array.isArray(raw) ? raw : [raw];
  const servers = list.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
  if (!servers.length) {
    throw new Error("Import file must contain one FHIR server object or a servers array");
  }
  return servers;
}

function makeEmptyForm(): FormState {
  return {
    server_key: "",
    name: "",
    description: "",
    base_url: "",
    test_path: "",
    default_token_strategy: "",
    enabled: true,
    is_default: false,
    auth_type: "none",
    auth_profile: "none",
    auth_server_url: "",
    metadata_url: "",
    authorization_endpoint: "",
    token_endpoint: "",
    use_metadata: true,
    client_id: "",
    client_secret: "",
    token_auth_method: "client_secret_basic",
    client_private_key: "",
    client_private_key_configured: false,
    client_public_jwk_configured: false,
    jwt_signing_alg: "",
    jwt_kid: "",
    scope: "",
    resource: "",
    requested_token_type: "",
    metadata_headers: [newHeaderRow()],
    token_headers: [newHeaderRow()],
    resource_headers: [newHeaderRow()],
    verify_tls: true,
    timeout_seconds: 30,
    allowed_resource_types: DEFAULT_RESOURCE_TYPES,
    allowed_operations: ["metadata", "read", "search"],
  };
}

function serverToForm(server: FhirServer): FormState {
  return {
    fhir_server_id: server.fhir_server_id,
    server_key: server.server_key,
    name: server.name,
    description: server.description,
    base_url: server.base_url,
    test_path: server.test_path,
    default_token_strategy: server.default_token_strategy,
    enabled: server.enabled,
    is_default: server.is_default,
    auth_type: server.auth_type,
    auth_profile: normalizeAuthProfile(server.auth_profile),
    auth_server_url: server.auth_server_url,
    metadata_url: server.metadata_url,
    authorization_endpoint: server.authorization_endpoint,
    token_endpoint: server.token_endpoint,
    use_metadata: server.use_metadata,
    client_id: server.client_id,
    client_secret: "",
    token_auth_method: normalizeTokenAuthMethod(server.token_auth_method),
    client_private_key: "",
    client_private_key_configured: server.client_private_key_configured,
    client_public_jwk_configured: server.client_public_jwk_configured,
    jwt_signing_alg: server.jwt_signing_alg,
    jwt_kid: server.jwt_kid,
    scope: server.scope,
    resource: server.resource,
    requested_token_type: server.requested_token_type,
    metadata_headers: headersObjectToRows(server.metadata_headers_json),
    token_headers: headersObjectToRows(server.token_headers_json),
    resource_headers: headersObjectToRows(server.resource_headers_json),
    verify_tls: server.verify_tls,
    timeout_seconds: server.timeout_seconds,
    allowed_resource_types: (server.allowed_resource_types || []).join(", "),
    allowed_operations: server.allowed_operations,
  };
}

function toPayload(form: FormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    server_key: form.server_key.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    base_url: form.base_url.trim(),
    test_path: form.test_path.trim(),
    default_token_strategy: form.default_token_strategy,
    enabled: form.enabled,
    is_default: form.is_default,
    auth_type: form.auth_type,
    auth_profile: form.auth_type !== "none" ? form.auth_profile : "none",
    auth_server_url: form.auth_server_url.trim(),
    metadata_url: form.metadata_url.trim(),
    authorization_endpoint: form.authorization_endpoint.trim(),
    token_endpoint: form.token_endpoint.trim(),
    use_metadata: form.use_metadata,
    client_id: form.client_id.trim(),
    token_auth_method:
      form.auth_type === "oauth2_client_credentials"
        ? form.token_auth_method
        : "client_secret_basic",
    jwt_signing_alg: form.jwt_signing_alg.trim(),
    jwt_kid: form.jwt_kid.trim(),
    scope: form.scope.trim(),
    resource: form.resource.trim(),
    requested_token_type: form.requested_token_type.trim(),
    metadata_headers_json: headerRowsToObject(form.metadata_headers, "Metadata headers"),
    token_headers_json: headerRowsToObject(form.token_headers, "Token headers"),
    resource_headers_json: headerRowsToObject(form.resource_headers, "Resource headers"),
    verify_tls: form.verify_tls,
    timeout_seconds: Number(form.timeout_seconds) || 30,
    allowed_resource_types: form.allowed_resource_types
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    allowed_operations: form.allowed_operations,
  };
  if (form.client_secret.trim()) {
    payload.client_secret = form.client_secret.trim();
  }
  if (form.client_private_key.trim()) {
    payload.client_private_key = form.client_private_key.trim();
  }
  // On create from an imported config, ask the backend to reuse this id so the
  // JWKS URL stays stable. Ignored by the update path (id comes from the URL).
  if (form.preserved_id) {
    payload.fhir_server_id = form.preserved_id;
  }
  return payload;
}

function capabilityLine(server: FhirServer): string {
  const summary = server.capability_summary || {};
  const version = summary.fhirVersion ? `FHIR ${summary.fhirVersion}` : "FHIR version unknown";
  const count =
    summary.supported_resource_count != null
      ? `${summary.supported_resource_count} resources`
      : "no capability summary";
  return `${version} · ${count}`;
}

function statusForProbe(server: FhirServer): "ok" | "degraded" | "error" {
  if (server.last_probe_status === "ok") return "ok";
  if (server.last_probe_status) return "error";
  return "degraded";
}

function OperationCheckboxes({
  value,
  onChange,
}: {
  value: FhirOperation[];
  onChange: (next: FhirOperation[]) => void;
}): JSX.Element {
  return (
    <div className="fhir-check-grid">
      {OPERATIONS.map((op) => (
        <label key={op} className="fhir-check">
          <input
            type="checkbox"
            checked={value.includes(op)}
            onChange={(e) => {
              const next = e.target.checked
                ? [...value, op]
                : value.filter((item) => item !== op);
              onChange(next);
            }}
          />
          <span>{op}</span>
        </label>
      ))}
    </div>
  );
}

function HeaderRowsEditor({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: HeaderRow[];
  onChange: (next: HeaderRow[]) => void;
}): JSX.Element {
  const updateRow = (id: string, patch: Partial<HeaderRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <div className="fhir-headers-editor">
      <div className="fhir-headers-editor__head">
        <span className="settings-field__label">{label}</span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => onChange([...rows, newHeaderRow()])}
        >
          Add header
        </button>
      </div>
      <div className="fhir-header-row fhir-header-row--head">
        <span>Use</span>
        <span>Key</span>
        <span>Value</span>
        <span />
      </div>
      {rows.map((row) => (
        <div key={row.id} className="fhir-header-row">
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={(e) => updateRow(row.id, { enabled: e.target.checked })}
            aria-label="Enable header"
          />
          <input
            value={row.key}
            onChange={(e) => updateRow(row.id, { key: e.target.value })}
            placeholder="Header-Name"
          />
          <input
            value={row.value}
            onChange={(e) => updateRow(row.id, { value: e.target.value })}
            placeholder="value"
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              const next = rows.filter((item) => item.id !== row.id);
              onChange(next.length ? next : [newHeaderRow()]);
            }}
            aria-label="Remove header"
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

// Collapsible form section. Keeps the (long) FHIR server form scannable: the
// essentials stay open while advanced groups (headers, access control) fold away.
function FormSection({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <details className="fhir-section" open={defaultOpen}>
      <summary className="fhir-section__summary">
        <span className="fhir-section__title">{title}</span>
        {hint != null && hint !== "" ? (
          <span className="fhir-section__hint">{hint}</span>
        ) : null}
        <span className="fhir-section__chevron" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="fhir-section__body">{children}</div>
    </details>
  );
}

const countHeaders = (rows: HeaderRow[]): number =>
  rows.filter((r) => r.enabled && r.key.trim()).length;

function FhirServerForm({
  initial,
  onCancel,
  onSave,
  saving,
}: {
  initial: FormState;
  onCancel: () => void;
  onSave: (form: FormState) => void;
  saving: boolean;
}): JSX.Element {
  const [form, setForm] = useState<FormState>(initial);
  const isClientCreds = form.auth_type === "oauth2_client_credentials";
  const isAuthCode = form.auth_type === "oauth2_authorization_code";
  const isOAuth = isClientCreds || isAuthCode;
  const [scopeOptions, setScopeOptions] = useState<string[]>([]);
  const [scopeFilter, setScopeFilter] = useState<string>("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string>("");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string>("");
  const [genKey, setGenKey] = useState<GeneratedKey | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Generate an asymmetric signing keypair on the server. The private key is
  // returned once: we drop it into the PEM field (encrypted on save) and offer
  // it for download/backup; the public JWK is published at the JWKS endpoint.
  const generateKeypair = async () => {
    const alg = form.jwt_signing_alg || defaultSigningAlg("private_key_jwt");
    setGenBusy(true);
    setGenError("");
    try {
      const res = await api.post<{
        ok: boolean;
        private_key_pem?: string;
        public_jwk?: Record<string, unknown>;
        kid?: string;
        alg?: string;
        error?: string;
      }>("/admin/api/fhir-servers/generate-key", { alg });
      if (res.ok && res.private_key_pem && res.public_jwk && res.kid) {
        set("client_private_key", res.private_key_pem);
        set("jwt_kid", res.kid);
        if (res.alg) set("jwt_signing_alg", res.alg);
        setGenKey({
          private_key_pem: res.private_key_pem,
          public_jwk: res.public_jwk,
          kid: res.kid,
          alg: res.alg || alg,
        });
        toast.success("Keypair generated — download the private key now");
      } else {
        setGenError(res.error || "Failed to generate keypair");
      }
    } catch (err) {
      setGenError(String(err));
    } finally {
      setGenBusy(false);
    }
  };

  // Show the URL for the saved id, or the preserved id of an imported-but-unsaved
  // config (so the user sees the URL that will be kept after saving).
  const jwksId = form.fhir_server_id || form.preserved_id;
  const jwksUrl = jwksId
    ? `${window.location.origin}/fhir-client/${jwksId}/jwks.json`
    : "";
  // The OAuth2 redirect/callback URI to register at the authorization server.
  const callbackUrl = `${window.location.origin}/fhir-oauth/callback`;

  // Scope is a space-separated string; chips add/remove individual tokens while
  // preserving any manually-typed extras and their order.
  const scopeTokens = form.scope.split(/\s+/).filter(Boolean);
  const toggleScope = (scope: string) => {
    const tokens = form.scope.split(/\s+/).filter(Boolean);
    const idx = tokens.indexOf(scope);
    if (idx >= 0) tokens.splice(idx, 1);
    else tokens.push(scope);
    set("scope", tokens.join(" "));
  };
  // Bulk add/remove (operates on the filtered set so "select all" can mean "all
  // matching the search"). Preserves manual extras and existing order.
  const addScopes = (list: string[]) => {
    const tokens = form.scope.split(/\s+/).filter(Boolean);
    const seen = new Set(tokens);
    for (const s of list) {
      if (!seen.has(s)) {
        tokens.push(s);
        seen.add(s);
      }
    }
    set("scope", tokens.join(" "));
  };
  const removeScopes = (list: string[]) => {
    const drop = new Set(list);
    const tokens = form.scope
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !drop.has(t));
    set("scope", tokens.join(" "));
  };

  // Discovered scopes can be hundreds long, so never render them all at once:
  // filter by the search box and cap how many rows are drawn inside a scrollable
  // box. Selected scopes are always shown as removable chips regardless.
  const SCOPE_RENDER_CAP = 200;
  const scopeFilterLc = scopeFilter.trim().toLowerCase();
  const filteredScopeOptions = scopeFilterLc
    ? scopeOptions.filter((s) => s.toLowerCase().includes(scopeFilterLc))
    : scopeOptions;
  const scopeShown = filteredScopeOptions.slice(0, SCOPE_RENDER_CAP);
  const selectedInFiltered = filteredScopeOptions.filter((s) =>
    scopeTokens.includes(s),
  ).length;
  const allFilteredSelected =
    filteredScopeOptions.length > 0 &&
    selectedInFiltered === filteredScopeOptions.length;

  // Fetch the discovery doc and surface its scopes_supported as a datalist.
  // Triggered when the Metadata URL field loses focus (use_metadata + a URL present).
  const discoverScopes = async () => {
    if (!form.use_metadata || !form.metadata_url.trim()) return;
    setDiscovering(true);
    setDiscoverError("");
    try {
      const res = await api.post<{
        ok: boolean;
        scopes_supported?: string[];
        error?: string;
      }>("/admin/api/fhir-servers/discover", {
        metadata_url: form.metadata_url.trim(),
        auth_server_url: form.auth_server_url.trim(),
        auth_profile: isOAuth ? form.auth_profile : "none",
        verify_tls: form.verify_tls,
        timeout_seconds: Number(form.timeout_seconds) || 30,
      });
      if (res.ok && Array.isArray(res.scopes_supported)) {
        setScopeOptions(res.scopes_supported);
        if (!res.scopes_supported.length) {
          setDiscoverError("Metadata has no scopes_supported; enter scope manually.");
        }
      } else {
        setScopeOptions([]);
        setDiscoverError(res.error || "Metadata unavailable; enter scope manually.");
      }
    } catch (err) {
      setScopeOptions([]);
      setDiscoverError(`Metadata unavailable; enter scope manually. (${String(err)})`);
    } finally {
      setDiscovering(false);
    }
  };

  const authProfileLabel =
    AUTH_PROFILE_OPTIONS.find((o) => o.value === form.auth_profile)?.label ??
    form.auth_profile;
  const authHint = isOAuth ? `OAuth2 · ${authProfileLabel}` : "No auth";
  const headerCount =
    countHeaders(form.resource_headers) +
    (isOAuth
      ? countHeaders(form.metadata_headers) + countHeaders(form.token_headers)
      : 0);

  return (
    <form
      className="fhir-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <FormSection title="General" hint={form.server_key || "new server"} defaultOpen>
        <div className="fhir-form-grid">
          <label>
            <span>Server key</span>
            <input
              value={form.server_key}
              onChange={(e) => set("server_key", e.target.value)}
              placeholder="hospital-a"
              required
            />
          </label>
          <label>
            <span>Name</span>
            <input value={form.name} onChange={(e) => set("name", e.target.value)} required />
          </label>
          <label className="fhir-form-wide">
            <span>Base URL</span>
            <input
              value={form.base_url}
              onChange={(e) => set("base_url", e.target.value)}
              placeholder="https://fhir.example.com/fhir"
              required
            />
          </label>
          <label className="fhir-form-wide">
            <span>Description</span>
            <input value={form.description} onChange={(e) => set("description", e.target.value)} />
          </label>
        </div>
        <div className="fhir-toggle-row">
          <label className="switch">
            <input checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} type="checkbox" />
            <span className="switch__track" />
            <span className="switch__label">Enabled</span>
          </label>
          <label className="switch">
            <input checked={form.is_default} onChange={(e) => set("is_default", e.target.checked)} type="checkbox" />
            <span className="switch__track" />
            <span className="switch__label">Default</span>
          </label>
        </div>
      </FormSection>

      <FormSection title="Authentication & connection" hint={authHint} defaultOpen>
        <div className="fhir-form-grid">
          <label>
            <span>Auth mode</span>
            <select
              value={form.auth_type}
              onChange={(e) => set("auth_type", e.target.value as FormState["auth_type"])}
            >
              {AUTH_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Timeout seconds</span>
            <input
              type="number"
              min={1}
              max={120}
              value={form.timeout_seconds}
              onChange={(e) => set("timeout_seconds", Number(e.target.value))}
            />
          </label>
        </div>
        <div className="fhir-toggle-row">
          <label className="switch">
            <input checked={form.verify_tls} onChange={(e) => set("verify_tls", e.target.checked)} type="checkbox" />
            <span className="switch__track" />
            <span className="switch__label">Verify TLS</span>
          </label>
        </div>

      {isOAuth && (
        <>
          <div className="fhir-form-grid">
            <label>
              <span>Auth profile</span>
              <select
                value={form.auth_profile}
                onChange={(e) => {
                  const next = e.target.value as FhirAuthProfile;
                  set("auth_profile", next);
                  // SMART Backend Services (client credentials) requires a signed
                  // client assertion; default to private_key_jwt when leaving a
                  // Basic/POST method. Not applicable to the Authorization Code flow.
                  if (
                    isClientCreds &&
                    next === "smart" &&
                    form.token_auth_method !== "private_key_jwt" &&
                    form.token_auth_method !== "client_secret_jwt"
                  ) {
                    set("token_auth_method", "private_key_jwt");
                    set("jwt_signing_alg", "");
                  }
                }}
              >
                {AUTH_PROFILE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <small className="field-help">
                {form.auth_profile === "smart"
                  ? "SMART Backend Services: discovery via .well-known/smart-configuration, audience sent as `aud`, system/* scopes."
                  : form.auth_profile === "iua"
                    ? "IHE IUA: discovery via .well-known/oauth-authorization-server, audience sent as `resource`, requested_token_type defaults to JWT."
                    : "Plain OAuth2 Client Credentials with no IHE/SMART-specific framing."}
              </small>
            </label>
            {isClientCreds && (
            <label>
              <span>Token auth method</span>
              <select
                value={form.token_auth_method}
                onChange={(e) => {
                  set("token_auth_method", e.target.value as FhirTokenAuthMethod);
                  set("jwt_signing_alg", "");
                }}
              >
                {TOKEN_AUTH_METHOD_OPTIONS.filter(
                  // SMART only allows the client-assertion (JWT) methods.
                  (opt) =>
                    form.auth_profile !== "smart" ||
                    opt.value === "private_key_jwt" ||
                    opt.value === "client_secret_jwt",
                ).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <small className="field-help">
                {form.auth_profile === "smart"
                  ? "SMART Backend Services always sends a signed client_assertion (client_assertion_type + client_assertion in the token body)."
                  : form.token_auth_method === "private_key_jwt"
                    ? "Signs a client_assertion JWT with your private key (SMART Backend Services standard)."
                    : form.token_auth_method === "client_secret_jwt"
                      ? "Signs a client_assertion JWT (HMAC) using the client secret."
                      : form.token_auth_method === "client_secret_post"
                        ? "Sends client_id/client_secret in the token request body."
                        : "Sends client_id/client_secret via HTTP Basic auth."}
              </small>
            </label>
            )}
          </div>
          <div className="fhir-toggle-row">
            <label className="switch">
              <input checked={form.use_metadata} onChange={(e) => set("use_metadata", e.target.checked)} type="checkbox" />
              <span className="switch__track" />
              <span className="switch__label">Use metadata</span>
            </label>
          </div>
          <div className="fhir-form-grid">
            <label>
              <span>Auth server URL</span>
              <input value={form.auth_server_url} onChange={(e) => set("auth_server_url", e.target.value)} />
            </label>
            <label>
              <span>Metadata URL</span>
              <input
                value={form.metadata_url}
                onChange={(e) => set("metadata_url", e.target.value)}
                onBlur={() => void discoverScopes()}
                disabled={!form.use_metadata}
              />
              {discovering && <small className="field-help">Discovering scopes…</small>}
            </label>
            {isAuthCode && (
              <label>
                <span>Authorization endpoint</span>
                <input
                  value={form.authorization_endpoint}
                  onChange={(e) => set("authorization_endpoint", e.target.value)}
                  placeholder="https://auth.example.com/authorize"
                />
                <small className="field-help">
                  Where the operator is redirected to log in. Leave blank to
                  auto-discover it from metadata.
                </small>
              </label>
            )}
            {isAuthCode && (
              <label className="fhir-form-wide">
                <span>Redirect URI (register this at the authorization server)</span>
                <div className="fhir-keytools">
                  <input readOnly value={callbackUrl} onFocus={(e) => e.target.select()} />
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => copyText(callbackUrl)}
                  >
                    📋 Copy
                  </button>
                </div>
                <small className="field-help">
                  The external server must allow this exact redirect URI. If your
                  public URL differs from this origin, set PUBLIC_BASE_URL and
                  register that instead.
                </small>
              </label>
            )}
            <label>
              <span>Token endpoint</span>
              <input value={form.token_endpoint} onChange={(e) => set("token_endpoint", e.target.value)} />
            </label>
            <label>
              <span>Client ID</span>
              <input value={form.client_id} onChange={(e) => set("client_id", e.target.value)} />
            </label>
            {form.token_auth_method !== "private_key_jwt" && (
              <label>
                <span>Client secret</span>
                <input
                  type="text"
                  value={form.client_secret}
                  onChange={(e) => set("client_secret", e.target.value)}
                  placeholder={
                    form.fhir_server_id ? "Leave blank to keep current secret" : ""
                  }
                />
                {isAuthCode && (
                  <small className="field-help">
                    Required for the IUA profile (confidential client); optional for
                    a SMART public client (PKCE only).
                  </small>
                )}
              </label>
            )}
            {form.token_auth_method === "private_key_jwt" && (
              <label className="fhir-form-wide">
                <span>Client private key (PEM)</span>
                <textarea
                  value={form.client_private_key}
                  onChange={(e) => set("client_private_key", e.target.value)}
                  rows={6}
                  placeholder={
                    form.client_private_key_configured
                      ? "Leave blank to keep current private key"
                      : "-----BEGIN PRIVATE KEY----- (paste, or click Generate keypair)"
                  }
                />
                <div className="fhir-keytools">
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={genBusy}
                    onClick={generateKeypair}
                  >
                    {genBusy ? "Generating…" : "Generate keypair"}
                  </button>
                  <small className="field-help">
                    Generates a {form.jwt_signing_alg || defaultSigningAlg("private_key_jwt")}{" "}
                    keypair on the server. The public half is published at this
                    server&apos;s JWKS URL; give that URL (or the downloaded JWKS) to
                    the OAuth Server to register your client.
                  </small>
                </div>
                {genError && <small className="field-error">{genError}</small>}
                {genKey && (
                  <div className="fhir-keycard">
                    <strong>⚠ Private key is shown once — download &amp; back it up now.</strong>
                    <div className="fhir-keytools">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() =>
                          downloadText(
                            `fhir-client-${form.server_key || "key"}-private.pem`,
                            genKey.private_key_pem,
                            "application/x-pem-file",
                          )
                        }
                      >
                        ⬇ Download private key (.pem)
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() =>
                          downloadText(
                            `fhir-client-${form.server_key || "key"}-jwks.json`,
                            JSON.stringify({ keys: [genKey.public_jwk] }, null, 2),
                            "application/json",
                          )
                        }
                      >
                        ⬇ Download public JWKS (.json)
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => copyText(JSON.stringify(genKey.public_jwk))}
                      >
                        📋 Copy public JWK
                      </button>
                    </div>
                    <small className="field-help">
                      kid <code>{genKey.kid}</code> · alg {genKey.alg}. Save the server
                      to persist this key and activate the JWKS URL.
                    </small>
                  </div>
                )}
              </label>
            )}
            {form.token_auth_method === "private_key_jwt" && (
              <label className="fhir-form-wide">
                <span>JWKS URL (give this to the OAuth Server)</span>
                {jwksUrl ? (
                  <>
                    <div className="fhir-keytools">
                      <input readOnly value={jwksUrl} onFocus={(e) => e.target.select()} />
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => copyText(jwksUrl)}
                      >
                        📋 Copy
                      </button>
                      <a
                        className="btn btn--sm"
                        href={jwksUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                      </a>
                    </div>
                    <small className="field-help">
                      {form.client_public_jwk_configured || genKey
                        ? genKey
                          ? "Becomes live after you save this server. Must be reachable by the OAuth Server (i.e. this admin origin is publicly accessible)."
                          : "Live now. Must be reachable by the OAuth Server (i.e. this admin origin is publicly accessible)."
                        : "Generate or paste a private key and save — the public key appears here once stored."}
                    </small>
                  </>
                ) : (
                  <small className="field-help">
                    Save the server first to get its per-server JWKS URL.
                  </small>
                )}
              </label>
            )}
            {(form.token_auth_method === "private_key_jwt" ||
              form.token_auth_method === "client_secret_jwt") && (
              <>
                <label>
                  <span>JWT signing alg</span>
                  <select
                    value={form.jwt_signing_alg || defaultSigningAlg(form.token_auth_method)}
                    onChange={(e) => set("jwt_signing_alg", e.target.value)}
                  >
                    {signingAlgOptions(form.token_auth_method).map((alg) => (
                      <option key={alg} value={alg}>
                        {alg}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>JWT key id (kid)</span>
                  <input
                    value={form.jwt_kid}
                    onChange={(e) => set("jwt_kid", e.target.value)}
                    placeholder="optional"
                  />
                </label>
              </>
            )}
            <label className="fhir-form-wide">
              <span>Scope</span>
              <input
                value={form.scope}
                onChange={(e) => set("scope", e.target.value)}
                placeholder={SCOPE_PLACEHOLDER[form.auth_profile]}
              />
              {scopeTokens.length > 0 && (
                <div className="fhir-scope-chips">
                  {scopeTokens.map((s) => (
                    <button
                      type="button"
                      key={s}
                      className="fhir-scope-chip"
                      onClick={() => toggleScope(s)}
                      title="Remove scope"
                    >
                      <span>{s}</span>
                      <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              )}
              <small className="field-help">
                Space-separated. Type your own above, or pick from discovered scopes
                below. Selected scopes show as chips you can click to remove.
              </small>
            </label>
            {scopeOptions.length > 0 ? (
              <div className="fhir-form-wide fhir-scope-picker">
                <div className="fhir-scope-picker__head">
                  <input
                    type="search"
                    className="fhir-scope-search"
                    placeholder={`Search ${scopeOptions.length} discovered scope(s)…`}
                    value={scopeFilter}
                    onChange={(e) => setScopeFilter(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={allFilteredSelected}
                    onClick={() => addScopes(filteredScopeOptions)}
                  >
                    {scopeFilterLc ? "Select all matching" : "Select all"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={selectedInFiltered === 0}
                    onClick={() => removeScopes(filteredScopeOptions)}
                  >
                    {scopeFilterLc ? "Clear matching" : "Clear all"}
                  </button>
                </div>
                <div className="fhir-scope-list">
                  {scopeShown.map((s) => (
                    <label key={s} className="fhir-scope-row">
                      <input
                        type="checkbox"
                        checked={scopeTokens.includes(s)}
                        onChange={() => toggleScope(s)}
                      />
                      <span>{s}</span>
                    </label>
                  ))}
                  {scopeShown.length === 0 && (
                    <div className="muted small fhir-scope-empty">
                      No scopes match “{scopeFilter}”.
                    </div>
                  )}
                </div>
                <small className="field-help">
                  {`${selectedInFiltered} selected`}
                  {` · `}
                  {filteredScopeOptions.length > scopeShown.length
                    ? `showing first ${scopeShown.length} of ${filteredScopeOptions.length} match(es) — refine the search`
                    : `${filteredScopeOptions.length} of ${scopeOptions.length} discovered scope(s)${
                        scopeFilterLc ? " match" : ""
                      }`}
                </small>
              </div>
            ) : (
              <div className="fhir-form-wide">
                <small className="field-help">
                  {discoverError
                    ? discoverError
                    : "Discovered scopes appear here after the Metadata URL is filled and loses focus (Use metadata on). You can always type scopes manually."}
                </small>
              </div>
            )}
            <label>
              <span>Token audience / resource parameter</span>
              <input
                value={form.resource}
                onChange={(e) => set("resource", e.target.value)}
                placeholder="https://fhir.example.com/fhir"
              />
              <small className="field-help">
                OAuth token target sent as the `resource` parameter. This is usually the
                FHIR server base URL; it is not a FHIR resource type like Patient or
                Observation.
              </small>
            </label>
            {form.auth_profile !== "smart" && (
              <label>
                <span>Requested token type</span>
                <input
                  value={form.requested_token_type}
                  onChange={(e) => set("requested_token_type", e.target.value)}
                  placeholder="urn:ietf:params:oauth:token-type:jwt"
                />
              </label>
            )}
          </div>
        </>
      )}
      </FormSection>

      <FormSection
        title="Custom headers"
        hint={headerCount ? `${headerCount} configured` : "none"}
      >
        {isOAuth && (
          <div className="fhir-form-wide">
            <HeaderRowsEditor
              label="Metadata discovery headers"
              rows={form.metadata_headers}
              onChange={(next) => set("metadata_headers", next)}
            />
            <small className="field-help">
              Sent with the discovery request (.well-known/openid-configuration,
              smart-configuration, oauth-authorization-server). Authorization is reserved.
            </small>
          </div>
        )}
        {isOAuth && (
          <div className="fhir-form-wide">
            <HeaderRowsEditor
              label="Token request headers"
              rows={form.token_headers}
              onChange={(next) => set("token_headers", next)}
            />
            <small className="field-help">Sent with the OAuth token request.</small>
          </div>
        )}
        <div className="fhir-form-wide">
          <HeaderRowsEditor
            label="FHIR request headers"
            rows={form.resource_headers}
            onChange={(next) => set("resource_headers", next)}
          />
          <small className="field-help">Sent with every FHIR resource request.</small>
        </div>
        {!isOAuth && (
          <small className="field-help">
            Metadata &amp; token headers apply only to OAuth2 servers.
          </small>
        )}
      </FormSection>

      <FormSection
        title="Access control"
        hint={`${form.allowed_operations.length} operation(s)`}
      >
        <div className="fhir-form-grid">
          <label className="fhir-form-wide">
            <span>Test / probe path</span>
            <input
              value={form.test_path}
              onChange={(e) => set("test_path", e.target.value)}
              placeholder="Patient?_count=1"
            />
            <small className="field-help">
              Optional. Relative path fetched with the token during Test &amp; probe to
              verify real data access. When set it <strong>replaces</strong> the default
              /metadata check. Blank = test /metadata (CapabilityStatement).
            </small>
          </label>
          {isOAuth && (
            <label className="fhir-form-wide">
              <span>Default token strategy</span>
              <select
                value={form.default_token_strategy}
                onChange={(e) => set("default_token_strategy", e.target.value)}
              >
                <option value="">Global default (fresh)</option>
                <option value="fresh">fresh — re-auth every call</option>
                <option value="cached">cached — reuse token until expiry</option>
              </select>
              <small className="field-help">
                How MCP FHIR calls obtain the token when the tool call doesn&apos;t
                specify. <strong>fresh</strong> = new token each call (safest);
                <strong> cached</strong> = reuse until expiry (fast). Shared across users.
              </small>
            </label>
          )}
          <label className="fhir-form-wide">
            <span>Allowed resource types</span>
            <input
              value={form.allowed_resource_types}
              onChange={(e) => set("allowed_resource_types", e.target.value)}
            />
          </label>
        </div>
        <div>
          <div className="settings-field__label">Allowed operations</div>
          <OperationCheckboxes
            value={form.allowed_operations}
            onChange={(next) => set("allowed_operations", next)}
          />
        </div>
      </FormSection>

      {isOAuth && (
        <p className="field-help fhir-form-note">
          Save the server, then use <strong>Authorize</strong> and{" "}
          <strong>Probe</strong> on its card to obtain a token and test connectivity.
        </p>
      )}

      <div className="modal-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

export function FhirServersPage(): JSX.Element {
  const qc = useQueryClient();
  const importInput = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [probeResult, setProbeResult] = useState<FhirServerProbePayload | null>(null);
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null);
  const [importing, setImporting] = useState(false);

  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: qk.fhirServers,
    queryFn: () => api.get<FhirServersPayload>("/admin/api/fhir-servers?include_disabled=true"),
    staleTime: 10_000,
    // Keep token status / countdowns reasonably fresh while the page is open.
    refetchInterval: 30_000,
  });

  const servers = data?.servers ?? [];
  const defaultServer = useMemo(() => servers.find((server) => server.is_default), [servers]);

  // Handle the OAuth2 callback redirect (?oauth=success|error&...) — toast the
  // result, refresh the list, then strip the query so a refresh doesn't re-toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (!oauth) return;
    if (oauth === "success") {
      const server = params.get("server");
      toast.success(
        server ? `Authorization complete for ${server}` : "Authorization complete",
      );
      void qc.invalidateQueries({ queryKey: qk.fhirServers });
    } else if (oauth === "error") {
      toast.error(`Authorization failed: ${params.get("reason") || "unknown error"}`);
    }
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useMutation({
    mutationFn: (form: FormState) => {
      const payload = toPayload(form);
      if (form.fhir_server_id) {
        return api.patch<FhirServerPayload>(
          `/admin/api/fhir-servers/${encodeURIComponent(form.fhir_server_id)}`,
          payload,
        );
      }
      return api.post<FhirServerPayload>("/admin/api/fhir-servers", payload);
    },
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: qk.fhirServers });
      toast.success("FHIR server saved");
    },
    onError: (err) => toast.error(`Save failed: ${String(err)}`),
  });

  const probe = useMutation({
    mutationFn: (server: FhirServer) =>
      api.post<FhirServerProbePayload>(
        `/admin/api/fhir-servers/${encodeURIComponent(server.fhir_server_id)}/probe`,
        {},
      ),
    onSuccess: (result) => {
      setProbeResult(result);
      void qc.invalidateQueries({ queryKey: qk.fhirServers });
      toast.success(result.ok ? "Probe complete" : "Probe returned an error");
    },
    onError: (err) => toast.error(`Probe failed: ${String(err)}`),
  });

  const setDefault = useMutation({
    mutationFn: (server: FhirServer) =>
      api.post<FhirServerPayload>(
        `/admin/api/fhir-servers/${encodeURIComponent(server.fhir_server_id)}/set-default`,
        {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.fhirServers });
      toast.success("Default server updated");
    },
    onError: (err) => toast.error(`Default update failed: ${String(err)}`),
  });

  const remove = useMutation({
    mutationFn: (server: FhirServer) =>
      api.del<{ deleted: FhirServer }>(
        `/admin/api/fhir-servers/${encodeURIComponent(server.fhir_server_id)}`,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.fhirServers });
      toast.success("FHIR server deleted");
    },
    onError: (err) => toast.error(`Delete failed: ${String(err)}`),
  });

  // Authorize a server. Client Credentials authorizes synchronously (fetches +
  // stores a token); Authorization Code returns a URL to redirect the browser to
  // for the interactive login (which returns via /fhir-oauth/callback).
  const authorize = useMutation({
    mutationFn: (serverId: string) =>
      api.post<FhirOAuthAuthorizePayload>(
        `/admin/api/fhir-servers/${encodeURIComponent(serverId)}/oauth/authorize`,
        {},
      ),
    onSuccess: (res) => {
      if (res.authorization_uri) {
        window.location.href = res.authorization_uri;
        return;
      }
      void qc.invalidateQueries({ queryKey: qk.fhirServers });
      toast.success("Authorized — access token obtained");
    },
    onError: (err) => toast.error(`Authorize failed: ${String(err)}`),
  });

  // Manually exchange the stored refresh token for a fresh access token.
  const refreshNow = useMutation({
    mutationFn: (serverId: string) =>
      api.post<{ ok: boolean }>(
        `/admin/api/fhir-servers/${encodeURIComponent(serverId)}/oauth/refresh`,
        {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.fhirServers });
      toast.success("Access token refreshed");
    },
    onError: (err) => toast.error(`Refresh failed: ${String(err)}`),
  });

  const clearCache = useMutation({
    mutationFn: (serverId: string) =>
      api.post<{ cleared: boolean }>(
        `/admin/api/fhir-servers/${encodeURIComponent(serverId)}/oauth/clear-cache`,
        {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.fhirServers });
      toast.success("OAuth tokens cleared");
    },
    onError: (err) => toast.error(`Clear cache failed: ${String(err)}`),
  });

  if (isPending) return <div className="muted">Loading FHIR servers...</div>;
  if (isError) return <div className="error-box">Failed to load FHIR servers: {String(error)}</div>;

  const exportConfig = async () => {
    try {
      // Fetch the full config from the backend so the export includes the
      // decrypted client_secret (the list endpoint redacts it).
      const res = await api.get<{ servers: ExportServer[] }>(
        "/admin/api/fhir-servers/export",
      );
      const blob = new Blob([exportPayload(res.servers ?? [])], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fhir-servers-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(`Export failed: ${String(err)}`);
    }
  };

  const duplicateServer = async (server: FhirServer) => {
    const form = serverToForm(server);
    form.fhir_server_id = undefined; // create a new server, not edit this one
    form.server_key = `${server.server_key}-copy`;
    form.name = `${server.name} (copy)`;
    form.is_default = false; // never steal the default flag on a copy
    // Carry the client_secret too — pull it from the full export config.
    if (server.auth_type !== "none") {
      try {
        const res = await api.get<{ servers: ExportServer[] }>(
          "/admin/api/fhir-servers/export",
        );
        const full = (res.servers ?? []).find(
          (s) => s.fhir_server_id === server.fhir_server_id,
        );
        if (full?.client_secret) form.client_secret = full.client_secret;
      } catch {
        // Non-fatal: open the form anyway; the secret can be re-entered.
      }
    }
    setEditing(form);
  };

  const editServer = async (server: FhirServer) => {
    const form = serverToForm(server);
    // Prefill the stored credentials so they are visible when editing, pulling
    // the decrypted values from the full export config (the list endpoint redacts them).
    if (server.auth_type !== "none") {
      try {
        const res = await api.get<{ servers: ExportServer[] }>(
          "/admin/api/fhir-servers/export",
        );
        const full = (res.servers ?? []).find(
          (s) => s.fhir_server_id === server.fhir_server_id,
        );
        if (full?.client_secret) form.client_secret = full.client_secret;
        if (full?.client_private_key) form.client_private_key = full.client_private_key;
      } catch {
        // Non-fatal: open the form anyway with the credential fields blank.
      }
    }
    setEditing(form);
  };

  const importConfig = async (file: File) => {
    try {
      const text = await file.text();
      const raws = parseServersFromFile(text);
      if (raws.length === 1) {
        // Single server keeps the familiar "review in the form" flow.
        setEditing(importedServerToForm(raws[0]));
        toast.success("FHIR server config loaded");
      } else {
        // Multiple servers open a review list for selective, conflict-aware import.
        const byKey = new Map(servers.map((s) => [s.server_key, s]));
        setImportRows(
          raws.map((raw, i) => {
            const form = importedServerToForm(raw);
            const conflict = byKey.get(form.server_key.trim().toLowerCase()) ?? null;
            return {
              id: `${i}-${form.server_key}`,
              form,
              selected: true,
              conflict,
              resolution: "skip" as ImportResolution,
            };
          }),
        );
      }
    } catch (err) {
      toast.error(`Import failed: ${String(err)}`);
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  };

  const updateImportRow = (id: string, patch: Partial<ImportRow>) =>
    setImportRows((rows) =>
      rows ? rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) : rows,
    );

  const importDone = !!importRows?.some((r) => r.status);
  const importableCount =
    importRows?.filter(
      (r) => r.selected && !(r.conflict && r.resolution === "skip"),
    ).length ?? 0;

  const runImport = async () => {
    if (!importRows) return;
    setImporting(true);
    const takenKeys = new Set(servers.map((s) => s.server_key.toLowerCase()));
    const results: ImportRow[] = [];
    for (const row of importRows) {
      const skip = !row.selected || (row.conflict && row.resolution === "skip");
      if (skip) {
        results.push({ ...row, status: "skipped", message: "Skipped" });
        continue;
      }
      try {
        // Never let imports fight over the single-default flag; set after import.
        const form: FormState = { ...row.form, is_default: false };
        if (row.conflict && row.resolution === "overwrite") {
          await api.patch<FhirServerPayload>(
            `/admin/api/fhir-servers/${encodeURIComponent(row.conflict.fhir_server_id)}`,
            toPayload(form),
          );
          results.push({ ...row, status: "ok", message: "Updated existing" });
        } else {
          if (row.conflict && row.resolution === "copy") {
            let key = `${form.server_key}-imported`;
            let n = 2;
            while (takenKeys.has(key.toLowerCase())) key = `${form.server_key}-imported-${n++}`;
            form.server_key = key;
            form.name = `${form.name} (imported)`;
            form.preserved_id = undefined; // a copy is a new server → fresh id/JWKS URL
          }
          await api.post<FhirServerPayload>("/admin/api/fhir-servers", toPayload(form));
          takenKeys.add(form.server_key.toLowerCase());
          results.push({
            ...row,
            status: "ok",
            message: row.conflict ? `Imported as ${form.server_key}` : "Created",
          });
        }
      } catch (err) {
        results.push({ ...row, status: "error", message: String(err) });
      }
    }
    setImportRows(results);
    setImporting(false);
    void qc.invalidateQueries({ queryKey: qk.fhirServers });
    const ok = results.filter((r) => r.status === "ok").length;
    const fail = results.filter((r) => r.status === "error").length;
    if (fail) toast.error(`Imported ${ok} server(s), ${fail} failed`);
    else toast.success(`Imported ${ok} server(s)`);
  };

  return (
    <section>
      <header className="section-head">
        <div>
          <h3>FHIR Servers</h3>
          <div className="muted small">
            {isFetching ? "Refreshing..." : `${servers.length} configured`}
            {defaultServer ? ` · default: ${defaultServer.server_key}` : ""}
          </div>
        </div>
        <div className="head-actions">
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importConfig(file);
            }}
          />
          <button type="button" className="btn btn--ghost" onClick={() => importInput.current?.click()}>
            Import config
          </button>
          <button type="button" className="btn btn--ghost" disabled={!servers.length} onClick={exportConfig}>
            Export config
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditing(makeEmptyForm());
            }}
          >
            Add server
          </button>
        </div>
      </header>

      {probeResult && (
        <div className={`fhir-probe fhir-probe--${probeResult.ok ? "ok" : "bad"}`}>
          <div>
            <strong>{probeResult.server.name}</strong>
            <div className="muted small">
              {probeResult.probe.message} · {probeResult.probe.latency_ms} ms
            </div>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setProbeResult(null)}>
            Dismiss
          </button>
        </div>
      )}

      {!servers.length ? (
        <div className="module-card">
          <div className="muted">No FHIR servers configured.</div>
        </div>
      ) : (
        <div className="fhir-server-list">
          {servers.map((server) => {
            const oauth = server.auth_type !== "none";
            const st = server.oauth_status;
            const authorized = st?.status === "authorized";
            // A refresh token that is present and not past its own expiry can be
            // exchanged manually (null refresh expiry = non-expiring).
            const refreshUsable =
              Boolean(st?.has_refresh) &&
              (!st?.refresh_expires_at ||
                new Date(st.refresh_expires_at).getTime() > Date.now());
            const busyAuthorize =
              authorize.isPending && authorize.variables === server.fhir_server_id;
            const busyRefresh =
              refreshNow.isPending && refreshNow.variables === server.fhir_server_id;
            const busyClear =
              clearCache.isPending && clearCache.variables === server.fhir_server_id;
            return (
            <article key={server.fhir_server_id} className="fhir-server-card">
              <div className="fhir-server-card__main">
                <div className="fhir-server-card__title">
                  <div>
                    <div className="fhir-server-card__name">{server.name}</div>
                    <code>{server.server_key}</code>
                  </div>
                  <div className="fhir-server-card__badges">
                    {server.is_default && <span className="badge badge--ok">Default</span>}
                    {!server.enabled && <span className="badge badge--muted">Disabled</span>}
                    <span className="badge badge--muted">
                      {server.auth_type === "oauth2_client_credentials"
                        ? "OAuth2 CC"
                        : server.auth_type === "oauth2_authorization_code"
                          ? "OAuth2 Auth Code"
                          : "No auth"}
                    </span>
                    {server.auth_profile === "iua" && <span className="badge badge--warn">IUA</span>}
                    {server.auth_profile === "smart" && <span className="badge badge--warn">SMART</span>}
                    {oauth && st && (
                      <span className={`badge ${oauthBadgeTone(st.status)}`}>
                        {oauthBadgeLabel(st.status)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="fhir-server-card__url">{server.base_url}</div>
                <div className="muted small">{capabilityLine(server)}</div>
                <div className="fhir-server-card__ops">
                  {server.allowed_operations.map((op) => (
                    <span key={op}>{op}</span>
                  ))}
                </div>
              </div>
              <div className="fhir-server-card__side">
                <div className="fhir-server-card__probe">
                  <StatusBadge status={statusForProbe(server)} />
                  <span className="muted small">{formatRelative(server.last_probe_at)}</span>
                </div>
                {oauth &&
                  st &&
                  (st.status === "authorized" || st.status === "expired") && (
                    <div className="fhir-token-status">
                      <TokenCountdown
                        label="Access token"
                        expiresAt={st.access_expires_at}
                      />
                      {st.has_refresh && (
                        <TokenCountdown
                          label="Refresh token"
                          expiresAt={st.refresh_expires_at}
                          fallback="does not expire"
                        />
                      )}
                    </div>
                  )}
                <div className="fhir-server-card__actions">
                  {oauth && (
                    <>
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={busyAuthorize}
                        onClick={() => authorize.mutate(server.fhir_server_id)}
                      >
                        {busyAuthorize
                          ? "Authorizing..."
                          : authorized
                            ? "Re-authorize"
                            : "Authorize"}
                      </button>
                      {refreshUsable && (
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busyRefresh}
                          onClick={() => refreshNow.mutate(server.fhir_server_id)}
                        >
                          {busyRefresh ? "Refreshing..." : "Refresh token"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        disabled={busyClear || !st || st.status === "not_authorized"}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Clear stored tokens for ${server.name}? The server will need to be authorized again.`,
                            )
                          )
                            clearCache.mutate(server.fhir_server_id);
                        }}
                      >
                        Clear cache
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={
                      (probe.isPending &&
                        probe.variables?.fhir_server_id === server.fhir_server_id) ||
                      (oauth && !authorized)
                    }
                    title={
                      oauth && !authorized
                        ? "Authorize first to obtain a valid token"
                        : undefined
                    }
                    onClick={() => probe.mutate(server)}
                  >
                    {probe.isPending && probe.variables?.fhir_server_id === server.fhir_server_id
                      ? "Probing..."
                      : "Probe"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void editServer(server)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void duplicateServer(server)}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={server.is_default || setDefault.isPending}
                    onClick={() => setDefault.mutate(server)}
                  >
                    Set default
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete ${server.name}?`)) remove.mutate(server);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </article>
            );
          })}
        </div>
      )}

      {editing && (
        <Modal
          title={editing.fhir_server_id ? "Edit FHIR server" : "Add FHIR server"}
          onClose={() => setEditing(null)}
          wide
        >
          <FhirServerForm
            initial={editing}
            saving={save.isPending}
            onCancel={() => setEditing(null)}
            onSave={(form) => save.mutate(form)}
          />
        </Modal>
      )}

      {importRows && (
        <Modal
          title={`Import ${importRows.length} FHIR servers`}
          onClose={() => setImportRows(null)}
          wide
        >
          <div className="fhir-import-list">
            {importRows.map((row) => (
              <div key={row.id} className="module-card fhir-import-row">
                <label className="fhir-import-row__main">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    disabled={importing || importDone}
                    onChange={(e) => updateImportRow(row.id, { selected: e.target.checked })}
                  />
                  <div>
                    <div className="fhir-server-card__name">
                      {row.form.name || "(unnamed)"}
                    </div>
                    <code>{row.form.server_key}</code>
                    <div className="muted small">{row.form.base_url}</div>
                    <div className="fhir-server-card__badges">
                      <span className="badge badge--muted">
                        {row.form.auth_type === "oauth2_client_credentials"
                          ? "OAuth2"
                          : "No auth"}
                      </span>
                      {row.form.auth_profile !== "none" && (
                        <span className="badge badge--warn">
                          {row.form.auth_profile.toUpperCase()}
                        </span>
                      )}
                      {row.conflict ? (
                        <span className="badge badge--bad">Conflict: key exists</span>
                      ) : (
                        <span className="badge badge--ok">New</span>
                      )}
                    </div>
                  </div>
                </label>

                {row.conflict && !row.status && (
                  <div className="fhir-import-row__conflict fhir-check-grid">
                    {(["skip", "overwrite", "copy"] as ImportResolution[]).map((opt) => (
                      <label key={opt} className="fhir-check">
                        <input
                          type="radio"
                          name={`resolution-${row.id}`}
                          checked={row.resolution === opt}
                          disabled={importing}
                          onChange={() => updateImportRow(row.id, { resolution: opt })}
                        />
                        <span>{opt}</span>
                      </label>
                    ))}
                  </div>
                )}

                {row.status && (
                  <div
                    className={`muted small fhir-import-row__status--${row.status}`}
                  >
                    {row.status === "ok" ? "✓ " : row.status === "error" ? "✗ " : "⊘ "}
                    {row.message}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setImportRows(null)}
            >
              {importDone ? "Close" : "Cancel"}
            </button>
            {!importDone && (
              <button
                type="button"
                className="btn"
                disabled={importing || importableCount === 0}
                onClick={() => void runImport()}
              >
                {importing ? "Importing…" : `Import ${importableCount} selected`}
              </button>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
