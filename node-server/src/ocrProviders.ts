/**
 * OCR providers for drug insert PDFs: MinerU and Indra OCR.
 *
 * Both turn one document into Markdown — the only thing the Analysis LM stage
 * needs — so the drug pipeline is provider-agnostic past this module:
 *
 *   mineru  POST {base_url}/file_parse        (MinerU's synchronous API; GPU-backed, external)
 *   indra   POST {indra_base_url}/ocr         (services/ocr-indra: Indra OCR on CPU, in compose)
 *
 * Settings live in `admin.app_settings` group `ocr` (adminSettings.ts). A primary
 * provider is always set (default `mineru`, which keeps the pre-Indra behaviour);
 * an optional `fallback_provider` is tried once when the primary fails for a
 * reason a second engine could fix (unreachable, HTTP error, timeout, empty
 * output) — not when the input itself is unusable.
 *
 * Every network call takes an injectable `fetch` so the adapters are unit-tested
 * against fakes (ocrProviders.test.ts). Document text is never logged.
 */

import { logWarning } from "./logger.js";

export const OCR_PROVIDERS = ["mineru", "indra"] as const;
export type OcrProviderId = (typeof OCR_PROVIDERS)[number];
export const OCR_FALLBACK_OPTIONS = ["none", ...OCR_PROVIDERS] as const;
export const INDRA_MODES = ["auto", "ocr", "text"] as const;
export const INDRA_DEFAULT_BASE_URL = "http://ocr-indra:8000";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MineruSettings {
  baseUrl: string;
  backend: string;
  effort: string;
  parseMethod: string;
  lang: string;
  timeoutSeconds: number;
}

export interface IndraSettings {
  baseUrl: string;
  timeoutSeconds: number;
  dpi: number;
  mode: string;
}

export interface OcrSettings {
  /** Raw (lower-cased) provider value; may be unsupported — see `providerReadiness`. */
  provider: string;
  fallbackProvider: OcrProviderId | null;
  mineru: MineruSettings;
  indra: IndraSettings;
}

export interface OcrRequest {
  bytes: Buffer;
  filename: string;
  /** Defaults to application/pdf. */
  mimeType?: string;
  /** MinerU only: inline result images as data URIs (OCR test preview). */
  embedImages?: boolean;
}

export interface OcrOutput {
  markdown: string;
  provider: OcrProviderId;
  /** Provider-specific numbers for logs / the admin test (never document text). */
  details: Record<string, unknown>;
}

function text(value: unknown, fallback: string): string {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** An exception as text; Node's bare `fetch failed` is expanded with its cause (ECONNREFUSED, ENOTFOUND …). */
export function errText(exc: unknown): string {
  const e = exc as { message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const message = String(e?.message ?? exc);
  const cause = e?.cause;
  if (message === "fetch failed" && cause) {
    return `fetch failed: ${[cause.code, cause.message].filter(Boolean).map(String).join(" ")}`.trim();
  }
  return message;
}

const stripSlash = (url: string): string => url.trim().replace(/\/+$/, "");

export function isOcrProvider(value: string): value is OcrProviderId {
  return (OCR_PROVIDERS as readonly string[]).includes(value);
}

/** Typed OCR settings from the `ocr` settings group values (getGroup output or a form draft). */
export function ocrSettingsFromValues(values: Record<string, unknown>): OcrSettings {
  const provider = text(values.provider, "mineru").toLowerCase();
  const fb = text(values.fallback_provider, "none").toLowerCase();
  return {
    provider,
    // A fallback equal to the primary would just retry the same engine.
    fallbackProvider: isOcrProvider(fb) && fb !== provider ? fb : null,
    mineru: {
      baseUrl: stripSlash(String(values.base_url ?? "")),
      backend: text(values.backend, "hybrid-engine"),
      effort: text(values.effort, "medium"),
      parseMethod: text(values.parse_method, "auto"),
      lang: text(values.lang, "ch"),
      timeoutSeconds: num(values.timeout_seconds, 600),
    },
    indra: {
      baseUrl: stripSlash(String(values.indra_base_url ?? INDRA_DEFAULT_BASE_URL)),
      timeoutSeconds: num(values.indra_timeout_seconds, 300),
      dpi: num(values.indra_dpi, 200),
      mode: text(values.indra_mode, "auto"),
    },
  };
}

export function baseUrlOf(s: OcrSettings, provider: OcrProviderId): string {
  return provider === "indra" ? s.indra.baseUrl : s.mineru.baseUrl;
}

/** Hard-config check for one provider: [ready, reason]. Reasons are matched by adminErrorCodes.ts. */
export function providerReadiness(s: OcrSettings, provider: string): [boolean, string] {
  if (!isOcrProvider(provider)) return [false, `Unsupported OCR provider: ${provider}`];
  if (!baseUrlOf(s, provider)) {
    return [
      false,
      provider === "indra"
        ? "OCR base URL is not configured yet — set the Indra base URL in the admin console (Settings → OCR Server)."
        : "OCR base URL is not configured yet — set it up in the admin console (Settings → OCR Server).",
    ];
  }
  return [true, ""];
}

/** Thrown for inputs no OCR engine can read — never worth a fallback attempt. */
export class OcrInputError extends Error {}

/**
 * MinerU's synchronous `/file_parse`: the Markdown comes back inline, so there is
 * no task to poll and no archive to unpack.
 */
export async function mineruOcr(cfg: MineruSettings, req: OcrRequest, fetchImpl: FetchLike = fetch): Promise<OcrOutput> {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(req.bytes)], { type: req.mimeType ?? "application/pdf" }), req.filename);
  form.append("backend", cfg.backend);
  form.append("effort", cfg.effort);
  form.append("parse_method", cfg.parseMethod);
  form.append("lang_list", cfg.lang);
  form.append("table_enable", "true");
  form.append("return_md", "true");
  form.append("return_images", req.embedImages ? "true" : "false");
  form.append("return_middle_json", "false");
  form.append("return_content_list", "false");
  form.append("response_format_zip", "false");

  const url = `${cfg.baseUrl}/file_parse`;
  const started = Date.now();
  const response = await fetchImpl(url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(cfg.timeoutSeconds * 1000),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const results = (payload.results ?? {}) as Record<string, { md_content?: string; images?: Record<string, string> }>;
  // `results` is keyed by the uploaded file's stem, and we upload exactly one.
  const first = Object.values(results)[0];
  if (!first) throw new Error(`OCR returned no results: ${String(payload.error ?? JSON.stringify(payload).slice(0, 300))}`);
  let markdown = String(first.md_content ?? "");
  if (req.embedImages && first.images) {
    markdown = markdown.replace(/!\[([^\]]*)\]\(images\/([^)]+)\)/g, (match, alt, name) => {
      const uri = first.images?.[name];
      return uri ? `![${alt}](${uri})` : match;
    });
  }
  if (!markdown.trim()) throw new Error("OCR markdown is empty");
  return { markdown, provider: "mineru", details: { backend: cfg.backend, ms: Date.now() - started } };
}

interface IndraPage {
  index?: number;
  source?: string;
  markdown?: string;
  text?: string;
}

interface IndraResponse {
  ok?: boolean;
  error?: { code?: string; message?: string };
  markdown?: string;
  pages?: IndraPage[];
  total_pages?: number;
  pages_processed?: number;
  page_errors?: number;
  truncated?: boolean;
  timed_out?: boolean;
  versions?: Record<string, string>;
  timings?: Record<string, number>;
}

/** Error codes from services/ocr-indra that say the input itself is unusable. */
const INDRA_INPUT_ERRORS = new Set(["UNSUPPORTED_FILE", "PDF_ENCRYPTED", "PDF_UNREADABLE", "FILE_EMPTY", "UPLOAD_TOO_LARGE"]);

/**
 * Indra's per-page result → one Markdown document, the shape MinerU returns: the
 * pages' markdown joined by blank lines, in page order. A page Indra could not
 * read (`source: "error"`) is skipped; a document where every page failed, or
 * that yielded no text at all, is an error so a fallback provider gets its turn.
 */
export function indraMarkdown(payload: IndraResponse): string {
  const pages = Array.isArray(payload.pages) ? [...payload.pages] : [];
  if (pages.length === 0) return String(payload.markdown ?? "");
  pages.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  return pages
    .filter((p) => p.source !== "error")
    .map((p) => String(p.markdown ?? p.text ?? "").trim())
    .filter((md) => md !== "")
    .join("\n\n");
}

export async function indraOcr(cfg: IndraSettings, req: OcrRequest, fetchImpl: FetchLike = fetch): Promise<OcrOutput> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(req.bytes)], { type: req.mimeType ?? "application/pdf" }), req.filename);
  form.append("format", "markdown");
  form.append("mode", cfg.mode);
  form.append("dpi", String(cfg.dpi));
  form.append("timeout_seconds", String(cfg.timeoutSeconds));

  const url = `${cfg.baseUrl}/ocr`;
  const started = Date.now();
  // The service stops between pages at timeout_seconds; leave room for the page in flight.
  const response = await fetchImpl(url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout((cfg.timeoutSeconds + 90) * 1000),
  });
  let payload: IndraResponse;
  try {
    payload = (await response.json()) as IndraResponse;
  } catch {
    throw new Error(`HTTP ${response.status} from ${url}: response is not JSON`);
  }
  if (!response.ok || payload.ok === false) {
    const code = payload.error?.code ?? "UNKNOWN";
    const message = String(payload.error?.message ?? "").slice(0, 300);
    const err = `Indra OCR error ${code} (HTTP ${response.status}) from ${url}: ${message}`;
    if (INDRA_INPUT_ERRORS.has(code)) throw new OcrInputError(err);
    throw new Error(err);
  }
  if (payload.timed_out) {
    throw new Error(
      `Indra OCR timed out after ${payload.pages_processed ?? 0} of ${payload.total_pages ?? "?"} page(s) ` +
        `(indra_timeout_seconds = ${cfg.timeoutSeconds})`,
    );
  }
  const markdown = indraMarkdown(payload);
  if (!markdown.trim()) throw new Error("OCR markdown is empty");
  if (payload.truncated) {
    logWarning("indra_ocr_truncated", { total_pages: payload.total_pages, pages_processed: payload.pages_processed });
  }
  return {
    markdown,
    provider: "indra",
    details: {
      ms: Date.now() - started,
      total_pages: payload.total_pages ?? null,
      pages_processed: payload.pages_processed ?? null,
      page_errors: payload.page_errors ?? 0,
      truncated: payload.truncated ?? false,
      page_sources: (payload.pages ?? []).map((p) => p.source ?? ""),
      indra_ocr: payload.versions?.indra_ocr ?? null,
    },
  };
}

export async function ocrWith(
  s: OcrSettings,
  provider: OcrProviderId,
  req: OcrRequest,
  fetchImpl: FetchLike = fetch,
): Promise<OcrOutput> {
  return provider === "indra" ? indraOcr(s.indra, req, fetchImpl) : mineruOcr(s.mineru, req, fetchImpl);
}

/**
 * OCR with the primary provider, then — once — the fallback provider when the
 * primary failed for a reason another engine could fix. When both fail, the
 * primary's error is thrown with the fallback's appended, so the job log and the
 * zh explanation (adminErrorCodes.ts matches the leading primary error) stay useful.
 */
export async function runOcr(
  s: OcrSettings,
  req: OcrRequest,
  opts: { fetchImpl?: FetchLike; onFallback?: (info: { from: OcrProviderId; to: OcrProviderId; error: string }) => void } = {},
): Promise<OcrOutput> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const [ready, reason] = providerReadiness(s, s.provider);
  if (!ready) throw new Error(reason);
  const primary = s.provider as OcrProviderId;
  try {
    return await ocrWith(s, primary, req, fetchImpl);
  } catch (exc) {
    const fb = s.fallbackProvider;
    if (!fb || exc instanceof OcrInputError || !providerReadiness(s, fb)[0]) throw exc;
    const error = errText(exc);
    logWarning("ocr_fallback", { from: primary, to: fb, error: error.slice(0, 300) });
    opts.onFallback?.({ from: primary, to: fb, error });
    try {
      return await ocrWith(s, fb, req, fetchImpl);
    } catch (fbExc) {
      throw new Error(`${error} (fallback ${fb} also failed: ${errText(fbExc).slice(0, 300)})`);
    }
  }
}

// ── health (admin test + service probes) ────────────────────────────────────

/** What the probe row calls a provider: MinerU by its backend (unchanged wording), Indra by name. */
export function ocrProbeLabel(s: OcrSettings, provider: OcrProviderId): string {
  return provider === "indra" ? "indra" : s.mineru.backend;
}

/**
 * Fold the primary and (optional) fallback OCR probes into one row. Only both
 * failing is `error` (which blocks drug_analysis jobs); one of the two failing
 * is `degraded`, so a dead fallback is visible without blocking work.
 */
export function foldOcrProbes(
  s: OcrSettings,
  primary: { ok: boolean; message: string },
  fallback: { ok: boolean; message: string } | null,
): { status: string; message: string } {
  const label = ocrProbeLabel(s, s.provider as OcrProviderId);
  const fb = s.fallbackProvider;
  if (primary.ok) {
    if (!fallback || fallback.ok || !fb) return { status: "ok", message: `OCR server reachable (${label}).` };
    return { status: "degraded", message: `OCR server reachable (${label}); fallback ${fb} probe failed: ${fallback.message}` };
  }
  if (fallback?.ok && fb) {
    return { status: "degraded", message: `OCR server probe failed: ${primary.message}; fallback ${fb} reachable.` };
  }
  return { status: "error", message: `OCR server probe failed: ${primary.message}` };
}


export interface OcrHealth {
  ok: boolean;
  /** Human-readable, English; adminErrorCodes.ts explains it in zh-TW. */
  message: string;
  version: string | null;
  details: Record<string, unknown>;
}

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const resp = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: resp.status, body };
}

/** `GET /health` of either provider (both answer `{status: "healthy", version, …}`). */
export async function ocrHealth(
  s: OcrSettings,
  provider: OcrProviderId,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 8000,
): Promise<OcrHealth> {
  const base = baseUrlOf(s, provider);
  const name = provider === "indra" ? "Indra OCR" : "MinerU";
  if (!base) return { ok: false, message: "Base URL is empty.", version: null, details: { provider } };
  try {
    const { status, body } = await getJson(fetchImpl, `${base}/health`, timeoutMs);
    const j = body ?? {};
    const reported = String(j.status ?? "");
    if (provider === "indra") {
      const versions = (j.versions ?? {}) as Record<string, unknown>;
      const version = versions.indra_ocr ? String(versions.indra_ocr) : null;
      const details = {
        provider,
        version,
        models: versions.models ?? null,
        workers: j.workers ?? null,
        threads_per_worker: j.threads_per_worker ?? null,
        processing_tasks: j.processing_tasks ?? null,
        queued_tasks: j.queued_tasks ?? null,
        ...(j.error ? { error: String(j.error) } : {}),
      };
      if (status === 200 && reported === "healthy") {
        return { ok: true, message: `Indra OCR ${version ?? "unknown"} reachable at ${base}.`, version, details };
      }
      if (reported) {
        return { ok: false, message: `OCR server at ${base} reports status '${reported}'.`, version, details };
      }
      return { ok: false, message: `HTTP ${status} from ${base}/health`, version, details };
    }
    if (status < 200 || status >= 300) return { ok: false, message: `HTTP ${status} from ${base}/health`, version: null, details: { provider } };
    const version = String(j.version ?? "unknown");
    const details = {
      provider,
      version,
      max_concurrent_requests: j.max_concurrent_requests ?? null,
      processing_tasks: j.processing_tasks ?? null,
      queued_tasks: j.queued_tasks ?? null,
    };
    if (reported && reported !== "healthy") {
      return { ok: false, message: `OCR server at ${base} reports status '${reported}'.`, version, details };
    }
    return { ok: true, message: `${name} ${version} reachable at ${base}.`, version, details };
  } catch (exc) {
    return { ok: false, message: `OCR test failed: ${errText(exc)}`, version: null, details: { provider } };
  }
}
