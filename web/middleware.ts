import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Front-end auth gate for the admin console. The backend remains authoritative
// for the API; this only keeps unauthenticated users from loading the SPA shell.
const SESSION_COOKIE = "tw_health_admin_session";

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Login page and API/WS (proxied to the backend) must stay reachable.
  if (
    pathname === "/admin/login" ||
    pathname.startsWith("/admin/api") ||
    pathname === "/admin/ws"
  ) {
    return NextResponse.next();
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (!req.cookies.get(SESSION_COOKIE)) {
      const url = req.nextUrl.clone();
      url.pathname = "/admin/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
