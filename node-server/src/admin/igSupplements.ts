/**
 * Uploaded FHIR R4 CodeSystem supplements (`content = supplement`) and the IG
 * concept-search index status — admin API helpers (adminApp.ts routes under
 * /admin/api/igs/supplements and /admin/api/igs/concept-index).
 *
 * A supplement adds designations / properties to the CodeSystem named by its
 * `supplements` canonical (optionally "|version"). Supplements shipped inside IG
 * packages stay in fhir.artifacts; uploaded ones live in fhir.codesystem_supplements.
 * Both are merged into the concept-search index by the ig_concept_index job, which
 * saving / deleting a supplement queues for the affected packages.
 *
 * Supplements bundled with the code (node-server/data/supplements, conceptSearch/bundled.ts)
 * are written to the same table by the worker before each index build (uploaded_by
 * 'system:bundled'); deleting one records an opt-out, restoreBundledSupplements undoes it.
 */

import { query } from "../db.js";
import { createJob } from "./adminJobs.js";
import { checkSupplement, packagesHoldingCodeSystems, writeSupplementRow, type Db } from "../conceptSearch/supplements.js";
import {
  BUNDLED_LEXICON_SOURCE_PREFIX,
  BUNDLED_ORIGIN,
  bundledLexiconInfo,
  bundledSupplementPlan,
  clearOptOuts,
  listBundledSupplements,
  recordOptOut,
} from "../conceptSearch/bundled.js";
import { selectIndexableCodeSystems } from "../conceptSearch/indexBuilder.js";

export { checkSupplement, type SupplementCheck } from "../conceptSearch/supplements.js";

const db: Db = {
  query: <R extends Record<string, any>>(sql: string, params?: unknown[]) => query<R>(sql, params ?? []),
};

/** Installed packages holding the CodeSystem a supplement targets. */
async function packagesHolding(supplements: string): Promise<Array<{ package_id: string; version: string }>> {
  return packagesHoldingCodeSystems(db, [supplements]);
}

async function queueReindex(supplements: string, user: string, reason: string): Promise<string | null> {
  const packages = await packagesHolding(supplements);
  if (!packages.length) return null;
  const job = await createJob({
    moduleKey: "ig",
    jobType: "ig_concept_index",
    requestedBy: user,
    jobOptions: { packages, thesaurus: false, reason },
  });
  return String(job.job_id);
}

export async function saveSupplement(
  res: Record<string, unknown>,
  user: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const chk = checkSupplement(res);
  if (!chk.ok) return { status: 400, body: { error: chk.error } };
  const targets = await packagesHolding(chk.supplements!);
  await writeSupplementRow(db, chk, res, user, "replace");
  const job = await queueReindex(chk.supplements!, user, "supplement_uploaded");
  return {
    status: 201,
    body: {
      supplement: { url: chk.url, version: chk.version ?? "", supplements: chk.supplements, title: chk.title, concept_count: chk.conceptCount },
      target_packages: targets,
      reindex_job: job,
      ...(targets.length ? {} : { warning: "No installed IG holds the supplemented CodeSystem yet; it is applied when one is installed." }),
    },
  };
}

/**
 * Uploaded + bundled (stored rows) + package-shipped supplements, plus `bundled`: every
 * supplement shipped with the code and its state (applied / pending / opted_out / conflict /
 * target_missing) so the console can offer the restore action.
 */
export async function listSupplements(): Promise<{ supplements: Record<string, unknown>[]; bundled: Record<string, unknown>[] }> {
  const up = await query<Record<string, unknown>>(
    `SELECT url, version, supplements, name, title, concept_count, uploaded_by, uploaded_at,
            CASE WHEN uploaded_by = $1 THEN 'bundled' ELSE 'upload' END AS origin, NULL AS package
       FROM fhir.codesystem_supplements ORDER BY uploaded_at DESC`,
    [BUNDLED_ORIGIN],
  );
  const pkg = await query<Record<string, unknown>>(
    `SELECT raw_json->>'url' AS url, COALESCE(raw_json->>'version', '') AS version, raw_json->>'supplements' AS supplements,
            name, title, concept_count, NULL AS uploaded_by, imported_at AS uploaded_at, 'package' AS origin,
            package_id || '@' || package_version AS package
       FROM fhir.artifacts WHERE resource_type = 'CodeSystem' AND raw_json->>'content' = 'supplement'
      ORDER BY package_id, package_version`,
  );
  const applied = await query<{ url: string; version: string | null; cs: string }>(
    `SELECT s->>'url' AS url, s->>'version' AS version, c.package_id || '@' || c.package_version || ' ' || c.cs_url AS cs
       FROM fhir.concept_index_cs c, jsonb_array_elements(c.supplements) s`,
  );
  const appliedBy = new Map<string, string[]>();
  for (const a of applied.rows) {
    const k = `${a.url}|${a.version ?? ""}`;
    appliedBy.set(k, [...(appliedBy.get(k) || []), a.cs]);
  }
  const bundledList = await listBundledSupplements();
  const bundledKeys = new Set(bundledList.map((b) => `${b.url}|${b.version}`));
  const plan = (await bundledSupplementPlan(db, bundledList)) ?? [];
  const bundled = plan.map((e) => {
    const b = bundledList.find((x) => x.url === e.url && x.version === e.version)!;
    const state =
      e.action === "present" ? "applied" : e.action === "insert" || e.action === "upgrade" ? "pending" : e.action;
    return {
      url: e.url, version: e.version, supplements: e.supplements, title: b.title, name: b.name, concept_count: b.conceptCount,
      file: b.file, state, ...(e.versions ? { other_versions: e.versions } : {}), ...(e.storedBy ? { stored_by: e.storedBy } : {}),
    };
  });
  const supplements = [...up.rows, ...pkg.rows].map((r) => ({
    ...r,
    bundled: r.origin !== "package" && bundledKeys.has(`${r.url}|${r.version ?? ""}`),
    applied_to: appliedBy.get(`${r.url}|${r.version ?? ""}`) || [],
  }));
  return { supplements, bundled };
}

/**
 * Delete a stored supplement. Deleting the url+version of a bundled supplement (whoever
 * stored it) records an opt-out so the next IG import / index run does not bring it back.
 */
export async function deleteSupplement(url: string, version: string, user: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await query<{ supplements: string }>(
    "DELETE FROM fhir.codesystem_supplements WHERE url = $1 AND version = $2 RETURNING supplements",
    [url, version],
  );
  if (!r.rows.length) return { status: 404, body: { error: "Supplement not found", detail: `${url}|${version}` } };
  const isBundled = (await listBundledSupplements()).some((b) => b.url === url && b.version === version);
  if (isBundled) await recordOptOut(db, url, version, user);
  const job = await queueReindex(r.rows[0].supplements, user, "supplement_deleted");
  return { status: 200, body: { deleted: { url, version }, bundled_opt_out: isBundled, reindex_job: job } };
}

/**
 * Undo opt-outs of bundled supplements (one url, or all) and queue an ig_concept_index job,
 * which applies them and rebuilds the affected CodeSystems.
 */
export async function restoreBundledSupplements(url: string | null, user: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const list = await listBundledSupplements();
  if (url && !list.some((b) => b.url === url)) return { status: 404, body: { error: "Bundled supplement not found", detail: url } };
  const restored = await clearOptOuts(db, url ?? undefined);
  const targets = list.filter((b) => restored.includes(b.url)).map((b) => b.supplements);
  const packages = await packagesHoldingCodeSystems(db, targets);
  let job: string | null = null;
  if (packages.length) {
    const j = await createJob({ moduleKey: "ig", jobType: "ig_concept_index", requestedBy: user, jobOptions: { packages, thesaurus: false, reason: "bundled_supplement_restored" } });
    job = String(j.job_id);
  }
  return {
    status: 200,
    body: {
      restored,
      reindex_job: job,
      ...(restored.length && !packages.length ? { warning: "No installed IG holds the supplemented CodeSystem yet; it is applied when one is installed." } : {}),
    },
  };
}

/**
 * Packages without index rows, split into those that have CodeSystems the index builder
 * would index (really unindexed) and those that have none (nothing to index — e.g. a
 * package of profiles only, or of LOINC / SNOMED-routed / content=not-present CodeSystems).
 */
export async function unindexedPackages(dbx: Db = db): Promise<{
  unindexed: Array<{ package_id: string; version: string; codesystems: number }>;
  nothingToIndex: Array<{ package_id: string; version: string }>;
}> {
  const missing = await dbx.query<{ package_id: string; version: string }>(
    `SELECT p.package_id, p.version FROM fhir.ig_packages p
      WHERE NOT EXISTS (SELECT 1 FROM fhir.concept_index_cs c WHERE c.package_id = p.package_id AND c.package_version = p.version)
      ORDER BY 1, 2`,
  );
  if (!missing.rows.length) return { unindexed: [], nothingToIndex: [] };
  const arts = await dbx.query<{ package_id: string; package_version: string; artifact_id: string | null; url: string | null; content: string | null }>(
    `SELECT package_id, package_version, artifact_id, COALESCE(raw_json->>'url', canonical_url) AS url, raw_json->>'content' AS content
       FROM fhir.artifacts
      WHERE resource_type = 'CodeSystem'
        AND (package_id || '#' || package_version) = ANY($1::text[])`,
    [missing.rows.map((m) => `${m.package_id}#${m.version}`)],
  );
  const unindexed: Array<{ package_id: string; version: string; codesystems: number }> = [];
  const nothingToIndex: Array<{ package_id: string; version: string }> = [];
  for (const m of missing.rows) {
    const n = selectIndexableCodeSystems(arts.rows.filter((a) => a.package_id === m.package_id && a.package_version === m.version)).length;
    if (n > 0) unindexed.push({ ...m, codesystems: n });
    else nothingToIndex.push(m);
  }
  return { unindexed, nothingToIndex };
}

/** Concept-search index status: per-package totals, embedding coverage, latest jobs. */
export async function conceptIndexStatus(): Promise<Record<string, unknown>> {
  const per = await query<Record<string, unknown>>(
    `SELECT package_id, package_version, COUNT(*)::int AS codesystems, SUM(concept_count)::int AS concepts,
            SUM(term_count)::int AS terms, COUNT(*) FILTER (WHERE embed)::int AS embedded_codesystems, MAX(built_at) AS built_at
       FROM fhir.concept_index_cs GROUP BY package_id, package_version ORDER BY package_id, package_version`,
  );
  const { unindexed, nothingToIndex } = await unindexedPackages();
  const emb = await query<{ terms: string; vectors: string }>(
    `SELECT (SELECT COUNT(DISTINCT text_hash) FROM fhir.concept_index_terms WHERE text_hash IS NOT NULL) AS terms,
            (SELECT COUNT(*) FROM fhir.concept_embeddings) AS vectors`,
  );
  const thes = await query<{ n: string }>("SELECT COUNT(*) AS n FROM fhir.term_thesaurus");
  let umls: Record<string, unknown> | null = null;
  try {
    umls = (await query<Record<string, unknown>>("SELECT release, sabs, terms, concepts, source_file, loaded_at FROM fhir.umls_release WHERE id = 1")).rows[0] ?? null;
  } catch {
    umls = null; // migration 20261023 not applied
  }
  let abbreviations: number | null = null;
  let lexicon: Record<string, unknown> | null = null;
  try {
    const rows = (await query<{ source: string; n: string }>("SELECT source, COUNT(*) AS n FROM fhir.abbreviation_lexicon GROUP BY source")).rows;
    abbreviations = rows.reduce((s, r) => s + Number(r.n), 0);
    const bundledSrc = rows.find((r) => r.source.startsWith(BUNDLED_LEXICON_SOURCE_PREFIX));
    const info = await bundledLexiconInfo();
    lexicon = {
      entries: abbreviations,
      // "umls": loaded from an uploaded UMLS file (umls_import); "bundled": the copy shipped with the code.
      source: abbreviations === 0 ? null : bundledSrc ? "bundled" : "umls",
      label: bundledSrc ? bundledSrc.source.slice(BUNDLED_LEXICON_SOURCE_PREFIX.length) : rows[0]?.source ?? null,
      bundled_available: info,
    };
  } catch {
    abbreviations = null; // migration 20261027 not applied
  }
  const jobs = await query<Record<string, unknown>>(
    `SELECT job_id, job_type, status, current_step, progress_current, progress_total, created_at, finished_at,
            CASE WHEN job_type = 'ig_concept_index' THEN jsonb_build_object(
              'rebuilt', result_summary_json->'rebuilt', 'skipped', result_summary_json->'skipped', 'codesystems', result_summary_json->'codesystems',
              'bundled_supplements_applied', result_summary_json->'bundled_supplements_applied') END AS summary
       FROM admin.import_jobs
      WHERE job_type IN ('ig_concept_index', 'ig_embed', 'umls_import') ORDER BY created_at DESC LIMIT 6`,
  );
  return {
    packages: per.rows,
    unindexed_packages: unindexed,
    packages_without_indexable_codesystems: nothingToIndex,
    embeddings: { embeddable_terms: Number(emb.rows[0]?.terms ?? 0), vectors: Number(emb.rows[0]?.vectors ?? 0) },
    thesaurus_entries: Number(thes.rows[0]?.n ?? 0),
    umls,
    abbreviation_lexicon_entries: abbreviations,
    abbreviation_lexicon: lexicon,
    recent_jobs: jobs.rows,
  };
}

/** Queue a backfill of the whole index (signature-skipped when unchanged unless `force`). */
export async function queueConceptIndexRebuild(user: string, force: boolean): Promise<string> {
  const job = await createJob({ moduleKey: "ig", jobType: "ig_concept_index", requestedBy: user, jobOptions: { force, reason: "admin_rebuild" } });
  return String(job.job_id);
}

