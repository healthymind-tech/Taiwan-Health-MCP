/**
 * LOINC 2.80 full loader (Node port of `loader/loaders/loinc_loader.py` plus
 * `loader/loaders/loinc_taiwan_seed.py`).
 *
 * Reads `Loinc_2.80.zip` (the root-level `LoincTable/Loinc.csv`), writes
 * `loinc.concepts`; the staged admin import additionally keeps the answer /
 * part / group codes of the AccessoryFiles (`loinc.other_codes`) and the
 * release version (`loinc.editions`) for the FHIR validator. Then applies the Taiwan
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
  // Trim surrounding whitespace from header names so lookups tolerate padded
  // columns in uploaded CSVs (the leading file BOM is already stripped by
  // parseCsv) — mirrors PR #25's header normalization on the Python side.
  const header = rows[0].map((h) => h.trim());
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

/** COMMON_TEST_RANK / COMMON_ORDER_RANK: a positive integer, or null (0 / blank = not ranked). */
export function loincRank(row: Record<string, string>, key: string): number | null {
  const n = parseInt(gs(row, key), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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

type Concept = (string | number | null)[];

// ── Staged-import payload (Node port of admin_jobs._build_loinc_stage_payload) ──
// Returns row tuples (rather than writing tables directly) so the admin worker
// can stage → promote them. The mapping CSV is pre-merged into the concept rows
// (indices 13–16: name_zh/common_name_zh/specimen_type/unit), exactly mirroring
// the Python stager — unlike the legacy direct-write loader which UPDATEs.

export interface LoincStagePayload {
  /** 19-col concept tuples (loinc_num … unit, common_test_rank, common_order_rank). */
  conceptRows: (string | number | null)[][];
  /** 8-col reference-range tuples (loinc_num, age_min, age_max, gender, range_low, range_high, unit, interpretation). */
  rangeRows: (string | number)[][];
  /** 5-col non-term code tuples (code, kind, display, alt_display, status) — see parseLoincOtherCodes. */
  otherCodeRows: (string | null)[][];
  /** Part links / answer lists / panels / MapTo (empty when the zip lacks those members). */
  structure: LoincStructureRows;
  /** LOINC release version ('2.80'): the highest VersionLastChanged in Loinc.csv. */
  version: string | null;
  stats: { mapping_row_count: number; mapping_match_count: number };
}

/** Compare dotted LOINC versions numerically ('2.9' < '2.10'). */
export function compareLoincVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Release version of a parsed Loinc.csv: the highest VersionLastChanged value. */
export function loincReleaseVersion(rows: Record<string, string>[]): string | null {
  let best: string | null = null;
  for (const row of rows) {
    const v = gs(row, "VersionLastChanged");
    if (!/^\d+\.\d+$/.test(v)) continue;
    if (best === null || compareLoincVersion(v, best) > 0) best = v;
  }
  return best;
}

/**
 * LOINC codes outside the term table (LoincTable/Loinc.csv), as tx.fhir.org
 * serves them in http://loinc.org:
 *  - LA answer codes        AnswerFile/AnswerList.csv  display = DisplayText
 *  - LL answer lists        AnswerFile/AnswerList.csv  display = AnswerListName
 *  - LP parts               PartFile/Part.csv          display = PartDisplayName, alt = PartName
 *  - LG groups              GroupFile/Group.csv        display = Group
 *  - LG parent groups       GroupFile/ParentGroup.csv  display = ParentGroup
 * First occurrence wins (AnswerList.csv repeats an answer once per list it
 * belongs to; DisplayText is identical across lists in 2.80).
 */
export function parseLoincOtherCodes(files: {
  answerList?: string | null;
  part?: string | null;
  group?: string | null;
  parentGroup?: string | null;
}): (string | null)[][] {
  const out = new Map<string, (string | null)[]>();
  const put = (code: string, kind: string, display: string, alt: string | null, status: string | null): void => {
    if (!code || out.has(code)) return;
    out.set(code, [code, kind, display || null, alt && alt !== display ? alt : null, status || null]);
  };
  if (files.answerList) {
    const rows = parseCsvDict(files.answerList);
    for (const r of rows) put(gs(r, "AnswerStringId"), "answer", gs(r, "DisplayText"), null, null);
    for (const r of rows) put(gs(r, "AnswerListId"), "answer_list", gs(r, "AnswerListName"), null, null);
  }
  if (files.part) {
    for (const r of parseCsvDict(files.part)) {
      put(gs(r, "PartNumber"), "part", gs(r, "PartDisplayName"), gs(r, "PartName"), gs(r, "Status"));
    }
  }
  if (files.parentGroup) {
    for (const r of parseCsvDict(files.parentGroup)) put(gs(r, "ParentGroupId"), "parent_group", gs(r, "ParentGroup"), null, gs(r, "Status"));
  }
  if (files.group) {
    for (const r of parseCsvDict(files.group)) put(gs(r, "GroupId"), "group", gs(r, "Group"), null, gs(r, "Status"));
  }
  return [...out.values()];
}

/**
 * Callback CSV row iterator (same RFC 4180 rules as `parseCsv`) for the large
 * AccessoryFiles (LoincPartLink_Primary.csv is ~111 MB): only one row's cells
 * are alive at a time, and unquoted / quoted runs are sliced, not built
 * char-by-char. A leading BOM is skipped.
 */
export function forEachCsvRow(text: string, onRow: (cells: string[], index: number) => void): void {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let index = 0;
  while (i < n) {
    const cells: string[] = [];
    // Parse one record.
    for (;;) {
      let field: string;
      if (text[i] === '"') {
        let out = "";
        let j = i + 1;
        for (;;) {
          const q = text.indexOf('"', j);
          if (q < 0) {
            out += text.slice(j);
            j = n;
            break;
          }
          out += text.slice(j, q);
          if (text[q + 1] === '"') {
            out += '"';
            j = q + 2;
          } else {
            j = q + 1;
            break;
          }
        }
        // Tolerate stray characters after a closing quote (csv.reader keeps them).
        let k = j;
        while (k < n && text[k] !== "," && text[k] !== "\n" && text[k] !== "\r") k += 1;
        field = out + text.slice(j, k);
        i = k;
      } else {
        let k = i;
        while (k < n && text[k] !== "," && text[k] !== "\n" && text[k] !== "\r") k += 1;
        field = text.slice(i, k);
        i = k;
      }
      cells.push(field);
      if (i < n && text[i] === ",") {
        i += 1;
        continue;
      }
      if (i < n && text[i] === "\r") i += 1;
      if (i < n && text[i] === "\n") i += 1;
      break;
    }
    onRow(cells, index);
    index += 1;
  }
}

/** Iterate data rows of a CSV, resolving the named columns to indexes once. */
function forEachCsvRecord(
  text: string,
  columns: string[],
  onRecord: (get: (col: string) => string) => void,
): void {
  let idx: Map<string, number> | null = null;
  let current: string[] = [];
  const get = (col: string): string => {
    const k = idx!.get(col);
    return k === undefined ? "" : (current[k] ?? "").trim();
  };
  forEachCsvRow(text, (cells, rowIndex) => {
    if (rowIndex === 0) {
      idx = new Map(cells.map((h, k) => [h.trim(), k] as [string, number]));
      const missing = columns.filter((c) => !idx!.has(c));
      if (missing.length) throw new Error(`CSV is missing column(s): ${missing.join(", ")}`);
      return;
    }
    if (cells.length === 1 && cells[0] === "") return; // blank line
    current = cells;
    onRecord(get);
  });
}

function intOrNull(v: string): number | null {
  if (!/^-?\d+$/.test(v)) return null;
  return Number.parseInt(v, 10);
}

/** LoincPartLink_Primary.csv → (loinc_num, part_type, part_number, part_name), deduped on the PK. */
export function parseLoincPartLinks(text: string): (string | null)[][] {
  const out = new Map<string, (string | null)[]>();
  forEachCsvRecord(text, ["LoincNumber", "PartNumber", "PartName", "PartTypeName"], (g) => {
    const linkType = g("LinkTypeName");
    if (linkType && linkType !== "Primary") return;
    const loinc = g("LoincNumber");
    const type = g("PartTypeName");
    const part = g("PartNumber");
    if (!loinc || !type || !part) return;
    const key = `${loinc}\u0000${type}\u0000${part}`;
    if (!out.has(key)) out.set(key, [loinc, type, part, g("PartName") || null]);
  });
  return [...out.values()];
}

/**
 * AnswerList.csv → answer list members (list_id, seq, answer_code, display, score).
 * Externally-defined lists carry no AnswerStringId and are skipped. First
 * occurrence of (list_id, answer_code) wins.
 */
export function parseLoincAnswerListItems(text: string): (string | number | null)[][] {
  const out = new Map<string, (string | number | null)[]>();
  forEachCsvRecord(text, ["AnswerListId", "AnswerStringId", "SequenceNumber", "DisplayText"], (g) => {
    const list = g("AnswerListId");
    const answer = g("AnswerStringId");
    if (!list || !answer) return;
    const key = `${list}\u0000${answer}`;
    if (!out.has(key)) out.set(key, [list, intOrNull(g("SequenceNumber")), answer, g("DisplayText") || null, g("Score") || null]);
  });
  return [...out.values()];
}

/** LoincAnswerListLink.csv → (loinc_num, list_id, link_type, context). */
export function parseLoincAnswerListLinks(text: string): (string | null)[][] {
  const out = new Map<string, (string | null)[]>();
  forEachCsvRecord(text, ["LoincNumber", "AnswerListId"], (g) => {
    const loinc = g("LoincNumber");
    const list = g("AnswerListId");
    if (!loinc || !list) return;
    const context = g("ApplicableContext");
    const key = `${loinc}\u0000${list}\u0000${context}`;
    if (!out.has(key)) out.set(key, [loinc, list, g("AnswerListLinkType") || null, context]);
  });
  return [...out.values()];
}

/**
 * PanelsAndForms.csv → panel membership (parent_loinc, seq, loinc_num, display, required).
 * ParentId is the row ID of the IMMEDIATE parent (a nested sub-panel's members
 * point at the sub-panel's row) and ParentLoinc is always that row's Loinc, so
 * ParentLoinc is the immediate parent panel. The panel's own row (ID ==
 * ParentId) is skipped. A sub-panel used in several panels lists its members
 * once per use; rows are deduped on (parent_loinc, loinc_num) keeping the
 * lowest SEQUENCE.
 */
export function parsePanelItems(text: string): (string | number | null)[][] {
  const out = new Map<string, (string | number | null)[]>();
  forEachCsvRecord(text, ["ParentId", "ParentLoinc", "ID", "SEQUENCE", "Loinc"], (g) => {
    const id = g("ID");
    if (id && id === g("ParentId")) return;
    const parent = g("ParentLoinc");
    const loinc = g("Loinc");
    if (!parent || !loinc || parent === loinc) return;
    const seq = intOrNull(g("SEQUENCE")) ?? 0;
    const key = `${parent}\u0000${loinc}`;
    const prev = out.get(key);
    if (prev && (prev[1] as number) <= seq) return;
    out.set(key, [parent, seq, loinc, g("DisplayNameForForm") || g("LoincName") || null, g("ObservationRequiredInPanel") || null]);
  });
  return [...out.values()];
}

/** MapTo.csv → (loinc_num, map_to, comment). */
export function parseLoincMapTo(text: string): (string | null)[][] {
  const out = new Map<string, (string | null)[]>();
  forEachCsvRecord(text, ["LOINC", "MAP_TO"], (g) => {
    const from = g("LOINC");
    const to = g("MAP_TO");
    if (!from || !to) return;
    const key = `${from}\u0000${to}`;
    if (!out.has(key)) out.set(key, [from, to, g("COMMENT") || null]);
  });
  return [...out.values()];
}

/** Row sets of the LOINC structure tables (see db/migrations/20261020_loinc_structure.sql). */
export interface LoincStructureRows {
  partLinkRows: (string | null)[][];
  answerListItemRows: (string | number | null)[][];
  answerListLinkRows: (string | null)[][];
  panelItemRows: (string | number | null)[][];
  mapToRows: (string | null)[][];
}

/**
 * Parse the structure members out of a LOINC release zip. Members absent from
 * the zip (older or trimmed releases) yield empty row sets. Each member is
 * decompressed, parsed and released before the next to bound peak memory.
 */
export function parseLoincStructure(buf: Uint8Array): LoincStructureRows {
  const pick = (re: RegExp): string | null => {
    const entries = unzipSync(buf, { filter: (f) => re.test(f.name) });
    const names = Object.keys(entries).sort();
    if (names.length === 0) return null;
    return Buffer.from(entries[names[0]]).toString("utf-8");
  };
  const parse = <T>(re: RegExp, fn: (text: string) => T[]): T[] => {
    const text = pick(re);
    return text ? fn(text) : [];
  };
  return {
    partLinkRows: parse(/(^|\/)PartFile\/LoincPartLink_Primary\.csv$/, parseLoincPartLinks),
    answerListItemRows: parse(/(^|\/)AnswerFile\/AnswerList\.csv$/, parseLoincAnswerListItems),
    answerListLinkRows: parse(/(^|\/)AnswerFile\/LoincAnswerListLink\.csv$/, parseLoincAnswerListLinks),
    panelItemRows: parse(/(^|\/)PanelsAndForms\/PanelsAndForms\.csv$/, parsePanelItems),
    mapToRows: parse(/(^|\/)LoincTable\/MapTo\.csv$/, parseLoincMapTo),
  };
}

/** SQL recording the loaded LOINC version (params: version, term_count, other_code_count). */
export const LOINC_EDITION_UPSERT_SQL = `
  INSERT INTO loinc.editions (code_system, version, term_count, other_code_count, loaded_at)
  VALUES ('loinc', $1, $2::integer, $3::integer, NOW())
  ON CONFLICT (code_system) DO UPDATE SET
    version = EXCLUDED.version, term_count = EXCLUDED.term_count,
    other_code_count = EXCLUDED.other_code_count, loaded_at = NOW()`;

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
  const version = loincReleaseVersion(rows);

  // Answer / part / group files (AccessoryFiles). Absent members simply yield
  // no rows (older or trimmed release zips).
  const accessory = unzipSync(buf, {
    filter: (f) => /AccessoryFiles\/(AnswerFile\/AnswerList|PartFile\/Part|GroupFile\/Group|GroupFile\/ParentGroup)\.csv$/.test(f.name),
  });
  const member = (re: RegExp): string | null => {
    const name = Object.keys(accessory).find((n) => re.test(n));
    return name ? Buffer.from(accessory[name]).toString("utf-8") : null;
  };
  const otherCodeRows = parseLoincOtherCodes({
    answerList: member(/AnswerFile\/AnswerList\.csv$/),
    part: member(/PartFile\/Part\.csv$/),
    group: member(/GroupFile\/Group\.csv$/),
    parentGroup: member(/GroupFile\/ParentGroup\.csv$/),
  });

  // Keyed by loinc_num, preserving CSV insertion order (mirrors Python dict).
  const conceptMap = new Map<string, (string | number | null)[]>();
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
      loincRank(row, "COMMON_TEST_RANK"),
      loincRank(row, "COMMON_ORDER_RANK"),
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
        // Optional Taiwan columns may be absent from the uploaded CSV; default
        // to "" so a missing specimen_type/unit column never stages `undefined`
        // (JS returns undefined for an absent key rather than throwing — cf.
        // PR #25, which fixed the equivalent Python `KeyError` crash).
        concept[13] = m["name_zh"] ?? "";
        concept[14] = m["common_name_zh"] ?? "";
        concept[15] = m["specimen_type"] ?? "";
        concept[16] = m["unit"] ?? "";
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

  const structure = parseLoincStructure(buf);

  return {
    conceptRows,
    rangeRows,
    otherCodeRows,
    structure,
    version,
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
      loincRank(row, "COMMON_TEST_RANK"),
      loincRank(row, "COMMON_ORDER_RANK"),
    ]);
  }

  logInfo(`  Parsed ${records.length} LOINC concepts. Writing to DB ...`);

  const ncols = 19;
  const batchRows = Math.floor(PARAM_LIMIT / ncols);
  const client = await pool.connect();
  try {
    await client.query("TRUNCATE loinc.reference_ranges, loinc.concepts CASCADE");
    for (let i = 0; i < records.length; i += batchRows) {
      const slice = records.slice(i, i + batchRows);
      const values: string[] = [];
      const params: (string | number | null)[] = [];
      slice.forEach((rec, ri) => {
        const ph = rec.map((_, ci) => `$${ri * ncols + ci + 1}`);
        values.push(`(${ph.join(",")})`);
        params.push(...rec);
      });
      await client.query(
        `INSERT INTO loinc.concepts
           (loinc_num, component, property, time_aspect, system, scale_type, method_type,
            long_common_name, shortname, class, classtype, status, consumer_name,
            name_zh, common_name_zh, specimen_type, unit, common_test_rank, common_order_rank)
         VALUES ${values.join(",")}
         ON CONFLICT (loinc_num) DO UPDATE SET
           long_common_name=EXCLUDED.long_common_name, shortname=EXCLUDED.shortname,
           class=EXCLUDED.class, status=EXCLUDED.status,
           common_test_rank=EXCLUDED.common_test_rank, common_order_rank=EXCLUDED.common_order_rank`,
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
