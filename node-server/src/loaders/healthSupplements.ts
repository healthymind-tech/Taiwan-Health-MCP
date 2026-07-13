/**
 * Taiwan FDA health supplements dataset loader (Node port of
 * `loader/loaders/health_supplements_loader.py`).
 *
 * Fetches the TFDA Open Data endpoint, then writes `health_supplements.items`
 * atomically (TRUNCATE + batch INSERT in one transaction) and stamps
 * `health_supplements.sync_meta.last_updated`. The row mapping mirrors the
 * Python loader field-for-field, including the `dict.get(k,"")` null-vs-empty
 * semantics (see `loaders/foodNutrition.ts` and the loader parity memo) and the
 * hardcoded empty `valid_to`.
 *
 * Run standalone:  node dist/loaders/healthSupplements.js
 * (requires DATABASE_URL pointing directly at Postgres, bypassing pgBouncer.)
 */

import pg from "pg";
import { unzipSync, strFromU8 } from "fflate";
import { config } from "../config.js";
import { logInfo, logError, configureLogLevel } from "../logger.js";

const API_SOURCE = "https://data.fda.gov.tw/data/opendata/export/19/json";

const BATCH = 2000;

type Json = Record<string, unknown>;

/**
 * Mirror of `fda_common.fetch_json`. The TFDA Open Data export endpoint returns
 * an `application/zip` body wrapping a single `.json` file; unzip it and parse
 * the first JSON entry. A plain JSON body is parsed directly.
 */
async function fetchJson(url: string): Promise<Json[]> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("zip") || url.endsWith(".zip")) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    const entries = unzipSync(buf);
    const jsonName = Object.keys(entries).find((n) => n.endsWith(".json"));
    if (!jsonName) return [];
    return JSON.parse(strFromU8(entries[jsonName])) as Json[];
  }
  return (await resp.json()) as Json[];
}

/**
 * Mirror Python `r.get(key, "")` semantics exactly for a TEXT column:
 *   - key absent           → "" (the default)
 *   - key present & null    → null (→ SQL NULL, like Python None)
 *   - key present non-null  → the value as-is (TFDA values are strings)
 */
function g(r: Json, key: string): string | null {
  if (!(key in r)) return "";
  const v = r[key];
  return v === null ? null : String(v);
}

/** Insert `rows` (array of value-tuples) into `table(cols)` in batches of BATCH. */
async function batchInsert(
  client: pg.PoolClient,
  table: string,
  cols: string[],
  rows: (string | null)[][],
): Promise<void> {
  const ncols = cols.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values: string[] = [];
    const params: (string | null)[] = [];
    slice.forEach((row, ri) => {
      const ph = row.map((_, ci) => `$${ri * ncols + ci + 1}`);
      values.push(`(${ph.join(",")})`);
      params.push(...row);
    });
    await client.query(
      `INSERT INTO ${table} (${cols.join(",")}) VALUES ${values.join(",")}`,
      params,
    );
  }
}

/** Faithful port of `load_health_supplements`. */
export async function loadHealthSupplements(pool: pg.Pool): Promise<void> {
  logInfo("Fetching Taiwan FDA health supplements dataset ...");
  const data = await fetchJson(API_SOURCE);

  // Mirror the Python tuple order; `valid_to` is hardcoded "" (index 5).
  const rows = data.map((r) => [
    g(r, "許可證字號"),
    g(r, "中文品名"),
    g(r, "申請商"),
    g(r, "保健功效"),
    g(r, "核可日期"),
    "",
    g(r, "類別"),
  ]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE health_supplements.items");
    await batchInsert(
      client,
      "health_supplements.items",
      [
        "permit_no",
        "name",
        "applicant",
        "benefit_claims",
        "valid_from",
        "valid_to",
        "category",
      ],
      rows,
    );
    await client.query(
      `INSERT INTO health_supplements.sync_meta (key, value, updated_at)
       VALUES ('last_updated', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [new Date().toISOString()],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  logInfo("Health supplements loaded", { items: rows.length });
}

/** CLI entry. */
async function main(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  try {
    await loadHealthSupplements(pool);
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (not when imported).
const invokedDirectly = process.argv[1]?.endsWith("healthSupplements.js");
if (invokedDirectly) {
  main().catch((err) => {
    logError("Health supplements loader failed", { error: String((err as Error).message) });
    process.exit(1);
  });
}
