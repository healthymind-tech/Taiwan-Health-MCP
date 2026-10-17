/**
 * Admin console → MCP 工具: public endpoint overview, full tool catalog and a playground.
 *
 *   GET  /admin/api/mcp/overview             public surfaces, auth mode, server version
 *   GET  /admin/api/mcp/tools                every tool in mcp.ts (registered or not) + why
 *   POST /admin/api/mcp/tools/{name}/invoke  run a registered tool exactly like POST /tools/{name}
 *
 * Mounted behind the admin session gate and the DB-health gate in adminApp.ts. The invoke
 * path goes through the same `invokeRegisteredTool` as the public OpenAPI bridge, so zod
 * validation and defaults are identical and a disabled tool cannot be reached.
 *
 * Privacy: tool arguments can hold clinical text (`source_text`, resources, bundles). They
 * are never logged — only a sha256 prefix of the canonical argument JSON and its size.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModuleStatus, ModuleCount, ModuleRequirement } from "../moduleStatus.js";
import { DERIVED_MODULES } from "../moduleStatus.js";
import type { CatalogTool, ToolGroupInfo } from "../mcp.js";
import { TOOLS_VERSION, toolVersion } from "../toolVersions.js";
import { MCP_TOOL_EXAMPLES_VERSION, toolExamples, type ToolExample } from "./mcpToolExamples.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolStatusReason =
  | "always_on"
  | "module_ready"
  | "module_data_missing"
  | "module_check_failed"
  | "service_unavailable";

export interface ToolGate {
  module: string;
  /** Set for fhir_condition / fhir_medication, which reuse another module's data. */
  derived_from: string | null;
  table: string | null;
  minimum: number | null;
  count: number | null;
  ready: boolean;
  error?: string;
}

export interface CatalogToolPayload {
  name: string;
  group: string;
  title: string;
  description: string;
  summary: string;
  version: string;
  /** True when the version is pinned in TOOLS_VERSION (otherwise it follows the server version). */
  version_pinned: boolean;
  enabled: boolean;
  reason: ToolStatusReason;
  gate: ToolGate | null;
  write_capable: boolean;
  input_schema: Record<string, unknown>;
  examples: ToolExample[];
}

export interface CatalogGroupPayload {
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
  groups: CatalogGroupPayload[];
  tools: CatalogToolPayload[];
}

export interface McpAdminDeps {
  /** Rebuild the tool registry so `registeredNames` reflects current module gating. */
  refreshRegistry(): Promise<void>;
  /** Make sure the registry exists (no rebuild when it is already warm). */
  ensureRegistry(): Promise<void>;
  registeredNames(): Set<string>;
  catalog(): readonly CatalogTool[];
  groups(): readonly ToolGroupInfo[];
  writeCapable(): ReadonlySet<string>;
  inputSchema(tool: CatalogTool): Record<string, unknown>;
  invoke(name: string, args: Record<string, unknown>): Promise<string>;
  moduleStatus(): Promise<ModuleStatus>;
  moduleCounts(): Promise<Partial<Record<ModuleRequirement["key"], ModuleCount>>>;
  overviewInfo(): Promise<OverviewInfo>;
  now(): number;
  log(message: string, extra: Record<string, unknown>): void;
}

export interface OverviewInfo {
  serverName: string;
  serverVersion: string;
  build: string;
  lexiconVersion: string;
  mcpPath: string;
  publicBaseUrl: string;
  authMode: "none" | "bearer";
  bearerConfigured: boolean;
  corsOrigins: string[];
  /** Admin-configured FHIR servers (only ids/keys — the JWKS URL is a public capability). */
  fhirServers: Array<{ id: string; server_key: string; token_auth_method: string | null }>;
}

export interface McpApiResult {
  status: number;
  body: unknown;
}

// ── Catalog ───────────────────────────────────────────────────────────────────

function firstLine(text: string): string {
  const line = (text || "").trim().split("\n")[0] ?? "";
  // First sentence, like the OpenAPI summary, but never cut mid-word for long ones.
  const sentence = /^(.+?[.。])(\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

function gateFor(
  module: keyof ModuleStatus | null,
  status: ModuleStatus | null,
  counts: Partial<Record<ModuleRequirement["key"], ModuleCount>>,
): ToolGate | null {
  if (!module) return null;
  const derived = (DERIVED_MODULES as Record<string, ModuleRequirement["key"]>)[module] ?? null;
  const dataKey = (derived ?? module) as ModuleRequirement["key"];
  const c = counts[dataKey];
  const gate: ToolGate = {
    module,
    derived_from: derived,
    table: c?.table ?? null,
    minimum: c?.minimum ?? null,
    count: c?.count ?? null,
    ready: status ? Boolean(status[module]) : false,
  };
  if (c?.error) gate.error = c.error;
  return gate;
}

/** Pure: assemble the catalog payload from the static catalog + live state. */
export function buildCatalogPayload(input: {
  catalog: readonly CatalogTool[];
  groups: readonly ToolGroupInfo[];
  registered: Set<string>;
  writeCapable: ReadonlySet<string>;
  status: ModuleStatus | null;
  counts: Partial<Record<ModuleRequirement["key"], ModuleCount>>;
  inputSchema: (tool: CatalogTool) => Record<string, unknown>;
}): CatalogPayload {
  const groupInfo = new Map(input.groups.map((g) => [g.key, g]));
  const tools: CatalogToolPayload[] = input.catalog.map((t) => {
    const info = groupInfo.get(t.group);
    const gate = gateFor(info?.module ?? null, input.status, input.counts);
    const enabled = input.registered.has(t.name);
    let reason: ToolStatusReason;
    if (!gate) reason = enabled ? "always_on" : "service_unavailable";
    else if (enabled) reason = "module_ready";
    else if (gate.ready) reason = "service_unavailable";
    else if (gate.count === null) reason = "module_check_failed";
    else reason = "module_data_missing";
    const ex = toolExamples(t.name);
    return {
      name: t.name,
      group: t.group,
      title: ex?.title ?? t.name,
      description: t.description,
      summary: firstLine(t.description),
      version: toolVersion(t.name),
      version_pinned: Object.prototype.hasOwnProperty.call(TOOLS_VERSION, t.name),
      enabled,
      reason,
      gate,
      write_capable: input.writeCapable.has(t.name),
      input_schema: input.inputSchema(t),
      examples: ex?.examples ?? [],
    };
  });

  const groups: CatalogGroupPayload[] = input.groups.map((g) => {
    const members = tools.filter((t) => t.group === g.key);
    const enabled = members.filter((t) => t.enabled).length;
    return {
      key: g.key,
      label: g.label,
      module: g.module,
      always_on: g.module === null,
      total: members.length,
      enabled,
      disabled: members.length - enabled,
      gate: gateFor(g.module, input.status, input.counts),
    };
  });
  const enabled = tools.filter((t) => t.enabled).length;
  return {
    examples_version: MCP_TOOL_EXAMPLES_VERSION,
    totals: { total: tools.length, enabled, disabled: tools.length - enabled },
    groups,
    tools,
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

export function buildOverviewPayload(info: OverviewInfo, totals: { total: number; enabled: number }): Record<string, unknown> {
  const base = info.publicBaseUrl.replace(/\/+$/, "");
  const url = (p: string) => `${base}${p}`;
  const protectedAuth = info.authMode === "bearer" ? "bearer" : "none";
  return {
    base_url: base,
    server: {
      name: info.serverName,
      version: info.serverVersion,
      build: info.build,
      lexicon_version: info.lexiconVersion,
      tools_version: TOOLS_VERSION,
    },
    auth: {
      mode: info.authMode,
      bearer_configured: info.bearerConfigured,
      cors_origins: info.corsOrigins,
      env: {
        mode: "PUBLIC_TOOLS_AUTH_MODE",
        token: "PUBLIC_TOOLS_BEARER_TOKEN",
        cors: "PUBLIC_TOOLS_CORS_ORIGINS",
      },
    },
    mcp: { transport: "streamable-http", path: info.mcpPath, url: url(info.mcpPath) },
    endpoints: [
      { key: "mcp", methods: ["POST", "GET", "DELETE"], path: info.mcpPath, url: url(info.mcpPath), auth: protectedAuth },
      { key: "openapi", methods: ["GET"], path: "/openapi.json", url: url("/openapi.json"), auth: protectedAuth },
      { key: "tools", methods: ["POST"], path: "/tools/{name}", url: url("/tools/{name}"), auth: protectedAuth },
      { key: "jwks", methods: ["GET"], path: "/fhir-client/{id}/jwks.json", url: url("/fhir-client/{id}/jwks.json"), auth: "capability" },
      { key: "oauth_callback", methods: ["GET"], path: "/fhir-oauth/callback", url: url("/fhir-oauth/callback"), auth: "capability" },
    ],
    fhir_servers: info.fhirServers.map((s) => ({
      ...s,
      jwks_url: url(`/fhir-client/${encodeURIComponent(s.id)}/jwks.json`),
      uses_jwks: s.token_auth_method === "private_key_jwt",
    })),
    tools: totals,
  };
}

// ── Invoke ────────────────────────────────────────────────────────────────────

const WRITE_OPERATIONS = new Set(["create", "update", "patch", "delete"]);

/** True when a crud_fhir_server call would actually write to the external server. */
export function isConfirmedWrite(name: string, args: Record<string, unknown>): boolean {
  return name === "crud_fhir_server" && WRITE_OPERATIONS.has(String(args.operation ?? "")) && args.confirm_write === true;
}

/** sha256 hex of the argument JSON (logged instead of the arguments themselves). */
export function argsDigest(args: unknown): { sha256: string; bytes: number } {
  const text = JSON.stringify(args ?? {});
  return { sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text, "utf8") };
}

/** Did the tool report success? (`{ok:false}` envelopes and `{error}` payloads are failures.) */
export function toolReportedOk(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return true;
  const r = result as Record<string, unknown>;
  if (r.ok === false) return false;
  if (typeof r.error === "string" && r.error) return false;
  if (r.error && typeof r.error === "object") return false;
  return true;
}

/** Sliding one-minute window per admin user. */
export class InvokeRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number,
  ) {}

  /** Returns 0 when allowed (and records the hit), else the ms until the next slot. */
  take(key: string): number {
    const t = this.now();
    const live = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (live.length >= this.limitPerMinute) {
      this.hits.set(key, live);
      return Math.max(1, 60_000 - (t - live[0]));
    }
    live.push(t);
    this.hits.set(key, live);
    return 0;
  }
}

export const INVOKE_LIMIT_PER_MINUTE = 60;

export async function invokeTool(
  deps: McpAdminDeps,
  limiter: InvokeRateLimiter,
  username: string,
  name: string,
  body: Record<string, unknown>,
): Promise<McpApiResult> {
  const catalogTool = deps.catalog().find((t) => t.name === name);
  if (!catalogTool) return { status: 404, body: { error: "unknown_tool", tool: name } };

  const rawArgs = body.arguments ?? {};
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return { status: 400, body: { error: "arguments_must_be_a_json_object" } };
  }
  const args = rawArgs as Record<string, unknown>;

  const waitMs = limiter.take(username);
  if (waitMs > 0) {
    return { status: 429, body: { error: "rate_limited", retry_after_ms: waitMs, limit_per_minute: INVOKE_LIMIT_PER_MINUTE } };
  }

  await deps.ensureRegistry();
  if (!deps.registeredNames().has(name)) {
    return { status: 409, body: { error: "tool_disabled", tool: name } };
  }

  if (isConfirmedWrite(name, args) && body.confirm_write_operation !== true) {
    return {
      status: 428,
      body: {
        error: "write_confirmation_required",
        message: "This call writes to an external FHIR server; resend with confirm_write_operation=true.",
      },
    };
  }

  const digest = argsDigest(args);
  const started = deps.now();
  let status = 200;
  let payload: Record<string, unknown>;
  try {
    const text = await deps.invoke(name, args);
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      result = { result: text };
    }
    payload = { ok: true, tool_ok: toolReportedOk(result), result };
  } catch (exc) {
    // Same status and body as POST /tools/{name} on failure.
    status = 400;
    payload = { ok: false, tool_ok: false, error: "tool_call_failed", tool: name, detail: String((exc as Error).message) };
    if (exc instanceof z.ZodError) payload.issues = exc.issues;
  }
  const elapsed = Math.max(0, Math.round(deps.now() - started));
  deps.log("Admin MCP playground invocation", {
    tool: name,
    username,
    http_status: status,
    tool_ok: payload.tool_ok,
    elapsed_ms: elapsed,
    args_sha256: digest.sha256.slice(0, 12),
    args_bytes: digest.bytes,
    write: isConfirmedWrite(name, args),
  });
  return { status: 200, body: { ...payload, http_status: status, elapsed_ms: elapsed, public_path: `/tools/${name}` } };
}

// ── Router ────────────────────────────────────────────────────────────────────

const INVOKE_PATH = /^\/admin\/api\/mcp\/tools\/([A-Za-z0-9_]+)\/invoke$/;

/** Returns null when the path is not an MCP admin route. */
export async function handleMcpApi(
  deps: McpAdminDeps,
  limiter: InvokeRateLimiter,
  method: string,
  path: string,
  body: Record<string, unknown>,
  username: string,
): Promise<McpApiResult | null> {
  if (method === "GET" && path === "/admin/api/mcp/tools") {
    await deps.refreshRegistry();
    const [status, counts] = await Promise.all([deps.moduleStatus().catch(() => null), deps.moduleCounts().catch(() => ({}))]);
    return {
      status: 200,
      body: buildCatalogPayload({
        catalog: deps.catalog(),
        groups: deps.groups(),
        registered: deps.registeredNames(),
        writeCapable: deps.writeCapable(),
        status,
        counts,
        inputSchema: deps.inputSchema,
      }),
    };
  }
  if (method === "GET" && path === "/admin/api/mcp/overview") {
    await deps.ensureRegistry();
    const info = await deps.overviewInfo();
    const registered = deps.registeredNames();
    return {
      status: 200,
      body: buildOverviewPayload(info, { total: deps.catalog().length, enabled: deps.catalog().filter((t) => registered.has(t.name)).length }),
    };
  }
  const m = INVOKE_PATH.exec(path);
  if (m) {
    if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
    return invokeTool(deps, limiter, username, m[1], body);
  }
  return null;
}
