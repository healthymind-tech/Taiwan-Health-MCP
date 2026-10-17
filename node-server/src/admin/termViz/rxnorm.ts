/**
 * RxNorm explorer. Only `rxnorm.concepts` (RXNCONSO, concept level) is loaded —
 * no RXNREL — so relations are *derived from the normalized names*, which
 * RxNorm builds deterministically:
 *
 *   SCD  "metformin hydrochloride 500 MG Oral Tablet"
 *   SBD  "metformin hydrochloride 500 MG Oral Tablet [Glucophage]"
 *   SCDC "metformin hydrochloride 500 MG"      (component)
 *   SCDF "metformin Oral Tablet"               (ingredient + dose form)
 *
 * Every derived edge is flagged `derived: "name"` so the UI can say so.
 */

import { ftsPrefixQuery, likeEscape, num, str, TermVizError, type Q, type Row } from "./common.js";

export const TTY_LAYERS: { key: string; label: string; ttys: string[] }[] = [
  { key: "ingredient", label: "成分", ttys: ["IN", "PIN", "MIN"] },
  { key: "clinical", label: "臨床藥品（學名）", ttys: ["SCDC", "SCDF", "SCDFP", "SCDG", "SCDGP", "SCD"] },
  { key: "branded", label: "品牌藥品", ttys: ["BN", "SBDC", "SBDF", "SBDFP", "SBDG", "SBD"] },
  { key: "pack", label: "包裝", ttys: ["GPCK", "BPCK"] },
  { key: "form", label: "劑型", ttys: ["DF", "DFG"] },
  { key: "synonym", label: "同義詞", ttys: ["PSN", "SY", "TMSY", "ET"] },
];

export const TTY_LABEL: Record<string, string> = {
  IN: "Ingredient",
  PIN: "Precise Ingredient",
  MIN: "Multiple Ingredients",
  SCDC: "Clinical Drug Component",
  SCDF: "Clinical Drug Form",
  SCDFP: "Clinical Drug Form (precise)",
  SCDG: "Clinical Dose Form Group",
  SCDGP: "Clinical Dose Form Group (precise)",
  SCD: "Semantic Clinical Drug",
  BN: "Brand Name",
  SBDC: "Branded Drug Component",
  SBDF: "Branded Drug Form",
  SBDFP: "Branded Drug Form (precise)",
  SBDG: "Branded Dose Form Group",
  SBD: "Semantic Branded Drug",
  GPCK: "Generic Pack",
  BPCK: "Branded Pack",
  DF: "Dose Form",
  DFG: "Dose Form Group",
  PSN: "Prescribable Name",
  SY: "Synonym",
  TMSY: "Tall Man Synonym",
  ET: "Entry Term",
};

export interface ParsedDrugName {
  /** Name without the "[Brand]" suffix. */
  clinical: string;
  brand: string | null;
  /** Ingredient (+ strength) components split on " / ". */
  components: string[];
  ingredients: string[];
  doseForm: string | null;
}

const UNIT = /\s(\d[\d.,]*)\s([A-Z%][A-Z%-]*(?:\/[A-Z%-]+)*)(?=\s|$)/;

/**
 * Split an RxNorm normalized drug name (pure). The dose form is what follows
 * the last strength of the last component; ingredients are components with
 * the strength removed.
 */
export function parseDrugName(name: string): ParsedDrugName {
  const bm = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(name);
  const clinical = (bm ? bm[1] : name).trim();
  const brand = bm ? bm[2].trim() : null;
  const pieces = clinical.split(" / ").map((p) => p.trim());
  const components: string[] = [];
  const ingredients: string[] = [];
  let doseForm: string | null = null;
  pieces.forEach((p, i) => {
    const m = UNIT.exec(p);
    if (m && m.index !== undefined) {
      const end = m.index + m[0].length;
      components.push(p.slice(0, end).trim());
      ingredients.push(p.slice(0, m.index).trim());
      if (i === pieces.length - 1 && end < p.length) doseForm = p.slice(end).trim() || null;
    } else {
      ingredients.push(p);
      components.push(p);
    }
  });
  return { clinical, brand, components, ingredients, doseForm };
}

export async function rxnormSummary(q: Q): Promise<Row> {
  const r = await q("SELECT tty, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE COALESCE(suppress, 'N') <> 'N')::int AS suppressed FROM rxnorm.concepts GROUP BY tty");
  const counts = new Map(r.rows.map((x) => [str(x.tty), { n: num(x.n), suppressed: num(x.suppressed) }]));
  return {
    has_relationships: false,
    layers: TTY_LAYERS.map((l) => ({
      ...l,
      ttys: l.ttys.map((t) => ({ tty: t, label: TTY_LABEL[t] ?? t, count: counts.get(t)?.n ?? 0, suppressed: counts.get(t)?.suppressed ?? 0 })),
    })),
    total: [...counts.values()].reduce((s, c) => s + c.n, 0),
  };
}

export async function rxnormSearch(q: Q, text: string, tty: string, includeSuppressed: boolean, page: number, perPage: number): Promise<Row> {
  const params: unknown[] = [];
  const where: string[] = [];
  const t = text.trim();
  if (/^\d{1,9}$/.test(t)) {
    params.push(t);
    where.push(`rxcui = $${params.length}::bigint`);
  } else if (t) {
    const tsq = ftsPrefixQuery(t);
    if (tsq) {
      params.push(tsq);
      where.push(`${RX_FTS} @@ to_tsquery('english', $${params.length})`);
    } else {
      params.push(`%${likeEscape(t)}%`);
      where.push(`name ILIKE $${params.length} ESCAPE '\\'`);
    }
  }
  if (tty) {
    params.push(tty.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
    where.push(`tty = ANY($${params.length}::text[])`);
  }
  if (!includeSuppressed) where.push("COALESCE(suppress, 'N') = 'N'");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [cnt, rows] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM rxnorm.concepts ${w}`, params),
    q(`SELECT rxcui::text AS rxcui, name, tty, suppress FROM rxnorm.concepts ${w} ORDER BY length(name), name LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params),
  ]);
  return { total: num(cnt.rows[0]?.n), page, per_page: perPage, rows: rows.rows };
}

type Concept = { rxcui: string; name: string; tty: string; suppress: string | null };

async function byNames(q: Q, names: string[], ttys: string[]): Promise<Concept[]> {
  if (names.length === 0) return [];
  const r = await q(
    "SELECT rxcui::text AS rxcui, name, tty, suppress FROM rxnorm.concepts WHERE lower(name) = ANY($1::text[]) AND tty = ANY($2::text[]) ORDER BY COALESCE(suppress, 'N') = 'N' DESC",
    [names.map((n) => n.toLowerCase()), ttys],
  );
  return r.rows as unknown as Concept[];
}

/** Same expression as idx_rxnorm_concepts_name_fts. */
const RX_FTS = "to_tsvector('english'::regconfig, COALESCE(name, ''::text))";

/**
 * Concepts whose name matches `prefix` + `suffixLike` (LIKE pattern), narrowed
 * first through the FTS index with `words` (the names' own words) so the
 * ILIKE runs on a few hundred rows instead of the whole table.
 */
async function byPrefix(q: Q, prefix: string, ttys: string[], limit: number, suffixLike = "%", words = prefix): Promise<{ total: number; items: Concept[] }> {
  const pat = `${likeEscape(prefix)}${suffixLike}`;
  const tsq = words.trim() ? words.trim() : null;
  const pre = tsq ? `${RX_FTS} @@ plainto_tsquery('english', $3) AND ` : "";
  const args = tsq ? [pat, ttys, tsq] : [pat, ttys];
  const [c, r] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM rxnorm.concepts WHERE ${pre}name ILIKE $1 ESCAPE '\\' AND tty = ANY($2::text[]) AND COALESCE(suppress, 'N') = 'N'`, args),
    q(
      `SELECT rxcui::text AS rxcui, name, tty, suppress FROM rxnorm.concepts WHERE ${pre}name ILIKE $1 ESCAPE '\\' AND tty = ANY($2::text[]) AND COALESCE(suppress, 'N') = 'N' ORDER BY length(name), name LIMIT ${Math.trunc(limit)}`,
      args,
    ),
  ]);
  return { total: num(c.rows[0]?.n), items: r.rows as unknown as Concept[] };
}

/**
 * Name-derived neighbourhood of one concept, as labelled groups:
 *   IN   → clinical drugs / components / forms that start with the ingredient, brands of those drugs
 *   SCD  → its ingredients, components, dose form, branded versions
 *   SBD  → its brand name, the generic SCD, ingredients, dose form
 *   BN   → branded drugs carrying the brand
 */
export async function rxnormConcept(q: Q, rxcui: string): Promise<Row> {
  if (!/^\d{1,9}$/.test(rxcui)) throw new TermVizError(400, "RxCUI must be numeric");
  const r = await q("SELECT rxcui::text AS rxcui, name, tty, suppress FROM rxnorm.concepts WHERE rxcui = $1::bigint", [rxcui]);
  const c = r.rows[0] as unknown as Concept | undefined;
  if (!c) throw new TermVizError(404, `RxCUI ${rxcui} not found`);
  const groups: { relation: string; label: string; total: number; items: Concept[] }[] = [];
  const add = (relation: string, label: string, items: Concept[], total = items.length): void => {
    const seen = new Set<string>();
    const uniq = items.filter((i) => i.rxcui !== c.rxcui && !seen.has(i.rxcui) && seen.add(i.rxcui));
    if (uniq.length) groups.push({ relation, label, total: Math.max(total, uniq.length), items: uniq });
  };
  const tty = c.tty;
  if (["IN", "PIN", "MIN"].includes(tty)) {
    const scdc = await byPrefix(q, `${c.name} `, ["SCDC"], 12);
    add("ingredient_of", "成分 → 臨床藥品成分（SCDC）", scdc.items, scdc.total);
    const scdf = await byPrefix(q, `${c.name} `, ["SCDF", "SCDG"], 12);
    add("ingredient_of", "成分 → 臨床劑型（SCDF / SCDG）", scdf.items, scdf.total);
    const scd = await byPrefix(q, `${c.name} `, ["SCD"], 16);
    add("ingredient_of", "成分 → 臨床藥品（SCD）", scd.items, scd.total);
    const sbd = await byPrefix(q, `${c.name} `, ["SBD"], 16);
    add("ingredient_of", "成分 → 品牌藥品（SBD）", sbd.items, sbd.total);
  } else if (["SCD", "SBD", "SCDC", "SBDC", "SCDF", "SBDF", "SCDG", "SBDG", "GPCK", "BPCK"].includes(tty)) {
    const p = parseDrugName(c.name);
    const ins = await byNames(q, p.ingredients, ["IN", "PIN", "MIN"]);
    add("has_ingredient", "成分（IN / PIN）", ins);
    if (p.components.length && (tty === "SCD" || tty === "SBD")) add("consists_of", "臨床藥品成分（SCDC）", await byNames(q, p.components, ["SCDC"]));
    if (p.doseForm) add("has_dose_form", "劑型（DF）", await byNames(q, [p.doseForm], ["DF"]));
    if (p.brand) {
      add("has_tradename", "品牌名（BN）", await byNames(q, [p.brand], ["BN"]));
      add("tradename_of", "對應學名藥（SCD）", await byNames(q, [p.clinical], ["SCD"]));
    } else if (tty === "SCD") {
      const sbd = await byPrefix(q, `${c.name} [`, ["SBD"], 16);
      add("tradename_of", "品牌版本（SBD）", sbd.items, sbd.total);
    }
    if (p.ingredients.length && p.doseForm && (tty === "SCD" || tty === "SBD")) {
      add("isa", "臨床劑型（SCDF）", await byNames(q, [`${p.ingredients.join(" / ")} ${p.doseForm}`], ["SCDF"]));
    }
  } else if (tty === "BN") {
    const sbd = await byPrefix(q, "", ["SBD"], 20, `% [${likeEscape(c.name)}]`, c.name);
    add("has_tradename", "品牌名 → 品牌藥品（SBD）", sbd.items, sbd.total);
  } else if (tty === "DF") {
    const scd = await byPrefix(q, "", ["SCD"], 12, `% ${likeEscape(c.name)}`, c.name);
    add("dose_form_of", "使用此劑型的臨床藥品（SCD）", scd.items, scd.total);
  }
  return { concept: { ...c, tty_label: TTY_LABEL[tty] ?? tty }, parsed: parseDrugName(c.name), groups, derived: "name", has_relationships: false };
}
