/**
 * Bounded parallel dispatcher for indexed tasks (embedding batches).
 *
 * At most `concurrency()` tasks are in flight at once — the limit is re-read
 * every time a slot is about to be filled, so a caller can hot-reload it while
 * a long run is in progress. Tasks are dispatched strictly in index order and
 * each index runs exactly once.
 *
 * Stop semantics (pause / cancel): `shouldStop` is consulted before every task
 * after the first. Once it fires no new task is started; tasks already in flight
 * are awaited so their results land cleanly (they are idempotent upserts), and
 * the run returns `stopped: true`.
 *
 * Error semantics: the first task rejection stops further dispatch; in-flight
 * tasks are awaited, then that first error is rethrown.
 */

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 32;

/** Clamp an arbitrary (possibly junk) value into [MIN_CONCURRENCY, MAX_CONCURRENCY]. */
export function clampConcurrency(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  return Math.min(n, MAX_CONCURRENCY);
}

export interface BoundedPoolOptions {
  /** Number of tasks; tasks are identified by index 0..count-1. */
  count: number;
  /** Current in-flight limit; consulted before every dispatch. */
  concurrency: () => number;
  /** Runs one task. */
  task: (index: number) => Promise<void>;
  /** Cooperative stop hook, checked before dispatching each task after the first. */
  shouldStop?: () => boolean | Promise<boolean>;
}

export interface BoundedPoolResult {
  /** True when `shouldStop` fired before every task was dispatched. */
  stopped: boolean;
  /** Tasks that completed successfully. */
  completed: number;
  /** Tasks that were dispatched (completed + failed). */
  dispatched: number;
}

export async function runBoundedPool(opts: BoundedPoolOptions): Promise<BoundedPoolResult> {
  const { count, task, shouldStop } = opts;
  const inFlight = new Set<Promise<void>>();
  let next = 0;
  let completed = 0;
  let stopped = false;
  let failed = false;
  let firstError: unknown = null;

  while (next < count && !failed) {
    const limit = clampConcurrency(opts.concurrency());
    while (inFlight.size >= limit && !failed) {
      await Promise.race(inFlight);
    }
    if (failed) break;
    if (next > 0 && shouldStop && (await shouldStop())) {
      stopped = true;
      break;
    }
    const index = next;
    next += 1;
    const p: Promise<void> = task(index)
      .then(
        () => {
          completed += 1;
        },
        (err: unknown) => {
          if (!failed) {
            failed = true;
            firstError = err;
          }
        },
      )
      .finally(() => {
        inFlight.delete(p);
      });
    inFlight.add(p);
  }

  // Drain: whatever is already on the wire finishes (or fails) before we return.
  await Promise.all(inFlight);
  if (failed) throw firstError;
  return { stopped, completed, dispatched: next };
}
