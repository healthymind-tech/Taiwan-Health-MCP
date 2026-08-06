# Admin Console

The admin console is a session-authenticated operator interface mounted at `/admin`, used to upload source files, run and schedule data imports, manage settings and external FHIR servers, and monitor background jobs in real time. It is **disabled by default**.

## Enabling it

Set the following in `.env` and restart `app`:

```dotenv
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
# Generate a password hash (Node):
#   node -e "console.log('sha256$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
# ⚠️ Every $ must be written as $$ in .env (Docker Compose expands $ as a variable
#    reference, and a hash starting with a letter gets silently truncated).
#    Compose collapses $$ back to a single $.
ADMIN_PASSWORD_HASH=sha256$$...
ADMIN_SESSION_SECRET=change_this_admin_session_secret
ADMIN_SESSION_TTL_MINUTES=240
ADMIN_MAX_UPLOAD_MB=512
# pgcrypto symmetric key for external FHIR servers' OAuth tokens / client secrets.
# Falls back to ADMIN_SESSION_SECRET when unset.
FHIR_SERVER_SECRET_KEY=
```

Password hashes support `sha256$<hex>` and `pbkdf2_sha256$<iterations>$<salt>$<hex>`. You may instead supply a plaintext initial password with `ADMIN_INITIAL_PASSWORD` (effective on first boot only). `/admin` opens when `ADMIN_ENABLED=true`, `ADMIN_USERNAME`, and `ADMIN_SESSION_SECRET` all have values, and at least one of `ADMIN_PASSWORD_HASH` / `ADMIN_INITIAL_PASSWORD` is set.

The sign-in URL is `http://<host>:8080/admin` (through the nginx front door; the `app` container publishes no host port).

> The admin console needs the `admin-worker` container running alongside it (the background job runner). `docker compose up -d` starts both.

> **Important:** `FHIR_SERVER_SECRET_KEY` (or its fallback, `ADMIN_SESSION_SECRET`) must be **identical** on the `app` and `admin-worker` containers. The worker uses this key to `pgp_sym_decrypt` external FHIR servers' OAuth tokens and client secrets; if the worker's key is empty or different, background jobs raise `Illegal argument to function` (empty key) or `Wrong key or corrupt data` (mismatched key).

## Interface

The admin interface is a React SPA in **`web/admin-app/`**, mounted client-side by the Next.js front-end (the `web` service) under the `/admin` catch-all route; `web/middleware.ts` gates access on the `tw_health_admin_session` cookie.

The main tabs:

| Tab | Purpose |
|-----|---------|
| **Overview** | System overview: DB, per-module, worker, and external FHIR server health. |
| **Services** | Availability and probe results for each service / module. |
| **Tasks** | The import job queue, progress, step timeline, and live logs (see [Jobs & Scheduling](jobs-and-worker.md)). |
| **Modules** | Per-module source files, imports, schedules, previews, embeddings, and maintenance mode. |
| **Settings** | Organised into Embedding, Analysis LM, OCR, integrations, Privacy, and Backup sub-pages; manages DB-backed settings, LLM profiles, login credentials, and system backups. |
| **FHIR Servers** | Register and manage external FHIR R4 servers, authentication, and health checks. |

The corresponding backend modules are in `node-server/src/admin/*.ts` (`adminApp.ts` is the routing entry point).

Besides passwords, sign-in also supports **passkeys / WebAuthn** (`node-server/src/admin/webauthn.ts`); passkeys only work over HTTPS on the RP domain (or on localhost for development). See [Configuration](../deployment/configuration.md).

## Settings and precedence

Bootstrap variables (DB / Redis / MCP transport / `ADMIN_*` auth) originate in `.env`. On first boot, `ADMIN_PASSWORD_HASH` is written into `admin.admin_credentials`, and subsequent sign-ins validate only against the hash in the database. Seeding uses `ON CONFLICT DO NOTHING`, so once the credential row exists, editing `.env` or restarting the service never overwrites a working password. Passwords and passkeys are both managed under Settings → Privacy.

The other external-system settings (MinIO, TFDA base URL, worker tuning) are **seed-only**: `.env` is read exactly once, on first boot, while `admin.app_settings` is empty. Editing `.env` afterwards has no effect on an already-seeded database. TFDA and registry settings can then be managed and tested in the Settings tab (applied hot); **MinIO and worker tuning are read-only groups** there, so changing them later requires a direct `UPDATE admin.app_settings` and a service restart.

**Model endpoints (embedding / OCR / analysis LLM) are never read from environment variables.** They live only in `admin.llm_profiles` and are configurable only in the Settings sub-pages. Use the JSON Export / Import under Settings → Backup & restore to move a working configuration between installs.

## System backups

Settings → Backup & restore lets you select settings and credentials, the PostgreSQL database, and MinIO object storage individually.
Creating a backup only queues a `system_backup` background job; the worker streams the PostgreSQL custom dump and the MinIO objects into a ZIP chunk by chunk, then writes it back to the `system-backups/` prefix in MinIO with a multipart upload — the whole backup is never assembled in a single HTTP request or in Node's memory. Once finished, it can be streamed down from the backup history through a same-origin API.

Backups contain API keys, login credentials, and medical data, and should be managed as production secrets. The database dump restores with PostgreSQL 16 `pg_restore`; the object storage files are in the ZIP's `object-storage/` directory.

## Source files

Upload each module's source files under Modules / Sources (ICD zip, LOINC zip, SNOMED RF2, RxNorm zip, FHIR IG `package.tgz`, and so on), optionally specifying a source role (such as an IG dependency package). The system blocks duplicate uploads by file fingerprint; files are stored in MinIO and fetched back when a job runs.

> Uploads must send `Content-Type: application/octet-stream`, or express's JSON parser intercepts them and returns 413.

## Maintenance mode

Each module can be switched into maintenance mode: while it is on, that module's MCP tools stop responding (returning a maintenance message), so the data can be reloaded or cleared safely without read/write races.

## External FHIR servers

Register external FHIR R4 servers on the FHIR Servers tab, configuring the permitted resource types and operations, OAuth authentication (including `private_key_jwt` key generation, with the public JWKS hosted at `/fhir-client/<id>/jwks.json`), the token strategy, and the health check path.

The MCP side consumes them through `list_fhir_servers` / `get_fhir_server_status` / `crud_fhir_server`, with the server handling tokens on the caller's behalf — the caller never touches any secret.

> `crud_fhir_server` is the only tool in the system that can produce a write: write operations require the server's allow-list to permit them and the caller to pass `confirm_write=true`.

## DB health gate

`node-server/src/dbHealth.ts` is the central DB health monitor: when PostgreSQL is unreachable, it locks every mutating operation and shows an overlay in the UI, preventing imports or edits while the database is unhealthy.
