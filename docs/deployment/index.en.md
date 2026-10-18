# Deployment Guide

This section explains how to deploy the Taiwan Health MCP server to production. The project is container-first; Docker deployment is strongly recommended for environment consistency.

For the full variable reference see [Configuration](configuration.md). This page is the **ordered deployment procedure**.

## Supported environments
- **Operating system**: Linux (Ubuntu/CentOS), macOS, Windows (WSL2)
- **Container platform**: Docker Engine 24+ with Docker Compose v2 (`docker compose`, not the legacy `docker-compose`)
- **Node.js**: 20 or newer (for bare-metal deployment or local development). The project has no Python runtime dependency.

### Resource requirements

| Item | Minimum | Recommended | Notes |
|------|---------|-------------|-------|
| CPU | 2 cores | 4+ cores | Imports and embedding jobs are the dominant load |
| Memory | 8 GB | 16 GB+ | `admin-worker` alone is configured with `--max-old-space-size=8192` (required by FHIR IG imports) |
| Disk | 20 GB | 100 GB+ | PostgreSQL plus MinIO drug assets (inserts / labels / pill images) grow continuously |

The embedding service, OCR (MinerU), and the analysis LLM are all **external HTTP services**. They are not part of this compose stack — provision them separately and configure them in the admin console.

## Services

`docker compose up -d` starts the following services:

| Service | Description |
|---------|-------------|
| `nginx` | **The front door** (`:8080` by default, set by `WEB_PORT`). Routes `/mcp`, `/openapi.json`, `/tools/*`, `/admin/api/*`, `/admin/ws`, `/fhir-client/*`, and `/fhir-oauth/*` to `app`, and everything else (the `/admin` pages) to `web-v2`. |
| `web-v2` | Static build of the admin console SPA (`web-v2/`, Vite + React + Mantine), served by the container's own nginx. |
| `app` | Node MCP server + admin REST API. **Only `expose`s port 8000 on the compose network; never published to the host.** |
| `admin-worker` | Background job runner: every import (including the three-stage drug pipeline) and embedding job. |
| `postgres` | PostgreSQL 16 + pgvector. |
| `pgbouncer` | Connection pool (transaction mode). |
| `redis` | Live event broadcast for the admin console and health probes (tool responses are **not** cached today). |
| `minio` + `minio-init` | Object storage for source files, drug assets and system backups, plus bucket initialisation. |

The old Next.js front-end `web` is kept only in the compose profile `legacy-web` (for rollback) and is **not started by default**; bring it back with `docker compose --profile legacy-web up -d web` and restore `$th_frontend` in `nginx/nginx.conf` at the same time.

Data imports are triggered from the admin console and run inside `admin-worker`; there is no longer a standalone data-loader container.

!!! warning "Application traffic goes through nginx only"
    Never use `http://<host>:8000` in documentation or client configuration — `app` does not publish that port to the host.
    All application traffic (including MCP) must go through `http://<host>:8080`.

    (`postgres` and `minio` do publish ports to the host for operational access; for production see [Exposed ports and hardening](#external-ports).)

---

## Deployment procedure

### Step 1: Get the code

```bash
git clone https://github.com/healthymind-tech/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
```

### Step 2: Create `.env`

```bash
cp .env.example .env
```

The defaults in `.env.example` **must not go straight to production**. The following must be handled:

#### 2-1. Required / must-change variables

| Variable | Why it matters | Suggested approach |
|----------|----------------|--------------------|
| `POSTGRES_PASSWORD` | `docker compose` fails outright when unset (compose enforces it with `:?`); **`app` refuses to start while the `.env.example` placeholder is still in place** | `openssl rand -hex 24` |
| `ADMIN_ENABLED` | Defaults to `true` (`/admin` is the **only** way to import data). Set it to `false` once the data is loaded, to shrink a public deployment's attack surface | As needed |
| `ADMIN_USERNAME` | Admin console account | Defaults to `admin`; customisable |
| `ADMIN_INITIAL_PASSWORD`<br>or `ADMIN_PASSWORD_HASH` | Without a credential you cannot sign in | Pick one, see 2-2 |
| `ADMIN_SESSION_SECRET` | Session cookie signing key — holding it is enough to forge a session for any user, no password involved; also the fallback for `FHIR_SERVER_SECRET_KEY`. **`app` refuses to start while the `.env.example` placeholder is still in place** | `openssl rand -hex 32` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Default to `minioadmin` / `minioadmin`, effectively no password | `openssl rand -hex 16` each |
| `PUBLIC_BASE_URL` | Public origin, used to build the OAuth2 redirect_uri and to derive the WebAuthn RP ID | `https://your-domain.example.com` |
| `PUBLIC_TOOLS_AUTH_MODE` / `PUBLIC_TOOLS_BEARER_TOKEN` | Defaults to `none`, meaning `/mcp` and `/tools/*` are completely unauthenticated | Set `bearer` + `openssl rand -hex 32` when publicly reachable |
| `WEB_PORT` | Public port | Defaults to `8080`; adjust per environment |

Generate every random value at once:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "ADMIN_SESSION_SECRET=$(openssl rand -hex 32)"
echo "FHIR_SERVER_SECRET_KEY=$(openssl rand -hex 32)"
echo "MINIO_ACCESS_KEY=$(openssl rand -hex 16)"
echo "MINIO_SECRET_KEY=$(openssl rand -hex 16)"
echo "PUBLIC_TOOLS_BEARER_TOKEN=$(openssl rand -hex 32)"
```

#### 2-2. Set the admin console password

Pick one of two approaches:

**(a) Plaintext initial password (simpler)** — used only on first boot, when the database has no credential row yet, and ignored forever afterwards:

```dotenv
ADMIN_INITIAL_PASSWORD=your-strong-password
```

**(b) A pre-computed hash**:

```bash
node -e "console.log('sha256\$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
```

```dotenv
ADMIN_PASSWORD_HASH=sha256$$1a2b3c...
```

When both are set, `ADMIN_INITIAL_PASSWORD` wins. Password hashes support `sha256$<hex>` and `pbkdf2_sha256$<iterations>$<salt>$<hex>`.

!!! danger "Every `$` in `.env` must be written as `$$`"
    Docker Compose interpolates variables in `.env`, so a single `$` is read as a variable reference.
    When the hash starts with a letter (for example `sha256$abc…`), `$abc…` is treated as an undefined
    variable and the value is **silently truncated to `sha256`** — login then fails forever with no
    obvious error message.

    Write every `$` as `$$` (Compose collapses it back to a single `$`). A `pbkdf2_sha256$...$...$...`
    hash contains several `$`; double each one. The same applies when the password itself or
    `ADMIN_SESSION_SECRET` contains a `$`.

#### 2-3. Keep the encryption key consistent

`FHIR_SERVER_SECRET_KEY` is the pgcrypto symmetric key for external FHIR servers' OAuth tokens and client secrets, falling back to `ADMIN_SESSION_SECRET` when unset. `compose.yaml` passes it to both `app` and `admin-worker`, and **the two must match** — otherwise the worker fails to decrypt with `Illegal argument to function` (empty key) or `Wrong key or corrupt data` (mismatched key).

#### 2-4. Know which settings are read only once

Seed-only settings (MinIO, the TFDA crawler, the FHIR package registry, worker tuning) are **read from `.env` exactly once, on first boot**, and written into `admin.app_settings` (`seedIfEmpty()` inserts key by key with `ON CONFLICT DO NOTHING`). Editing `.env` afterwards has no effect. How changeable they remain, however, **differs**:

| Settings group | How to change it after first boot |
|----------------|-----------------------------------|
| TFDA crawler, FHIR package registry | Edit directly under External services (`/admin/integrations`) in the console (applied hot) |
| **MinIO (Storage)**, **Worker Tuning** | **Read-only** in the console, labelled "Owned by the deployment (.env / compose)". But since the values were already seeded into the database and the code reads the database, **editing `.env` has no effect either** — the only way is a direct `UPDATE admin.app_settings` followed by a restart of the relevant service. |
| Model endpoints (embedding / analysis LLM), OCR | **Never read from `.env`**: embedding and the analysis LLM are configured under Model endpoints (`/admin/models`), OCR under External services → OCR |

`ADMIN_MAX_CONCURRENT_JOBS` is the exception: it never enters `admin.app_settings`. The worker reads the environment variable on every start, so editing `.env` and restarting the worker takes effect.

!!! danger "Set the MinIO credentials before the very first boot"
    `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` have two consumers that behave differently:

    - The `minio` container reads `.env` **on every start** for its root credentials (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`);
    - `app` / `admin-worker` use the copy **seeded into `admin.app_settings` on first boot** (`seedIfEmpty()` writes with `ON CONFLICT DO NOTHING` and never overwrites).

    Changing `.env` after the first boot leaves the MinIO server's credentials **out of sync** with the stored application settings, breaking object storage reads and writes.

    Worse, the **MinIO group under External services is read-only** (labelled "Owned by the deployment (.env / compose)"), so it cannot be fixed from the console. If this has already happened, the only route is the database:

    ```sql
    UPDATE admin.app_settings SET value = '<new-access-key>'
     WHERE group_key = 'minio' AND key = 'access_key';
    UPDATE admin.app_settings SET value = '<new-secret-key>'
     WHERE group_key = 'minio' AND key = 'secret_key';
    ```

    Then restart `app` and `admin-worker`.

See [Configuration](configuration.md#settings-precedence) for details.

#### 2-5. A minimal working `.env`

```dotenv
# --- Public ---
WEB_PORT=8080
PUBLIC_BASE_URL=https://taiwan-health-mcp.example.com

# --- Database ---
POSTGRES_DB=taiwan_health
POSTGRES_USER=mcp
POSTGRES_PASSWORD=<openssl rand -hex 24>

# --- MCP ---
MCP_PORT=8000
MCP_PATH=/mcp
PUBLIC_TOOLS_AUTH_MODE=bearer
PUBLIC_TOOLS_BEARER_TOKEN=<openssl rand -hex 32>

# --- Admin console ---
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
ADMIN_INITIAL_PASSWORD=<strong password; write any $ as $$>
ADMIN_SESSION_SECRET=<openssl rand -hex 32>
ADMIN_COOKIE_SECURE=true          # set explicitly when TLS terminates at a proxy
FHIR_SERVER_SECRET_KEY=<openssl rand -hex 32>

# --- Object storage (seed-only: read on first boot) ---
MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=<openssl rand -hex 16>
MINIO_SECRET_KEY=<openssl rand -hex 16>
MINIO_BUCKET=taiwan-health-drug-assets
```

### Step 3: Build and start

```bash
BUILD_SHA=$(git rev-parse --short HEAD) docker compose build   # builds the app / admin-worker / web-v2 images
docker compose up -d
```

`compose.yaml` passes the `BUILD_SHA` environment variable (default `dev`) as a build arg to `app` and `admin-worker`: `app` reports it in the `build` field of the `health_check` response, and `admin-worker` records it in its startup log (the `build` field of `Admin worker started`). `web-v2` does not use it.

On first boot the PostgreSQL container applies `db/schema.sql` automatically, and `minio-init` creates the bucket and exits (an `exited` status is normal).

### Step 4: Verify

Check container status — `postgres` / `redis` / `minio` / `pgbouncer` should be `healthy`:

```bash
docker compose ps
```

Check the services and each module's status:

```bash
curl http://localhost:8080/openapi.json | head  # currently registered tools
curl -X POST http://localhost:8080/tools/health_check -H 'Content-Type: application/json' -d '{}'
```

`health_check` returns DB / cache / per-module status, the server `version`, `build` (git sha), `tools_version` (per-tool versions), the loaded terminology editions (`terminology`), the installed IG packages and `default_ig`.

When startup fails, start with the logs:

```bash
docker compose logs -f app admin-worker
```

### Step 5: Sign in and configure the model endpoints

Open `http://<host>:8080/admin` and sign in with the credentials from step 2.

Then configure the external model endpoints (these **cannot** be set from `.env`):

| Page | What it configures | Consequence if unset |
|------|--------------------|----------------------|
| Model endpoints (`/admin/models`) → Embedding | Create a provider account, then an embedding profile bound to the embedding role (e.g. Ollama `qwen3-embedding`) | Search falls back to keyword mode; **Chinese keyword search finds almost nothing** |
| Model endpoints (`/admin/models`) → Analysis | A profile for the LLM used to extract drug inserts | The drug analysis stage cannot run |
| External services (`/admin/integrations`) → OCR | MinerU service address | Insert PDFs cannot be OCR'd |

Settings can be moved between environments with the settings export / import under Backups & settings (`/admin/system`). See [Admin Console](../admin/index.md).

### Step 6: Load data

Import module by module from each module page (Terminology, Drug, Health supplements, Food nutrition, IG library). Licensed source files (ICD-10, LOINC, SNOMED CT, RxNorm, FHIR IG) must be uploaded first; drugs, health supplements, and food nutrition are fetched automatically via API.

!!! warning "A manually queued `drug_enrichment` is not protected by the batch cap"
    `DRUG_AUTOCHAIN_BATCH_LIMIT` (default 200) **applies only to auto-chained jobs**.
    A manually queued `drug_enrichment` with no `limit` crawls the entire pending queue,
    issuing tens of thousands of requests against the TFDA site.

For the steps and scheduling see [Getting Started](../getting-started.md) and [Jobs & Scheduling](../admin/jobs-and-worker.md).

---

## Day-2 operations

### Updating and redeploying

When only application code changed, there is no need to restart the whole stack:

```bash
git pull
BUILD_SHA=$(git rev-parse --short HEAD) docker compose build app admin-worker web-v2
docker compose up -d --no-deps app admin-worker web-v2
```

!!! warning "`admin-worker` is a separate image"
    `admin-worker` is built by `Dockerfile.worker` from the same `node-server/` source. Changing job / loader code
    (`adminJobs.ts`, `*Service.ts`, `loaders/*`) but rebuilding only `app` leaves the worker running stale code with no error.

### Rollback tags

Before redeploying, tag the images currently running so you can switch straight back if something breaks:

```bash
LABEL=rollback-pre-$(date +%Y%m%d)
for svc in app admin-worker web-v2; do
  docker tag taiwan-health-mcp-$svc:latest taiwan-health-mcp-$svc:$LABEL
done
```

(The image-name prefix is the compose project name; check `docker images`.) To roll back, re-tag the image as `:latest` and run `docker compose up -d --no-deps <service>`. Database migrations do not roll back with the images — back up the database before applying one.

After changing `nginx/nginx.conf` (a single-file bind mount — edit it in place and reload):

```bash
docker compose exec nginx nginx -s reload    # or: docker compose restart nginx
```

Containers only need recreating when a **bootstrap variable** in `.env` changed (DB / Redis / MCP / `ADMIN_*`):

```bash
docker compose up -d
```

(Changing the seed-only block has no effect; see 2-4.)

### Database migrations

`db/schema.sql` is applied automatically on first boot. **Existing environments** must apply the incremental changes under `db/migrations/` themselves, in filename date order:

```bash
docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < db/migrations/20261020_loinc_structure.sql
```

Migrations added in 2026-10 (apply in order; all are folded into `db/schema.sql`):

| File | Contents |
|------|----------|
| `20261015_llm_provider_registry.sql` | Data only: rewrites legacy provider values to registry ids (`vllm` → `openai_compatible`, `google` → `gemini`, …) |
| `20261016_llm_providers_and_routes.sql` | Adds `admin.llm_providers` / `llm_routes` / `llm_route_members` / `llm_role_routes`, migrates the old rows, renames `admin.llm_profiles` to `admin.llm_profiles_legacy` |
| `20261017_icd10cm_complete_edition.sql` | Complete ICD-10-CM edition: `short_name_en`, `is_header` columns and `icd.editions` |
| `20261018_terminology_completeness_v4.sql` | LOINC LA/LP/LL/LG codes and `loinc.editions`, SNOMED inactive concepts / descriptions, `first_released`, `snomed.editions`, WHO ICD-10 (`icd.icd10_who`) |
| `20261019_ig_install_origin.sql` | `fhir.ig_packages.install_origin` / `installed_for` |
| `20261020_loinc_structure.sql` | LOINC axis part links, answer lists, panels and MapTo tables |
| `20261021_embedding_identity.sql` | `admin.embedding_identity` / `admin.embedding_fingerprints` (embedding identity; the code also creates them at runtime, so applying it is idempotent either way) |
| `20261022_ig_concept_search.sql` | IG concept search: `fhir.concept_index_cs` / `_concepts` / `_terms`, `fhir.concept_embeddings`, `fhir.term_thesaurus`, `fhir.codesystem_supplements`. Afterwards press "補建索引" in admin → IG packages → 術語搜尋索引 (`ig_concept_index`, followed by `ig_embed`) |
| `20261023_umls_terms.sql` | Optional UMLS synonym store `fhir.umls_terms` / `fhir.umls_release` (needs a UMLS licence; the engine works without it) |

After `20261017`, `20261018` and `20261020`, re-import the matching modules (ICD, LOINC, SNOMED CT) to fill the new tables.

To apply all of them in order (drop the ones already applied yourself — the project has no built-in migration version tracking):

```bash
for f in $(ls db/migrations/*.sql | sort); do
  echo "applying $f"
  docker compose exec -T postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < "$f"
done
```

!!! tip "Credentials are expanded inside the container"
    The `$POSTGRES_USER` / `$POSTGRES_DB` above are expanded **inside the container** (which is why the
    whole command is wrapped in a single-quoted `sh -c`), so nothing needs exporting or substituting on the host.

!!! note "Connect to postgres directly, not pgbouncer"
    Run migrations through the `postgres` container. pgBouncer runs in transaction mode and is unsuitable for DDL batches.

### Backups

Two approaches:

**(a) Admin console (recommended)** — Backups & settings (`/admin/system`) lets you select settings and credentials, the PostgreSQL database, and MinIO object storage. It queues a `system_backup` background job; the resulting ZIP is written back to the `system-backups/` prefix in MinIO and can be downloaded from the backup history.

**(b) Manual**:

```bash
# PostgreSQL (custom format, for pg_restore)
docker compose exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backup-$(date +%F).dump

# MinIO objects (volume level)
docker run --rm -v taiwan-health-mcp_minio_data:/data -v "$PWD":/backup \
  alpine tar czf /backup/minio-$(date +%F).tar.gz -C /data .
```

> The volume name is prefixed with the compose project name (the directory name by default); confirm the actual name with `docker volume ls`.

Backups contain API keys, login credentials, and medical data — **treat them as production secrets**.

### Exposed ports and hardening { #external-ports }

Ports `compose.yaml` currently publishes to the host:

| Service | Port | Binding | Production recommendation |
|---------|------|---------|---------------------------|
| `nginx` | `${WEB_PORT}` → 80 | All interfaces | Put a TLS reverse proxy in front |
| `postgres` | `5432` | **All interfaces** | Rebind to `127.0.0.1:5432:5432` or remove |
| `minio` | `9000` | **All interfaces** | Rebind to `127.0.0.1:9000:9000` or remove |
| `minio` console | `9001` | `127.0.0.1` | Leave as is |
| `redis` | `6379` | `127.0.0.1` | Leave as is |
| `app` metrics | `${METRICS_PORT}` | `127.0.0.1` | Leave as is |

Pre-launch checklist:

- [ ] `POSTGRES_PASSWORD`, `ADMIN_SESSION_SECRET`, and `FHIR_SERVER_SECRET_KEY` are all strong random values
- [ ] MinIO credentials no longer use the `minioadmin` defaults
- [ ] `postgres:5432` / `minio:9000` rebound to `127.0.0.1` or blocked by a firewall
- [ ] `PUBLIC_TOOLS_AUTH_MODE=bearer` with a high-entropy token (if `/mcp` is publicly reachable)
- [ ] TLS terminates at a front proxy and `ADMIN_COOKIE_SECURE=true`
- [ ] `.env` permissions tightened (`chmod 600 .env`) and kept out of version control

Override the port bindings with `docker-compose.override.yml` instead of editing `compose.yaml`:

```yaml
services:
  postgres:
    ports:
      - "127.0.0.1:5432:5432"
  minio:
    ports:
      - "127.0.0.1:9000:9000"
```

The same override file is a good home for [resource limits](configuration.md#resource-limits).

### Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `docker compose up` fails immediately with `POSTGRES_PASSWORD is required` | The variable is unset in `.env` | Set it (compose enforces it with `:?`) |
| `/admin` returns 404 | `ADMIN_ENABLED` was set to false | Set it back to `true` and run `docker compose up -d` |
| `/admin` returns 503 | Enabled, but the auth variables are incomplete | Check the `missing` field in the startup log, fill them in and restart |
| The admin password is correct but login fails | `$` in `.env` was not written as `$$`, truncating the hash | See the warning box in 2-2 |
| Changing the password in `.env` has no effect | The credential was written to `admin.admin_credentials` on first boot, and seeding uses `ON CONFLICT DO NOTHING` | Change it under Account security (`/admin/security`) instead |
| The worker raises `Illegal argument to function` / `Wrong key or corrupt data` | `FHIR_SERVER_SECRET_KEY` is empty, or differs between `app` and the worker | See 2-3 |
| Changing TFDA / registry settings in `.env` has no effect | That group is seed-only, read only on first boot | Change it under External services (`/admin/integrations`) |
| Changing MinIO / worker tuning in `.env` has no effect | Seed-only, and read-only in the console | `UPDATE admin.app_settings` directly, then restart the service (see 2-4) |
| Chinese search returns almost nothing | No embedding endpoint configured, so search fell back to keyword mode | Configure an embedding profile under Model endpoints (`/admin/models`) |
| The worker OOMs during an IG import | `NODE_OPTIONS` was lowered, or the container memory limit is too small | Keep `--max-old-space-size=8192` and give the container a 10G limit |
| `http://<host>:8000` is unreachable | By design — `app` publishes no host port | Always use `http://<host>:${WEB_PORT}` |
| A change to job / loader code has no effect | Only `app` was rebuilt; `admin-worker` still runs the old image | `docker compose build admin-worker && docker compose up -d --no-deps admin-worker` |

---

## Isolated staging stack

`deploy/staging/compose.yaml` is a stack fully isolated from production (compose project `twh-staging`): its own Postgres, Redis, MinIO, `app`, `admin-worker` and `web-v2`. The `web-v2` container is the front door (its nginx proxies the backend via `BACKEND_UPSTREAM`), published on `${STAGING_PORT:-8090}`; the entry point is `http://<host>:8090/admin/`.

Before starting it, create an **untracked** `deploy/staging/.env` containing at least:

| Variable | Purpose |
|----------|---------|
| `STAGING_DB_PASSWORD` | Staging Postgres password (compose fails without it) |
| `STAGING_MINIO_PASSWORD` | Staging MinIO root password (compose fails without it) |
| `STAGING_RESTORE_DIR` | Host directory holding the production DB dump, mounted read-only at `/restore` in Postgres (compose fails without it) |
| `STAGING_HOST` / `STAGING_PORT` | Optional; used to build `PUBLIC_BASE_URL`, default port `8090` |

```bash
BUILD_SHA=$(git rev-parse --short HEAD) docker compose -p twh-staging -f deploy/staging/compose.yaml up -d --build
```

Notes:

- `app` / `admin-worker` also read the root `.env` (`env_file`) and then override the DB / Redis / MinIO connections with staging values.
- Staging runs over http, so it sets `ADMIN_COOKIE_SECURE=false` and uses its own cookie name, `ADMIN_SESSION_COOKIE=tw_health_admin_session_staging` — cookies are scoped per host, not per port, so on a shared host production's `Secure` cookie of the default name would shadow it and loop the staging login.
- Postgres mounts the host directory `${STAGING_RESTORE_DIR}` read-only at `/restore` for restoring a production dump; after restoring, disable the inherited jobs / schedules and model endpoints so staging does not compete with production for external resources.

---

## Further reading

### [Architecture & Container Deployment](../architecture/deployment.md)
Infrastructure topology, container composition, and the startup sequence.

### [Configuration](configuration.md)
The full parameter reference, covering bootstrap variables (`.env`) and seed-only settings (managed under External services in the console after first boot).

### [Performance & Monitoring](performance.md)
Optimisation advice for high-concurrency scenarios, connection pool and cache strategy, and Prometheus monitoring.

!!! note "The public pages moved out of this repo"
    The public-facing marketing and legal pages (`/`, `/status`, `/privacy`, `/dpa`) are
    now served by a standalone marketing-site project, not by this repo's front-end.
    `/privacy` is the URL registered with the Anthropic Connectors Directory, so once the
    new site is live, add the 301 redirects in `nginx/nginx.conf` (a TODO block is in place).
