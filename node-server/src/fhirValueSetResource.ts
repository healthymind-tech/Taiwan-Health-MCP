/**
 * Port of org.hl7.fhir.validation.instance.type.ValueSetValidator (tag 7.0.1) + the codesystem checkers
 * (CodeSystemChecker, CodeSystemBasedChecker, SnomedCTChecker.rulesForFilter), the checks that run when the resource
 * being validated is itself a ValueSet: value set parameters, include.system (canonical syntax, absolute, contained),
 * includes that name a supplement or a ValueSet, enumerated concepts, filters (property, operation, value, cqf-expression).
 * Not ported: the for-publication rules, hints, expansion checks (validateValueSetExpansion), the ECL parser behind a
 * SNOMED `constraint` filter (the server's parser, SnomedCTChecker.checkFilterValue) and LOINC / RxNorm property lists.
 */
import { isAbsoluteUrl } from "./fhirSpecialSystems.js";
import type { ResourceIssue } from "./fhirCodeSystemResource.js";

type Json = Record<string, any>;

export interface ValueSetResourceDeps {
  fetchCodeSystem(url: string): Promise<Json | null>;
  fetchValueSet(url: string): Promise<Json | null>;
  codeStatus(system: string, code: string, version: string | null): Promise<{ status: "ok" | "invalid" | "unsupported"; message?: string }>;
  allowExamples: boolean;
  isExampleUrl(url: string): boolean;
}

const PARAM_EXT = "http://hl7.org/fhir/tools/StructureDefinition/valueset-parameter";
const CQF_EXPRESSION = "http://hl7.org/fhir/StructureDefinition/cqf-expression";
const has = (v: unknown): v is string => typeof v === "string" && v !== "";
const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

type FilterType = "Boolean" | "String" | "Code" | "DateTime" | "Decimal" | "Integer" | "Coding";
interface Rules {
  type: FilterType | null;
  codeValidation: "Error" | "Warning" | "None" | null;
  ops: string[];
  active?: boolean;
}
const R4_CONCEPT_OPS = ["=", "in", "is-a", "descendent-of", "is-not-a", "generalizes", "not-in"];

/** CodeSystemChecker.listPropertyNames + rulesForFilter (R4). */
function baseRules(property: string, ops: string[]): Rules | null {
  switch (property) {
    case "concept":
      return { type: "Code", codeValidation: "Error", ops: [...new Set([...ops, ...R4_CONCEPT_OPS])] };
    case "code":
      return { type: "Code", codeValidation: "Error", ops: [...new Set([...ops, "regex", ...R4_CONCEPT_OPS])] };
    case "status":
    case "synonym":
      return { type: "Code", codeValidation: "None", ops };
    case "inactive":
    case "notSelectable":
      return { type: "Boolean", codeValidation: null, ops };
    case "effectiveDate":
    case "deprecationDate":
    case "retirementDate":
      return { type: "DateTime", codeValidation: null, ops };
    case "parent":
    case "child":
    case "partOf":
      return { type: "Code", codeValidation: "Error", ops };
    case "itemWeight":
      return { type: "Decimal", codeValidation: null, ops };
    default:
      return null;
  }
}

/** The checker for a system: null = known names are not reproduced here (LOINC, RxNorm …), the filter is not judged. */
function rulesForFilter(system: string, cs: Json | null, property: string): { known: boolean; rules: Rules | null } | null {
  if (system === "http://snomed.info/sct") {
    if (property === "constraint") return { known: true, rules: { type: "String", codeValidation: null, ops: ["="], active: true } };
    if (property === "expressions" || property === "inactive") return { known: true, rules: { type: "Boolean", codeValidation: null, ops: ["=", "in"] } };
    if (property === "concept") return { known: true, rules: { type: "Code", codeValidation: "Error", ops: ["is-a", "is-not-a", "in", "descendent-of", "descendent-leaf"] } };
    return { known: /^\d+$/.test(property), rules: { type: "Code", codeValidation: "Error", ops: ["=", "in"] } };
  }
  // CodeSystemBasedChecker, or GeneralCodeSystemChecker when the CodeSystem is not held
  if (!cs) {
    const generic = ["concept", "code", "status", "inactive", "effectiveDate", "deprecationDate", "retirementDate", "notSelectable", "synonym", "comment", "itemWeight"].includes(property);
    return { known: generic, rules: baseRules(property, []) };
  }
  const ops: string[] = [];
  for (const f of asList(cs.filter)) if (f.code === property) for (const o of Array.isArray(f.operator) ? f.operator : []) ops.push(String(o));
  for (const p of asList(cs.property)) {
    if (p.code !== property || !has(p.type)) continue;
    switch (p.type) {
      case "boolean":
        return { known: true, rules: { type: "Boolean", codeValidation: null, ops } };
      case "code":
        return { known: true, rules: { type: "Code", codeValidation: "Warning", ops } };
      case "Coding":
        return { known: true, rules: { type: "Coding", codeValidation: null, ops } };
      case "dateTime":
        return { known: true, rules: { type: "DateTime", codeValidation: null, ops } };
      case "decimal":
        return { known: true, rules: { type: "Decimal", codeValidation: null, ops } };
      case "integer":
        return { known: true, rules: { type: "Integer", codeValidation: null, ops } };
      case "string":
        return { known: true, rules: null };
    }
  }
  const known =
    ["concept", "code", "status", "inactive", "effectiveDate", "deprecationDate", "retirementDate", "notSelectable", "synonym", "comment", "itemWeight"].includes(property) ||
    (has(cs.hierarchyMeaning) && ["parent", "child", "partOf"].includes(property)) ||
    asList(cs.filter).some((f) => f.code === property);
  return { known, rules: baseRules(property, ops) };
}

/** `%name` constants of a FHIRPath expression outside strings (ValueSetValidator.scanForConstants). */
function constantsOf(expression: string): string[] {
  return [...expression.replace(/'(?:[^'\\]|\\.)*'/g, "''").matchAll(/%`?([A-Za-z][A-Za-z0-9_.-]*)`?/g)].map((m) => m[1]);
}

/** The FHIRPath lexer's complaint about a bare `$` (FHIRPathLexer: the position is that of the token after the next). */
function fhirPathSyntaxError(expression: string): string | null {
  const m = /(^|[\s(])\$(?![A-Za-z])/.exec(expression);
  if (!m) return null;
  const at = m.index + m[1].length;
  const rest = /^\s*[A-Za-z0-9_]*/.exec(expression.slice(at + 1))?.[0] ?? "";
  return `Error @1, ${at + 1 + rest.length + 1}: Found $ expecting a valid token name`;
}

function javaRegexOk(v: string): string | null {
  try {
    new RegExp(v, "u");
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const COMPARATOR = /^(eq|ne|gt|lt|ge|le|sa|eb|ap)/;
const DATE_RE = /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/;

export async function validateValueSetResource(vs: Json, path: string, deps: ValueSetResourceDeps): Promise<ResourceIssue[]> {
  const out: ResourceIssue[] = [];
  const err = (p: string, message: string, code = "invalid"): void => void out.push({ severity: "error", path: p, code, message });
  const warn = (p: string, message: string, code = "invalid"): void => void out.push({ severity: "warning", path: p, code, message });

  const params = new Map<string, boolean>();
  for (const ext of asList(vs.extension)) {
    if (ext.url !== PARAM_EXT) continue;
    const name = asList(ext.extension).find((e) => e.url === "name");
    const v = name ? (Object.entries(name).find(([k]) => k.startsWith("value"))?.[1] as unknown) : null;
    if (has(v)) params.set(v, false);
  }

  const checkFilterValue = async (p: string, system: string, version: string | null, property: string, value: string, rules: Rules): Promise<void> => {
    switch (rules.type) {
      case "Boolean":
        if (value !== "true" && value !== "false") err(p, `The value for a filter based on property '${property}' must be either 'true' or 'false', not '${value}'`);
        break;
      case "Code": {
        if (value.trim() !== value) err(p, `The value for a filter based on property '${property}' must be a valid code, not '${value}'`);
        if (rules.codeValidation === "Error" || rules.codeValidation === "Warning") {
          const r = await deps.codeStatus(system, value, version);
          if (r.status === "invalid") {
            const m = `The value for a filter based on property '${property}' must be a valid code from the system '${system}', and '${value}' is not (${r.message ?? ""})`;
            if (rules.codeValidation === "Error") err(p, m);
            else warn(p, m);
          }
        }
        break;
      }
      case "DateTime": {
        const v = value.replace(COMPARATOR, "");
        if (!DATE_RE.test(v)) err(p, `The value for a filter based on property '${property}' must be a valid date(/time), not '${value}'`);
        break;
      }
      case "Decimal": {
        const v = value.replace(COMPARATOR, "");
        if (!/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) err(p, `The value for a filter based on property '${property}' must be a decimal value, not '${value}'`);
        break;
      }
      case "Integer": {
        const v = value.replace(COMPARATOR, "");
        if (!/^[-+]?\d+$/.test(v)) err(p, `The value for a filter based on property '${property}' must be integer value, not '${value}'`);
        break;
      }
      case "Coding": {
        // Coding.fromLiteral: system(|version)#code; the older search pattern system|code is a warning
        let sys: string | null = null;
        let ver: string | null = null;
        let code: string | null = null;
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s|]+\|\S+$/.test(value) && !value.includes("#")) {
          warn(p, `The value for a filter based on property '${property}' should be in the format system(|version)#code, not the coding search pattern '${value}'`);
          sys = value.slice(0, value.lastIndexOf("|"));
          code = value.slice(value.lastIndexOf("|") + 1);
        } else if (value.includes("#")) {
          const left = value.slice(0, value.indexOf("#"));
          code = value.slice(value.indexOf("#") + 1);
          sys = left.includes("|") ? left.slice(0, left.indexOf("|")) : left;
          ver = left.includes("|") ? left.slice(left.indexOf("|") + 1) : null;
        }
        if (!sys || !code) {
          err(p, `The value for a filter based on property '${property}' must be in the format system(|version)#code, not '${value}'`);
        } else {
          const r = await deps.codeStatus(sys, code, ver);
          if (r.status === "invalid") err(p, `The value for a filter based on property '${property}' is '${value}' which is not a valid code (${r.message ?? ""})`);
        }
        break;
      }
      default:
        break;
    }
  };

  const checkFilter = async (filter: Json, p: string, system: string, version: string | null, cs: Json | null): Promise<void> => {
    const property = has(filter.property) ? filter.property : null;
    if (property === null) return;
    const op = has(filter.op) ? filter.op : null;
    const value = typeof filter.value === "string" ? filter.value : null;
    const exprExt = asList(filter._value?.extension).find((e) => e.url === CQF_EXPRESSION) ?? null;
    const judged = rulesForFilter(system, cs, property);
    if (judged === null || !judged.known || judged.rules === null) return; // VALUESET_UNKNOWN_FILTER_PROPERTY(_NO_CS): warning / hint at most
    const rules = judged.rules;
    if (rules.ops.length && op !== null && !rules.ops.includes(op)) {
      err(p, `The operation '${op}' is not allowed for property '${property}' in system '${system}'. Allowed ops: ${rules.ops.join(",")}`);
    }
    if (value === null) {
      const expr = exprExt && typeof exprExt.valueExpression === "object" ? exprExt.valueExpression : null;
      if (!expr) {
        err(p, "A filter needs a value and or an expression for the value");
        return;
      }
      const ep = `${p}.extension[0].valueExpression`;
      if (expr.language !== "text/fhirpath") {
        err(ep, `A ValueSet expression language must be 'text/fhirpath' not '${expr.language}'`);
        return;
      }
      const expression = String(expr.expression ?? "");
      const syntax = fhirPathSyntaxError(expression);
      if (syntax) {
        err(ep, `The value of the expression '${expression}' is not a valid FHIRPath: ${syntax}`, "exception");
        return;
      }
      for (const name of constantsOf(expression)) {
        if (params.has(name)) params.set(name, true);
        else err(ep, `The filter parameter expression '${expression}' refers to the unknown parameter '${name}'`, "exception");
      }
      return;
    }
    if (exprExt) err(p, "A filter can't have both a value and and expression for the value at the same time");
    if (rules.active) return; // SnomedCTChecker.checkFilterValue validates the ECL on the terminology server
    if (op === "exists") {
      await checkFilterValue(p, system, version, property, value, { type: "Boolean", codeValidation: null, ops: [] });
    } else if (op === "regex") {
      const e = javaRegexOk(value);
      if (e !== null) err(p, `The value for a filter based on property '${property}' should be a valid regex, not '${value}' (err = '${e}')`);
      if (property === "concept") err(p, `Cannot apply a regex filter to the property '${property}' (usually regex filters are applied to the codes, or a named property of the code system)`);
    } else if (op === "in" || op === "not-in") {
      for (const v of value.split(",")) await checkFilterValue(p, system, version, property, v, rules);
    } else {
      await checkFilterValue(p, system, version, property, value, rules);
    }
  };

  const checkInclude = async (include: Json, p: string): Promise<void> => {
    let system = typeof include.system === "string" ? include.system : null;
    const version = has(include.version) ? include.version : null;
    if (system !== null && system.includes("|")) {
      const uver = system.slice(system.indexOf("|") + 1);
      system = system.slice(0, system.indexOf("|"));
      if (uver === "") warn(p, `Value set System reference '${system}' ends with a '|' which is suspicious. Note that the reference must not use the canonical version syntax; the version goes in the version property`);
      else if (version === null) err(p, `Value set System references must not use the canonical version syntax - the version '${uver}' should be in the version property, but that already contains 'null'`);
      else if (uver !== version) err(p, `Value set System references must not use the canonical version syntax - the version '${uver}' should be in the version property, but that already contains '${version}'`);
      else err(p, `Value set System references must not use the canonical version syntax - the version '${uver}' is already in the version property `);
    }
    const concepts = asList(include.concept);
    const filters = asList(include.filter);
    if (system === null) {
      if (filters.length || concepts.length) warn(p, "No System specified, so Concepts and Filters can't be checked", "business-rule");
      return;
    }
    if (!isAbsoluteUrl(system)) {
      err(
        p,
        system.startsWith("#")
          ? "URI values in ValueSet.compose.include.system must be absolute. To reference a contained code system, use the full CodeSystem URL and reference it using the http://hl7.org/fhir/StructureDefinition/valueset-system extension"
          : "URI values in ValueSet.compose.include.system must be absolute",
      );
    }
    if (system.startsWith("#")) {
      const matching: Json[] = [];
      for (const c of asList(vs.contained)) {
        if (`#${c.id}` !== system) continue;
        if (c.resourceType !== "CodeSystem") err(p, `The include system '${system}' is a reference to a contained resource, but the contained resource with that id is not a CodeSystem, it's a ${c.resourceType}`);
        else if (version === null || version === c.version) matching.push(c);
      }
      if (!matching.length) err(p, version === null ? `No matching contained code system found for system '${system}'` : `No matching contained code system found for system '${system}' version '${version}'`);
      else if (matching.length > 1) err(p, version === null ? `Multiple matching contained code systems found for system '${system}'` : `Multiple matching contained code systems found for system '${system}' version '${version}'`);
    }
    const cs = await deps.fetchCodeSystem(version ? `${system}|${version}` : system);
    let validateConcepts = true;
    if (cs) {
      if (cs.content === "supplement") {
        validateConcepts = false;
        const m = `which is a supplement. It must reference the underlying CodeSystem '${cs.supplements}' and use the http://hl7.org/fhir/StructureDefinition/valueset-supplement extension for the supplement`;
        err(p, version === null ? `The value set references CodeSystem '${system}' ${m}` : `The value set references CodeSystem '${system}' version '${version}' ${m}`);
      }
    } else {
      const svs = isAbsoluteUrl(system) ? await deps.fetchValueSet(version ? `${system}|${version}` : system) : null;
      if (svs) {
        validateConcepts = false;
        const systems = [...new Set(asList(svs.compose?.include).map((i) => i.system).filter(has))];
        if (!systems.length) err(p, `The system '${system}' is actually a value set`);
        else if (systems.length === 1) err(p, `The system '${system}' is actually a value set, which itself refers to the system '${systems[0]}' so that may be what is intended here`);
        else err(p, `The system '${system}' is actually a value set, which itself refers to the systems ${systems.join(", ")}`);
      }
    }
    if (validateConcepts) {
      for (const [i, concept] of concepts.entries()) {
        const code = has(concept.code) ? concept.code : null;
        if (code === null) continue;
        const r = await deps.codeStatus(system, code, version);
        if (r.status === "unsupported") {
          // validateValueSetIncludeConcept: the first concept tells whether the system can be validated at all
          if (version === null && deps.isExampleUrl(system) && !deps.allowExamples) err(p, `Example System '${system}' specified, which is illegal. Concepts and Filters can't be checked`, "business-rule");
          else if (version === null) warn(p, `Unknown System '${system}' specified, so Concepts and Filters can't be checked (Details: ${r.message ?? ""})`, "business-rule");
          else warn(p, `Unknown System/Version '${system}#${version}' specified, so Concepts and Filters can't be checked (Details: ${r.message ?? ""})`, "business-rule");
          break;
        }
        if (r.status === "invalid") {
          err(
            `${p}.concept[${i}]`,
            // (sic) VALUESET_INCLUDE_INVALID_CONCEPT_CODE_VER repeats {2}, the code
            version === null ? `The code '${code}' is not valid in the system ${system} (${r.message ?? ""})` : `The code '${code}' is not valid in the system ${system} version ${version} (${code})`,
            "business-rule",
          );
        }
      }
    }
    for (const [i, filter] of filters.entries()) await checkFilter(filter, `${p}.filter[${i}]`, system, version, cs);
  };

  const compose = vs.compose && typeof vs.compose === "object" ? vs.compose : null;
  if (compose) {
    for (const [i, inc] of asList(compose.include).entries()) await checkInclude(inc, `${path}.compose.include[${i}]`);
    for (const [i, exc] of asList(compose.exclude).entries()) await checkInclude(exc, `${path}.compose.exclude[${i}]`);
  }
  for (const [name, used] of params) if (!used) warn(path, `The value set parameter '${name}' is not used`, "business-rule");
  return out;
}
