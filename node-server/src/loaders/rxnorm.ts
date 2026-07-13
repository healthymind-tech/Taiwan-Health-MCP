/**
 * RxNorm Full Release RRF parsing — concept-only (Node port of
 * `src/rxnorm_rrf.py`).
 *
 * Reads `RXNCONSO.RRF` from a `RxNorm_full_<date>.zip` and returns one concept
 * row per RXCUI (SAB=RXNORM, preferring the ISPREF=Y atom). Relationships
 * (`RXNREL.RRF`) are intentionally ignored — this terminology exists solely so
 * the admin preview can expand IG ValueSet TTY filters into real codes.
 *
 * RXNCONSO.RRF columns (0-indexed, pipe-delimited, no header):
 *    0  RXCUI    — concept unique identifier
 *    6  ISPREF   — Y when this atom is preferred for the RXCUI
 *   11  SAB      — source abbreviation (we keep SAB=RXNORM)
 *   12  TTY      — term type
 *   14  STR      — concept name
 *   16  SUPPRESS — suppression flag (N/O/Y/E)
 *
 * Run standalone:  node dist/loaders/rxnorm.js <RxNorm_full_*.zip>
 */

import fs from "fs";
import pg from "pg";
import { unzipSync, strFromU8 } from "fflate";
import { config } from "../config.js";
import { logInfo, logError, configureLogLevel } from "../logger.js";

const RXCUI = 0;
const ISPREF = 6;
const SAB = 11;
const TTY = 12;
const STR = 14;
const SUPPRESS = 16;
const MIN_COLS = 17;

/** (rxcui, name, tty, suppress) — suppress is null when empty. */
export type RxnormConceptRow = [number, string, string, string | null];

/**
 * Faithful port of `load_rxnorm_concepts`: parse RXNCONSO.RRF and return one row
 * per RXCUI (SAB=RXNORM). The preferred atom (ISPREF=Y) wins; otherwise the first
 * atom seen is kept. Row order follows first appearance of each RXCUI (mirrors the
 * insertion order of the Python dict).
 */
export function loadRxnormConcepts(zipPath: string): RxnormConceptRow[] {
  const buf = new Uint8Array(fs.readFileSync(zipPath));
  // Decompress only RXNCONSO.RRF — the sibling RRF files (RXNREL etc.) are huge
  // and unused, so filtering keeps memory bounded.
  const entries = unzipSync(buf, {
    filter: (f) => f.name.toLowerCase().endsWith("rxnconso.rrf"),
  });
  const names = Object.keys(entries);
  if (names.length === 0) throw new Error("RXNCONSO.RRF not found in RxNorm zip");
  const text = strFromU8(entries[names[0]]);

  const best = new Map<number, { row: RxnormConceptRow; isPref: boolean }>();
  const n = text.length;
  let start = 0;
  while (start < n) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = n;
    const line = text.slice(start, end); // mirrors rstrip("\n") (a trailing \r stays)
    start = end + 1;
    if (line.length === 0) continue;
    const cols = line.split("|");
    if (cols.length < MIN_COLS) continue;
    if (cols[SAB] !== "RXNORM") continue;
    const name = (cols[STR] ?? "").trim();
    if (!name) continue;
    const rxcuiRaw = (cols[RXCUI] ?? "").trim();
    // Mirror Python int(): accept an optional sign + digits only, else skip.
    if (!/^[+-]?\d+$/.test(rxcuiRaw)) continue;
    const rxcui = Number(rxcuiRaw);
    const isPref = cols[ISPREF] === "Y";
    const row: RxnormConceptRow = [
      rxcui,
      name,
      (cols[TTY] ?? "").trim(),
      (cols[SUPPRESS] ?? "").trim() || null,
    ];
    const existing = best.get(rxcui);
    if (existing === undefined || (isPref && !existing.isPref)) {
      // Updating an existing key preserves its insertion position (like dict).
      best.set(rxcui, { row, isPref });
    }
  }

  return [...best.values()].map((v) => v.row);
}

async function main(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  const zipPath = process.argv[2] || process.env.RXNORM_ZIP;
  if (!zipPath) {
    logError("usage: node dist/loaders/rxnorm.js <RxNorm_full_*.zip>");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  try {
    const rows = loadRxnormConcepts(zipPath);
    logInfo(`Parsed ${rows.length} RxNorm concepts. Writing to DB ...`);
    const client = await pool.connect();
    try {
      await client.query("TRUNCATE rxnorm.concepts");
      const ncols = 4;
      const batchRows = Math.floor(60000 / ncols);
      for (let i = 0; i < rows.length; i += batchRows) {
        const slice = rows.slice(i, i + batchRows);
        const values: string[] = [];
        const params: (string | number | null)[] = [];
        slice.forEach((rec, ri) => {
          values.push(`(${rec.map((_, ci) => `$${ri * ncols + ci + 1}`).join(",")})`);
          params.push(...rec);
        });
        await client.query(
          `INSERT INTO rxnorm.concepts (rxcui, name, tty, suppress) VALUES ${values.join(",")}
           ON CONFLICT (rxcui) DO UPDATE SET name=EXCLUDED.name, tty=EXCLUDED.tty, suppress=EXCLUDED.suppress`,
          params,
        );
      }
    } finally {
      client.release();
    }
    logInfo(`RxNorm loaded: ${rows.length} concepts.`);
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("rxnorm.js");
if (invokedDirectly) {
  main().catch((err) => {
    logError("RxNorm loader failed", { error: String((err as Error).message) });
    process.exit(1);
  });
}
