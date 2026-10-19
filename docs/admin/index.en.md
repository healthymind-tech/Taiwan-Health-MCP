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

Besides passwords, sign-in also supports **passkeys / WebAuthn** (`node-server/src/admin/webauthn.ts`), managed on the Account security page (a new password set there must be at least 12 characters, also enforced server-side); passkeys only work over HTTPS on the RP domain (or on localhost for development). See [Configuration](../deployment/configuration.md).

## MCP tools page (`/admin/mcp`)

Backed by `node-server/src/admin/adminMcp.ts` (`GET /admin/api/mcp/overview`, `GET /admin/api/mcp/tools`, `POST /admin/api/mcp/tools/{name}/invoke`), with three tabs:

- **Overview**: public endpoints (`/mcp`, `/openapi.json`, `/tools/{name}`, JWKS, OAuth callback), auth mode, server version and copy-ready client configs.
- **Catalog**: all 63 tools defined in `mcp.ts` and whether each is registered; an unregistered tool shows why (gating table and row-count threshold); tools and groups whose module is in maintenance carry a 「維護中」 (under maintenance) badge.
- **Playground**: runs any registered tool with pre-filled examples, through the same handler as `POST /tools/{name}` (rate-limited); while the tool's module is in maintenance the Run button is disabled with the reason shown.

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
- **Embedding identity (fingerprint)**: `admin/embeddingIdentity.ts` stores the vectors of a fixed set of probe texts as the system's embedding identity (`admin.embedding_identity` / `admin.embedding_fingerprints`, defined in `db/schema.sql` and `db/migrations/20261021_embedding_identity.sql`; the code also creates them at runtime with `CREATE TABLE IF NOT EXISTS` as a safety net). A new endpoint may join an embedding profile only if every probe reaches cosine ≥ 0.95 — i.e. it is the same model. Switching models while vectors exist goes through a guarded flow: turn the embedding role off → stop embed jobs → wipe vectors (re-typing every `*_embeddings` vector column in the same transaction when the size changes, e.g. 1024 → 2560) → adopt the new identity → re-queue every module's embed job.
- **No identity row yet, but vectors exist** (data loaded by older versions): on the first embedding profile save, role binding, or the Overview button "確認現有向量的模型並建立指紋" (confirm the model of the stored vectors), the system takes a few stored vectors with their source text (verified against `source_hash`) and asks the role's endpoints, then every other embedding profile's endpoints, then the endpoints being added, to re-embed them; the first one that reproduces them is adopted. An unreachable or 404 endpoint is skipped, never adopted. If none matches, the API answers `embedding_identity_unresolved` (listing why each endpoint failed) instead of a raw HTTP error.
- **Every error carries a code**: model-endpoint failures (profile save, role binding, account / model test, fingerprint check, switch, settings import) answer with `code` + `params`; the console translates them into Chinese with the next step and keeps the raw server text in a collapsible "技術細節" (technical details). The main codes are listed under "Changing the embedding model" below.
- Role-level knobs (embedding timeout / batch size / concurrency, analysis max retries) live in the `embedding` / `analysis` groups of `admin.app_settings`.

### Changing the embedding model (switch flow)

**Editing a profile cannot change the embedding model.** Saving a member with another model (or another vector size) is refused (HTTP 409, `embedding_model_change_requires_switch`) and the console shows a guidance dialog instead: the current model and size, the requested model, how many vectors would be rebuilt and an estimated time, and a "改用切換模型流程" (use the switch flow) button that opens the switch dialog pre-filled with the same account, model and parameters. Binding a profile of a different model to the embedding role behaves the same way.

Switch steps (Model endpoints → Overview → Embedding → "切換模型…"):

1. Pick the account, model and vector size, then run the **pre-check** (`POST /admin/api/llm/embedding/precheck`, no side effects). It calls the new model and reports, before anything is deleted:
    - `embedding_model_not_found`: the server does not serve that model; the models it does serve are listed and can be picked with one click.
    - `embedding_dims_unsupported`: the vectors are not the configured size. Without `dimensions` sent, the model's native size differs (Qwen3-Embedding-4B is 2560); with it sent, the server rejected or ignored it. Two fixes: use the native size, or (Matryoshka models) enable "send dimensions" — vLLM must then be started with `--hf-overrides '{"is_matryoshka": true}'`, otherwise it answers HTTP 400.
    - `embedding_switch_same_model`: the endpoint already produces the system's vectors — no switch needed, add it to the profile as a fallback.
    - On success it shows the returned size and whether the vector columns will be re-typed (e.g. 1024 → 2560).
2. With vectors present, type `REINDEX` and run it. The system shuts the embedding role, stops embed jobs, wipes the vectors and re-types the columns, adopts the new identity, creates and binds a new profile, and queues a rebuild for every module that had vectors. Semantic search falls back to keyword matching meanwhile; ~600k vectors take roughly 1–2 h on a shared GPU (0.6B), about 3 h with the 4B model.
    When the GPU also serves production's live queries, lower `batch_size` (e.g. 8) under External services → Embedding before the rebuild and keep `concurrency` at 1: the smaller the batch, the shorter a single query waits behind one (measured with Qwen3-Embedding-4B: live single-query p95 ≈ 110–170 ms at batch 16, ≈ 80 ms at batch 8). `batch_size` is read when each job starts, `concurrency` applies live; a member's `rpm` caps only the average rate, not the peaks.

**Query instruction.** The model member's "query instruction" parameter decides whether search queries carry a task description. The default, "auto", prefixes `Instruct: <task>\nQuery: <query>` for the Qwen3-Embedding family (and gte-Qwen2-instruct) with one English task sentence per module (ICD, LOINC, SNOMED, IG concepts, food, health supplements) and leaves other models alone; it can also be "off" or a custom sentence used for every module (`params.query_instruction`: absent / `off` / text). Only query vectors are instructed — stored vectors and the identity-fingerprint probes never are — so changing it needs **no re-index**.

The Overview's embedding card probes every member of the role (cached 60 s): a failing member shows "Embedding route degraded: member X failing (reason) — failing over to Y" with a fix hint; the Service health page's embedding row uses the same probe.

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

Content is checked at upload time, so a wrong file is refused right away (with a zh-TW reason): file type (magic bytes); release archives must
contain the member the loader needs (LOINC `LoincTable/Loinc.csv`, SNOMED `sct2_Concept_*`, RxNorm `RXNCONSO.RRF`, the ICD-10-CM / PCS order file,
UMLS `MRCONSO.RRF`; archives whose directory cannot be listed, such as zip64, skip this check); CSVs must have their required columns (drug index;
LOINC Taiwan mapping `loinc_code,name_zh`; reference ranges `loinc_code,age_min,age_max,gender,range_low,range_high`). An IG upload import reads
`package/package.json` first and answers 422 — without creating a job — when the file is not a FHIR package.

When an import job binds its sources, a single-file source role uses its **active** version; only when the role has no active version does it fall
back to the most recent upload.

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

The `drug`, `icd`, `loinc`, `snomed`, `ig` and `rxnorm` modules can be switched into maintenance mode (`POST /admin/api/module-maintenance`; state lives in the `maintenance` group of `admin.app_settings`), to pause a module's MCP tools while its data is being reloaded or cleared: calls to the tools of a module in maintenance (over `/mcp`, `/tools/*` and the admin playground) return error code `MODULE_MAINTENANCE` immediately (English + Traditional Chinese message), while the tools stay in `tools/list` (no tool-list churn for clients). The state is cached for 5 seconds, so a toggle takes effect within about 5 seconds. ICD-10 and FHIR Condition follow `icd`, Drug and FHIR Medication follow `drug`, Lab follows `loinc`, FHIR IG follows `ig`; `rxnorm` has no tools of its own, so its flag is informational. The module page shows the tools as "paused (under maintenance)" and the MCP tools page marks the tool cards 「維護中」 (under maintenance). The error format is in the [API reference](../api/index.md#maintenance).

## External FHIR servers

Register external FHIR R4 servers on the FHIR servers page, configuring the permitted resource types and operations, OAuth authentication (including `private_key_jwt` key generation, with the public JWKS hosted at `/fhir-client/<id>/jwks.json`), the token strategy, and the health check path. After the OAuth Authorization Code callback the browser is sent back to `/admin/fhir-servers`.

The MCP side consumes them through `list_fhir_servers` / `get_fhir_server_status` / `crud_fhir_server`, with the server handling tokens on the caller's behalf — the caller never touches any secret.

> `crud_fhir_server` is the only tool in the system that can produce a write: write operations require the server's allow-list to permit them and the caller to pass `confirm_write=true`.

## Error messages and next steps { #errors }

Every admin API error response (HTTP ≥ 400) keeps its original `error` (English) and `detail` (raw technical text) and also carries:

| Field | Content |
|-------|---------|
| `code` | Stable machine code, e.g. `SOURCE_MISSING`, `DB_SCHEMA_OUTDATED`, `UPSTREAM_UNREACHABLE`, `JOB_ALREADY_ACTIVE` |
| `message_zh` | What happened (Traditional Chinese) |
| `hint_zh` | What to do next (which page, which setting, which command) |

`node-server/src/admin/adminErrorCodes.ts` produces them in one place: known English messages first (missing source files,
out-of-range settings, OAuth failures…), then the technical cause found in `detail` (PostgreSQL errors such as a missing
table / column → apply the migration, duplicate key, foreign key; connection refused, DNS, timeout, TLS, upstream HTTP status;
MinIO). When nothing matches, the message still names the failed operation and gives a generic next step. Responses that
already carry a `code` (model-endpoint API, IG removal, `MODULE_MAINTENANCE`) are left alone. Toasts show the explanation,
then the next step; the raw text appears only as small "技術細節" (technical details).

The same explanations apply to:

- **External services "Test connection"** (OCR / MinIO / TFDA): results gain `message_zh` / `hint_zh`.
- **Service health** probe rows and the **dashboard** infrastructure status: `message_zh` / `detail_zh` + `hint_zh`.
- **Failed background jobs**: `last_error_zh` / `last_error_hint_zh` (job detail, and "why the last import failed" on module pages).
- **Gateway errors**: when the app does not answer (nginx returns a 502 / 504 HTML page) the console says the backend is not responding and how to check it.

## DB health gate

`node-server/src/dbHealth.ts` is the central DB health monitor: when PostgreSQL is unreachable, it locks every mutating operation and shows an overlay in the UI, preventing imports or edits while the database is unhealthy.
