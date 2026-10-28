/**
 * ISSUES_v16.2 R3 — failed-invariant explanations (invariants.ts): splitting, term descriptions,
 * evaluation on synthetic nodes, and a TWPAS 1.2.7 example Claim with the diagnosis rule broken
 * (local FHIR package cache; skipped when absent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator } from "../fhirValidator.js";
import { available, exampleBundles, packages } from "../../scripts/v16-structure-eval/packages.js";
import { attachSuggestions } from "./index.js";
import { describeTerm, explainInvariant, splitTop } from "./invariants.js";

const EXT = "http://example.org/StructureDefinition/recordedDate";

test("splitTop splits outside parentheses and quotes", () => {
  assert.deepEqual(splitTop("a implies (b and c)", "implies"), ["a", "(b and c)"]);
  assert.deepEqual(splitTop("x.where(y = 'a and b').exists() and z.exists()", "and"), ["x.where(y = 'a and b').exists()", "z.exists()"]);
  assert.deepEqual(splitTop("(a or b) and c", "or"), ["(a or b) and c"]);
});

test("describeTerm: plain paths and extension tests (url, value type, JSON to write)", () => {
  assert.equal(describeTerm("type.text.exists()").missing, "type.text");
  const e = describeTerm(`extension.where(url = '${EXT}').value.ofType(date).exists()`);
  assert.deepEqual(e.extension, { url: EXT, value_type: "date" });
  assert.deepEqual(e.write, { url: EXT, valueDate: "<date>" });
  assert.equal(describeTerm("count() = 1").missing, undefined);
});

test("explainInvariant: the false parts of `guard implies (a and b)`; nothing when the guard is false", () => {
  const expr = `sequence=1 implies (extension.where(url = '${EXT}').value.ofType(date).exists() and type.text.exists() )`;
  const env = { resource: {}, rootResource: {} };
  const node = { sequence: 1, type: [{ text: "主診斷" }] };
  const info = explainInvariant("diagnosis", expr, node, "Claim.diagnosis", env)!;
  assert.equal(info.need, "all");
  assert.equal(info.applies_because, "sequence=1");
  assert.equal(info.failed.length, 1);
  assert.equal(info.failed[0].extension?.url, EXT);
  assert.match(info.hint, /missing: extension .*recordedDate \(valueDate\)/);
  assert.equal(explainInvariant("diagnosis", expr, { sequence: 2 }, "Claim.diagnosis", env), null);
  const both = explainInvariant("diagnosis", expr, { sequence: 1 }, "Claim.diagnosis", env)!;
  assert.deepEqual(both.failed.map((p) => p.missing), ["extension", "type.text"]);
  const alt = explainInvariant("pas-1", "text.exists() or coding.exists()", {}, "Claim.item.programCode", env)!;
  assert.equal(alt.need, "one_of");
  assert.deepEqual(alt.failed.map((p) => p.missing), ["text", "coding"]);
});

for (const ig of ["pas"]) {
  test(`R3 ${ig}: an example Claim whose primary diagnosis lost its recorded-date extension says which extension to add`, { skip: !available(ig), timeout: 600_000 }, async () => {
    const pk = packages(ig);
    const sdeps = pk.suggestionDeps();
    let checked = 0;
    for (const [, b0] of exampleBundles(ig, 2)) {
      const b = JSON.parse(JSON.stringify(b0));
      const claim = (b.entry as any[]).map((e) => e.resource).find((r) => r?.resourceType === "Claim" && Array.isArray(r.diagnosis));
      const d1 = claim?.diagnosis?.find((d: any) => d.sequence === 1 && Array.isArray(d.extension));
      if (!d1) continue;
      d1.extension = d1.extension.filter((x: any) => !/diagnosisRecordedDate/.test(String(x.url)));
      if (!d1.extension.length) delete d1.extension;
      const issues = (await new InstanceValidator(pk.resolver()).validate(b, {})) as any[];
      const inv = issues.filter((i) => i.code === "invariant" && /^Constraint failed: diagnosis:/.test(i.message));
      if (!inv.length) continue;
      const before = JSON.stringify(issues.map((i) => [i.severity, i.path, i.message]));
      await attachSuggestions(issues, b, sdeps);
      assert.equal(JSON.stringify(issues.map((i) => [i.severity, i.path, i.message])), before, "issues unchanged");
      const info = inv[0].invariant;
      assert.ok(info, "explained");
      assert.ok(info.failed.some((p: any) => /diagnosisRecordedDate$/.test(p.extension?.url ?? "") && p.extension.value_type === "date"), JSON.stringify(info));
      checked++;
      if (checked >= 2) break;
    }
    assert.ok(checked >= 1, "at least one example Claim checked");
  });
}
