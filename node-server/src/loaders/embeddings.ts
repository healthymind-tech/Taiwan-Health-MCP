/**
 * Embedding loader — Node port of `loader/loaders/embedding_loader.py`.
 *
 * Generates pgvector/halfvec embeddings for hybrid (BM25 + vector) search and
 * upserts them into the per-module `*_embeddings` tables:
 *   food_nutrition.food_embeddings / ingredient_embeddings, health_supplements.
 *   item_embeddings, icd.diagnosis_embeddings, loinc.concept_embeddings,
 *   snomed.concept_embeddings.
 *
 * Incremental: each row's embedded text is hashed (sha256 → `source_hash`); a row
 * is (re)embedded only when new or changed since the last run, and embedding rows
 * whose source key is gone are pruned. A per-module marker is written to
 * `admin.module_embed_log`. This determinism (text construction + sha256) is what
 * makes a re-run a near-instant no-op and is the verifiable parity surface — the
 * vectors themselves are model output (halfvec-quantized), not byte-checked.
 *
 * Reuses `EmbeddingService` (Ollama / OpenAI / Google) for the actual embed call,
 * configured from the `admin.app_settings` `embedding` group, exactly like the
 * Python worker's `embedding_loader.configure(...)`.
 *
 * Run:  node dist/loaders/embeddings.js [--food-nutrition] [--health-supplements]
 *       [--icd] [--loinc] [--snomed] [--ensure-dims]
 *       (no module flag → all modules; --ensure-dims also ALTERs vector dims)
 */

import crypto from "crypto";
import pg from "pg";
import { config } from "../config.js";
import { logInfo, logWarning, logError, configureLogLevel } from "../logger.js";
import {
  DEFAULT_EMBEDDING_SETTINGS,
  EmbeddingService,
  parseEmbeddingSettings,
  type EmbeddingSettings,
} from "../embeddingService.js";
import { candidateOrder, embeddingDimensions, type LlmProfile } from "../admin/llmProfiles.js";
import { runBoundedPool } from "./batchPool.js";
import { probeEndpoint } from "../providers/probe.js";
import { alterEmbeddingColumns } from "../admin/embeddingColumns.js";
import { identityDimensions } from "../admin/embeddingIdentity.js";

/** Python `" ".join(filter(None, parts))`: drop null/undefined/"" then join. */
function joinText(parts: (string | null | undefined)[]): string {
  return parts.filter((v) => v != null && v !== "").join(" ");
}

/** Stable content fingerprint of the exact text fed to the embedding model. */
function textHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function loadSettings(pool: pg.Pool): Promise<EmbeddingSettings> {
  try {
    const res = await pool.query<{ key: string; value: string | null }>(
      "SELECT key, value FROM admin.app_settings WHERE group_key = 'embedding'",
    );
    return parseEmbeddingSettings(new Map(res.rows.map((r) => [r.key, r.value ?? ""])));
  } catch {
    return { ...DEFAULT_EMBEDDING_SETTINGS };
  }
}

/** How often a running embed job re-reads `embedding.concurrency`. */
const CONCURRENCY_REFRESH_MS = 10_000;

/**
 * Live view of `embedding.concurrency` for one run: returns the last known value
 * synchronously and refreshes it from the DB in the background at most every
 * {@link CONCURRENCY_REFRESH_MS}, so an operator can raise or lower it while a
 * long module (SNOMED) is embedding. A failed refresh keeps the current value —
 * a transient DB error must not silently drop the job back to 1.
 */
export function liveConcurrency(
  initial: number,
  read: () => Promise<number | null>,
  refreshMs = CONCURRENCY_REFRESH_MS,
): () => number {
  let current = initial;
  let lastRead = Date.now();
  let reading = false;
  return () => {
    if (!reading && Date.now() - lastRead >= refreshMs) {
      reading = true;
      void read()
        .then((n) => {
          if (n !== null && n !== current) {
            logInfo(`Embedding concurrency changed ${current} → ${n}`);
            current = n;
          }
        })
        .catch(() => undefined)
        .finally(() => {
          reading = false;
          lastRead = Date.now();
        });
    }
    return current;
  };
}

async function readConcurrency(pool: pg.Pool): Promise<number | null> {
  try {
    const res = await pool.query<{ key: string; value: string | null }>(
      "SELECT key, value FROM admin.app_settings WHERE group_key = 'embedding'",
    );
    return parseEmbeddingSettings(new Map(res.rows.map((r) => [r.key, r.value ?? ""]))).concurrency;
  } catch {
    return null;
  }
}

/** Enabled embedding endpoints, in the order this run should try them. */
async function loadProfiles(settings: EmbeddingSettings): Promise<LlmProfile[]> {
  return candidateOrder("embedding", settings.strategy);
}

function activeDimensions(profiles: LlmProfile[]): number {
  return embeddingDimensions(profiles[0] ?? { params: {} });
}

/**
 * Is at least one embedding endpoint actually reachable? A dead host is not a
 * reason to abort when another profile can serve the same model, so this only
 * fails the run when *every* profile is unreachable.
 */
async function checkProvider(s: EmbeddingSettings, profiles: LlmProfile[]): Promise<boolean> {
  if (profiles.length === 0) {
    logError("No enabled embedding profile — configure one in Admin → Settings → Embedding");
    return false;
  }
  for (const p of profiles) {
    // A real one-text embedding: verifies host, key, model and vector size.
    const r = await probeEndpoint(p, "embedding", { deep: true, timeoutMs: 30_000 });
    if (r.ok) {
      logInfo(`Embedding endpoint OK profile='${p.name}' provider=${r.provider} model=${p.model} dimensions=${embeddingDimensions(p)} (${r.message})`);
      return true;
    }
    logWarning(`Embedding profile '${p.name}' unreachable: ${r.message}`);
  }
  logError("No embedding profile is reachable");
  return false;
}

/** ALTER all embedding halfvec columns to match the configured dimensions. */
async function ensureDimensions(pool: pg.Pool, dims: number): Promise<void> {
  logInfo(`Ensuring embedding dimensions = ${dims}`);
  await alterEmbeddingColumns(pool, dims);
}

/**
 * The vector size this run writes: the system identity's (what the stored
 * vectors are) when there is one, else the first endpoint's configured size.
 * Preferring the identity means a profile with a missing / wrong `dimensions`
 * knob can never re-type (and so empty) the columns.
 */
async function targetDimensions(profiles: LlmProfile[]): Promise<number> {
  return (await identityDimensions().catch(() => null)) ?? activeDimensions(profiles);
}

async function ensureEmbedInfra(pool: pg.Pool, table: string): Promise<void> {
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_hash TEXT`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS admin.module_embed_log (
       module_key       TEXT PRIMARY KEY,
       last_run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       source_total     INTEGER,
       embedded         INTEGER,
       changed_last_run INTEGER,
       updated_at       TIMESTAMPTZ DEFAULT NOW()
     )`,
  );
}

/** Delete embedding rows whose source key no longer exists (anti-join). */
async function deleteOrphans(
  pool: pg.Pool,
  table: string,
  keyCol: string,
  keySqlType: string,
  keys: (string | number)[],
): Promise<number> {
  const res = await pool.query(
    `DELETE FROM ${table} t
       WHERE NOT EXISTS (
         SELECT 1 FROM unnest($1::${keySqlType}[]) AS k(k) WHERE k.k = t.${keyCol}
       )`,
    [keys],
  );
  return res.rowCount ?? 0;
}

interface EmbedStats {
  source_total: number;
  changed: number;
  embedded_total: number;
  deleted: number;
  /** True when the run bailed out at a batch boundary because `shouldStop` fired. */
  stopped: boolean;
}

/**
 * Cooperative cancellation hook, consulted between embedding batches so a
 * pause/stop requested from the admin console takes effect promptly instead of
 * only after the whole module finishes (SNOMED alone is ~360k rows).
 * Embedding is content-hash incremental, so bailing out mid-module is safe:
 * a resumed job re-derives the remaining set and continues.
 */
export type ShouldStop = () => boolean | Promise<boolean>;

interface EmbedTableArgs {
  table: string;
  keyCol: string;
  keySqlType: string;
  rows: any[];
  keyOf: (r: any) => string | number;
  textOf: (r: any) => string;
  desc: string;
  shouldStop?: ShouldStop;
}

/** The slice of `EmbeddingService` the loader needs (fakeable in tests). */
export interface BatchEmbedder {
  embedBatch(texts: string[]): Promise<(number[] | null)[]>;
  /** Optional pacing hook: wait while every profile is out of RPM/TPM budget. */
  waitForCapacity?(): Promise<number>;
}

/** Per-run knobs shared by every table of a module. */
export interface EmbedRunOptions {
  batchSize: number;
  /** In-flight batch limit, consulted before each dispatch (hot-reloadable). */
  concurrency: () => number;
}

/**
 * Incrementally embed one source→embedding table.
 *
 * Batches are embedded through a bounded pool (`concurrency()` requests in
 * flight). Each batch is fetched over HTTP first and only then written with a
 * single autocommit multi-row upsert — no transaction is held across a network
 * call, each write holds one pooled connection for one statement, and the
 * upsert is idempotent (keyed + content-hashed), so a batch that lands after a
 * pause was requested is harmless and a resumed run re-derives exactly the
 * rows still missing or stale.
 */
export async function embedTable(
  pool: pg.Pool,
  svc: BatchEmbedder,
  run: EmbedRunOptions,
  a: EmbedTableArgs,
): Promise<EmbedStats> {
  const batchSize = Math.max(1, Math.floor(run.batchSize) || 1);
  await ensureEmbedInfra(pool, a.table);

  // An empty source means "not loaded yet" — never wipe existing embeddings.
  if (a.rows.length === 0) {
    const r = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${a.table}`);
    return { source_total: 0, changed: 0, embedded_total: r.rows[0].c, deleted: 0, stopped: false };
  }

  // 1. Current keys + text + hash (text computed once, shared by hash & embed).
  const current = a.rows.map((r) => {
    const t = a.textOf(r);
    return { k: a.keyOf(r), t, h: textHash(t) };
  });
  const keys = current.map((c) => c.k);

  // 2. Existing hashes for this table.
  const existingRes = await pool.query<{ k: string | number; h: string | null }>(
    `SELECT ${a.keyCol} AS k, source_hash AS h FROM ${a.table}`,
  );
  const existing = new Map(existingRes.rows.map((r) => [String(r.k), r.h]));

  // 3. New or content-changed rows only. De-duplicated by key (last wins, as
  //    sequential per-row upserts used to behave): one multi-row upsert must not
  //    touch the same key twice.
  const byKey = new Map<string, (typeof current)[number]>();
  for (const c of current) {
    if (existing.get(String(c.k)) !== c.h) byKey.set(String(c.k), c);
  }
  const toEmbed = [...byKey.values()];
  logInfo(`${a.desc}: ${a.rows.length} source, ${toEmbed.length} new/changed`);

  // 4-5. Embed just those, upserting the fresh hash alongside the vector.
  const sql =
    `INSERT INTO ${a.table} (${a.keyCol}, embedding, source_hash) ` +
    `SELECT k, e::halfvec, h FROM unnest($1::${a.keySqlType}[], $2::text[], $3::text[]) AS u(k, e, h) ` +
    `ON CONFLICT (${a.keyCol}) DO UPDATE ` +
    `SET embedding = EXCLUDED.embedding, source_hash = EXCLUDED.source_hash, embedded_at = NOW()`;
  const batchCount = Math.ceil(toEmbed.length / batchSize);
  let done = 0;
  let missing = 0;
  let nextLogAt = batchSize * 20;
  const result = await runBoundedPool({
    count: batchCount,
    concurrency: run.concurrency,
    shouldStop: a.shouldStop,
    task: async (b) => {
      const batch = toEmbed.slice(b * batchSize, (b + 1) * batchSize);
      if (svc.waitForCapacity) await svc.waitForCapacity();
      const vecs = await svc.embedBatch(batch.map((x) => x.t));
      const ks: (string | number)[] = [];
      const es: string[] = [];
      const hs: string[] = [];
      for (let j = 0; j < batch.length; j += 1) {
        const v = vecs[j];
        if (v == null || v.length === 0) continue;
        ks.push(batch[j].k);
        es.push(`[${v.join(",")}]`);
        hs.push(batch[j].h);
      }
      missing += batch.length - ks.length;
      if (ks.length > 0) await pool.query(sql, [ks, es, hs]);
      done += batch.length;
      if (b === 0 || done >= nextLogAt || done === toEmbed.length) {
        while (nextLogAt <= done) nextLogAt += batchSize * 20;
        logInfo(`  ${a.desc}: ${done}/${toEmbed.length}`);
      }
    },
  });
  if (missing > 0) {
    logWarning(`  ${a.desc}: ${missing} item(s) got no vector from any embedding profile`);
  }

  if (result.stopped) {
    logInfo(`  ${a.desc}: stopping at ${done}/${toEmbed.length} on request`);
    const r = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${a.table}`);
    // Orphan pruning is deliberately skipped: it is a whole-module sync step
    // and must not run against a half-embedded table.
    return {
      source_total: a.rows.length, changed: done, embedded_total: r.rows[0].c,
      deleted: 0, stopped: true,
    };
  }

  // 6. Prune embeddings whose source row is gone.
  const deleted = await deleteOrphans(pool, a.table, a.keyCol, a.keySqlType, keys);
  const r = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${a.table}`);
  return {
    source_total: a.rows.length, changed: toEmbed.length, embedded_total: r.rows[0].c,
    deleted, stopped: false,
  };
}

async function writeEmbedLog(
  pool: pg.Pool,
  moduleKey: string,
  sourceTotal: number,
  embedded: number,
  changed: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO admin.module_embed_log
       (module_key, last_run_at, source_total, embedded, changed_last_run, updated_at)
     VALUES ($1, NOW(), $2, $3, $4, NOW())
     ON CONFLICT (module_key) DO UPDATE
       SET last_run_at = NOW(), source_total = EXCLUDED.source_total,
           embedded = EXCLUDED.embedded, changed_last_run = EXCLUDED.changed_last_run,
           updated_at = NOW()`,
    [moduleKey, sourceTotal, embedded, changed],
  );
}

// ── per-module functions ─────────────────────────────────────────────────────

async function embedFoodNutrition(
  pool: pg.Pool, svc: BatchEmbedder, batch: EmbedRunOptions, shouldStop?: ShouldStop,
): Promise<boolean> {
  logInfo("=== Embedding: food_nutrition ===");
  const foods = (
    await pool.query(
      `SELECT DISTINCT ON (sample_name) sample_name, common_name, english_name
         FROM food_nutrition.measurements ORDER BY sample_name`,
    )
  ).rows;
  const ings = (await pool.query("SELECT id, name_zh, name_en FROM food_nutrition.ingredients")).rows;

  const sFoods = await embedTable(pool, svc, batch, {
    table: "food_nutrition.food_embeddings",
    keyCol: "sample_name",
    keySqlType: "TEXT",
    rows: foods,
    keyOf: (r) => r.sample_name,
    textOf: (r) => joinText([r.sample_name, r.common_name, r.english_name]),
    desc: "Foods",
    shouldStop,
  });
  if (sFoods.stopped) return true;
  const sIngs = await embedTable(pool, svc, batch, {
    table: "food_nutrition.ingredient_embeddings",
    keyCol: "id",
    keySqlType: "INTEGER",
    rows: ings,
    keyOf: (r) => r.id,
    textOf: (r) => joinText([r.name_zh, r.name_en]),
    desc: "Ingredients",
    shouldStop,
  });
  if (sIngs.stopped) return true;
  await writeEmbedLog(
    pool,
    "food_nutrition",
    sFoods.source_total + sIngs.source_total,
    sFoods.embedded_total + sIngs.embedded_total,
    sFoods.changed + sIngs.changed,
  );
  logInfo(
    `food_nutrition done: ${sFoods.changed + sIngs.changed} (re)embedded, ${sFoods.deleted + sIngs.deleted} orphans pruned`,
  );
  return false;
}

async function embedHealthSupplements(
  pool: pg.Pool, svc: BatchEmbedder, batch: EmbedRunOptions, shouldStop?: ShouldStop,
): Promise<boolean> {
  logInfo("=== Embedding: health_supplements ===");
  const items = (
    await pool.query("SELECT permit_no, name, benefit_claims FROM health_supplements.items")
  ).rows;
  const s = await embedTable(pool, svc, batch, {
    table: "health_supplements.item_embeddings",
    keyCol: "permit_no",
    keySqlType: "TEXT",
    rows: items,
    keyOf: (r) => r.permit_no,
    textOf: (r) => joinText([r.name, r.benefit_claims]),
    desc: "Health supplements",
    shouldStop,
  });
  if (s.stopped) return true;
  await writeEmbedLog(pool, "health_supplements", s.source_total, s.embedded_total, s.changed);
  logInfo(
    `Health supplements done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`,
  );
  return false;
}

async function embedIcd(
  pool: pg.Pool, svc: BatchEmbedder, batch: EmbedRunOptions, shouldStop?: ShouldStop,
): Promise<boolean> {
  logInfo("=== Embedding: icd.diagnoses ===");
  const rows = (await pool.query("SELECT code, name_zh, name_en FROM icd.diagnoses")).rows;
  const s = await embedTable(pool, svc, batch, {
    table: "icd.diagnosis_embeddings",
    keyCol: "code",
    keySqlType: "TEXT",
    rows,
    keyOf: (r) => r.code,
    textOf: (r) => joinText([r.code, r.name_zh, r.name_en]),
    desc: "ICD diagnoses",
    shouldStop,
  });
  if (s.stopped) return true;
  await writeEmbedLog(pool, "icd", s.source_total, s.embedded_total, s.changed);
  logInfo(`ICD done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`);
  return false;
}

async function embedLoinc(
  pool: pg.Pool, svc: BatchEmbedder, batch: EmbedRunOptions, shouldStop?: ShouldStop,
): Promise<boolean> {
  logInfo("=== Embedding: loinc.concepts ===");
  const rows = (
    await pool.query(
      `SELECT loinc_num, long_common_name, shortname, name_zh, common_name_zh, component, specimen_type
         FROM loinc.concepts`,
    )
  ).rows;
  const s = await embedTable(pool, svc, batch, {
    table: "loinc.concept_embeddings",
    keyCol: "loinc_num",
    keySqlType: "TEXT",
    rows,
    keyOf: (r) => r.loinc_num,
    textOf: (r) =>
      joinText([
        r.long_common_name,
        r.shortname,
        r.name_zh,
        r.common_name_zh,
        r.component,
        r.specimen_type,
      ]),
    desc: "LOINC",
    shouldStop,
  });
  if (s.stopped) return true;
  await writeEmbedLog(pool, "loinc", s.source_total, s.embedded_total, s.changed);
  logInfo(`LOINC done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`);
  return false;
}

async function embedSnomed(
  pool: pg.Pool, svc: BatchEmbedder, batch: EmbedRunOptions, shouldStop?: ShouldStop,
): Promise<boolean> {
  logInfo("=== Embedding: snomed.concept_embeddings (~360k FSNs — slow) ===");
  const rows = (
    await pool.query(
      `SELECT DISTINCT ON (concept_id) concept_id, term
         FROM snomed.descriptions
        WHERE active = TRUE AND type_id = '900000000000003001'
        ORDER BY concept_id`,
    )
  ).rows;
  const s = await embedTable(pool, svc, batch, {
    table: "snomed.concept_embeddings",
    keyCol: "concept_id",
    keySqlType: "BIGINT",
    rows,
    keyOf: (r) => r.concept_id, // 18-digit string (BIGINT carried as text)
    textOf: (r) => r.term || "",
    desc: "SNOMED",
    shouldStop,
  });
  if (s.stopped) return true;
  await writeEmbedLog(pool, "snomed", s.source_total, s.embedded_total, s.changed);
  logInfo(`SNOMED done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`);
  return false;
}

/**
 * IG concept terms (fhir.concept_index_terms, built by the ig_concept_index job). Vectors
 * are content-addressed by sha256(term): the same name in several package versions /
 * CodeSystems is embedded once. Only terms the index marked embeddable carry a hash.
 */
async function embedIg(
  pool: pg.Pool, svc: BatchEmbedder, batch: EmbedRunOptions, shouldStop?: ShouldStop,
): Promise<boolean> {
  logInfo("=== Embedding: fhir.concept_index_terms (IG CodeSystem terms) ===");
  const rows = (
    await pool.query(
      `SELECT DISTINCT ON (text_hash) text_hash, term
         FROM fhir.concept_index_terms WHERE text_hash IS NOT NULL ORDER BY text_hash`,
    )
  ).rows;
  const s = await embedTable(pool, svc, batch, {
    table: "fhir.concept_embeddings",
    keyCol: "text_hash",
    keySqlType: "TEXT",
    rows,
    keyOf: (r) => r.text_hash,
    textOf: (r) => r.term || "",
    desc: "IG concept terms",
    shouldStop,
  });
  if (s.stopped) return true;
  await writeEmbedLog(pool, "ig", s.source_total, s.embedded_total, s.changed);
  logInfo(`IG concept terms done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`);
  return false;
}

const MODULES: Record<
  string,
  (p: pg.Pool, s: BatchEmbedder, run: EmbedRunOptions, stop?: ShouldStop) => Promise<boolean>
> = {
  "food-nutrition": embedFoodNutrition,
  "health-supplements": embedHealthSupplements,
  icd: embedIcd,
  loinc: embedLoinc,
  snomed: embedSnomed,
  ig: embedIg,
};

/** Shared embedding settings for the admin worker's validate phase. */
export async function loadEmbeddingSettings(pool: pg.Pool): Promise<EmbeddingSettings> {
  return loadSettings(pool);
}

/** Enabled embedding endpoints, for the admin worker's validate phase. */
export async function loadEmbeddingProfiles(settings: EmbeddingSettings): Promise<LlmProfile[]> {
  return loadProfiles(settings);
}

/**
 * Run one module's incremental embedding (mirror the worker's
 * `ensure_dimensions(pool)` + `embed_fn(pool)`): always ensure halfvec dims, then
 * embed via the module's loader function. Settings come from the `embedding` group.
 *
 * Returns true when `shouldStop` cut the run short at a batch boundary; the
 * caller is then responsible for applying the pending pause/stop.
 */
export async function runEmbedModule(
  pool: pg.Pool,
  moduleKey: string,
  shouldStop?: ShouldStop,
): Promise<boolean> {
  const fn = MODULES[moduleKey];
  if (!fn) throw new Error(`unknown embed module: ${moduleKey}`);
  const settings = await loadSettings(pool);
  const profiles = await loadProfiles(settings);
  await ensureDimensions(pool, await targetDimensions(profiles));
  const svc = new EmbeddingService(settings, profiles);
  logInfo(`Embedding run: batch_size=${settings.batchSize} concurrency=${settings.concurrency}`);
  return fn(pool, svc, {
    batchSize: settings.batchSize,
    concurrency: liveConcurrency(settings.concurrency, () => readConcurrency(pool)),
  }, shouldStop);
}

async function main(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  const argv = process.argv.slice(2);
  const ensureDims = argv.includes("--ensure-dims");
  const selected = Object.keys(MODULES).filter((m) => argv.includes(`--${m}`));
  const modules = selected.length ? selected : Object.keys(MODULES);

  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  try {
    const settings = await loadSettings(pool);
    const profiles = await loadProfiles(settings);
    if (ensureDims) await ensureDimensions(pool, await targetDimensions(profiles));
    if (!(await checkProvider(settings, profiles))) {
      logError("Embedding provider not ready — nothing embedded");
      return;
    }
    const svc = new EmbeddingService(settings, profiles);
    for (const m of modules) {
      await MODULES[m](pool, svc, { batchSize: settings.batchSize, concurrency: () => settings.concurrency });
    }
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("embeddings.js");
if (invokedDirectly) {
  main().catch((err) => {
    logError("Embedding loader failed", { error: String((err as Error).message) });
    process.exit(1);
  });
}
