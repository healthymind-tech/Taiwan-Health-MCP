/**
 * SNOMED CT service — search, concept detail, hierarchy traversal, ICD-10 mapping.
 *
 * Faithful port of `src/snomed_service.py`. Data is pre-loaded into PostgreSQL
 * from the International RF2 release; all concepts are English-only.
 *
 * Parity note on integer types: SNOMED IDs are PostgreSQL `bigint`. node-postgres
 * returns bigint as a **string** (asyncpg returns Python int). The well-known
 * metadata type constants (e.g. FSN_TYPE 900000000000003001) exceed JS
 * `Number.MAX_SAFE_INTEGER`, so they are kept as string literals and passed as
 * string query params (node-pg binds them losslessly to bigint columns). Realistic
 * clinical concept IDs are within safe range and are coerced to `number` at output
 * to match Python's int (`asNum`).
 */

import { query } from "./db.js";
import { logError, logInfo } from "./logger.js";
import type { EmbeddingService } from "./embeddingService.js";
import { vecLiteral } from "./embeddingService.js";
import { rankSnomed } from "./terminologyRanking.js";

// SNOMED type constants (kept as strings to avoid JS precision loss on the
// 18-digit metadata IDs; compared against bigint columns returned as strings).
const FSN_TYPE = "900000000000003001"; // Fully Specified Name
const SYNONYM_TYPE = "900000000000013009"; // Synonym
const IS_A_TYPE = "116680003"; // Is-a relationship

// definitionStatusId → human-readable label (keys are bigint strings).
const DEFINITION_STATUS: Record<string, string> = {
  "900000000000074008": "primitive",
  "900000000000073002": "fully_defined",
};

/** Coerce a bigint string from pg to a JS number, mirroring asyncpg's int. */
function asNum(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

/**
 * Extract the SNOMED semantic tag from a Fully Specified Name, e.g.
 * "Myocardial infarction (disorder)" → "disorder". Null when absent.
 */
function hierarchyTag(fsn: string | null): string | null {
  if (!fsn) return null;
  const match = fsn.match(/\(([^()]+)\)\s*$/);
  return match ? match[1] : null;
}


export class SnomedService {
  private embeddingSvc: EmbeddingService | null;

  constructor(embeddingSvc: EmbeddingService | null = null) {
    this.embeddingSvc = embeddingSvc;
  }

  async initialize(): Promise<void> {
    const res = await query<{ count: string }>("SELECT COUNT(*) AS count FROM snomed.concepts");
    const count = Number(res.rows[0]?.count ?? 0);
    if (count === 0) {
      logError("SNOMED CT table empty — run data-loader (--snomed) first");
    } else {
      logInfo("SNOMEDService ready", { concepts: count });
    }
  }

  /**
   * Hybrid concept search: full-text over active descriptions ∪ nearest FSN vectors,
   * ordered by score-aware fusion over every active name of each concept
   * (terminologyRanking.ts). Keyword-only without a query vector.
   */
  async searchConcepts(
    queryText: string,
    limit = 3,
    hierarchyFilter: number | null = null,
  ): Promise<Record<string, unknown>[]> {
    limit = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(queryText, "snomed") : null;
    const vecStr = vecLiteral(vec);
    const ranked = await rankSnomed(queryText, vecStr, limit, { hierarchy: hierarchyFilter ? String(hierarchyFilter) : null });
    return ranked.map((r) => ({
      concept_id: asNum(r.concept_id),
      fsn: r.fsn,
      preferred_term: r.preferred,
      hierarchy_tag: hierarchyTag(r.fsn),
      active: r.active,
    }));
  }

  /** Mirror of `SNOMEDService.get_concept`. Returns null when not found. */
  async getConcept(conceptId: number): Promise<Record<string, unknown> | null> {
    const cid = String(conceptId);
    const conceptRes = await query<Record<string, unknown>>(
      "SELECT * FROM snomed.concepts WHERE concept_id = $1",
      [cid],
    );
    const concept = conceptRes.rows[0];
    if (!concept) return null;

    const descriptions = await query<{ term: string; type_id: string }>(
      `SELECT term, type_id FROM snomed.descriptions
       WHERE concept_id = $1 AND active = TRUE
       ORDER BY CASE WHEN type_id = $2 THEN 0 ELSE 1 END`,
      [cid, FSN_TYPE],
    );

    const parents = await query<{ parent_id: string; parent_term: string | null }>(
      `SELECT r.destination_id AS parent_id, d.term AS parent_term
       FROM snomed.relationships r
       LEFT JOIN snomed.descriptions d ON d.concept_id = r.destination_id
           AND d.type_id = $2 AND d.active = TRUE
       WHERE r.source_id = $1 AND r.type_id = $3 AND r.active = TRUE
       LIMIT 20`,
      [cid, FSN_TYPE, IS_A_TYPE],
    );

    const icdMaps = await query<{
      map_target: string | null;
      map_rule: string | null;
      map_advice: string | null;
      map_priority: number | null;
      map_group: number | null;
    }>(
      `SELECT map_target, map_rule, map_advice, map_priority, map_group
       FROM snomed.icd10_map
       WHERE referenced_component_id = $1 AND active = TRUE
       ORDER BY map_group, map_priority`,
      [cid],
    );

    const fsn = descriptions.rows.find((r) => r.type_id === FSN_TYPE)?.term ?? null;
    const synonyms = descriptions.rows.filter((r) => r.type_id === SYNONYM_TYPE).map((r) => r.term);

    return {
      concept_id: asNum(concept.concept_id as string),
      fsn,
      hierarchy_tag: hierarchyTag(fsn),
      synonyms,
      active: concept.active,
      definition_status:
        DEFINITION_STATUS[String(concept.definition_status_id)] ?? "unknown",
      parents: parents.rows.map((p) => ({ concept_id: asNum(p.parent_id), fsn: p.parent_term })),
      icd10_maps: icdMaps.rows.map((m) => ({
        icd10_code: m.map_target,
        rule: m.map_rule,
        advice: m.map_advice,
        priority: m.map_priority,
        group: m.map_group,
      })),
    };
  }

  /** Mirror of `SNOMEDService.get_children`. */
  async getChildren(conceptId: number, limit = 50): Promise<Record<string, unknown>[]> {
    const r = await query<{ child_id: string; child_term: string | null }>(
      `SELECT r.source_id AS child_id, d.term AS child_term
       FROM snomed.relationships r
       LEFT JOIN snomed.descriptions d ON d.concept_id = r.source_id
           AND d.type_id = $2 AND d.active = TRUE
       WHERE r.destination_id = $1 AND r.type_id = $3 AND r.active = TRUE
       LIMIT $4`,
      [String(conceptId), FSN_TYPE, IS_A_TYPE, limit],
    );
    return r.rows.map((row) => ({ concept_id: asNum(row.child_id), fsn: row.child_term }));
  }

  /** Mirror of `SNOMEDService.get_ancestors`. */
  async getAncestors(conceptId: number, maxDepth = 10): Promise<Record<string, unknown>[]> {
    const r = await query<{ concept_id: string; depth: number; fsn: string | null }>(
      `WITH RECURSIVE ancestors(concept_id, depth) AS (
           SELECT destination_id, 1
           FROM snomed.relationships
           WHERE source_id = $1 AND type_id = $3 AND active = TRUE
           UNION
           SELECT r.destination_id, a.depth + 1
           FROM snomed.relationships r
           JOIN ancestors a ON r.source_id = a.concept_id
           WHERE r.type_id = $3 AND r.active = TRUE AND a.depth < $2
       )
       SELECT DISTINCT a.concept_id, a.depth, d.term AS fsn
       FROM ancestors a
       LEFT JOIN snomed.descriptions d ON d.concept_id = a.concept_id
           AND d.type_id = $4 AND d.active = TRUE
       ORDER BY a.depth, a.concept_id`,
      [String(conceptId), maxDepth, IS_A_TYPE, FSN_TYPE],
    );
    return r.rows.map((row) => ({ concept_id: asNum(row.concept_id), fsn: row.fsn, depth: row.depth }));
  }

  /** Mirror of `SNOMEDService.get_relationships` (non-IS-A, grouped by type). */
  async getRelationships(
    conceptId: number,
    relationshipTypeId: number | null = null,
  ): Promise<Record<string, unknown>[]> {
    interface RelRow {
      type_id: string;
      destination_id: string;
      relationship_type: string | null;
      target_term: string | null;
    }
    let rows: RelRow[];
    if (relationshipTypeId) {
      const r = await query<RelRow>(
        `SELECT r.type_id, r.destination_id,
                dt.term AS relationship_type,
                dd.term AS target_term
         FROM snomed.relationships r
         LEFT JOIN snomed.descriptions dt
             ON dt.concept_id = r.type_id AND dt.type_id = $3 AND dt.active = TRUE
         LEFT JOIN snomed.descriptions dd
             ON dd.concept_id = r.destination_id AND dd.type_id = $3 AND dd.active = TRUE
         WHERE r.source_id = $1 AND r.active = TRUE AND r.type_id = $2
         ORDER BY r.type_id, r.destination_id
         LIMIT 100`,
        // No IS_A_TYPE here: an unreferenced bind parameter has no inferable type and
        // Postgres rejects the whole statement ("could not determine data type of parameter").
        [String(conceptId), String(relationshipTypeId), FSN_TYPE],
      );
      rows = r.rows;
    } else {
      const r = await query<RelRow>(
        `SELECT r.type_id, r.destination_id,
                dt.term AS relationship_type,
                dd.term AS target_term
         FROM snomed.relationships r
         LEFT JOIN snomed.descriptions dt
             ON dt.concept_id = r.type_id AND dt.type_id = $3 AND dt.active = TRUE
         LEFT JOIN snomed.descriptions dd
             ON dd.concept_id = r.destination_id AND dd.type_id = $3 AND dd.active = TRUE
         WHERE r.source_id = $1 AND r.active = TRUE AND r.type_id != $2
         ORDER BY r.type_id, r.destination_id
         LIMIT 100`,
        [String(conceptId), IS_A_TYPE, FSN_TYPE],
      );
      rows = r.rows;
    }

    // Group by relationship type, preserving first-seen order (mirrors Python dict).
    const byType = new Map<string, { typeId: string; targets: Record<string, unknown>[] }>();
    for (const r of rows) {
      const typeName = r.relationship_type ?? String(r.type_id);
      if (!byType.has(typeName)) byType.set(typeName, { typeId: r.type_id, targets: [] });
      byType.get(typeName)!.targets.push({ concept_id: asNum(r.destination_id), fsn: r.target_term });
    }

    return [...byType.entries()].map(([k, v]) => ({
      relationship_type: k,
      type_concept_id: asNum(v.typeId),
      targets: v.targets,
    }));
  }

  /** Mirror of `SNOMEDService.map_icd_to_snomed`. */
  async mapIcdToSnomed(icdCode: string): Promise<Record<string, unknown>[]> {
    const code = icdCode.toUpperCase();
    const r = await query<{
      concept_id: string;
      map_rule: string | null;
      map_advice: string | null;
      map_priority: number | null;
      map_group: number | null;
      fsn: string | null;
    }>(
      `SELECT m.referenced_component_id AS concept_id,
              m.map_rule, m.map_advice, m.map_priority, m.map_group,
              d.term AS fsn
       FROM snomed.icd10_map m
       LEFT JOIN snomed.descriptions d ON d.concept_id = m.referenced_component_id
           AND d.type_id = $2 AND d.active = TRUE
       WHERE m.map_target = $1 AND m.active = TRUE
       ORDER BY m.map_group, m.map_priority`,
      [code, FSN_TYPE],
    );
    return r.rows.map((row) => ({
      concept_id: asNum(row.concept_id),
      fsn: row.fsn,
      icd10_code: code,
      map_rule: row.map_rule,
      map_advice: row.map_advice,
      map_priority: row.map_priority,
      map_group: row.map_group,
    }));
  }

  /** Mirror of `SNOMEDService.map_snomed_to_icd`. */
  async mapSnomedToIcd(conceptId: number): Promise<Record<string, unknown>[]> {
    const r = await query<{
      map_target: string;
      map_rule: string | null;
      map_advice: string | null;
      map_priority: number | null;
      map_group: number | null;
    }>(
      `SELECT map_target, map_rule, map_advice, map_priority, map_group
       FROM snomed.icd10_map
       WHERE referenced_component_id = $1 AND active = TRUE
         AND map_target IS NOT NULL AND map_target <> ''
       ORDER BY map_group, map_priority`,
      [String(conceptId)],
    );
    return r.rows.map((row) => ({
      icd10_code: row.map_target,
      map_rule: row.map_rule,
      map_advice: row.map_advice,
      map_priority: row.map_priority,
      map_group: row.map_group,
    }));
  }
}
