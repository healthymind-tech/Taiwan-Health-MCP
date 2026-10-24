/**
 * fhir_context — inspect or trim a per-task authoring context (get / list / delete).
 */

import { z } from "zod";
import { CONTEXT_IDLE_TTL_SECONDS } from "./contextStore.js";
import type { AuthoringService } from "./service.js";
import { authoringErrorEnvelope, errorEnvelope, invalidArgumentError, okEnvelope } from "./toolEnvelope.js";
import type { AuthoringToolSpec } from "./types.js";

export const CONTEXT_TOOL_NAME = "fhir_context";

export const contextToolDescription =
  "Inspect or trim the per-task authoring context that fhir_author_resources fills (context_id from its response). " +
  "action=list → every stored key with resourceType, profile, status (valid | invalid | refs_pending), refs, counts of missing / errors / warnings " +
  "— use it before fhir_assemble_bundle to check that every referenced key exists and nothing is invalid. action=get + key → that resource's " +
  "full result (resource, provenance, missing, refs, issues) exactly as fhir_author_resources returned it. action=delete + key → remove one " +
  "resource (e.g. authored under a wrong key); action=delete without key → discard the whole context when the task is finished. " +
  `Every call refreshes the context's ${CONTEXT_IDLE_TTL_SECONDS / 60}-min idle TTL; an unknown or expired context_id returns error.code ` +
  "CONTEXT_EXPIRED (start over with fhir_author_resources without context_id). Never changes a resource — fix values with " +
  "fhir_author_resources(merge=true).";

export const contextInputShape = {
  context_id: z.string().regex(/^[0-9a-f]{32}$/, "context_id is the 32-hex id returned by fhir_author_resources").describe("The task's context id (data.context_id of fhir_author_resources)."),
  action: z.enum(["get", "list", "delete"]).describe("list: all keys with status; get: one stored result (needs key); delete: one key, or the whole context without key."),
  key: z.string().min(1).max(128).nullish().default(null).describe("The resource key (required for get; optional for delete)."),
};

export function createContextTool(service: AuthoringService): AuthoringToolSpec {
  return {
    name: CONTEXT_TOOL_NAME,
    description: contextToolDescription,
    inputShape: contextInputShape,
    handler: async (args: Record<string, unknown>) => {
      const contextId = String(args.context_id ?? "");
      const action = String(args.action ?? "");
      const key = typeof args.key === "string" && args.key ? args.key : null;
      try {
        if (action === "get") {
          if (!key) return errorEnvelope(invalidArgumentError("action=get needs key", { parameter: "key" }));
          const r = await service.getEntry(contextId, key);
          if (!r) {
            return errorEnvelope({
              ...invalidArgumentError(`key "${key}" is not in context ${contextId}`, { key }),
              code: "KEY_NOT_FOUND",
              hint: "fhir_context action=list shows the stored keys; author it with fhir_author_resources (same context_id).",
              hint_zh: "用 fhir_context action=list 查看已儲存的 key；用 fhir_author_resources（同一 context_id）建立。",
              retryable: false,
            });
          }
          return okEnvelope(CONTEXT_TOOL_NAME, { context_id: contextId, storage: service.store.kind, result: r });
        }
        if (action === "list") {
          const entries = await service.listEntries(contextId);
          const pending = [...new Set(entries.flatMap((e) => e.refs.pending))].filter((k) => !entries.some((e) => e.key === k)).sort();
          return okEnvelope(CONTEXT_TOOL_NAME, {
            context_id: contextId,
            storage: service.store.kind,
            entries,
            summary: {
              total: entries.length,
              valid: entries.filter((e) => e.status === "valid").length,
              invalid: entries.filter((e) => e.status === "invalid").length,
              refs_pending: entries.filter((e) => e.status === "refs_pending").length,
              unauthored_referenced_keys: pending,
            },
          });
        }
        if (action === "delete") {
          if (key) {
            const existed = await service.deleteEntry(contextId, key);
            return okEnvelope(CONTEXT_TOOL_NAME, { context_id: contextId, storage: service.store.kind, deleted: existed ? [key] : [], note: existed ? null : `key "${key}" was not stored` });
          }
          const existed = await service.deleteContext(contextId);
          return okEnvelope(CONTEXT_TOOL_NAME, { context_id: contextId, storage: service.store.kind, deleted_context: existed });
        }
        return errorEnvelope(invalidArgumentError("action must be get | list | delete", { parameter: "action", allowed: ["get", "list", "delete"] }));
      } catch (e) {
        const env = authoringErrorEnvelope(e);
        if (env) return env;
        throw e;
      }
    },
  };
}
