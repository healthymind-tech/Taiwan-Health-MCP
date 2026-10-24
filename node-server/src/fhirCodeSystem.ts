/**
 * Pure terminology core: CodeSystem indexing (nested `concept.concept` hierarchy
 * + `parent`/`child` properties), ValueSet `compose` filters, rule-based
 * ValueSet membership and expansion. No DB access — every lookup goes through
 * the injected `TerminologyDeps`, so the logic is unit-testable with fakes.
 */

export const SNOMED_SYSTEM = "http://snomed.info/sct";
export const LOINC_SYSTEM = "http://loinc.org";

export interface CsConcept {
  code: string;
  display: string | null;
  /** display + every designation value (all languages). */
  designations: string[];
  /** Designations with their language (for HL7's language-aware display check). */
  designationList: Array<{ language: string | null; value: string }>;
  parents: Set<string>;
  children: Set<string>;
  properties: Map<string, any[]>;
}

export interface CodeSystemIndex {
  url: string;
  version: string | null;
  content: string;
  /** CodeSystem.language (null when absent). */
  language: string | null;
  caseSensitive: boolean;
  concepts: Map<string, CsConcept>;
  /** lower-cased code → code, for case-insensitive systems. */
  lower: Map<string, string>;
}

function propertyValue(p: Record<string, any>): any {
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith("value")) {
      if (k === "valueCoding" && v && typeof v === "object") return v.code;
      return v;
    }
  }
  return undefined;
}

/** Flatten a CodeSystem resource (any nesting depth) into an index with hierarchy links. */
export function indexCodeSystem(cs: Record<string, any>): CodeSystemIndex {
  const concepts = new Map<string, CsConcept>();
  const ensure = (code: string): CsConcept => {
    let c = concepts.get(code);
    if (!c) {
      c = { code, display: null, designations: [], designationList: [], parents: new Set(), children: new Set(), properties: new Map() };
      concepts.set(code, c);
    }
    return c;
  };
  const visit = (list: any[], parent: string | null): void => {
    for (const raw of list || []) {
      if (!raw || typeof raw !== "object" || raw.code === undefined || raw.code === null) continue;
      const code = String(raw.code);
      const c = ensure(code);
      if (raw.display !== undefined && raw.display !== null) {
        c.display = String(raw.display);
        c.designations.push(String(raw.display));
      }
      for (const d of raw.designation || []) {
        if (d && d.value !== undefined && d.value !== null) {
          c.designations.push(String(d.value));
          c.designationList.push({ language: typeof d.language === "string" ? d.language : null, value: String(d.value) });
        }
      }
      for (const p of raw.property || []) {
        if (!p || !p.code) continue;
        const v = propertyValue(p);
        if (!c.properties.has(p.code)) c.properties.set(p.code, []);
        c.properties.get(p.code)!.push(v);
      }
      if (parent !== null) {
        c.parents.add(parent);
        ensure(parent).children.add(code);
      }
      if (Array.isArray(raw.concept)) visit(raw.concept, code);
    }
  };
  visit(cs.concept || [], null);
  // Hierarchy expressed through properties: `parent` / `child`, or any property
  // declared with the standard concept-properties#parent / #child URI (THO v3
  // code systems use `subsumedBy`).
  const parentProps = new Set(["parent", "subsumedBy"]);
  const childProps = new Set(["child"]);
  for (const pd of cs.property || []) {
    if (!pd || !pd.code) continue;
    const uri = String(pd.uri || "");
    if (/concept-properties#parent$/.test(uri)) parentProps.add(pd.code);
    if (/concept-properties#child$/.test(uri)) childProps.add(pd.code);
  }
  for (const c of [...concepts.values()]) {
    const parents: any[] = [];
    for (const k of parentProps) pushEach(parents, c.properties.get(k) || []);
    const kids: any[] = [];
    for (const k of childProps) pushEach(kids, c.properties.get(k) || []);
    for (const p of parents) {
      if (typeof p === "string" && p !== c.code) {
        c.parents.add(p);
        ensure(p).children.add(c.code);
      }
    }
    for (const ch of kids) {
      if (typeof ch === "string" && ch !== c.code) {
        c.children.add(ch);
        ensure(ch).parents.add(c.code);
      }
    }
  }
  const lower = new Map<string, string>();
  for (const code of concepts.keys()) lower.set(code.toLowerCase(), code);
  return {
    url: String(cs.url || ""),
    version: cs.version ?? null,
    content: String(cs.content || "complete"),
    language: typeof cs.language === "string" ? cs.language : null,
    caseSensitive: cs.caseSensitive !== false,
    concepts,
    lower,
  };
}

/** Find a concept honouring CodeSystem.caseSensitive (exact match is always tried first). */
export function findConcept(idx: CodeSystemIndex, code: string): CsConcept | null {
  const exact = idx.concepts.get(code);
  if (exact) return exact;
  if (!idx.caseSensitive) {
    const k = idx.lower.get(code.toLowerCase());
    if (k) return idx.concepts.get(k) || null;
  }
  return null;
}

function walk(idx: CodeSystemIndex, start: string, dir: "parents" | "children"): Set<string> {
  const out = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = idx.concepts.get(stack.pop()!);
    if (!cur) continue;
    for (const next of cur[dir]) {
      if (!out.has(next)) {
        out.add(next);
        stack.push(next);
      }
    }
  }
  return out;
}

export function descendantsOf(idx: CodeSystemIndex, code: string): Set<string> {
  const c = findConcept(idx, code);
  return c ? walk(idx, c.code, "children") : new Set();
}

export function ancestorsOf(idx: CodeSystemIndex, code: string): Set<string> {
  const c = findConcept(idx, code);
  return c ? walk(idx, c.code, "parents") : new Set();
}

export interface ComposeFilter {
  property?: string;
  op?: string;
  value?: string;
}

const HIERARCHY_PROPS = new Set(["concept", "code", "parent", "child"]);

function conceptPropertyMatches(c: CsConcept, property: string, test: (v: string) => boolean): boolean {
  if (property === "code" || property === "concept") return test(c.code);
  if (property === "display") return c.display !== null && test(c.display);
  const vals = c.properties.get(property);
  if (!vals) return false;
  return vals.some((v) => v !== undefined && v !== null && test(String(v)));
}

/**
 * Codes of `idx` selected by one compose filter. Returns null for an
 * operator/property this engine cannot evaluate (callers must then treat the
 * result as unknown, never as "empty").
 */
export function applyFilter(idx: CodeSystemIndex, f: ComposeFilter): Set<string> | null {
  const op = f.op || "";
  const prop = f.property || "concept";
  const value = f.value === undefined || f.value === null ? "" : String(f.value);
  const all = (): Set<string> => new Set(idx.concepts.keys());
  if (["is-a", "descendent-of", "is-not-a", "generalizes", "child-of", "descendent-leaf"].includes(op)) {
    if (!HIERARCHY_PROPS.has(prop)) return null;
    const root = findConcept(idx, value);
    if (op === "is-not-a") {
      const out = all();
      if (root) {
        out.delete(root.code);
        for (const d of descendantsOf(idx, root.code)) out.delete(d);
      }
      return out;
    }
    if (!root) return new Set();
    if (op === "is-a") return new Set([root.code, ...descendantsOf(idx, root.code)]);
    if (op === "descendent-of") return descendantsOf(idx, root.code);
    if (op === "generalizes") return new Set([root.code, ...ancestorsOf(idx, root.code)]);
    if (op === "child-of") return new Set(root.children);
    // descendent-leaf
    return new Set([...descendantsOf(idx, root.code)].filter((c) => (idx.concepts.get(c)?.children.size ?? 0) === 0));
  }
  const out = new Set<string>();
  if (op === "=") {
    for (const c of idx.concepts.values()) if (conceptPropertyMatches(c, prop, (v) => v === value)) out.add(c.code);
    return out;
  }
  if (op === "in" || op === "not-in") {
    const vals = new Set(value.split(",").map((s) => s.trim()));
    for (const c of idx.concepts.values()) {
      const hit = conceptPropertyMatches(c, prop, (v) => vals.has(v));
      if (hit === (op === "in")) out.add(c.code);
    }
    return out;
  }
  if (op === "regex") {
    let re: RegExp;
    try {
      re = new RegExp("^(?:" + value + ")$");
    } catch {
      return null;
    }
    for (const c of idx.concepts.values()) if (conceptPropertyMatches(c, prop, (v) => re.test(v))) out.add(c.code);
    return out;
  }
  if (op === "exists") {
    const want = value !== "false";
    for (const c of idx.concepts.values()) {
      const has = prop === "display" ? c.display !== null : (c.properties.get(prop) || []).length > 0;
      if (has === want) out.add(c.code);
    }
    return out;
  }
  return null;
}

// --------------------------------------------------------------------------- //
// ValueSet membership + expansion over injected dependencies
// --------------------------------------------------------------------------- //

export interface ExternalLookup {
  display: string | null;
  definition?: string | null;
}

export interface TerminologyDeps {
  loadValueSet(url: string): Promise<Record<string, any> | null>;
  /** IG-held CodeSystem (raw JSON indexed), or null when not held. */
  loadCodeSystem(url: string): Promise<CodeSystemIndex | null>;
  /** Externally backed systems (SNOMED / LOINC / ICD tables). null = unknown code or system. */
  lookupExternal(system: string, code: string): Promise<ExternalLookup | null>;
  /** True when the external system is backed by local tables (so a miss is meaningful). */
  externalSystemHeld(system: string): Promise<boolean>;
  /** SNOMED subsumption: is `code` equal to or a descendant of `ancestor`? undefined = unknown. */
  snomedSubsumedBy?(code: string, ancestor: string): Promise<boolean | undefined>;
  snomedDescendants?(code: string, limit: number): Promise<string[]>;
  snomedDisplays?(codes: string[]): Promise<Map<string, string>>;
  /**
   * (v13) One compose filter on an externally backed system (LOINC properties such as
   * CLASSTYPE / CLASS / SCALE_TYP) evaluated for one code. undefined = cannot decide
   * (unsupported property / op, code not held locally).
   */
  externalFilter?(system: string, filter: ComposeFilter, code: string): Promise<boolean | undefined>;
}

const MAX_DEPTH = 8;

function stripVersion(url: string): string {
  return String(url || "").split("|")[0];
}

/** Rule-based membership of one include/exclude part. undefined = cannot decide locally. */
async function partContains(
  part: Record<string, any>,
  system: string | null,
  code: string,
  deps: TerminologyDeps,
  depth: number,
  seen: Set<string>,
): Promise<boolean | undefined> {
  const results: Array<boolean | undefined> = [];
  const partSystem: string | undefined = part.system;
  if (partSystem) {
    if (system !== null && system !== partSystem) return false;
    results.push(await systemPartContains(part, partSystem, code, deps));
  }
  for (const vs of part.valueSet || []) {
    results.push(await valueSetContainsInner(stripVersion(vs), system ?? partSystem ?? null, code, deps, depth + 1, seen));
  }
  if (!results.length) return false;
  if (results.some((r) => r === false)) return false;
  if (results.some((r) => r === undefined)) return undefined;
  return true;
}

async function systemPartContains(
  part: Record<string, any>,
  system: string,
  code: string,
  deps: TerminologyDeps,
): Promise<boolean | undefined> {
  const cs = await deps.loadCodeSystem(system);
  if (Array.isArray(part.concept) && part.concept.length) {
    const caseSensitive = cs ? cs.caseSensitive : true;
    return part.concept.some((c: any) =>
      caseSensitive ? String(c.code) === code : String(c.code).toLowerCase() === code.toLowerCase(),
    );
  }
  const filters: ComposeFilter[] = part.filter || [];
  if (filters.length) {
    let acc: boolean | undefined = true;
    for (const f of filters) {
      let r: boolean | undefined;
      if (cs) {
        const set = applyFilter(cs, f);
        if (set === null) r = undefined;
        else {
          const c = findConcept(cs, code);
          r = c ? set.has(c.code) : false;
          // A fragment / example CodeSystem cannot prove non-membership.
          if (r === false && cs.content !== "complete") r = undefined;
        }
      } else if (system === SNOMED_SYSTEM && deps.snomedSubsumedBy && ["is-a", "descendent-of"].includes(String(f.op))) {
        const sub = await deps.snomedSubsumedBy(code, String(f.value));
        r = sub === undefined ? undefined : sub && (f.op === "is-a" || code !== String(f.value));
      } else if (f.op === "=" && (f.property === "concept" || f.property === "code")) {
        r = code === String(f.value);
      } else if (deps.externalFilter) {
        r = await deps.externalFilter(system, f, code);
      } else {
        r = undefined;
      }
      if (r === false) return false;
      if (r === undefined) acc = undefined;
    }
    return acc;
  }
  // Whole-system include.
  if (cs) {
    if (findConcept(cs, code)) return true;
    return cs.content === "complete" ? false : undefined;
  }
  if (await deps.externalSystemHeld(system)) {
    const hit = await deps.lookupExternal(system, code);
    return hit ? true : undefined;
  }
  return undefined;
}

async function valueSetContainsInner(
  url: string,
  system: string | null,
  code: string,
  deps: TerminologyDeps,
  depth: number,
  seen: Set<string>,
): Promise<boolean | undefined> {
  if (depth > MAX_DEPTH || seen.has(url)) return undefined;
  const vs = await deps.loadValueSet(url);
  if (!vs) return undefined;
  const next = new Set(seen);
  next.add(url);
  return composeContains(vs.compose || {}, system, code, deps, depth, next, vs.expansion);
}

/** Membership of (system, code) in a compose (system may be null for bare `code` elements). */
export async function composeContains(
  compose: Record<string, any>,
  system: string | null,
  code: string,
  deps: TerminologyDeps,
  depth = 0,
  seen: Set<string> = new Set(),
  expansion?: Record<string, any>,
): Promise<boolean | undefined> {
  const includes: any[] = compose.include || [];
  if (!includes.length && expansion && Array.isArray(expansion.contains)) {
    const flat: any[] = [];
    const visit = (list: any[]): void => {
      for (const c of list || []) {
        flat.push(c);
        if (c.contains) visit(c.contains);
      }
    };
    visit(expansion.contains);
    return flat.some((c) => c.code === code && (system === null || c.system === system));
  }
  let anyUnknown = false;
  let member = false;
  for (const inc of includes) {
    const r = await partContains(inc, system, code, deps, depth, seen);
    if (r === true) {
      member = true;
      break;
    }
    if (r === undefined) anyUnknown = true;
  }
  if (!member) return anyUnknown ? undefined : false;
  for (const exc of compose.exclude || []) {
    const r = await partContains(exc, system, code, deps, depth, seen);
    if (r === true) return false;
  }
  return true;
}

export async function valueSetContains(
  url: string,
  system: string | null,
  code: string,
  deps: TerminologyDeps,
): Promise<boolean | undefined> {
  return valueSetContainsInner(stripVersion(url), system, code, deps, 0, new Set());
}

export interface Coding {
  system: string | null;
  code: string;
  display: string | null;
}

export interface ExpandResult {
  codings: Coding[];
  total: number;
  truncated: boolean;
  warnings: string[];
  unresolved: any[];
}

interface PartExpansion {
  codings: Coding[];
  complete: boolean;
  truncated: boolean;
}

async function expandSystemPart(
  part: Record<string, any>,
  system: string,
  deps: TerminologyDeps,
  limit: number,
  warnings: string[],
  unresolved: any[],
): Promise<PartExpansion> {
  const cs = await deps.loadCodeSystem(system);
  const out: Coding[] = [];
  let truncated = false;
  const push = (code: string, display: string | null): boolean => {
    if (out.length >= limit) {
      truncated = true;
      return false;
    }
    out.push({ system, code, display });
    return true;
  };
  if (Array.isArray(part.concept) && part.concept.length) {
    for (const c of part.concept) {
      let display = c.display ?? null;
      if (display === null) {
        if (cs) display = findConcept(cs, String(c.code))?.display ?? null;
        else display = (await deps.lookupExternal(system, String(c.code)))?.display ?? null;
      }
      if (!push(String(c.code), display)) break;
    }
    return { codings: out, complete: true, truncated };
  }
  const filters: ComposeFilter[] = part.filter || [];
  if (filters.length) {
    if (cs) {
      let set: Set<string> | null = null;
      for (const f of filters) {
        const s = applyFilter(cs, f);
        if (s === null) {
          warnings.push(`unsupported filter op '${f.op}' on ${system}`);
          unresolved.push({ system, reason: `filter:${f.op}` });
          return { codings: [], complete: false, truncated: false };
        }
        const prev: Set<string> | null = set;
        set = prev === null ? s : new Set([...prev].filter((x: string) => s.has(x)));
      }
      for (const code of set || []) if (!push(code, cs.concepts.get(code)?.display ?? null)) break;
      return { codings: out, complete: true, truncated };
    }
    if (system === SNOMED_SYSTEM && filters.length === 1 && deps.snomedDescendants && ["is-a", "descendent-of"].includes(String(filters[0].op))) {
      const f = filters[0];
      let ids = await deps.snomedDescendants(String(f.value), limit + 1);
      if (f.op === "descendent-of") ids = ids.filter((i) => i !== String(f.value));
      const disp = deps.snomedDisplays ? await deps.snomedDisplays(ids) : new Map<string, string>();
      for (const id of ids) if (!push(id, disp.get(id) ?? null)) break;
      return { codings: out, complete: !truncated, truncated };
    }
    for (const f of filters) {
      if (f.op === "=" && (f.property === "concept" || f.property === "code")) {
        const look = await deps.lookupExternal(system, String(f.value));
        if (look) push(String(f.value), look.display);
        else unresolved.push({ system, reason: "FILTER_EQ_UNRESOLVED" });
      } else {
        warnings.push(`unsupported filter op '${f.op}' on ${system}`);
        unresolved.push({ system, reason: `filter:${f.op}` });
      }
    }
    return { codings: out, complete: false, truncated };
  }
  if (cs) {
    for (const c of cs.concepts.values()) if (!push(c.code, c.display)) break;
    if (cs.content !== "complete") unresolved.push({ system, reason: `CODESYSTEM_${cs.content.toUpperCase()}` });
    return { codings: out, complete: cs.content === "complete", truncated };
  }
  warnings.push(`TOO_BROAD: whole-system not enumerated: ${system}`);
  unresolved.push({ system, reason: "TOO_BROAD" });
  return { codings: [], complete: false, truncated: false };
}

async function expandPart(
  part: Record<string, any>,
  deps: TerminologyDeps,
  limit: number,
  depth: number,
  seen: Set<string>,
  warnings: string[],
  unresolved: any[],
): Promise<PartExpansion> {
  const pieces: PartExpansion[] = [];
  if (part.system) pieces.push(await expandSystemPart(part, part.system, deps, limit, warnings, unresolved));
  for (const raw of part.valueSet || []) {
    const url = stripVersion(raw);
    if (depth >= MAX_DEPTH || seen.has(url)) {
      warnings.push(`valueSet import not expanded (depth/cycle): ${url}`);
      pieces.push({ codings: [], complete: false, truncated: false });
      continue;
    }
    const vs = await deps.loadValueSet(url);
    if (!vs) {
      unresolved.push({ valueSet: url, reason: "VALUESET_NOT_FOUND" });
      pieces.push({ codings: [], complete: false, truncated: false });
      continue;
    }
    const next = new Set(seen);
    next.add(url);
    const sub = await expandComposeWith(vs.compose || {}, deps, limit, depth + 1, next);
    pushEach(warnings, sub.warnings);
    pushEach(unresolved, sub.unresolved);
    pieces.push({ codings: sub.codings, complete: !sub.truncated && sub.unresolved.length === 0, truncated: sub.truncated });
  }
  if (pieces.length <= 1) return pieces[0] || { codings: [], complete: true, truncated: false };
  // Include semantics: the system part and every imported ValueSet are intersected.
  const key = (c: Coding): string => `${c.system} ${c.code}`;
  let acc = pieces[0].codings;
  for (const p of pieces.slice(1)) {
    const keys = new Set(p.codings.map(key));
    acc = acc.filter((c) => keys.has(key(c)));
  }
  return { codings: acc, complete: pieces.every((p) => p.complete), truncated: pieces.some((p) => p.truncated) };
}

function pushEach<T>(target: T[], items: Iterable<T>): void {
  for (const i of items) target.push(i);
}

/** Expand a ValueSet compose (nested CodeSystem hierarchies, filters, imports, excludes). */
export async function expandComposeWith(
  compose: Record<string, any>,
  deps: TerminologyDeps,
  limit: number,
  depth = 0,
  seenVs: Set<string> = new Set(),
): Promise<ExpandResult> {
  const warnings: string[] = [];
  const unresolved: any[] = [];
  const codings: Coding[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const inc of (compose || {}).include || []) {
    const part = await expandPart(inc, deps, limit, depth, seenVs, warnings, unresolved);
    truncated = truncated || part.truncated;
    for (const c of part.codings) {
      const k = `${c.system} ${c.code}`;
      if (seen.has(k)) continue;
      if (codings.length >= limit) {
        truncated = true;
        break;
      }
      seen.add(k);
      codings.push(c);
    }
  }
  const excluded = new Set<string>();
  for (const exc of (compose || {}).exclude || []) {
    const part = await expandPart(exc, deps, Number.MAX_SAFE_INTEGER, depth, seenVs, [], []);
    for (const c of part.codings) excluded.add(`${c.system} ${c.code}`);
  }
  const finalCodings = excluded.size ? codings.filter((c) => !excluded.has(`${c.system} ${c.code}`)) : codings;
  return { codings: finalCodings, total: finalCodings.length, truncated, warnings, unresolved };
}

// --------------------------------------------------------------------------- //
// Check digits for external code systems (an invalid check digit is certain proof
// that a code does not exist, independent of the local table's release).
// --------------------------------------------------------------------------- //

/** LOINC codes: digits '-' mod-10 check digit. */
export function loincCheckDigitValid(code: string): boolean {
  // Answer (LA), part (LP), group (LG) and answer-list (LL) codes: format only.
  if (/^L[APGL]\d{1,8}-\d$/.test(code)) return true;
  const m = /^(\d{1,7})-(\d)$/.exec(code);
  if (!m) return false;
  const body = m[1];
  // Mod 10 (Luhn variant used by LOINC): double every other digit starting from the rightmost.
  let sum = 0;
  let double = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let d = Number(body[i]);
    if (double) {
      d *= 2;
      if (d > 9) d = Math.floor(d / 10) + (d % 10);
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10 === Number(m[2]);
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** SNOMED CT SCTID: 6-18 digits, Verhoeff check digit. */
export function snomedCheckDigitValid(code: string): boolean {
  if (!/^\d{6,18}$/.test(code)) return false;
  let c = 0;
  const digits = code.split("").reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digits[i]]];
  return c === 0;
}
