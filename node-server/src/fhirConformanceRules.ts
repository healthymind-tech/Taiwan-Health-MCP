/**
 * Resource-specific rules of validator_cli 7.0.1 for conformance resources that have no clinical use:
 *
 *  - validateSearchParameter: instance/type/SearchParameterValidator.java
 *  - validateImplementationGuide: instance/type/ImplementationGuideValidator.java
 *
 * Message text is Messages.properties verbatim. Pure over the injected `fetchSearchParameter`.
 *
 * Not ported, with the Java reason:
 *  - checkExpression runs FHIRPathEngine.checkOnTypes, a full static type checker. Only its entry check is ported:
 *    a type name that opens a union leg must be one of the bases (or an ancestor of one), executeType l. 3497, else
 *    FHIRPATH_UNKNOWN_NAME. Deeper paths are not type-checked here.
 *  - checkDependency's package lookups (FilesystemPackageCacheManager, the package registry) need the package cache of
 *    the host running the CLI. The rules that read only the resource are ported.
 */

type Json = Record<string, any>;

export interface ConformanceIssue {
  severity: "error" | "warning" | "information";
  path: string;
  code: string;
  message: string;
}

export interface ConformanceRuleDeps {
  fetchSearchParameter(url: string): Promise<Json | null>;
  /** The type a type definition derives from, by the type's name (null at the root). */
  parentType(type: string): Promise<string | null>;
}

const SPECIFIC_USE = "http://hl7.org/fhir/StructureDefinition/version-specific-use";
const SEARCH_PARAMETER_BASE = "http://hl7.org/fhir/tools/StructureDefinition/searchparameter-base-type";
const CORE = "http://hl7.org/fhir/StructureDefinition/";

const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : x === undefined ? [] : [x]);

/** The `_base[i]` shadow of `base[i]`: where a primitive's extensions live in JSON. */
function baseShadow(sp: Json, i: number): Json | null {
  const s = Array.isArray(sp._base) ? sp._base[i] : i === 0 ? sp._base : undefined;
  return isObject(s) ? s : null;
}

/** BaseValidator.isForThisVersion l. 1794-1812, for R4: version-specific-use start / end against 4.0. */
function isForR4(shadow: Json | null): boolean {
  const ext = (shadow?.extension ?? []).find((x: Json) => isObject(x) && x.url === SPECIFIC_USE);
  if (!ext) return true;
  const minor = (v: unknown): number | null => {
    const m = typeof v === "string" ? /^(\d+)\.(\d+)/.exec(v) : null;
    return m ? Number(m[1]) * 100 + Number(m[2]) : null;
  };
  for (const sub of ext.extension ?? []) {
    const v = minor(sub?.valueCode ?? sub?.valueString);
    if (v === null) continue;
    if (sub.url === "startFhirVersion" && v > 400) return false;
    if (sub.url === "endFhirVersion" && v < 400) return false;
  }
  return true;
}

/** Top-level `|` legs of a FHIRPath expression with their offsets (outside quotes and parentheses). */
function unionLegs(expression: string): Array<{ text: string; at: number }> {
  const legs: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) {
      legs.push({ text: expression.slice(start, i), at: start });
      start = i + 1;
    }
  }
  legs.push({ text: expression.slice(start), at: start });
  return legs;
}

/** executeType l. 3497: `name` is the focus type or one of its ancestors. */
async function isTypeOrAncestor(type: string, name: string, deps: ConformanceRuleDeps): Promise<boolean> {
  const seen = new Set<string>();
  for (let t: string | null = type; t && !seen.has(t); t = await deps.parentType(t)) {
    if (t === name) return true;
    seen.add(t);
  }
  return false;
}

/** SearchParameterValidator.checkExpression, entry check only (see the module comment). */
async function expressionIssue(expression: string, bases: string[], deps: ConformanceRuleDeps): Promise<string | null> {
  for (const leg of unionLegs(expression)) {
    const m = /^(\s*\(*\s*)([A-Z][A-Za-z0-9]*)(?![A-Za-z0-9])/.exec(leg.text);
    if (!m) continue;
    let known = false;
    for (const b of bases) if (await isTypeOrAncestor(b, m[2], deps)) known = true;
    if (known) continue;
    // TypeDetails.describe: the sorted type urls; PathEngineException: " (@char n)", 1-based
    const described = bases.map((b) => CORE + b).sort().join(", ");
    return `Error evaluating FHIRPath expression: The name '${m[2]}' is not valid for any of the possible types: [${described}] (@char ${leg.at + m[1].length + 1})`;
  }
  return null;
}

/** SearchParameterValidator.validateSearchParameter l. 42-106. */
export async function validateSearchParameter(sp: Json, path: string, deps: ConformanceRuleDeps): Promise<ConformanceIssue[]> {
  const out: ConformanceIssue[] = [];
  const code = typeof sp.code === "string" ? sp.code : null;
  if (code !== null) {
    for (const c of [".", "$", "|"]) {
      if (code.includes(c)) out.push({ severity: "warning", path, code: "invalid", message: `The Search Parameter code includes '${code}' which has special meaning in the RESTful API, and so this will be a problem` });
    }
  }
  const baseList = list(sp.base);
  const hasExpression = typeof sp.expression === "string";
  if (hasExpression) {
    const bases: string[] = [];
    baseList.forEach((b, i) => {
      const shadow = baseShadow(sp, i);
      if (!isForR4(shadow)) return;
      const stated = (shadow?.extension ?? []).find((x: Json) => isObject(x) && x.url === SEARCH_PARAMETER_BASE);
      const v = stated ? (stated.valueCode ?? stated.valueString ?? stated.valueUri) : b;
      if (typeof v === "string") bases.push(v);
    });
    if (bases.length) {
      const bad = await expressionIssue(String(sp.expression), bases, deps);
      if (bad) out.push({ severity: "error", path: `${path}.expression`, code: "invalid", message: `Error in search expression '${sp.expression}': ${bad}` });
    }
  }
  const master = typeof sp.derivedFrom === "string" && sp.derivedFrom ? sp.derivedFrom : null;
  if (master) {
    const parent = await deps.fetchSearchParameter(master);
    if (!parent) {
      out.push({ severity: "warning", path, code: "business-rule", message: `Unable to find the base Search Parameter ${master} so can't check that this SearchParameter is a proper derivation from it` });
    } else {
      const parentBases = list(parent.base);
      baseList.forEach((b, i) => {
        if (!isForR4(baseShadow(sp, i))) return;
        if (!parentBases.includes(b) && !parentBases.includes("Resource")) {
          out.push({ severity: "error", path, code: "business-rule", message: `The resource type ${String(b)} is not listed as a base in the SearchParameter this is derived from (${master})` });
        }
      });
      // SEARCHPARAMETER_TYPE_WRONG is called with (master, sp.type, cs.type): {1} is the parent's type, {0} the master url
      if (typeof sp.type === "string" && parent.type !== sp.type) {
        out.push({ severity: "error", path, code: "business-rule", message: `The type ${parent.type} is different to the type ${master} in the derivedFrom SearchParameter` });
      }
    }
  }
  if (sp.type === "composite" && list(sp.component).length <= 1) {
    out.push({ severity: "error", path, code: "business-rule", message: "When the SearchParameter has a type of 'composite', then the SearchParameter must define two or more components" });
  }
  return out;
}

/** FilesystemPackageCacheManager.PACKAGE_REGEX. */
const PACKAGE_REGEX = /^[a-zA-Z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/;

const hasExtension = (r: Json, url: string): boolean => (Array.isArray(r.extension) ? r.extension : []).some((x: unknown) => isObject(x) && x.url === url);

/** ImplementationGuideValidator.checkDependency l. 62-82, the rules that read only the resource. */
function checkDependency(dep: Json, at: string, out: ConformanceIssue[]): void {
  const rule = (ok: boolean, message: string): void => {
    if (!ok) out.push({ severity: "error", path: at, code: "business-rule", message });
  };
  let uri: string | null = typeof dep.uri === "string" ? dep.uri : null;
  const version: string | null = typeof dep.version === "string" ? dep.version : null;
  const packageId: string | null = typeof dep.packageId === "string" ? dep.packageId : null;
  if (uri !== null && uri.includes("|")) {
    const uver = uri.slice(uri.indexOf("|") + 1);
    uri = uri.slice(0, uri.indexOf("|"));
    if (uver === "") rule(false, "The canonical URL cannot end in '|'");
    else if (version === null) rule(false, `The canonical URL specifies the version '${uver}', while the dependency does not. If a version is specified, it must be in the explicit version property`);
    else if (uver !== version) rule(uri.includes("/ImplementationGuide/"), `The canonical URL specifies the version '${uver}', while the dependency has version '${version}'. If a version is specified, it must be the same as in the explicit version property `);
  }
  rule(uri === null || uri.includes("/ImplementationGuide/"), "The URL should refer directly to the ImplementationGuide resource (e.g. include '/ImplementationGuide/')");
  rule(packageId === null || PACKAGE_REGEX.test(packageId), `The packageId ${packageId} is not valid`);
}

/** ImplementationGuideValidator.validateImplementationGuide l. 39-60. */
export function validateImplementationGuide(ig: Json, path: string): ConformanceIssue[] {
  const out: ConformanceIssue[] = [];
  if (list(ig.fhirVersion).length === 0) out.push({ severity: "warning", path, code: "business-rule", message: "No fhir version was specified for the IG so the version consistency can't be checked" });
  list(ig.dependsOn).forEach((d, i) => {
    if (isObject(d)) checkDependency(d, `${path}.dependsOn[${i}]`, out);
  });
  // BaseValidator.isHL7Org l. 1820-1823
  if (typeof ig.url === "string" && ig.url.startsWith("http://hl7.org/fhir/")) {
    if (!hasExtension(ig, "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status")) {
      out.push({ severity: "error", path, code: "business-rule", message: "HL7 Implementation Guides must state their status explicitly using the extension http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status" });
    }
    if (!hasExtension(ig, "http://hl7.org/fhir/StructureDefinition/structuredefinition-wg")) {
      out.push({ severity: "error", path, code: "business-rule", message: "HL7 Implementation Guides must state their owning workgroup explicitly using the extension http://hl7.org/fhir/StructureDefinition/structuredefinition-wg" });
    }
    if (!hasExtension(ig, "http://hl7.org/fhir/StructureDefinition/structuredefinition-fmm")) {
      out.push({ severity: "warning", path, code: "business-rule", message: "HL7 Implementation Guides should state their maturity explicitly using the extension http://hl7.org/fhir/StructureDefinition/structuredefinition-fmm" });
    }
  }
  return out;
}
