/**
 * The size of the pgvector (halfvec) columns that hold embeddings.
 *
 * Every *_embeddings table stores vectors of one fixed size. Changing the
 * system's embedding model to one with another size means the columns must be
 * re-typed; that is only safe on empty tables (DROP + ADD loses the data), so
 * the model switch does it right after its TRUNCATE, in the same transaction.
 * The embed loader calls the same function before every run as a safety net.
 */

import { logInfo, logWarning } from "../logger.js";

/** pgvector halfvec HNSW limit. */
export const HNSW_MAX_DIMS = 4000;

/** All (schema, table, column) triples that hold embedding vectors. */
export const EMBEDDING_COLUMNS: [string, string, string][] = [
  ["icd", "diagnosis_embeddings", "embedding"],
  ["health_supplements", "item_embeddings", "embedding"],
  ["food_nutrition", "food_embeddings", "embedding"],
  ["food_nutrition", "ingredient_embeddings", "embedding"],
  ["loinc", "concept_embeddings", "embedding"],
  ["snomed", "concept_embeddings", "embedding"],
  ["fhir", "concept_embeddings", "embedding"],
];

/**
 * Tables searched only by exact scan scoped to a subset (one CodeSystem): an HNSW
 * index would let the planner answer ORDER BY … LIMIT globally and lose the scope.
 */
export const NO_HNSW = new Set(["fhir.concept_embeddings"]);

type Queryable = { query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

/** Current declared size of each embedding column (tables that do not exist are left out). */
export async function embeddingColumnDims(db: Queryable): Promise<{ table: string; dims: number }[]> {
  const out: { table: string; dims: number }[] = [];
  for (const [schema, table, col] of EMBEDDING_COLUMNS) {
    const r = await db.query<{ atttypmod: number }>(
      `SELECT pa.atttypmod FROM pg_attribute pa
         JOIN pg_class pc ON pc.oid = pa.attrelid
         JOIN pg_namespace pn ON pn.oid = pc.relnamespace
        WHERE pn.nspname = $1 AND pc.relname = $2 AND pa.attname = $3
          AND pa.attnum > 0 AND NOT pa.attisdropped`,
      [schema, table, col],
    );
    if (r.rows.length) out.push({ table: `${schema}.${table}`, dims: Number(r.rows[0].atttypmod) });
  }
  return out;
}

/**
 * Re-type every embedding column whose size differs from `dims`. Destroys the
 * vectors of a re-typed column — call it only when they are already gone (model
 * switch) or of the wrong size anyway. Returns the tables that changed.
 */
export async function alterEmbeddingColumns(db: Queryable, dims: number): Promise<{ table: string; from: number; to: number }[]> {
  const changed: { table: string; from: number; to: number }[] = [];
  if (dims > HNSW_MAX_DIMS) logWarning(`${dims}d > ${HNSW_MAX_DIMS} halfvec HNSW limit — index skipped (exact scan)`);
  for (const { table: fqt, dims: current } of await embeddingColumnDims(db)) {
    if (current === dims) continue;
    const [schema, table] = fqt.split(".");
    logInfo(`  ${fqt}.embedding: ${current}d → ${dims}d (ALTER TABLE)`);
    await db.query(`ALTER TABLE ${fqt} DROP COLUMN IF EXISTS embedding CASCADE`);
    await db.query(`ALTER TABLE ${fqt} ADD COLUMN embedding halfvec(${dims})`);
    if (dims <= HNSW_MAX_DIMS && !NO_HNSW.has(fqt)) {
      const idx = `idx_${schema.slice(0, 2)}_${table.slice(0, 6)}_emb_hnsw`;
      await db.query(`CREATE INDEX IF NOT EXISTS ${idx} ON ${fqt} USING hnsw (embedding halfvec_cosine_ops)`);
    }
    changed.push({ table: fqt, from: current, to: dims });
  }
  return changed;
}
