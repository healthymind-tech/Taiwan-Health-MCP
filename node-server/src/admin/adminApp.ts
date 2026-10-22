/**
 * Admin console HTTP surface — gate + auth + read-only REST endpoints.
 *
 * Faithful port of the inline `/admin/*` dispatcher in `src/server.py`
 * (the long method+path if-chain starting at the admin-route block). This
 * Express middleware reproduces the gate ordering exactly:
 *   1. admin disabled              -> 404 "Not Found"
 *   2. admin enabled but not ready -> 503 JSON (api) / 503 (page)
 *   3. resolve session username from the signed cookie
 *   4. login/logout (form + JSON aliases) — must precede the auth gate
 *   5. unauthenticated /admin/api/* -> 401 JSON; other -> redirect /admin/login
 *   6. GET /admin/api/health -> db health snapshot (never gated)
 *   7. DB-health gate: /admin/api/* -> 503 while DB unavailable
 *   8. read-only endpoint dispatch
 *
 * The Next.js front door owns the admin SPA + login page, so legacy HTML is off
 * by default: non-API admin GETs fall through to 404 here (mirroring
 * `_LEGACY_HTML_PAGES` being false).
 */

import type { Request, Response, NextFunction } from "express";
import { config, adminReady, type AppConfig } from "../config.js";
import { monitor as dbHealthMonitor } from "../dbHealth.js";
import {
  buildAdminSessionToken,
  buildAdminSessionCookie,
  clearAdminSessionCookie,
  parseAdminSessionToken,
  parseCookieHeader,
  SESSION_COOKIE_NAME,
} from "../adminAuth.js";
import { changePassword, verifyPassword } from "./adminCredentials.js";
import { listBackups, openBackupDownload } from "./adminBackup.js";
import * as adminSettings from "./adminSettings.js";
import * as ocrTestSamples from "./ocrTestSamples.js";
import {
  listWorkerHeartbeats,
  listJobs,
  getJob,
  listJobSteps,
  listJobLogs,
  createJob,
  requestJobControl,
  ADMIN_JOB_TYPES,
  sortedAdminJobTypes,
  JobValueError,
} from "./adminJobs.js";
import { listServiceProbes, runServiceProbes, ValueError as ServiceProbeValueError } from "./adminServices.js";
import {
  listIgs,
  getIgDetail,
  setDefault as setIgDefault,
  removeIg,
  removalImpact as igRemovalImpact,
  listUnusedDependencies as listUnusedIgDependencies,
  removeUnusedDependencies as removeUnusedIgDependencies,
  listMissingDependencies,
  queueDependencyImport,
  missingForIg,
  isInstalled as isIgInstalled,
  inspectUploadedIg,
} from "./adminIg.js";
import { parseDependencyRequest } from "./igDependencies.js";
import { conceptIndexStatus, deleteSupplement, listSupplements, queueConceptIndexRebuild, restoreBundledSupplements, saveSupplement } from "./igSupplements.js";
import { query } from "../db.js";
import { broadcast } from "./adminWs.js";
import { clearModule, previewModuleClear, ModuleClearError, type ClearScope } from "./adminModuleClear.js";
import {
  listFhirServers,
  getFhirServer,
  exportFhirServers,
  createFhirServer,
  updateFhirServer,
  deleteFhirServer,
  setDefaultFhirServer,
  generateClientKey,
  discoverFhirMetadata,
  testFhirServerConfig,
  runFhirTestRequest,
  probeFhirServer,
  fhirServerSecretKey,
  FhirServerValueError,
} from "./adminFhirServers.js";
import {
  attachOauthStatus,
  startAuthorization,
  refreshTokenNow,
  clearOauthState,
  OAuthError,
} from "./fhirOauthService.js";
import {
  getSchedule,
  upsertSchedule,
  deleteSchedule,
  fireSchedule,
  SCHEDULABLE_MODULES,
  URL_FETCH_MODULES,
  ScheduleValueError,
} from "./adminSchedule.js";
import type { FireScheduleInput } from "./adminSchedule.js";
import {
  listSourceVersions,
  listSourceCatalog,
  moduleRecordCounts,
  createUploadedSource,
  activateSource,
  deactivateSource,
  deleteUploadedSource,
  catalogEntry,
  validateSourceFilename,
  validateSourceContent,
  SourceValueError,
  SourceRuntimeError,
} from "./adminSources.js";
import { getEmbeddingStatus } from "./adminEmbedding.js";
import {
  beginRegistration,
  finishRegistration,
  beginAuthentication,
  finishAuthentication,
  listCredentials,
  deleteCredential,
  buildChallengeCookie,
  clearChallengeCookie,
  readChallengeCookie,
} from "./webauthn.js";
import { getDrugAdminStatus, getDrugPipelineStatus, getDrugLicenseEvents } from "./adminDrug.js";
import { getDrugExplorer, getDrugExplorerDetail } from "./adminDrugExplorer.js";
import { listDrugLlmCalls, getDrugLlmCall } from "./llmCallLog.js";
import { getStates as getMaintenanceStates, setEnabled as setMaintenanceEnabled, MaintenanceValueError } from "./adminMaintenance.js";
import * as minioService from "../minioService.js";
import { buildAdminOverview } from "./adminOverview.js";
import { searchWithFallback as registrySearchWithFallback } from "../loaders/igRegistry.js";
import { getDrugService as getDrugServiceForAdmin } from "../mcp.js";
import { RawJson, stringifyLossless } from "../losslessJson.js";
import { parseByteRange } from "./drugAssetResponse.js";
import { reconfigureEmbeddingService } from "../embeddingService.js";
import { logWarning } from "../logger.js";
import { codeFields, errorFields } from "./llmErrorCodes.js";
import {
  enrichErrorBody,
  explainFhirConnection,
  withFhirProbeErrorExplanation,
  explainInfrastructure,
  explainProbe,
  explainServiceTest,
  withJobErrorExplanation,
  workerOfflineWarning,
  type ProbeRowLike,
} from "./adminErrorCodes.js";
import { precheckJobCreate } from "./jobPrechecks.js";
import { ProfileValidationError } from "./llmProfiles.js";
import { dispatchPreview, PREVIEW_SUPPORTED_MODULES } from "./adminPreview.js";

/**
 * Send a JSON body with the same content-type Python `_send_json` uses.
 * Error bodies (status ≥ 400) gain `code` / `message_zh` / `hint_zh` so the
 * console can say what happened and what to do (adminErrorCodes.ts); the
 * original `error` / `detail` fields are kept.
 */
function sendJson(res: Response, status: number, payload: unknown): void {
  sendRawJson(res, status, enrichErrorBody(status, payload));
}

/**
 * `{ worker_warning }` when no admin-worker is heartbeating, so a response that
 * queued a job can tell the operator it will not start yet. Best-effort.
 */
async function workerWarningFields(): Promise<Record<string, unknown>> {
  try {
    const w = workerOfflineWarning(await listWorkerHeartbeats());
    return w ? { worker_warning: w } : {};
  } catch {
    return {};
  }
}

/** Add zh-TW explanations to the `services` rows of a probe payload. */
function withProbeExplanations(payload: Record<string, unknown>): Record<string, unknown> {
  const explain = (rows: unknown): unknown => (Array.isArray(rows) ? (rows as ProbeRowLike[]).map((r) => explainProbe(r)) : rows);
  return { ...payload, services: explain(payload.services), history: explain(payload.history) };
}

/** sendJson without error enrichment — for APIs that attach their own codes (LLM / model endpoints). */
function sendRawJson(res: Response, status: number, payload: unknown): void {
  // stringifyLossless ≡ JSON.stringify unless the payload carries a RawJson / RawNumber (MCP playground result).
  res.status(status).set("content-type", "application/json; charset=utf-8").send(stringifyLossless(payload));
}

const OAUTH_CALLBACK_PATH = "/fhir-oauth/callback";

/**
 * Mirror Python `_oauth_redirect_uri`: prefer the configured PUBLIC_BASE_URL,
 * else the request origin behind a trusted proxy (X-Forwarded-* aware).
 */
export function oauthRedirectUri(req: Request): string {
  const cfg = config();
  let base = cfg.publicBaseUrl;
  if (!base) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || req.protocol || "http";
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    base = host ? `${proto}://${host}` : "";
  }
  return base ? `${base.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}` : OAUTH_CALLBACK_PATH;
}

/** Public origin for user-facing URLs: PUBLIC_BASE_URL, else the request origin (proxy-aware). */
export function publicBaseUrlFromReq(req: Request): string {
  const configured = config().publicBaseUrl;
  if (configured) return configured.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || req.protocol || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

/** Mirror Python `_send_404`: status 404, body "Not Found". */
function send404(res: Response): void {
  res.status(404).set("content-length", "9").send("Not Found");
}

function adminUsernameFromReq(req: Request): string | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  const cfg = config();
  return parseAdminSessionToken(cookies[SESSION_COOKIE_NAME], cfg.adminSessionSecret);
}

/** True for `/admin` and any `/admin/...` path (mirrors Python is_admin_route). */
export function isAdminRoute(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

export async function adminHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  const path = req.path;
  const method = req.method;
  if (!isAdminRoute(path)) {
    next();
    return;
  }

  const cfg = config();

  // 1. Admin disabled → 404 (route does not exist).
  if (!cfg.adminEnabled) {
    send404(res);
    return;
  }

  // 2. Enabled but not fully configured → 503.
  if (!adminReady(cfg)) {
    const message = "Admin console is enabled but not fully configured.";
    if (path.startsWith("/admin/api/")) {
      sendJson(res, 503, {
        error: message,
        hint:
          "Set ADMIN_USERNAME, ADMIN_SESSION_SECRET, and a password source " +
          "(ADMIN_INITIAL_PASSWORD, or ADMIN_PASSWORD_HASH for a pre-computed hash).",
      });
    } else {
      // Login UI owned by the Next.js front door; legacy HTML off → plain 503.
      res.status(503).set("content-type", "text/html; charset=utf-8").send(message);
    }
    return;
  }

  const adminUsername = adminUsernameFromReq(req);

  // 4a. GET /admin/login — front door owns the page (legacy off → 404 / redirect).
  if (method === "GET" && path === "/admin/login") {
    if (adminUsername) res.redirect(303, "/admin");
    else send404(res);
    return;
  }

  // 4b. POST /admin/login (form) — success redirect+cookie; failure 401.
  if (method === "POST" && path === "/admin/login") {
    const { username, password } = readCredentials(req);
    if (await verifyPassword(username, password)) {
      setSessionCookie(res, cfg, username);
      res.redirect(303, "/admin");
    } else {
      // Legacy-only failure HTML (build_admin_login_html) is owned by the front
      // door when LEGACY_HTML is off; return the same 401 status with a minimal
      // body. This path is unreachable in the Next.js-fronted deployment.
      res.status(401).set("content-type", "text/html; charset=utf-8").send("Invalid username or password.");
    }
    return;
  }

  // 4c. POST /admin/logout (form) — clear cookie, redirect.
  if (method === "POST" && path === "/admin/logout") {
    res.set("set-cookie", clearAdminSessionCookie(cfg.adminCookieSecure));
    res.redirect(303, "/admin/login");
    return;
  }

  // 4d. JSON aliases for the SPA. MUST precede the auth gate.
  if (method === "POST" && path === "/admin/api/login") {
    const { username, password } = readCredentials(req);
    if (await verifyPassword(username, password)) {
      setSessionCookie(res, cfg, username);
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 401, { ok: false, error: "Invalid username or password." });
    }
    return;
  }

  if (method === "POST" && path === "/admin/api/logout") {
    res.set("set-cookie", clearAdminSessionCookie(cfg.adminCookieSecure));
    sendJson(res, 200, { ok: true });
    return;
  }

  // 4e. Passkey login ceremony (unauthenticated — mirrors password login above).
  // Only the single configured admin user can hold passkeys.
  if (method === "POST" && path === "/admin/api/passkeys/login/options") {
    try {
      const options = await beginAuthentication(cfg.adminUsername);
      res.append("set-cookie", buildChallengeCookie({ c: options.challenge, t: "auth", u: cfg.adminUsername }));
      sendJson(res, 200, options);
    } catch (exc) {
      sendJson(res, 500, { error: "Failed to start passkey login", detail: String((exc as Error).message) });
    }
    return;
  }

  if (method === "POST" && path === "/admin/api/passkeys/login/verify") {
    const challenge = readChallengeCookie(req, "auth");
    if (!challenge) {
      res.append("set-cookie", clearChallengeCookie());
      sendJson(res, 401, { ok: false, error: "Passkey challenge expired. Please try again." });
      return;
    }
    try {
      const ok = await finishAuthentication(cfg.adminUsername, req.body as never, challenge.c);
      if (ok) {
        setSessionCookie(res, cfg, cfg.adminUsername); // res.set(set-cookie) — must precede appends
        res.append("set-cookie", clearChallengeCookie()); // single-use challenge
        sendJson(res, 200, { ok: true });
      } else {
        res.append("set-cookie", clearChallengeCookie());
        sendJson(res, 401, { ok: false, error: "Passkey could not be verified." });
      }
    } catch (exc) {
      res.append("set-cookie", clearChallengeCookie());
      sendJson(res, 401, { ok: false, error: "Passkey could not be verified.", detail: String((exc as Error).message) });
    }
    return;
  }

  // 5. Auth gate.
  if (!adminUsername) {
    if (path.startsWith("/admin/api/")) {
      sendJson(res, 401, { error: "Authentication required", hint: "Sign in at /admin/login first." });
    } else {
      res.redirect(303, "/admin/login");
    }
    return;
  }

  // 5b. Who am I — lets the SPA show the signed-in operator (cookie is HttpOnly).
  if (method === "GET" && path === "/admin/api/me") {
    sendJson(res, 200, { username: adminUsername, session_ttl_minutes: cfg.adminSessionTtlMinutes });
    return;
  }

  // 6. DB health endpoint — always available (never gated).
  if (method === "GET" && path === "/admin/api/health") {
    sendJson(res, 200, dbHealthMonitor().snapshot());
    return;
  }

  // 7. DB-health gate — block every other admin API op while DB is unavailable.
  if (path.startsWith("/admin/api/") && !dbHealthMonitor().isHealthy()) {
    sendJson(res, 503, {
      error: "database_unavailable",
      message: "Operations are paused until the database recovers.",
      db_status: dbHealthMonitor().snapshot(),
    });
    return;
  }

  // 8. Non-API admin GET (page navigation) belongs to the Next.js front door.
  if (method === "GET" && !path.startsWith("/admin/api/")) {
    send404(res);
    return;
  }

  // ── Read-only endpoint dispatch ──────────────────────────────────────────
  try {
    // Passkeys (authenticated): register / list / delete. Registration is bound
    // to the logged-in admin (adminUsername from the session).
    if (method === "GET" && path === "/admin/api/passkeys") {
      sendJson(res, 200, { credentials: await listCredentials(adminUsername) });
      return;
    }

    if (method === "POST" && path === "/admin/api/passkeys/register/options") {
      const options = await beginRegistration(adminUsername);
      res.append("set-cookie", buildChallengeCookie({ c: options.challenge, t: "reg", u: adminUsername }));
      sendJson(res, 200, options);
      return;
    }

    if (method === "POST" && path === "/admin/api/passkeys/register/verify") {
      const challenge = readChallengeCookie(req, "reg");
      res.append("set-cookie", clearChallengeCookie());
      if (!challenge || challenge.u !== adminUsername) {
        sendJson(res, 400, { error: "Passkey challenge expired. Please try again." });
        return;
      }
      const body = (req.body ?? {}) as { response?: unknown; label?: unknown };
      const label = typeof body.label === "string" ? body.label : null;
      try {
        const credential = await finishRegistration(
          adminUsername,
          (body.response ?? body) as never,
          challenge.c,
          label,
        );
        sendJson(res, 200, { ok: true, credential });
      } catch (exc) {
        sendJson(res, 400, { error: "Passkey registration failed", detail: String((exc as Error).message) });
      }
      return;
    }

    if (method === "DELETE" && path.startsWith("/admin/api/passkeys/")) {
      const id = decodeURIComponent(path.slice("/admin/api/passkeys/".length));
      if (!id) {
        sendJson(res, 400, { error: "Missing credential id." });
        return;
      }
      const removed = await deleteCredential(adminUsername, id);
      sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "Passkey not found." });
      return;
    }

    if (method === "POST" && path === "/admin/api/privacy/password") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        await changePassword({
          username: adminUsername,
          currentPassword: String(body.current_password ?? ""),
          newPassword: String(body.new_password ?? ""),
        });
        sendJson(res, 200, { ok: true });
      } catch (exc) {
        const message = String((exc as Error).message);
        sendJson(res, 400, { error: message });
      }
      return;
    }

    if (method === "GET" && path === "/admin/api/backups") {
      sendJson(res, 200, { backups: await listBackups() });
      return;
    }

    const backupDownloadMatch = /^\/admin\/api\/backups\/([0-9a-fA-F-]+)\/download$/.exec(path);
    if (method === "GET" && backupDownloadMatch) {
      try {
        const artifact = await openBackupDownload(backupDownloadMatch[1]);
        const safeFilename = artifact.filename.replace(/["\\\r\n]/g, "_");
        res
          .status(200)
          .set("content-type", "application/zip")
          .set("content-disposition", `attachment; filename="${safeFilename}"`)
          .set("cache-control", "no-store");
        artifact.stream.once("error", (error) => {
          if (!res.headersSent) sendJson(res, 502, { error: "Backup download failed", detail: String(error.message) });
          else res.destroy(error);
        });
        artifact.stream.pipe(res);
      } catch (exc) {
        const message = String((exc as Error).message);
        sendJson(res, message === "Backup not found" ? 404 : 409, { error: message });
      }
      return;
    }

    // GET /admin/api/registry/search?q=...  (FHIR package registry autocomplete)
    if (method === "GET" && path === "/admin/api/registry/search") {
      const q = String(req.query.q ?? "");
      try {
        const cfg = await adminSettings.getGroup("registry");
        const out = await registrySearchWithFallback(String(cfg.base_url ?? ""), q);
        sendJson(res, 200, out);
      } catch (exc) {
        sendJson(res, 502, {
          error: "Registry search failed",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    if (method === "GET" && path === "/admin/api/overview") {
      try {
        const overview = (await buildAdminOverview()) as unknown as Record<string, unknown>;
        if (overview.infrastructure && typeof overview.infrastructure === "object") {
          overview.infrastructure = explainInfrastructure(overview.infrastructure as Record<string, { status: string; detail: string }>);
        }
        sendJson(res, 200, overview);
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to build admin overview",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    if (method === "GET" && path === "/admin/api/settings") {
      try {
        // Custom serialize so integer-valued float fields render as `N.0`
        // (Python json.dumps(float) parity — see serializeSettingsResponse).
        res
          .status(200)
          .set("content-type", "application/json; charset=utf-8")
          .send(adminSettings.serializeSettingsResponse(await adminSettings.getAll()));
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load settings", detail: String((exc as Error).message) });
      }
      return;
    }

    // ── FHIR profile viewer (read-only; before the /igs/{id}/{version} routes) ──
    if (path === "/admin/api/igs/profile" || path.startsWith("/admin/api/igs/profile/")) {
      const { handleIgProfileApi, defaultProfileApiDeps } = await import("./igProfileApi.js");
      const out = await handleIgProfileApi(await defaultProfileApiDeps(), method, path, req.query as Record<string, unknown>);
      if (out) {
        sendJson(res, out.status, out.body);
        return;
      }
    }

    // ── Terminology explorer (read-only tree / graph / facet views) ─────────
    if (path.startsWith("/admin/api/terminology/")) {
      const { handleTerminologyApi } = await import("./termViz/router.js");
      const { query: dbQuery } = await import("../db.js");
      const out = await handleTerminologyApi(
        (sql, params) => dbQuery(sql, params as unknown[]),
        method,
        path,
        req.query as Record<string, unknown>,
      );
      if (out) {
        sendJson(res, out.status, out.body);
        return;
      }
    }

    // ── IG explorer (read-only IG detail page: composition, artifacts, CodeSystems) ──
    if (path.startsWith("/admin/api/ig-explorer/")) {
      const { handleIgExplorerApi } = await import("./igExplorer.js");
      const { query: dbQuery } = await import("../db.js");
      const out = await handleIgExplorerApi((sql, params) => dbQuery(sql, params as unknown[]), method, path, req.query as Record<string, unknown>);
      if (out) {
        sendJson(res, out.status, out.body);
        return;
      }
    }

    // ── MCP 工具: endpoint overview, tool catalog, playground (/admin/api/mcp/*) ──
    if (path.startsWith("/admin/api/mcp/")) {
      const { handleMcpApi } = await import("./adminMcp.js");
      const { productionMcpAdminDeps, mcpInvokeLimiter } = await import("./adminMcpDeps.js");
      try {
        const out = await handleMcpApi(
          productionMcpAdminDeps(publicBaseUrlFromReq(req)),
          mcpInvokeLimiter,
          method,
          path,
          (req.body ?? {}) as Record<string, unknown>,
          adminUsername,
        );
        if (out) {
          // The playground result is the tool's JSON text spliced in verbatim (number spellings kept, as POST /tools/<name>).
          const body = out.resultText !== undefined && out.body && typeof out.body === "object" ? { ...(out.body as Record<string, unknown>), result: new RawJson(out.resultText) } : out.body;
          sendJson(res, out.status, body);
          return;
        }
      } catch (exc) {
        sendJson(res, 500, { error: "mcp_admin_failed", detail: String((exc as Error).message) });
        return;
      }
    }

    // ── Provider registry: what each vendor supports, for the profile form ───
    if (method === "GET" && path === "/admin/api/llm-providers") {
      const { providerSpecs } = await import("../providers/registry.js");
      sendJson(res, 200, { providers: providerSpecs() });
      return;
    }

    // ── Provider accounts, profiles, role bindings (/admin/api/llm/*) ────────
    if (path.startsWith("/admin/api/llm/")) {
      const { handleLlmApi } = await import("./adminLlmApi.js");
      await handleLlmApi(
        method,
        path,
        (req.body ?? {}) as Record<string, unknown>,
        adminUsername,
        (status, payload) => sendRawJson(res, status, payload),
        async () => {
          await refreshSettingsSingletons("embedding");
          await refreshSettingsSingletons("analysis");
        },
      );
      return;
    }

    // GET /admin/api/settings/export — the stored settings as a portable file.
    // The body carries secrets in the clear (that is the point: it must restore a
    // working configuration), so it is served as a download and never cached.
    if (method === "GET" && path === "/admin/api/settings/export") {
      try {
        const doc = await adminSettings.exportSettings();
        const stamp = doc.exported_at.slice(0, 10);
        res
          .status(200)
          .set("content-type", "application/json; charset=utf-8")
          .set("content-disposition", `attachment; filename="tw-health-settings-${stamp}.json"`)
          .set("cache-control", "no-store")
          .send(JSON.stringify(doc, null, 2));
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to export settings", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/settings/import — apply a previously exported file.
    if (method === "POST" && path === "/admin/api/settings/import") {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        // Accept the raw export document, or one wrapped as {document: {...}}.
        const doc = body.document ?? body;
        const result = await adminSettings.importSettings(doc, adminUsername);
        for (const group of result.groups) await refreshSettingsSingletons(group);
        sendJson(res, 200, result);
      } catch (exc) {
        const msg = String((exc as Error).message);
        // A rejected LLM section (validation, fingerprint) is the document's fault: 400, nothing was changed.
        if (exc instanceof ProfileValidationError) {
          sendJson(res, (exc as { status?: number }).status ?? 400, { error: msg, detail: msg, ...errorFields(exc) });
        } else if (/Unsupported settings export version|Malformed export|is not one of|is not a valid|is not an integer|is not a number|is out of range/.test(msg)) {
          sendJson(res, 400, { error: msg });
        } else {
          sendJson(res, 500, { error: "Failed to import settings", detail: msg });
        }
      }
      return;
    }

    // POST /admin/api/settings/{group}[/{action}] — models | test | save (bare).
    // Mirrors server.py's `rest.split("/")` → group, action dispatch.
    if (method === "POST" && path.startsWith("/admin/api/settings/")) {
      const rest = path.slice("/admin/api/settings/".length);
      const parts = rest.split("/");
      const group = parts[0];
      const action = parts.length > 1 ? parts[1] : "";
      const body = (req.body ?? {}) as Record<string, unknown>;
      const values = (body.values ?? {}) as Record<string, unknown>;
      try {
        if (action === "models") {
          sendJson(res, 200, await adminSettings.listModels(group, values));
        } else if (action === "test") {
          sendJson(res, 200, explainServiceTest(group, await adminSettings.testGroup(group, values)));
        } else if (action === "") {
          const saved = await adminSettings.saveGroup(group, values, adminUsername);
          await refreshSettingsSingletons(group);
          // Saving never blocks on reachability, but say right away when the
          // saved endpoint does not answer (instead of failing jobs later).
          let connection: Record<string, unknown> | undefined;
          if (group === "ocr" || group === "tfda") {
            const probe = adminSettings.testGroup(group, saved as Record<string, unknown>).then((r) => explainServiceTest(group, r) as unknown as Record<string, unknown>);
            const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 6000));
            connection = await Promise.race([probe, timeout]).catch(() => undefined);
          }
          sendJson(res, 200, { ok: true, values: saved, ...(connection ? { connection } : {}) });
        } else {
          sendJson(res, 404, { error: `Unknown action '${action}'` });
        }
      } catch (exc) {
        // Python raises ValueError → 400; any other exception → 500.
        const msg = String((exc as Error).message);
        if (/Unknown settings group|is not one of|is not a valid http|is out of range|is managed by the deployment|is not an integer|is not a number/.test(msg)) {
          sendJson(res, 400, { error: msg });
        } else {
          sendJson(res, 500, { error: "Settings operation failed", detail: msg });
        }
      }
      return;
    }

    // POST /admin/api/uploads — raw-body source upload + sha256 dedup.
    if (method === "POST" && path === "/admin/api/uploads") {
      const moduleKey = String(req.query.module_key ?? "").trim();
      const sourceRole = String(req.query.source_role ?? "").trim();
      const originalFilename = String(req.query.filename ?? "").trim();
      const autoActivate = String(req.query.auto_activate ?? "false").trim().toLowerCase() === "true";
      const maxUploadBytes = Math.max(config().adminMaxUploadMb, 1) * 1024 * 1024;
      if (!moduleKey || !sourceRole || !originalFilename) {
        sendJson(res, 400, { error: "Missing upload metadata", required: ["module_key", "source_role", "filename"] });
        return;
      }
      let rawBody: Buffer;
      try {
        rawBody = await readRawBody(req);
      } catch {
        sendJson(res, 400, { error: "Upload body is empty" });
        return;
      }
      if (rawBody.length === 0) {
        sendJson(res, 400, { error: "Upload body is empty" });
        return;
      }
      if (rawBody.length > maxUploadBytes) {
        sendJson(res, 413, { error: "Upload exceeds max size", max_upload_mb: config().adminMaxUploadMb });
        return;
      }
      // Content-type validation (extension + magic-byte) — ValueError → 415.
      try {
        const entry = catalogEntry(moduleKey, sourceRole);
        validateSourceFilename(originalFilename, entry);
        validateSourceContent(rawBody, entry);
      } catch (exc) {
        if (exc instanceof SourceValueError) {
          sendJson(res, 415, { error: exc.message });
          return;
        }
        throw exc;
      }
      try {
        const result = await createUploadedSource({
          moduleKey,
          sourceRole,
          originalFilename,
          mimeType: String(req.headers["content-type"] ?? "") || "application/octet-stream",
          data: rawBody,
          uploadedBy: adminUsername,
          autoActivate,
        });
        if (result.duplicate) {
          sendJson(res, 200, {
            message: "Duplicate upload skipped; existing source reused",
            duplicate: true,
            uploaded_file: result.uploaded_file,
          });
        } else {
          sendJson(res, 201, { duplicate: false, uploaded_file: result.uploaded_file });
        }
      } catch (exc) {
        if (exc instanceof SourceValueError) sendJson(res, 400, { error: exc.message });
        else if (exc instanceof SourceRuntimeError) sendJson(res, 503, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to persist uploaded source", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/module-sources/{activate|deactivate|delete}
    if (method === "POST" && path === "/admin/api/module-sources/activate") {
      const uploadedFileId = String(((req.body ?? {}) as Record<string, unknown>).uploaded_file_id ?? "").trim();
      if (!uploadedFileId) {
        sendJson(res, 400, { error: "uploaded_file_id is required" });
        return;
      }
      try {
        const moduleSource = await activateSource(uploadedFileId, adminUsername);
        sendJson(res, 200, { module_source: moduleSource });
      } catch (exc) {
        if (exc instanceof SourceValueError) sendJson(res, 404, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to activate module source", detail: String((exc as Error).message) });
      }
      return;
    }

    if (method === "POST" && path === "/admin/api/module-sources/deactivate") {
      const uploadedFileId = String(((req.body ?? {}) as Record<string, unknown>).uploaded_file_id ?? "").trim();
      if (!uploadedFileId) {
        sendJson(res, 400, { error: "uploaded_file_id is required" });
        return;
      }
      try {
        const source = await deactivateSource(uploadedFileId, adminUsername);
        sendJson(res, 200, { ok: true, source });
      } catch (exc) {
        if (exc instanceof SourceValueError) sendJson(res, 400, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to deactivate module source", detail: String((exc as Error).message) });
      }
      return;
    }

    if (method === "POST" && path === "/admin/api/module-sources/delete") {
      const uploadedFileId = String(((req.body ?? {}) as Record<string, unknown>).uploaded_file_id ?? "").trim();
      if (!uploadedFileId) {
        sendJson(res, 400, { error: "uploaded_file_id is required" });
        return;
      }
      try {
        const deleted = await deleteUploadedSource(uploadedFileId, adminUsername);
        sendJson(res, 200, { ok: true, deleted });
      } catch (exc) {
        if (exc instanceof SourceValueError) sendJson(res, 400, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to delete module source", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/jobs — create an admin job
    if (method === "POST" && path === "/admin/api/jobs") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const jobType = String((body.job_type ?? "") || "").trim();
      const moduleKey = String((body.module_key ?? "admin") || "admin").trim();
      if (!ADMIN_JOB_TYPES.has(jobType)) {
        sendJson(res, 400, { error: "Unsupported admin job type", allowed_job_types: sortedAdminJobTypes() });
        return;
      }
      try {
        const jobOptions = (body.job_options as Record<string, unknown>) || {};
        const blocked = await precheckJobCreate(jobType, jobOptions, {
          activeJobs: async (t) =>
            (
              await query<{ job_id: string; status: string }>(
                `SELECT job_id::text AS job_id, status FROM admin.import_jobs
                  WHERE job_type = $1 AND status IN ('queued', 'running', 'paused')
                  ORDER BY created_at DESC LIMIT 1`,
                [t],
              )
            ).rows,
          drugReadiness: async (stage) => {
            const { DrugAnalysisService, loadDrugAnalysisConfig } = await import("../drugAnalysisService.js");
            const service = new DrugAnalysisService(await loadDrugAnalysisConfig());
            return stage === "analysis" ? service.analysisReadiness() : service.readiness();
          },
        });
        if (blocked) {
          sendJson(res, blocked.status, blocked.body);
          return;
        }
        const job = await createJob({
          moduleKey,
          jobType,
          requestedBy: adminUsername,
          jobOptions: (body.job_options as Record<string, unknown>) || {},
          sourceModuleSourceId: String((body.source_module_source_id ?? "") || "").trim(),
          sourceUploadedFileId: String((body.source_uploaded_file_id ?? "") || "").trim(),
        });
        sendJson(res, 201, { ...(await workerWarningFields()), job });
      } catch (exc) {
        if (exc instanceof JobValueError) sendJson(res, 400, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to create admin job", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/jobs/{id}/(pause|resume|stop|restart) — job control
    const jobControlMatch = /^\/admin\/api\/jobs\/([0-9a-fA-F-]+)\/(pause|resume|stop|restart)$/.exec(path);
    if (method === "POST" && jobControlMatch) {
      try {
        const result = await requestJobControl({
          jobId: jobControlMatch[1],
          action: jobControlMatch[2],
          requestedBy: adminUsername,
        });
        sendJson(res, 200, result);
      } catch (exc) {
        if (exc instanceof JobValueError) sendJson(res, 400, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to apply job control", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/module-maintenance — toggle per-module maintenance mode
    if (method === "POST" && path === "/admin/api/module-maintenance") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const moduleKey = String((body.module_key ?? "") || "").trim();
      const enabled = Boolean(body.enabled ?? false);
      try {
        const newState = await setMaintenanceEnabled(moduleKey, enabled, adminUsername);
        await broadcast("maintenance_changed", { module_key: moduleKey, enabled: newState });
        sendJson(res, 200, { ok: true, module_key: moduleKey, enabled: newState });
      } catch (exc) {
        if (exc instanceof MaintenanceValueError) sendJson(res, 400, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to set maintenance mode", detail: String((exc as Error).message) });
      }
      return;
    }

    if (method === "GET" && path === "/admin/api/workers") {
      try {
        sendJson(res, 200, { workers: await listWorkerHeartbeats() });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to list worker heartbeats", detail: String((exc as Error).message) });
      }
      return;
    }

    if (method === "GET" && path === "/admin/api/services") {
      try {
        sendJson(res, 200, withProbeExplanations(await listServiceProbes()));
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load cached service probes", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/services/probe — run live probes (optionally a subset).
    if (method === "POST" && path === "/admin/api/services/probe") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawKeys = body.service_keys ?? [];
      if (rawKeys && !Array.isArray(rawKeys)) {
        sendJson(res, 400, { error: "service_keys must be an array when provided" });
        return;
      }
      try {
        const serviceKeys = (rawKeys as unknown[]).map((k) => String(k));
        sendJson(res, 200, withProbeExplanations(await runServiceProbes(serviceKeys)));
      } catch (exc) {
        if (exc instanceof ServiceProbeValueError) {
          sendJson(res, 400, { error: String(exc.message) });
        } else {
          sendJson(res, 500, { error: "Failed to run active service probes", detail: String((exc as Error).message) });
        }
      }
      return;
    }

    if (method === "GET" && path === "/admin/api/igs") {
      try {
        sendJson(res, 200, { igs: await listIgs() });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to list IGs", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/igs/supplements — uploaded / bundled / package-shipped CodeSystem
    // supplements, plus the state of every supplement bundled with the code.
    if (method === "GET" && path === "/admin/api/igs/supplements") {
      try {
        sendJson(res, 200, await listSupplements());
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to list CodeSystem supplements", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/supplements — upload a CodeSystem supplement (FHIR JSON).
    // application/json bodies are parsed by express (4 MB cap); larger files are sent with
    // another content type (e.g. application/fhir+json) and read raw here (64 MB cap).
    if (method === "POST" && path === "/admin/api/igs/supplements") {
      let resource: unknown = req.body;
      const ctype = String(req.headers["content-type"] ?? "");
      if (!/^application\/json\b/i.test(ctype)) {
        try {
          const raw = await readRawBody(req);
          if (raw.length > 64 * 1024 * 1024) {
            sendJson(res, 413, { error: "Supplement exceeds 64 MB" });
            return;
          }
          resource = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
        } catch (exc) {
          sendJson(res, 400, { error: "Body is not valid JSON", detail: String((exc as Error).message) });
          return;
        }
      }
      try {
        const out = await saveSupplement(resource as Record<string, unknown>, adminUsername);
        sendJson(res, out.status, out.body);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to save CodeSystem supplement", detail: String((exc as Error).message) });
      }
      return;
    }

    // DELETE /admin/api/igs/supplements?url=&version= — remove an uploaded supplement
    if (method === "DELETE" && path === "/admin/api/igs/supplements") {
      const url = String(req.query.url ?? "").trim();
      const version = String(req.query.version ?? "").trim();
      if (!url) {
        sendJson(res, 400, { error: "url is required" });
        return;
      }
      try {
        const out = await deleteSupplement(url, version, adminUsername);
        sendJson(res, out.status, out.body);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to delete CodeSystem supplement", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/supplements/bundled/restore {url?} — undo the opt-out of a bundled
    // supplement (all when url is omitted) and queue the ig_concept_index job that applies it.
    if (method === "POST" && path === "/admin/api/igs/supplements/bundled/restore") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : null;
      try {
        const out = await restoreBundledSupplements(url, adminUsername);
        sendJson(res, out.status, out.status < 300 ? { ...(await workerWarningFields()), ...out.body } : out.body);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to restore bundled CodeSystem supplement", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/igs/concept-index — concept-search index + embedding coverage
    if (method === "GET" && path === "/admin/api/igs/concept-index") {
      try {
        sendJson(res, 200, await conceptIndexStatus());
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to read concept index status", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/concept-index/rebuild {force?} — queue the ig_concept_index backfill
    if (method === "POST" && path === "/admin/api/igs/concept-index/rebuild") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const jobId = await queueConceptIndexRebuild(adminUsername, body.force === true);
        sendJson(res, 201, { ...(await workerWarningFields()), job_id: jobId });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to queue concept index rebuild", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/import — queue an IG import job (registry or upload)
    if (method === "POST" && path === "/admin/api/igs/import") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const source = String((body.source ?? "") || "").trim();
      let options: Record<string, unknown>;
      if (source === "registry") {
        const pkgId = String((body.package_id ?? "") || "").trim();
        if (!pkgId) {
          sendJson(res, 400, { error: "package_id is required for registry import" });
          return;
        }
        options = {
          ig_source: "registry",
          package_id: pkgId,
          version: String((body.version ?? "") || "").trim(),
        };
      } else if (source === "upload") {
        const uploadedFileId = String((body.uploaded_file_id ?? "") || "").trim();
        let objectKey = String((body.object_key ?? "") || "").trim();
        if (!objectKey && uploadedFileId) {
          try {
            const row = await query<{ object_key: string }>(
              "SELECT object_key FROM admin.uploaded_files WHERE uploaded_file_id = $1::uuid",
              [uploadedFileId],
            );
            objectKey = row.rows.length > 0 ? row.rows[0].object_key : "";
          } catch {
            objectKey = "";
          }
        }
        if (!objectKey) {
          sendJson(res, 400, { error: "object_key or a valid uploaded_file_id is required" });
          return;
        }
        // Refuse a file that is not a FHIR package before queueing: the loader
        // would otherwise install it under its file name (e.g. "ig-root@0.0.0")
        // as an empty, "successful" manual IG.
        if (uploadedFileId) {
          const inspected = await inspectUploadedIg(uploadedFileId).catch(() => null); // lookup failure: let the job report it
          if (inspected && !inspected.ok && (inspected.status === 422 || inspected.status === 404)) {
            sendJson(res, inspected.status, { error: inspected.error, ...(inspected.detail ? { detail: inspected.detail } : {}) });
            return;
          }
        }
        options = { ig_source: "upload", object_key: objectKey };
        // Optional: the missing dependency this upload is meant to supply, so the
        // dependency list can show it as "downloading" while the job runs.
        if (body.expected_package !== undefined) {
          const exp = parseDependencyRequest(body.expected_package);
          if ("error" in exp) {
            sendJson(res, 400, { error: `expected_package: ${exp.error}` });
            return;
          }
          options.expected_package = exp;
          // Optional: the installed IG that needs it (recorded as installed_for).
          if (body.requested_for !== undefined && body.requested_for !== null) {
            const rf = parseDependencyRequest(body.requested_for);
            if ("error" in rf) {
              sendJson(res, 400, { error: `requested_for: ${rf.error}` });
              return;
            }
            options.requested_for = rf;
          }
        }
      } else {
        sendJson(res, 400, { error: "source must be 'registry' or 'upload'" });
        return;
      }
      try {
        const job = await createJob({
          moduleKey: "ig",
          jobType: "ig_import",
          requestedBy: adminUsername,
          jobOptions: options,
        });
        sendJson(res, 201, { ...(await workerWarningFields()), job });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to start IG import", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/igs/dependencies — missing dependencies + download state
    if (method === "GET" && path === "/admin/api/igs/dependencies") {
      try {
        sendJson(res, 200, { dependencies: await listMissingDependencies() });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to list missing IG dependencies", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/dependencies/download {package_id, version}
    //   → queue a dependency-only ig_import for that exact package (+ its own missing deps)
    if (method === "POST" && path === "/admin/api/igs/dependencies/download") {
      const parsed = parseDependencyRequest(req.body);
      if ("error" in parsed) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      try {
        if (await isIgInstalled(parsed.package_id, parsed.version)) {
          sendJson(res, 409, {
            error: `${parsed.package_id}@${parsed.version} is already installed`,
            code: "already_installed",
          });
          return;
        }
        const out = await queueDependencyImport({ packages: [parsed], requestedBy: adminUsername });
        sendJson(res, out.packages.length ? 201 : 200, out);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to queue dependency download", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/dependencies/download-all → one job for every missing dependency
    if (method === "POST" && path === "/admin/api/igs/dependencies/download-all") {
      try {
        const missing = await listMissingDependencies();
        const out = await queueDependencyImport({
          packages: missing.map((d) => ({ package_id: d.package_id, version: d.version })),
          requestedBy: adminUsername,
        });
        sendJson(res, out.packages.length ? 201 : 200, out);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to queue dependency downloads", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/inspect-upload {uploaded_file_id} → package identity of an uploaded .tgz
    if (method === "POST" && path === "/admin/api/igs/inspect-upload") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = String(body.uploaded_file_id ?? "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        sendJson(res, 400, { error: "uploaded_file_id must be a UUID" });
        return;
      }
      try {
        const out = await inspectUploadedIg(id);
        if (out.ok) sendJson(res, 200, out);
        else sendJson(res, out.status, { error: out.error, ...(out.detail ? { detail: out.detail } : {}) });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to read the uploaded package", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/{package_id}/{version}/fill-dependencies → fetch this IG's missing deps
    const igFillMatch = /^\/admin\/api\/igs\/([^/]+)\/([^/]+)\/fill-dependencies$/.exec(path);
    if (method === "POST" && igFillMatch) {
      const pkgId = decodeURIComponent(igFillMatch[1]);
      const pkgVer = decodeURIComponent(igFillMatch[2]);
      try {
        const missing = await missingForIg(pkgId, pkgVer);
        if (missing === null) {
          sendJson(res, 404, { error: "IG not found" });
          return;
        }
        if (missing.length === 0) {
          sendJson(res, 200, { job: null, packages: [], already_queued: [], nothing_missing: true });
          return;
        }
        const out = await queueDependencyImport({
          packages: missing.map((d) => ({ package_id: d.package_id, version: d.version })),
          requestedBy: adminUsername,
          requestedFor: { package_id: pkgId, version: pkgVer },
        });
        sendJson(res, out.packages.length ? 201 : 200, out);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to queue dependency downloads", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/igs/unused-dependencies — dependency installs no installed IG needs any more
    if (method === "GET" && path === "/admin/api/igs/unused-dependencies") {
      try {
        sendJson(res, 200, { packages: await listUnusedIgDependencies() });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to list unused IG dependencies", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/unused-dependencies/remove {packages?: [{package_id, version}]}
    //   → remove those (default: every unused dependency) as one set; 409 IG_DEPENDENCY_IN_USE
    //     when any of them is still needed.
    if (method === "POST" && path === "/admin/api/igs/unused-dependencies/remove") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      let packages: { package_id: string; version: string }[] | null = null;
      if (body.packages !== undefined && body.packages !== null) {
        if (!Array.isArray(body.packages)) {
          sendJson(res, 400, { error: "packages must be an array when provided" });
          return;
        }
        packages = [];
        for (const raw of body.packages) {
          const p = parseDependencyRequest(raw);
          if ("error" in p) {
            sendJson(res, 400, { error: `packages: ${p.error}` });
            return;
          }
          packages.push(p);
        }
      }
      try {
        const result = await removeUnusedIgDependencies({ packages, removedBy: adminUsername });
        if (result.removed) await broadcast("module_changed", { module_key: "ig" });
        sendJson(res, result.ok ? 200 : result.status, result);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to remove unused IG dependencies", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/igs/{package_id}/{version}/removal-impact — what deleting this IG would break
    const igImpactMatch = /^\/admin\/api\/igs\/([^/]+)\/([^/]+)\/removal-impact$/.exec(path);
    if (method === "GET" && igImpactMatch) {
      try {
        const impact = await igRemovalImpact(decodeURIComponent(igImpactMatch[1]), decodeURIComponent(igImpactMatch[2]));
        if (impact === null) sendJson(res, 404, { error: "IG not found", code: "IG_NOT_FOUND" });
        else sendJson(res, 200, impact);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to compute IG removal impact", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/igs/{package_id}/{version}/default — make this IG the default
    const igDefaultMatch = /^\/admin\/api\/igs\/([^/]+)\/([^/]+)\/default$/.exec(path);
    if (method === "POST" && igDefaultMatch) {
      const ok = await setIgDefault(igDefaultMatch[1], igDefaultMatch[2]);
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }

    // GET /admin/api/igs/{package_id}/{version}  (detail) | DELETE (remove)
    const igDetailMatch = /^\/admin\/api\/igs\/([^/]+)\/([^/]+)$/.exec(path);
    if (igDetailMatch && (method === "GET" || method === "DELETE")) {
      const pkgId = igDetailMatch[1];
      const pkgVer = igDetailMatch[2];
      if (method === "GET") {
        const detail = await getIgDetail(pkgId, pkgVer);
        if (detail === null) sendJson(res, 404, { error: "IG not found" });
        else sendJson(res, 200, detail);
        return;
      }
      // DELETE — remove the IG package, then broadcast the module change.
      // Refused (409 IG_HAS_DEPENDENTS / IG_IS_DEFAULT) unless force=true or,
      // for the default IG, new_default names a replacement.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const force = String(req.query.force ?? body.force ?? "").trim().toLowerCase() === "true";
      let newDefault: { package_id: string; version: string } | null = null;
      const rawNd = body.new_default ?? (typeof req.query.new_default === "string" ? req.query.new_default : undefined);
      if (rawNd !== undefined && rawNd !== null && rawNd !== "") {
        const nd = typeof rawNd === "string" ? (() => {
          const at = rawNd.lastIndexOf("@");
          return parseDependencyRequest(at > 0 ? { package_id: rawNd.slice(0, at), version: rawNd.slice(at + 1) } : {});
        })() : parseDependencyRequest(rawNd);
        if ("error" in nd) {
          sendJson(res, 400, { error: `new_default: ${nd.error}`, code: "IG_INVALID_NEW_DEFAULT" });
          return;
        }
        newDefault = nd;
      }
      try {
        const result = await removeIg({
          packageId: decodeURIComponent(pkgId),
          version: decodeURIComponent(pkgVer),
          removedBy: adminUsername,
          force,
          newDefault,
        });
        if (result.removed) await broadcast("module_changed", { module_key: "ig" });
        sendJson(res, result.removed ? 200 : result.status, result);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to remove IG", detail: String((exc as Error).message) });
      }
      return;
    }

    // ── FHIR Servers registry (sub-step A: CRUD + pgcrypto) ───────────────────
    if (method === "GET" && path === "/admin/api/fhir-servers") {
      try {
        const includeDisabled = String(req.query.include_disabled ?? "false").trim().toLowerCase() === "true";
        const servers = await listFhirServers(includeDisabled);
        await attachOauthStatus(servers);
        sendJson(res, 200, { servers: servers.map((sv) => withFhirProbeErrorExplanation(sv as { last_probe_error?: unknown })) });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to list FHIR servers", detail: String((exc as Error).message) });
      }
      return;
    }

    if (method === "GET" && path === "/admin/api/fhir-servers/export") {
      try {
        const servers = await exportFhirServers(fhirServerSecretKey(cfg.adminSessionSecret), true);
        sendJson(res, 200, { servers });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to export FHIR servers", detail: String((exc as Error).message) });
      }
      return;
    }

    if (method === "POST" && path === "/admin/api/fhir-servers") {
      try {
        const server = await createFhirServer((req.body ?? {}) as Record<string, unknown>, {
          adminUser: adminUsername,
          secretKey: fhirServerSecretKey(cfg.adminSessionSecret),
        });
        sendJson(res, 201, { server });
      } catch (exc) {
        if (exc instanceof FhirServerValueError) sendJson(res, 400, { error: exc.message });
        else if (/duplicate key value violates unique constraint "[^"]*server_key/.test(String((exc as Error).message)))
          sendJson(res, 409, {
            error: "server_key already in use",
            code: "FHIR_SERVER_KEY_TAKEN",
            message_zh: "已有另一台 FHIR 伺服器使用這個識別碼（server_key）。",
            hint_zh: "請換一個識別碼；若要修改既有伺服器，請到它的詳情頁按「編輯」。",
          });
        else sendJson(res, 500, { error: "Failed to create FHIR server", detail: String((exc as Error).message) });
      }
      return;
    }

    if (method === "POST" && path === "/admin/api/fhir-servers/generate-key") {
      try {
        const alg = String(((req.body ?? {}) as Record<string, unknown>).alg ?? "").trim();
        const result = generateClientKey(alg);
        sendJson(res, 200, { ok: true, ...result });
      } catch (exc) {
        if (exc instanceof FhirServerValueError) sendJson(res, 400, { ok: false, error: exc.message });
        else sendJson(res, 500, { ok: false, error: "Failed to generate keypair", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/fhir-servers/discover — OAuth2/SMART metadata discovery
    if (method === "POST" && path === "/admin/api/fhir-servers/discover") {
      try {
        const result = await discoverFhirMetadata((req.body ?? {}) as Record<string, unknown>);
        sendJson(res, 200, { ok: true, ...result });
      } catch (exc) {
        if (exc instanceof FhirServerValueError) sendJson(res, 400, { ok: false, error: exc.message });
        // Metadata unreachable/invalid is non-fatal: 200 so the UI falls back to manual entry.
        else sendJson(res, 200, { ok: false, error: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/fhir-servers/{id}/oauth/authorize
    const fhirOauthAuthorizeMatch = /^\/admin\/api\/fhir-servers\/([^/]+)\/oauth\/authorize$/.exec(path);
    if (method === "POST" && fhirOauthAuthorizeMatch) {
      try {
        const result = await startAuthorization(fhirOauthAuthorizeMatch[1], {
          adminUser: adminUsername,
          redirectUri: oauthRedirectUri(req),
          secretKey: fhirServerSecretKey(cfg.adminSessionSecret),
        });
        sendJson(res, 200, result);
      } catch (exc) {
        if (exc instanceof OAuthError) sendJson(res, 400, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to start OAuth authorization", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/fhir-servers/{id}/oauth/refresh
    const fhirOauthRefreshMatch = /^\/admin\/api\/fhir-servers\/([^/]+)\/oauth\/refresh$/.exec(path);
    if (method === "POST" && fhirOauthRefreshMatch) {
      try {
        const result = await refreshTokenNow(fhirOauthRefreshMatch[1], fhirServerSecretKey(cfg.adminSessionSecret));
        sendJson(res, 200, result);
      } catch (exc) {
        if (exc instanceof OAuthError) sendJson(res, 400, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to refresh token", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/fhir-servers/{id}/oauth/clear-cache
    const fhirOauthClearMatch = /^\/admin\/api\/fhir-servers\/([^/]+)\/oauth\/clear-cache$/.exec(path);
    if (method === "POST" && fhirOauthClearMatch) {
      try {
        const result = await clearOauthState(fhirOauthClearMatch[1]);
        sendJson(res, 200, result);
      } catch (exc) {
        if (exc instanceof OAuthError) sendJson(res, 404, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to clear OAuth token cache", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/fhir-servers/test — full connection workflow on a draft
    if (method === "POST" && path === "/admin/api/fhir-servers/test") {
      try {
        const result = await testFhirServerConfig((req.body ?? {}) as Record<string, unknown>, fhirServerSecretKey(cfg.adminSessionSecret));
        sendJson(res, 200, explainFhirConnection(result));
      } catch (exc) {
        if (exc instanceof FhirServerValueError) sendJson(res, 400, { error: exc.message });
        else sendJson(res, 500, { error: "FHIR server connection test failed", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/fhir-servers/test-request — single ad-hoc request on a draft
    if (method === "POST" && path === "/admin/api/fhir-servers/test-request") {
      try {
        const result = await runFhirTestRequest((req.body ?? {}) as Record<string, unknown>, fhirServerSecretKey(cfg.adminSessionSecret));
        sendJson(res, 200, result);
      } catch (exc) {
        if (exc instanceof FhirServerValueError) sendJson(res, 400, { error: exc.message });
        else sendJson(res, 500, { error: "FHIR test request failed", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/fhir-servers/{id}/probe — probe a saved server
    const fhirProbeMatch = /^\/admin\/api\/fhir-servers\/([^/]+)\/probe$/.exec(path);
    if (method === "POST" && fhirProbeMatch) {
      try {
        const result = await probeFhirServer(fhirProbeMatch[1], fhirServerSecretKey(cfg.adminSessionSecret));
        sendJson(res, 200, explainFhirConnection(result));
      } catch (exc) {
        if (exc instanceof FhirServerValueError) sendJson(res, 404, { error: exc.message });
        else sendJson(res, 500, { error: "FHIR server probe failed", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/fhir-servers/{id}/set-default
    const fhirSetDefaultMatch = /^\/admin\/api\/fhir-servers\/([^/]+)\/set-default$/.exec(path);
    if (method === "POST" && fhirSetDefaultMatch) {
      try {
        const server = await setDefaultFhirServer(fhirSetDefaultMatch[1], { adminUser: adminUsername });
        sendJson(res, 200, { server });
      } catch (exc) {
        if (exc instanceof FhirServerValueError) sendJson(res, 404, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to set default FHIR server", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET/PATCH/DELETE /admin/api/fhir-servers/{id}
    const fhirDetailMatch = /^\/admin\/api\/fhir-servers\/([^/]+)$/.exec(path);
    if (fhirDetailMatch && (method === "GET" || method === "PATCH" || method === "DELETE")) {
      const identifier = fhirDetailMatch[1];
      if (method === "GET") {
        try {
          const server = await getFhirServer(identifier);
          if (server === null) {
            sendJson(res, 404, { error: "FHIR server not found" });
          } else {
            await attachOauthStatus([server]);
            sendJson(res, 200, { server: withFhirProbeErrorExplanation(server as { last_probe_error?: unknown }) });
          }
        } catch (exc) {
          sendJson(res, 500, { error: "Failed to load FHIR server", detail: String((exc as Error).message) });
        }
        return;
      }
      if (method === "PATCH") {
        try {
          const server = await updateFhirServer(identifier, (req.body ?? {}) as Record<string, unknown>, {
            adminUser: adminUsername,
            secretKey: fhirServerSecretKey(cfg.adminSessionSecret),
          });
          sendJson(res, 200, { server });
        } catch (exc) {
          if (exc instanceof FhirServerValueError) sendJson(res, 400, { error: exc.message });
          else if (/duplicate key value violates unique constraint "[^"]*server_key/.test(String((exc as Error).message)))
          sendJson(res, 409, {
            error: "server_key already in use",
            code: "FHIR_SERVER_KEY_TAKEN",
            message_zh: "已有另一台 FHIR 伺服器使用這個識別碼（server_key）。",
            hint_zh: "請換一個識別碼；若要修改既有伺服器，請到它的詳情頁按「編輯」。",
          });
        else sendJson(res, 500, { error: "Failed to update FHIR server", detail: String((exc as Error).message) });
        }
        return;
      }
      // DELETE
      try {
        const server = await deleteFhirServer(identifier, { adminUser: adminUsername });
        sendJson(res, 200, { deleted: server });
      } catch (exc) {
        if (exc instanceof FhirServerValueError) sendJson(res, 404, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to delete FHIR server", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/modules  (source catalog + storage/maintenance/record-counts)
    if (method === "GET" && path === "/admin/api/modules") {
      try {
        const modules = await listSourceCatalog();
        let maintenance: Record<string, boolean>;
        try {
          maintenance = await getMaintenanceStates();
        } catch {
          maintenance = {};
        }
        const recordCounts = await moduleRecordCounts();
        const storage = {
          minio_enabled: minioService.enabled(),
          bucket: minioService.initialized() ? minioService.bucket() : "",
          detail: minioService.enabled()
            ? "MinIO ready"
            : minioService.initialized()
              ? minioService.initError() // raw init_error (may be null)
              : "MinIO service not initialized",
        };
        sendJson(res, 200, {
          modules,
          upload_limits: { max_upload_mb: cfg.adminMaxUploadMb },
          storage,
          maintenance,
          record_counts: recordCounts,
        });
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to list module sources",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    // GET  /admin/api/modules/{key}/clear  — counts a clear would remove
    // POST /admin/api/modules/{key}/clear  — body {scope, confirm}
    const clearMatch = /^\/admin\/api\/modules\/([A-Za-z0-9_-]+)\/clear$/.exec(path);
    if (clearMatch && (method === "GET" || method === "POST")) {
      const moduleKey = clearMatch[1];
      try {
        if (method === "GET") {
          sendJson(res, 200, await previewModuleClear(moduleKey));
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const scope = String(body.scope ?? "all") as ClearScope;
        if (String(body.confirm ?? "") !== moduleKey) {
          sendJson(res, 400, { error: `Type the module key '${moduleKey}' to confirm` });
          return;
        }
        sendJson(res, 200, await clearModule({ moduleKey, scope, requestedBy: adminUsername }));
      } catch (exc) {
        if (exc instanceof ModuleClearError) sendJson(res, exc.status, { error: exc.message });
        else sendJson(res, 500, { error: "Failed to clear module", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/modules/{key}/versions  (source version history)
    const versionsMatch = /^\/admin\/api\/modules\/([A-Za-z0-9_-]+)\/versions$/.exec(path);
    if (method === "GET" && versionsMatch) {
      const dsKey = versionsMatch[1];
      try {
        sendJson(res, 200, { module_key: dsKey, versions: await listSourceVersions(dsKey) });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load version history", detail: String((exc as Error).message) });
      }
      return;
    }

    // /admin/api/modules/{key}/schedule  (GET read / POST upsert / DELETE)
    const scheduleMatch = /^\/admin\/api\/modules\/([A-Za-z0-9_-]+)\/schedule$/.exec(path);
    if (scheduleMatch && (method === "GET" || method === "POST" || method === "DELETE")) {
      const dsKey = scheduleMatch[1];
      if (!SCHEDULABLE_MODULES.has(dsKey)) {
        sendJson(res, 400, { error: `Module '${dsKey}' does not support scheduling` });
        return;
      }

      if (method === "GET") {
        try {
          sendJson(res, 200, { schedule: await getSchedule(dsKey) });
        } catch (exc) {
          sendJson(res, 500, { error: "Failed to load schedule", detail: String((exc as Error).message) });
        }
        return;
      }

      if (method === "POST") {
        try {
          const body = (req.body ?? {}) as Record<string, unknown>;
          const frequency = String(body.frequency ?? "").trim();
          if (!["daily", "weekly", "monthly"].includes(frequency)) {
            throw new ScheduleValueError("frequency must be 'daily', 'weekly', or 'monthly'");
          }
          const hourUtc = toInt(body.hour_utc ?? 2);
          const minuteUtc = toInt(body.minute_utc ?? 0);
          if (!(hourUtc >= 0 && hourUtc <= 23)) throw new ScheduleValueError("hour_utc must be 0-23");
          if (!(minuteUtc >= 0 && minuteUtc <= 59)) throw new ScheduleValueError("minute_utc must be 0-59");

          let dayOfWeek: number | null = null;
          let dayOfMonth: number | null = null;
          if (frequency === "weekly") {
            if (body.day_of_week === undefined || body.day_of_week === null) {
              throw new ScheduleValueError("day_of_week required for weekly frequency");
            }
            dayOfWeek = toInt(body.day_of_week);
            if (!(dayOfWeek >= 0 && dayOfWeek <= 6)) throw new ScheduleValueError("day_of_week must be 0 (Mon) to 6 (Sun)");
          } else if (frequency === "monthly") {
            if (body.day_of_month === undefined || body.day_of_month === null) {
              throw new ScheduleValueError("day_of_month required for monthly frequency");
            }
            dayOfMonth = toInt(body.day_of_month);
            if (!(dayOfMonth >= 1 && dayOfMonth <= 28)) throw new ScheduleValueError("day_of_month must be 1-28");
          }

          const fetchUrl = String((body.fetch_url ?? "") || "").trim() || null;
          const sourceRole = String((body.source_role ?? "") || "").trim() || null;
          const isEnabled = body.is_enabled === undefined ? true : Boolean(body.is_enabled);

          if (URL_FETCH_MODULES.has(dsKey)) {
            if (!fetchUrl) throw new ScheduleValueError(`fetch_url is required for '${dsKey}' schedules`);
            if (!fetchUrl.toLowerCase().startsWith("https://")) throw new ScheduleValueError("fetch_url must use HTTPS");
            if (!sourceRole) throw new ScheduleValueError(`source_role is required for '${dsKey}' schedules`);
          }

          const sched = await upsertSchedule({
            moduleKey: dsKey,
            sourceRole,
            fetchUrl,
            frequency,
            dayOfWeek: frequency === "weekly" ? dayOfWeek : null,
            dayOfMonth: frequency === "monthly" ? dayOfMonth : null,
            hourUtc,
            minuteUtc,
            isEnabled,
            createdBy: adminUsername,
          });
          sendJson(res, 200, { schedule: sched });
        } catch (exc) {
          if (exc instanceof ScheduleValueError) sendJson(res, 400, { error: exc.message });
          else sendJson(res, 500, { error: "Failed to save schedule", detail: String((exc as Error).message) });
        }
        return;
      }

      // DELETE
      try {
        const deleted = await deleteSchedule(dsKey);
        sendJson(res, 200, { deleted });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to delete schedule", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/modules/{key}/schedule/trigger — fire a schedule now
    const scheduleTriggerMatch = /^\/admin\/api\/modules\/([A-Za-z0-9_-]+)\/schedule\/trigger$/.exec(path);
    if (method === "POST" && scheduleTriggerMatch) {
      const dsKey = scheduleTriggerMatch[1];
      if (!SCHEDULABLE_MODULES.has(dsKey)) {
        sendJson(res, 400, { error: `Module '${dsKey}' does not support scheduling` });
        return;
      }
      try {
        const sched = await getSchedule(dsKey);
        if (sched === null) {
          sendJson(res, 404, { error: "No schedule configured for this module" });
          return;
        }
        const username = adminUsername || "admin";
        // Fire in the background so large downloads don't block the HTTP response.
        void fireSchedule({
          schedule: sched as unknown as FireScheduleInput,
          triggeredBy: `manual:${username}`,
        }).catch(() => {
          // fireSchedule records its own failure via markScheduleRun; swallow here.
        });
        sendJson(res, 200, {
          triggered: true,
          message: "Schedule trigger initiated. Check the Tasks tab for progress.",
          module_key: dsKey,
        });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to trigger schedule", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/modules/{key}/preview  (per-module data preview)
    const previewMatch = /^\/admin\/api\/modules\/([A-Za-z0-9_-]+)\/preview$/.exec(path);
    if (method === "GET" && previewMatch) {
      const dsKey = previewMatch[1];
      if (!PREVIEW_SUPPORTED_MODULES.has(dsKey)) {
        sendJson(res, 400, { error: `No preview available for '${dsKey}'` });
        return;
      }
      try {
        const kwargs = buildPreviewKwargs(req.query as Record<string, unknown>, dsKey);
        sendJson(res, 200, await dispatchPreview(dsKey, kwargs));
      } catch (exc) {
        sendJson(res, 500, { error: "Preview failed", detail: String((exc as Error).message) });
      }
      return;
    }

    if (method === "GET" && path === "/admin/api/embedding/status") {
      try {
        sendJson(res, 200, await getEmbeddingStatus());
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to load embedding status",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    // GET /admin/api/drug/status  (paginated license pipeline view)
    if (method === "GET" && path === "/admin/api/drug/status") {
      try {
        const page = parseIntDefault(req.query.page, 1, (v) => Math.max(1, v));
        const perPage = parseIntDefault(req.query.per_page, 50, (v) =>
          Math.max(1, Math.min(200, v)),
        );
        const qParam = String(req.query.q ?? "").trim();
        const activeOnly = String(req.query.active_only ?? "true").trim().toLowerCase() === "true";
        const failedOnly = String(req.query.failed_only ?? "false").trim().toLowerCase() === "true";
        sendJson(
          res,
          200,
          await getDrugAdminStatus({ page, perPage, q: qParam, activeOnly, failedOnly }),
        );
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to load drug admin status",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    // GET /admin/api/drug/explorer (faceted, server-side drug browser)
    if (method === "GET" && path === "/admin/api/drug/explorer") {
      try {
        const csv = (value: unknown): string[] =>
          String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
        const activeRaw = String(req.query.active ?? "active");
        const active = activeRaw === "all" || activeRaw === "inactive" ? activeRaw : "active";
        const matchRaw = String(req.query.asset_match ?? "all");
        const orderRaw = String(req.query.order ?? "desc");
        const errorRaw = String(req.query.has_error ?? "");
        sendJson(res, 200, await getDrugExplorer({
          q: String(req.query.q ?? "").trim(),
          active,
          assetTypes: csv(req.query.asset_types),
          assetMatch: matchRaw === "all" ? "all" : "any",
          missingAssetTypes: csv(req.query.missing_asset_types),
          pipelineStatuses: csv(req.query.pipeline_statuses),
          stage: String(req.query.stage ?? ""),
          stageStatuses: csv(req.query.stage_statuses),
          hasError: errorRaw === "true" ? true : errorRaw === "false" ? false : null,
          manufacturer: String(req.query.manufacturer ?? "").trim(),
          country: String(req.query.country ?? "").trim(),
          dosageForm: String(req.query.dosage_form ?? "").trim(),
          ingredient: String(req.query.ingredient ?? "").trim(),
          appearanceColor: String(req.query.appearance_color ?? "").trim(),
          appearanceShape: String(req.query.appearance_shape ?? "").trim(),
          updatedFrom: String(req.query.updated_from ?? "").trim(),
          updatedTo: String(req.query.updated_to ?? "").trim(),
          documentFrom: String(req.query.document_from ?? "").trim(),
          documentTo: String(req.query.document_to ?? "").trim(),
          sort: String(req.query.sort ?? "").trim(),
          order: orderRaw === "asc" ? "asc" : "desc",
          page: parseIntDefault(req.query.page, 1, (value) => Math.max(1, value)),
          perPage: parseIntDefault(req.query.per_page, 25, (value) => Math.max(10, Math.min(100, value))),
        }));
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to search drugs", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/drug/explorer-detail?license_id=...
    if (method === "GET" && path === "/admin/api/drug/explorer-detail") {
      const licenseId = String(req.query.license_id ?? "").trim();
      if (!licenseId) {
        sendJson(res, 400, { error: "license_id is required" });
        return;
      }
      try {
        const detail = await getDrugExplorerDetail(licenseId);
        if (!detail) sendJson(res, 404, { error: "Drug not found" });
        else sendJson(res, 200, detail);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load drug", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/drug/llm-calls?license_id=... (per-call Analysis LM audit)
    if (method === "GET" && path === "/admin/api/drug/llm-calls") {
      const licenseId = String(req.query.license_id ?? "").trim();
      if (!licenseId) {
        sendJson(res, 400, { error: "license_id is required" });
        return;
      }
      try {
        sendJson(res, 200, { calls: await listDrugLlmCalls(licenseId) });
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to load LLM calls",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    // GET /admin/api/drug/llm-call?id=... (full record: prompts + reply)
    if (method === "GET" && path === "/admin/api/drug/llm-call") {
      const id = Number(req.query.id);
      if (!Number.isFinite(id) || id <= 0) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      try {
        const detail = await getDrugLlmCall(id);
        if (!detail) sendJson(res, 404, { error: "LLM call not found" });
        else sendJson(res, 200, detail);
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to load LLM call",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    // GET /admin/api/drug/details?license_id=...&include_cancelled=...
    if (method === "GET" && path === "/admin/api/drug/details") {
      const licenseId = String(req.query.license_id ?? "").trim();
      const includeCancelled =
        String(req.query.include_cancelled ?? "true").trim().toLowerCase() === "true";
      if (!licenseId) {
        sendJson(res, 400, { error: "license_id is required" });
        return;
      }
      const drug = await getDrugServiceForAdmin();
      if (drug === null) {
        sendJson(res, 503, { error: "Drug service not available" });
        return;
      }
      try {
        sendJson(res, 200, await drug.getDrugDetails(licenseId, includeCancelled));
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to load drug details",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    // GET /admin/api/drug/assets?license_id=...&asset_group=...
    if (method === "GET" && path === "/admin/api/drug/assets") {
      const licenseId = String(req.query.license_id ?? "").trim();
      const assetGroup = String(req.query.asset_group ?? "").trim() || null;
      if (!licenseId) {
        sendJson(res, 400, { error: "license_id is required" });
        return;
      }
      const drug = await getDrugServiceForAdmin();
      if (drug === null) {
        sendJson(res, 503, { error: "Drug service not available" });
        return;
      }
      try {
        sendJson(
          res,
          200,
          await drug.getDrugAssetLinks({ license_id: licenseId, asset_group: assetGroup }),
        );
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to load drug assets",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    // GET /admin/api/drug/asset-content?asset_id=...
    // Same-origin proxy that streams one asset's bytes from MinIO for inline
    // preview (PDF iframe / image / JSON / Markdown), so the browser never has
    // to reach MinIO itself.
    if (method === "GET" && path === "/admin/api/drug/asset-content") {
      const assetId = String(req.query.asset_id ?? "").trim();
      if (!assetId) {
        sendJson(res, 400, { error: "asset_id is required" });
        return;
      }
      const drug = await getDrugServiceForAdmin();
      if (drug === null) {
        sendJson(res, 503, { error: "Drug service not available" });
        return;
      }
      try {
        const variant = String(req.query.variant ?? "").trim() || null;
        const asset = await drug.getDrugAssetContent(assetId, variant);
        if (asset === null) {
          sendJson(res, 404, { error: "Asset not found or has no stored content" });
          return;
        }
        const download = String(req.query.download ?? "").toLowerCase() === "true";
        const isPdf = asset.mimeType.toLowerCase() === "application/pdf";
        const range = isPdf ? parseByteRange(req.headers.range, asset.data.length) : undefined;
        if (range === null) {
          res.writeHead(416, {
            "Content-Range": `bytes */${asset.data.length}`,
            "Accept-Ranges": "bytes",
          });
          res.end();
          return;
        }
        const body = range ? asset.data.subarray(range.start, range.end + 1) : asset.data;
        res.writeHead(range ? 206 : 200, {
          "Content-Type": asset.mimeType || "application/octet-stream",
          "Content-Length": String(body.length),
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cache-Control": variant ? "private, max-age=86400" : "private, max-age=3600",
          "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
          ...(isPdf ? { "Accept-Ranges": "bytes" } : { "Content-Security-Policy": "sandbox" }),
          ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${asset.data.length}` } : {}),
        });
        res.end(body);
      } catch (exc) {
        // The DB row exists but the object is gone from storage → 404, not 500.
        const e = exc as Error & { code?: string };
        if (e.code === "NoSuchKey" || e.code === "NotFound" || /does not exist|NoSuchKey|Not Found/i.test(String(e.message))) {
          sendJson(res, 404, { error: "Asset file is missing from object storage", detail: String(e.message) });
          return;
        }
        sendJson(res, 500, {
          error: "Failed to load asset content",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    // GET /admin/api/drug/pipeline-status
    if (method === "GET" && path === "/admin/api/drug/pipeline-status") {
      try {
        sendJson(res, 200, await getDrugPipelineStatus());
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to load drug pipeline status",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    // GET /admin/api/drug/events?license_id=...
    if (method === "GET" && path === "/admin/api/drug/events") {
      const licenseId = String(req.query.license_id ?? "").trim();
      if (!licenseId) {
        sendJson(res, 400, { error: "license_id is required" });
        return;
      }
      try {
        sendJson(res, 200, { license_id: licenseId, events: await getDrugLicenseEvents(licenseId) });
      } catch (exc) {
        sendJson(res, 500, {
          error: "Failed to load drug events",
          detail: String((exc as Error).message),
        });
      }
      return;
    }

    if (method === "GET" && path === "/admin/api/jobs") {
      try {
        const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 500);
        sendJson(res, 200, { jobs: (await listJobs(limit)).map(withJobErrorExplanation) });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to list admin jobs", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/jobs/{id}/steps  (must precede the bare detail match)
    const jobStepsMatch = /^\/admin\/api\/jobs\/([0-9a-fA-F-]+)\/steps$/.exec(path);
    if (method === "GET" && jobStepsMatch) {
      try {
        sendJson(res, 200, { steps: await listJobSteps(jobStepsMatch[1]) });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load job steps", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/jobs/{id}/logs  (limit capped at 500; cursor before_id)
    const jobLogsMatch = /^\/admin\/api\/jobs\/([0-9a-fA-F-]+)\/logs$/.exec(path);
    if (method === "GET" && jobLogsMatch) {
      try {
        const limit = Math.min(Number.parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
        const beforeIdRaw = req.query.before_id;
        const beforeId = beforeIdRaw ? Number.parseInt(String(beforeIdRaw), 10) : null;
        sendJson(res, 200, { logs: await listJobLogs(jobLogsMatch[1], { limit, beforeId }) });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load job logs", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/jobs/{id}
    const jobDetailMatch = /^\/admin\/api\/jobs\/([0-9a-fA-F-]+)$/.exec(path);
    if (method === "GET" && jobDetailMatch) {
      try {
        const job = await getJob(jobDetailMatch[1]);
        if (job === null) sendJson(res, 404, { error: "Admin job not found" });
        else sendJson(res, 200, { job: withJobErrorExplanation(job) });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load admin job", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/ocr/samples — list available sample files for testing.
    if (method === "GET" && path === "/admin/api/ocr/samples") {
      try {
        const samples = await ocrTestSamples.listSamples();
        sendJson(res, 200, { samples });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to list OCR samples", detail: String((exc as Error).message) });
      }
      return;
    }

    // GET /admin/api/ocr/samples/{id} — fetch sample file data.
    const ocrSampleMatch = /^\/admin\/api\/ocr\/samples\/([a-zA-Z0-9._-]+)$/.exec(path);
    if (method === "GET" && ocrSampleMatch) {
      try {
        const sampleId = ocrSampleMatch[1];
        const data = await ocrTestSamples.getSampleData(sampleId);
        if (!data) {
          sendJson(res, 404, { error: "Sample not found" });
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `inline; filename="${sampleId}"`);
        res.end(data);
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to fetch sample", detail: String((exc as Error).message) });
      }
      return;
    }

    // POST /admin/api/ocr/test — test OCR with a PDF or image file.
    if (method === "POST" && path === "/admin/api/ocr/test") {
      try {
        const { parseFormData } = await import("../formDataParser.js");
        const formFields = await parseFormData(req);

        const filename = String(formFields.filename ?? "file.pdf").trim() || "file.pdf";
        const fileData = formFields.file;
        if (!fileData || fileData.length === 0) {
          sendJson(res, 400, { error: "No file data provided" });
          return;
        }

        const { DrugAnalysisService, loadDrugAnalysisConfig } = await import("../drugAnalysisService.js");
        const service = new DrugAnalysisService(await loadDrugAnalysisConfig());

        // Run OCR only (Analysis LM is optional)
        const markdown = await service.ocrOnly({
          sourceFilename: filename,
          pdfBytes: fileData,
          // Inline MinerU result images so the preview can render them (Indra returns none).
          embedImages: true,
        });

        // Try analysis if configured, but don't fail if not
        let analysisJson: Record<string, unknown> | null = null;
        let analysisProvider = "";
        const [analysisReady] = service.analysisReadiness();
        if (analysisReady) {
          try {
            analysisJson = await service.analyzeMarkdown(markdown);
            analysisProvider = service.lastProfileUsed?.provider ?? "";
          } catch (analysisErr) {
            // Analysis failed, but OCR succeeded - return partial result
            analysisJson = { error: String((analysisErr as Error).message) };
          }
        }

        sendJson(res, 200, {
          ok: true,
          markdown,
          analysis: analysisJson,
          // The provider that answered — the fallback may have stepped in.
          ocrProvider: service.lastOcrProvider ?? service.config.ocrProvider,
          analysisProvider: analysisProvider || null,
          analysisConfigured: analysisReady,
        });
      } catch (exc) {
        const msg = adminSettings.errStr(exc);
        sendJson(res, 400, { error: "OCR test failed", detail: msg });
      }
      return;
    }
  } catch {
    // defensive: dispatch-level guard (individual handlers own their own errors)
    send404(res);
    return;
  }

  // Unmatched admin/api route → 404 (other endpoints land in later chunks).
  send404(res);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Mirror Python's `try: max/min(int(str(q or default))) except ValueError: default`.
 * Empty/absent → default string (Python's `... or "1"`); non-integer text falls
 * back to the unclamped default; valid ints go through `clamp`.
 */
function parseIntDefault(
  raw: unknown,
  def: number,
  clamp: (v: number) => number,
): number {
  const s = String(raw ?? "").trim() === "" ? String(def) : String(raw);
  const v = Number(s);
  if (!Number.isInteger(v)) return def;
  return clamp(v);
}

// Query keys forwarded verbatim as `str(v) if v else ""` (mirrors the big
// elif branch in server.py's preview param mapping).
const PREVIEW_STR_KEYS = new Set([
  "q",
  // Which installed IG the preview is scoped to (required by the `ig` preview).
  "package_id",
  "table",
  "category",
  "code_prefix",
  "code_from",
  "code_to",
  "zh_filter",
  "reference_filter",
  "component",
  "system",
  "property",
  "scale_type",
  "method_type",
  "specimen_type",
  "unit",
  "semantic_tag",
  "active",
  "language_code",
  "map_filter",
  "sort",
  "direction",
  "cs_id",
  "mode",
  "quality",
  "status",
  "class_",
  "resource_type",
  "grouping_id",
  "base_type",
  "element_source",
  "tty",
]);

/**
 * Faithful port of the preview kwargs construction in `src/server.py`
 * (`for k, v in query.items(): ...`). page/per_page become clamped ints, `id`
 * becomes `id_` int (skipped on parse error), `class`/`property`/`node` get the
 * Python-specific renames/null semantics, and `artifact_key`/`value_set_url`/
 * `field_q` are only kept for the `ig` module.
 */
function buildPreviewKwargs(
  query: Record<string, unknown>,
  dsKey: string,
): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(query)) {
    const v = Array.isArray(raw) ? String(raw[raw.length - 1] ?? "") : String(raw ?? "");
    if (k === "page" || k === "per_page") {
      const parsed = /^-?\d+$/.test(v) ? Number.parseInt(v, 10) : NaN;
      kwargs[k] = Number.isNaN(parsed) ? 1 : Math.max(1, parsed);
    } else if (k === "id") {
      if (/^-?\d+$/.test(v)) kwargs.id_ = Number.parseInt(v, 10);
    } else if (k === "class") {
      kwargs.class_ = v;
    } else if (k === "property") {
      kwargs.property_ = v ? v : "";
    } else if (k === "node") {
      kwargs.node = v ? v : null;
    } else if (k === "artifact_key" || k === "value_set_url" || k === "field_q") {
      if (dsKey === "ig") kwargs[k] = v ? v : "";
    } else if (PREVIEW_STR_KEYS.has(k)) {
      kwargs[k] = v ? v : "";
    }
  }
  return kwargs;
}

/**
 * After a settings save, hot-apply changes to long-lived app singletons so no
 * restart is needed (the worker picks up DB changes via the short-TTL cache).
 * Mirrors `server.py:_refresh_settings_singletons`. Best-effort: failures are
 * logged, never surfaced to the caller.
 */
async function refreshSettingsSingletons(group: string): Promise<void> {
  try {
    if (group === "embedding") {
      await reconfigureEmbeddingService();
    } else if (group === "minio") {
      // saveGroup already busted the "minio" cache; initialize() re-reads it.
      await minioService.initialize();
    }
  } catch (exc) {
    logWarning("Settings singleton refresh failed", { group, error: String((exc as Error).message) });
  }
}

/**
 * Collect the raw request body as a Buffer. Used by the binary upload endpoint
 * (express.json/urlencoded skip non-matching content-types, leaving the stream
 * readable). Rejects if the stream errors.
 */
function readRawBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Mirror Python `int(...)` coercion for JSON body values. Truncates floats
 * toward zero, parses integer strings; anything else throws (Python raises
 * ValueError/TypeError, both mapped to HTTP 400 by the schedule route).
 */
function toInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ScheduleValueError(`invalid int value: ${v}`);
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!/^[+-]?\d+$/.test(t)) throw new ScheduleValueError(`invalid literal for int() with base 10: ${JSON.stringify(v)}`);
    return Number.parseInt(t, 10);
  }
  throw new ScheduleValueError(`int() argument must be a number or string, not '${v === null ? "NoneType" : typeof v}'`);
}

function readCredentials(req: Request): { username: string; password: string } {
  // express.json() + express.urlencoded() populate req.body for both JSON and
  // form posts; mirror Python's str(...).strip() coercion.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  return { username, password };
}

function setSessionCookie(res: Response, cfg: AppConfig, username: string): void {
  const maxAge = Math.max(cfg.adminSessionTtlMinutes, 1) * 60;
  const token = buildAdminSessionToken(username, cfg.adminSessionSecret, {
    ttlMinutes: cfg.adminSessionTtlMinutes,
  });
  res.set("set-cookie", buildAdminSessionCookie(token, maxAge, cfg.adminCookieSecure));
}
