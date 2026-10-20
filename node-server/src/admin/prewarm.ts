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
import { isDbDownError } from "../dbHealth.js";

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
  // Heaps read per search (term text, hierarchy CTE, vector rows) — small next to the index.
  "snomed.descriptions",
  "snomed.concepts",
  "snomed.relationships",
  "snomed.concept_embeddings",
] as const;

/**
 * Relations only pulled into the OS page cache (`'prefetch'`): the TOAST of the embedding
 * table (~2 GB of out-of-line vectors, read when candidates are re-scored) would crowd
 * shared buffers. `toast:` resolves the table's TOAST relation.
 */
export const SNOMED_PREFETCH_RELATIONS = ["toast:snomed.concept_embeddings"] as const;

export interface PrewarmResult {
  relation: string;
  blocks: number | null;
  ms: number;
  skipped?: "missing";
  error?: string;
}

type Queryable = Pick<pg.PoolClient, "query">;

/**
 * Load each relation with `pg_prewarm(rel, mode)` — `'buffer'` = shared buffers, `'prefetch'` = OS page cache.
 * Returns null when the pg_prewarm extension is not installed.
 */
export async function prewarmRelations(
  client: Queryable,
  relations: readonly string[] = SNOMED_PREWARM_RELATIONS,
  mode: "buffer" | "prefetch" = "buffer",
): Promise<PrewarmResult[] | null> {
  const ext = await client.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_prewarm') AS ok");
  if (!ext.rows[0]?.ok) return null;
  const out: PrewarmResult[] = [];
  for (const relation of relations) {
    const started = Date.now();
    try {
      const toast = relation.startsWith("toast:");
      const name = toast ? relation.slice("toast:".length) : relation;
      const exists = await client.query<{ oid: string | null }>(
        toast
          ? "SELECT NULLIF(reltoastrelid, 0)::regclass::text AS oid FROM pg_class WHERE oid = to_regclass($1)"
          : "SELECT to_regclass($1)::text AS oid",
        [name],
      );
      const target = exists.rows[0]?.oid;
      if (!target) {
        out.push({ relation, blocks: null, ms: 0, skipped: "missing" });
        continue;
      }
      const r = await client.query<{ blocks: string }>("SELECT pg_prewarm($1::regclass, $2) AS blocks", [target, mode]);
      out.push({ relation, blocks: Number(r.rows[0]?.blocks ?? 0), ms: Date.now() - started });
    } catch (err) {
      out.push({ relation, blocks: null, ms: Date.now() - started, error: String((err as Error).message) });
    }
  }
  return out;
}

/**
 * Background prewarm on worker startup; never throws. While the database is still coming up
 * (worker started during a Postgres restart) it retries every 30 s for up to 15 minutes.
 */
export async function prewarmSnomedOnStartup(pool: pg.Pool): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const outcome = await prewarmSnomedOnce(pool);
    if (outcome !== "db_down") return;
    if (attempt === 1) logWarning("SNOMED prewarm deferred: database unavailable, retrying every 30 s");
    await new Promise((r) => setTimeout(r, 30_000));
  }
  logWarning("SNOMED prewarm given up: database stayed unavailable for 15 minutes");
}

async function prewarmSnomedOnce(pool: pg.Pool): Promise<"done" | "db_down"> {
  const started = Date.now();
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    // One transaction so SET LOCAL survives pgBouncer transaction pooling; HDD reads of the
    // HNSW index can take minutes and must not hit a statement timeout.
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");
    const buffered = await prewarmRelations(client);
    const results = buffered === null ? null : [...buffered, ...((await prewarmRelations(client, SNOMED_PREFETCH_RELATIONS, "prefetch")) ?? [])];
    await client.query("COMMIT");
    if (results === null) {
      logWarning("SNOMED prewarm skipped: pg_prewarm extension not installed (apply db/migrations/20261029_pg_prewarm.sql)");
      return "done";
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
    if (isDbDownError(err)) return "db_down";
    logWarning("SNOMED prewarm failed (non-fatal)", { error: String((err as Error).message) });
  } finally {
    client?.release();
  }
  return "done";
}
