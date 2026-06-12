import { loadLegacy, htmlResponse } from "@/lib/legacy";

// Landing page — served verbatim from the extracted legacy HTML.
export const dynamic = "force-static";

export function GET() {
  return htmlResponse(loadLegacy("landing.html"));
}
