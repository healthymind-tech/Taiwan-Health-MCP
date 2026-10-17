/**
 * Where to send the user after login, and how to build the login URL.
 *
 * `next` must never point back at /login: a 401 seen *on* the login page would
 * otherwise wrap the current URL in another `?next=` each time, growing an
 * unbounded /login?next=/login?next=… chain.
 */

/** A safe in-app path to return to (default "/"). Unwraps nested /login?next=… */
export function safeNext(raw: string | null | undefined): string {
  let next = raw ?? "";
  for (let i = 0; i < 8 && next.startsWith("/login"); i += 1) {
    const q = next.indexOf("?");
    next = q >= 0 ? (new URLSearchParams(next.slice(q + 1)).get("next") ?? "") : "";
  }
  // Same-origin paths only ("//host" would be protocol-relative).
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) return "/";
  return next;
}

/** Login URL that returns to `path` afterwards (path relative to the /admin basename). */
export function loginPath(path: string): string {
  const next = safeNext(path);
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
