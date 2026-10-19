/**
 * FHIR R4 CodeSystem supplements stored in fhir.codesystem_supplements — the shared write
 * path of admin uploads (admin/igSupplements.ts) and of the supplements bundled with the
 * code (conceptSearch/bundled.ts), plus the structural check both go through.
 *
 * No admin / job imports here: the worker and the app both use it, and the unit tests run
 * it against a faked query layer.
 */

/** Minimal query surface (pg.Pool / pg.PoolClient, or a fake in tests). */
export interface Db {
  query<R extends Record<string, any> = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

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

/** Structural check of a supplement resource (pure). */
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

/**
 * Write one checked supplement. `replace` (admin upload) overwrites the same url+version;
 * otherwise an existing row is left untouched (bundled apply: idempotent, never clobbers an
 * operator's upload). Returns whether a row was written.
 */
export async function writeSupplementRow(
  db: Db,
  chk: SupplementCheck,
  res: Record<string, unknown>,
  user: string,
  mode: "replace" | "keep",
): Promise<boolean> {
  const conflict =
    mode === "replace"
      ? `DO UPDATE SET supplements = EXCLUDED.supplements, name = EXCLUDED.name, title = EXCLUDED.title,
           concept_count = EXCLUDED.concept_count, raw_json = EXCLUDED.raw_json, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = NOW()`
      : "DO NOTHING";
  const r = await db.query(
    `INSERT INTO fhir.codesystem_supplements (url, version, supplements, name, title, concept_count, raw_json, uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
     ON CONFLICT (url, version) ${conflict}`,
    [chk.url, chk.version ?? "", chk.supplements, chk.name, chk.title, chk.conceptCount, JSON.stringify(res), user],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Installed packages holding any of the CodeSystems the canonicals ("url[|version]") name. */
export async function packagesHoldingCodeSystems(db: Db, canonicals: string[]): Promise<Array<{ package_id: string; version: string }>> {
  const urls = [...new Set(canonicals.map((c) => String(c).split("|")[0]).filter(Boolean))];
  if (!urls.length) return [];
  const r = await db.query<{ package_id: string; version: string }>(
    `SELECT DISTINCT package_id, package_version AS version FROM fhir.artifacts
      WHERE resource_type = 'CodeSystem' AND COALESCE(raw_json->>'content', '') <> 'supplement'
        AND (canonical_url = ANY($1::text[]) OR raw_json->>'url' = ANY($1::text[]))
      ORDER BY 1, 2`,
    [urls],
  );
  return r.rows;
}
