import { useEffect, useState } from "react";
import { useMediaQuery } from "@mantine/hooks";
import { em } from "@mantine/core";

/** Re-render on an interval (relative times, elapsed durations). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** True below the `sm` breakpoint (phones). */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${em(767)})`) ?? false;
}

/** Debounced value for search inputs. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Spinner state for a manual "重新整理" button that is independent of
 * background polling (so the button doesn't flicker on every interval refetch).
 */
export function useManualRefresh(run: () => Promise<unknown>[] | Promise<unknown>): { refreshing: boolean; refresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    const r = run();
    void Promise.allSettled(Array.isArray(r) ? r : [r]).finally(() => setRefreshing(false));
  };
  return { refreshing, refresh };
}
