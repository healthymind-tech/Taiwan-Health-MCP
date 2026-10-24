/**
 * query_fhir_medication never invents data (R3): meta.lastUpdated is not stamped with now.
 * Fake query function, no DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FHIRMedicationService, type MedicationQueryFn } from "./fhirMedicationService.js";

const ROW = {
  license_id: "衛署藥製字第012345號",
  is_active: true,
  cancellation_status: "",
  normalized_json: { drug: { chinese_name: "測試錠", english_name: "Test Tablets", dosage_form: "錠劑" }, ingredients: { active: [] } },
};
const q: MedicationQueryFn = async <T extends object>(): Promise<{ rows: T[] }> => ({ rows: [ROW] as T[] });

test("createMedication: meta carries the profile only — no lastUpdated", async () => {
  const svc = new FHIRMedicationService(q);
  for (const rt of ["Medication", "MedicationKnowledge"] as const) {
    const m = (await svc.createMedication(ROW.license_id, rt)) as Record<string, any>;
    assert.equal(m.resourceType, rt);
    assert.deepEqual(Object.keys(m.meta), ["profile"]);
    assert.equal(m.status, "active");
    assert.equal(JSON.stringify(m).includes(String(new Date().getUTCFullYear())), false, "no current-year timestamp anywhere");
  }
});

test("createMedicationFromSearch: same resource, no invented timestamp", async () => {
  const svc = new FHIRMedicationService(q);
  const r = (await svc.createMedicationFromSearch("測試")) as Record<string, any>;
  assert.equal(r.selected_license_id, ROW.license_id);
  assert.ok(!("lastUpdated" in r.fhir_medication.meta));
});
