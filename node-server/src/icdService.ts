/**
 * ICD-10-CM / ICD-10-PCS service.
 *
 * Faithful port of `src/icd_service.py` (deterministic methods only). Data is
 * pre-loaded into PostgreSQL by the loader. `searchCodes` (hybrid BM25 + vector)
 * is intentionally NOT ported yet — it depends on the embedding service, which
 * is a separate Phase-1 port; until then `search_medical_codes` stays unported.
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
      logError("ICD diagnoses table is empty — run data-loader (--icd) first");
    } else {
      logInfo("ICD Service ready", { diagnoses: diagCount, procedures: procCount });
    }
  }

  /**
   * Mirror of `ICDService.search_codes` (hybrid BM25 + vector re-ranking).
   *
   * When the embedding provider yields a vector, the diagnosis branch runs the
   * RRF hybrid query (identical SQL to Python); the vec CTE contributes only if
   * `icd.diagnosis_embeddings` is populated. The `search_mode: keyword_only`
   * marker is added whenever the semantic half could not contribute.
   */
  async searchCodes(keyword: string, type: "diagnosis" | "procedure" | "all" = "all", limit = 3): Promise<unknown> {
    limit = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(keyword) : null;
    const vecStr = vecLiteral(vec);
    const results: Record<string, unknown> = {};

    if (type === "diagnosis" || type === "all") {
      let rows: CodeRow[];
      if (vecStr) {
        const r = await query<CodeRow>(
          `WITH fts AS (
               SELECT code,
                      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                          to_tsvector('simple', code || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,'')),
                          plainto_tsquery('simple', $1)) DESC) AS rank
               FROM icd.diagnoses
               WHERE to_tsvector('simple', code || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                     @@ plainto_tsquery('simple', $1)
                  OR code ILIKE $2
               LIMIT 20
           ),
           vec AS (
               SELECT code,
                      ROW_NUMBER() OVER (ORDER BY embedding <=> $3::halfvec) AS rank
               FROM icd.diagnosis_embeddings
               ORDER BY embedding <=> $3::halfvec LIMIT 20
           ),
           rrf AS (
               SELECT COALESCE(f.code, v.code) AS code,
                      COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
               FROM fts f FULL OUTER JOIN vec v ON f.code = v.code
           )
           SELECT d.code, d.name_zh, d.name_en
           FROM rrf JOIN icd.diagnoses d ON d.code = rrf.code
           ORDER BY rrf.score DESC LIMIT $4`,
          [keyword, `${keyword}%`, vecStr, limit],
        );
        rows = r.rows;
      } else {
        const r = await query<CodeRow>(
          `SELECT code, name_zh, name_en
           FROM icd.diagnoses
           WHERE to_tsvector('simple', code || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                 @@ plainto_tsquery('simple', $1)
              OR code ILIKE $2
           ORDER BY code LIMIT $3`,
          [keyword, `${keyword}%`, limit],
        );
        rows = r.rows;
      }
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
          "Add icd10pcs_tables_<year>.zip to fhir-code/icd10pcs/ and re-run data-loader.";
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
    return {
      message: `Code ${code} is specific. Showing related codes in category ${category}:`,
      related_codes: siblings.rows,
    };
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
    return { target: code, nearby_options: neighbors };
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
      return {
        error: `找不到 category '${category}'。使用 category=null 可列出所有分類。`,
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
      return {
        diagnosis_info: diagRow ?? `Diagnosis ${diagnosisCode} not found`,
        procedure_info: proc ?? (procNote ?? `Procedure ${procedureCode} not found`),
        instruction: "Analyze the above for potential contraindications or medical conflicts.",
      };
    } catch (e) {
      logError("get_conflict_info error", { error: String((e as Error).message) });
      return {
        error: String((e as Error).message),
        diagnosis_code: diagnosisCode,
        procedure_code: procedureCode,
      };
    }
  }
}
