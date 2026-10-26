/**
 * Registration of the IG structure tools (ISSUES_v16 R1 / R2): fhir_get_bundle_blueprint and
 * fhir_get_minimal_skeleton, in the FHIR IG tool group of mcp.ts (`registerFhirIgTools` calls
 * `registerBlueprintTools`), so the metrics / error-boundary / maintenance-gate wrappers apply to
 * them like to every other tool. Nothing is touched at registration time (the DB deps are lazy).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { blueprintTools } from "./tools.js";

export const BLUEPRINT_TOOL_NAMES = ["fhir_get_bundle_blueprint", "fhir_get_minimal_skeleton"] as const;

export function registerBlueprintTools(server: McpServer): void {
  for (const spec of blueprintTools()) {
    server.registerTool(spec.name, { description: spec.description, inputSchema: spec.inputShape as z.ZodRawShape }, async (args: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await spec.handler(args)) }],
    }));
  }
}
