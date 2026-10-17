/**
 * Production wiring for adminMcp.ts (kept apart so the router stays testable with fakes).
 */

import { config } from "../config.js";
import { query } from "../db.js";
import { logInfo } from "../logger.js";
import {
  GROUP_MAINTENANCE_MODULE,
  SERVER_NAME,
  TOOL_GROUPS,
  WRITE_CAPABLE_TOOLS,
  buildMcpServer,
  catalogToolInputSchema,
  invokeRegisteredTool,
  registeredToolNames,
  toolCatalog,
  toolRegistryReady,
} from "../mcp.js";
import { getModuleCounts, getModuleStatus } from "../moduleStatus.js";
import { getStates as getMaintenanceStates } from "./adminMaintenance.js";
import { BUILD, SERVER_VERSION } from "../toolVersions.js";
import { LEXICON_VERSION } from "../grounding/index.js";
import { InvokeRateLimiter, INVOKE_LIMIT_PER_MINUTE, type McpAdminDeps } from "./adminMcp.js";

async function listFhirServers(): Promise<Array<{ id: string; server_key: string; token_auth_method: string | null }>> {
  try {
    const r = await query<{ id: string; server_key: string; token_auth_method: string | null }>(
      "SELECT fhir_server_id::text AS id, server_key, token_auth_method FROM admin.fhir_servers ORDER BY server_key",
    );
    return r.rows;
  } catch {
    return [];
  }
}

/** Real dependencies; `publicBaseUrl` is resolved per request (PUBLIC_BASE_URL, else the request origin). */
export function productionMcpAdminDeps(publicBaseUrl: string): McpAdminDeps {
  const cfg = config();
  return {
    refreshRegistry: async () => {
      await buildMcpServer();
    },
    ensureRegistry: async () => {
      if (!toolRegistryReady()) await buildMcpServer();
    },
    registeredNames: registeredToolNames,
    catalog: toolCatalog,
    groups: () => TOOL_GROUPS,
    writeCapable: () => WRITE_CAPABLE_TOOLS,
    inputSchema: catalogToolInputSchema,
    invoke: invokeRegisteredTool,
    moduleStatus: () => getModuleStatus(),
    moduleCounts: () => getModuleCounts(),
    maintenanceModules: () => GROUP_MAINTENANCE_MODULE,
    maintenanceStates: () => getMaintenanceStates(),
    overviewInfo: async () => ({
      serverName: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      build: BUILD,
      lexiconVersion: LEXICON_VERSION,
      mcpPath: cfg.path,
      publicBaseUrl,
      authMode: cfg.publicToolsAuthMode,
      bearerConfigured: Boolean(cfg.publicToolsBearerToken),
      corsOrigins: cfg.publicToolsCorsOrigins,
      fhirServers: await listFhirServers(),
    }),
    now: () => performance.now(),
    log: (message, extra) => logInfo(message, extra),
  };
}

/** Process-wide limiter for playground invocations (per admin user). */
export const mcpInvokeLimiter = new InvokeRateLimiter(INVOKE_LIMIT_PER_MINUTE, () => Date.now());
