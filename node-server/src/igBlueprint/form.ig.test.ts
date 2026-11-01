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

const EMPD = availableClosure(["tw.gov.mohw.nhi.empd#0.2.1", "tw.gov.mohw.twcore#0.3.2", "hl7.fhir.uv.extensions.r4#5.3.0", "hl7.terminology.r4#7.4.0", "hl7.fhir.r4.core#4.0.1"]);

test("v1.1: EMPD Bundle-EMPD / Bundle-DS — no example clinic / identifier prefilled, self-check clean", { skip: !EMPD }, async () => {
  const deps = fileBlueprintDeps(EMPD!)!;
  for (const b of ["Bundle-EMPD", "Bundle-DS"]) {
    const { data } = await bundleForm({ bundle_profile: b }, deps);
    check(data, 8);
    const text = JSON.stringify(data);
    for (const v of ["洪文武診所", "02-29765731", "集美街", "http://ns.electronichealth.net.au/id/hi/hpio/1.0", "3531020884"]) assert.ok(!text.includes(v), `${b}: ${v} not in the form`);
    assert.deepEqual(data.self_check, { ok: true }, `${b}: ${JSON.stringify(data.self_check)}`);
  }
});

test("v1.2: EMPD Bundle-EMPD — pat-id-1 choose_one, empd-ord-1 / enc-nhi-1 required_if, empd-medreq-3 format", { skip: !EMPD }, async () => {
  const deps = fileBlueprintDeps(EMPD!)!;
  const { data } = await bundleForm({ bundle_profile: "Bundle-EMPD" }, deps);
  check(data, 8);
  const entries = (data.bundle as R).entry as R[];
  const ph = data.placeholders as FormPlaceholder[];
  const idx = (rt: string): number => entries.findIndex((e) => e.resource.resourceType === rt);
  const rules = (key: string): FormPlaceholder[] => ph.filter((p) => p.choose_one?.rule.key === key || p.required_if?.rule.key === key || p.format_rule?.key === key);
  // pat-id-1: one identifier slice of the three the rule admits
  const pat = entries[idx("Patient")].resource;
  const typed = (pat.identifier as R[]).filter((x) => ["NNxxx", "PPN", "PRC"].includes(x.type?.coding?.[0]?.code));
  assert.equal(typed.length, 1, "exactly one option placed");
  const co = rules("pat-id-1").find((p) => p.choose_one)!;
  assert.ok(co, "choose_one on the option's placeholder");
  assert.equal(co.choose_one!.options.length, 3);
  // empd-ord-1: dose / timing / route / supply duration, required only unless the order type is 3
  const ord = rules("empd-ord-1");
  assert.ok(ord.length >= 5, `${ord.length} empd-ord-1 placeholders`);
  for (const p of ord) assert.equal(p.required, false);
  // enc-nhi-1: the Encounter's visit sequence number, decided on the Bundle by the Coverage type
  const enc = rules("enc-nhi-1");
  assert.equal(enc.length, 1);
  assert.match(enc[0].pointer, new RegExp(`^/entry/${idx("Encounter")}/resource/identifier/\\d+/value$`));
  const when = typeof enc[0].required_if!.when === "string" ? (data.conditions as R)[enc[0].required_if!.when as unknown as string] : enc[0].required_if!.when;
  assert.equal(when.context, "");
  // empd-medreq-3: the material code's format
  assert.ok(rules("empd-medreq-3").some((p) => p.format && new RegExp(p.format).test("FBZ012345001")));
  assert.deepEqual(data.self_check, { ok: true });
  assert.ok((data.response_chars as number) <= FORM_BUDGET);
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
