/**
 * An absolute contentReference in a profile (`http://hl7.org/fhir/StructureDefinition/Questionnaire#Questionnaire.item`,
 * as snapshot generators write it for nested items): InstanceValidator 7.0.1 validates the referenced element's
 * children (the base resource's) under the profile, and ProfileUtilities.getChildMap finds no children for a
 * BackboneElement of another definition — nor for the profile's own element of that id once that empty answer is
 * cached (childMapCache, key `profile versioned url # element id`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, type Issue } from "./fhirValidator.js";
import { CORE, FakeResolver, el, sd } from "./fhirTestKit.test.js";

const PROFILE = "http://test.fhir.tw/StructureDefinition/q";

function questionnaire(url: string, nestedRef: string, extra: Record<string, any> = {}): Record<string, any> {
  return sd(
    url,
    "Questionnaire",
    "resource",
    [
      el("Questionnaire", 0, "*"),
      el("Questionnaire.id", 0, "1", ["string"]),
      el("Questionnaire.status", 1, "1", ["code"]),
      el("Questionnaire.item", 0, "*", ["BackboneElement"]),
      el("Questionnaire.item.linkId", 1, "1", ["string"]),
      el("Questionnaire.item.answerOption", 0, "*", ["BackboneElement"]),
      el("Questionnaire.item.answerOption.value[x]", 1, "1", ["Coding", "string"]),
      el("Questionnaire.item.item", 0, "*", [], { contentReference: nestedRef }),
    ],
    extra,
  );
}

class Resolver extends FakeResolver {
  override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    const u = url.split("|")[0];
    if (u === CORE + "Questionnaire") return questionnaire(u, "#Questionnaire.item", { version: "4.0.1" });
    if (u === PROFILE) return questionnaire(u, CORE + "Questionnaire#Questionnaire.item", { version: "1.0.0", baseDefinition: CORE + "Questionnaire", derivation: "constraint" });
    return super.fetchStructureDefinition(url);
  }
}

const option = { valueCoding: { system: "http://example.org/cs", code: "a" } };
const errs = async (r: Record<string, any>): Promise<string[]> =>
  (await new InstanceValidator(new Resolver()).validate(r, { profiles: [PROFILE] }))
    .filter((i: Issue) => i.severity === "error" && i.message.startsWith("Example URLs are not allowed"))
    .map((i: Issue) => i.path)
    .sort();

test("absolute contentReference: a nested item's BackboneElement children are not validated (getChildMap l. 491-577)", async () => {
  const q = {
    resourceType: "Questionnaire",
    status: "draft",
    item: [
      { linkId: "1", item: [{ linkId: "1.1", answerOption: [option], item: [{ linkId: "1.1.1", answerOption: [option] }] }] },
      { linkId: "2", answerOption: [option] },
    ],
  };
  // depth 2 (the base element, under the profile) comes first: no children found, cached empty under the id it shares
  // with the profile's own element — which then answers nothing at depth 3 (`#Questionnaire.item` of the base resolves
  // in the profile) and at depth 1 alike
  assert.deepEqual(await errs(q), []);
});

test("absolute contentReference: the profile's element validated first fills the cache for the base element", async () => {
  const q = {
    resourceType: "Questionnaire",
    status: "draft",
    item: [{ linkId: "1", answerOption: [option], item: [{ linkId: "1.1", answerOption: [option] }] }],
  };
  assert.deepEqual(await errs(q), ["Questionnaire.item[0].answerOption[0].valueCoding.system", "Questionnaire.item[0].item[0].answerOption[0].valueCoding.system"]);
});

test("absolute contentReference: the profile's own element validated first fills the cache with its children", async () => {
  const q = {
    resourceType: "Questionnaire",
    status: "draft",
    item: [{ linkId: "1", item: [{ linkId: "1.1", item: [{ linkId: "1.1.1", answerOption: [option] }] }, { linkId: "1.2", answerOption: [option] }] }],
  };
  // depth 3 comes first (document order): validated, cached; the later depth-2 base element then answers from the cache
  assert.deepEqual(await errs(q), ["Questionnaire.item[0].item[0].item[0].answerOption[0].valueCoding.system", "Questionnaire.item[0].item[1].answerOption[0].valueCoding.system"]);
});

test("a relative contentReference keeps every depth validated", async () => {
  const q = {
    resourceType: "Questionnaire",
    status: "draft",
    item: [{ linkId: "1", answerOption: [option], item: [{ linkId: "1.1", answerOption: [option] }] }],
  };
  const issues = (await new InstanceValidator(new Resolver()).validate(q, { profiles: [] })).filter((i: Issue) => i.severity === "error" && i.message.startsWith("Example URLs are not allowed"));
  assert.equal(issues.length, 2, JSON.stringify(issues));
});
