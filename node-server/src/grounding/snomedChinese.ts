/**
 * Chinese names of SNOMED CT concepts for the code-grounding comparison of the validating tools (ISSUES_v15.3 R3 follow-up,
 * recordChecks/codeGrounding.ts) — data-driven, no hand-written translation list:
 *
 *   1. IG designations: ValueSet compose / expansion concepts and SNOMED CodeSystem supplements (installed IG artifacts
 *      and uploaded fhir.codesystem_supplements) whose designation language is zh* or whose display is Chinese
 *      (TW Core ValueSets often carry Chinese displays). Confidence 0.9 (designation) / 0.85 (Chinese display).
 *   2. The SNOMED → ICD-10 extended map (snomed.icd10_map): map group 1, the highest-priority (lowest map_priority)
 *      UNCONDITIONAL rule (TRUE / OTHERWISE TRUE / empty) → the Chinese name (icd.diagnoses.name_zh) of the target;
 *      the map targets WHO ICD-10, so a target ICD-10-CM holds only as a header without a Chinese name is named by its
 *      first ICD-10-CM child that has one (".9" / ".0" … the unspecified children first), else by the 3-character
 *      category. Confidence 0.75 exact target (0.65 when conditional rules precede the chosen one), 0.65 child, 0.6
 *      category. Every other Chinese name of the target's 3-character category is returned too, at 0.3
 *      (`icd_category_member`): below every comparison threshold, it only ever shows that the record names a
 *      diagnosis of the same ICD category (never makes a code "contradicted").
 *   3. The mined bilingual thesaurus (fhir.term_thesaurus, source 'bilingual': English word stem → Chinese word,
 *      freq = Dice × 1000) applied word by word to the concept's English names (preferred term / FSN / synonyms):
 *      kept only when ≥ 80 % of the content words translate; confidence 0.8 × coverage × the weakest word's Dice.
 *
 * ICD Chinese names keep the full name plus its core: the head segment without qualifier words (未明示氣喘 → 氣喘) and
 * the following segments that are not qualifiers / negations (「，無併發症」「，部位未明示」「，未伴有食道炎」 dropped whole):
 * classification conventions, not part of the diagnosis a record writes.
 *
 * Used ONLY by the code-grounding comparison; never shown by any other tool. Cached: an LRU of per-concept results
 * and a per-process table of IG designations (refreshed hourly). Any query failure degrades to fewer names (never an
 * error) and is not cached. DB access is injected (`query`), as in terminologyDb.ts.
 */
import { BI_STOP } from "../conceptSearch/thesaurus.js";
import { hasCjk, LATIN_STOP, normalizeText, stemLatin } from "../conceptSearch/text.js";

export type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

export type ZhSource = "ig_designation" | "ig_display" | "icd_map" | "icd_map_child" | "icd_category" | "icd_category_member" | "thesaurus";

export interface ZhName {
  name: string;
  source: ZhSource;
  /** 0..1 — how surely the name means the concept (see the module comment). */
  confidence: number;
  /** ICD-10 code the name came from (icd_* sources). */
  icd?: string;
}

/** Confidence per source (thesaurus names are computed). */
export const ZH_SOURCE_CONFIDENCE = {
  ig_designation: 0.9,
  ig_display: 0.85,
  icd_map: 0.75,
  icd_map_conditional: 0.65,
  icd_map_child: 0.65,
  icd_category: 0.6,
  icd_category_member: 0.3,
} as const;

/** Share of an English name's content words the thesaurus must translate. */
export const THESAURUS_MIN_COVERAGE = 0.8;

const SCT = "http://snomed.info/sct";
const RE_ICD = /^[A-Z]\d{2}(?:\.[0-9A-Z]{1,4})?$/u;
const RE_TAG = /\s*\((?:disorder|finding|symptom|situation|observable entity|morphologic abnormality|procedure|substance|product|regime\/therapy|event|qualifier value|body structure|clinical drug|medicinal product)\)\s*$/iu;
/** SNOMED structural head words a Chinese name usually leaves out (「泌尿道感染」 for "urinary tract infectious disease"). */
const OPTIONAL_WORDS = new Set(["disorder", "disease", "finding", "condition"]);
const round2 = (x: number): number => Math.round(x * 100) / 100;

// ------------------------------------------------------------------------------------------- pure helpers

export interface MapRow {
  map_target: string | null;
  map_rule?: string | null;
  map_advice?: string | null;
  map_priority?: number | null;
  map_group?: number | null;
  active?: boolean | null;
}

const unconditional = (rule: string | null | undefined): boolean => {
  const r = String(rule ?? "").trim().toUpperCase();
  return r === "" || r === "TRUE" || r === "OTHERWISE TRUE";
};

/**
 * The ICD-10 code a concept is named by: map group 1 (the main group), active rows, the highest-priority unconditional
 * rule. `conditional`: conditional rules (IFA age / sex / other concept) precede it — the target holds only "otherwise".
 */
export function primaryMapTarget(rows: readonly MapRow[]): { code: string; conditional: boolean } | null {
  const g1 = rows
    .filter((r) => r.active !== false && (r.map_group ?? 1) === 1)
    .sort((a, b) => (a.map_priority ?? 1) - (b.map_priority ?? 1));
  let conditional = false;
  for (const r of g1) {
    const code = String(r.map_target ?? "").trim().replace(/[†*+]$/u, "").toUpperCase();
    if (!unconditional(r.map_rule)) {
      conditional = true;
      continue;
    }
    if (!RE_ICD.test(code)) return null; // the main rule maps to nothing (no ICD-10 code): no name
    return { code, conditional };
  }
  return null;
}

/** ICD-10-CM codes to look the map target up by: the code, its children (unspecified first), its category. */
export function icdCandidates(code: string): { exact: string; children: string[]; category: string } {
  const c = code.toUpperCase();
  const category = c.slice(0, 3);
  const children = c.includes(".")
    ? ["9", "0", "09", "90", "99", "00", "1"].map((s) => c + s)
    : [".9", ".0", ".90", ".99", ".909", ".00", ".1"].map((s) => c + s);
  return { exact: c, children, category };
}

const ICD_QUALIFIER = /(?:部位|病原體|原因|類型|側性|型態|位置)?(?:未明示|未特定|未明確|未特指|未明)(?:者|之|的)?|其他(?:特定)?(?:的|之)?/gu;
/** A segment after the head that is a qualifier / negation (「，未明示病原體」「，未伴有食道炎」「，無併發症」): dropped whole. */
const ICD_QUALIFIER_SEGMENT = /未明示|未特定|未明確|未特指|未明|其他|未伴有|無|不伴|伴有|併有|初期照護|後續照護|後遺症/u;
const cjkCount = (x: string): number => [...x].filter((ch) => hasCjk(ch)).length;

/**
 * The full ICD Chinese name and its core: the head segment with qualifier words removed (未明示氣喘 → 氣喘) plus the
 * following segments that are not qualifiers / negations (「，未伴有食道炎」 is dropped whole — removing only the
 * qualifier word would invert its meaning). Each ≥ 2 Chinese characters.
 */
export function icdChineseNames(nameZh: string | null | undefined): string[] {
  const full = String(nameZh ?? "").trim();
  if (!hasCjk(full)) return [];
  const [head, ...rest] = full.split(/[，,；;、]/u).map((x) => x.trim());
  const core = [head.replace(ICD_QUALIFIER, "").trim(), ...rest.filter((seg) => !ICD_QUALIFIER_SEGMENT.test(seg))]
    .filter((seg) => cjkCount(seg) >= 2)
    .join("，");
  return [...new Set([full, core].filter((x) => cjkCount(x) >= 2))];
}

/** Content-word stems of an English name (semantic tag removed), as the bilingual miner stemmed them. */
export function englishStems(name: string): string[] {
  const t = normalizeText(name.replace(RE_TAG, ""));
  const out: string[] = [];
  for (const w of t.match(/[a-z][a-z0-9]+/gu) ?? []) {
    if (LATIN_STOP.has(w)) continue;
    const st = stemLatin(w);
    if (st.length < 3 || BI_STOP.has(st)) continue;
    if (!out.includes(st)) out.push(st);
  }
  return out;
}

/** Join Chinese word translations, merging overlaps (泌尿 + 尿道 → 泌尿道) and dropping repeats. */
function joinZh(parts: readonly string[]): string {
  let out = "";
  for (const p of parts) {
    if (!p || out.includes(p)) continue;
    let k = Math.min(out.length, p.length - 1);
    while (k > 0 && !out.endsWith(p.slice(0, k))) k--;
    out += p.slice(k);
  }
  return out;
}

/**
 * Word-by-word Chinese rendering of an English name through the mined bilingual pairs (stem → {zh, dice}). Null when
 * fewer than 80 % of the content words translate (SNOMED head words disorder / disease / finding may stay untranslated).
 */
export function translateEnglish(name: string, pairs: ReadonlyMap<string, { zh: string; dice: number }>): { zh: string; coverage: number; minDice: number } | null {
  const stems = englishStems(name);
  const required = stems.filter((s) => !OPTIONAL_WORDS.has(s) || pairs.has(s));
  if (!required.length) return null;
  const hits = required.map((s) => pairs.get(s)).filter((x): x is { zh: string; dice: number } => !!x);
  const coverage = hits.length / required.length;
  if (!hits.length || coverage < THESAURUS_MIN_COVERAGE) return null;
  const zh = joinZh(hits.map((h) => h.zh));
  if ([...zh].filter((ch) => hasCjk(ch)).length < 2) return null;
  return { zh, coverage, minDice: Math.min(...hits.map((h) => h.dice)) };
}

/** Merge names: one entry per name (highest confidence wins), sorted by confidence. */
export function mergeZhNames(names: Iterable<ZhName>, maxMain = 8, maxMembers = 40): ZhName[] {
  const by = new Map<string, ZhName>();
  for (const n of names) {
    const k = normalizeText(n.name);
    if (!k) continue;
    const prev = by.get(k);
    if (!prev || n.confidence > prev.confidence) by.set(k, n);
  }
  const all = [...by.values()].sort((a, b) => b.confidence - a.confidence || a.name.length - b.name.length);
  const main = all.filter((n) => n.source !== "icd_category_member").slice(0, maxMain);
  const members = all.filter((n) => n.source === "icd_category_member").slice(0, maxMembers);
  return [...main, ...members];
}

// ------------------------------------------------------------------------------------------- provider

export interface SnomedChineseOptions {
  query: QueryFn;
  /** English names (preferred term / FSN / synonyms) by concept id — the thesaurus source. Optional. */
  englishNames?: (ids: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>;
  /** Max cached concepts (default 5000). */
  cacheSize?: number;
  /** IG designation table lifetime (default 1 h). */
  designationTtlMs?: number;
  now?: () => number;
  logger?: { warn?(msg: string, meta?: Record<string, unknown>): void };
}

export interface SnomedChineseNames {
  /** Chinese names of one concept (`snomedChineseNames(conceptId)`). */
  snomedChineseNames(conceptId: string): Promise<ZhName[]>;
  /** Batch form; concepts without a Chinese name are omitted. */
  lookup(conceptIds: readonly string[]): Promise<ReadonlyMap<string, ZhName[]>>;
  clear(): void;
  stats(): { cached: number; queries: number };
}

const CJK_RE = "[㐀-䶿一-鿿豈-﫿]";

/** Concepts of a JSON concept array with their zh designations / Chinese displays (SQL fragment over `arr`). */
function conceptRowsSql(from: string, arr: string, where: string): string {
  return (
    `SELECT c->>'code' AS code, c->>'display' AS display, d->>'language' AS lang, d->>'value' AS value FROM ${from} ` +
    `CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(${arr}) = 'array' THEN ${arr} ELSE '[]'::jsonb END) c ` +
    `LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c->'designation') = 'array' THEN c->'designation' ELSE '[]'::jsonb END) d ON TRUE ` +
    `WHERE ${where} AND (d->>'language' ILIKE 'zh%' OR c->>'display' ~ $1)`
  );
}

const DESIGNATION_QUERIES: string[] = [
  // ValueSet compose.include[system = SNOMED].concept[]
  conceptRowsSql(
    "fhir.artifacts a CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.raw_json->'compose'->'include') = 'array' THEN a.raw_json->'compose'->'include' ELSE '[]'::jsonb END) inc",
    "inc->'concept'",
    "a.resource_type = 'ValueSet' AND inc->>'system' LIKE 'http://snomed.info/sct%'",
  ),
  // ValueSet expansion.contains[] (top level)
  conceptRowsSql("fhir.artifacts a", "a.raw_json->'expansion'->'contains'", "a.resource_type = 'ValueSet' AND c->>'system' LIKE 'http://snomed.info/sct%'"),
  // SNOMED CodeSystem supplements shipped in packages
  conceptRowsSql("fhir.artifacts a", "a.raw_json->'concept'", "a.resource_type = 'CodeSystem' AND a.raw_json->>'supplements' LIKE 'http://snomed.info/sct%'"),
  // SNOMED CodeSystem supplements uploaded in the admin console
  conceptRowsSql("fhir.codesystem_supplements a", "a.raw_json->'concept'", "a.supplements LIKE 'http://snomed.info/sct%'"),
];

export function createSnomedChineseNames(opts: SnomedChineseOptions): SnomedChineseNames {
  const cap = opts.cacheSize ?? 5000;
  const ttl = opts.designationTtlMs ?? 3_600_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, ZhName[]>();
  let designations: { at: number; ttl: number; map: Map<string, ZhName[]> } | null = null;
  let queries = 0;

  const run = async (sql: string, params: unknown[]): Promise<Array<Record<string, unknown>> | null> => {
    queries++;
    try {
      return (await opts.query(sql, params)).rows;
    } catch (e) {
      opts.logger?.warn?.("snomed chinese names query failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
  const remember = (id: string, v: ZhName[]): void => {
    if (cache.has(id)) cache.delete(id);
    cache.set(id, v);
    while (cache.size > cap) cache.delete(cache.keys().next().value as string);
  };

  async function igDesignations(): Promise<Map<string, ZhName[]>> {
    if (designations && now() - designations.at < designations.ttl) return designations.map;
    const map = new Map<string, ZhName[]>();
    let failed = false;
    for (const sql of DESIGNATION_QUERIES) {
      const rows = await run(sql, [CJK_RE]);
      if (rows === null) {
        failed = true;
        continue;
      }
      for (const r of rows) {
        const code = String(r.code ?? "").trim();
        if (!/^\d{6,18}$/u.test(code)) continue;
        const list = map.get(code) ?? [];
        const value = typeof r.value === "string" ? r.value.trim() : "";
        if (value && String(r.lang ?? "").toLowerCase().startsWith("zh") && hasCjk(value)) list.push({ name: value, source: "ig_designation", confidence: ZH_SOURCE_CONFIDENCE.ig_designation });
        const display = typeof r.display === "string" ? r.display.trim() : "";
        if (display && hasCjk(display)) list.push({ name: display, source: "ig_display", confidence: ZH_SOURCE_CONFIDENCE.ig_display });
        if (list.length) map.set(code, list);
      }
    }
    // a failed source is retried after 5 minutes rather than an hour
    designations = { at: now(), ttl: failed ? Math.min(ttl, 300_000) : ttl, map };
    return map;
  }

  async function lookupUncached(ids: string[]): Promise<Map<string, ZhName[]>> {
    const out = new Map<string, ZhName[]>(ids.map((id) => [id, []]));
    const failed = new Set<string>();
    const add = (id: string, n: ZhName): void => void out.get(id)?.push(n);

    // 1. IG designations / Chinese displays
    for (const id of ids) for (const n of (await igDesignations()).get(id) ?? []) add(id, n);

    // 2. SNOMED → ICD-10 map → ICD-10-CM Chinese names
    const mapRows = await run(
      "SELECT referenced_component_id::text AS id, map_target, map_rule, map_advice, map_priority, map_group, active " +
        "FROM snomed.icd10_map WHERE referenced_component_id = ANY($1::bigint[]) AND active = TRUE",
      [ids],
    );
    if (mapRows === null) ids.forEach((id) => failed.add(id));
    else {
      const byId = new Map<string, MapRow[]>();
      for (const r of mapRows) {
        const id = String(r.id);
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id)!.push({
          map_target: r.map_target as string | null,
          map_rule: r.map_rule as string | null,
          map_advice: r.map_advice as string | null,
          map_priority: r.map_priority === null || r.map_priority === undefined ? null : Number(r.map_priority),
          map_group: r.map_group === null || r.map_group === undefined ? null : Number(r.map_group),
          active: r.active as boolean | null,
        });
      }
      const targets = new Map<string, { code: string; conditional: boolean }>();
      for (const [id, rows] of byId) {
        const t = primaryMapTarget(rows);
        if (t) targets.set(id, t);
      }
      if (targets.size) {
        const want = new Set<string>();
        const cats = new Set<string>();
        for (const t of targets.values()) {
          const c = icdCandidates(t.code);
          want.add(c.exact);
          c.children.forEach((x) => want.add(x));
          want.add(c.category);
          cats.add(c.category);
        }
        const icdRows = await run("SELECT code, name_zh FROM icd.diagnoses WHERE code = ANY($1::text[]) AND COALESCE(name_zh, '') <> ''", [[...want]]);
        const memberRows = await run(
          "SELECT code, name_zh, category FROM icd.diagnoses WHERE category = ANY($1::text[]) AND COALESCE(name_zh, '') <> '' AND length(code) <= 7 ORDER BY code LIMIT 5000",
          [[...cats]],
        );
        if (icdRows === null) {
          for (const id of targets.keys()) failed.add(id);
        } else {
          const zh = new Map(icdRows.map((r) => [String(r.code), String(r.name_zh)]));
          for (const [id, t] of targets) {
            const c = icdCandidates(t.code);
            const exact = zh.get(c.exact);
            if (exact) {
              const conf = t.conditional ? ZH_SOURCE_CONFIDENCE.icd_map_conditional : ZH_SOURCE_CONFIDENCE.icd_map;
              for (const n of icdChineseNames(exact)) add(id, { name: n, source: "icd_map", confidence: conf, icd: c.exact });
            } else {
              const child = c.children.find((x) => zh.has(x));
              if (child) for (const n of icdChineseNames(zh.get(child))) add(id, { name: n, source: "icd_map_child", confidence: ZH_SOURCE_CONFIDENCE.icd_map_child, icd: child });
            }
            if (c.category !== c.exact && zh.get(c.category)) for (const n of icdChineseNames(zh.get(c.category))) add(id, { name: n, source: "icd_category", confidence: ZH_SOURCE_CONFIDENCE.icd_category, icd: c.category });
          }
        }
        if (memberRows !== null) {
          for (const [id, t] of targets) {
            const cat = t.code.slice(0, 3);
            for (const r of memberRows) {
              if (String(r.category ?? String(r.code).slice(0, 3)) !== cat) continue;
              for (const n of icdChineseNames(String(r.name_zh))) add(id, { name: n, source: "icd_category_member", confidence: ZH_SOURCE_CONFIDENCE.icd_category_member, icd: String(r.code) });
            }
          }
        } else for (const id of targets.keys()) failed.add(id);
      }
    }

    // 3. mined bilingual thesaurus over the English names
    if (opts.englishNames) {
      let en: ReadonlyMap<string, readonly string[]> | null = null;
      try {
        en = await opts.englishNames(ids);
      } catch {
        en = null;
        ids.forEach((id) => failed.add(id));
      }
      if (en) {
        const names = new Map<string, string[]>();
        for (const id of ids) names.set(id, [...(en.get(id) ?? [])].filter((n) => !hasCjk(n)).slice(0, 6));
        const stems = [...new Set([...names.values()].flat().flatMap(englishStems))];
        if (stems.length) {
          const rows = await run("SELECT abbr, expansion, freq FROM fhir.term_thesaurus WHERE source = 'bilingual' AND abbr = ANY($1::text[])", [stems]);
          if (rows === null) ids.forEach((id) => failed.add(id));
          else {
            const pairs = new Map<string, { zh: string; dice: number }>();
            for (const r of rows) {
              const k = String(r.abbr);
              const dice = Math.min(1, Number(r.freq) / 1000);
              const prev = pairs.get(k);
              if (hasCjk(String(r.expansion)) && (!prev || dice > prev.dice)) pairs.set(k, { zh: String(r.expansion), dice });
            }
            for (const [id, ns] of names) {
              for (const n of ns) {
                const t = translateEnglish(n, pairs);
                if (t) add(id, { name: t.zh, source: "thesaurus", confidence: round2(0.8 * t.coverage * t.minDice) });
              }
            }
          }
        }
      }
    }

    const result = new Map<string, ZhName[]>();
    for (const id of ids) {
      const merged = mergeZhNames(out.get(id) ?? []);
      result.set(id, merged);
      if (!failed.has(id)) remember(id, merged);
    }
    return result;
  }

  async function lookup(conceptIds: readonly string[]): Promise<ReadonlyMap<string, ZhName[]>> {
    const ids = [...new Set(conceptIds.map((x) => String(x).trim()).filter((x) => /^\d{6,18}$/u.test(x)))];
    const out = new Map<string, ZhName[]>();
    const todo: string[] = [];
    for (const id of ids) {
      const hit = cache.get(id);
      if (hit) {
        cache.delete(id);
        cache.set(id, hit);
        if (hit.length) out.set(id, hit);
      } else todo.push(id);
    }
    if (todo.length) for (const [id, v] of await lookupUncached(todo)) if (v.length) out.set(id, v);
    return out;
  }

  return {
    lookup,
    async snomedChineseNames(conceptId) {
      return (await lookup([conceptId])).get(String(conceptId).trim()) ?? [];
    },
    clear() {
      cache.clear();
      designations = null;
    },
    stats: () => ({ cached: cache.size, queries }),
  };
}

/** `system|code` keys of SNOMED codings → concept ids. */
export function snomedIdsOf(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((k) => k.startsWith(`${SCT}|`)).map((k) => k.slice(SCT.length + 1)).filter((c) => /^\d{6,18}$/u.test(c)))];
}
