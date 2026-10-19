import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUERY_TASKS, formatQueryText, instructsByDefault } from "./queryInstruction.js";

const p = (model: string, params: Record<string, unknown> = {}) => ({ model, params });

test("Qwen3-Embedding under any serving name gets the instruction", () => {
  for (const m of ["qwen3-embedding-4b", "qwen3-embedding:0.6b-q8_0", "Qwen/Qwen3-Embedding-0.6B", "Qwen3-Embedding-0.6B-4bit-DWQ"]) {
    assert.equal(instructsByDefault(p(m)), true, m);
    assert.equal(formatQueryText(p(m), "icd", "UTI"), `Instruct: ${DEFAULT_QUERY_TASKS.icd}\nQuery: UTI`);
  }
});

test("unknown models, missing task and 'off' leave the text alone", () => {
  assert.equal(formatQueryText(p("text-embedding-3-small"), "loinc", "CRP"), "CRP");
  assert.equal(formatQueryText(p("bge-m3"), "snomed", "asthma"), "asthma");
  assert.equal(formatQueryText(p("qwen3-embedding-4b"), undefined, "CRP"), "CRP");
  assert.equal(formatQueryText(p("qwen3-embedding-4b", { query_instruction: "off" }), "loinc", "CRP"), "CRP");
  assert.equal(formatQueryText(p("qwen3-embedding-4b", { query_instruction: " OFF " }), "loinc", "CRP"), "CRP");
});

test("base_model on the account identifies an aliased served model", () => {
  assert.equal(instructsByDefault(p("my-embedder", { base_model: "Qwen/Qwen3-Embedding-8B" })), true);
});

test("a custom instruction replaces the task text (and enables an unknown model)", () => {
  assert.equal(formatQueryText(p("qwen3-embedding-4b", { query_instruction: "Find the billing item" }), "icd", "x"), "Instruct: Find the billing item\nQuery: x");
  assert.equal(formatQueryText(p("other", { query_instruction: "Find it" }), "icd", "x"), "Instruct: Find it\nQuery: x");
  assert.equal(formatQueryText(p("qwen3-embedding-4b", { query_instruction: "auto" }), "loinc", "x"), `Instruct: ${DEFAULT_QUERY_TASKS.loinc}\nQuery: x`);
});
