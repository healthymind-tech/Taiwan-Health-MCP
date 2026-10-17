# Admin Console

The admin console is a session-authenticated operator interface mounted at `/admin`, used to upload source files, run and schedule data imports, manage model endpoints, settings and external FHIR servers, and monitor background jobs in real time. It is **enabled by default** (`ADMIN_ENABLED=true`) — it is the only way to import data; once the data is loaded you may set it to `false` to shrink a public deployment's attack surface (MCP tools, the worker and scheduled imports keep running).

## Enabling it and signing in

Set the following in `.env` and restart `app`:

```dotenv
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
# One of the two: a plaintext initial password (hashed into the DB on first boot), or a precomputed hash
ADMIN_INITIAL_PASSWORD=
# Generate a password hash (Node):
#   node -e "console.log('sha256$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
# ⚠️ Every $ must be written as $$ in .env (Docker Compose expands $ as a variable
#    reference, and a hash starting with a letter gets silently truncated).
#    Compose collapses $$ back to a single $.
ADMIN_PASSWORD_HASH=sha256$$...
ADMIN_SESSION_SECRET=<openssl rand -hex 32>
ADMIN_SESSION_TTL_MINUTES=240
ADMIN_MAX_UPLOAD_MB=512
# pgcrypto symmetric key for external FHIR servers' OAuth tokens / client secrets.
# Falls back to ADMIN_SESSION_SECRET when unset.
FHIR_SERVER_SECRET_KEY=
```

Password hashes support `sha256$<hex>` and `pbkdf2_sha256$<iterations>$<salt>$<hex>`. When both `ADMIN_INITIAL_PASSWORD` and `ADMIN_PASSWORD_HASH` are set the former wins, and both are used only on first boot, while the database has no credential row. `/admin` opens when `ADMIN_ENABLED=true`, `ADMIN_USERNAME`, and `ADMIN_SESSION_SECRET` all have values, and at least one of `ADMIN_PASSWORD_HASH` / `ADMIN_INITIAL_PASSWORD` is set (404 = console off, 503 = on but misconfigured, 401 = wrong credentials).

The sign-in URL is `http://<host>:8080/admin` (through the nginx front door; the `app` container publishes no host port).

> The admin console needs the `admin-worker` container running alongside it (the background job runner). `docker compose up -d` starts both.

> **Important:** `FHIR_SERVER_SECRET_KEY` (or its fallback, `ADMIN_SESSION_SECRET`) must be **identical** on the `app` and `admin-worker` containers. The worker uses this key to `pgp_sym_decrypt` external FHIR servers' OAuth tokens and client secrets; if the worker's key is empty or different, background jobs raise `Illegal argument to function` (empty key) or `Wrong key or corrupt data` (mismatched key).

## Interface

The admin interface is the React SPA in **`web-v2/`** (Vite + React 19 + Mantine 8). Its static build is served by a dedicated `web-v2` container (with its own nginx); the root `nginx/nginx.conf` routes `/admin` pages to `web-v2`, while `/admin/api/*` and `/admin/ws` go straight to `app`. Access control is enforced by the backend API's session cookie (default name `tw_health_admin_session`, overridable with `ADMIN_SESSION_COOKIE`); without a session the SPA redirects to `/admin/login`.

> The old Next.js front-end (`web/` + `web/admin-app/`) has been replaced. It is kept only in the compose profile `legacy-web` for rollback and is not started by default.

The sidebar (`web-v2/src/layout/nav.ts`) has five sections:

| Section | Pages (paths relative to `/admin`) | Purpose |
|---------|------|---------|
| **Overview** | Dashboard `/`, Jobs `/jobs` | System status at a glance; the import / embedding / sync job queue, step timeline and live logs (see [Jobs & Scheduling](jobs-and-worker.md)). |
| **Data** | Terminology `/terminology` (per module `/terminology/<icd\|loinc\|snomed\|rxnorm>`), Drug `/drug` (drug explorer `/drug/explorer`), Health supplements `/data/health_supplements`, Food nutrition `/data/food_nutrition` | Per-module source files, imports, schedules, data preview, embeddings, maintenance mode and clearing; terminology modules also get a browser (see below). |
| **FHIR** | IG library `/fhir/ig`, FHIR servers `/fhir-servers` | FHIR IG import / dependency packages / removal protection; registration, authentication and health checks for external FHIR R4 servers. |
| **Integrations** | Model endpoints `/models`, MCP tools `/mcp`, External services `/integrations` | Provider accounts and profiles for embedding and the analysis LLM; MCP endpoints, tool catalog and playground; OCR (MinerU), object storage, TFDA, FHIR package registry and worker settings. |
| **System** | Service health `/health`, Backups & settings `/system`, Account security `/security` | Infrastructure probes and worker heartbeats; system backups and settings export / import; password and passkeys. |

The corresponding backend modules are in `node-server/src/admin/*.ts` (`adminApp.ts` is the routing entry point).

Besides passwords, sign-in also supports **passkeys / WebAuthn** (`node-server/src/admin/webauthn.ts`), managed on the Account security page; passkeys only work over HTTPS on the RP domain (or on localhost for development). See [Configuration](../deployment/configuration.md).

## MCP tools page (`/admin/mcp`)

Backed by `node-server/src/admin/adminMcp.ts` (`GET /admin/api/mcp/overview`, `GET /admin/api/mcp/tools`, `POST /admin/api/mcp/tools/{name}/invoke`), with three tabs:

- **Overview**: public endpoints (`/mcp`, `/openapi.json`, `/tools/{name}`, JWKS, OAuth callback), auth mode, server version and copy-ready client configs.
- **Catalog**: all 63 tools defined in `mcp.ts` and whether each is registered; an unregistered tool shows why (gating table and row-count threshold).
- **Playground**: runs any registered tool with pre-filled examples, through the same handler as `POST /tools/{name}` (rate-limited).

## Model endpoints (`/admin/models`)

Embedding and analysis-LLM endpoints are **never read from environment variables**. They live in these tables (migration `20261016_llm_providers_and_routes.sql`):

| Table | Contents |
|-------|----------|
| `admin.llm_providers` | Provider accounts: a named account of a provider type (several per type allowed) with URL, credentials and account-wide limits. |
| `admin.llm_routes` | Profiles: a strategy (`single` / `fallback` / `round_robin` / `load_balance`) over a set of members; `kind` is `analysis` or `embedding`. |
| `admin.llm_route_members` | Members: a model on a provider account (with its own knobs), **or another profile** (nesting; cycles are rejected). |
| `admin.llm_role_routes` | Which profile each role (`analysis` / `embedding`) uses. |

The old `admin.llm_profiles` table was renamed `admin.llm_profiles_legacy` and is kept for rollback only.

- **Provider adapters**: `node-server/src/providers/registry.ts` registers 24 adapters — OpenAI, Azure OpenAI, Anthropic, Gemini, Bedrock, Mistral, Cohere, Voyage, Jina, DeepSeek, xAI, Groq, OpenRouter, Together, Fireworks, SiliconFlow, DashScope, Moonshot, Zhipu, Volcengine, MiniMax, OpenAI-compatible servers (vLLM, LM Studio, LiteLLM…), Ollama, and ChatGPT. Legacy values `vllm` / `google` / `azure` / `claude` resolve to the new ids (migration `20261015_llm_provider_registry.sql` also rewrites stored rows).
- **ChatGPT sign-in**: the `chatgpt` provider uses OpenAI's "Sign in with ChatGPT" PKCE flow (`admin/chatgptOAuth.ts`). The redirect can only be a local loopback, so the operator pastes the browser's final URL back into the console to finish the exchange; tokens are stored in `admin.llm_providers.oauth` and never leave the server.
- **Embedding identity (fingerprint)**: `admin/embeddingIdentity.ts` stores the vectors of a fixed set of probe texts as the system's embedding identity (`admin.embedding_identity` / `admin.embedding_fingerprints`, defined in `db/schema.sql` and `db/migrations/20261021_embedding_identity.sql`; the code also creates them at runtime with `CREATE TABLE IF NOT EXISTS` as a safety net). A new endpoint may join an embedding profile only if every probe reaches cosine ≥ 0.95 — i.e. it is the same model. Switching models while vectors exist goes through a guarded flow: turn the embedding role off → stop embed jobs → wipe vectors → adopt the new identity → re-queue every module's embed job.
- Role-level knobs (embedding timeout / batch size / concurrency, analysis max retries) live in the `embedding` / `analysis` groups of `admin.app_settings`.

## Settings and precedence

Bootstrap variables (DB / Redis / MCP transport / `ADMIN_*` auth) originate in `.env`. On first boot, `ADMIN_INITIAL_PASSWORD` (hashed) or `ADMIN_PASSWORD_HASH` is written into `admin.admin_credentials`, and subsequent sign-ins validate only against the hash in the database. Seeding uses `ON CONFLICT DO NOTHING`, so once the credential row exists, editing `.env` or restarting the service never overwrites a working password. Passwords and passkeys are both managed under Account security (`/admin/security`).

The other external-system settings (MinIO, TFDA base URL, FHIR package registry, worker tuning) are **seed-only**: `.env` is read exactly once, on first boot, for keys not yet present in `admin.app_settings`. Afterwards manage and test them under External services (`/admin/integrations`); editing `.env` has no effect on an already-seeded database. TFDA and registry can be edited there (applied hot); **MinIO and worker tuning are read-only groups**.

The OCR (MinerU) endpoint lives in the `ocr` group of `admin.app_settings`. It is **not seeded from `.env`** and is configured and tested only under External services → OCR.

Settings export / import (format version 3) under Backups & settings (`/admin/system`) moves a working configuration between installs: it carries every `admin.app_settings` group, the provider accounts / profiles / role bindings (keys included), and the passkeys with their RP ID. Older v1 / v2 exports still import. The export contains secrets in the clear — store it like a credential.

## System backups { #system-backups }

The Backups & settings page lets you select settings and credentials, the PostgreSQL database, and MinIO object storage individually.
Creating a backup only queues a `system_backup` background job; the worker streams the PostgreSQL custom dump and the MinIO objects into a ZIP chunk by chunk, then writes it back to the `system-backups/` prefix in MinIO with a multipart upload — the whole backup is never assembled in a single HTTP request or in Node's memory. Once finished, it can be streamed down from the backup history through a same-origin API.

Backups contain API keys, login credentials, and medical data, and should be managed as production secrets. The database dump restores with PostgreSQL 16 `pg_restore`; the object storage files are in the ZIP's `object-storage/` directory.

## Source files

Upload each module's source files in the sources section of its module page (ICD-10-CM CMS order-file zip, ICD-10-PCS, LOINC zip, SNOMED RF2, RxNorm zip, FHIR IG `package.tgz`, and so on), optionally specifying a source role (such as an IG dependency package or the optional WHO ICD-10 source). The system blocks duplicate uploads by file fingerprint (SHA-256); files are stored in MinIO and fetched back when a job runs.

> Uploads must send `Content-Type: application/octet-stream` (the SPA does), or express's JSON parser intercepts them and returns 413.

## Terminology browsers

The Terminology module pages and the IG library include read-only browsers backed by `GET /admin/api/terminology/*` (`node-server/src/admin/termViz/`):

| Browser | API prefix | Contents |
|---------|------------|----------|
| ICD-10-CM tree / WHO ICD-10 tree | `icd/cm/*`, `icd/who/*` | Chapter → category → code hierarchy, paths and search |
| ICD-10-PCS axes | `icd/pcs/*` | Tables by the first three characters, filtered on axes 4–7 |
| SNOMED CT graph | `snomed/*` | Concept neighbourhood (parents / children / attribute relationships) and search |
| LOINC axes | `loinc/*` | Six-axis facet filtering, term detail, LA / LP / LL codes |
| RxNorm | `rxnorm/*` | Summary, search by TTY, concept detail |
| IG CodeSystem tree | `ig/codesystem*` | Concept hierarchy and search for CodeSystems inside an IG package |

## Maintenance mode

The `drug`, `icd`, `loinc`, `snomed`, `ig` and `rxnorm` modules can be switched into maintenance mode (`POST /admin/api/module-maintenance`; state lives in the `maintenance` group of `admin.app_settings`), to flag a module while its data is being reloaded or cleared. Today it is a **console-level flag**: the module page shows the tools as "available (under maintenance)", but the MCP tools themselves do **not** stop responding.

## External FHIR servers

Register external FHIR R4 servers on the FHIR servers page, configuring the permitted resource types and operations, OAuth authentication (including `private_key_jwt` key generation, with the public JWKS hosted at `/fhir-client/<id>/jwks.json`), the token strategy, and the health check path. After the OAuth Authorization Code callback the browser is sent back to `/admin/fhir-servers`.

The MCP side consumes them through `list_fhir_servers` / `get_fhir_server_status` / `crud_fhir_server`, with the server handling tokens on the caller's behalf — the caller never touches any secret.

> `crud_fhir_server` is the only tool in the system that can produce a write: write operations require the server's allow-list to permit them and the caller to pass `confirm_write=true`.

## DB health gate

`node-server/src/dbHealth.ts` is the central DB health monitor: when PostgreSQL is unreachable, it locks every mutating operation and shows an overlay in the UI, preventing imports or edits while the database is unhealthy.
