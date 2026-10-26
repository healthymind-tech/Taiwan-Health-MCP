/**
 * Value slots of a FHIR resource for the record checks: the places where a field needs a structured
 * value (Identifier.value, Coding.code, date / dateTime / instant, Quantity, Reference, HumanName
 * parts, ContactPoint.value, Observation.valueString, lotNumber, the text of a CodeableConcept that
 * has no code — or only placeholder codes (ISSUES_v15.3) — and the Dosage.text of a medication
 * resource (ISSUES_v15.3)). Narrative (Narrative.div, Annotation, *.note / description / conclusion,
 * *String choice types other than Observation.valueString) is never a slot.
 *
 * Datatypes are recognised from the JSON shape and the element name (no StructureDefinition needed),
 * so the walk is pure and the same in every tool.
 */
import { absenceOf } from "./lexicon.js";

type Json = Record<string, any>;

export type SlotKind =
  | "identifier"
  | "coding"
  | "cc-text"
  | "date"
  | "quantity"
  | "reference"
  | "ref-display"
  | "name-part"
  | "telecom"
  | "value-string"
  | "lot"
  /** 1.2.0 (ISSUES_v15.3 R1): Dosage.text of a medication resource (the dose written as text). */
  | "dosage-text";

export interface Slot {
  kind: SlotKind;
  /** Instance path of the value (Bundle.entry[0].resource.identifier[0].value / Patient.identifier[0].value). */
  path: string;
  /** Generic path without indices, from the resource type (Patient.identifier.value, Observation.component.valueQuantity). */
  gpath: string;
  value: unknown;
  /** The datatype node (Identifier, Coding, CodeableConcept, Quantity, Reference …). */
  holder: Json | null;
  /** The resource the slot belongs to (contained resources are their own). */
  resource: Json;
  /** Bundle entry index (null outside a Bundle entry). */
  entry: number | null;
}

const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

const NULL_FLAVOR_SYSTEMS = /^https?:\/\/terminology\.hl7\.org\/CodeSystem\/(v3-NullFlavor|data-absent-reason)$/u;

/**
 * ISSUES_v15.3 R1: a Coding that carries no concept — no code, an empty code, a NullFlavor / data-absent-reason
 * code (UNK, ASKU, NI …), or a code that is itself an absence word / placeholder (unknown, TBD, --, xxx). A
 * CodeableConcept whose codings are all placeholders is read by its text, like one without coding.
 */
export function placeholderCoding(c: unknown): boolean {
  if (!isObj(c)) return true;
  const code = typeof c.code === "string" ? c.code.trim() : "";
  if (!code) return true;
  if (typeof c.system === "string" && NULL_FLAVOR_SYSTEMS.test(c.system)) return true;
  return absenceOf(code, true) !== null;
}

const DOSAGE_KEYS = new Set(["dosageInstruction", "dosage"]);
const MED_RESOURCES = new Set(["MedicationRequest", "MedicationStatement", "MedicationAdministration", "MedicationDispense"]);

const PERSON_TYPES = new Set(["Patient", "Practitioner", "RelatedPerson", "Person"]);
const SKIP_KEYS = new Set(["meta", "id", "implicitRules", "language", "resourceType", "fullUrl", "request", "response", "search", "link"]);
const NARRATIVE_KEYS = new Set(["note", "description", "comment", "summary", "conclusion", "dosageInstruction", "dosage", "address", "presentedForm", "attachment", "content", "section", "div", "patientInstruction"]);
/** Element names whose object value is a CodeableConcept even when it has only `text`. */
const RE_CC_KEY = /(^code$|Code$|CodeableConcept$|^reasonCode$|^category$|^type$|^bodySite$|^route$|^method$|^form$|^vaccineCode$|^substance$|^manifestation$|^severity$|^specialty$|^serviceType$|^qualification$)/u;
const RE_QUANTITY_KEY = /(Quantity$|^quantity$|^low$|^high$|^numerator$|^denominator$|^expectedSupplyDuration$|^length$|^valueDuration$|^valueAge$|^onsetAge$|^dose$|^rateQuantity$)/u;
/** date / dateTime / instant primitives by element name. */
const RE_DATE_KEY = /(DateTime$|Date$|Instant$|^authoredOn$|^issued$|^date$|^timestamp$|^dateAsserted$|^created$|^recorded$|^sent$|^started$|^lastOccurrence$|^whenHandedOver$|^whenPrepared$|^receivedTime$|^birthDate$)/u;
const PERIOD_KEYS = /(^period$|Period$|^validityPeriod$|^billablePeriod$)/u;

function walkResource(resource: Json, base: string, entry: number | null, out: Slot[]): void {
  const rt = String(resource.resourceType ?? "Resource");
  const push = (kind: SlotKind, path: string, gparts: string[], value: unknown, holder: Json | null): void => {
    out.push({ kind, path, gpath: [rt, ...gparts].join("."), value, holder, resource, entry });
  };

  const visit = (node: unknown, path: string, gparts: string[], key: string, parentKey: string): void => {
    if (Array.isArray(node)) {
      node.forEach((it, i) => visit(it, `${path}[${i}]`, gparts, key, parentKey));
      return;
    }
    if (isObj(node)) {
      if (key === "contained" && typeof node.resourceType === "string") {
        walkResource(node, path, entry, out);
        return;
      }
      if (key === "extension" || key === "modifierExtension") {
        const url = typeof node.url === "string" ? node.url : "";
        if (url.endsWith("StructureDefinition/data-absent-reason")) return;
      }
      // 1.3.0 (ISSUES_v15.4 R1): dataAbsentReason is the FHIR way to say the value is absent — a side field the empty-shell
      // check reads (emptyShell.ts), never a value slot
      if (key === "dataAbsentReason") return;
      if (key === "identifier") {
        push("identifier", `${path}.value`, [...gparts, "value"], node.value, node);
        return;
      }
      if (key === "name" && PERSON_TYPES.has(rt) && ("text" in node || "family" in node || "given" in node)) {
        if (typeof node.text === "string") push("name-part", `${path}.text`, [...gparts, "text"], node.text, node);
        if (typeof node.family === "string") push("name-part", `${path}.family`, [...gparts, "family"], node.family, node);
        if (Array.isArray(node.given)) node.given.forEach((g: unknown, i: number) => push("name-part", `${path}.given[${i}]`, [...gparts, "given"], g, node));
        return;
      }
      if (key === "telecom") {
        if ("value" in node) push("telecom", `${path}.value`, [...gparts, "value"], node.value, node);
        return;
      }
      if (typeof node.reference === "string" || (("display" in node || "identifier" in node) && Object.keys(node).every((k) => ["reference", "display", "type", "identifier", "extension"].includes(k)) && !RE_CC_KEY.test(key))) {
        if (typeof node.reference === "string") push("reference", `${path}.reference`, [...gparts, "reference"], node.reference, node);
        else if (typeof node.display === "string") push("ref-display", `${path}.display`, [...gparts, "display"], node.display, node);
        if (isObj(node.identifier)) push("identifier", `${path}.identifier.value`, [...gparts, "identifier", "value"], node.identifier.value, node.identifier);
        return;
      }
      if (Array.isArray(node.coding) || (RE_CC_KEY.test(key) && "text" in node && Object.keys(node).every((k) => ["text", "extension", "id"].includes(k)))) {
        const codings: unknown[] = Array.isArray(node.coding) ? node.coding : [];
        let coded = false;
        codings.forEach((c, i) => {
          if (!isObj(c)) return;
          if ("code" in c) {
            if (!placeholderCoding(c)) coded = true;
            push("coding", `${path}.coding[${i}].code`, [...gparts, "coding", "code"], c.code, c);
          }
        });
        if (!coded && typeof node.text === "string") push("cc-text", `${path}.text`, [...gparts, "text"], node.text, node);
        return;
      }
      if ("code" in node && ("system" in node || "display" in node) && !("value" in node) && !("unit" in node) && !RE_QUANTITY_KEY.test(key)) {
        push("coding", `${path}.code`, [...gparts, "code"], node.code, node);
        return;
      }
      if (RE_QUANTITY_KEY.test(key) && !Array.isArray(node.coding) && ("value" in node || "unit" in node || "code" in node || "system" in node || Object.keys(node).length === 0)) {
        push("quantity", `${path}.value`, [...gparts], node.value, node);
        return;
      }
      if (gparts.length > 0 && NARRATIVE_KEYS.has(key) && key !== "dosageInstruction" && key !== "dosage") return;
      if (DOSAGE_KEYS.has(key) && MED_RESOURCES.has(rt) && typeof node.text === "string") push("dosage-text", `${path}.text`, [...gparts, "text"], node.text, node);
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith("_")) continue;
        if (gparts.length === 0 && (SKIP_KEYS.has(k) || k === "text")) continue;
        if (k === "text" && isObj(v) && "div" in v) continue;
        visit(v, `${path}.${k}`, [...gparts, k], k, key);
      }
      return;
    }
    if (typeof node === "string") {
      if (RE_DATE_KEY.test(key) || ((key === "start" || key === "end") && PERIOD_KEYS.test(parentKey))) push("date", path, gparts, node, null);
      else if (key === "valueString" && rt === "Observation") push("value-string", path, gparts, node, null);
      else if (key === "lotNumber") push("lot", path, gparts, node, null);
    }
  };

  for (const [k, v] of Object.entries(resource)) {
    if (SKIP_KEYS.has(k) || k === "text" || k.startsWith("_")) continue;
    if (k === "entry" && rt === "Bundle") continue;
    if (k === "note" || k === "description") continue;
    visit(v, `${base}.${k}`, [k], k, "");
  }
}

/** Slots of a resource (paths from `<ResourceType>`) or of a Bundle and its entries (paths from `Bundle`). */
export function slotsOf(root: Json): Slot[] {
  const out: Slot[] = [];
  if (!isObj(root)) return out;
  if (root.resourceType === "Bundle") {
    walkResource(root, "Bundle", null, out);
    const entries: unknown[] = Array.isArray(root.entry) ? root.entry : [];
    entries.forEach((e, i) => {
      if (isObj(e) && isObj(e.resource) && typeof e.resource.resourceType === "string") walkResource(e.resource, `Bundle.entry[${i}].resource`, i, out);
    });
    return out;
  }
  walkResource(root, String(root.resourceType ?? "Resource"), null, out);
  return out;
}

/** Resources of the instance with their path prefix and entry index (a Bundle's entries; else the resource). */
export function resourcesOf(root: Json): Array<{ resource: Json; base: string; entry: number | null; fullUrl: string | null }> {
  if (!isObj(root)) return [];
  if (root.resourceType !== "Bundle") return [{ resource: root, base: String(root.resourceType ?? "Resource"), entry: null, fullUrl: null }];
  const out: Array<{ resource: Json; base: string; entry: number | null; fullUrl: string | null }> = [];
  (Array.isArray(root.entry) ? root.entry : []).forEach((e: unknown, i: number) => {
    if (isObj(e) && isObj(e.resource) && typeof e.resource.resourceType === "string") {
      out.push({ resource: e.resource, base: `Bundle.entry[${i}].resource`, entry: i, fullUrl: typeof e.fullUrl === "string" ? e.fullUrl : null });
    }
  });
  return out;
}
