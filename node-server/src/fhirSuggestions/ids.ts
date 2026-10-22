/**
 * ID-class suggestions for fhir_validate_bundle (ISSUES_v9 R2): fullUrl / reference / id
 * errors get the deterministic replacement the Bundle finalizer (fhirBundleFinalize.ts)
 * would apply, so the model can fix every linked value in one pass instead of point by
 * point. Additive like the rest of the suggestion layer: issue set, severities and
 * messages never change.
 */

import type { FinalizeChange, FinalizeResult, FinalizeUnresolved } from "../fhirBundleFinalize.js";
import type { Suggestion } from "./types.js";

/** Validator messages about Bundle identity / reference wiring (any severity). */
const ID_CLASS = [
  /^UUIDs must be valid and lowercase/,
  /^Invalid Resource id/,
  /^Bundle entry missing fullUrl$/,
  /^Except for transactions and batches, each entry in a Bundle must have a fullUrl/,
  /^Relative Reference appears inside Bundle whose entry is missing a fullUrl/,
  /^URN reference is not locally contained within the bundle/,
  /^Entry \d+ matches the reference .* by type and id but its fullUrl/,
  /^The reference '.*' is not a valid reference$/,
  /^Can't find '.*' in the bundle/,
  /isn't reachable by traversing links/,
  /bdl-7\b/,
  /bdl-11\b/,
  /bdl-12\b/,
  /^The first entry in a document must be a composition/,
  /^The first entry in a message must be a MessageHeader/,
];
const PROFILE_MATCH = /^Unable to find a profile match for (\S+) among choices/;

/** Is this issue about Bundle identity / reference wiring (the class the finalizer repairs)? */
export function isIdClassIssue(issue: Record<string, any>): boolean {
  const m = String(issue?.message || "");
  return ID_CLASS.some((re) => re.test(m));
}

function suggestionFor(c: FinalizeChange): Suggestion {
  const from = c.from === null || c.from === undefined ? "(missing)" : String(c.from);
  switch (c.rule) {
    case "fullUrl-uuid":
      return {
        value: String(c.to),
        kind: "replace_fullurl",
        confidence: 0.95,
        reason: `fullUrl must be an absolute URI (urn:uuid: + lowercase UUID); deterministic replacement for ${from} — every reference to it must change too (data.id_map)`,
        patch: { op: c.from === null || c.from === undefined ? "add" : "replace", path: c.path, value: c.to },
      };
    case "reference-rewire":
      return {
        value: String(c.to),
        kind: "replace_reference",
        confidence: 0.9,
        reason: `a reference inside the Bundle must equal the target entry's fullUrl; '${from}' names the entry whose fullUrl is '${c.to}'`,
        patch: { op: "replace", path: c.path, value: c.to },
      };
    case "resource-id":
      return c.to === null
        ? { value: from, kind: "remove_property", confidence: 0.8, reason: `'${from}' is not a FHIR id ([A-Za-z0-9-.]{1,64}) and has no usable segment`, patch: { op: "remove", path: c.path } }
        : { value: String(c.to), kind: "replace_id", confidence: 0.9, reason: `'${from}' is not a FHIR id ([A-Za-z0-9-.]{1,64}); its last segment is`, patch: { op: "replace", path: c.path, value: c.to } };
    case "bundle-type":
      return { value: String(c.to), kind: "replace_bundle_type", confidence: 0.9, reason: `the Bundle profile fixes Bundle.type to '${c.to}'`, patch: { op: "replace", path: "Bundle.type", value: c.to } };
    case "document-order":
      return { value: "Bundle.entry[0]", kind: "move_entry", confidence: 0.9, reason: "a document Bundle's first entry must be the Composition (bdl-11)", patch: { op: "move", from: c.path, path: "Bundle.entry[0]" } };
  }
}

function unresolvedSuggestions(u: FinalizeUnresolved): Suggestion[] {
  const conf = u.candidates.length === 1 ? 0.6 : 0.4;
  return u.candidates.map((cand) => ({
    value: cand,
    kind: "replace_reference" as const,
    confidence: conf,
    reason: `${u.reason}; candidate entry fullUrl`,
    patch: { op: "replace" as const, path: u.path, value: cand },
  }));
}

/**
 * Attach the finalizer's changes as `suggestions` to the ID-class issues at the same place
 * (in place; existing suggestions are kept after ours). Returns how many issues got one.
 */
export function attachIdSuggestions(issues: Array<Record<string, any>>, fin: FinalizeResult): number {
  const byPath = new Map<string, FinalizeChange[]>();
  for (const c of fin.changes) {
    const list = byPath.get(c.path) || [];
    list.push(c);
    byPath.set(c.path, list);
  }
  const unresolvedByPath = new Map(fin.unresolved.map((u) => [u.path, u]));
  const order = fin.changes.find((c) => c.rule === "document-order");
  let attached = 0;
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const msg = String(issue.message || "");
    const path = String(issue.path || "");
    const idClass = isIdClassIssue(issue);
    const profileMatch = PROFILE_MATCH.test(msg);
    if (!idClass && !profileMatch) continue;
    const out: Suggestion[] = [];
    for (const p of [path, `${path}.fullUrl`, `${path}.reference`, `${path}.id`]) {
      for (const c of byPath.get(p) || []) out.push(suggestionFor(c));
      const u = unresolvedByPath.get(p);
      if (u) out.push(...unresolvedSuggestions(u));
    }
    if (order && /bdl-11|first entry in a document/.test(msg)) out.push(suggestionFor(order));
    if (!out.length) continue;
    const existing: Suggestion[] = Array.isArray(issue.suggestions) ? issue.suggestions : [];
    issue.suggestions = [...out, ...existing.filter((e) => !out.some((o) => o.kind === e.kind && o.value === e.value))];
    attached++;
  }
  return attached;
}

/** The `information` issues fhir_validate_bundle(normalize_ids=true) reports for what it normalised. */
export function normalizationIssues(changes: FinalizeChange[]): Array<Record<string, any>> {
  return changes.map((c) => ({
    severity: "information",
    path: c.path,
    code: "informational",
    message: `Normalized by normalize_ids (${c.rule}): ${c.from === null || c.from === undefined ? "(missing)" : `'${String(c.from)}'`} → ${c.to === null ? "(removed)" : `'${String(c.to)}'`}`,
  }));
}
