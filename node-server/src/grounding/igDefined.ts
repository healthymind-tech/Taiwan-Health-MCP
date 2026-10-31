/**
 * ISSUES_v17.2 — values the IG itself defines are never record facts: grounding (G-UNGROUNDED /
 * G-CONTEXT-LABEL …) and the record checks (ungrounded-value, information-absent …) exempt them,
 * wherever in a resource they appear. Collected per IG by igBlueprint/igValues.ts:
 *   constants  fixed[x] / pattern[x] of the declared profiles, and every value fhir_get_minimal_skeleton
 *              marks ig-constant (e.g. the payer agency's name and OID the IG reuses in all its examples);
 *   literals   answer literals the profiles' invariants allow for value[x] (pat-ast-value: 'class1').
 * Literals exempt only a value[x] string (never codings, identifiers, quantities or other elements); a structured value
 * is exempt when every significant leaf of it is a constant. Pure; no clinical content is kept.
 */

export interface IgDefinedValues {
  constants: ReadonlySet<string>;
  literals: ReadonlySet<string>;
}

/** Comparison form: NFKC, trimmed, inner whitespace collapsed. */
export function normIgValue(v: unknown): string {
  return String(v).normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/** Keys whose values are qualifiers of a value, not the value itself. */
const QUALIFIER_KEYS = new Set(["system", "use", "version", "userSelected", "display", "url", "id", "extension", "modifierExtension"]);

/** Every scalar leaf of a value (strings, numbers, booleans), qualifier keys included. */
export function allLeaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || v === null || v === undefined) return out;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    const s = normIgValue(v);
    if (s && !(s.startsWith("<") && s.endsWith(">"))) out.push(s);
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) allLeaves(x, out, depth + 1);
    return out;
  }
  if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) allLeaves(x, out, depth + 1);
  return out;
}

/** The leaves that carry the value (qualifier keys skipped). */
function significantLeaves(v: unknown, out: string[], depth: number): string[] {
  if (depth > 12 || v === null || v === undefined) return out;
  if (typeof v === "string" || typeof v === "number") {
    const s = normIgValue(v);
    if (s) out.push(s);
    return out;
  }
  if (typeof v === "boolean") return out;
  if (Array.isArray(v)) {
    for (const x of v) significantLeaves(x, out, depth + 1);
    return out;
  }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!QUALIFIER_KEYS.has(k)) significantLeaves(x, out, depth + 1);
  }
  return out;
}

/** Paths an invariant answer literal may exempt: a value[x] string / code (Observation.valueString, component.valueCodeableConcept.text is not one). */
const RE_VALUE_PATH = /(?:^|\.)value(?:String|Code)?$/u;

/**
 * True when the value is one the IG defines (see the module comment). Quantities and bare numbers are never exempt;
 * invariant literals only for a value[x] string at `path` (when the path is given).
 */
export function isIgDefined(node: unknown, defs: IgDefinedValues | null | undefined, path?: string): boolean {
  if (!defs || (!defs.constants.size && !defs.literals.size) || node === null || node === undefined) return false;
  if (typeof node === "number") return false; // a bare number is a measurement / count, never exempt
  if (typeof node === "string") {
    const s = normIgValue(node);
    return s.length > 0 && (defs.constants.has(s) || (path !== undefined && RE_VALUE_PATH.test(path) && defs.literals.has(s)));
  }
  if (typeof node !== "object" || Array.isArray(node)) return false;
  const o = node as Record<string, unknown>;
  if (typeof o.value === "number") return false; // Quantity-like
  const leaves = significantLeaves(o, [], 0);
  return leaves.length > 0 && leaves.every((s) => defs.constants.has(s));
}
