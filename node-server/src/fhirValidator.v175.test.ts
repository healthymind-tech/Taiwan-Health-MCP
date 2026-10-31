/**
 * ISSUES_v17.5 — validator_cli parity on document Bundles (IPS blind test): every reference of a document's entries
 * must resolve inside the Bundle, local narrative links must resolve, a `url|version` uri must resolve that version,
 * and a coding bound to an enumerated ValueSet in a non-English resource needs the ValueSet's display.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, narrativeLinkProblems, type Issue } from "./fhirValidator.js";
import { COND_PROFILE, FakeResolver } from "./fhirTestKit.test.js";

type Json = Record<string, any>;
const U = (n: number): string => `urn:uuid:${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const errors = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal");
const comp = (extra: Json = {}): Json => ({ resourceType: "Composition", id: "c1", status: "final", type: { text: "x" }, subject: { reference: U(1) }, date: "2024-01-01", author: [{ reference: U(1) }], title: "t", ...extra });
const run = (r: Json, resolver = new FakeResolver(), profiles: string[] = []): Promise<Issue[]> => new InstanceValidator(resolver).validate(r, { profiles });

test("document: an unresolved reference of any entry is an error on the Bundle (with the near-miss note)", async () => {
  const b = {
    resourceType: "Bundle",
    type: "document",
    entry: [
      { fullUrl: U(3), resource: comp({ section: [{ title: "s", entry: [{ reference: U(2) }] }] }) },
      { fullUrl: U(1), resource: { resourceType: "Patient", id: "p1" } },
      { fullUrl: U(2), resource: { resourceType: "Observation", id: "o1", status: "final", code: { text: "x" }, subject: { reference: "Patient/p1" } } },
    ],
  };
  const e = errors(await run(b));
  const hit = e.find((i) => /Can't find 'Patient\/p1' in the bundle \(Bundle\.entry\[2\]\.resource\.subject\)/.test(i.message));
  assert.ok(hit, JSON.stringify(e.map((i) => i.message)));
  assert.equal(hit!.path, "Bundle");
  assert.match(hit!.message, /same type and id, but it does not match because of the fullUrl based rules/);
  // collection Bundles are not checked this way
  const c = { ...b, type: "collection" };
  assert.ok(!errors(await run(c)).some((i) => /Can't find 'Patient\/p1'/.test(i.message)));
});

test("narrative: a local link without a target is an error; a link to an id in the Bundle is fine", async () => {
  assert.deepEqual(narrativeLinkProblems('<div xmlns="http://www.w3.org/1999/xhtml"><p><a href="#Patient_1">See above</a></p></div>', new Set()), [{ href: "#Patient_1", at: "div/p/a", text: "See above" }]);
  assert.deepEqual(narrativeLinkProblems('<div><p><a href="#x">t</a></p><span id="x"/></div>', new Set(["x"])), []);
  assert.deepEqual(narrativeLinkProblems('<div><a href="http://example.org">t</a></div>', new Set()), []);
  const p = { resourceType: "Patient", id: "p1", text: { status: "generated", div: '<div xmlns="http://www.w3.org/1999/xhtml"><p><a href="#nowhere">see</a></p></div>' } };
  const e = errors(await run(p));
  assert.ok(e.some((i) => i.path === "Patient.text.div" && /Hyperlink '#nowhere' at 'div\/p\/a' for 'see' does not resolve/.test(i.message)), JSON.stringify(e));
});

test("a coding bound to an enumerated ValueSet in a zh-TW resource needs the ValueSet's display; English / no language does not", async () => {
  const VS = "http://x/ValueSet/diseases";
  const P = "http://x/StructureDefinition/Condition-lang";
  class R extends FakeResolver {
    async fetchStructureDefinition(url: string): Promise<Json | null> {
      if (url.split("|")[0] !== P) return super.fetchStructureDefinition(url);
      const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(COND_PROFILE)));
      base.url = P;
      for (const e of base.snapshot.element) if (e.path === "Condition.code") e.binding = { strength: "preferred", valueSet: VS };
      return base;
    }
    async fetchValueSet(url: string): Promise<Json | null> {
      if (url.split("|")[0] !== VS) return super.fetchValueSet(url);
      return { resourceType: "ValueSet", url: VS, status: "active", compose: { include: [{ system: "http://snomed.info/sct", concept: [{ code: "27836007", display: "Pertussis (disorder)" }] }] } };
    }
  }
  const cond = (lang: string | null, display: string): Json => ({
    resourceType: "Condition",
    ...(lang ? { language: lang } : {}),
    meta: { profile: [P] },
    subject: { reference: "Patient/p1" },
    code: { coding: [{ system: "http://snomed.info/sct", code: "27836007", display }] },
  });
  const lang = (issues: Issue[]): Issue[] => errors(issues).filter((i) => /for the language\(s\)/.test(i.message));
  const zh = lang(await run(cond("zh-TW", "Pertussis"), new R()));
  assert.equal(zh.length, 1);
  assert.equal(zh[0].path, "Condition.code.coding[0].display");
  assert.match(zh[0].message, /Valid display is 'Pertussis \(disorder\)' \(for the language\(s\) 'zh-TW'\)/);
  assert.deepEqual(lang(await run(cond("zh-TW", "Pertussis (disorder)"), new R())), []);
  assert.deepEqual(lang(await run(cond("en-US", "Pertussis"), new R())), []);
  assert.deepEqual(lang(await run(cond(null, "Pertussis"), new R())), []);
});
