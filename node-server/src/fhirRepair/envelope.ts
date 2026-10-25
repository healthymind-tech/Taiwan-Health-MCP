/**
 * Bundle envelope repairs (ISSUES_v14.1 items 4 / 7, rule `shape`) — the Bundle's own structure,
 * before any entry is looked at. All lossless and decided by FHIR R4 core alone:
 *
 *   resourceType  an object without resourceType whose `entry` is a non-empty array of entry-shaped
 *                 objects (each has `resource` and / or `fullUrl` and only Bundle.entry keys) — the
 *                 only R4 resource with such entries is Bundle → resourceType "Bundle";
 *   entry keys    entries written as numbered keys (`"entry[1]": {…}`, `"entry2": {…}`, `entry_3`)
 *                 instead of the `entry` array → the array, in key-number order (after the items of
 *                 an existing `entry` array when every number is past its end); duplicate numbers,
 *                 non-entry values or numbers inside an existing array → reported, not rebuilt;
 *   duplicates    (bdl-7) entries with the same fullUrl whose resources are deep-equal → the later
 *                 copies are dropped (references to that fullUrl still resolve to the one kept);
 *                 different resources under one fullUrl → reported (which one is meant is not decidable);
 *   entry props   a property of an entry's resource that is not a property of the resource type
 *                 but is one of Bundle.entry (request, response, search, fullUrl) and the entry lacks
 *                 → moved to the entry (the Bundle-level verification withdraws it if it adds an error,
 *                 e.g. bdl-3 request outside a batch / transaction).
 */

import type { RepairChange, RepairIssue } from "./types.js";
import { CORE, cloneTree, groupFor, insertKey, isObject, type Session } from "./walk.js";

const ENTRY_KEYS = new Set(["id", "extension", "modifierExtension", "link", "fullUrl", "resource", "search", "request", "response"]);
const ENTRY_KEY_RE = /^entry\s*(?:\[\s*(\d+)\s*\]|[_\-\s]?(\d+))$/i;

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (isObject(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  return JSON.stringify(v) ?? "null";
}

function entryShaped(e: unknown): boolean {
  return isObject(e) && ("resource" in e || "fullUrl" in e) && Object.keys(e).every((k) => ENTRY_KEYS.has(k) || k.startsWith("_"));
}

/** Why an argument is not a FHIR Bundle, precisely (null = it is one). */
export function bundleEnvelopeProblem(input: unknown): string | null {
  if (!isObject(input)) return `bundle must be a FHIR Bundle resource (a JSON object); got ${Array.isArray(input) ? "an array" : input === null ? "null" : typeof input}`;
  if (input.resourceType === "Bundle") return null;
  if (input.resourceType !== undefined) return `bundle must be a FHIR Bundle resource; its resourceType is ${JSON.stringify(input.resourceType)} (at resourceType)`;
  const entries = Array.isArray(input.entry) ? input.entry : null;
  if (entries && entries.length && entries.every(entryShaped)) return `bundle has no resourceType (at resourceType); its entry array is a Bundle's — add "resourceType": "Bundle" (repair="content" does this)`;
  return `bundle must be a FHIR Bundle resource: resourceType is missing (at resourceType)${entries ? "" : " and there is no entry array"}`;
}

/** The envelope rules above (resourceType, numbered entry keys), in place. */
export function repairBundleEnvelope(bundle: Record<string, any>): { changes: RepairChange[]; issues: RepairIssue[] } {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  if (!isObject(bundle)) return { changes, issues };
  // Numbered entry keys → the entry array.
  const numbered = Object.keys(bundle)
    .map((k) => {
      const m = ENTRY_KEY_RE.exec(k);
      return m ? { key: k, n: Number(m[1] ?? m[2]) } : null;
    })
    .filter((x): x is { key: string; n: number } => !!x);
  if (numbered.length) {
    const existing = bundle.entry;
    const arr: unknown[] | null = existing === undefined ? [] : Array.isArray(existing) ? existing : null;
    const nums = numbered.map((x) => x.n);
    const problems: string[] = [];
    if (arr === null) problems.push("`entry` is present and is not an array");
    if (new Set(nums).size !== nums.length) problems.push("two keys carry the same number");
    if (!numbered.every((x) => entryShaped(bundle[x.key]))) problems.push("a numbered value is not an entry object ({fullUrl, resource})");
    if (arr && arr.length && nums.some((n) => n < arr.length)) problems.push(`a number falls inside the existing entry array (${arr.length} item(s)), so the order is not decidable`);
    if (problems.length) {
      issues.push({
        path: `Bundle.${numbered[0].key}`, rule: "shape", severity: "error",
        message: `entries written as numbered keys (${numbered.map((x) => x.key).join(", ")}) instead of the entry array were not rebuilt: ${problems.join("; ")}. Write "entry": [{"fullUrl": …, "resource": {…}}, …]`,
      });
    } else {
      const sorted = [...numbered].sort((a, b) => a.n - b.n);
      const before = arr!.length;
      const list = [...arr!, ...sorted.map((x) => bundle[x.key])];
      for (const x of sorted) delete bundle[x.key];
      if (existing === undefined) insertKey(bundle, "entry", list, []);
      else bundle.entry = list;
      for (const [j, x] of sorted.entries()) {
        changes.push({ path: `Bundle.entry[${before + j}]`, from: { path: `Bundle.${x.key}`, value: list[before + j] }, to: list[before + j], rule: "shape", reason: `'${x.key}' is an entry written as a numbered key: Bundle.entry is an array (rebuilt in key-number order)` });
      }
    }
  }
  if (bundle.resourceType === undefined && Array.isArray(bundle.entry) && bundle.entry.length && bundle.entry.every(entryShaped)) {
    insertKey(bundle, "resourceType", "Bundle", Object.keys(bundle));
    changes.push({ path: "Bundle.resourceType", from: null, to: "Bundle", rule: "shape", reason: "resourceType is missing and the object's entry array holds Bundle entries ({fullUrl, resource}); only a Bundle has those" });
  }
  return { changes, issues };
}

/** Duplicate fullUrls (deep-equal resources dropped) and resource properties that belong to the entry, in place. */
export async function repairBundleEntries(session: Session, bundle: Record<string, any>, allow: (rule: "shape", path: string) => boolean): Promise<{ changes: RepairChange[]; issues: RepairIssue[]; removed: number[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  const removed: number[] = [];
  const entries: unknown[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  // bdl-7 duplicates.
  const byUrl = new Map<string, number[]>();
  for (const [i, e] of entries.entries()) {
    if (isObject(e) && typeof e.fullUrl === "string" && e.fullUrl) byUrl.set(e.fullUrl, [...(byUrl.get(e.fullUrl) || []), i]);
  }
  const drop = new Set<number>();
  for (const [url, idx] of byUrl) {
    if (idx.length < 2) continue;
    const first = entries[idx[0]] as Record<string, any>;
    const key = stableJson(first);
    const equal = idx.slice(1).every((i) => stableJson(entries[i]) === key);
    if (!equal || !allow("shape", `Bundle.entry[${idx[1]}]`)) {
      issues.push({
        path: `Bundle.entry[${idx[1]}].fullUrl`, rule: "shape", severity: "error",
        message: `fullUrl ${url} is used by ${idx.length} entries (${idx.map((i) => `entry[${i}]`).join(", ")}) whose resources differ (bdl-7); not merged — give each resource its own fullUrl and point each reference at the one meant`,
      });
      continue;
    }
    for (const i of idx.slice(1)) drop.add(i);
  }
  if (drop.size) {
    for (const i of [...drop].sort((a, b) => b - a)) {
      changes.push({ path: `Bundle.entry[${i}]`, from: cloneTree(entries[i]), to: null, rule: "shape", reason: `entry[${i}] repeats entry[${byUrl.get((entries[i] as any).fullUrl)![0]}] exactly (same fullUrl, deep-equal resource; bdl-7): the copy was dropped` });
      entries.splice(i, 1);
      removed.push(i);
    }
    changes.reverse();
  }
  // Resource properties that belong to the entry.
  for (const [i, e] of entries.entries()) {
    if (!isObject(e) || !isObject(e.resource) || typeof e.resource.resourceType !== "string") continue;
    const res = e.resource;
    const view = await session.view(CORE + res.resourceType);
    const groups = view ? view.sdx.childrenOfId(String(view.sdx.root.id || res.resourceType)) : null;
    if (!groups) continue;
    for (const k of Object.keys(res)) {
      if (!["request", "response", "search", "fullUrl"].includes(k) || groupFor(groups, k) || k in e) continue;
      const v = res[k];
      const ok = k === "fullUrl" ? typeof v === "string" : isObject(v) && (k !== "request" || (typeof v.method === "string" && typeof v.url === "string"));
      const path = `Bundle.entry[${i}].${k}`;
      if (!ok || !allow("shape", path)) continue;
      e[k] = v;
      delete res[k];
      changes.push({ path, from: { path: `Bundle.entry[${i}].resource.${k}`, value: v }, to: v, rule: "shape", reason: `'${k}' is not a property of ${res.resourceType}; it is a property of Bundle.entry (the one place nearby that defines it)` });
    }
  }
  return { changes, issues, removed };
}
