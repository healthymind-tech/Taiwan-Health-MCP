/**
 * R1 — Coding.display that the terminology rejects ("Wrong Display Name") for a code that exists.
 * The display is replaced by the code's official display ONLY when it is a different spelling of
 * the SAME concept; when it names a different concept (the model probably chose the wrong code)
 * nothing is changed and an issue carries the codes the display itself denotes.
 *
 * Method (data-driven, documented in the tool descriptions):
 *   (a) spelling — the display equals one of the valid displays the validator lists for the code
 *       (display, designations / synonyms in any language, LOINC long / short names …) after
 *       normalisation: Unicode NFKC, case, punctuation / whitespace, word order, singular / plural,
 *       roman numerals (Type II ↔ Type 2), a SNOMED semantic tag "(disorder)", or it is the
 *       initialism of one (CBC ↔ complete blood count) → same;
 *   (b) search — otherwise the display is searched in the code's own system (fhir_normalize_code:
 *       lexical + semantic ranking over the terminology's names). Same only when the given code is
 *       the top candidate AND that hit is exact or shares at least half of its words with a valid
 *       display (c, token overlap of the words), and no other candidate is named exactly like the
 *       display. Another code ranked first (e.g. 'Pneumonia' → 233604007 for a coding 428921007
 *       'Infection of uncertain etiology'), the given code only lower in the list, or no search
 *       available → different (ancestors / descendants count as different concepts);
 *   ambiguous is treated as different: reported, never changed.
 * The code and system are never changed; the model's wording is kept as CodeableConcept.text when
 * that is empty.
 */

import { UCUM_SYSTEM } from "../fhirUcum.js";
import type { RepairChange, RepairIssue } from "./types.js";
import { isObject, type Session, type Site } from "./walk.js";

const SNOMED = "http://snomed.info/sct";
/** Reason of a whitespace-only display correction (the composer records it without a note). */
export const WHITESPACE_ONLY = "whitespace-only difference";
const STOP = new Set(["of", "in", "and", "the", "by", "for", "with", "to", "on", "at", "or", "a", "an"]);

function words(s: string): string[] {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9㐀-鿿]+/)
    .filter(Boolean);
}

function stripTag(s: string): string {
  return s.replace(/\s*\([a-z ]+\)\s*$/i, "");
}

const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };

/** One word in comparable form: roman numerals II–IX as digits, a plain English plural -s dropped. */
function stem(w: string): string {
  if (w in ROMAN) return ROMAN[w];
  return w.length > 3 && /[a-z]s$/.test(w) && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

/** Bag of words (order-free, stemmed) of a display. */
function bag(s: string): string {
  return words(s).map(stem).sort().join(" ");
}

function initials(s: string): string {
  return words(s)
    .filter((w) => !STOP.has(w))
    .map((w) => w[0])
    .join("");
}

/** (a): the same name after normalisation? */
export function sameSpelling(given: string, valid: string[], system: string): string | null {
  const g = system === SNOMED ? stripTag(given) : given;
  const gb = bag(g);
  const gi = /^[A-Z0-9]{2,8}$/.test(given.trim()) ? given.trim().toLowerCase() : null;
  for (const v of valid) {
    const vv = system === SNOMED ? stripTag(v) : v;
    if (gb && bag(vv) === gb) return v;
    if (gi && initials(vv) === gi) return v;
  }
  return null;
}

function overlap(a: string, b: string): number {
  const A = new Set(words(a).filter((w) => !STOP.has(w)));
  const B = new Set(words(b).filter((w) => !STOP.has(w)));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.max(A.size, B.size);
}

export interface DisplayDecision {
  same: boolean;
  /** The official display to use (same). */
  display?: string;
  reason: string;
  /** Codes the display denotes in the code's system (different). */
  candidates?: Array<{ system: string | null; code: string; display: string | null }>;
}

export async function decideDisplay(session: Session, system: string, code: string, given: string, valid: string[]): Promise<DisplayDecision> {
  const official = async (): Promise<string> => {
    let canonical: string | null = null;
    if (session.deps.lookupDisplay) canonical = await session.memo(`disp\0${system}\0${code}`, () => session.deps.lookupDisplay!(system, code), null);
    if (canonical && valid.length && !valid.some((d) => d.toLowerCase() === canonical!.toLowerCase())) canonical = null;
    return canonical ?? valid[0];
  };
  const spelled = sameSpelling(given, valid, system);
  if (spelled) {
    return { same: true, display: await official(), reason: `'${given}' is the valid display '${spelled}' written differently (case / punctuation / word order / abbreviation)` };
  }
  const cands = await session.normalize(given, { system }, 5);
  if (cands === null) {
    return { same: false, reason: `'${given}' is not a valid display of ${system}#${code} and could not be checked further (no terminology search available)` };
  }
  const named = (c: { display: string | null }): boolean => !!c.display && bag(c.display) === bag(given);
  const top = cands[0];
  const others = cands.filter((c) => c.code !== code);
  const shown = others.slice(0, 5).map((c) => ({ system: c.system ?? system, code: c.code, display: c.display }));
  if (top && top.code === code && !others.some(named)) {
    const best = Math.max(0, ...valid.map((v) => overlap(given, v)));
    if (top.exact || best >= 0.5) {
      return { same: true, display: await official(), reason: `searching '${given}' in ${system} finds ${code} first${top.exact ? " (exact)" : ` (${Math.round(best * 100)}% of the words shared with its display)`}: the same concept` };
    }
    return { same: false, reason: `searching '${given}' in ${system} finds ${code} first, but neither exactly nor sharing enough words with its displays — ambiguous`, candidates: shown };
  }
  const rank = cands.findIndex((c) => c.code === code);
  const firstOther = others[0];
  return {
    same: false,
    reason:
      firstOther
        ? `'${given}' denotes ${firstOther.system ?? system}#${firstOther.code}${firstOther.display ? ` '${firstOther.display}'` : ""}${rank > 0 ? ` (${code} ranks ${rank + 1})` : ` (${code} is not among the matches)`}`
        : `searching '${given}' in ${system} does not find ${code}`,
    candidates: shown,
  };
}

export async function repairDisplays(session: Session, sites: Site[], rp: (p: string) => string, skip: (p: string) => boolean): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  if (!session.deps.checkDisplay) return { changes, issues };
  for (const site of sites) {
    if (site.type !== "Coding" || !isObject(site.value)) continue;
    const coding = site.value;
    if (typeof coding.system !== "string" || typeof coding.code !== "string" || typeof coding.display !== "string" || !coding.display.trim()) continue;
    if (coding.system === UCUM_SYSTEM || !/^[a-z][a-z0-9+.-]*:/i.test(coding.system)) continue;
    if (skip(site.path) || skip(`${site.path}.display`)) continue;
    if (session.displayChecksLeft-- <= 0) break;
    const old: string = coding.display;
    const verdict = await session.memo(
      `chk\0${coding.system}\0${coding.code}\0${old}\0${coding.version ?? ""}`,
      () => session.deps.checkDisplay!(coding.system, coding.code, old, typeof coding.version === "string" ? coding.version : null),
      { status: "unknown" as const, valid: [] as string[] },
    );
    if (!verdict || verdict.status !== "invalid-display") continue;
    const valid = (verdict.valid || []).filter((d) => typeof d === "string" && d.trim());
    if (!valid.length) continue;
    const ws = (x: string): string => x.replace(/\s+/g, " ").trim().toLowerCase();
    const wsSame = valid.find((d) => ws(d) === ws(old));
    const decision: DisplayDecision = wsSame
      ? { same: true, display: wsSame, reason: WHITESPACE_ONLY }
      : await decideDisplay(session, coding.system, coding.code, old, valid);
    const path = rp(`${site.path}.display`);
    if (!decision.same || !decision.display) {
      issues.push({
        path,
        rule: "display",
        severity: "error",
        message:
          `Display '${old}' does not match ${coding.system}#${coding.code} (valid: '${valid[0]}') and was NOT replaced: ${decision.reason}. ` +
          "If the display is what was meant, the code is probably wrong — choose one of the candidates; if the code is right, use its display.",
        ...(decision.candidates && decision.candidates.length ? { candidates: decision.candidates } : {}),
      });
      continue;
    }
    if (decision.display === old) continue;
    coding.display = decision.display;
    changes.push({ path, from: old, to: decision.display, rule: "display", reason: decision.reason });
    // The model's wording is kept as the CodeableConcept's text when that is empty.
    if (site.key === "coding" && isObject(site.holder) && site.holder.text === undefined && !wsSame) {
      site.holder.text = old;
      changes.push({ path: rp(`${site.path.replace(/\.coding\[\d+\]$/, "")}.text`), from: null, to: old, rule: "display", reason: "the original wording is kept as CodeableConcept.text" });
    }
  }
  return { changes, issues };
}
