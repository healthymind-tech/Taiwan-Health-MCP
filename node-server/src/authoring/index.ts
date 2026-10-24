/**
 * Registration of the authoring tools (coordinator): fhir_get_authoring_fields (A),
 * fhir_author_resources / fhir_context / fhir_assemble_bundle (C) over B's composer, wired into
 * the FHIR IG tool group of mcp.ts (`registerFhirIgTools` calls `registerAuthoringTools` last),
 * so the metrics / error-boundary / maintenance-gate wrappers that `captureToolRegistrations`
 * installs on `server.registerTool` apply to them like to every other tool.
 *
 * Contexts live in Redis (`authoring:ctx:*`, cache.ts' client) with an in-process memory
 * fallback; the store is a process-wide singleton created on the first tool call (after
 * server.ts has initialised Redis), not at registration time — buildMcpServer runs per MCP
 * session and the tool catalog registers against a placeholder service.
 *
 * Results are serialised with stringifyLossless so number spellings the model wrote
 * (12.50) survive into the stored resources and the assembled Bundle.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { getClient } from "../cache.js";
import type { FHIRIGService } from "../fhirIgService.js";
import type { GroundingToolDeps } from "../groundingTools.js";
import { stringifyLossless } from "../losslessJson.js";
import { createAssembleTool } from "./assembleTool.js";
import { createAuthorTool } from "./authorTool.js";
import { composeResource, keyToUrn } from "./compose.js";
import { makeComposer } from "./composeDeps.js";
import { createContextStore, type ContextStore } from "./contextStore.js";
import { createContextTool } from "./contextTools.js";
import { fieldsTool } from "./fieldsTool.js";
import { AuthoringService, productionDeps } from "./service.js";
import type { AuthoringToolSpec } from "./types.js";

export const AUTHORING_TOOL_NAMES = ["fhir_get_authoring_fields", "fhir_author_resources", "fhir_context", "fhir_assemble_bundle"] as const;

let _store: ContextStore | null = null;

/** The process-wide context store (Redis when cache.ts' client is connected, memory otherwise). */
export function authoringContextStore(): ContextStore {
  return (_store ??= createContextStore(getClient));
}

/** Test hook: replace the store singleton (e.g. with a MemoryContextStore). */
export function setAuthoringContextStore(store: ContextStore | null): void {
  _store = store;
}

/**
 * Lazily-built service behind a forwarding proxy: `svc` may be the tool catalog's placeholder
 * (any property access throws), so nothing dereferences it until a handler runs.
 */
function lazyService(svc: FHIRIGService, grounding: GroundingToolDeps): AuthoringService {
  let service: AuthoringService | null = null;
  const get = (): AuthoringService => (service ??= new AuthoringService(productionDeps(svc, authoringContextStore(), makeComposer(svc, composeResource), grounding, keyToUrn)));
  return new Proxy({} as AuthoringService, {
    get(_t, prop) {
      const real = get() as unknown as Record<string | symbol, unknown>;
      const v = real[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  });
}

/** Register the four authoring tools on `server` (called from registerFhirIgTools). */
export function registerAuthoringTools(server: McpServer, svc: FHIRIGService, grounding: GroundingToolDeps): void {
  const service = lazyService(svc, grounding);
  const specs: AuthoringToolSpec[] = [fieldsTool(), createAuthorTool(service), createContextTool(service), createAssembleTool(service)];
  for (const spec of specs) {
    server.registerTool(spec.name, { description: spec.description, inputSchema: spec.inputShape as z.ZodRawShape }, async (args: Record<string, unknown>, extra: { requestId?: string | number | null }) => ({
      content: [{ type: "text" as const, text: stringifyLossless(await spec.handler(args, extra)) }],
    }));
  }
}
