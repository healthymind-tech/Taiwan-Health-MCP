# Configuration

The system is configured through two layers: environment variables and database settings (`admin.app_settings` / `admin.llm_profiles`). Copy `.env.example` to `.env` and edit it:

```bash
cp .env.example .env
```

## Settings precedence (important) { #settings-precedence }

| Category | Stored in | Notes |
|----------|-----------|-------|
| **Bootstrap variables** | `.env` only | DB / Redis / MCP transport / `ADMIN_*` auth / `WEB_PORT`. These must be known before startup and never enter the database. |
| **Seed-only settings** | `.env` → `admin.app_settings` | MinIO, the TFDA crawler, the FHIR package registry, worker tuning, and so on. **Read exactly once, on first boot, for keys that do not yet exist**, to seed the database; editing `.env` has no effect on an already-seeded database. TFDA and registry settings can then be managed in Admin → Settings (applied hot); **MinIO and worker tuning are read-only groups in the console**, so changing them later requires a direct `UPDATE admin.app_settings` and a service restart. |
| **Model endpoints** | Database only (`admin.llm_profiles`) | Embedding, OCR (MinerU), and the analysis LLM. **Never read from environment variables**; configurable only in Admin → Settings, and movable between environments with Settings → Export / Import. |

---

## Bootstrap variables (`.env`)

### Public port

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PORT` | `8080` | **The port the nginx front door publishes to the host.** This is the system's only public entry point. |

> The `app` container only `expose`s `MCP_PORT` (8000) on the internal network and never publishes it to the host. Clients always connect to `http://<host>:${WEB_PORT}`.

### PostgreSQL

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | **Required** | PostgreSQL password (compose fails outright when unset) |
| `POSTGRES_DB` | `taiwan_health` | Database name |
| `POSTGRES_USER` | `mcp` | Database user |
| `DATABASE_URL` | Composed by compose | `postgresql://<user>:<pass>@pgbouncer:5432/<db>`. Only needs setting by hand when running outside Docker. |

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://redis:6379/0` (set by compose; the program's own default is `redis://localhost:6379/0`) | Redis connection URL |

### MCP transport

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_HOST` | `0.0.0.0` | Listen host (HTTP mode) |
| `MCP_PORT` | `8000` | **Container-internal** listen port. Never published to the host. |
| `MCP_PATH` | `/mcp` | HTTP endpoint path |
| `PUBLIC_TOOLS_AUTH_MODE` | `none` | Authentication mode for the public MCP / OpenAPI bridge: `none` or `bearer`. `bearer` is recommended in production. |
| `PUBLIC_TOOLS_BEARER_TOKEN` | empty | The token required in bearer mode; use a high-entropy random value. |
| `PUBLIC_TOOLS_CORS_ORIGINS` | empty | Permitted browser origins (comma-separated). `*` is not allowed in bearer mode; empty means no cross-origin browser calls are permitted. |

### Application and monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `INFO` | `DEBUG` \| `INFO` \| `WARNING` \| `ERROR` |
| `METRICS_PORT` | `9090` | Prometheus metrics endpoint (bound to `127.0.0.1` only) |

### Admin console authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_ENABLED` | `true` | Mounts `/admin`. Accepts `true/1/yes/on` and `false/0/no/off`; anything else aborts startup |
| `ADMIN_USERNAME` | `admin` | Operator account |
| `ADMIN_PASSWORD_HASH` | empty | `sha256$<hex>` or `pbkdf2_sha256$<iterations>$<salt>$<hex>` |
| `ADMIN_INITIAL_PASSWORD` | empty | A plaintext initial password, used **only on first boot while the database has no credential row**: it is hashed into `admin.admin_credentials` once and ignored forever afterwards. Takes precedence over `ADMIN_PASSWORD_HASH` when both are set. The plaintext is never persisted. |
| `ADMIN_SESSION_SECRET` | empty | Session cookie signing key |
| `ADMIN_SESSION_TTL_MINUTES` | `240` | Session lifetime |
| `ADMIN_COOKIE_SECURE` | empty (automatic) | `true` / `false`. When empty, the cookie's `Secure` attribute is added if `PUBLIC_BASE_URL` uses HTTPS. Set it explicitly to `true` when TLS terminates at an external proxy and no public URL is configured. |
| `ADMIN_MAX_UPLOAD_MB` | `512` | Source file upload cap |
| `FHIR_SERVER_SECRET_KEY` | empty (falls back to `ADMIN_SESSION_SECRET`) | pgcrypto symmetric key for external FHIR servers' OAuth tokens and client secrets. **Must be identical on `app` and `admin-worker`**, or the worker's decryption raises `Illegal argument to function` (empty key) or `Wrong key or corrupt data` (mismatched key). |

`/admin` opens (`adminReady()`) when `ADMIN_ENABLED=true`, `ADMIN_USERNAME`, and `ADMIN_SESSION_SECRET` all have values, and **at least one** of `ADMIN_PASSWORD_HASH` / `ADMIN_INITIAL_PASSWORD` is set.

Generating a password hash (Node):

```bash
node -e "console.log('sha256$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
```

!!! warning "Write every `$` in `.env` as `$$`"
    Docker Compose interpolates variables in `.env`, so a single `$` is read as a variable
    reference and the hash value is silently truncated (especially when the digest starts with
    a letter). Write every `$` as `$$`; Compose collapses it back to a single `$`.

### Passkeys / WebAuthn (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_BASE_URL` | empty | The public origin (`scheme://host`), used to build the OAuth2 redirect_uri and to derive the WebAuthn RP ID. When empty it is derived from the request's `Host` header. |
| `WEBAUTHN_RP_ID` | The host of `PUBLIC_BASE_URL`, falling back to `taiwan-health-mcp.gugulu.tw` | The registrable domain the admin console is served from |
| `WEBAUTHN_RP_NAME` | `Taiwan Health MCP — Admin` | The name shown in the OS passkey prompt |
| `WEBAUTHN_ORIGIN` | `https://<WEBAUTHN_RP_ID>` | Allow-list of expected origins (comma-separated) |

`compose.yaml` passes all four variables to `app`. A production deployment should at least set
`PUBLIC_BASE_URL`; set `WEBAUTHN_*` only when the derived values need overriding.

---

## Seed-only settings (managed in Admin → Settings after first boot)

### MinIO (drug assets)

| Variable | Default |
|----------|---------|
| `MINIO_ENDPOINT` | `minio:9000` (use `localhost:9000` outside Docker) |
| `MINIO_ACCESS_KEY` | `minioadmin` |
| `MINIO_SECRET_KEY` | `minioadmin` |
| `MINIO_BUCKET` | `taiwan-health-drug-assets` |
| `MINIO_SECURE` | `false` |
| `MINIO_PRESIGN_TTL_SECONDS` | `3600` |

### Drug / TFDA crawler

| Variable | Default | Description |
|----------|---------|-------------|
| `DRUG_TFDA_BASE_URL` | `https://mcp.fda.gov.tw` | TFDA site base URL |
| `DRUG_HTTP_TIMEOUT` | `30` | Per-request HTTP timeout (seconds) |
| `DRUG_CRAWLER_CONCURRENCY` | `4` | Crawler concurrency |
| `DRUG_AUTOCHAIN_BATCH_LIMIT` | `200` | The licenses each follow-on job processes when auto-chaining (index → enrichment → analysis). **Applies only to auto-chained jobs**; a manually queued job without a `limit` processes the entire pending queue. |
| `DRUG_ANALYSIS_PROMPT_PATH` | `src/prompts/drug/analysis_prompt.txt` | Path to the analysis LLM's system prompt |

### Background worker tuning

| Variable | Default (program) | Description |
|----------|-------------------|-------------|
| `ADMIN_WORKER_NAME` | `admin-worker` | Worker identifier (used for heartbeats and job claiming) |
| `ADMIN_WORKER_POLL_SECONDS` | `3` | Queue poll interval |
| `ADMIN_HEARTBEAT_INTERVAL_SECONDS` | `15` | Heartbeat interval |
| `ADMIN_WORKER_STALE_AFTER_SECONDS` | `45` | No heartbeat for longer than this counts as lost |
| `ADMIN_MAX_CONCURRENT_JOBS` | `4` | Maximum concurrent jobs (per-module resource slots apply on top). Read from the environment on every worker start — not stored in `admin.app_settings`. |
| `ADMIN_SCHEDULE_SCAN_INTERVAL_SECONDS` | `60` | Schedule scan interval |
| `NODE_OPTIONS` | `--max-old-space-size=8192` (set by compose on the worker) | IG imports load whole dependency packages — **do not lower this**. |

### Source file paths for local development

In production, source files are uploaded to MinIO through the admin console; the variables below only specify file locations when running a loader locally.

| Variable | Default |
|----------|---------|
| `FHIR_CODE_DIR` | `<repo>/fhir-code` |
| `ICD_CM_ZIP` / `ICD_PCS_ZIP` / `ICD_XLSX` | The matching files under `fhir-code/icd/10/...` |
| `LOINC_ZIP_PATH` | `fhir-code/loinc/2.80/Loinc_2.80.zip` |
| `LOINC_MAPPING_CSV` / `LOINC_RANGES_CSV` | The mapping tables under `data/loinc/` |
| `SNOMED_ZIP` | `fhir-code/snomed/SnomedCT_InternationalRF2_PRODUCTION_*.zip` |
| `RXNORM_ZIP` | `fhir-code/rxnorm/RxNorm_full_*.zip` |
| `IG_TGZ` | `fhir-code/twcoreig/**/package.tgz` |

---

## MCP client configuration

### streamable-http (production, recommended)

Claude Desktop:

```json
{
  "mcpServers": {
    "taiwan-health": {
      "url": "http://<host>:8080/mcp",
      "transport": "streamable-http"
    }
  }
}
```

---

## Recommended resource limits (production) { #resource-limits }

Add resource limits in `docker-compose.override.yml`:

```yaml
services:
  app:
    deploy:
      resources:
        limits:
          memory: 2G
  admin-worker:
    deploy:
      resources:
        limits:
          memory: 10G     # needed by IG imports, matching NODE_OPTIONS=--max-old-space-size=8192
  postgres:
    deploy:
      resources:
        limits:
          memory: 4G
  redis:
    deploy:
      resources:
        limits:
          memory: 512M
```

---

## Advanced pgBouncer settings

pgBouncer is configured through the `edoburu/pgbouncer` image's environment variables. The important ones (see `compose.yaml`):

| Parameter | Value | Description |
|-----------|-------|-------------|
| `POOL_MODE` | `transaction` | Release the connection after each transaction |
| `MAX_CLIENT_CONN` | `500` | Up to 500 client connections |
| `DEFAULT_POOL_SIZE` | `30` | Up to 30 PostgreSQL connections |
| `MIN_POOL_SIZE` | `5` | Pre-warmed connections |
| `AUTH_TYPE` | `scram-sha-256` | Authentication method |
| `IGNORE_STARTUP_PARAMETERS` | `extra_float_digits` | Driver compatibility setting |
