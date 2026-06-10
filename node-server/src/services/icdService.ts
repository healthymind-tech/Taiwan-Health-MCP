import crypto from "node:crypto";

import { cached } from "../cache.js";
import { query } from "../db.js";

export type IcdSearchType = "diagnosis" | "procedure" | "all";

export interface IcdCode {
  code: string;
  name_zh: string | null;
  name_en: string | null;
}

export interface IcdSearchResult {
  diagnoses?: IcdCode[];
  procedures?: IcdCode[];
  procedures_note?: string;
  metadata: {
    search_mode: "keyword";
    semantic_available: false;
    node_gateway: true;
  };
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit || 3), 1), 10);
}

function cacheKey(keyword: string, type: IcdSearchType, limit: number): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ keyword, type, limit }))
    .digest("hex")
    .slice(0, 16);
  return `node:icd.search:${digest}`;
}

async function pcsAvailable(): Promise<boolean> {
  const result = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM icd.procedures",
    [],
    "icd.pcs_count"
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10) > 0;
}

async function searchDiagnoses(
  keyword: string,
  limit: number
): Promise<IcdCode[]> {
  const result = await query<IcdCode>(
    `SELECT code, name_zh, name_en
       FROM icd.diagnoses
      WHERE to_tsvector(
              'simple',
              COALESCE(code,'') || ' ' || COALESCE(name_zh,'') || ' ' ||
              COALESCE(name_en,'')
            ) @@ plainto_tsquery('simple', $1)
         OR code ILIKE $2
      ORDER BY code
      LIMIT $3`,
    [keyword, `${keyword}%`, limit],
    "icd.search_diagnoses"
  );
  return result.rows;
}

async function searchProcedures(
  keyword: string,
  limit: number
): Promise<IcdCode[]> {
  const result = await query<IcdCode>(
    `SELECT code, name_zh, name_en
       FROM icd.procedures
      WHERE to_tsvector(
              'simple',
              COALESCE(code,'') || ' ' || COALESCE(name_zh,'') || ' ' ||
              COALESCE(name_en,'')
            ) @@ plainto_tsquery('simple', $1)
         OR code ILIKE $2
      ORDER BY code
      LIMIT $3`,
    [keyword, `${keyword}%`, limit],
    "icd.search_procedures"
  );
  return result.rows;
}

export async function searchMedicalCodes(
  keyword: string,
  type: IcdSearchType,
  requestedLimit: number
): Promise<IcdSearchResult> {
  const limit = clampLimit(requestedLimit);
  return cached(cacheKey(keyword, type, limit), 86_400, async () => {
    const result: IcdSearchResult = {
      metadata: {
        search_mode: "keyword",
        semantic_available: false,
        node_gateway: true
      }
    };

    if (type === "diagnosis" || type === "all") {
      result.diagnoses = await searchDiagnoses(keyword, limit);
    }

    if (type === "procedure" || type === "all") {
      if (await pcsAvailable()) {
        result.procedures = await searchProcedures(keyword, limit);
      } else {
        result.procedures = [];
        result.procedures_note = "ICD-10-PCS data is not loaded.";
      }
    }

    return result;
  });
}
