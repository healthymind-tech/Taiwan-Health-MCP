/**
 * attachSuggestions: the single entry point of the suggestion layer. Called once per
 * validation with the validator's issue list (mutated in place: only `suggestions` and
 * `caused_by` are ever added; existing fields are untouched) and the validated instance.
 *
 * Dispatch is by the validator's (HL7-parity) message text, so the layer needs no change
 * in the validator. Deterministic: issues are processed in order, collaborator budgets are
 * consumed in that order, and every list is sorted with explicit tie-breakers. Fail-open:
 * any error leaves the issue without suggestions.
 */

import { suggestCanonical, type CanonicalContext } from "./canonicals.js";
import { codingContext, suggestBinding, suggestDisplay, suggestUnknownCode, type Budget } from "./codes.js";
import { suggestChoiceType, suggestProperty } from "./properties.js";
import { causedBy } from "./references.js";
import type { Suggestion, SuggestionDeps, SuggestOptions } from "./types.js";
import { suggestUcum } from "./ucum.js";
import { isObject, nodeAt, rankSuggestions, splitLast } from "./util.js";

export type { CausedBy, Suggestion, SuggestionDeps, SuggestOptions, SuggestionKind, SuggestionPatch } from "./types.js";

const UCUM = "http://unitsofmeasure.org";

const RE_UNKNOWN_CODE = /^Unknown code '(.*)' in the CodeSystem '([^']+)'/s;
const RE_UNRECOGNIZED = /^Unrecognized property '([^']+)'$/;
const RE_NO_DEFINITION = /^No definition could be found for URL value '([^']+)'$/;
const RE_CS_NOT_FOUND = /^A definition for CodeSystem '([^']+)' could not be found/;
const RE_VS_AS_SYSTEM = /^The Coding references a value set, not a code system \('([^']+)'\)$/;
const RE_WRONG_DISPLAY = /^Wrong (whitespace in )?Display Name /;
const RE_BINDING = /^(None of the codings provided are in the value set|The value provided \(.*\) was not found in the value set)/s;
const RE_PROFILE_MATCH = /^Unable to find a profile match for /;
const RE_TYPE_NOT_ALLOWED = /^The type '[^']+' is not allowed for \S+ \(allowed: /;

/** Category of an issue for the suggestion layer (null = no suggester). Exported for tests / evaluation. */
export function suggestionCategory(issue: Record<string, any>): string | null {
  const m = String(issue.message || "");
  const sev = String(issue.severity || "");
  if (sev !== "error" && sev !== "fatal" && sev !== "warning") return null;
  if (RE_UNKNOWN_CODE.test(m)) return RE_UNKNOWN_CODE.exec(m)![2] === UCUM ? "ucum" : "unknown_code";
  if (RE_UNRECOGNIZED.test(m)) return "unrecognized_property";
  if (RE_NO_DEFINITION.test(m) || RE_CS_NOT_FOUND.test(m) || RE_VS_AS_SYSTEM.test(m)) return "unknown_url";
  if (RE_WRONG_DISPLAY.test(m)) return "wrong_display";
  if (RE_BINDING.test(m)) return "binding";
  if (RE_PROFILE_MATCH.test(m)) return "reference_chain";
  if (RE_TYPE_NOT_ALLOWED.test(m)) return "choice_type";
  return null;
}

function canonicalContext(root: any, issuePath: string): CanonicalContext {
  const { parent, last } = splitLast(issuePath);
  if (last === "system") {
    const holder = nodeAt(root, parent);
    // Coding / Quantity system: a CodeSystem. Identifier.system is a namespace (any).
    if (isObject(holder) && ("code" in holder || "display" in holder || "unit" in holder)) {
      return { expect: "CodeSystem", code: typeof holder.code === "string" ? holder.code : null, display: typeof holder.display === "string" ? holder.display : null, path: issuePath };
    }
  }
  if (last === "valueSet" || last === "answerValueSet") return { expect: "ValueSet", path: issuePath };
  if (last === "profile" || last === "targetProfile" || last === "url") return { expect: last === "url" ? "any" : "StructureDefinition", path: issuePath };
  return { expect: "any", path: issuePath };
}

async function suggestFor(issue: Record<string, any>, all: Array<Record<string, any>>, root: any, deps: SuggestionDeps, budget: Budget): Promise<{ suggestions?: Suggestion[]; caused_by?: any[] }> {
  const msg = String(issue.message || "");
  const path = String(issue.path || "");
  switch (suggestionCategory(issue)) {
    case "ucum": {
      const code = RE_UNKNOWN_CODE.exec(msg)![1];
      const { codingPath } = codingContext(root, path);
      const holder = nodeAt(root, codingPath);
      const unitText = isObject(holder) && typeof holder.unit === "string" ? holder.unit : null;
      return {
        suggestions: suggestUcum(code, unitText, 5).map((c) => ({
          value: c.value,
          kind: "replace_code" as const,
          confidence: Math.max(0.2, 0.97 - 0.3 * c.cost),
          reason: c.reason,
          system: UCUM,
          patch: { op: "replace" as const, path: path.endsWith(".code") ? path : `${codingPath}.code`, value: c.value },
        })),
      };
    }
    case "unknown_code": {
      const m = RE_UNKNOWN_CODE.exec(msg)!;
      return { suggestions: await suggestUnknownCode(deps, root, path, m[2], m[1], budget) };
    }
    case "unrecognized_property":
      return { suggestions: await suggestProperty(deps, root, path, RE_UNRECOGNIZED.exec(msg)![1]) };
    case "unknown_url": {
      const url = (RE_NO_DEFINITION.exec(msg) || RE_CS_NOT_FOUND.exec(msg) || RE_VS_AS_SYSTEM.exec(msg))![1];
      const systemIssue = RE_CS_NOT_FOUND.test(msg) || RE_VS_AS_SYSTEM.test(msg);
      const ctx = canonicalContext(root, systemIssue && !path.endsWith(".system") ? `${path}.system` : path);
      if (systemIssue) ctx.expect = "CodeSystem";
      return { suggestions: await suggestCanonical(deps, url, ctx) };
    }
    case "wrong_display":
      return { suggestions: await suggestDisplay(deps, root, path, msg, budget) };
    case "binding":
      return { suggestions: await suggestBinding(deps, root, path, msg, budget) };
    case "choice_type":
      return { suggestions: suggestChoiceType(root, path, msg) };
    case "reference_chain":
      return { caused_by: await causedBy(deps, root, issue, all, budget) };
    default:
      return {};
  }
}

/**
 * Add ranked `suggestions` (and `caused_by` for reference-chain errors) to `issues`, in place.
 * Never throws; never removes or changes an existing field.
 */
/** Categories whose suggester calls the expensive collaborators (normalize / expand / validateAgainst). */
const REMOTE = new Set(["unknown_code", "binding", "wrong_display", "reference_chain"]);

/**
 * Add ranked `suggestions` (and `caused_by` for reference-chain errors) to `issues`, in place.
 * Never throws; never removes or changes an existing field.
 *
 * Cost bound: the expensive collaborators get a per-issue allowance, handed out in issue order
 * to the first `maxRemoteCalls / 2` issues that need them — fixed before anything runs, so the
 * issues can be processed concurrently and the output is still deterministic.
 */
export async function attachSuggestions(
  issues: Array<Record<string, any>>,
  root: Record<string, any>,
  deps: SuggestionDeps,
  opts: SuggestOptions = {},
): Promise<void> {
  const maxIssues = opts.maxIssues ?? 60;
  const maxSuggestions = opts.maxSuggestions ?? 5;
  let remoteIssues = Math.floor((opts.maxRemoteCalls ?? 20) / 2);
  let displayLookups = 1;
  // Plan: which issues, which key (identical questions share one answer), which allowance.
  const jobs = new Map<string, { issue: Record<string, any>; budget: Budget }>();
  const plan: Array<{ issue: Record<string, any>; key: string; category: string }> = [];
  for (const issue of issues) {
    if (plan.length >= maxIssues) break;
    const category = isObject(issue) ? suggestionCategory(issue) : null;
    if (category === null) continue;
    // Identical (path, message) issues — e.g. a profile and its base reporting the same thing — share one answer;
    // unknown-URL issues about the same value (No definition … / A definition for CodeSystem …) too.
    const url = category === "unknown_url" ? /'([^']+)'/.exec(String(issue.message))?.[1] : undefined;
    const key = url ? `url\u0000${String(issue.path).replace(/\.system$/, "")}\u0000${url}` : `${issue.path}\u0000${issue.message}`;
    plan.push({ issue, key, category });
    if (jobs.has(key)) continue;
    const remote = REMOTE.has(category) && remoteIssues > 0;
    if (remote) remoteIssues--;
    const display = category === "wrong_display" && displayLookups > 0;
    if (display) displayLookups--;
    jobs.set(key, { issue, budget: { left: remote ? 2 : 0, displayLeft: display ? 1 : 0 } });
  }
  // Run (bounded concurrency); each job only reads shared caches, so timing cannot change a result.
  const results = new Map<string, { suggestions?: Suggestion[]; caused_by?: any[] } | null>();
  const queue = [...jobs.entries()];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, job] = next;
      try {
        results.set(key, await suggestFor(job.issue, issues, root, deps, job.budget));
      } catch {
        results.set(key, null); // fail-open: no suggestions for this issue
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  for (const { issue, key, category } of plan) {
    const r = results.get(key);
    if (!r) continue;
    const list = r.suggestions ? rankSuggestions(r.suggestions, category === "binding" ? Math.max(maxSuggestions, 12) : maxSuggestions) : [];
    if (list.length) issue.suggestions = list;
    if (r.caused_by && r.caused_by.length) issue.caused_by = r.caused_by;
  }
}
