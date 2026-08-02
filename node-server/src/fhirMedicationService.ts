/**
 * FHIR Medication service — derives FHIR R4 Medication / MedicationKnowledge
 * resources from normalized TFDA drug records (no RxNorm dependency).
 *
 * Faithful port of `src/fhir_medication_service.py`. Reads `drug.licenses` +
 * `drug.normalized_records.normalized_json`. The MCP tool wrappers
 * (`query_fhir_medication` / `validate_fhir_medication`) live in `mcp.ts`.
 */

import { query } from "./db.js";
import { logInfo, logError } from "./logger.js";

const FHIR_MEDICATION_PROFILE = "http://hl7.org/fhir/StructureDefinition/Medication";
const FHIR_MEDICATION_KNOWLEDGE_PROFILE =
  "http://hl7.org/fhir/StructureDefinition/MedicationKnowledge";
const TFDA_LICENSE_SYSTEM = "https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id";
const EXT_BASE = "https://mcp.fda.gov.tw/fhir/StructureDefinition";
const UCUM_SYSTEM = "http://unitsofmeasure.org";

type ResourceType = "Medication" | "MedicationKnowledge";
type Json = Record<string, unknown>;

/** Mirror Python `normalize_license_token`: uppercase, strip non-alphanumerics. */
export function normalizeLicenseToken(licenseId: string): string {
  return (licenseId || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/** Mirror Python `datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")`. */
function nowStamp(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`
  );
}

function asDict(v: unknown): Json {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Mirror Python `_coerce_json`: jsonb may arrive as object (node-pg) or string. */
function coerceJson(v: unknown): Json {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Json;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Json)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

interface DrugRecord {
  license_id: string;
  is_active: boolean;
  cancellation_status: string;
  normalized_json: Json;
}

interface RawRow {
  license_id: string;
  is_active: boolean;
  cancellation_status: string | null;
  normalized_json: unknown;
}

export class FHIRMedicationService {
  async initialize(): Promise<void> {
    logInfo("FHIR Medication Service initialized");
  }

  private async getDrugRecord(licenseId: string): Promise<DrugRecord | null> {
    const token = normalizeLicenseToken(licenseId);
    const r = await query<RawRow>(
      `SELECT l.license_id, l.is_active, l.cancellation_status, n.normalized_json
       FROM drug.normalized_records n
       JOIN drug.licenses l ON l.license_id = n.license_id
       WHERE l.license_id = $1 OR l.license_token = $2
       ORDER BY CASE
           WHEN l.license_id = $1 THEN 0
           WHEN l.license_token = $2 THEN 1
           ELSE 2
       END
       LIMIT 1`,
      [licenseId, token],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      license_id: row.license_id,
      is_active: Boolean(row.is_active),
      cancellation_status: row.cancellation_status || "",
      normalized_json: coerceJson(row.normalized_json),
    };
  }

  private async searchDrugRecords(keyword: string, limit = 5): Promise<DrugRecord[]> {
    const like = `%${keyword}%`;
    const r = await query<RawRow>(
      `WITH ranked AS (
          SELECT
              l.license_id,
              CASE
                  WHEN COALESCE(l.chinese_name, '') = $1 OR COALESCE(l.english_name, '') = $1 THEN 0
                  WHEN COALESCE(l.chinese_name, '') ILIKE $2 OR COALESCE(l.english_name, '') ILIKE $2 THEN 1
                  WHEN COALESCE(l.indications_text, '') ILIKE $2 THEN 2
                  ELSE 3
              END AS match_rank
          FROM drug.licenses l
          JOIN drug.normalized_records n ON n.license_id = l.license_id
          WHERE l.is_listed
            AND (
              COALESCE(l.chinese_name, '') ILIKE $2
              OR COALESCE(l.english_name, '') ILIKE $2
              OR COALESCE(l.indications_text, '') ILIKE $2
              OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(COALESCE(n.normalized_json #> '{ingredients,active}', '[]'::jsonb)) i
                  WHERE COALESCE(i->>'name', i->>'成分', '') ILIKE $2
                     OR COALESCE(i->>'raw_text', '') ILIKE $2
              )
            )
       )
       SELECT l.license_id, l.is_active, l.cancellation_status, n.normalized_json, ranked.match_rank
       FROM ranked
       JOIN drug.licenses l ON l.license_id = ranked.license_id
       JOIN drug.normalized_records n ON n.license_id = l.license_id
       ORDER BY ranked.match_rank, l.is_active DESC, l.license_id
       LIMIT $3`,
      [keyword, like, Math.min(Math.max(limit, 1), 5)],
    );
    return r.rows.map((row) => ({
      license_id: row.license_id,
      is_active: Boolean(row.is_active),
      cancellation_status: row.cancellation_status || "",
      normalized_json: coerceJson(row.normalized_json),
    }));
  }

  /** Mirror of `create_medication`. */
  async createMedication(licenseId: string, resourceType: ResourceType = "Medication"): Promise<Json> {
    try {
      const record = await this.getDrugRecord(licenseId);
      if (!record) {
        return { error: `Drug license '${licenseId}' not found in database` };
      }
      return this.buildResource(record.normalized_json, record.license_id, record.is_active, resourceType);
    } catch (exc) {
      logError(`create_medication error: ${String((exc as Error).message)}`);
      return { error: String((exc as Error).message), license_id: licenseId };
    }
  }

  /** Mirror of `create_medication_from_search`. */
  async createMedicationFromSearch(keyword: string, resourceType: ResourceType = "Medication"): Promise<Json> {
    const matches = await this.searchDrugRecords(keyword);
    if (matches.length === 0) {
      return { error: `No drug found for keyword: ${keyword}` };
    }
    const first = matches[0];
    const resource = this.buildResource(first.normalized_json, first.license_id, first.is_active, resourceType);
    return {
      search_results: matches.map((item) => ({
        license_id: item.license_id,
        name_zh: this.nestedGet(item.normalized_json, "drug", "chinese_name"),
        name_en: this.nestedGet(item.normalized_json, "drug", "english_name"),
        is_active: item.is_active,
        cancellation_status: item.cancellation_status,
      })),
      selected_license_id: first.license_id,
      fhir_medication: resource,
    };
  }

  /** Mirror of `validate_medication`. */
  validateMedication(medication: Json): Json {
    const errors: string[] = [];
    const resourceType = medication.resourceType;
    if (resourceType !== "Medication" && resourceType !== "MedicationKnowledge") {
      errors.push("resourceType must be 'Medication' or 'MedicationKnowledge'");
    }
    const code = medication.code;
    if (typeof code !== "object" || code === null || !(code as Json).coding) {
      errors.push("code.coding must be present with at least one entry");
    }
    const ingredients = medication.ingredient ?? [];
    if (ingredients !== null && ingredients !== undefined) {
      if (!Array.isArray(ingredients)) {
        errors.push("ingredient must be an array");
      } else {
        ingredients.forEach((item, idx) => {
          if (typeof item !== "object" || item === null || Array.isArray(item)) {
            errors.push(`ingredient[${idx}] must be an object`);
            return;
          }
          const it = item as Json;
          if (!("itemCodeableConcept" in it) && !("itemReference" in it)) {
            errors.push(`ingredient[${idx}] must include itemCodeableConcept or itemReference`);
          }
        });
      }
    }
    return {
      valid: errors.length === 0,
      resource_type: (resourceType as string) || "",
      errors,
    };
  }

  // ── resource builders ──────────────────────────────────────────────────

  private buildResource(
    normalized: Json,
    licenseId: string,
    isActive: boolean,
    resourceType: ResourceType,
  ): Json {
    if (resourceType !== "Medication" && resourceType !== "MedicationKnowledge") {
      throw new Error("resource_type must be 'Medication' or 'MedicationKnowledge'");
    }
    const token = normalizeLicenseToken(licenseId) || licenseId;
    const now = nowStamp();
    const drug = asDict(normalized.drug);
    const companies = asDict(normalized.companies);
    const applicant = asDict(companies.applicant);
    const manufacturers = companies.manufacturers;
    const ingredients = this.buildIngredients(normalized.ingredients);
    const displayName = drug.english_name || drug.chinese_name || licenseId;
    const textName = drug.chinese_name || drug.english_name || licenseId;

    const common: Json = {
      identifier: [{ use: "official", system: TFDA_LICENSE_SYSTEM, value: licenseId }],
      code: {
        coding: [{ system: TFDA_LICENSE_SYSTEM, code: licenseId, display: displayName }],
        text: textName,
      },
      extension: this.buildCommonExtensions(normalized, applicant, manufacturers),
    };

    if (resourceType === "Medication") {
      return {
        resourceType: "Medication",
        id: `medication-${token.toLowerCase()}`,
        meta: { profile: [FHIR_MEDICATION_PROFILE], lastUpdated: now },
        status: isActive ? "active" : "inactive",
        ...common,
        doseForm: this.textCodeableConcept(String(drug.dosage_form ?? "")),
        ingredient: ingredients,
      };
    }

    return {
      resourceType: "MedicationKnowledge",
      id: `medicationknowledge-${token.toLowerCase()}`,
      meta: { profile: [FHIR_MEDICATION_KNOWLEDGE_PROFILE], lastUpdated: now },
      status: isActive ? "active" : "inactive",
      ...common,
      associatedMedication: [
        { reference: `Medication/medication-${token.toLowerCase()}`, display: textName },
      ],
      doseForm: this.textCodeableConcept(String(drug.dosage_form ?? "")),
      ingredient: ingredients,
      monograph: this.buildMonographs(normalized),
      drugCharacteristic: this.buildDrugCharacteristics(normalized),
    };
  }

  private buildCommonExtensions(normalized: Json, applicant: Json, manufacturers: unknown): Json[] {
    const drug = asDict(normalized.drug);
    const usage = asDict(normalized.usage);
    const quality = asDict(normalized.quality);
    const extensions: Json[] = [];
    this.appendStringExtension(extensions, "tfda-drug-category", String(drug.drug_category ?? ""));
    this.appendStringExtension(extensions, "tfda-license-type", String(drug.license_type ?? ""));
    this.appendStringExtension(extensions, "tfda-package", String(drug.package ?? ""));
    this.appendStringExtension(extensions, "tfda-applicant-name", String(applicant.name ?? ""));
    this.appendStringExtension(extensions, "tfda-applicant-address", String(applicant.address ?? ""));
    for (const manufacturer of asArray(manufacturers)) {
      if (typeof manufacturer !== "object" || manufacturer === null) continue;
      const m = manufacturer as Json;
      if (m.name) {
        extensions.push({
          url: `${EXT_BASE}/tfda-manufacturer`,
          extension: [
            { url: "name", valueString: String(m.name ?? "") },
            { url: "country", valueString: String(m.country ?? "") },
            { url: "process", valueString: String(m.process ?? "") },
          ],
        });
      }
    }
    for (const indication of asArray(usage.purpose)) {
      if (indication) {
        extensions.push({ url: `${EXT_BASE}/tfda-indication`, valueString: String(indication) });
      }
    }
    this.appendStringExtension(extensions, "tfda-quality-confidence", String(quality.confidence ?? ""));
    return extensions;
  }

  private buildMonographs(normalized: Json): Json[] {
    const insertContent = asDict(normalized.insert_content);
    const packaging = asDict(normalized.packaging_and_labeling);
    const monographs: Json[] = [];
    for (const document of asArray(insertContent.insert_documents)) {
      const m = this.monographFromDocument(document, "Insert PDF");
      if (m) monographs.push(m);
    }
    for (const document of asArray(packaging.label_documents)) {
      const m = this.monographFromDocument(document, "Label PDF");
      if (m) monographs.push(m);
    }
    return monographs;
  }

  private monographFromDocument(document: unknown, label: string): Json | null {
    if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
    const doc = document as Json;
    const filename = String(doc.filename ?? "");
    const sourceUrl = String(doc.source_url ?? "");
    const minio = asDict(doc.minio);
    const reference: Json = { display: filename || sourceUrl || label };
    const minioUri = String(minio.uri ?? "");
    if (minioUri) {
      reference.identifier = { system: "urn:minio:uri", value: minioUri };
    } else if (sourceUrl) {
      reference.identifier = { system: "urn:source:url", value: sourceUrl };
    }
    return { type: { text: label }, source: reference };
  }

  private buildDrugCharacteristics(normalized: Json): Json[] {
    const appearance = asDict(normalized.appearance);
    const records = asArray(appearance.records);
    if (records.length === 0) return [];
    const first = typeof records[0] === "object" && records[0] !== null ? (records[0] as Json) : {};
    const characteristics: Json[] = [];
    for (const [label, key] of [
      ["color", "color"],
      ["shape", "shape"],
      ["imprint", "imprint"],
      ["size", "size"],
      ["description", "description"],
    ] as const) {
      const value = first[key] ?? "";
      if (value) {
        characteristics.push({ type: { text: label }, valueString: String(value) });
      }
    }
    return characteristics;
  }

  private buildIngredients(ingredientsBlock: unknown): Json[] {
    if (typeof ingredientsBlock !== "object" || ingredientsBlock === null || Array.isArray(ingredientsBlock)) {
      return [];
    }
    const block = ingredientsBlock as Json;
    const entries: Json[] = [];
    for (const [isActive, bucketName] of [
      [true, "active"],
      [false, "inactive"],
    ] as const) {
      for (const item of asArray(block[bucketName])) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const it = item as Json;
        const name = it.name || it["成分"] || "";
        if (!name) continue;
        const ingredient: Json = {
          itemCodeableConcept: { text: String(name) },
          isActive,
        };
        const strength = this.ratioFromAmount(
          [String(it.amount || it["含量"] || ""), String(it.unit || "")].filter(Boolean).join(" "),
        );
        if (strength) ingredient.strength = strength;
        entries.push(ingredient);
      }
    }
    return entries;
  }

  private ratioFromAmount(amountText: string): Json | null {
    if (!amountText) return null;
    const match = /^\s*(\d+(?:\.\d+)?)\s*(mg|g|mcg|μg|ug|mL|ml|IU|%)\b/i.exec(String(amountText));
    if (!match) return null;
    const value = Number.parseFloat(match[1]);
    const unit = match[2];
    const normalizedUnit = ({ ml: "mL", ug: "ug" } as Record<string, string>)[unit.toLowerCase()] ?? unit;
    return {
      numerator: { value, unit: normalizedUnit, system: UCUM_SYSTEM, code: normalizedUnit },
      denominator: { value: 1, unit: "1", system: UCUM_SYSTEM, code: "1" },
    };
  }

  private appendStringExtension(target: Json[], name: string, value: string): void {
    if (value) target.push({ url: `${EXT_BASE}/${name}`, valueString: String(value) });
  }

  private textCodeableConcept(text: string): Json {
    return text ? { text } : {};
  }

  private nestedGet(data: Json, ...keys: string[]): string {
    let current: unknown = data;
    for (const key of keys) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) return "";
      current = (current as Json)[key] ?? "";
    }
    return current !== null && current !== "" && current !== undefined ? String(current) : "";
  }
}
