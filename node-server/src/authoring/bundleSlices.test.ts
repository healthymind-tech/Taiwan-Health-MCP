/** ISSUES_v16 R5 — entry-slice placement at assembly (bundleSlices.ts), synthetic profiles. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { placeEntrySlices } from "./bundleSlices.js";

const X = "http://example.org/StructureDefinition/";
const el = (id: string, min: number, max: string, extra: Record<string, any> = {}): Record<string, any> => ({ id, path: id.replace(/:[^.]+/g, ""), min, max, ...extra });
const slice = (name: string, type: string, min: number, max: string): Array<Record<string, any>> => [el(`Bundle.entry:${name}`, min, max), el(`Bundle.entry:${name}.resource`, 1, "1", { type: [{ code: type, profile: [`${X}${name}`] }] })];
const bundleSd = (rules: string, ordered: boolean): Record<string, any> => ({
  url: `${X}B`, type: "Bundle",
  snapshot: { element: [el("Bundle", 0, "*"), el("Bundle.entry", 1, "*", { slicing: { discriminator: [{ type: "profile", path: "resource" }], rules, ordered } }), ...slice("comp", "Composition", 1, "1"), ...slice("pat", "Patient", 1, "1"), ...slice("obsA", "Observation", 0, "*"), ...slice("obsB", "Observation", 0, "1")] },
});
const SDS: Record<string, Record<string, any>> = {
  [`${X}comp`]: { url: `${X}comp`, type: "Composition", snapshot: { element: [el("Composition", 0, "*")] } },
  [`${X}pat`]: { url: `${X}pat`, type: "Patient", snapshot: { element: [el("Patient", 0, "*")] } },
  [`${X}obsA`]: { url: `${X}obsA`, type: "Observation", snapshot: { element: [el("Observation", 0, "*"), el("Observation.code", 1, "1", { patternCodeableConcept: { text: "a" } })] } },
  [`${X}obsB`]: { url: `${X}obsB`, type: "Observation", snapshot: { element: [el("Observation", 0, "*"), el("Observation.code", 1, "1", { patternCodeableConcept: { text: "b" } })] } },
};
const fetch = async (u: string): Promise<Record<string, any> | null> => SDS[u.split("|")[0]] ?? null;

test("placement by authored / declared profile, meta.profile completed, ordered slicing, missing / excess / closed unmatched", async () => {
  const entries = [
    { key: "o1", resource: { resourceType: "Observation", code: { text: "a" } }, authoredProfile: "obsA" },
    { key: "o2", resource: { resourceType: "Observation", meta: { profile: [`${X}obsB`] }, code: { text: "b" } }, authoredProfile: null },
    { key: "o3", resource: { resourceType: "Observation", id: "x", code: { text: "b" } }, authoredProfile: `${X}obsB` },
    { key: "c", resource: { resourceType: "Composition" }, authoredProfile: `${X}comp` },
    { key: "m", resource: { resourceType: "Medication" }, authoredProfile: null },
  ];
  const r = (await placeEntrySlices(entries, bundleSd("closed", true), fetch))!;
  assert.deepEqual(r.report.entries.map((e) => [e.key, e.slice, e.by]), [["o1", "obsA", "authored-profile"], ["o2", "obsB", "declared-profile"], ["o3", "obsB", "authored-profile"], ["c", "comp", "authored-profile"], ["m", null, null]]);
  assert.deepEqual(entries[0].resource, { resourceType: "Observation", meta: { profile: [`${X}obsA`] }, code: { text: "a" } }, "meta.profile added (an id names the canonical ending in it)");
  assert.deepEqual(Object.keys(entries[2].resource), ["resourceType", "id", "meta", "code"], "meta inserted after id");
  assert.deepEqual(r.report.meta_profile_set, ["o1", "o3", "c"]);
  assert.deepEqual(r.order, ["c", "o1", "o2", "o3", "m"], "slice order (ordered), unplaced last");
  assert.equal(r.report.reordered, true);
  assert.deepEqual(r.report.missing.map((m) => [m.slice, m.found, m.min]), [["pat", 0, 1]]);
  assert.match(r.report.missing[0].guidance, /author a Patient for profile .*pat.*never invented/);
  assert.deepEqual(r.report.excess, [{ slice: "obsB", max: "1", keys: ["o2", "o3"] }]);
  assert.deepEqual(r.report.unmatched.map((u) => u.key), ["m"]);
  // open slicing: entries outside the slices are fine; unordered: order kept
  const open = (await placeEntrySlices([{ key: "m", resource: { resourceType: "Medication" }, authoredProfile: null }, { key: "c", resource: { resourceType: "Composition" }, authoredProfile: null }], bundleSd("open", false), fetch))!;
  assert.deepEqual(open.report.unmatched, []);
  assert.deepEqual(open.order, ["m", "c"]);
  assert.equal(await placeEntrySlices([], { url: "u", type: "Bundle", snapshot: { element: [el("Bundle", 0, "*"), el("Bundle.entry", 0, "*")] } }, fetch), null);
});
