/**
 * Admin-side embedding status visibility.
 *
 * Faithful port of `src/admin_embedding.py` `get_embedding_status`: per-module
 * embed completeness counts + the Ollama (or provider) reachability probe.
 *
 * Parity notes:
 *  - `COUNT(*)` / `COUNT(DISTINCT …)` are Postgres bigint; node-pg decodes
 *    bigint to a string, so every count is `Number(...)`-coerced (the Python
 *    side wraps each in `int(... or 0)`).
 *  - Timestamps are emitted by Python's `_iso`, which is `datetime.isoformat()`
 *    (T-separated, microsecond, `+00:00`) or "" for None. We render the column
 *    with `tsIsoExpr` (fixed-width UTC text) and feed it through `pyIso`; null
 *    renders to "". Fixed-width UTC text also compares chronologically under a
 *    plain lexicographic `<`, which `_later` and the `embed_run or last`
 *    fall-throughs rely on.
 *  - The non-ollama provider branch mirrors Python's structure, but its
 *    reachability check calls `admin_settings.list_models`, which lands with the
 *    write-path port; until then non-ollama providers report `reachable: false`.
 *    The live/seeded provider is `ollama`, so the verified path is exact.
 */

import { query } from "../db.js";
import { tsIsoExpr, pyIso } from "./adminJobs.js";
import * as adminSettings from "./adminSettings.js";
import { candidateOrder, embeddingDimensions } from "./llmProfiles.js";

/**
 * Ping Ollama: reachable AND ≥1 model loaded. Returns true only when
 * `/api/version` is 200 and `/api/tags` returns a non-empty `models` list.
 */
async function pingOllama(baseUrl: string): Promise<boolean> {
  const url = (baseUrl || "").replace(/\/+$/, "");
  if (!url) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const versionResp = await fetch(`${url}/api/version`, { signal: ctrl.signal });
      if (versionResp.status !== 200) return false;
      const tagsResp = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
      if (tagsResp.status !== 200) return false;
      const body = (await tagsResp.json()) as { models?: unknown[] };
      const models = body.models ?? [];
      return Array.isArray(models) && models.length > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Mirror `_iso`: None/null → "", else isoformat-equivalent. */
function iso(text: string | null | undefined): string {
  return text === null || text === undefined ? "" : pyIso(text);
}

/** Mirror `_later`: the later of two fixed-width UTC texts (null-aware). */
function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

interface CountsRow {
  icd_total: string;
  icd_embedded: string;
  icd_last: string | null;
  loinc_total: string;
  loinc_embedded: string;
  loinc_last: string | null;
  hf_total: string;
  hf_embedded: string;
  hf_last: string | null;
  fn_foods_total: string;
  fn_foods_embedded: string;
  fn_ings_total: string;
  fn_ings_embedded: string;
  fn_food_last: string | null;
  fn_ing_last: string | null;
  gl_total: string;
  gl_embedded: string;
  gl_last: string | null;
  sn_total: string;
  sn_embedded: string;
  sn_last: string | null;
}

/** Faithful port of `get_embedding_status`. */
export async function getEmbeddingStatus(): Promise<Record<string, unknown>> {
  const emb = await adminSettings.getGroup("embedding");
  const strategy =
    String((emb.strategy ?? "failover") || "failover").toLowerCase() === "weighted"
      ? "weighted"
      : "failover";
  const profiles = await candidateOrder("embedding", strategy);
  const primary = profiles[0] ?? null;
  const provider = String((primary?.provider ?? "ollama") || "ollama").toLowerCase();
  const ollamaBaseUrl = String((primary?.base_url ?? "") || "").replace(/\/+$/, "");
  const ollamaModel = String((primary?.model ?? "") || "");
  const ollamaDimensions = primary ? embeddingDimensions(primary) : 1024;

  let configured: boolean;
  let ollamaOk: boolean;
  if (provider === "ollama") {
    configured = Boolean(ollamaBaseUrl);
    ollamaOk = await pingOllama(ollamaBaseUrl);
  } else {
    configured = Boolean(ollamaModel) && Boolean(primary?.api_key);
    // Non-ollama reachability (admin_settings.list_models) lands with the
    // write-path port; treat unverified providers as unreachable until then.
    ollamaOk = false;
  }

  const countsRes = await query<CountsRow>(
    `SELECT
        (SELECT COUNT(*) FROM icd.diagnoses)                 AS icd_total,
        (SELECT COUNT(*) FROM icd.diagnosis_embeddings)      AS icd_embedded,
        ${tsIsoExpr("(SELECT MAX(embedded_at) FROM icd.diagnosis_embeddings)")} AS icd_last,
        (SELECT COUNT(*) FROM loinc.concepts)                AS loinc_total,
        (SELECT COUNT(*) FROM loinc.concept_embeddings)      AS loinc_embedded,
        ${tsIsoExpr("(SELECT MAX(embedded_at) FROM loinc.concept_embeddings)")} AS loinc_last,
        (SELECT COUNT(*) FROM health_supplements.items)            AS hf_total,
        (SELECT COUNT(*) FROM health_supplements.item_embeddings)  AS hf_embedded,
        ${tsIsoExpr("(SELECT MAX(embedded_at) FROM health_supplements.item_embeddings)")} AS hf_last,
        (SELECT COUNT(DISTINCT sample_name) FROM food_nutrition.measurements) AS fn_foods_total,
        (SELECT COUNT(*) FROM food_nutrition.food_embeddings)        AS fn_foods_embedded,
        (SELECT COUNT(*) FROM food_nutrition.ingredients)            AS fn_ings_total,
        (SELECT COUNT(*) FROM food_nutrition.ingredient_embeddings)  AS fn_ings_embedded,
        ${tsIsoExpr("(SELECT MAX(embedded_at) FROM food_nutrition.food_embeddings)")} AS fn_food_last,
        ${tsIsoExpr("(SELECT MAX(embedded_at) FROM food_nutrition.ingredient_embeddings)")} AS fn_ing_last,
        (SELECT COUNT(DISTINCT concept_id) FROM snomed.descriptions
           WHERE active = TRUE AND type_id = 900000000000003001) AS sn_total,
        (SELECT COUNT(*) FROM snomed.concept_embeddings)     AS sn_embedded,
        ${tsIsoExpr("(SELECT MAX(embedded_at) FROM snomed.concept_embeddings)")} AS sn_last`,
  );
  const c = countsRes.rows[0];
  const n = (v: string | null) => Number(v ?? 0);

  const loadRes = await query<{ module_key: string; last_loaded_at_iso: string | null }>(
    `SELECT module_key, ${tsIsoExpr("last_loaded_at")} AS last_loaded_at_iso
       FROM admin.module_load_log`,
  );
  const loadLog = new Map<string, string | null>();
  for (const r of loadRes.rows) loadLog.set(r.module_key, r.last_loaded_at_iso);

  const embedRes = await query<{
    module_key: string;
    last_run_at_iso: string | null;
    changed_last_run: boolean | null;
  }>(
    `SELECT module_key, ${tsIsoExpr("last_run_at")} AS last_run_at_iso, changed_last_run
       FROM admin.module_embed_log`,
  );
  const embedRun = new Map<string, string | null>();
  const embedChanged = new Map<string, boolean | null>();
  for (const r of embedRes.rows) {
    embedRun.set(r.module_key, r.last_run_at_iso);
    embedChanged.set(r.module_key, r.changed_last_run);
  }

  // `embed_changed.get(key)` → the stored bool, or None when the module has no
  // embed-log row at all.
  const changed = (key: string): boolean | null =>
    embedChanged.has(key) ? embedChanged.get(key)! : null;

  const fnFoodsTotal = n(c.fn_foods_total);
  const fnFoodsEmbedded = n(c.fn_foods_embedded);
  const fnIngsTotal = n(c.fn_ings_total);
  const fnIngsEmbedded = n(c.fn_ings_embedded);

  return {
    ollama: {
      provider,
      base_url: ollamaBaseUrl,
      model: ollamaModel,
      dimensions: ollamaDimensions,
      configured,
      reachable: ollamaOk,
    },
    modules: [
      {
        key: "icd",
        label: "ICD-10-CM",
        job_type: "icd_embed",
        total: n(c.icd_total),
        embedded: n(c.icd_embedded),
        last_embedded_at: iso((embedRun.get("icd") || c.icd_last) ?? null),
        last_source_updated_at: iso(loadLog.get("icd") ?? null),
        changed_last_run: changed("icd"),
      },
      {
        key: "loinc",
        label: "LOINC",
        job_type: "loinc_embed",
        total: n(c.loinc_total),
        embedded: n(c.loinc_embedded),
        last_embedded_at: iso((embedRun.get("loinc") || c.loinc_last) ?? null),
        last_source_updated_at: iso(loadLog.get("loinc") ?? null),
        changed_last_run: changed("loinc"),
      },
      {
        key: "health_supplements",
        label: "Health Supplements",
        job_type: "health_supplements_embed",
        total: n(c.hf_total),
        embedded: n(c.hf_embedded),
        last_embedded_at: iso((embedRun.get("health_supplements") || c.hf_last) ?? null),
        last_source_updated_at: iso(loadLog.get("health_supplements") ?? null),
        changed_last_run: changed("health_supplements"),
      },
      {
        key: "food_nutrition",
        label: "Food Nutrition",
        job_type: "food_nutrition_embed",
        total: fnFoodsTotal + fnIngsTotal,
        embedded: fnFoodsEmbedded + fnIngsEmbedded,
        last_embedded_at: iso(
          (embedRun.get("food_nutrition") || later(c.fn_food_last, c.fn_ing_last)) ?? null,
        ),
        last_source_updated_at: iso(loadLog.get("food_nutrition") ?? null),
        changed_last_run: changed("food_nutrition"),
        detail: {
          foods_total: fnFoodsTotal,
          foods_embedded: fnFoodsEmbedded,
          ingredients_total: fnIngsTotal,
          ingredients_embedded: fnIngsEmbedded,
        },
      },
      {
        key: "snomed",
        label: "SNOMED CT",
        job_type: "snomed_embed",
        total: n(c.sn_total),
        embedded: n(c.sn_embedded),
        last_embedded_at: iso((embedRun.get("snomed") || c.sn_last) ?? null),
        last_source_updated_at: iso(loadLog.get("snomed") ?? null),
        changed_last_run: changed("snomed"),
        note: "~360k concepts — embedding takes 1-2+ hours with Ollama",
      },
    ],
  };
}
