/**
 * OCR provider abstraction (MinerU / Indra + fallback), the drug service's use of
 * it, the settings connection test and the probe folding. No network: every
 * call goes through an injected fake `fetch`.
 */

process.env.DATABASE_URL ??= "postgresql://qa:qa@127.0.0.1:1/qa";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OcrInputError,
  foldOcrProbes,
  indraMarkdown,
  indraOcr,
  ocrHealth,
  ocrSettingsFromValues,
  providerReadiness,
  runOcr,
  type FetchLike,
} from "./ocrProviders.js";
import { configFromValues, DrugAnalysisService } from "./drugAnalysisService.js";
import { testOcr } from "./admin/adminSettings.js";
import { explainProbe, explainServiceTest, classifyMessage } from "./admin/adminErrorCodes.js";

const PDF = Buffer.from("%PDF-1.7\nfake\n");

interface Call {
  url: string;
  method: string;
  form: FormData | null;
}

type Handler = (call: Call) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call = { url: String(input), method: init?.method ?? "GET", form: (init?.body as FormData) ?? null };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const indraOk = (pages: { index: number; source: string; markdown: string }[]) =>
  json({ ok: true, total_pages: pages.length, pages_processed: pages.length, page_errors: 0, truncated: false, timed_out: false, pages, versions: { indra_ocr: "0.3.2" } });

const mineruOk = (md: string) => json({ results: { doc: { md_content: md } } });

const BOTH = { provider: "mineru", base_url: "http://mineru.test:8000", fallback_provider: "indra", indra_base_url: "http://ocr-indra:8000" };

test("settings: production-like values (only base_url stored) stay MinerU with no fallback", () => {
  const s = ocrSettingsFromValues({ provider: "mineru", base_url: "https://mineru.example/", fallback_provider: "none" });
  assert.equal(s.provider, "mineru");
  assert.equal(s.fallbackProvider, null);
  assert.equal(s.mineru.baseUrl, "https://mineru.example");
  assert.equal(s.indra.baseUrl, "http://ocr-indra:8000");
  assert.equal(s.indra.dpi, 200);
  assert.equal(s.indra.mode, "auto");
  // A fallback equal to the primary is no fallback.
  assert.equal(ocrSettingsFromValues({ provider: "indra", fallback_provider: "indra" }).fallbackProvider, null);
});

test("readiness: unsupported provider and missing URL are named", () => {
  const s = ocrSettingsFromValues({ provider: "tesseract" });
  assert.deepEqual(providerReadiness(s, "tesseract"), [false, "Unsupported OCR provider: tesseract"]);
  const noUrl = ocrSettingsFromValues({ provider: "indra", indra_base_url: "" });
  const [ok, reason] = providerReadiness(noUrl, "indra");
  assert.equal(ok, false);
  assert.match(reason, /^OCR base URL is not configured yet — set the Indra base URL/);
  assert.equal(classifyMessage(reason)?.code, "OCR_NOT_CONFIGURED");
});

test("indra: sends the configured options and joins pages in order, skipping failed pages", async () => {
  const { fetch, calls } = fakeFetch(() =>
    indraOk([
      { index: 1, source: "ocr", markdown: "page two" },
      { index: 0, source: "text", markdown: "## page one" },
      { index: 2, source: "error", markdown: "" },
    ]),
  );
  const s = ocrSettingsFromValues({ provider: "indra", indra_dpi: 300, indra_mode: "ocr", indra_timeout_seconds: 120 });
  const out = await indraOcr(s.indra, { bytes: PDF, filename: "x.pdf" }, fetch);
  assert.equal(out.provider, "indra");
  assert.equal(out.markdown, "## page one\n\npage two");
  assert.equal(calls[0].url, "http://ocr-indra:8000/ocr");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].form?.get("format"), "markdown");
  assert.equal(calls[0].form?.get("mode"), "ocr");
  assert.equal(calls[0].form?.get("dpi"), "300");
  assert.equal(calls[0].form?.get("timeout_seconds"), "120");
  assert.ok(calls[0].form?.get("file") instanceof Blob);
  assert.deepEqual(out.details.page_sources, ["ocr", "text", "error"]);
});

test("indra: error bodies become actionable errors; input errors are OcrInputError", async () => {
  const s = ocrSettingsFromValues({ provider: "indra" });
  const busy = fakeFetch(() => json({ ok: false, error: { code: "BUSY", message: "too many" } }, 429));
  await assert.rejects(indraOcr(s.indra, { bytes: PDF, filename: "x.pdf" }, busy.fetch), (e: Error) => {
    assert.ok(!(e instanceof OcrInputError));
    assert.match(e.message, /^Indra OCR error BUSY \(HTTP 429\)/);
    assert.equal(classifyMessage(e.message)?.code, "OCR_BUSY");
    return true;
  });
  const bad = fakeFetch(() => json({ ok: false, error: { code: "PDF_ENCRYPTED", message: "password-protected PDF" } }, 422));
  await assert.rejects(indraOcr(s.indra, { bytes: PDF, filename: "x.pdf" }, bad.fetch), OcrInputError);
  const timedOut = fakeFetch(() => json({ ok: true, timed_out: true, total_pages: 9, pages_processed: 3, pages: [] }));
  await assert.rejects(indraOcr(s.indra, { bytes: PDF, filename: "x.pdf" }, timedOut.fetch), (e: Error) => {
    assert.match(e.message, /^Indra OCR timed out after 3 of 9 page/);
    assert.equal(classifyMessage(e.message)?.code, "OCR_TIMEOUT");
    return true;
  });
  const empty = fakeFetch(() => indraOk([{ index: 0, source: "ocr", markdown: "  " }]));
  await assert.rejects(indraOcr(s.indra, { bytes: PDF, filename: "x.pdf" }, empty.fetch), /OCR markdown is empty/);
});

test("indraMarkdown falls back to the top-level markdown when pages are absent", () => {
  assert.equal(indraMarkdown({ markdown: "whole" }), "whole");
});

test("runOcr: MinerU failure falls back to Indra once and reports the provider that answered", async () => {
  const fallbacks: string[] = [];
  const { fetch, calls } = fakeFetch((c) => {
    if (c.url.endsWith("/file_parse")) return new Response("bad gateway", { status: 502 });
    return indraOk([{ index: 0, source: "ocr", markdown: "from indra" }]);
  });
  const out = await runOcr(ocrSettingsFromValues(BOTH), { bytes: PDF, filename: "x.pdf" }, {
    fetchImpl: fetch,
    onFallback: (i) => fallbacks.push(`${i.from}->${i.to}`),
  });
  assert.equal(out.provider, "indra");
  assert.equal(out.markdown, "from indra");
  assert.deepEqual(fallbacks, ["mineru->indra"]);
  assert.deepEqual(calls.map((c) => c.url), ["http://mineru.test:8000/file_parse", "http://ocr-indra:8000/ocr"]);
});

test("runOcr: no fallback for unreadable input, and both failing keeps the primary error first", async () => {
  const indraFirst = { provider: "indra", fallback_provider: "mineru", base_url: "http://mineru.test:8000" };
  const enc = fakeFetch(() => json({ ok: false, error: { code: "PDF_ENCRYPTED", message: "password-protected PDF" } }, 422));
  await assert.rejects(runOcr(ocrSettingsFromValues(indraFirst), { bytes: PDF, filename: "x.pdf" }, { fetchImpl: enc.fetch }), OcrInputError);
  assert.equal(enc.calls.length, 1);

  const down = fakeFetch((c) => (c.url.endsWith("/file_parse") ? new Response("oops", { status: 500 }) : json({ ok: false, error: { code: "NOT_READY", message: "loading" } }, 503)));
  await assert.rejects(runOcr(ocrSettingsFromValues(indraFirst), { bytes: PDF, filename: "x.pdf" }, { fetchImpl: down.fetch }), (e: Error) => {
    assert.match(e.message, /^Indra OCR error NOT_READY \(HTTP 503\).*\(fallback mineru also failed: HTTP 500 from http:\/\/mineru\.test:8000\/file_parse/);
    assert.equal(classifyMessage(e.message)?.code, "OCR_NOT_READY");
    return true;
  });
});

test("runOcr without a fallback rethrows the primary error unchanged (pre-Indra behaviour)", async () => {
  const { fetch, calls } = fakeFetch(() => new Response("gateway timeout", { status: 504 }));
  const s = ocrSettingsFromValues({ provider: "mineru", base_url: "https://mineru.example" });
  await assert.rejects(runOcr(s, { bytes: PDF, filename: "x.pdf" }, { fetchImpl: fetch }), (e: Error) => {
    assert.match(e.message, /^HTTP 504 from https:\/\/mineru\.example\/file_parse: gateway timeout$/);
    assert.equal(classifyMessage(e.message)?.code, "OCR_HTTP_ERROR");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("DrugAnalysisService: ocrOnly goes through the provider abstraction and records the provider used", async () => {
  const { fetch } = fakeFetch((c) =>
    c.url.endsWith("/file_parse") ? Promise.reject(new TypeError("fetch failed")) : indraOk([{ index: 0, source: "text", markdown: "insert" }]),
  );
  const svc = new DrugAnalysisService(configFromValues({ ocr: BOTH, analysis: {}, ocrConfigured: true }), fetch);
  assert.deepEqual(svc.ocrReadiness(), [true, ""]);
  assert.equal(await svc.ocrOnly({ sourceFilename: "x.pdf", pdfBytes: PDF }), "insert");
  assert.equal(svc.lastOcrProvider, "indra");
  // The pipeline still refuses non-PDF bytes; the OCR test accepts images.
  await assert.rejects(
    (svc as unknown as { ocrPdfBytes: (b: Buffer, n: string) => Promise<string> }).ocrPdfBytes(Buffer.from("<html>"), "x.pdf"),
    /x\.pdf is not a PDF/,
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(await svc.ocrOnly({ sourceFilename: "x.png", pdfBytes: png }), "insert");
});

test("DrugAnalysisService: MinerU stays the default provider and an unknown provider fails readiness", () => {
  const def = new DrugAnalysisService(configFromValues({ ocr: { base_url: "http://m:8000" }, analysis: {}, ocrConfigured: true }));
  assert.equal(def.config.ocrProvider, "mineru");
  assert.deepEqual(def.ocrReadiness(), [true, ""]);
  const bad = new DrugAnalysisService(configFromValues({ ocr: { provider: "paddle" }, analysis: {}, ocrConfigured: true }));
  assert.deepEqual(bad.ocrReadiness(), [false, "Unsupported OCR provider: paddle"]);
});

test("health: Indra 503 while loading is not ok; MinerU healthy is", async () => {
  const s = ocrSettingsFromValues(BOTH);
  const loading = fakeFetch(() => json({ status: "loading", versions: { indra_ocr: "0.3.2" } }, 503));
  const h = await ocrHealth(s, "indra", loading.fetch);
  assert.equal(h.ok, false);
  assert.match(h.message, /reports status 'loading'/);
  const mineru = fakeFetch(() => json({ status: "healthy", version: "2.5.0", queued_tasks: 0 }));
  const m = await ocrHealth(s, "mineru", mineru.fetch);
  assert.equal(m.ok, true);
  assert.equal(m.message, "MinerU 2.5.0 reachable at http://mineru.test:8000.");
});

test("testOcr (Indra): health + sample OCR, fallback reported in details, zh explanation", async () => {
  const { fetch, calls } = fakeFetch((c) => {
    if (c.url === "http://ocr-indra:8000/health") return json({ status: "healthy", versions: { indra_ocr: "0.3.2" }, workers: 1 });
    if (c.url === "http://ocr-indra:8000/ocr") return indraOk([{ index: 0, source: "ocr", markdown: "x".repeat(42) }]);
    return Promise.reject(new TypeError("fetch failed"));
  });
  const r = await testOcr({ provider: "indra", fallback_provider: "mineru", base_url: "http://mineru.test:8000" }, fetch, async () => PDF);
  assert.equal(r.ok, true);
  assert.match(r.message, /^Indra OCR 0\.3\.2 reachable at http:\/\/ocr-indra:8000; sample OCR: 42 chars in \d+ ms\.$/);
  assert.equal(r.details?.fallback_provider, "mineru");
  assert.equal(r.details?.fallback_ok, false);
  assert.ok(calls.some((c) => c.url === "http://ocr-indra:8000/ocr"));
  const zh = explainServiceTest("ocr", r);
  assert.match(zh.message_zh ?? "", /^已連線到 Indra OCR 0\.3\.2（http:\/\/ocr-indra:8000）。範例 PDF 辨識出 42 個字元/);
  assert.match(zh.message_zh ?? "", /備援 mineru 目前無法連線/);

  const down = fakeFetch(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 172.18.0.9:8000" } })));
  const f = await testOcr({ provider: "indra" }, down.fetch, async () => PDF);
  assert.equal(f.ok, false);
  const fz = explainServiceTest("ocr", f);
  assert.match(fz.message_zh ?? "", /^OCR（Indra）連線測試失敗/);
  assert.match(fz.hint_zh ?? "", /ocr-indra/);
});

test("testOcr (MinerU) keeps the existing health-only check", async () => {
  const { fetch, calls } = fakeFetch(() => json({ status: "healthy", version: "2.5.0" }));
  const r = await testOcr({ provider: "mineru", base_url: "http://mineru.test:8000" }, fetch, async () => PDF);
  assert.equal(r.ok, true);
  assert.equal(r.message, "MinerU 2.5.0 reachable at http://mineru.test:8000.");
  assert.equal(calls.length, 1);
});

test("probe folding: only both down is an error; one side down is degraded and explained", () => {
  const s = ocrSettingsFromValues(BOTH);
  const up = { ok: true, message: "HTTP 200" };
  const down = { ok: false, message: "fetch failed" };
  assert.deepEqual(foldOcrProbes(ocrSettingsFromValues({ provider: "mineru" }), up, null), { status: "ok", message: "OCR server reachable (hybrid-engine)." });
  assert.equal(foldOcrProbes(s, up, up).status, "ok");
  const a = foldOcrProbes(s, up, down);
  assert.equal(a.status, "degraded");
  const b = foldOcrProbes(s, down, up);
  assert.equal(b.status, "degraded");
  assert.equal(foldOcrProbes(s, down, down).status, "error");
  assert.equal(foldOcrProbes(ocrSettingsFromValues({ provider: "indra" }), up, null).message, "OCR server reachable (indra).");
  assert.match(explainProbe({ service_key: "ocr_server", status: a.status, message: a.message }).message_zh ?? "", /備援 indra 無法連線/);
  assert.match(explainProbe({ service_key: "ocr_server", status: b.status, message: b.message }).message_zh ?? "", /改用備援 indra/);
});
