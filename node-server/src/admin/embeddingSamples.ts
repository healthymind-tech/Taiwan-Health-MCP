/**
 * A few stored vectors together with the exact text they were made from.
 *
 * Used to find out which model produced the vectors already in the database
 * when no identity row records it (vectors loaded before identities existed):
 * re-embed these texts with a candidate endpoint and compare. The text is
 * rebuilt the way the embed loader builds it (loaders/embeddings.ts) and is
 * only used when its sha256 equals the row's stored `source_hash` — so a
 * builder that drifted from the loader yields no sample, never a wrong one.
 */

import crypto from "crypto";

export interface StoredSample {
  table: string;
  text: string;
  vector: number[];
}

type Queryable = { query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

const join = (parts: unknown[]): string => parts.filter((v) => v != null && v !== "").map(String).join(" ");
const sha256 = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");

/** Per table: rows of (candidate text parts…, h = source_hash, v = vector text). Several rows per key are fine. */
const SPECS: { table: string; sql: string; text: (r: Record<string, unknown>) => string }[] = [
  {
    table: "icd.diagnosis_embeddings",
    sql: `SELECT d.code, d.name_zh, d.name_en, e.source_hash AS h, e.embedding::text AS v
            FROM (SELECT * FROM icd.diagnosis_embeddings WHERE source_hash IS NOT NULL LIMIT $1) e
            JOIN icd.diagnoses d ON d.code = e.code`,
    text: (r) => join([r.code, r.name_zh, r.name_en]),
  },
  {
    table: "loinc.concept_embeddings",
    sql: `SELECT c.long_common_name, c.shortname, c.name_zh, c.common_name_zh, c.component, c.specimen_type, e.source_hash AS h, e.embedding::text AS v
            FROM (SELECT * FROM loinc.concept_embeddings WHERE source_hash IS NOT NULL LIMIT $1) e
            JOIN loinc.concepts c ON c.loinc_num = e.loinc_num`,
    text: (r) => join([r.long_common_name, r.shortname, r.name_zh, r.common_name_zh, r.component, r.specimen_type]),
  },
  {
    table: "snomed.concept_embeddings",
    sql: `SELECT d.term, e.source_hash AS h, e.embedding::text AS v
            FROM (SELECT * FROM snomed.concept_embeddings WHERE source_hash IS NOT NULL LIMIT $1) e
            JOIN snomed.descriptions d ON d.concept_id = e.concept_id AND d.active = TRUE AND d.type_id = '900000000000003001'`,
    text: (r) => String(r.term ?? ""),
  },
  {
    table: "fhir.concept_embeddings",
    sql: `SELECT t.term, e.source_hash AS h, e.embedding::text AS v
            FROM (SELECT * FROM fhir.concept_embeddings WHERE source_hash IS NOT NULL LIMIT $1) e
            JOIN LATERAL (SELECT term FROM fhir.concept_index_terms WHERE text_hash = e.text_hash LIMIT 1) t ON TRUE`,
    text: (r) => String(r.term ?? ""),
  },
  {
    table: "health_supplements.item_embeddings",
    sql: `SELECT i.name, i.benefit_claims, e.source_hash AS h, e.embedding::text AS v
            FROM (SELECT * FROM health_supplements.item_embeddings WHERE source_hash IS NOT NULL LIMIT $1) e
            JOIN health_supplements.items i ON i.permit_no = e.permit_no`,
    text: (r) => join([r.name, r.benefit_claims]),
  },
  {
    table: "food_nutrition.food_embeddings",
    sql: `SELECT m.sample_name, m.common_name, m.english_name, e.source_hash AS h, e.embedding::text AS v
            FROM (SELECT * FROM food_nutrition.food_embeddings WHERE source_hash IS NOT NULL LIMIT $1) e
            JOIN food_nutrition.measurements m ON m.sample_name = e.sample_name`,
    text: (r) => join([r.sample_name, r.common_name, r.english_name]),
  },
  {
    table: "food_nutrition.ingredient_embeddings",
    sql: `SELECT i.name_zh, i.name_en, e.source_hash AS h, e.embedding::text AS v
            FROM (SELECT * FROM food_nutrition.ingredient_embeddings WHERE source_hash IS NOT NULL LIMIT $1) e
            JOIN food_nutrition.ingredients i ON i.id = e.id`,
    text: (r) => join([r.name_zh, r.name_en]),
  },
];

function parseVector(v: unknown): number[] | null {
  if (typeof v !== "string") return Array.isArray(v) ? (v as number[]) : null;
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === "number") ? (arr as number[]) : null;
  } catch {
    return null;
  }
}

/** Up to `max` verified (text, vector) pairs, spread over the tables that have rows. */
export async function sampleStoredVectors(db: Queryable, max = 4): Promise<StoredSample[]> {
  const out: StoredSample[] = [];
  for (const spec of SPECS) {
    if (out.length >= max) break;
    let rows: Record<string, unknown>[];
    try {
      rows = (await db.query<Record<string, unknown>>(spec.sql, [Math.max(2, max)])).rows;
    } catch {
      continue; // table / source missing on this install
    }
    const seen = new Set<string>();
    for (const r of rows) {
      if (out.length >= max) break;
      const h = String(r.h ?? "");
      if (!h || seen.has(h)) continue;
      const text = spec.text(r);
      if (!text || sha256(text) !== h) continue;
      const vector = parseVector(r.v);
      if (!vector) continue;
      seen.add(h);
      out.push({ table: spec.table, text, vector });
      // Two per table at most: spread the evidence over modules.
      if (out.filter((s) => s.table === spec.table).length >= 2) break;
    }
  }
  return out;
}
