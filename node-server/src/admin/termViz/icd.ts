/**
 * ICD-10 explorer data: ICD-10-CM tree (chapter → block → category → … →
 * billable code, 7th characters folded into chips), WHO ICD-10 tree, and
 * ICD-10-PCS table browsing / 7-axis breakdown.
 *
 * `icd.diagnoses` has no parent column: the CMS order file lists every level
 * (headers included, even placeholder "X" stems such as T36.0X), so a code's
 * parent is its longest proper prefix present in the same category. Chapters,
 * blocks, 7th-character meanings and PCS axis labels are not in the database;
 * they come from the generated static tables in ../../data/.
 */

import { ICD10CM_STRUCTURE_JSON } from "../../data/icd10cmStructure.data.js";
import { ICD10PCS_TABLES_JSON } from "../../data/icd10pcsTables.data.js";
import { ftsPrefixQuery, hasCjk, likeEscape, num, str, TermVizError, VersionedCache, type Q, type Row } from "./common.js";

// ── Static structure ─────────────────────────────────────────────────────────

interface CmSection {
  id: string;
  title: string;
  first: string;
  last: string;
  cats: string[];
}
interface CmChapter {
  num: number;
  title: string;
  first: string;
  last: string;
  sections: CmSection[];
}
interface CmStructure {
  source: string;
  chapters: CmChapter[];
  seventh: Record<string, Record<string, string>>;
}

type PcsLabel = [string, string];
interface PcsTable {
  s: string;
  b: string;
  o: string;
  d: string;
  t: string[];
  rows: PcsLabel[][][];
}
interface PcsTables {
  source: string;
  tables: Record<string, PcsTable>;
}

let cmCache: (CmStructure & { sectionOfCat: Map<string, CmSection>; chapterOfSection: Map<string, CmChapter> }) | null = null;
export function cmStructure(): NonNullable<typeof cmCache> {
  if (!cmCache) {
    const s = JSON.parse(ICD10CM_STRUCTURE_JSON) as CmStructure;
    const sectionOfCat = new Map<string, CmSection>();
    const chapterOfSection = new Map<string, CmChapter>();
    for (const ch of s.chapters) {
      for (const sec of ch.sections) {
        chapterOfSection.set(sec.id, ch);
        for (const c of sec.cats) sectionOfCat.set(c, sec);
      }
    }
    cmCache = { ...s, sectionOfCat, chapterOfSection };
  }
  return cmCache;
}

let pcsCache: PcsTables | null = null;
export function pcsTables(): PcsTables {
  if (!pcsCache) pcsCache = JSON.parse(ICD10PCS_TABLES_JSON) as PcsTables;
  return pcsCache;
}

/** Taiwan (MOHW 2023 Chinese edition) chapter titles, by chapter number. */
export const CM_CHAPTER_ZH: Record<number, string> = {
  1: "某些傳染病和寄生蟲病",
  2: "腫瘤",
  3: "血液和造血器官及涉及免疫機轉的疾患",
  4: "內分泌、營養和代謝疾病",
  5: "精神、行為和神經發展障礙症",
  6: "神經系統疾病",
  7: "眼和附屬器官疾病",
  8: "耳和乳突疾病",
  9: "循環系統疾病",
  10: "呼吸系統疾病",
  11: "消化系統疾病",
  12: "皮膚和皮下組織疾病",
  13: "肌肉骨骼系統和結締組織疾病",
  14: "泌尿生殖系統疾病",
  15: "妊娠、生產和產褥期",
  16: "源於周產期的某些病況",
  17: "先天性畸形、變形和染色體異常",
  18: "症狀、徵候和臨床與實驗室的異常發現，他處未歸類者",
  19: "傷害、中毒和外因的某些其他後果",
  20: "罹病和死亡的外因",
  21: "影響健康狀態和與醫療保健服務接觸之因素",
  22: "特殊目的代碼",
};

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI", "XXII"];

/** WHO ICD-10 (2019) chapter ranges — the FHIR CodeSystem lists chapters without them. */
export const WHO_CHAPTER_RANGES: Record<string, [string, string]> = {
  I: ["A00", "B99"],
  II: ["C00", "D48"],
  III: ["D50", "D89"],
  IV: ["E00", "E90"],
  V: ["F00", "F99"],
  VI: ["G00", "G99"],
  VII: ["H00", "H59"],
  VIII: ["H60", "H95"],
  IX: ["I00", "I99"],
  X: ["J00", "J99"],
  XI: ["K00", "K93"],
  XII: ["L00", "L99"],
  XIII: ["M00", "M99"],
  XIV: ["N00", "N99"],
  XV: ["O00", "O99"],
  XVI: ["P00", "P96"],
  XVII: ["Q00", "Q99"],
  XVIII: ["R00", "R99"],
  XIX: ["S00", "T98"],
  XX: ["V01", "Y98"],
  XXI: ["Z00", "Z99"],
  XXII: ["U00", "U99"],
};

export const PCS_SECTION_ZH: Record<string, string> = {
  "0": "內科及外科",
  "1": "產科",
  "2": "置放",
  "3": "給藥",
  "4": "測量及監測",
  "5": "體外輔助及效能",
  "6": "體外治療",
  "7": "整骨治療",
  "8": "其他處置",
  "9": "脊椎推拿治療",
  B: "影像",
  C: "核子醫學",
  D: "放射治療",
  F: "物理復健及聽力診斷",
  G: "心理健康",
  H: "物質濫用治療",
  X: "新技術",
};

// ── Node model ───────────────────────────────────────────────────────────────

export type IcdNodeKind = "chapter" | "block" | "category" | "header" | "billable";

export interface SeventhChip {
  code: string;
  char: string;
  meaning: string;
  title_zh: string | null;
  title_en: string | null;
}

export interface IcdNode {
  id: string;
  code: string;
  kind: IcdNodeKind;
  title_en: string;
  title_zh: string | null;
  /** "A00–B99" for chapters / blocks. */
  range?: string;
  has_children: boolean;
  /** Billable codes underneath (inclusive). */
  billable_count: number;
  /** 7th-character variants folded into this stem (A / D / S …). */
  seventh?: SeventhChip[];
}

export interface CodeRow {
  code: string;
  name_en: string | null;
  name_zh: string | null;
  is_header: boolean;
}

const stripDot = (c: string): string => c.replace(".", "");

/** Nearest 7th-character definition that applies to `code` (by prefix). */
export function seventhDefFor(code: string, defs: Record<string, Record<string, string>>): Record<string, string> | null {
  for (let k = code.length - 1; k >= 3; k--) {
    const d = defs[code.slice(0, k)];
    if (d) return d;
  }
  return null;
}

/** Is `child` a 7th-character extension of `parent` (one more char, 7 chars without the dot)? */
export function isSeventhExtension(child: string, parent: string, defs: Record<string, Record<string, string>>): boolean {
  if (stripDot(child).length !== 7 || child.length !== parent.length + 1 || !child.startsWith(parent)) return false;
  const def = seventhDefFor(parent, defs);
  return Boolean(def && def[child.slice(-1)] !== undefined);
}

/**
 * Parent map for the codes of one category: parent = longest proper prefix
 * that is itself a code (trailing "." trimmed). The category code has no parent.
 */
export function buildParentMap(codes: string[]): Map<string, string | null> {
  const set = new Set(codes);
  const out = new Map<string, string | null>();
  for (const c of codes) {
    let parent: string | null = null;
    for (let k = c.length - 1; k >= 3; k--) {
      let p = c.slice(0, k);
      if (p.endsWith(".")) p = p.slice(0, -1);
      if (p !== c && set.has(p)) {
        parent = p;
        break;
      }
    }
    out.set(c, parent);
  }
  return out;
}

/** Direct children + inclusive billable counts for every code of a category. */
export function categoryIndex(rows: CodeRow[]): {
  children: Map<string, CodeRow[]>;
  billable: Map<string, number>;
  byCode: Map<string, CodeRow>;
  parent: Map<string, string | null>;
} {
  const sorted = [...rows].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const parent = buildParentMap(sorted.map((r) => r.code));
  const children = new Map<string, CodeRow[]>();
  const byCode = new Map<string, CodeRow>();
  const billable = new Map<string, number>();
  for (const r of sorted) {
    byCode.set(r.code, r);
    const p = parent.get(r.code);
    if (p) {
      const list = children.get(p) ?? [];
      list.push(r);
      children.set(p, list);
    }
  }
  for (const r of sorted) {
    if (r.is_header) continue;
    // Count this billable code on itself and every ancestor.
    let cur: string | null | undefined = r.code;
    while (cur) {
      billable.set(cur, (billable.get(cur) ?? 0) + 1);
      cur = parent.get(cur);
    }
  }
  return { children, billable, byCode, parent };
}

/** Tree node for one code; folds its children into chips when they are all 7th characters. */
export function codeNode(
  row: CodeRow,
  idx: ReturnType<typeof categoryIndex>,
  defs: Record<string, Record<string, string>>,
): IcdNode {
  const kids = idx.children.get(row.code) ?? [];
  const isCategory = row.code.length === 3;
  const node: IcdNode = {
    id: row.code,
    code: row.code,
    kind: isCategory ? "category" : row.is_header ? "header" : "billable",
    title_en: row.name_en ?? "",
    title_zh: row.name_zh || null,
    has_children: kids.length > 0,
    billable_count: idx.billable.get(row.code) ?? 0,
  };
  if (kids.length > 0 && kids.every((k) => isSeventhExtension(k.code, row.code, defs))) {
    const def = seventhDefFor(row.code, defs) ?? {};
    node.seventh = kids.map((k) => ({
      code: k.code,
      char: k.code.slice(-1),
      meaning: def[k.code.slice(-1)] ?? "",
      title_zh: k.name_zh || null,
      title_en: k.name_en || null,
    }));
    node.has_children = false;
  }
  return node;
}

// ── ICD-10-CM queries ────────────────────────────────────────────────────────

const catCounts = new VersionedCache<Map<string, { billable: number; total: number }>>(10 * 60_000, 4);
const whoCache = new VersionedCache<WhoIndex>(10 * 60_000, 2);
const pcsCountCache = new VersionedCache<Map<string, number>>(10 * 60_000, 2);

async function editionVersion(q: Q, codeSystem: string, fallbackTable: string): Promise<string> {
  const r = await q("SELECT loaded_at::text AS v FROM icd.editions WHERE code_system = $1", [codeSystem]);
  if (r.rows[0]?.v) return str(r.rows[0].v);
  const c = await q(`SELECT COUNT(*)::text AS v FROM ${fallbackTable}`);
  return `count:${str(c.rows[0]?.v)}`;
}

async function categoryCounts(q: Q): Promise<Map<string, { billable: number; total: number }>> {
  const version = await editionVersion(q, "icd-10-cm", "icd.diagnoses");
  return catCounts.get("cm", version, async () => {
    const r = await q(
      "SELECT category, COUNT(*) FILTER (WHERE NOT COALESCE(is_header, false))::int AS b, COUNT(*)::int AS n FROM icd.diagnoses GROUP BY category",
    );
    return new Map(r.rows.map((x) => [str(x.category), { billable: num(x.b), total: num(x.n) }]));
  });
}

function toCodeRow(r: Row): CodeRow {
  return { code: str(r.code), name_en: (r.name_en as string) ?? null, name_zh: (r.name_zh as string) ?? null, is_header: Boolean(r.is_header) };
}

async function categoryRows(q: Q, category: string): Promise<CodeRow[]> {
  const r = await q("SELECT code, name_en, name_zh, is_header FROM icd.diagnoses WHERE category = $1", [category]);
  return r.rows.map(toCodeRow);
}

function chapterNode(ch: CmChapter, counts: Map<string, { billable: number }>): IcdNode {
  const billable = ch.sections.reduce((s, sec) => s + sec.cats.reduce((t, c) => t + (counts.get(c)?.billable ?? 0), 0), 0);
  return {
    id: `ch:${ch.num}`,
    code: String(ch.num),
    kind: "chapter",
    title_en: ch.title,
    title_zh: CM_CHAPTER_ZH[ch.num] ?? null,
    range: `${ch.first}–${ch.last}`,
    has_children: ch.sections.length > 0,
    billable_count: billable,
  };
}

function sectionNode(sec: CmSection, counts: Map<string, { billable: number }>): IcdNode {
  return {
    id: `sec:${sec.id}`,
    code: sec.first === sec.last ? sec.first : `${sec.first}–${sec.last}`,
    kind: "block",
    title_en: sec.title,
    title_zh: null,
    range: `${sec.first}–${sec.last}`,
    has_children: sec.cats.length > 0,
    billable_count: sec.cats.reduce((t, c) => t + (counts.get(c)?.billable ?? 0), 0),
  };
}

/** Children of a CM tree node: "" (root → chapters), "ch:N", "sec:X-Y", or a code. */
export async function cmChildren(q: Q, nodeId: string): Promise<IcdNode[]> {
  const s = cmStructure();
  const counts = await categoryCounts(q);
  if (!nodeId) return s.chapters.map((ch) => chapterNode(ch, counts));
  if (nodeId.startsWith("ch:")) {
    const ch = s.chapters.find((c) => `ch:${c.num}` === nodeId);
    if (!ch) throw new TermVizError(404, `Unknown chapter ${nodeId}`);
    return ch.sections.map((sec) => sectionNode(sec, counts));
  }
  if (nodeId.startsWith("sec:")) {
    const sec = s.chapterOfSection.get(nodeId.slice(4)) ? findSection(nodeId.slice(4)) : null;
    if (!sec) throw new TermVizError(404, `Unknown block ${nodeId}`);
    const present = sec.cats.filter((c) => counts.has(c));
    if (present.length === 0) return [];
    const r = await q("SELECT code, name_en, name_zh, is_header FROM icd.diagnoses WHERE code = ANY($1::text[])", [present]);
    const byCode = new Map(r.rows.map((x) => [str(x.code), toCodeRow(x)]));
    return present
      .filter((c) => byCode.has(c))
      .map((c) => {
        const row = byCode.get(c)!;
        const cnt = counts.get(c)!;
        return {
          id: c,
          code: c,
          kind: "category" as const,
          title_en: row.name_en ?? "",
          title_zh: row.name_zh || null,
          has_children: cnt.total > 1,
          billable_count: cnt.billable,
        };
      });
  }
  const code = nodeId.toUpperCase();
  const rows = await categoryRows(q, code.slice(0, 3));
  if (!rows.some((r) => r.code === code)) throw new TermVizError(404, `Unknown code ${code}`);
  const idx = categoryIndex(rows);
  const node = codeNode(idx.byCode.get(code)!, idx, s.seventh);
  if (node.seventh) return [];
  return (idx.children.get(code) ?? []).map((r) => codeNode(r, idx, s.seventh));
}

function findSection(id: string): CmSection | null {
  const ch = cmStructure().chapterOfSection.get(id);
  return ch?.sections.find((x) => x.id === id) ?? null;
}

export interface IcdPath {
  code: string;
  /** Tree node ids from the root's child down to the node that shows `code`. */
  path: string[];
  /** Pre-fetched children for every node on the path ("" = root). */
  children: Record<string, IcdNode[]>;
  /** The node that represents `code` (its stem when `code` is a folded 7th character). */
  node_id: string;
  detail: IcdCodeDetail;
}

export interface IcdCodeDetail {
  code: string;
  title_en: string;
  title_zh: string | null;
  is_header: boolean;
  chapter: { id: string; code: string; title_en: string; title_zh: string | null; range: string } | null;
  block: { id: string; code: string; title_en: string } | null;
  ancestors: { code: string; title_en: string; title_zh: string | null }[];
  seventh: { char: string; meaning: string } | null;
  billable_count: number;
}

/** Path from the root to `code`, with every level's children (one round-trip "search reveal"). */
export async function cmPath(q: Q, rawCode: string): Promise<IcdPath> {
  const s = cmStructure();
  const code = normalizeCmCode(rawCode);
  const cat = code.slice(0, 3);
  const sec = s.sectionOfCat.get(cat);
  const ch = sec ? s.chapterOfSection.get(sec.id) : undefined;
  const rows = await categoryRows(q, cat);
  const idx = categoryIndex(rows);
  const row = idx.byCode.get(code);
  if (!row || !sec || !ch) throw new TermVizError(404, `ICD-10-CM code ${code} not found`);

  const ancestors: string[] = [];
  for (let cur = idx.parent.get(code); cur; cur = idx.parent.get(cur)) ancestors.unshift(cur);

  // A folded 7th character is shown on its stem's row.
  const parentCode = ancestors[ancestors.length - 1];
  let nodeId = code;
  if (parentCode) {
    const parentNode = codeNode(idx.byCode.get(parentCode)!, idx, s.seventh);
    if (parentNode.seventh?.some((c) => c.code === code)) nodeId = parentCode;
  }

  const path = [`ch:${ch.num}`, `sec:${sec.id}`, ...ancestors, ...(nodeId === code ? [code] : [])];
  const children: Record<string, IcdNode[]> = {};
  const counts = await categoryCounts(q);
  children[""] = s.chapters.map((c) => chapterNode(c, counts));
  children[`ch:${ch.num}`] = ch.sections.map((x) => sectionNode(x, counts));
  children[`sec:${sec.id}`] = await cmChildren(q, `sec:${sec.id}`);
  for (const a of ancestors) {
    children[a] = (idx.children.get(a) ?? []).map((r) => codeNode(r, idx, s.seventh));
  }

  const def = seventhDefFor(code, s.seventh);
  const isExt = parentCode ? isSeventhExtension(code, parentCode, s.seventh) : false;
  return {
    code,
    path,
    children,
    node_id: nodeId,
    detail: {
      code,
      title_en: row.name_en ?? "",
      title_zh: row.name_zh || null,
      is_header: row.is_header,
      chapter: { id: `ch:${ch.num}`, code: String(ch.num), title_en: ch.title, title_zh: CM_CHAPTER_ZH[ch.num] ?? null, range: `${ch.first}–${ch.last}` },
      block: { id: `sec:${sec.id}`, code: sec.id, title_en: sec.title },
      ancestors: ancestors.map((a) => {
        const r = idx.byCode.get(a)!;
        return { code: a, title_en: r.name_en ?? "", title_zh: r.name_zh || null };
      }),
      seventh: isExt && def ? { char: code.slice(-1), meaning: def[code.slice(-1)] ?? "" } : null,
      billable_count: idx.billable.get(code) ?? 0,
    },
  };
}

/** Accept "e1121", "E11.21", " E11.21 " → "E11.21". */
export function normalizeCmCode(raw: string): string {
  const c = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (c.includes(".") || c.length <= 3) return c;
  return `${c.slice(0, 3)}.${c.slice(3)}`;
}

/** Same expression as idx_icd_diag_fts / idx_icd_proc_fts (must match to use the index). */
const ICD_FTS = "to_tsvector('simple'::regconfig, (((COALESCE(code, ''::text) || ' '::text) || COALESCE(name_zh, ''::text)) || ' '::text) || COALESCE(name_en, ''::text))";

export interface IcdSearchHit {
  code: string;
  title_en: string;
  title_zh: string | null;
  is_header: boolean;
  chapter: string | null;
  block: string | null;
}

export function looksLikeIcdCode(q: string): boolean {
  return /^[A-Z][0-9][0-9A-Z]?\.?[0-9A-Z]{0,4}$/i.test(q.trim());
}

/** Typeahead: code prefix (dot optional) or Chinese / English title. */
export async function cmSearch(q: Q, text: string, limit = 25): Promise<IcdSearchHit[]> {
  const s = cmStructure();
  const t = text.trim();
  if (!t) return [];
  let r;
  if (looksLikeIcdCode(t)) {
    r = await q(
      `SELECT code, name_en, name_zh, is_header FROM icd.diagnoses
        WHERE replace(code, '.', '') LIKE $1 ESCAPE '\\'
        ORDER BY length(code), code LIMIT $2`,
      [`${likeEscape(stripDot(t.toUpperCase()))}%`, limit],
    );
  } else if (hasCjk(t)) {
    // strpos: ~10x faster than ILIKE on this column set, and Chinese has no case.
    r = await q(
      `SELECT code, name_en, name_zh, is_header FROM icd.diagnoses
        WHERE strpos(name_zh, $1) > 0
        ORDER BY (strpos(name_zh, $1) = 1) DESC, length(code), code LIMIT $2`,
      [t, limit],
    );
  } else {
    const tsq = ftsPrefixQuery(t);
    if (!tsq) return [];
    r = await q(
      `SELECT code, name_en, name_zh, is_header FROM icd.diagnoses
        WHERE ${ICD_FTS} @@ to_tsquery('simple', $1)
        ORDER BY length(code), code LIMIT $2`,
      [tsq, limit],
    );
  }
  return r.rows.map((x) => {
    const code = str(x.code);
    const sec = s.sectionOfCat.get(code.slice(0, 3));
    const ch = sec ? s.chapterOfSection.get(sec.id) : undefined;
    return {
      code,
      title_en: str(x.name_en),
      title_zh: (x.name_zh as string) || null,
      is_header: Boolean(x.is_header),
      chapter: ch ? String(ch.num) : null,
      block: sec?.id ?? null,
    };
  });
}

// ── WHO ICD-10 ───────────────────────────────────────────────────────────────

interface WhoRow {
  code: string;
  display: string;
}
export interface WhoIndex {
  byCode: Map<string, WhoRow>;
  children: Map<string, string[]>;
  parent: Map<string, string | null>;
  leafCount: Map<string, number>;
}

const isRoman = (c: string): boolean => /^[IVX]+$/.test(c);
const isBlock = (c: string): boolean => /^[A-Z]\d\d-[A-Z]\d\d$/.test(c);

/** Build the WHO tree: chapter → (nested) blocks → categories → subcategories. */
export function buildWhoIndex(rows: WhoRow[]): WhoIndex {
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const chapters = rows.filter((r) => isRoman(r.code) && WHO_CHAPTER_RANGES[r.code]);
  const blocks = rows.filter((r) => isBlock(r.code)).map((r) => ({ code: r.code, first: r.code.slice(0, 3), last: r.code.slice(4) }));
  const parent = new Map<string, string | null>();
  const containers = (first: string, last: string, self: string): string | null => {
    let best: { code: string; span: number } | null = null;
    for (const b of blocks) {
      if (b.code === self || b.first > first || b.last < last) continue;
      // Identical ranges: keep the input order deterministic (first listed is the outer one).
      const span = rangeSpan(b.first, b.last);
      if (b.first === first && b.last === last && blocks.findIndex((x) => x.code === b.code) > blocks.findIndex((x) => x.code === self)) continue;
      if (!best || span < best.span) best = { code: b.code, span };
    }
    if (best) return best.code;
    for (const ch of chapters) {
      const [a, z] = WHO_CHAPTER_RANGES[ch.code];
      if (first >= a && last <= z) return ch.code;
    }
    return null;
  };
  for (const ch of chapters) parent.set(ch.code, null);
  for (const b of blocks) parent.set(b.code, containers(b.first, b.last, b.code));
  const codes = rows.filter((r) => !isRoman(r.code) && !isBlock(r.code)).map((r) => r.code).sort();
  const codeSet = new Set(codes);
  for (const c of codes) {
    if (c.length === 3) {
      parent.set(c, containers(c, c, c));
      continue;
    }
    let p: string | null = null;
    for (let k = c.length - 1; k >= 3; k--) {
      let cand = c.slice(0, k);
      if (cand.endsWith(".")) cand = cand.slice(0, -1);
      if (codeSet.has(cand)) {
        p = cand;
        break;
      }
    }
    parent.set(c, p);
  }
  const children = new Map<string, string[]>();
  const order = (a: string, b: string): number => {
    const ka = isRoman(a) ? WHO_CHAPTER_RANGES[a][0] : a.slice(0, 3);
    const kb = isRoman(b) ? WHO_CHAPTER_RANGES[b][0] : b.slice(0, 3);
    if (ka !== kb) return ka < kb ? -1 : 1;
    // Blocks before the categories they contain; wider blocks first.
    if (isBlock(a) !== isBlock(b)) return isBlock(a) ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  for (const [c, p] of parent) {
    const key = p ?? "";
    const list = children.get(key) ?? [];
    list.push(c);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort(order);
  const leafCount = new Map<string, number>();
  const count = (c: string): number => {
    const kids = children.get(c);
    const n = kids && kids.length ? kids.reduce((s, k) => s + count(k), 0) : isRoman(c) || isBlock(c) ? 0 : 1;
    leafCount.set(c, n);
    return n;
  };
  for (const root of children.get("") ?? []) count(root);
  return { byCode, children, parent, leafCount };
}

function rangeSpan(first: string, last: string): number {
  const v = (c: string): number => (c.charCodeAt(0) - 65) * 100 + Number.parseInt(c.slice(1), 10);
  return v(last) - v(first);
}

async function whoIndex(q: Q): Promise<WhoIndex> {
  const version = await editionVersion(q, "icd-10", "icd.icd10_who");
  return whoCache.get("who", version, async () => {
    const r = await q("SELECT code, display FROM icd.icd10_who");
    return buildWhoIndex(r.rows.map((x) => ({ code: str(x.code), display: str(x.display) })));
  });
}

function whoNode(idx: WhoIndex, code: string): IcdNode {
  const row = idx.byCode.get(code)!;
  const kids = idx.children.get(code) ?? [];
  const kind: IcdNodeKind = isRoman(code) ? "chapter" : isBlock(code) ? "block" : code.length === 3 ? "category" : kids.length ? "header" : "billable";
  return {
    id: code,
    code: isBlock(code) ? code.replace("-", "–") : code,
    kind,
    title_en: row.display,
    title_zh: isRoman(code) ? (CM_CHAPTER_ZH[ROMAN.indexOf(code)] ?? null) : null,
    range: isRoman(code) ? WHO_CHAPTER_RANGES[code].join("–") : isBlock(code) ? code.replace("-", "–") : undefined,
    has_children: kids.length > 0,
    billable_count: idx.leafCount.get(code) ?? 0,
  };
}

export async function whoChildren(q: Q, nodeId: string): Promise<IcdNode[]> {
  const idx = await whoIndex(q);
  if (nodeId && !idx.byCode.has(nodeId)) throw new TermVizError(404, `Unknown WHO ICD-10 node ${nodeId}`);
  return (idx.children.get(nodeId) ?? []).map((c) => whoNode(idx, c));
}

export async function whoPath(q: Q, rawCode: string): Promise<{ code: string; path: string[]; children: Record<string, IcdNode[]>; node_id: string; title: string }> {
  const idx = await whoIndex(q);
  const code = rawCode.trim().toUpperCase();
  if (!idx.byCode.has(code)) throw new TermVizError(404, `WHO ICD-10 code ${code} not found`);
  const path: string[] = [];
  for (let cur: string | null | undefined = code; cur; cur = idx.parent.get(cur)) path.unshift(cur);
  const children: Record<string, IcdNode[]> = { "": (idx.children.get("") ?? []).map((c) => whoNode(idx, c)) };
  for (const p of path.slice(0, -1)) children[p] = (idx.children.get(p) ?? []).map((c) => whoNode(idx, c));
  return { code, path, children, node_id: code, title: idx.byCode.get(code)!.display };
}

export async function whoSearch(q: Q, text: string, limit = 25): Promise<IcdSearchHit[]> {
  const idx = await whoIndex(q);
  const t = text.trim().toUpperCase();
  if (!t) return [];
  const hits: IcdSearchHit[] = [];
  const codeLike = looksLikeIcdCode(t);
  const needle = t.toLowerCase();
  const all = [...idx.byCode.values()].sort((a, b) => a.code.length - b.code.length || (a.code < b.code ? -1 : 1));
  for (const r of all) {
    if (isRoman(r.code)) continue;
    const ok = codeLike ? stripDot(r.code).startsWith(stripDot(t)) || r.code.startsWith(t) : r.display.toLowerCase().includes(needle);
    if (!ok) continue;
    let chapter: string | null = null;
    let block: string | null = null;
    for (let cur = idx.parent.get(r.code); cur; cur = idx.parent.get(cur)) {
      if (!block && isBlock(cur)) block = cur;
      if (isRoman(cur)) chapter = cur;
    }
    hits.push({ code: r.code, title_en: r.display, title_zh: null, is_header: (idx.children.get(r.code)?.length ?? 0) > 0, chapter, block });
    if (hits.length >= limit) break;
  }
  return hits;
}

// ── ICD-10-PCS ───────────────────────────────────────────────────────────────

async function pcsPrefixCounts(q: Q): Promise<Map<string, number>> {
  const c = await q("SELECT COUNT(*)::text AS v FROM icd.procedures");
  return pcsCountCache.get("pcs", str(c.rows[0]?.v), async () => {
    const r = await q("SELECT left(code, 3) AS k, COUNT(*)::int AS n FROM icd.procedures GROUP BY 1");
    return new Map(r.rows.map((x) => [str(x.k), num(x.n)]));
  });
}

export interface PcsBrowseSection {
  code: string;
  label: string;
  label_zh: string | null;
  db_count: number;
  systems: { code: string; label: string; db_count: number; ops: { key: string; code: string; label: string; db_count: number }[] }[];
}

/** Section → body system → operation hierarchy, with DB code counts per table. */
export function pcsHierarchy(tables: Record<string, PcsTable>, counts: Map<string, number>): PcsBrowseSection[] {
  const sections = new Map<string, PcsBrowseSection>();
  for (const key of Object.keys(tables).sort()) {
    const t = tables[key];
    const sec = sections.get(key[0]) ?? { code: key[0], label: t.s, label_zh: PCS_SECTION_ZH[key[0]] ?? null, db_count: 0, systems: [] };
    sections.set(key[0], sec);
    let sys = sec.systems.find((x) => x.code === key[1]);
    if (!sys) {
      sys = { code: key[1], label: t.b, db_count: 0, ops: [] };
      sec.systems.push(sys);
    }
    const n = counts.get(key) ?? 0;
    sys.ops.push({ key, code: key[2], label: t.o, db_count: n });
    sys.db_count += n;
    sec.db_count += n;
  }
  return [...sections.values()];
}

export async function pcsBrowse(q: Q): Promise<{ source: string; sections: PcsBrowseSection[] }> {
  const t = pcsTables();
  return { source: t.source, sections: pcsHierarchy(t.tables, await pcsPrefixCounts(q)) };
}

export interface PcsAxis {
  pos: number;
  title: string;
  value: string;
  label: string | null;
}

/**
 * 7-axis breakdown of a PCS code. Characters 4–7 are labelled from the table
 * row that contains all four values; `valid` is false when no row does (the
 * code is not constructible from the table).
 */
export function pcsBreakdown(code: string, tables: Record<string, PcsTable>): { axes: PcsAxis[]; valid: boolean; table_key: string | null; definition: string | null } {
  const c = code.trim().toUpperCase();
  const t = c.length >= 3 ? tables[c.slice(0, 3)] : undefined;
  const titles = t?.t ?? ["Section", "Body System", "Operation", "Body Part", "Approach", "Device", "Qualifier"];
  const axes: PcsAxis[] = [];
  for (let i = 0; i < 7; i++) axes.push({ pos: i + 1, title: titles[i] || `Axis ${i + 1}`, value: c[i] ?? "", label: null });
  if (!t) return { axes, valid: false, table_key: null, definition: null };
  axes[0].label = t.s;
  axes[1].label = t.b;
  axes[2].label = t.o;
  const tail = c.slice(3, 7).split("");
  let valid = false;
  const rowHit = t.rows.find((row) => row.every((labels, i) => labels.some(([v]) => v === tail[i])));
  if (rowHit && tail.length === 4) {
    valid = true;
    rowHit.forEach((labels, i) => (axes[3 + i].label = labels.find(([v]) => v === tail[i])?.[1] ?? null));
  } else {
    for (let i = 0; i < 4; i++) {
      for (const row of t.rows) {
        const hit = row[i]?.find(([v]) => v === tail[i]);
        if (hit) {
          axes[3 + i].label = hit[1];
          break;
        }
      }
    }
  }
  return { axes, valid, table_key: c.slice(0, 3), definition: t.d || null };
}

export async function pcsTable(q: Q, key: string): Promise<Row> {
  const k = key.trim().toUpperCase();
  const t = pcsTables().tables[k];
  if (!t) throw new TermVizError(404, `ICD-10-PCS table ${k} not found`);
  const counts = await pcsPrefixCounts(q);
  return {
    key: k,
    section: { code: k[0], label: t.s, label_zh: PCS_SECTION_ZH[k[0]] ?? null },
    body_system: { code: k[1], label: t.b },
    operation: { code: k[2], label: t.o, definition: t.d || null },
    titles: t.t,
    rows: t.rows.map((row) => ({ body_part: row[0], approach: row[1], device: row[2], qualifier: row[3] })),
    db_count: counts.get(k) ?? 0,
  };
}

/** DB codes of one table filtered by optional axis 4–7 values. */
export async function pcsCodes(q: Q, key: string, axes: string[], page: number, perPage: number): Promise<Row> {
  const k = key.trim().toUpperCase();
  if (!/^[0-9A-Z]{3}$/.test(k)) throw new TermVizError(400, "key must be the 3-character table prefix");
  const pattern = k + [0, 1, 2, 3].map((i) => (/^[0-9A-Z]$/.test(axes[i] ?? "") ? axes[i].toUpperCase() : "_")).join("");
  const offset = (page - 1) * perPage;
  // Fixed leading characters → pkey range scan (codes are [0-9A-Z], which sort
  // the same under any collation), LIKE only for the wildcard positions.
  const fixed = pattern.split("_")[0];
  const range = "code >= $2 AND code <= $3";
  const [cnt, rows] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM icd.procedures WHERE ${range} AND code LIKE $1`, [pattern, fixed, `${fixed}ZZZZZZZ`]),
    q(`SELECT code, name_en, name_zh FROM icd.procedures WHERE ${range} AND code LIKE $1 ORDER BY code LIMIT $4 OFFSET $5`, [pattern, fixed, `${fixed}ZZZZZZZ`, perPage, offset]),
  ]);
  return { pattern, total: num(cnt.rows[0]?.n), page, per_page: perPage, rows: rows.rows };
}

export async function pcsCode(q: Q, rawCode: string): Promise<Row> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[0-9A-HJ-NP-Z]{7}$/.test(code)) throw new TermVizError(400, "ICD-10-PCS codes are 7 characters (0-9, A-Z except I and O)");
  const r = await q("SELECT code, name_en, name_zh FROM icd.procedures WHERE code = $1", [code]);
  const b = pcsBreakdown(code, pcsTables().tables);
  return { code, in_db: r.rows.length > 0, name_en: r.rows[0]?.name_en ?? null, name_zh: r.rows[0]?.name_zh ?? null, ...b };
}

export async function pcsSearch(q: Q, text: string, limit = 25): Promise<Row[]> {
  const t = text.trim();
  if (!t) return [];
  if (/^[0-9A-Z]{1,7}$/i.test(t)) {
    const r = await q("SELECT code, name_en, name_zh FROM icd.procedures WHERE code LIKE $1 ORDER BY code LIMIT $2", [`${t.toUpperCase()}%`, limit]);
    if (r.rows.length) return r.rows;
  }
  if (hasCjk(t)) {
    const r = await q("SELECT code, name_en, name_zh FROM icd.procedures WHERE strpos(name_zh, $1) > 0 ORDER BY code LIMIT $2", [t, limit]);
    return r.rows;
  }
  const tsq = ftsPrefixQuery(t);
  if (!tsq) return [];
  const r = await q(`SELECT code, name_en, name_zh FROM icd.procedures WHERE ${ICD_FTS} @@ to_tsquery('simple', $1) ORDER BY code LIMIT $2`, [tsq, limit]);
  return r.rows;
}
