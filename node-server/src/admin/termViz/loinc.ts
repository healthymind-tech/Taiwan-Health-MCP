/**
 * LOINC explorer: faceted browsing over the six axes (+ class / status) with
 * counts, and a term card (axis bar with Part codes, answer lists LL → LA,
 * panel members, MapTo replacement, Taiwan mapping and reference ranges).
 *
 * The structure tables (part_links, answer_list_items / _links, panel_items,
 * map_to; migration 20261020_loinc_structure.sql) are optional: an install
 * that has not re-imported LOINC since simply gets those sections empty.
 */

import { ftsPrefixQuery, hasCjk, likeEscape, num, str, tableExists, TermVizError, VersionedCache, type Q, type Row } from "./common.js";

/** Facet key → loinc.concepts column (whitelist; keys are client-visible). */
export const LOINC_FACETS: Record<string, string> = {
  component: "component",
  property: "property",
  time: "time_aspect",
  system: "system",
  scale: "scale_type",
  method: "method_type",
  class: "class",
  status: "status",
};

export const LOINC_AXES = ["component", "property", "time", "system", "scale", "method"] as const;

/** Part type names in LoincPartLink_Primary.csv, by facet key. */
export const PART_TYPE_OF_AXIS: Record<string, string> = {
  component: "COMPONENT",
  property: "PROPERTY",
  time: "TIME",
  system: "SYSTEM",
  scale: "SCALE",
  method: "METHOD",
};

export type LoincFilters = Partial<Record<keyof typeof LOINC_FACETS, string>> & { q?: string };

/** Same expression as idx_loinc_fts (must match to use the index). */
const LOINC_FTS =
  "to_tsvector('simple'::regconfig, (((((((COALESCE(loinc_num, ''::text) || ' '::text) || COALESCE(long_common_name, ''::text)) || ' '::text) || COALESCE(shortname, ''::text)) || ' '::text) || COALESCE(name_zh, ''::text)) || ' '::text) || COALESCE(common_name_zh, ''::text))";

export function isLoincNum(s: string): boolean {
  return /^\d{1,7}-\d$/.test(s.trim());
}

/**
 * WHERE clause for the active filters, optionally leaving one facet out (a
 * facet's own counts ignore its own selection, so the user can switch value).
 * "∅" selects empty values (e.g. method-less terms).
 */
export function loincWhere(filters: LoincFilters, exclude?: string): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of Object.entries(LOINC_FACETS)) {
    if (key === exclude) continue;
    const v = filters[key as keyof LoincFilters];
    if (v === undefined || v === "") continue;
    if (v === "∅") {
      parts.push(`COALESCE(${col}, '') = ''`);
      continue;
    }
    params.push(v);
    parts.push(`${col} = $${params.length}`);
  }
  const text = (filters.q ?? "").trim();
  if (text) {
    if (isLoincNum(text) || /^\d{2,7}-?$/.test(text)) {
      params.push(`${likeEscape(text)}%`);
      parts.push(`loinc_num LIKE $${params.length} ESCAPE '\\'`);
    } else if (hasCjk(text)) {
      params.push(text);
      const i = params.length;
      parts.push(`(strpos(COALESCE(name_zh, ''), $${i}) > 0 OR strpos(COALESCE(common_name_zh, ''), $${i}) > 0 OR strpos(COALESCE(specimen_type, ''), $${i}) > 0)`);
    } else {
      const tsq = ftsPrefixQuery(text);
      if (tsq) {
        params.push(tsq);
        parts.push(`${LOINC_FTS} @@ to_tsquery('simple', $${params.length})`);
      }
    }
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

export function parseLoincFilters(params: Record<string, unknown>): LoincFilters {
  const f: LoincFilters = {};
  for (const key of Object.keys(LOINC_FACETS)) {
    const v = str(params[key]).trim();
    if (v) (f as Record<string, string>)[key] = v.slice(0, 200);
  }
  const q = str(params.q).trim();
  if (q) f.q = q.slice(0, 200);
  return f;
}

const facetCache = new VersionedCache<Row>(5 * 60_000, 64);

async function loincVersion(q: Q): Promise<string> {
  const r = await q("SELECT loaded_at::text AS v FROM loinc.editions WHERE code_system = 'loinc'");
  return str(r.rows[0]?.v) || "none";
}

/** Facet counts (top N per axis) + a page of matching terms. */
export async function loincFacets(q: Q, filters: LoincFilters, page: number, perPage: number, facetLimit = 24): Promise<Row> {
  const version = await loincVersion(q);
  const cacheKey = JSON.stringify([filters, page, perPage, facetLimit]);
  return facetCache.get(cacheKey, version, async () => {
    const where = loincWhere(filters);
    const offset = (page - 1) * perPage;
    // Free text: exact component / Chinese-name hits first ("glucose" → Glucose, not "Glucose^30M post…").
    const text = (filters.q ?? "").trim();
    const rank =
      text && !isLoincNum(text)
        ? { sql: `(lower(component) = lower($${where.params.length + 1}) OR name_zh = $${where.params.length + 1}) DESC, `, params: [text] }
        : { sql: "", params: [] as unknown[] };
    const facetQueries = Object.entries(LOINC_FACETS).map(async ([key, col]) => {
      const w = loincWhere(filters, key);
      const r = await q(
        `SELECT COALESCE(NULLIF(${col}, ''), '∅') AS value, COUNT(*)::int AS n
           FROM loinc.concepts ${w.sql}
          GROUP BY 1 ORDER BY n DESC, value LIMIT ${facetLimit + 1}`,
        w.params,
      );
      return [key, r.rows.map((x) => ({ value: str(x.value), count: num(x.n) }))] as const;
    });
    const [total, rows, ...facets] = await Promise.all([
      q(`SELECT COUNT(*)::int AS n FROM loinc.concepts ${where.sql}`, where.params),
      q(
        `SELECT loinc_num, long_common_name, shortname, component, property, time_aspect, system, scale_type, method_type, class, status, name_zh
           FROM loinc.concepts ${where.sql}
          ORDER BY ${rank.sql}(status = 'ACTIVE') DESC, length(long_common_name), loinc_num
          LIMIT ${perPage} OFFSET ${offset}`,
        [...where.params, ...rank.params],
      ),
      ...facetQueries,
    ]);
    const facetObj: Record<string, { value: string; count: number }[]> = {};
    const more: Record<string, boolean> = {};
    for (const [key, list] of facets) {
      more[key] = list.length > facetLimit;
      facetObj[key] = list.slice(0, facetLimit);
    }
    return { total: num(total.rows[0]?.n), page, per_page: perPage, rows: rows.rows, facets: facetObj, facets_truncated: more, filters };
  });
}

/** Search one facet's values (for the "more…" picker), respecting the other filters. */
export async function loincFacetValues(q: Q, facet: string, filters: LoincFilters, text: string, limit = 50): Promise<Row[]> {
  const col = LOINC_FACETS[facet];
  if (!col) throw new TermVizError(400, `Unknown facet ${facet}`);
  const w = loincWhere(filters, facet);
  const params = [...w.params];
  let extra = "";
  if (text.trim()) {
    params.push(`%${likeEscape(text.trim())}%`);
    extra = `${w.sql ? " AND" : "WHERE"} ${col} ILIKE $${params.length} ESCAPE '\\'`;
  }
  const r = await q(
    `SELECT COALESCE(NULLIF(${col}, ''), '∅') AS value, COUNT(*)::int AS n FROM loinc.concepts ${w.sql}${extra}
      GROUP BY 1 ORDER BY n DESC, value LIMIT ${limit}`,
    params,
  );
  return r.rows.map((x) => ({ value: str(x.value), count: num(x.n) }));
}

export interface AxisCell {
  axis: string;
  value: string;
  parts: { part_number: string; part_name: string | null }[];
}

/** Axis bar cells from the concept row + its part links (pure). */
export function buildAxisBar(concept: Row, partLinks: Row[]): AxisCell[] {
  return LOINC_AXES.map((axis) => {
    const value = str(concept[LOINC_FACETS[axis]]);
    const parts = partLinks
      .filter((p) => str(p.part_type) === PART_TYPE_OF_AXIS[axis])
      .map((p) => ({ part_number: str(p.part_number), part_name: (p.part_name as string) ?? null }));
    return { axis, value, parts };
  });
}

/** Group answer-list rows into lists with ordered answers (pure). */
export function groupAnswerLists(links: Row[], items: Row[], names: Map<string, string>): Row[] {
  const byList = new Map<string, Row[]>();
  for (const it of items) {
    const id = str(it.list_id);
    const list = byList.get(id) ?? [];
    list.push({ code: str(it.answer_code), display: (it.display as string) ?? null, seq: it.seq === null || it.seq === undefined ? null : num(it.seq), score: (it.score as string) || null });
    byList.set(id, list);
  }
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const l of links) {
    const id = str(l.list_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const answers = (byList.get(id) ?? []).sort((a, b) => num(a.seq) - num(b.seq) || str(a.code).localeCompare(str(b.code)));
    out.push({ id, name: names.get(id) ?? null, link_type: (l.link_type as string) || null, context: (l.context as string) || null, answers, answer_count: answers.length });
  }
  return out;
}

const structureCache = new VersionedCache<Record<string, boolean>>(60_000, 1);

async function structureTables(q: Q): Promise<Record<string, boolean>> {
  return structureCache.get("t", "1", async () => {
    const names = ["loinc.part_links", "loinc.answer_list_items", "loinc.answer_list_links", "loinc.panel_items", "loinc.map_to"];
    const out: Record<string, boolean> = {};
    for (const n of names) out[n] = await tableExists(q, n);
    return out;
  });
}

/** Full term card. */
export async function loincTerm(q: Q, code: string): Promise<Row> {
  const c = code.trim();
  if (!isLoincNum(c)) throw new TermVizError(400, "LOINC codes look like 2345-7");
  const r = await q("SELECT * FROM loinc.concepts WHERE loinc_num = $1", [c]);
  const concept = r.rows[0];
  if (!concept) throw new TermVizError(404, `LOINC ${c} not found`);
  const has = await structureTables(q);

  const [parts, ranges, mapTo, mappedFrom, panelItems, inPanels, links] = await Promise.all([
    has["loinc.part_links"] ? q("SELECT part_type, part_number, part_name FROM loinc.part_links WHERE loinc_num = $1", [c]) : Promise.resolve({ rows: [] }),
    q(
      "SELECT age_min, age_max, gender, round(range_low::numeric, 4)::float8 AS low, round(range_high::numeric, 4)::float8 AS high, unit, interpretation FROM loinc.reference_ranges WHERE loinc_num = $1 ORDER BY gender, age_min",
      [c],
    ),
    has["loinc.map_to"]
      ? q("SELECT m.map_to, m.comment, t.long_common_name, t.status FROM loinc.map_to m LEFT JOIN loinc.concepts t ON t.loinc_num = m.map_to WHERE m.loinc_num = $1", [c])
      : Promise.resolve({ rows: [] }),
    has["loinc.map_to"]
      ? q("SELECT m.loinc_num, t.long_common_name FROM loinc.map_to m LEFT JOIN loinc.concepts t ON t.loinc_num = m.loinc_num WHERE m.map_to = $1 LIMIT 20", [c])
      : Promise.resolve({ rows: [] }),
    has["loinc.panel_items"]
      ? q(
          `SELECT p.seq, p.loinc_num, p.display, p.required, t.long_common_name, t.status,
                  EXISTS (SELECT 1 FROM loinc.panel_items s WHERE s.parent_loinc = p.loinc_num) AS is_panel
             FROM loinc.panel_items p LEFT JOIN loinc.concepts t ON t.loinc_num = p.loinc_num
            WHERE p.parent_loinc = $1 ORDER BY p.seq LIMIT 300`,
          [c],
        )
      : Promise.resolve({ rows: [] }),
    has["loinc.panel_items"]
      ? q(
          `SELECT p.parent_loinc, t.long_common_name FROM loinc.panel_items p LEFT JOIN loinc.concepts t ON t.loinc_num = p.parent_loinc
            WHERE p.loinc_num = $1 ORDER BY p.parent_loinc LIMIT 30`,
          [c],
        )
      : Promise.resolve({ rows: [] }),
    has["loinc.answer_list_links"]
      ? q("SELECT list_id, link_type, context FROM loinc.answer_list_links WHERE loinc_num = $1 ORDER BY link_type, list_id", [c])
      : Promise.resolve({ rows: [] }),
  ]);

  let answerLists: Row[] = [];
  if (links.rows.length && has["loinc.answer_list_items"]) {
    const ids = [...new Set(links.rows.map((l) => str(l.list_id)))].slice(0, 6);
    const [items, names] = await Promise.all([
      q("SELECT list_id, seq, answer_code, display, score FROM loinc.answer_list_items WHERE list_id = ANY($1::text[]) ORDER BY list_id, seq LIMIT 600", [ids]),
      q("SELECT code, display FROM loinc.other_codes WHERE code = ANY($1::text[])", [ids]),
    ]);
    answerLists = groupAnswerLists(
      links.rows.filter((l) => ids.includes(str(l.list_id))),
      items.rows,
      new Map(names.rows.map((n) => [str(n.code), str(n.display)])),
    );
  }

  return {
    concept,
    axes: buildAxisBar(concept, parts.rows),
    reference_ranges: ranges.rows,
    map_to: mapTo.rows,
    mapped_from: mappedFrom.rows,
    panel_items: panelItems.rows,
    in_panels: inPanels.rows,
    answer_lists: answerLists,
    answer_list_total: new Set(links.rows.map((l) => str(l.list_id))).size,
    structure_available: has,
  };
}

/** LA / LL / LP / LG lookup (other_codes) with its usage. */
export async function loincOtherCode(q: Q, code: string): Promise<Row> {
  const c = code.trim().toUpperCase();
  if (!/^L[ALPG]\d+-\d$/.test(c)) throw new TermVizError(400, "Expected an LA / LL / LP / LG code");
  const r = await q("SELECT code, kind, display, alt_display, status FROM loinc.other_codes WHERE code = $1", [c]);
  if (!r.rows[0]) throw new TermVizError(404, `${c} not found`);
  const has = await structureTables(q);
  const out: Row = { ...r.rows[0] };
  if (c.startsWith("LL") && has["loinc.answer_list_items"]) {
    const items = await q("SELECT seq, answer_code AS code, display, score FROM loinc.answer_list_items WHERE list_id = $1 ORDER BY seq LIMIT 500", [c]);
    out.answers = items.rows;
    if (has["loinc.answer_list_links"]) {
      const used = await q(
        `SELECT l.loinc_num, t.long_common_name FROM loinc.answer_list_links l LEFT JOIN loinc.concepts t ON t.loinc_num = l.loinc_num
          WHERE l.list_id = $1 ORDER BY l.loinc_num LIMIT 30`,
        [c],
      );
      out.used_by = used.rows;
    }
  }
  if (c.startsWith("LA") && has["loinc.answer_list_items"]) {
    const lists = await q(
      "SELECT i.list_id, o.display FROM loinc.answer_list_items i LEFT JOIN loinc.other_codes o ON o.code = i.list_id WHERE i.answer_code = $1 ORDER BY i.list_id LIMIT 30",
      [c],
    );
    out.in_lists = lists.rows;
  }
  if (c.startsWith("LP") && has["loinc.part_links"]) {
    const n = await q("SELECT part_type, COUNT(*)::int AS n FROM loinc.part_links WHERE part_number = $1 GROUP BY 1", [c]);
    out.term_counts = n.rows;
  }
  return out;
}
