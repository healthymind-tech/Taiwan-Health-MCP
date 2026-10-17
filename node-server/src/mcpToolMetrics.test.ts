import { test } from "node:test";
import assert from "node:assert/strict";
import { withToolMetrics } from "./mcp.js";

type Rec = { tool: string; status: string; durationS: number };

function recorder(): { calls: Rec[]; record: (tool: string, status: string, durationS: number) => void } {
  const calls: Rec[] = [];
  return { calls, record: (tool, status, durationS) => calls.push({ tool, status, durationS }) };
}

test("withToolMetrics records success with tool name only", async () => {
  const r = recorder();
  const wrapped = withToolMetrics("search_loinc", async (args: { q: string }) => ({ content: [{ type: "text", text: args.q }] }), r.record);
  const out = await wrapped({ q: "secret-patient-term" });
  assert.equal(out.content[0].text, "secret-patient-term");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].tool, "search_loinc");
  assert.equal(r.calls[0].status, "success");
  assert.ok(r.calls[0].durationS >= 0);
  assert.ok(!JSON.stringify(r.calls).includes("secret-patient-term"));
});

test("withToolMetrics records error on throw and rethrows", async () => {
  const r = recorder();
  const wrapped = withToolMetrics("query_loinc", async () => {
    throw new Error("boom");
  }, r.record);
  await assert.rejects(wrapped(), /boom/);
  assert.deepEqual(r.calls.map((c) => [c.tool, c.status]), [["query_loinc", "error"]]);
});

test("withToolMetrics records error for isError results", async () => {
  const r = recorder();
  const wrapped = withToolMetrics("x", async () => ({ isError: true, content: [] }), r.record);
  await wrapped();
  assert.equal(r.calls[0].status, "error");
});

test("withToolMetrics never fails the call when recording throws", async () => {
  const wrapped = withToolMetrics("x", async () => 42, () => {
    throw new Error("metrics down");
  });
  assert.equal(await wrapped(), 42);
});
