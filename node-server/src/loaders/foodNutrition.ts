/**
 * Taiwan FDA food nutrition dataset loader (Node port of
 * `loader/loaders/food_nutrition_loader.py`).
 *
 * Fetches both TFDA Open Data endpoints, then writes `food_nutrition.measurements`
 * and `food_nutrition.ingredients` atomically (TRUNCATE + batch INSERT in one
 * transaction) and stamps `food_nutrition.sync_meta.last_updated`. The row
 * mapping mirrors the Python loader field-for-field so the loader golden-output
 * diff (scripts/loader_parity_test.py) matches.
 *
 * Run standalone:  node dist/loaders/foodNutrition.js
 * (requires DATABASE_URL pointing directly at Postgres, bypassing pgBouncer.)
 */

import pg from "pg";
import { unzipSync, strFromU8 } from "fflate";
import { config } from "../config.js";
import { logInfo, logError, configureLogLevel } from "../logger.js";

const API_SOURCES = {
  nutrition: "https://data.fda.gov.tw/data/opendata/export/20/json",
  ingredients: "https://data.fda.gov.tw/data/opendata/export/4/json",
};

const BATCH = 5000;

type Json = Record<string, unknown>;

/**
 * Mirror of `fda_common.fetch_json`. The TFDA Open Data export endpoints return
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
 * The absent-vs-present-null distinction matters: TFDA returns `"俗名": null`
 * for some rows, which Python stores as NULL (not "").
 */
function g(r: Json, key: string): string | null {
  if (!(key in r)) return "";
  const v = r[key];
  return v === null ? null : String(v);
}

/**
 * Mirror Python `str(r.get(key, ""))` for `content_per_100g`:
 *   - key absent          → str("")   = ""
 *   - key present & null   → str(None) = "None"
 *   - else                → String(v)
 */
function gStr(r: Json, key: string): string {
  if (!(key in r)) return "";
  const v = r[key];
  return v === null ? "None" : String(v);
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

/** Faithful port of `load_food_nutrition`. */
export async function loadFoodNutrition(pool: pg.Pool): Promise<void> {
  logInfo("Fetching Taiwan FDA food nutrition datasets ...");
  const [nutritionData, ingredientsData] = await Promise.all([
    fetchJson(API_SOURCES.nutrition),
    fetchJson(API_SOURCES.ingredients),
  ]);

  const measurementRows = nutritionData.map((r) => [
    g(r, "食品分類"),
    g(r, "樣品名稱"),
    g(r, "俗名"),
    g(r, "樣品英文名稱"),
    g(r, "分析項"),
    gStr(r, "每100克含量"),
    g(r, "含量單位"),
    g(r, "分析項分類"),
  ]);
  const ingredientRows = ingredientsData.map((r) => [
    g(r, "中文名稱"),
    g(r, "英文名稱"),
    g(r, "大分類"),
    g(r, "次分類"),
    g(r, "備註"),
  ]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE food_nutrition.ingredients, food_nutrition.measurements");
    await batchInsert(
      client,
      "food_nutrition.measurements",
      [
        "food_category",
        "sample_name",
        "common_name",
        "english_name",
        "nutrient_item",
        "content_per_100g",
        "content_unit",
        "nutrient_category",
      ],
      measurementRows,
    );
    await batchInsert(
      client,
      "food_nutrition.ingredients",
      ["name_zh", "name_en", "major_category", "sub_category", "note"],
      ingredientRows,
    );
    await client.query(
      `INSERT INTO food_nutrition.sync_meta (key, value, updated_at)
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

  logInfo("Food nutrition loaded", {
    measurements: measurementRows.length,
    ingredients: ingredientRows.length,
  });
}

/** CLI entry. */
async function main(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  try {
    await loadFoodNutrition(pool);
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (not when imported).
const invokedDirectly = process.argv[1]?.endsWith("foodNutrition.js");
if (invokedDirectly) {
  main().catch((err) => {
    logError("Food nutrition loader failed", { error: String((err as Error).message) });
    process.exit(1);
  });
}
