/**
 * FHIR Condition service — converts ICD-10 diagnosis codes to FHIR R4 Condition
 * resources. Faithful port of `src/fhir_condition_service.py`.
 *
 * Derives entirely from `icd.diagnoses` (no own tables). The MCP tool wrappers
 * (`query_fhir_condition` / `validate_fhir_condition`) live in `mcp.ts`,
 * mirroring `server.py`.
 */

import { randomBytes } from "node:crypto";
import { query } from "./db.js";
import { logInfo, logError } from "./logger.js";

const FHIR_ICD10_CM_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm";
const FHIR_CLINICAL_STATUS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-clinical";
const FHIR_VERIFICATION_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-ver-status";
const FHIR_CATEGORY_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-category";
const FHIR_SEVERITY_SYSTEM = "http://snomed.info/sct";

type ClinicalStatus = "active" | "inactive" | "resolved" | "remission";
type VerificationStatus = "confirmed" | "provisional" | "differential" | "refuted";
type Category = "problem-list-item" | "encounter-diagnosis";
type Severity = "mild" | "moderate" | "severe";

interface IcdRow {
  code: string;
  name_zh: string | null;
  name_en: string | null;
}

interface CreateConditionOpts {
  clinical_status?: ClinicalStatus;
  verification_status?: VerificationStatus;
  category?: Category;
  severity?: Severity | string | null;
  onset_date?: string | null;
  recorded_date?: string | null;
  additional_notes?: string | null;
}

const STATUS_DISPLAY: Record<string, Record<string, string>> = {
  clinical: {
    active: "Active",
    inactive: "Inactive",
    resolved: "Resolved",
    remission: "Remission",
  },
  verification: {
    confirmed: "Confirmed",
    provisional: "Provisional",
    differential: "Differential",
    refuted: "Refuted",
  },
  category: {
    "problem-list-item": "Problem List Item",
    "encounter-diagnosis": "Encounter Diagnosis",
  },
};

function statusDisplay(code: string, kind: string): string {
  return STATUS_DISPLAY[kind]?.[code] ?? code;
}

function codeableConcept(system: string, code: string, display: string) {
  return { coding: [{ system, code, display }] };
}

/** Mirror Python `datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")`. */
function nowStamp(): string {
  // Render wall-clock in UTC+8 with a fixed +08:00 offset, matching the Python
  // server which formats local time with a hardcoded +08:00 suffix.
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`
  );
}

export class FHIRConditionService {
  async initialize(): Promise<void> {
    logInfo("FHIR Condition Service initialized");
  }

  private async getIcdInfo(icdCode: string): Promise<IcdRow | null> {
    const r = await query<IcdRow>(
      "SELECT code, name_zh, name_en FROM icd.diagnoses WHERE code = $1",
      [icdCode],
    );
    return r.rows[0] ?? null;
  }

  /** Mirror of `FHIRConditionService.create_condition`. */
  async createCondition(
    icdCode: string,
    patientId: string,
    opts: CreateConditionOpts = {},
  ): Promise<Record<string, unknown>> {
    const {
      clinical_status = "active",
      verification_status = "confirmed",
      category = "encounter-diagnosis",
      severity = null,
      onset_date = null,
      recorded_date = null,
      additional_notes = null,
    } = opts;
    try {
      const icdInfo = await this.getIcdInfo(icdCode);
      if (!icdInfo) {
        return { error: `ICD-10 code '${icdCode}' not found in database` };
      }

      const now = nowStamp();
      const condition: Record<string, unknown> = {
        resourceType: "Condition",
        id: `condition-${patientId}-${icdCode.replace(/\./g, "-")}-${randomBytes(4).toString("hex")}`,
        meta: {
          profile: ["http://hl7.org/fhir/StructureDefinition/Condition"],
          lastUpdated: now,
        },
        clinicalStatus: codeableConcept(
          FHIR_CLINICAL_STATUS_SYSTEM,
          clinical_status,
          statusDisplay(clinical_status, "clinical"),
        ),
        verificationStatus: codeableConcept(
          FHIR_VERIFICATION_SYSTEM,
          verification_status,
          statusDisplay(verification_status, "verification"),
        ),
        category: [
          codeableConcept(
            FHIR_CATEGORY_SYSTEM,
            category,
            statusDisplay(category, "category"),
          ),
        ],
        code: {
          coding: [
            {
              system: FHIR_ICD10_CM_SYSTEM,
              code: icdInfo.code,
              // Mirror dict.get("name_en", "") on a present key: value as-is (may be null).
              display: icdInfo.name_en ?? null,
            },
          ],
          // Mirror dict.get("name_zh", dict.get("name_en","")): present key → value as-is.
          text: icdInfo.name_zh ?? null,
        },
        subject: { reference: `Patient/${patientId}` },
        recordedDate: recorded_date || now,
      };

      if (severity) {
        const severityMap: Record<string, [string, string]> = {
          mild: ["255604002", "Mild"],
          moderate: ["6736007", "Moderate"],
          severe: ["24484000", "Severe"],
        };
        const [code, display] = severityMap[severity as string] ?? ["6736007", "Moderate"];
        condition.severity = codeableConcept(FHIR_SEVERITY_SYSTEM, code, display);
      }
      if (onset_date) condition.onsetDateTime = onset_date;
      if (additional_notes) condition.note = [{ text: additional_notes, time: now }];

      return condition;
    } catch (e) {
      logError(`create_condition error: ${String((e as Error).message)}`);
      return { error: String((e as Error).message), icd_code: icdCode };
    }
  }

  /** Mirror of `FHIRConditionService.create_condition_from_search`. */
  async createConditionFromSearch(
    keyword: string,
    patientId: string,
    opts: CreateConditionOpts = {},
  ): Promise<Record<string, unknown>> {
    const r = await query<IcdRow>(
      `SELECT code, name_zh, name_en FROM icd.diagnoses
       WHERE to_tsvector('simple', COALESCE(code,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
             @@ plainto_tsquery('simple', $1)
       LIMIT 5`,
      [keyword],
    );
    if (r.rows.length === 0) {
      return { error: `No diagnosis found for keyword: ${keyword}` };
    }
    const first = r.rows[0];
    const condition = await this.createCondition(first.code, patientId, opts);
    return {
      search_results: r.rows,
      selected_code: first.code,
      fhir_condition: condition,
    };
  }

  /** Mirror of `FHIRConditionService.validate_condition`. */
  validateCondition(condition: Record<string, unknown>): Record<string, unknown> {
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const field of ["resourceType", "code", "subject"]) {
      if (!(field in condition)) errors.push(`Missing required field: ${field}`);
    }
    if (condition.resourceType !== "Condition") {
      errors.push("resourceType must be 'Condition'");
    }
    if (!("clinicalStatus" in condition) && !("verificationStatus" in condition)) {
      warnings.push(
        "At least one of clinicalStatus or verificationStatus should be present",
      );
    }
    return { valid: errors.length === 0, errors, warnings };
  }
}
