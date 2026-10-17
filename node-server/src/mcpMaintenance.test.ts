import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_MAINTENANCE_MODULE,
  MODULE_MAINTENANCE_CODE,
  TOOL_GROUPS,
  maintenanceModuleForTool,
  withMaintenanceGate,
  withToolMetrics,
} from "./mcp.js";
import { MAINTENANCE_MODULES } from "./admin/adminMaintenance.js";

const OK = { content: [{ type: "text", text: '{"ok":true}' }] };

function fakeStates(states: Record<string, boolean>): { calls: string[][]; fn: (keys: readonly string[]) => Promise<Record<string, boolean>> } {
  const calls: string[][] = [];
  return {
    calls,
    fn: async (keys) => {
      calls.push([...keys]);
      return Object.fromEntries(keys.map((k) => [k, states[k] ?? false]));
    },
  };
}

test("maintenance gate: a tool of a module in maintenance fails fast with MODULE_MAINTENANCE (zh-TW + en)", async () => {
  let ran = 0;
  const s = fakeStates({ loinc: true });
  const gated = withMaintenanceGate("query_loinc", async () => (ran++, OK), s.fn);
  const out = (await gated({})) as any;
  assert.equal(ran, 0, "handler must not run");
  assert.equal(out.isError, true);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, MODULE_MAINTENANCE_CODE);
  assert.equal(body.error.module, "loinc");
  assert.equal(body.error.tool, "query_loinc");
  assert.match(body.error.message, /under maintenance/);
  assert.match(body.error.message_zh, /維護中/);
  assert.deepEqual(s.calls, [["loinc"]]);
});

test("maintenance gate: normal calls are passed through unchanged", async () => {
  const gated = withMaintenanceGate("query_loinc", async (a: { x: number }) => ({ ...OK, echoed: a.x }), fakeStates({ icd: true }).fn);
  assert.deepEqual(await gated({ x: 3 }), { ...OK, echoed: 3 });
});

test("maintenance gate: always-on tools never consult the state; a failing lookup fails open", async () => {
  const s = fakeStates({ loinc: true, icd: true, drug: true, snomed: true, ig: true, rxnorm: true });
  for (const name of ["health_check", "calculate_bmi", "crud_fhir_server", "list_fhir_servers", "query_food_nutrition", "search_health_supplements"]) {
    assert.equal(maintenanceModuleForTool(name), null, name);
    assert.deepEqual(await withMaintenanceGate(name, async () => OK, s.fn)(), OK, name);
  }
  assert.equal(s.calls.length, 0);
  const failing = withMaintenanceGate("query_loinc", async () => OK, async () => {
    throw new Error("db down");
  });
  assert.deepEqual(await failing(), OK);
});

test("maintenance mapping: groups map onto maintenance modules (derived groups follow their source data)", () => {
  assert.deepEqual(new Set(Object.keys(GROUP_MAINTENANCE_MODULE)), new Set(TOOL_GROUPS.map((g) => g.key)));
  for (const m of Object.values(GROUP_MAINTENANCE_MODULE)) if (m) assert.ok(MAINTENANCE_MODULES.includes(m), m);
  assert.equal(maintenanceModuleForTool("search_medical_codes"), "icd");
  assert.equal(maintenanceModuleForTool("query_fhir_condition"), "icd");
  assert.equal(maintenanceModuleForTool("search_drug"), "drug");
  assert.equal(maintenanceModuleForTool("query_fhir_medication"), "drug");
  assert.equal(maintenanceModuleForTool("query_loinc"), "loinc");
  assert.equal(maintenanceModuleForTool("search_snomed_concept"), "snomed");
  assert.equal(maintenanceModuleForTool("fhir_validate_bundle"), "ig");
  assert.equal(maintenanceModuleForTool("no_such_tool"), null);
});

test("maintenance gate composes with withToolMetrics: the blocked call is recorded as an error", async () => {
  const rec: Array<[string, string]> = [];
  const wrapped = withToolMetrics(
    "query_loinc",
    withMaintenanceGate("query_loinc", async () => OK, fakeStates({ loinc: true }).fn),
    (tool, status) => void rec.push([tool, status]),
  );
  const out = (await wrapped()) as any;
  assert.equal(out.isError, true);
  assert.deepEqual(rec, [["query_loinc", "error"]]);
});
