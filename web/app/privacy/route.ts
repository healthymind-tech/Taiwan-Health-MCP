import { loadLegacy, withDarkMode, htmlResponse } from "@/lib/legacy";

// Privacy Policy — verbatim content + injected dark mode (migration fix).
export const dynamic = "force-static";

export function GET() {
  return htmlResponse(withDarkMode(loadLegacy("privacy.html")));
}
