/**
 * Port of org.hl7.fhir.validation.instance.type.CodeSystemValidator (tag 7.0.1), the checks that run when the resource
 * being validated is itself a CodeSystem: metaChecks (supplement / content / count), the supplement checks, property
 * definitions and values, duplicate codes, designations. Not ported: the for-publication rules (checkShareableCodeSystem,
 * hints), the all-codes value set rules, and property value sets found through the concept-properties CodeSystem.
 * Hints (information) are not reported; rules and warnings keep their Messages.properties wording.
 */
import { isAbsoluteUrl } from "./fhirSpecialSystems.js";

type Json = Record<string, any>;

export interface ResourceIssue {
  severity: "error" | "warning";
  path: string;
  code: string;
  message: string;
}

export interface CodeSystemResourceDeps {
  /** A CodeSystem by canonical (`url|version` honoured), null when not held. */
  fetchCodeSystem(url: string): Promise<Json | null>;
  /** Code check against a code system: "invalid" (rejected), "unsupported" (system unknown), "ok" (accepted or undecided). */
  codeStatus(system: string, code: string, version: string | null): Promise<{ status: "ok" | "invalid" | "unsupported"; message?: string }>;
}

/** CodeSystemValidator.KnownProperty: uri tail (= code) → property type. */
const KNOWN_PROPERTIES: Record<string, string> = {
  status: "code",
  inactive: "boolean",
  effectiveDate: "dateTime",
  deprecationDate: "dateTime",
  retirementDate: "dateTime",
  notSelectable: "boolean",
  parent: "code",
  child: "code",
  partOf: "code",
  synonym: "code",
  comment: "string",
  itemWeight: "decimal",
};
const KNOWN_URI = "http://hl7.org/fhir/concept-properties#";
const INTERNAL_CODE_PROPERTIES = new Set(["child", "parent", "partOf", "synonym"]);

interface PropertyDef {
  type: string | null;
  /** CodeValidationRule of a `code` property: INTERNAL_CODE (error) or the default INTERNAL_CODE_WARNING. */
  rule: "error" | "warning" | null;
}

const has = (v: unknown): v is string => typeof v === "string" && v !== "";
const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

function countConcepts(list: unknown): number {
  let n = 0;
  for (const c of asList(list)) n += 1 + countConcepts(c.concept);
  return n;
}

function valueType(prop: Json): { type: string; value: unknown } | null {
  for (const [k, v] of Object.entries(prop)) {
    if (!k.startsWith("value") || k.length === 5 || v === undefined) continue;
    const t = k.slice(5);
    return { type: t === "Coding" || t === "Code" ? (t === "Coding" ? "Coding" : "code") : t[0].toLowerCase() + t.slice(1), value: v };
  }
  return null;
}

export async function validateCodeSystemResource(cs: Json, path: string, deps: CodeSystemResourceDeps): Promise<ResourceIssue[]> {
  const out: ResourceIssue[] = [];
  const err = (p: string, message: string, code = "business-rule"): void => void out.push({ severity: "error", path: p, code, message });
  const warn = (p: string, message: string, code = "business-rule"): void => void out.push({ severity: "warning", path: p, code, message });
  const url = has(cs.url) ? cs.url : null;
  const content = has(cs.content) ? cs.content : null;
  const supp = has(cs.supplements) ? cs.supplements : null;
  const concepts = asList(cs.concept);
  const count = countConcepts(cs.concept);

  // metaChecks (CodeSystemValidator:794)
  if (supp !== null) {
    if (content !== "supplement") err(`${path}.content`, "CodeSystem Supplements SHALL have a content value of 'supplement'");
    if (cs.caseSensitive !== undefined) err(`${path}.caseSensitive`, "CodeSystems SHOULD NOT have a stated value for the caseSensitive element when they are a supplement");
  } else {
    const isHL7 = url !== null && (url.includes("hl7.org") || url.includes("fhir.org"));
    if (content === null) {
      const m = "element so that users know the status and meaning of the code system clearly";
      if (isHL7) err(path, `HL7 Defined CodeSystems SHALL have a stated value for the content ${m}`);
      else warn(path, `CodeSystems SHOULD have a stated value for the content ${m}`);
    } else if (content === "supplement") {
      err(`${path}.content`, "CodeSystem Supplements with a content value of 'supplement' SHALL have a supplements element that specifies which code system is being supplemented");
    }
    if (cs.caseSensitive === undefined && isHL7) {
      warn(path, "HL7 Defined CodeSystems SHOULD have a stated value for the caseSensitive element so that users know the status and meaning of the code system clearly");
    }
    if (!has(cs.hierarchyMeaning) && isHL7 && concepts.some((c) => asList(c.concept).length > 0)) {
      warn(path, "HL7 Defined CodeSystems SHOULD have a stated value for the hierarchyMeaning element so that users know the status and meaning of the code system clearly");
    }
  }
  if (count === 0 && content === "complete") warn(path, "When a CodeSystem has content = 'complete', it doesn't make sense for there to be no concepts defined");
  if (typeof cs.count === "number" && cs.count > -1 && content !== null) {
    const stated = cs.count;
    if (content === "complete" && count !== stated) err(`${path}.count`, `The code system is complete, but the number of concepts (${count}) does not match the stated total number (${stated})`, "invalid");
    if ((content === "example" || content === "fragment") && !(count < stated)) warn(`${path}.count`, `The code system is a fragment/example, but the number of concepts (${count}) exceeds or matches the stated total number (${stated})`, "invalid");
    if (content === "supplement" && supp !== null) {
      const base = await deps.fetchCodeSystem(supp);
      if (base && count !== base.count) err(`${path}.count`, `The code system supplement states the total number of concepts as ${stated}, but this is different to the underlying code system that states a value of ${base.count}`, "invalid");
    }
  }
  if (content === "not-present" && concepts.length) err(`${path}.concept[0]`, "The code system says it has no content present, but concepts are found", "invalid");

  // supplement checks (CodeSystemValidator:199-262)
  if (content === "supplement" || supp !== null) {
    if (supp === null) {
      err(path, "The code system is marked as a supplement, but it does not define what code system it supplements");
    } else {
      const [suppUrl, suppVersion] = supp.includes("|") ? [supp.slice(0, supp.indexOf("|")), supp.slice(supp.indexOf("|") + 1)] : [supp, null];
      const base = await deps.fetchCodeSystem(supp);
      if (base && has(base.hierarchyMeaning) && has(cs.hierarchyMeaning) && base.hierarchyMeaning !== cs.hierarchyMeaning) {
        err(path, `The supplement declares a hierarchyMeaning of '${cs.hierarchyMeaning}' that doesn't match that in the base code system '${base.hierarchyMeaning}'`);
      }
      let systemOk = true;
      for (let i = 0; i < concepts.length && systemOk; i++) {
        const code = concepts[i].code;
        if (!has(code)) continue;
        const r = await deps.codeStatus(suppUrl, code, suppVersion);
        if (r.status === "unsupported") {
          warn(`${path}.concept[${i}]`, `CodeSystem ${supp} cannot be found, so can't check if concepts are valid`);
          systemOk = false;
        } else if (r.status === "invalid") {
          err(`${path}.concept[${i}]`, `The code '${code}' is not declared in the base CodeSystem ${supp} so is not valid in the supplement`);
        }
      }
    }
  }

  // properties (checkPropertyDefinition:313)
  const properties = new Map<string, PropertyDef>();
  for (const [i, property] of asList(cs.property).entries()) {
    const p = `${path}.property[${i}]`;
    const uri = has(property.uri) ? property.uri : null;
    const code = has(property.code) ? property.code : null;
    const type = has(property.type) ? property.type : null;
    const pd: PropertyDef = { type, rule: type === "code" ? "warning" : null };
    let ukp: string | null = null;
    if (uri !== null) {
      if (!isAbsoluteUrl(uri)) {
        err(p, `A property URI must be an absolute URI, but '${uri}' is not`);
      } else {
        if (properties.has(uri)) err(p, `A property is already defined with the URI '${uri}'`);
        else properties.set(uri, pd);
        if (uri.includes("://hl7.org/fhir")) {
          const tail = uri.startsWith(KNOWN_URI) ? uri.slice(KNOWN_URI.length) : null;
          if (tail !== null && tail in KNOWN_PROPERTIES) ukp = tail;
          else {
            const baseSpec = url !== null && url.startsWith("http://hl7.org/fhir/") && !url.slice(20).includes("/");
            const selfRef = url !== null && uri.startsWith(url);
            if (!baseSpec && !selfRef) err(p, `Unknown CodeSystem Property '${uri}'. If you are creating your own property, do not create it in the HL7 namespace`);
          }
        }
      }
    }
    if (code !== null) {
      if (properties.has(code)) err(p, `A property is already defined with the code '${code}'`);
      else properties.set(code, pd);
    }
    if (ukp !== null) {
      if (code !== null && code in KNOWN_PROPERTIES && code !== ukp) {
        err(p, `The URI '${uri}' is normally assigned the code '${ukp}'. Using the code '${code}' will usually create confusion in ValueSet filters etc`);
      }
      if (type !== null && type !== KNOWN_PROPERTIES[ukp]) err(p, `Wrong type '${type}': The URI '${uri}' identifies a property that has the type '${KNOWN_PROPERTIES[ukp]}'`);
      if (INTERNAL_CODE_PROPERTIES.has(ukp)) pd.rule = "error";
      else if (ukp === "status") pd.rule = null; // VS_WARNING against the concept-status value set: not reproduced
    }
    if (uri === null && code !== null && code in KNOWN_PROPERTIES) {
      warn(p, `This property has only the standard code ('${code}') but not the standard URI '${KNOWN_URI}${code}', so it has no clearly defined meaning in the terminology ecosystem`);
      if (type !== null && type !== KNOWN_PROPERTIES[code]) warn(p, `Wrong type '${type}': The code '${code}' identifies a property that has the type '${KNOWN_PROPERTIES[code]}'`);
    }
  }

  // concepts (checkConcept:578, checkDesignation:653)
  const codes = new Set<string>();
  const checkConcept = (concept: Json, p: string): void => {
    const code = has(concept.code) ? concept.code : null;
    if (code !== null && codes.has(code)) err(p, `The code '${code}' has already been defined`);
    if (code !== null) codes.add(code);
    const rlang = has(cs.language) ? cs.language : null;
    const display = has(concept.display) ? concept.display : null;
    for (const d of asList(concept.designation)) {
      if (d.use !== undefined || d.additionalUse !== undefined) continue;
      const lang = has(d.language) ? d.language : null;
      const clash = display !== null && display !== d.value;
      if (rlang === null && lang === null && clash) warn(p, `The designation '${d.value}' has no use and no language, so is not differentiated from the base display ('${display}')`);
      else if (rlang !== null && (lang === null || rlang === lang) && clash) warn(p, `The designation '${d.value}' has no use and is in the same language ('${rlang}'), so is not differentiated from the base display ('${display}')`);
    }
    asList(concept.concept).forEach((c, i) => checkConcept(c, `${p}.concept[${i}]`));
  };
  concepts.forEach((c, i) => checkConcept(c, `${path}.concept[${i}]`));

  // property values (checkConceptProps:634, checkPropertyValue:681)
  const checkProps = async (concept: Json, p: string): Promise<void> => {
    for (const [i, prop] of asList(concept.property).entries()) {
      const pp = `${p}.property[${i}]`;
      const code = has(prop.code) ? prop.code : null;
      if (code === null) continue;
      const defn = properties.get(code) ?? null;
      if (!defn) warn(pp, `The property '${code}' has no definition in CodeSystem.property. Many terminology tools won't know what to do with it`);
      const value = valueType(prop);
      if (!value) {
        err(pp, `The property '${code}' has no value, and cannot be understood`);
        continue;
      }
      if (defn && defn.type !== null) {
        if (value.type !== defn.type) {
          err(pp, `The property '${code}' has the invalid type '${value.type}', when it is defined to have the type '${defn.type}'`);
        } else if (value.type === "code" && typeof value.value === "string" && defn.rule !== null) {
          // checkCodeProperty: a supplement's codes are those of its base code system
          let known = codes.has(value.value);
          if (supp !== null) known = (await deps.codeStatus(supp.split("|")[0], value.value, null)).status !== "invalid";
          const message = `The code '${value.value}' is not a valid code in this code system`;
          if (!known && (defn.rule === "error" || supp !== null)) err(pp, message, "invalid");
          else if (!known) warn(pp, message, "invalid");
        }
      }
      if (code === "synonym" && typeof value.value === "string" && !codes.has(value.value)) {
        warn(pp, `The synonym '${value.value}' is not also defined in the code system. The Synonym property should only used to declare equivalence to other existing codes`);
      }
    }
    for (const [i, c] of asList(concept.concept).entries()) await checkProps(c, `${p}.concept[${i}]`);
  };
  for (const [i, c] of concepts.entries()) await checkProps(c, `${path}.concept[${i}]`);
  return out;
}
