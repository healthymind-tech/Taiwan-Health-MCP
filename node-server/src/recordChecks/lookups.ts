/**
 * Terminology lookups of the record checks (ISSUES_v15.3), done once per tool call by the tools through the grounding
 * terminology provider (local tables, LRU-cached — the grounding run of the same call has already fetched the same
 * keys): LOINC axes of text-result Observations (quantitative.ts, R1) and, with source_text, the names of every coding
 * (codeGrounding.ts, R3 — the names grounding compared). Fail-open: any failure gives empty maps.
 */
import { collectCodingKeys } from "../grounding/checkGrounding.js";
import { loincCodesNeedingAxes, type CodeAxes } from "./quantitative.js";

type Json = Record<string, any>;

/** The part of the grounding terminology provider the lookups need. */
export interface TermLookup {
  lookup(keys: readonly string[]): Promise<ReadonlyMap<string, { names?: readonly string[]; axes?: CodeAxes | null }>>;
}

export interface RecordCheckLookups {
  codeAxes: Map<string, CodeAxes>;
  codeNames: Map<string, string[]>;
}

export async function recordCheckLookups(root: Json, terminology: TermLookup | null | undefined, sourceText: string | null | undefined): Promise<RecordCheckLookups> {
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
  return out;
}
