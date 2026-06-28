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
  verifyAdminPassword,
} from "../adminAuth.js";
import * as adminSettings from "./adminSettings.js";
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
import { listServiceProbes } from "./adminServices.js";
import { listIgs, getIgDetail, setDefault as setIgDefault, removeIg } from "./adminIg.js";
import { query } from "../db.js";
import { broadcast } from "./adminWs.js";
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
import { getDrugAdminStatus, getDrugPipelineStatus, getDrugLicenseEvents } from "./adminDrug.js";
import { getStates as getMaintenanceStates, setEnabled as setMaintenanceEnabled, MaintenanceValueError } from "./adminMaintenance.js";
import * as minioService from "../minioService.js";
import { buildAdminOverview } from "./adminOverview.js";
import { search as registrySearch } from "../loaders/igRegistry.js";
import { getDrugService as getDrugServiceForAdmin } from "../mcp.js";
import { reconfigureEmbeddingService } from "../embeddingService.js";
import { logWarning } from "../logger.js";
import { dispatchPreview, PREVIEW_SUPPORTED_MODULES } from "./adminPreview.js";

/** Send a JSON body with the same content-type Python `_send_json` uses. */
function sendJson(res: Response, status: number, payload: unknown): void {
  res.status(status).set("content-type", "application/json; charset=utf-8").send(JSON.stringify(payload));
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

/** Mirror Python `_send_404`: status 404, body "Not Found". */
function send404(res: Response): void {
  res.status(404).set("content-length", "9").send("Not Found");
}

function adminUsernameFromReq(req: Request): string | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  const cfg = config();
  return parseAdminSessionToken(cookies["tw_health_admin_session"], cfg.adminSessionSecret);
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
        hint: "Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and ADMIN_SESSION_SECRET.",
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
    if (username === cfg.adminUsername && verifyAdminPassword(password, cfg.adminPasswordHash)) {
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
    res.set("set-cookie", clearAdminSessionCookie());
    res.redirect(303, "/admin/login");
    return;
  }

  // 4d. JSON aliases for the SPA. MUST precede the auth gate.
  if (method === "POST" && path === "/admin/api/login") {
    const { username, password } = readCredentials(req);
    if (username === cfg.adminUsername && verifyAdminPassword(password, cfg.adminPasswordHash)) {
      setSessionCookie(res, cfg, username);
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 401, { ok: false, error: "Invalid username or password." });
    }
    return;
  }

  if (method === "POST" && path === "/admin/api/logout") {
    res.set("set-cookie", clearAdminSessionCookie());
    sendJson(res, 200, { ok: true });
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
    // GET /admin/api/registry/search?q=...  (FHIR package registry autocomplete)
    if (method === "GET" && path === "/admin/api/registry/search") {
      const q = String(req.query.q ?? "");
      try {
        const cfg = await adminSettings.getGroup("registry");
        const results = await registrySearch(String(cfg.base_url ?? ""), q);
        sendJson(res, 200, { results });
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
        sendJson(res, 200, await buildAdminOverview());
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
        sendJson(res, 200, await adminSettings.getAll());
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load settings", detail: String((exc as Error).message) });
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
          sendJson(res, 200, await adminSettings.testGroup(group, values));
        } else if (action === "") {
          const saved = await adminSettings.saveGroup(group, values, adminUsername);
          await refreshSettingsSingletons(group);
          sendJson(res, 200, { ok: true, values: saved });
        } else {
          sendJson(res, 404, { error: `Unknown action '${action}'` });
        }
      } catch (exc) {
        // Python raises ValueError → 400; any other exception → 500.
        const msg = String((exc as Error).message);
        if (/Unknown settings group|is not one of/.test(msg)) {
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
        const job = await createJob({
          moduleKey,
          jobType,
          requestedBy: adminUsername,
          jobOptions: (body.job_options as Record<string, unknown>) || {},
          sourceModuleSourceId: String((body.source_module_source_id ?? "") || "").trim(),
          sourceUploadedFileId: String((body.source_uploaded_file_id ?? "") || "").trim(),
        });
        sendJson(res, 201, { job });
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
        sendJson(res, 200, await listServiceProbes());
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load cached service probes", detail: String((exc as Error).message) });
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
        options = { ig_source: "upload", object_key: objectKey };
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
        sendJson(res, 201, { job });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to start IG import", detail: String((exc as Error).message) });
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
      const result = await removeIg({ packageId: pkgId, version: pkgVer, removedBy: adminUsername });
      await broadcast("module_changed", { module_key: "ig" });
      sendJson(res, result.removed ? 200 : 404, result);
      return;
    }

    // ── FHIR Servers registry (sub-step A: CRUD + pgcrypto) ───────────────────
    if (method === "GET" && path === "/admin/api/fhir-servers") {
      try {
        const includeDisabled = String(req.query.include_disabled ?? "false").trim().toLowerCase() === "true";
        const servers = await listFhirServers(includeDisabled);
        await attachOauthStatus(servers);
        sendJson(res, 200, { servers });
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
        sendJson(res, 200, result);
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
        sendJson(res, 200, result);
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
            sendJson(res, 200, { server });
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
        sendJson(res, 200, { jobs: await listJobs() });
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
        else sendJson(res, 200, { job });
      } catch (exc) {
        sendJson(res, 500, { error: "Failed to load admin job", detail: String((exc as Error).message) });
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
  res.set("set-cookie", buildAdminSessionCookie(token, maxAge));
}
