/**
 * LLM profiles — several endpoints per role, with failover / weighted selection.
 *
 * A *role* (`kind`) is "analysis" or "embedding". Each profile is one endpoint:
 * provider + base URL + key + model, plus `enabled`, a failover `priority` and a
 * load-balancing `weight`. The strategy for a role lives in the corresponding
 * `admin.app_settings` group (`analysis.strategy` / `embedding.strategy`), as do
 * the globals every profile of that role must agree on.
 *
 * Callers do not pick an endpoint themselves: they ask for `candidateOrder(kind)`
 * and walk it, calling `reportSuccess`/`reportFailure` as they go. A profile that
 * fails repeatedly is put in a short cool-down (a process-local circuit breaker)
 * so a dead endpoint stops costing every request a timeout — but it is never
 * disabled behind the operator's back; `enabled` is theirs alone.
 *
 * Embedding is a special case, and the reason the UI shouts about it: vectors
 * from different models (even different quantisations of the "same" model) are
 * not comparable, and pgvector keeps them all in one column. Two enabled
 * embedding profiles serving different model strings would silently poison
 * semantic search, so `assertEmbeddingConsistency` refuses to let that be saved.
 * For embeddings, extra profiles buy redundancy across hosts serving the *same*
 * model — they are not a way to mix models.
 */

import { query, withTransaction } from "../db.js";
import { logWarning } from "../logger.js";

export type ProfileKind = "analysis" | "embedding";
export type Strategy = "failover" | "weighted";

export interface LlmProfile {
  id: number;
  kind: ProfileKind;
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  enabled: boolean;
  priority: number;
  weight: number;
  params: Record<string, unknown>;
}

/** A profile as the admin UI sees it: the key is never sent, only its presence. */
export type LlmProfilePublic = Omit<LlmProfile, "api_key"> & { has_api_key: boolean };

export function toPublic(p: LlmProfile): LlmProfilePublic {
  const { api_key, ...rest } = p;
  return { ...rest, has_api_key: Boolean(api_key) };
}

const ROW_COLS =
  "id, kind, name, provider, base_url, api_key, model, enabled, priority, weight, params";

interface Row {
  id: string | number;
  kind: string;
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  enabled: boolean;
  priority: number;
  weight: number;
  params: Record<string, unknown> | null;
}

function fromRow(r: Row): LlmProfile {
  return {
    id: Number(r.id),
    kind: r.kind as ProfileKind,
    name: r.name,
    provider: r.provider,
    base_url: r.base_url,
    api_key: r.api_key,
    model: r.model,
    enabled: r.enabled,
    priority: Number(r.priority),
    weight: Number(r.weight),
    params: r.params ?? {},
  };
}

export async function listProfiles(kind?: ProfileKind): Promise<LlmProfile[]> {
  const res = kind
    ? await query<Row>(
        `SELECT ${ROW_COLS} FROM admin.llm_profiles WHERE kind = $1 ORDER BY priority, id`,
        [kind],
      )
    : await query<Row>(`SELECT ${ROW_COLS} FROM admin.llm_profiles ORDER BY kind, priority, id`);
  return res.rows.map(fromRow);
}

export async function getProfile(id: number): Promise<LlmProfile | null> {
  const res = await query<Row>(`SELECT ${ROW_COLS} FROM admin.llm_profiles WHERE id = $1`, [id]);
  return res.rows.length ? fromRow(res.rows[0]) : null;
}

/** Enabled profiles for a role, in failover order. */
export async function listEnabled(kind: ProfileKind): Promise<LlmProfile[]> {
  const res = await query<Row>(
    `SELECT ${ROW_COLS} FROM admin.llm_profiles
      WHERE kind = $1 AND enabled = TRUE ORDER BY priority, id`,
    [kind],
  );
  return res.rows.map(fromRow);
}

/** Is this role usable at all? (At least one enabled profile with an endpoint.) */
export async function isKindConfigured(kind: ProfileKind): Promise<boolean> {
  const enabled = await listEnabled(kind);
  return enabled.some((p) => p.base_url && p.model);
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
// Process-local: the app and the worker each learn independently, which is fine —
// this state is a latency optimisation, never a source of truth.

const FAILURES_BEFORE_TRIP = 3;
const COOLDOWN_MS = 60_000;

const breaker = new Map<number, { failures: number; openUntil: number }>();

export function reportSuccess(id: number): void {
  breaker.delete(id);
}

export function reportFailure(id: number, error: string): void {
  const s = breaker.get(id) ?? { failures: 0, openUntil: 0 };
  s.failures += 1;
  if (s.failures >= FAILURES_BEFORE_TRIP) {
    s.openUntil = Date.now() + COOLDOWN_MS;
    logWarning("llm_profile_cooling_down", { profile_id: id, cooldown_ms: COOLDOWN_MS, error });
  }
  breaker.set(id, s);
}

function isCoolingDown(id: number): boolean {
  const s = breaker.get(id);
  return s !== undefined && s.openUntil > Date.now();
}

/** Forget every breaker decision (config changed, or tests). */
export function resetBreakers(): void {
  breaker.clear();
}

/**
 * Pick one profile per the weighted strategy. Weight 0 means "only if everything
 * else is down": it stays in the fallback chain but never wins the draw.
 */
function weightedPick(profiles: LlmProfile[]): LlmProfile {
  const total = profiles.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
  if (total <= 0) return profiles[0];
  let ticket = Math.random() * total;
  for (const p of profiles) {
    ticket -= Math.max(0, p.weight);
    if (ticket < 0) return p;
  }
  return profiles[profiles.length - 1];
}

/**
 * The order a caller should try endpoints in, for one request.
 *
 * `failover`: strictly by priority. `weighted`: one profile drawn by weight goes
 * first and the rest follow as fallbacks in priority order — so load is spread,
 * but a request never fails just because the endpoint it happened to draw is down.
 *
 * Profiles in cool-down go to the back rather than being dropped: if every
 * endpoint is unhealthy we still try them all instead of failing outright.
 */
export async function candidateOrder(kind: ProfileKind, strategy: Strategy): Promise<LlmProfile[]> {
  const enabled = (await listEnabled(kind)).filter((p) => p.base_url && p.model);
  if (enabled.length === 0) return [];

  let order: LlmProfile[];
  if (strategy === "weighted") {
    const first = weightedPick(enabled);
    order = [first, ...enabled.filter((p) => p.id !== first.id)];
  } else {
    order = enabled;
  }
  const healthy = order.filter((p) => !isCoolingDown(p.id));
  const cooling = order.filter((p) => isCoolingDown(p.id));
  return [...healthy, ...cooling];
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface ProfileInput {
  kind: ProfileKind;
  name: string;
  provider: string;
  base_url: string;
  api_key?: string;
  model: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  params?: Record<string, unknown>;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

export class ProfileValidationError extends Error {}

function validate(input: {
  kind: string;
  name: string;
  base_url: string;
  model: string;
  weight?: number;
}): void {
  if (!input.name.trim()) throw new ProfileValidationError("Profile name is required.");
  if (input.kind !== "analysis" && input.kind !== "embedding") {
    throw new ProfileValidationError(`Unknown profile kind: ${input.kind}`);
  }
  if (!input.model.trim()) throw new ProfileValidationError("Model is required.");
  if (!isValidHttpUrl(input.base_url.trim())) {
    throw new ProfileValidationError(`'${input.base_url}' is not a valid http(s) URL`);
  }
  if (input.weight !== undefined && (!Number.isInteger(input.weight) || input.weight < 0)) {
    throw new ProfileValidationError("Weight must be a non-negative integer.");
  }
}

/**
 * Every enabled embedding profile must serve the same model. Vectors from two
 * different models — or two quantisations of one model — are not comparable, and
 * they all land in the same pgvector column, so mixing them corrupts semantic
 * search in a way nothing would flag at query time.
 */
export async function assertEmbeddingConsistency(pending?: LlmProfile[]): Promise<void> {
  const enabled = (pending ?? (await listProfiles("embedding"))).filter((p) => p.enabled);
  const models = [...new Set(enabled.map((p) => p.model.trim()).filter(Boolean))];
  if (models.length > 1) {
    throw new ProfileValidationError(
      `All enabled embedding profiles must serve the same model — found ${models
        .map((m) => `'${m}'`)
        .join(", ")}. Vectors from different embedding models (including different ` +
        "quantisations of the same model) are not comparable, and every vector in the " +
        "database shares one column. Extra embedding profiles are for redundancy across " +
        "hosts serving the same model; to change model, re-embed every module afterwards.",
    );
  }
}

/** The embedding profiles as they would be after a change, for pre-write validation. */
async function simulateEmbedding(change: {
  upsert?: LlmProfile;
  deleteId?: number;
}): Promise<LlmProfile[]> {
  let next = await listProfiles();
  if (change.deleteId !== undefined) next = next.filter((p) => p.id !== change.deleteId);
  if (change.upsert) {
    const up = change.upsert;
    next = next.filter((p) => p.id !== up.id);
    next.push(up);
  }
  return next.filter((p) => p.kind === "embedding");
}

export async function createProfile(input: ProfileInput, updatedBy: string): Promise<LlmProfile> {
  const candidate: LlmProfile = {
    id: -1,
    kind: input.kind,
    name: String(input.name ?? "").trim(),
    provider: input.provider,
    base_url: String(input.base_url ?? "").trim(),
    api_key: input.api_key ?? "",
    model: String(input.model ?? "").trim(),
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    weight: input.weight ?? 1,
    params: input.params ?? {},
  };
  validate(candidate);
  if (candidate.kind === "embedding") {
    await assertEmbeddingConsistency(await simulateEmbedding({ upsert: candidate }));
  }

  const row = await withTransaction(async (client) => {
    const r = await client.query(
      `INSERT INTO admin.llm_profiles (kind, name, provider, base_url, api_key, model, enabled, priority, weight, params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING ${ROW_COLS}`,
      [
        candidate.kind,
        candidate.name,
        candidate.provider,
        candidate.base_url,
        candidate.api_key,
        candidate.model,
        candidate.enabled,
        candidate.priority,
        candidate.weight,
        JSON.stringify(candidate.params),
      ],
    );
    await audit(client, updatedBy, "create_llm_profile", candidate.name, candidate);
    return r.rows[0] as Row;
  });
  return fromRow(row);
}

export async function updateProfile(
  id: number,
  patch: Partial<ProfileInput>,
  updatedBy: string,
): Promise<LlmProfile> {
  const existing = await getProfile(id);
  if (!existing) throw new ProfileValidationError(`No such profile: ${id}`);

  const merged: LlmProfile = {
    ...existing,
    ...("name" in patch ? { name: String(patch.name).trim() } : {}),
    ...("provider" in patch ? { provider: String(patch.provider) } : {}),
    ...("base_url" in patch ? { base_url: String(patch.base_url).trim() } : {}),
    ...("model" in patch ? { model: String(patch.model).trim() } : {}),
    ...("enabled" in patch ? { enabled: Boolean(patch.enabled) } : {}),
    ...("priority" in patch ? { priority: Number(patch.priority) } : {}),
    ...("weight" in patch ? { weight: Number(patch.weight) } : {}),
    ...("params" in patch ? { params: patch.params ?? {} } : {}),
  };
  // A blank/absent key means "keep the stored one" — same rule as the settings
  // form: a secret is only ever replaced by a value the operator actually typed.
  const incomingKey = typeof patch.api_key === "string" ? patch.api_key.trim() : "";
  if (incomingKey) merged.api_key = incomingKey;

  validate(merged);
  if (merged.kind === "embedding") {
    await assertEmbeddingConsistency(await simulateEmbedding({ upsert: merged }));
  }

  const row = await withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE admin.llm_profiles
          SET name=$2, provider=$3, base_url=$4, api_key=$5, model=$6,
              enabled=$7, priority=$8, weight=$9, params=$10::jsonb, updated_at=NOW()
        WHERE id=$1
        RETURNING ${ROW_COLS}`,
      [
        id,
        merged.name,
        merged.provider,
        merged.base_url,
        merged.api_key,
        merged.model,
        merged.enabled,
        merged.priority,
        merged.weight,
        JSON.stringify(merged.params),
      ],
    );
    await audit(client, updatedBy, "update_llm_profile", merged.name, merged);
    return r.rows[0] as Row;
  });
  reportSuccess(id); // config changed — give the endpoint a clean slate
  return fromRow(row);
}

export async function deleteProfile(id: number, updatedBy: string): Promise<void> {
  const existing = await getProfile(id);
  if (!existing) throw new ProfileValidationError(`No such profile: ${id}`);
  if (existing.kind === "embedding") {
    await assertEmbeddingConsistency(await simulateEmbedding({ deleteId: id }));
  }
  await withTransaction(async (client) => {
    await client.query("DELETE FROM admin.llm_profiles WHERE id = $1", [id]);
    await audit(client, updatedBy, "delete_llm_profile", existing.name, existing);
  });
  breaker.delete(id);
}

async function audit(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  adminUser: string,
  action: string,
  target: string,
  profile: LlmProfile,
): Promise<void> {
  const { api_key, ...safe } = profile; // never log the key
  await client.query(
    `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
     VALUES ($1, $2, 'llm_profile', $3, $4::jsonb)`,
    [adminUser, action, target, JSON.stringify({ ...safe, has_api_key: Boolean(api_key) })],
  );
}

// ── Export / import (part of the settings document) ──────────────────────────

export async function exportProfiles(): Promise<Omit<LlmProfile, "id">[]> {
  const all = await listProfiles();
  return all.map(({ id: _id, ...rest }) => rest);
}

/** Replace every profile with the exported set. Validated exactly like a form write. */
export async function importProfiles(docProfiles: unknown, updatedBy: string): Promise<number> {
  if (docProfiles === undefined || docProfiles === null) return 0;
  if (!Array.isArray(docProfiles)) throw new ProfileValidationError("'profiles' must be an array");

  const parsed: LlmProfile[] = docProfiles.map((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const profile: LlmProfile = {
      id: -(i + 1),
      kind: String(p.kind ?? "") as ProfileKind,
      name: String(p.name ?? "").trim(),
      provider: String(p.provider ?? ""),
      base_url: String(p.base_url ?? "").trim(),
      api_key: String(p.api_key ?? ""),
      model: String(p.model ?? "").trim(),
      enabled: p.enabled !== false,
      priority: Number(p.priority ?? 100),
      weight: Number(p.weight ?? 1),
      params: (p.params as Record<string, unknown>) ?? {},
    };
    validate(profile);
    return profile;
  });
  await assertEmbeddingConsistency(parsed.filter((p) => p.kind === "embedding"));

  await withTransaction(async (client) => {
    await client.query("DELETE FROM admin.llm_profiles");
    for (const p of parsed) {
      await client.query(
        `INSERT INTO admin.llm_profiles (kind, name, provider, base_url, api_key, model, enabled, priority, weight, params)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          p.kind,
          p.name,
          p.provider,
          p.base_url,
          p.api_key,
          p.model,
          p.enabled,
          p.priority,
          p.weight,
          JSON.stringify(p.params),
        ],
      );
    }
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'import_llm_profiles', 'llm_profile', 'all', $2::jsonb)`,
      [updatedBy, JSON.stringify({ count: parsed.length })],
    );
  });
  resetBreakers();
  return parsed.length;
}
