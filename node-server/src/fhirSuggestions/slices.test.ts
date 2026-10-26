/**
 * ISSUES_v16 R3 — slice / profile-match explanations (slices.ts, fhirSliceMatch.ts) over synthetic
 * StructureDefinitions and fake collaborators; plus the IG example Bundles of TWPAS 1.2.7 /
 * TW Core 1.0.0 with one entry corrupted (local FHIR package cache; skipped when absent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { profileRelation } from "../fhirSliceMatch.js";
import { InstanceValidator } from "../fhirValidator.js";
import { available, exampleBundles, packages } from "../../scripts/v16-structure-eval/packages.js";
import { attachSuggestions } from "./index.js";
import type { SuggestionDeps } from "./types.js";

const X = "http://example.org/StructureDefinition/";
const el = (id: string, min: number, max: string, extra: Record<string, any> = {}): Record<string, any> => ({ id, path: id.replace(/:[^.]+/g, ""), min, max, ...extra });
const SDS: Record<string, Record<string, any>> = {
  [`${X}Bundle-x`]: {
    url: `${X}Bundle-x`, type: "Bundle",
    snapshot: { element: [
      el("Bundle", 0, "*"),
      el("Bundle.entry", 1, "*", { slicing: { discriminator: [{ type: "profile", path: "resource" }], rules: "closed" } }),
      el("Bundle.entry:patient", 1, "1"),
      el("Bundle.entry:patient.resource", 1, "1", { type: [{ code: "Patient", profile: [`${X}Patient-x`] }] }),
      el("Bundle.entry:orgA", 0, "*"),
      el("Bundle.entry:orgA.resource", 1, "1", { type: [{ code: "Organization", profile: [`${X}Org-a`] }] }),
      el("Bundle.entry:orgB", 0, "*"),
      el("Bundle.entry:orgB.resource", 1, "1", { type: [{ code: "Organization", profile: [`${X}Org-b`] }] }),
    ] },
  },
  [`${X}Patient-x`]: { url: `${X}Patient-x`, type: "Patient", snapshot: { element: [el("Patient", 0, "*"), el("Patient.identifier", 1, "*"), el("Patient.name", 0, "*")] } },
  [`${X}Org-a`]: { url: `${X}Org-a`, type: "Organization", snapshot: { element: [el("Organization", 0, "*"), el("Organization.type", 1, "1", { patternCodeableConcept: { coding: [{ system: "urn:s", code: "a" }] } })] } },
  [`${X}Org-b`]: { url: `${X}Org-b`, type: "Organization", snapshot: { element: [el("Organization", 0, "*"), el("Organization.type", 1, "1", { patternCodeableConcept: { coding: [{ system: "urn:s", code: "b" }] } })] } },
};

function deps(calls: string[] = []): SuggestionDeps {
  return {
    fetchStructureDefinition: async (u) => SDS[u.split("|")[0]] ?? null,
    checkCode: async () => ({ status: "ok" }) as any,
    validateAgainst: async (res, profile) => {
      calls.push(profile);
      if (profile.endsWith("Patient-x") && !res.identifier) return [{ severity: "error", path: "Patient", message: `Patient.identifier: minimum required = 1, but only found 0 (from ${profile})` }];
      if (profile.endsWith("Org-a")) return [{ severity: "error", path: "Organization.type", message: "pattern a" }];
      return [];
    },
  };
}

const bundle = (): Record<string, any> => ({
  resourceType: "Bundle",
  meta: { profile: [`${X}Bundle-x`] },
  entry: [
    { fullUrl: "urn:uuid:p", resource: { resourceType: "Patient", name: [{ text: "x" }] } },
    { fullUrl: "urn:uuid:o", resource: { resourceType: "Organization", meta: { profile: `${X}Org-a` }, type: [{ coding: [{ system: "urn:s", code: "b" }] }] } },
  ],
});
const closed = (i: number): Record<string, any> => ({ severity: "error", path: `Bundle.entry[${i}]`, code: "structure", message: `This element does not match any known slice defined in the profile ${X}Bundle-x and slicing is CLOSED`, element: "Bundle.entry", profile: `${X}Bundle-x` });
const missing = (): Record<string, any> => ({ severity: "error", path: "Bundle", code: "required", message: `Slice 'Bundle.entry:patient': a matching slice is required, but not found (from ${X}Bundle-x)`, element: "Bundle.entry:patient", profile: `${X}Bundle-x` });

test("profileRelation: exact / other version / misspelled / other / missing / a string", () => {
  assert.equal(profileRelation([`${X}A|2`], `${X}A`).relation, "exact");
  assert.equal(profileRelation([`${X}A|1`], `${X}A|2`).relation, "other-version");
  assert.equal(profileRelation([`${X}patient-X`], `${X}Patient-x`).relation, "misspelled");
  assert.equal(profileRelation([`${X}Patient-xy`], `${X}Patient-x`).relation, "misspelled");
  assert.equal(profileRelation([`${X}Org-a`], `${X}Patient-x`).relation, "other-profile");
  assert.equal(profileRelation([], `${X}A`).relation, "missing");
  assert.equal(profileRelation([`${X}A`], `${X}A`, true).relation, "malformed");
});

test("closed-slice / missing-slice issues: closest slice, failed discriminator, blocking errors, set_profile — additive and deterministic", async () => {
  const run = async (): Promise<Array<Record<string, any>>> => {
    const issues = [closed(0), closed(1), missing()];
    await attachSuggestions(issues, bundle(), deps());
    return issues;
  };
  const issues = await run();
  const [p, o, m] = issues;
  // the validator's fields are untouched
  for (const [i, orig] of [closed(0), closed(1), missing()].entries()) for (const k of Object.keys(orig)) assert.deepEqual(issues[i][k], orig[k]);
  assert.equal(p.slice_match.closest.slice, "patient");
  assert.ok(p.slice_match.failed.some((f: any) => f.reason === "meta-profile-missing"));
  assert.ok(p.slice_match.failed.some((f: any) => f.reason === "value-missing" && /identifier/.test(f.detail)));
  assert.deepEqual(p.slice_match.blocking, [{ path: "Bundle.entry[0].resource", message: `Patient.identifier: minimum required = 1, but only found 0 (from ${X}Patient-x)` }]);
  const sp = p.suggestions.find((s: any) => s.kind === "set_profile");
  assert.deepEqual(sp.patch, { op: "add", path: "Bundle.entry[0].resource.meta.profile", value: [`${X}Patient-x`] });
  // declared Org-a (a string) but the pattern says b: closest is orgB, chosen by the pattern / fewest errors
  assert.equal(o.slice_match.closest.slice, "orgB");
  assert.ok(o.slice_match.failed.some((f: any) => f.reason === "meta-profile-not-array"));
  assert.ok(o.slice_match.failed.some((f: any) => f.reason === "meta-profile-other"));
  assert.deepEqual(o.suggestions.find((s: any) => s.kind === "set_profile").patch, { op: "replace", path: "Bundle.entry[1].resource.meta.profile", value: [`${X}Org-b`] });
  // the required slice's closest item is the unmatched Patient entry
  assert.equal(m.slice_match.closest.item, "Bundle.entry[0]");
  assert.equal(m.slice_match.blocking_total, 1);
  assert.equal(JSON.stringify(await run()), JSON.stringify(issues), "deterministic");
});

test("missing slice with no candidate → add_resource (never invented); validation budget honoured; fail-open", async () => {
  const b = bundle();
  b.entry.shift();
  const issues = [missing()];
  await attachSuggestions(issues, b, deps());
  assert.equal(issues[0].slice_match.closest, null);
  assert.match(issues[0].slice_match.hint, /author a Patient conforming to .*Patient-x.*never invented/);
  assert.equal(issues[0].suggestions[0].kind, "add_resource");
  assert.equal(issues[0].suggestions[0].patch, undefined);
  // budget 0: explanations without blocking, no validation call
  const calls: string[] = [];
  const two = [closed(0), closed(1)];
  await attachSuggestions(two, bundle(), deps(calls), { maxSliceValidations: 0 });
  assert.deepEqual(calls, []);
  assert.equal(two[0].slice_match.closest.slice, "patient");
  assert.equal(two[0].slice_match.blocking, undefined);
  // collaborators failing: no exception, no explanation fields beyond what could be read
  const boom = async (): Promise<never> => {
    throw new Error("down");
  };
  const three = [closed(0)];
  await attachSuggestions(three, bundle(), { fetchStructureDefinition: boom, checkCode: boom, validateAgainst: boom });
  assert.equal(three[0].slice_match, undefined);
});

for (const ig of ["pas"]) {
  // (TW Core 1.0.0 Bundle profiles do not slice their entries by profile: no closed-slice issue to explain.)
  test(`R3 ${ig}: an example entry missing a required element — its slice issues name the right slice and the blocking error`, { skip: !available(ig), timeout: 600_000 }, async () => {
    const pk = packages(ig);
    const sdeps = pk.suggestionDeps();
    let checked = 0;
    for (const [name, b0] of exampleBundles(ig, 5).slice(0, 2)) {
      for (let i = 0; i < b0.entry.length && checked < 12; i += 4) {
        const b = JSON.parse(JSON.stringify(b0));
        const res = b.entry[i].resource;
        const P = res?.meta?.profile?.[0];
        const sd = P ? await sdeps.fetchStructureDefinition(P) : null;
        const req = sd?.snapshot?.element?.find((e: any) => String(e.path).split(".").length === 2 && !String(e.id).includes(":") && e.min >= 1 && String(e.path).split(".")[1] in res && !String(e.path).endsWith(".meta"));
        if (!req) continue;
        const key = String(req.path).split(".")[1];
        delete res[key]; // meta.profile kept: the entry declares the profile it was written for
        const issues = (await new InstanceValidator(pk.resolver()).validate(b, {})) as any[];
        await attachSuggestions(issues, b, sdeps);
        const own = issues.find((x) => x.path === `Bundle.entry[${i}]` && /does not match any known slice/.test(x.message));
        if (!own) continue;
        checked++;
        assert.equal(own.slice_match?.closest?.profile?.split("|")[0], P, `${name} entry ${i}: ${JSON.stringify(own.slice_match)}`);
        assert.ok((own.slice_match.blocking ?? []).some((x: any) => `${x.path} ${x.message}`.includes(key)), `${name} entry ${i}: blocking names ${key}`);
      }
    }
    assert.ok(checked > 0, "at least one entry checked");
  });
}
