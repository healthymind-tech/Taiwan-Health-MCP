import { test } from "node:test";
import assert from "node:assert/strict";
import { compareIssues, comparableMessage, stripCanonicalVersions } from "./compare.js";

const err = (path: string, message: string): { severity: string; path: string; message: string } => ({ severity: "error", path, message });

test("only the version of a canonical leaves the key", () => {
  assert.equal(stripCanonicalVersions("in the value set 'X' (http://hl7.org/fhir/ValueSet/a|4.0.1), and"), "in the value set 'X' (http://hl7.org/fhir/ValueSet/a), and");
  assert.equal(stripCanonicalVersions("(from https://x.org/StructureDefinition/p|1.2.7). Note"), "(from https://x.org/StructureDefinition/p). Note");
  assert.equal(stripCanonicalVersions("system http://a.org/cs|5.4.0-ballot and urn:oid:1.2.3|2"), "system http://a.org/cs and urn:oid:1.2.3");
  assert.equal(stripCanonicalVersions("a|b is not a canonical"), "a|b is not a canonical");
  assert.equal(comparableMessage("Wrong Display Name 'x' for http://a#c. Valid display is 'y' (for the language(s) 'en-GB')."), "Wrong Display Name 'x' for http://a#c. Valid display is 'y'");
});

test("strict: version noise agrees, a different canonical or a one-sided error does not", () => {
  const off = [err("P.a", "Unknown code in http://a.org/cs|5.4.0")];
  assert.equal(compareIssues(off, [err("P.a", "Unknown code in http://a.org/cs|4.0.1")]).strict, true);
  assert.equal(compareIssues(off, [err("P.a", "Unknown code in http://b.org/cs|5.4.0")]).strict, false);
  assert.equal(compareIssues(off, []).strict, false);
  assert.equal(compareIssues(off, [err("P.b", "Unknown code in http://a.org/cs|4.0.1")]).strict, false);
});
