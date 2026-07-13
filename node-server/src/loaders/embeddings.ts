/**
 * Embedding loader — Node port of `loader/loaders/embedding_loader.py`.
 *
 * Generates pgvector/halfvec embeddings for hybrid (BM25 + vector) search and
 * upserts them into the per-module `*_embeddings` tables:
 *   food_nutrition.food_embeddings / ingredient_embeddings, health_supplements.
 *   item_embeddings, icd.diagnosis_embeddings, loinc.concept_embeddings,
 *   guideline.guideline_embeddings, snomed.concept_embeddings.
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
 *       [--icd] [--loinc] [--guideline] [--snomed] [--ensure-dims]
 *       (no module flag → all modules; --ensure-dims also ALTERs vector dims)
 */

import crypto from "crypto";
import pg from "pg";
import { config } from "../config.js";
import { logInfo, logWarning, logError, configureLogLevel } from "../logger.js";
import { EmbeddingService, type EmbeddingSettings } from "../embeddingService.js";
import { candidateOrder, type LlmProfile } from "../admin/llmProfiles.js";

const HNSW_MAX_DIMS = 4000; // pgvector halfvec HNSW limit

// All (schema, table, column) triples that hold embedding vectors.
const EMBEDDING_COLUMNS: [string, string, string][] = [
  ["icd", "diagnosis_embeddings", "embedding"],
  ["health_supplements", "item_embeddings", "embedding"],
  ["food_nutrition", "food_embeddings", "embedding"],
  ["food_nutrition", "ingredient_embeddings", "embedding"],
  ["loinc", "concept_embeddings", "embedding"],
  ["guideline", "guideline_embeddings", "embedding"],
  ["snomed", "concept_embeddings", "embedding"],
];

/** Python `" ".join(filter(None, parts))`: drop null/undefined/"" then join. */
function joinText(parts: (string | null | undefined)[]): string {
  return parts.filter((v) => v != null && v !== "").join(" ");
}

/** Stable content fingerprint of the exact text fed to the embedding model. */
function textHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function loadSettings(pool: pg.Pool): Promise<EmbeddingSettings> {
  const defaults: EmbeddingSettings = {
    strategy: "failover",
    timeout: 30,
    batchSize: 32,
    dimensions: 1024,
  };
  try {
    const res = await pool.query<{ key: string; value: string | null }>(
      "SELECT key, value FROM admin.app_settings WHERE group_key = 'embedding'",
    );
    const m = new Map(res.rows.map((r) => [r.key, r.value ?? ""]));
    const strategy = (m.get("strategy") || "failover").trim().toLowerCase();
    return {
      strategy: strategy === "weighted" ? "weighted" : "failover",
      timeout: Number(m.get("timeout")) || 30,
      batchSize: Number(m.get("batch_size")) || 32,
      dimensions: Number(m.get("dimensions")) || 1024,
    };
  } catch {
    return defaults;
  }
}

/** Enabled embedding endpoints, in the order this run should try them. */
async function loadProfiles(settings: EmbeddingSettings): Promise<LlmProfile[]> {
  return candidateOrder("embedding", settings.strategy);
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
    const base = p.base_url.replace(/\/+$/, "");
    if (p.provider !== "ollama") {
      // Hosted providers: a key and a model is all we can check without spending a call.
      if (p.model && p.api_key) {
        logInfo(`${p.provider} embedding profile '${p.name}' model=${p.model} dimensions=${s.dimensions}`);
        return true;
      }
      logWarning(`Embedding profile '${p.name}' needs a model and API key — skipping it`);
      continue;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${base}/api/version`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        logInfo(`Ollama OK profile='${p.name}' url=${base} model=${p.model} dimensions=${s.dimensions}`);
        return true;
      }
    } catch {
      /* try the next profile */
    }
    logWarning(`Embedding profile '${p.name}' not reachable at ${base}`);
  }
  logError("No embedding profile is reachable — skipping embedding");
  return false;
}

/** ALTER all embedding halfvec columns to match the configured dimensions. */
async function ensureDimensions(pool: pg.Pool, dims: number): Promise<void> {
  logInfo(`Ensuring embedding dimensions = ${dims}`);
  if (dims > HNSW_MAX_DIMS) {
    logWarning(`${dims}d > ${HNSW_MAX_DIMS} halfvec HNSW limit — index skipped (exact scan)`);
  }
  for (const [schema, table, col] of EMBEDDING_COLUMNS) {
    const row = await pool.query<{ atttypmod: number }>(
      `SELECT atttypmod FROM pg_attribute pa
         JOIN pg_class pc ON pc.oid = pa.attrelid
         JOIN pg_namespace pn ON pn.oid = pc.relnamespace
        WHERE pn.nspname = $1 AND pc.relname = $2 AND pa.attname = $3
          AND pa.attnum > 0 AND NOT pa.attisdropped`,
      [schema, table, col],
    );
    if (row.rows.length === 0) {
      logInfo(`  ${schema}.${table} not found, skipping`);
      continue;
    }
    const current = row.rows[0].atttypmod;
    if (current === dims) {
      logInfo(`  ${schema}.${table}.${col}: already ${dims}d — OK`);
      continue;
    }
    logInfo(`  ${schema}.${table}.${col}: ${current}d → ${dims}d (ALTER TABLE)`);
    const fqt = `${schema}.${table}`;
    await pool.query(`ALTER TABLE ${fqt} DROP COLUMN IF EXISTS ${col} CASCADE`);
    await pool.query(`ALTER TABLE ${fqt} ADD COLUMN ${col} halfvec(${dims})`);
    if (dims <= HNSW_MAX_DIMS) {
      const idx = `idx_${schema.slice(0, 2)}_${table.slice(0, 6)}_emb_hnsw`;
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${idx} ON ${fqt} USING hnsw (${col} halfvec_cosine_ops)`,
      );
      logInfo(`    → HNSW index recreated: ${idx}`);
    }
  }
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
}

interface EmbedTableArgs {
  table: string;
  keyCol: string;
  keySqlType: string;
  rows: any[];
  keyOf: (r: any) => string | number;
  textOf: (r: any) => string;
  desc: string;
}

/** Incrementally embed one source→embedding table. */
async function embedTable(
  pool: pg.Pool,
  svc: EmbeddingService,
  batchSize: number,
  a: EmbedTableArgs,
): Promise<EmbedStats> {
  await ensureEmbedInfra(pool, a.table);

  // An empty source means "not loaded yet" — never wipe existing embeddings.
  if (a.rows.length === 0) {
    const r = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${a.table}`);
    return { source_total: 0, changed: 0, embedded_total: r.rows[0].c, deleted: 0 };
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

  // 3. New or content-changed rows only.
  const toEmbed = current.filter((c) => existing.get(String(c.k)) !== c.h);
  logInfo(`${a.desc}: ${a.rows.length} source, ${toEmbed.length} new/changed`);

  // 4-5. Embed just those, upserting the fresh hash alongside the vector.
  const sql =
    `INSERT INTO ${a.table} (${a.keyCol}, embedding, source_hash) ` +
    `VALUES ($1, $2::halfvec, $3) ` +
    `ON CONFLICT (${a.keyCol}) DO UPDATE ` +
    `SET embedding = EXCLUDED.embedding, source_hash = EXCLUDED.source_hash, embedded_at = NOW()`;
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const batch = toEmbed.slice(i, i + batchSize);
    const vecs = await svc.embedBatch(batch.map((b) => b.t));
    for (let j = 0; j < batch.length; j += 1) {
      const v = vecs[j];
      if (v == null) continue;
      await pool.query(sql, [batch[j].k, `[${v.join(",")}]`, batch[j].h]);
    }
    const done = Math.min(i + batchSize, toEmbed.length);
    if (i === 0 || done % (batchSize * 20) === 0 || done === toEmbed.length) {
      logInfo(`  ${a.desc}: ${done}/${toEmbed.length}`);
    }
  }

  // 6. Prune embeddings whose source row is gone.
  const deleted = await deleteOrphans(pool, a.table, a.keyCol, a.keySqlType, keys);
  const r = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${a.table}`);
  return { source_total: a.rows.length, changed: toEmbed.length, embedded_total: r.rows[0].c, deleted };
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

async function embedFoodNutrition(pool: pg.Pool, svc: EmbeddingService, batch: number): Promise<void> {
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
  });
  const sIngs = await embedTable(pool, svc, batch, {
    table: "food_nutrition.ingredient_embeddings",
    keyCol: "id",
    keySqlType: "INTEGER",
    rows: ings,
    keyOf: (r) => r.id,
    textOf: (r) => joinText([r.name_zh, r.name_en]),
    desc: "Ingredients",
  });
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
}

async function embedHealthSupplements(pool: pg.Pool, svc: EmbeddingService, batch: number): Promise<void> {
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
  });
  await writeEmbedLog(pool, "health_supplements", s.source_total, s.embedded_total, s.changed);
  logInfo(
    `Health supplements done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`,
  );
}

async function embedIcd(pool: pg.Pool, svc: EmbeddingService, batch: number): Promise<void> {
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
  });
  await writeEmbedLog(pool, "icd", s.source_total, s.embedded_total, s.changed);
  logInfo(`ICD done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`);
}

async function embedLoinc(pool: pg.Pool, svc: EmbeddingService, batch: number): Promise<void> {
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
  });
  await writeEmbedLog(pool, "loinc", s.source_total, s.embedded_total, s.changed);
  logInfo(`LOINC done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`);
}

async function embedGuideline(pool: pg.Pool, svc: EmbeddingService, batch: number): Promise<void> {
  logInfo("=== Embedding: guideline.disease_guidelines ===");
  const rows = (
    await pool.query(
      `SELECT id, disease_name_zh, disease_name_en, guideline_title, guideline_summary
         FROM guideline.disease_guidelines`,
    )
  ).rows;
  if (rows.length === 0) {
    logWarning("No guidelines found — run the guideline loader first");
    return;
  }
  const s = await embedTable(pool, svc, batch, {
    table: "guideline.guideline_embeddings",
    keyCol: "id",
    keySqlType: "INTEGER",
    rows,
    keyOf: (r) => r.id,
    textOf: (r) =>
      joinText([r.disease_name_zh, r.disease_name_en, r.guideline_title, r.guideline_summary]),
    desc: "Guidelines",
  });
  await writeEmbedLog(pool, "guideline", s.source_total, s.embedded_total, s.changed);
  logInfo(
    `Guidelines done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`,
  );
}

async function embedSnomed(pool: pg.Pool, svc: EmbeddingService, batch: number): Promise<void> {
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
  });
  await writeEmbedLog(pool, "snomed", s.source_total, s.embedded_total, s.changed);
  logInfo(`SNOMED done: ${s.changed} (re)embedded, ${s.deleted} orphans pruned, ${s.embedded_total} total`);
}

const MODULES: Record<string, (p: pg.Pool, s: EmbeddingService, b: number) => Promise<void>> = {
  "food-nutrition": embedFoodNutrition,
  "health-supplements": embedHealthSupplements,
  icd: embedIcd,
  loinc: embedLoinc,
  guideline: embedGuideline,
  snomed: embedSnomed,
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
 */
export async function runEmbedModule(pool: pg.Pool, moduleKey: string): Promise<void> {
  const fn = MODULES[moduleKey];
  if (!fn) throw new Error(`unknown embed module: ${moduleKey}`);
  const settings = await loadSettings(pool);
  await ensureDimensions(pool, settings.dimensions);
  const svc = new EmbeddingService(settings, await loadProfiles(settings));
  await fn(pool, svc, settings.batchSize);
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
    if (ensureDims) await ensureDimensions(pool, settings.dimensions);
    if (!(await checkProvider(settings, profiles))) {
      logError("Embedding provider not ready — nothing embedded");
      return;
    }
    const svc = new EmbeddingService(settings, profiles);
    for (const m of modules) {
      await MODULES[m](pool, svc, settings.batchSize);
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
