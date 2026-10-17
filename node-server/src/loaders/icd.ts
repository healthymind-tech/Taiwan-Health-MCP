/**
 * ICD-10-CM / ICD-10-PCS loader (Node port of `loader/loaders/icd_loader.py`
 * plus the `load_icd` wiring in `loader/main.py`).
 *
 *   - ICD-10-CM: the complete code set (headers + billable codes incl. 7th
 *     characters) from either the CMS "Code Descriptions in Tabular Order" zip
 *     (`icd10cm_order_YYYY.txt`, preferred) or the "Code Tables, Tabular and
 *     Index" zip (`icd10cm_tabular_YYYY.xml`, 7th characters expanded)
 *     → `icd.diagnoses`, edition recorded in `icd.editions`.
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

const CM_DIR = path.join(ICD_DIR, "icd10cm");
/** Pre-2026-10 default; still used when nothing else is found in CM_DIR. */
const LEGACY_CM_ZIP = path.join(CM_DIR, "icd10cm-table-index-2025.zip");
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
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function parseAttrs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

function parseXml(s: string): XmlNode {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
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
      const node: XmlNode = { tag, attrs: sp < 0 ? {} : parseAttrs(body.slice(sp)), children: [], text: "" };
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

// ── ICD-10-CM release parsing ───────────────────────────────────────────────
//
// The complete ICD-10-CM code set (what tx.fhir.org serves as
// http://hl7.org/fhir/sid/icd-10-cm, e.g. version '2026-04-01') is every code
// of the CMS "Code Descriptions in Tabular Order" file: header (non-billable)
// codes such as S93.41 / S93.411 plus billable codes, including codes that
// carry a 7th character (S93.411A) and the placeholder X (S06.0X0A, T36.0X1A).
// The tabular XML lists the same codes except the 7th-character ones, which
// are only defined by `sevenChrDef` blocks on an ancestor; `expandTabular`
// generates them the way the CMS order file spells them.

/** One ICD-10-CM concept parsed from a CMS release. */
export interface Icd10cmCode {
  /** Dotted code as used in FHIR (`S93.411A`). */
  code: string;
  /** Long description (tx.fhir.org display). */
  nameEn: string;
  /** CMS short description (tx.fhir.org synonym designation); "" when unknown. */
  shortNameEn: string;
  /** Non-billable header code (category / subcategory). */
  isHeader: boolean;
}

/** Below this row count a parsed ICD-10-CM table is never treated as complete. */
export const ICD10CM_COMPLETE_MIN_ROWS = 90_000;

/** Insert the ICD-10-CM dot after the 3-character category (`S93411A` → `S93.411A`). */
export function dottedIcd10cm(raw: string): string {
  const c = raw.trim().toUpperCase();
  return c.length > 3 && !c.includes(".") ? `${c.slice(0, 3)}.${c.slice(3)}` : c;
}

/**
 * Parse the CMS order file (`icd10cm_order_YYYY.txt`), fixed width:
 * cols 1-5 order number, 7-13 code (no dot), 15 header flag (0 = header,
 * 1 = valid for HIPAA transactions), 17-76 short description, 78- long
 * description. Every row is kept (headers are valid concepts at tx.fhir.org).
 */
export function parseCmsOrderTxt(text: string): Icd10cmCode[] {
  const out: Icd10cmCode[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 16) continue;
    const raw = line.slice(6, 13).trim();
    // Category = letter + 2 alphanumerics (QA0 since April 2026), then up to 4.
    if (!/^[A-Z][0-9A-Z]{2,6}$/.test(raw)) continue;
    const flag = line[14];
    if (flag !== "0" && flag !== "1") continue;
    const shortName = line.slice(16, 76).trim();
    const longName = line.slice(77).trim() || shortName;
    out.push({ code: dottedIcd10cm(raw), nameEn: longName, shortNameEn: shortName, isHeader: flag === "0" });
  }
  return out;
}

/**
 * The tabular XML spells eponyms with diacritics ("Sézary disease") where the
 * CMS order file — and therefore tx.fhir.org — uses ASCII ("Sezary disease").
 * The folded form is kept as the alternative display; "" when identical.
 */
function asciiFold(s: string): string {
  const folded = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return folded === s ? "" : folded;
}

/**
 * Walk the tabular XML (`icd10cm_tabular_YYYY.xml`), expanding 7th characters:
 * a `sevenChrDef` applies to every leaf code below the diag that declares it
 * (the nearest declaration wins); the leaf is padded with the placeholder X to
 * six characters and each extension character appended, with the description
 * "<leaf description>, <extension text>" (the CMS long-title convention).
 * A leaf that receives 7th characters becomes a header itself. This is an
 * approximation: tabular notes that restrict 7th characters for some codes
 * (e.g. S06.1X7 / S06.1X8 take only "A") are prose, so a handful of generated
 * codes do not exist in the order file — the result is never marked complete.
 */
export function expandTabular(xmlText: string): { codes: Icd10cmCode[]; sevenChrDefs: number; version: string } {
  const root = parseXml(xmlText);
  const codes: Icd10cmCode[] = [];
  let sevenChrDefs = 0;
  const readSeven = (node: XmlNode): Array<[string, string]> | null => {
    const def = find(node, "sevenChrDef");
    if (!def) return null;
    sevenChrDefs += 1;
    return findall(def, "extension")
      .map((e): [string, string] => [(e.attrs.char || "").trim().toUpperCase(), (e.text || "").trim()])
      .filter(([c]) => /^[0-9A-Z]$/.test(c));
  };
  const walk = (node: XmlNode, inherited: Array<[string, string]> | null): void => {
    const seven = readSeven(node) ?? inherited;
    const nameNode = find(node, "name");
    const descNode = find(node, "desc");
    const children = findall(node, "diag");
    const code = nameNode ? (nameNode.text || "").trim().toUpperCase() : "";
    if (code && /^[A-Z][0-9A-Z]{2}(\.[0-9A-Z]{1,4})?$/.test(code)) {
      const desc = descNode ? (descNode.text || "").trim() : "";
      const expand = children.length === 0 && seven !== null && seven.length > 0;
      codes.push({ code, nameEn: desc, shortNameEn: asciiFold(desc), isHeader: children.length > 0 || expand });
      if (expand) {
        const base = code.replace(".", "").padEnd(6, "X");
        for (const [ch, text] of seven!) {
          const name = text ? `${desc}, ${text}` : desc;
          codes.push({ code: dottedIcd10cm(base + ch), nameEn: name, shortNameEn: asciiFold(name), isHeader: false });
        }
      }
    }
    for (const child of children) walk(child, seven);
  };
  for (const chapter of iter(root, "chapter")) {
    const sections = findall(chapter, "section");
    const secs = sections.length ? sections : [chapter];
    for (const section of secs) for (const diag of findall(section, "diag")) walk(diag, null);
  }
  const versionNode = find(root, "version");
  return { codes, sevenChrDefs, version: versionNode ? (versionNode.text || "").trim() : "" };
}

const MONTHS: Record<string, string> = { january: "01", april: "04", july: "07", october: "10" };

/**
 * Edition label of a CMS ICD-10-CM release. The CMS archive names carry the
 * effective date of interim updates ("april-1-2026-code-descriptions-…zip"),
 * which is how tx.fhir.org labels the version ('2026-04-01'); otherwise the
 * fiscal year of the inner file ("icd10cm_order_2026.txt" → "FY2026").
 */
export function icd10cmEdition(archiveName: string, innerNames: string[], xmlVersion = ""): string {
  const base = path.basename(archiveName).toLowerCase();
  const dated = /(january|april|july|october)[-_ ]?0?1[-_, ]+(\d{4})/.exec(base);
  if (dated) return `${dated[2]}-${MONTHS[dated[1]]}-01`;
  for (const n of [...innerNames, base]) {
    const m = /icd-?10-?cm[-_a-z]*?[-_](\d{4})\b/i.exec(path.basename(n));
    if (m) return `FY${m[1]}`;
  }
  return /^\d{4}$/.test(xmlVersion) ? `FY${xmlVersion}` : "unknown";
}

/** A parsed ICD-10-CM release: stage rows plus edition metadata. */
export interface Icd10cmRelease {
  /** [code, name_en, name_zh, category, short_name_en, is_header] */
  records: string[][];
  edition: string;
  sourceFormat: "cms-order" | "tabular-xml";
  /** Exact CMS code set (order file: headers + billable codes incl. 7th characters), above the row threshold. */
  complete: boolean;
}

/**
 * Parse an uploaded ICD-10-CM archive. Accepts the CMS "Code Descriptions in
 * Tabular Order" zip (order TXT — preferred, carries short titles) or the
 * "Code Tables, Tabular and Index" zip (tabular XML, 7th characters expanded).
 * Duplicate codes keep the first occurrence.
 */
export function parseIcd10cmRelease(zipPath: string, nameZhMap: Map<string, string>): Icd10cmRelease {
  const allNames: string[] = [];
  const isOrder = (n: string): boolean => {
    const lo = path.basename(n).toLowerCase();
    return lo.endsWith(".txt") && lo.includes("order") && !lo.includes("addenda");
  };
  const isTabular = (n: string): boolean => {
    const lo = path.basename(n).toLowerCase();
    return lo.endsWith(".xml") && lo.includes("tabular");
  };
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)), {
    filter: (f) => {
      allNames.push(f.name);
      return isOrder(f.name) || isTabular(f.name);
    },
  });
  const orderFiles = allNames.filter(isOrder).sort();
  const xmlFiles = allNames.filter(isTabular).sort();
  let codes: Icd10cmCode[];
  let sourceFormat: Icd10cmRelease["sourceFormat"];
  let xmlVersion = "";
  let expanded = true;
  if (orderFiles.length) {
    codes = parseCmsOrderTxt(Buffer.from(entries[orderFiles[0]]).toString("utf-8"));
    sourceFormat = "cms-order";
  } else if (xmlFiles.length) {
    const t = expandTabular(Buffer.from(entries[xmlFiles[0]]).toString("utf-8"));
    codes = t.codes;
    xmlVersion = t.version;
    expanded = t.sevenChrDefs > 0;
    sourceFormat = "tabular-xml";
  } else {
    throw new Error("No usable ICD-10-CM order TXT or tabular XML found in ZIP");
  }
  const seen = new Set<string>();
  const records: string[][] = [];
  for (const c of codes) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    records.push([c.code, c.nameEn, nameZhMap.get(c.code) ?? "", c.code.slice(0, 3), c.shortNameEn, c.isHeader ? "true" : "false"]);
  }
  const headers = codes.some((c) => c.isHeader);
  return {
    records,
    edition: icd10cmEdition(zipPath, [...orderFiles, ...xmlFiles], xmlVersion),
    sourceFormat,
    // Only the CMS order file is the exact code set tx.fhir.org serves.
    complete: sourceFormat === "cms-order" && expanded && headers && records.length >= ICD10CM_COMPLETE_MIN_ROWS,
  };
}

/** Mirror `_parse_pcs_codes_txt`: yield [code, name_en] from the flat CMS codes TXT. */
function parsePcsCodesTxt(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+$/, ""); // rstrip
    if (line.length < 9) continue;
    const code = line.slice(0, 7).trim();
    const desc = line.slice(8).trim();
    if (code && code.length === 7 && desc) out.push([code, desc]);
  }
  return out;
}

// ── Stage-record parsers ─────────────────────────────────────────────────────
// These RETURN row tuples (rather than writing tables directly) so the admin
// worker can stage → promote them:
//   diagnoses:  parseIcd10cmRelease().records — [code, name_en, name_zh, category, short_name_en, is_header]
//   procedures: [code, name_en, name_zh]

/** Faithful port of `_parse_icd10pcs_stage_records`. */
export function parseIcd10pcsStageRecords(
  zipPath: string,
  nameZhMap: Map<string, string>,
): string[][] {
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
    throw new Error("No usable ICD-10-PCS TXT found in ZIP");
  }
  const data = Buffer.from(entries[codesFiles[0]]).toString("utf-8");
  const records: string[][] = [];
  for (const [code, nameEn] of parsePcsCodesTxt(data)) {
    records.push([code, nameEn, nameZhMap.get(code) ?? ""]);
  }
  return records;
}

/** Faithful port of `_parse_icd_bilingual_names` (raises if 0 names parsed). */
export function parseIcdBilingualNames(
  xlsxPath: string,
): { cmZh: Map<string, string>; pcsZh: Map<string, string> } {
  const { cmZh, pcsZh } = parseIcdChineseXlsx(xlsxPath);
  if (cmZh.size === 0 && pcsZh.size === 0) {
    throw new Error(
      "Taiwan ICD bilingual XLSX parsed 0 Chinese names. " +
        "Verify the workbook has ICD-10-CM and ICD-10-PCS sheets with Chinese names.",
    );
  }
  return { cmZh, pcsZh };
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

/** SQL that records the loaded ICD-10-CM edition (params: edition, format, complete, count). */
export const ICD10CM_EDITION_UPSERT_SQL = `
  INSERT INTO icd.editions (code_system, edition, source_format, complete, code_count, loaded_at)
  VALUES ('icd-10-cm', $1, $2, $3::boolean, $4::integer, NOW())
  ON CONFLICT (code_system) DO UPDATE SET
    edition = EXCLUDED.edition, source_format = EXCLUDED.source_format,
    complete = EXCLUDED.complete, code_count = EXCLUDED.code_count, loaded_at = NOW()`;

// ── WHO ICD-10 (http://hl7.org/fhir/sid/icd-10) ─────────────────────────────

export interface Icd10WhoRelease {
  /** (code, display, kind, alt_displays[]) */
  records: [string, string, string | null, string[]][];
  version: string | null;
}

/**
 * Parse a WHO ICD-10 code system delivered as FHIR JSON: a CodeSystem
 * (`concept`, nested) or a ValueSet `$expand` result (`expansion.contains`,
 * nested) — e.g. the tx.fhir.org edition fetched by
 * scripts/validator-audit/harness/fetch_tx_terms.py. Chapters ('I') and blocks
 * ('A00-A09') are concepts too (tx.fhir.org validates them). Designation values
 * other than the display (the long description) are kept as alt displays.
 */
export function parseIcd10WhoJson(text: string): Icd10WhoRelease {
  const doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, any>;
  const out = new Map<string, [string, string, string | null, string[]]>();
  let version: string | null = null;
  const visit = (c: Record<string, any>): void => {
    const code = typeof c.code === "string" ? c.code.trim() : "";
    const display = typeof c.display === "string" ? c.display : "";
    if (code && display && !out.has(code)) {
      const alts: string[] = [];
      for (const d of Array.isArray(c.designation) ? c.designation : []) {
        if (typeof d?.value === "string" && d.value && d.value !== display && !alts.includes(d.value)) alts.push(d.value);
      }
      let kind: string | null = null;
      for (const p of Array.isArray(c.property) ? c.property : []) {
        if (p?.code === "kind" && typeof p.valueCode === "string") kind = p.valueCode;
      }
      out.set(code, [code, display, kind, alts]);
    }
    for (const child of [...(Array.isArray(c.concept) ? c.concept : []), ...(Array.isArray(c.contains) ? c.contains : [])]) visit(child);
  };
  if (doc.resourceType === "CodeSystem") {
    if (doc.url && doc.url !== "http://hl7.org/fhir/sid/icd-10") {
      throw new Error(`Not a WHO ICD-10 CodeSystem: url = ${doc.url}`);
    }
    version = typeof doc.version === "string" ? doc.version : null;
    for (const c of doc.concept || []) visit(c);
  } else if (doc.resourceType === "ValueSet" && doc.expansion) {
    for (const p of doc.expansion.parameter || []) {
      if (p?.name === "used-codesystem" && typeof p.valueUri === "string" && p.valueUri.startsWith("http://hl7.org/fhir/sid/icd-10|")) {
        version = p.valueUri.split("|")[1];
      }
    }
    for (const c of doc.expansion.contains || []) {
      if (c.system && c.system !== "http://hl7.org/fhir/sid/icd-10") continue;
      visit(c);
    }
  } else {
    throw new Error("WHO ICD-10 source must be a FHIR CodeSystem or an expanded ValueSet (JSON)");
  }
  if (out.size === 0) throw new Error("WHO ICD-10 source contains no concepts");
  return { records: [...out.values()], version };
}

export function parseIcd10WhoFile(filePath: string): Icd10WhoRelease {
  return parseIcd10WhoJson(fs.readFileSync(filePath, "utf-8"));
}

/** SQL recording the loaded WHO ICD-10 edition (params: edition, count). */
export const ICD10_WHO_EDITION_UPSERT_SQL = `
  INSERT INTO icd.editions (code_system, edition, source_format, complete, code_count, loaded_at)
  VALUES ('icd-10', $1, 'fhir-json', TRUE, $2::integer, NOW())
  ON CONFLICT (code_system) DO UPDATE SET
    edition = EXCLUDED.edition, source_format = EXCLUDED.source_format,
    complete = EXCLUDED.complete, code_count = EXCLUDED.code_count, loaded_at = NOW()`;

export async function loadIcd10cm(
  pool: pg.Pool,
  zipPath: string,
  zh: Map<string, string>,
): Promise<void> {
  logInfo(`Parsing ${zipPath} ...`);
  // Sync correctness: parse everything first, then write in one transaction.
  const release = parseIcd10cmRelease(zipPath, zh);
  const records = release.records;
  const matched = records.filter((r) => r[2]).length;
  logInfo(
    `  Parsed ${records.length} ICD-10-CM codes (${release.sourceFormat}, edition ${release.edition}, ` +
      `complete=${release.complete}, ${matched} with Chinese names). Writing to DB ...`,
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE icd.diagnoses");
    await batchInsert(
      client,
      "INSERT INTO icd.diagnoses (code, name_en, name_zh, category, short_name_en, is_header)",
      "ON CONFLICT (code) DO UPDATE SET name_en=EXCLUDED.name_en, name_zh=EXCLUDED.name_zh, category=EXCLUDED.category, " +
        "short_name_en=EXCLUDED.short_name_en, is_header=EXCLUDED.is_header",
      6,
      records,
    );
    await client.query(ICD10CM_EDITION_UPSERT_SQL, [
      release.edition,
      release.sourceFormat,
      release.complete,
      records.length,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
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

/**
 * Local-dev ICD-10-CM zip discovery. `ICD_CM_ZIP` wins; otherwise, in `dir`,
 * prefer the CMS "Code Descriptions in Tabular Order" zip (complete code set,
 * e.g. `april-1-2026-code-descriptions-tabular-order.zip`), then a "Code Tables,
 * Tabular and Index" zip (`icd10cm-table-index-YYYY.zip`), newest name first;
 * falls back to the legacy `icd10cm-table-index-2025.zip` path.
 */
export function resolveIcd10cmZip(
  dir: string = CM_DIR,
  envPath: string | undefined = process.env.ICD_CM_ZIP,
): string {
  if (envPath) return envPath;
  const zips = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".zip")).sort().reverse()
    : [];
  const orderZip = zips.find((n) => /order|code-descriptions/i.test(n));
  if (orderZip) return path.join(dir, orderZip);
  const tableZip = zips.find((n) => /table-index|tabular/i.test(n));
  if (tableZip) return path.join(dir, tableZip);
  return dir === CM_DIR ? LEGACY_CM_ZIP : path.join(dir, path.basename(LEGACY_CM_ZIP));
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

  const cmZip = resolveIcd10cmZip();
  if (fs.existsSync(cmZip)) {
    await loadIcd10cm(pool, cmZip, cmZh);
  } else {
    logError(`  ICD-10-CM zip not found: ${cmZip}`);
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
