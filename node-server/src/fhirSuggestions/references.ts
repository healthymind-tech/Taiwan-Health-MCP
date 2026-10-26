/**
 * Reference-chain errors ("Unable to find a profile match for urn:uuid:X among choices: P"):
 * `caused_by` lists the errors of the referenced resource that make it fail — its own
 * errors when it has any, otherwise the errors it gets when validated against the
 * profile(s) the reference requires (a target that does not declare / meet that profile).
 */

import type { CausedBy, SuggestionDeps } from "./types.js";
import { isObject } from "./util.js";

export interface Target {
  resource: Record<string, any>;
  fullUrl: string | null;
  entry?: number;
  /** Validator path prefix of the target's issues (Bundle.entry[k].resource / X.contained[k]). */
  pathPrefix: string;
}

export function parseProfileMatch(message: string): { ref: string; profiles: string[] } | null {
  const m = /^Unable to find a profile match for (\S+) among choices: (.+)$/.exec(message);
  if (!m) return null;
  return { ref: m[1], profiles: m[2].split(/,\s*/).filter((p) => p !== "") };
}

export function findTarget(root: Record<string, any>, issuePath: string, ref: string): Target | null {
  const rootType = String(root.resourceType || "");
  if (ref.startsWith("#")) {
    // Contained in the resource that holds the reference (bundle entry or root).
    const m = /^(Bundle\.entry\[(\d+)\]\.resource)/.exec(issuePath);
    const holder = m && Array.isArray(root.entry) ? root.entry[Number(m[2])]?.resource : root;
    const prefix = m ? m[1] : rootType;
    const list = isObject(holder) && Array.isArray(holder.contained) ? holder.contained : [];
    const i = list.findIndex((c: any) => isObject(c) && `#${c.id}` === ref);
    return i >= 0 ? { resource: list[i], fullUrl: ref, pathPrefix: `${prefix}.contained[${i}]` } : null;
  }
  if (rootType !== "Bundle" || !Array.isArray(root.entry)) return null;
  const entries: any[] = root.entry;
  let idx = entries.findIndex((e) => isObject(e) && e.fullUrl === ref);
  if (idx < 0) idx = entries.findIndex((e) => isObject(e) && typeof e.fullUrl === "string" && e.fullUrl.endsWith(`/${ref}`));
  if (idx < 0) {
    const m = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/.exec(ref);
    if (m) idx = entries.findIndex((e) => isObject(e) && isObject(e.resource) && e.resource.resourceType === m[1] && e.resource.id === m[2]);
  }
  if (idx < 0 || !isObject(entries[idx].resource)) return null;
  return { resource: entries[idx].resource, fullUrl: entries[idx].fullUrl ?? null, entry: idx, pathPrefix: `Bundle.entry[${idx}].resource` };
}

const MAX_CAUSES = 10;

export async function causedBy(
  deps: SuggestionDeps,
  root: Record<string, any>,
  issue: Record<string, any>,
  allIssues: Array<Record<string, any>>,
  budget: { left: number },
): Promise<CausedBy[]> {
  const pm = parseProfileMatch(String(issue.message || ""));
  if (!pm) return [];
  const t = findTarget(root, String(issue.path || ""), pm.ref);
  if (!t) return [];
  const isError = (i: Record<string, any>): boolean => i.severity === "error" || i.severity === "fatal";
  const own = allIssues.filter((i) => i !== issue && isError(i) && (String(i.path) === t.pathPrefix || String(i.path).startsWith(t.pathPrefix + ".")));
  const base = (i: Record<string, any>, extra: Partial<CausedBy> = {}): CausedBy => ({
    fullUrl: t.fullUrl,
    ...(t.entry !== undefined ? { entry: t.entry } : {}),
    severity: String(i.severity),
    path: String(i.path),
    message: String(i.message),
    ...extra,
  });
  // A nested reference-chain error inside the target is itself explained by its own caused_by.
  if (own.length) return own.slice(0, MAX_CAUSES).map((i) => base(i));
  if (!deps.validateAgainst) return [];
  const out: CausedBy[] = [];
  const rt = String(t.resource.resourceType || "");
  for (const p of pm.profiles.slice(0, 2)) {
    if (budget.left <= 0) break;
    budget.left--;
    let issues: Array<Record<string, any>> = [];
    try {
      issues = await deps.validateAgainst(t.resource, p);
    } catch {
      issues = [];
    }
    for (const i of issues.filter(isError)) {
      // Re-root the stand-alone path (Observation.code) at the target's place in this instance.
      const path = String(i.path || "");
      const rel = path === rt ? "" : path.startsWith(rt + ".") ? path.slice(rt.length) : `.${path}`;
      out.push(base({ ...i, path: t.pathPrefix + rel }, { profile: p }));
      if (out.length >= MAX_CAUSES) return out;
    }
  }
  return out;
}
