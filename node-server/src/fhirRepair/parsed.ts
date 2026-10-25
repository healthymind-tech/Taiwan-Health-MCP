/** Parse results shared by the authoring value grammar (authoring/values.ts) and the repair layer. */

import { isRawNumber } from "../losslessJson.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string; candidates?: unknown[] };

export function fail<T = never>(message: string, candidates?: unknown[]): Parsed<T> {
  return candidates && candidates.length ? { ok: false, message, candidates } : { ok: false, message };
}

export function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "nothing";
  if (Array.isArray(v)) return "an array";
  if (isRawNumber(v)) return `a number (${v.text})`;
  if (typeof v === "object") return `an object with keys ${Object.keys(v as object).join(", ") || "(none)"}`;
  if (typeof v === "string") return `a string (${JSON.stringify(v.length > 40 ? v.slice(0, 39) + "…" : v)})`;
  return `${typeof v} ${String(v)}`;
}
