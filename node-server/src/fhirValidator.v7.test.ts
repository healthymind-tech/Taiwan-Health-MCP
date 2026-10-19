/**
 * v7 (evaluation report v5 false negatives): extension context checking
 * (StructureDefinition.context / contextInvariant), "Unrecognized property" where
 * the profile walk does not descend, the HL7 "current version" choice between
 * copies of one canonical, and RxNorm code / display judgements. Behaviour
 * confirmed with validator_cli 7.0.1 + tx.fhir.org (scripts/validator-audit,
 * corpus v7 probes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceValidator, type Issue } from "./fhirValidator.js";
import { rankHl7Current } from "./fhirTerminology.js";
import { judgeRxnorm, rxnormStrict, RXNORM } from "./fhirExternalTerminology.js";
import { parseRxnormZip, rxnormReleaseFromNames } from "./loaders/rxnorm.js";
import { CORE, FakeResolver, SDS, VITAL, el, sd } from "./fhirTestKit.test.js";

const EXT = "http://example.tw/fhir/StructureDefinition/";

/** A simple extension definition with the given contexts (and optional context invariants). */
function extSd(id: string, context: Array<Record<string, any>>, extra: Record<string, any> = {}): Record<string, any> {
  return sd(EXT + id, "Extension", "complex-type", [
    el("Extension", 0, "*", [], { constraint: extra.rootConstraint ? [extra.rootConstraint] : [] }),
    el("Extension.id", 0, "1", ["string"]),
    el("Extension.extension", 0, "*", ["Extension"]),
    el("Extension.url", 1, "1", ["uri"], { fixedUri: EXT + id }),
    el("Extension.value[x]", 0, "1", ["string", "Expression"]),
  ], { context, version: "1.0.0", baseDefinition: CORE + "Extension", ...(extra.contextInvariant ? { contextInvariant: extra.contextInvariant } : {}) });
}

const EXTRA: Record<string, Record<string, any>> = {};
for (const s of [
  extSd("on-patient", [{ type: "element", expression: "Patient" }]),
  extSd("on-cc", [{ type: "element", expression: "CodeableConcept" }]),
  extSd("on-obs-code", [{ type: "element", expression: "Observation.code" }]),
  extSd("on-element", [{ type: "element", expression: "Element" }]),
  extSd("on-domainresource", [{ type: "element", expression: "DomainResource" }]),
  extSd("on-resource", [{ type: "element", expression: "Resource" }]),
  extSd("on-status", [{ type: "element", expression: "Observation.status" }]),
  extSd("on-value", [{ type: "element", expression: "Observation.value[x]" }]),
  extSd("on-ext", [{ type: "extension", expression: EXT + "on-element" }]),
  extSd("r5-only", [{ type: "element", expression: "Observation", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/version-specific-use", extension: [{ url: "startFhirVersion", valueCode: "5.0" }] }] }, { type: "element", expression: "Patient" }]),
  extSd("final-only", [{ type: "element", expression: "Observation" }], { contextInvariant: ["status = 'final'"] }),
  extSd("needs-name", [{ type: "element", expression: "Observation" }], {
    rootConstraint: { key: "nm-1", severity: "error", human: "must have a name", expression: "value.name.exists()" },
  }),
]) EXTRA[s.url] = s;
// Observation / DomainResource with the base chain the context fallback walks.
EXTRA[CORE + "Observation"] = { ...SDS[CORE + "Observation"], baseDefinition: CORE + "DomainResource" };
EXTRA[CORE + "DomainResource"] = sd(CORE + "DomainResource", "DomainResource", "resource", [el("DomainResource", 0, "*")], { baseDefinition: CORE + "Resource" });
EXTRA[CORE + "Expression"] = sd(CORE + "Expression", "Expression", "complex-type", [
  el("Expression", 0, "*"),
  el("Expression.name", 0, "1", ["id"]),
  el("Expression.language", 1, "1", ["code"]),
  el("Expression.expression", 0, "1", ["string"]),
]);

class ExtResolver extends FakeResolver {
  override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    return EXTRA[url.split("|")[0]] ?? super.fetchStructureDefinition(url);
  }
}

const run = (r: Record<string, any>): Promise<Issue[]> => new InstanceValidator(new ExtResolver()).validate(r);
const errs = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal");
const ctxErrs = (issues: Issue[]): Issue[] => errs(issues).filter((i) => /is not allowed to be used at this point/.test(i.message));

const obs = (extra: Record<string, any> = {}): Record<string, any> => ({
  resourceType: "Observation",
  status: "final",
  code: { coding: [{ system: "http://loinc.org", code: "1-8" }] },
  ...extra,
});
const ext = (id: string, value: Record<string, any> = { valueString: "x" }): Record<string, any> => ({ url: EXT + id, ...value });

// ---- 1. extension context ----------------------------------------------------------

test("extension context: an element context naming another resource type is an error at the host", async () => {
  const issues = await run(obs({ extension: [ext("on-patient")] }));
  const e = ctxErrs(issues);
  assert.equal(e.length, 1, JSON.stringify(issues));
  assert.equal(e[0].path, "Observation");
  assert.equal(
    e[0].message,
    `The extension ${EXT}on-patient v1.0.0 is not allowed to be used at this point (this element is [Observation]; allowed for this version = e:Patient)`,
  );
  assert.deepEqual(ctxErrs(await run({ resourceType: "Patient", extension: [ext("on-patient")] })), []);
});

test("extension context: datatype / path / Element contexts follow the host's logical paths", async () => {
  // On Observation.code: CodeableConcept and Observation.code are fine, Patient is not.
  for (const ok of ["on-cc", "on-obs-code", "on-element"]) {
    const r = obs();
    r.code.extension = [ext(ok)];
    assert.deepEqual(ctxErrs(await run(r)), [], ok);
  }
  const bad = obs();
  bad.code.extension = [ext("on-patient")];
  const e = ctxErrs(await run(bad));
  assert.equal(e.length, 1);
  assert.equal(e[0].path, "Observation.code");
  assert.match(e[0].message, /this element is \[CodeableConcept, Observation\.code\]/);
  // A Coding below it: [CodeableConcept.coding, Coding, Observation.code.coding] (validator_cli wording).
  const deep = obs();
  deep.code.coding[0].extension = [ext("on-patient")];
  assert.match(ctxErrs(await run(deep))[0].message, /this element is \[CodeableConcept\.coding, Coding, Observation\.code\.coding\]/);
});

test("extension context: primitive hosts (_status) and choice contexts (value[x])", async () => {
  assert.deepEqual(ctxErrs(await run(obs({ _status: { extension: [ext("on-status")] } }))), []);
  const e = ctxErrs(await run(obs({ _status: { extension: [ext("on-cc")] } })));
  assert.equal(e.length, 1);
  assert.equal(e[0].path, "Observation.status");
  assert.match(e[0].message, /this element is \[Observation\.status, code\]/);
  assert.deepEqual(ctxErrs(await run(obs({ valueQuantity: { value: 1, extension: [ext("on-value")] } }))), []);
});

test("extension context: Resource / DomainResource contexts (type hierarchy) only on a resource root", async () => {
  assert.deepEqual(ctxErrs(await run(obs({ extension: [ext("on-resource")] }))), []);
  assert.deepEqual(ctxErrs(await run(obs({ extension: [ext("on-domainresource")] }))), []);
  const r = obs();
  r.code.extension = [ext("on-resource")];
  assert.equal(ctxErrs(await run(r)).length, 1);
});

test("extension context: extension-type contexts, contexts for other FHIR versions, context invariants", async () => {
  // Sub-extension allowed only inside extension on-element.
  assert.deepEqual(ctxErrs(await run(obs({ extension: [{ url: EXT + "on-element", extension: [ext("on-ext")] }] }))), []);
  assert.equal(ctxErrs(await run(obs({ extension: [ext("on-ext")] }))).length, 1);
  // The R5-only context is skipped: Observation is not allowed in R4, Patient is.
  const v = ctxErrs(await run(obs({ extension: [ext("r5-only")] })));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /allowed for this version = e:Patient\)$/);
  // contextInvariant evaluated on the host.
  assert.deepEqual(ctxErrs(await run(obs({ extension: [ext("final-only")] }))), []);
  const inv = ctxErrs(await run(obs({ status: "preliminary", extension: [ext("final-only")] })));
  assert.equal(inv.length, 1);
  assert.match(inv[0].message, /based on context invariant 'status = 'final''/);
});

test("extension context: inside a Bundle the host path is the entry resource", async () => {
  const b = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:uuid:7d3c0a4e-0000-4000-8000-000000000001", resource: obs({ extension: [ext("on-patient")] }) }] };
  const e = ctxErrs(await run(b));
  assert.equal(e.length, 1);
  assert.equal(e[0].path, "Bundle.entry[0].resource");
});

test("the extension's own invariants run (var-1 style: value.name.exists())", async () => {
  const bad = errs(await run(obs({ extension: [ext("needs-name", { valueExpression: { language: "text/fhirpath", expression: "1" } })] })));
  assert.ok(bad.some((i) => i.path === "Observation.extension[0]" && /nm-1/.test(i.message)), JSON.stringify(bad));
  const ok = errs(await run(obs({ extension: [ext("needs-name", { valueExpression: { name: "a", language: "text/fhirpath", expression: "1" } })] })));
  assert.deepEqual(ok.filter((i) => /nm-1|not allowed/.test(i.message)), []);
});

// ---- 2. unrecognized properties ------------------------------------------------------

const unknownAt = (issues: Issue[]): string[] => errs(issues).filter((i) => /^Unrecognized property/.test(i.message)).map((i) => `${i.path}: ${i.message}`);

test("Unrecognized property below a choice type the profile does not allow (HL7 parser runs on core definitions)", async () => {
  const r = {
    resourceType: "Observation",
    meta: { profile: [VITAL] },
    status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
    code: { coding: [{ system: "http://loinc.org", code: "29463-7" }] },
    valueCodeableConcept: { coding: [{ system: "http://loinc.org", code: "x", slice: "loinc" }] },
  };
  assert.deepEqual(unknownAt(await run(r)), ["Observation.valueCodeableConcept.coding[0]: Unrecognized property 'slice'"]);
});

test("Unrecognized property inside an unknown extension's value and inside a primitive's extension object", async () => {
  const r = obs({ extension: [{ url: "http://example.tw/fhir/StructureDefinition/nope", valueCodeableConcept: { coding: [{ code: "a", slice: "x" }] } }] });
  assert.ok(unknownAt(await run(r)).includes("Observation.extension[0].valueCodeableConcept.coding[0]: Unrecognized property 'slice'"));
  const p = obs();
  p.code.coding[0]._code = { slice: "x" };
  assert.deepEqual(unknownAt(await run(p)), ["Observation.code.coding[0].code: Unrecognized property 'slice'"]);
});

test("like the HL7 parser, no descent into a wrong-shaped value (array for a single element) or a second choice value", async () => {
  const arr = await run(obs({ code: [{ coding: [{ system: "http://loinc.org", code: "1-8", slice: "x" }] }] }));
  assert.ok(errs(arr).some((i) => /must be a simple value, not an Array/.test(i.message)));
  assert.deepEqual(unknownAt(arr), []);
  const two = await run(obs({ valueString: "a", valueQuantity: { value: 1, slice: "x" } }));
  assert.deepEqual(unknownAt(two), ["Observation: Unrecognized property 'valueQuantity'"]);
});

test("Unrecognized property is reported once (profile walk + structural pass dedupe)", async () => {
  const r = obs();
  r.code.coding[0].slice = "x";
  assert.deepEqual(unknownAt(await run(r)), ["Observation.code.coding[0]: Unrecognized property 'slice'"]);
});

// ---- HL7 current version of a canonical ------------------------------------------------

test("rankHl7Current: highest major.minor wins (extensions pack over R4 core), ties keep closure order", () => {
  const row = (packageId: string, version: string | null, ord: number, fhirVersion = "4.0.1") => ({ packageId, packageVersion: "x", fhirVersion, ord, version });
  const url = "http://hl7.org/fhir/StructureDefinition/variable";
  const core = row("hl7.fhir.r4.core", "4.0.1", 4);
  const extp = row("hl7.fhir.uv.extensions.r4", "5.2.0", 6);
  const r5 = row("hl7.fhir.uv.extensions", "5.3.0", 7, "5.0.0");
  assert.equal(rankHl7Current(url, [core, extp, r5])[0], extp);
  const ig = row("tw.gov.mohw.twcore", "1.0.0", 1);
  const dep = row("other", "1.0.3", 2);
  assert.equal(rankHl7Current("http://x/SD/a", [dep, ig])[0], ig); // same 1.0 line: closure order
  assert.equal(rankHl7Current("http://x/SD/a", [row("a", null, 1), row("b", "0.1.0", 2)])[0].packageId, "b");
  // terminology.hl7.org canonicals keep the THO rule (newest hl7.terminology first).
  const tho = "http://terminology.hl7.org/StructureDefinition/ext";
  const t1 = { ...row("hl7.terminology.r4", "1.0.0", 5), packageVersion: "7.0.0" };
  const c1 = row("hl7.fhir.r4.core", "4.0.1", 4);
  assert.equal(rankHl7Current(tho, [c1, t1])[0], t1);
});

// ---- 5. RxNorm -------------------------------------------------------------------------

test("judgeRxnorm: wrong display (tx.fhir.org wording), case-insensitive, any RXNORM atom accepted", () => {
  const row = { name: "thyroglobulin 100 MG Oral Tablet", altNames: ["Thyroid 100 MG Oral Tablet"] };
  const bad = judgeRxnorm("313375", "Clopidogrel 75 MG Oral Tablet", row, false, "06032024");
  assert.equal(bad.status, "invalid-display");
  assert.equal(bad.status === "invalid-display" && bad.severity, "error");
  assert.equal(
    bad.status === "invalid-display" && bad.message,
    `Wrong Display Name 'Clopidogrel 75 MG Oral Tablet' for ${RXNORM}#313375. Valid display is 'thyroglobulin 100 MG Oral Tablet' (for the language(s) 'en')`,
  );
  assert.equal(judgeRxnorm("313375", "THYROGLOBULIN 100 mg oral tablet", row, false, null).status, "ok");
  assert.equal(judgeRxnorm("313375", "thyroid 100 MG Oral Tablet", row, false, null).status, "ok");
  assert.equal(judgeRxnorm("313375", null, row, false, null).status, "ok");
});

test("judgeRxnorm: only the preferred name held → mismatch is a warning; unknown RXCUI strict only for a current release", () => {
  const w = judgeRxnorm("213169", "Plavix 75 MG Oral Tablet", { name: "clopidogrel 75 MG Oral Tablet [Plavix]", altNames: null }, false, null);
  assert.equal(w.status === "invalid-display" && w.severity, "warning");
  const u = judgeRxnorm("99999999", "x", null, false, "06032024");
  assert.equal(u.status === "invalid-code" && u.severity, "warning");
  const s = judgeRxnorm("99999999", "x", null, true, "03022026");
  assert.equal(s.status === "invalid-code" && s.message, `Unknown code '99999999' in the CodeSystem '${RXNORM}' version '03022026'`);
  assert.equal(rxnormStrict({ releaseDate: "2024-06-03" }), false);
  assert.equal(rxnormStrict({ releaseDate: "2026-03-02" }), true);
  assert.equal(rxnormStrict(null), false);
});

test("RxNorm loader keeps every SAB=RXNORM atom string and the release", () => {
  const line = (cui: string, pref: string, sab: string, tty: string, str: string, sup = "N"): string =>
    [cui, "ENG", "", "", "", "", pref, "", "", "", "", sab, tty, cui, str, "", sup, "", ""].join("|");
  const rrf = [
    line("213169", "Y", "RXNORM", "SBD", "clopidogrel 75 MG Oral Tablet [Plavix]"),
    line("213169", "N", "RXNORM", "PSN", "Plavix 75 MG Oral Tablet"),
    line("213169", "N", "RXNORM", "SY", "Plavix 75 MG Oral Tablet"),
    line("213169", "N", "MTHSPL", "SU", "PLAVIX tablet"),
    line("1191", "Y", "RXNORM", "IN", "aspirin"),
  ].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "rxn-"));
  const zip = join(dir, "upload.zip");
  writeFileSync(zip, zipSync({ "Readme_full_06032024.txt": strToU8("x"), "rrf/RXNCONSO.RRF": strToU8(rrf + "\n") }));
  const { rows, release } = parseRxnormZip(zip);
  assert.deepEqual(release, { version: "06032024", releaseDate: "2024-06-03" });
  const plavix = rows.find((r) => r[0] === 213169)!;
  assert.equal(plavix[1], "clopidogrel 75 MG Oral Tablet [Plavix]");
  assert.deepEqual(plavix[4], ["Plavix 75 MG Oral Tablet"]);
  assert.deepEqual(rows.find((r) => r[0] === 1191)![4], []);
  assert.deepEqual(rxnormReleaseFromNames(["/x/RxNorm_full_03022026.zip"]), { version: "03022026", releaseDate: "2026-03-02" });
  assert.equal(rxnormReleaseFromNames(["foo.zip"]), null);
});
