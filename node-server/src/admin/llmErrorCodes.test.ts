/**
 * The console translates by code, so the patterns must keep matching the exact
 * messages the routing / fingerprint / provider layers produce.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLlmMessage, codeFields } from "./llmErrorCodes.js";

const SWITCH_HINT = "Every embedding endpoint must produce the same vectors. To change models, use 'Switch embedding model', which re-indexes all vectors.";

test("same model name with different dimensions is reported as a dimension problem", () => {
  const c = classifyLlmMessage(
    `'siliconflow · Qwen/Qwen3-Embedding-4B' is not the system's embedding model (Qwen/Qwen3-Embedding-4B, 1024 dims): Configured dimensions 768 differ from the system's 1024. ${SWITCH_HINT}`,
  );
  assert.equal(c?.code, "embedding_rejected_same_model_dims");
  assert.equal(c?.params.dims, 768);
  assert.equal(c?.params.system_dims, 1024);
  assert.equal(c?.params.model, "Qwen/Qwen3-Embedding-4B");
});

test("a different embedding model is rejected with its similarity", () => {
  const c = classifyLlmMessage(
    `'ollama · bge-m3' is not the system's embedding model (Qwen/Qwen3-Embedding-4B, 1024 dims): Different model: similarity to the system's vectors is 0.123 (needs ≥ 0.95). ${SWITCH_HINT}`,
  );
  assert.equal(c?.code, "embedding_rejected_different_model");
  assert.equal(c?.params.similarity, 0.123);
  assert.equal(c?.params.min_similarity, 0.95);
});

test("a different model with other dimensions is a plain dimension rejection", () => {
  const c = classifyLlmMessage(`'a · m1' is not the system's embedding model (m2, 1024 dims): Configured dimensions 768 differ from the system's 1024. ${SWITCH_HINT}`);
  assert.equal(c?.code, "embedding_rejected_dims");
});

test("fingerprint verdicts", () => {
  assert.equal(classifyLlmMessage("Different model: similarity to the system's vectors is 0.412 (needs ≥ 0.95).")?.code, "embedding_different_model");
  assert.equal(classifyLlmMessage("Configured dimensions 768 differ from the system's 1024.")?.code, "embedding_dims_mismatch");
  assert.equal(classifyLlmMessage("Same model as the system (similarity 0.9990–0.9999).")?.code, "embedding_same_model");
});

test("account errors", () => {
  assert.deepEqual(classifyLlmMessage("'not a url' is not a valid http(s) URL"), { code: "invalid_url", params: { url: "not a url" } });
  assert.deepEqual(classifyLlmMessage("This account is used by profile(s): A, B. Remove it from them first."), {
    code: "account_in_use",
    params: { profiles: "A, B" },
  });
  assert.equal(classifyLlmMessage("An account named 'x' already exists.")?.code, "account_name_taken");
});

test("model listing failures carry a reason", () => {
  const c = classifyLlmMessage("Could not list models: Failed to parse URL from not a url/models");
  assert.equal(c?.code, "models_list_failed");
  assert.equal(c?.params.reason, "bad_url");
  assert.equal(classifyLlmMessage("Could not list models: HTTP 401: invalid key")?.params.reason, "auth");
  assert.equal(classifyLlmMessage("Could not list models: fetch failed")?.params.reason, "unreachable");
  assert.equal(classifyLlmMessage("Found 12 model(s).")?.params.count, 12);
});

test("member-scoped profile errors keep the member index", () => {
  assert.deepEqual(classifyLlmMessage("Member 3: 'Pool' is already a member of this profile."), {
    code: "member_duplicate_profile",
    params: { name: "Pool", index: 3 },
  });
  assert.equal(classifyLlmMessage("Member 1: model is required.")?.code, "member_model_required");
});

test("unknown messages yield no code", () => {
  assert.equal(classifyLlmMessage("something odd"), null);
  assert.deepEqual(codeFields("something odd"), {});
  assert.deepEqual(codeFields("Model is required.", "models_"), { models_code: "model_required", models_params: {} });
});

test("validation and switch messages added with the API hardening", () => {
  assert.deepEqual(classifyLlmMessage("Member 2: weight must be an integer between 0 and 1000."), { code: "member_weight_invalid", params: { max: 1000, index: 2 } });
  assert.equal(classifyLlmMessage("Member 1: enabled must be true or false.")?.code, "member_enabled_invalid");
  assert.equal(classifyLlmMessage("Enabled must be true or false.")?.code, "enabled_invalid");
  assert.equal(classifyLlmMessage("Unknown role: foo")?.code, "unknown_role");
  assert.equal(classifyLlmMessage("'Off' has no enabled model; enable a member before assigning it to a role.")?.code, "role_no_enabled_model");
  assert.equal(classifyLlmMessage("Profile name is too long (max 120).")?.code, "profile_name_too_long");
  assert.equal(classifyLlmMessage("This model already produces the system's vectors; no switch is needed — add it to the embedding profile instead.")?.code, "embedding_switch_same_model");
  assert.equal(classifyLlmMessage("An embedding model switch is already in progress.")?.code, "embedding_switch_busy");
  assert.equal(classifyLlmMessage("'llm' must contain providers[] and profiles[]")?.code, "import_malformed");
  assert.equal(classifyLlmMessage("Imported profile #2 must have a members[] list.")?.code, "import_malformed");
});
