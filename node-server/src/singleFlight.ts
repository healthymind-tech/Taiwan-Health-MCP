/**
 * Concurrent callers of a lazy initialiser share one in-flight call. The service getters in mcp.ts cache their
 * instance only after `initialize()` resolved, so the sessions opened together at startup each built their own
 * service — and each FHIRIGService its own ConceptIndex cache with its own byte budget, held by that session's tool
 * closures for as long as the session lived (local soak 2026-11-12: 646 MB of indexes under a 192 MB budget).
 * A finished call is forgotten: the getter's own cache answers later calls, and a failed initialisation is retried.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return () => {
    if (!inflight) {
      inflight = fn().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}
