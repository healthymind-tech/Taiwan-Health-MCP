import { test } from "node:test";
import assert from "node:assert/strict";
import { precheckJobCreate, type JobPrecheckDeps } from "./jobPrechecks.js";

function deps(over: Partial<JobPrecheckDeps> = {}): JobPrecheckDeps {
  return {
    activeJobs: async () => [],
    drugReadiness: async () => [true, ""],
    ...over,
  };
}

test("a second active whole-module import is refused with the active job id", async () => {
  const out = await precheckJobCreate("loinc_import", {}, deps({ activeJobs: async () => [{ job_id: "j1", status: "running" }] }));
  assert.equal(out?.status, 409);
  assert.equal(out?.body.code, "JOB_ALREADY_ACTIVE");
  assert.equal(out?.body.active_job_id, "j1");
  assert.match(String(out?.body.message_zh), /執行中/);
});

test("non-singleton job types are never blocked by an active job", async () => {
  const d = deps({ activeJobs: async () => [{ job_id: "j1", status: "running" }] });
  assert.equal(await precheckJobCreate("ig_import", {}, d), null);
  assert.equal(await precheckJobCreate("drug_enrichment", {}, d), null);
});

test("drug analysis without OCR configured is refused up front, in zh with the fix", async () => {
  const out = await precheckJobCreate(
    "drug_analysis",
    {},
    deps({ drugReadiness: async () => [false, "OCR server is not configured yet — set it up in the admin console (Settings → OCR Server)."] }),
  );
  assert.equal(out?.status, 409);
  assert.equal(out?.body.code, "OCR_NOT_CONFIGURED");
  assert.match(String(out?.body.hint_zh), /外部服務/);
});

test("analysis-only retry checks only the analysis LLM; normalize checks nothing", async () => {
  let asked = "";
  const d = deps({
    drugReadiness: async (stage) => {
      asked = stage;
      return [false, "Analysis LM is not configured yet — set it up in the admin console (Settings → Analysis LM)."];
    },
  });
  const out = await precheckJobCreate("drug_analysis", { retry_stage: "analysis" }, d);
  assert.equal(asked, "analysis");
  assert.equal(out?.body.code, "ANALYSIS_LM_NOT_CONFIGURED");
  asked = "";
  assert.equal(await precheckJobCreate("drug_analysis", { retry_stage: "normalize" }, d), null);
  assert.equal(asked, "");
});

test("lookup failures fail open (the worker still reports the real error)", async () => {
  const d = deps({
    activeJobs: async () => {
      throw new Error("db down");
    },
    drugReadiness: async () => {
      throw new Error("db down");
    },
  });
  assert.equal(await precheckJobCreate("icd_import", {}, d), null);
  assert.equal(await precheckJobCreate("drug_pipeline", {}, d), null);
});
