/**
 * Chinese names of SNOMED CT concepts for the code-grounding comparison of the validating tools (ISSUES_v15.3 R3 follow-up,
 * recordChecks/codeGrounding.ts) — data-driven, no hand-written translation list:
 *
 *   1. IG designations: ValueSet compose / expansion concepts and SNOMED CodeSystem supplements (installed IG artifacts
 *      of Chinese-language packages and uploaded fhir.codesystem_supplements) whose designation language is zh* or whose
 *      display is Chinese. Confidence 0.9 (designation) / 0.85 (Chinese display). Loaded once per process in the
 *      background (see igDesignations: single flight, stale-while-revalidate, ≤ 2 s wait on the first load — the first
 *      calls of a process may therefore run without IG names; then every name is capped at PARTIAL_MAX (0.55, below the
 *      comparability threshold), so such a call can give "uncertain" (warning) where a later one gives "contradicted"
 *      (error), never the reverse).
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

/** Highest confidence of a thesaurus rendering no ICD Chinese name of the concept corroborates (below 0.6: never comparable). */
export const THESAURUS_UNCORROBORATED_MAX = 0.55;

/** Confidence cap of every name while the IG designation table is not available (first load running / failed). */
export const PARTIAL_MAX = 0.55;

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

/**
 * Qualifier PREFIX of an ICD Chinese head segment (其他或未明示之氣喘, 未明示部位之泌尿道感染症, 其他特定之尿失禁): removed as a
 * whole, only at the start — removing qualifier words anywhere leaves fragments (「或氣喘」).
 */
const ICD_QUALIFIER_PREFIX = /^(?:其他(?:特定)?(?:或|及)?(?:未明示|未特定|未明確|未特指)?|未明示|未特定|未明確|未特指)(?:部位|病原體|原因|類型|側性|型態|位置)?(?:之|的)?/u;
/** A segment after the head that is a qualifier / negation (「，未明示病原體」「，未伴有食道炎」「，無併發症」): dropped whole. */
const ICD_QUALIFIER_SEGMENT = /未明示|未特定|未明確|未特指|未明|其他|未伴有|無|不伴|伴有|併有|初期照護|後續照護|後遺症/u;
/** A Chinese name never starts with a function word / bound suffix morpheme (「或氣喘」「性氣喘」「之心肌梗塞」 are fragments). */
const RE_FRAGMENT_START = /^[或及與和之的伴併并性型症者等以於而且]/u;
const cjkCount = (x: string): number => [...x].filter((ch) => hasCjk(ch)).length;

/** A complete Chinese name: ≥ 2 Chinese characters and not starting with a function word / bound morpheme. */
export function isCompleteZhName(name: string): boolean {
  const t = name.trim();
  return cjkCount(t) >= 2 && !RE_FRAGMENT_START.test(t);
}

/**
 * Drop candidates that are fragments: incomplete names (isCompleteZhName), and a name that is another complete candidate
 * minus its first character (「道感染」 next to 「尿道感染」: the tail of a longer word, not a name of its own).
 */
export function dropFragments<T extends { name: string }>(names: readonly T[]): T[] {
  const complete = names.filter((n) => isCompleteZhName(n.name));
  const all = complete.map((n) => n.name.trim());
  return complete.filter((n) => {
    const t = n.name.trim();
    return !all.some((o) => o.length === t.length + 1 && o.endsWith(t) && hasCjk(o[0]));
  });
}

/**
 * The full ICD Chinese name and its core: the head segment without its qualifier prefix (其他或未明示之氣喘 → 氣喘) plus the
 * following segments that are not qualifiers / negations (「，未伴有食道炎」 is dropped whole — removing only the
 * qualifier word would invert its meaning). Only complete names (isCompleteZhName) are returned.
 */
export function icdChineseNames(nameZh: string | null | undefined): string[] {
  const full = String(nameZh ?? "").trim();
  if (!hasCjk(full)) return [];
  const [head, ...rest] = full.split(/[，,；;、]/u).map((x) => x.trim());
  const h = head.replace(ICD_QUALIFIER_PREFIX, "").trim();
  const core = [isCompleteZhName(h) ? h : head, ...rest.filter((seg) => !ICD_QUALIFIER_SEGMENT.test(seg))]
    .filter((seg) => cjkCount(seg) >= 2)
    .join("，");
  return [...new Set([full, core].filter(isCompleteZhName))];
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
export function translateEnglish(name: string, pairs: ReadonlyMap<string, { zh: string; dice: number }>): { zh: string; parts: string[]; coverage: number; minDice: number } | null {
  const stems = englishStems(name);
  const required = stems.filter((s) => !OPTIONAL_WORDS.has(s) || pairs.has(s));
  if (!required.length) return null;
  const hits = required.map((s) => pairs.get(s)).filter((x): x is { zh: string; dice: number } => !!x);
  const coverage = hits.length / required.length;
  if (!hits.length || coverage < THESAURUS_MIN_COVERAGE) return null;
  // mined n-grams can carry a neighbour's bound morpheme (asthma ↔ 「性氣喘」): trim it
  const parts = hits.map((h) => h.zh.replace(/^[或及與和之的伴併并性型症者等以於而且]+/u, "")).filter((x) => x.length);
  const zh = joinZh(parts);
  if (!isCompleteZhName(zh)) return null;
  return { zh, parts, coverage, minDice: Math.min(...hits.map((h) => h.dice)) };
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
  const all = dropFragments([...by.values()]).sort((a, b) => b.confidence - a.confidence || a.name.length - b.name.length);
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
  /** IG designation table lifetime (default 1 h; refreshed in the background after it). */
  designationTtlMs?: number;
  /** How long a request waits for the FIRST designation load before going on without it (default 2000 ms). */
  designationWaitMs?: number;
  now?: () => number;
  logger?: { warn?(msg: string, meta?: Record<string, unknown>): void };
}

export interface SnomedChineseNames {
  /** Chinese names of one concept (`snomedChineseNames(conceptId)`). */
  snomedChineseNames(conceptId: string): Promise<ZhName[]>;
  /** Batch form; concepts without a Chinese name are omitted. */
  lookup(conceptIds: readonly string[]): Promise<ReadonlyMap<string, ZhName[]>>;
  /** Start loading the IG designation table in the background (app startup); resolves when loaded. Never rejects. */
  warm(): Promise<void>;
  clear(): void;
  stats(): { cached: number; queries: number; designations: "none" | "loading" | "loaded" | "failed" };
}

const CJK_RE = "[㐀-䶿一-鿿豈-﫿]";

/**
 * The IG designation table in ONE query, restricted before any jsonb is read: only packages that hold Chinese text in an
 * artifact's title / name / description (plain columns — data-driven "Chinese-language packages"; on production TW Core
 * and TW PAS, 4 package versions instead of 94 696 ValueSets / 420 MB of jsonb), their ValueSet / CodeSystem rows via the
 * primary key, plus the uploaded SNOMED supplements. EXPLAIN ANALYZE on production: ~0.63 s (was 13.8 s + 11.4 s).
 */
export const DESIGNATION_SQL = `
WITH pk AS MATERIALIZED (
  SELECT DISTINCT package_id, package_version FROM fhir.artifacts
   WHERE title ~ $1 OR name ~ $1 OR description ~ $1),
art AS MATERIALIZED (
  SELECT a.resource_type, a.raw_json FROM pk JOIN fhir.artifacts a USING (package_id, package_version)
   WHERE a.resource_type IN ('ValueSet', 'CodeSystem')),
con AS (
  SELECT c FROM art,
       jsonb_array_elements(CASE WHEN jsonb_typeof(art.raw_json->'compose'->'include') = 'array' THEN art.raw_json->'compose'->'include' ELSE '[]'::jsonb END) inc,
       jsonb_array_elements(CASE WHEN jsonb_typeof(inc->'concept') = 'array' THEN inc->'concept' ELSE '[]'::jsonb END) c
   WHERE art.resource_type = 'ValueSet' AND inc->>'system' LIKE 'http://snomed.info/sct%'
  UNION ALL
  SELECT c FROM art,
       jsonb_array_elements(CASE WHEN jsonb_typeof(art.raw_json->'expansion'->'contains') = 'array' THEN art.raw_json->'expansion'->'contains' ELSE '[]'::jsonb END) c
   WHERE art.resource_type = 'ValueSet' AND c->>'system' LIKE 'http://snomed.info/sct%'
  UNION ALL
  SELECT c FROM art,
       jsonb_array_elements(CASE WHEN jsonb_typeof(art.raw_json->'concept') = 'array' THEN art.raw_json->'concept' ELSE '[]'::jsonb END) c
   WHERE art.resource_type = 'CodeSystem' AND art.raw_json->>'supplements' LIKE 'http://snomed.info/sct%'
  UNION ALL
  SELECT c FROM fhir.codesystem_supplements s,
       jsonb_array_elements(CASE WHEN jsonb_typeof(s.raw_json->'concept') = 'array' THEN s.raw_json->'concept' ELSE '[]'::jsonb END) c
   WHERE s.supplements LIKE 'http://snomed.info/sct%')
SELECT c->>'code' AS code, c->>'display' AS display, d->>'language' AS lang, d->>'value' AS value
  FROM con LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c->'designation') = 'array' THEN c->'designation' ELSE '[]'::jsonb END) d ON TRUE
 WHERE d->>'language' ILIKE 'zh%' OR c->>'display' ~ $1`;

export function createSnomedChineseNames(opts: SnomedChineseOptions): SnomedChineseNames {
  const cap = opts.cacheSize ?? 5000;
  const ttl = opts.designationTtlMs ?? 3_600_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, ZhName[]>();
  const waitMs = opts.designationWaitMs ?? 2000;
  let designations: { at: number; ttl: number; map: Map<string, ZhName[]>; ok: boolean } | null = null;
  let inflight: Promise<void> | null = null;
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

  /**
   * The IG designation table: loaded once (single flight — concurrent callers share one in-flight load), refreshed in
   * the background after its lifetime (stale-while-revalidate — a request never waits for a refresh), started early by
   * `warm()` (app startup). While the FIRST load is still running a request waits at most `designationWaitMs` (2 s) and
   * then proceeds without IG designations (returns null; the ICD-map and thesaurus names still apply, and that call's
   * concept results are not cached).
   */
  const startLoad = (): Promise<void> => {
    inflight ??= (async () => {
      const rows = await run(DESIGNATION_SQL, [CJK_RE]);
      if (rows === null) {
        // keep the previous table; retry after 5 minutes
        designations = designations ? { ...designations, at: now(), ttl: Math.min(ttl, 300_000) } : { at: now(), ttl: Math.min(ttl, 300_000), map: new Map(), ok: false };
        return;
      }
      const map = new Map<string, ZhName[]>();
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
      designations = { at: now(), ttl, map, ok: true };
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  async function igDesignations(): Promise<{ map: Map<string, ZhName[]>; ok: boolean } | null> {
    if (designations) {
      if (now() - designations.at >= designations.ttl) void startLoad(); // stale-while-revalidate
      return designations;
    }
    const load = startLoad().then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const done = await Promise.race([load, timeout]);
    if (timer) clearTimeout(timer);
    return done && designations ? designations : null;
  }

  async function lookupUncached(ids: string[]): Promise<Map<string, ZhName[]>> {
    const out = new Map<string, ZhName[]>(ids.map((id) => [id, []]));
    const failed = new Set<string>();
    const add = (id: string, n: ZhName): void => void out.get(id)?.push(n);

    // 1. IG designations / Chinese displays (null: the first load is still running — go on without, do not cache)
    const ig = await igDesignations();
    if (!ig || !ig.ok) ids.forEach((id) => failed.add(id));
    for (const id of ids) for (const n of ig?.map.get(id) ?? []) add(id, n);

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
                if (!t) continue;
                // mined pairs are noisy (type ↔ 「型開放」): a rendering whose every word also occurs in an ICD Chinese name of
                // the concept's map target / category is corroborated; otherwise it stays below ZH_CONFIDENCE_MIN-level use
                // (≤ THESAURUS_UNCORROBORATED_MAX: related evidence only, it never makes a slot comparable)
                const icdText = (out.get(id) ?? []).filter((z) => z.source.startsWith("icd_")).map((z) => z.name).join("|");
                const corroborated = t.parts.every((p) => icdText.includes(p));
                const conf = round2(0.8 * t.coverage * t.minDice);
                add(id, { name: t.zh, source: "thesaurus", confidence: corroborated ? conf : Math.min(conf, THESAURUS_UNCORROBORATED_MAX) });
              }
            }
          }
        }
      }
    }

    const result = new Map<string, ZhName[]>();
    for (const id of ids) {
      let merged = mergeZhNames(out.get(id) ?? []);
      // without the IG table an IG name that matches the record could be missing: no name may make a slot comparable
      // (confidence capped below ZH_CONFIDENCE_MIN) — this call can be "uncertain" (warning), never a new "contradicted"
      if (!ig || !ig.ok) merged = merged.map((z) => (z.confidence > PARTIAL_MAX ? { ...z, confidence: PARTIAL_MAX } : z));
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
    warm: () => startLoad().catch(() => undefined),
    clear() {
      cache.clear();
      designations = null;
    },
    stats: () => ({ cached: cache.size, queries, designations: inflight && !designations ? "loading" : !designations ? "none" : designations.ok ? "loaded" : "failed" }),
  };
}

/** `system|code` keys of SNOMED codings → concept ids. */
export function snomedIdsOf(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((k) => k.startsWith(`${SCT}|`)).map((k) => k.slice(SCT.length + 1)).filter((c) => /^\d{6,18}$/u.test(c)))];
}

// ------------------------------------------------------------------------------------------- hierarchy guard

/** A diagnosis-slot item as the hierarchy guard reads it: its text (the slot parser's lower-cased form), ICD codes, names. */
export interface SlotItemRef {
  key: string;
  icd: readonly string[];
  /** Chinese / English names of the item (text without codes, its core). */
  names: readonly string[];
}

export interface SnomedHierarchy {
  /**
   * Per SNOMED concept, the slot items whose own SNOMED concept(s) are the same concept, an ancestor or a descendant of it
   * (snomed.concept_ancestors): a broader / narrower concept, never "a different diagnosis". An item's concepts come from
   * its ICD-10 codes (reverse snomed.icd10_map: map group 1 targets equal to the code, its 4-character WHO form or its
   * category) and from its names (icd.diagnoses.name_zh equal to the name → that ICD code). A Chinese name with no exact ICD
   * name also tries its Chinese tails (Chinese compounds are head-final: 社區型肺炎 → 肺炎): a tail is a broader concept than
   * the item, so it only relates a coded concept that is the tail's concept or an ancestor of it — never a narrower one.
   */
  relatedSlotItems(conceptIds: readonly string[], items: readonly SlotItemRef[]): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
}

/**
 * WHO-style map targets for an ICD-10(-CM) code: the code, its first 5 characters (X99.9), its category, and for a
 * category its unspecified subcategory (J18 → J18.9: map targets are mostly 4-character codes).
 */
export function mapTargetsFor(code: string): string[] {
  const c = code.toUpperCase();
  return [...new Set([c, c.slice(0, 5), c.slice(0, 3), `${c.slice(0, 3)}.9`].filter((x) => RE_ICD.test(x)))];
}

export function createSnomedHierarchy(opts: { query: QueryFn; cacheSize?: number; logger?: SnomedChineseOptions["logger"] }): SnomedHierarchy {
  const cap = opts.cacheSize ?? 2000;
  const byCodes = new Map<string, string[]>(); // sorted ICD code list → SNOMED concepts
  const ancestors = new Map<string, Set<string>>();
  const run = async (sql: string, params: unknown[]): Promise<Array<Record<string, unknown>> | null> => {
    try {
      return (await opts.query(sql, params)).rows;
    } catch (e) {
      opts.logger?.warn?.("snomed hierarchy query failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
  const trim = <K, V>(m: Map<K, V>): void => {
    while (m.size > cap) m.delete(m.keys().next().value as K);
  };

  return {
    async relatedSlotItems(conceptIds, items) {
      const out = new Map<string, Set<string>>();
      const ids = [...new Set(conceptIds.filter((x) => /^\d{6,18}$/u.test(x)))];
      if (!ids.length || !items.length) return out;
      // 1. item names → ICD codes (exact Chinese ICD names)
      const names = [...new Set(items.flatMap((i) => i.names).map((n) => n.trim()).filter((n) => hasCjk(n) && n.length <= 40))];
      const tails = new Map<string, string[]>(); // name → its Chinese tails, longest first
      for (const n of names) {
        const m = /[\p{Script=Han}]+$/u.exec(n)?.[0] ?? "";
        const ts: string[] = [];
        for (let i = n.length - m.length + (m.length === n.length ? 1 : 0); i <= n.length - 2; i++) ts.push(n.slice(i));
        if (ts.length) tails.set(n, ts);
      }
      const nameCodes = new Map<string, string[]>();
      const lookup = [...new Set([...names, ...[...tails.values()].flat()])];
      if (lookup.length) {
        const rows = await run("SELECT code, name_zh FROM icd.diagnoses WHERE name_zh = ANY($1::text[])", [lookup]);
        for (const r of rows ?? []) {
          const n = String(r.name_zh);
          nameCodes.set(n, [...(nameCodes.get(n) ?? []), String(r.code)]);
        }
      }
      // the longest tail with an ICD name, for names without an exact one
      const headCodes = new Map<string, string[]>();
      for (const it of items) {
        const codes = it.names.flatMap((n) => {
          const t = n.trim();
          if (nameCodes.has(t)) return [];
          const hit = (tails.get(t) ?? []).find((x) => nameCodes.has(x));
          return hit ? nameCodes.get(hit)! : [];
        });
        if (codes.length) headCodes.set(it.key, [...new Set(codes.map((c) => c.toUpperCase()))]);
      }
      // 2. ICD codes → SNOMED concepts (reverse map)
      const itemCodes = new Map<string, string[]>();
      for (const it of items) itemCodes.set(it.key, [...new Set([...it.icd.map((c) => c.toUpperCase()), ...it.names.flatMap((n) => nameCodes.get(n.trim()) ?? [])])]);
      const conceptsOf = async (codes: readonly string[]): Promise<string[] | null> => {
        const k = [...codes].sort().join(",");
        let cs = byCodes.get(k);
        if (!cs) {
          const rows = await run(
            "SELECT DISTINCT referenced_component_id::text AS id FROM snomed.icd10_map WHERE map_target = ANY($1::text[]) AND active = TRUE AND COALESCE(map_group, 1) = 1 LIMIT 2000",
            [[...new Set(codes.flatMap(mapTargetsFor))]],
          );
          if (rows === null) return null;
          cs = rows.map((r) => String(r.id));
          byCodes.set(k, cs);
          trim(byCodes);
        }
        return cs;
      };
      const itemConcepts = new Map<string, string[]>();
      for (const [key, codes] of itemCodes) {
        if (!codes.length) continue;
        const cs = await conceptsOf(codes);
        if (cs) itemConcepts.set(key, cs);
      }
      const headConcepts = new Map<string, string[]>();
      for (const [key, codes] of headCodes) {
        const cs = await conceptsOf(codes);
        if (cs) headConcepts.set(key, cs);
      }
      if (!itemConcepts.size && !headConcepts.size) return out;
      // 3. ancestors of the codes' concepts and of the items' concepts
      const need = [...new Set([...ids, ...[...itemConcepts.values(), ...headConcepts.values()].flat()])].filter((x) => !ancestors.has(x));
      if (need.length) {
        const rows = await run("SELECT concept_id::text AS id, ancestor_ids::text[] AS anc FROM snomed.concept_ancestors WHERE concept_id = ANY($1::bigint[])", [need]);
        if (rows === null) return out;
        for (const x of need) ancestors.set(x, new Set());
        for (const r of rows) ancestors.set(String(r.id), new Set((Array.isArray(r.anc) ? r.anc : []).map(String)));
      }
      for (const x of ids) {
        const ax = ancestors.get(x) ?? new Set<string>();
        for (const [key, cs] of itemConcepts) {
          if (cs.some((c) => c === x || ax.has(c) || (ancestors.get(c)?.has(x) ?? false))) {
            if (!out.has(x)) out.set(x, new Set());
            out.get(x)!.add(key);
          }
        }
        // a tail concept is broader than its item: only the same concept or an ancestor of it is related
        for (const [key, cs] of headConcepts) {
          if (cs.some((c) => c === x || (ancestors.get(c)?.has(x) ?? false))) {
            if (!out.has(x)) out.set(x, new Set());
            out.get(x)!.add(key);
          }
        }
      }
      while (ancestors.size > cap * 10) ancestors.delete(ancestors.keys().next().value as string);
      return out;
    },
  };
}
