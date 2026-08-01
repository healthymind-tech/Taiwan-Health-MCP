/**
 * OCR and structured analysis for drug insert PDFs.
 *
 * Node port of `src/drug_analysis_service.py`. A PDF goes to MinerU's synchronous
 * `/file_parse` endpoint, the Markdown that comes back goes to the Analysis LM,
 * and the LM's JSON is normalized and shape-checked against `ANALYSIS_TEMPLATE`.
 * Stays independent of RxNorm: it only touches TFDA-backed drug assets.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as adminSettings from "./admin/adminSettings.js";
import { candidateOrder, type LlmProfile, type Strategy } from "./admin/llmProfiles.js";
import { callAnalysisLlm, type Message } from "./analysisLlmClient.js";
import { logInfo, logWarning } from "./logger.js";

export { isReasoningModel, MAX_TOKEN_BUDGET, TokenBudgetExceeded } from "./analysisLlmClient.js";

export const ANALYSIS_TEMPLATE: Record<string, unknown> = {
  藥品特性: "",
  有效成分及含量: [],
  其他成分: [],
  "用途(適應症)": [],
  使用上注意事項: {
    "有下列情形者，請勿使用": [],
    "有下列情形者，使用前請洽醫師診治": [],
    "有下列情形者，使用前請先諮詢醫師藥師藥劑生": [],
    其他使用上注意事項: [],
  },
  用法用量: [],
  警語: {
    "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生": [],
    "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治": [],
  },
  儲存方式: [],
};

// Simplified→traditional conversion. The Python tries OpenCC first and falls back
// to these tables; OpenCC is not in the worker's requirements, so the fallback is
// what actually runs — and it is what is reproduced here.
const S2T_PHRASES: Record<string, string> = {
  药品: "藥品",
  适应症: "適應症",
  使用上注意事项: "使用上注意事項",
  请勿使用: "請勿使用",
  使用前请洽医师诊治: "使用前請洽醫師診治",
  使用前请先咨询医师药师药剂生: "使用前請先諮詢醫師藥師藥劑生",
  警语: "警語",
  说明书: "說明書",
  咨询: "諮詢",
  医师: "醫師",
  药师: "藥師",
  药剂生: "藥劑生",
  症状: "症狀",
  接受医师诊治: "接受醫師診治",
  储存方式: "儲存方式",
};

const S2T_CHARS: Record<string, string> = {
  药: "藥", 医: "醫", 师: "師", 剂: "劑", 咨: "諮", 询: "詢", 说: "說", 书: "書",
  语: "語", 储: "儲", 适: "適", 应: "應", 项: "項", 请: "請", 诊: "診", 则: "則",
  时: "時", 后: "後", 发: "發", 处: "處", 阳: "陽", 儿: "兒", 与: "與", 为: "為",
  无: "無", 湿: "濕", 温: "溫", 过: "過", 内: "內", 类: "類", 体: "體", 复: "複",
  补: "補", 营: "營", 养: "養", 并: "並",
};

const DATA_IMG_MD_RE = /!\[[^\]]*\]\(\s*data:image\/[^;\s)]+;base64,[^)]+\)/gi;
const DATA_IMG_HTML_RE = /<img\b[^>]*\bsrc=["']data:image\/[^;"']+;base64,[^"']+["'][^>]*>/gi;
const DATA_IMG_URI_RE = /data:image\/[^;\s)"']+;base64,[A-Za-z0-9+/_=\-.\r\n]+/gi;

const INGREDIENT_AMOUNT_RE =
  /^(.+?)\s*(\d+(?:\.\d+)?\s*(?:mg|g|mcg|μg|ug|mL|ml|IU|%|毫克|公克|微克|毫升|單位).*)$/i;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The prompt ships with the code (repo `src/prompts/drug/`), and is deliberately
// not configurable — a path pointing elsewhere was only ever a way to break the
// pipeline. DRUG_ANALYSIS_PROMPT_PATH exists so the container can say where the
// repo is mounted, not so the prompt can be swapped.
const DEFAULT_ANALYSIS_PROMPT_PATH = path.resolve(
  process.env.DRUG_ANALYSIS_PROMPT_PATH ||
    path.join(HERE, "..", "..", "src", "prompts", "drug", "analysis_prompt.txt"),
);

export function convertTextToTraditional(text: string): string {
  let converted = text;
  for (const [simplified, traditional] of Object.entries(S2T_PHRASES)) {
    converted = converted.split(simplified).join(traditional);
  }
  return [...converted].map((ch) => S2T_CHARS[ch] ?? ch).join("");
}

export function convertJsonToTraditional(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convertJsonToTraditional);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[convertTextToTraditional(String(key))] = convertJsonToTraditional(item);
    }
    return out;
  }
  if (typeof value === "string") return convertTextToTraditional(value);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateAnalysisShape(
  data: unknown,
  template: unknown = ANALYSIS_TEMPLATE,
  pathStr = "$",
): string[] {
  const errors: string[] = [];
  if (isPlainObject(template)) {
    if (!isPlainObject(data)) return [`${pathStr} 必須是 object。`];
    const expected = new Set(Object.keys(template));
    const actual = new Set(Object.keys(data));
    const missing = [...expected].filter((key) => !actual.has(key)).sort();
    const extra = [...actual].filter((key) => !expected.has(key)).sort();
    if (missing.length) errors.push(`${pathStr} 缺少欄位: ${missing.join(", ")}`);
    if (extra.length) errors.push(`${pathStr} 多出欄位: ${extra.join(", ")}`);
    for (const key of [...expected].filter((k) => actual.has(k))) {
      errors.push(...validateAnalysisShape(data[key], template[key], `${pathStr}.${key}`));
    }
    return errors;
  }
  if (Array.isArray(template)) return Array.isArray(data) ? [] : [`${pathStr} 必須是 array。`];
  if (typeof template === "string") {
    return typeof data === "string" ? [] : [`${pathStr} 必須是 string。`];
  }
  return errors;
}

export function validateIngredientItems(data: unknown): string[] {
  const errors: string[] = [];
  for (const fieldName of ["有效成分及含量", "其他成分"]) {
    const items = isPlainObject(data) ? data[fieldName] : [];
    if (!Array.isArray(items)) continue;
    items.forEach((item, idx) => {
      const pathStr = `$.${fieldName}[${idx}]`;
      if (!isPlainObject(item)) {
        errors.push(`${pathStr} 必須是 object。`);
        return;
      }
      const expected = ["成分", "含量"];
      const keys = Object.keys(item);
      for (const key of expected.filter((k) => !keys.includes(k)).sort()) {
        errors.push(`${pathStr} 缺少欄位: ${key}`);
      }
      for (const key of keys.filter((k) => !expected.includes(k)).sort()) {
        errors.push(`${pathStr} 多出欄位: ${key}`);
      }
      for (const key of expected.filter((k) => keys.includes(k))) {
        if (typeof item[key] !== "string") errors.push(`${pathStr}.${key} 必須是 string。`);
      }
    });
  }
  return errors;
}

function parseIngredientText(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return { 成分: "", 含量: "" };
  const match = INGREDIENT_AMOUNT_RE.exec(trimmed);
  if (match) {
    return {
      成分: match[1].replace(/^[\s,，:：;；]+|[\s,，:：;；]+$/g, ""),
      含量: match[2].replace(/ /g, "").trim(),
    };
  }
  return { 成分: trimmed, 含量: "" };
}

/** Python's `value in (None, "")` — null/undefined or the empty string. */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function normalizeIngredientList(value: unknown): Record<string, string>[] {
  if (isBlank(value)) return [];
  const items = Array.isArray(value) ? value : [value];
  const result: Record<string, string>[] = [];
  for (const raw of items) {
    if (isBlank(raw)) continue;
    if (typeof raw === "string") {
      result.push(parseIngredientText(convertTextToTraditional(raw)));
    } else if (isPlainObject(raw)) {
      const item = convertJsonToTraditional(raw) as Record<string, unknown>;
      let name = item["成分"] || item["名稱"] || item.name || "";
      let amount = item["含量"] || item["劑量"] || item.amount || "";
      const entries = Object.entries(item);
      if (!name && entries.length === 1) {
        const [onlyKey, onlyVal] = entries[0];
        name = String(onlyKey);
        amount = onlyVal === null || onlyVal === undefined ? "" : String(onlyVal);
      }
      result.push({ 成分: String(name), 含量: String(amount) });
    } else {
      result.push({ 成分: String(raw), 含量: "" });
    }
  }
  return result;
}

function normalizeArray(value: unknown): unknown[] {
  if (isBlank(value)) return [];
  if (Array.isArray(value)) {
    return value.filter((item) => !isBlank(item)).map(convertJsonToTraditional);
  }
  return [convertJsonToTraditional(value)];
}

function normalizeString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isBlank(item))
      .map((item) => String(item))
      .join("；");
  }
  if (isPlainObject(value)) return JSON.stringify(convertJsonToTraditional(value));
  return convertTextToTraditional(String(value));
}

function firstMappingValue(mapping: unknown, ...keys: string[]): unknown {
  if (!isPlainObject(mapping)) return [];
  for (const key of keys) if (key in mapping) return mapping[key];
  return [];
}

export function normalizeAnalysisData(input: unknown): Record<string, unknown> {
  const converted = convertJsonToTraditional(input);
  const data: Record<string, unknown> = isPlainObject(converted) ? converted : {};

  let usage = data["使用上注意事項"] ?? {};
  if (!isPlainObject(usage)) usage = { 其他使用上注意事項: usage };

  let warnings = data["警語"] ?? {};
  if (!isPlainObject(warnings)) {
    warnings = {
      "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生": warnings,
    };
  }

  return {
    藥品特性: normalizeString(data["藥品特性"] ?? ""),
    有效成分及含量: normalizeIngredientList(data["有效成分及含量"] ?? []),
    其他成分: normalizeIngredientList(data["其他成分"] ?? data["其他成分(賦形劑)"] ?? []),
    "用途(適應症)": normalizeArray(data["用途(適應症)"] ?? data["用途(适应症)"] ?? []),
    使用上注意事項: {
      "有下列情形者，請勿使用": normalizeArray(
        firstMappingValue(usage, "有下列情形者，請勿使用", "有下列情形者，请勿使用"),
      ),
      "有下列情形者，使用前請洽醫師診治": normalizeArray(
        firstMappingValue(
          usage,
          "有下列情形者，使用前請洽醫師診治",
          "有下列情形者，使用前请洽医师诊治",
        ),
      ),
      "有下列情形者，使用前請先諮詢醫師藥師藥劑生": normalizeArray(
        firstMappingValue(
          usage,
          "有下列情形者，使用前請先諮詢醫師藥師藥劑生",
          "有下列情形者，使用前请先咨询医师药师药剂生",
        ),
      ),
      其他使用上注意事項: normalizeArray(
        firstMappingValue(usage, "其他使用上注意事項", "其他使用上注意事项"),
      ),
    },
    用法用量: normalizeArray(data["用法用量"] ?? []),
    警語: {
      "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生":
        normalizeArray(
          firstMappingValue(
            warnings,
            "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生",
            "使用本药后，若有发生以下副作用，请立即停止使用，并持此说明书咨询医师药师药剂生",
          ),
        ),
      "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治": normalizeArray(
        firstMappingValue(
          warnings,
          "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治",
          "使用本药后，若有发生以下症状时，请立即停止使用，并接受医师诊治",
        ),
      ),
    },
    儲存方式: normalizeArray(data["儲存方式"] ?? []),
  };
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface DrugAnalysisConfig {
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
}): DrugAnalysisConfig {
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
 * The one way to build a drug OCR/analysis config. OCR settings come from
 * `admin.app_settings` (group `ocr`), the Analysis LM endpoints from
 * `admin.llm_profiles`, already ordered by the configured strategy. Neither is
 * seeded from the environment, so "nothing there" means the operator has not set
 * it up — which `getGroup` alone cannot say, since it answers with schema defaults
 * so the admin form has something to prefill.
 */
export async function loadDrugAnalysisConfig(): Promise<DrugAnalysisConfig> {
  const analysis = await adminSettings.getGroup("analysis");
  const strategy = str(analysis.strategy, "failover") as Strategy;
  return configFromValues({
    ocr: await adminSettings.getGroup("ocr"),
    analysis,
    analysisProfiles: await candidateOrder("analysis", strategy),
    ocrConfigured: await adminSettings.isGroupConfigured("ocr"),
  });
}

export interface DrugAnalysisResult {
  markdown: string;
  analysisJson: Record<string, unknown>;
  ocrProvider: string;
  analysisProvider: string;
}

const NOT_CONFIGURED = (what: string, group: string): string =>
  `${what} is not configured yet — set it up in the admin console (Settings → ${group}).`;

export class DrugAnalysisService {
  /** The profile that served the last call — failover may make it not the primary. */
  lastProfileUsed: LlmProfile | null = null;

  constructor(readonly config: DrugAnalysisConfig) {}

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

  /**
   * OCR only — no analysis. Useful for testing OCR independently.
   * Returns markdown even if Analysis LM is not configured.
   */
  async ocrOnly(opts: {
    sourceFilename: string;
    pdfBytes: Buffer;
    /** Embed MinerU result images as data URIs, replacing `![](images/…)` refs. */
    embedImages?: boolean;
  }): Promise<string> {
    const [ready, reason] = this.ocrReadiness();
    if (!ready) throw new Error(reason);
    // OCR is not sensitive to analysis configuration — always available.
    return this.ocrPdfBytes(opts.pdfBytes, opts.sourceFilename, {
      embedImages: opts.embedImages,
    });
  }

  /**
   * Analyze markdown with the configured Analysis LM.
   * Can be used to analyze OCR output after the fact.
   */
  async analyzeMarkdown(markdown: string): Promise<Record<string, unknown>> {
    const [ready, reason] = this.analysisReadiness();
    if (!ready) throw new Error(reason);
    return this.runAnalysis(markdown);
  }

  async analyzePdfBytes(opts: {
    licenseId: string;
    sourceFilename: string;
    pdfBytes: Buffer;
    existingMarkdown?: string | null;
  }): Promise<DrugAnalysisResult> {
    const [ready, reason] = opts.existingMarkdown ? this.analysisReadiness() : this.readiness();
    if (!ready) throw new Error(reason);

    const markdown =
      opts.existingMarkdown || (await this.ocrPdfBytes(opts.pdfBytes, opts.sourceFilename));
    const analysisJson = await this.runAnalysis(markdown);
    const used = this.lastProfileUsed;
    return {
      markdown,
      analysisJson,
      ocrProvider: this.config.ocrProvider,
      // The profile that actually answered, which failover may have made a
      // different one from the primary.
      analysisProvider: used ? used.provider : (this.config.analysisProfiles[0]?.provider ?? ""),
    };
  }

  /**
   * Turn one insert PDF into Markdown via MinerU's synchronous endpoint.
   *
   * `/file_parse` parses the upload and answers with the Markdown inline, so there
   * is no task to poll and no archive to unpack. Markdown only: the Analysis LM
   * cannot use the images or the layout JSON anyway.
   */
  private async ocrPdfBytes(
    pdfBytes: Buffer,
    sourceFilename: string,
    opts: { embedImages?: boolean } = {},
  ): Promise<string> {
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
    form.append("return_images", opts.embedImages ? "true" : "false");
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

    const results = (payload.results ?? {}) as Record<
      string,
      { md_content?: string; images?: Record<string, string> }
    >;
    const first = Object.values(results)[0];
    if (!first) {
      throw new Error(
        `OCR returned no results: ${String(payload.error ?? JSON.stringify(payload))}`,
      );
    }
    // `results` is keyed by the uploaded file's stem, and we upload exactly one.
    let markdown = String(first.md_content ?? "");
    if (opts.embedImages && first.images) {
      markdown = markdown.replace(/!\[([^\]]*)\]\(images\/([^)]+)\)/g, (match, alt, name) => {
        const uri = first.images?.[name];
        return uri ? `![${alt}](${uri})` : match;
      });
    }
    if (!markdown.trim()) throw new Error("OCR markdown is empty");
    return markdown;
  }

  private async runAnalysis(ocrMarkdown: string): Promise<Record<string, unknown>> {
    const [sanitized, removedImages, removedChars] = stripEmbeddedBase64Images(ocrMarkdown);
    if (removedImages) {
      logInfo("Removed embedded base64 images from OCR markdown", {
        removed_images: removedImages,
        removed_chars: removedChars,
      });
    }
    const prompt = fs.readFileSync(this.config.analysisPromptPath, "utf8");
    const templateJson = JSON.stringify(ANALYSIS_TEMPLATE, null, 2);
    const messages: Message[] = [
      { role: "system", content: prompt },
      {
        role: "user",
        content:
          "以下是 OCR 轉出的藥品說明書 Markdown 內容。" +
          "請只根據這份內容抽取資訊，並輸出和指定模板完全一致的 JSON。\n\n" +
          `指定 JSON 模板：\n${templateJson}\n\n` +
          `OCR Markdown：\n${sanitized}`,
      },
    ];

    // NB: a TokenBudgetExceeded from here is deliberately NOT caught. This loop
    // re-prompts a model that produced *malformed* output, which is the wrong
    // medicine for a truncated one — appending the cut-off reply and asking again
    // only lengthens the conversation and makes the next reply likelier to be cut
    // off too. Budget is handled inside callAnalysisLlm, where it can be fixed.
    let lastError = "";
    for (let attempt = 1; attempt <= this.config.analysisMaxRetries; attempt += 1) {
      const { content, profileUsed } = await callAnalysisLlm(this.config.analysisProfiles, messages);
      this.lastProfileUsed = profileUsed;
      try {
        const parsed = normalizeAnalysisData(extractJsonObject(content));
        const errors = [...validateAnalysisShape(parsed), ...validateIngredientItems(parsed)];
        if (errors.length === 0) return parsed;
        lastError = errors.join("; ");
      } catch (err) {
        lastError = String(err instanceof Error ? err.message : err);
      }

      logWarning("Analysis output failed validation", {
        attempt,
        max_retries: this.config.analysisMaxRetries,
        error: lastError,
      });
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          "上一次輸出不合格。請重新輸出單一合法 JSON object。" +
          "不要輸出說明、不要輸出 Markdown code fence、不要加入模板外欄位。" +
          `錯誤原因: ${lastError}`,
      });
    }
    throw new Error(
      `Analysis LLM failed after ${this.config.analysisMaxRetries} attempts: ${lastError}`,
    );
  }

}

export function extractJsonObject(content: string): unknown {
  let text = content.trim();
  if (text.startsWith("```")) {
    let lines = text.split(/\r?\n/);
    if (lines.length && lines[0].startsWith("```")) lines = lines.slice(1);
    if (lines.length && lines[lines.length - 1].startsWith("```")) lines = lines.slice(0, -1);
    text = lines.join("\n").trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the brace scan
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model reply.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

export function stripEmbeddedBase64Images(markdown: string): [string, number, number] {
  if (!markdown) return [markdown, 0, 0];
  const originalLen = markdown.length;
  let count = 0;
  let text = markdown;
  for (const pattern of [DATA_IMG_MD_RE, DATA_IMG_HTML_RE, DATA_IMG_URI_RE]) {
    text = text.replace(pattern, () => {
      count += 1;
      return "";
    });
  }
  return [text, count, originalLen - text.length];
}
