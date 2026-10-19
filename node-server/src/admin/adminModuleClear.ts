/**
 * Scoped module clear: remove a module's embeddings, imported data, uploaded
 * source files, or all three — independently.
 *
 * Before this existed the admin UI called `POST /admin/api/modules/{key}/clear`
 * against a route that did not exist, and there was no way at all to drop a
 * module's vectors while keeping its imported rows (needed when the embedding
 * model changes, or when an embed run produced bad vectors).
 *
 * Scopes:
 *   embeddings — TRUNCATE the module's `*_embeddings` tables, reset its embed marker.
 *   data       — TRUNCATE the imported tables (embeddings go too: they are keyed to
 *                rows that no longer exist), reset load + embed markers.
 *   sources    — delete every uploaded source file (DB rows + objects); imported data stays.
 *   all        — data + sources.
 *
 * Guard rails: refuses while any job for the module is queued/running/paused, and
 * every clear is written to `admin.admin_audit_log`.
 */

import { query, withTransaction } from "../db.js";
import * as minioService from "../minioService.js";
import { broadcast } from "./adminWs.js";

export type ClearScope = "embeddings" | "data" | "sources" | "all";
export const CLEAR_SCOPES: readonly ClearScope[] = ["embeddings", "data", "sources", "all"];

const API_SYNC_MODULES = new Set(["health_supplements", "food_nutrition"]);

export class ModuleClearError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface ModuleClearSpec {
  /** Imported tables, children before parents (TRUNCATE lists them together anyway). */
  data: string[];
  embeddings: string[];
  /** Job types that write this module (a clear must not race them). */
  jobTypes: string[];
}

export const MODULE_CLEAR_SPECS: Record<string, ModuleClearSpec> = {
  icd: {
    data: ["icd.diagnoses", "icd.procedures", "icd.icd10_who", "icd.editions"],
    embeddings: ["icd.diagnosis_embeddings"],
    jobTypes: ["icd_import", "icd_embed"],
  },
  loinc: {
    data: [
      "loinc.reference_ranges", "loinc.concepts", "loinc.other_codes", "loinc.editions",
      "loinc.part_links", "loinc.answer_list_items", "loinc.answer_list_links", "loinc.panel_items", "loinc.map_to", "loinc.component_names",
      "loinc.axis_names",
    ],
    embeddings: ["loinc.concept_embeddings"],
    jobTypes: ["loinc_import", "loinc_embed"],
  },
  snomed: {
    data: [
      "snomed.historical_associations",
      "snomed.icd10_map",
      "snomed.relationships",
      "snomed.descriptions",
      "snomed.concepts",
      "snomed.inactive_descriptions",
      "snomed.inactive_concepts",
      "snomed.editions",
    ],
    embeddings: ["snomed.concept_embeddings"],
    jobTypes: ["snomed_import", "snomed_embed"],
  },
  rxnorm: {
    data: ["rxnorm.concepts"],
    embeddings: [],
    jobTypes: ["rxnorm_import"],
  },
  ig: {
    data: ["fhir.concepts", "fhir.codesystems", "fhir.artifacts", "fhir.ig_packages"],
    embeddings: [],
    jobTypes: ["ig_import"],
  },
  health_supplements: {
    data: ["health_supplements.items"],
    embeddings: ["health_supplements.item_embeddings"],
    jobTypes: ["health_supplements_sync", "health_supplements_embed"],
  },
  food_nutrition: {
    data: ["food_nutrition.ingredients", "food_nutrition.measurements"],
    embeddings: ["food_nutrition.food_embeddings", "food_nutrition.ingredient_embeddings"],
    jobTypes: ["food_nutrition_sync", "food_nutrition_embed"],
  },
};

/** Which scopes each module supports (UI uses this to hide impossible actions). */
export function supportedScopes(moduleKey: string): ClearScope[] {
  const spec = MODULE_CLEAR_SPECS[moduleKey];
  if (!spec) return [];
  const scopes: ClearScope[] = [];
  if (spec.embeddings.length > 0) scopes.push("embeddings");
  scopes.push("data");
  // API-sync modules have no uploaded sources.
  if (!API_SYNC_MODULES.has(moduleKey)) scopes.push("sources");
  scopes.push("all");
  return scopes;
}

async function tableExists(qualified: string): Promise<boolean> {
  const res = await query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [qualified]);
  return Boolean(res.rows[0]?.ok);
}

async function countRows(tables: string[]): Promise<number> {
  let total = 0;
  for (const t of tables) {
    if (!(await tableExists(t))) continue;
    const r = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${t}`);
    total += Number(r.rows[0]?.n ?? 0);
  }
  return total;
}

/** Row/file counts a clear would remove — shown in the confirmation dialog. */
export async function previewModuleClear(moduleKey: string): Promise<Record<string, unknown>> {
  const spec = MODULE_CLEAR_SPECS[moduleKey];
  if (!spec) throw new ModuleClearError(`Module '${moduleKey}' cannot be cleared`, 404);
  const files = await query<{ n: string; bytes: string }>(
    `SELECT COUNT(*)::text AS n, COALESCE(SUM(size_bytes),0)::text AS bytes
       FROM admin.uploaded_files WHERE module_key = $1`,
    [moduleKey],
  );
  return {
    module_key: moduleKey,
    scopes: supportedScopes(moduleKey),
    data_rows: await countRows(spec.data),
    embedding_rows: await countRows(spec.embeddings),
    source_files: Number(files.rows[0]?.n ?? 0),
    source_bytes: Number(files.rows[0]?.bytes ?? 0),
  };
}

export async function clearModule(opts: {
  moduleKey: string;
  scope: ClearScope;
  requestedBy: string;
}): Promise<Record<string, unknown>> {
  const { moduleKey, scope, requestedBy } = opts;
  const spec = MODULE_CLEAR_SPECS[moduleKey];
  if (!spec) throw new ModuleClearError(`Module '${moduleKey}' cannot be cleared`, 404);
  if (!CLEAR_SCOPES.includes(scope)) {
    throw new ModuleClearError(`scope must be one of ${CLEAR_SCOPES.join(", ")}`);
  }
  if (!supportedScopes(moduleKey).includes(scope)) {
    throw new ModuleClearError(`Module '${moduleKey}' does not support scope '${scope}'`);
  }
  if (scope === "embeddings" && spec.embeddings.length === 0) {
    throw new ModuleClearError(`Module '${moduleKey}' has no embeddings`);
  }

  const active = await query<{ job_type: string; status: string }>(
    `SELECT job_type, status FROM admin.import_jobs
      WHERE job_type = ANY($1::text[]) AND status IN ('queued','running','paused') LIMIT 1`,
    [spec.jobTypes],
  );
  if (active.rows.length > 0) {
    const j = active.rows[0];
    throw new ModuleClearError(
      `A ${j.job_type} job is ${j.status}. Stop it in Jobs before clearing this module.`,
      409,
    );
  }

  const before = await previewModuleClear(moduleKey);
  const clearEmbeddings = scope === "embeddings" || scope === "data" || scope === "all";
  const clearData = scope === "data" || scope === "all";
  const clearSources = scope === "sources" || scope === "all";

  const objectKeys: string[] = [];
  await withTransaction(async (client) => {
    const truncate = async (tables: string[]): Promise<void> => {
      const existing: string[] = [];
      for (const t of tables) {
        const r = await client.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t]);
        if (r.rows[0]?.ok) existing.push(t);
      }
      // Tables are hard-coded literals from MODULE_CLEAR_SPECS, never user input.
      if (existing.length > 0) await client.query(`TRUNCATE ${existing.join(", ")}`);
    };

    if (clearEmbeddings && spec.embeddings.length > 0) {
      await truncate(spec.embeddings);
      await client.query(`DELETE FROM admin.module_embed_log WHERE module_key = $1`, [moduleKey]);
    }
    if (clearData) {
      await truncate(spec.data);
      await client.query(`DELETE FROM admin.module_load_log WHERE module_key = $1`, [moduleKey]);
    }
    if (clearSources) {
      const files = await client.query<{ uploaded_file_id: string; object_key: string | null }>(
        `SELECT uploaded_file_id::text AS uploaded_file_id, object_key
           FROM admin.uploaded_files WHERE module_key = $1`,
        [moduleKey],
      );
      const ids = files.rows.map((r) => r.uploaded_file_id);
      for (const r of files.rows) if (r.object_key) objectKeys.push(r.object_key);
      if (ids.length > 0) {
        // Job history keeps pointing at the file it imported; detach it rather than
        // fail on the FK (that was the old "delete errors out" bug).
        await client.query(
          `UPDATE admin.import_jobs SET source_uploaded_file_id = NULL, source_module_source_id = NULL
            WHERE source_uploaded_file_id = ANY($1::uuid[])
               OR source_module_source_id IN (
                    SELECT module_source_id FROM admin.module_sources WHERE uploaded_file_id = ANY($1::uuid[]))`,
          [ids],
        );
        await client.query(`DELETE FROM admin.uploaded_files WHERE uploaded_file_id = ANY($1::uuid[])`, [ids]);
      }
    }
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'clear_module', 'module', $2, $3::jsonb)`,
      [requestedBy, moduleKey, JSON.stringify({ scope, before })],
    );
  });

  let objectsRemoved = 0;
  for (const key of objectKeys) {
    try {
      await minioService.removeObject(key);
      objectsRemoved += 1;
    } catch {
      /* best-effort: the DB no longer references it */
    }
  }

  await broadcast("module_cleared", { module_key: moduleKey, scope }).catch(() => undefined);
  return { ok: true, module_key: moduleKey, scope, before, objects_removed: objectsRemoved };
}
