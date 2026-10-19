/**
 * Startup cache prewarm for the SNOMED CT search path.
 *
 * On spinning disks a cold SNOMED HNSW index (~3 GB) turns the first
 * `search_snomed_concept` calls into multi-second reads. Postgres' autoprewarm
 * (shared_preload_libraries = pg_prewarm, see compose.yaml) restores the buffer
 * cache after a database restart; this covers the cases autoprewarm cannot —
 * a fresh database, a dump file written before SNOMED was searched, or buffers
 * evicted by a large import — by loading the search relations explicitly when
 * the worker starts. Fail-open: a missing extension or relation only logs.
 */
import type pg from "pg";
import { logInfo, logWarning } from "../logger.js";

/** Relations read by `search_snomed_concept` (hybrid + hierarchy_filter), most important first. */
export const SNOMED_PREWARM_RELATIONS = [
  "snomed.idx_sn_concep_emb_hnsw",
  "snomed.concept_embeddings_pkey",
  "snomed.idx_snomed_desc_fts",
  "snomed.idx_snomed_desc_concept",
  "snomed.concepts_pkey",
  "snomed.concept_ancestors",
  "snomed.concept_ancestors_pkey",
  "snomed.idx_snomed_rel_dest",
] as const;

export interface PrewarmResult {
  relation: string;
  blocks: number | null;
  ms: number;
  skipped?: "missing";
  error?: string;
}

type Queryable = Pick<pg.PoolClient, "query">;

/**
 * Load each relation into shared buffers (`pg_prewarm(..., 'buffer')`).
 * Returns null when the pg_prewarm extension is not installed.
 */
export async function prewarmRelations(
  client: Queryable,
  relations: readonly string[] = SNOMED_PREWARM_RELATIONS,
): Promise<PrewarmResult[] | null> {
  const ext = await client.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_prewarm') AS ok");
  if (!ext.rows[0]?.ok) return null;
  const out: PrewarmResult[] = [];
  for (const relation of relations) {
    const started = Date.now();
    try {
      const exists = await client.query<{ oid: string | null }>("SELECT to_regclass($1)::text AS oid", [relation]);
      if (!exists.rows[0]?.oid) {
        out.push({ relation, blocks: null, ms: 0, skipped: "missing" });
        continue;
      }
      const r = await client.query<{ blocks: string }>("SELECT pg_prewarm($1::regclass, 'buffer') AS blocks", [relation]);
      out.push({ relation, blocks: Number(r.rows[0]?.blocks ?? 0), ms: Date.now() - started });
    } catch (err) {
      out.push({ relation, blocks: null, ms: Date.now() - started, error: String((err as Error).message) });
    }
  }
  return out;
}

/** Background prewarm on worker startup; never throws. */
export async function prewarmSnomedOnStartup(pool: pg.Pool): Promise<void> {
  const started = Date.now();
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    // One transaction so SET LOCAL survives pgBouncer transaction pooling; HDD reads of the
    // HNSW index can take minutes and must not hit a statement timeout.
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");
    const results = await prewarmRelations(client);
    await client.query("COMMIT");
    if (results === null) {
      logWarning("SNOMED prewarm skipped: pg_prewarm extension not installed (apply db/migrations/20261029_pg_prewarm.sql)");
      return;
    }
    const loaded = results.filter((r) => r.blocks !== null);
    logInfo("SNOMED search cache prewarmed", {
      duration_ms: Date.now() - started,
      relations: loaded.length,
      mb: Math.round((loaded.reduce((a, r) => a + (r.blocks ?? 0), 0) * 8) / 1024),
      missing: results.filter((r) => r.skipped).map((r) => r.relation),
      errors: results.filter((r) => r.error).map((r) => `${r.relation}: ${r.error}`),
    });
  } catch (err) {
    try {
      await client?.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    logWarning("SNOMED prewarm failed (non-fatal)", { error: String((err as Error).message) });
  } finally {
    client?.release();
  }
}
