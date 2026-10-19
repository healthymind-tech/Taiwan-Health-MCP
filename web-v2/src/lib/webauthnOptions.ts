import { useQuery } from "@tanstack/react-query";

/**
 * WebAuthn ceremony options fetched *before* the user clicks.
 *
 * Safari only allows navigator.credentials.create()/get() while the click's user
 * activation is still live; awaiting a network round-trip first makes it reject with
 * NotAllowedError ("cancelled or timed out") without ever showing the prompt. So the
 * options (whose challenge rides in a 5-minute HttpOnly cookie) are prefetched and
 * refreshed every 4 minutes, and the click handler calls startRegistration /
 * startAuthentication synchronously. Call `refetch()` after every attempt — the
 * challenge is single-use.
 */
export function usePrefetchedWebAuthnOptions<T>(key: string, fetcher: () => Promise<T>, opts: { enabled: boolean; paused: boolean }) {
  return useQuery({
    queryKey: ["webauthn-options", key],
    queryFn: fetcher,
    enabled: opts.enabled,
    staleTime: 240_000,
    // Never refresh mid-ceremony: a new challenge cookie would make the pending verify fail.
    refetchInterval: opts.paused ? false : 240_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: 1,
  });
}
