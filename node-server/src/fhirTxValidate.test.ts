import { test } from "node:test";
import assert from "node:assert/strict";
import { expandComposeWith, indexCodeSystem, safeRegex, valueSetContains, type TerminologyDeps } from "./fhirCodeSystem.js";
import { txValidateCode } from "./fhirTxValidate.js";

// Fixtures modelled on the HL7 tx ecosystem test cases (inactive / version / regex-bad / default-valueset-version).
const CS = "http://example.org/cs";
const csV1 = { resourceType: "CodeSystem", url: CS, version: "1.0.0", content: "complete", concept: [{ code: "a", display: "A" }, { code: "b", display: "B" }] };
const csV2 = {
  resourceType: "CodeSystem",
  url: CS,
  version: "1.2.0",
  content: "complete",
  concept: [{ code: "a", display: "A" }, { code: "b", display: "B" }, { code: "c", display: "C" }, { code: "old", display: "Old", property: [{ code: "status", valueCode: "retired" }] }],
};
const vsAll = { resourceType: "ValueSet", url: "http://example.org/vs/all", compose: { include: [{ system: CS }] } };
const vsActive = { resourceType: "ValueSet", url: "http://example.org/vs/active", compose: { inactive: false, include: [{ system: CS }] } };
const vsPinned = { resourceType: "ValueSet", url: "http://example.org/vs/v1", compose: { include: [{ system: CS, version: "1.0.0" }] } };
const vsImportV1 = { resourceType: "ValueSet", url: "http://example.org/vs/imp", compose: { include: [{ valueSet: ["http://example.org/vs/sub|1"] }] } };
const sub1 = { resourceType: "ValueSet", url: "http://example.org/vs/sub", version: "1", compose: { include: [{ system: CS, concept: [{ code: "a" }] }] } };
const sub2 = { resourceType: "ValueSet", url: "http://example.org/vs/sub", version: "2", compose: { include: [{ system: CS, concept: [{ code: "c" }] }] } };

function deps(): TerminologyDeps & { codeSystemVersions(u: string): string[] } {
  const cs = [csV1, csV2].map((r) => indexCodeSystem(r));
  const vss = [vsAll, vsActive, vsPinned, vsImportV1, sub1, sub2];
  return {
    async loadCodeSystem(url) {
      const [u, v] = url.split("|");
      const hits = cs.filter((c) => c.url === u && (!v || c.version === v));
      return hits[hits.length - 1] ?? null;
    },
    async loadValueSet(url) {
      const [u, v] = url.split("|");
      const hits = vss.filter((x) => x.url === u && (!v || (x as any).version === v));
      return (hits[hits.length - 1] as any) ?? null;
    },
    async lookupExternal() {
      return null;
    },
    async externalSystemHeld() {
      return false;
    },
    codeSystemVersions: () => ["1.0.0", "1.2.0"],
  };
}

test("compose.inactive = false excludes an inactive (retired) concept from membership and expansion", async () => {
  assert.equal(await valueSetContains(vsAll.url, CS, "old", deps()), true);
  assert.equal(await valueSetContains(vsActive.url, CS, "old", deps()), false);
  const ex = await expandComposeWith(vsActive.compose, deps(), 100);
  assert.deepEqual(ex.codings.map((c) => c.code).sort(), ["a", "b", "c"]);
});

test("include.version pins the CodeSystem version; a versioned include.valueSet import pins that ValueSet version", async () => {
  assert.equal(await valueSetContains(vsPinned.url, CS, "c", deps()), false); // c exists only in 1.2.0
  assert.equal(await valueSetContains(vsImportV1.url, CS, "a", deps()), true);
  assert.equal(await valueSetContains(vsImportV1.url, CS, "c", deps()), false); // c is in sub|2 only
});

test("catastrophic filter regex is refused (undecidable), not evaluated", () => {
  assert.equal(safeRegex("(a+)+"), null);
  assert.equal(safeRegex("((a+)+)+"), null);
  assert.ok(safeRegex("[A-Z]{2}\\d+"));
  assert.ok(safeRegex("(ab)+"));
});

test("tx $validate-code: retired concept → INACTIVE_CONCEPT_FOUND warning; not in an active-only value set → STATUS_CODE_WARNING_CODE", async () => {
  const ok = await txValidateCode({ mode: "valueset", url: vsAll.url, coding: { system: CS, code: "old" }, params: {} }, deps());
  assert.equal(ok.result, true);
  assert.ok(ok.issues.some((i) => i.id === "INACTIVE_CONCEPT_FOUND" && i.severity === "warning"));
  const bad = await txValidateCode({ mode: "valueset", url: vsActive.url, coding: { system: CS, code: "old" }, params: {} }, deps());
  assert.equal(bad.result, false);
  assert.ok(bad.issues.some((i) => i.id === "STATUS_CODE_WARNING_CODE"));
});

test("tx $validate-code: Coding.version differing from the include version → VALUESET_VALUE_MISMATCH; no system → never a pass", async () => {
  const r = await txValidateCode({ mode: "valueset", url: vsPinned.url, coding: { system: CS, version: "1.2.0", code: "a" }, params: {} }, deps());
  assert.equal(r.result, false);
  assert.ok(r.issues.some((i) => i.id === "VALUESET_VALUE_MISMATCH"));
  const n = await txValidateCode({ mode: "valueset", url: vsAll.url, coding: { code: "a" }, params: {} }, deps());
  assert.equal(n.result, false);
  assert.ok(n.issues.some((i) => i.id === "Coding_has_no_system__cannot_validate"));
});
