/**
 * Hybrid candidate retrieval + ranking for ICD-10-CM, LOINC and SNOMED CT.
 *
 * Shared by the module search tools (search_medical_codes, search_loinc,
 * search_snomed_concept) and the matching branches of fhir_normalize_code, so the
 * same query ranks the same way everywhere. Each function:
 *   1. builds a candidate pool = full-text matches (shortest names first — the ones
 *      a short query most likely *is*) ∪ the nearest vectors;
 *   2. fetches every pooled candidate's names, its cosine similarity to the query
 *      vector, and its prior signals in one round trip;
 *   3. orders the pool with hybridRank.ts (score-aware fusion + semantic guard).
 *
 * `vecStr` null = keyword-only (no embedding): the pool is the full-text half and
 * the order is lexical.
 */

import type pg from "pg";
import { query, withTransaction } from "./db.js";
import { rankHybrid, type RankCandidate, type RankedCandidate } from "./hybridRank.js";
import { queryNameKeys } from "./loincComponentNames.js";

/** Lexical and vector halves of the candidate pool (each). */
const POOL = 40;

type Q = typeof query;

/**
 * HNSW search breadth for the vector half of the pool. Measured on the 2,560-dim
 * Qwen3-Embedding-4B ICD-10-CM vectors (133 queries): ef_search 40 (pgvector's default)
 * recalls 93% of the exact top-40, 200 recalls 99% at ~45 ms, where the exact scan the ICD
 * search used to force ("+ 0") took ~650 ms warm (1.3 s p50 in production).
 */
export const HNSW_EF_SEARCH = 200;

/**
 * Run a pool query with a wider HNSW search (and iterative scans, so a filtered vector
 * search — SNOMED hierarchy / ValueSet scope — still fills its LIMIT). SET LOCAL needs a
 * transaction (pgBouncer transaction mode keeps it on one server connection).
 */
const vectorQuery: Q = async <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> =>
  withTransaction(async (c) => {
    await c.query(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);
    await c.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
    return c.query<T>(sql, params as never[]);
  });

// ── ICD-10-CM diagnoses ──────────────────────────────────────────────────────

export interface IcdRow {
  code: string;
  name_zh: string | null;
  name_en: string | null;
}

/**
 * Prior for an ICD-10-CM code: a little less per character below the 3-character
 * category, so a short query prefers I50 / I50.9 over I50.813 when both match.
 */
/** Text that could be (the start of) an ICD-10-CM code: "I50", "e11.9", "S93.40". */
const ICD_CODE_LIKE = /^[A-Za-z]\d[0-9A-Za-z]?(\.[0-9A-Za-z]{0,4})?$/;
/** Text that could be (part of) a LOINC number: "718", "718-7", "2345-". */
const LOINC_CODE_LIKE = /^\d{1,6}(-\d?)?$/;

export function icdDepthPrior(code: string): number {
  const depth = Math.max(0, code.replace(".", "").length - 3);
  return depth === 0 ? 0 : -0.02 * depth;
}

export async function rankIcdDiagnoses(
  keyword: string,
  vecStr: string | null,
  limit: number,
  q: Q = query,
): Promise<{ rows: IcdRow[]; ranked: RankedCandidate[] }> {
  // The full-text expression must match idx_icd_diag_fts exactly (COALESCE on code too).
  const fts =
    "to_tsvector('simple', COALESCE(code,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,'')) " +
    "@@ plainto_tsquery('simple', $1)";
  // The code-prefix branch only for code-like text: an OR with ILIKE keeps the planner off
  // the full-text GIN index (a 98k-row to_tsvector scan, ~0.7 s, for every query).
  const codeLike = ICD_CODE_LIKE.test(keyword.trim());
  const lex = `SELECT code FROM icd.diagnoses WHERE ${fts}${codeLike ? " OR code ILIKE $2" : " AND $2::text IS NOT NULL"}
               ORDER BY length(COALESCE(name_en, name_zh, code)), code LIMIT ${POOL}`;
  const r = vecStr
    ? await (q === query ? vectorQuery : q)<IcdRow & { sim: number | null }>(
        `WITH lex AS (${lex}),
         vec AS (SELECT code FROM icd.diagnosis_embeddings ORDER BY embedding <=> $3::halfvec LIMIT ${POOL}),
         pool AS (SELECT code FROM lex UNION SELECT code FROM vec)
         SELECT d.code, d.name_zh, d.name_en, 1 - (e.embedding <=> $3::halfvec) AS sim
           FROM pool JOIN icd.diagnoses d ON d.code = pool.code
           LEFT JOIN icd.diagnosis_embeddings e ON e.code = pool.code`,
        [keyword, `${keyword}%`, vecStr],
      )
    : await q<IcdRow & { sim: number | null }>(
        `WITH lex AS (${lex}) SELECT d.code, d.name_zh, d.name_en, NULL::float8 AS sim FROM lex JOIN icd.diagnoses d ON d.code = lex.code`,
        [keyword, `${keyword}%`],
      );
  const byCode = new Map(r.rows.map((x) => [x.code, x]));
  const cands: RankCandidate[] = r.rows.map((x) => ({
    key: x.code,
    texts: [{ text: x.name_en }, { text: x.name_zh }, { text: x.code, weight: 1 }],
    sim: x.sim === null || x.sim === undefined ? null : Number(x.sim),
    prior: icdDepthPrior(x.code),
  }));
  const ranked = rankHybrid(keyword, cands, limit);
  return { rows: ranked.map((k) => { const x = byCode.get(k.key)!; return { code: x.code, name_zh: x.name_zh, name_en: x.name_en }; }), ranked };
}

// ── LOINC ────────────────────────────────────────────────────────────────────

/** Columns returned by search_loinc (shape kept). */
export const LOINC_COLS = [
  "loinc_num", "long_common_name", "shortname", "name_zh", "common_name_zh",
  "component", "property", "time_aspect", "system", "scale_type", "method_type",
  "class", "classtype", "specimen_type", "unit", "status",
];

// Must match idx_loinc_fts.
export const LOINC_FTS_VECTOR =
  "to_tsvector('simple', " +
  "COALESCE(loinc_num,'') || ' ' || COALESCE(long_common_name,'') || ' ' || " +
  "COALESCE(shortname,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(common_name_zh,''))";

let rankColumns: { at: number; present: boolean } | null = null;
let namesTable: { at: number; present: boolean } | null = null;

/** loinc.component_names exists (migration 20261025)? Cached; false on error. */
async function hasComponentNames(q: Q): Promise<boolean> {
  if (namesTable && Date.now() - namesTable.at < 300_000) return namesTable.present;
  let present = false;
  try {
    present = (await q("SELECT to_regclass('loinc.component_names') IS NOT NULL AS ok")).rows[0]?.ok === true;
  } catch {
    present = false;
  }
  namesTable = { at: Date.now(), present };
  return present;
}

/** Analyte synonyms (loinc.component_names) named in the query: component → matched names. */
async function componentSynonyms(keyword: string, q: Q): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!(await hasComponentNames(q))) return out;
  const keys = queryNameKeys(keyword);
  if (!keys.length) return out;
  try {
    const r = await q<{ component: string; name: string }>(
      `SELECT component, name FROM loinc.component_names WHERE name_key = ANY($1::text[])
        ORDER BY length(name_key) DESC, component LIMIT ${SYNONYM_COMPONENTS}`,
      [keys],
    );
    for (const x of r.rows) out.set(x.component, [...(out.get(x.component) ?? []), x.name]);
  } catch {
    /* table not migrated / unreadable: rank without synonyms */
  }
  return out;
}

/** loinc.concepts.common_test_rank exists (migration 20261024)? Cached; false on error. */
async function hasLoincRanks(q: Q): Promise<boolean> {
  if (rankColumns && Date.now() - rankColumns.at < 300_000) return rankColumns.present;
  let present = false;
  try {
    present =
      (
        await q(
          "SELECT 1 FROM information_schema.columns WHERE table_schema = 'loinc' AND table_name = 'concepts' AND column_name = 'common_test_rank'",
        )
      ).rows.length > 0;
  } catch {
    present = false;
  }
  rankColumns = { at: Date.now(), present };
  return present;
}

/** Weight of the usage-rank prior (one object so evaluation harnesses can sweep it). */
export const LOINC_PRIOR = { rankWeight: 0.3 };

/**
 * Prior for a LOINC term: Regenstrief's COMMON_TEST_RANK (1 = most commonly
 * resulted test in their usage data; null = not ranked) and the term status.
 */

export function loincPrior(rank: number | null | undefined, status: string | null | undefined): number {
  let p = 0;
  const r = Number(rank);
  if (Number.isFinite(r) && r > 0) p += LOINC_PRIOR.rankWeight * Math.max(0, 1 - Math.log10(r) / 4.5);
  const s = String(status ?? "").toUpperCase();
  if (s === "DEPRECATED") p -= 0.2;
  else if (s === "DISCOURAGED") p -= 0.05;
  else if (s === "TRIAL") p -= 0.02;
  return p;
}

/** Penalties (one object so evaluation harnesses can sweep them). */
export const LOINC_SHAPE = { panel: 0.1, ratio: 0.08 };

/**
 * A panel or a ratio of two analytes is rarely what a test name means: it sinks a little
 * unless the query asks for one ("panel", "profile", "ratio", "/", 比值 …).
 */
export function loincShapePrior(query: string, x: { long_common_name?: unknown; component?: unknown }): number {
  const q = query.toLowerCase();
  let p = 0;
  if (/\bpanel\b/i.test(String(x.long_common_name ?? "")) && !/panel|profile|battery|組套|套組|組合/.test(q)) p -= LOINC_SHAPE.panel;
  if (String(x.component ?? "").includes("/") && !/\/|ratio|index|比/.test(q)) p -= LOINC_SHAPE.ratio;
  return p;
}

/** Most common terms of each pooled analyte added to the pool. */
const FAMILY_DEFAULTS = 2;
/** At most this many analytes found through their synonyms. */
const SYNONYM_COMPONENTS = 30;

/**
 * Family of a LOINC term: its analyte without challenge / timing suffixes ("Glucose^post
 * CFst" → glucose), split where the property makes it a different measurement: per-cell
 * (entitic: MCH / MCHC are component Hemoglobin too) and fractions (HbA1c %).
 */
export function loincFamily(component: unknown, property?: unknown): string | null {
  const c = String(component ?? "").split("^")[0].trim().toLowerCase();
  if (!c) return null;
  const prop = String(property ?? "");
  const kind = /^Ent/i.test(prop) ? "|ent" : /Fr$/i.test(prop) ? "|fr" : "";
  return `loinc:${c}${kind}`;
}

/**
 * How much a LOINC term is its analyte's default reading: Regenstrief's COMMON_TEST_RANK
 * first (every ranked term beats every unranked one), then — among unranked terms — no
 * method and a point-in-time measurement. Deprecated / discouraged terms sink.
 */
export function loincDefaultness(x: { common_test_rank?: unknown; status?: unknown; method_type?: unknown; time_aspect?: unknown }): number {
  const r = Number(x.common_test_rank);
  let d = Number.isFinite(r) && r > 0 ? 1 - Math.log10(r) / 5 : 0;
  if (!(Number.isFinite(r) && r > 0)) {
    if (x.method_type) d -= 0.05;
    if (x.time_aspect && String(x.time_aspect) !== "Pt") d -= 0.05;
  }
  const s = String(x.status ?? "").toUpperCase();
  if (s === "DEPRECATED") d -= 2;
  else if (s === "DISCOURAGED") d -= 1;
  return d;
}

export async function rankLoinc(
  keyword: string,
  vecStr: string | null,
  limit: number,
  category: string | null = null,
  q: Q = query,
): Promise<{ rows: Record<string, unknown>[]; ranked: RankedCandidate[] }> {
  const ranks = await hasLoincRanks(q);
  const rankCol = ranks ? "c.common_test_rank" : "NULL::int";
  const synonyms = await componentSynonyms(keyword, q);
  const params: unknown[] = [keyword, `%${keyword}%`];
  const synIdx = params.push([...synonyms.keys()]);
  const catSql = category ? `AND c.class ILIKE $${params.push(`%${category}%`)}` : "";
  let vecIdx = 0;
  if (vecStr) vecIdx = params.push(vecStr);
  const lex = `SELECT loinc_num FROM loinc.concepts c
               WHERE (${LOINC_FTS_VECTOR} @@ plainto_tsquery('simple', $1)${LOINC_CODE_LIKE.test(keyword.trim()) ? " OR loinc_num ILIKE $2" : " AND $2::text IS NOT NULL"}) ${catSql}
               ORDER BY ${ranks ? "c.common_test_rank IS NULL, c.common_test_rank," : ""} length(long_common_name), loinc_num
               LIMIT ${POOL}`;
  const cols = LOINC_COLS.map((c) => `c.${c}`).join(", ");
  // Family defaults: for every analyte (component) in the pool, its most commonly resulted
  // terms join the pool, so a generic query can land on the default term of the analyte
  // even when neither half retrieved it (orderFamilies in hybridRank.ts picks it).
  // Analytes the query names by a synonym ("uric acid" → Urate) join the same way.
  // Needs idx_loinc_concepts_component (migration 20261025, with loinc.component_names): without
  // it the lookup is a sequential scan, so a database not migrated yet skips the expansion.
  const famOk = await hasComponentNames(q);
  const fam = (from: string): string =>
    !famOk
      ? `fam AS (SELECT NULL::text AS loinc_num WHERE $${synIdx}::text[] IS NOT NULL AND FALSE),`
      : `fam AS (SELECT loinc_num FROM (
               SELECT f.loinc_num, row_number() OVER (
                        PARTITION BY f.component
                        ORDER BY ${ranks ? "f.common_test_rank IS NULL, f.common_test_rank," : ""} (f.status = 'ACTIVE') DESC, length(f.long_common_name), f.loinc_num) AS rn
                 FROM loinc.concepts f
                WHERE f.component IN (SELECT p.component FROM ${from} JOIN loinc.concepts p ON p.loinc_num = ${from}.loinc_num
                                      UNION SELECT unnest($${synIdx}::text[]))) x
             WHERE rn <= ${FAMILY_DEFAULTS}),`;
  const sql = vecStr
    ? `WITH lex AS (${lex}),
       vec AS (SELECT loinc_num FROM loinc.concept_embeddings ORDER BY embedding <=> $${vecIdx}::halfvec LIMIT ${POOL}),
       pool0 AS (SELECT loinc_num FROM lex UNION SELECT loinc_num FROM vec),
       ${fam("pool0")}
       pool AS (SELECT loinc_num FROM pool0 UNION SELECT loinc_num FROM fam)
       SELECT ${cols}, c.consumer_name, ${rankCol} AS common_test_rank, 1 - (e.embedding <=> $${vecIdx}::halfvec) AS sim
         FROM pool JOIN loinc.concepts c ON c.loinc_num = pool.loinc_num
         LEFT JOIN loinc.concept_embeddings e ON e.loinc_num = pool.loinc_num
        WHERE TRUE ${catSql}`
    : `WITH lex AS (${lex}),
       ${fam("lex")}
       pool AS (SELECT loinc_num FROM lex UNION SELECT loinc_num FROM fam)
       SELECT ${cols}, c.consumer_name, ${rankCol} AS common_test_rank, NULL::float8 AS sim
         FROM pool JOIN loinc.concepts c ON c.loinc_num = pool.loinc_num
        WHERE TRUE ${catSql}`;
  const r = await (vecStr && q === query ? vectorQuery : q)<Record<string, unknown>>(sql, params);
  const byNum = new Map(r.rows.map((x) => [String(x.loinc_num), x]));
  const cands: RankCandidate[] = r.rows.map((x) => ({
    key: String(x.loinc_num),
    texts: [
      ...(synonyms.get(String(x.component)) ?? []).map((t) => ({ text: t, weight: 0.9 })),
      { text: x.long_common_name as string, weight: 1 },
      { text: x.shortname as string, weight: 0.9 },
      // Both names together: a query mixing a long-name word and a short-name abbreviation
      // ("CSF protein": "Protein … in Cerebral spinal fluid" + "Prot CSF-mCnc").
      { text: x.shortname ? `${x.long_common_name} ${x.shortname}` : null, weight: 0.9 },
      { text: x.component as string, weight: 0.85 },
      { text: x.consumer_name as string, weight: 0.9 },
      { text: x.name_zh as string, weight: 1 },
      { text: x.common_name_zh as string, weight: 0.95 },
      { text: x.loinc_num as string, weight: 1 },
    ],
    sim: x.sim === null || x.sim === undefined ? null : Number(x.sim),
    prior: loincPrior(x.common_test_rank as number | null, x.status as string | null) + loincShapePrior(keyword, x),
    family: loincFamily(x.component, x.property),
    defaultness: loincDefaultness(x),
  }));
  const ranked = rankHybrid(keyword, cands, limit);
  const rows = ranked.map((k) => {
    const x = byNum.get(k.key)!;
    const out: Record<string, unknown> = {};
    for (const c of LOINC_COLS) out[c] = x[c];
    return out;
  });
  return { rows, ranked };
}

// ── SNOMED CT ────────────────────────────────────────────────────────────────

export const SNOMED_FSN_TYPE = "900000000000003001";
export const SNOMED_IS_A = "116680003";

/** "Myocardial infarction (disorder)" → "Myocardial infarction". */
export function stripSemanticTag(fsn: string): string {
  return fsn.replace(/\s*\([^()]+\)\s*$/, "").trim();
}

/** Prior for a SNOMED concept: inactive concepts sink; longer (more specific) names lose a little. */
export function snomedPrior(active: boolean, fsnCore: string | null): number {
  let p = active ? 0 : -0.3;
  if (fsnCore) {
    const words = fsnCore.split(/\s+/).filter(Boolean).length;
    p -= Math.min(0.06, 0.01 * Math.max(0, words - 2));
  }
  return p;
}

export interface SnomedRanked {
  concept_id: string;
  active: boolean;
  fsn: string | null;
  preferred: string | null;
  ranked: RankedCandidate;
}

/**
 * `scope`: restrict to these concept ids (a ValueSet's is-a expansion);
 * `hierarchy`: restrict to the descendants-or-self of this concept.
 */
export async function rankSnomed(
  text: string,
  vecStr: string | null,
  limit: number,
  opts: { scope?: (string | number)[] | null; hierarchy?: string | number | null } = {},
  q: Q = query,
): Promise<SnomedRanked[]> {
  const params: unknown[] = [text];
  let ctes = "";
  let restrictD = "";
  let restrictE = "";
  if (opts.hierarchy) {
    const h = params.push(String(opts.hierarchy));
    const isa = params.push(SNOMED_IS_A);
    ctes = `descendants AS (
              SELECT concept_id FROM snomed.concepts WHERE concept_id = $${h}::bigint
              UNION
              SELECT r.source_id FROM snomed.relationships r JOIN descendants d ON r.destination_id = d.concept_id
               WHERE r.type_id = $${isa}::bigint AND r.active = TRUE
            ),`;
    restrictD = "AND d.concept_id IN (SELECT concept_id FROM descendants)";
    restrictE = "WHERE e.concept_id IN (SELECT concept_id FROM descendants)";
  } else if (opts.scope && opts.scope.length) {
    const s = params.push(opts.scope.map(String));
    restrictD = `AND d.concept_id = ANY($${s}::bigint[])`;
    restrictE = `WHERE e.concept_id = ANY($${s}::bigint[])`;
  }
  // Full text over active descriptions (expression matches idx_snomed_desc_fts); per
  // concept its shortest matching description, shortest first.
  const lex = `SELECT d.concept_id FROM snomed.descriptions d
                WHERE d.active = TRUE AND to_tsvector('english', COALESCE(d.term,'')) @@ plainto_tsquery('english', $1) ${restrictD}
                GROUP BY d.concept_id ORDER BY min(length(d.term)), d.concept_id LIMIT ${POOL}`;
  let sql: string;
  if (vecStr) {
    const v = params.push(vecStr);
    sql = `WITH RECURSIVE ${ctes}
           lex AS (${lex}),
           vec AS (SELECT e.concept_id FROM snomed.concept_embeddings e ${restrictE} ORDER BY e.embedding <=> $${v}::halfvec LIMIT ${POOL}),
           pool AS (SELECT concept_id FROM lex UNION SELECT concept_id FROM vec)
           SELECT pool.concept_id::text AS concept_id, c.active, 1 - (e.embedding <=> $${v}::halfvec) AS sim
             FROM pool JOIN snomed.concepts c ON c.concept_id = pool.concept_id
             LEFT JOIN snomed.concept_embeddings e ON e.concept_id = pool.concept_id`;
  } else {
    sql = `WITH RECURSIVE ${ctes} lex AS (${lex})
           SELECT lex.concept_id::text AS concept_id, c.active, NULL::float8 AS sim
             FROM lex JOIN snomed.concepts c ON c.concept_id = lex.concept_id`;
  }
  const pool = (await (vecStr && q === query ? vectorQuery : q)<{ concept_id: string; active: boolean; sim: number | null }>(sql, params)).rows;
  if (!pool.length) return [];
  const desc = (
    await q<{ concept_id: string; type_id: string; term: string; us_preferred: boolean | null }>(
      `SELECT concept_id::text AS concept_id, type_id::text AS type_id, term, us_preferred
         FROM snomed.descriptions WHERE concept_id = ANY($1::bigint[]) AND active = TRUE`,
      [pool.map((p) => p.concept_id)],
    )
  ).rows;
  const fsn = new Map<string, string>();
  const preferred = new Map<string, string>();
  const synonyms = new Map<string, string[]>();
  for (const d of desc) {
    if (d.type_id === SNOMED_FSN_TYPE) fsn.set(d.concept_id, d.term);
    else {
      if (!synonyms.has(d.concept_id)) synonyms.set(d.concept_id, []);
      synonyms.get(d.concept_id)!.push(d.term);
      if (d.us_preferred) preferred.set(d.concept_id, d.term);
    }
  }
  const info = new Map(pool.map((p) => [p.concept_id, p]));
  const cands: RankCandidate[] = pool.map((p) => {
    const f = fsn.get(p.concept_id) ?? null;
    const core = f ? stripSemanticTag(f) : null;
    return {
      key: p.concept_id,
      texts: [{ text: core, weight: 1 }, ...(synonyms.get(p.concept_id) ?? []).map((t) => ({ text: t, weight: t === preferred.get(p.concept_id) ? 1 : 0.95 }))],
      sim: p.sim === null || p.sim === undefined ? null : Number(p.sim),
      prior: snomedPrior(p.active, core),
    };
  });
  return rankHybrid(text, cands, limit).map((r) => ({
    concept_id: r.key,
    active: info.get(r.key)!.active,
    fsn: fsn.get(r.key) ?? null,
    preferred: preferred.get(r.key) ?? synonyms.get(r.key)?.[0] ?? fsn.get(r.key) ?? null,
    ranked: r,
  }));
}
