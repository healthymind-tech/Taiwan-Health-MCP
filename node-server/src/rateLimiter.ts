/**
 * Per-profile rate limiter — RPM (requests per minute) and TPM (tokens per minute).
 *
 * Maintains a sliding window of requests per profile. Each entry stores the
 * request time and its token count, with running sums kept alongside so that a
 * check costs O(expired entries) rather than O(tokens). The window is pruned
 * before every check, so `canRequest()` and `waitUntilMs()` always see the same
 * state: "not allowed" always comes with a positive wait.
 *
 * Callers check `canRequest()` and optionally `waitUntilMs()` before a request,
 * and call `recordRequest()` afterwards with the tokens it consumed (including
 * calls whose reply was truncated — those tokens were still billed).
 */

interface WindowEntry {
  at: number;
  tokens: number;
}

interface RateLimitState {
  /** Entries in time order (oldest first); `head` marks the first live one. */
  entries: WindowEntry[];
  head: number;
  tokenSum: number;
}

const WINDOW_MS = 60_000; // 1 minute

/**
 * A profile's own (local) RPM/TPM budget is exhausted; no request was sent.
 * The endpoint is healthy, so callers must not feed this to the circuit breaker.
 */
export class ProfileRateLimited extends Error {
  constructor(
    message: string,
    readonly waitMs: number,
  ) {
    super(message);
    this.name = "ProfileRateLimited";
  }
}

const state = new Map<number, RateLimitState>();

function ensureState(profileId: number): RateLimitState {
  let s = state.get(profileId);
  if (!s) {
    s = { entries: [], head: 0, tokenSum: 0 };
    state.set(profileId, s);
  }
  return s;
}

/** Drop entries that have left the window. Amortised O(1) per entry. */
function prune(s: RateLimitState, now: number): void {
  const cutoff = now - WINDOW_MS;
  while (s.head < s.entries.length && s.entries[s.head].at <= cutoff) {
    s.tokenSum -= s.entries[s.head].tokens;
    s.head += 1;
  }
  // Compact occasionally so the array does not grow without bound.
  if (s.head > 1024 && s.head * 2 > s.entries.length) {
    s.entries = s.entries.slice(s.head);
    s.head = 0;
  }
  if (s.head === s.entries.length) {
    s.entries = [];
    s.head = 0;
    s.tokenSum = 0;
  }
}

function liveCount(s: RateLimitState): number {
  return s.entries.length - s.head;
}

interface ProfileRateLimit {
  rpm?: number;
  tpm?: number;
}

/**
 * Current usage in the sliding window (last minute).
 * Returns [usedRequests, usedTokens].
 */
function currentUsage(profileId: number): [requests: number, tokens: number] {
  const s = ensureState(profileId);
  prune(s, Date.now());
  return [liveCount(s), s.tokenSum];
}

/**
 * Can the profile make a request right now?
 * Returns { allowed: boolean, reason?: string }.
 */
export function canRequest(
  profileId: number,
  limits: ProfileRateLimit,
): { allowed: boolean; reason?: string } {
  const [requests, tokens] = currentUsage(profileId);

  if (limits.rpm && requests >= limits.rpm) {
    return { allowed: false, reason: `RPM limit (${limits.rpm}) reached` };
  }
  if (limits.tpm && tokens >= limits.tpm) {
    return { allowed: false, reason: `TPM limit (${limits.tpm}) reached` };
  }
  return { allowed: true };
}

/**
 * How many ms until the profile can make another request?
 * Returns 0 if it can now, or the ms to wait. Consistent with `canRequest()`:
 * after waiting the returned time (+1 ms), `canRequest()` is allowed unless new
 * requests were recorded in between.
 */
export function waitUntilMs(profileId: number, limits: ProfileRateLimit): number {
  const s = ensureState(profileId);
  const now = Date.now();
  prune(s, now);
  let earliestOpenTime = now;

  // RPM: the window reopens when enough of the oldest requests have expired
  // to bring the count below the limit.
  const count = liveCount(s);
  if (limits.rpm && count >= limits.rpm) {
    const mustExpire = count - limits.rpm + 1;
    const entry = s.entries[s.head + mustExpire - 1];
    earliestOpenTime = Math.max(earliestOpenTime, entry.at + WINDOW_MS);
  }

  // TPM: walk the oldest entries until the remaining sum drops below the limit.
  if (limits.tpm && s.tokenSum >= limits.tpm) {
    let remaining = s.tokenSum;
    for (let i = s.head; i < s.entries.length; i += 1) {
      remaining -= s.entries[i].tokens;
      if (remaining < limits.tpm) {
        earliestOpenTime = Math.max(earliestOpenTime, s.entries[i].at + WINDOW_MS);
        break;
      }
    }
  }

  return Math.max(0, earliestOpenTime - now);
}

/**
 * Record a request and the tokens it consumed. Call after every billed API
 * call — successful or truncated.
 */
export function recordRequest(profileId: number, tokenCount: number = 0): void {
  const s = ensureState(profileId);
  const now = Date.now();
  prune(s, now);
  const tokens = Number.isFinite(tokenCount) && tokenCount > 0 ? Math.floor(tokenCount) : 0;
  s.entries.push({ at: now, tokens });
  s.tokenSum += tokens;
}

/**
 * Reset all rate limit counters for a profile (e.g., on config change).
 */
export function resetProfile(profileId: number): void {
  state.delete(profileId);
}

/**
 * Reset all rate limiters.
 */
export function resetAll(): void {
  state.clear();
}

/**
 * Get current usage stats for debugging/monitoring.
 */
export function getStats(profileId: number): { requests: number; tokens: number } {
  const [requests, tokens] = currentUsage(profileId);
  return { requests, tokens };
}
