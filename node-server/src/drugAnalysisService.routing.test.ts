/**
 * The drug analysis service re-resolves the Analysis LM candidate order for
 * every document, so a route's round robin / load balance and the circuit
 * breaker's cool-down ordering keep working through a long job. No DB, no
 * network: the profile source is injected and globalThis.fetch is stubbed.
 */

process.env.DATABASE_URL ??= "postgresql://qa:qa@127.0.0.1:1/qa";

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configFromValues, DrugAnalysisService } from "./drugAnalysisService.js";
import { setProfileStatsEnabled } from "./admin/llmProfileStats.js";
import { resetBreakers, type LlmProfile } from "./admin/llmProfiles.js";
import { AnalysisLlmUnavailable } from "./analysisLlmClient.js";

setProfileStatsEnabled(false);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetBreakers();
});

function leaf(id: number): LlmProfile {
  return {
    id,
    kind: "analysis",
    name: `leaf${id}`,
    provider: "vllm",
    base_url: `http://leaf${id}.test/v1`,
    api_key: "",
    model: "qwen3-32b",
    enabled: true,
    priority: id,
    weight: 1,
    params: {},
  };
}

function service(source: () => Promise<LlmProfile[]>, snapshot: LlmProfile[] = [leaf(1), leaf(2)]): DrugAnalysisService {
  return new DrugAnalysisService(
    configFromValues({ ocr: {}, analysis: { max_retries: 1 }, analysisProfiles: snapshot, analysisProfileSource: source, ocrConfigured: false }),
  );
}

test("profilesForDocument re-resolves on every call", async () => {
  let calls = 0;
  const svc = service(async () => {
    calls += 1;
    return calls % 2 ? [leaf(1), leaf(2)] : [leaf(2), leaf(1)];
  });
  assert.deepEqual((await svc.profilesForDocument()).map((p) => p.id), [1, 2]);
  assert.deepEqual((await svc.profilesForDocument()).map((p) => p.id), [2, 1]);
  assert.equal(calls, 2);
});

test("profilesForDocument falls back to the load-time snapshot when the lookup fails", async () => {
  const svc = service(async () => {
    throw new Error("connect ECONNREFUSED");
  }, [leaf(7)]);
  assert.deepEqual((await svc.profilesForDocument()).map((p) => p.id), [7]);
});

test("each document starts on the leaf the route picks for it (round robin across documents)", async () => {
  const firstHost: string[] = [];
  let docStart = true;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (docStart) {
      firstHost.push(new URL(String(input)).host);
      docStart = false;
    }
    return new Response("down", { status: 500 });
  }) as typeof fetch;
  let n = 0;
  const svc = service(async () => (n++ % 2 === 0 ? [leaf(1), leaf(2)] : [leaf(2), leaf(1)]));
  for (let doc = 0; doc < 3; doc += 1) {
    docStart = true;
    await assert.rejects(svc.analyzeMarkdown("# 藥品說明書"), AnalysisLlmUnavailable);
  }
  assert.deepEqual(firstHost, ["leaf1.test", "leaf2.test", "leaf1.test"]);
});

test("analysisReadiness accepts every registered chat provider and rejects unknown or embedding-only ones", () => {
  const ready = (provider: string, base_url = "https://api.example.test/v1") =>
    service(async () => [], [{ ...leaf(1), provider, base_url }]).analysisReadiness();
  for (const provider of ["anthropic", "gemini", "openai_compatible", "ollama", "deepseek", "vllm"]) {
    assert.equal(ready(provider)[0], true, provider);
  }
  assert.equal(ready("voyage")[0], false, "embedding-only provider");
  assert.match(ready("no_such_provider")[1], /unsupported provider/);
});
