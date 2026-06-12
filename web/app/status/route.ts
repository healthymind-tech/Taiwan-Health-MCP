import { loadLegacy, htmlResponse } from "@/lib/legacy";

// Status & Tool Tester — verbatim interactive page. The three JS constants that
// Python injected at build time are instead fetched live from the backend's
// /status.json at request time, so the tool catalog tracks the registered tools.
export const dynamic = "force-dynamic";

const BACKEND = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

interface StatusData {
  category_map?: unknown;
  tool_examples?: unknown;
  tool_selector_examples?: unknown;
}

export async function GET() {
  const tpl = loadLegacy("status.html");
  let data: StatusData = {};
  try {
    const r = await fetch(`${BACKEND}/status.json`, { cache: "no-store" });
    if (r.ok) data = (await r.json()) as StatusData;
  } catch {
    // Backend unreachable — render with empty catalog rather than 500.
  }
  const html = tpl
    .replace('"__CATEGORY_MAP__"', JSON.stringify(data.category_map ?? {}))
    .replace('"__TOOL_EXAMPLES__"', JSON.stringify(data.tool_examples ?? {}))
    .replace('"__TOOL_SELECTOR_EXAMPLES__"', JSON.stringify(data.tool_selector_examples ?? {}));
  return htmlResponse(html);
}
