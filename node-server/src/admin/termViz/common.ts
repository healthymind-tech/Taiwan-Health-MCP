/**
 * Shared plumbing for the admin terminology explorer endpoints
 * (`GET /admin/api/terminology/*`, see router.ts).
 *
 * Every data function takes a `Q` (query runner) so the tree / graph logic can
 * be unit-tested against a fake without Postgres. Production passes `db.query`.
 *
 * Privacy: the explorer reads reference terminology only (codes and titles);
 * request parameters are search terms / codes and are never logged.
 */

export type Row = Record<string, unknown>;

/** Minimal query runner (matches `db.query`'s shape). */
export type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;

export class TermVizError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : String(v);
}

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Clamp an integer query parameter. */
export function intParam(v: unknown, def: number, min: number, max: number): number {
  const n = Number.parseInt(str(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Escape LIKE wildcards in user input (used with `ESCAPE '\\'`). */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Tiny TTL cache for whole-table derivations (chapter counts, WHO tree, PCS
 * prefix counts). Keyed by a caller-supplied version string (e.g. the edition's
 * loaded_at) so a re-import invalidates it immediately.
 */
export class VersionedCache<T> {
  private entries = new Map<string, { version: string; at: number; value: T }>();
  constructor(
    private ttlMs: number,
    private max = 16,
  ) {}

  async get(key: string, version: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.version === version && Date.now() - hit.at < this.ttlMs) {
      // LRU touch.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const value = await load();
    this.entries.set(key, { version, at: Date.now(), value });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** True when a table exists (optional tables added by later migrations). */
export async function tableExists(q: Q, qualified: string): Promise<boolean> {
  const r = await q("SELECT to_regclass($1) IS NOT NULL AS ok", [qualified]);
  return Boolean(r.rows[0]?.ok);
}

/** Contains CJK ideographs (Chinese titles): use strpos, the `simple` FTS tokenizer can't split them. */
export function hasCjk(s: string): boolean {
  return /[㐀-鿿豈-﫿]/.test(s);
}

/**
 * Prefix tsquery from free text ("type 2 diab" → "type:* & 2:* & diab:*"), or
 * null when nothing indexable remains. Tokens are reduced to letters/digits, so
 * the result is safe to pass to to_tsquery().
 */
export function ftsPrefixQuery(text: string): string | null {
  const toks = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !hasCjk(t))
    .slice(0, 8);
  return toks.length ? toks.map((t) => `${t}:*`).join(" & ") : null;
}
