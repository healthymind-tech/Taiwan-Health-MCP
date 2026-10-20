/**
 * Code-level suggestions:
 *   - unknown code in a CodeSystem → repaired spellings of the code that the validator
 *     accepts (case, whitespace, ICD dot), codes whose name matches the Coding's display /
 *     the CodeableConcept text (fhir_normalize_code), near codes of an IG CodeSystem, and
 *     the same code in another terminology whose code shape fits (replace_system);
 *   - wrong display → the valid display(s) the validator names (uniform for every
 *     terminology), plus the code whose display is the one written (replace_code);
 *   - value not in a required / extensible ValueSet → its codes, all of them when the
 *     expansion is small, otherwise the closest to the given code / display.
 */

import type { ExpandedCoding, NormalizeCandidate, Suggestion, SuggestionDeps } from "./types.js";
import { isObject, nodeAt, splitLast, textSim } from "./util.js";

export const LOINC = "http://loinc.org";
export const SNOMED = "http://snomed.info/sct";
export const ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm";

/** Terminologies a misplaced code is checked against, by code shape. */
const SHAPES: Array<{ system: string; re: RegExp }> = [
  { system: LOINC, re: /^(LA|LP|LL|LG)?\d{1,7}-\d$/ },
  { system: SNOMED, re: /^[1-9]\d{5,17}$/ },
  { system: ICD10CM, re: /^[A-TV-Z]\d[0-9A-Z](\.[0-9A-Z]{1,4})?$/ },
];

export interface Budget {
  /** Expensive collaborator calls (normalize / expand / validateAgainst) left for this validation. */
  left: number;
  /** Of those, "right display, wrong code" lookups left (a secondary suggestion; one per validation). */
  displayLeft?: number;
}

/** The Coding addressed by an issue path ending in .code / .display / .system, and its CodeableConcept text. */
export function codingContext(root: any, issuePath: string): { coding: Record<string, any> | null; codingPath: string; text: string | null } {
  const { parent, last } = splitLast(issuePath);
  const codingPath = ["code", "display", "system", "version"].includes(last) ? parent : issuePath;
  const coding = nodeAt(root, codingPath);
  let text: string | null = null;
  const m = /^(.*)\.coding\[\d+\]$/.exec(codingPath);
  if (m) {
    const cc = nodeAt(root, m[1]);
    if (isObject(cc) && typeof cc.text === "string" && cc.text.trim()) text = cc.text.trim();
  }
  return { coding: isObject(coding) ? coding : null, codingPath, text };
}

/** Spelling repairs of a code (deterministic, small). */
export function codeVariants(code: string, system: string): string[] {
  const out = new Set<string>();
  const c = code.trim();
  const add = (x: string): void => {
    if (x && x !== code) out.add(x);
  };
  add(c);
  add(c.replace(/\s+/g, ""));
  add(c.toLowerCase());
  add(c.toUpperCase());
  add(c.replace(/_/g, "-"));
  add(c.replace(/-/g, "_"));
  if (system === ICD10CM || /icd-?10/i.test(system)) {
    const u = c.toUpperCase().replace(/\s+/g, "");
    if (!u.includes(".") && u.length > 3) add(`${u.slice(0, 3)}.${u.slice(3)}`);
    if (u.includes(".")) add(u.replace(/\.$/, ""));
  }
  if (system === LOINC) {
    const m = /^(\d+)(\d)$/.exec(c);
    if (m) add(`${m[1]}-${m[2]}`);
  }
  return [...out].slice(0, 8);
}

async function normalized(deps: SuggestionDeps, budget: Budget, text: string, target: { system?: string; valueSet?: string }, limit: number): Promise<NormalizeCandidate[]> {
  if (!deps.normalize || budget.left <= 0 || !text.trim()) return [];
  budget.left--;
  try {
    return await deps.normalize(text, target, limit);
  } catch {
    return [];
  }
}

function codingPatch(codingPath: string, system: string | null, code: string, display: string | null): Suggestion["patch"] {
  return { op: "replace", path: codingPath, value: { ...(system ? { system } : {}), code, ...(display ? { display } : {}) } };
}

export async function suggestUnknownCode(
  deps: SuggestionDeps,
  root: any,
  issuePath: string,
  system: string,
  code: string,
  budget: Budget,
): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const { coding, codingPath, text } = codingContext(root, issuePath);
  const display = coding && typeof coding.display === "string" && coding.display.trim() ? coding.display.trim() : null;
  // 1. Spelling repairs the validator accepts (checked concurrently; results keep the variant order).
  const variants = codeVariants(code, system);
  const checks = await Promise.all(variants.map((v) => deps.checkCode(system, v, display).catch(() => null)));
  variants.forEach((v, i) => {
    const r = checks[i];
    if (!r || (r.status !== "ok" && r.status !== "invalid-display")) return;
    const caseOnly = v.toLowerCase() === code.toLowerCase();
    out.push({
      value: v,
      kind: "replace_code",
      confidence: r.status === "ok" ? (caseOnly ? 0.95 : 0.9) : 0.75,
      reason: caseOnly ? `codes are case-sensitive: '${v}' exists in ${system}` : `'${v}' (same code, corrected spelling) exists in ${system}`,
      system,
      patch: { op: "replace", path: `${codingPath}.code`, value: v },
    });
  });
  const repaired = out.some((s) => s.confidence >= 0.9);
  // 2. Codes named like the display / text.
  const label = display || text;
  // A repair that matches the display already is the answer: no name lookup needed.
  if (label && !repaired) {
    const cands = await normalized(deps, budget, label, { system }, 5);
    cands.forEach((c, i) => {
      if (!c.code || c.code === code) return;
      const sim = c.display ? textSim(label, c.display) : 0;
      const exact = c.exact || sim >= 0.98;
      out.push({
        value: c.code,
        kind: "replace_code",
        confidence: exact ? 0.88 : Math.max(0.3, 0.72 - 0.08 * i) * (0.6 + 0.4 * sim),
        reason: `${exact ? "named exactly" : "closest name to"} '${label}' in ${c.system || system}${c.display ? `: '${c.display}'` : ""}`,
        system: c.system || system,
        ...(c.display ? { display: c.display } : {}),
        patch: codingPatch(codingPath, c.system || system, c.code, c.display),
      });
    });
  }
  // 3. Near codes of an IG CodeSystem (no name to go by).
  if (!out.length && deps.nearCodes) {
    try {
      const near = await deps.nearCodes(system, code, 3);
      near.forEach((n, i) =>
        out.push({
          value: n.code,
          kind: "replace_code",
          confidence: 0.45 - 0.05 * i,
          reason: `an existing code of ${system} that looks like '${code}'${n.display ? `: '${n.display}'` : ""}`,
          system,
          ...(n.display ? { display: n.display } : {}),
          patch: { op: "replace", path: `${codingPath}.code`, value: n.code },
        }),
      );
    } catch {
      /* fail-open */
    }
  }
  // 4. The code belongs to another terminology (by its shape).
  const shapes = SHAPES.filter((x) => x.system !== system && x.re.test(code));
  const other = await Promise.all(shapes.map((x) => deps.checkCode(x.system, code, display).catch(() => null)));
  shapes.forEach((x, i) => {
    const r = other[i];
    if (!r || (r.status !== "ok" && r.status !== "invalid-display")) return;
    out.push({
      value: x.system,
      kind: "replace_system",
      confidence: r.status === "ok" && display ? 0.85 : 0.65,
      reason: `'${code}' is a code of ${x.system}${r.status === "ok" && display ? " with this display" : ""}`,
      patch: { op: "replace", path: `${codingPath}.system`, value: x.system },
    });
  });
  return out;
}

/** The quoted displays a "Wrong Display Name" message lists as valid (any terminology). */
export function parseValidDisplays(message: string): string[] {
  const out: string[] = [];
  const grab = (s: string): void => {
    // A quoted item ends at a quote followed by a list separator / language note / end.
    const re = /'((?:[^']|'(?!\s*(?:,|\bor\b|\(|$|\.\s|;)))*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  };
  const valid = /Valid display is (.*)$/s.exec(message);
  // The language note may be followed by further clauses ("; the display denotes a different concept: …"),
  // so strip it wherever it sits and stop at the first clause separator outside the quoted list.
  if (valid) grab(valid[1].replace(/\s*\(for the language\(s\) '[^']*'\)/g, "").replace(/;\s+the display denotes[\s\S]*$/, ""));
  const def = /Default display is (.*)$/s.exec(message);
  if (def) grab(def[1]);
  return out;
}

export async function suggestDisplay(deps: SuggestionDeps, root: any, issuePath: string, message: string, budget: Budget): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const { coding, codingPath } = codingContext(root, issuePath);
  const m = /(?:Wrong (?:whitespace in )?Display Name) '(.*)' for (\S+?)#(\S+?)[.:]?(?:\s|$)/s.exec(message);
  const system = m ? m[2] : coding && typeof coding.system === "string" ? coding.system : null;
  const code = m ? m[3] : coding && typeof coding.code === "string" ? coding.code : null;
  const given = coding && typeof coding.display === "string" ? coding.display : m ? m[1] : "";
  const displays = parseValidDisplays(message);
  displays.slice(0, 5).forEach((d, i) => {
    out.push({
      value: d,
      kind: "replace_display",
      confidence: i === 0 ? 0.92 : Math.max(0.5, 0.8 - 0.05 * i + 0.1 * textSim(given, d)),
      reason: i === 0 ? `the valid display of ${system}#${code}` : `another valid display of ${system}#${code}`,
      ...(system ? { system } : {}),
      patch: { op: "replace", path: `${codingPath}.display`, value: d },
    });
  });
  // The written display may name another code (right display, wrong code) — looked up only when it
  // does not read like a variant of a valid display (bounded cost: one normalize call).
  const variant = displays.some((d) => textSim(given, d) >= 0.5);
  if (system && given && code && !variant && (budget.displayLeft ?? 2) > 0) {
    budget.displayLeft = (budget.displayLeft ?? 2) - 1;
    const cands = await normalized(deps, budget, given, { system }, 3);
    for (const c of cands) {
      if (!c.code || c.code === code || !c.display) continue;
      if (textSim(given, c.display) < 0.98 && !c.exact) continue;
      out.push({
        value: c.code,
        kind: "replace_code",
        confidence: displays.length ? 0.6 : 0.8,
        reason: `'${given}' is the display of ${c.system || system}#${c.code} — if that concept was meant, change the code instead`,
        system: c.system || system,
        display: c.display,
        patch: codingPatch(codingPath, c.system || system, c.code, c.display),
      });
      break;
    }
  }
  return out;
}

/** The ValueSet canonical a binding message names: `'Title' (url)` or `'url'`. */
export function parseBindingValueSet(message: string): string | null {
  const m = /value set '(?:[^']|'(?! \())*' \(([^)\s]+)\)/.exec(message) || /value set '([a-z][a-z0-9+.-]*:[^']+)'/i.exec(message);
  return m ? m[1] : null;
}

/** Given (system, code, label) values of a bound element instance. */
function givenValues(node: any): { codings: Array<{ system: string | null; code: string }>; labels: string[]; kind: "code" | "Coding" | "CodeableConcept" | "Quantity" | "other" } {
  if (typeof node === "string") return { codings: [{ system: null, code: node }], labels: [node], kind: "code" };
  if (!isObject(node)) return { codings: [], labels: [], kind: "other" };
  const labels: string[] = [];
  if (Array.isArray(node.coding)) {
    const codings = node.coding.filter(isObject).map((c: any) => ({ system: typeof c.system === "string" ? c.system : null, code: String(c.code ?? "") }));
    for (const c of node.coding) if (isObject(c) && typeof c.display === "string" && c.display.trim()) labels.push(c.display.trim());
    if (typeof node.text === "string" && node.text.trim()) labels.push(node.text.trim());
    for (const c of codings) if (c.code) labels.push(c.code);
    return { codings, labels, kind: "CodeableConcept" };
  }
  if (isObject(node.concept)) return givenValues(node.concept);
  const sys = typeof node.system === "string" ? node.system : null;
  if (typeof node.display === "string" && node.display.trim()) labels.push(node.display.trim());
  if ("value" in node && typeof node.unit === "string") labels.push(node.unit);
  if (typeof node.code === "string") labels.push(node.code);
  return { codings: typeof node.code === "string" ? [{ system: sys, code: node.code }] : [], labels, kind: "value" in node || "unit" in node ? "Quantity" : "Coding" };
}

/** Up to this many codes, the whole (small) expansion is offered. */
const SMALL_VS = 12;

export async function suggestBinding(deps: SuggestionDeps, root: any, issuePath: string, message: string, budget: Budget): Promise<Suggestion[]> {
  const vsUrl = parseBindingValueSet(message);
  if (!vsUrl) return [];
  const node = nodeAt(root, issuePath);
  const given = givenValues(node);
  const out: Suggestion[] = [];
  let exp: { codings: ExpandedCoding[]; total: number; truncated: boolean } | null = null;
  if (deps.expandValueSet && budget.left > 0) {
    budget.left--;
    try {
      exp = await deps.expandValueSet(vsUrl, 500);
    } catch {
      exp = null;
    }
  }
  const patchFor = (c: ExpandedCoding): Suggestion["patch"] => {
    if (given.kind === "code") return { op: "replace", path: issuePath, value: c.code };
    if (given.kind === "CodeableConcept") return { op: "replace", path: `${issuePath}.coding[0]`, value: { ...(c.system ? { system: c.system } : {}), code: c.code, ...(c.display ? { display: c.display } : {}) } };
    if (given.kind === "Quantity") return { op: "replace", path: `${issuePath}.code`, value: c.code };
    return { op: "replace", path: issuePath, value: { ...(c.system ? { system: c.system } : {}), code: c.code, ...(c.display ? { display: c.display } : {}) } };
  };
  const score = (c: ExpandedCoding): number => {
    let s = 0;
    for (const g of given.codings) {
      if (!g.code) continue;
      if (g.code.toLowerCase() === c.code.toLowerCase()) s = Math.max(s, 1);
      else s = Math.max(s, textSim(g.code, c.code) * 0.9);
    }
    for (const l of given.labels) {
      if (c.display) s = Math.max(s, textSim(l, c.display) * 0.95);
      s = Math.max(s, textSim(l, c.code) * 0.85);
      // An abbreviation of the code / display (M → male, hr → h is the reverse: code is a prefix).
      const ll = l.toLowerCase();
      if (ll && (c.code.toLowerCase().startsWith(ll) || (c.display || "").toLowerCase().startsWith(ll))) s = Math.max(s, 0.7);
    }
    return s;
  };
  const scored = new Map<string, { c: ExpandedCoding; s: number; why: string }>();
  const keyOf = (c: ExpandedCoding): string => `${c.system ?? ""}|${c.code}`;
  const codings = exp ? exp.codings : [];
  const small = !!exp && !exp.truncated && codings.length <= SMALL_VS;
  codings.forEach((c) => {
    const s = score(c);
    if (small || s >= 0.45) scored.set(keyOf(c), { c, s, why: s >= 0.99 ? "same code, written differently" : "closest code of the value set" });
  });
  // Semantic / lexical candidates restricted to the value set: large / unexpandable sets, and
  // small ones whose codes do not resemble the given value (a synonym, e.g. a status word).
  const bestLexical = Math.max(0, ...[...scored.values()].map((x) => x.s));
  if (!small || bestLexical < 0.5) {
    const label = given.labels[0];
    if (label) {
      const cands = await normalized(deps, budget, label, { valueSet: vsUrl }, 5);
      cands.forEach((n, i) => {
        if (!n.code) return;
        const c: ExpandedCoding = { system: n.system, code: n.code, display: n.display };
        const s = Math.max(score(c), (n.exact ? 0.9 : 0.75) - 0.06 * i);
        const cur = scored.get(keyOf(c));
        if (!cur || s > cur.s) scored.set(keyOf(c), { c, s, why: `matches '${label}'` });
      });
    }
  }
  const total = exp ? exp.total : null;
  const ranked = [...scored.values()].sort((a, b) => b.s - a.s || (a.c.code < b.c.code ? -1 : 1));
  for (const { c, s, why } of ranked.slice(0, small ? SMALL_VS : 5)) {
    // Already in the instance (e.g. member under another system)? Still offered.
    out.push({
      value: c.code,
      kind: "choose_code",
      confidence: small ? 0.35 + 0.6 * s : 0.3 + 0.6 * s,
      reason: `${why}${total !== null ? ` (${small ? "one of all" : "from"} ${total} code${total === 1 ? "" : "s"} in ${vsUrl})` : ` (in ${vsUrl})`}`,
      ...(c.system ? { system: c.system } : {}),
      ...(c.display ? { display: c.display } : {}),
      patch: patchFor(c),
    });
  }
  return out;
}
