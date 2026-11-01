/**
 * Release v1 item 3 — the one rule every repair that uses a profile's fixed[x] / pattern[x] value follows:
 *
 *   a MISSING fixed / pattern value may be filled in; an EXISTING value that differs from it is never overwritten
 *   (by any rule: fixed-value, fixed-slice, shape, display, system …).
 *
 * The only exception is a pure representation difference — the same value in another JSON shape (`["x"]` for `"x"`,
 * surrounding whitespace) or another URI of the same code system (`urn:oid:2.16.840.1.113883.6.1` / a trailing `/`
 * for `http://loinc.org`). A real conflict is reported (fhirRepair issue → `ambiguous`, category fixed_pattern) and the
 * validator's error stays: the record says one thing, the profile requires another, and only the record's author can
 * say which is right (a preliminary result is not a final one).
 *
 * Nothing here is IG-specific: the system aliases are FHIR R4's external code system table (systems.ts).
 */

import { EXTERNAL_SYSTEMS } from "./systems.js";

type Json = Record<string, any>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** OID / URL spellings → the canonical URL of an external code system (FHIR R4 terminologies-systems). */
const SYSTEM_ALIASES: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const e of EXTERNAL_SYSTEMS) {
    m.set(e.url, e.url);
    for (const n of e.names) if (/^\d+(?:\.\d+)+$/u.test(n)) m.set(`urn:oid:${n}`, e.url);
  }
  return m;
})();

/** The canonical spelling of a URI for comparison (trailing slash, known OID aliases); other strings: trimmed. */
function canonicalUri(s: string): string {
  const t = s.trim();
  const noSlash = /^https?:\/\/.+\/$/u.test(t) ? t.slice(0, -1) : t;
  return SYSTEM_ALIASES.get(noSlash) ?? SYSTEM_ALIASES.get(t) ?? noSlash;
}

const looksUri = (s: string): boolean => /^(?:https?:\/\/|urn:)/u.test(s.trim());

/**
 * Is `written` the profile's `required` value, differing at most in representation? Objects follow pattern
 * semantics (every property of `required` present and the same); an array of one item equals that item.
 */
export function sameValue(written: unknown, required: unknown): boolean {
  if (Array.isArray(written) && !Array.isArray(required)) return written.length === 1 && sameValue(written[0], required);
  if (Array.isArray(required) && !Array.isArray(written)) return required.length === 1 && sameValue(written, required[0]);
  if (Array.isArray(written) && Array.isArray(required)) return required.every((r) => written.some((w) => sameValue(w, r)));
  if (isObj(required)) return isObj(written) && Object.entries(required).every(([k, v]) => sameValue(written[k], v));
  if (typeof required === "string" && typeof written === "string") {
    if (written === required || written.trim() === required.trim()) return true;
    return looksUri(written) && looksUri(required) && canonicalUri(written) === canonicalUri(required);
  }
  if (typeof required === "number" && typeof written === "string") return written.trim() !== "" && Number(written) === required;
  if (typeof required === "boolean" && typeof written === "string") return written.trim() === String(required);
  return JSON.stringify(written) === JSON.stringify(required);
}

/** May a fixed / pattern value be written over `existing`? Absent → yes (fill); same value in another shape → yes; else no. */
export function mayWriteFixed(existing: unknown, required: unknown): boolean {
  if (existing === undefined || existing === null) return true;
  return sameValue(existing, required);
}

/** Workflow-status elements (Observation.status, …): a value there is the record's state, not a representation. */
export function isStatusElement(key: string, def?: Json | null): boolean {
  return key === "status" || /\.status$/u.test(String(def?.path ?? ""));
}

/** The repair-issue message of a conflict (the record's value is kept). */
export function conflictMessage(args: { path: string; written: unknown; required: unknown; where: string; status: boolean }): string {
  const w = JSON.stringify(args.written);
  const r = JSON.stringify(args.required);
  return (
    `the record has ${w} at ${args.path}, but ${args.where} requires ${r}: an existing value that differs from the profile's fixed / pattern value is never overwritten — not changed` +
    (args.status
      ? `. A status is the record's own state (an unfinished result is not a final one): when the record does not say ${r}, this Bundle cannot conform to the profile — report insufficient_information instead of changing the status`
      : ". Correct it only from the record (or choose a profile that allows this value)")
  );
}

/** The candidates of a conflict: descriptions only — no automatic patch for a code / status / clinical value. */
export function conflictCandidates(required: unknown, status: boolean): string[] {
  const r = JSON.stringify(required);
  return status
    ? [`if the record itself states ${r}, write that value`, "otherwise keep the record's value and report insufficient_information (the record does not meet this profile)"]
    : [`if the record itself states ${r}, write that value`, "otherwise keep the record's value (the profile does not fit this record)"];
}
