/**
 * Unknown canonical URLs: "No definition could be found for URL value 'U'",
 * "A definition for CodeSystem 'S' could not be found" and "The Coding references a value
 * set, not a code system ('V')".
 *
 * Candidates (CodeSystem expected when the URL is a Coding / Quantity system):
 *   1. a ValueSet used as a system — the URL itself, or the same name under /ValueSet/
 *      (…/CodeSystem/v3-ActEncounterCode → ValueSet/v3-ActEncounterCode) — points to the
 *      CodeSystem(s) its compose includes (→ …/CodeSystem/v3-ActCode);
 *   2. the closest known canonical of the expected type under the URL's own base and the
 *      HL7 terminology bases (token overlap + edit distance of the URL tail).
 * When the Coding has a code, each candidate system is checked with the validator's own
 * code check, and systems that hold the code rank first.
 */

import type { Suggestion, SuggestionDeps } from "./types.js";
import { jaccard, levenshtein, tokens } from "./util.js";

/** Bases searched in addition to the URL's own (where HL7 core / THO canonicals of each kind live). */
const HL7_BASES: Record<CanonicalContext["expect"], string[]> = {
  CodeSystem: ["http://terminology.hl7.org/CodeSystem/", "http://hl7.org/fhir/"],
  ValueSet: ["http://terminology.hl7.org/ValueSet/", "http://hl7.org/fhir/ValueSet/"],
  StructureDefinition: ["http://hl7.org/fhir/StructureDefinition/"],
  any: ["http://terminology.hl7.org/CodeSystem/", "http://hl7.org/fhir/"],
};

const GENERIC_SEGMENTS = new Set(["fhir", "codesystem", "valueset", "structuredefinition", "sid", "ig", "namingsystem", "www", "http", "https", "org"]);

interface UrlKey {
  tail: string;
  flat: string;
  toks: string[];
}

const keyCache = new Map<string, UrlKey>();

/** Comparable tokens of a canonical URL: its path minus generic segments (memoised). */
function urlKey(url: string): UrlKey {
  const hit = keyCache.get(url);
  if (hit) return hit;
  const noVer = url.split("|")[0];
  const path = noVer.replace(/^[a-z]+:\/\/[^/]+\//i, "");
  const segs = path.split("/").filter((x) => x && !GENERIC_SEGMENTS.has(x.toLowerCase()));
  const tail = segs.join("/").toLowerCase();
  const k = { tail, flat: tail.replace(/[^a-z0-9]/g, ""), toks: tokens(segs.join(" ")) };
  if (keyCache.size > 20000) keyCache.clear();
  keyCache.set(url, k);
  return k;
}

function urlSim(ka: UrlKey, b: string): number {
  const kb = urlKey(b);
  if (!ka.tail || !kb.tail) return 0;
  const j = jaccard(ka.toks, kb.toks);
  // Edit similarity is bounded by the length ratio: skip the O(n·m) pass when it cannot matter.
  // Only an edit similarity ≥ 0.5 can lift a candidate over the threshold: bounded distance, early exit.
  const n = Math.max(ka.flat.length, kb.flat.length, 1);
  const maxD = Math.floor(n * 0.5);
  const d = levenshtein(ka.flat, kb.flat, maxD);
  const e = d > maxD ? 0 : 1 - d / n;
  return Math.max(j, e) * 0.7 + Math.min(j, e) * 0.3;
}

function baseOf(url: string): string {
  const u = url.split("|")[0];
  const i = u.lastIndexOf("/");
  return i > 8 ? u.slice(0, i + 1) : u;
}

export interface CanonicalContext {
  /** The kind of definition the element expects. */
  expect: "CodeSystem" | "ValueSet" | "StructureDefinition" | "any";
  /** For a Coding system: its code and display, to check candidate systems. */
  code?: string | null;
  display?: string | null;
  /** Path of the URL value (patch target). */
  path: string;
}

export async function suggestCanonical(deps: SuggestionDeps, url: string, ctx: CanonicalContext): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const checked = new Map<string, boolean | null>();
  const holdsCode = async (system: string): Promise<boolean | null> => {
    if (!ctx.code) return null;
    if (checked.has(system)) return checked.get(system)!;
    let r: boolean | null = null;
    try {
      const c = await deps.checkCode(system, ctx.code, null);
      r = c.status === "ok" || c.status === "invalid-display" ? true : c.status === "invalid-code" ? false : null;
    } catch {
      r = null;
    }
    checked.set(system, r);
    return r;
  };
  const push = async (value: string, base: number, reason: string): Promise<void> => {
    if (!value || value === url) return;
    let conf = base;
    let why = reason;
    if (ctx.expect === "CodeSystem" && ctx.code) {
      const h = await holdsCode(value);
      if (h === true) {
        conf = Math.min(0.97, base + 0.2);
        why += `; code '${ctx.code}' exists in it`;
      } else if (h === false) {
        conf = base * 0.5;
        why += `; but code '${ctx.code}' is not in it`;
      }
    }
    out.push({ value, kind: "replace_system", confidence: conf, reason: why, patch: { op: "replace", path: ctx.path, value } });
  };

  // 1. ValueSet used as / confused with a CodeSystem → the systems its compose includes.
  if (ctx.expect === "CodeSystem" && deps.loadValueSet) {
    const asVs = [url.split("|")[0]];
    if (/\/CodeSystem\//.test(url)) asVs.push(url.split("|")[0].replace("/CodeSystem/", "/ValueSet/"));
    for (const v of asVs) {
      let vs: Record<string, any> | null = null;
      try {
        vs = await deps.loadValueSet(v);
      } catch {
        vs = null;
      }
      if (!vs || !vs.compose) continue;
      const systems = [...new Set(((vs.compose.include || []) as any[]).map((i) => i && i.system).filter((s): s is string => typeof s === "string" && s !== ""))];
      for (const s of systems.slice(0, 4)) {
        await push(s, systems.length === 1 ? 0.75 : 0.6, `${v === url ? "'" + url + "' is a ValueSet" : "the ValueSet " + v + " has this name"}; Coding.system takes the CodeSystem it draws codes from (${s})`);
      }
    }
  }

  // 2. Closest known canonical of the expected type.
  // (canonical lists are small, cached per package closure: not budgeted)
  if (deps.canonicalsUnder) {
    const types = ctx.expect === "any" ? ["CodeSystem", "ValueSet", "StructureDefinition", "NamingSystem"] : [ctx.expect];
    const bases = [...new Set([baseOf(url), ...HL7_BASES[ctx.expect]])];
    const pool = new Set<string>();
    for (const b of bases) {
      try {
        for (const c of await deps.canonicalsUnder(b, types)) pool.add(c);
      } catch {
        /* fail-open */
      }
    }
    const own = urlKey(url);
    const scored = [...pool]
      .filter((c) => c !== url)
      .map((c) => ({ c, s: urlSim(own, c) + (baseOf(c) === baseOf(url) ? 0.03 : 0) }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s || (a.c < b.c ? -1 : 1))
      .slice(0, 5);
    // Code checks of the candidates run concurrently (results are keyed by system, so order stays fixed).
    await Promise.all(scored.slice(0, 3).map(({ c }) => holdsCode(c)));
    for (const [i, { c, s }] of scored.entries()) {
      if (i >= 3) checked.set(c, checked.get(c) ?? null); // beyond the top 3: no code check (cost bound)
      await push(c, 0.35 + 0.5 * Math.min(1, s), `closest known ${ctx.expect === "any" ? "canonical" : ctx.expect} URL`);
    }
  }
  return out;
}
