/**
 * Content repair (ISSUES_v14): the single entry point of the shared repair layer.
 *
 *   repairResource(resource, deps, opts)  one resource, in place (the caller clones);
 *   repairBundle(bundle, deps, opts)      the Bundle's own shape + every entry resource.
 *
 * Phases, in order (each one only writes what it can decide uniquely; see each module):
 *   shape     R6 lossless reshapes + empty elements (shape.ts), repeated until stable (≤ 4 passes)
 *   systems   R4 / R5 Coding.system corrections, v12 ValueSet / binding rules included (systems.ts)
 *   slices    required coding slices the profile fully determines (slices.ts, v14.1)
 *   alternatives  an excerpt CodeSystem's unknown code → its one accepted linked coding (alternatives.ts, v15.2)
 *   units     R2 Quantity UCUM code / system (units.ts)
 *   dates     R3 ROC (民國) dates; the site timezone for date-times without an offset (dates.ts, timezone.ts)
 *   codes     required-binding code spellings (codes.ts)
 *   displays  R1 display of the same concept; a different concept is reported (displays.ts)
 * The walk is repeated after shape and systems (a corrected system can change slice membership).
 *
 * Deterministic (no clock / random; collaborator answers memoised per call) and idempotent: a
 * repaired resource yields `changes: []`. Numbers are never rewritten — RawNumber leaves of a
 * lossless tree (losslessJson.ts) are carried as scalars, so a lossless input stays lossless.
 */

import { impliedVitalSignProfile } from "../fhirValidator.js";
import { repairAlternativeCodings } from "./alternatives.js";
import { repairCodes } from "./codes.js";
import { repairDates } from "./dates.js";
import { repairDisplays } from "./displays.js";
import { repairBundleEnvelope, repairBundleEntries } from "./envelope.js";
import { inferResourceType, repairShapes } from "./shape.js";
import { repairSlices } from "./slices.js";
import { repairSystems } from "./systems.js";
import { ALL_PHASES, ALL_RULES, type RepairChange, type RepairDeps, type RepairIssue, type RepairOptions, type RepairResult, type RepairRule } from "./types.js";
import { repairUnits } from "./units.js";
import { toPlain } from "../losslessJson.js";
import { cloneTree, insertKey, isObject, reportPath, Session, walkResource, type Site } from "./walk.js";

export * from "./types.js";
export { cloneTree, Session } from "./walk.js";
export { bundleEnvelopeProblem, repairBundleEnvelope } from "./envelope.js";
export { siteConfigTimezone, siteTimezone, parseTimezone } from "./timezone.js";

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
  if (!deps.validate) return repairOnce(resource, deps, opts, new Set(opts.blocked ?? []));
  const original = cloneTree(resource);
  const blocked = new Set<string>(opts.blocked ?? []);
  const withdrawn: RepairIssue[] = [];
  let result = await repairOnce(resource, deps, opts, blocked);
  for (let round = 0; round < 3 && result.changes.length; round++) {
    const fresh = (await newErrors(deps, original, resource, opts)).filter((e) => !exposedDisplay(e, result.changes));
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

/** Path relative to its resource root (`Bundle.entry[2].resource.code…` / `Condition.code…` → `.code…`), plus the entry index. */
function relPath(p: string): { entry: number | null; rel: string } {
  const m = /^Bundle\.entry\[(\d+)\]\.resource(.*)$/.exec(p);
  if (m) return { entry: Number(m[1]), rel: m[2] };
  return { entry: null, rel: p.replace(/^[A-Z][A-Za-z]+/, "") };
}

/**
 * Evaluator decision (v14.1, 2026-10-25): an error that only becomes visible because a Coding's
 * system was corrected — the terminology's display check of THAT same Coding ("Wrong Display Name
 * '…' for <corrected system>#<code>") — existed semantically before (the display never matched the
 * code); it is not a regression of the repair. The system correction is kept; the display stays
 * reported by the display rule (with the candidates its wording denotes). Any other new error still
 * withdraws the change.
 */
export function exposedDisplay(e: { path: string; message: string }, changes: RepairChange[]): boolean {
  const m = /^Wrong (?:Display Name|whitespace in Display) .* for (\S+?)#(\S+?)[.\s]/.exec(e.message) ?? /^Wrong (?:Display Name|whitespace in Display) .* for (\S+?)#(\S+)$/.exec(e.message);
  if (!m) return false;
  const system = m[1];
  const ep = relPath(e.path.replace(/\/\*[^*]*\*\//g, ""));
  return changes.some((c) => {
    if (c.rule !== "system" || !/\.system$/.test(c.path) || c.to !== system) return false;
    const cp = relPath(c.path.replace(/\.system$/, ""));
    if (ep.entry !== null && cp.entry !== null && ep.entry !== cp.entry) return false;
    // the error at the Coding itself, its display, or (validator style) at the element holding it
    return ep.rel === cp.rel || ep.rel.startsWith(`${cp.rel}.`) || cp.rel.startsWith(`${ep.rel}.`) || cp.rel.startsWith(`${ep.rel}[`);
  });
}

export function blockKey(rule: RepairRule, path: string): string {
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
    for (let pass = 0; pass < 4; pass++) {
      const r = await repairShapes(session, sites, rp, skipRule("shape"), skipRule("empty"));
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
  if (phases.has("slices")) {
    const r = await repairSlices(session, sites, rp, skipRule("fixed-slice"));
    changes.push(...r.changes);
    issues.push(...r.issues);
    if (r.changes.length) sites = await walk();
  }
  if (phases.has("alternatives")) {
    const r = await repairAlternativeCodings(session, sites, rp, skipRule("alt-coding"), profilesFor);
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
    const r = repairDates(sites, rp, (p, rule) => skipRule(rule ?? "roc-date")(p), opts.timezone, opts.timezoneSource ?? null);
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
  /** The site timezone (UTC offset or IANA name; see timezone.ts). */
  timezone?: string | null;
  timezoneSource?: string | null;
  phases?: RepairOptions["phases"];
}

/**
 * The Bundle's envelope (envelope.ts), its own shape (entry-level misplaced properties, single
 * values) and every entry resource, in place.
 *
 * Verification (v14.1): each entry resource is verified stand-alone (repairResource), and then the
 * whole Bundle is validated before and after — an error the repaired Bundle has that the Bundle as
 * written did not (compared by message, entry indices mapped through dropped duplicates) is owed to
 * the changes on the entry / path it is reported at (else the Bundle-level changes); those are
 * withdrawn and the Bundle is repaired again from the original without them (≤ 3 rounds). If an
 * error still cannot be attributed, every change is withdrawn: a repair never adds an error to the
 * validator's verdict of the Bundle — including errors only the Bundle context shows (references,
 * entry slices, document rules), which the per-resource check cannot see.
 */
export async function repairBundle(bundle: Record<string, any>, deps: RepairDeps, opts: BundleRepairOptions = {}): Promise<RepairResult> {
  if (!isObject(bundle)) return { changes: [], issues: [] };
  // The envelope (resourceType, numbered entry keys) first: it makes the argument a Bundle the
  // validator can read at all, so it is the baseline of the verification, not a change under it.
  const env = new Set(opts.phases ?? ALL_PHASES).has("shape") ? repairBundleEnvelope(bundle) : { changes: [], issues: [] };
  const withEnv = (r: RepairResult): RepairResult => ({ changes: [...env.changes, ...r.changes], issues: [...env.issues, ...r.issues] });
  if (bundle.resourceType !== "Bundle") return withEnv({ changes: [], issues: [] });
  if (!deps.validate) return withEnv((await repairBundleOnce(bundle, deps, opts, new Set())).result);
  const original = cloneTree(bundle);
  const blocked = new Set<string>();
  const withdrawn: RepairIssue[] = [];
  let run = await repairBundleOnce(bundle, deps, opts, blocked);
  for (let round = 0; round < 4 && run.result.changes.length; round++) {
    const fresh = (await newBundleErrors(deps, original, bundle, run.removed)).filter((e) => !exposedDisplay(e, run.result.changes));
    if (!fresh.length) break;
    const blame = round < 3 ? attributeBundle(fresh, run.result.changes, bundle) : [];
    const restore = (): void => {
      for (const k of Object.keys(bundle)) delete bundle[k];
      Object.assign(bundle, cloneTree(original));
    };
    if (!blame.length) {
      // Not attributable (or still failing after three rounds): nothing is applied.
      restore();
      withdrawn.push({
        path: "Bundle", rule: "shape", severity: "warning",
        message: `content repairs not applied: the repaired Bundle would have an error the Bundle as written does not have (${fresh[0].message.slice(0, 200)}) and it cannot be traced to one change; the Bundle is returned as written`,
      });
      run = { result: { changes: [], issues: run.result.issues.filter((i) => i.severity === "error") }, removed: [] };
      break;
    }
    for (const b of blame) {
      blocked.add(blockKey(b.change.rule, b.change.path));
      if (b.change.from && typeof b.change.from === "object" && typeof (b.change.from as any).path === "string") blocked.add(blockKey(b.change.rule, (b.change.from as any).path));
      withdrawn.push({
        path: b.change.path, rule: b.change.rule, severity: "warning",
        message: `not applied: changing ${b.change.path} ${describeChange(b.change)} would leave the Bundle with an error it does not have now (${b.error.slice(0, 200)}); fix that first`,
      });
    }
    restore();
    run = await repairBundleOnce(bundle, deps, opts, blocked);
  }
  const seen = new Set<string>();
  const extra = withdrawn.filter((w) => !seen.has(w.path + w.message) && !!seen.add(w.path + w.message));
  return withEnv({ changes: run.result.changes, issues: [...run.result.issues, ...extra] });
}

/** Entry index of a reported path (`Bundle.entry[3].resource…`), else null. */
function entryIndex(path: string): number | null {
  const m = /^Bundle\.entry\[(\d+)\]/.exec(path);
  return m ? Number(m[1]) : null;
}

/** Errors of the repaired Bundle that the Bundle as written did not have (whole-Bundle validation). */
async function newBundleErrors(deps: RepairDeps, before: Record<string, any>, after: Record<string, any>, removed: number[]): Promise<Array<{ path: string; message: string }>> {
  let pre: Array<{ severity?: string; path?: string; message?: string }>;
  let post: Array<{ severity?: string; path?: string; message?: string }>;
  try {
    [pre, post] = await Promise.all([deps.validate!(toPlain(before) as Record<string, any>, []), deps.validate!(toPlain(after) as Record<string, any>, [])]);
  } catch {
    return [];
  }
  // After-indices → original indices (duplicates dropped shift the entries after them).
  const drops = [...removed].sort((a, b) => a - b);
  const orig = (k: number): number => {
    let i = k;
    for (const d of drops) if (d <= i) i++;
    return i;
  };
  const remap = (s: string): string => (drops.length ? s.replace(/entry\[(\d+)\]/g, (_, n) => `entry[${orig(Number(n))}]`) : s);
  const key = (m: unknown): string => msgKey(m);
  const left = new Map<string, number>();
  for (const i of pre) if (ERROR_SEV.has(String(i.severity))) left.set(key(i.message), (left.get(key(i.message)) ?? 0) + 1);
  const out: Array<{ path: string; message: string }> = [];
  for (const i of post) {
    if (!ERROR_SEV.has(String(i.severity))) continue;
    const k = key(remap(String(i.message ?? "")));
    const n = left.get(k) ?? 0;
    if (n > 0) {
      left.set(k, n - 1);
      continue;
    }
    out.push({ path: String(i.path ?? ""), message: String(i.message ?? "") });
  }
  return out;
}

/**
 * The changes a new Bundle error is owed to: those at / under / above its path when the path is
 * inside an element (not a resource root); else those in the entries its message names (by index
 * or fullUrl — a reference error is reported at the referrer but caused at the target); else
 * those in its own entry; else the Bundle-level ones.
 */
function attributeBundle(errors: Array<{ path: string; message: string }>, changes: RepairChange[], bundle: Record<string, any>): Array<{ change: RepairChange; error: string }> {
  const out: Array<{ change: RepairChange; error: string }> = [];
  const add = (c: RepairChange, e: string): void => {
    if (!out.some((x) => x.change === c)) out.push({ change: c, error: e });
  };
  const fromPath = (c: RepairChange): string | null => (c.from && typeof c.from === "object" && typeof (c.from as any).path === "string" ? (c.from as any).path : null);
  const near = (p: string, ep: string): boolean => p === ep || ep.startsWith(`${p}.`) || ep.startsWith(`${p}[`) || p.startsWith(`${ep}.`) || p.startsWith(`${ep}[`);
  const inEntry = (c: RepairChange, i: number): boolean => entryIndex(c.path) === i || (fromPath(c) !== null && entryIndex(fromPath(c)!) === i);
  const entries: unknown[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  const byUrl = new Map<string, number>();
  for (const [i, e] of entries.entries()) if (isObject(e) && typeof e.fullUrl === "string") byUrl.set(e.fullUrl.toLowerCase(), i);
  for (const e of errors) {
    const ep = e.path.replace(/\/\*[^*]*\*\//g, "");
    const inside = /^Bundle\.entry\[\d+\]\.resource[.[]/.test(ep) || (/^Bundle[.[]/.test(ep) && !/^Bundle\.entry\[\d+\](\.resource)?$/.test(ep));
    const hits = inside ? changes.filter((c) => near(c.path, ep) || (fromPath(c) !== null && near(fromPath(c)!, ep))) : [];
    if (hits.length) {
      for (const c of hits) add(c, e.message);
      continue;
    }
    const named = new Set<number>();
    for (const m of e.message.matchAll(/entry\[(\d+)\]/g)) named.add(Number(m[1]));
    for (const m of e.message.matchAll(/urn:(?:uuid|oid):[0-9a-z.-]+/gi)) {
      const i = byUrl.get(m[0].toLowerCase());
      if (i !== undefined) named.add(i);
    }
    const own = entryIndex(ep);
    const inNamed = changes.filter((c) => [...named].some((i) => i !== own && inEntry(c, i)));
    if (inNamed.length) {
      for (const c of inNamed) add(c, e.message);
      continue;
    }
    const inOwn = own !== null ? changes.filter((c) => inEntry(c, own) || [...named].some((i) => inEntry(c, i))) : [];
    if (inOwn.length) {
      for (const c of inOwn) add(c, e.message);
      continue;
    }
    const bundleLevel = changes.filter((c) => !/^Bundle\.entry\[\d+\]\.resource[.[]/.test(c.path));
    for (const c of bundleLevel) add(c, e.message);
  }
  return out;
}

async function repairBundleOnce(bundle: Record<string, any>, deps: RepairDeps, opts: BundleRepairOptions, blocked: Set<string>): Promise<{ result: RepairResult; removed: number[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  const allow = (rule: RepairRule, path: string): boolean => !blocked.has(blockKey(rule, path));
  const phases = new Set(opts.phases ?? ALL_PHASES);
  let removed: number[] = [];
  if (!isObject(bundle) || bundle.resourceType !== "Bundle") return { result: { changes, issues }, removed };
  const session = new Session(deps);
  if (phases.has("shape")) {
    const r = await repairBundleEntries(session, bundle, (rule, p) => allow(rule, p));
    changes.push(...r.changes);
    issues.push(...r.issues);
    removed = r.removed;
  }
  const before = (Array.isArray(bundle.entry) ? bundle.entry : []).map((e: unknown) => cloneTree(e));
  if (phases.has("shape")) {
    // Entry resources without resourceType first (so the Bundle walk sees their definitions).
    const entries: unknown[] = Array.isArray(bundle.entry) ? bundle.entry : [];
    for (const [i, e] of entries.entries()) {
      if (!isObject(e) || !isObject(e.resource) || (typeof e.resource.resourceType === "string" && e.resource.resourceType)) continue;
      const path = `Bundle.entry[${i}].resource.resourceType`;
      if (!allow("shape", path)) continue;
      const inferred = await inferResourceType(session, e.resource);
      if (!inferred) continue;
      insertKey(e.resource, "resourceType", inferred.type, Object.keys(e.resource));
      changes.push({ path, from: null, to: inferred.type, rule: "shape", reason: inferred.reason });
    }
    for (let pass = 0; pass < 3; pass++) {
      const sites = (await walkResource(session, bundle)).filter((s) => !/^Bundle\.entry\[\d+\]\.resource[.[]/.test(s.path));
      const r = await repairShapes(session, sites, (p) => p, (p) => !allow("shape", p), (p) => !allow("empty", p));
      changes.push(...r.changes);
      if (pass === 0) issues.push(...r.issues);
      if (!r.changes.length) break;
    }
  }
  const bundleLevel = [...changes];
  const entries: unknown[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  const entryOpts = (rootPath: string): RepairOptions => ({ rootPath, timezone: opts.timezone, timezoneSource: opts.timezoneSource, phases: opts.phases, session, blocked });
  for (const [i, e] of entries.entries()) {
    if (!isObject(e) || !isObject(e.resource)) continue;
    const rootPath = `Bundle.entry[${i}].resource`;
    let r = await repairResource(e.resource, deps, entryOpts(rootPath));
    // Entry-level reshapes (a moved meta.profile, an inferred resourceType) are verified against the
    // entry as written, after its own repairs: if the entry ends with an error it did not have, they
    // are withdrawn and the entry is repaired as written.
    const prefix = `Bundle.entry[${i}]`;
    const mine = bundleLevel.filter((c) => (c.path === prefix || c.path.startsWith(`${prefix}.`) || c.path.startsWith(`${prefix}[`)) && !(c.to === null && c.path === prefix));
    if (mine.length && deps.validate && isObject(before[i])) {
      const orig = isObject(before[i].resource) ? before[i].resource : null;
      // Written without resourceType the resource was not validated at all: every error it has now is new.
      const fresh = orig && typeof orig.resourceType === "string" ? await newErrors(deps, orig, e.resource, {}) : await allErrors(deps, e.resource);
      if (fresh.length) {
        const restored = cloneTree(before[i]) as Record<string, any>;
        entries[i] = restored;
        for (const c of mine) {
          changes.splice(changes.indexOf(c), 1);
          blocked.add(blockKey(c.rule, c.path));
          issues.push({ path: c.path, rule: c.rule, severity: "warning", message: `not applied: changing ${c.path} ${describeChange(c)} would leave the resource with an error it does not have now (${fresh[0].message.slice(0, 200)}); fix that first` });
        }
        r = isObject(restored.resource) ? await repairResource(restored.resource, deps, entryOpts(rootPath)) : { changes: [], issues: [] };
      }
    }
    changes.push(...r.changes);
    issues.push(...r.issues);
  }
  return { result: { changes, issues }, removed };
}

/** Counts per rule (tool summaries). */
export function countByRule(changes: RepairChange[]): Record<RepairRule, number> {
  const out = Object.fromEntries(ALL_RULES.map((r) => [r, 0])) as Record<RepairRule, number>;
  for (const c of changes) if (c.rule in out) out[c.rule]++;
  return out;
}
