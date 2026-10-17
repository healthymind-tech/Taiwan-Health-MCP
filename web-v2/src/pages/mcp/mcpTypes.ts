// Shapes of /admin/api/mcp/* (node-server/src/admin/adminMcp.ts).

export type ToolStatusReason = "always_on" | "module_ready" | "module_data_missing" | "module_check_failed" | "service_unavailable";

export interface ToolGate {
  module: string;
  derived_from: string | null;
  table: string | null;
  minimum: number | null;
  count: number | null;
  ready: boolean;
  error?: string;
}

export interface ToolExample {
  id: string;
  label: string;
  description?: string;
  args: Record<string, unknown>;
}

export interface CatalogTool {
  name: string;
  group: string;
  title: string;
  description: string;
  summary: string;
  version: string;
  version_pinned: boolean;
  enabled: boolean;
  reason: ToolStatusReason;
  gate: ToolGate | null;
  write_capable: boolean;
  input_schema: JsonSchema;
  examples: ToolExample[];
}

export interface CatalogGroup {
  key: string;
  label: string;
  module: string | null;
  always_on: boolean;
  total: number;
  enabled: number;
  disabled: number;
  gate: ToolGate | null;
}

export interface CatalogPayload {
  examples_version: string;
  totals: { total: number; enabled: number; disabled: number };
  groups: CatalogGroup[];
  tools: CatalogTool[];
}

export interface OverviewEndpoint {
  key: "mcp" | "openapi" | "tools" | "jwks" | "oauth_callback";
  methods: string[];
  path: string;
  url: string;
  auth: "none" | "bearer" | "capability";
}

export interface OverviewPayload {
  base_url: string;
  server: { name: string; version: string; build: string; lexicon_version: string; tools_version: Record<string, string> };
  auth: { mode: "none" | "bearer"; bearer_configured: boolean; cors_origins: string[]; env: { mode: string; token: string; cors: string } };
  mcp: { transport: string; path: string; url: string };
  endpoints: OverviewEndpoint[];
  fhir_servers: Array<{ id: string; server_key: string; token_auth_method: string | null; jwks_url: string; uses_jwks: boolean }>;
  tools: { total: number; enabled: number };
}

export interface InvokeResponse {
  ok: boolean;
  tool_ok: boolean;
  http_status: number;
  elapsed_ms: number;
  public_path: string;
  result?: unknown;
  error?: string;
  detail?: string;
  issues?: Array<{ path: Array<string | number>; message: string; code?: string }>;
}

/** The subset of JSON Schema that zod-to-json-schema emits for our tools. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  $ref?: string;
}
