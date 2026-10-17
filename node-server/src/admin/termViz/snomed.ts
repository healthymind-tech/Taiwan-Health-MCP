/**
 * SNOMED CT focus-concept neighbourhood for the explorer graph: the concept
 * card (FSN, preferred term, synonyms, semantic tag), all IS-A parents (poly-
 * hierarchy), a page of children, attribute relationships (finding site,
 * causative agent, …), ICD-10 maps, and — for inactive concepts — the
 * historical associations (SAME AS / REPLACED BY …) pointing at live content.
 *
 * Concept ids exceed 2^53, so they stay strings end-to-end (bound as text and
 * cast ::bigint in SQL).
 */

import { ftsPrefixQuery, num, str, TermVizError, type Q, type Row } from "./common.js";

export const ISA = "116680003";
export const FSN = "900000000000003001";
export const SYNONYM = "900000000000013009";
export const DEFINED = "900000000000073002";

export const HIST_ASSOC: Record<string, { rank: number; label: string }> = {
  "900000000000527005": { rank: 1, label: "SAME AS" },
  "900000000000526001": { rank: 2, label: "REPLACED BY" },
  "1186924009": { rank: 3, label: "POSSIBLY REPLACED BY" },
  "900000000000523009": { rank: 4, label: "POSSIBLY EQUIVALENT TO" },
  "1186921001": { rank: 5, label: "POSSIBLY EQUIVALENT TO" },
  "900000000000528000": { rank: 6, label: "WAS A" },
  "900000000000530003": { rank: 7, label: "ALTERNATIVE" },
  "900000000000525002": { rank: 8, label: "MOVED FROM" },
  "900000000000524003": { rank: 9, label: "MOVED TO" },
  "900000000000531004": { rank: 10, label: "REFERS TO" },
  "1186919001": { rank: 11, label: "PARTIALLY EQUIVALENT TO" },
};

export function isConceptId(v: string): boolean {
  return /^\d{6,18}$/.test(v);
}

/** "Diabetes mellitus (disorder)" → "disorder". */
export function semanticTag(fsn: string | null | undefined): string | null {
  const m = /\(([^()]+)\)\s*$/.exec(fsn ?? "");
  return m ? m[1] : null;
}

export interface ConceptRef {
  id: string;
  term: string;
  fsn: string | null;
  tag: string | null;
  active: boolean;
  has_children?: boolean;
}

/**
 * Pick display terms per concept from description rows: FSN (type FSN) and the
 * US-preferred synonym, falling back to the first synonym, then the FSN without
 * its tag.
 */
export function pickTerms(rows: Row[]): Map<string, { fsn: string | null; pt: string | null; synonyms: string[] }> {
  const out = new Map<string, { fsn: string | null; pt: string | null; synonyms: string[] }>();
  for (const r of rows) {
    const id = str(r.concept_id);
    const e = out.get(id) ?? { fsn: null, pt: null, synonyms: [] };
    const type = str(r.type_id);
    const term = str(r.term);
    if (type === FSN) e.fsn = e.fsn ?? term;
    else {
      if (r.us_preferred && !e.pt) e.pt = term;
      if (!e.synonyms.includes(term)) e.synonyms.push(term);
    }
    out.set(id, e);
  }
  for (const e of out.values()) {
    if (!e.pt) e.pt = e.synonyms[0] ?? (e.fsn ? e.fsn.replace(/\s*\([^()]+\)\s*$/, "") : null);
  }
  return out;
}

async function activeTerms(q: Q, ids: string[]): Promise<Map<string, { fsn: string | null; pt: string | null; synonyms: string[] }>> {
  if (ids.length === 0) return new Map();
  const r = await q(
    `SELECT concept_id::text AS concept_id, type_id::text AS type_id, term, us_preferred
       FROM snomed.descriptions
      WHERE concept_id = ANY($1::bigint[]) AND active
      ORDER BY us_preferred DESC, description_id`,
    [ids],
  );
  return pickTerms(r.rows);
}

async function inactiveTerms(q: Q, ids: string[]): Promise<Map<string, { fsn: string | null; pt: string | null; synonyms: string[] }>> {
  if (ids.length === 0) return new Map();
  const r = await q(
    `SELECT concept_id::text AS concept_id, type_id::text AS type_id, term, false AS us_preferred
       FROM snomed.inactive_descriptions
      WHERE concept_id = ANY($1::bigint[])
      ORDER BY description_id`,
    [ids],
  );
  return pickTerms(r.rows);
}

/** Display refs for a set of ids, active or inactive. */
async function refs(q: Q, ids: string[]): Promise<Map<string, ConceptRef>> {
  const uniq = [...new Set(ids)];
  const out = new Map<string, ConceptRef>();
  if (uniq.length === 0) return out;
  const act = await q("SELECT concept_id::text AS id FROM snomed.concepts WHERE concept_id = ANY($1::bigint[]) AND active", [uniq]);
  const activeSet = new Set(act.rows.map((r) => str(r.id)));
  const at = await activeTerms(q, uniq.filter((i) => activeSet.has(i)));
  const it = await inactiveTerms(q, uniq.filter((i) => !activeSet.has(i)));
  for (const id of uniq) {
    const t = at.get(id) ?? it.get(id);
    out.set(id, { id, term: t?.pt ?? id, fsn: t?.fsn ?? null, tag: semanticTag(t?.fsn), active: activeSet.has(id) });
  }
  return out;
}

export interface Neighbourhood {
  concept: {
    id: string;
    active: boolean;
    fsn: string | null;
    pt: string | null;
    tag: string | null;
    synonyms: string[];
    defined: boolean | null;
    effective_time: string | null;
    module_id: string | null;
  };
  parents: ConceptRef[];
  children: { total: number; offset: number; items: ConceptRef[] };
  attributes: { type_id: string; type: string; target: ConceptRef }[];
  /** Concepts that point to this one through an attribute (e.g. what has this finding site), sampled. */
  inbound_attribute_count: number;
  associations: { refset_id: string; label: string; target: ConceptRef }[];
  icd10_maps: { group: number; priority: number; target: string; rule: string | null; advice: string | null }[];
}

/** Group attribute rows, sorted by type then target term (pure, for tests). */
export function shapeAttributes(rows: { type_id: string; target_id: string }[], terms: Map<string, ConceptRef>): Neighbourhood["attributes"] {
  return rows
    .filter((r) => r.type_id !== ISA)
    .map((r) => ({
      type_id: r.type_id,
      type: terms.get(r.type_id)?.term ?? r.type_id,
      target: terms.get(r.target_id) ?? { id: r.target_id, term: r.target_id, fsn: null, tag: null, active: false },
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.target.term.localeCompare(b.target.term));
}

export function shapeAssociations(rows: { refset_id: string; target_id: string }[], terms: Map<string, ConceptRef>): Neighbourhood["associations"] {
  return rows
    .map((r) => ({
      refset_id: r.refset_id,
      label: HIST_ASSOC[r.refset_id]?.label ?? "ASSOCIATED WITH",
      rank: HIST_ASSOC[r.refset_id]?.rank ?? 99,
      target: terms.get(r.target_id) ?? { id: r.target_id, term: r.target_id, fsn: null, tag: null, active: false },
    }))
    .sort((a, b) => a.rank - b.rank || a.target.term.localeCompare(b.target.term))
    .map(({ rank: _rank, ...rest }) => rest);
}

export async function snomedNeighbourhood(q: Q, id: string, childOffset = 0, childLimit = 24): Promise<Neighbourhood> {
  if (!isConceptId(id)) throw new TermVizError(400, "SNOMED CT concept ids are 6–18 digits");
  const c = await q(
    "SELECT concept_id::text AS id, active, definition_status_id::text AS ds, effective_time::text AS et, module_id::text AS mod FROM snomed.concepts WHERE concept_id = $1::bigint",
    [id],
  );
  let row = c.rows[0];
  let active = Boolean(row?.active);
  if (!row) {
    const ic = await q(
      "SELECT concept_id::text AS id, effective_time::text AS et, module_id::text AS mod FROM snomed.inactive_concepts WHERE concept_id = $1::bigint",
      [id],
    );
    row = ic.rows[0];
    active = false;
    if (!row) throw new TermVizError(404, `SNOMED CT concept ${id} not found`);
  }

  const terms = active ? await activeTerms(q, [id]) : await inactiveTerms(q, [id]);
  const t = terms.get(id);

  let parents: ConceptRef[] = [];
  let children: Neighbourhood["children"] = { total: 0, offset: childOffset, items: [] };
  let attributes: Neighbourhood["attributes"] = [];
  let inbound = 0;
  let associations: Neighbourhood["associations"] = [];
  let maps: Neighbourhood["icd10_maps"] = [];

  if (active) {
    const out = await q(
      `SELECT type_id::text AS type_id, destination_id::text AS target_id
         FROM snomed.relationships WHERE source_id = $1::bigint AND active`,
      [id],
    );
    const outRows = out.rows.map((r) => ({ type_id: str(r.type_id), target_id: str(r.target_id) }));
    const parentIds = outRows.filter((r) => r.type_id === ISA).map((r) => r.target_id);
    const attrRows = outRows.filter((r) => r.type_id !== ISA);
    const page = await snomedChildren(q, id, childOffset, childLimit);
    children = page;
    const inb = await q(
      `SELECT COUNT(*)::int AS n FROM snomed.relationships WHERE destination_id = $1::bigint AND active AND type_id <> ${ISA}`,
      [id],
    );
    inbound = num(inb.rows[0]?.n);
    const r = await refs(q, [...parentIds, ...attrRows.flatMap((a) => [a.type_id, a.target_id])]);
    parents = parentIds.map((p) => r.get(p)!).sort((a, b) => a.term.localeCompare(b.term));
    attributes = shapeAttributes(attrRows, r);
    const m = await q(
      `SELECT map_group, map_priority, map_target, map_rule, map_advice FROM snomed.icd10_map
        WHERE referenced_component_id = $1::bigint AND active AND map_target IS NOT NULL AND map_target <> ''
        ORDER BY map_group, map_priority LIMIT 20`,
      [id],
    );
    maps = m.rows.map((x) => ({
      group: num(x.map_group),
      priority: num(x.map_priority),
      target: str(x.map_target),
      rule: (x.map_rule as string) || null,
      advice: (x.map_advice as string) || null,
    }));
  } else {
    const a = await q(
      `SELECT refset_id::text AS refset_id, target_component_id::text AS target_id
         FROM snomed.historical_associations WHERE referenced_component_id = $1::bigint`,
      [id],
    );
    const rows = a.rows.map((x) => ({ refset_id: str(x.refset_id), target_id: str(x.target_id) }));
    associations = shapeAssociations(rows, await refs(q, rows.map((x) => x.target_id)));
  }

  return {
    concept: {
      id,
      active,
      fsn: t?.fsn ?? null,
      pt: t?.pt ?? null,
      tag: semanticTag(t?.fsn),
      synonyms: (t?.synonyms ?? []).filter((s) => s !== t?.pt),
      defined: row.ds ? str(row.ds) === DEFINED : null,
      effective_time: (row.et as string) ?? null,
      module_id: (row.mod as string) ?? null,
    },
    parents,
    children,
    attributes,
    inbound_attribute_count: inbound,
    associations,
    icd10_maps: maps,
  };
}

/** Children page, ordered by preferred term, each flagged with has_children. */
export async function snomedChildren(q: Q, id: string, offset: number, limit: number): Promise<Neighbourhood["children"]> {
  if (!isConceptId(id)) throw new TermVizError(400, "SNOMED CT concept ids are 6–18 digits");
  const r = await q(
    `WITH kids AS (
       SELECT DISTINCT source_id FROM snomed.relationships
        WHERE destination_id = $1::bigint AND type_id = ${ISA} AND active
     ), named AS (
       SELECT k.source_id,
              (SELECT d.term FROM snomed.descriptions d
                WHERE d.concept_id = k.source_id AND d.active AND d.type_id = ${SYNONYM}
                ORDER BY d.us_preferred DESC, d.description_id LIMIT 1) AS term
         FROM kids k
     )
     SELECT source_id::text AS id, term, COUNT(*) OVER ()::int AS total
       FROM named ORDER BY lower(term), source_id LIMIT $2 OFFSET $3`,
    [id, limit, offset],
  );
  const ids = r.rows.map((x) => str(x.id));
  const total = num(r.rows[0]?.total);
  if (ids.length === 0) {
    // Past the end, or a leaf: still report the true total.
    const c = await q(`SELECT COUNT(DISTINCT source_id)::int AS n FROM snomed.relationships WHERE destination_id = $1::bigint AND type_id = ${ISA} AND active`, [id]);
    return { total: num(c.rows[0]?.n), offset, items: [] };
  }
  const [terms, grand] = await Promise.all([
    refs(q, ids),
    q(
      `SELECT DISTINCT destination_id::text AS id FROM snomed.relationships
        WHERE destination_id = ANY($1::bigint[]) AND type_id = ${ISA} AND active`,
      [ids],
    ),
  ]);
  const withKids = new Set(grand.rows.map((x) => str(x.id)));
  return { total, offset, items: ids.map((i) => ({ ...terms.get(i)!, has_children: withKids.has(i) })) };
}

/** Typeahead: concept id, or English term (FTS on active descriptions). */
export async function snomedSearch(q: Q, text: string, limit = 20): Promise<ConceptRef[]> {
  const t = text.trim();
  if (!t) return [];
  if (isConceptId(t)) {
    const r = await refs(q, [t]);
    const hit = r.get(t);
    const exists = await q(
      "SELECT 1 FROM snomed.concepts WHERE concept_id = $1::bigint UNION ALL SELECT 1 FROM snomed.inactive_concepts WHERE concept_id = $1::bigint LIMIT 1",
      [t],
    );
    return hit && exists.rows.length ? [hit] : [];
  }
  const tsq = ftsPrefixQuery(t);
  if (!tsq) return [];
  // Shortest matching terms first; dedupe per concept in JS (DISTINCT ON would
  // sort every match of a common word).
  const r = await q(
    `SELECT concept_id::text AS id, term FROM snomed.descriptions d
      WHERE to_tsvector('english', COALESCE(d.term, '')) @@ to_tsquery('english', $1) AND d.active
      ORDER BY length(d.term) LIMIT 200`,
    [tsq],
  );
  const seen = new Set<string>();
  const best = r.rows.filter((x) => !seen.has(str(x.id)) && seen.add(str(x.id))).slice(0, limit);
  const ref = await refs(q, best.map((x) => str(x.id)));
  return best.map((x) => ref.get(str(x.id))!).filter(Boolean);
}
