/**
 * ISSUES_v16 R3 — why an element / entry does not match a slice or a profile. Three validator
 * messages (HL7 validator_cli wording) get an additive explanation:
 *
 *   "This element does not match any known slice defined in the profile P and slicing is CLOSED"
 *       → `slice_match`: the closest slice of P's slicing (scored by discriminator agreement:
 *         resourceType, meta.profile relation, fixed / pattern values, required bindings), which
 *         discriminator failed and how, and the errors that block the match;
 *   "Slice 'S': a matching slice is required, but not found (from P)"
 *       → `slice_match`: the closest item of the sliced list (an unmatched one first) and why it
 *         fails S, or — no item of the slice's type — what to author (`add_resource`, never invented);
 *   "Unable to find a profile match for R among choices: P1, P2"
 *       → `profile_match`: the closest choice, the failed checks, the blocking errors.
 *
 * Blocking errors are the target's errors against the closest profile: its own reported errors
 * when it declares that profile, else a stand-alone validation (`deps.validateAgainst`, the same
 * validator), at most `maxValidations` distinct (resource, profile) pairs per call, planned in issue
 * order before anything runs (deterministic). A `set_profile` suggestion (patch meta.profile) is
 * added when the closest profile is unique and the resource does not declare it correctly.
 * Existing issue fields are never changed (additive only); everything fails open.
 */

import {
  checkItemAgainstSlice,
  declaredProfiles,
  elementsById,
  isObj,
  profileAffinity,
  slicingOf,
  stripVersion,
  type DiscriminatorFailure,
  type SliceCheck,
  type Slicing,
} from "../fhirSliceMatch.js";
import { findTarget, parseProfileMatch } from "./references.js";
import type { Suggestion, SuggestionDeps } from "./types.js";
import { nodeAt } from "./util.js";

export const RE_CLOSED_SLICE = /^This element does not match any known slice defined in the profile (\S+) and slicing is CLOSED$/;
export const RE_MISSING_SLICE = /^Slice '([^']+)': a matching slice is required, but not found \(from (\S+)\)$/;
const RE_PROFILE_MATCH = /^Unable to find a profile match for /;

const MAX_BLOCKING = 5;
const MAX_ISSUES = 40;

export interface SliceMatchInfo {
  /** Element id of the sliced element and the profile that slices it. */
  sliced: string;
  profile: string;
  rules: string;
  discriminators: string[];
  /** missing-slice issues: the slice that is required. */
  slice?: string;
  /** The closest slice (closed-slice issue) / the closest item (missing-slice issue). */
  closest: { slice: string; profile: string | null; score: number; item?: string } | null;
  /** Next candidates (≤ 2). */
  others?: Array<{ slice: string; profile: string | null; score: number; item?: string }>;
  failed: DiscriminatorFailure[];
  /** Errors of the item's resource against the closest profile (≤ 5), re-rooted at the item. */
  blocking?: Array<{ path: string; message: string }>;
  blocking_total?: number;
  hint: string;
}

export interface ProfileMatchInfo {
  reference: string;
  target: { path: string; resourceType: string | null; declared: string[] };
  closest: { profile: string; score: number } | null;
  others?: Array<{ profile: string; score: number }>;
  failed: DiscriminatorFailure[];
  blocking?: Array<{ path: string; message: string }>;
  blocking_total?: number;
  hint: string;
}

export interface SliceOptions {
  /** Distinct (resource, profile) stand-alone validations per call (default 12). */
  maxValidations?: number;
}

interface Need {
  target: Record<string, any>;
  profile: string;
  /** Validator path of the target in this instance. */
  prefix: string;
}

type Blocking = Array<{ path: string; message: string }>;

interface Pending {
  issue: Record<string, any>;
  field: "slice_match" | "profile_match";
  /** `pick` = the index into `needs` chosen (fewest blocking errors; 0 when nothing was validated). */
  build: (pick: number, blocking: Blocking | null, total: number, decisive: boolean) => { info: SliceMatchInfo | ProfileMatchInfo; suggestions: Suggestion[] };
  /** Candidate (target, profile) pairs, closest first; several when the cheap scores cannot separate them. */
  needs: Need[];
  /** Per need: own errors to use instead of validating (the target declares the profile), else null. */
  own: Array<Blocking | null>;
  /** Per need: extra cost of choosing it — 2 per fixed / pattern / required-binding value that differs (another kind of resource). */
  penalties?: number[];
}

const isError = (i: Record<string, any>): boolean => i.severity === "error" || i.severity === "fatal";

function reroot(rt: string, prefix: string, path: string): string {
  const rel = path === rt ? "" : path.startsWith(`${rt}.`) ? path.slice(rt.length) : `.${path}`;
  return prefix + rel;
}

/** Errors the validator already reported under `prefix` (the target validated against its declared profile). */
function ownErrors(all: Array<Record<string, any>>, prefix: string, except: Record<string, any>): Array<{ path: string; message: string }> {
  return all
    .filter((i) => i !== except && isError(i) && (String(i.path) === prefix || String(i.path).startsWith(`${prefix}.`) || String(i.path).startsWith(`${prefix}[`)))
    .map((i) => ({ path: String(i.path), message: String(i.message) }));
}

/** Nested reference-chain / slice errors last: they are explained by their own issues. */
function orderBlocking(list: Array<{ path: string; message: string }>): Array<{ path: string; message: string }> {
  const late = (m: string): number => (RE_PROFILE_MATCH.test(m) || RE_CLOSED_SLICE.test(m) ? 1 : 0);
  const seen = new Set<string>();
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => late(a.x.message) - late(b.x.message) || a.i - b.i)
    .map((y) => y.x)
    .filter((x) => !seen.has(x.path + "\u0000" + x.message) && !!seen.add(x.path + "\u0000" + x.message));
}

function setProfileSuggestion(target: Record<string, any>, prefix: string, profile: string, blockingTotal: number | null, why: string): Suggestion | null {
  const decl = declaredProfiles(target);
  if (!decl.malformed && decl.list.some((p) => stripVersion(p) === stripVersion(profile))) return null;
  const has = isObj(target.meta) && target.meta.profile !== undefined;
  const others = decl.list.filter((p) => stripVersion(p) !== stripVersion(profile));
  return {
    value: profile,
    kind: "set_profile",
    confidence: blockingTotal === 0 ? 0.9 : 0.6,
    reason:
      `${why}; declare it in meta.profile${others.length ? ` (instead of ${others.join(", ")})` : ""}` +
      (blockingTotal ? ` — the resource must also be fixed: it has ${blockingTotal} error(s) against that profile (blocking)` : blockingTotal === 0 ? " — the resource has no other error against that profile" : ""),
    patch: { op: has ? "replace" : "add", path: `${prefix}.meta.profile`, value: [profile] },
  };
}

/** The sliced element's id for an issue (the validator sets `element`; otherwise from the path). */
function slicedIdOf(E: Map<string, any>, issue: Record<string, any>, type: string): string | null {
  const el = typeof issue.element === "string" ? issue.element : null;
  if (el && E.has(el)) return el;
  const path = String(issue.path || "");
  const m = /\.resource((?:\.[^.]+)*)$/.exec(path);
  let rest = m && type !== "Bundle" ? m[1] : path.replace(/^[A-Z][A-Za-z]+/, "");
  rest = rest.replace(/\[\d+\]/g, "");
  const ep = `${type}${rest}`;
  for (const [id, e] of E) if (e.path === ep && isObj(e.slicing) && !id.includes(":")) return id;
  for (const [id, e] of E) if (e.path === ep && isObj(e.slicing)) return id;
  return null;
}

function rankChecks(checks: SliceCheck[]): SliceCheck[] {
  return checks.map((c, i) => ({ c, i })).sort((a, b) => b.c.score - a.c.score || a.i - b.i).map((x) => x.c);
}

function describeFailed(f: DiscriminatorFailure[]): string {
  return f.slice(0, 3).map((x) => x.detail).join("; ");
}

/**
 * Attach `slice_match` / `profile_match` (and `set_profile` / `add_resource` suggestions) to the
 * slice and profile-match issues of `issues`, in place. Never throws.
 */
export async function attachSliceExplanations(issues: Array<Record<string, any>>, root: Record<string, any>, deps: SuggestionDeps, opts: SliceOptions = {}): Promise<void> {
  const maxValidations = opts.maxValidations ?? 12;
  const sdMemo = new Map<string, Promise<Record<string, any> | null>>();
  const fetchSd = (url: string): Promise<Record<string, any> | null> => {
    const k = String(url);
    if (!sdMemo.has(k)) sdMemo.set(k, deps.fetchStructureDefinition(k).catch(() => null));
    return sdMemo.get(k)!;
  };
  const sliceDeps = { fetchStructureDefinition: fetchSd, valueSetContains: deps.valueSetContains?.bind(deps) };
  const eMemo = new Map<string, Map<string, any>>();
  const elementsOf = async (url: string): Promise<{ sd: Record<string, any>; E: Map<string, any> } | null> => {
    const sd = await fetchSd(url);
    if (!sd) return null;
    if (!eMemo.has(url)) eMemo.set(url, elementsById(sd));
    return { sd, E: eMemo.get(url)! };
  };
  const bundle = root.resourceType === "Bundle" ? root : null;
  // Items with a closed-slice issue (unmatched), per sliced profile.
  const unmatched = new Set<string>();
  for (const i of issues) {
    const m = RE_CLOSED_SLICE.exec(String(i.message || ""));
    if (m) unmatched.add(`${m[1]}\u0000${String(i.path)}`);
  }

  const pending: Pending[] = [];
  let considered = 0;
  for (const issue of issues) {
    if (considered >= MAX_ISSUES) break;
    if (!isObj(issue) || !isError(issue)) continue;
    const msg = String(issue.message || "");
    try {
      const closed = RE_CLOSED_SLICE.exec(msg);
      const missing = closed ? null : RE_MISSING_SLICE.exec(msg);
      if (closed || missing) {
        considered++;
        const profile = closed ? closed[1] : missing![2];
        const loaded = await elementsOf(String(issue.profile || profile));
        if (!loaded) continue;
        const { sd, E } = loaded;
        const baseId = missing ? missing[1].slice(0, missing[1].lastIndexOf(":")) : slicedIdOf(E, issue, String(sd.type || ""));
        if (!baseId) continue;
        const slicing = slicingOf(E, baseId);
        if (!slicing || !slicing.slices.length) continue;
        const p = closed ? planClosed(issue, root, bundle, E, slicing, profile, sliceDeps) : planMissing(issue, root, bundle, E, slicing, missing![1], profile, sliceDeps, unmatched);
        const plan = await p;
        if (plan) pending.push({ issue, field: "slice_match", ...plan, own: plan.needs.map((n) => (declares(n.target, n.profile) ? ownErrors(issues, n.prefix, issue) : null)) });
        continue;
      }
      if (RE_PROFILE_MATCH.test(msg)) {
        considered++;
        const plan = await planProfileMatch(issue, root, fetchSd);
        if (plan) {
          const own = plan.needs.map((n) => {
            if (declares(n.target, n.profile)) return ownErrors(issues, n.prefix, issue);
            const fromCause = Array.isArray(issue.caused_by) ? issue.caused_by.filter((c: any) => c && c.profile === n.profile).map((c: any) => ({ path: String(c.path), message: String(c.message) })) : [];
            return fromCause.length ? fromCause : null;
          });
          pending.push({ issue, field: "profile_match", ...plan, own });
        }
      }
    } catch {
      // fail-open: this issue gets no explanation
    }
  }

  // Validations: distinct (target, profile) pairs in issue order, up to the budget.
  const keyOf = (n: Need): string => `${n.prefix}\u0000${stripVersion(n.profile)}`;
  const planned: Need[] = [];
  plan: for (const p of pending) {
    for (const [i, n] of p.needs.entries()) {
      if (p.own[i] !== null || planned.some((x) => keyOf(x) === keyOf(n))) continue;
      if (planned.length >= maxValidations || !deps.validateAgainst) break plan;
      planned.push(n);
    }
  }
  const results = new Map<string, Array<{ path: string; message: string }> | null>();
  const queue = [...planned];
  const worker = async (): Promise<void> => {
    for (let n = queue.shift(); n; n = queue.shift()) {
      try {
        const list = await deps.validateAgainst!(n.target, n.profile);
        const rt = String(n.target.resourceType || "");
        results.set(keyOf(n), list.filter(isError).map((i) => ({ path: reroot(rt, n.prefix, String(i.path || "")), message: String(i.message || "") })));
      } catch {
        results.set(keyOf(n), null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

  for (const p of pending) {
    try {
      // The candidate of least cost (blocking errors + penalties; closest-first on ties); unvalidated ones lose.
      let pick = 0;
      let blocking: Blocking | null = null;
      let best = Infinity;
      const costs: number[] = [];
      for (const [i, n] of p.needs.entries()) {
        const b = p.own[i] !== null ? p.own[i] : results.has(keyOf(n)) ? results.get(keyOf(n)) ?? null : null;
        if (b === null) continue;
        const cost = b.length + (p.penalties?.[i] ?? 0);
        costs.push(cost);
        if (cost < best) {
          best = cost;
          pick = i;
          blocking = b;
        }
      }
      // decisive: several candidates were validated and exactly one has the least cost
      const decisive = costs.length > 1 && blocking !== null && costs.filter((c) => c === best).length === 1;
      const ordered = blocking ? orderBlocking(blocking) : null;
      const { info, suggestions } = p.build(pick, ordered ? ordered.slice(0, MAX_BLOCKING) : null, ordered ? ordered.length : -1, decisive);
      p.issue[p.field] = info;
      if (suggestions.length) {
        const cur: Suggestion[] = Array.isArray(p.issue.suggestions) ? p.issue.suggestions : [];
        p.issue.suggestions = [...cur, ...suggestions.filter((s) => !cur.some((c) => c.kind === s.kind && c.value === s.value))];
      }
    } catch {
      // fail-open
    }
  }
}

function declares(target: Record<string, any>, profile: string): boolean {
  const d = declaredProfiles(target);
  return !d.malformed && d.list.some((p) => stripVersion(p) === stripVersion(profile));
}

type Plan = { build: Pending["build"]; needs: Need[]; penalties?: number[] };

const valueMismatches = (f: DiscriminatorFailure[]): number => 2 * f.filter((x) => x.reason === "pattern-differs" || x.reason === "not-in-valueset").length;

/**
 * Candidates the cheap score cannot separate from the closest, closest first (at most 3): within
 * 0.15 — or 0.3 when the closest is not the declared profile (no meta.profile signal), since the
 * cheap checks then see only patterns and top-level required elements.
 */
const TIE = 0.15;
const TIE_UNDECLARED = 0.3;
const MAX_TIED = 3;

function withBlocking<T extends { blocking?: unknown; blocking_total?: number }>(info: T, blocking: Array<{ path: string; message: string }> | null, total: number): T {
  if (blocking && total >= 0) {
    info.blocking = blocking;
    info.blocking_total = total;
  }
  return info;
}

async function planClosed(
  issue: Record<string, any>,
  root: Record<string, any>,
  bundle: Record<string, any> | null,
  E: Map<string, any>,
  slicing: Slicing,
  profile: string,
  deps: { fetchStructureDefinition(url: string): Promise<Record<string, any> | null>; valueSetContains?: SuggestionDeps["valueSetContains"] },
): Promise<Plan | null> {
  const path = String(issue.path || "");
  const item = nodeAt(root, path);
  if (item === undefined) return null;
  const checks: SliceCheck[] = [];
  for (const s of slicing.slices) checks.push(await checkItemAgainstSlice(E, slicing, s, item, bundle ?? root, deps));
  const ranked = rankChecks(checks);
  const best = ranked[0];
  const typed = ranked.filter((c) => !c.failed.some((f) => f.reason === "resource-type-differs"));
  const base = {
    sliced: slicing.baseId,
    profile: stripVersion(profile),
    rules: slicing.rules,
    discriminators: slicing.discriminators.map((d) => `${d.type}:${d.path}`),
  };
  if (!best || best.score <= 0 || !typed.length) {
    const kinds = [...new Set(slicing.slices.map((s) => s.name))];
    const rtNow = isObj(item) && isObj(item.resource) ? item.resource.resourceType : isObj(item) ? item.resourceType : undefined;
    return {
      needs: [],
      build: () => ({
        info: {
          ...base,
          closest: null,
          failed: best ? best.failed.slice(0, 3) : [],
          hint: `no slice of ${stripVersion(profile)} takes this ${rtNow ? `${rtNow} ` : ""}element (slices: ${kinds.slice(0, 12).join(", ")}${kinds.length > 12 ? ", …" : ""}); with CLOSED slicing it must be removed or changed to match one of them`,
        },
        suggestions: [],
      }),
    };
  }
  const prefixOf = (c: SliceCheck): string => {
    const conf = c.needsConformance[0];
    return conf && conf.relPath && conf.relPath !== "$this" ? `${path}.${conf.relPath}` : path;
  };
  const declaredExact = (c: SliceCheck): boolean => !!c.needsConformance[0] && declares(c.needsConformance[0].target, c.needsConformance[0].profile);
  // Several same-type slices the cheap score cannot separate (no / another meta.profile): validate each, keep the best.
  const tied = declaredExact(typed[0]) ? [typed[0]] : typed.filter((c) => c.needsConformance.length && typed[0].score - c.score < TIE_UNDECLARED).slice(0, MAX_TIED);
  const cands = tied.length ? tied : [typed[0]];
  const needs: Need[] = cands.filter((c) => c.needsConformance.length).map((c) => ({ target: c.needsConformance[0].target, profile: c.needsConformance[0].profile, prefix: prefixOf(c) }));
  return {
    needs,
    penalties: cands.filter((c) => c.needsConformance.length).map((c) => valueMismatches(c.failed)),
    build: (pick, blocking, total, decisive) => {
      const top = cands[pick] ?? cands[0];
      const rest = typed.filter((c) => c !== top);
      const second = rest[0];
      const conf = top.needsConformance[0];
      const prefix = prefixOf(top);
      // unique: clearly the best by the cheap score, or the only tied candidate with the fewest blocking errors
      const unique = !second || top.score - second.score >= 0.1 || decisive;
      const info: SliceMatchInfo = withBlocking(
        {
          ...base,
          closest: { slice: top.slice.name, profile: top.profiles[0] ?? null, score: top.score },
          ...(rest.length ? { others: rest.slice(0, 2).map((c) => ({ slice: c.slice.name, profile: c.profiles[0] ?? null, score: c.score })) } : {}),
          failed: top.failed,
          hint:
            `closest slice is '${top.slice.name}'${top.profiles[0] ? ` (${stripVersion(top.profiles[0])})` : ""}` +
            (top.failed.length ? `: ${describeFailed(top.failed)}` : "") +
            (total > 0 ? `; ${total} error(s) against that profile block the match (see blocking)` : total === 0 && conf ? "; the resource has no error against that profile" : "") +
            (decisive ? `; chosen among ${cands.map((c) => `'${c.slice.name}'`).join(", ")} by the fewest errors and differing fixed / pattern values` : "") +
            (unique ? "" : `; '${second.slice.name}' is about as close`),
        } as SliceMatchInfo,
        blocking,
        total,
      );
      const sug: Suggestion[] = [];
      if (conf && unique) {
        const s = setProfileSuggestion(conf.target, prefix, conf.profile, total >= 0 ? total : null, `the closest slice of ${stripVersion(profile)} is '${top.slice.name}' (${stripVersion(conf.profile)})`);
        if (s) sug.push(s);
      }
      return { info, suggestions: sug };
    },
  };
}

async function planMissing(
  issue: Record<string, any>,
  root: Record<string, any>,
  bundle: Record<string, any> | null,
  E: Map<string, any>,
  slicing: Slicing,
  sliceId: string,
  profile: string,
  deps: { fetchStructureDefinition(url: string): Promise<Record<string, any> | null>; valueSetContains?: SuggestionDeps["valueSetContains"] },
  unmatched: Set<string>,
): Promise<Plan | null> {
  const slice = slicing.slices.find((s) => s.id === sliceId);
  if (!slice) return null;
  const parentPath = String(issue.path || "");
  const key = slicing.baseId.split(".").pop()!.replace(/:.*$/, "").replace(/\[x\]$/, "");
  const holder = nodeAt(root, parentPath);
  const raw = isObj(holder) ? holder[key] : undefined;
  const items: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const base = {
    sliced: slicing.baseId,
    profile: stripVersion(profile),
    rules: slicing.rules,
    discriminators: slicing.discriminators.map((d) => `${d.type}:${d.path}`),
    slice: slice.name,
  };
  const scored: Array<{ c: SliceCheck; i: number; path: string; free: boolean }> = [];
  for (const [i, it] of items.entries()) {
    const c = await checkItemAgainstSlice(E, slicing, slice, it, bundle ?? root, deps);
    if (c.failed.some((f) => f.reason === "resource-type-differs") || c.score <= 0) continue;
    const p = `${parentPath}.${key}[${i}]`;
    scored.push({ c, i, path: p, free: unmatched.has(`${stripVersion(profile)}\u0000${p}`) || unmatched.has(`${profile}\u0000${p}`) });
  }
  scored.sort((a, b) => Number(b.free) - Number(a.free) || b.c.score - a.c.score || a.i - b.i);
  // What the slice takes (for the "author it" guidance).
  const probe = await checkItemAgainstSlice(E, slicing, slice, {}, bundle ?? root, deps);
  const sliceProfiles = probe.profiles;
  const sliceTypes = await typesOf(sliceProfiles, deps.fetchStructureDefinition);
  if (!scored.length) {
    const needs = probe.failed.filter((f) => f.reason === "value-missing" && f.expected !== undefined);
    const what = sliceProfiles.length
      ? `a ${sliceTypes[0] ?? "resource"} conforming to ${stripVersion(sliceProfiles[0])}`
      : `an element matching slice '${slice.name}'${needs.length ? ` (${needs.map((f) => `${f.path} = ${JSON.stringify(f.expected).slice(0, 160)}`).join(", ")})` : ` (${base.discriminators.join(", ")})`}`;
    return {
      needs: [],
      build: () => ({
        info: {
          ...base,
          closest: null,
          failed: [],
          hint: `no ${sliceTypes[0] ?? "item"} here can fill slice '${slice.name}' (min ${slice.min}): author ${what} from the record and add it${key === "entry" ? " as a Bundle entry" : ""}; it is never invented`,
        },
        suggestions: sliceProfiles.length
          ? [{ value: stripVersion(sliceProfiles[0]), kind: "add_resource", confidence: 0.5, reason: `slice '${slice.name}' of ${stripVersion(profile)} needs at least ${slice.min} ${sliceTypes[0] ?? "resource"} conforming to ${stripVersion(sliceProfiles[0])}; none of the entries is one — author it from the record (never invented)` }]
          : [],
      }),
    };
  }
  const top = scored[0];
  const conf = top.c.needsConformance[0];
  const prefix = conf ? (conf.relPath && conf.relPath !== "$this" ? `${top.path}.${conf.relPath}` : top.path) : top.path;
  const unique = scored.length === 1 || scored[0].free !== scored[1].free || scored[0].c.score - scored[1].c.score >= 0.1;
  return {
    needs: conf ? [{ target: conf.target, profile: conf.profile, prefix }] : [],
    build: (_pick, blocking, total) => {
      const info: SliceMatchInfo = withBlocking(
        {
          ...base,
          closest: { slice: slice.name, profile: sliceProfiles[0] ?? null, score: top.c.score, item: top.path },
          ...(scored.length > 1 ? { others: scored.slice(1, 3).map((s) => ({ slice: slice.name, profile: sliceProfiles[0] ?? null, score: s.c.score, item: s.path })) } : {}),
          failed: top.c.failed,
          hint:
            `${top.path} is the closest candidate for slice '${slice.name}'${top.free ? " (it matches no other slice)" : " (it currently matches another slice)"}` +
            (top.c.failed.length ? `: ${describeFailed(top.c.failed)}` : "") +
            (total > 0 ? `; ${total} error(s) against ${stripVersion(conf?.profile ?? "")} block the match (see blocking)` : "") +
            (top.free ? "" : `; if it belongs to that other slice, author another ${sliceTypes[0] ?? "item"} for '${slice.name}'`),
        } as SliceMatchInfo,
        blocking,
        total,
      );
      const sug: Suggestion[] = [];
      if (conf && unique && top.free) {
        const s = setProfileSuggestion(conf.target, prefix, conf.profile, total >= 0 ? total : null, `${top.path} is the closest candidate for required slice '${slice.name}' (${stripVersion(conf.profile)})`);
        if (s) sug.push(s);
      }
      return { info, suggestions: sug };
    },
  };
}

async function typesOf(profiles: string[], fetchSd: (u: string) => Promise<Record<string, any> | null>): Promise<string[]> {
  const out: string[] = [];
  for (const p of profiles.slice(0, 3)) {
    const sd = await fetchSd(p);
    if (sd && typeof sd.type === "string" && !out.includes(sd.type)) out.push(sd.type);
  }
  return out;
}

async function planProfileMatch(issue: Record<string, any>, root: Record<string, any>, fetchSd: (u: string) => Promise<Record<string, any> | null>): Promise<Plan | null> {
  const pm = parseProfileMatch(String(issue.message || ""));
  if (!pm || !pm.profiles.length) return null;
  const t = findTarget(root, String(issue.path || ""), pm.ref);
  if (!t) return null;
  const scored: Array<{ profile: string; aff: ReturnType<typeof profileAffinity>; type: string | null; i: number }> = [];
  for (const [i, p] of pm.profiles.slice(0, 6).entries()) {
    const sd = await fetchSd(p);
    const aff = profileAffinity(t.resource, sd, p);
    // A "misspelling" that names an existing profile is another profile.
    if (aff.relation === "misspelled" && aff.declared && (await fetchSd(aff.declared))) aff.relation = "other-profile";
    scored.push({ profile: p, aff, type: sd && typeof sd.type === "string" ? sd.type : null, i });
  }
  scored.sort((a, b) => b.aff.score - a.aff.score || a.i - b.i);
  const top = scored[0];
  const rt = typeof t.resource.resourceType === "string" ? t.resource.resourceType : null;
  const decl = declaredProfiles(t.resource);
  const target = { path: t.pathPrefix, resourceType: rt, declared: decl.list };
  if (!top.aff.typeOk) {
    return {
      needs: [],
      build: () => ({
        info: {
          reference: pm.ref,
          target,
          closest: null,
          failed: [{ discriminator: "type", reason: "resource-type-differs", detail: `the reference points at a ${rt ?? "resource without resourceType"}; the element requires ${[...new Set(scored.map((s) => s.type).filter(Boolean))].join(" / ")}`, path: `${t.pathPrefix}.resourceType`, expected: [...new Set(scored.map((s) => s.type).filter(Boolean))], actual: rt }],
          hint: `the reference targets the wrong resource: point it at a ${[...new Set(scored.map((s) => s.type).filter(Boolean))].join(" / ")} entry conforming to ${stripVersion(pm.profiles[0])}`,
        } as ProfileMatchInfo,
        suggestions: [],
      }),
    };
  }
  type Scored = (typeof scored)[number];
  const failuresOf = (c: Scored): DiscriminatorFailure[] => {
    const failed: DiscriminatorFailure[] = [];
    const rel = c.aff.relation;
    const metaPath = `${t.pathPrefix}.meta.profile`;
    const want = stripVersion(c.profile);
    if (rel === "missing") failed.push({ discriminator: "profile", reason: "meta-profile-missing", detail: `the target does not declare ${want} in meta.profile (not required, but then it must conform to it)`, path: metaPath, expected: [c.profile] });
    else if (rel === "misspelled") failed.push({ discriminator: "profile", reason: "meta-profile-misspelled", detail: `meta.profile '${c.aff.declared}' looks like a misspelling of ${want}`, path: metaPath, expected: [c.profile], actual: c.aff.declared });
    else if (rel === "other-version") failed.push({ discriminator: "profile", reason: "meta-profile-other-version", detail: `meta.profile '${c.aff.declared}' names another version of ${want}`, path: metaPath, expected: [c.profile], actual: c.aff.declared });
    else if (rel === "malformed") failed.push({ discriminator: "profile", reason: "meta-profile-not-array", detail: "meta.profile must be an array of canonical URLs", path: metaPath, expected: [c.profile], actual: c.aff.declared });
    else if (rel === "other-profile") failed.push({ discriminator: "profile", reason: "meta-profile-other", detail: `the target declares '${c.aff.declared}', not ${want}`, path: metaPath, expected: [c.profile], actual: c.aff.declared });
    if (decl.malformed && rel !== "malformed") failed.push({ discriminator: "profile", reason: "meta-profile-not-array", detail: "meta.profile must be an array of canonical URLs", path: metaPath, actual: c.aff.declared });
    for (const x of c.aff.checks.filter((y) => !y.ok).slice(0, 4)) {
      failed.push(
        x.kind === "required"
          ? { discriminator: "profile", reason: "value-missing", detail: `${x.path} is required by ${want} and absent`, path: `${t.pathPrefix}.${x.path}` }
          : { discriminator: "profile", reason: x.actual === undefined ? "value-missing" : "pattern-differs", detail: `${x.path} must match ${JSON.stringify(x.expected).slice(0, 120)} (${x.kind} in ${want})${x.actual === undefined ? " and is absent" : `; found ${JSON.stringify(x.actual).slice(0, 120)}`}`, path: `${t.pathPrefix}.${x.path}`, expected: x.expected, ...(x.actual !== undefined ? { actual: x.actual } : {}) },
      );
    }
    return failed;
  };
  const typed = scored.filter((c) => c.aff.typeOk);
  const cands = top.aff.relation === "exact" ? [top] : typed.filter((c) => top.aff.score - c.aff.score < TIE_UNDECLARED).slice(0, MAX_TIED);
  return {
    needs: cands.map((c) => ({ target: t.resource, profile: c.profile, prefix: t.pathPrefix })),
    penalties: cands.map((c) => valueMismatches(failuresOf(c))),
    build: (pick, blocking, total, decisive) => {
      const best = cands[pick] ?? top;
      const rest = scored.filter((c) => c !== best);
      const failed = failuresOf(best);
      const unique = rest.length === 0 || best.aff.score - rest[0].aff.score >= 0.1 || decisive;
      const info: ProfileMatchInfo = withBlocking(
        {
          reference: pm.ref,
          target,
          closest: { profile: best.profile, score: best.aff.score },
          ...(rest.length ? { others: rest.slice(0, 2).map((c) => ({ profile: c.profile, score: c.aff.score })) } : {}),
          failed,
          hint:
            `${t.pathPrefix} (${rt}) must conform to ${stripVersion(best.profile)}` +
            (failed.length ? `: ${describeFailed(failed)}` : "") +
            (total > 0 ? `; ${total} error(s) against that profile block the match (see blocking)` : total === 0 ? "; it has no error against that profile" : "") +
            (decisive ? `; chosen among ${cands.map((c) => stripVersion(c.profile)).join(", ")} by the fewest errors and differing fixed / pattern values` : ""),
        } as ProfileMatchInfo,
        blocking,
        total,
      );
      const sug: Suggestion[] = [];
      if (unique) {
        const sp = setProfileSuggestion(t.resource, t.pathPrefix, best.profile, total >= 0 ? total : null, `the reference requires ${stripVersion(best.profile)}`);
        if (sp) sug.push(sp);
      }
      return { info, suggestions: sug };
    },
  };
}
