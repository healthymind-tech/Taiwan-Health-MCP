/**
 * Content repair (ISSUES_v14): the single entry point of the shared repair layer.
 *
 *   repairResource(resource, deps, opts)  one resource, in place (the caller clones);
 *   repairBundle(bundle, deps, opts)      the Bundle's own shape + every entry resource.
 *
 * Phases, in order (each one only writes what it can decide uniquely; see each module):
 *   shape     R6 lossless reshapes (shape.ts), repeated until stable (≤ 3 passes)
 *   systems   R4 / R5 Coding.system corrections, v12 ValueSet / binding rules included (systems.ts)
 *   units     R2 Quantity UCUM code / system (units.ts)
 *   dates     R3 ROC (民國) dates (dates.ts)
 *   codes     required-binding code spellings (codes.ts)
 *   displays  R1 display of the same concept; a different concept is reported (displays.ts)
 * The walk is repeated after shape and systems (a corrected system can change slice membership).
 *
 * Deterministic (no clock / random; collaborator answers memoised per call) and idempotent: a
 * repaired resource yields `changes: []`. Numbers are never rewritten — RawNumber leaves of a
 * lossless tree (losslessJson.ts) are carried as scalars, so a lossless input stays lossless.
 */

import { impliedVitalSignProfile } from "../fhirValidator.js";
import { repairCodes } from "./codes.js";
import { repairDates } from "./dates.js";
import { repairDisplays } from "./displays.js";
import { inferResourceType, repairShapes } from "./shape.js";
import { repairSystems } from "./systems.js";
import { ALL_PHASES, type RepairChange, type RepairDeps, type RepairIssue, type RepairOptions, type RepairResult, type RepairRule } from "./types.js";
import { repairUnits } from "./units.js";
import { toPlain } from "../losslessJson.js";
import { cloneTree, insertKey, isObject, reportPath, Session, walkResource, type Site } from "./walk.js";

export * from "./types.js";
export { cloneTree, Session } from "./walk.js";

/** Content-repair mode of the finalize tools: "ids" (v9: fullUrl / reference / id only) or "content" (ids + R1–R6). */
export type RepairMode = "ids" | "content";
export const REPAIR_MODES: readonly RepairMode[] = ["ids", "content"];
/**
 * DEFAULT of fhir_finalize_bundle / fhir_finalize_resource `repair` (ISSUES_v14; evaluator confirmed
 * "content" on 2026-10-25 and passes repair:"ids" for the v9 T3 acceptance). One constant to flip.
 */
export const DEFAULT_FINALIZE_REPAIR: RepairMode = "content";

function sessionOf(deps: RepairDeps, opts: RepairOptions): Session {
  return opts.session instanceof Session ? opts.session : new Session(deps);
}

/** Profiles a resource is walked with: the caller's + the HL7 vital-signs profile the validator implies. */
function walkProfiles(res: Record<string, any>, opts: RepairOptions): string[] {
  const out = [...(opts.profiles || [])];
  if (res.resourceType === "Observation") {
    const vs = impliedVitalSignProfile(res.code);
    if (vs && !out.includes(vs)) out.push(vs);
  }
  return out;
}

/**
 * Repair one resource in place. With `deps.validate` every change is verified: the resource is
 * validated before and after; when the repaired resource has an error the original did not have
 * (introduced by a change, or one the old shape hid — e.g. a Coding unwrapped from a wrong
 * CodeableConcept now shows its unknown system), the changes on that element are withdrawn (the
 * resource is repaired again without them, at most twice) and reported in `issues` — so a repair
 * never adds an error to the validator's verdict.
 */
export async function repairResource(resource: Record<string, any>, deps: RepairDeps, opts: RepairOptions = {}): Promise<RepairResult> {
  if (!isObject(resource)) return { changes: [], issues: [] };
  if (!deps.validate) return repairOnce(resource, deps, opts, new Set());
  const original = cloneTree(resource);
  const blocked = new Set<string>();
  const withdrawn: RepairIssue[] = [];
  let result = await repairOnce(resource, deps, opts, blocked);
  for (let round = 0; round < 3 && result.changes.length; round++) {
    const fresh = await newErrors(deps, original, resource, opts);
    if (!fresh.length) break;
    const blame = attribute(fresh, result.changes, opts, resource);
    if (!blame.length) break;
    for (const b of blame) {
      blocked.add(blockKey(b.change.rule, b.change.path));
      if (b.change.from && typeof b.change.from === "object" && typeof (b.change.from as any).path === "string") blocked.add(blockKey(b.change.rule, (b.change.from as any).path));
      withdrawn.push({
        path: b.change.path,
        rule: b.change.rule,
        severity: "warning",
        message: `not applied: changing ${b.change.path} ${describeChange(b.change)} would leave the resource with an error it does not have now (${b.error.slice(0, 200)}); fix that first`,
      });
    }
    // Restore the original and repair again without the withdrawn changes.
    for (const k of Object.keys(resource)) delete resource[k];
    Object.assign(resource, cloneTree(original));
    result = await repairOnce(resource, deps, opts, blocked);
  }
  const seen = new Set<string>();
  const extra = withdrawn.filter((w) => !seen.has(w.path + w.message) && !!seen.add(w.path + w.message));
  return { changes: result.changes, issues: [...result.issues, ...extra] };
}

function blockKey(rule: RepairRule, path: string): string {
  return `${rule}\u0000${path.replace(/\[\d+\]$/, "")}`;
}

function describeChange(c: RepairChange): string {
  const v = (x: unknown): string => {
    const t = typeof x === "string" ? `'${x}'` : JSON.stringify(x);
    return t && t.length > 60 ? t.slice(0, 57) + "…" : String(t);
  };
  if (c.rule === "shape" && c.from && typeof c.from === "object" && typeof (c.from as any).path === "string") return `(moving ${(c.from as any).path})`;
  return `from ${v(c.from)} to ${v(c.to)}`;
}

const ERROR_SEV = new Set(["error", "fatal"]);

function msgKey(m: unknown): string {
  return String(m ?? "").replace(/urn:uuid:[0-9a-f-]{36}/g, "urn:uuid:X");
}

/**
 * Errors of the repaired resource that the original did not have (stand-alone validation),
 * compared by message as a multiset — a re-shaped path (x[0] → x, a moved property) does not make
 * an old error new, while one more occurrence of a message is new.
 */
async function newErrors(deps: RepairDeps, before: Record<string, any>, after: Record<string, any>, opts: RepairOptions): Promise<Array<{ path: string; message: string }>> {
  const profiles = opts.profiles || [];
  let pre: Array<{ severity?: string; path?: string; message?: string }>;
  let post: Array<{ severity?: string; path?: string; message?: string }>;
  try {
    [pre, post] = await Promise.all([deps.validate!(toPlain(before) as Record<string, any>, profiles), deps.validate!(toPlain(after) as Record<string, any>, profiles)]);
  } catch {
    return [];
  }
  const left = new Map<string, number>();
  for (const i of pre) if (ERROR_SEV.has(String(i.severity))) left.set(msgKey(i.message), (left.get(msgKey(i.message)) ?? 0) + 1);
  const out: Array<{ path: string; message: string }> = [];
  for (const i of post) {
    if (!ERROR_SEV.has(String(i.severity))) continue;
    const k = msgKey(i.message);
    const n = left.get(k) ?? 0;
    if (n > 0) {
      left.set(k, n - 1);
      continue;
    }
    out.push({ path: String(i.path ?? ""), message: String(i.message ?? "") });
  }
  return out;
}

async function allErrors(deps: RepairDeps, res: Record<string, any>): Promise<Array<{ path: string; message: string }>> {
  try {
    const issues = await deps.validate!(toPlain(res) as Record<string, any>, []);
    return issues.filter((i) => ERROR_SEV.has(String(i.severity))).map((i) => ({ path: String(i.path ?? ""), message: String(i.message ?? "") }));
  } catch {
    return [];
  }
}

/** Top-level element (first property under the resource root) of a reported / resource-rooted path. */
function topElement(path: string, root: string): string | null {
  let rest = path;
  if (rest.startsWith(root)) rest = rest.slice(root.length);
  else {
    const m = /^[A-Z][A-Za-z]+/.exec(rest);
    if (!m) return null;
    rest = rest.slice(m[0].length);
  }
  const m = /^\.([A-Za-z0-9_]+)/.exec(rest);
  return m ? m[1] : null;
}

function sameElement(a: string, b: string): boolean {
  const stem = (x: string): string => (x.endsWith("[x]") ? x.slice(0, -3) : x);
  const sa = stem(a);
  const sb = stem(b);
  if (sa === sb) return true;
  // value[x] (message) ↔ valueQuantity (instance)
  return (a.endsWith("[x]") && b.startsWith(sa) && /[A-Z]/.test(b[sa.length] ?? "")) || (b.endsWith("[x]") && a.startsWith(sb) && /[A-Z]/.test(a[sb.length] ?? ""));
}

/** The changes a new error is owed to: those on the same top-level element; else the resource-wide ones (resourceType / meta); else all. */
function attribute(errors: Array<{ path: string; message: string }>, changes: RepairChange[], opts: RepairOptions, resource: Record<string, any>): Array<{ change: RepairChange; error: string }> {
  const rt = String(resource.resourceType || "");
  const root = opts.rootPath || rt;
  const out: Array<{ change: RepairChange; error: string }> = [];
  const add = (c: RepairChange, e: string): void => {
    if (!out.some((x) => x.change === c)) out.push({ change: c, error: e });
  };
  const elementsOf = (c: RepairChange): string[] => {
    const els = [topElement(c.path, root)];
    if (c.from && typeof c.from === "object" && typeof (c.from as any).path === "string") els.push(topElement((c.from as any).path, root));
    return els.filter((x): x is string => !!x);
  };
  for (const e of errors) {
    let el = topElement(e.path, rt);
    if (!el) {
      // A resource-level error naming its element in the message (slice cardinality, invariants).
      const m = new RegExp(`\\b${rt}\\.([A-Za-z0-9_]+(?:\\[x\\])?)`).exec(e.message);
      el = m ? m[1] : null;
    }
    // Nearest first: a change at / above / below the error's own path (a moved property: its target or source).
    const ep = e.path.startsWith(rt) ? root + e.path.slice(rt.length) : e.path;
    const near = (p: string): boolean => p === ep || ep.startsWith(`${p}.`) || ep.startsWith(`${p}[`) || p.startsWith(`${ep}.`) || p.startsWith(`${ep}[`);
    const nearHits = ep && ep !== root ? changes.filter((c) => near(c.path) || (c.from && typeof c.from === "object" && typeof (c.from as any).path === "string" && near((c.from as any).path))) : [];
    if (nearHits.length) {
      for (const c of nearHits) add(c, e.message);
      continue;
    }
    const hits = el ? changes.filter((c) => elementsOf(c).some((x) => sameElement(x, el!))) : [];
    if (hits.length) {
      for (const c of hits) add(c, e.message);
      continue;
    }
    const wide = changes.filter((c) => c.rule === "shape" && elementsOf(c).some((x) => x === "meta" || x === "resourceType"));
    for (const c of wide.length ? wide : changes) add(c, e.message);
  }
  return out;
}

async function repairOnce(resource: Record<string, any>, deps: RepairDeps, opts: RepairOptions, blocked: Set<string>): Promise<RepairResult> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  const session = sessionOf(deps, opts);
  const phases = new Set(opts.phases ?? ALL_PHASES);
  const rp0 = (p: string): string => reportPath(String(resource.resourceType || ""), opts.rootPath, p);
  const isBlocked = (rule: RepairRule, p: string): boolean => blocked.size > 0 && (blocked.has(blockKey(rule, rp0(p))) || blocked.has(blockKey(rule, rp0(p.replace(/\.(code|system|display)$/, "")))));
  const skipRule = (rule: RepairRule) => (p: string): boolean => isBlocked(rule, p) || (opts.skip ? opts.skip(p, rule) : false);

  if (phases.has("shape") && !(typeof resource.resourceType === "string" && resource.resourceType)) {
    const inferred = await inferResourceType(session, resource);
    if (inferred && !blocked.has(blockKey("shape", opts.rootPath ? `${opts.rootPath}.resourceType` : `${inferred.type}.resourceType`))) {
      insertKey(resource, "resourceType", inferred.type, Object.keys(resource));
      changes.push({ path: opts.rootPath ? `${opts.rootPath}.resourceType` : `${inferred.type}.resourceType`, from: null, to: inferred.type, rule: "shape", reason: inferred.reason });
    }
  }
  const rt = typeof resource.resourceType === "string" ? resource.resourceType : "";
  if (!rt) return { changes, issues };
  const rp = (p: string): string => reportPath(rt, opts.rootPath, p);
  const walk = (): Promise<Site[]> => walkResource(session, resource, { profiles: walkProfiles(resource, opts) });
  const profilesFor = (site: Site): string[] => (site.resource === resource ? opts.profiles || [] : []);

  let sites = await walk();
  if (phases.has("shape")) {
    for (let pass = 0; pass < 3; pass++) {
      const r = await repairShapes(session, sites, rp, skipRule("shape"));
      changes.push(...r.changes);
      if (pass === 0 || r.changes.length) issues.push(...r.issues.filter((i) => !issues.some((x) => x.path === i.path && x.message === i.message)));
      sites = await walk();
      if (!r.changes.length) break;
    }
  }
  if (phases.has("systems")) {
    const r = await repairSystems(session, sites, rp, skipRule("system"), profilesFor);
    changes.push(...r.changes);
    issues.push(...r.issues);
    if (r.changes.length) sites = await walk();
  }
  if (phases.has("units")) {
    const r = await repairUnits(session, sites, rp, skipRule("ucum"));
    changes.push(...r.changes);
    issues.push(...r.issues);
  }
  if (phases.has("dates")) {
    const r = repairDates(sites, rp, skipRule("roc-date"), opts.timezone);
    changes.push(...r.changes);
    issues.push(...r.issues);
  }
  if (phases.has("codes")) {
    const r = await repairCodes(session, sites, rp, skipRule("code"));
    changes.push(...r.changes);
    issues.push(...r.issues);
  }
  if (phases.has("displays")) {
    const r = await repairDisplays(session, sites, rp, skipRule("display"));
    changes.push(...r.changes);
    issues.push(...r.issues);
  }
  return { changes, issues };
}

export interface BundleRepairOptions {
  timezone?: string | null;
  phases?: RepairOptions["phases"];
}

/** The Bundle's own shape (entry-level misplaced properties, single values) and every entry resource, in place. */
export async function repairBundle(bundle: Record<string, any>, deps: RepairDeps, opts: BundleRepairOptions = {}): Promise<RepairResult> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  if (!isObject(bundle) || bundle.resourceType !== "Bundle") return { changes, issues };
  const session = new Session(deps);
  const phases = new Set(opts.phases ?? ALL_PHASES);
  const before = (Array.isArray(bundle.entry) ? bundle.entry : []).map((e: unknown) => cloneTree(e));
  if (phases.has("shape")) {
    // Entry resources without resourceType first (so the Bundle walk sees their definitions).
    const entries: unknown[] = Array.isArray(bundle.entry) ? bundle.entry : [];
    for (const [i, e] of entries.entries()) {
      if (!isObject(e) || !isObject(e.resource) || (typeof e.resource.resourceType === "string" && e.resource.resourceType)) continue;
      const inferred = await inferResourceType(session, e.resource);
      if (!inferred) continue;
      insertKey(e.resource, "resourceType", inferred.type, Object.keys(e.resource));
      changes.push({ path: `Bundle.entry[${i}].resource.resourceType`, from: null, to: inferred.type, rule: "shape", reason: inferred.reason });
    }
    for (let pass = 0; pass < 3; pass++) {
      const sites = (await walkResource(session, bundle)).filter((s) => !/^Bundle\.entry\[\d+\]\.resource[.[]/.test(s.path));
      const r = await repairShapes(session, sites, (p) => p, () => false);
      changes.push(...r.changes);
      if (pass === 0) issues.push(...r.issues);
      if (!r.changes.length) break;
    }
  }
  const bundleLevel = [...changes];
  const entries: unknown[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  for (const [i, e] of entries.entries()) {
    if (!isObject(e) || !isObject(e.resource)) continue;
    const rootPath = `Bundle.entry[${i}].resource`;
    let r = await repairResource(e.resource, deps, { rootPath, timezone: opts.timezone, phases: opts.phases, session });
    // Entry-level reshapes (a moved meta.profile, an inferred resourceType) are verified against the
    // entry as written, after its own repairs: if the entry ends with an error it did not have, they
    // are withdrawn and the entry is repaired as written.
    const prefix = `Bundle.entry[${i}]`;
    const mine = bundleLevel.filter((c) => c.path === prefix || c.path.startsWith(`${prefix}.`) || c.path.startsWith(`${prefix}[`));
    if (mine.length && deps.validate && isObject(before[i])) {
      const orig = isObject(before[i].resource) ? before[i].resource : null;
      // Written without resourceType the resource was not validated at all: every error it has now is new.
      const fresh = orig && typeof orig.resourceType === "string" ? await newErrors(deps, orig, e.resource, {}) : await allErrors(deps, e.resource);
      if (fresh.length) {
        const restored = cloneTree(before[i]) as Record<string, any>;
        entries[i] = restored;
        for (const c of mine) {
          changes.splice(changes.indexOf(c), 1);
          issues.push({ path: c.path, rule: c.rule, severity: "warning", message: `not applied: changing ${c.path} ${describeChange(c)} would leave the resource with an error it does not have now (${fresh[0].message.slice(0, 200)}); fix that first` });
        }
        r = isObject(restored.resource) ? await repairResource(restored.resource, deps, { rootPath, timezone: opts.timezone, phases: opts.phases, session }) : { changes: [], issues: [] };
      }
    }
    changes.push(...r.changes);
    issues.push(...r.issues);
  }
  return { changes, issues };
}

/** Counts per rule (tool summaries). */
export function countByRule(changes: RepairChange[]): Record<RepairRule, number> {
  const out: Record<RepairRule, number> = { shape: 0, system: 0, ucum: 0, "roc-date": 0, code: 0, display: 0 };
  for (const c of changes) out[c.rule]++;
  return out;
}
