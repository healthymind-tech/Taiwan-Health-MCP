/**
 * Per-profile rate limiter — RPM (requests per minute) and TPM (tokens per minute).
 *
 * Maintains a sliding window of requests/tokens per profile. Before each request,
 * callers check `canRequest()` and optionally `waitUntil()` for availability.
 * After a successful request, they call `recordRequest()` with token usage.
 */

interface RateLimitState {
  rpms: number[];
  tpms: number[];
  lastCleanupAt: number;
}

const WINDOW_MS = 60_000; // 1 minute
const CLEANUP_INTERVAL_MS = 10_000;

const state = new Map<number, RateLimitState>();

function ensureState(profileId: number): RateLimitState {
  if (!state.has(profileId)) {
    state.set(profileId, { rpms: [], tpms: [], lastCleanupAt: Date.now() });
  }
  return state.get(profileId)!;
}

function cleanup(s: RateLimitState): void {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  s.rpms = s.rpms.filter((ts) => ts > cutoff);
  s.tpms = s.tpms.filter((ts) => ts > cutoff);
  s.lastCleanupAt = now;
}

interface ProfileRateLimit {
  rpm?: number;
  tpm?: number;
}

/**
 * Current request count in the sliding window (last minute).
 * Returns [usedRequests, usedTokens].
 */
function currentUsage(
  profileId: number,
): [requests: number, tokens: number] {
  const s = ensureState(profileId);
  if (Date.now() - s.lastCleanupAt > CLEANUP_INTERVAL_MS) {
    cleanup(s);
  }
  return [s.rpms.length, s.tpms.reduce((sum, _) => sum + 1, 0)];
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
 * Returns 0 if it can now, or the ms to wait.
 */
export function waitUntilMs(
  profileId: number,
  limits: ProfileRateLimit,
): number {
  const s = ensureState(profileId);
  if (Date.now() - s.lastCleanupAt > CLEANUP_INTERVAL_MS) {
    cleanup(s);
  }

  const now = Date.now();
  let earliestOpenTime = now;

  // Check RPM limit
  if (limits.rpm && s.rpms.length >= limits.rpm) {
    const oldest = s.rpms[0];
    const reopenAt = oldest + WINDOW_MS;
    if (reopenAt > earliestOpenTime) {
      earliestOpenTime = reopenAt;
    }
  }

  // Check TPM limit
  if (limits.tpm && s.tpms.length >= limits.tpm) {
    const oldest = Math.min(...s.tpms);
    const reopenAt = oldest + WINDOW_MS;
    if (reopenAt > earliestOpenTime) {
      earliestOpenTime = reopenAt;
    }
  }

  return Math.max(0, earliestOpenTime - now);
}

/**
 * Record a successful request. Call this after a successful API call.
 */
export function recordRequest(
  profileId: number,
  tokenCount: number = 0,
): void {
  const s = ensureState(profileId);
  const now = Date.now();

  // Record the request timestamp (for RPM)
  s.rpms.push(now);

  // Record token timestamps (for TPM)
  if (tokenCount > 0) {
    for (let i = 0; i < tokenCount; i++) {
      s.tpms.push(now);
    }
  }

  // Cleanup if needed
  if (Date.now() - s.lastCleanupAt > CLEANUP_INTERVAL_MS) {
    cleanup(s);
  }
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
