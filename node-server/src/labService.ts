/**
 * LOINC lab service (deterministic lookups only).
 *
 * Faithful port of the `query_loinc`-backing methods of `src/lab_service.py`:
 * `get_patient_friendly_name` (detail mode) and `get_reference_range`
 * (reference_range mode). The embedding-backed `search_loinc` /
 * `interpret_lab_result` / `batch_interpret_lab_results` are NOT ported here
 * (search needs the embedding service; interpretation is a later batch).
 *
 * NUMERIC columns (`range_low`/`range_high`) come back from pg as strings; they
 * are coerced to `number` to match Python's `float(...)`.
 */

import { query } from "./db.js";
import type { EmbeddingService } from "./embeddingService.js";
import { vecLiteral } from "./embeddingService.js";
import { annotate, embeddingsPresent } from "./searchQuality.js";

// LOINC concept columns returned by code-mode search (mirror of `_fts_cols`).
const FTS_COLS =
  "loinc_num, long_common_name, shortname, name_zh, common_name_zh, " +
  "component, property, time_aspect, system, scale_type, method_type, " +
  "class, classtype, specimen_type, unit, status";

// The full-text vector expression shared by code-mode search (mirror of `_fts_vector`).
const FTS_VECTOR =
  "to_tsvector('simple', " +
  "COALESCE(loinc_num,'') || ' ' || COALESCE(long_common_name,'') || ' ' || " +
  "COALESCE(shortname,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(common_name_zh,''))";

export class LabService {
  private embeddingSvc: EmbeddingService | null;

  constructor(embeddingSvc: EmbeddingService | null = null) {
    this.embeddingSvc = embeddingSvc;
  }

  /** Mirror of `LabService.search_loinc_code` (hybrid BM25 + vector re-ranking). */
  async searchLoincCode(keyword: string, category: string | null = null, limit = 3): Promise<unknown> {
    limit = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(keyword) : null;
    const vecStr = vecLiteral(vec);

    let rows: Record<string, unknown>[];
    if (vecStr) {
      const catFilter = category ? "AND c.class ILIKE $5" : "";
      const params: unknown[] = [keyword, `%${keyword}%`, vecStr, limit];
      if (category) params.push(`%${category}%`);
      const r = await query<Record<string, unknown>>(
        `WITH fts AS (
             SELECT loinc_num,
                    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                        ${FTS_VECTOR},
                        plainto_tsquery('simple', $1)) DESC) AS rank
             FROM loinc.concepts
             WHERE (${FTS_VECTOR} @@ plainto_tsquery('simple', $1)
                OR loinc_num ILIKE $2)
             LIMIT 20
         ),
         vec AS (
             SELECT loinc_num,
                    ROW_NUMBER() OVER (ORDER BY embedding <=> $3::halfvec) AS rank
             FROM loinc.concept_embeddings
             ORDER BY embedding <=> $3::halfvec LIMIT 20
         ),
         rrf AS (
             SELECT COALESCE(f.loinc_num, v.loinc_num) AS loinc_num,
                    COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
             FROM fts f FULL OUTER JOIN vec v ON f.loinc_num = v.loinc_num
         )
         SELECT c.${FTS_COLS}
         FROM rrf JOIN loinc.concepts c ON c.loinc_num = rrf.loinc_num
         ${catFilter}
         ORDER BY rrf.score DESC LIMIT $4`,
        params,
      );
      rows = r.rows;
    } else if (category) {
      const r = await query<Record<string, unknown>>(
        `SELECT ${FTS_COLS}
         FROM loinc.concepts
         WHERE ${FTS_VECTOR} @@ plainto_tsquery('simple', $1)
           AND class ILIKE $2
         ORDER BY loinc_num LIMIT $3`,
        [keyword, `%${category}%`, limit],
      );
      rows = r.rows;
    } else {
      const r = await query<Record<string, unknown>>(
        `SELECT ${FTS_COLS}
         FROM loinc.concepts
         WHERE ${FTS_VECTOR} @@ plainto_tsquery('simple', $1)
            OR loinc_num ILIKE $2
         ORDER BY loinc_num LIMIT $3`,
        [keyword, `%${keyword}%`, limit],
      );
      rows = r.rows;
    }

    if (!rows.length) {
      return {
        message: `找不到符合 '${keyword}' 的檢驗項目`,
        suggestion: "請嘗試使用中文名稱、英文名稱或常用縮寫",
      };
    }
    const hasEmb = await embeddingsPresent("loinc.concept_embeddings");
    return annotate({ keyword, total_found: rows.length, results: rows }, vecStr, hasEmb);
  }

  /** Mirror of `LabService.search_by_specimen`. */
  async searchBySpecimen(specimenType: string, limit = 3): Promise<unknown> {
    limit = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(specimenType) : null;
    const vecStr = vecLiteral(vec);

    let rows: Record<string, unknown>[];
    if (vecStr) {
      const r = await query<Record<string, unknown>>(
        `WITH fts AS (
             SELECT loinc_num,
                    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                        to_tsvector('simple',
                            COALESCE(specimen_type,'') || ' ' || COALESCE(long_common_name,'') || ' ' ||
                            COALESCE(name_zh,'')),
                        plainto_tsquery('simple', $1)) DESC) AS rank
             FROM loinc.concepts
             WHERE specimen_type ILIKE $2
                OR to_tsvector('simple',
                       COALESCE(specimen_type,'') || ' ' || COALESCE(long_common_name,''))
                   @@ plainto_tsquery('simple', $1)
             LIMIT 20
         ),
         vec AS (
             SELECT loinc_num,
                    ROW_NUMBER() OVER (ORDER BY embedding <=> $3::halfvec) AS rank
             FROM loinc.concept_embeddings
             ORDER BY embedding <=> $3::halfvec LIMIT 20
         ),
         rrf AS (
             SELECT COALESCE(f.loinc_num, v.loinc_num) AS loinc_num,
                    COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
             FROM fts f FULL OUTER JOIN vec v ON f.loinc_num = v.loinc_num
         )
         SELECT c.loinc_num, c.long_common_name, c.name_zh, c.common_name_zh,
                c.specimen_type, c.component, c.class, c.unit
         FROM rrf JOIN loinc.concepts c ON c.loinc_num = rrf.loinc_num
         WHERE c.status = 'ACTIVE'
         ORDER BY rrf.score DESC LIMIT $4`,
        [specimenType, `%${specimenType}%`, vecStr, limit],
      );
      rows = r.rows;
    } else {
      const r = await query<Record<string, unknown>>(
        `SELECT loinc_num, long_common_name, name_zh, common_name_zh,
                specimen_type, component, class, unit
         FROM loinc.concepts
         WHERE specimen_type ILIKE $1
           AND status = 'ACTIVE'
         ORDER BY class, loinc_num
         LIMIT $2`,
        [`%${specimenType}%`, limit],
      );
      rows = r.rows;
    }
    if (!rows.length) {
      return {
        message: `找不到檢體類型 '${specimenType}' 的檢驗項目`,
        hint: "常見值: 血清/血漿, 全血, Urine, Ser/Plas, Bld",
      };
    }
    const hasEmb = await embeddingsPresent("loinc.concept_embeddings");
    return annotate({ specimen_type: specimenType, total_found: rows.length, results: rows }, vecStr, hasEmb);
  }

  /** Mirror of `LabService.find_related_tests` (component search, grouped by system). */
  async findRelatedTests(component: string, limit = 3): Promise<unknown> {
    limit = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(component) : null;
    const vecStr = vecLiteral(vec);

    interface CompRow {
      loinc_num: string;
      component: string | null;
      property: string | null;
      time_aspect: string | null;
      system: string | null;
      scale_type: string | null;
      method_type: string | null;
      long_common_name: string | null;
      name_zh: string | null;
      unit: string | null;
    }

    let rows: CompRow[];
    if (vecStr) {
      const r = await query<CompRow>(
        `WITH fts AS (
             SELECT loinc_num,
                    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                        to_tsvector('simple', COALESCE(component,'')),
                        plainto_tsquery('simple', $1)) DESC) AS rank
             FROM loinc.concepts
             WHERE component ILIKE $2
                OR to_tsvector('simple', COALESCE(component,''))
                   @@ plainto_tsquery('simple', $1)
             LIMIT 20
         ),
         vec AS (
             SELECT loinc_num,
                    ROW_NUMBER() OVER (ORDER BY embedding <=> $3::halfvec) AS rank
             FROM loinc.concept_embeddings
             ORDER BY embedding <=> $3::halfvec LIMIT 20
         ),
         rrf AS (
             SELECT COALESCE(f.loinc_num, v.loinc_num) AS loinc_num,
                    COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
             FROM fts f FULL OUTER JOIN vec v ON f.loinc_num = v.loinc_num
         )
         SELECT c.loinc_num, c.component, c.property, c.time_aspect, c.system,
                c.scale_type, c.method_type, c.long_common_name, c.name_zh, c.unit
         FROM rrf JOIN loinc.concepts c ON c.loinc_num = rrf.loinc_num
         ORDER BY rrf.score DESC LIMIT $4`,
        [component, `%${component}%`, vecStr, limit],
      );
      rows = r.rows;
    } else {
      const r = await query<CompRow>(
        `SELECT loinc_num, component, property, time_aspect, system,
                scale_type, method_type, long_common_name, name_zh, unit
         FROM loinc.concepts
         WHERE component ILIKE $1
         ORDER BY system, time_aspect, method_type
         LIMIT $2`,
        [`%${component}%`, limit],
      );
      rows = r.rows;
    }
    if (!rows.length) {
      return { message: `找不到含有 '${component}' 的 LOINC 檢驗項目` };
    }
    const bySystem: Record<string, unknown[]> = {};
    for (const r of rows) {
      const sys = r.system || "Unknown";
      (bySystem[sys] ??= []).push({
        loinc_num: r.loinc_num,
        long_common_name: r.long_common_name,
        name_zh: r.name_zh,
        property: r.property,
        time_aspect: r.time_aspect,
        method_type: r.method_type,
        scale_type: r.scale_type,
        unit: r.unit,
      });
    }
    const hasEmb = await embeddingsPresent("loinc.concept_embeddings");
    return annotate({ component, total_found: rows.length, by_system: bySystem }, vecStr, hasEmb);
  }

  /** Mirror of `LabService.list_categories`. */
  async listCategories(): Promise<unknown> {
    const r = await query<{ class: string }>(
      "SELECT DISTINCT class FROM loinc.concepts WHERE class IS NOT NULL ORDER BY class",
    );
    const categories = r.rows.map((row) => row.class);
    return { total_categories: categories.length, categories };
  }

  /** Mirror of `LabService.get_patient_friendly_name`. */
  async getPatientFriendlyName(loincNum: string): Promise<unknown> {
    const res = await query<Record<string, unknown>>(
      `SELECT loinc_num, long_common_name, shortname, name_zh, common_name_zh,
              consumer_name, component, property, time_aspect, system,
              scale_type, method_type, specimen_type, unit, class, status
       FROM loinc.concepts WHERE loinc_num = $1`,
      [loincNum],
    );
    const row = res.rows[0];
    if (!row) {
      return { error: `找不到 LOINC 碼: ${loincNum}` };
    }
    // consumer_name is empty in current module; fall back to common_name_zh / shortname.
    const displayName =
      (row.consumer_name as string) ||
      (row.common_name_zh as string) ||
      (row.shortname as string) ||
      (row.long_common_name as string);
    return { ...row, display_name: displayName };
  }

  /** Mirror of `LabService.get_reference_range`. */
  async getReferenceRange(
    loincNum: string,
    age: number,
    gender: "M" | "F" | "all" = "all",
  ): Promise<unknown> {
    const conceptRes = await query<{
      loinc_num: string;
      long_common_name: string | null;
      name_zh: string | null;
      common_name_zh: string | null;
      unit: string | null;
    }>(
      "SELECT loinc_num, long_common_name, name_zh, common_name_zh, unit FROM loinc.concepts WHERE loinc_num = $1",
      [loincNum],
    );
    const concept = conceptRes.rows[0];
    if (!concept) {
      return { error: `找不到 LOINC 碼: ${loincNum}` };
    }

    const refRes = await query<{
      range_low: string | null;
      range_high: string | null;
      unit: string | null;
      interpretation: string | null;
      age_min: number;
      age_max: number;
      gender: string;
    }>(
      `SELECT range_low, range_high, unit, interpretation, age_min, age_max, gender
       FROM loinc.reference_ranges
       WHERE loinc_num = $1 AND age_min <= $2 AND age_max >= $2
         AND (gender = $3 OR gender = 'all')
       ORDER BY CASE gender WHEN $3 THEN 1 ELSE 2 END, age_min DESC
       LIMIT 1`,
      [loincNum, age, gender],
    );
    const ref = refRes.rows[0];

    if (!ref) {
      return {
        loinc_num: loincNum,
        test_name_zh: concept.name_zh,
        message: `找不到適用於年齡 ${age} 歲、性別 ${gender} 的參考值`,
        unit: concept.unit,
      };
    }

    return {
      loinc_num: loincNum,
      test_name_zh: concept.name_zh,
      test_name_en: concept.long_common_name,
      common_name: concept.common_name_zh,
      reference_range: {
        low: ref.range_low !== null ? Number(ref.range_low) : null,
        high: ref.range_high !== null ? Number(ref.range_high) : null,
        unit: ref.unit,
        interpretation: ref.interpretation,
      },
      applicable_to: {
        age_range: `${ref.age_min}-${ref.age_max} 歲`,
        gender: ref.gender === "M" ? "男性" : ref.gender === "F" ? "女性" : "不分性別",
      },
    };
  }

  /** Mirror of `LabService.interpret_lab_result`. */
  async interpretLabResult(
    loincNum: string,
    value: number,
    age: number,
    gender: "M" | "F" | "all" = "all",
  ): Promise<Record<string, unknown>> {
    const refData = (await this.getReferenceRange(loincNum, age, gender)) as Record<string, unknown>;
    if ("error" in refData || "message" in refData) {
      return refData;
    }

    const refRange = refData.reference_range as {
      low: number | null;
      high: number | null;
      unit: string | null;
      interpretation: string | null;
    };
    const { low, high } = refRange;

    let status: string;
    let flag: string;
    let note: string;
    if (low !== null && value < low) {
      status = "偏低 (Low)";
      flag = "L";
      note = "低於正常參考值，建議進一步評估";
    } else if (high !== null && value > high) {
      status = "偏高 (High)";
      flag = "H";
      note = "高於正常參考值，建議進一步評估";
    } else {
      status = "正常 (Normal)";
      flag = "N";
      note = "數值在正常範圍內";
    }

    return {
      loinc_num: loincNum,
      test_name_zh: refData.test_name_zh,
      test_name_en: refData.test_name_en,
      result: {
        value,
        unit: refRange.unit,
        status,
        flag,
      },
      reference_range: {
        low,
        high,
        unit: refRange.unit,
      },
      interpretation: note,
      applicable_to: refData.applicable_to,
    };
  }

  /** Mirror of `LabService.batch_interpret_results`. */
  async batchInterpretResults(
    results: Record<string, unknown>[],
    age: number,
    gender: "M" | "F" | "all" = "all",
  ): Promise<unknown> {
    const interpretations: Record<string, unknown>[] = [];
    let abnormalCount = 0;

    for (const item of results) {
      const loincNum = (item.loinc_code ?? item.loinc_num) as string | undefined;
      const value = item.value;
      if (!loincNum || value === undefined || value === null) continue;
      const interp = await this.interpretLabResult(loincNum, Number(value), age, gender);
      if (!("error" in interp) && !("message" in interp)) {
        interpretations.push(interp);
        if ((interp.result as { flag: string }).flag !== "N") {
          abnormalCount += 1;
        }
      }
    }

    return {
      total_tests: interpretations.length,
      abnormal_count: abnormalCount,
      normal_count: interpretations.length - abnormalCount,
      patient_info: {
        age,
        gender: gender === "M" ? "男性" : gender === "F" ? "女性" : "不分性別",
      },
      results: interpretations,
    };
  }
}
