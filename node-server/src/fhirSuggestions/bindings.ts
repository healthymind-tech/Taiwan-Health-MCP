/**
 * Element bindings for the suggestion layer: which ValueSets (and so which CodeSystems) the
 * element at an issue path is bound to. Found by walking the instance path through the
 * resource's profiles (meta.profile / the validation's profiles) and the base definitions,
 * datatypes included (Dosage.route under MedicationRequest.dosageInstruction); slices of the
 * element, its `.coding` child, and max / additional bindings are collected too. Built on it:
 *
 *   suggestCrossSystem   "Unknown code X in CodeSystem S" where X is a code of another
 *                        CodeSystem the bound ValueSet includes (an IG-local CodeSystem and
 *                        the HL7 one of the same name, both in one ValueSet), or of the
 *                        CodeSystem of the same name under another base → replace_system.
 *   suggestBoundCoding   "No definition could be found for URL value U" on a Coding: the
 *                        Coding's code / display normalised within the bound ValueSets
 *                        (fhir_normalize_code) → replace_coding; the ValueSets' CodeSystems →
 *                        replace_system (the one that holds the code first).
 *   suggestMoveValue     a value not in the element's ValueSet that is a valid code of
 *                        another bound element of the same resource (criticality 'severe' →
 *                        reaction.severity) → move_value.
 *
 * All rules are generic: they read the StructureDefinitions, ValueSet composes and the
 * terminology collaborators; nothing is keyed on particular codes, systems or elements.
 */

import { codingContext, givenValues, normalized, type Budget } from "./codes.js";
import { bindingsAgree, declaresProfile, implicitCandidates, implicitNote } from "./implicitProfiles.js";
import type { ImplicitProfiles, Suggestion, SuggestionDeps } from "./types.js";
import { isObject, nodeAt, parsePath, splitLast, textSim } from "./util.js";

const CORE = "http://hl7.org/fhir/StructureDefinition/";
const THO_CS = "http://terminology.hl7.org/CodeSystem/";
const EXT_MAX_VALUESET = "http://hl7.org/fhir/StructureDefinition/elementdefinition-maxValueSet";
const EXT_ADDITIONAL_BINDING = "http://hl7.org/fhir/tools/StructureDefinition/additional-binding";
const STRENGTH_RANK: Record<string, number> = { required: 0, extensible: 1, preferred: 2, example: 3 };

export interface BindingRef {
  /** ValueSet canonical as written in the binding (may carry `|version`). */
  valueSet: string;
  /** Binding strength (required / extensible / preferred / example), or the purpose of an additional binding. */
  strength: string;
  /** ElementDefinition id the binding sits on. */
  element: string;
  /** StructureDefinition canonical the binding comes from. */
  profile: string;
  source: "binding" | "max" | "additional";
  /** 0 = the element at the path itself (or its `.coding` child), 1 = its parent, ... */
  depth: number;
}

export interface ElementBindings {
  resourceType: string;
  /** Instance path of the resource holding the element (`Bundle.entry[3].resource`, or the root type). */
  resourcePath: string;
  resource: Record<string, any>;
  /** Element path of the target in its definition (`MedicationRequest.dosageInstruction.route.coding`). */
  elementPath: string;
  /** Nearest first, then strongest, then profile before base. Deduplicated by ValueSet. */
  bindings: BindingRef[];
  /** StructureDefinitions walked (profiles first, base type last) — for sibling searches. */
  definitions: Array<Record<string, any>>;
}

export interface WalkOptions {
  /** Profiles the validation was asked for (apply to the root resource; `meta.profile` is read from the instance). */
  profiles?: string[];
  /**
   * v15.2.1: profiles of the resource holding the path, used instead of its meta.profile / the
   * validation's profiles (the implicit-profile binding lookup, implicitProfiles.ts).
   */
  resourceProfiles?: string[];
}

function elements(sd: Record<string, any> | null): Array<Record<string, any>> {
  return sd && sd.snapshot && Array.isArray(sd.snapshot.element) ? (sd.snapshot.element as Array<Record<string, any>>) : [];
}

function typeCodes(el: Record<string, any>): string[] {
  return (Array.isArray(el.type) ? el.type : []).map((t: any) => String(t && t.code ? t.code : "")).filter((c: string) => c !== "");
}

function strengthRank(s: string): number {
  return STRENGTH_RANK[s] ?? 1.5;
}

function unversioned(u: string): string {
  return u.split("|")[0];
}

/** Short name of a canonical for reason texts (`identifier-type-tw`). */
export function canonicalName(url: string): string {
  const u = unversioned(url);
  const i = u.lastIndexOf("/");
  return i >= 0 && i < u.length - 1 ? u.slice(i + 1) : u;
}

function baseOf(url: string): string {
  const u = unversioned(url);
  const i = u.lastIndexOf("/");
  return i > 8 ? u.slice(0, i + 1) : u;
}

// --------------------------------------------------------------------------- //
// Instance → resource → definition walk
// --------------------------------------------------------------------------- //

interface ResourceAt {
  node: Record<string, any>;
  path: string;
  /** Element names from the resource to the target (indices dropped). */
  rel: string[];
}

/** The resource holding an issue path: the deepest node with a resourceType (Bundle entries, contained). */
function resourceOf(root: any, issuePath: string): ResourceAt | null {
  const segs = parsePath(issuePath);
  if (!segs.length || !isObject(root) || typeof root.resourceType !== "string") return null;
  let node: any = root;
  let cur = segs[0].name;
  let res: ResourceAt = { node: root, path: cur, rel: [] };
  let resIdx = 0;
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    if (!isObject(node)) break;
    let next = node[s.name];
    cur += `.${s.name}`;
    if (Array.isArray(next)) {
      next = next[s.index ?? 0];
      cur += `[${s.index ?? 0}]`;
    } else if (s.index !== null) cur += `[${s.index}]`;
    node = next;
    if (isObject(node) && typeof node.resourceType === "string") {
      res = { node, path: cur, rel: [] };
      resIdx = i;
    }
  }
  res.rel = segs.slice(resIdx + 1).map((s) => s.name);
  return res;
}

interface Level {
  sd: Record<string, any>;
  /** Element path in `sd` (`Patient.identifier.type`). */
  elPath: string;
  /** Every snapshot element with that path (the element and its slices). */
  elements: Array<Record<string, any>>;
  /** The datatype to descend into for the next segment (choice: the typed name's type). */
  type: string | null;
}

/** Children named `name` under `cur` in `sd` (slices included; `value[x]` matched by its typed name). */
function matchChildren(sd: Record<string, any>, cur: string, name: string): { elements: Array<Record<string, any>>; type: string | null } | null {
  const els = elements(sd);
  const exact = els.filter((e) => e.path === `${cur}.${name}`);
  if (exact.length) {
    const first = exact[0];
    const types = typeCodes(first);
    return { elements: exact, type: first.contentReference ? null : types[0] ?? null };
  }
  const head = `${cur}.`;
  for (const e of els) {
    const p = String(e.path || "");
    if (!p.startsWith(head) || !p.endsWith("[x]")) continue;
    const stem = p.slice(head.length, -3);
    if (stem.includes(".") || !name.startsWith(stem) || name.length === stem.length) continue;
    const t = name.slice(stem.length);
    const hit = typeCodes(e).find((c) => c.toLowerCase() === t.toLowerCase());
    if (hit) return { elements: els.filter((x) => x.path === p), type: hit };
  }
  return null;
}

/** Levels along `rel` from the root of `sd`, descending into core datatypes when the definition stops inline. */
async function walk(deps: SuggestionDeps, sd: Record<string, any>, rel: string[]): Promise<Level[]> {
  const rootPath = String(sd.type || "");
  if (!rootPath) return [];
  const out: Level[] = [{ sd, elPath: rootPath, elements: elements(sd).filter((e) => e.path === rootPath), type: null }];
  let curSd = sd;
  let cur = rootPath;
  let fetches = 0;
  for (const name of rel) {
    let found = matchChildren(curSd, cur, name);
    if (!found) {
      // Not constrained inline: continue in the datatype of the current element.
      const t = out[out.length - 1].type;
      if (!t || /^[a-z]/.test(t) || t === "Resource" || t === "DomainResource" || fetches >= 12) break;
      fetches++;
      let dsd: Record<string, any> | null = null;
      try {
        dsd = await deps.fetchStructureDefinition(CORE + t);
      } catch {
        dsd = null;
      }
      if (!dsd || !elements(dsd).length) break;
      curSd = dsd;
      cur = String(dsd.type || t);
      found = matchChildren(curSd, cur, name);
      if (!found) break;
    }
    cur = String(found.elements[0].path);
    out.push({ sd: curSd, elPath: cur, elements: found.elements, type: found.type });
  }
  return out;
}

function bindingsOf(el: Record<string, any>): Array<{ valueSet: string; strength: string; source: BindingRef["source"] }> {
  const out: Array<{ valueSet: string; strength: string; source: BindingRef["source"] }> = [];
  const b = isObject(el.binding) ? el.binding : null;
  if (b && typeof b.valueSet === "string" && b.valueSet) {
    out.push({ valueSet: b.valueSet, strength: String(b.strength || ""), source: "binding" });
    for (const x of Array.isArray(b.extension) ? b.extension : []) {
      if (!isObject(x) || x.url !== EXT_MAX_VALUESET) continue;
      const v = typeof x.valueCanonical === "string" ? x.valueCanonical : typeof x.valueUri === "string" ? x.valueUri : null;
      if (v) out.push({ valueSet: v, strength: "max", source: "max" });
    }
  }
  for (const x of Array.isArray(el.extension) ? el.extension : []) {
    if (!isObject(x) || x.url !== EXT_ADDITIONAL_BINDING || !Array.isArray(x.extension)) continue;
    let vs: string | null = null;
    let purpose = "additional";
    for (const y of x.extension) {
      if (!isObject(y)) continue;
      if (y.url === "valueSet" && typeof y.valueCanonical === "string") vs = y.valueCanonical;
      if (y.url === "purpose" && typeof y.valueCode === "string") purpose = y.valueCode;
    }
    if (vs) out.push({ valueSet: vs, strength: purpose, source: "additional" });
  }
  return out;
}

/** Profiles of a resource instance (`meta.profile`), plus the validation's profiles for the root resource. */
function profilesOf(res: ResourceAt, root: any, opts: WalkOptions): string[] {
  if (opts.resourceProfiles) return opts.resourceProfiles.filter((p) => typeof p === "string" && p !== "").slice(0, 3);
  const out: string[] = [];
  const metas = isObject(res.node.meta) && Array.isArray(res.node.meta.profile) ? res.node.meta.profile : [];
  for (const p of metas) if (typeof p === "string" && p && !out.includes(p)) out.push(p);
  if (res.node === root) for (const p of opts.profiles || []) if (typeof p === "string" && p && !out.includes(p)) out.push(p);
  return out.slice(0, 3);
}

/**
 * Bindings that govern the element at `issuePath` (a Coding, CodeableConcept, code, Quantity
 * ... — pass the coded element's path, not `.code` / `.system`). Null when the resource or
 * its definitions cannot be found. Fail-open: a profile that cannot be fetched is skipped.
 */
export async function elementBindings(deps: SuggestionDeps, root: any, issuePath: string, opts: WalkOptions = {}): Promise<ElementBindings | null> {
  const res = resourceOf(root, issuePath);
  if (!res) return null;
  const rt = String(res.node.resourceType);
  const urls = [...profilesOf(res, root, opts), CORE + rt];
  const found = new Map<string, BindingRef & { order: number }>();
  const definitions: Array<Record<string, any>> = [];
  let elementPath = res.rel.length ? `${rt}.${res.rel.join(".")}` : rt;
  let resolved = false;
  for (const [pi, u] of urls.entries()) {
    let sd: Record<string, any> | null = null;
    try {
      sd = await deps.fetchStructureDefinition(u);
    } catch {
      sd = null;
    }
    if (!sd || !elements(sd).length) continue;
    definitions.push(sd);
    const levels = await walk(deps, sd, res.rel);
    if (!levels.length) continue;
    const complete = levels.length === res.rel.length + 1;
    const collect = (els: Array<Record<string, any>>, depth: number): void => {
      for (const el of els) {
        for (const b of bindingsOf(el)) {
          const key = unversioned(b.valueSet);
          const cur = found.get(key);
          const cand = { ...b, element: String(el.id || el.path || ""), profile: String(sd!.url || u), depth, order: pi };
          if (!cur || depth < cur.depth || (depth === cur.depth && strengthRank(b.strength) < strengthRank(cur.strength))) found.set(key, cand);
        }
      }
    };
    levels.forEach((lv, i) => collect(lv.elements, res.rel.length - i));
    if (complete) {
      const last = levels[levels.length - 1];
      if (!resolved) {
        elementPath = last.elPath;
        resolved = true;
      }
      // The `.coding` child of a CodeableConcept carries bindings of its own in some profiles.
      if (last.type === "CodeableConcept") {
        const kids = matchChildren(last.sd, last.elPath, "coding");
        if (kids) collect(kids.elements, 0);
      }
    }
  }
  // Nearest, then strongest, then a slice's binding before the unsliced element's, then profile before base.
  const sliced = (b: BindingRef): number => (b.element.includes(":") ? 0 : 1);
  const bindings = [...found.values()]
    .sort((a, b) => a.depth - b.depth || strengthRank(a.strength) - strengthRank(b.strength) || sliced(a) - sliced(b) || a.order - b.order || (a.valueSet < b.valueSet ? -1 : 1))
    .map(({ order: _o, ...b }) => b);
  return { resourceType: rt, resourcePath: res.path, resource: res.node, elementPath, bindings, definitions };
}

// --------------------------------------------------------------------------- //
// ValueSet → CodeSystems
// --------------------------------------------------------------------------- //

export interface ValueSetSystem {
  system: string;
  /** Codes the ValueSet enumerates for this system; null = the whole system (or a filter). */
  codes: Set<string> | null;
  /** The include carries a filter (membership not decidable from the compose alone). */
  filtered: boolean;
}

/** CodeSystems a ValueSet draws from (compose.include, one level of nested ValueSets). */
export async function valueSetSystems(deps: SuggestionDeps, vsUrl: string, depth = 0): Promise<ValueSetSystem[]> {
  if (!deps.loadValueSet) return [];
  let vs: Record<string, any> | null = null;
  try {
    vs = await deps.loadValueSet(vsUrl);
  } catch {
    vs = null;
  }
  if (!vs || !isObject(vs.compose)) return [];
  const out = new Map<string, ValueSetSystem>();
  const add = (s: ValueSetSystem): void => {
    const cur = out.get(s.system);
    if (!cur) out.set(s.system, s);
    else {
      cur.filtered = cur.filtered || s.filtered;
      if (cur.codes && s.codes) for (const c of s.codes) cur.codes.add(c);
      else cur.codes = null;
    }
  };
  for (const inc of Array.isArray(vs.compose.include) ? vs.compose.include : []) {
    if (!isObject(inc)) continue;
    if (typeof inc.system === "string" && inc.system) {
      const concepts = Array.isArray(inc.concept) ? inc.concept.filter(isObject).map((c: any) => String(c.code ?? "")).filter((c: string) => c !== "") : null;
      add({ system: inc.system, codes: concepts && concepts.length ? new Set(concepts) : null, filtered: Array.isArray(inc.filter) && inc.filter.length > 0 });
    } else if (depth < 1 && Array.isArray(inc.valueSet)) {
      for (const v of inc.valueSet.slice(0, 3)) if (typeof v === "string") for (const s of await valueSetSystems(deps, v, depth + 1)) add(s);
    }
  }
  return [...out.values()];
}

// --------------------------------------------------------------------------- //
// A1: the code belongs to another CodeSystem of the bound ValueSet (or of the same name)
// --------------------------------------------------------------------------- //

export async function suggestCrossSystem(
  deps: SuggestionDeps,
  root: any,
  issuePath: string,
  system: string,
  code: string,
  opts: WalkOptions = {},
): Promise<Suggestion[]> {
  const { coding, codingPath } = codingContext(root, issuePath);
  const display = coding && typeof coding.display === "string" && coding.display.trim() ? coding.display.trim() : null;
  const ctx = await elementBindings(deps, root, codingPath, opts);
  interface Cand {
    /** The bound ValueSets that include the system (nearest / strongest first). */
    via: Array<{ binding: BindingRef; vsSystem: ValueSetSystem }>;
    sameName: boolean;
  }
  const cands = new Map<string, Cand>();
  // 1. Other CodeSystems the bound ValueSets include (nearest / strongest binding first).
  if (ctx) {
    for (const b of ctx.bindings.slice(0, 4)) {
      for (const s of await valueSetSystems(deps, b.valueSet)) {
        if (s.system === system) continue;
        const cur = cands.get(s.system);
        if (cur) cur.via.push({ binding: b, vsSystem: s });
        else cands.set(s.system, { via: [{ binding: b, vsSystem: s }], sameName: false });
      }
    }
  }
  // 2. The CodeSystem of the same name under another base (an IG-local copy of an HL7 CodeSystem).
  const tail = canonicalName(system).toLowerCase();
  if (deps.canonicalsUnder && tail && tail !== unversioned(system).toLowerCase()) {
    for (const base of [...new Set([baseOf(system), THO_CS, "http://hl7.org/fhir/"])]) {
      let urls: string[] = [];
      try {
        urls = await deps.canonicalsUnder(base, ["CodeSystem"]);
      } catch {
        urls = [];
      }
      for (const c of urls) {
        if (c === system || canonicalName(c).toLowerCase() !== tail) continue;
        const cur = cands.get(c);
        if (cur) cur.sameName = true;
        else cands.set(c, { via: [], sameName: true });
      }
    }
  }
  const list = [...cands.entries()].slice(0, 5);
  if (!list.length) return [];
  const checks = await Promise.all(list.map(([s]) => deps.checkCode(s, code, display).catch(() => null)));
  const out: Suggestion[] = [];
  for (const [i, [s, c]] of list.entries()) {
    const r = checks[i];
    if (!r || (r.status !== "ok" && r.status !== "invalid-display")) continue;
    let confidence: number;
    let reason: string;
    if (c.via.length) {
      // In the CodeSystem — but is it in a bound ValueSet's selection of it? The best verdict counts
      // (a slice's ValueSet may include the whole system where the base one enumerates a few codes).
      let best: { binding: BindingRef; member: boolean | undefined } | null = null;
      for (const { binding, vsSystem } of c.via) {
        let member: boolean | undefined = vsSystem.codes ? vsSystem.codes.has(code) : vsSystem.filtered ? undefined : true;
        if (member === undefined && deps.valueSetContains) {
          try {
            member = await deps.valueSetContains(binding.valueSet, s, code);
          } catch {
            member = undefined;
          }
        }
        const rank = (m: boolean | undefined): number => (m === true ? 2 : m === undefined ? 1 : 0);
        if (!best || rank(member) > rank(best.member)) best = { binding, member };
        if (member === true) break;
      }
      const { binding, member } = best!;
      confidence = member === false ? 0.6 : member === undefined ? 0.8 : 0.9;
      reason =
        `code '${code}' is not in ${system} but exists in ${s}, which the bound ValueSet ${canonicalName(binding.valueSet)} (${binding.strength}) also includes` +
        (member === false ? `; the ValueSet includes only some codes of ${canonicalName(s)}, not '${code}'` : "");
    } else {
      confidence = display && r.status === "ok" ? 0.85 : 0.8;
      reason = `'${code}' is a code of ${s}, the CodeSystem of the same name (${canonicalName(s)}) under ${baseOf(s)}${display && r.status === "ok" ? ", with this display" : ""}`;
    }
    out.push({ value: s, kind: "replace_system", confidence, reason, patch: { op: "replace", path: `${codingPath}.system`, value: s } });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// v15.2 R3: unknown code of an excerpt CodeSystem → an accepted coding of another system it links to
// --------------------------------------------------------------------------- //

/**
 * v15.2.1: the element's bindings from the IG profiles of a resource that declares none
 * (implicitProfiles.ts): the bindings a profile itself puts on the element and its coding slices
 * (the core definition's are left out, as they are the same for every profile); one profile
 * → its bindings; several → only when they all agree; a profile that cannot be read, or profiles
 * that disagree → null (no alternative — never assumed).
 */
async function implicitBindings(deps: SuggestionDeps, root: any, codingPath: string, resourceType: string, system: string): Promise<{ imp: ImplicitProfiles; bindings: BindingRef[] } | null> {
  if (!deps.implicitProfiles) return null;
  let imp: ImplicitProfiles | null = null;
  try {
    imp = implicitCandidates(await deps.implicitProfiles(resourceType, system));
  } catch {
    imp = null;
  }
  if (!imp) return null;
  const per: BindingRef[][] = [];
  for (const p of imp.profiles) {
    const c = await elementBindings(deps, root, codingPath, { resourceProfiles: [p] });
    const sd = c ? c.definitions.find((d) => unversioned(String(d.url || "")) === unversioned(p) && d.type === resourceType) : undefined;
    if (!c || !sd) return null;
    per.push(c.bindings.filter((b) => unversioned(b.profile) === unversioned(p)));
  }
  if (!bindingsAgree(per)) return null;
  return { imp, bindings: per[0] };
}

/**
 * "Unknown code X in CodeSystem S" where X is defined in another installed copy of S (an excerpt
 * CodeSystem — TW Core 1.0.0 ships 35 of the NHI drug codes) and its concept links to codings of
 * other systems (a drug's ATC code from the NHI supplement): each linked coding that
 *   - the validator accepts (codeAlternatives: the validator's code check / the bundled terminology
 *     server verdicts — never a guess), and
 *   - a ValueSet bound to the element or one of its coding slices includes (membership as the
 *     validator decides it, e.g. TW Core's medcation-atc-tw for slice atc-medication-code)
 * is offered as the replacement Coding (`replace_coding`; CodeableConcept.text is kept). When the
 * CodeableConcept already carries that coding, the unknown Coding is to be dropped (`remove_coding`):
 * validator_cli rejects the CodeableConcept while the unknown Coding is present, whatever else it holds.
 * The original's display is kept in the reason, so the product-level name is not lost silently.
 */
export async function suggestAlternativeCoding(
  deps: SuggestionDeps,
  root: any,
  issuePath: string,
  system: string,
  code: string,
  opts: WalkOptions = {},
): Promise<Suggestion[]> {
  if (!deps.codeAlternatives) return [];
  let known: Awaited<ReturnType<NonNullable<SuggestionDeps["codeAlternatives"]>>> = null;
  try {
    known = await deps.codeAlternatives(system, code);
  } catch {
    known = null;
  }
  if (!known || !known.definedIn || known.inValidatedCopy) return [];
  const accepted = known.alternatives.filter((a) => a.accepted === true && a.system !== system);
  if (!accepted.length) return [];
  const { coding, codingPath } = codingContext(root, issuePath);
  if (!coding) return [];
  const ctx = await elementBindings(deps, root, codingPath, opts);
  if (!ctx) return [];
  const allowedBy = async (bindings: BindingRef[]): Promise<Array<{ alt: (typeof accepted)[number]; binding: BindingRef }>> => {
    const allowed: Array<{ alt: (typeof accepted)[number]; binding: BindingRef }> = [];
    for (const alt of accepted) {
      let via: BindingRef | null = null;
      for (const b of bindings.slice(0, 8)) {
        const systems = await valueSetSystems(deps, b.valueSet);
        const vss = systems.find((x) => x.system === alt.system);
        if (!vss) continue;
        let member: boolean | undefined = vss.codes ? vss.codes.has(alt.code) : undefined;
        if (member === undefined && deps.valueSetContains) {
          try {
            member = await deps.valueSetContains(b.valueSet, alt.system, alt.code);
          } catch {
            member = undefined;
          }
        }
        if (member === true) {
          via = b;
          break;
        }
      }
      if (via) allowed.push({ alt, binding: via });
    }
    return allowed;
  };
  let allowed = await allowedBy(ctx.bindings);
  // v15.2.1: no declared profile → the binding of the IG's profile(s) of this resource type.
  let implicit: ImplicitProfiles | null = null;
  if (!allowed.length && !declaresProfile(ctx.resource, ctx.resource === root ? opts.profiles || [] : [])) {
    const bindings = await implicitBindings(deps, root, codingPath, ctx.resourceType, system);
    if (bindings) {
      allowed = await allowedBy(bindings.bindings);
      implicit = bindings.imp;
    }
  }
  if (!allowed.length) return [];
  const m = /^(.*)\.coding\[\d+\]$/.exec(codingPath);
  const cc = m ? nodeAt(root, m[1]) : null;
  const present = (a: { system: string; code: string }): boolean =>
    isObject(cc) && Array.isArray(cc.coding) && cc.coding.some((c: any) => isObject(c) && c.system === a.system && c.code === a.code);
  const unique = allowed.length === 1;
  const name = known.display ? ` ('${known.display}')` : "";
  const bindingNote = implicit ? `; ${implicitNote(implicit)}` : "";
  return allowed.map(({ alt, binding }) => {
    const coding2 = { system: alt.system, code: alt.code, ...(alt.display ? { display: alt.display } : {}) };
    const where = `${canonicalName(binding.valueSet)} (${binding.strength}${binding.element.includes(":") ? `, slice ${binding.element.split(":").pop()}` : ""})`;
    if (present(alt)) {
      return {
        value: code,
        kind: "remove_coding" as const,
        confidence: 0.85,
        reason:
          `'${code}'${name} is defined in ${known!.definedIn} but not in the copy of ${system} this package validates against; the CodeableConcept already ` +
          `carries ${alt.system}#${alt.code}, which ${where} accepts — drop the unknown Coding (the validator rejects the CodeableConcept while it is present)${bindingNote}`,
        system: alt.system,
        patch: { op: "remove" as const, path: codingPath },
      };
    }
    return {
      value: alt.code,
      kind: "replace_coding" as const,
      confidence: unique ? 0.85 : 0.7,
      reason:
        `'${code}'${name} is defined in ${known!.definedIn} but not in the copy of ${system} this package validates against; its concept links to ` +
        `${alt.system}#${alt.code}${alt.display ? ` '${alt.display}'` : ""}, which the validator accepts and ${where} includes — replace the Coding ` +
        `(keep the name in CodeableConcept.text; a product-level code becomes the substance-level one)${bindingNote}`,
      system: alt.system,
      ...(alt.display ? { display: alt.display } : {}),
      patch: { op: "replace" as const, path: codingPath, value: coding2 },
    };
  });
}

// --------------------------------------------------------------------------- //
// A2: unknown CodeSystem URL on a Coding → the bound ValueSets' codes / systems
// --------------------------------------------------------------------------- //

export async function suggestBoundCoding(
  deps: SuggestionDeps,
  root: any,
  systemPath: string,
  url: string,
  budget: Budget,
  opts: WalkOptions = {},
  systemIsValueSet = false,
): Promise<Suggestion[]> {
  const { parent: codingPath } = splitLast(systemPath);
  if (!codingPath) return [];
  const coding = nodeAt(root, codingPath);
  if (!isObject(coding)) return [];
  const code = typeof coding.code === "string" && coding.code.trim() ? coding.code.trim() : null;
  const display = typeof coding.display === "string" && coding.display.trim() ? coding.display.trim() : null;
  const ctx = await elementBindings(deps, root, codingPath, opts);
  const bindings = ctx ? ctx.bindings.slice(0, 3) : [];
  // v13: a ValueSet canonical written as the system — its own CodeSystems / codes are candidates
  // too (first), whatever the element is bound to.
  if (systemIsValueSet) {
    const i = bindings.findIndex((b) => unversioned(b.valueSet) === unversioned(url));
    const own = i >= 0 ? bindings.splice(i, 1)[0] : { valueSet: unversioned(url), strength: "named as system", element: "the system", profile: "", source: "binding" as const, depth: 0 };
    bindings.unshift(own);
  }
  if (!bindings.length) return [];
  const what = systemIsValueSet ? `'${url}' is a ValueSet, not a CodeSystem` : `'${url}' is not a known CodeSystem`;
  const boundTo = (b: BindingRef): string =>
    b.strength === "named as system" ? `the ValueSet ${canonicalName(b.valueSet)}` : `${b.element} is bound to ${canonicalName(b.valueSet)} (${b.strength}), which`;
  const out: Suggestion[] = [];
  // 1. The Coding's display / code normalised within the bound ValueSets (one lookup per ValueSet, nearest first).
  const label = display || (code && /[a-z]/i.test(code) ? code : null);
  const seen = new Set<string>();
  if (label) {
    // Normalisation targets: each bound ValueSet; for a ValueSet written as the system, that
    // ValueSet first and then each CodeSystem it includes (a filter-defined include is often not
    // expandable locally, its CodeSystem is), stopping at the first that answers.
    const targets: Array<{ b: BindingRef; target: { system?: string; valueSet?: string }; via?: string }> = [];
    for (const [i, b] of bindings.entries()) {
      targets.push({ b, target: { valueSet: b.valueSet } });
      if (systemIsValueSet && i === 0) for (const s of (await valueSetSystems(deps, b.valueSet)).slice(0, 3)) targets.push({ b, target: { system: s.system }, via: s.system });
    }
    for (const [ti, { b, target, via }] of targets.entries()) {
      if (budget.left <= 0) break;
      if (systemIsValueSet && out.length && ti > 0 && targets[ti - 1].b !== b) break;
      const cands = (await normalized(deps, budget, label, target, 5)).slice(0, systemIsValueSet ? 3 : 5);
      cands.forEach((c, i) => {
        if (!c.code) return;
        const key = `${c.system ?? ""}|${c.code}`;
        if (seen.has(key)) return;
        seen.add(key);
        const sim = c.display ? textSim(label, c.display) : 0;
        const exact = c.exact || sim >= 0.98;
        const rel = typeof c.score === "number" ? Math.min(1, c.score) : Math.max(0.2, 0.75 - 0.06 * i) * (0.6 + 0.4 * sim);
        const confidence = (exact ? 0.88 : Math.min(0.85, 0.4 + 0.5 * rel)) * (b.depth > 0 ? 0.95 : 1);
        out.push({
          value: c.code,
          kind: "replace_coding",
          confidence,
          reason: `${what}; ${via ? `in ${via}, which the ValueSet ${canonicalName(b.valueSet)} includes,` : b.strength === "named as system" ? `in the ValueSet ${canonicalName(b.valueSet)},` : `${b.element} is bound to ${canonicalName(b.valueSet)} (${b.strength}), where`} '${label}' ${exact ? "names" : "matches"} ${c.system ?? "?"}#${c.code}${c.display ? ` '${c.display}'` : ""}`,
          ...(c.system ? { system: c.system } : {}),
          ...(c.display ? { display: c.display } : {}),
          patch: { op: "replace", path: codingPath, value: { ...(c.system ? { system: c.system } : {}), code: c.code, ...(c.display ? { display: c.display } : {}) } },
        });
      });
    }
  }
  // 2. The CodeSystems those ValueSets draw from (the one that holds the code first).
  const systems: Array<{ system: string; via: BindingRef }> = [];
  for (const b of bindings) {
    for (const s of await valueSetSystems(deps, b.valueSet)) {
      if (s.system === unversioned(url) || systems.some((x) => x.system === s.system)) continue;
      systems.push({ system: s.system, via: b });
    }
  }
  const top = systems.slice(0, 4);
  const checks = await Promise.all(top.map(({ system }) => (code ? deps.checkCode(system, code, display).catch(() => null) : Promise.resolve(null))));
  top.forEach(({ system, via }, i) => {
    const r = checks[i];
    const held: boolean | null = !code || !r ? null : r.status === "ok" || r.status === "invalid-display" ? true : r.status === "invalid-code" ? false : null;
    out.push({
      value: system,
      kind: "replace_system",
      confidence: held === true ? 0.9 : held === false ? 0.35 : 0.5,
      reason:
        `${what}; ${boundTo(via)} draws codes from ${system}` +
        (held === true ? `; code '${code}' exists in it` : held === false ? `; but code '${code}' is not in it` : ""),
      patch: { op: "replace", path: systemPath, value: system },
    });
  });
  return out;
}

// --------------------------------------------------------------------------- //
// A3: the value is a valid code of another bound element of the same resource
// --------------------------------------------------------------------------- //

interface SiblingBinding {
  /** Element path in the definition (`AllergyIntolerance.reaction.severity`). */
  elementPath: string;
  /** Instance path of that element (`Bundle.entry[5].resource.reaction[0].severity`). */
  instancePath: string;
  valueSet: string;
  strength: string;
  type: string;
  /** The instance already has a value there. */
  present: boolean;
  /** Snapshot order (tie-break). */
  order: number;
}

/** Other coded elements of the resource with a required / extensible binding, strongest first, in snapshot order. */
function siblingBindings(ctx: ElementBindings): SiblingBinding[] {
  const out: SiblingBinding[] = [];
  const seen = new Set<string>();
  const own = ctx.elementPath;
  for (const sd of ctx.definitions) {
    const els = elements(sd);
    const maxOf = new Map<string, string>();
    for (const el of els) if (typeof el.path === "string" && !maxOf.has(el.path)) maxOf.set(el.path, String(el.max ?? "1"));
    for (const el of els) {
      const p = typeof el.path === "string" ? el.path : "";
      if (!p || seen.has(p) || p === own || p.startsWith(`${own}.`) || own.startsWith(`${p}.`)) continue;
      const b = isObject(el.binding) ? el.binding : null;
      if (!b || typeof b.valueSet !== "string" || !b.valueSet || (b.strength !== "required" && b.strength !== "extensible")) continue;
      const type = typeCodes(el).find((t) => t === "code" || t === "Coding" || t === "CodeableConcept");
      if (!type) continue;
      // Instance path: the resource path plus the element's segments, `[0]` on repeating ones.
      const segs = p.split(".").slice(1);
      let ip = ctx.resourcePath;
      let node: any = ctx.resource;
      let acc = String(sd.type || segs[0]);
      for (const s of segs) {
        acc += `.${s}`;
        const child = isObject(node) ? node[s] : undefined;
        const repeating = Array.isArray(child) || (child === undefined && maxOf.get(acc) !== "1" && maxOf.get(acc) !== "0");
        ip += `.${s}${repeating ? "[0]" : ""}`;
        node = Array.isArray(child) ? child[0] : child;
      }
      seen.add(p);
      out.push({ elementPath: p, instancePath: ip, valueSet: b.valueSet, strength: String(b.strength), type, present: node !== undefined, order: out.length });
    }
  }
  return out.sort((a, b) => strengthRank(a.strength) - strengthRank(b.strength) || a.order - b.order);
}

export async function suggestMoveValue(
  deps: SuggestionDeps,
  root: any,
  issuePath: string,
  vsUrl: string | null,
  opts: WalkOptions = {},
): Promise<Suggestion[]> {
  if (!deps.valueSetContains) return [];
  const given = givenValues(nodeAt(root, issuePath));
  const codings = given.codings.filter((g) => g.code).slice(0, 2);
  if (!codings.length) return [];
  const ctx = await elementBindings(deps, root, issuePath, opts);
  if (!ctx || !ctx.definitions.length) return [];
  const fits = (t: string): boolean => (given.kind === "code" ? t === "code" : given.kind === "Coding" ? t === "Coding" || t === "CodeableConcept" : given.kind === "CodeableConcept" ? t === "CodeableConcept" : false);
  const sibs = siblingBindings(ctx)
    .filter((s) => fits(s.type))
    .slice(0, 12);
  const out: Suggestion[] = [];
  for (const sib of sibs) {
    for (const g of codings) {
      let member: boolean | undefined;
      try {
        member = await deps.valueSetContains(sib.valueSet, g.system, g.code);
      } catch {
        member = undefined;
      }
      if (member !== true) continue;
      const rel = sib.elementPath.slice(sib.elementPath.indexOf(".") + 1);
      out.push({
        value: sib.instancePath,
        kind: "move_value",
        confidence: sib.present ? 0.45 : 0.6,
        reason:
          `'${g.code}' is not in ${vsUrl ? canonicalName(vsUrl) : "this value set"} but is a valid code of ${ctx.resourceType}.${rel} (ValueSet ${canonicalName(sib.valueSet)}, ${sib.strength}): the value may belong to that element` +
          (sib.present ? ", which already has a value" : ""),
        ...(g.system ? { system: g.system } : {}),
        patch: { op: "move", from: issuePath, path: sib.instancePath },
      });
      break;
    }
  }
  return out;
}
