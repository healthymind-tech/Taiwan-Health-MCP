// Shared types mirroring the Python /admin/api/* payloads.
// These are intentionally loose where the backend shape is still fluid;
// tighten per-tab as each route is migrated.

// ── WebSocket events (admin_ws.py) ──────────────────────────────────────────
export type WsEventType =
  | "job_status_changed"
  | "job_log_line"
  | "job_step_updated"
  | "worker_heartbeat"
  | "maintenance_changed"
  | "module_cleared"
  | "pong";

export interface WsEnvelope {
  type: WsEventType;
  data: Record<string, unknown>;
}

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "success"
  | "failed"
  | "cancelled";

export interface JobStatusChangedEvent {
  job_id: string;
  job_type: string;
  module_key?: string;
  status: JobStatus;
  current_step?: string;
  progress_current?: number;
  progress_total?: number;
  updated_at?: string;
}

export interface WorkerHeartbeatEvent {
  worker_id: string;
  status?: string;
  updated_at?: string;
}

// ── Overview (AdminOverviewPayload) ─────────────────────────────────────────
export interface OverviewPayload {
  generated_at: string;
  app: Record<string, unknown>;
  infrastructure: Record<string, unknown>;
  modules: Record<string, unknown>;
  services: Record<string, unknown>;
  jobs: Record<string, unknown>;
  workers: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
  fhir_servers?: OverviewFhirServers;
}

export interface OverviewFhirServerItem {
  server_key: string;
  name: string;
  enabled: boolean;
  is_default: boolean;
  auth_profile: string;
  last_probe_status: string;
  last_probe_at: string | null;
  last_probe_error: string;
}

export interface OverviewFhirServers {
  total: number;
  ok: number;
  items: OverviewFhirServerItem[];
  error?: string;
}

// ── Services (/admin/api/services, /admin/api/services/probe) ───────────────
export type ServiceStatus = "ok" | "degraded" | "error";

export interface ServiceProbe {
  service_key: string;
  label: string;
  category: string; // "infrastructure" | "storage" | "ml" | "other"
  description: string;
  status: ServiceStatus;
  endpoint: string;
  latency_ms: number | null;
  message: string;
  details: Record<string, unknown>;
  checked_at: string | null;
}

export interface ServicesPayload {
  services: ServiceProbe[];
  history: ServiceProbe[];
  summary: {
    total: number;
    ok: number;
    degraded: number;
    error: number;
    last_checked_at: string | null;
  };
  probed_service_keys?: string[];
}

// ── FHIR Servers (/admin/api/fhir-servers) ─────────────────────────────────
export type FhirAuthType =
  | "none"
  | "oauth2_client_credentials"
  | "oauth2_authorization_code";
export type FhirAuthProfile = "none" | "iua" | "smart";
export type FhirOAuthStatus =
  | "not_authorized"
  | "authorized"
  | "expired"
  | "pending";
export type FhirTokenAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "client_secret_jwt"
  | "private_key_jwt";
export type FhirOperation =
  | "metadata"
  | "read"
  | "search"
  | "create"
  | "update"
  | "patch"
  | "delete";

export interface FhirCapabilityResource {
  type: string;
  profile?: string;
  interactions?: string[];
}

export interface FhirServer {
  fhir_server_id: string;
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
  client_secret_configured: boolean;
  token_auth_method: FhirTokenAuthMethod;
  client_private_key_configured: boolean;
  client_public_jwk_configured: boolean;
  jwt_signing_alg: string;
  jwt_kid: string;
  scope: string;
  resource: string;
  requested_token_type: string;
  metadata_headers_json: Record<string, unknown>;
  token_headers_json: Record<string, unknown>;
  resource_headers_json: Record<string, unknown>;
  verify_tls: boolean;
  timeout_seconds: number;
  allowed_resource_types: string[];
  allowed_operations: FhirOperation[];
  last_probe_status: string;
  last_probe_at: string | null;
  last_probe_error: string;
  capability_summary: {
    resourceType?: string;
    fhirVersion?: string;
    software?: Record<string, unknown>;
    implementation?: Record<string, unknown>;
    supported_resource_count?: number;
    supported_resources?: FhirCapabilityResource[];
  };
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
  oauth_status?: FhirOAuthStatusInfo;
}

export interface FhirOAuthStatusInfo {
  status: FhirOAuthStatus;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  has_refresh: boolean;
  scope: string;
}

export interface FhirServersPayload {
  servers: FhirServer[];
}

export interface FhirOAuthAuthorizePayload {
  // Authorization Code returns a URL to redirect the browser to; Client
  // Credentials authorizes synchronously and returns the new status.
  authorization_uri?: string;
  state?: string;
  authorized?: boolean;
  oauth_status?: FhirOAuthStatusInfo;
}

export interface FhirServerPayload {
  server: FhirServer;
}

export interface FhirServerProbePayload {
  ok: boolean;
  probe: {
    status: string;
    message: string;
    latency_ms: number;
    details: Record<string, unknown>;
  };
  capability_summary: FhirServer["capability_summary"];
  server: FhirServer;
  raw_result?: Record<string, unknown> | null;
}

// ── Jobs (/admin/api/jobs) ──────────────────────────────────────────────────
export interface JobSummary {
  job_id: string;
  job_type: string;
  module_key?: string;
  status: JobStatus;
  current_step?: string;
  progress_current?: number;
  progress_total?: number;
  created_at?: string;
  updated_at?: string;
}

export interface JobsPayload {
  jobs: JobSummary[];
}

// Full job detail (/admin/api/jobs/{id}) — AdminJob.to_dict().
export interface JobDetail extends JobSummary {
  requested_by: string;
  control_state: string;
  worker_name: string;
  started_at?: string;
  finished_at?: string;
  last_error_code: string;
  last_error_message: string;
  job_options: Record<string, unknown>;
  result_summary: Record<string, unknown>;
  available_actions: JobControlAction[];
}

export type JobControlAction = "pause" | "resume" | "stop" | "restart";

export interface JobStep {
  job_step_id: number;
  job_id: string;
  step_key: string;
  status: string;
  progress_current: number;
  progress_total: number;
  started_at?: string;
  finished_at?: string;
  checkpoint: Record<string, unknown>;
  last_error_message: string;
}

export interface JobLog {
  job_log_id: number;
  job_id: string;
  level: string;
  message: string;
  payload: Record<string, unknown>;
  created_at: string;
}

// WS job_log_line payload (admin_jobs.py append_job_log) — note it carries
// `timestamp`, not `created_at`, and has no job_log_id.
export interface JobLogLineEventFull {
  job_id: string;
  level: string;
  message: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// ── Settings (/admin/api/settings) ──────────────────────────────────────────
export type SettingsFieldType = "str" | "int" | "float" | "bool" | "secret";

export interface SettingsField {
  key: string;
  type: SettingsFieldType;
  label: string;
  secret: boolean;
  help: string;
  options: string[] | null;
  show_if: Record<string, string[]> | null;
  is_model: boolean;
  value: string | number | boolean | null;
}

export interface SettingsGroup {
  group: string;
  label: string;
  description: string;
  provider_field: string | null;
  test: string | null;
  fields: SettingsField[];
}

export interface SettingsPayload {
  groups: SettingsGroup[];
}

export interface SettingsActionResult {
  ok: boolean;
  message?: string;
  models?: string[];
  values?: Record<string, unknown>;
}

// ── Modules (/admin/api/modules) ──────────────────────────────────────────
export interface UploadedFile {
  uploaded_file_id: string;
  module_key: string;
  source_role: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  uploaded_at: string;
  validation_status: string;
  validation_error: string;
  module_source_id: string | null;
  is_active: boolean;
  activated_at: string | null;
  // Drug index only (cumulative imports):
  imported?: boolean;
  imported_at?: string;
  import_status?: "pending" | "importing" | "imported" | "failed";
  import_job_id?: string;
  import_job_status?: string;
  import_current_step?: string;
  import_started_at?: string;
  import_updated_at?: string;
  import_finished_at?: string;
  import_error?: string;
}

// One entry per (module_key, source_role) from SOURCE_CATALOG.
export interface CatalogEntry {
  module_key: string;
  source_role: string;
  label: string;
  description: string;
  accepted_extensions: string[];
  multi_source: boolean;
  active_source: UploadedFile | null;
  active_sources: UploadedFile[];
  recent_uploads: UploadedFile[];
  last_imported_at: string;
  cumulative_total?: number;
}

// Version history (/admin/api/modules/{key}/versions)
export interface SourceVersion {
  module_source_id: string;
  module_key: string;
  source_role: string;
  role_label: string;
  is_active: boolean;
  version_num: number | null;
  uploaded_file_id: string;
  original_filename: string;
  size_bytes: number | null;
  sha256: string;
  uploaded_by: string;
  validation_status: string;
  activated_at: string | null;
  uploaded_at: string | null;
}

// Schedule (/admin/api/modules/{key}/schedule)
export interface Schedule {
  schedule_id: string;
  module_key: string;
  source_role: string | null;
  fetch_url: string | null;
  frequency: "daily" | "weekly" | "monthly";
  day_of_week: number | null;
  day_of_month: number | null;
  hour_utc: number;
  minute_utc: number;
  is_enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_run_status: string | null;
  last_run_job_id: string | null;
  last_error: string | null;
}

// Generic data preview (/admin/api/modules/{key}/preview)
export interface PreviewResult {
  rows?: Array<Record<string, unknown>>;
  total?: number;
  page?: number;
  per_page?: number;
  message?: string;
  [k: string]: unknown;
}

// Drug asset link (drug_service.get_drug_asset_links)
export interface DrugAsset {
  asset_id: string;
  license_id?: string;
  asset_type: string;
  asset_group: string;
  source_page?: string;
  source_url?: string;
  source_filename: string;
  normalized_filename?: string;
  upload_date?: string;
  mime_type: string;
  size_bytes: number | null;
  storage_status: string;
  download_status: string;
  minio?: {
    bucket: string;
    object_key: string;
    uri: string;
    presigned_url: string | null;
  };
}

export interface DrugAssetsPayload {
  license_id: string;
  assets: DrugAsset[];
}

export interface DrugDetailsPayload {
  license_id: string;
  record?: Record<string, unknown>;
  availability?: Record<string, string>;
  documents_summary?: Record<string, number>;
  error?: string;
}

export interface DrugEvent {
  stage: string;
  status: string;
  error_message: string | null;
  created_at: string | null;
}

export interface ModulesPayload {
  modules: CatalogEntry[];
  upload_limits: { max_upload_mb: number };
  storage: {
    minio_enabled: boolean;
    bucket: string;
    detail: string;
  };
  // Per-module maintenance-mode flags (only maintenance-capable modules, e.g. icd).
  maintenance?: Record<string, boolean>;
  // Row counts for modules — distinguishes EMPTY vs POPULATED for action gating.
  record_counts?: Record<string, number>;
}

export interface DbHealthSnapshot {
  state: "healthy" | "recovering" | "unreachable";
  healthy: boolean;
  since: string;
  for_seconds: number;
  last_ok_at: string | null;
  last_error: string;
  monitoring: boolean;
}

// ── Embedding status (/admin/api/embedding/status) ──────────────────────────
export interface EmbeddingModule {
  key: string;
  label: string;
  job_type: string;
  total: number;
  embedded: number;
  last_embedded_at: string;
  last_source_updated_at: string;
  detail?: Record<string, number>;
  note?: string;
}

export interface EmbeddingStatusPayload {
  ollama: {
    provider: string;
    base_url: string;
    model: string;
    dimensions: number;
    configured: boolean;
    reachable: boolean;
  };
  modules: EmbeddingModule[];
}
