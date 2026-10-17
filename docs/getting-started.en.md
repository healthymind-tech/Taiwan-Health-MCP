# Getting Started

## Prerequisites

- Docker and Docker Compose
- (Optional) A reachable embedding server (Ollama with the `qwen3-embedding` model by default) for semantic / hybrid search. **Its endpoint is configured on the admin console's Model endpoints page (`/admin/models`), not through environment variables**; without it, search falls back to keyword mode automatically.
- Some data sources require licensed files you must obtain yourself (SNOMED CT, LOINC, the ICD-10 zips, and so on) — see [Data Sources](data-sources/index.md).

For local development outside Docker you need **Node.js 20 or newer**. The project has no Python runtime dependency.

## Start the services

```bash
cp .env.example .env                # set POSTGRES_PASSWORD and the other required variables
docker compose up -d
```

`docker compose up -d` starts:

| Service | Description |
|---------|-------------|
| `nginx` | **The single front door**, `:8080` by default (adjustable via `WEB_PORT`) |
| `web-v2` | The admin console SPA (`web-v2/`, Vite + React + Mantine), served by the container's nginx |
| `app` | Node MCP server + admin REST API (internal network only) |
| `admin-worker` | Background job runner (all imports and embedding jobs) |
| `postgres` | PostgreSQL 16 + pgvector |
| `pgbouncer` | Connection pool (transaction mode) |
| `redis` | Live event broadcast for the admin console and health probes (tool responses are not cached today) |
| `minio` + `minio-init` | Drug asset object storage and bucket initialisation |

!!! warning "All traffic goes through nginx"
    The `app` container only `expose`s port 8000 on the compose network — it is **never published to the host**.
    Always use `http://<host>:8080`; `http://<host>:8000` does not reach this system.

## Enable the admin console

Data imports are triggered from the admin console and executed by `admin-worker` in the background (there is no standalone CLI data-loader container). The console is enabled by default (`ADMIN_ENABLED=true`); you only need to set the sign-in credential and session key in `.env`:

```dotenv
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
# Generate a password hash (Node):
#   node -e "console.log('sha256$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
# ⚠️ Every $ must be written as $$ in .env (Docker Compose expands $ as a variable
#    reference, and a hash starting with a letter gets silently truncated).
#    Compose collapses $$ back to a single $.
ADMIN_PASSWORD_HASH=sha256$$...
# Or a plaintext initial password (hashed into the DB on first boot): ADMIN_INITIAL_PASSWORD=...
# Must replace the .env.example placeholder, or app refuses to start: openssl rand -hex 32
ADMIN_SESSION_SECRET=<random value>
```

After restarting (`docker compose up -d`), sign in at `http://<host>:8080/admin`. See [Admin Console](admin/index.md) for details.

## Load data (admin console module pages)

Import module by module from the sidebar's Data section (Terminology, Drug, Health supplements, Food nutrition) and FHIR → IG library:

| Type | Modules | Action |
|------|---------|--------|
| Source file upload required | ICD-10-CM (CMS order file) / PCS, LOINC, SNOMED CT, RxNorm, FHIR IG (`package.tgz`) | Upload the source file on the module page, then press import (IGs can also be fetched straight from the FHIR package registry) |
| Fetched automatically via API | Drugs (TFDA), health supplements, food nutrition | Press import directly, or set up a schedule |

- The **drug domain** is a three-stage pipeline (index → enrichment crawl → OCR/LLM analysis). The crawler's TFDA base URL and the OCR (MinerU) endpoint are configured under External services (`/admin/integrations`); the analysis LLM gets a provider account and profile under Model endpoints (`/admin/models`).
- **Embeddings** (semantic search) are separate `*_embed` jobs per module, runnable or schedulable from each module's page.
- Import progress, the step timeline, and live logs are on the **Jobs** page (`/admin/jobs`); the background mechanism is described in [Jobs & Scheduling](admin/jobs-and-worker.md).

## Connect a client

Both interfaces are served through the nginx front door (`:8080` by default):

### 1. MCP (native)

Served in `streamable-http` mode at `http://<host>:8080/mcp` by default, for native MCP clients (Claude Desktop, Open WebUI v0.6.31+ MCP connections, and so on).

### 2. OpenAPI bridge (for OpenAPI-only clients)

For clients that cannot speak MCP natively and only connect to OpenAPI tool servers (for example **Open WebUI's External Tools / OpenAPI type**), the server has a built-in OpenAPI layer — **no extra mcpo proxy or container required**:

- `GET http://<host>:8080/openapi.json` — an OpenAPI 3.1 spec generated dynamically from the currently enabled tools
- `POST http://<host>:8080/tools/<tool_name>` — invoke a tool with the arguments as a JSON body

In the client, just fill in the base URL `http://<host>:8080`; it fetches `/openapi.json` and lists every tool.

> Note: by default (`PUBLIC_TOOLS_AUTH_MODE=none`) `/mcp` and the OpenAPI bridge perform **no authentication**. When exposing them publicly, set `PUBLIC_TOOLS_AUTH_MODE=bearer` with a high-entropy `PUBLIC_TOOLS_BEARER_TOKEN`, and have clients send `Authorization: Bearer <token>`. See [Configuration](deployment/configuration.md).

## Verification

Check the services and each module's status:

```bash
curl http://localhost:8080/openapi.json | head  # currently registered tools
```

Per-module row counts and service health are on the admin console's Dashboard and Service health pages; every tool (including unregistered ones and why) can be browsed and tried on the MCP tools page (`/admin/mcp`).

You can also call the `health_check` tool directly:

```bash
curl -X POST http://localhost:8080/tools/health_check \
  -H 'Content-Type: application/json' -d '{}'
```

The response includes DB / cache / per-module status, the server `version` and `build` (git sha), `tools_version`, the loaded terminology editions (`terminology`), the installed IG packages and `default_ig`.

For code-level tests see [Testing](development/testing.md).
