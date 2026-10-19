/**
 * ICD-10-CM / ICD-10-PCS service.
 *
 * Port of `src/icd_service.py`. Data is loaded into PostgreSQL by the admin
 * console's ICD import (`icd_import` job, run by the admin worker).
 * `searchCodes` backs `search_medical_codes`: hybrid BM25 + vector re-ranking for
 * diagnoses (keyword-only when embeddings are unavailable), BM25 for procedures.
 *
 * Output objects mirror the Python `dict(row)` shapes value-for-value. BIGINT
 * COUNT results are coerced to `number` (pg returns them as strings) so they
 * match asyncpg's int.
 */

import { query } from "./db.js";
import { logError, logInfo } from "./logger.js";
import type { EmbeddingService } from "./embeddingService.js";
import { vecLiteral } from "./embeddingService.js";
import { annotate, embeddingsPresent } from "./searchQuality.js";
import { rankIcdDiagnoses } from "./terminologyRanking.js";

interface CodeRow {
  code: string;
  name_zh: string | null;
  name_en: string | null;
}

export class IcdService {
  private pcsAvailable = false;
  private embeddingSvc: EmbeddingService | null;

  constructor(embeddingSvc: EmbeddingService | null = null) {
    this.embeddingSvc = embeddingSvc;
  }

  async initialize(): Promise<void> {
    const diag = await query<{ count: string }>("SELECT COUNT(*) AS count FROM icd.diagnoses");
    const proc = await query<{ count: string }>("SELECT COUNT(*) AS count FROM icd.procedures");
    const diagCount = Number(diag.rows[0]?.count ?? 0);
    const procCount = Number(proc.rows[0]?.count ?? 0);
    this.pcsAvailable = procCount > 0;
    if (diagCount === 0) {
      logError("ICD diagnoses table is empty — run the ICD import from the admin console (ICD module)");
    } else {
      logInfo("ICD Service ready", { diagnoses: diagCount, procedures: procCount });
    }
  }

  /**
   * Mirror of `ICDService.search_codes` (hybrid BM25 + vector re-ranking).
   *
   * When the embedding provider yields a vector, the diagnosis branch ranks the
   * union of full-text matches and nearest vectors with score-aware fusion
   * (terminologyRanking.ts); the vector half contributes only if
   * `icd.diagnosis_embeddings` is populated. The `search_mode: keyword_only`
   * marker is added whenever the semantic half could not contribute.
   */
  async searchCodes(keyword: string, type: "diagnosis" | "procedure" | "all" = "all", limit = 3): Promise<unknown> {
    limit = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(keyword, "icd") : null;
    const vecStr = vecLiteral(vec);
    const results: Record<string, unknown> = {};

    if (type === "diagnosis" || type === "all") {
      // Hybrid: full-text ∪ nearest vectors, ordered by score-aware fusion
      // (terminologyRanking.ts); keyword-only when there is no query vector.
      const rows: CodeRow[] = (await rankIcdDiagnoses(keyword, vecStr, limit)).rows;
      results.diagnoses = rows;
    }

    if (type === "procedure" || type === "all") {
      if (this.pcsAvailable) {
        const r = await query<CodeRow>(
          `SELECT code, name_zh, name_en
           FROM icd.procedures
           WHERE to_tsvector('simple', code || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                 @@ plainto_tsquery('simple', $1)
              OR code ILIKE $2
           ORDER BY code LIMIT $3`,
          [keyword, `${keyword}%`, limit],
        );
        results.procedures = r.rows;
      } else {
        results.procedures = [];
        results.procedures_note =
          "ICD-10-PCS data not loaded. " +
          "Upload the ICD-10-PCS tables zip (icd10pcs_tables_<year>.zip) in the admin console's ICD module " +
          "and re-run the ICD import.";
      }
    }

    const diagnoses = results.diagnoses as unknown[] | undefined;
    const procedures = results.procedures as unknown[] | undefined;
    if (
      !(diagnoses && diagnoses.length) &&
      !(procedures && procedures.length) &&
      !("procedures_note" in results)
    ) {
      return { error: `No results found for '${keyword}'.` };
    }

    const hasEmb = await embeddingsPresent("icd.diagnosis_embeddings");
    return annotate(results, vecStr, hasEmb);
  }

  /** Mirror of `ICDService.infer_complications`. */
  async inferComplications(code: string): Promise<unknown> {
    code = code.toUpperCase().trim();
    const children = await query<CodeRow>(
      "SELECT code, name_zh, name_en FROM icd.diagnoses WHERE code LIKE $1 AND code != $2 ORDER BY code LIMIT 15",
      [`${code}%`, code],
    );
    if (children.rows.length) {
      return { base_code: code, potential_complications_or_specifics: children.rows };
    }
    const category = code.includes(".") ? code.split(".")[0] : code.slice(0, 3);
    const siblings = await query<CodeRow>(
      "SELECT code, name_zh, name_en FROM icd.diagnoses WHERE category = $1 AND code != $2 LIMIT 10",
      [category, code],
    );
    const out: Record<string, unknown> = {
      message: `Code ${code} is specific. Showing related codes in category ${category}:`,
      related_codes: siblings.rows,
    };
    if (!(await this.diagnosisExists(code))) {
      // Unknown code: say so instead of implying it is a valid specific code.
      out.code_found = false;
      out.suggestions = await this.suggestDiagnosisCodes(code);
      out.hint = icdNotFoundHint(code);
    }
    return out;
  }

  /** True when `code` is an ICD-10-CM code in icd.diagnoses. */
  private async diagnosisExists(code: string): Promise<boolean> {
    if (!code) return false;
    const r = await query<{ one: number }>("SELECT 1 AS one FROM icd.diagnoses WHERE code = $1 LIMIT 1", [code]);
    return r.rows.length > 0;
  }

  /**
   * Up to 5 existing codes close to an unknown one: the dotted form (E119 → E11.9), then codes sharing the longest
   * prefix (E11.999 → E11.9x). Cheap: indexed prefix lookups only.
   */
  async suggestDiagnosisCodes(code: string): Promise<CodeRow[]> {
    const normalized = normalizeIcdCode(code);
    if (!normalized) return [];
    const exact = await query<CodeRow>("SELECT code, name_zh, name_en FROM icd.diagnoses WHERE code = $1", [normalized]);
    if (exact.rows.length) return exact.rows;
    for (let len = normalized.length - 1; len >= 3; len--) {
      const prefix = normalized.slice(0, len).replace(/\.$/, "");
      const r = await query<CodeRow>(
        "SELECT code, name_zh, name_en FROM icd.diagnoses WHERE code LIKE $1 ORDER BY LENGTH(code), code LIMIT 5",
        [`${prefix}%`],
      );
      if (r.rows.length) return r.rows;
    }
    return [];
  }

  /** Mirror of `ICDService.get_nearby_codes`. */
  async getNearbyCodes(code: string): Promise<unknown> {
    code = code.toUpperCase().trim();
    const prev = await query<CodeRow & { rel: string }>(
      "SELECT code, name_zh, name_en, 'prev' AS rel FROM icd.diagnoses WHERE code < $1 ORDER BY code DESC LIMIT 2",
      [code],
    );
    const next = await query<CodeRow & { rel: string }>(
      "SELECT code, name_zh, name_en, 'next' AS rel FROM icd.diagnoses WHERE code > $1 ORDER BY code ASC LIMIT 2",
      [code],
    );
    const neighbors = [...prev.rows, ...next.rows];
    neighbors.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const out: Record<string, unknown> = { target: code, nearby_options: neighbors };
    if (!(await this.diagnosisExists(code))) {
      out.target_found = false;
      out.hint = `${code} is not an ICD-10-CM code; the neighbours are only where it would sort. ` + icdNotFoundHint(code);
    }
    return out;
  }

  /** Mirror of `ICDService.browse_category`. */
  async browseCategory(category: string | null = null, limit = 50): Promise<unknown> {
    if (!category) {
      const rows = await query<{
        category: string;
        category_name_zh: string | null;
        category_name_en: string | null;
        code_count: string;
      }>(
        `SELECT category,
                MIN(name_zh) FILTER (WHERE LENGTH(code)=3) AS category_name_zh,
                MIN(name_en) FILTER (WHERE LENGTH(code)=3) AS category_name_en,
                COUNT(*) AS code_count
         FROM icd.diagnoses
         GROUP BY category
         ORDER BY category`,
      );
      return {
        total_categories: rows.rows.length,
        categories: rows.rows.map((r) => ({
          category: r.category,
          category_name_zh: r.category_name_zh,
          category_name_en: r.category_name_en,
          code_count: Number(r.code_count),
        })),
      };
    }

    const rows = await query<CodeRow>(
      `SELECT code, name_zh, name_en
       FROM icd.diagnoses
       WHERE category = $1
       ORDER BY code
       LIMIT $2`,
      [category.toUpperCase(), Math.min(limit, 200)],
    );
    if (!rows.rows.length) {
      const cat = category.toUpperCase().trim();
      const near = await query<{ category: string }>(
        "SELECT DISTINCT category FROM icd.diagnoses WHERE category LIKE $1 ORDER BY category LIMIT 10",
        [`${cat.slice(0, 2)}%`],
      );
      return {
        error: `找不到 category '${category}'。使用 category=null 可列出所有分類。`,
        hint:
          `'${category}' is not an ICD-10-CM 3-character category (format: letter + 2 characters, e.g. E11). ` +
          "Pick one from suggestions, call browse_icd_category without category to list all, or use search_medical_codes(keyword).",
        suggestions: near.rows.map((r) => r.category),
      };
    }
    return {
      category: category.toUpperCase(),
      total: rows.rows.length,
      codes: rows.rows,
    };
  }

  /** Mirror of `ICDService.get_conflict_info`. */
  async getConflictInfo(diagnosisCode: string, procedureCode: string): Promise<unknown> {
    try {
      const diag = await query<Record<string, unknown>>(
        "SELECT * FROM icd.diagnoses WHERE code = $1",
        [diagnosisCode],
      );
      let proc: Record<string, unknown> | null = null;
      let procNote: string | null = null;
      if (this.pcsAvailable) {
        const r = await query<Record<string, unknown>>(
          "SELECT * FROM icd.procedures WHERE code = $1",
          [procedureCode],
        );
        proc = r.rows[0] ?? null;
      } else {
        procNote = "ICD-10-PCS data not loaded — procedure lookup unavailable.";
      }
      const diagRow = diag.rows[0] ?? null;
      const out: Record<string, unknown> = {
        diagnosis_info: diagRow ?? `Diagnosis ${diagnosisCode} not found`,
        procedure_info: proc ?? (procNote ?? `Procedure ${procedureCode} not found`),
        instruction: "Analyze the above for potential contraindications or medical conflicts.",
      };
      const hints: string[] = [];
      if (!diagRow) {
        out.diagnosis_suggestions = await this.suggestDiagnosisCodes(diagnosisCode);
        hints.push(`Diagnosis: ${icdNotFoundHint(diagnosisCode)}`);
      }
      if (!proc && !procNote) {
        hints.push(
          `Procedure: '${procedureCode}' is not an ICD-10-PCS code (7 characters, no dot, e.g. 0DTJ4ZZ). ` +
            "Find it with search_medical_codes(keyword, type=procedure).",
        );
      }
      if (hints.length) out.hint = hints.join(" ");
      return out;
    } catch (e) {
      logError("get_conflict_info error", { error: String((e as Error).message) });
      return {
        error: "Lookup failed on the server (database error); this is not caused by your arguments.",
        code: "INTERNAL_QUERY_FAILED",
        hint: "Retry once; if it fails again, tell the user the ICD lookup is failing on the server.",
        diagnosis_code: diagnosisCode,
        procedure_code: procedureCode,
      };
    }
  }
}

/** Upper-case, strip spaces, and insert the dot after the category (E119 → E11.9) for ICD-10-CM look-ups. */
export function normalizeIcdCode(code: string): string {
  const c = String(code ?? "").toUpperCase().replace(/\s+/g, "");
  if (!c) return "";
  if (!c.includes(".") && c.length > 3 && /^[A-Z][0-9][0-9A-Z]/.test(c)) return `${c.slice(0, 3)}.${c.slice(3)}`;
  return c;
}

/** Next-step text for an ICD-10-CM code that is not in the loaded edition. */
export function icdNotFoundHint(code: string): string {
  const n = normalizeIcdCode(code);
  const dotted = n && n !== String(code).toUpperCase().trim() ? ` (try the dotted form ${n})` : "";
  return (
    `'${code}' is not in the loaded ICD-10-CM edition${dotted}. ICD-10-CM codes look like E11.9 (letter, 2 characters, ` +
    "optional dot + up to 4 characters). Check suggestions, or find the code with search_medical_codes(keyword=<diagnosis name>)."
  );
}
