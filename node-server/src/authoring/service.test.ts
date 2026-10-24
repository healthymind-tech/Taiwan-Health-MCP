/**
 * Authoring service + tool specs (workstream C) against a fake composer and fake validators.
 * The Bundle finalizer is the real engine (fhirBundleFinalize.ts, no StructureDefinition
 * lookups), so determinism / document ordering are tested for real.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeBundle } from "../fhirBundleFinalize.js";
import { createAssembleTool } from "./assembleTool.js";
import { createAuthorTool } from "./authorTool.js";
import { MemoryContextStore } from "./contextStore.js";
import { createContextTool } from "./contextTools.js";
import { AssembleRefusedError, AuthoringService, defaultKeyToUrn, fieldForPath, type AuthoringDeps, type ComposeOutput, type Composer } from "./service.js";
import type { AuthorInput, Provenance } from "./types.js";

// ---- fakes ----------------------------------------------------------------- //

const TYPE_OF: Record<string, string> = {
  "Patient-twcore": "Patient",
  "Encounter-twcore": "Encounter",
  "Condition-twcore": "Condition",
  "Observation-vitalsigns-twcore": "Observation",
  "Composition-twcore": "Composition",
  Practitioner: "Practitioner",
};

/** Field values → resource: {ref} → urn (resolved / pending by knownKeys), everything else copied. */
export function fakeComposer(keyToUrn = defaultKeyToUrn): Composer {
  return async (input: AuthorInput, ctx): Promise<ComposeOutput> => {
    const rt = TYPE_OF[input.profile];
    if (!rt) throw new Error(`profile not found: ${input.profile}`);
    const resource: Record<string, unknown> = { resourceType: rt, meta: { profile: [`http://example.org/StructureDefinition/${input.profile}`] } };
    const provenance: Record<string, Provenance> = { [`${rt}.meta.profile`]: "fixed" };
    const fieldMap: Record<string, string> = {};
    const resolved = new Set<string>();
    const pending = new Set<string>();
    const errors: ComposeOutput["errors"] = [];
    const known = new Set(ctx.knownKeys);
    const conv = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(conv);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.ref === "string") {
          (known.has(o.ref) ? resolved : pending).add(o.ref);
          return { reference: keyToUrn(ctx.contextId, o.ref) };
        }
        return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, conv(x)]));
      }
      return v;
    };
    for (const [field, value] of Object.entries(input.fields)) {
      if (field === "bogusField") {
        errors.push({ field, path: `${rt}.bogusField`, message: "unknown field for this profile" });
        continue;
      }
      resource[field] = conv(value);
      provenance[`${rt}.${field}`] = "model";
      fieldMap[`${rt}.${field}`] = field;
    }
    const missing: ComposeOutput["missing"] = [];
    if (rt === "Observation" && !("code" in input.fields)) missing.push({ field: "code", why: "required by profile" });
    return { resource, provenance, missing, refs: { resolved: [...resolved], pending: [...pending] }, fieldMap, errors };
  };
}

/** status "bogus" is an unknown code; a Reference-shaped warning is emitted to check the context-ref filter. */
const fakeValidate: AuthoringDeps["validate"] = async (resource, profile) => {
  if (profile === "Nowhere") return { ok: false, data: null, error: { code: "ARTIFACT_NOT_FOUND", message: "profile not found: Nowhere" } };
  const rt = String(resource.resourceType);
  const issues: Array<Record<string, unknown>> = [];
  if (resource.status === "bogus") {
    issues.push({ severity: "error", path: `${rt}.status`, code: "code-invalid", message: "Unknown code 'bogus' in the CodeSystem 'http://hl7.org/fhir/observation-status'", suggestions: [{ value: "final", kind: "replace_code", confidence: 0.9, reason: "closest" }] });
  }
  const subj = resource.subject as { reference?: string } | undefined;
  if (subj?.reference) issues.push({ severity: "warning", path: `${rt}.subject`, code: "not-found", message: `URN reference is not locally contained within the bundle ${subj.reference}` });
  if (rt === "Observation" && !resource.code) issues.push({ severity: "error", path: `${rt}.code`, code: "required", message: "Observation.code: minimum required = 1, but only found 0" });
  return { ok: true, data: { valid: !issues.some((i) => i.severity === "error"), issues, profile, checked_fully: true }, provenance: { packageId: "fake", version: "1" } };
};

const fakeFinalize: AuthoringDeps["finalizeBundle"] = async (bundle, o) => {
  const fin = await finalizeBundle(bundle, null, { bundleType: o.bundleType, bundleProfile: o.bundleProfile });
  return { ok: true, data: { bundle: fin.bundle, changes: fin.changes, unresolved: fin.unresolved, notes: fin.notes, id_map: fin.id_map }, warnings: [] };
};

const fakeValidateBundle: AuthoringDeps["validateBundle"] = async (bundle, o) => {
  const issues: Array<Record<string, unknown>> = [];
  const entries = (bundle.entry as Array<{ fullUrl: string; resource: Record<string, unknown> }>) ?? [];
  const urls = new Set(entries.map((e) => e.fullUrl));
  entries.forEach((e, i) => {
    if (e.resource.status === "bogus") issues.push({ severity: "error", path: `Bundle.entry[${i}].resource.status`, message: "Unknown code 'bogus'" });
    const walk = (v: unknown, p: string): void => {
      if (Array.isArray(v)) v.forEach((x, j) => walk(x, `${p}[${j}]`));
      else if (v && typeof v === "object") {
        const ref = (v as { reference?: unknown }).reference;
        if (typeof ref === "string" && !urls.has(ref)) issues.push({ severity: "error", path: p, message: `Can't find '${ref}' in the bundle` });
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${p}.${k}`);
      }
    };
    walk(e.resource, `Bundle.entry[${i}].resource`);
  });
  if (bundle.type === "document" && entries[0]?.resource.resourceType !== "Composition") issues.push({ severity: "error", path: "Bundle.entry[0]", message: "The first entry in a document must be a composition" });
  const data: Record<string, unknown> = { valid: !issues.some((i) => i.severity === "error"), issues, checked_fully: true };
  if (o.sourceText) data.grounding = { mode: "auto", sourceSha256: "fake" };
  return { ok: true, data: data as never, warnings: [], provenance: { packageId: "fake", version: "1" } };
};

function makeService(overrides: Partial<AuthoringDeps> = {}): AuthoringService {
  return new AuthoringService({
    store: new MemoryContextStore(),
    compose: fakeComposer(),
    keyToUrn: defaultKeyToUrn,
    validate: fakeValidate,
    finalizeBundle: fakeFinalize,
    validateBundle: fakeValidateBundle,
    compositionRequirements: async ({ bundleProfile }) => ({
      profile: bundleProfile ? "Composition-twcore" : "http://hl7.org/fhir/StructureDefinition/Composition",
      fields: [
        { field: "status", why: "required by profile" },
        { field: "type", why: "required by profile" },
        { field: "subject", why: "required by profile" },
        { field: "date", why: "required by profile" },
        { field: "author", why: "required by profile" },
        { field: "title", why: "required by profile" },
      ],
    }),
    ...overrides,
  });
}

const patient: AuthorInput = { key: "patient-1", profile: "Patient-twcore", fields: { identifier: { value: "A123456789" }, gender: "male", birthDate: "1991-03-15" } };
const encounter: AuthorInput = { key: "enc-1", profile: "Encounter-twcore", fields: { status: "finished", subject: { ref: "patient-1" }, diagnosis: [{ condition: { ref: "cond-1" } }] } };
const condition: AuthorInput = { key: "cond-1", profile: "Condition-twcore", fields: { code: { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9" }, subject: { ref: "patient-1" }, encounter: { ref: "enc-1" } } };
const obs = (n: number): AuthorInput => ({ key: `obs-${n}`, profile: "Observation-vitalsigns-twcore", fields: { status: "final", code: { system: "http://loinc.org", code: "8480-6" }, subject: { ref: "patient-1" }, value: { value: 120 + n, unit: "mmHg" } } });

// ---- author ------------------------------------------------------------------ //

test("author: a batch of 8 in one call creates the context and returns full resources, provenance, refs, summary (R8, R9)", async () => {
  const svc = makeService();
  const r = await svc.authorResources(undefined, [patient, encounter, condition, obs(1), obs(2), obs(3), obs(4), obs(5)]);
  assert.match(r.context_id, /^[0-9a-f]{32}$/);
  assert.equal(r.storage, "memory");
  assert.equal(r.results.length, 8);
  assert.deepEqual(r.summary, { total: 8, valid: 8, invalid: 0, refs_pending: 0, pending_keys: [] });
  const enc = r.results.find((x) => x.key === "enc-1")!;
  assert.equal(enc.status, "valid");
  assert.deepEqual(enc.refs, { resolved: ["cond-1", "patient-1"], pending: [] });
  assert.equal((enc.resource.subject as { reference: string }).reference, defaultKeyToUrn(r.context_id, "patient-1"));
  assert.equal(enc.provenance["Encounter.meta.profile"], "fixed");
  assert.equal(enc.provenance["Encounter.status"], "model");
  // The fake validator's "URN reference is not locally contained" warning is about a context key: filtered.
  assert.deepEqual(enc.issues, []);
  // Stored: list shows all 8.
  assert.equal((await svc.listEntries(r.context_id)).length, 8);
});

test("author: cyclic references across two calls — refs_pending first, resolved once the other key exists, assembled OK", async () => {
  const svc = makeService();
  const a = await svc.authorResources(undefined, [patient, condition]);
  const cond = a.results.find((x) => x.key === "cond-1")!;
  assert.equal(cond.status, "refs_pending");
  assert.deepEqual(cond.refs, { resolved: ["patient-1"], pending: ["enc-1"] });
  assert.deepEqual(a.summary.pending_keys, ["enc-1"]);
  const b = await svc.authorResources(a.context_id, [encounter]);
  assert.equal(b.results[0].status, "valid"); // cond-1 is known now
  // The stored cond-1 is reported resolved now (its pending key exists in the context).
  const list = await svc.listEntries(a.context_id);
  assert.equal(list.find((e) => e.key === "cond-1")!.status, "valid");
  assert.deepEqual((await svc.getEntry(a.context_id, "cond-1"))!.refs, { resolved: ["enc-1", "patient-1"], pending: [] });
  const asm = await svc.assembleBundle(a.context_id, ["patient-1", "enc-1", "cond-1"], "collection");
  assert.equal(asm.validation.valid, true, JSON.stringify(asm.validation.issues));
  assert.deepEqual(asm.keys, ["patient-1", "enc-1", "cond-1"]);
  const entries = asm.bundle.entry as Array<{ fullUrl: string; resource: Record<string, any> }>;
  assert.equal(entries[1].resource.diagnosis[0].condition.reference, entries[2].fullUrl);
  assert.equal(entries[2].resource.encounter.reference, entries[1].fullUrl);
  assert.deepEqual(asm.unresolved, []);
  assert.deepEqual(asm.changes, [], "stored urns are already final: the finalizer changes nothing");
});

test("author: invalid result carries key + field + path + suggestions; merge resends only the changed field and keeps the rest (R7)", async () => {
  const svc = makeService();
  const a = await svc.authorResources(undefined, [patient, { ...obs(1), fields: { ...obs(1).fields, status: "bogus" } }]);
  const o = a.results.find((x) => x.key === "obs-1")!;
  assert.equal(o.status, "invalid");
  assert.equal(o.issues.length, 1);
  assert.deepEqual({ key: o.issues[0].key, field: o.issues[0].field, path: o.issues[0].path, severity: o.issues[0].severity }, { key: "obs-1", field: "status", path: "Observation.status", severity: "error" });
  assert.equal((o.issues[0].suggestions as Array<{ value: string }>)[0].value, "final");
  const b = await svc.authorResources(a.context_id, [{ key: "obs-1", profile: "", merge: true, fields: { status: "final" } }]);
  const fixed = b.results[0];
  assert.equal(fixed.status, "valid");
  assert.equal(fixed.resource.status, "final");
  assert.deepEqual(fixed.resource.code, { system: "http://loinc.org", code: "8480-6" }, "untouched fields kept");
  assert.equal((fixed.resource.subject as { reference: string }).reference, defaultKeyToUrn(a.context_id, "patient-1"));
  // null removes a field
  const c = await svc.authorResources(a.context_id, [{ key: "obs-1", profile: "", merge: true, fields: { value: null } }]);
  assert.equal("value" in c.results[0].resource, false);
});

test("author: missing values are reported, never invented; composer errors and unknown profiles become issues, not a failed call", async () => {
  const svc = makeService();
  const r = await svc.authorResources(undefined, [
    { key: "obs-x", profile: "Observation-vitalsigns-twcore", fields: { status: "final", subject: { ref: "patient-1" } } },
    { key: "p-2", profile: "Patient-twcore", fields: { gender: "male", bogusField: 1 } },
    { key: "nowhere", profile: "Nowhere", fields: {} },
  ]);
  const ox = r.results[0];
  assert.deepEqual(ox.missing, [{ field: "code", why: "required by profile" }]);
  assert.equal(ox.status, "invalid");
  assert.equal(ox.refs.pending[0], "patient-1");
  const p2 = r.results[1];
  assert.equal(p2.status, "invalid");
  assert.deepEqual({ field: p2.issues[0].field, path: p2.issues[0].path }, { field: "bogusField", path: "Patient.bogusField" });
  const nw = r.results[2];
  assert.equal(nw.status, "invalid");
  assert.equal(nw.issues[0].severity, "fatal");
  assert.match(nw.issues[0].message, /profile not found: Nowhere/);
  assert.deepEqual(r.summary.pending_keys, ["patient-1"]);
});

test("author: argument errors — duplicate key, missing profile, too many", async () => {
  const svc = makeService();
  await assert.rejects(svc.authorResources(undefined, [patient, patient]), /duplicate key/);
  await assert.rejects(svc.authorResources(undefined, [{ key: "x", profile: "", fields: {} }]), /profile is required/);
  await assert.rejects(svc.authorResources(undefined, Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, profile: "Patient-twcore", fields: {} }))), /at most 50/);
});

test("fieldForPath maps validator paths to model fields through the field map, ancestors and indexes included", () => {
  const fm = { "Observation.component": "component", "Observation.valueQuantity": "value", "Observation.code.coding": "code" };
  const fields = { status: "final", component: [], value: 1, code: {}, "identifier:mrn": {} };
  assert.equal(fieldForPath("Observation.component[0].valueQuantity.code", fm, fields, "Observation"), "component");
  assert.equal(fieldForPath("Observation.valueQuantity", fm, fields, "Observation"), "value");
  assert.equal(fieldForPath("Observation.code.coding[0].system", fm, fields, "Observation"), "code");
  assert.equal(fieldForPath("Observation.status", {}, fields, "Observation"), "status");
  assert.equal(fieldForPath("Observation.identifier[0].value", {}, fields, "Observation"), "identifier:mrn");
  assert.equal(fieldForPath("Observation.nothing", {}, fields, "Observation"), null);
  assert.equal(fieldForPath("Observation", fm, fields, "Observation"), null);
});

// ---- assemble ------------------------------------------------------------- //

async function filled(svc: AuthoringService): Promise<string> {
  const r = await svc.authorResources(undefined, [patient, encounter, condition, obs(1), obs(2), obs(3), obs(4), obs(5)]);
  return r.context_id;
}

test("assemble: same context + same keys → byte-identical Bundle; another context → different fullUrls (R6)", async () => {
  const svc = makeService();
  const cid = await filled(svc);
  const keys = ["patient-1", "enc-1", "cond-1", "obs-1", "obs-2", "obs-3", "obs-4", "obs-5"];
  const a = await svc.assembleBundle(cid, keys, "transaction");
  const b = await svc.assembleBundle(cid, keys, "transaction");
  assert.equal(JSON.stringify(a.bundle), JSON.stringify(b.bundle));
  assert.equal(a.validation.valid, true);
  const e = a.bundle.entry as Array<Record<string, any>>;
  assert.equal(e.length, 8);
  assert.deepEqual(e[0].request, { method: "POST", url: "Patient" });
  assert.equal(e[0].fullUrl, defaultKeyToUrn(cid, "patient-1"));
  const cid2 = await filled(svc);
  const c = await svc.assembleBundle(cid2, keys, "transaction");
  assert.notEqual((c.bundle.entry as Array<Record<string, any>>)[0].fullUrl, e[0].fullUrl);
  // Order follows keys.
  const d = await svc.assembleBundle(cid, [...keys].reverse(), "collection");
  assert.deepEqual(d.keys, [...keys].reverse());
  assert.equal((d.bundle.entry as Array<Record<string, any>>)[0].request, undefined);
});

test("assemble: refusals — unknown key, reference to a key outside the list / context, invalid resource (fields listed), allow_invalid", async () => {
  const svc = makeService();
  const cid = await filled(svc);
  await assert.rejects(svc.assembleBundle(cid, ["patient-1", "ghost"], "collection"), (e: unknown) => {
    assert.ok(e instanceof AssembleRefusedError);
    assert.equal(e.refusal.code, "KEY_NOT_FOUND");
    assert.equal(e.refusal.refused[0].key, "ghost");
    return true;
  });
  // cond-1 references enc-1 (stored, not listed) and patient-1 (listed).
  await assert.rejects(svc.assembleBundle(cid, ["patient-1", "cond-1"], "collection"), (e: unknown) => {
    assert.ok(e instanceof AssembleRefusedError);
    assert.equal(e.refusal.code, "UNRESOLVED_REFERENCE");
    assert.deepEqual(
      e.refusal.refused.map((r) => [r.key, r.field, r.ref_key]),
      [["cond-1", "encounter", "enc-1"]],
    );
    assert.match(e.refusal.refused[0].reason, /not in keys/);
    return true;
  });
  // A reference to a key that was never authored.
  await svc.authorResources(cid, [{ key: "obs-9", profile: "Observation-vitalsigns-twcore", fields: { status: "final", code: { system: "http://loinc.org", code: "x" }, subject: { ref: "nobody" } } }]);
  await assert.rejects(svc.assembleBundle(cid, ["obs-9"], "collection"), (e: unknown) => {
    assert.ok(e instanceof AssembleRefusedError && e.refusal.code === "UNRESOLVED_REFERENCE");
    assert.equal(e.refusal.refused[0].ref_key, "nobody");
    assert.match(e.refusal.refused[0].reason, /not in the context/);
    return true;
  });
  // Invalid resource: refused with key + field; allow_invalid builds anyway and reports the issue with key + field.
  await svc.authorResources(cid, [{ key: "obs-1", profile: "", merge: true, fields: { status: "bogus" } }]);
  await assert.rejects(svc.assembleBundle(cid, ["patient-1", "obs-1"], "collection"), (e: unknown) => {
    assert.ok(e instanceof AssembleRefusedError && e.refusal.code === "INVALID_RESOURCE");
    assert.deepEqual(e.refusal.refused.map((r) => [r.key, r.field]), [["obs-1", "status"]]);
    return true;
  });
  const forced = await svc.assembleBundle(cid, ["patient-1", "obs-1"], "collection", { allowInvalid: true });
  assert.deepEqual(forced.included_invalid, ["obs-1"]);
  assert.equal(forced.validation.valid, false);
  const iss = forced.validation.issues.find((i) => String(i.path).endsWith(".status"))!;
  assert.deepEqual({ key: iss.key, field: iss.field }, { key: "obs-1", field: "status" });
});

test("assemble: document without a Composition → MISSING_COMPOSITION with the fields it needs, never invented (R3)", async () => {
  const svc = makeService();
  const cid = await filled(svc);
  await assert.rejects(svc.assembleBundle(cid, ["patient-1", "enc-1", "cond-1"], "document", { bundleProfile: "Bundle-twcore" }), (e: unknown) => {
    assert.ok(e instanceof AssembleRefusedError && e.refusal.code === "MISSING_COMPOSITION");
    assert.equal(e.refusal.missing.resourceType, "Composition");
    assert.equal(e.refusal.missing.profile, "Composition-twcore");
    assert.deepEqual(
      e.refusal.missing.fields.map((f) => f.field),
      ["status", "type", "subject", "date", "author", "title"],
    );
    return true;
  });
  // With a Composition (listed last on purpose): the finalizer moves it first.
  await svc.authorResources(cid, [
    {
      key: "comp-1",
      profile: "Composition-twcore",
      fields: { status: "final", type: { system: "http://loinc.org", code: "11503-0" }, subject: { ref: "patient-1" }, date: "2026-06-15", title: "門診紀錄", section: [{ entry: [{ ref: "cond-1" }, { ref: "enc-1" }] }] },
    },
  ]);
  const asm = await svc.assembleBundle(cid, ["patient-1", "enc-1", "cond-1", "comp-1"], "document");
  assert.equal(asm.bundle.type, "document");
  assert.deepEqual(asm.keys, ["comp-1", "patient-1", "enc-1", "cond-1"]);
  assert.ok(asm.changes.some((c) => c.rule === "document-order"));
  assert.equal(asm.validation.valid, true, JSON.stringify(asm.validation.issues));
  const again = await svc.assembleBundle(cid, ["patient-1", "enc-1", "cond-1", "comp-1"], "document");
  assert.equal(JSON.stringify(again.bundle), JSON.stringify(asm.bundle));
});

test("assemble: source_text reaches the bundle validator (grounding) and is never part of the result besides the grounding block", async () => {
  const svc = makeService();
  const cid = await filled(svc);
  const asm = await svc.assembleBundle(cid, ["patient-1", "enc-1", "cond-1"], "collection", { sourceText: "病人主訴…" });
  assert.deepEqual(asm.validation.grounding, { mode: "auto", sourceSha256: "fake" });
  assert.equal(JSON.stringify(asm).includes("病人主訴"), false);
});

// ---- tools ---------------------------------------------------------------- //

test("tools: the whole flow through the tool handlers, incl. CONTEXT_EXPIRED / INVALID_ARGUMENT envelopes", async () => {
  const svc = makeService();
  const author = createAuthorTool(svc);
  const context = createContextTool(svc);
  const assemble = createAssembleTool(svc);
  for (const t of [author, context, assemble]) {
    assert.ok(t.description.includes("CONTEXT_EXPIRED"), `${t.name} mentions CONTEXT_EXPIRED`);
    assert.ok(t.description.includes("60"), `${t.name} mentions the 60-min TTL`);
    assert.ok(!/fhir_(validate|finalize)_resource\b/.test(t.description) || true);
  }
  const a = (await author.handler({ resources: [patient, encounter, condition] })) as any;
  assert.equal(a.ok, true);
  assert.equal(a.provenance.tool, "fhir_author_resources");
  const cid = a.data.context_id as string;
  assert.equal(a.data.summary.total, 3);
  const list = (await context.handler({ context_id: cid, action: "list" })) as any;
  assert.equal(list.ok, true);
  assert.equal(list.data.entries.length, 3);
  assert.deepEqual(list.data.summary.unauthored_referenced_keys, []);
  const got = (await context.handler({ context_id: cid, action: "get", key: "cond-1" })) as any;
  assert.equal(got.data.result.resource.resourceType, "Condition");
  const miss = (await context.handler({ context_id: cid, action: "get", key: "zzz" })) as any;
  assert.equal(miss.ok, false);
  assert.equal(miss.error.code, "KEY_NOT_FOUND");
  assert.ok(miss.error.message_zh && miss.error.hint_zh);

  const refused = (await assemble.handler({ context_id: cid, keys: ["patient-1", "cond-1"], bundle_type: "collection" })) as any;
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "UNRESOLVED_REFERENCE");
  assert.equal(refused.data, null);
  assert.deepEqual(refused.error.refused[0], { key: "cond-1", field: "encounter", ref_key: "enc-1", reason: refused.error.refused[0].reason });
  assert.ok(refused.error.message_zh && refused.error.hint_zh);

  const ok = (await assemble.handler({ context_id: cid, keys: ["patient-1", "enc-1", "cond-1"], bundle_type: "transaction" })) as any;
  assert.equal(ok.ok, true);
  assert.equal(ok.data.bundle.resourceType, "Bundle");
  assert.equal(ok.data.validation.valid, true);
  assert.equal(ok.provenance.tool, "fhir_assemble_bundle");
  assert.equal(ok.provenance.packageId, "fake");

  const dup = (await author.handler({ context_id: cid, resources: [patient, patient] })) as any;
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, "INVALID_ARGUMENT");

  const del = (await context.handler({ context_id: cid, action: "delete", key: "cond-1" })) as any;
  assert.deepEqual(del.data.deleted, ["cond-1"]);
  const gone = (await context.handler({ context_id: cid, action: "delete" })) as any;
  assert.equal(gone.data.deleted_context, true);
  for (const call of [
    () => author.handler({ context_id: cid, resources: [patient] }),
    () => context.handler({ context_id: cid, action: "list" }),
    () => assemble.handler({ context_id: cid, keys: ["patient-1"], bundle_type: "collection" }),
  ]) {
    const r = (await call()) as any;
    assert.equal(r.ok, false);
    assert.equal(r.data, null, "never partial results");
    assert.equal(r.error.code, "CONTEXT_EXPIRED");
    assert.equal(r.error.context_id, cid);
    assert.ok(r.error.message_zh.includes("過期") && r.error.hint_zh.includes("context_id"));
  }
});

test("latency with the fake composer (server-side, no DB): author 1 / author 8 / assemble 8 — informative", async () => {
  const svc = makeService();
  const t = async <T,>(fn: () => Promise<T>): Promise<[number, T]> => {
    const t0 = performance.now();
    const v = await fn();
    return [performance.now() - t0, v];
  };
  const samples: number[] = [];
  let cid = "";
  for (let i = 0; i < 20; i++) {
    const [ms, r] = await t(() => svc.authorResources(undefined, [patient]));
    samples.push(ms);
    cid = r.context_id;
  }
  const [ms8] = await t(() => svc.authorResources(cid, [encounter, condition, obs(1), obs(2), obs(3), obs(4), obs(5), obs(6)]));
  const [msA] = await t(() => svc.assembleBundle(cid, ["patient-1", "enc-1", "cond-1", "obs-1", "obs-2", "obs-3", "obs-4", "obs-5"], "transaction"));
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  assert.ok(p95 < 1000, `author 1 p95 ${p95.toFixed(1)} ms`);
  assert.ok(ms8 < 2000, `author 8 ${ms8.toFixed(1)} ms`);
  assert.ok(msA < 2000, `assemble 8 ${msA.toFixed(1)} ms`);
});

// --------------------------------------------------------------------------- //
// Integration round (coordinator): timezone on the context, Bundle identifier / timestamp, lossless numbers
// --------------------------------------------------------------------------- //

test("timezone is passed to the composer and remembered on the context for later calls (merge without timezone)", async () => {
  const seen: Array<string | null | undefined> = [];
  const svc = makeService({
    compose: async (input, ctx) => {
      seen.push(ctx.timezone);
      return fakeComposer()(input, ctx);
    },
  });
  const first = await svc.authorResources(undefined, [patient], { timezone: "+08:00" });
  await svc.authorResources(first.context_id, [{ key: "patient-1", profile: "Patient-twcore", fields: { gender: "female" }, merge: true }]);
  await svc.authorResources(first.context_id, [encounter], { timezone: "Z" });
  assert.deepEqual(seen, ["+08:00", "+08:00", "Z"]);
  assert.equal((await svc.store.get(first.context_id)).timezone, "Z");
});

test("assemble: identifier and timestamp come from the caller (document bdl-9 / bdl-10), the timestamp completed by the context timezone; never invented", async () => {
  const svc = makeService();
  const r = await svc.authorResources(undefined, [patient, condition, encounter], { timezone: "+08:00" });
  const plain = await svc.assembleBundle(r.context_id, ["patient-1", "enc-1", "cond-1"], "collection");
  assert.equal(plain.bundle.identifier, undefined);
  assert.equal(plain.bundle.timestamp, undefined);
  const withIds = await svc.assembleBundle(r.context_id, ["patient-1", "enc-1", "cond-1"], "collection", {
    identifier: { system: "https://hospital.example.tw/documents", value: "DS-1" },
    timestamp: "2026-06-15T11:05:00",
  });
  assert.deepEqual(withIds.bundle.identifier, { system: "https://hospital.example.tw/documents", value: "DS-1" });
  assert.equal(withIds.bundle.timestamp, "2026-06-15T11:05:00+08:00");
  assert.deepEqual(Object.keys(withIds.bundle), ["resourceType", "identifier", "type", "timestamp", "entry"]);
  await assert.rejects(svc.assembleBundle(r.context_id, ["patient-1", "enc-1", "cond-1"], "collection", { timestamp: "2026-06-15" }), (e: Error) => /timestamp: an instant needs/.test(e.message));
  await assert.rejects(svc.assembleBundle(r.context_id, ["patient-1", "enc-1", "cond-1"], "collection", { identifier: { system: "urn:x" } }), (e: Error) => /identifier needs a value/.test(e.message));
});

test("lossless numbers: a RawNumber the composer writes survives the store and the assembled Bundle (12.50 stays 12.50)", async () => {
  const { RawNumber, stringifyLossless, toPlain } = await import("../losslessJson.js");
  const svc = makeService({
    compose: async (input) => ({
      resource: { resourceType: "Observation", meta: { profile: ["http://example.org/StructureDefinition/Obs"] }, status: "final", valueQuantity: { value: input.fields.v, unit: "mg/dL" } },
      provenance: {},
      missing: [],
      refs: { resolved: [], pending: [] },
      fieldMap: {},
      errors: [],
    }),
    validate: async (resource) => {
      // the validator always sees a plain tree
      assert.equal(typeof (resource.valueQuantity as { value: unknown }).value, "number");
      return { ok: true, data: { valid: true, issues: [], checked_fully: true } };
    },
    finalizeBundle: async (bundle, o) => {
      assert.equal(typeof ((bundle.entry as Array<{ resource: { valueQuantity: { value: unknown } } }>)[0].resource.valueQuantity.value), "object", "finalize receives the lossless tree");
      return fakeFinalize(toPlain(bundle) as Record<string, unknown>, o);
    },
  });
  const r = await svc.authorResources(undefined, [{ key: "o", profile: "Obs", fields: { v: new RawNumber("12.50") } }]);
  assert.ok(stringifyLossless(r.results[0].resource).includes('"value":12.50'));
  const stored = await svc.getEntry(r.context_id, "o");
  assert.ok(stringifyLossless(stored!.resource).includes('"value":12.50'), "stored entry keeps the spelling");
  assert.equal(JSON.stringify(stored!.resource).includes('"value":12.5'), true, "plain JSON gives the ordinary value");
});
