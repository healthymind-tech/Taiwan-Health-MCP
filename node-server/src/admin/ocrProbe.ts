/**
 * OCR server reachability probe for the admin overview `infrastructure.ocr` block.
 *
 * The OCR backend is MinerU: a standalone HTTP service the drug pipeline uploads
 * insert PDFs to. Reachability is the whole story — unlike the dots_ocr VLM it
 * replaced, there is no in-process runtime that could be absent from an image, so
 * this probe now says the same thing as its Python twin
 * (`admin_services._probe_ocr_server`) rather than deliberately diverging from it.
 */

import * as adminSettings from "./adminSettings.js";

/**
 * Map Node's generic `fetch` failure message to the httpx-equivalent string the
 * Python probe surfaces, so `infrastructure.ocr.detail` matches byte-for-byte.
 * undici raises TypeError "fetch failed" for a refused/unreachable host; httpx's
 * ConnectError stringifies to "All connection attempts failed".
 */
function httpxLikeMessage(message: string): string {
  return message === "fetch failed" ? "All connection attempts failed" : message;
}

/** GET each candidate; return true on the first 2xx (mirrors `_probe_http_candidates`). */
async function probeHttpCandidates(candidates: string[]): Promise<{ ok: boolean; message: string }> {
  let lastMessage = "No probe URL candidates configured.";
  for (const candidate of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const resp = await fetch(candidate, { redirect: "follow", signal: ctrl.signal });
      if (resp.status >= 200 && resp.status < 300) return { ok: true, message: `HTTP ${resp.status}` };
      lastMessage = `HTTP ${resp.status}`;
    } catch (exc) {
      lastMessage = httpxLikeMessage(String((exc as Error).message));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, message: lastMessage };
}

/** Probe the configured MinerU server → `{status, detail}` for the overview. */
export async function probeOcr(): Promise<{ status: string; detail: string }> {
  try {
    // Not seeded from env — no rows means the operator has not set it up, and
    // probing the schema defaults would report a server nobody chose as broken.
    if (!(await adminSettings.isGroupConfigured("ocr"))) {
      return { status: "degraded", detail: "OCR server is not configured yet — set it up in Admin → Settings." };
    }
    const ocr = await adminSettings.getGroup("ocr");
    const provider = String((ocr.provider ?? "mineru") || "mineru").trim().toLowerCase();
    const baseUrl = String((ocr.base_url ?? "") || "").trim().replace(/\/+$/, "");
    const backend = String((ocr.backend ?? "hybrid-engine") || "hybrid-engine").trim();

    // Mirror the `ocr_readiness` hard-config failures.
    if (provider !== "mineru") {
      return { status: "error", detail: `Unsupported OCR provider: ${provider}` };
    }
    if (!baseUrl) {
      return {
        status: "error",
        detail: "OCR base URL is not configured yet — set it up in the admin console (Settings → OCR Server).",
      };
    }

    const { ok, message } = await probeHttpCandidates([`${baseUrl}/health`]);
    return ok
      ? { status: "ok", detail: `OCR server reachable (${backend}).` }
      : { status: "error", detail: `OCR server probe failed: ${message}` };
  } catch (exc) {
    return { status: "error", detail: String((exc as Error).message) };
  }
}
