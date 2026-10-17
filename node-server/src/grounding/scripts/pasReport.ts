/**
 * Dev script: TW PAS grounding evaluation report.
 *   cd node-server && node --import tsx src/grounding/scripts/pasReport.ts [--misses]
 *
 * Against a deployed server (records are still rendered from the static PAS terminology snapshot;
 * the check itself runs on the server with its DB terminology):
 *   ... pasReport.ts --url http://<host>:8090            # POST /tools/fhir_check_grounding (OpenAPI bridge)
 *   ... pasReport.ts --url http://<host>:8090 --mcp      # tools/call over MCP streamable HTTP (/mcp)
 */
import { evaluatePas, pasTerminology, type GroundingChecker } from "../pasEval.js";
import type { GroundingInput, GroundingResult } from "../checkGrounding.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Minimal MCP streamable-HTTP client (initialize once, then tools/call). */
async function mcpChecker(base: string): Promise<GroundingChecker> {
  const url = `${base.replace(/\/$/, "")}/mcp`;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  let id = 0;
  const rpc = async (method: string, params: unknown, notify = false): Promise<any> => {
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params };
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) headers["mcp-session-id"] = sid;
    const text = await r.text();
    if (notify) return null;
    const json = (r.headers.get("content-type") ?? "").includes("text/event-stream")
      ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? "{}")
      : JSON.parse(text);
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  };
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pasReport", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  return async (input: GroundingInput): Promise<GroundingResult> => {
    const res = await rpc("tools/call", { name: "fhir_check_grounding", arguments: input });
    const env = JSON.parse(res.content[0].text);
    if (!env.ok) throw new Error(JSON.stringify(env.error));
    return env.data as GroundingResult;
  };
}

function httpChecker(base: string): GroundingChecker {
  return async (input) => {
    const r = await fetch(`${base.replace(/\/$/, "")}/tools/fhir_check_grounding`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const env = (await r.json()) as { ok?: boolean; data?: unknown; error?: unknown };
    if (!env.ok) throw new Error(JSON.stringify(env.error ?? env));
    return env.data as GroundingResult;
  };
}

const base = arg("--url");
const check = base ? (process.argv.includes("--mcp") ? await mcpChecker(base) : httpChecker(base)) : undefined;
const t0 = performance.now();
const r = await evaluatePas(pasTerminology(), 1, check);
console.log(`checker: ${base ? `${base} (${process.argv.includes("--mcp") ? "MCP /mcp" : "POST /tools"})` : "in-process"}; ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(`PAS bundles ${r.bundles}, checked units ${r.units}`);
console.log(`supported records: bundles with errors ${r.supported.bundlesWithErrors}/${r.bundles}, errors ${r.supported.errors.length}, warnings ${r.supported.warnings}`);
for (const e of r.supported.errors.slice(0, 60)) console.log("  FP", e);
console.log(`admin timestamps (warning by policy): errors ${r.adminTimestamps.detected}/${r.adminTimestamps.total}`);
for (const [k, v] of Object.entries(r.byKind)) {
  console.log(`${k}: error ${v.detected}/${v.total} = ${(v.detected / Math.max(v.total, 1)).toFixed(3)}; warning-only ${v.warned ?? 0}; G-DERIVED info ${v.derived ?? 0}; silent ${v.total - v.detected - (v.warned ?? 0) - (v.derived ?? 0)}`);
  if (process.argv.includes("--misses")) for (const m of v.misses.filter((x) => process.argv.includes("--all") || x.endsWith("SILENT")).slice(0, 60)) console.log("   miss", m);
}
