/**
 * Shared fixtures for the FHIR validator unit tests: a tiny in-memory
 * "package" of hand-built StructureDefinition snapshots, ValueSets and
 * CodeSystems, plus a fake `ValidatorResolver` over them. No DB.
 *
 * (Named *.test.ts so the build excludes it; it declares no tests itself.)
 */

import { composeContains, findConcept, indexCodeSystem, type TerminologyDeps } from "./fhirCodeSystem.js";
import type { CodeCheck, ValidatorResolver } from "./fhirValidator.js";

export const CORE = "http://hl7.org/fhir/StructureDefinition/";

type El = Record<string, any>;

/** Build an ElementDefinition. `types` are type codes; `max` defaults to "1". */
export function el(id: string, min: number, max: string, types: string[] = [], extra: El = {}): El {
  const path = id.replace(/:[^.]+/g, "");
  return {
    id,
    path,
    min,
    max,
    base: { path, min, max: extra.baseMax ?? max },
    ...(types.length ? { type: types.map((code) => ({ code })) } : {}),
    ...extra,
  };
}

export function sd(url: string, type: string, kind: string, elements: El[], extra: El = {}): El {
  return { resourceType: "StructureDefinition", url, type, kind, snapshot: { element: elements }, ...extra };
}

const idEl = (p: string): El => el(`${p}.id`, 0, "1", ["string"]);
const extEl = (p: string): El => el(`${p}.extension`, 0, "*", ["Extension"]);

export const SDS: Record<string, El> = {};
function put(s: El): void {
  SDS[s.url] = s;
}

// ---- datatypes ------------------------------------------------------------
put(
  sd(CORE + "Extension", "Extension", "complex-type", [
    el("Extension", 0, "*", [], {
      constraint: [{ key: "ext-1", severity: "error", human: "Must have either extensions or value[x], not both", expression: "extension.exists() != value.exists()" }],
    }),
    idEl("Extension"),
    extEl("Extension"),
    el("Extension.url", 1, "1", ["uri"]),
    el("Extension.value[x]", 0, "1", ["string", "boolean", "Address", "CodeableConcept", "Reference", "Quantity", "integer", "code"]),
  ]),
);
put(
  sd(CORE + "Coding", "Coding", "complex-type", [
    el("Coding", 0, "*"),
    idEl("Coding"),
    extEl("Coding"),
    el("Coding.system", 0, "1", ["uri"]),
    el("Coding.version", 0, "1", ["string"]),
    el("Coding.code", 0, "1", ["code"]),
    el("Coding.display", 0, "1", ["string"]),
  ]),
);
put(
  sd(CORE + "CodeableConcept", "CodeableConcept", "complex-type", [
    el("CodeableConcept", 0, "*"),
    idEl("CodeableConcept"),
    extEl("CodeableConcept"),
    el("CodeableConcept.coding", 0, "*", ["Coding"]),
    el("CodeableConcept.text", 0, "1", ["string"]),
  ]),
);
put(
  sd(CORE + "Identifier", "Identifier", "complex-type", [
    el("Identifier", 0, "*"),
    idEl("Identifier"),
    extEl("Identifier"),
    el("Identifier.use", 0, "1", ["code"]),
    el("Identifier.system", 0, "1", ["uri"]),
    el("Identifier.value", 0, "1", ["string"]),
  ]),
);
put(
  sd(CORE + "Reference", "Reference", "complex-type", [
    el("Reference", 0, "*", [], {
      constraint: [
        {
          key: "ref-1",
          severity: "error",
          human: "SHALL have a contained resource if a local reference is provided",
          expression: "reference.startsWith('#').not() or (reference.substring(1).trace('url') in %rootResource.contained.id.trace('ids'))",
        },
      ],
    }),
    idEl("Reference"),
    extEl("Reference"),
    el("Reference.reference", 0, "1", ["string"]),
    el("Reference.display", 0, "1", ["string"]),
  ]),
);
put(
  sd(CORE + "Quantity", "Quantity", "complex-type", [
    el("Quantity", 0, "*"),
    idEl("Quantity"),
    extEl("Quantity"),
    el("Quantity.value", 0, "1", ["decimal"]),
    el("Quantity.unit", 0, "1", ["string"]),
    el("Quantity.system", 0, "1", ["uri"]),
    el("Quantity.code", 0, "1", ["code"]),
  ]),
);
put(
  sd(CORE + "Period", "Period", "complex-type", [
    el("Period", 0, "*", [], {
      constraint: [{ key: "per-1", severity: "error", human: "start <= end", expression: "start.hasValue().not() or end.hasValue().not() or (start <= end)" }],
    }),
    idEl("Period"),
    extEl("Period"),
    el("Period.start", 0, "1", ["dateTime"]),
    el("Period.end", 0, "1", ["dateTime"]),
  ]),
);
put(
  sd(CORE + "Address", "Address", "complex-type", [
    el("Address", 0, "*"),
    idEl("Address"),
    extEl("Address"),
    el("Address.city", 0, "1", ["string"]),
  ]),
);

// ---- extensions -----------------------------------------------------------
put(
  sd(CORE + "patient-birthPlace", "Extension", "complex-type", [
    el("Extension", 0, "*", [], {
      constraint: [{ key: "ext-1", severity: "error", human: "Must have either extensions or value[x], not both", expression: "extension.exists() != value.exists()" }],
    }),
    idEl("Extension"),
    el("Extension.extension", 0, "0", ["Extension"], { baseMax: "*" }),
    el("Extension.url", 1, "1", ["uri"], { fixedUri: CORE + "patient-birthPlace" }),
    el("Extension.value[x]", 1, "1", ["Address"]),
  ]),
);

// ---- resources ------------------------------------------------------------
const domain = (t: string): El[] => [
  // As in R4 core 4.0.1: System.String with fhir-type "string", base Resource.id.
  el(`${t}.id`, 0, "1", [], {
    type: [{ code: "http://hl7.org/fhirpath/System.String", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type", valueUrl: "string" }] }],
    base: { path: "Resource.id", min: 0, max: "1" },
  }),
  el(`${t}.meta`, 0, "1", ["Meta"]),
  el(`${t}.text`, 0, "1", ["Narrative"]),
  el(`${t}.contained`, 0, "*", ["Resource"]),
  extEl(t),
];

put(
  sd(CORE + "Patient", "Patient", "resource", [
    el("Patient", 0, "*"),
    ...domain("Patient"),
    el("Patient.identifier", 0, "*", ["Identifier"]),
    el("Patient.active", 0, "1", ["boolean"]),
    el("Patient.gender", 0, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1" } }),
    el("Patient.birthDate", 0, "1", ["date"]),
    el("Patient.managingOrganization", 0, "1", ["Reference"], { type: [{ code: "Reference", targetProfile: [CORE + "Organization"] }] }),
  ]),
);
put(
  sd(CORE + "Organization", "Organization", "resource", [el("Organization", 0, "*"), ...domain("Organization"), el("Organization.name", 0, "1", ["string"])]),
);
const anyRef = (id: string, min: number, max: string): El =>
  el(id, min, max, [], { type: [{ code: "Reference", targetProfile: [CORE + "Resource"] }] });
put(sd(CORE + "Resource", "Resource", "resource", [el("Resource", 0, "*"), el("Resource.id", 0, "1", ["id"])]));
put(
  sd(CORE + "Composition", "Composition", "resource", [
    el("Composition", 0, "*"),
    ...domain("Composition"),
    el("Composition.status", 1, "1", ["code"]),
    el("Composition.type", 1, "1", ["CodeableConcept"]),
    anyRef("Composition.subject", 0, "1"),
    anyRef("Composition.encounter", 0, "1"),
    el("Composition.date", 1, "1", ["dateTime"]),
    anyRef("Composition.author", 1, "*"),
    el("Composition.title", 1, "1", ["string"]),
    el("Composition.attester", 0, "*", ["BackboneElement"]),
    el("Composition.attester.mode", 1, "1", ["code"]),
    anyRef("Composition.attester.party", 0, "1"),
    anyRef("Composition.custodian", 0, "1"),
    el("Composition.section", 0, "*", ["BackboneElement"]),
    el("Composition.section.title", 0, "1", ["string"]),
    anyRef("Composition.section.entry", 0, "*"),
    el("Composition.section.section", 0, "*", [], { contentReference: "#Composition.section" }),
  ]),
);
put(
  sd(CORE + "Provenance", "Provenance", "resource", [
    el("Provenance", 0, "*"),
    ...domain("Provenance"),
    anyRef("Provenance.target", 1, "*"),
    el("Provenance.recorded", 1, "1", ["instant"]),
  ]),
);
put(
  sd(CORE + "Condition", "Condition", "resource", [
    el("Condition", 0, "*"),
    ...domain("Condition"),
    el("Condition.clinicalStatus", 0, "1", ["CodeableConcept"], {
      binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/condition-clinical|4.0.1" },
    }),
    el("Condition.category", 0, "*", ["CodeableConcept"]),
    el("Condition.subject", 1, "1", ["Reference"]),
    el("Condition.code", 0, "1", ["CodeableConcept"]),
  ]),
);

const vs2 = {
  key: "vs-2",
  severity: "error",
  human: "If there is no component or hasMember element then either a value[x] or a data absent reason must be present.",
  expression: "(component.empty() and hasMember.empty()) implies (dataAbsentReason.exists() or value.exists())",
};
const obsBase = (t = "Observation"): El[] => [
  el(t, 0, "*", [], { constraint: [vs2] }),
  ...domain(t),
  el(`${t}.status`, 1, "1", ["code"]),
  el(`${t}.category`, 0, "*", ["CodeableConcept"]),
  el(`${t}.code`, 1, "1", ["CodeableConcept"]),
  el(`${t}.subject`, 0, "1", ["Reference"]),
  el(`${t}.effective[x]`, 0, "1", ["dateTime", "Period"]),
  el(`${t}.value[x]`, 0, "1", ["Quantity", "CodeableConcept", "string", "boolean"]),
  el(`${t}.dataAbsentReason`, 0, "1", ["CodeableConcept"]),
  el(`${t}.hasMember`, 0, "*", ["Reference"]),
  el(`${t}.component`, 0, "*", ["BackboneElement"], {
    constraint: [{ key: "vs-3", severity: "error", human: "component value or dar", expression: "value.exists() or dataAbsentReason.exists()" }],
  }),
  el(`${t}.component.id`, 0, "1", ["string"]),
  el(`${t}.component.code`, 1, "1", ["CodeableConcept"]),
  el(`${t}.component.value[x]`, 0, "1", ["Quantity", "string"]),
  el(`${t}.component.dataAbsentReason`, 0, "1", ["CodeableConcept"]),
];
put(sd(CORE + "Observation", "Observation", "resource", obsBase()));

/** A vital-sign style profile: category slice (pattern), value[x] restricted to Quantity with fixed system. */
export const VITAL = "http://example.tw/fhir/StructureDefinition/vital";
put(
  sd(VITAL, "Observation", "resource", [
    ...obsBase().filter((e) => !["Observation.category", "Observation.value[x]"].includes(e.id)),
    el("Observation.category", 1, "*", ["CodeableConcept"], {
      slicing: { discriminator: [{ type: "pattern", path: "$this" }], rules: "open" },
    }),
    el("Observation.category:VSCat", 1, "1", ["CodeableConcept"], {
      patternCodeableConcept: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] },
    }),
    el("Observation.value[x]", 0, "1", ["Quantity"], { slicing: { discriminator: [{ type: "type", path: "$this" }], rules: "closed" } }),
    el("Observation.value[x]:valueQuantity", 0, "1", ["Quantity"]),
    el("Observation.value[x]:valueQuantity.value", 1, "1", ["decimal"]),
    el("Observation.value[x]:valueQuantity.system", 1, "1", ["uri"], { fixedUri: "http://unitsofmeasure.org" }),
    el("Observation.value[x]:valueQuantity.code", 1, "1", ["code"]),
  ], { baseDefinition: CORE + "Observation" }),
);

/** Profile with closed coding slicing by required bindings (like TW PAS Condition.code). */
export const COND_PROFILE = "http://example.tw/fhir/StructureDefinition/cond";
put(
  sd(COND_PROFILE, "Condition", "resource", [
    el("Condition", 0, "*"),
    ...domain("Condition"),
    el("Condition.clinicalStatus", 0, "1", ["CodeableConcept"], {
      binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/condition-clinical|4.0.1" },
    }),
    el("Condition.category", 1, "*", ["CodeableConcept"]),
    el("Condition.subject", 1, "1", ["Reference"]),
    el("Condition.code", 0, "1", ["CodeableConcept"]),
    el("Condition.code.coding", 0, "*", ["Coding"], { slicing: { discriminator: [{ type: "pattern", path: "$this" }], rules: "closed" } }),
    el("Condition.code.coding:icd", 0, "1", ["Coding"], { binding: { strength: "required", valueSet: "http://example.tw/ValueSet/icd" } }),
    el("Condition.code.text", 0, "1", ["string"]),
  ]),
);

/** Patient profile with an extension slice and an invariant on a primitive (`value.matches`). */
export const PAT_PROFILE = "http://example.tw/fhir/StructureDefinition/pat";
put(
  sd(PAT_PROFILE, "Patient", "resource", [
    el("Patient", 0, "*"),
    ...domain("Patient").filter((e) => e.id !== "Patient.extension"),
    el("Patient.extension", 0, "*", ["Extension"], { slicing: { discriminator: [{ type: "value", path: "url" }], rules: "open" } }),
    el("Patient.extension:birthPlace", 0, "1", [], { type: [{ code: "Extension", profile: [CORE + "patient-birthPlace"] }] }),
    el("Patient.identifier", 1, "*", ["Identifier"]),
    el("Patient.identifier.id", 0, "1", ["string"]),
    el("Patient.identifier.use", 0, "1", ["code"]),
    el("Patient.identifier.system", 1, "1", ["uri"]),
    el("Patient.identifier.value", 1, "1", ["string"], {
      constraint: [{ key: "id-card", severity: "error", human: "TW id card", expression: "value.matches('^[A-Z][0-9]{9}$')" }],
    }),
    el("Patient.gender", 0, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1" } }),
    el("Patient.birthDate", 0, "1", ["date"]),
    el("Patient.active", 0, "1", ["boolean"]),
    el("Patient.managingOrganization", 0, "1", [], { type: [{ code: "Reference", targetProfile: [CORE + "Organization"] }] }),
  ]),
);

/** Bundle profile slicing entries by resource profile (like PAS Bundle). */
export const BUNDLE_PROFILE = "http://example.tw/fhir/StructureDefinition/bundle";
put(
  sd(CORE + "Bundle", "Bundle", "resource", [
    el("Bundle", 0, "*"),
    el("Bundle.id", 0, "1", ["id"]),
    el("Bundle.meta", 0, "1", ["Meta"]),
    el("Bundle.type", 1, "1", ["code"]),
    el("Bundle.entry", 0, "*", ["BackboneElement"]),
    el("Bundle.entry.fullUrl", 0, "1", ["uri"]),
    el("Bundle.entry.resource", 0, "1", ["Resource"]),
  ]),
);
put(
  sd(BUNDLE_PROFILE, "Bundle", "resource", [
    el("Bundle", 0, "*"),
    el("Bundle.id", 0, "1", ["id"]),
    el("Bundle.meta", 0, "1", ["Meta"]),
    el("Bundle.type", 1, "1", ["code"]),
    el("Bundle.entry", 1, "*", ["BackboneElement"], { slicing: { discriminator: [{ type: "profile", path: "resource" }], rules: "closed" } }),
    el("Bundle.entry.fullUrl", 0, "1", ["uri"]),
    el("Bundle.entry.resource", 0, "1", ["Resource"]),
    el("Bundle.entry:patient", 1, "1", ["BackboneElement"]),
    el("Bundle.entry:patient.fullUrl", 0, "1", ["uri"]),
    el("Bundle.entry:patient.resource", 1, "1", [], { type: [{ code: "Patient", profile: [PAT_PROFILE] }] }),
  ]),
);

// ---- terminology ----------------------------------------------------------
export const CONDITION_CLINICAL_CS = {
  resourceType: "CodeSystem",
  url: "http://terminology.hl7.org/CodeSystem/condition-clinical",
  content: "complete",
  hierarchyMeaning: "is-a",
  concept: [
    { code: "active", display: "Active", concept: [{ code: "recurrence", display: "Recurrence" }, { code: "relapse", display: "Relapse" }] },
    { code: "inactive", display: "Inactive", concept: [{ code: "remission", display: "Remission" }, { code: "resolved", display: "Resolved" }] },
    { code: "unknown", display: "Unknown" },
  ],
};
const GENDER_CS = {
  resourceType: "CodeSystem",
  url: "http://hl7.org/fhir/administrative-gender",
  content: "complete",
  concept: ["male", "female", "other", "unknown"].map((c) => ({ code: c, display: c })),
};
const ICD_CS = {
  resourceType: "CodeSystem",
  url: "http://example.tw/CodeSystem/icd",
  content: "complete",
  concept: [{ code: "I10", display: "Essential hypertension", designation: [{ language: "zh-TW", value: "原發性高血壓" }] }],
};
const OBS_CAT_CS = {
  resourceType: "CodeSystem",
  url: "http://terminology.hl7.org/CodeSystem/observation-category",
  content: "complete",
  concept: [{ code: "vital-signs", display: "Vital Signs" }, { code: "laboratory", display: "Laboratory" }],
};
export const CODE_SYSTEMS: Record<string, any> = {};
for (const cs of [CONDITION_CLINICAL_CS, GENDER_CS, ICD_CS, OBS_CAT_CS]) CODE_SYSTEMS[cs.url] = cs;

export const VALUE_SETS: Record<string, any> = {
  "http://hl7.org/fhir/ValueSet/condition-clinical": {
    resourceType: "ValueSet",
    url: "http://hl7.org/fhir/ValueSet/condition-clinical",
    title: "Condition Clinical Status Codes",
    compose: { include: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical" }] },
  },
  "http://hl7.org/fhir/ValueSet/administrative-gender": {
    resourceType: "ValueSet",
    url: "http://hl7.org/fhir/ValueSet/administrative-gender",
    compose: { include: [{ system: "http://hl7.org/fhir/administrative-gender" }] },
  },
  "http://example.tw/ValueSet/icd": {
    resourceType: "ValueSet",
    url: "http://example.tw/ValueSet/icd",
    compose: { include: [{ system: "http://example.tw/CodeSystem/icd" }] },
  },
};

export function fakeDeps(): TerminologyDeps {
  return {
    loadValueSet: async (url) => VALUE_SETS[url.split("|")[0]] ?? null,
    loadCodeSystem: async (url) => (CODE_SYSTEMS[url] ? indexCodeSystem(CODE_SYSTEMS[url]) : null),
    lookupExternal: async () => null,
    externalSystemHeld: async () => false,
  };
}

export class FakeResolver implements ValidatorResolver {
  async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    return SDS[url.split("|")[0]] ?? null;
  }
  async fetchValueSet(url: string): Promise<Record<string, any> | null> {
    return VALUE_SETS[url.split("|")[0]] ?? null;
  }
  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    const vs = VALUE_SETS[url.split("|")[0]];
    if (!vs) return undefined;
    return composeContains(vs.compose, system, code, fakeDeps());
  }
  async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
    const raw = CODE_SYSTEMS[system];
    if (!raw) return system.startsWith("http://unitsofmeasure.org") ? { status: "silent" } : { status: "unknown-system" };
    const idx = indexCodeSystem(raw);
    const c = findConcept(idx, code);
    if (!c) return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}'` };
    if (display !== null && !c.designations.some((d) => d.toLowerCase() === display.toLowerCase())) {
      return { status: "invalid-display", severity: "error", message: `Wrong Display Name '${display}'` };
    }
    return { status: "ok" };
  }
}
