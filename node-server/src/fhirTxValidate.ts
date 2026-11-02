/**
 * $validate-code / $expand over the local terminology layer, in tx.fhir.org's answer shape
 * (result + issues with HL7 message ids and tx-issue-type codes) — a port of the parts of
 * ValueSetValidator.validateCode (org.hl7.fhir.r5 terminologies/validation, validator 7.0.1) that
 * local CodeSystems / ValueSets can answer: determineVersion / getCodeSystemVersionFromValueSet,
 * the code-system check (unknown code, display by language, inactive / deprecated concepts),
 * value set membership (fhirCodeSystem.valueSetContains — the engine the InstanceValidator uses)
 * and the CodeableConcept roll-up.
 *
 * Used by the terminology parity runner (scripts/parity/tx/run.ts) against the official tx
 * ecosystem test cases. Anything the local data cannot decide comes back as result undefined
 * ("cannot be validated"), never as a pass. Pure: every lookup goes through TerminologyDeps.
 */
import { conceptInactive, expandComposeWith, findConcept, valueSetContains, type CodeSystemIndex, type TerminologyDeps } from "./fhirCodeSystem.js";
import { judgeHeldCodeSystem } from "./fhirValidationResolver.js";
import type { CodeCheck } from "./fhirValidator.js";
import { cmpVersions, versionIsMoreDetailed, versionMatches } from "./fhirCsVersion.js";

export interface TxValidateRequest {
  mode: "valueset" | "codesystem";
  url?: string;
  valueSet?: Record<string, any>;
  valueSetVersion?: string;
  code?: string;
  system?: string;
  version?: string;
  display?: string;
  coding?: Record<string, any>;
  codeableConcept?: Record<string, any>;
  /** Expansion-profile rules: system-version / check-system-version / force-system-version = `system|version`. */
  systemVersions?: Array<{ kind: string; value: string }>;
  params: Record<string, any>;
}

export interface TxIssue {
  severity: "error" | "warning" | "information";
  /** tx-issue-type code (invalid-code, invalid-display, not-in-vs, this-code-not-in-vs, not-found, …). */
  type: string;
  /** HL7 message id (Messages.properties / tx.fhir.org). */
  id: string;
  path: string;
  message: string;
}

export interface TxValidateResult {
  /** undefined = cannot be validated from local data (never a pass). */
  result: boolean | undefined;
  /** "error" = the server answers with an OperationOutcome (request cannot be processed). */
  outcome?: "error";
  issues: TxIssue[];
}

export { versionMatches } from "./fhirCsVersion.js";
const moreDetailed = versionIsMoreDetailed;

function checkIssue(r: CodeCheck, path: string, lenient: boolean): TxIssue[] {
  const out: TxIssue[] = [];
  const at = (s: string): string => (path ? `${path}.${s}` : s);
  for (const x of r.extra ?? []) {
    const id = /is deprecated/u.test(x.message) ? "DEPRECATED_CONCEPT_FOUND" : /has a status of/u.test(x.message) ? "INACTIVE_CONCEPT_FOUND" : "";
    if (id) out.push({ severity: x.severity, type: "code-comment", id, path, message: x.message });
  }
  if (r.status === "invalid-code") {
    const id = /labeled as a fragment/u.test(r.message) ? "UNKNOWN_CODE_IN_FRAGMENT" : / version '/u.test(r.message) ? "Unknown_Code_in_Version" : "Unknown_Code_in";
    out.push({ severity: r.severity, type: "invalid-code", id, path: at("code"), message: r.message });
  } else if (r.status === "invalid-display") {
    const id = /is no longer considered a correct display/u.test(r.message)
      ? "INACTIVE_DISPLAY_FOUND"
      : /^Wrong whitespace/u.test(r.message)
      ? "Display_Name_WS_for__should_be_one_of__instead_of"
      : /Default display is/u.test(r.message)
        ? "NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_ERR"
        : /is the default display|which is a valid display for the default language/u.test(r.message)
          ? "NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_OK"
          : "Display_Name_for__should_be_one_of__instead_of";
    const severity = lenient && r.severity === "error" ? "warning" : r.severity;
    out.push({ severity, type: "invalid-display", id, path: at("display"), message: r.message });
  }
  return out;
}

function splitCanonical(v: string): [string, string] {
  const k = v.indexOf("|");
  return k < 0 ? [v, ""] : [v.slice(0, k), v.slice(k + 1)];
}

/** $validate-code (CodeSystem or ValueSet). */
const SUPPLEMENT_TYPE_EXT = "http://hl7.org/fhir/StructureDefinition/codesystem-supplement-type";
const SUPPLEMENT_GLOBAL_EXT = "http://hl7.org/fhir/StructureDefinition/codesystem-supplement-global";

/**
 * Designations a CodeSystem gets from its supplements for display checks: a global language pack
 * (codesystem-supplement-type = lang-pack + codesystem-supplement-global = true) applies whether or not it is
 * referenced; any other supplement only when referenced (ValueSet valueset-supplement extension / useSupplement).
 * A supplement concept's display counts as a designation in the supplement's language. Returns a copy of the index.
 */
export function withSupplementDesignations(cs: CodeSystemIndex, supplements: Array<Record<string, any>>, referenced: string[]): CodeSystemIndex {
  const refs = new Set(referenced.map((r) => splitCanonical(r)[0]));
  const used = supplements.filter((s) => {
    const ext: any[] = Array.isArray(s.extension) ? s.extension : [];
    const global = ext.some((e) => e && e.url === SUPPLEMENT_TYPE_EXT && e.valueCode === "lang-pack") && ext.some((e) => e && e.url === SUPPLEMENT_GLOBAL_EXT && e.valueBoolean === true);
    return global || refs.has(String(s.url ?? ""));
  });
  if (!used.length) return cs;
  const concepts = new Map(cs.concepts);
  const visit = (list: any[], lang: string | null): void => {
    for (const c of list ?? []) {
      if (!c || c.code === undefined) continue;
      const base = concepts.get(String(c.code));
      if (base) {
        const add: Array<{ language: string | null; value: string; status?: string }> = [];
        if (typeof c.display === "string" && c.display) add.push({ language: lang, value: c.display });
        for (const d of c.designation ?? []) {
          if (!d || typeof d.value !== "string") continue;
          const st = Array.isArray(d.extension) ? d.extension.find((e: any) => e && e.url === "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status") : null;
          add.push({ language: typeof d.language === "string" ? d.language : lang, value: d.value, ...(st && typeof st.valueCode === "string" ? { status: st.valueCode } : {}) });
        }
        if (add.length) concepts.set(base.code, { ...base, designationList: [...base.designationList, ...add], designations: [...base.designations, ...add.map((a) => a.value)] });
      }
      if (Array.isArray(c.concept)) visit(c.concept, lang);
    }
  };
  for (const s of used) visit(s.concept, typeof s.language === "string" ? s.language : null);
  return { ...cs, concepts };
}

export async function txValidateCode(
  req: TxValidateRequest,
  deps: TerminologyDeps & { codeSystemVersions?(url: string): string[]; supplementsOf?(system: string): Promise<Array<Record<string, any>>> },
): Promise<TxValidateResult> {
  const issues: TxIssue[] = [];
  const lenient = req.params["lenient-display-validation"] === true;
  const parseLangs = (v: unknown): string[] => (typeof v === "string" && v ? v.split(",").map((x) => x.trim().split(";")[0]).filter(Boolean) : []);
  // displayLanguage parameter, then the Accept-Language header; checkValueSetOptions below adds the value set's own
  let langs = parseLangs(req.params.displayLanguage);
  if (!langs.length) langs = parseLangs(req.params.acceptLanguage);
  const activeOnlyParam = req.params.activeOnly === true;
  const rules = req.systemVersions ?? [];
  let codings: Array<{ c: Record<string, any>; path: string }>;
  if (req.codeableConcept) codings = (req.codeableConcept.coding ?? []).map((c: any, i: number) => ({ c, path: `CodeableConcept.coding[${i}]` }));
  else if (req.coding) codings = [{ c: req.coding, path: "Coding" }];
  else if (req.code !== undefined) {
    if (req.mode === "valueset" && !req.system && req.params.inferSystem !== true) return { result: undefined, outcome: "error", issues };
    if (req.mode === "codesystem" && !req.system && !req.url) return { result: undefined, outcome: "error", issues };
    codings = [{ c: { system: req.system ?? (req.mode === "codesystem" ? req.url : undefined), code: req.code, version: req.version, display: req.display }, path: "" }];
  } else return { result: undefined, outcome: "error", issues };
  let vs: Record<string, any> | null = null;
  let vsUrl: string | null = null;
  let vdeps: TerminologyDeps = deps;
  if (req.mode === "valueset") {
    if (req.valueSet) {
      vs = req.valueSet;
      vsUrl = String(vs.url ?? "urn:inline-valueset");
      const inline = vs;
      vdeps = { ...deps, loadValueSet: (u: string) => (u.split("|")[0] === vsUrl ? Promise.resolve(inline) : deps.loadValueSet(u)) };
    } else if (req.url) {
      vsUrl = req.valueSetVersion ? `${req.url}|${req.valueSetVersion}` : req.url;
      vs = await deps.loadValueSet(vsUrl);
      if (!vs) {
        issues.push({ severity: "error", type: "not-found", id: "Unable_to_resolve_value_Set_", path: "", message: `A definition for the value Set '${vsUrl}' could not be found` });
        return { result: undefined, outcome: "error", issues };
      }
      // pin the resolved version for nested lookups
      const pinned = vs;
      vdeps = { ...deps, loadValueSet: (u: string) => (u.split("|")[0] === req.url ? Promise.resolve(pinned) : deps.loadValueSet(u)) };
    } else return { result: undefined, outcome: "error", issues };
  }
  // ValueSet supplements (valueset-supplement extension / useSupplement): one that is not available → the
  // request cannot be processed (VALUESET_SUPPLEMENT_MISSING)
  const supplements: string[] = [
    ...((vs?.extension ?? []) as any[]).filter((e) => e && e.url === "http://hl7.org/fhir/StructureDefinition/valueset-supplement").map((e) => String(e.valueCanonical ?? e.valueUri ?? "")),
    ...(typeof req.params.useSupplement === "string" ? [req.params.useSupplement] : []),
  ].filter(Boolean);
  for (const sup of supplements) {
    if (!(await deps.loadCodeSystem(sup))) {
      issues.push({ severity: "error", type: "not-found", id: "VALUESET_SUPPLEMENT_MISSING", path: "", message: `Required supplement not found: ${sup}` });
      return { result: undefined, outcome: "error", issues };
    }
  }
  // default-valueset-version: an unversioned reference to that ValueSet resolves to the pinned version
  const dvv = req.params["default-valueset-version"];
  if (typeof dvv === "string" && dvv.includes("|")) {
    const [du, dv] = splitCanonical(dvv);
    const inner = vdeps;
    vdeps = { ...inner, loadValueSet: (u: string) => inner.loadValueSet(u === du ? `${du}|${dv}` : u) };
  }
  const includes: any[] = Array.isArray(vs?.compose?.include) ? vs!.compose.include : [];
  // ValueSetValidator.checkValueSetOptions (VSV:1105-1116): the compose's displayLanguage expansion parameter, else
  // ValueSet.language; with no language at all every display language is acceptable (isOkLanguage, VSV:1485; G30)
  for (const ext of (vs?.compose?.extension ?? []) as any[]) {
    if (ext?.url !== "http://hl7.org/fhir/StructureDefinition/valueset-expansion-parameter" && ext?.url !== "http://hl7.org/fhir/tools/StructureDefinition/valueset-expansion-parameter") continue;
    const sub: any[] = Array.isArray(ext.extension) ? ext.extension : [];
    const nameExt = sub.find((e) => e?.url === "name");
    if ((nameExt?.valueString ?? nameExt?.valueCode) !== "displayLanguage") continue;
    const val = sub.find((e) => e?.url === "value");
    const parsed = parseLangs(val ? (Object.entries(val).find(([k]) => k.startsWith("value"))?.[1] as unknown) : null);
    if (parsed.length) langs = parsed;
  }
  if (!langs.length && typeof vs?.language === "string" && vs.language) langs = [vs.language];

  /** getCodeSystemVersionFromValueSet (7.0.1). */
  const versionFromVs = async (system: string, cv: string | null, code: string, display: string | null): Promise<string | null> => {
    if (!vs) return null;
    if (cv && includes.some((i) => i && i.version === cv)) return cv;
    let v: string | null = null;
    const list: string[] = [];
    for (const inc of includes) {
      if (!inc || inc.system !== system || typeof inc.version !== "string" || !inc.version) continue;
      if (v === null || cmpVersions(inc.version, v) > 0) v = inc.version;
      const cs = await deps.loadCodeSystem(`${system}|${inc.version}`);
      let ok = false;
      const cd = cs ? findConcept(cs, code) : null;
      if (cd) ok = display === null || display === cd.display || cd.designations.includes(display);
      if (ok && Array.isArray(inc.concept) && inc.concept.length) ok = inc.concept.some((c: any) => c && c.code === code);
      if (ok) list.push(inc.version);
    }
    if (!list.length) return v;
    return list.sort((a, b) => cmpVersions(b, a))[0];
  };

  /** determineVersion (7.0.1): VS-implied version, expansion-profile rules, then the Coding's own version. */
  const determineVersion = async (system: string, path: string, versionVS: string | null, cv: string | null): Promise<string | null> => {
    let result: string | null = versionVS;
    const mine = rules.filter((r) => r.value.startsWith(system + "|"));
    const force = mine.find((r) => r.kind === "force-system-version");
    if (force) result = splitCanonical(force.value)[1];
    if (!result) {
      const def = mine.find((r) => r.kind === "system-version");
      if (def) result = splitCanonical(def.value)[1];
    }
    if (!result) {
      const chk = mine.find((r) => r.kind === "check-system-version");
      if (chk) result = splitCanonical(chk.value)[1];
    }
    if (!result && vs) {
      const implied = new Set(includes.filter((i) => i && i.system === system && typeof i.version === "string" && i.version).map((i) => String(i.version)));
      if (implied.size === 1) result = [...implied][0];
    }
    const vp = path ? `${path}.version` : "version";
    if (cv) {
      let source: "vs" | "coding" = "vs";
      if (moreDetailed(result, cv)) {
        result = cv;
        source = "coding";
      }
      const cs = await deps.loadCodeSystem(result ? `${system}|${result}` : system);
      if (cs && cs.version) checkVersion(system, cs.version, path);
      const csv = cs?.version ?? null;
      if (cs && !(cv === csv || moreDetailed(cv, csv))) {
        if (result === null) {
          if (csv !== null) {
            issues.push({ severity: "warning", type: "vs-invalid", id: "VALUESET_VALUE_MISMATCH_DEFAULT", path: vp, message: `The code system '${system}' version '${csv}' for the versionless include in the ValueSet include is different to the one in the value ('${cv}')` });
          }
        } else if (result !== versionVS) {
          issues.push({ severity: "error", type: "vs-invalid", id: "VALUESET_VALUE_MISMATCH_CHANGED", path: vp, message: `The code system '${system}' version '${result}' resulting from the version '${versionVS ?? ""}' in the ValueSet include is different to the one in the value ('${cv}')` });
        } else if ((versionVS ?? "") !== cv) {
          issues.push({ severity: "error", type: "vs-invalid", id: "VALUESET_VALUE_MISMATCH", path: vp, message: `The code system '${system}' version '${versionVS ?? ""}' in the ValueSet include is different to the one in the value ('${cv}')` });
        }
        if (!(await deps.loadCodeSystem(`${system}|${cv}`))) unknownVersion(system, cv, path);
      } else if (!cs && result !== null && cv !== result) {
        issues.push({ severity: "error", type: "vs-invalid", id: "VALUESET_VALUE_MISMATCH", path: vp, message: `The code system '${system}' version '${result}' in the ValueSet include is different to the one in the value ('${cv}')` });
      }
      void source;
    }
    return result;
  };
  const reportedUnknown = new Set<string>();
  const unknownVersion = (system: string, v: string, path: string): void => {
    if (reportedUnknown.has(`${system}|${v}`)) return;
    reportedUnknown.add(`${system}|${v}`);
    const known = deps.codeSystemVersions ? deps.codeSystemVersions(system) : [];
    issues.push({
      severity: "error",
      type: "not-found",
      id: known.length ? "UNKNOWN_CODESYSTEM_VERSION" : "UNKNOWN_CODESYSTEM_VERSION_NONE",
      path: path ? `${path}.system` : "system",
      message: `A definition for CodeSystem '${system}' version '${v}' could not be found, so the code cannot be validated. Valid versions: ${known.join(",")}`,
    });
  };
  const checkVersion = (system: string, version: string, path: string): void => {
    for (const r of rules) {
      if (r.kind !== "check-system-version" || !r.value.startsWith(system + "|")) continue;
      const tv = splitCanonical(r.value)[1];
      if (versionMatches(tv, version)) continue;
      const msg = `The version '${version}' is not allowed for system '${system}': required to be '${tv}' by a version-check parameter`;
      if (!issues.some((i) => i.message === msg)) issues.push({ severity: "error", type: "version-error", id: "VALUESET_VERSION_CHECK", path: path ? `${path}.version` : "version", message: msg });
    }
  };

  let anyOk = false;
  let anyUnknown = false;
  let anyCodingError = false;
  const unknownInCC: TxIssue[] = [];
  let anyInVs = false;
  const notInVs: TxIssue[] = [];
  for (const { c, path } of codings) {
    const p = path || "";
    let system: string | null = typeof c.system === "string" && c.system ? c.system : null;
    const code: string | null = c.code !== undefined && c.code !== null ? String(c.code) : null;
    const display = typeof c.display === "string" ? c.display : null;
    const cv: string | null = typeof c.version === "string" && c.version ? c.version : null;
    if (code === null) {
      const id = system ? "Coding_has_no_code__cannot_validate" : "Coding_has_no_system_or_code__cannot_validate";
      issues.push({ severity: "warning", type: "invalid-data", id, path: p, message: "Coding has no code, cannot validate" });
      continue;
    }
    if (!system && !path && req.mode === "valueset" && req.params.inferSystem === true) {
      // systemForCodeInValueSet (VSV:1603): exactly one include must define the code
      const found = await inferSystem(includes, code, deps);
      if (found.length > 1) {
        const vsv = `${vs?.url ?? vsUrl}${vs?.version ? `|${vs.version}` : ""}`;
        issues.push({ severity: "error", type: "cannot-infer", id: "Unable_to_resolve_system__value_set_has_multiple_matches", path: "code", message: `The System URI could not be determined for the code '${code}' in the ValueSet '${vsv}': value set expansion has multiple matches: ${found.sort().join(",")}` });
        return { result: false, issues };
      }
      system = found[0] ?? null;
    }
    if (!system) {
      // ValueSetValidator: Coding_has_no_system__cannot_validate (warning); the code cannot be in the value set
      issues.push({ severity: "warning", type: "invalid-data", id: "Coding_has_no_system__cannot_validate", path: p, message: "Coding has no system. A code with no system has no defined meaning, and it cannot be validated. A system should be provided" });
      anyCodingError = req.mode === "codesystem" ? true : anyCodingError;
      if (req.mode === "valueset") notInVs.push(notInVsIssue(p, null, code, vsUrl!, !!req.codeableConcept));
      continue;
    }
    if (!/^[a-z][a-z0-9+.-]*:/iu.test(system)) {
      issues.push({ severity: "error", type: "invalid-data", id: "Terminology_TX_System_Relative", path: p ? `${p}.system` : "system", message: "Coding.system must be an absolute reference, not a local reference" });
      anyCodingError = true;
      continue;
    }
    // version: implied by the value set, the expansion-profile rules and the Coding
    const versionVS = vs ? await versionFromVs(system, cv, code, display) : cv;
    const wv = vs ? await determineVersion(system, p, versionVS, cv) : await determineVersion(system, p, null, cv);
    let cs: CodeSystemIndex | null = await deps.loadCodeSystem(wv ? `${system}|${wv}` : system);
    let csOk = true;
    if (!cs) {
      const anyVersion = await deps.loadCodeSystem(system);
      if (anyVersion && wv) {
        unknownVersion(system, wv, p);
        csOk = false;
        anyCodingError = true;
        cs = null;
      } else {
        const isVs = !!(await deps.loadValueSet(system));
        issues.push(
          isVs
            ? { severity: "error", type: "invalid-data", id: "Terminology_TX_System_ValueSet2", path: p ? `${p}.system` : "system", message: `The Coding references a value set, not a code system ('${system}')` }
            : { severity: "error", type: "not-found", id: "UNKNOWN_CODESYSTEM", path: p ? `${p}.system` : "system", message: `A definition for CodeSystem '${system}' could not be found, so the code cannot be validated` },
        );
        csOk = false;
        // REVIEW_port_2 G30 (VSV:444): in a CodeableConcept an unknown system is only an error when no other coding is
        // in the value set (else UNKNOWN_CODESYSTEM_CODING_NOT_CHECKED, a warning) — settled after the loop
        if (!isVs && req.codeableConcept) unknownInCC.push(issues[issues.length - 1]);
        else anyCodingError = true;
        if (!isVs) anyUnknown = true;
      }
    } else {
      if (cs.version) checkVersion(system, cs.version, p);
      if (cs.content === "supplement") {
        issues.push({ severity: "error", type: "invalid-data", id: "CODESYSTEM_CS_NO_SUPPLEMENT", path: p ? `${p}.system` : "system", message: `CodeSystem ${system} is a supplement, so can't be used as a value in Coding.system` });
        csOk = false;
        anyCodingError = true;
        if (req.mode === "valueset") notInVs.push(notInVsIssue(p, system, code, vsUrl!, !!req.codeableConcept));
        continue;
      }
      const held = deps.supplementsOf ? withSupplementDesignations(cs, await deps.supplementsOf(system), supplements) : cs;
      const r: CodeCheck | null = judgeHeldCodeSystem(held, system, code, display, langs);
      if (r === null) {
        // content not-present: nothing local to check the code against — cannot be validated
        anyUnknown = true;
        continue;
      }
      const found = checkIssue(r, p, lenient);
      for (const i of found) issues.push(i);
      if (found.some((i) => i.severity === "error")) {
        csOk = false;
        anyCodingError = true;
      }
      const concept = findConcept(cs, code);
      // abstract = false: a notSelectable concept is not allowed (ABSTRACT_CODE_NOT_ALLOWED)
      const ns = concept?.properties.get("notSelectable")?.[0];
      if (concept && req.params.abstract === false && (ns === true || ns === "true")) {
        issues.push({ severity: "error", type: "code-rule", id: "ABSTRACT_CODE_NOT_ALLOWED", path: p ? `${p}.code` : "code", message: `Code '${system}#${code}' is abstract, and not allowed in this context` });
        csOk = false;
        anyCodingError = true;
        if (req.mode === "valueset") notInVs.push(notInVsIssue(p, system, code, vsUrl!, !!req.codeableConcept));
        continue;
      }
      if (concept && concept.code !== code) {
        issues.push({ severity: "information", type: "code-rule", id: "CODE_CASE_DIFFERENCE", path: p ? `${p}.code` : "code", message: `The code '${code}' differs from the correct code '${concept.code}' by case` });
      }
    }
    if (issues.some((i) => i.severity === "error" && (i.id.startsWith("VALUESET_VALUE_MISMATCH") || i.id === "VALUESET_VERSION_CHECK" || i.id.startsWith("UNKNOWN_CODESYSTEM_VERSION")) && i.path.startsWith(p))) {
      csOk = false;
      anyCodingError = true;
    }
    if (req.mode === "codesystem") {
      if (csOk) anyOk = true;
      continue;
    }
    if (!cs && !csOk) {
      // an unknown CodeSystem version is the only finding (tx reports no not-in-value-set for it)
      if (!reportedUnknown.size) notInVs.push(notInVsIssue(p, system, code, vsUrl!, !!req.codeableConcept));
      continue;
    }
    const forced = rules.some((r) => r.kind === "force-system-version" && r.value.startsWith(system + "|"));
    const m = await membership(vsUrl!, system, code, wv, vdeps, activeOnlyParam, forced);
    if (m === true) {
      anyInVs = true;
      if (csOk) anyOk = true;
    } else if (m === undefined) anyUnknown = true;
    else {
      const concept = cs ? findConcept(cs, code) : null;
      if (concept && conceptInactive(concept) && (vs?.compose?.inactive === false || activeOnlyParam)) {
        issues.push({ severity: "error", type: "code-rule", id: "STATUS_CODE_WARNING_CODE", path: p ? `${p}.code` : "code", message: `The concept '${code}' is valid but is not active` });
      }
      notInVs.push(notInVsIssue(p, system, code, vsUrl!, !!req.codeableConcept));
    }
  }
  if (req.mode === "codesystem") return { result: anyOk && !anyCodingError, issues };
  // CodeableConcept: any coding in the value set and no coding with an error → valid
  if (anyInVs) {
    for (const u of unknownInCC) {
      const sys = /CodeSystem '([^']*)'/.exec(u.message)?.[1] ?? "";
      Object.assign(u, { severity: "warning", id: "UNKNOWN_CODESYSTEM_CODING_NOT_CHECKED", message: `A definition for the code system '${sys}' could not be found, so this coding was not checked. The CodeableConcept is still valid: another coding is in the value set` });
    }
    if (req.codeableConcept) for (const i of notInVs) issues.push(i);
    return { result: anyOk && !anyCodingError, issues };
  }
  if (unknownInCC.length) anyCodingError = true;
  if (anyUnknown && !anyCodingError) return { result: undefined, issues };
  for (const i of notInVs) issues.push(i);
  if (req.codeableConcept && notInVs.length) issues.push({ severity: "error", type: "not-in-vs", id: "TX_GENERAL_CC_ERROR_MESSAGE", path: "", message: `No valid coding was found for the value set '${vsUrl}'` });
  return { result: false, issues };
}

function notInVsIssue(p: string, system: string | null, code: string, vsUrl: string, inCC: boolean): TxIssue {
  return {
    severity: inCC ? "information" : "error",
    type: inCC ? "this-code-not-in-vs" : "not-in-vs",
    id: "None_of_the_provided_codes_are_in_the_value_set_one",
    path: p ? `${p}.code` : "code",
    message: `The provided code '${system ?? ""}#${code}' was not found in the value set '${vsUrl}'`,
  };
}

/** Membership at the determined CodeSystem version: includes that pin another version do not hold the code. */
async function membership(vsUrl: string, system: string, code: string, wv: string | null, deps: TerminologyDeps, activeOnly: boolean, forced = false): Promise<boolean | undefined> {
  const vs = await deps.loadValueSet(vsUrl);
  if (!vs) return undefined;
  let compose = vs.compose ?? {};
  if (wv || activeOnly) {
    // force-system-version re-pins every include of the system; otherwise includes pinned to another version do not apply
    const keep = (inc: any): boolean => forced || !wv || !inc || inc.system !== system || !inc.version || inc.version === wv || versionMatches(inc.version, wv) || versionMatches(wv, inc.version);
    const pin = (inc: any): any => (wv && inc && inc.system === system && (forced || !inc.version) ? { ...inc, version: wv } : inc);
    compose = { ...compose, include: (compose.include ?? []).filter(keep).map(pin) };
    if (activeOnly) compose.inactive = false;
  }
  const copy = { ...vs, compose };
  return valueSetContains(vsUrl, system, code, { ...deps, loadValueSet: (u: string) => (u.split("|")[0] === vsUrl.split("|")[0] ? Promise.resolve(copy) : deps.loadValueSet(u)) });
}

/** systemForCodeInValueSet (simplified): the single include system whose CodeSystem defines the code. */
async function inferSystem(includes: any[], code: string, deps: TerminologyDeps): Promise<string[]> {
  const found = new Set<string>();
  for (const inc of includes) {
    if (!inc || typeof inc.system !== "string") continue;
    if (Array.isArray(inc.concept) && inc.concept.length) {
      if (inc.concept.some((c: any) => c && c.code === code)) found.add(inc.system);
      continue;
    }
    const cs = await deps.loadCodeSystem(inc.system);
    if (cs && findConcept(cs, code)) found.add(inc.system);
  }
  return [...found];
}

export interface TxExpandRequest {
  url: string | null;
  valueSet: Record<string, any> | null;
  params: Record<string, any[]>;
}

export interface TxExpandResult {
  contains?: Array<Record<string, any>>;
  error?: string;
  /** The expansion cannot be computed from local data (never an empty pass). */
  cannotValidate?: boolean;
}

export async function txExpand(req: TxExpandRequest, deps: TerminologyDeps): Promise<TxExpandResult> {
  const vs = req.valueSet ?? (req.url ? await deps.loadValueSet(req.url) : null);
  if (!vs) return { error: "Unable_to_resolve_value_Set_" };
  const activeOnly = (req.params.activeOnly ?? []).some((v: any) => v === true);
  const r = await expandComposeWith(vs.compose ?? {}, deps, 100000, 0, new Set(), activeOnly);
  if (r.unresolved.length) return { error: `cannot expand: ${JSON.stringify(r.unresolved.slice(0, 3))}`, cannotValidate: true };
  return { contains: r.codings.map((c) => ({ system: c.system, code: c.code, display: c.display })) };
}
