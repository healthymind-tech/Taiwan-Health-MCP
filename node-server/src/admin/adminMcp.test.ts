import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { CatalogTool, ToolGroupInfo } from "../mcp.js";
import type { ModuleStatus } from "../moduleStatus.js";
import {
  InvokeRateLimiter,
  argsDigest,
  buildCatalogPayload,
  buildOverviewPayload,
  handleMcpApi,
  isConfirmedWrite,
  toolReportedOk,
  type McpAdminDeps,
  type OverviewInfo,
} from "./adminMcp.js";

const GROUPS: ToolGroupInfo[] = [
  { key: "icd", label: "ICD-10", module: "icd" },
  { key: "fhir_condition", label: "FHIR R4 (Condition)", module: "fhir_condition" },
  { key: "food_nutrition", label: "Food Nutrition", module: "food_nutrition" },
  { key: "fhir_servers", label: "FHIR Servers", module: null },
  { key: "system", label: "System", module: null },
];

const CATALOG: CatalogTool[] = [
  { name: "search_medical_codes", group: "icd", description: "Search ICD codes. More text.", shape: { keyword: z.string(), limit: z.number().int().default(3) } },
  { name: "query_fhir_condition", group: "fhir_condition", description: "Generate a Condition.", shape: { icd_code: z.string().nullish().default(null) } },
  { name: "query_food_nutrition", group: "food_nutrition", description: "Food.", shape: { food_name: z.string() } },
  { name: "crud_fhir_server", group: "fhir_servers", description: "CRUD.", shape: { server_key: z.string(), operation: z.string().default("metadata"), confirm_write: z.boolean().default(false) } },
  { name: "health_check", group: "system", description: "Health.", shape: {} },
];

const STATUS: ModuleStatus = {
  icd: true, drug: true, health_supplements: false, food_nutrition: false,
  fhir_condition: true, fhir_medication: true, lab: true, ig: true, snomed: true,
};

const COUNTS = {
  icd: { table: "icd.diagnoses", minimum: 10_000, count: 74_000 },
  food_nutrition: { table: "food_nutrition.measurements", minimum: 10, count: 0 },
};

function fakeDeps(overrides: Partial<McpAdminDeps> = {}): McpAdminDeps & { calls: Array<{ name: string; args: unknown }>; logs: Array<Record<string, unknown>> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let t = 1000;
  const registered = new Set(["search_medical_codes", "query_fhir_condition", "crud_fhir_server", "health_check"]);
  const deps: McpAdminDeps = {
    refreshRegistry: async () => {},
    ensureRegistry: async () => {},
    registeredNames: () => registered,
    catalog: () => CATALOG,
    groups: () => GROUPS,
    writeCapable: () => new Set(["crud_fhir_server"]),
    inputSchema: () => ({ type: "object" }),
    invoke: async (name, args) => {
      calls.push({ name, args });
      // Same validation the real invokeRegisteredTool applies.
      const parsed = z.object(CATALOG.find((c) => c.name === name)!.shape).parse(args);
      return JSON.stringify({ echoed: parsed });
    },
    moduleStatus: async () => STATUS,
    moduleCounts: async () => COUNTS,
    maintenanceModules: () => ({ icd: "icd", fhir_condition: "icd", food_nutrition: null, fhir_servers: null, system: null }),
    maintenanceStates: async () => ({ icd: false }),
    overviewInfo: async () => OVERVIEW,
    now: () => (t += 7),
    log: (_m, extra) => logs.push(extra),
    ...overrides,
  };
  return Object.assign(deps, { calls, logs });
}

const OVERVIEW: OverviewInfo = {
  serverName: "taiwan-health-mcp",
  serverVersion: "1.1.0",
  build: "abc123",
  lexiconVersion: "1",
  mcpPath: "/mcp",
  publicBaseUrl: "https://mcp.example.tw/",
  authMode: "bearer",
  bearerConfigured: true,
  corsOrigins: ["https://chat.example.tw"],
  fhirServers: [{ id: "11111111-2222-3333-4444-555555555555", server_key: "hapi", token_auth_method: "private_key_jwt" }],
};

test("catalog payload: enabled flags, reasons, gates and group totals", () => {
  const p = buildCatalogPayload({
    catalog: CATALOG,
    groups: GROUPS,
    registered: new Set(["search_medical_codes", "query_fhir_condition", "health_check"]),
    writeCapable: new Set(["crud_fhir_server"]),
    status: STATUS,
    counts: COUNTS,
    inputSchema: () => ({ type: "object" }),
  });
  const by = Object.fromEntries(p.tools.map((t) => [t.name, t]));
  assert.equal(by.search_medical_codes.reason, "module_ready");
  assert.deepEqual(by.search_medical_codes.gate, { module: "icd", derived_from: null, table: "icd.diagnoses", minimum: 10_000, count: 74_000, ready: true });
  assert.equal(by.search_medical_codes.summary, "Search ICD codes.");
  assert.equal(by.query_fhir_condition.gate?.derived_from, "icd");
  assert.equal(by.query_fhir_condition.gate?.table, "icd.diagnoses");
  assert.equal(by.query_food_nutrition.enabled, false);
  assert.equal(by.query_food_nutrition.reason, "module_data_missing");
  assert.equal(by.query_food_nutrition.gate?.count, 0);
  // Always-on group whose service failed to start: not registered, no gate.
  assert.equal(by.crud_fhir_server.reason, "service_unavailable");
  assert.equal(by.crud_fhir_server.gate, null);
  assert.equal(by.crud_fhir_server.write_capable, true);
  assert.equal(by.health_check.reason, "always_on");
  assert.deepEqual(p.totals, { total: 5, enabled: 3, disabled: 2 });
  const food = p.groups.find((g) => g.key === "food_nutrition")!;
  assert.deepEqual([food.total, food.enabled, food.disabled, food.always_on], [1, 0, 1, false]);
});

test("catalog payload: module ready but tool missing → service_unavailable; count failure → module_check_failed", () => {
  const p = buildCatalogPayload({
    catalog: CATALOG,
    groups: GROUPS,
    registered: new Set(),
    writeCapable: new Set(),
    status: STATUS,
    counts: { food_nutrition: { table: "food_nutrition.measurements", minimum: 10, count: null, error: "relation does not exist" } },
    inputSchema: () => ({}),
  });
  const by = Object.fromEntries(p.tools.map((t) => [t.name, t]));
  assert.equal(by.search_medical_codes.reason, "service_unavailable");
  assert.equal(by.query_food_nutrition.reason, "module_check_failed");
  assert.equal(by.query_food_nutrition.gate?.error, "relation does not exist");
});

test("overview: URLs from the public base, bearer token never exposed", () => {
  const o = buildOverviewPayload(OVERVIEW, { total: 63, enabled: 58 }) as Record<string, any>;
  assert.equal(o.mcp.url, "https://mcp.example.tw/mcp");
  assert.equal(o.endpoints.find((e: any) => e.key === "openapi").url, "https://mcp.example.tw/openapi.json");
  assert.equal(o.endpoints.find((e: any) => e.key === "mcp").auth, "bearer");
  assert.equal(o.fhir_servers[0].jwks_url, "https://mcp.example.tw/fhir-client/11111111-2222-3333-4444-555555555555/jwks.json");
  assert.equal(o.fhir_servers[0].uses_jwks, true);
  assert.equal(o.auth.bearer_configured, true);
  assert.ok(!JSON.stringify(o).toLowerCase().includes("token\":\"s"), "no token value");
  assert.ok(!("bearer_token" in o.auth));
});

test("invoke: validates through the same handler path and reports elapsed + status", async () => {
  const deps = fakeDeps();
  const lim = new InvokeRateLimiter(30, () => 0);
  const out = await handleMcpApi(deps, lim, "POST", "/admin/api/mcp/tools/search_medical_codes/invoke", { arguments: { keyword: "糖尿病" } }, "admin");
  assert.equal(out?.status, 200);
  const body = out!.body as Record<string, any>;
  assert.equal(body.ok, true);
  assert.equal(body.tool_ok, true);
  assert.equal(body.http_status, 200);
  assert.equal(body.elapsed_ms, 7);
  assert.deepEqual(body.result, { echoed: { keyword: "糖尿病", limit: 3 } }, "zod defaults applied");
  assert.equal(body.public_path, "/tools/search_medical_codes");
});

test("invoke: zod failure maps to the bridge's 400 tool_call_failed with issues", async () => {
  const deps = fakeDeps();
  const out = await handleMcpApi(deps, new InvokeRateLimiter(30, () => 0), "POST", "/admin/api/mcp/tools/search_medical_codes/invoke", { arguments: { keyword: 42 } }, "admin");
  const body = out!.body as Record<string, any>;
  assert.equal(out!.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.http_status, 400);
  assert.equal(body.error, "tool_call_failed");
  assert.ok(Array.isArray(body.issues) && body.issues[0].path[0] === "keyword");
});

test("invoke: unknown, disabled, bad body and wrong method", async () => {
  const deps = fakeDeps();
  const lim = new InvokeRateLimiter(30, () => 0);
  assert.equal((await handleMcpApi(deps, lim, "POST", "/admin/api/mcp/tools/nope/invoke", {}, "a"))!.status, 404);
  const disabled = await handleMcpApi(deps, lim, "POST", "/admin/api/mcp/tools/query_food_nutrition/invoke", { arguments: { food_name: "白飯" } }, "a");
  assert.equal(disabled!.status, 409);
  assert.equal(deps.calls.length, 0, "a disabled tool is never invoked");
  assert.equal((await handleMcpApi(deps, lim, "POST", "/admin/api/mcp/tools/health_check/invoke", { arguments: [1] }, "a"))!.status, 400);
  assert.equal((await handleMcpApi(deps, lim, "GET", "/admin/api/mcp/tools/health_check/invoke", {}, "a"))!.status, 405);
  assert.equal(await handleMcpApi(deps, lim, "GET", "/admin/api/mcp/elsewhere", {}, "a"), null);
});

test("invoke: confirmed crud write needs an explicit confirm_write_operation", async () => {
  const deps = fakeDeps();
  const lim = new InvokeRateLimiter(30, () => 0);
  const args = { server_key: "hapi", operation: "create", confirm_write: true };
  assert.equal(isConfirmedWrite("crud_fhir_server", args), true);
  assert.equal(isConfirmedWrite("crud_fhir_server", { ...args, confirm_write: false }), false);
  assert.equal(isConfirmedWrite("crud_fhir_server", { ...args, operation: "read" }), false);
  const refused = await handleMcpApi(deps, lim, "POST", "/admin/api/mcp/tools/crud_fhir_server/invoke", { arguments: args }, "a");
  assert.equal(refused!.status, 428);
  assert.equal(deps.calls.length, 0);
  const ok = await handleMcpApi(deps, lim, "POST", "/admin/api/mcp/tools/crud_fhir_server/invoke", { arguments: args, confirm_write_operation: true }, "a");
  assert.equal(ok!.status, 200);
  assert.equal(deps.calls.length, 1);
  // Unconfirmed write: passes through so the tool itself refuses it (same as /tools).
  const unconfirmed = await handleMcpApi(deps, lim, "POST", "/admin/api/mcp/tools/crud_fhir_server/invoke", { arguments: { ...args, confirm_write: false } }, "a");
  assert.equal(unconfirmed!.status, 200);
});

test("invoke: arguments are never logged, only a digest prefix", async () => {
  const deps = fakeDeps();
  const secret = "病人王小明今日胸痛";
  await handleMcpApi(deps, new InvokeRateLimiter(30, () => 0), "POST", "/admin/api/mcp/tools/search_medical_codes/invoke", { arguments: { keyword: secret } }, "admin");
  assert.equal(deps.logs.length, 1);
  const line = JSON.stringify(deps.logs[0]);
  assert.ok(!line.includes(secret));
  assert.equal(deps.logs[0].args_sha256, argsDigest({ keyword: secret }).sha256.slice(0, 12));
  assert.equal(deps.logs[0].tool, "search_medical_codes");
});

test("invoke: rate limited per user", async () => {
  let now = 0;
  const lim = new InvokeRateLimiter(2, () => now);
  assert.equal(lim.take("a"), 0);
  assert.equal(lim.take("a"), 0);
  assert.ok(lim.take("a") > 0);
  assert.equal(lim.take("b"), 0, "other users unaffected");
  now = 60_001;
  assert.equal(lim.take("a"), 0, "window slides");
  const deps = fakeDeps();
  const tight = new InvokeRateLimiter(1, () => 0);
  await handleMcpApi(deps, tight, "POST", "/admin/api/mcp/tools/health_check/invoke", {}, "a");
  const limited = await handleMcpApi(deps, tight, "POST", "/admin/api/mcp/tools/health_check/invoke", {}, "a");
  assert.equal(limited!.status, 429);
});

test("toolReportedOk", () => {
  assert.equal(toolReportedOk({ ok: true, data: {} }), true);
  assert.equal(toolReportedOk({ ok: false, error: { code: "X" } }), false);
  assert.equal(toolReportedOk({ error: "Provide keyword" }), false);
  assert.equal(toolReportedOk({ valid: false, errors: ["x"] }), true, "a validation verdict is a successful call");
  assert.equal(toolReportedOk([1, 2]), true);
});

test("GET tools refreshes the registry and returns the catalog", async () => {
  let refreshed = 0;
  const deps = fakeDeps({ refreshRegistry: async () => void refreshed++ });
  const out = await handleMcpApi(deps, new InvokeRateLimiter(30, () => 0), "GET", "/admin/api/mcp/tools", {}, "a");
  assert.equal(refreshed, 1);
  assert.equal((out!.body as any).totals.total, 5);
  const ov = await handleMcpApi(deps, new InvokeRateLimiter(30, () => 0), "GET", "/admin/api/mcp/overview", {}, "a");
  assert.deepEqual((ov!.body as any).tools, { total: 5, enabled: 4 });
});

test("GET tools: maintenance state per tool and group (only modules with a toggle; always-on groups never)", async () => {
  const deps = fakeDeps({ maintenanceStates: async () => ({ icd: true }) });
  const body = (await handleMcpApi(deps, new InvokeRateLimiter(30, () => 0), "GET", "/admin/api/mcp/tools", {}, "a"))!.body as any;
  const by = Object.fromEntries(body.tools.map((t: any) => [t.name, t]));
  assert.deepEqual(by.search_medical_codes.maintenance, { module: "icd", active: true });
  assert.deepEqual(by.query_fhir_condition.maintenance, { module: "icd", active: true }, "derived group follows icd");
  assert.equal(by.query_food_nutrition.maintenance, null);
  assert.equal(by.health_check.maintenance, null);
  assert.equal(by.search_medical_codes.enabled, true, "maintenance does not change registration (tools/list unchanged)");
  assert.deepEqual(body.groups.find((g: any) => g.key === "icd").maintenance, { module: "icd", active: true });
  // a failing state lookup leaves the catalog usable (maintenance reported inactive)
  const failing = fakeDeps({ maintenanceStates: async () => { throw new Error("db down"); } });
  const b2 = (await handleMcpApi(failing, new InvokeRateLimiter(30, () => 0), "GET", "/admin/api/mcp/tools", {}, "a"))!.body as any;
  assert.deepEqual(b2.tools.find((t: any) => t.name === "search_medical_codes").maintenance, { module: "icd", active: false });
});
