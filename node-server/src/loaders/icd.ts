/**
 * ICD-10-CM / ICD-10-PCS 2025 loader (Node port of `loader/loaders/icd_loader.py`
 * plus the `load_icd` wiring in `loader/main.py`).
 *
 *   - ICD-10-CM: parse the NLM tabular XML (`icd-10-cm-tabular-2025.xml`) inside
 *     `icd10cm-table-index-2025.zip` → `icd.diagnoses`.
 *   - ICD-10-PCS: parse the flat CMS codes TXT inside `icd10pcs_tables_2025.zip`
 *     → `icd.procedures`.
 *   - Chinese names: parse the Taiwan MOHW bilingual XLSX (sheets "ICD-10-CM" and
 *     "ICD-10-PCS", col A = code, col D = 中文名稱).
 *
 * Field mapping mirrors the Python loader so the loader golden-output diff
 * matches. A minimal XML tree parser and a minimal XLSX reader are implemented
 * here to avoid extra dependencies (fflate handles the zip containers).
 *
 * Run standalone:  node dist/loaders/icd.js
 * (requires DATABASE_URL pointing directly at Postgres, bypassing pgBouncer.)
 */

import fs from "fs";
import path from "path";
import pg from "pg";
import { unzipSync, strFromU8 } from "fflate";
import { config } from "../config.js";
import { logInfo, logError, configureLogLevel } from "../logger.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const FHIR_CODE_DIR = process.env.FHIR_CODE_DIR || path.join(REPO_ROOT, "fhir-code");
const ICD_DIR = path.join(FHIR_CODE_DIR, "icd", "10");

const CM_ZIP =
  process.env.ICD_CM_ZIP || path.join(ICD_DIR, "icd10cm", "icd10cm-table-index-2025.zip");
const PCS_ZIP_GLOB_DIR = path.join(ICD_DIR, "icd10pcs");
const XLSX_GLOB_DIR = ICD_DIR;

const PARAM_LIMIT = 60000;

// ── Entity decoding ─────────────────────────────────────────────────────────

/**
 * XML 1.0 line-end normalization: a conforming parser translates `\r\n` and a
 * lone `\r` to a single `\n` before the application sees the text. ElementTree
 * and openpyxl both do this, so a multi-line cell stored as CRLF (e.g. ICD code
 * Z53's Chinese name) must collapse to LF to match. Applied to raw character
 * data *before* entity expansion (encoded `&#13;` is preserved).
 */
function normalizeEol(s: string): string {
  return s.indexOf("\r") < 0 ? s : s.replace(/\r\n?/g, "\n");
}

function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        if (body[0] === "#") {
          const code =
            body[1] === "x" || body[1] === "X"
              ? parseInt(body.slice(2), 16)
              : parseInt(body.slice(1), 10);
          return Number.isNaN(code) ? m : String.fromCodePoint(code);
        }
        return m;
    }
  });
}

// ── Minimal XML tree parser ─────────────────────────────────────────────────
// Mirrors the subset of ElementTree we need: `.text` is the text before the
// first child element; `find` returns the first direct child of a tag;
// `findall` returns all direct children of a tag; `iter` walks all descendants
// (incl. self) with a tag.

interface XmlNode {
  tag: string;
  children: XmlNode[];
  text: string;
}

function parseXml(s: string): XmlNode {
  const root: XmlNode = { tag: "#root", children: [], text: "" };
  const stack: XmlNode[] = [root];
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (s[i] === "<") {
      if (s.startsWith("<!--", i)) {
        const e = s.indexOf("-->", i);
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (s.startsWith("<![CDATA[", i)) {
        const e = s.indexOf("]]>", i);
        const cur = stack[stack.length - 1];
        if (cur.children.length === 0) cur.text += normalizeEol(s.slice(i + 9, e < 0 ? n : e));
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (s.startsWith("<?", i)) {
        const e = s.indexOf("?>", i);
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (s.startsWith("<!", i)) {
        const e = s.indexOf(">", i);
        i = e < 0 ? n : e + 1;
        continue;
      }
      if (s[i + 1] === "/") {
        const e = s.indexOf(">", i);
        stack.pop();
        i = e < 0 ? n : e + 1;
        continue;
      }
      // Open tag.
      const e = s.indexOf(">", i);
      let body = s.slice(i + 1, e < 0 ? n : e);
      const selfClose = body.endsWith("/");
      if (selfClose) body = body.slice(0, -1);
      const sp = body.search(/[\s/]/);
      const tag = sp < 0 ? body : body.slice(0, sp);
      const node: XmlNode = { tag, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
      i = e < 0 ? n : e + 1;
    } else {
      const e = s.indexOf("<", i);
      const end = e < 0 ? n : e;
      const cur = stack[stack.length - 1];
      // ElementTree `.text`: only the text before the first child element.
      if (cur.children.length === 0) cur.text += decodeEntities(normalizeEol(s.slice(i, end)));
      i = end;
    }
  }
  return root.children[0];
}

function find(node: XmlNode, tag: string): XmlNode | null {
  for (const c of node.children) if (c.tag === tag) return c;
  return null;
}

function findall(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((c) => c.tag === tag);
}

function* iter(node: XmlNode, tag: string): Generator<XmlNode> {
  if (node.tag === tag) yield node;
  for (const c of node.children) yield* iter(c, tag);
}

// ── Minimal XLSX reader ─────────────────────────────────────────────────────

interface Xlsx {
  entries: Record<string, Uint8Array>;
  sharedStrings: string[];
}

function openXlsx(buf: Uint8Array): Xlsx {
  const entries = unzipSync(buf);
  const ssRaw = entries["xl/sharedStrings.xml"];
  const sharedStrings: string[] = [];
  if (ssRaw) {
    const xml = strFromU8(ssRaw);
    let pos = 0;
    while (true) {
      const start = xml.indexOf("<si>", pos);
      if (start < 0) break;
      const end = xml.indexOf("</si>", start);
      if (end < 0) break;
      const block = xml.slice(start + 4, end);
      // openpyxl concatenates every <t> within an <si> (rich-text runs).
      let text = "";
      const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(block))) text += decodeEntities(normalizeEol(m[1]));
      sharedStrings.push(text);
      pos = end + 5;
    }
  }
  return { entries, sharedStrings };
}

/** Map a sheet display name to its worksheet XML path via workbook + rels. */
function sheetPath(xlsx: Xlsx, sheetName: string): string | null {
  const wb = strFromU8(xlsx.entries["xl/workbook.xml"] || new Uint8Array());
  const rels = strFromU8(xlsx.entries["xl/_rels/workbook.xml.rels"] || new Uint8Array());
  const sheetRe = /<sheet\s[^>]*\/>/g;
  let rid: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = sheetRe.exec(wb))) {
    const tag = m[0];
    const nameM = /\bname="([^"]*)"/.exec(tag);
    const ridM = /\br:id="([^"]*)"/.exec(tag);
    if (nameM && nameM[1] === sheetName && ridM) {
      rid = ridM[1];
      break;
    }
  }
  if (!rid) return null;
  const relRe = /<Relationship\s[^>]*\/>/g;
  while ((m = relRe.exec(rels))) {
    const tag = m[0];
    const idM = /\bId="([^"]*)"/.exec(tag);
    const tgtM = /\bTarget="([^"]*)"/.exec(tag);
    if (idM && idM[1] === rid && tgtM) {
      let target = tgtM[1];
      if (target.startsWith("/")) return target.slice(1);
      return "xl/" + target.replace(/^\.\//, "");
    }
  }
  return null;
}

function colIndex(ref: string): number {
  // "A1" → 0, "D2" → 3, "AA10" → 26.
  let idx = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const ch = ref.charCodeAt(i);
    if (ch >= 65 && ch <= 90) idx = idx * 26 + (ch - 64);
    else break;
  }
  return idx - 1;
}

/**
 * Read a worksheet into an ordered list of rows, each a sparse map of
 * column-index → string value. Only string-typed cells (shared / inline / str)
 * yield a value — numeric/boolean/date cells are omitted (Python's
 * `isinstance(..., str)` guard would reject them anyway).
 */
function readSheetRows(xml: string, sharedStrings: string[]): Map<number, string>[] {
  const rows: Map<number, string>[] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    const rowBody = rm[1];
    const cells = new Map<number, string>();
    let cm: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rowBody))) {
      const attrs = cm[1];
      const inner = cm[2] ?? "";
      const rM = /\br="([^"]*)"/.exec(attrs);
      if (!rM) continue;
      const col = colIndex(rM[1]);
      const tM = /\bt="([^"]*)"/.exec(attrs);
      const t = tM ? tM[1] : "";
      if (t === "s") {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vM) {
          const sIdx = parseInt(vM[1], 10);
          if (!Number.isNaN(sIdx) && sIdx < sharedStrings.length) {
            cells.set(col, sharedStrings[sIdx]);
          }
        }
      } else if (t === "str") {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vM) cells.set(col, decodeEntities(normalizeEol(vM[1])));
      } else if (t === "inlineStr") {
        let text = "";
        const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(inner))) text += decodeEntities(normalizeEol(m[1]));
        cells.set(col, text);
      }
      // numeric / boolean / date cells: omitted (non-string).
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Parse the Taiwan MOHW bilingual XLSX. Returns `{cmZh, pcsZh}` mapping ICD code
 * → Chinese name, mirroring `parse_icd_chinese_xlsx`.
 */
function parseIcdChineseXlsx(xlsxPath: string): {
  cmZh: Map<string, string>;
  pcsZh: Map<string, string>;
} {
  logInfo(`  Parsing Chinese names from ${path.basename(xlsxPath)} ...`);
  const xlsx = openXlsx(new Uint8Array(fs.readFileSync(xlsxPath)));

  const readSheet = (sheetName: string): Map<string, string> => {
    const sp = sheetPath(xlsx, sheetName);
    const result = new Map<string, string>();
    if (!sp || !xlsx.entries[sp]) {
      logError(`  WARNING: sheet '${sheetName}' not found in xlsx`);
      return result;
    }
    const rows = readSheetRows(strFromU8(xlsx.entries[sp]), xlsx.sharedStrings);
    let headerSkipped = false;
    for (const row of rows) {
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }
      const code = row.get(0);
      const nameZh = row.get(3);
      // Both must be present non-empty strings (mirrors the isinstance guard).
      if (code && nameZh) {
        result.set(code.trim(), nameZh.trim());
      }
    }
    return result;
  };

  const cmZh = readSheet("ICD-10-CM");
  const pcsZh = readSheet("ICD-10-PCS");
  logInfo(`  Chinese names loaded: ${cmZh.size} CM, ${pcsZh.size} PCS`);
  return { cmZh, pcsZh };
}

// ── ICD-10-CM tabular XML walk ──────────────────────────────────────────────

function* walkDiag(node: XmlNode): Generator<[string, string]> {
  const nameNode = find(node, "name");
  const descNode = find(node, "desc");
  if (nameNode && descNode) {
    const code = (nameNode.text || "").trim();
    const desc = (descNode.text || "").trim();
    if (code && /^[A-Z]\d/.test(code)) yield [code, desc];
  }
  for (const child of findall(node, "diag")) yield* walkDiag(child);
}

function parseTabularXml(xmlText: string): [string, string][] {
  const root = parseXml(xmlText);
  const out: [string, string][] = [];
  for (const chapter of iter(root, "chapter")) {
    const sections = findall(chapter, "section");
    const secs = sections.length ? sections : [chapter];
    for (const section of secs) {
      for (const diag of findall(section, "diag")) {
        for (const rec of walkDiag(diag)) out.push(rec);
      }
    }
  }
  return out;
}

// ── DB write helper ─────────────────────────────────────────────────────────

async function batchInsert(
  client: pg.PoolClient,
  sqlHead: string,
  sqlTail: string,
  ncols: number,
  rows: string[][],
): Promise<void> {
  const batchRows = Math.floor(PARAM_LIMIT / ncols);
  for (let i = 0; i < rows.length; i += batchRows) {
    const slice = rows.slice(i, i + batchRows);
    const values: string[] = [];
    const params: string[] = [];
    slice.forEach((rec, ri) => {
      const ph = rec.map((_, ci) => `$${ri * ncols + ci + 1}`);
      values.push(`(${ph.join(",")})`);
      params.push(...rec);
    });
    await client.query(`${sqlHead} VALUES ${values.join(",")} ${sqlTail}`, params);
  }
}

// ── ICD-10-CM ───────────────────────────────────────────────────────────────

export async function loadIcd10cm(
  pool: pg.Pool,
  zipPath: string,
  zh: Map<string, string>,
): Promise<void> {
  logInfo(`Parsing ${zipPath} ...`);
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)), {
    filter: (f) => {
      const n = f.name.toLowerCase();
      return (
        (n.endsWith(".xml") && n.includes("tabular")) ||
        (n.endsWith(".txt") && n.includes("order"))
      );
    },
  });
  const names = Object.keys(entries);
  const xmlFiles = names.filter(
    (n) => n.toLowerCase().endsWith(".xml") && n.toLowerCase().includes("tabular"),
  );
  const txtFiles = names.filter(
    (n) => n.toLowerCase().endsWith(".txt") && n.toLowerCase().includes("order"),
  );

  const records: string[][] = [];
  if (xmlFiles.length) {
    logInfo(`  Using XML: ${xmlFiles[0]}`);
    const xmlText = Buffer.from(entries[xmlFiles[0]]).toString("utf-8");
    for (const [code, nameEn] of parseTabularXml(xmlText)) {
      records.push([code, nameEn, zh.get(code) ?? "", code.slice(0, 3)]);
    }
  } else if (txtFiles.length) {
    logInfo(`  Using TXT: ${txtFiles[0]}`);
    const text = Buffer.from(entries[txtFiles[0]]).toString("utf-8");
    for (const line of text.split(/\r?\n/)) {
      if (line.length < 77) continue;
      const code = line.slice(6, 13).trim();
      const isHeader = line[14] ? line[14].trim() : "";
      if (isHeader === "1") continue;
      const longDesc = line.slice(77).trim();
      if (code && /^[A-Z]\d/.test(code)) {
        records.push([code, longDesc, zh.get(code) ?? "", code.slice(0, 3)]);
      }
    }
  } else {
    logError(`  ERROR: No usable file found in ${zipPath}. Contents: ${names}`);
    return;
  }

  const matched = records.filter((r) => r[2]).length;
  logInfo(
    `  Parsed ${records.length} ICD-10-CM diagnoses (${matched} with Chinese names). Writing to DB ...`,
  );

  const client = await pool.connect();
  try {
    await client.query("TRUNCATE icd.diagnoses");
    await batchInsert(
      client,
      "INSERT INTO icd.diagnoses (code, name_en, name_zh, category)",
      "ON CONFLICT (code) DO UPDATE SET name_en=EXCLUDED.name_en, name_zh=EXCLUDED.name_zh, category=EXCLUDED.category",
      4,
      records,
    );
  } finally {
    client.release();
  }
  logInfo(`  ICD-10-CM loaded: ${records.length} rows.`);

  await pool.query(
    `INSERT INTO admin.module_load_log (module_key, last_loaded_at, row_count)
     VALUES ('icd', NOW(), $1)
     ON CONFLICT (module_key) DO UPDATE SET last_loaded_at=NOW(), row_count=$1`,
    [records.length],
  );
}

// ── ICD-10-PCS ──────────────────────────────────────────────────────────────

export async function loadIcd10pcs(
  pool: pg.Pool,
  zipPath: string,
  zh: Map<string, string>,
): Promise<void> {
  logInfo(`Parsing ${zipPath} ...`);
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const names = Object.keys(entries);
  let codesFiles = names.filter((n) => {
    const lo = n.toLowerCase();
    return (
      lo.endsWith(".txt") &&
      !lo.includes("addenda") &&
      (lo.includes("codes") || lo.includes("pcs"))
    );
  });
  if (!codesFiles.length) {
    codesFiles = names.filter(
      (n) => n.toLowerCase().endsWith(".txt") && !n.toLowerCase().includes("addenda"),
    );
  }
  if (!codesFiles.length) {
    logError(`  ERROR: No usable PCS file found. Contents: ${names}`);
    return;
  }
  logInfo(`  Using: ${codesFiles[0]}`);
  const data = Buffer.from(entries[codesFiles[0]]).toString("utf-8");
  const records: string[][] = [];
  for (let line of data.split(/\r?\n/)) {
    line = line.replace(/\s+$/, ""); // rstrip
    if (line.length < 9) continue;
    const code = line.slice(0, 7).trim();
    const desc = line.slice(8).trim();
    if (code && code.length === 7 && desc) {
      records.push([code, desc, zh.get(code) ?? ""]);
    }
  }

  const matched = records.filter((r) => r[2]).length;
  logInfo(
    `  Parsed ${records.length} ICD-10-PCS procedures (${matched} with Chinese names). Writing to DB ...`,
  );

  const client = await pool.connect();
  try {
    await client.query("TRUNCATE icd.procedures");
    await batchInsert(
      client,
      "INSERT INTO icd.procedures (code, name_en, name_zh)",
      "ON CONFLICT (code) DO UPDATE SET name_en=EXCLUDED.name_en, name_zh=EXCLUDED.name_zh",
      3,
      records,
    );
  } finally {
    client.release();
  }
  logInfo(`  ICD-10-PCS loaded: ${records.length} rows.`);
}

// ── Orchestration (mirrors loader/main.py:load_icd) ─────────────────────────

function firstGlob(dir: string, test: (name: string) => boolean): string | null {
  if (!fs.existsSync(dir)) return null;
  const matches = fs.readdirSync(dir).filter(test).sort();
  return matches.length ? path.join(dir, matches[0]) : null;
}

export async function loadIcd(pool: pg.Pool): Promise<void> {
  const xlsxPath =
    process.env.ICD_XLSX ||
    firstGlob(XLSX_GLOB_DIR, (n) => n.toLowerCase().endsWith(".xlsx"));
  let cmZh = new Map<string, string>();
  let pcsZh = new Map<string, string>();
  if (xlsxPath && fs.existsSync(xlsxPath)) {
    ({ cmZh, pcsZh } = parseIcdChineseXlsx(xlsxPath));
  } else {
    logInfo("  No Taiwan ICD bilingual XLSX resolved — loading English-only.");
  }

  if (fs.existsSync(CM_ZIP)) {
    await loadIcd10cm(pool, CM_ZIP, cmZh);
  } else {
    logError(`  ICD-10-CM zip not found: ${CM_ZIP}`);
  }

  const pcsZip =
    process.env.ICD_PCS_ZIP ||
    firstGlob(PCS_ZIP_GLOB_DIR, (n) => n.toLowerCase().endsWith(".zip"));
  if (pcsZip && fs.existsSync(pcsZip)) {
    await loadIcd10pcs(pool, pcsZip, pcsZh);
  } else {
    logError(`  ICD-10-PCS zip not found in ${PCS_ZIP_GLOB_DIR}`);
  }
}

async function main(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  try {
    await loadIcd(pool);
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("icd.js");
if (invokedDirectly) {
  main().catch((err) => {
    logError("ICD loader failed", { error: String((err as Error).message) });
    process.exit(1);
  });
}
