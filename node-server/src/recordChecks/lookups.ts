/**
 * Terminology lookups of the record checks (ISSUES_v15.3), done once per tool call by the tools through the grounding
 * terminology provider (local tables, LRU-cached — the grounding run of the same call has already fetched the same
 * keys): LOINC axes of text-result Observations (quantitative.ts, R1) and, with source_text, the names of every coding
 * (codeGrounding.ts, R3 — the names grounding compared) and, ISSUES_v15.3 R3 follow-up, the Chinese names of SNOMED codings
 * (grounding/snomedChinese.ts; only the R3 comparison reads them). Fail-open: any failure gives empty maps.
 */
import { collectCodingKeys } from "../grounding/checkGrounding.js";
import { nfkc } from "../grounding/lexicon.js";
import { RecordText } from "../grounding/recordText.js";
import { snomedIdsOf, type SlotItemRef, type ZhName } from "../grounding/snomedChinese.js";
import { diagnosisSlots } from "./diagnosisSlot.js";
import { loincCodesNeedingAxes, type CodeAxes } from "./quantitative.js";

type Json = Record<string, any>;

/** The part of the grounding terminology provider the lookups need. */
export interface TermLookup {
  lookup(keys: readonly string[]): Promise<ReadonlyMap<string, { names?: readonly string[]; axes?: CodeAxes | null }>>;
  /** Chinese names of SNOMED concepts (grounding/snomedChinese.ts) — the DB provider has it; optional. */
  snomedChineseNamesBatch?(conceptIds: readonly string[]): Promise<ReadonlyMap<string, readonly ZhName[]>>;
  /** Hierarchy guard: per SNOMED concept, the diagnosis-slot items naming the same / a broader / a narrower concept. */
  snomedRelatedSlotItems?(conceptIds: readonly string[], items: readonly SlotItemRef[]): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
}

export interface RecordCheckLookups {
  codeAxes: Map<string, CodeAxes>;
  codeNames: Map<string, string[]>;
  /** ISSUES_v15.3 R3 follow-up: Chinese names of the SNOMED codings, keyed `http://snomed.info/sct|<id>` (only when any exist). */
  codeNamesZh?: Map<string, ZhName[]>;
  /**
   * Hierarchy guard (R3): per SNOMED coding key, the diagnosis-slot item texts (the slot parser's lower-cased form) whose
   * SNOMED concept is the same, an ancestor or a descendant of the coding's — never "a different diagnosis". Only when any.
   */
  codeSlotRelations?: Map<string, Set<string>>;
}

const RE_ICD_IN = /\b[A-Z]\d{2}(?:\.[0-9A-Z]{1,4})?\b/gu;

/** The record's diagnosis-slot items as the hierarchy guard reads them (text = key, ICD codes, names). */
export function slotItemRefs(sourceText: string, siteConfig: string | null = null): SlotItemRef[] {
  const out: SlotItemRef[] = [];
  for (const s of diagnosisSlots(new RecordText(sourceText, siteConfig))) {
    if (s.empty) continue;
    for (const it of s.items) {
      const up = nfkc(it.text).toUpperCase();
      const icd = up.match(RE_ICD_IN) ?? [];
      const bare = it.text.replace(/\b[a-z]\d{2}(?:\.[0-9a-z]{1,4})?\b/giu, "").replace(/[()（）\s]+/gu, " ").trim();
      const names = [...new Set([bare, it.core].map((x) => x.trim()).filter((x) => x.length >= 2))];
      out.push({ key: it.text, icd, names });
    }
  }
  return out;
}

export async function recordCheckLookups(root: Json, terminology: TermLookup | null | undefined, sourceText: string | null | undefined, siteConfig: string | null = null): Promise<RecordCheckLookups> {
  const out: RecordCheckLookups = { codeAxes: new Map(), codeNames: new Map() };
  if (!terminology) return out;
  const axesKeys = loincCodesNeedingAxes(root);
  let nameKeys: string[] = [];
  if (typeof sourceText === "string" && sourceText.trim()) {
    try {
      nameKeys = collectCodingKeys(root);
    } catch {
      nameKeys = [];
    }
  }
  const keys = [...new Set([...axesKeys, ...nameKeys])];
  if (!keys.length) return out;
  try {
    const m = await terminology.lookup(keys);
    for (const k of axesKeys) {
      const a = m.get(k)?.axes;
      if (a && (a.property || a.scale)) out.codeAxes.set(k, { property: a.property ?? null, scale: a.scale ?? null });
    }
    for (const k of nameKeys) {
      const n = m.get(k)?.names;
      if (n && n.length) out.codeNames.set(k, [...n]);
    }
  } catch {
    // fail-open
  }
  if (nameKeys.length && typeof terminology.snomedChineseNamesBatch === "function") {
    try {
      const ids = snomedIdsOf(nameKeys);
      const zh = ids.length ? await terminology.snomedChineseNamesBatch(ids) : new Map();
      const m = new Map<string, ZhName[]>();
      for (const [id, names] of zh) if (names.length) m.set(`http://snomed.info/sct|${id}`, [...names]);
      if (m.size) out.codeNamesZh = m;
    } catch {
      // fail-open: the comparison runs on the other names
    }
  }
  if (nameKeys.length && typeof sourceText === "string" && typeof terminology.snomedRelatedSlotItems === "function") {
    try {
      const ids = snomedIdsOf(nameKeys);
      const items = ids.length ? slotItemRefs(sourceText, siteConfig) : [];
      if (items.length) {
        const rel = await terminology.snomedRelatedSlotItems(ids, items);
        const m = new Map<string, Set<string>>();
        for (const [id, keys] of rel) if (keys.size) m.set(`http://snomed.info/sct|${id}`, new Set(keys));
        if (m.size) out.codeSlotRelations = m;
      }
    } catch {
      // fail-open: without the guard the comparison is as before
    }
  }
  return out;
}
