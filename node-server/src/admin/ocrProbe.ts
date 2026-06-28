/**
 * OCR server reachability probe for the admin overview `infrastructure.ocr` block.
 *
 * Faithful port of the OUTCOME of `admin_services._probe_ocr_server` +
 * `_probe_http_candidates` for the `ready=True` path: read the "ocr" settings
 * group, build the vLLM endpoint, GET `/health` then `/v1/models`, and report
 * "OCR server reachable for model {model}." on a 2xx.
 *
 * Deliberate divergence: Python's `ocr_readiness()` also checks whether the
 * `dots_ocr` runtime is importable *in the app image* and downgrades to
 * "degraded … not installed in the app image". The Node backend never hosts the
 * dots_ocr VLM (the OCR pipeline stays in the Python worker — see the drug
 * pipeline decision), so that app-image-local check is not modeled here; the
 * probe reports reachability of the configured external server, which matches
 * the live deployment where the app image has dots_ocr installed.
 */

import * as adminSettings from "./adminSettings.js";

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
      lastMessage = String((exc as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, message: lastMessage };
}

/** Probe the configured OCR server → `{status, detail}` for the overview. */
export async function probeOcr(): Promise<{ status: string; detail: string }> {
  try {
    const ocr = await adminSettings.getGroup("ocr");
    const provider = String((ocr.provider ?? "dots_ocr") || "dots_ocr").trim().toLowerCase();
    const serverIp = String((ocr.server_ip ?? "127.0.0.1") || "127.0.0.1").trim();
    const port = Number(ocr.port || 8002) || 8002;
    const model = String((ocr.model ?? "") || "").trim();

    // Mirror `ocr_readiness` hard-config failure for a non-dots_ocr provider.
    if (provider !== "dots_ocr") {
      return { status: "error", detail: "Unsupported DRUG_OCR_PROVIDER" };
    }

    const endpoint = `http://${serverIp}:${port}`;
    const { ok, message } = await probeHttpCandidates([`${endpoint}/health`, `${endpoint}/v1/models`]);
    return ok
      ? { status: "ok", detail: `OCR server reachable for model ${model}.` }
      : { status: "error", detail: `OCR server probe failed: ${message}` };
  } catch (exc) {
    return { status: "error", detail: String((exc as Error).message) };
  }
}
