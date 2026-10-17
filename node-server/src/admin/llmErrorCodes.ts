/**
 * Stable machine codes for the messages the LLM admin API sends to the console.
 *
 * The routing / fingerprint / provider layers throw plain English messages
 * (also used in logs and tests). Rather than thread a code through every throw
 * site, the HTTP layer (adminLlmApi.ts) classifies the message here and attaches
 * `{ code, params }` to the response; the console translates by code and falls
 * back to the raw message when no code is present.
 *
 * Keep the patterns in step with the message strings in llmRouting.ts,
 * embeddingIdentity.ts and adminSettings.ts — llmErrorCodes.test.ts pins them.
 */

export type LlmCodeParams = Record<string, string | number>;

export interface LlmCode {
  code: string;
  params: LlmCodeParams;
}

type Rule = [RegExp, string, (m: RegExpMatchArray) => LlmCodeParams];

const none = (): LlmCodeParams => ({});

/** Classify the detail of a failed provider call (network, auth, bad URL…). */
export function providerDetail(detail: string): LlmCodeParams {
  const d = detail.trim();
  let reason = "other";
  if (/Failed to parse URL|Invalid URL|ERR_INVALID_URL/i.test(d)) reason = "bad_url";
  else if (/HTTP 40[13]\b/.test(d)) reason = "auth";
  else if (/HTTP 404\b/.test(d)) reason = "not_found";
  else if (/HTTP 429\b/.test(d)) reason = "rate_limited";
  else if (/HTTP 5\d\d\b/.test(d)) reason = "server_error";
  else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|fetch failed|getaddrinfo|socket hang up|ECONNRESET/i.test(d)) reason = "unreachable";
  else if (/timed? ?out|ETIMEDOUT|aborted/i.test(d)) reason = "timeout";
  return { reason, detail: d };
}

/** Messages that describe why an embedding endpoint does not match the system's. */
const FINGERPRINT_RULES: Rule[] = [
  [/^Configured dimensions (\d+) differ from the system's (\d+)\.?$/, "embedding_dims_mismatch", (m) => ({ dims: Number(m[1]), system_dims: Number(m[2]) })],
  [/^The endpoint returned (\d+)-dimension vectors; the system uses (\d+)\.?$/, "embedding_dims_returned", (m) => ({ dims: Number(m[1]), system_dims: Number(m[2]) })],
  [
    /^Different model: similarity to the system's vectors is ([\d.-]+) \(needs ≥ ([\d.]+)\)\.?$/,
    "embedding_different_model",
    (m) => ({ similarity: Number(m[1]), min_similarity: Number(m[2]) }),
  ],
  [/^Same model as the system \(similarity ([\d.-]+)–([\d.-]+)\)\.?$/, "embedding_same_model", (m) => ({ min: Number(m[1]), max: Number(m[2]) })],
  [/^No embedding identity yet/, "embedding_no_identity", none],
];

const RULES: Rule[] = [
  // ── accounts ──
  [/^'(.*)' is not a valid http\(s\) URL\.?$/s, "invalid_url", (m) => ({ url: m[1] })],
  [/^This account is used by profile\(s\): (.*)\. Remove it from them first\.?$/s, "account_in_use", (m) => ({ profiles: m[1] })],
  [/^Account name is required\.?$/, "account_name_required", none],
  [/^Account name is too long \(max (\d+)\)\.?$/, "account_name_too_long", (m) => ({ max: Number(m[1]) })],
  [/^An account named '(.*)' already exists\.?$/s, "account_name_taken", (m) => ({ name: m[1] })],
  [/^No such account: (\d+)/, "account_not_found", (m) => ({ id: Number(m[1]) })],
  [/^Unknown provider account\.?$/, "account_not_found", none],
  [/^Unknown provider:? '?([^'.]*)'?\.?$/, "unknown_provider", (m) => ({ provider: m[1] })],
  [/^The provider type of an account cannot change/, "account_provider_locked", none],
  [/^(.+) accounts are connected by signing in, not with an API key\.?$/, "account_oauth_only", (m) => ({ provider: m[1] })],
  [/^(.+) requires an API key\.?$/, "api_key_required", (m) => ({ provider: m[1] })],
  [/^API key is required for this provider\.?$/, "api_key_required", none],
  [/^Base URL is required\.?$/, "base_url_required", none],
  [/^Model is required\.?$/, "model_required", none],
  [/^RPM \/ TPM must be positive integers\.?$/, "rate_limit_invalid", none],
  [/^Enabled must be true or false\.?$/, "enabled_invalid", none],
  [/^Unknown role: (.*)$/, "unknown_role", (m) => ({ role: m[1] })],
  [/^'(.*)' has no enabled model; enable a member before assigning it to a role\.?$/s, "role_no_enabled_model", (m) => ({ name: m[1] })],
  [/^A member references a profile or account that was just deleted/, "member_ref_deleted", none],
  [/^'llm' must contain providers\[\] and profiles\[\]|^Imported (account|profile) #(\d+)/, "import_malformed", none],
  [/^Imported profiles reference missing profiles or each other in a loop/, "import_profile_refs", none],
  // ── model listing / test ──
  [/^Could not list models: (.*)$/s, "models_list_failed", (m) => providerDetail(m[1])],
  [/^Found (\d+) model\(s\)\.?$/, "models_found", (m) => ({ count: Number(m[1]) })],
  [/^This provider has no model listing/, "models_no_listing", none],
  [/^(.+) does not offer (embeddings|chat models)\.?$/, "provider_no_role", (m) => ({ provider: m[1], role: m[2] === "embeddings" ? "embedding" : "analysis" })],
  // ── profiles ──
  [/^Profile name is required\.?$/, "profile_name_required", none],
  [/^Profile name is too long \(max (\d+)\)\.?$/, "profile_name_too_long", (m) => ({ max: Number(m[1]) })],
  [/^A profile named '(.*)' already exists\.?$/s, "profile_name_taken", (m) => ({ name: m[1] })],
  [/^A profile needs at least one member\.?$/, "profile_needs_member", none],
  [/^A 'single' profile has exactly one member/, "profile_single_one_member", none],
  [/^No such profile: (\d+)/, "profile_not_found", (m) => ({ id: Number(m[1]) })],
  [/^Profiles would reference each other in a loop: (.*)\.$/s, "profile_loop", (m) => ({ path: m[1] })],
  [/^This profile is in use; its role/, "profile_kind_locked", none],
  [/^Deleting '(.*)' affects other profiles or roles/s, "profile_delete_needs_confirm", (m) => ({ name: m[1] })],
  [/^'(.*)' is a (analysis|embedding) profile; it cannot serve the (analysis|embedding) role\.?$/s, "profile_wrong_role", (m) => ({ name: m[1], kind: m[2], role: m[3] })],
  [/^Every model in an embedding profile must use the same dimensions — found (.*)\.$/, "embedding_dims_mixed", (m) => ({ dims: m[1] })],
  // ── embedding identity / switching ──
  [/^Vectors exist but no embedding model is bound/, "embedding_no_seed", none],
  [/^Could not verify '(.*)' against the system embedding model: (.*)$/s, "embedding_unverified", (m) => ({ name: m[1], ...providerDetail(m[2]) })],
  [/^The new model did not answer: (.*)$/s, "embedding_new_model_unreachable", (m) => providerDetail(m[1])],
  [/^The new model returned (\d+)-dimension vectors but (\d+) were configured\.?$/, "embedding_new_model_dims", (m) => ({ returned: Number(m[1]), dims: Number(m[2]) })],
  [/^Type REINDEX to confirm/, "embedding_reindex_confirm", none],
  [/^This model already produces the system's vectors; no switch is needed/, "embedding_switch_same_model", none],
  [/^An embedding model switch is already in progress/, "embedding_switch_busy", none],
  [/^Embedding jobs did not stop within/, "embedding_jobs_busy", none],
  [/^Confirm the ChatGPT subscription terms/, "chatgpt_terms_required", none],
  ...FINGERPRINT_RULES,
];

/** Member-scoped profile errors: "Member 3: …". */
const MEMBER_RULES: Rule[] = [
  [/^weight must be (?:a non-negative integer|an integer between 0 and (\d+))\.?$/, "member_weight_invalid", (m): LlmCodeParams => (m[1] ? { max: Number(m[1]) } : {})],
  [/^enabled must be true or false\.?$/, "member_enabled_invalid", none],
  [/^unknown provider account\.?$/, "member_unknown_account", none],
  [/^model is required\.?$/, "member_model_required", none],
  [/^(.+) \((.+)\) does not offer (embeddings|chat models)\.?$/, "member_provider_no_role", (m) => ({ account: m[1], provider: m[2], role: m[3] === "embeddings" ? "embedding" : "analysis" })],
  [/^dimensions must be a positive integer\.?$/, "member_dims_invalid", none],
  [/^unknown profile\.?$/, "member_unknown_profile", none],
  [/^a profile cannot contain itself\.?$/, "member_self_reference", none],
  [/^'(.*)' is already a member of this profile\.?$/s, "member_duplicate_profile", (m) => ({ name: m[1] })],
  [/^'(.*)' is a (analysis|embedding) profile; it cannot go into a (analysis|embedding) profile\.?$/s, "member_kind_mismatch", (m) => ({ name: m[1], kind: m[2], target: m[3] })],
  [/^unknown member type\.?$/, "member_unknown_type", none],
];

function match(rules: Rule[], msg: string): LlmCode | null {
  for (const [re, code, params] of rules) {
    const m = msg.match(re);
    if (m) return { code, params: params(m) };
  }
  return null;
}

/** A leaf name is "<account> · <model>"; the model part, when present. */
function modelOfLeafName(name: string): string {
  const i = name.lastIndexOf(" · ");
  return i >= 0 ? name.slice(i + 3) : name;
}

/** Map an admin-facing message to a stable code + params, or null when unknown. */
export function classifyLlmMessage(message: string | null | undefined): LlmCode | null {
  const msg = String(message ?? "").trim();
  if (!msg) return null;

  // A profile save rejected by the fingerprint check wraps the specific reason.
  const rejected = msg.match(/^'(.*)' is not the system's embedding model \((.*), (\d+) dims\): (.*?)\s*Every embedding endpoint must produce the same vectors/s);
  if (rejected) {
    const [, name, systemModel, systemDims, reasonText] = rejected;
    const reason = match(FINGERPRINT_RULES, reasonText.trim());
    const model = modelOfLeafName(name);
    const base: LlmCodeParams = { name, model, system_model: systemModel, system_dims: Number(systemDims), detail: reasonText.trim() };
    if (reason?.code === "embedding_dims_mismatch" || reason?.code === "embedding_dims_returned") {
      // Same model name, different size: say exactly that rather than "not the system model".
      return {
        code: model === systemModel ? "embedding_rejected_same_model_dims" : "embedding_rejected_dims",
        params: { ...base, ...reason.params },
      };
    }
    if (reason?.code === "embedding_different_model") return { code: "embedding_rejected_different_model", params: { ...base, ...reason.params } };
    return { code: "embedding_rejected", params: base };
  }

  const member = msg.match(/^Member (\d+): (.*)$/s);
  if (member) {
    const inner = match(MEMBER_RULES, member[2]);
    if (inner) return { code: inner.code, params: { ...inner.params, index: Number(member[1]) } };
  }

  const param = msg.match(/^(.+) must be (an integer|a number|between .+|one of: .+)\.$/s);
  const known = match(RULES, msg);
  if (known) return known;
  if (param) return { code: "param_invalid", params: { label: param[1], rule: param[2] } };
  return null;
}

/** `{ code, params }` fields to spread into a JSON response next to a message (empty when unknown). */
export function codeFields(message: string | null | undefined, prefix = ""): Record<string, unknown> {
  const c = classifyLlmMessage(message);
  return c ? { [`${prefix}code`]: c.code, [`${prefix}params`]: c.params } : {};
}
