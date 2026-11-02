/**
 * extended_findings (parity v3, evaluator's ROUND 9): the second, independent layer of fhir_validate_bundle /
 * fhir_validate_resource. `issues` stay what validator_cli says; this block says what the local data can prove beyond it,
 * for the places where the validator only warns. Never part of `issues`, never changes `valid` / `checked_fully`, and
 * absent when there is nothing to report. It reports:
 *
 *   (a) code-not-in-held-codesystem (error): a Coding whose system the validator does not know (UNKNOWN_CODESYSTEM) is held
 *       here under a spelling of the same canonical (http / https, a CodeSystem published under its /ValueSet/ URL), and the
 *       complete copy does not have the code. Only a complete copy counts: a fragment, a self-declared partial list, an
 *       older edition or a copy outside the IG closure never yields a "not found" (they give `unverifiable`).
 *   (b) unresolvable-profile / malformed-profile (error): a meta.profile entry that resolves to no StructureDefinition of
 *       the closure, or is no canonical at all, with a fix; a unique mapping (mapProfile) is what fhir_finalize_bundle /
 *       fhir_finalize_resource apply.
 *   (c) no-local-data (`unverifiable`, counted, not blocking): a system the validator could not check either, and with no
 *       data here. A system the validator's terminology server does check is not here: that is `checked_fully: false`.
 *
 * Pure over ExtendedDeps. Findings carry the request's own values; nothing here logs.
 */

import { levenshtein } from "../fhirSuggestions/util.js";

export type ExtendedKind = "code-not-in-held-codesystem" | "unresolvable-profile" | "malformed-profile" | "no-local-data";

export interface ExtendedFix {
  /** What to do, in words. */
  action: string;
  /** The one canonical the value maps to; fhir_finalize_bundle / fhir_finalize_resource apply it. */
  replace_with?: string;
  /** Near canonicals when no unique mapping exists (best first). */
  candidates?: string[];
}

export interface ExtendedFinding {
  kind: ExtendedKind;
  severity: "error" | "unverifiable";
  /** Validator-style path of the element; for `no-local-data` the first occurrence. */
  path: string;
  message: string;
  system?: string;
  code?: string;
  /** The canonical the system is held under. */
  held_as?: string;
  profile?: string;
  fix?: ExtendedFix;
  /** `no-local-data`: why, and how many Codings it covers (one finding per system). */
  reason?: "no-data" | "held-copy-incomplete" | "held-outside-closure";
  count?: number;
}

export interface ExtendedFindings {
  /** errors block a release; unverifiable is counted and does not. `incomplete`: the layer could not finish, nothing is proven. */
  summary: { errors: number; unverifiable: number; incomplete?: true };
  findings: ExtendedFinding[];
}

/** What a Coding of a system the validator does not know finds in the local data. */
export type HeldVerdict =
  | { held: "no" }
  /** A copy has the code. */
  | { held: "found"; heldAs: string }
  /** A complete copy of the closure does not have it. */
  | { held: "absent"; heldAs: string }
  /** A copy exists but cannot prove absence (fragment, partial list, older edition). */
  | { held: "incomplete"; heldAs: string }
  /** Only outside the IG closure, and the code is not in it: an excerpt there proves nothing. */
  | { held: "outside"; heldAs: string };

export interface ExtendedDeps {
  /** Does validator_cli end this system in UNKNOWN_CODESYSTEM? (resolver.checkCode status `unknown-system`) */
  unknownToValidator(system: string, code: string, version: string | null): Promise<boolean>;
  /** The same canonical under another spelling, in the local data (variantsOf). */
  held(system: string, code: string, version: string | null): Promise<HeldVerdict>;
  /** Does this canonical (`|version` honoured) resolve to a StructureDefinition of the closure? */
  profileResolves(canonical: string): Promise<boolean>;
  /** Canonicals of the closure's profiles of a resource type. */
  profilesOf(resourceType: string): Promise<string[]>;
}

/** Codings looked at per call; beyond it the block says `incomplete` rather than a silent pass. */
export const MAX_CODINGS = 5000;

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * Other spellings of one canonical: http ↔ https and the /CodeSystem/ ↔ /ValueSet/ path segment (a CodeSystem published under
 * its ValueSet's URL, which is how a ValueSet that includes the /CodeSystem/ URL ends up naming nothing). In a fixed order.
 */
export function variantsOf(system: string): string[] {
  const swapScheme = (u: string): string | null => (/^https:/iu.test(u) ? u.replace(/^https:/iu, "http:") : /^http:/iu.test(u) ? u.replace(/^http:/iu, "https:") : null);
  const swapPath = (u: string): string | null => (/\/CodeSystem\//u.test(u) ? u.replace("/CodeSystem/", "/ValueSet/") : /\/ValueSet\//u.test(u) ? u.replace("/ValueSet/", "/CodeSystem/") : null);
  const s = swapScheme(system);
  const p = swapPath(system);
  const both = s ? swapPath(s) : null;
  return [s, p, both].filter((v): v is string => v !== null);
}

export const looksCanonical = (p: string): boolean => /^(https?:\/\/[^\s/|]+\/[^\s|]*|urn:[a-z0-9-]+:[^\s|]+)(\|[^\s|]+)?$/iu.test(p);

function normProfile(p: string): string {
  return p.trim().split("|")[0].replace(/^https?:\/\//iu, "").replace(/\.html$/iu, "").replace(/\/+$/u, "").toLowerCase();
}

const tailOf = (n: string): string => n.slice(n.lastIndexOf("/") + 1);
const baseOf = (n: string): string => n.slice(0, n.lastIndexOf("/") + 1);

export interface ProfileMapping {
  /** The one canonical it maps to, else null. */
  canonical: string | null;
  /** Near canonicals, best first (at most 3). */
  candidates: string[];
}

/**
 * Deterministic mapping of an unresolvable meta.profile value onto the closure's profiles of the resource's type:
 *   1. the same canonical up to `|version`, case, scheme, a trailing slash or `.html`;
 *   2. a bare id / a URL whose last segment is a profile's id, on any base;
 *   3. on the same base, the nearest id by edit distance (≤ 5, and at most half its length), strictly nearer than the runner-up.
 * Several candidates at the same rank: no mapping. Never guessed across resource types.
 */
export function mapProfile(profile: string, candidates: readonly string[]): ProfileMapping {
  const n = normProfile(profile);
  const uniq = [...new Set(candidates)].sort();
  const rows = uniq.map((c) => ({ c, n: normProfile(c) }));
  const exact = rows.filter((r) => r.n === n);
  if (exact.length === 1) return { canonical: exact[0].c, candidates: [exact[0].c] };
  if (exact.length > 1) return { canonical: null, candidates: exact.map((r) => r.c).slice(0, 3) };
  const tail = tailOf(n);
  if (!tail) return { canonical: null, candidates: [] };
  const sameId = rows.filter((r) => tailOf(r.n) === tail);
  if (sameId.length === 1) return { canonical: sameId[0].c, candidates: [sameId[0].c] };
  if (sameId.length > 1) return { canonical: null, candidates: sameId.map((r) => r.c).slice(0, 3) };
  const base = baseOf(n);
  const near = rows
    .filter((r) => baseOf(r.n) === base)
    .map((r) => ({ c: r.c, d: levenshtein(tail, tailOf(r.n), 6), len: Math.max(tail.length, tailOf(r.n).length) }))
    .filter((r) => r.d <= 5 && r.d * 2 <= r.len)
    .sort((x, y) => x.d - y.d || (x.c < y.c ? -1 : 1));
  if (!near.length) return { canonical: null, candidates: [] };
  const list = near.slice(0, 3).map((r) => r.c);
  return { canonical: near.length === 1 || near[0].d < near[1].d ? near[0].c : null, candidates: list };
}

interface Site {
  path: string;
  system: string;
  code: string;
  version: string | null;
}

interface ProfileSite {
  path: string;
  resourceType: string;
  profile: string;
}

/** Every Coding-shaped object (Coding, coded Quantity) and every meta.profile entry of a resource tree. */
function collect(root: Record<string, any>): { codings: Site[]; profiles: ProfileSite[] } {
  const codings: Site[] = [];
  const profiles: ProfileSite[] = [];
  const walk = (x: unknown, path: string): void => {
    if (Array.isArray(x)) {
      x.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (!isObj(x)) return;
    if (typeof x.resourceType === "string" && isObj(x.meta) && Array.isArray(x.meta.profile)) {
      x.meta.profile.forEach((p: unknown, i: number) => {
        if (typeof p === "string") profiles.push({ path: `${path}.meta.profile[${i}]`, resourceType: x.resourceType, profile: p });
      });
    }
    if (typeof x.system === "string" && x.system && typeof x.code === "string" && x.code) {
      codings.push({ path, system: x.system, code: x.code, version: typeof x.version === "string" && x.version ? x.version : null });
    }
    for (const [k, v] of Object.entries(x)) if (typeof v === "object" && v !== null) walk(v, `${path}.${k}`);
  };
  walk(root, typeof root.resourceType === "string" ? root.resourceType : "");
  return { codings, profiles };
}

async function profileFinding(s: ProfileSite, deps: ExtendedDeps): Promise<ExtendedFinding | null> {
  const wellFormed = looksCanonical(s.profile);
  if (wellFormed && (await deps.profileResolves(s.profile))) return null;
  const m = mapProfile(s.profile, await deps.profilesOf(s.resourceType));
  const fix: ExtendedFix = m.canonical
    ? { action: `Replace it with ${m.canonical} (fhir_finalize_bundle / fhir_finalize_resource do this).`, replace_with: m.canonical }
    : { action: m.candidates.length ? "Replace it with the intended profile of the IG." : "Remove it, or replace it with a profile of the IG (fhir_list_resource_profiles).", ...(m.candidates.length ? { candidates: m.candidates } : {}) };
  return {
    kind: wellFormed ? "unresolvable-profile" : "malformed-profile",
    severity: "error",
    path: s.path,
    profile: s.profile,
    message: wellFormed
      ? `meta.profile '${s.profile}' resolves to no StructureDefinition of this IG, so the resource was not checked against it.`
      : `meta.profile '${s.profile}' is not a canonical URL, so the resource was not checked against it.`,
    fix,
  };
}

export async function extendedFindings(root: Record<string, any>, deps: ExtendedDeps): Promise<ExtendedFindings | null> {
  const findings: ExtendedFinding[] = [];
  const unverifiable = new Map<string, ExtendedFinding>();
  let incomplete = false;
  try {
    const { codings, profiles } = collect(root);
    for (const s of profiles) {
      const f = await profileFinding(s, deps);
      if (f) findings.push(f);
    }
    if (codings.length > MAX_CODINGS) incomplete = true;
    for (const c of codings.slice(0, MAX_CODINGS)) {
      if (!(await deps.unknownToValidator(c.system, c.code, c.version))) continue;
      const h = await deps.held(c.system, c.code, c.version);
      if (h.held === "found") continue;
      if (h.held === "absent") {
        findings.push({
          kind: "code-not-in-held-codesystem",
          severity: "error",
          path: c.path,
          system: c.system,
          code: c.code,
          held_as: h.heldAs,
          message: `Code '${c.code}' is not in the complete CodeSystem held as ${h.heldAs}, which is what '${c.system}' names.`,
          fix: { action: `Use a code of ${h.heldAs} (fhir_normalize_code), or the system the code really belongs to.` },
        });
        continue;
      }
      const reason = h.held === "no" ? "no-data" : h.held === "incomplete" ? "held-copy-incomplete" : "held-outside-closure";
      const row = unverifiable.get(c.system);
      if (row) row.count = (row.count ?? 0) + 1;
      else {
        unverifiable.set(c.system, {
          kind: "no-local-data",
          severity: "unverifiable",
          path: c.path,
          system: c.system,
          reason,
          count: 1,
          ...(h.held === "no" ? {} : { held_as: h.heldAs }),
          message:
            h.held === "no"
              ? `No local data for '${c.system}', and validator_cli cannot check it either: its codes are unverified.`
              : `The copy of '${c.system}' held as ${h.heldAs} cannot prove a code absent: its codes are unverified.`,
        });
      }
    }
  } catch {
    incomplete = true;
  }
  const rows = [...findings, ...unverifiable.values()];
  if (!rows.length && !incomplete) return null;
  const count = (sev: string): number => rows.reduce((n, f) => n + (f.severity === sev ? (f.count ?? 1) : 0), 0);
  return { summary: { errors: count("error"), unverifiable: count("unverifiable"), ...(incomplete ? { incomplete: true as const } : {}) }, findings: rows };
}

/**
 * Applies the unique profile mapping to every meta.profile entry of a resource tree, in place (fhir_finalize_bundle /
 * fhir_finalize_resource). `map` answers the replacement or null. Returns the changes, in the finalizer's convention.
 */
export async function repairMetaProfiles(
  root: Record<string, any>,
  map: (resourceType: string, profile: string) => Promise<string | null>,
): Promise<Array<{ path: string; from: string; to: string; rule: "meta-profile"; reason: string }>> {
  const out: Array<{ path: string; from: string; to: string; rule: "meta-profile"; reason: string }> = [];
  for (const s of collect(root).profiles) {
    const to = await map(s.resourceType, s.profile);
    if (!to || to === s.profile) continue;
    const m = /^(.*)\.meta\.profile\[(\d+)\]$/u.exec(s.path);
    const res = m ? resolveAt(root, m[1]) : null;
    if (!res || !Array.isArray(res.meta?.profile) || res.meta.profile[Number(m![2])] !== s.profile) continue;
    if (res.meta.profile.includes(to)) res.meta.profile.splice(Number(m![2]), 1);
    else res.meta.profile[Number(m![2])] = to;
    out.push({ path: s.path, from: s.profile, to, rule: "meta-profile", reason: "meta.profile named no StructureDefinition of the IG and maps to exactly this one" });
  }
  return out;
}

function resolveAt(root: Record<string, any>, path: string): Record<string, any> | null {
  let cur: any = root;
  for (const seg of path.split(".").slice(1)) {
    const m = /^([^[]*)((?:\[\d+\])*)$/u.exec(seg);
    if (!m) return null;
    cur = cur?.[m[1]];
    for (const i of m[2].matchAll(/\[(\d+)\]/gu)) cur = cur?.[Number(i[1])];
  }
  return isObj(cur) ? cur : null;
}
