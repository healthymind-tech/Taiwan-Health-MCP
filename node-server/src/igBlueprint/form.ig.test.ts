/**
 * fhir_get_bundle_form against the real IG packages (ISSUES_v19 (b) structure part): TW Core
 * Bundle-twcore with planned entries and TWPAS Bundle-twpas / Bundle-immunologic-agent-twpas from a
 * local FHIR package cache (FHIR_PACKAGE_CACHE, default ~/.fhir/packages). Skipped when the packages
 * are not cached. The fake-fill + validation half of the acceptance is scripts/ig-blueprint/form-eval.mts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleForm, getAt, PLACEHOLDER_TOKEN, FORM_BUDGET, type FormPlaceholder } from "./form.js";
import { availableClosure, fileBlueprintDeps, TWCORE_CLOSURE, TWPAS_CLOSURE } from "./fileDeps.test.js";

type R = Record<string, any>;
const PAS = availableClosure(TWPAS_CLOSURE);
const TWC = availableClosure(TWCORE_CLOSURE);

function check(data: R, minEntries: number): void {
  const entries = (data.bundle as R).entry as R[];
  assert.ok(entries.length >= minEntries, `${entries.length} entries`);
  for (const e of entries) {
    assert.match(e.fullUrl, /^urn:uuid:/);
    assert.equal(typeof e.resource.resourceType, "string");
    assert.ok(Array.isArray(e.resource.meta?.profile) && e.resource.meta.profile.length, "every resource declares its profile");
  }
  (data.placeholders as FormPlaceholder[]).forEach((p, i) => {
    assert.ok(p.type && p.what && p.value_source);
    const m = PLACEHOLDER_TOKEN.exec(String(getAt(data.bundle, p.pointer)));
    assert.ok(m && Number(m[1]) === i, `${p.pointer} resolves to token ${i}`);
  });
  assert.doesNotMatch(JSON.stringify(data.bundle), /"<[^<>"]*>"/, "no raw skeleton token");
  assert.ok((data.response_chars as number) <= FORM_BUDGET, `${data.response_chars} chars`);
}

test("TW Core Bundle-twcore form with 5 planned entries", { skip: !TWC }, async () => {
  const deps = fileBlueprintDeps(TWC!)!;
  const plan = ["Patient-twcore", "Encounter-twcore", "Condition-twcore", "MedicationRequest-twcore", "Observation-laboratoryResult-twcore"].map((profile) => ({ profile }));
  const { data } = await bundleForm({ bundle_profile: "Bundle-twcore", entries: plan }, deps);
  check(data, 5);
  const entries = (data.bundle as R).entry as R[];
  const patient = entries.find((e) => e.resource.resourceType === "Patient")!.fullUrl;
  const withSubject = entries.filter((x) => x.resource.subject);
  assert.ok(withSubject.length >= 3, "Condition / MedicationRequest / Observation require a subject");
  for (const e of withSubject) assert.equal(e.resource.subject.reference, patient, `${e.resource.resourceType}.subject -> the Patient entry`);
});

test("TWPAS Bundle-twpas / Bundle-immunologic-agent-twpas forms hold every required slice", { skip: !PAS }, async () => {
  const deps = fileBlueprintDeps(PAS!)!;
  for (const b of ["Bundle-twpas", "Bundle-immunologic-agent-twpas"]) {
    const { data } = await bundleForm({ bundle_profile: b, package_id: "tw.gov.mohw.nhi.pas", version: "1.2.7" }, deps);
    check(data, 8);
    const claim = ((data.bundle as R).entry as R[])[0].resource;
    assert.equal(claim.resourceType, "Claim");
    const urls = new Set(((data.bundle as R).entry as R[]).map((e) => e.fullUrl));
    assert.ok(urls.has(claim.patient.reference) && urls.has(claim.extension[0].valueReference.reference), "Claim references wired, also inside the extension");
  }
});
