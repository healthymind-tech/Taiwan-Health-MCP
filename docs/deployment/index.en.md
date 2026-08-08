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
| `nginx` | **The front door** (`:8080` by default, set by `WEB_PORT`). Routes `/mcp`, `/openapi.json`, `/tools/*`, `/admin/api/*`, `/admin/ws`, `/fhir-client/*`, and `/fhir-oauth/*` to `app`, and everything else to `web`. |
| `web` | Next.js front-end: the `/admin` console SPA. |
| `app` | Node MCP server + admin REST API. **Only `expose`s port 8000 on the compose network; never published to the host.** |
| `admin-worker` | Background job runner: every import (including the three-stage drug pipeline) and embedding job. |
| `postgres` | PostgreSQL 16 + pgvector. |
| `pgbouncer` | Connection pool (transaction mode). |
| `redis` | Response cache. |
| `minio` + `minio-init` | Drug asset object storage and bucket initialisation. |

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
| `POSTGRES_PASSWORD` | `docker compose` fails outright when unset (compose enforces it with `:?`) | `openssl rand -hex 24` |
| `ADMIN_ENABLED` | Defaults to `false`; without it there is no `/admin`, and **no way to import any data** | Set to `true` |
| `ADMIN_USERNAME` | Admin console account | Defaults to `admin`; customisable |
| `ADMIN_INITIAL_PASSWORD`<br>or `ADMIN_PASSWORD_HASH` | Without a credential you cannot sign in | Pick one, see 2-2 |
| `ADMIN_SESSION_SECRET` | Session cookie signing key; also the fallback value for `FHIR_SERVER_SECRET_KEY` | `openssl rand -hex 32` |
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
| TFDA crawler, FHIR package registry | Edit directly in Admin → Settings (applied hot) |
| **MinIO (Storage)**, **Worker Tuning** | **Read-only** in the console, labelled "Owned by the deployment (.env / compose)". But since the values were already seeded into the database and the code reads the database, **editing `.env` has no effect either** — the only way is a direct `UPDATE admin.app_settings` followed by a restart of the relevant service. |
| Model endpoints (embedding / OCR / analysis LLM) | **Never read from `.env`**; configurable only in Admin → Settings |

`ADMIN_MAX_CONCURRENT_JOBS` is the exception: it never enters `admin.app_settings`. The worker reads the environment variable on every start, so editing `.env` and restarting the worker takes effect.

!!! danger "Set the MinIO credentials before the very first boot"
    `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` have two consumers that behave differently:

    - The `minio` container reads `.env` **on every start** for its root credentials (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`);
    - `app` / `admin-worker` use the copy **seeded into `admin.app_settings` on first boot** (`seedIfEmpty()` writes with `ON CONFLICT DO NOTHING` and never overwrites).

    Changing `.env` after the first boot leaves the MinIO server's credentials **out of sync** with the stored application settings, breaking object storage reads and writes.

    Worse, the **Storage group in Settings is read-only** (labelled "Owned by the deployment (.env / compose)"), so it cannot be fixed from the console. If this has already happened, the only route is the database:

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
MCP_TRANSPORT=streamable-http
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
docker compose build          # first build of the app / admin-worker / web images
docker compose up -d
```

On first boot the PostgreSQL container applies `db/schema.sql` automatically, and `minio-init` creates the bucket and exits (an `exited` status is normal).

### Step 4: Verify

Check container status — `postgres` / `redis` / `minio` / `pgbouncer` should be `healthy`:

```bash
docker compose ps
```

Check the services and each module's status:

```bash
curl http://localhost:8080/openapi.json | head  # currently registered tools
```

When startup fails, start with the logs:

```bash
docker compose logs -f app admin-worker
```

### Step 5: Sign in and configure the model endpoints

Open `http://<host>:8080/admin` and sign in with the credentials from step 2.

Then configure the external model endpoints under **Settings** (these **cannot** be set from `.env`):

| Sub-page | What it configures | Consequence if unset |
|----------|--------------------|----------------------|
| Embedding | Embedding endpoint / model (Ollama `qwen3-embedding` in the default scenario) | Search falls back to keyword mode; **Chinese keyword search finds almost nothing** |
| Analysis LM | The LLM used to extract drug inserts | The drug analysis stage cannot run |
| OCR | MinerU service address | Insert PDFs cannot be OCR'd |

Model settings can be moved between environments with the JSON Export / Import under Settings → Backup & restore. See [Admin Console](../admin/index.md).

### Step 6: Load data

Import module by module from the Modules tab. Licensed source files (ICD-10, LOINC, SNOMED CT, RxNorm, FHIR IG) must be uploaded first; drugs, health supplements, and food nutrition are fetched automatically via API.

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
docker compose build app web admin-worker
docker compose up -d --no-deps app web admin-worker
```

After changing `nginx/nginx.conf`:

```bash
docker compose restart nginx
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
  < db/migrations/20260802_llm_call_log.sql
```

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

**(a) Admin console (recommended)** — Settings → Backup & restore lets you select settings and credentials, the PostgreSQL database, and MinIO object storage. It queues a `system_backup` background job; the resulting ZIP is written back to the `system-backups/` prefix in MinIO and can be downloaded from the backup history.

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
| `/admin` returns 404 | `ADMIN_ENABLED` is not `true`, or the auth variables are incomplete | Complete them and run `docker compose up -d` |
| The admin password is correct but login fails | `$` in `.env` was not written as `$$`, truncating the hash | See the warning box in 2-2 |
| Changing the password in `.env` has no effect | The credential was written to `admin.admin_credentials` on first boot, and seeding uses `ON CONFLICT DO NOTHING` | Change it under Settings → Privacy instead |
| The worker raises `Illegal argument to function` / `Wrong key or corrupt data` | `FHIR_SERVER_SECRET_KEY` is empty, or differs between `app` and the worker | See 2-3 |
| Changing TFDA / registry settings in `.env` has no effect | That group is seed-only, read only on first boot | Change it in Admin → Settings |
| Changing MinIO / worker tuning in `.env` has no effect | Seed-only, and read-only in the console | `UPDATE admin.app_settings` directly, then restart the service (see 2-4) |
| Chinese search returns almost nothing | No embedding endpoint configured, so search fell back to keyword mode | Configure the endpoint under Settings → Embedding |
| The worker OOMs during an IG import | `NODE_OPTIONS` was lowered, or the container memory limit is too small | Keep `--max-old-space-size=8192` and give the container a 10G limit |
| `http://<host>:8000` is unreachable | By design — `app` publishes no host port | Always use `http://<host>:${WEB_PORT}` |

---

## Further reading

### [Architecture & Container Deployment](../architecture/deployment.md)
Infrastructure topology, container composition, and the startup sequence.

### [Configuration](configuration.md)
The full parameter reference, covering bootstrap variables (`.env`) and seed-only settings (managed in Admin → Settings after first boot).

### [Performance & Monitoring](performance.md)
Optimisation advice for high-concurrency scenarios, connection pool and cache strategy, and Prometheus monitoring.

!!! note "The public pages moved out of this repo"
    The public-facing marketing and legal pages (`/`, `/status`, `/privacy`, `/dpa`) are
    now served by a standalone marketing-site project, not by the `web` service here.
    `/privacy` is the URL registered with the Anthropic Connectors Directory, so once the
    new site is live, add the 301 redirects in `nginx/nginx.conf` (a TODO block is in place).
