/**
 * OCR server reachability probe for the admin overview `infrastructure.ocr` block.
 *
 * The OCR backend is MinerU or Indra OCR (ocrProviders.ts): standalone HTTP
 * services the drug pipeline uploads insert PDFs to. Reachability of `/health`
 * is the whole story. With a fallback provider configured, both are probed and
 * folded like the services page does (`foldOcrProbes`): one side down is
 * `degraded`, only both down is `error`.
 */

import * as adminSettings from "./adminSettings.js";
import { baseUrlOf, foldOcrProbes, ocrSettingsFromValues, providerReadiness, type OcrProviderId } from "../ocrProviders.js";

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

/** Probe the configured OCR provider(s) → `{status, detail}` for the overview. */
export async function probeOcr(): Promise<{ status: string; detail: string }> {
  try {
    // Not seeded from env — no rows means the operator has not set it up, and
    // probing the schema defaults would report a server nobody chose as broken.
    if (!(await adminSettings.isGroupConfigured("ocr"))) {
      return { status: "degraded", detail: "OCR server is not configured yet — set it up in Admin → Settings." };
    }
    const s = ocrSettingsFromValues(await adminSettings.getGroup("ocr"));

    // Mirror the `ocr_readiness` hard-config failures.
    const [ready, reason] = providerReadiness(s, s.provider);
    if (!ready) {
      return {
        status: "error",
        detail: reason.startsWith("Unsupported")
          ? reason
          : "OCR base URL is not configured yet — set it up in the admin console (Settings → OCR Server).",
      };
    }
    const primary = await probeHttpCandidates([`${baseUrlOf(s, s.provider as OcrProviderId)}/health`]);
    const fb = s.fallbackProvider;
    const fallback = fb && providerReadiness(s, fb)[0] ? await probeHttpCandidates([`${baseUrlOf(s, fb)}/health`]) : null;
    const folded = foldOcrProbes(s, primary, fallback);
    return { status: folded.status, detail: folded.message };
  } catch (exc) {
    return { status: "error", detail: String((exc as Error).message) };
  }
}
