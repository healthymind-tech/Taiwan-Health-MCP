/**
 * LOINC 2.80 full loader (Node port of `loader/loaders/loinc_loader.py` plus
 * `loader/loaders/loinc_taiwan_seed.py`).
 *
 * Reads `Loinc_2.80.zip` (the root-level `LoincTable/Loinc.csv`, excluding the
 * AccessoryFiles subsets), writes `loinc.concepts`, then applies the Taiwan
 * Chinese names (`taiwan_mapping.csv`) and reference ranges
 * (`lab_reference_ranges.csv`). Field mapping mirrors the Python loader
 * column-for-column so the loader golden-output diff matches.
 *
 * Run standalone:  node dist/loaders/loinc.js
 * (requires DATABASE_URL pointing directly at Postgres, bypassing pgBouncer.)
 */

import fs from "fs";
import path from "path";
import pg from "pg";
import { unzipSync } from "fflate";
import { config } from "../config.js";
import { logInfo, logError, configureLogLevel } from "../logger.js";

// Source-file locations. Mirror the Python loaders' `FHIR_CODE_DIR` default and
// the `config/datasets.yaml` layout; each path is individually overridable.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const FHIR_CODE_DIR = process.env.FHIR_CODE_DIR || path.join(REPO_ROOT, "fhir-code");
const LOINC_DIR = path.join(FHIR_CODE_DIR, "loinc");

const ZIP_PATH = process.env.LOINC_ZIP_PATH || path.join(LOINC_DIR, "2.80", "Loinc_2.80.zip");
const MAPPING_CSV_PATH = process.env.LOINC_MAPPING_CSV || path.join(LOINC_DIR, "taiwan_mapping.csv");
const RANGES_CSV_PATH =
  process.env.LOINC_RANGES_CSV || path.join(LOINC_DIR, "lab_reference_ranges.csv");

// Postgres caps a single statement at 65535 bind parameters; cap rows/batch so
// rows*ncols stays under that. Batch size does not affect the final data.
const PARAM_LIMIT = 60000;

/**
 * RFC 4180 CSV parser, matching Python's `csv.reader` defaults: double-quoted
 * fields, embedded commas/newlines inside quotes, and `""` → `"` escaping.
 * Returns an array of rows, each an array of string cells. A leading UTF-8 BOM
 * is stripped (mirrors `encoding="utf-8-sig"`).
 */
function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (c === "\r") {
      // Swallow CR; the following LF (or EOF) terminates the record.
      if (text[i + 1] === "\n") i += 2;
      else i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  // Flush a trailing field/row when the file does not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse CSV text into header-keyed records (mirrors `csv.DictReader`). */
function parseCsvDict(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const rec: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      rec[header[c]] = cells[c] ?? "";
    }
    out.push(rec);
  }
  return out;
}

/** Mirror Python `row.get(key, "").strip()` for an always-present column. */
function gs(row: Record<string, string>, key: string): string {
  return (row[key] ?? "").trim();
}

/**
 * Exact decimal expansion of a float64, matching what the Python loader stores
 * in a `numeric` column. asyncpg encodes a Python `float` as `Decimal(value)` —
 * the *exact* binary value of the IEEE-754 double — so `float("0.2")` lands in
 * the DB as `0.2000000000000000111...0625`, not `0.2`. We reproduce that by
 * sending range bounds as the exact-decimal string (node-postgres would
 * otherwise send the shortest round-trip form, `0.2`, breaking byte parity).
 */
function floatToExactNumeric(x: number): string {
  if (Number.isInteger(x)) return String(x);
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const negative = (hi >>> 31) === 1;
  let exp = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo >>> 0);
  if (exp === 0) {
    exp = -1074; // subnormal
  } else {
    mantissa |= 1n << 52n;
    exp -= 1075;
  }
  // value = mantissa * 2^exp. Reduce common factors of 2 so the result carries
  // the minimal scale, matching Python's Decimal(float) (e.g. 0.5 → "0.5", not
  // "0.5000…0"). With an odd mantissa, mantissa*5^k never ends in a zero digit.
  while (exp < 0 && (mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    exp += 1;
  }
  let out: string;
  if (exp >= 0) {
    out = (mantissa << BigInt(exp)).toString();
  } else {
    const k = -exp;
    // mantissa / 2^k = mantissa * 5^k / 10^k → exact decimal with k frac digits.
    let scaled = (mantissa * 5n ** BigInt(k)).toString();
    if (scaled.length <= k) scaled = "0".repeat(k - scaled.length + 1) + scaled;
    const intPart = scaled.slice(0, scaled.length - k);
    const fracPart = scaled.slice(scaled.length - k);
    out = `${intPart}.${fracPart}`;
  }
  return negative ? `-${out}` : out;
}

type Concept = (string | number)[];

// ── Staged-import payload (Node port of admin_jobs._build_loinc_stage_payload) ──
// Returns row tuples (rather than writing tables directly) so the admin worker
// can stage → promote them. The mapping CSV is pre-merged into the concept rows
// (indices 13–16: name_zh/common_name_zh/specimen_type/unit), exactly mirroring
// the Python stager — unlike the legacy direct-write loader which UPDATEs.

export interface LoincStagePayload {
  /** 17-col concept tuples (loinc_num … unit). */
  conceptRows: (string | number)[][];
  /** 8-col reference-range tuples (loinc_num, age_min, age_max, gender, range_low, range_high, unit, interpretation). */
  rangeRows: (string | number)[][];
  stats: { mapping_row_count: number; mapping_match_count: number };
}

/** Faithful port of `_build_loinc_stage_payload`. */
export function buildLoincStagePayload(
  loincZipPath: string,
  mappingCsvPath: string | null,
  rangesCsvPath: string | null,
): LoincStagePayload {
  const buf = new Uint8Array(fs.readFileSync(loincZipPath));
  let entries = unzipSync(buf, {
    filter: (file) => file.name.endsWith("Loinc.csv") && !file.name.includes("AccessoryFiles"),
  });
  let names = Object.keys(entries);
  if (names.length === 0) {
    entries = unzipSync(buf, { filter: (f) => f.name.endsWith("Loinc.csv") });
    names = Object.keys(entries);
    if (names.length === 0) throw new Error("Loinc.csv not found in ZIP");
  }
  const csvText = Buffer.from(entries[names[0]]).toString("utf-8");
  const rows = parseCsvDict(csvText);

  // Keyed by loinc_num, preserving CSV insertion order (mirrors Python dict).
  const conceptMap = new Map<string, (string | number)[]>();
  for (const row of rows) {
    const loincNum = gs(row, "LOINC_NUM");
    if (!loincNum) continue;
    let classtype = parseInt(row["CLASSTYPE"] ?? "", 10);
    if (Number.isNaN(classtype)) classtype = 0;
    conceptMap.set(loincNum, [
      loincNum,
      gs(row, "COMPONENT"),
      gs(row, "PROPERTY"),
      gs(row, "TIME_ASPCT"),
      gs(row, "SYSTEM"),
      gs(row, "SCALE_TYP"),
      gs(row, "METHOD_TYP"),
      gs(row, "LONG_COMMON_NAME"),
      gs(row, "SHORTNAME"),
      gs(row, "CLASS"),
      classtype,
      gs(row, "STATUS"),
      gs(row, "CONSUMER_NAME"),
      "", // name_zh
      "", // common_name_zh
      "", // specimen_type
      "", // unit
    ]);
  }

  let mappingRowCount = 0;
  let mappingMatchCount = 0;
  if (mappingCsvPath) {
    // _load_mapping_csv: raw DictReader values (no strip), keyed loinc_code.
    const mrows = parseCsvDict(fs.readFileSync(mappingCsvPath, "utf-8"));
    for (const m of mrows) {
      mappingRowCount += 1;
      const concept = conceptMap.get(m["loinc_code"]);
      if (concept) {
        mappingMatchCount += 1;
        concept[13] = m["name_zh"];
        concept[14] = m["common_name_zh"];
        concept[15] = m["specimen_type"];
        concept[16] = m["unit"];
      }
    }
    if (mappingRowCount === 0) {
      throw new Error(
        "LOINC Taiwan mapping CSV parsed 0 rows. Verify the uploaded CSV headers " +
          "include loinc_code, name_zh, common_name_zh, specimen_type, and unit.",
      );
    }
  }

  const conceptRows = [...conceptMap.values()];
  const conceptCodes = new Set(conceptMap.keys());

  let rangeRows: (string | number)[][] = [];
  if (rangesCsvPath) {
    // _load_ranges_csv: int(age_*) + float(range_*). The numeric stage columns
    // take exact-decimal strings (floatToExactNumeric) to reproduce asyncpg's
    // Decimal(float) byte-for-byte. Filter to codes present in concepts.
    const rrows = parseCsvDict(fs.readFileSync(rangesCsvPath, "utf-8"));
    rangeRows = rrows
      .map(
        (r) =>
          [
            r["loinc_code"],
            parseInt(r["age_min"], 10),
            parseInt(r["age_max"], 10),
            r["gender"],
            floatToExactNumeric(parseFloat(r["range_low"])),
            floatToExactNumeric(parseFloat(r["range_high"])),
            r["unit"],
            r["interpretation"],
          ] as (string | number)[],
      )
      .filter((r) => conceptCodes.has(r[0] as string));
  }

  return {
    conceptRows,
    rangeRows,
    stats: { mapping_row_count: mappingRowCount, mapping_match_count: mappingMatchCount },
  };
}

/** Faithful port of `load_loinc_full`. */
export async function loadLoincFull(pool: pg.Pool): Promise<void> {
  logInfo(`Parsing ${ZIP_PATH} ...`);

  const buf = new Uint8Array(fs.readFileSync(ZIP_PATH));
  const entries = unzipSync(buf, {
    filter: (file) =>
      file.name.endsWith("Loinc.csv") && !file.name.includes("AccessoryFiles"),
  });
  let names = Object.keys(entries);
  if (names.length === 0) {
    // Fallback: any Loinc.csv (re-unzip without the filter).
    const all = unzipSync(buf, { filter: (f) => f.name.endsWith("Loinc.csv") });
    names = Object.keys(all);
    if (names.length === 0) {
      logError("Loinc.csv not found in zip");
      return;
    }
    Object.assign(entries, all);
  }
  const loincFile = names[0];
  logInfo(`  Reading ${loincFile} ...`);
  const csvText = Buffer.from(entries[loincFile]).toString("utf-8");
  const rows = parseCsvDict(csvText);

  const records: Concept[] = [];
  for (const row of rows) {
    const loincNum = gs(row, "LOINC_NUM");
    if (!loincNum) continue;
    let classtype = parseInt(row["CLASSTYPE"] ?? "", 10);
    if (Number.isNaN(classtype)) classtype = 0;
    records.push([
      loincNum,
      gs(row, "COMPONENT"),
      gs(row, "PROPERTY"),
      gs(row, "TIME_ASPCT"),
      gs(row, "SYSTEM"),
      gs(row, "SCALE_TYP"),
      gs(row, "METHOD_TYP"),
      gs(row, "LONG_COMMON_NAME"),
      gs(row, "SHORTNAME"),
      gs(row, "CLASS"),
      classtype,
      gs(row, "STATUS"),
      gs(row, "CONSUMER_NAME"),
      "", // name_zh
      "", // common_name_zh
      "", // specimen_type
      "", // unit
    ]);
  }

  logInfo(`  Parsed ${records.length} LOINC concepts. Writing to DB ...`);

  const ncols = 17;
  const batchRows = Math.floor(PARAM_LIMIT / ncols);
  const client = await pool.connect();
  try {
    await client.query("TRUNCATE loinc.reference_ranges, loinc.concepts CASCADE");
    for (let i = 0; i < records.length; i += batchRows) {
      const slice = records.slice(i, i + batchRows);
      const values: string[] = [];
      const params: (string | number)[] = [];
      slice.forEach((rec, ri) => {
        const ph = rec.map((_, ci) => `$${ri * ncols + ci + 1}`);
        values.push(`(${ph.join(",")})`);
        params.push(...rec);
      });
      await client.query(
        `INSERT INTO loinc.concepts
           (loinc_num, component, property, time_aspect, system, scale_type, method_type,
            long_common_name, shortname, class, classtype, status, consumer_name,
            name_zh, common_name_zh, specimen_type, unit)
         VALUES ${values.join(",")}
         ON CONFLICT (loinc_num) DO UPDATE SET
           long_common_name=EXCLUDED.long_common_name, shortname=EXCLUDED.shortname,
           class=EXCLUDED.class, status=EXCLUDED.status`,
        params,
      );
    }
  } finally {
    client.release();
  }

  logInfo(`  LOINC loaded: ${records.length} concepts.`);

  await applyTaiwanSeed(pool);

  await pool.query(
    `INSERT INTO admin.module_load_log (module_key, last_loaded_at, row_count)
     VALUES ('loinc', NOW(), $1)
     ON CONFLICT (module_key) DO UPDATE SET last_loaded_at=NOW(), row_count=$1`,
    [records.length],
  );
}

/** Faithful port of `apply_taiwan_seed`. */
async function applyTaiwanSeed(pool: pg.Pool): Promise<void> {
  logInfo("  Applying Taiwan LOINC Chinese names ...");

  const mapping = parseCsvDict(fs.readFileSync(MAPPING_CSV_PATH, "utf-8"));
  const taiwanTests = mapping.map((row) => ({
    loincNum: row["loinc_code"],
    nameZh: row["name_zh"],
    commonNameZh: row["common_name_zh"],
    specimenType: row["specimen_type"],
    unit: row["unit"],
  }));

  const rangesRaw = parseCsvDict(fs.readFileSync(RANGES_CSV_PATH, "utf-8"));
  const referenceRanges = rangesRaw.map((row) => [
    row["loinc_code"],
    parseInt(row["age_min"], 10),
    parseInt(row["age_max"], 10),
    row["gender"],
    floatToExactNumeric(parseFloat(row["range_low"])),
    floatToExactNumeric(parseFloat(row["range_high"])),
    row["unit"],
    row["interpretation"],
  ]) as (string | number)[][];

  const client = await pool.connect();
  try {
    for (const t of taiwanTests) {
      await client.query(
        `UPDATE loinc.concepts
           SET name_zh=$2, common_name_zh=$3, specimen_type=$4, unit=$5
         WHERE loinc_num=$1`,
        [t.loincNum, t.nameZh, t.commonNameZh, t.specimenType, t.unit],
      );
    }

    logInfo("  Inserting Taiwan reference ranges ...");
    await client.query("TRUNCATE loinc.reference_ranges");
    // Only insert ranges for codes that exist in concepts (FK safety).
    const existingRes = await client.query("SELECT loinc_num FROM loinc.concepts");
    const existing = new Set(existingRes.rows.map((r) => r.loinc_num));
    const rangesToInsert = referenceRanges.filter((r) => existing.has(r[0] as string));
    const skipped = referenceRanges.length - rangesToInsert.length;
    if (skipped) {
      const missing = new Set(
        referenceRanges.filter((r) => !existing.has(r[0] as string)).map((r) => r[0]),
      );
      logError(
        `  WARNING: skipping ${skipped} range rows — LOINC codes not in concepts: ${[...missing].join(", ")}`,
      );
    }
    if (rangesToInsert.length) {
      const ncols = 8;
      const values: string[] = [];
      const params: (string | number)[] = [];
      rangesToInsert.forEach((rec, ri) => {
        const ph = rec.map((_, ci) => `$${ri * ncols + ci + 1}`);
        values.push(`(${ph.join(",")})`);
        params.push(...rec);
      });
      await client.query(
        `INSERT INTO loinc.reference_ranges
           (loinc_num, age_min, age_max, gender, range_low, range_high, unit, interpretation)
         VALUES ${values.join(",")}`,
        params,
      );
    }
    logInfo(
      `  Taiwan seed applied: ${taiwanTests.length} names, ${rangesToInsert.length} ranges.`,
    );
  } finally {
    client.release();
  }
}

/** CLI entry. */
async function main(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  try {
    await loadLoincFull(pool);
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("loinc.js");
if (invokedDirectly) {
  main().catch((err) => {
    logError("LOINC loader failed", { error: String((err as Error).message) });
    process.exit(1);
  });
}
