/**
 * OCR and structured analysis for clinical guideline PDFs.
 *
 * Mirrors `drugAnalysisService.ts`: a PDF goes to MinerU's synchronous
 * `/file_parse` endpoint, the Markdown that comes back goes to the Analysis LM,
 * and the LM's JSON is shape-checked against `GUIDELINE_ANALYSIS_TEMPLATE`.
 *
 * Unlike the drug pipeline, the result of this service is never written straight
 * into the live `guideline.*` tables — the caller (`loaders/guidelineAnalysis.ts`)
 * only stages it into `guideline.document_analysis` with `review_status =
 * 'pending_review'`. Fan-out into `disease_guidelines` and its four child tables
 * happens only when an operator approves the document (`admin/guidelineReview.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as adminSettings from "./admin/adminSettings.js";
import { candidateOrder, type LlmProfile, type Strategy } from "./admin/llmProfiles.js";
import { callAnalysisLlm, type Message } from "./analysisLlmClient.js";
import { extractJsonObject, stripEmbeddedBase64Images } from "./drugAnalysisService.js";
import { logInfo, logWarning } from "./logger.js";

/** One row-template per recommendation array — every field is a string in the LLM contract; numeric fields like `step_order` are coerced at promotion time. */
const ROW_TEMPLATES: Record<string, Record<string, string>> = {
  diagnostic_recommendations: {
    step_order: "",
    recommendation_type: "",
    description: "",
    evidence_level: "",
  },
  medication_recommendations: {
    line_of_therapy: "",
    medication_class: "",
    medication_examples: "",
    dosage_guidance: "",
    contraindications: "",
    evidence_level: "",
  },
  test_recommendations: {
    test_category: "",
    test_name: "",
    loinc_code: "",
    frequency: "",
    indication: "",
    evidence_level: "",
  },
  treatment_goals: {
    goal_type: "",
    target_parameter: "",
    target_value: "",
    timeframe: "",
  },
};

export const GUIDELINE_ANALYSIS_TEMPLATE: Record<string, unknown> = {
  disease_info: {
    icd_code: "",
    disease_name_zh: "",
    disease_name_en: "",
    guideline_title: "",
    guideline_source: "",
    publication_year: "",
    guideline_summary: "",
  },
  diagnostic_recommendations: [],
  medication_recommendations: [],
  test_recommendations: [],
  treatment_goals: [],
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ANALYSIS_PROMPT_PATH = path.resolve(
  process.env.GUIDELINE_ANALYSIS_PROMPT_PATH ||
    path.join(HERE, "..", "..", "src", "prompts", "guideline", "analysis_prompt.txt"),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python `value in (None, "")` — null/undefined or the empty string. */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function asString(value: unknown): string {
  if (isBlank(value)) return "";
  if (typeof value === "string") return value.trim();
  return String(value);
}

/**
 * Structural validation for the guideline extraction template: a `disease_info`
 * object plus four arrays of row objects. Unlike `validateAnalysisShape` (drug's
 * template is scalars/nested objects), this needs an "array of objects each
 * matching a fixed row shape" case — the one genuinely new piece of validation
 * logic guideline extraction needs.
 */
export function validateGuidelineAnalysisShape(data: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(data)) return ["$ 必須是 object。"];

  const expectedTop = new Set(Object.keys(GUIDELINE_ANALYSIS_TEMPLATE));
  const actualTop = new Set(Object.keys(data));
  const missingTop = [...expectedTop].filter((key) => !actualTop.has(key)).sort();
  const extraTop = [...actualTop].filter((key) => !expectedTop.has(key)).sort();
  if (missingTop.length) errors.push(`$ 缺少欄位: ${missingTop.join(", ")}`);
  if (extraTop.length) errors.push(`$ 多出欄位: ${extraTop.join(", ")}`);

  if (actualTop.has("disease_info")) {
    const diseaseInfo = data.disease_info;
    const infoTemplate = GUIDELINE_ANALYSIS_TEMPLATE.disease_info as Record<string, string>;
    if (!isPlainObject(diseaseInfo)) {
      errors.push("$.disease_info 必須是 object。");
    } else {
      const expected = new Set(Object.keys(infoTemplate));
      const actual = new Set(Object.keys(diseaseInfo));
      const missing = [...expected].filter((key) => !actual.has(key)).sort();
      const extra = [...actual].filter((key) => !expected.has(key)).sort();
      if (missing.length) errors.push(`$.disease_info 缺少欄位: ${missing.join(", ")}`);
      if (extra.length) errors.push(`$.disease_info 多出欄位: ${extra.join(", ")}`);
      for (const key of expected) {
        if (actual.has(key) && typeof diseaseInfo[key] !== "string") {
          errors.push(`$.disease_info.${key} 必須是 string。`);
        }
      }
    }
  }

  for (const [arrayKey, rowTemplate] of Object.entries(ROW_TEMPLATES)) {
    if (!actualTop.has(arrayKey)) continue;
    const items = data[arrayKey];
    if (!Array.isArray(items)) {
      errors.push(`$.${arrayKey} 必須是 array。`);
      continue;
    }
    const expected = Object.keys(rowTemplate);
    items.forEach((item, idx) => {
      const p = `$.${arrayKey}[${idx}]`;
      if (!isPlainObject(item)) {
        errors.push(`${p} 必須是 object。`);
        return;
      }
      const keys = Object.keys(item);
      for (const key of expected.filter((k) => !keys.includes(k)).sort()) {
        errors.push(`${p} 缺少欄位: ${key}`);
      }
      for (const key of keys.filter((k) => !expected.includes(k)).sort()) {
        errors.push(`${p} 多出欄位: ${key}`);
      }
      for (const key of expected.filter((k) => keys.includes(k))) {
        if (typeof item[key] !== "string") errors.push(`${p}.${key} 必須是 string。`);
      }
    });
  }

  return errors;
}

/** Fills missing/malformed fields with the template defaults; never throws. */
export function normalizeGuidelineAnalysisData(input: unknown): Record<string, unknown> {
  const data = isPlainObject(input) ? input : {};
  const infoTemplate = GUIDELINE_ANALYSIS_TEMPLATE.disease_info as Record<string, string>;
  const rawInfo = isPlainObject(data.disease_info) ? data.disease_info : {};
  const diseaseInfo: Record<string, string> = {};
  for (const key of Object.keys(infoTemplate)) diseaseInfo[key] = asString(rawInfo[key]);

  const result: Record<string, unknown> = { disease_info: diseaseInfo };
  for (const [arrayKey, rowTemplate] of Object.entries(ROW_TEMPLATES)) {
    const items = Array.isArray(data[arrayKey]) ? (data[arrayKey] as unknown[]) : [];
    result[arrayKey] = items.filter(isPlainObject).map((item) => {
      const row: Record<string, string> = {};
      for (const key of Object.keys(rowTemplate)) row[key] = asString(item[key]);
      return row;
    });
  }
  return result;
}

/**
 * The top-level shape the Analysis LM actually returns: `{"guidelines": [...]}`,
 * one element per disease it identified in the document (a single PDF may cover
 * more than one disease — see analysis_prompt.txt). Each element is validated
 * with `validateGuidelineAnalysisShape`, the same per-disease validator the
 * review/approve path uses for a single extraction.
 */
export function validateGuidelineAnalysisResponse(data: unknown): string[] {
  if (!isPlainObject(data)) return ["$ 必須是 object。"];
  const expectedTop = new Set(["guidelines"]);
  const actualTop = new Set(Object.keys(data));
  const extraTop = [...actualTop].filter((key) => !expectedTop.has(key)).sort();
  const errors: string[] = [];
  if (!actualTop.has("guidelines")) errors.push('$ 缺少欄位: guidelines');
  if (extraTop.length) errors.push(`$ 多出欄位: ${extraTop.join(", ")}`);

  const guidelines = data.guidelines;
  if (!Array.isArray(guidelines)) {
    errors.push("$.guidelines 必須是 array。");
    return errors;
  }
  if (guidelines.length === 0) errors.push("$.guidelines 不可為空陣列（至少要判斷出一種疾病）。");
  guidelines.forEach((item, idx) => {
    for (const err of validateGuidelineAnalysisShape(item)) {
      errors.push(`$.guidelines[${idx}]${err.startsWith("$") ? err.slice(1) : ` ${err}`}`);
    }
  });
  return errors;
}

/** Normalizes the `{guidelines: [...]}` envelope, one element per disease; never throws. */
export function normalizeGuidelineAnalysisResponse(input: unknown): Record<string, unknown>[] {
  const data = isPlainObject(input) ? input : {};
  const guidelines = Array.isArray(data.guidelines) ? data.guidelines : [];
  return guidelines.map((item) => normalizeGuidelineAnalysisData(item));
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface GuidelineAnalysisConfig {
  ocrProvider: string;
  ocrBaseUrl: string;
  ocrBackend: string;
  ocrEffort: string;
  ocrParseMethod: string;
  ocrLang: string;
  ocrTimeoutSeconds: number;
  analysisPromptPath: string;
  analysisMaxRetries: number;
  /** Already ordered for this run (failover by priority, or weighted). */
  analysisProfiles: LlmProfile[];
  analysisStrategy: string;
  /** Whether an operator has actually set OCR up — it is never seeded from env. */
  ocrConfigured: boolean;
}

function str(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function configFromValues(opts: {
  ocr: Record<string, unknown>;
  analysis: Record<string, unknown>;
  analysisProfiles?: LlmProfile[];
  ocrConfigured?: boolean;
}): GuidelineAnalysisConfig {
  const { ocr, analysis } = opts;
  return {
    ocrProvider: str(ocr.provider, "mineru").toLowerCase(),
    ocrBaseUrl: String(ocr.base_url ?? "")
      .trim()
      .replace(/\/+$/, ""),
    ocrBackend: str(ocr.backend, "hybrid-engine"),
    ocrEffort: str(ocr.effort, "medium"),
    ocrParseMethod: str(ocr.parse_method, "auto"),
    ocrLang: str(ocr.lang, "ch"),
    ocrTimeoutSeconds: Number(ocr.timeout_seconds || 600) || 600,
    analysisPromptPath: DEFAULT_ANALYSIS_PROMPT_PATH,
    analysisMaxRetries: Number(analysis.max_retries || 3) || 3,
    analysisProfiles: opts.analysisProfiles ?? [],
    analysisStrategy: str(analysis.strategy, "failover"),
    ocrConfigured: opts.ocrConfigured ?? true,
  };
}

/**
 * The one way to build a guideline OCR/analysis config. Reuses the exact same
 * `admin.app_settings` group `"ocr"` and `kind='analysis'` LLM profiles as the
 * drug pipeline — guideline and drug extraction are both "OCR markdown →
 * structured JSON via a general-purpose chat LLM", so there is no reason to
 * configure them independently unless an operator later wants to point a
 * different model at guideline extraction specifically.
 */
export async function loadGuidelineAnalysisConfig(): Promise<GuidelineAnalysisConfig> {
  const analysis = await adminSettings.getGroup("analysis");
  const strategy = str(analysis.strategy, "failover") as Strategy;
  return configFromValues({
    ocr: await adminSettings.getGroup("ocr"),
    analysis,
    analysisProfiles: await candidateOrder("analysis", strategy),
    ocrConfigured: await adminSettings.isGroupConfigured("ocr"),
  });
}

export interface GuidelineAnalysisResult {
  markdown: string;
  /** One element per disease the LLM identified in the document. */
  analysisItems: Record<string, unknown>[];
  ocrProvider: string;
  analysisProvider: string;
}

const NOT_CONFIGURED = (what: string, group: string): string =>
  `${what} is not configured yet — set it up in the admin console (Settings → ${group}).`;

export class GuidelineAnalysisService {
  /** The profile that served the last call — failover may make it not the primary. */
  lastProfileUsed: LlmProfile | null = null;

  constructor(readonly config: GuidelineAnalysisConfig) {}

  ocrReadiness(): [boolean, string] {
    if (!this.config.ocrConfigured) return [false, NOT_CONFIGURED("OCR server", "OCR Server")];
    if (this.config.ocrProvider !== "mineru") {
      return [false, `Unsupported OCR provider: ${this.config.ocrProvider}`];
    }
    if (!this.config.ocrBaseUrl) return [false, NOT_CONFIGURED("OCR base URL", "OCR Server")];
    return [true, ""];
  }

  analysisReadiness(): [boolean, string] {
    if (this.config.analysisProfiles.length === 0) {
      return [false, NOT_CONFIGURED("Analysis LM", "Analysis LM")];
    }
    if (!fs.existsSync(this.config.analysisPromptPath)) {
      return [false, `Analysis prompt not found: ${this.config.analysisPromptPath}`];
    }
    for (const profile of this.config.analysisProfiles) {
      if (!["openai", "vllm", "ollama"].includes(profile.provider)) {
        return [false, `Profile '${profile.name}': unsupported provider '${profile.provider}'`];
      }
    }
    return [true, ""];
  }

  readiness(): [boolean, string] {
    const [ready, reason] = this.ocrReadiness();
    if (!ready) return [ready, reason];
    return this.analysisReadiness();
  }

  async analyzePdfBytes(opts: {
    documentId: string;
    sourceFilename: string;
    pdfBytes: Buffer;
    existingMarkdown?: string | null;
  }): Promise<GuidelineAnalysisResult> {
    const [ready, reason] = opts.existingMarkdown ? this.analysisReadiness() : this.readiness();
    if (!ready) throw new Error(reason);

    const markdown =
      opts.existingMarkdown || (await this.ocrPdfBytes(opts.pdfBytes, opts.sourceFilename));
    const analysisItems = await this.runAnalysis(markdown);
    const used = this.lastProfileUsed;
    return {
      markdown,
      analysisItems,
      ocrProvider: this.config.ocrProvider,
      analysisProvider: used ? used.provider : (this.config.analysisProfiles[0]?.provider ?? ""),
    };
  }

  /** Turn one guideline PDF into Markdown via MinerU's synchronous endpoint — identical shape to the drug pipeline's OCR call, since OCR is document-format-agnostic. */
  private async ocrPdfBytes(pdfBytes: Buffer, sourceFilename: string): Promise<string> {
    if (!pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error(
        `${sourceFilename} is not a PDF (leading bytes: ${JSON.stringify(
          pdfBytes.subarray(0, 8).toString("latin1"),
        )})`,
      );
    }

    const form = new FormData();
    form.append(
      "files",
      new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }),
      sourceFilename,
    );
    form.append("backend", this.config.ocrBackend);
    form.append("effort", this.config.ocrEffort);
    form.append("parse_method", this.config.ocrParseMethod);
    form.append("lang_list", this.config.ocrLang);
    form.append("table_enable", "true");
    form.append("return_md", "true");
    form.append("return_images", "false");
    form.append("return_middle_json", "false");
    form.append("return_content_list", "false");
    form.append("response_format_zip", "false");

    const url = `${this.config.ocrBaseUrl}/file_parse`;
    const response = await fetch(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.config.ocrTimeoutSeconds * 1000),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;

    const results = (payload.results ?? {}) as Record<string, { md_content?: string }>;
    const first = Object.values(results)[0];
    if (!first) {
      throw new Error(
        `OCR returned no results: ${String(payload.error ?? JSON.stringify(payload))}`,
      );
    }
    const markdown = String(first.md_content ?? "");
    if (!markdown.trim()) throw new Error("OCR markdown is empty");
    return markdown;
  }

  private async runAnalysis(ocrMarkdown: string): Promise<Record<string, unknown>[]> {
    const [sanitized, removedImages, removedChars] = stripEmbeddedBase64Images(ocrMarkdown);
    if (removedImages) {
      logInfo("Removed embedded base64 images from OCR markdown", {
        removed_images: removedImages,
        removed_chars: removedChars,
      });
    }
    const prompt = fs.readFileSync(this.config.analysisPromptPath, "utf8");
    const templateJson = JSON.stringify({ guidelines: [GUIDELINE_ANALYSIS_TEMPLATE] }, null, 2);
    const messages: Message[] = [
      { role: "system", content: prompt },
      {
        role: "user",
        content:
          "以下是 OCR 轉出的臨床指引 Markdown 內容。" +
          "請判斷文件中討論了幾種疾病，為每一種疾病各自輸出一份完整區塊，" +
          "並輸出和指定模板完全一致的 JSON。\n\n" +
          `指定 JSON 模板：\n${templateJson}\n\n` +
          `OCR Markdown：\n${sanitized}`,
      },
    ];

    let lastError = "";
    for (let attempt = 1; attempt <= this.config.analysisMaxRetries; attempt += 1) {
      const { content, profileUsed } = await callAnalysisLlm(this.config.analysisProfiles, messages);
      this.lastProfileUsed = profileUsed;
      try {
        const items = normalizeGuidelineAnalysisResponse(extractJsonObject(content));
        const errors = validateGuidelineAnalysisResponse({ guidelines: items });
        if (errors.length === 0) return items;
        lastError = errors.join("; ");
      } catch (err) {
        lastError = String(err instanceof Error ? err.message : err);
      }

      logWarning("Guideline analysis output failed validation", {
        attempt,
        max_retries: this.config.analysisMaxRetries,
        error: lastError,
      });
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          "上一次輸出不合格。請重新輸出單一合法 JSON object，最外層是 {\"guidelines\": [...]}。" +
          "不要輸出說明、不要輸出 Markdown code fence、不要加入模板外欄位。" +
          `錯誤原因: ${lastError}`,
      });
    }
    throw new Error(
      `Guideline analysis LLM failed after ${this.config.analysisMaxRetries} attempts: ${lastError}`,
    );
  }
}
