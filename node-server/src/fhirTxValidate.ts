/**
 * $validate-code / $expand over the local terminology layer, in tx.fhir.org's answer shape
 * (result + issues with HL7 message ids and tx-issue-type codes). Used by the terminology parity
 * runner (scripts/parity/tx/run.ts) against the official tx ecosystem test cases, so that what the
 * InstanceValidator asks the terminology layer (code existence / display, ValueSet membership,
 * expansion) is measured against validator_cli + tx.fhir.org.
 *
 * Pure: every lookup goes through the injected TerminologyDeps.
 */
import { expandComposeWith, valueSetContains, type CodeSystemIndex, type TerminologyDeps } from "./fhirCodeSystem.js";
import { judgeHeldCodeSystem } from "./fhirValidationResolver.js";
import type { CodeCheck } from "./fhirValidator.js";

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
  display?: string | null;
}

function checkIssue(r: CodeCheck, path: string): TxIssue | null {
  if (r.status === "invalid-code") {
    const id = /\(the CodeSystem is a fragment\)/u.test(r.message) ? "UNKNOWN_CODE_IN_FRAGMENT" : / version '/u.test(r.message) ? "Unknown_Code_in_Version" : "Unknown_Code_in";
    return { severity: r.severity, type: "invalid-code", id, path: `${path}.code`, message: r.message };
  }
  if (r.status === "invalid-display") {
    const id = /^Wrong whitespace/u.test(r.message)
      ? "Display_Name_WS_for__should_be_one_of__instead_of"
      : /Default display is/u.test(r.message)
        ? "NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_ERR"
        : /is the default display/u.test(r.message)
          ? "NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_OK"
          : "Display_Name_for__should_be_one_of__instead_of";
    return { severity: r.severity, type: "invalid-display", id, path: `${path}.display`, message: r.message };
  }
  return null;
}

/** $validate-code (CodeSystem or ValueSet) composed from the validator's terminology pieces. */
export async function txValidateCode(req: TxValidateRequest, deps: TerminologyDeps): Promise<TxValidateResult> {
  const issues: TxIssue[] = [];
  let codings: Array<{ c: Record<string, any>; path: string }>;
  if (req.codeableConcept) codings = (req.codeableConcept.coding ?? []).map((c: any, i: number) => ({ c, path: `CodeableConcept.coding[${i}]` }));
  else if (req.coding) codings = [{ c: req.coding, path: "Coding" }];
  else if (req.code !== undefined) codings = [{ c: { system: req.system, code: req.code, version: req.version, display: req.display }, path: "" }];
  else return { result: undefined, outcome: "error", issues };
  let vsUrl: string | null = null;
  let vdeps = deps;
  if (req.mode === "valueset") {
    if (req.valueSet) {
      const inline = req.valueSet;
      vsUrl = String(inline.url ?? "urn:inline-valueset");
      vdeps = { ...deps, loadValueSet: (u: string) => (u.split("|")[0] === vsUrl ? Promise.resolve(inline) : deps.loadValueSet(u)) };
    } else if (req.url) {
      vsUrl = req.valueSetVersion ? `${req.url}|${req.valueSetVersion}` : req.url;
      if (!(await deps.loadValueSet(vsUrl))) {
        issues.push({ severity: "error", type: "not-found", id: "Unable_to_resolve_value_Set_", path: "", message: `Unable to resolve value set ${vsUrl}` });
        return { result: undefined, outcome: "error", issues };
      }
    } else return { result: undefined, outcome: "error", issues };
  }
  let anyOk = false;
  let anyUnknown = false;
  let anyError = false;
  for (const { c, path } of codings) {
    const p = path || "";
    const system: string | null = typeof c.system === "string" ? c.system : null;
    const code: string | null = c.code !== undefined && c.code !== null ? String(c.code) : null;
    if (code === null) continue;
    const display = typeof c.display === "string" ? c.display : null;
    let csOk = true;
    if (system) {
      const cs: CodeSystemIndex | null = await deps.loadCodeSystem(c.version ? `${system}|${c.version}` : system);
      if (!cs) {
        issues.push({ severity: "error", type: "not-found", id: c.version ? "UNKNOWN_CODESYSTEM_VERSION" : "UNKNOWN_CODESYSTEM", path: `${p}.system`, message: `A definition for CodeSystem '${system}' could not be found` });
        csOk = false;
        anyError = true;
      } else {
        const r = judgeHeldCodeSystem(cs, system, code, display) ?? { status: "silent" as const };
        const i = checkIssue(r, p);
        if (i) {
          issues.push(i);
          if (i.severity === "error") {
            csOk = false;
            anyError = true;
          }
        }
      }
    }
    if (req.mode === "codesystem") {
      if (csOk) anyOk = true;
      continue;
    }
    const m = await valueSetContains(vsUrl!, system, code, vdeps);
    if (m === true && csOk) anyOk = true;
    else if (m === undefined) anyUnknown = true;
    else if (m === false) {
      issues.push({
        severity: req.codeableConcept ? "information" : "error",
        type: req.codeableConcept ? "this-code-not-in-vs" : "not-in-vs",
        id: "None_of_the_provided_codes_are_in_the_value_set_one",
        path: `${p}.code`,
        message: `The provided code '${system ?? ""}#${code}' was not found in the value set '${vsUrl}'`,
      });
    }
  }
  if (req.mode === "codesystem") return { result: anyOk && !anyError, issues };
  if (anyOk) return { result: true, issues };
  if (anyUnknown) return { result: undefined, issues };
  if (req.codeableConcept) issues.push({ severity: "error", type: "not-in-vs", id: "TX_GENERAL_CC_ERROR_MESSAGE", path: "", message: `No valid coding was found for the value set '${vsUrl}'` });
  return { result: false, issues };
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
  const r = await expandComposeWith(vs.compose ?? {}, deps, 100000);
  if (r.unresolved.length) return { error: `cannot expand: ${JSON.stringify(r.unresolved.slice(0, 3))}`, cannotValidate: true };
  return { contains: r.codings.map((c) => ({ system: c.system, code: c.code, display: c.display })) };
}
