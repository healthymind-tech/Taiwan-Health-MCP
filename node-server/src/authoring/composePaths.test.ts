import { test } from "node:test";
import assert from "node:assert/strict";
import { selfAndAncestorPaths } from "./compose.js";

test("selfAndAncestorPaths terminates on any key — incl. a literal 'dose[x]' (2026-10-30 event-loop outage)", () => {
  assert.deepEqual(selfAndAncestorPaths("MedicationRequest.dosageInstruction[0].doseAndRate[0].dose[x]"), [
    "MedicationRequest.dosageInstruction[0].doseAndRate[0].dose[x]",
    "MedicationRequest.dosageInstruction[0].doseAndRate[0]",
    "MedicationRequest.dosageInstruction[0].doseAndRate",
    "MedicationRequest.dosageInstruction[0]",
    "MedicationRequest.dosageInstruction",
  ]);
  for (const odd of ["A.b.", "A.b[", "A.b]", "A.[x]", "A..b", "A.b[x][y]", "A.b c.d e"]) {
    const t = Date.now();
    const r = selfAndAncestorPaths(odd);
    assert.ok(Date.now() - t < 50 && r.length <= 256, odd);
  }
  assert.deepEqual(selfAndAncestorPaths("Patient"), []);
});
