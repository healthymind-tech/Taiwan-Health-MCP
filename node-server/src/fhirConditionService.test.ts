/**
 * query_fhir_condition never invents data (R3): dates and timestamps appear only when the
 * caller supplies them. Fake query function, no DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FHIRConditionService, type ConditionQueryFn } from "./fhirConditionService.js";

const ROW = { code: "I10", name_zh: "原發性高血壓", name_en: "Essential (primary) hypertension" };
const q: ConditionQueryFn = async <T extends object>(sql: string, params: unknown[]): Promise<{ rows: T[] }> => {
  if (sql.includes("WHERE code = $1")) return { rows: (params[0] === "I10" ? [ROW] : []) as T[] };
  return { rows: [ROW] as T[] };
};

test("createCondition: no recordedDate / meta.lastUpdated / note.time unless supplied", async () => {
  const svc = new FHIRConditionService(q);
  const c = (await svc.createCondition("I10", "p1", { additional_notes: "seen in clinic" })) as Record<string, any>;
  assert.equal(c.resourceType, "Condition");
  assert.ok(!("recordedDate" in c), "recordedDate must be omitted, never now()");
  assert.deepEqual(c.meta, { profile: ["http://hl7.org/fhir/StructureDefinition/Condition"] });
  assert.deepEqual(c.note, [{ text: "seen in clinic" }]);
  assert.ok(!("onsetDateTime" in c));
  assert.equal(c.code.coding[0].code, "I10");
  assert.equal(c.subject.reference, "Patient/p1");
  assert.equal(JSON.stringify(c).includes(String(new Date().getUTCFullYear())), false, "no current-year timestamp anywhere");
});

test("createCondition: supplied dates are kept verbatim", async () => {
  const svc = new FHIRConditionService(q);
  const c = (await svc.createCondition("I10", "p1", { recorded_date: "2024-03-05", onset_date: "2023-12" })) as Record<string, any>;
  assert.equal(c.recordedDate, "2024-03-05");
  assert.equal(c.onsetDateTime, "2023-12");
});

test("createConditionFromSearch builds the same Condition (no invented dates)", async () => {
  const svc = new FHIRConditionService(q);
  const r = (await svc.createConditionFromSearch("hypertension", "p2")) as Record<string, any>;
  assert.equal(r.selected_code, "I10");
  assert.ok(!("recordedDate" in r.fhir_condition));
  assert.ok(!("lastUpdated" in r.fhir_condition.meta));
});

test("unknown code: error envelope, nothing built", async () => {
  const svc = new FHIRConditionService(q);
  const r = (await svc.createCondition("Z99.999", "p1")) as Record<string, any>;
  assert.match(String(r.error), /not found/);
});
