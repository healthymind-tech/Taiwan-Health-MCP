/**
 * Health Supplements service — Taiwan FDA approved health supplements.
 *
 * Faithful port of the MCP-exposed path in `src/health_supplements_service.py`
 * (`search_health_supplements`). The TFDA importer lives in
 * `loaders/healthSupplements.ts`. Hybrid BM25 + semantic search via RRF, with a
 * pure-FTS fallback when embeddings are unavailable.
 */

import { query } from "./db.js";
import { logInfo } from "./logger.js";
import type { EmbeddingService } from "./embeddingService.js";
import { vecLiteral } from "./embeddingService.js";
import { annotate, embeddingsPresent } from "./searchQuality.js";

interface ItemRow {
  permit_no: string;
  name: string | null;
  category: string | null;
  benefit_claims: string | null;
  applicant: string | null;
  valid_from: string | null;
}

// Mirror of `DISEASE_BENEFIT_MAPPING` — ICD-10 prefix → recommended benefit
// claims. Developer-curated, not medically validated (see CLAUDE.md limitations).
const DISEASE_BENEFIT_MAPPING: Record<string, string[]> = {
  E11: ["調節血糖", "延緩血糖上升"],
  E10: ["調節血糖", "延緩血糖上升"],
  E78: ["調節血脂", "不易形成體脂肪"],
  E66: ["不易形成體脂肪", "調節血脂"],
  E79: ["調節尿酸"],
  I10: ["調節血脂", "心血管保健"],
  I25: ["調節血脂", "心血管保健"],
  I21: ["調節血脂", "心血管保健"],
  K70: ["護肝"],
  K71: ["護肝"],
  K72: ["護肝"],
  K73: ["護肝"],
  K74: ["護肝"],
  K76: ["護肝"],
  M80: ["骨質保健", "促進鈣吸收"],
  M81: ["骨質保健", "促進鈣吸收"],
  M15: ["關節保健"],
  M17: ["關節保健"],
  K59: ["胃腸功能改善", "促進腸道有益菌增生"],
  K29: ["胃腸功能改善"],
  K21: ["胃腸功能改善"],
  D84: ["免疫調節"],
  J06: ["免疫調節"],
  H52: ["護眼保健", "調節視覺"],
  H53: ["護眼保健"],
  N40: ["促進泌尿道保健"],
  N39: ["促進泌尿道保健"],
  K02: ["牙齒保健", "促進釋放齒垢"],
  K05: ["牙齒保健"],
  L70: ["調節免疫", "皮膚保健"],
};

/** Minimal shape of the ICD service dependency used by condition mode. */
interface IcdLike {
  searchCodes(
    keyword: string,
    type: "diagnosis" | "procedure" | "all",
    limit?: number,
  ): Promise<unknown>;
}

export class HealthSupplementsService {
  private embeddingSvc: EmbeddingService | null;

  constructor(embeddingSvc: EmbeddingService | null = null) {
    this.embeddingSvc = embeddingSvc;
  }

  async initialize(): Promise<void> {
    const res = await query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM health_supplements.items",
    );
    const count = Number(res.rows[0]?.count ?? 0);
    if (count === 0) {
      logInfo(
        "Health supplements DB empty — run data-loader --health-supplements to load data",
      );
    } else {
      logInfo("Health Supplements Service ready", { items: count });
    }
  }

  /** Mirror of `HealthSupplementsService.search_health_supplements`. */
  async searchHealthSupplements(keyword: string, limit = 3): Promise<unknown> {
    limit = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(keyword) : null;
    const vecStr = vecLiteral(vec);

    let rows: ItemRow[];
    if (vecStr) {
      const r = await query<ItemRow>(
        `WITH fts AS (
             SELECT i.permit_no,
                    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                        to_tsvector('simple', COALESCE(i.name,'') || ' ' || COALESCE(i.benefit_claims,'')),
                        plainto_tsquery('simple', $1)) DESC) AS rank
             FROM health_supplements.items i
             WHERE to_tsvector('simple', COALESCE(i.name,'') || ' ' || COALESCE(i.benefit_claims,''))
                   @@ plainto_tsquery('simple', $1)
             LIMIT 20
         ),
         vec AS (
             SELECT permit_no,
                    ROW_NUMBER() OVER (ORDER BY embedding <=> $2::halfvec) AS rank
             FROM health_supplements.item_embeddings
             ORDER BY embedding <=> $2::halfvec LIMIT 20
         ),
         rrf AS (
             SELECT COALESCE(f.permit_no, v.permit_no) AS permit_no,
                    COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
             FROM fts f FULL OUTER JOIN vec v ON f.permit_no = v.permit_no
         )
         SELECT i.permit_no, i.name, i.category, i.benefit_claims, i.applicant, i.valid_from
         FROM rrf JOIN health_supplements.items i ON i.permit_no = rrf.permit_no
         ORDER BY rrf.score DESC LIMIT $3`,
        [keyword, vecStr, limit],
      );
      rows = r.rows;
    } else {
      const r = await query<ItemRow>(
        `SELECT permit_no, name, category, benefit_claims, applicant, valid_from
         FROM health_supplements.items
         WHERE to_tsvector('simple', COALESCE(name,'') || ' ' || COALESCE(benefit_claims,''))
               @@ plainto_tsquery('simple', $1)
         LIMIT $2`,
        [keyword, limit],
      );
      rows = r.rows;
    }

    if (rows.length === 0) {
      return { error: `找不到與 '${keyword}' 相關的健康補充品。`, results: [] };
    }
    const hasEmb = await embeddingsPresent("health_supplements.item_embeddings");
    return annotate({ results: rows }, vecStr, hasEmb);
  }

  /**
   * Look up one item by permit number. Mirror of the `permit_no` branch of the
   * `search_health_supplements` MCP tool: exact match first, then a digit-based
   * ILIKE fallback (single result for all-digit input, first of up to 50 else).
   */
  async lookupByPermit(keyword: string): Promise<ItemRow | null> {
    const exact = await query<ItemRow>(
      "SELECT * FROM health_supplements.items WHERE permit_no = $1",
      [keyword],
    );
    if (exact.rows[0]) return exact.rows[0];

    const digits = keyword.match(/\d+/);
    if (!digits) return null;
    const digitsOnly = digits[0];
    const isAllDigits = /^\d+$/.test(keyword);
    if (isAllDigits) {
      const r = await query<ItemRow>(
        "SELECT * FROM health_supplements.items WHERE permit_no ILIKE $1 ORDER BY permit_no LIMIT 1",
        [`%${digitsOnly}%`],
      );
      return r.rows[0] ?? null;
    }
    const r = await query<ItemRow>(
      "SELECT * FROM health_supplements.items WHERE permit_no ILIKE $1 ORDER BY permit_no LIMIT 50",
      [`%${digitsOnly}%`],
    );
    return r.rows[0] ?? null;
  }

  /** Mirror of `HealthSupplementsService._resolve_icd_code`. */
  private async resolveIcdCode(
    diagnosisKeyword: string,
    icdService: IcdLike | null,
  ): Promise<string | null> {
    const keyword = diagnosisKeyword ? diagnosisKeyword.trim() : "";
    if (!keyword) return null;

    // Direct ICD inputs such as E11 or E11.9
    if (/^[A-Z][0-9][0-9](?:\.[A-Z0-9]+)?$/.test(keyword.toUpperCase())) {
      return keyword.toUpperCase().split(".")[0];
    }
    if (!icdService) return null;

    try {
      const payload = (await icdService.searchCodes(keyword, "diagnosis")) as {
        diagnoses?: Array<{ code?: unknown; name_zh?: unknown; name_en?: unknown }>;
      };
      const diagnoses = payload.diagnoses ?? [];
      if (diagnoses.length === 0) return null;

      const normalized = keyword.toLowerCase();
      for (const row of diagnoses) {
        const nameZh = String(row.name_zh ?? "").toLowerCase();
        const nameEn = String(row.name_en ?? "").toLowerCase();
        if (normalized === nameZh || normalized === nameEn) {
          if (row.code) return String(row.code).toUpperCase().split(".")[0];
        }
      }
      const firstCode = diagnoses[0].code;
      if (firstCode) return String(firstCode).toUpperCase().split(".")[0];
    } catch {
      return null;
    }
    return null;
  }

  /** Mirror of `HealthSupplementsService.analyze_health_support_for_condition`. */
  async analyzeHealthSupportForCondition(
    diagnosisKeyword: string,
    icdService: IcdLike | null,
  ): Promise<{
    icd_code: string | null;
    recommended_benefits: string[];
    health_supplements: Array<{ permit_no: string; name: string | null; benefit_claims: string | null }>;
    disclaimer: string;
  }> {
    const icdCode = await this.resolveIcdCode(diagnosisKeyword, icdService);
    const recommendedBenefits =
      (icdCode && DISEASE_BENEFIT_MAPPING[icdCode]) || [diagnosisKeyword];

    const foods: Array<{ permit_no: string; name: string | null; benefit_claims: string | null }> = [];
    for (const benefit of recommendedBenefits) {
      const r = await query<{ permit_no: string; name: string | null; benefit_claims: string | null }>(
        `SELECT permit_no, name, benefit_claims FROM health_supplements.items
         WHERE to_tsvector('simple', COALESCE(benefit_claims,''))
               @@ plainto_tsquery('simple', $1)
         LIMIT 5`,
        [benefit],
      );
      foods.push(...r.rows);
    }

    // Deduplicate by permit_no, preserving first-seen order.
    const seen = new Set<string>();
    const unique = foods.filter((f) => {
      if (seen.has(f.permit_no)) return false;
      seen.add(f.permit_no);
      return true;
    });

    return {
      icd_code: icdCode,
      recommended_benefits: recommendedBenefits,
      health_supplements: unique,
      disclaimer: "健康補充品僅供輔助保健，不可取代醫療。使用前請諮詢醫師。",
    };
  }
}
