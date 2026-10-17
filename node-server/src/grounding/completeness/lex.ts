/**
 * Thin adapter over the shared grounding lexicon (../lexicon.ts, ../twLexiconData.ts) exposing
 * exactly what the completeness detectors need. No lexicon data is duplicated here.
 */
import {
  numbersWithUnits,
  freqSignatures,
  parseDates,
  routesIn,
} from "../lexicon.js";
import { TW_LEXICON_DATA } from "../twLexiconData.js";

export {
  ABSENCE_CONCEPTS,
  ABSENCE_WORDS,
  absenceConceptsIn,
  BIRTH_LABELS,
  DEFAULT_INSTRUCTION_MARKERS,
  HIST_CUES,
  ID_LABELS,
  LEXICON_VERSION,
  LIST_ITEM,
  VITAL_LABELS,
  gendersIn,
  hasStructure,
  latTokens,
  nameSimilarity,
  nfkc,
  norm,
  normWithMap,
  segment,
  type SourceLine,
} from "../lexicon.js";
export { PW, escapeRe, pyStrip } from "../py.js";

/** Abbreviation → expansion table (tw_lexicon.ABBREV). */
export const ABBREV = TW_LEXICON_DATA.terminology.abbrev as Record<string, string>;

const UNIT_TOKENS = new Set<string>(
  Object.values(TW_LEXICON_DATA.numbers.unitAliases as Record<string, string[]>).flat(),
);

/** True if the (already nfkc-normalized) string is a unit alias (tw_lexicon._UNIT_INDEX key). */
export function isUnitToken(s: string): boolean {
  return UNIT_TOKENS.has(s);
}

/** Date precisions found in text (day / month / year / md). */
export function parseDatePrecisions(text: string): string[] {
  return parseDates(text).map((d) => d[0]);
}

/** Canonical units of the numbers in text (null when a number has no unit). */
export function numberUnits(text: string): Array<string | null> {
  return numbersWithUnits(text).map((n) => n[2]);
}

export function freqSignatureCount(text: string): number {
  return freqSignatures(text).size;
}

export function routeCount(text: string): number {
  return routesIn(text).size;
}
