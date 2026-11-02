/**
 * Literal facts of a JSON instance that JSON.parse drops but validator_cli sees (parity v3, review F4): the source
 * spelling of numbers (`1.0`, `1e3`, `007` — the element model keeps JsonNumber.asString(), and InstanceValidator
 * checks integer / decimal values on that text) and repeated property names (DUPLICATE_JSON_PROPERTY_KEY).
 *
 * Kept beside the parsed tree, keyed by the parsed container object, so the validator's tree stays the ordinary
 * JSON value: numberText(container, key) is the source text of the number at container[key] (only recorded when it
 * differs from String(value)); duplicateKeys(object) are the names that object repeated in the source.
 *
 * Filled from a lossless tree (losslessJson.parseLossless of the request text: registerLosslessLiterals) or by the
 * raw-text reader (fhirJsonParser.toPlain).
 */
import { isRawNumber, losslessDuplicateFirst, losslessDuplicateKeys, toPlain as losslessToPlain } from "./losslessJson.js";

const NUMBERS = new WeakMap<object, Map<string, string>>();
const DUPLICATES = new WeakMap<object, string[]>();

export function setNumberText(container: object, key: string | number, text: string, value: number): void {
  if (String(value) === text) return;
  let m = NUMBERS.get(container);
  if (!m) NUMBERS.set(container, (m = new Map()));
  m.set(String(key), text);
}

/** The source spelling of the number at container[key], when it differs from String(value). */
export function numberText(container: unknown, key: string | number): string | undefined {
  return container !== null && typeof container === "object" ? NUMBERS.get(container)?.get(String(key)) : undefined;
}

/** A copy of a parsed container keeps the source literals of the original. */
export function copyLiterals(from: object, to: object): void {
  const m = NUMBERS.get(from);
  if (m) NUMBERS.set(to, m);
  const d = DUPLICATES.get(from);
  if (d) DUPLICATES.set(to, d);
}

export function setDuplicateKeys(obj: object, names: string[]): void {
  if (names.length) DUPLICATES.set(obj, names);
}

/** Property names `obj` repeated in its source (each repetition once per extra occurrence). */
export function duplicateKeys(obj: unknown): string[] {
  return obj !== null && typeof obj === "object" ? DUPLICATES.get(obj) ?? [] : [];
}

/**
 * Walks the parsed tree and the lossless tree of the same text in parallel and records the number spellings and
 * duplicated names on the parsed containers; a repeated name takes its FIRST value in the parsed tree (the tree is
 * changed in place, as validator_cli's element model reads it). Shapes that differ are skipped (never throws).
 */
export function registerLosslessLiterals(plain: unknown, lossless: unknown, depth = 0): void {
  if (depth > 200 || plain === null || typeof plain !== "object" || lossless === null || typeof lossless !== "object") return;
  if (Array.isArray(plain)) {
    if (!Array.isArray(lossless)) return;
    plain.forEach((v, i) => {
      const l = lossless[i];
      if (typeof v === "number" && isRawNumber(l)) setNumberText(plain, i, l.text, v);
      else registerLosslessLiterals(v, l, depth + 1);
    });
    return;
  }
  if (Array.isArray(lossless) || isRawNumber(lossless)) return;
  const lo = lossless as Record<string, unknown>;
  const dups = losslessDuplicateKeys(lo);
  const firsts = losslessDuplicateFirst(lo);
  if (dups.length) setDuplicateKeys(plain, dups);
  const po = plain as Record<string, unknown>;
  for (const [k, v0] of Object.entries(po)) {
    if (!Object.prototype.hasOwnProperty.call(lo, k)) continue;
    let v = v0;
    let l = lo[k];
    // JsonParser.getJsonPropertyByName binds the FIRST of repeated names (JSON.parse kept the last); resourceType is
    // read with JsonObject.get (last wins) and stays as is
    if (firsts.has(k) && k !== "resourceType" && k !== "__proto__") {
      l = firsts.get(k);
      po[k] = v = losslessToPlain(l);
    }
    if (typeof v === "number" && isRawNumber(l)) setNumberText(plain, k, l.text, v);
    else registerLosslessLiterals(v, l, depth + 1);
  }
}
