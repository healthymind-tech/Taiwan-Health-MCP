/**
 * Per-task authoring context (authoring contract R5): the resources an LLM has authored for one
 * task, keyed by the model's own labels, kept between `fhir_author_resources` calls and read by
 * `fhir_assemble_bundle`.
 *
 * Storage layout (Redis): one hash per context at `authoring:ctx:<id>` with two fields —
 * `version` (monotonic integer, the optimistic-concurrency token) and `data` (the whole
 * ContextRecord as JSON). Every write is a compare-and-swap in one Lua script (version check +
 * HSET + EXPIRE), so concurrent updates of the same context never lose an entry: the loser re-reads
 * and re-applies its mutation. Every read / write refreshes the idle TTL (60 min). An expired or
 * unknown id raises ContextExpiredError — never an empty context — so the caller returns the typed
 * CONTEXT_EXPIRED error instead of partial results.
 *
 * The in-memory implementation has the same interface (unit tests, and the fallback when Redis is
 * not available: the tool response then says `storage: "memory"`).
 *
 * Records are serialised with losslessJson (stringifyLossless / parseLossless), so a number the
 * model wrote as `12.50` keeps that spelling from the compose call through the stored entry to
 * the assembled Bundle (the tool output is serialised the same way).
 *
 * Nothing here logs clinical content: only ids, entry counts and byte sizes.
 */

import { randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import { logDebug, logWarning } from "../logger.js";
import { parseLossless, stringifyLossless } from "../losslessJson.js";
import type { AuthorInput, AuthorIssue, AuthorStatus, Provenance } from "./types.js";

/** Idle TTL of a context: refreshed on every access. */
export const CONTEXT_IDLE_TTL_SECONDS = 60 * 60;
export const CONTEXT_KEY_PREFIX = "authoring:ctx:";

/** One authored resource inside a context. */
export interface ContextEntry {
  key: string;
  /** The input as last composed (after `merge`), so a later merge starts from it. */
  input: AuthorInput;
  resource: Record<string, unknown>;
  status: AuthorStatus;
  provenance: Record<string, Provenance>;
  missing: Array<{ field: string; why: string }>;
  refs: { resolved: string[]; pending: string[] };
  issues: AuthorIssue[];
  /** FHIR path → model field name, as the composer reported it (issue → field mapping at assembly). */
  fieldMap: Record<string, string>;
  updated_at: string;
}

export interface ContextRecord {
  id: string;
  /** Optimistic-concurrency token; bumped on every successful write. */
  version: number;
  created_at: string;
  updated_at: string;
  entries: Record<string, ContextEntry>;
  /** UTC offset (e.g. "+08:00") completing times given without one; set by fhir_author_resources' `timezone`. */
  timezone?: string | null;
}

export type ContextStorageKind = "redis" | "memory";

/** Unknown or expired context id. Tool layer → `{error: {code: "CONTEXT_EXPIRED", …}}`. */
export class ContextExpiredError extends Error {
  readonly code = "CONTEXT_EXPIRED";
  readonly contextId: string;
  constructor(contextId: string) {
    super(`authoring context ${contextId} does not exist or has expired (idle TTL ${CONTEXT_IDLE_TTL_SECONDS / 60} min)`);
    this.name = "ContextExpiredError";
    this.contextId = contextId;
  }
}

/** Thrown when a compare-and-swap keeps losing (pathological contention). */
export class ContextConflictError extends Error {
  readonly code = "CONTEXT_CONFLICT";
  constructor(contextId: string, attempts: number) {
    super(`authoring context ${contextId}: concurrent update conflict after ${attempts} attempts`);
    this.name = "ContextConflictError";
  }
}

export interface ContextStore {
  /** Where contexts live right now ("memory" after a Redis fallback). */
  readonly kind: ContextStorageKind;
  /** New empty context; returns its 128-bit random hex id. */
  create(): Promise<string>;
  /** The whole record (refreshes the TTL). Throws ContextExpiredError. */
  get(id: string): Promise<ContextRecord>;
  /**
   * Atomic read-modify-write: `mutate` runs on a fresh copy and may be re-run when another writer
   * got in first (keep it pure). Returns the stored record. Throws ContextExpiredError.
   */
  update(id: string, mutate: (ctx: ContextRecord) => void): Promise<ContextRecord>;
  /** Refresh the TTL only. Throws ContextExpiredError. */
  touch(id: string): Promise<void>;
  /** Remove the context; false when it did not exist. */
  delete(id: string): Promise<boolean>;
}

const CAS_ATTEMPTS = 16;

export function newContextId(): string {
  return randomBytes(16).toString("hex");
}

export function isContextId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
}

function emptyRecord(id: string, nowIso: string): ContextRecord {
  return { id, version: 1, created_at: nowIso, updated_at: nowIso, entries: {} };
}

/** Deep copy of a record that keeps RawNumber spellings inside the entries (losslessJson); `version` stays a number. */
function clone(v: ContextRecord): ContextRecord {
  const out = parseLossless(stringifyLossless(v)) as ContextRecord;
  out.version = Number(out.version);
  return out;
}

// --------------------------------------------------------------------------- //
// In-memory store (tests, fallback)
// --------------------------------------------------------------------------- //

export interface MemoryStoreOptions {
  ttlSeconds?: number;
  /** Clock in ms (tests advance it to exercise expiry). */
  now?: () => number;
  /** Upper bound on live contexts; the least recently touched are evicted first. */
  maxContexts?: number;
}

export class MemoryContextStore implements ContextStore {
  readonly kind = "memory" as const;
  private readonly rows = new Map<string, { record: ContextRecord; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxContexts: number;

  constructor(opts: MemoryStoreOptions = {}) {
    this.ttlMs = (opts.ttlSeconds ?? CONTEXT_IDLE_TTL_SECONDS) * 1000;
    this.now = opts.now ?? Date.now;
    this.maxContexts = opts.maxContexts ?? 10_000;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, row] of this.rows) if (row.expiresAt <= t) this.rows.delete(id);
    if (this.rows.size > this.maxContexts) {
      const byAge = [...this.rows.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (const [id] of byAge.slice(0, this.rows.size - this.maxContexts)) this.rows.delete(id);
    }
  }

  private live(id: string): { record: ContextRecord; expiresAt: number } {
    this.sweep();
    const row = this.rows.get(id);
    if (!row) throw new ContextExpiredError(id);
    row.expiresAt = this.now() + this.ttlMs;
    return row;
  }

  async create(): Promise<string> {
    this.sweep();
    const id = newContextId();
    this.rows.set(id, { record: emptyRecord(id, new Date(this.now()).toISOString()), expiresAt: this.now() + this.ttlMs });
    return id;
  }

  async get(id: string): Promise<ContextRecord> {
    return clone(this.live(id).record);
  }

  async update(id: string, mutate: (ctx: ContextRecord) => void): Promise<ContextRecord> {
    const row = this.live(id);
    // Single-threaded: the mutation of the copy and the swap are one synchronous step.
    const next = clone(row.record);
    mutate(next);
    next.id = id;
    next.version = row.record.version + 1;
    next.updated_at = new Date(this.now()).toISOString();
    row.record = clone(next); // the mutator may have inserted caller-owned objects
    return next;
  }

  async touch(id: string): Promise<void> {
    this.live(id);
  }

  async delete(id: string): Promise<boolean> {
    this.sweep();
    return this.rows.delete(id);
  }

  /** Live context count (tests). */
  get size(): number {
    this.sweep();
    return this.rows.size;
  }
}

// --------------------------------------------------------------------------- //
// Redis store
// --------------------------------------------------------------------------- //

/** Compare-and-swap write: version must match; sets both fields and refreshes the TTL. */
const CAS_SCRIPT = `
local v = redis.call('HGET', KEYS[1], 'version')
if not v then return -1 end
if v ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'version', ARGV[2], 'data', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

/** Read + TTL refresh in one round trip; nil when the key is gone. */
const GET_SCRIPT = `
local d = redis.call('HGET', KEYS[1], 'data')
if not d then return nil end
local v = redis.call('HGET', KEYS[1], 'version')
redis.call('EXPIRE', KEYS[1], ARGV[1])
return {v, d}
`;

export interface RedisStoreOptions {
  prefix?: string;
  ttlSeconds?: number;
  now?: () => number;
}

export class RedisContextStore implements ContextStore {
  readonly kind = "redis" as const;
  private readonly client: RedisClientType;
  private readonly prefix: string;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(client: RedisClientType, opts: RedisStoreOptions = {}) {
    this.client = client;
    this.prefix = opts.prefix ?? CONTEXT_KEY_PREFIX;
    this.ttl = opts.ttlSeconds ?? CONTEXT_IDLE_TTL_SECONDS;
    this.now = opts.now ?? Date.now;
  }

  private key(id: string): string {
    return `${this.prefix}${id}`;
  }

  private async read(id: string): Promise<ContextRecord> {
    const r = (await this.client.eval(GET_SCRIPT, { keys: [this.key(id)], arguments: [String(this.ttl)] })) as [string, string] | null;
    if (!r) throw new ContextExpiredError(id);
    const record = parseLossless(r[1]) as ContextRecord;
    record.version = Number(r[0]);
    return record;
  }

  async create(): Promise<string> {
    const id = newContextId();
    const nowIso = new Date(this.now()).toISOString();
    const record = emptyRecord(id, nowIso);
    const key = this.key(id);
    // 128 random bits: a collision is not a practical concern, but never overwrite anyway.
    const tx = this.client.multi().hSetNX(key, "version", "1").hSetNX(key, "data", JSON.stringify(record)).expire(key, this.ttl);
    await tx.exec();
    logDebug("authoring context created", { contextId: id, storage: "redis" });
    return id;
  }

  async get(id: string): Promise<ContextRecord> {
    return this.read(id);
  }

  /**
   * Updates of one context from this process run one after another (per-id promise chain), so
   * the CAS only ever has to beat writers in *other* processes; those retry with a short jitter.
   */
  async update(id: string, mutate: (ctx: ContextRecord) => void): Promise<ContextRecord> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.updateCas(id, mutate));
    this.chains.set(id, run);
    try {
      return await run;
    } finally {
      if (this.chains.get(id) === run) this.chains.delete(id);
    }
  }

  private readonly chains = new Map<string, Promise<unknown>>();

  private async updateCas(id: string, mutate: (ctx: ContextRecord) => void): Promise<ContextRecord> {
    for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20 * attempt)));
      const current = await this.read(id);
      const next = clone(current);
      mutate(next);
      next.id = id;
      next.version = current.version + 1;
      next.updated_at = new Date(this.now()).toISOString();
      const data = stringifyLossless(next);
      const rc = (await this.client.eval(CAS_SCRIPT, {
        keys: [this.key(id)],
        arguments: [String(current.version), String(next.version), data, String(this.ttl)],
      })) as number;
      if (rc === 1) {
        logDebug("authoring context updated", { contextId: id, version: next.version, entries: Object.keys(next.entries).length, bytes: data.length });
        return next;
      }
      if (rc === -1) throw new ContextExpiredError(id);
      // rc === 0: someone else wrote first — re-read and re-apply.
    }
    throw new ContextConflictError(id, CAS_ATTEMPTS);
  }

  async touch(id: string): Promise<void> {
    const n = await this.client.expire(this.key(id), this.ttl);
    if (!n) throw new ContextExpiredError(id);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.client.del(this.key(id))) > 0;
  }
}

// --------------------------------------------------------------------------- //
// Redis-with-memory-fallback
// --------------------------------------------------------------------------- //

/**
 * Uses Redis while the client is connected and falls back to a process-local memory store
 * otherwise (the fallback is per process and lost on restart — the tools say so). `kind`
 * reports what the *next* call would use.
 */
export class FallbackContextStore implements ContextStore {
  private readonly redis: RedisContextStore | null;
  private readonly memory: MemoryContextStore;
  private readonly ready: () => boolean;
  private warned = false;

  constructor(redis: RedisContextStore | null, ready: () => boolean, memory: MemoryContextStore = new MemoryContextStore()) {
    this.redis = redis;
    this.ready = ready;
    this.memory = memory;
  }

  private pick(): ContextStore {
    if (this.redis && this.ready()) return this.redis;
    if (!this.warned) {
      this.warned = true;
      logWarning("authoring contexts: Redis unavailable, using in-process memory (lost on restart)");
    }
    return this.memory;
  }

  get kind(): ContextStorageKind {
    return this.pick().kind;
  }
  create(): Promise<string> {
    return this.pick().create();
  }
  get(id: string): Promise<ContextRecord> {
    return this.pick().get(id);
  }
  update(id: string, mutate: (ctx: ContextRecord) => void): Promise<ContextRecord> {
    return this.pick().update(id, mutate);
  }
  touch(id: string): Promise<void> {
    return this.pick().touch(id);
  }
  delete(id: string): Promise<boolean> {
    return this.pick().delete(id);
  }
}

/**
 * Production store: Redis through the shared cache client when it is connected, memory
 * otherwise. `getClient` may throw (client not initialised) — that is the memory case.
 */
export function createContextStore(getClient: () => RedisClientType, opts: RedisStoreOptions = {}): ContextStore {
  let client: RedisClientType | null = null;
  try {
    client = getClient();
  } catch {
    client = null;
  }
  const redis = client ? new RedisContextStore(client, opts) : null;
  return new FallbackContextStore(redis, () => !!client && client.isReady);
}

// --------------------------------------------------------------------------- //
// Entry helpers
// --------------------------------------------------------------------------- //

export async function putEntries(store: ContextStore, id: string, entries: ContextEntry[]): Promise<ContextRecord> {
  return store.update(id, (ctx) => {
    for (const e of entries) ctx.entries[e.key] = e;
  });
}

export async function deleteEntry(store: ContextStore, id: string, key: string): Promise<boolean> {
  let existed = false;
  await store.update(id, (ctx) => {
    existed = key in ctx.entries;
    delete ctx.entries[key];
  });
  return existed;
}

export async function getEntry(store: ContextStore, id: string, key: string): Promise<ContextEntry | null> {
  const ctx = await store.get(id);
  return ctx.entries[key] ?? null;
}

/** Entries in insertion order (JSON object key order is preserved by both stores). */
export async function listEntries(store: ContextStore, id: string): Promise<ContextEntry[]> {
  const ctx = await store.get(id);
  return Object.values(ctx.entries);
}
