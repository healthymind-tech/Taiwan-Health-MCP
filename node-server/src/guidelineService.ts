/**
 * Clinical Guideline service — Taiwan Medical Society clinical practice
 * guidelines. Faithful port of the read surface of
 * `src/clinical_guideline_service.py` (`search_guideline`,
 * `get_complete_guideline`, `get_medication_recommendations`,
 * `get_test_recommendations`, `get_treatment_goals`,
 * `check_medication_contraindications`, `suggest_clinical_pathway`).
 *
 * The MCP tool wrappers (`search_clinical_guideline` / `query_guideline`) live
 * in `mcp.ts`, mirroring `server.py`.
 */

import { query } from "./db.js";
import { logError, logInfo } from "./logger.js";
import { vecLiteral } from "./embeddingService.js";
import type { EmbeddingService } from "./embeddingService.js";
import { annotate, embeddingsPresent } from "./searchQuality.js";

export class ClinicalGuidelineService {
  private embeddingSvc: EmbeddingService | null;

  constructor(embeddingSvc: EmbeddingService | null = null) {
    this.embeddingSvc = embeddingSvc;
  }

  async initialize(): Promise<void> {
    const r = await query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM guideline.disease_guidelines",
    );
    const count = Number(r.rows[0]?.count ?? 0);
    if (count === 0) {
      logError("Clinical guideline table is empty — run loader seed script first");
    } else {
      logInfo(`Clinical Guideline Service ready (${count} guidelines)`);
    }
  }

  /** Mirror of `search_guideline`. */
  async searchGuideline(keyword: string, limit = 3): Promise<Record<string, unknown>> {
    const lim = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(keyword) : null;
    const vecStr = vecLiteral(vec);

    let rows: Array<Record<string, unknown>>;
    if (vecStr) {
      const r = await query<Record<string, unknown>>(
        `WITH fts AS (
             SELECT id,
                    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                        to_tsvector('simple', COALESCE(disease_name_zh,'') || ' ' || COALESCE(disease_name_en,'')),
                        plainto_tsquery('simple', $2)) DESC) AS rank
             FROM guideline.disease_guidelines
             WHERE icd_code ILIKE $1
                OR to_tsvector('simple', COALESCE(disease_name_zh,'') || ' ' || COALESCE(disease_name_en,''))
                   @@ plainto_tsquery('simple', $2)
             LIMIT 20
         ),
         vec AS (
             SELECT id,
                    ROW_NUMBER() OVER (ORDER BY embedding <=> $3::halfvec) AS rank
             FROM guideline.guideline_embeddings
             ORDER BY embedding <=> $3::halfvec LIMIT 20
         ),
         rrf AS (
             SELECT COALESCE(f.id, v.id) AS id,
                    COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
             FROM fts f FULL OUTER JOIN vec v ON f.id = v.id
         )
         SELECT g.id, g.icd_code, g.disease_name_zh, g.disease_name_en,
                g.guideline_title, g.guideline_source, g.publication_year
         FROM rrf JOIN guideline.disease_guidelines g ON g.id = rrf.id
         ORDER BY rrf.score DESC LIMIT $4`,
        [`%${keyword}%`, keyword, vecStr, lim],
      );
      rows = r.rows;
    } else {
      const r = await query<Record<string, unknown>>(
        `SELECT id, icd_code, disease_name_zh, disease_name_en,
                guideline_title, guideline_source, publication_year
         FROM guideline.disease_guidelines
         WHERE icd_code ILIKE $1
            OR to_tsvector('simple', COALESCE(disease_name_zh,'') || ' ' || COALESCE(disease_name_en,''))
               @@ plainto_tsquery('simple', $2)
         ORDER BY publication_year DESC LIMIT $3`,
        [`%${keyword}%`, keyword, lim],
      );
      rows = r.rows;
    }

    if (rows.length === 0) {
      return {
        message: `找不到符合 '${keyword}' 的診療指引`,
        suggestion: "請使用疾病中文名稱或 ICD-10 編碼搜尋",
      };
    }
    const hasEmb = await embeddingsPresent("guideline.guideline_embeddings");
    return annotate(
      { keyword, total_found: rows.length, guidelines: rows },
      vecStr,
      hasEmb,
    );
  }

  /** Mirror of `get_complete_guideline`. */
  async getCompleteGuideline(icdCode: string): Promise<Record<string, unknown>> {
    const g = await query<Record<string, unknown>>(
      "SELECT * FROM guideline.disease_guidelines WHERE icd_code = $1 OR icd_code ILIKE $2",
      [icdCode, `${icdCode}%`],
    );
    const guideline = g.rows[0];
    if (!guideline) {
      return { error: `找不到 ICD 碼 '${icdCode}' 的診療指引` };
    }
    const gid = guideline.id;
    const [diagnostics, medications, tests, goals] = await Promise.all([
      query<Record<string, unknown>>(
        "SELECT * FROM guideline.diagnostic_recommendations WHERE guideline_id = $1 ORDER BY step_order",
        [gid],
      ),
      query<Record<string, unknown>>(
        "SELECT * FROM guideline.medication_recommendations WHERE guideline_id = $1 ORDER BY line_of_therapy",
        [gid],
      ),
      query<Record<string, unknown>>(
        "SELECT * FROM guideline.test_recommendations WHERE guideline_id = $1 ORDER BY test_category",
        [gid],
      ),
      query<Record<string, unknown>>(
        "SELECT * FROM guideline.treatment_goals WHERE guideline_id = $1 ORDER BY goal_type",
        [gid],
      ),
    ]);

    return {
      guideline_info: {
        icd_code: guideline.icd_code,
        disease_name_zh: guideline.disease_name_zh,
        disease_name_en: guideline.disease_name_en,
        title: guideline.guideline_title,
        source: guideline.guideline_source,
        year: guideline.publication_year,
        summary: guideline.guideline_summary,
      },
      diagnostic_recommendations: diagnostics.rows,
      medication_recommendations: medications.rows,
      test_recommendations: tests.rows,
      treatment_goals: goals.rows,
    };
  }

  /** Mirror of `get_medication_recommendations`. */
  async getMedicationRecommendations(icdCode: string): Promise<Record<string, unknown>> {
    const r = await query<Record<string, unknown>>(
      `SELECT mr.* FROM guideline.medication_recommendations mr
       JOIN guideline.disease_guidelines dg ON mr.guideline_id = dg.id
       WHERE dg.icd_code = $1 OR dg.icd_code ILIKE $2
       ORDER BY mr.line_of_therapy`,
      [icdCode, `${icdCode}%`],
    );
    if (r.rows.length === 0) {
      return { message: `找不到 ICD 碼 '${icdCode}' 的用藥建議` };
    }
    return {
      icd_code: icdCode,
      total_recommendations: r.rows.length,
      medications: r.rows,
    };
  }

  /** Mirror of `get_test_recommendations`. */
  async getTestRecommendations(icdCode: string): Promise<Record<string, unknown>> {
    const r = await query<Record<string, unknown>>(
      `SELECT tr.* FROM guideline.test_recommendations tr
       JOIN guideline.disease_guidelines dg ON tr.guideline_id = dg.id
       WHERE dg.icd_code = $1 OR dg.icd_code ILIKE $2
       ORDER BY tr.test_category`,
      [icdCode, `${icdCode}%`],
    );
    if (r.rows.length === 0) {
      return { message: `找不到 ICD 碼 '${icdCode}' 的檢查建議` };
    }
    return {
      icd_code: icdCode,
      total_recommendations: r.rows.length,
      tests: r.rows,
    };
  }

  /** Mirror of `get_treatment_goals`. */
  async getTreatmentGoals(icdCode: string): Promise<Record<string, unknown>> {
    const r = await query<Record<string, unknown>>(
      `SELECT tg.* FROM guideline.treatment_goals tg
       JOIN guideline.disease_guidelines dg ON tg.guideline_id = dg.id
       WHERE dg.icd_code = $1 OR dg.icd_code ILIKE $2
       ORDER BY tg.goal_type`,
      [icdCode, `${icdCode}%`],
    );
    if (r.rows.length === 0) {
      return { message: `找不到 ICD 碼 '${icdCode}' 的治療目標` };
    }
    return {
      icd_code: icdCode,
      total_goals: r.rows.length,
      goals: r.rows,
    };
  }

  /** Mirror of `check_medication_contraindications`. */
  async checkMedicationContraindications(
    icdCode: string,
    medicationClass: string,
  ): Promise<Record<string, unknown>> {
    const matchedRes = await query<Record<string, unknown>>(
      `SELECT mr.line_of_therapy, mr.medication_class, mr.medication_examples,
              mr.dosage_guidance, mr.contraindications, mr.evidence_level
       FROM guideline.medication_recommendations mr
       JOIN guideline.disease_guidelines dg ON mr.guideline_id = dg.id
       WHERE (dg.icd_code = $1 OR dg.icd_code ILIKE $2)
         AND (mr.medication_class ILIKE $3 OR mr.medication_examples ILIKE $3)
       ORDER BY mr.line_of_therapy`,
      [icdCode, `${icdCode}%`, `%${medicationClass}%`],
    );
    const allMedsRes = await query<Record<string, unknown>>(
      `SELECT mr.line_of_therapy, mr.medication_class, mr.contraindications
       FROM guideline.medication_recommendations mr
       JOIN guideline.disease_guidelines dg ON mr.guideline_id = dg.id
       WHERE dg.icd_code = $1 OR dg.icd_code ILIKE $2
       ORDER BY mr.line_of_therapy`,
      [icdCode, `${icdCode}%`],
    );

    const allContraindications = allMedsRes.rows
      .filter((r) => r.contraindications)
      .map((r) => ({
        medication_class: r.medication_class,
        contraindications: r.contraindications,
      }));

    return {
      icd_code: icdCode,
      queried_medication: medicationClass,
      matched_recommendations: matchedRes.rows,
      all_contraindications_for_diagnosis: allContraindications,
      warning: "請由醫師或藥師依個別病患情況判斷用藥禁忌",
    };
  }

  /** Mirror of `suggest_clinical_pathway`. */
  async suggestClinicalPathway(
    icdCode: string,
    patientContext: Record<string, unknown> | null = null,
  ): Promise<Record<string, unknown>> {
    const guidelineData = await this.getCompleteGuideline(icdCode);
    if ("error" in guidelineData) return guidelineData;

    const info = guidelineData.guideline_info as Record<string, unknown>;
    const diagnostics = guidelineData.diagnostic_recommendations as Array<Record<string, unknown>>;
    const medications = guidelineData.medication_recommendations as Array<Record<string, unknown>>;
    const testRecs = guidelineData.test_recommendations as Array<Record<string, unknown>>;
    const goals = guidelineData.treatment_goals as Array<Record<string, unknown>>;

    const ind = (t: Record<string, unknown>): string => String(t.indication ?? "");
    const lot = (m: Record<string, unknown>): string => String(m.line_of_therapy ?? "");

    const clinicalPathway: Record<string, unknown> = {
      disease: info.disease_name_zh,
      icd_code: icdCode,
      pathway: {
        step1_diagnosis: {
          phase: "診斷確認階段",
          actions: diagnostics.map((r) => r.description),
        },
        step2_baseline_tests: {
          phase: "基礎檢查階段",
          actions: testRecs
            .filter((t) => ind(t).includes("診斷") || ind(t).includes("基礎"))
            .map((t) => `${t.test_name} (${t.indication})`),
        },
        step3_treatment_initiation: {
          phase: "治療啟始階段",
          actions: medications
            .filter((m) => lot(m).includes("第一線"))
            .map((m) => `第一線用藥: ${m.medication_class} (例如: ${m.medication_examples})`),
        },
        step4_monitoring: {
          phase: "追蹤監測階段",
          actions: testRecs
            .filter((t) => ind(t).includes("追蹤") || ind(t).includes("監測"))
            .map((t) => `${t.test_name} - ${t.frequency}`),
        },
        step5_treatment_goals: {
          phase: "治療目標",
          targets: goals.map((g) => `${g.target_parameter}: ${g.target_value}`),
        },
      },
      guideline_source: info.source,
      guideline_year: info.year,
    };

    if (patientContext) {
      clinicalPathway.patient_context = patientContext;
      clinicalPathway.note = "臨床路徑應根據個別患者情況調整";
    }
    return clinicalPathway;
  }
}
