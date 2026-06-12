import { loadLegacy, withDarkMode, htmlResponse } from "@/lib/legacy";

// Data Processing Addendum — verbatim content + injected dark mode (migration fix).
export const dynamic = "force-static";

export function GET() {
  return htmlResponse(withDarkMode(loadLegacy("dpa.html")));
}
