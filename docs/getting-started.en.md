# Getting Started

## Prerequisites

- Docker and Docker Compose
- (Optional) A reachable embedding server (Ollama with the `qwen3-embedding` model by default) for semantic / hybrid search. **Its endpoint is configured in the admin console's Settings tab, not through environment variables**; without it, search falls back to keyword mode automatically.
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
| `web` | Next.js front-end: public pages plus the `/admin` console SPA |
| `app` | Node MCP server + admin REST API (internal network only) |
| `admin-worker` | Background job runner (all imports and embedding jobs) |
| `postgres` | PostgreSQL 16 + pgvector |
| `pgbouncer` | Connection pool (transaction mode) |
| `redis` | Response cache |
| `minio` + `minio-init` | Drug asset object storage and bucket initialisation |

!!! warning "All traffic goes through nginx"
    The `app` container only `expose`s port 8000 on the compose network — it is **never published to the host**.
    Always use `http://<host>:8080`; `http://<host>:8000` does not reach this system.

## Enable the admin console

Data imports are triggered from the admin console and executed by `admin-worker` in the background (there is no standalone CLI data-loader container), so enable the console in `.env` first:

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
```

After restarting (`docker compose up -d`), sign in at `http://<host>:8080/admin`. See [Admin Console](admin/index.md) for details.

## Load data (Admin console → Modules)

Import module by module from the Modules tab:

| Type | Modules | Action |
|------|---------|--------|
| Source file upload required | ICD-10-CM/PCS, LOINC, SNOMED CT, RxNorm, FHIR IG (`package.tgz`) | Upload the source file under Sources / Modules, then press import |
| Fetched automatically via API | Drugs (TFDA), health supplements, food nutrition | Press import directly, or set up a schedule |

- The **drug domain** is a three-stage pipeline (index → enrichment crawl → OCR/LLM analysis). The TFDA base URL used by the crawler is configurable in Settings; the OCR (MinerU) and analysis LLM endpoints live in `admin.llm_profiles` and are likewise managed in Settings.
- **Embeddings** (semantic search) are separate `*_embed` jobs per module, runnable or schedulable from each module's page.
- Import progress, the step timeline, and live logs are on the **Tasks** tab; the background mechanism is described in [Jobs & Scheduling](admin/jobs-and-worker.md).

## Connect a client

Both interfaces are served through the nginx front door (`:8080` by default):

### 1. MCP (native)

Served in `streamable-http` mode at `http://<host>:8080/mcp` by default, for native MCP clients (Claude Desktop, Open WebUI v0.6.31+ MCP connections, and so on).

### 2. OpenAPI bridge (for OpenAPI-only clients)

For clients that cannot speak MCP natively and only connect to OpenAPI tool servers (for example **Open WebUI's External Tools / OpenAPI type**), the server has a built-in OpenAPI layer — **no extra mcpo proxy or container required**:

- `GET http://<host>:8080/openapi.json` — an OpenAPI 3.1 spec generated dynamically from the currently enabled tools
- `POST http://<host>:8080/tools/<tool_name>` — invoke a tool with the arguments as a JSON body

In the client, just fill in the base URL `http://<host>:8080`; it fetches `/openapi.json` and lists every tool.

> Note: `/mcp` and the OpenAPI bridge currently perform **no authentication by default**. When exposing them publicly, put a reverse proxy or token in front.

## Verification

Check the services and each module's status:

```bash
curl http://localhost:8080/status.json          # per-module row counts and service health
curl http://localhost:8080/openapi.json | head  # currently registered tools
```

You can also call the `health_check` tool directly:

```bash
curl -X POST http://localhost:8080/tools/health_check \
  -H 'Content-Type: application/json' -d '{}'
```

For code-level tests see [Testing](development/testing.md).
