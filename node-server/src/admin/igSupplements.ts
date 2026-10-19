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
 */

import { query } from "../db.js";
import { createJob } from "./adminJobs.js";

export interface SupplementCheck {
  ok: boolean;
  error?: string;
  url?: string;
  version?: string;
  supplements?: string;
  name?: string | null;
  title?: string | null;
  conceptCount?: number;
}

function countConcepts(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    n += 1 + countConcepts((c as Record<string, unknown>).concept);
  }
  return n;
}

/** Structural check of an uploaded supplement (pure). */
export function checkSupplement(res: unknown): SupplementCheck {
  if (!res || typeof res !== "object" || Array.isArray(res)) return { ok: false, error: "body must be a FHIR CodeSystem JSON object" };
  const r = res as Record<string, unknown>;
  if (r.resourceType !== "CodeSystem") return { ok: false, error: "resourceType must be CodeSystem" };
  if (r.content !== "supplement") return { ok: false, error: "content must be 'supplement' (FHIR R4 CodeSystem supplement)" };
  const url = typeof r.url === "string" ? r.url.trim() : "";
  if (!url) return { ok: false, error: "url is required" };
  const supplements = typeof r.supplements === "string" ? r.supplements.trim() : "";
  if (!supplements) return { ok: false, error: "supplements (canonical of the supplemented CodeSystem) is required" };
  if (supplements.split("|")[0] === url) return { ok: false, error: "a supplement cannot supplement itself" };
  const conceptCount = countConcepts(r.concept);
  if (conceptCount === 0) return { ok: false, error: "the supplement has no concept entries" };
  for (const c of (r.concept as unknown[]) || []) {
    if (!c || typeof c !== "object" || typeof (c as Record<string, unknown>).code !== "string") {
      return { ok: false, error: "every concept needs a string code" };
    }
  }
  return {
    ok: true,
    url,
    version: typeof r.version === "string" ? r.version : "",
    supplements,
    name: typeof r.name === "string" ? r.name : null,
    title: typeof r.title === "string" ? r.title : null,
    conceptCount,
  };
}

/** Installed packages holding the CodeSystem a supplement targets. */
async function packagesHolding(supplements: string): Promise<Array<{ package_id: string; version: string }>> {
  const url = supplements.split("|")[0];
  const r = await query<{ package_id: string; version: string }>(
    `SELECT DISTINCT package_id, package_version AS version FROM fhir.artifacts
      WHERE resource_type = 'CodeSystem' AND (canonical_url = $1 OR raw_json->>'url' = $1)`,
    [url],
  );
  return r.rows;
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
  await query(
    `INSERT INTO fhir.codesystem_supplements (url, version, supplements, name, title, concept_count, raw_json, uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
     ON CONFLICT (url, version) DO UPDATE SET supplements = EXCLUDED.supplements, name = EXCLUDED.name, title = EXCLUDED.title,
       concept_count = EXCLUDED.concept_count, raw_json = EXCLUDED.raw_json, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = NOW()`,
    [chk.url, chk.version ?? "", chk.supplements, chk.name, chk.title, chk.conceptCount, JSON.stringify(res), user],
  );
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

export async function listSupplements(): Promise<Record<string, unknown>[]> {
  const up = await query<Record<string, unknown>>(
    `SELECT url, version, supplements, name, title, concept_count, uploaded_by, uploaded_at, 'upload' AS origin, NULL AS package
       FROM fhir.codesystem_supplements ORDER BY uploaded_at DESC`,
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
  return [...up.rows, ...pkg.rows].map((r) => ({ ...r, applied_to: appliedBy.get(`${r.url}|${r.version ?? ""}`) || [] }));
}

export async function deleteSupplement(url: string, version: string, user: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await query<{ supplements: string }>(
    "DELETE FROM fhir.codesystem_supplements WHERE url = $1 AND version = $2 RETURNING supplements",
    [url, version],
  );
  if (!r.rows.length) return { status: 404, body: { error: "supplement not found" } };
  const job = await queueReindex(r.rows[0].supplements, user, "supplement_deleted");
  return { status: 200, body: { deleted: { url, version }, reindex_job: job } };
}

/** Concept-search index status: per-package totals, embedding coverage, latest jobs. */
export async function conceptIndexStatus(): Promise<Record<string, unknown>> {
  const per = await query<Record<string, unknown>>(
    `SELECT package_id, package_version, COUNT(*)::int AS codesystems, SUM(concept_count)::int AS concepts,
            SUM(term_count)::int AS terms, COUNT(*) FILTER (WHERE embed)::int AS embedded_codesystems, MAX(built_at) AS built_at
       FROM fhir.concept_index_cs GROUP BY package_id, package_version ORDER BY package_id, package_version`,
  );
  const missing = await query<{ package_id: string; version: string }>(
    `SELECT p.package_id, p.version FROM fhir.ig_packages p
      WHERE NOT EXISTS (SELECT 1 FROM fhir.concept_index_cs c WHERE c.package_id = p.package_id AND c.package_version = p.version)
      ORDER BY 1, 2`,
  );
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
  try {
    abbreviations = Number((await query<{ n: string }>("SELECT COUNT(*) AS n FROM fhir.abbreviation_lexicon")).rows[0]?.n ?? 0);
  } catch {
    abbreviations = null; // migration 20261027 not applied
  }
  const jobs = await query<Record<string, unknown>>(
    `SELECT job_id, job_type, status, created_at, finished_at FROM admin.import_jobs
      WHERE job_type IN ('ig_concept_index', 'ig_embed', 'umls_import') ORDER BY created_at DESC LIMIT 6`,
  );
  return {
    packages: per.rows,
    unindexed_packages: missing.rows,
    embeddings: { embeddable_terms: Number(emb.rows[0]?.terms ?? 0), vectors: Number(emb.rows[0]?.vectors ?? 0) },
    thesaurus_entries: Number(thes.rows[0]?.n ?? 0),
    umls,
    abbreviation_lexicon_entries: abbreviations,
    recent_jobs: jobs.rows,
  };
}

/** Queue a backfill of the whole index (signature-skipped when unchanged unless `force`). */
export async function queueConceptIndexRebuild(user: string, force: boolean): Promise<string> {
  const job = await createJob({ moduleKey: "ig", jobType: "ig_concept_index", requestedBy: user, jobOptions: { force, reason: "admin_rebuild" } });
  return String(job.job_id);
}
