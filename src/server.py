import asyncio
import inspect
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

import audit
import cache as cache_module
import database
import metrics
from audit import audited
from clinical_guideline_service import ClinicalGuidelineService
from config import AppConfig
from dataset_status import DatasetStatusManager
from embedding_service import EmbeddingService
from fhir_condition_service import FHIRConditionService
from food_nutrition_service import FoodNutritionService
from health_food_service import HealthFoodService
from icd_service import ICDService
from lab_service import LabService
from snomed_service import SNOMEDService
from twcore_service import TWCoreService
from utils import configure_log_level, log_error, log_info, log_warning

config = AppConfig.from_env()
configure_log_level(config.log_level)

# Services (populated once on first lifespan run)
icd_service: ICDService | None = None
health_food_service: HealthFoodService | None = None
food_nutrition_service: FoodNutritionService | None = None
fhir_condition_service: FHIRConditionService | None = None
lab_service: LabService | None = None
guideline_service: ClinicalGuidelineService | None = None
twcore_service: TWCoreService | None = None
snomed_service: SNOMEDService | None = None

# FastMCP (streamable-http mode) runs the lifespan once per session, not per
# process.  Guard all one-time initialization behind a lock + flag so that
# the second session simply reuses the already-initialized resources.
_init_lock: asyncio.Lock | None = None  # created lazily inside async context
_initialized: bool = False
_db_stats_task: asyncio.Task | None = None
_dataset_status = DatasetStatusManager()


@asynccontextmanager
async def lifespan(server):
    global icd_service, health_food_service, food_nutrition_service
    global fhir_condition_service, lab_service, guideline_service, twcore_service
    global snomed_service
    global _init_lock, _initialized, _db_stats_task

    # Lazily create the lock (must happen inside the running event loop)
    if _init_lock is None:
        _init_lock = asyncio.Lock()

    async with _init_lock:
        if not _initialized:
            log_info(f"Starting Taiwan Health MCP — {config}")

            # ── Prometheus metrics server ─────────────────────────────────
            if config.transport != "stdio":
                metrics.start_metrics_server()

            # ── Infrastructure ────────────────────────────────────────────
            # statement_cache_size=0 required for pgBouncer transaction-mode
            pool = await database.init_pool(
                config.database_url, min_size=5, max_size=20, statement_cache_size=0
            )
            await cache_module.init_client(config.redis_url)

            # ── Start DB pool stats collector ─────────────────────────────
            _db_stats_task = await metrics.start_db_stats_collector(database.get_pool)

            # ── Embedding (semantic search) ───────────────────────────────
            embedding_svc = EmbeddingService()
            await embedding_svc.initialize()

            # ── Services ──────────────────────────────────────────────────
            for name, factory in [
                ("ICDService", lambda: ICDService(pool, embedding_svc)),
                ("HealthFoodService", lambda: HealthFoodService(pool, embedding_svc)),
                (
                    "FoodNutritionService",
                    lambda: FoodNutritionService(pool, embedding_svc),
                ),
                ("FHIRConditionService", lambda: FHIRConditionService(pool)),
                ("LabService", lambda: LabService(pool, embedding_svc)),
                (
                    "ClinicalGuidelineService",
                    lambda: ClinicalGuidelineService(pool, embedding_svc),
                ),
                ("TWCoreService", lambda: TWCoreService(pool)),
                ("SNOMEDService", lambda: SNOMEDService(pool, embedding_svc)),
            ]:
                try:
                    svc = factory()
                    await svc.initialize()
                    if name == "ICDService":
                        icd_service = svc
                    elif name == "HealthFoodService":
                        health_food_service = svc
                    elif name == "FoodNutritionService":
                        food_nutrition_service = svc
                    elif name == "FHIRConditionService":
                        fhir_condition_service = svc
                    elif name == "LabService":
                        lab_service = svc
                    elif name == "ClinicalGuidelineService":
                        guideline_service = svc
                    elif name == "TWCoreService":
                        twcore_service = svc
                    elif name == "SNOMEDService":
                        snomed_service = svc
                except Exception as e:
                    log_error(f"{name} failed to initialize", error=str(e))

            # ── Redis warm-up ─────────────────────────────────────────────
            await _warm_up_cache()

            # ── Initial tool registration based on available datasets ────────
            await _dataset_status.refresh_if_stale_and_sync(pool, SERVICE_TOOLS, mcp)

            _initialized = True
            log_info("All services initialized — server ready")

    yield

    # Session teardown — do NOT close shared resources; the process may still
    # be serving other sessions.  Resources are reclaimed when the process exits.


async def _warm_up_cache() -> None:
    """Pre-warm the most frequently accessed, slow-changing data."""
    warmed = 0
    try:
        if lab_service:
            result = await lab_service.list_categories()
            warmed += await cache_module.warm_up(
                [("mcp:lab:categories:warm", result, 86400)]
            )
        if twcore_service:
            result = await twcore_service.list_codesystems("all")
            warmed += await cache_module.warm_up(
                [("mcp:twcore:list:warm", result, 86400)]
            )
        if guideline_service:
            for code in ("E11", "I10", "E78", "N18"):
                result = await guideline_service.get_complete_guideline(code)
                warmed += await cache_module.warm_up(
                    [(f"mcp:guideline:warm:{code}", result, 86400)]
                )
        log_info(f"Cache warm-up complete", keys_written=warmed)
    except Exception as e:
        log_error(f"Cache warm-up failed (non-fatal)", error=str(e))


def _svc_unavailable(name: str) -> str:
    """Return a standard JSON error when a service is not yet initialized."""
    return json.dumps(
        {
            "error": f"{name} service is not available",
            "hint": "Run the data-loader to populate this dataset, then restart the server.",
        },
        ensure_ascii=False,
    )


def _json_error(message: str, **extra) -> str:
    """Return a compact JSON error payload used by several thin wrappers."""
    payload = {"error": message}
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False)


async def _call_service_json(service, method_name: str, *args, **kwargs) -> str:
    """Call a service method and serialise dict/list responses to JSON."""
    method = getattr(service, method_name)
    result = await method(*args, **kwargs)
    if isinstance(result, str):
        return result
    serializer = getattr(service, "to_json_string", None)
    if callable(serializer):
        return serializer(result, indent=2)
    return json.dumps(result, ensure_ascii=False, indent=2)


class DynamicFastMCP(FastMCP):
    """FastMCP subclass that refreshes dataset-based tool availability on every tools/list."""

    async def list_tools(self) -> list:
        try:
            pool = database.get_pool()
            await _dataset_status.refresh_if_stale_and_sync(pool, SERVICE_TOOLS, self)
        except RuntimeError:
            pass  # pool not yet initialized — return whatever tools are registered
        return await super().list_tools()


mcp = DynamicFastMCP(
    "taiwanHealthMcp",
    host=config.host,
    port=config.port,
    streamable_http_path=config.path,
    dependencies=["uvicorn"],
    lifespan=lifespan,
)


class ApiErrorLoggingMiddleware:
    """Log request details for HTTP API responses with error status codes."""

    def __init__(self, app, max_body_chars: int = 2000):
        self.app = app
        self.max_body_chars = max_body_chars

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        body_chunks: list[bytes] = []

        async def wrapped_receive():
            message = await receive()
            if message["type"] == "http.request":
                chunk = message.get("body", b"")
                if chunk:
                    body_chunks.append(chunk)
            return message

        async def wrapped_send(message):
            if message["type"] == "http.response.start":
                status = int(message["status"])
                if status >= 400:
                    raw_body = b"".join(body_chunks)
                    try:
                        body_text = raw_body.decode("utf-8", errors="replace")
                    except Exception:
                        body_text = repr(raw_body)
                    if len(body_text) > self.max_body_chars:
                        body_text = body_text[: self.max_body_chars] + "...(truncated)"

                    headers = {
                        k.decode("latin-1").lower(): v.decode("latin-1")
                        for k, v in scope.get("headers", [])
                    }
                    log_warning(
                        "HTTP API error response",
                        status_code=status,
                        method=scope.get("method"),
                        path=scope.get("path"),
                        query_string=scope.get("query_string", b"").decode("latin-1"),
                        content_type=headers.get("content-type"),
                        accept=headers.get("accept"),
                        mcp_session_id=headers.get("mcp-session-id"),
                        request_body=body_text,
                    )
            await send(message)

        try:
            await self.app(scope, wrapped_receive, wrapped_send)
        except Exception as e:
            raw_body = b"".join(body_chunks)
            body_text = raw_body.decode("utf-8", errors="replace")
            if len(body_text) > self.max_body_chars:
                body_text = body_text[: self.max_body_chars] + "...(truncated)"
            log_error(
                "Unhandled HTTP API exception",
                method=scope.get("method"),
                path=scope.get("path"),
                query_string=scope.get("query_string", b"").decode("latin-1"),
                request_body=body_text,
                error=str(e),
            )
            raise


# ── Static assets (logos) ────────────────────────────────────────────────────
def _load_static_file(filename: str) -> bytes | None:
    """Load a static file from the project root or /app (Docker)."""
    for base in [Path(__file__).parent.parent, Path("/app")]:
        p = base / filename
        if p.exists():
            try:
                return p.read_bytes()
            except OSError:
                pass
    return None


_LOGO_H_BYTES: bytes | None = _load_static_file("static/logo-h.png")
_LOGO_S_BYTES: bytes | None = _load_static_file("static/logo-s.png")

# Shared HTML snippets injected into every page

_PRIVACY_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>Privacy Policy – Taiwan Health MCP Server</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; line-height: 1.7; color: #222;
           background: #fff; }
    nav { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e7eb;
          padding: 0 24px; z-index: 100; }
    .nav-inner { display: flex; align-items: center; max-width: 900px;
                 margin: 0 auto; padding: 10px 0; }
    .nav-inner img { height: 36px; display: block; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 0 24px 48px; }
    h1 { font-size: 1.6rem; margin-top: 36px; margin-bottom: 4px; }
    h2 { font-size: 1.15rem; margin-top: 2rem; }
    p, li { font-size: 0.97rem; }
    code { background: #f4f4f4; padding: 1px 5px; border-radius: 3px; font-size: 0.9rem; }
    a { color: #0066cc; }
    @media (max-width: 600px) {
      nav { padding: 0 16px; }
      .wrap { padding: 0 16px 32px; }
      h1 { font-size: 1.25rem; margin-top: 24px; }
      h2 { font-size: 1.05rem; }
      p, li { font-size: 0.93rem; }
    }
  </style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a href="/"><img src="/logo-h.png" alt="HealthyMind Tech"></a>
  </div>
</nav>
<div class="wrap">
<h1>Privacy Policy – Taiwan Health MCP Server</h1>
<p><em>Effective date: 2025-01-01 &nbsp;|&nbsp; Last updated: 2026-04-09</em></p>

<h2>1. Overview</h2>
<p>Taiwan Health MCP Server is an open-source Model Context Protocol (MCP) server
that provides read-only access to Taiwan FDA health, ICD-10, LOINC, SNOMED CT,
and Taiwan clinical guideline data. All underlying datasets are publicly available;
this service does not collect, store, or process personal health information.</p>

<h2>2. Data We Collect</h2>
<p>We do <strong>not</strong> collect any personally identifiable information (PII).
The server maintains an internal audit log (<code>audit.query_log</code>) for
operational monitoring purposes. Each audit record contains:</p>
<ul>
  <li>Tool name (e.g., <code>search_medical_codes</code>)</li>
  <li>SHA-256 hash of the tool parameters — <strong>not</strong> the raw values</li>
  <li>Request duration and status (success / error)</li>
  <li>Timestamp</li>
</ul>
<p>Raw parameter values are <strong>never</strong> written to logs. This design
ensures that patient-identifiable query terms cannot be reconstructed from the
audit trail.</p>

<h2>3. Data Sources</h2>
<p>All medical terminology data served by this API originates from publicly
available datasets:</p>
<ul>
  <li>ICD-10-CM / ICD-10-PCS — U.S. National Library of Medicine / CMS (public domain)</li>
  <li>LOINC 2.80 — Regenstrief Institute (LOINC License, free for most uses)</li>
  <li>SNOMED CT International — SNOMED International (SNOMED License)</li>
  <li>Taiwan FDA health food and nutrition data — Taiwan FDA open data</li>
  <li>TWCore IG — Taiwan Ministry of Health and Welfare (public)</li>
</ul>

<h2>4. How Data Is Used</h2>
<p>Query results are returned directly to the requesting MCP client (Claude).
We do not use query data for training, profiling, advertising, or any purpose
other than fulfilling the immediate API request.</p>

<h2>5. Third-Party Data Processing</h2>
<p>When this server is accessed through Anthropic's Claude products, Anthropic
may collect telemetry on tool calls (including parameters and responses) per
their own privacy policy. Please refer to
<a href="https://www.anthropic.com/privacy">Anthropic's Privacy Policy</a>
for details.</p>
<p>This server does not share data with any other third parties.</p>

<h2>6. Data Retention</h2>
<p>Audit log records (SHA-256 hashes only) are retained for up to 90 days and
then deleted. Redis cache entries expire per configured TTL (1–24 hours).</p>

<h2>7. No Authentication Required</h2>
<p>This service does not require user accounts or authentication. We do not
store session tokens, cookies, or user identifiers of any kind.</p>

<h2>8. Your Rights</h2>
<p>Because we do not collect PII, there is no personal data to access, correct,
or delete. If you believe this server has inadvertently processed personal data,
please contact us at the address below.</p>

<h2>9. Changes to This Policy</h2>
<p>We may update this policy from time to time. The effective date at the top of
this page will reflect the most recent revision.</p>

<h2>10. Contact</h2>
<p>For privacy-related questions, please open an issue at
<a href="https://github.com/healthymind-tech/Taiwan-Health-MCP/issues">
github.com/healthymind-tech/Taiwan-Health-MCP</a> or email
<a href="mailto:support@healthymind-tech.com">support@healthymind-tech.com</a>.</p>
</div>
</body>
</html>
"""

_PRIVACY_HTML_BYTES = _PRIVACY_HTML.encode("utf-8")

_DPA_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>Data Processing Agreement – Taiwan Health MCP Server</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; line-height: 1.7; color: #222;
           background: #fff; }
    nav { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e7eb;
          padding: 0 24px; z-index: 100; }
    .nav-inner { display: flex; align-items: center; max-width: 900px;
                 margin: 0 auto; padding: 10px 0; }
    .nav-inner img { height: 36px; display: block; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 0 24px 48px; }
    h1 { font-size: 1.6rem; margin-top: 36px; margin-bottom: 4px; }
    h2 { font-size: 1.15rem; margin-top: 2rem; }
    h3 { font-size: 1.0rem; margin-top: 1.4rem; }
    p, li { font-size: 0.97rem; }
    code { background: #f4f4f4; padding: 1px 5px; border-radius: 3px; font-size: 0.9rem; }
    .tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 1rem 0; }
    table { border-collapse: collapse; width: 100%; min-width: 480px; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; font-size: 0.95rem; }
    th { background: #f6f6f6; text-align: left; }
    a { color: #0066cc; }
    @media (max-width: 600px) {
      nav { padding: 0 16px; }
      .wrap { padding: 0 16px 32px; }
      h1 { font-size: 1.25rem; margin-top: 24px; }
      h2 { font-size: 1.05rem; }
      p, li { font-size: 0.93rem; }
      th, td { font-size: 0.85rem; padding: 6px 8px; }
    }
  </style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a href="/"><img src="/logo-h.png" alt="HealthyMind Tech"></a>
  </div>
</nav>
<div class="wrap">
<h1>Data Processing Agreement</h1>
<p><strong>Service:</strong> Taiwan Health MCP Server<br>
<strong>Operator:</strong> HealthyMind Tech<br>
<em>Effective date: 2025-01-01 &nbsp;|&nbsp; Last updated: 2026-04-09</em></p>

<h2>1. Parties and Scope</h2>
<p>This Data Processing Agreement ("DPA") applies between HealthyMind Tech
("Operator", "we", "us") and any individual or organisation ("User") accessing
the Taiwan Health MCP Server via Anthropic's Claude products or directly through
the MCP API. It describes how data flows through the server, what is retained,
and the obligations of each party.</p>

<h2>2. Nature of Processing</h2>
<p>Taiwan Health MCP Server is a <strong>read-only query API</strong> that provides
access to publicly available medical terminology and pharmaceutical datasets.
It does not accept, store, or process personal health information submitted by
users. All 28 tools perform outbound database lookups against pre-loaded public
datasets and return structured results to the MCP client.</p>

<h2>3. Categories of Data Processed</h2>
<div class="tbl-wrap"><table>
  <tr><th>Data category</th><th>Source</th><th>Retained by operator?</th></tr>
  <tr>
    <td>Tool call metadata (tool name, timestamp, duration, status)</td>
    <td>Generated internally</td>
    <td>Yes — audit log, 90 days</td>
  </tr>
  <tr>
    <td>SHA-256 hash of tool parameters</td>
    <td>Derived from request</td>
    <td>Yes — audit log, 90 days; raw values are <strong>never</strong> stored</td>
  </tr>
  <tr>
    <td>Medical terminology query strings (e.g. ICD codes, drug names)</td>
    <td>User / Claude client</td>
    <td>No — processed transiently; not written to storage</td>
  </tr>
  <tr>
    <td>Redis cache entries (query result payloads)</td>
    <td>Internal</td>
    <td>Temporarily — TTL 1–24 hours, then auto-deleted</td>
  </tr>
  <tr>
    <td>Personal health information</td>
    <td>—</td>
    <td>Not collected, not accepted</td>
  </tr>
</table></div>

<h2>4. Purpose and Legal Basis</h2>
<p>Data is processed solely to fulfil individual API requests from the MCP client.
There is no secondary use: query data is not used for model training, profiling,
analytics, advertising, or any purpose beyond returning the immediate response.</p>
<p>The legal basis for processing operational logs (tool name, hash, timing) is
<strong>legitimate interest</strong> in operating a reliable, auditable service.</p>

<h2>5. Data Minimisation and HIPAA Design</h2>
<p>The audit logger (<code>src/audit.py</code>) records only the SHA-256 hash of
parameters — never the raw values. This design ensures that patient-identifiable
query terms (e.g. a patient's ICD code or medication name) cannot be reconstructed
from the audit trail, consistent with HIPAA safe-harbour de-identification
requirements.</p>

<h2>6. Sub-processors</h2>
<div class="tbl-wrap"><table>
  <tr><th>Sub-processor</th><th>Role</th><th>Data shared</th></tr>
  <tr>
    <td>PostgreSQL 16 (self-hosted)</td>
    <td>Primary data store for terminology datasets</td>
    <td>Query strings (transient, in-process only)</td>
  </tr>
  <tr>
    <td>Redis 7 (self-hosted)</td>
    <td>Response cache</td>
    <td>Serialised query result payloads (TTL-bound)</td>
  </tr>
  <tr>
    <td>Anthropic</td>
    <td>MCP platform / Claude client</td>
    <td>Tool call parameters and responses, per
      <a href="https://www.anthropic.com/privacy">Anthropic's Privacy Policy</a></td>
  </tr>
</table></div>
<p>All infrastructure (PostgreSQL, Redis) is operated by the Operator on
self-managed servers. No data is sent to external cloud sub-processors except
via Anthropic's platform as described above.</p>

<h2>7. International Transfers</h2>
<p>The server is hosted in Taiwan. Tool call data passed through Anthropic's
platform may be processed in the United States or other jurisdictions per
Anthropic's data processing terms. The Operator does not independently transfer
data outside Taiwan.</p>

<h2>8. Security Measures</h2>
<ul>
  <li>All HTTP traffic is served over TLS (HTTPS).</li>
  <li>Database and cache are network-isolated (Docker internal network, not exposed to public internet).</li>
  <li>pgBouncer connection pooler limits database exposure.</li>
  <li>Prometheus metrics endpoint is internal only.</li>
  <li>Audit log is append-only and stored in a dedicated PostgreSQL schema (<code>audit</code>).</li>
</ul>

<h2>9. Data Subject Rights</h2>
<p>Because the Operator does not collect personally identifiable information,
there is no personal data subject to access, rectification, erasure, or
portability requests under GDPR or similar regulations. If you believe this
server has inadvertently processed personal data, contact us at the address
in Section 12 and we will investigate within 30 days.</p>

<h2>10. Breach Notification</h2>
<p>In the event of a confirmed data security incident affecting user data, the
Operator will notify affected users and, where required by applicable law,
relevant supervisory authorities, within 72 hours of becoming aware of the
breach.</p>

<h2>11. Retention and Deletion</h2>
<ul>
  <li><strong>Audit logs</strong> — retained for 90 days, then deleted by a scheduled purge job.</li>
  <li><strong>Redis cache</strong> — entries expire automatically per configured TTL (1–24 hours).</li>
  <li><strong>Terminology datasets</strong> — static public data; not subject to deletion requests.</li>
</ul>

<h2>12. Contact and Governing Law</h2>
<p>For data processing questions or concerns:</p>
<ul>
  <li>GitHub Issues:
    <a href="https://github.com/healthymind-tech/Taiwan-Health-MCP/issues">
    github.com/healthymind-tech/Taiwan-Health-MCP/issues</a></li>
  <li>Email: <a href="mailto:support@healthymind-tech.com">support@healthymind-tech.com</a></li>
</ul>
<p>This agreement is governed by the laws of Taiwan (R.O.C.). Any dispute shall
be subject to the exclusive jurisdiction of the Taiwan Taipei District Court.</p>

<h2>13. Changes to This Agreement</h2>
<p>We may update this DPA from time to time. The effective date at the top of
this page reflects the most recent revision. Continued use of the service after
an update constitutes acceptance of the revised terms.</p>
</div>
</body>
</html>
"""

_DPA_HTML_BYTES = _DPA_HTML.encode("utf-8")

_LANDING_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>Taiwan Health MCP Server</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; color: #1a1a1a;
           background: #fff; line-height: 1.7; }

    /* ── nav ── */
    nav { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e7eb;
          padding: 0 24px; z-index: 100; }
    .nav-inner { display: flex; align-items: center; gap: 24px; max-width: 900px;
                 margin: 0 auto; padding: 10px 0; flex-wrap: wrap; }
    .nav-logo img { height: 36px; display: block; }
    nav ul { display: flex; gap: 24px; list-style: none; flex-wrap: wrap;
             margin: 0; padding: 0; }
    nav a { text-decoration: none; color: #444; font-size: 0.9rem; }
    nav a:hover { color: #0066cc; }

    /* ── layout ── */
    .wrap { max-width: 900px; margin: 0 auto; padding: 0 24px; }
    section { padding: 56px 0; border-bottom: 1px solid #f0f0f0; }
    section:last-of-type { border-bottom: none; }

    /* ── hero ── */
    .hero { padding: 72px 0 56px; }
    .hero h1 { font-size: 2.2rem; font-weight: 700; line-height: 1.25;
               margin-bottom: 16px; }
    .hero h1 span { color: #0066cc; }
    .hero p.tagline { font-size: 1.1rem; color: #555; max-width: 640px;
                      margin-bottom: 28px; }
    .endpoint-box { display: inline-flex; align-items: center; gap: 10px;
                    background: #f4f7fb; border: 1px solid #d0daea;
                    border-radius: 8px; padding: 10px 18px; font-size: 0.9rem; }
    .endpoint-box .label { color: #666; }
    .endpoint-box code { color: #0055aa; font-size: 0.88rem;
                         word-break: break-all; }
    .badge-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
    .badge { background: #e8f0fe; color: #1a56cc; border-radius: 20px;
             padding: 3px 12px; font-size: 0.82rem; font-weight: 500; }

    /* ── headings ── */
    h2 { font-size: 1.45rem; font-weight: 700; margin-bottom: 20px; }
    h3 { font-size: 1.05rem; font-weight: 600; margin-bottom: 8px; }

    /* ── feature grid ── */
    .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px,1fr));
                    gap: 20px; }
    .feature-card { border: 1px solid #e5e7eb; border-radius: 10px;
                    padding: 20px 22px; }
    .feature-card .icon { font-size: 1.6rem; margin-bottom: 10px; }
    .feature-card ul { padding-left: 18px; font-size: 0.93rem; color: #444;
                       margin-top: 8px; }
    .feature-card li { margin-bottom: 4px; }

    /* ── dataset table ── */
    table { width: 100%; border-collapse: collapse; font-size: 0.93rem;
            margin-top: 12px; }
    th, td { border: 1px solid #e0e0e0; padding: 9px 14px; text-align: left; }
    th { background: #f6f8fb; font-weight: 600; }

    /* ── examples ── */
    .example { border: 1px solid #e5e7eb; border-radius: 10px;
               overflow: hidden; margin-bottom: 20px; }
    .example-header { background: #f6f8fb; padding: 10px 18px;
                      font-weight: 600; font-size: 0.9rem; color: #333;
                      border-bottom: 1px solid #e5e7eb; }
    .example-body { padding: 16px 18px; }
    .prompt { background: #fff8e6; border-left: 3px solid #f5a623;
              border-radius: 4px; padding: 8px 14px; font-size: 0.92rem;
              margin-bottom: 14px; }
    .prompt strong { color: #b8860b; font-size: 0.8rem; display: block;
                     margin-bottom: 2px; }
    .steps { padding-left: 18px; font-size: 0.92rem; color: #444; }
    .steps li { margin-bottom: 4px; }

    /* ── setup steps ── */
    .setup-steps { counter-reset: step; display: flex; flex-direction: column;
                   gap: 16px; }
    .setup-step { display: flex; gap: 16px; align-items: flex-start; }
    .setup-step .num { min-width: 32px; height: 32px; border-radius: 50%;
                       background: #0066cc; color: #fff; display: flex;
                       align-items: center; justify-content: center;
                       font-size: 0.85rem; font-weight: 700; margin-top: 2px; }
    .setup-step .text { font-size: 0.95rem; }
    .setup-step .text p { margin: 0; }
    code.inline { background: #f4f4f4; padding: 1px 6px; border-radius: 4px;
                  font-size: 0.88rem; }

    /* ── auth notice ── */
    .auth-notice { background: #f0fdf4; border: 1px solid #86efac;
                   border-radius: 8px; padding: 16px 20px; }
    .auth-notice strong { color: #166534; }

    /* ── links section ── */
    .link-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr));
                 gap: 14px; }
    .link-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 18px;
                 text-decoration: none; color: inherit;
                 transition: border-color 0.15s; display: block; }
    .link-card:hover { border-color: #0066cc; }
    .link-card .link-title { font-weight: 600; font-size: 0.95rem;
                             color: #0066cc; margin-bottom: 4px; }
    .link-card .link-desc { font-size: 0.85rem; color: #666; }

    /* ── footer ── */
    footer { text-align: center; padding: 32px 24px; color: #888;
             font-size: 0.85rem; border-top: 1px solid #f0f0f0; }
    footer a { color: #0066cc; text-decoration: none; }

    /* ── table scroll ── */
    .tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tbl-wrap table { min-width: 520px; }

    @media (max-width: 768px) {
      .hero { padding: 48px 0 36px; }
      .hero h1 { font-size: 1.8rem; }
      section { padding: 40px 0; }
      .feature-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 600px) {
      .hero h1 { font-size: 1.4rem; }
      .hero p.tagline { font-size: 1rem; }
      .endpoint-box { flex-direction: column; align-items: flex-start; gap: 4px; }
      .nav-inner { gap: 12px; padding: 8px 0; }
      .nav-logo img { height: 28px; }
      nav ul { gap: 10px; }
      nav a { font-size: 0.82rem; }
      h2 { font-size: 1.2rem; }
      section { padding: 32px 0; }
      .link-grid { grid-template-columns: 1fr 1fr; }
      footer { font-size: 0.8rem; padding: 24px 16px; }
    }
    @media (max-width: 400px) {
      .link-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

<nav>
  <div class="nav-inner">
    <div class="nav-logo">
      <a href="/"><img src="/logo-h.png" alt="HealthyMind Tech"></a>
    </div>
    <ul>
      <li><a href="#description">Overview</a></li>
      <li><a href="#features">Features</a></li>
      <li><a href="#datasets">Datasets</a></li>
      <li><a href="#examples">Examples</a></li>
      <li><a href="#setup">Setup</a></li>
      <li><a href="#authentication">Auth</a></li>
      <li><a href="#support">Support</a></li>
      <li><a href="/status">Status</a></li>
    </ul>
  </div>
</nav>

<!-- ── Hero ── -->
<section class="hero" id="top">
  <div class="wrap">
    <h1>Taiwan Health<br><span>MCP Server</span></h1>
    <p class="tagline">
      An open-source Model Context Protocol server that gives AI assistants
      structured, read-only access to Taiwan's medical and clinical knowledge
      for Taiwan healthcare workflows.
    </p>
    <div class="endpoint-box">
      <span class="label">MCP endpoint</span>
      <code>https://tw-health-mcp.healthymind-tech.com/mcp</code>
    </div>
    <div class="badge-row">
      <span class="badge">24 Tools</span>
      <span class="badge">ICD-10-CM 2025</span>
      <span class="badge">LOINC 2.80</span>
      <span class="badge">SNOMED CT</span>
      <span class="badge">Taiwan FDA</span>
      <span class="badge">TWCore IG v1.0</span>
      <span class="badge">FHIR R4</span>
    </div>
  </div>
</section>

<!-- ── Description ── -->
<section id="description">
  <div class="wrap">
    <h2>Description</h2>
    <p>
      Taiwan Health MCP Server connects Claude to authoritative medical and
      health datasets curated for Taiwan's healthcare system. Clinicians,
      researchers, developers, and health-tech products can query ICD-10 diagnoses
      and procedures, look up LOINC lab codes and reference ranges, navigate
      SNOMED CT concept hierarchies, search Taiwan FDA health foods, access
      clinical practice guidelines, and generate FHIR R4-compliant resources
      — all through natural language conversation with Claude.
    </p>
    <p style="margin-top:12px;">
      All underlying datasets are publicly available. The server does
      <strong>not</strong> collect, store, or process personal health information.
      Audit logs record only tool names and SHA-256 parameter hashes, never raw values.
    </p>
  </div>
</section>

<!-- ── Features ── -->
<section id="features">
  <div class="wrap">
    <h2>Features</h2>
    <div class="feature-grid">

      <div class="feature-card">
        <div class="icon">🏥</div>
        <h3>Medical Coding</h3>
        <p style="font-size:0.93rem;color:#555;">
          Hybrid BM25 + semantic search across ICD-10-CM/PCS 2025,
          SNOMED CT International, and LOINC 2.80.
        </p>
        <ul>
          <li>Diagnosis &amp; procedure code search</li>
          <li>SNOMED concept hierarchy traversal</li>
          <li>ICD ↔ SNOMED cross-mapping</li>
          <li>LOINC lab code lookup by name, specimen, or component</li>
          <li>Nearby codes &amp; complication inference</li>
        </ul>
      </div>

      <div class="feature-card">
      <div class="icon">🧪</div>
      <h3>Lab Interpretation</h3>
        <p style="font-size:0.93rem;color:#555;">
          Reference ranges and clinical interpretation for LOINC-coded
          lab results, with age- and gender-specific thresholds.
        </p>
        <ul>
          <li>Single &amp; batch result interpretation</li>
          <li>Normal / abnormal / critical flagging</li>
          <li>Gender- and age-specific reference ranges</li>
          <li>Patient-friendly name lookup</li>
          <li>Related test discovery</li>
        </ul>
      </div>

      <div class="feature-card">
        <div class="icon">📋</div>
        <h3>Clinical Guidelines</h3>
        <p style="font-size:0.93rem;color:#555;">
          Taiwan clinical practice guidelines linked to ICD codes,
          with medication recommendations and treatment goals.
        </p>
        <ul>
          <li>Guideline search by ICD code or keyword</li>
          <li>Medication &amp; test recommendations</li>
          <li>Treatment goals per condition</li>
          <li>Contraindication checking</li>
          <li>Clinical pathway suggestion</li>
        </ul>
      </div>

      <div class="feature-card">
        <div class="icon">🍎</div>
        <h3>Food &amp; Nutrition</h3>
        <p style="font-size:0.93rem;color:#555;">
          Taiwan FDA health food registry and food nutrition composition
          database, with meal-level analysis.
        </p>
        <ul>
          <li>Health food product search &amp; details</li>
          <li>Food nutrition lookup (per 100 g)</li>
          <li>Meal nutrition analysis (multi-food)</li>
          <li>Nutrient-ranked food search</li>
          <li>Ingredient &amp; additive lookup</li>
        </ul>
      </div>

      <div class="feature-card">
        <div class="icon">⚕️</div>
        <h3>FHIR R4</h3>
        <p style="font-size:0.93rem;color:#555;">
          Generate, validate, and search FHIR R4 resources aligned
          with TWCore IG v1.0.0.
        </p>
        <ul>
          <li>Condition resource generation</li>
          <li>FHIR resource validation</li>
          <li>TWCore CodeSystem lookup &amp; search</li>
          <li>Diagnosis-to-FHIR one-step conversion</li>
        </ul>
      </div>

    </div>
  </div>
</section>

<!-- ── Datasets ── -->
<section id="datasets">
  <div class="wrap">
    <h2>Datasets</h2>
    <div class="tbl-wrap"><table>
      <tr>
        <th>Dataset</th><th>Version / Source</th><th>Sync</th>
      </tr>
      <tr>
        <td>ICD-10-CM &amp; ICD-10-PCS</td>
        <td>FY 2025 — CMS / NLM (public domain)</td>
        <td>Static (data-loader)</td>
      </tr>
      <tr>
        <td>LOINC</td>
        <td>2.80 — Regenstrief Institute</td>
        <td>Static (data-loader)</td>
      </tr>
      <tr>
        <td>SNOMED CT International</td>
        <td>Latest RF2 — SNOMED International</td>
        <td>Static (data-loader)</td>
      </tr>
      <tr>
        <td>Taiwan FDA Health Supplements</td>
        <td>Open Data — Taiwan FDA</td>
        <td>Auto-sync every Monday 02:30 UTC</td>
      </tr>
      <tr>
        <td>Taiwan Food Nutrition</td>
        <td>Open Data — Taiwan FDA</td>
        <td>Auto-sync every Monday 03:00 UTC</td>
      </tr>
      <tr>
        <td>TWCore IG</td>
        <td>v1.0.0 — Taiwan MoHW</td>
        <td>Static + live fetch fallback</td>
      </tr>
      <tr>
        <td>Taiwan Clinical Guidelines</td>
        <td>Curated seed data</td>
        <td>Static (data-loader)</td>
      </tr>
    </table></div>
  </div>
</section>

<!-- ── Examples ── -->
<section id="examples">
  <div class="wrap">
    <h2>Examples</h2>

    <div class="example">
      <div class="example-header">Example 1 — Diagnosis lookup &amp; clinical guidance</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "我的病人診斷是 E11.9，幫我查詢對應的用藥建議和治療目標"
        </div>
        <ol class="steps">
          <li>Server searches ICD-10 for <code>E11.9</code> (Type 2 diabetes without complications)</li>
          <li>Fetches Taiwan clinical guideline for E11 — medication recommendations &amp; treatment goals</li>
          <li>Maps E11.9 to SNOMED CT concept 44054006 for semantic context</li>
          <li>Returns structured recommendations: first-line medications, HbA1c target, monitoring schedule</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 2 — Lab result interpretation</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "病人 HbA1c 8.2%、空腹血糖 176 mg/dL、肌酸酐 1.4，幫我解讀這些數值"
        </div>
        <ol class="steps">
          <li>Server identifies LOINC codes: 4548-4 (HbA1c), 1558-6 (fasting glucose), 2160-0 (creatinine)</li>
          <li>Runs batch lab interpretation with patient age/gender context</li>
          <li>Returns per-result flags (H / critical), reference ranges, and clinical significance</li>
          <li>HbA1c flagged as above target; creatinine mildly elevated — suggests CKD monitoring</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 3 — FHIR resource generation</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "幫我把診斷 E11.9 轉成 TWCore FHIR 格式"
        </div>
        <ol class="steps">
          <li>Server calls <code>query_fhir_condition</code> for E11.9</li>
          <li>Generates a TWCore-compliant FHIR Condition resource with ICD-10 coding</li>
          <li>Applies optional status fields such as clinical and verification status</li>
          <li>Returns valid FHIR R4 JSON ready for EMR integration</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 4 — Nutrition analysis</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "糖尿病病人的午餐：白米飯、雞胸肉、青花菜，幫我分析營養成分"
        </div>
        <ol class="steps">
          <li>Server queries Taiwan FDA food nutrition database for all three items</li>
          <li>Aggregates macronutrients: calories, carbohydrates, protein, fat, fiber per 100 g</li>
          <li>Returns per-food breakdown plus combined totals</li>
          <li>Highlights carbohydrate content relevant for diabetes meal planning</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 5 — Health supplement search</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "幫我找有調節血脂功效的台灣健康食品"
        </div>
        <ol class="steps">
          <li>Server searches the Taiwan FDA health supplement registry by benefit keywords</li>
          <li>Ranks certified products by product name, ingredients, and approved claims</li>
          <li>Returns permit number, company, ingredients, and approved benefit text</li>
          <li>Helps narrow candidates for further clinical or regulatory review</li>
        </ol>
      </div>
    </div>

  </div>
</section>

<!-- ── Setup ── -->
<section id="setup">
  <div class="wrap">
    <h2>Setup</h2>
    <div class="setup-steps">
      <div class="setup-step">
        <div class="num">1</div>
        <div class="text">
          <p>Visit the <strong>Anthropic MCP Directory</strong> at
          <a href="https://claude.com/connectors">claude.com/connectors</a>.</p>
        </div>
      </div>
      <div class="setup-step">
        <div class="num">2</div>
        <div class="text">
          <p>Search for <strong>"Taiwan Health"</strong> and select
          <em>Taiwan Health MCP Server</em>.</p>
        </div>
      </div>
      <div class="setup-step">
        <div class="num">3</div>
        <div class="text">
          <p>Click <strong>Connect</strong>. No account or OAuth required —
          the server is publicly accessible.</p>
        </div>
      </div>
      <div class="setup-step">
        <div class="num">4</div>
        <div class="text">
          <p>Alternatively, connect directly in Claude Desktop by adding the
          MCP endpoint to your config:<br>
          <code class="inline">https://tw-health-mcp.healthymind-tech.com/mcp</code></p>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ── Authentication ── -->
<section id="authentication">
  <div class="wrap">
    <h2>Authentication</h2>
    <div class="auth-notice">
      <strong>&#10003; No authentication required.</strong>
      <p style="margin-top:8px;font-size:0.95rem;">
        Taiwan Health MCP Server provides read-only access to publicly available
        datasets. No account, API key, or OAuth flow is needed. Simply connect
        and start querying.
      </p>
    </div>
    <p style="margin-top:16px;font-size:0.93rem;color:#555;">
      All 28 tools are read-only. The server does not accept writes, does not
      require a user session, and does not store any identifying information
      about callers.
    </p>
  </div>
</section>

<!-- ── Support ── -->
<section id="support">
  <div class="wrap">
    <h2>Support &amp; Links</h2>
    <div class="link-grid">
      <a class="link-card"
         href="https://github.com/healthymind-tech/Taiwan-Health-MCP">
        <div class="link-title">GitHub Repository</div>
        <div class="link-desc">Source code, issues, and contributions</div>
      </a>
      <a class="link-card"
         href="https://github.com/healthymind-tech/Taiwan-Health-MCP/issues">
        <div class="link-title">Report an Issue</div>
        <div class="link-desc">Bug reports and feature requests</div>
      </a>
      <a class="link-card" href="/status">
        <div class="link-title">Status &amp; Tool Tester</div>
        <div class="link-desc">Live tool availability and interactive tester</div>
      </a>
      <a class="link-card" href="/privacy">
        <div class="link-title">Privacy Policy</div>
        <div class="link-desc">How we handle data and audit logs</div>
      </a>
      <a class="link-card" href="/dpa">
        <div class="link-title">Data Processing Agreement</div>
        <div class="link-desc">Sub-processors, retention, and security</div>
      </a>
      <a class="link-card"
         href="mailto:support@healthymind-tech.com">
        <div class="link-title">Email Support</div>
        <div class="link-desc">support@healthymind-tech.com</div>
      </a>
    </div>
  </div>
</section>

<footer>
  <p>Taiwan Health MCP Server &nbsp;&middot;&nbsp;
     Open source under MIT License &nbsp;&middot;&nbsp;
     <a href="/status">Status</a> &nbsp;&middot;&nbsp;
     <a href="/privacy">Privacy</a> &nbsp;&middot;&nbsp;
     <a href="/dpa">DPA</a> &nbsp;&middot;&nbsp;
     <a href="https://github.com/healthymind-tech/Taiwan-Health-MCP">GitHub</a>
  </p>
</footer>

</body>
</html>
"""

_LANDING_HTML_BYTES = _LANDING_HTML.encode("utf-8")

# ---------------------------------------------------------------------------
# Status page — tool registry and tester
# ---------------------------------------------------------------------------

_TOOL_GROUPS: dict[str, dict[str, object]] = {
    "icd": {
        "category": "ICD-10",
        "tools": [
            (
                "search_medical_codes",
                "search_medical_codes",
                {"keyword": "第二型糖尿病", "type": "diagnosis", "limit": 5},
            ),
            (
                "search_medical_codes",
                "search_medical_codes",
                {"keyword": "Tracheostomy", "type": "procedure", "limit": 5},
            ),
            (
                "search_medical_codes",
                "search_medical_codes",
                {"keyword": "diabetes", "type": "all", "limit": 5},
            ),
            ("infer_complications", "infer_complications", {"code": "E11"}),
            ("get_nearby_codes", "get_nearby_codes", {"code": "E11.9"}),
            (
                "check_medical_conflict",
                "check_medical_conflict",
                {"diagnosis_code": "E11.9", "procedure_code": "0BH17EZ"},
            ),
            ("browse_icd_category", "browse_icd_category", {"category": "E11"}),
        ],
    },
    "lab": {
        "category": "Lab / LOINC",
        "tools": [
            (
                "search_loinc",
                "search_loinc",
                {"mode": "code", "keyword": "glucose", "category": "CHEM", "limit": 5},
            ),
            (
                "search_loinc",
                "search_loinc",
                {"mode": "category", "keyword": "CHE", "limit": 5},
            ),
            (
                "search_loinc",
                "search_loinc",
                {"mode": "specimen", "keyword": "Urine", "limit": 5},
            ),
            (
                "search_loinc",
                "search_loinc",
                {"mode": "component", "keyword": "Glucose", "limit": 5},
            ),
            (
                "query_loinc",
                "query_loinc",
                {"mode": "detail", "loinc_code": "2345-7"},
            ),
            (
                "query_loinc",
                "query_loinc",
                {"mode": "reference_range", "loinc_code": "2345-7", "age": 45, "gender": "M"},
            ),
            (
                "interpret_lab_result",
                "interpret_lab_result",
                {"loinc_code": "2345-7", "value": 126, "age": 45, "gender": "M"},
            ),
            (
                "batch_interpret_lab_results",
                "batch_interpret_lab_results",
                {
                    "results_json": '[{"loinc_code":"2345-7","value":126},{"loinc_code":"4548-4","value":7.2},{"loinc_code":"718-7","value":13.5}]',
                    "age": 45,
                    "gender": "M",
                },
            ),
        ],
    },
    "guideline": {
        "category": "Guidelines",
        "tools": [
            (
                "search_clinical_guideline",
                "search_clinical_guideline",
                {"keyword": "糖尿病"},
            ),
            (
                "query_guideline",
                "query_guideline",
                {"icd_code": "E11", "section": "medication"},
            ),
        ],
    },
    "snomed": {
        "category": "SNOMED CT",
        "tools": [
            (
                "search_snomed_concept",
                "search_snomed_concept",
                {"query": "diabetes mellitus", "limit": 5},
            ),
            ("query_snomed_concept", "query_snomed_concept", {"concept_id": 73211009}),
            (
                "get_snomed_relationships",
                "get_snomed_relationships",
                {"concept_id": 73211009},
            ),
            (
                "query_snomed_mapping",
                "query_snomed_mapping",
                {"mode": "icd", "keyword": "E11.9"},
            ),
            (
                "query_snomed_mapping",
                "query_snomed_mapping",
                {"mode": "snomed", "keyword": "44054006"},
            ),
        ],
    },
    "fhir_condition": {
        "category": "FHIR R4",
        "tools": [
            (
                "query_fhir_condition",
                "query_fhir_condition",
                {"diagnosis_keyword": "第二型糖尿病", "patient_id": "patient-001"},
            ),
            (
                "validate_fhir_condition",
                "validate_fhir_condition",
                {
                    "condition_json": '{"resourceType":"Condition","subject":{"reference":"Patient/patient-001"},"code":{"coding":[{"system":"http://hl7.org/fhir/sid/icd-10-cm","code":"E11.9","display":"Type 2 diabetes mellitus without complications"}]},"clinicalStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-clinical","code":"active"}]},"verificationStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-ActCode","code":"confirmed"}]}}'
                },
            ),
        ],
    },
    "twcore": {
        "category": "TWCore IG",
        "tools": [
            ("query_twcore_code", "query_twcore_code", {"category": "diagnosis"}),
            (
                "query_twcore_code",
                "query_twcore_code",
                {"code": "QD", "codesystem_id": "medication-frequency-nhi-tw"},
            ),
        ],
    },
    "health_food": {
        "category": "Health Supplement",
        "tools": [
            (
                "search_health_supplement",
                "search_health_supplement",
                {"mode": "keyword", "keyword": "魚油", "limit": 5},
            ),
            (
                "search_health_supplement",
                "search_health_supplement",
                {"mode": "permit_no", "keyword": "A00022"},
            ),
            (
                "search_health_supplement",
                "search_health_supplement",
                {"mode": "condition", "keyword": "E11", "limit": 5},
            ),
        ],
    },
    "food_nutrition": {
        "category": "Food Nutrition",
        "tools": [
            (
                "query_food_nutrition",
                "query_food_nutrition",
                {"food_name": "雞蛋", "nutrient": "粗蛋白"},
            ),
            (
                "query_food_ingredient",
                "query_food_ingredient",
                {"keyword": "薑黃"},
            ),
            (
                "search_foods_by_nutrient",
                "search_foods_by_nutrient",
                {"nutrient": "鈣"},
            ),
            (
                "analyze_meal_nutrition",
                "analyze_meal_nutrition",
                {"foods": ["白米飯", "雞胸肉", "花椰菜", "豆腐"]},
            ),
        ],
    },
    "system": {
        "category": "System",
        "tools": [("health_check", "health_check", {})],
    },
}


def _build_tool_maps():
    tool_category_map: dict[str, str] = {}
    tool_examples: dict[str, dict] = {}
    tool_selector_examples: dict[str, dict[str, dict[str, dict]]] = {}
    service_tools: dict[str, list[tuple[Callable, str]]] = {}
    selector_fields = {"mode", "type"}
    for service_key, spec in _TOOL_GROUPS.items():
        category = spec["category"]
        tools = []
        seen_names: set[str] = set()
        for fn_name, name, example in spec["tools"]:
            fn = globals().get(fn_name)
            if fn is None:
                raise NameError(f"Tool function not defined: {fn_name}")
            tool_category_map[name] = category
            if example and name not in tool_examples:
                tool_examples[name] = example
            if isinstance(example, dict):
                for field in selector_fields:
                    field_value = example.get(field)
                    if isinstance(field_value, str) and field_value:
                        (
                            tool_selector_examples.setdefault(name, {})
                            .setdefault(field, {})
                        )[field_value] = example
            if service_key != "system":
                if name not in seen_names:
                    tools.append((fn, name))
                    seen_names.add(name)
        if service_key != "system":
            service_tools[service_key] = tools
    return tool_category_map, tool_examples, tool_selector_examples, service_tools


def _build_status_html() -> str:
    """Build the status page HTML, embedding the category map and examples as JS constants."""
    cat_map_js = json.dumps(_TOOL_CATEGORY_MAP, ensure_ascii=False)
    examples_js = json.dumps(_TOOL_EXAMPLES, ensure_ascii=False)
    selector_examples_js = json.dumps(_TOOL_SELECTOR_EXAMPLES, ensure_ascii=False)
    return (
        _STATUS_HTML_TEMPLATE.replace('"__CATEGORY_MAP__"', cat_map_js)
        .replace('"__TOOL_EXAMPLES__"', examples_js)
        .replace('"__TOOL_SELECTOR_EXAMPLES__"', selector_examples_js)
    )


_STATUS_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>Status &amp; Tool Tester – Taiwan Health MCP</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { height: 100%; }
    body { font-family: system-ui, sans-serif; background: #f8f9fa; color: #1a1a1a;
           height: 100%; display: flex; flex-direction: column; overflow: hidden; }

    /* ── header ── */
    header { background: #fff; border-bottom: 1px solid #e5e7eb; padding: 8px 16px;
             display: flex; align-items: center; justify-content: space-between;
             flex-shrink: 0; gap: 10px; flex-wrap: wrap; }
    .hdr-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .hdr-left img { height: 28px; display: block; flex-shrink: 0; }
    header h1 { font-size: 0.95rem; font-weight: 700;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hdr-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
                 flex-shrink: 0; }
    .stats { font-size: 0.82rem; color: #555; white-space: nowrap; }
    .stats b { color: #166534; }
    .hdr-link { font-size: 0.8rem; color: #0066cc; text-decoration: none;
                white-space: nowrap; }
    .hdr-link:hover { text-decoration: underline; }

    /* ── layout ── */
    .main { display: flex; flex: 1; overflow: hidden; min-height: 0; }

    /* ── left panel ── */
    .left { width: 260px; min-width: 180px; background: #fff;
            border-right: 1px solid #e5e7eb; display: flex;
            flex-direction: column; flex-shrink: 0; overflow: hidden; }
    .search-wrap { padding: 10px 10px 6px; }
    .search-wrap input { width: 100%; padding: 7px 10px; border: 1px solid #ddd;
                         border-radius: 6px; font-size: 0.88rem; }
    .search-wrap input:focus { outline: none; border-color: #0066cc; }
    .cat-row { display: flex; gap: 5px; padding: 6px 10px 8px; flex-wrap: wrap;
               border-bottom: 1px solid #f0f0f0; overflow-x: auto; }
    .cat-btn { padding: 2px 9px; border-radius: 10px; font-size: 0.75rem; cursor: pointer;
               border: 1px solid #ddd; background: #f9f9f9; color: #555;
               white-space: nowrap; flex-shrink: 0; }
    .cat-btn:hover { border-color: #0066cc; color: #0066cc; }
    .cat-btn.on { background: #0066cc; color: #fff; border-color: #0066cc; }
    .tool-list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 4px 0; }
    .t-item { display: flex; align-items: center; gap: 7px; padding: 7px 12px;
              cursor: pointer; border-left: 3px solid transparent; }
    .t-item:hover { background: #f4f7fb; }
    .t-item.sel { background: #e8f0fe; border-left-color: #0066cc; }
    .t-item.off { opacity: 0.45; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .g { background: #22c55e; }
    .gr { background: #9ca3af; }
    .tname { font-size: 0.8rem; font-family: monospace; color: #333;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* ── right panel ── */
    .right { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
             padding: 20px 22px; min-width: 0; }
    .empty { height: 100%; display: flex; align-items: center; justify-content: center;
             color: #bbb; font-size: 1rem; text-align: center; padding: 20px; }

    /* ── tool detail ── */
    .th { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .th h2 { font-size: 1.05rem; font-family: monospace; font-weight: 700;
             word-break: break-all; }
    .badge { border-radius: 10px; padding: 2px 10px; font-size: 0.75rem; font-weight: 500; }
    .bc { background: #e8f0fe; color: #1a56cc; }
    .ba-on { background: #dcfce7; color: #166534; }
    .ba-off { background: #f3f4f6; color: #6b7280; }
    .tdesc { font-size: 0.88rem; color: #555; line-height: 1.65; margin-bottom: 18px; }
    hr.div { border: none; border-top: 1px solid #f0f0f0; margin: 0 0 16px; }

    /* ── form ── */
    .sec-title { font-size: 0.88rem; font-weight: 700; color: #333; margin-bottom: 12px;
                 text-transform: uppercase; letter-spacing: .04em; }
    .fg { margin-bottom: 13px; }
    .fg label { display: block; font-size: 0.83rem; font-weight: 600; margin-bottom: 3px; }
    .fg label.req::after { content: " *"; color: #dc2626; }
    .fdesc { font-size: 0.77rem; color: #888; margin-bottom: 4px; }
    .fg input[type=text], .fg input[type=number], .fg select, .fg textarea {
      width: 100%; max-width: 480px; padding: 7px 10px; border: 1px solid #ddd;
      border-radius: 6px; font-size: 0.88rem; font-family: inherit; }
    .fg input:focus, .fg select:focus, .fg textarea:focus {
      outline: none; border-color: #0066cc; }
    .fg textarea { resize: vertical; font-family: monospace; font-size: 0.82rem; }
    .cb-row { display: flex; align-items: center; gap: 7px; font-size: 0.88rem; }
    .run-btn { margin-top: 6px; padding: 8px 20px; background: #0066cc; color: #fff;
               border: none; border-radius: 6px; font-size: 0.88rem; font-weight: 600;
               cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    .run-btn:hover { background: #0055aa; }
    .run-btn:disabled { background: #93c5fd; cursor: not-allowed; }
    .no-params { color: #999; font-size: 0.85rem; font-style: italic; margin-bottom: 10px; }

    /* ── result ── */
    .res-sec { margin-top: 20px; }
    .res-sec.hidden { display: none; }
    .res-hdr { display: flex; align-items: center; justify-content: space-between;
               margin-bottom: 6px; flex-wrap: wrap; gap: 6px; }
    .res-meta { font-size: 0.78rem; color: #888; }
    .copy-btn { padding: 3px 10px; font-size: 0.78rem; border: 1px solid #ddd;
                border-radius: 4px; background: #f9f9f9; cursor: pointer; }
    .copy-btn:hover { border-color: #0066cc; }

    /* ── JSON tree ── */
    .json-tree { background:#1e1e1e; color:#d4d4d4; padding:12px 14px; border-radius:8px;
                 font-size:0.78rem; overflow:auto; max-height:480px; line-height:1.55;
                 font-family:'Consolas','JetBrains Mono','Courier New',monospace; }
    .json-tree.plain { white-space:pre-wrap; word-break:break-all; }
    .jhead { cursor:pointer; border-radius:3px; }
    .jhead:hover { background:#2a2a2a; }
    .jt { color:#888; font-size:0.65rem; margin-right:2px; display:inline-block;
          width:10px; text-align:center; }
    .jcoll > .jch { display:block; padding-left:18px;
                    border-left:1px solid #2d2d2d; margin-left:5px; }
    .jcoll > .jfoot { display:block; }
    .jcoll > .jhead > .jsum { display:none; }
    .jcollapsed > .jch { display:none !important; }
    .jcollapsed > .jfoot { display:none !important; }
    .jcollapsed > .jhead > .jsum { display:inline !important; }
    .jleaf { white-space:nowrap; }
    .jsum { color:#666; font-style:italic; font-size:0.72rem; }
    .jkey { color:#9cdcfe; }
    .jstr { color:#ce9178; }
    .jnum { color:#b5cea8; }
    .jbool { color:#569cd6; }
    .jnull { color:#808080; font-style:italic; }
    .jbrace { color:#d4d4d4; }
    .jsep { color:#666; }

    /* ── unavailable ── */
    .unavail { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;
               padding: 18px; color: #6b7280; font-size: 0.88rem; }

    /* ── spinner ── */
    .spin { display: inline-block; width: 13px; height: 13px; border: 2px solid #fff;
            border-top-color: transparent; border-radius: 50%;
            animation: sp .65s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }

    /* ── mobile: stack panels vertically ── */
    @media (max-width: 680px) {
      html, body { height: auto; overflow: auto; }
      .main { flex-direction: column; overflow: visible; }
      .left { width: 100%; height: auto; border-right: none;
              border-bottom: 1px solid #e5e7eb; }
      .tool-list { max-height: 200px; }
      .right { overflow-y: visible; padding: 16px; }
      .fg input[type=text], .fg input[type=number], .fg select, .fg textarea {
        max-width: 100%; }
      header h1 { font-size: 0.82rem; }
    }
  </style>
</head>
<body>

<header>
  <div class="hdr-left">
    <img src="/logo-s.png" alt="HealthyMind Tech">
    <h1>Taiwan Health MCP — Status &amp; Tool Tester</h1>
  </div>
  <div class="hdr-right">
    <div class="stats" id="stats">Loading…</div>
    <a class="hdr-link" href="/">← Home</a>
    <a class="hdr-link" href="/privacy">Privacy</a>
  </div>
</header>

<div class="main">
  <!-- left -->
  <div class="left">
    <div class="search-wrap">
      <input type="text" id="srch" placeholder="Search tools…" oninput="filter()">
    </div>
    <div class="cat-row" id="cats"></div>
    <div class="tool-list" id="tlist">
      <div style="padding:18px;color:#bbb;font-size:.83rem;">Loading…</div>
    </div>
  </div>

  <!-- right -->
  <div class="right" id="right">
    <div class="empty">← Select a tool from the list to test it</div>
  </div>
</div>

<script>
// ── category map (injected from server) ───────────────────────
const CATEGORY_MAP = "__CATEGORY_MAP__";

// ── per-tool example arguments (injected from server) ─────────
const TOOL_EXAMPLES = "__TOOL_EXAMPLES__";
const TOOL_SELECTOR_EXAMPLES = "__TOOL_SELECTOR_EXAMPLES__";

// ── MCP client ────────────────────────────────────────────────
let _sid = null, _mid = 0;

async function _mcpPost(body) {
  const hdrs = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (_sid) hdrs['mcp-session-id'] = _sid;
  const r = await fetch('/mcp', {method: 'POST', headers: hdrs, body: JSON.stringify(body)});
  const sid = r.headers.get('mcp-session-id');
  if (sid) _sid = sid;
  return r;
}

async function _readResult(r, id) {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        const lines = buf.split('\\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let msg; try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.id === id) {
            if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
            return msg.result;
          }
        }
      }
    } finally { reader.cancel(); }
    throw new Error('SSE stream ended without result');
  }
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

async function mcpRequest(method, params) {
  const id = ++_mid;
  const r = await _mcpPost({jsonrpc: '2.0', id, method, ...(params ? {params} : {})});
  return _readResult(r, id);
}

async function mcpNotify(method, params) {
  await _mcpPost({jsonrpc: '2.0', method, ...(params ? {params} : {})});
}

// ── app state ─────────────────────────────────────────────────
let tools = [], selName = null, activeCat = 'all';

async function init() {
  let step = 'initialize';
  try {
    await mcpRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {name: 'tw-health-status-tester', version: '1.0'},
    });
    step = 'notifications/initialized';
    await mcpNotify('notifications/initialized');

    step = 'tools/list';
    const {tools: mcpTools} = await mcpRequest('tools/list');
    const byName = Object.fromEntries(mcpTools.map(t => [t.name, t]));
    const avail  = new Set(mcpTools.map(t => t.name));

    tools = Object.keys(CATEGORY_MAP).map(name => ({
      name,
      category:    CATEGORY_MAP[name],
      description: byName[name]?.description || '',
      available:   avail.has(name),
      inputSchema: byName[name]?.inputSchema || {},
    }));

    const n = tools.filter(t => t.available).length;
    document.getElementById('stats').innerHTML =
      `<b>${n}</b> / ${tools.length} tools available`;
    buildCats();
    filter();
  } catch(e) {
    document.getElementById('tlist').innerHTML =
      `<div style="padding:18px;color:#dc2626;font-size:.83rem;">Failed at <b>${esc(step)}</b>: ${esc(e.message)}</div>`;
  }
}

function buildCats() {
  const cats = ['all', ...new Set(tools.map(t => t.category))];
  document.getElementById('cats').innerHTML = cats.map(c => {
    const cnt = c === 'all' ? tools.length : tools.filter(t => t.category===c).length;
    const lbl = c === 'all' ? `All&nbsp;(${cnt})` : `${c}&nbsp;(${cnt})`;
    return `<div class="cat-btn${c===activeCat?' on':''}" onclick="setCat('${c}')">${lbl}</div>`;
  }).join('');
}

function setCat(c) {
  activeCat = c;
  document.querySelectorAll('.cat-btn').forEach(el => {
    const isAll = c==='all' && el.textContent.startsWith('All');
    const isMatch = c!=='all' && el.textContent.startsWith(c);
    el.classList.toggle('on', isAll || isMatch);
  });
  filter();
}

function filter() {
  const q = document.getElementById('srch').value.toLowerCase();
  const vis = tools.filter(t => {
    if (activeCat !== 'all' && t.category !== activeCat) return false;
    if (q && !t.name.includes(q) && !t.description.toLowerCase().includes(q)) return false;
    return true;
  });
  if (!vis.length) {
    document.getElementById('tlist').innerHTML =
      '<div style="padding:18px;color:#bbb;font-size:.83rem;">No matches</div>';
    return;
  }
  document.getElementById('tlist').innerHTML = vis.map(t =>
    `<div class="t-item${t.available?'':' off'}${selName===t.name?' sel':''}"
          onclick="pick('${t.name}')">
       <span class="dot ${t.available?'g':'gr'}"></span>
       <span class="tname">${t.name}</span>
     </div>`
  ).join('');
}

function pick(name) {
  selName = name;
  filter();
  const t = tools.find(x => x.name === name);
  if (t) renderDetail(t);
}

function renderDetail(t) {
  const props = t.inputSchema?.properties || {};
  const req   = t.inputSchema?.required  || [];
  const fields = Object.entries(props).map(([k,s]) => mkField(k,s,req.includes(k))).join('');

  document.getElementById('right').innerHTML = `
    <div class="th">
      <h2>${t.name}</h2>
      <span class="badge bc">${t.category}</span>
      <span class="badge ${t.available?'ba-on':'ba-off'}">
        ${t.available ? '● Available' : '○ Unavailable'}
      </span>
    </div>
    <p class="tdesc">${esc(t.description || 'No description.')}</p>
    <hr class="div">
    ${t.available ? `
      <div class="sec-title">Parameters</div>
      <form id="frm" onsubmit="run(event)">
        ${fields || '<p class="no-params">No parameters — just click Run.</p>'}
        <button type="submit" class="run-btn" id="rbtn">&#9654; Run Tool</button>
      </form>
      <div class="res-sec hidden" id="rsec">
        <div class="res-hdr">
          <span class="sec-title" style="margin:0;">Result</span>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="res-meta" id="rmeta"></span>
            <button class="copy-btn" onclick="collapseAll()">Collapse</button>
            <button class="copy-btn" onclick="expandAll()">Expand</button>
            <button class="copy-btn" onclick="copyRes()">Copy</button>
          </div>
        </div>
        <div id="rout" class="json-tree"></div>
      </div>
    ` : `
      <div class="unavail">
        This tool is currently unavailable — its dataset has not been loaded yet.<br>
        Run <code>docker compose run --rm data-loader --all</code> to populate the data.
      </div>
    `}`;
  applyExamples(t.name);
}

function applyExamples(toolName) {
  const ex = TOOL_EXAMPLES[toolName];
  if (ex) applyExample(toolName, ex, true);
  bindSelectorExampleSwitch(toolName);
}

function applyExample(toolName, example, resetToDefaults) {
  const t = tools.find(x => x.name === toolName);
  if (!t) return;
  const props = t.inputSchema?.properties || {};

  if (resetToDefaults) {
    for (const [k, s] of Object.entries(props)) {
      const el = document.getElementById('p_' + k);
      if (!el) continue;
      const { schema } = pickSchema(s);
      const def = s.default !== undefined ? s.default : (schema.default !== undefined ? schema.default : '');
      if (el.type === 'checkbox') {
        el.checked = Boolean(def);
      } else if (def === null || def === undefined) {
        el.value = '';
      } else if (typeof def === 'object') {
        el.value = JSON.stringify(def, null, 2);
      } else {
        el.value = String(def);
      }
    }
  }

  for (const [k, v] of Object.entries(example || {})) {
    const el = document.getElementById('p_' + k);
    if (!el) continue;
    if (el.type === 'checkbox') {
      el.checked = Boolean(v);
    } else if (typeof v === 'object' && v !== null) {
      el.value = JSON.stringify(v, null, 2);
    } else if (v === null || v === undefined) {
      el.value = '';
    } else {
      el.value = String(v);
    }
  }
}

function bindSelectorExampleSwitch(toolName) {
  const toolMap = TOOL_SELECTOR_EXAMPLES[toolName];
  if (!toolMap) return;

  for (const field of ['mode', 'type']) {
    const el = document.getElementById('p_' + field);
    const fieldMap = toolMap[field];
    if (!el || !fieldMap) continue;

    // Fields that appear in some but not all mode examples are conditional:
    // show them when the current mode uses them, hide them otherwise.
    const allExamples = Object.values(fieldMap);
    const allFields = new Set(
      allExamples.flatMap(ex => Object.keys(ex).filter(k => k !== field))
    );
    const universalFields = new Set(
      [...allFields].filter(k => allExamples.every(ex => k in ex))
    );
    const conditionalFields = [...allFields].filter(k => !universalFields.has(k));

    const updateVisibility = (example) => {
      for (const k of conditionalFields) {
        const fg = document.getElementById('p_' + k)?.closest('.fg');
        if (fg) fg.style.display = (k in example) ? '' : 'none';
      }
    };

    const applyByField = () => {
      const v = el.value;
      const example = fieldMap[v];
      if (example) {
        applyExample(toolName, example, true);
        updateVisibility(example);
      }
    };

    el.onchange = applyByField;
    applyByField();
  }
}

function pickSchema(s) {
  if (!s || typeof s !== 'object') {
    return { type: 'string', enumVals: null, schema: {} };
  }
  let schema = s;
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    const nonNull = s.anyOf.filter(opt => opt && opt.type !== 'null');
    if (nonNull.length > 0) {
      const enumOpt = nonNull.find(opt => Array.isArray(opt.enum));
      schema = enumOpt || nonNull[0];
    }
  }
  const type = schema.type || s.type || 'string';
  const enumVals = Array.isArray(schema.enum) ? schema.enum : (Array.isArray(s.enum) ? s.enum : null);
  return { type, enumVals, schema };
}

function mkField(k, s, isReq) {
  const { type, enumVals, schema } = pickSchema(s);
  const id = 'p_'+k, desc = s.description||'';
  const def = s.default !== undefined ? s.default : (schema.default !== undefined ? schema.default : '');

  let inp;
  if (type==='boolean') {
    inp = `<div class="cb-row"><input type="checkbox" id="${id}" ${def?'checked':''}><label for="${id}" style="font-weight:normal">${k}</label></div>`;
  } else if (enumVals) {
    const opts = [];
    if (!isReq) {
      opts.push(`<option value=""${def===null||def===''?' selected':''}>(none)</option>`);
    }
    opts.push(...enumVals.map(v=>`<option value="${v}"${v===def?'selected':''}>${v}</option>`));
    inp = `<select id="${id}" ${isReq?'required':''}>${opts.join('')}</select>`;
  } else if (type==='integer'||type==='number') {
    const mn = schema.minimum!==undefined?`min="${schema.minimum}"`:(s.minimum!==undefined?`min="${s.minimum}"`:'');
    const mx = schema.maximum!==undefined?`max="${schema.maximum}"`:(s.maximum!==undefined?`max="${s.maximum}"`:'');
    inp = `<input type="number" id="${id}" value="${def}" ${mn} ${mx} placeholder="${ph(k)}" ${isReq?'required':''}>`;
  } else if (type==='array') {
    inp = `<textarea id="${id}" rows="3" placeholder="${arrPh(k)}" ${isReq?'required':''}></textarea>`;
  } else if (type==='object') {
    inp = `<textarea id="${id}" rows="3" placeholder='{"key":"value"}' ${isReq?'required':''}></textarea>`;
  } else if (type==='string' && k.endsWith('_json')) {
    inp = `<textarea id="${id}" rows="4" style="font-family:monospace;font-size:0.79rem;" placeholder="${k}" ${isReq?'required':''}></textarea>`;
  } else {
    inp = `<input type="text" id="${id}" value="${def}" placeholder="${ph(k)}" ${isReq?'required':''}>`;
  }

  return `<div class="fg">
    <label class="${isReq?'req':''}" for="${id}">${k}</label>
    ${desc?`<div class="fdesc">${esc(desc)}</div>`:''}
    ${inp}
  </div>`;
}

const PH = {
  keyword:'e.g. 糖尿病, diabetes', query:'e.g. A10BA02, 降血糖',
  icd_code:'e.g. E11.9', code:'e.g. E11.9', diagnosis_code:'e.g. E11.9',
  loinc_code:'e.g. 2345-7', loinc_num:'e.g. 4548-4',
  concept_id:'e.g. 73211009', permit_no:'e.g. 衛署健食字第A00022號',
  license_id:'e.g. 內衛成製字第000029號', food_name:'e.g. 雞蛋',
  ingredient_name:'e.g. metformin', nutrient:'e.g. 鈣, 粗蛋白',
  component:'e.g. Glucose', specimen_type:'e.g. 血清/血漿',
  features:'e.g. 白色 圓形', category:'e.g. E11, CHEM',
  diagnosis_keyword:'e.g. 糖尿病, E11', medication_class:'e.g. Metformin',
  drug_name:'e.g. Metformin', procedure_code:'e.g. 0BH17EZ',
  cs_id:'e.g. TW-CodeSystem-medication-fda-tw',
};
const ARR_PH = {
  foods:'["白米", "雞胸肉"]',
  drug_names:'["Metformin", "Warfarin"]',
  results_json:'[{"loinc_code":"2345-7","value":5.5}]',
};
const ph  = k => PH[k] || '';
const arrPh = k => ARR_PH[k] || '["item1","item2"]';

async function run(e) {
  e.preventDefault();
  const t = tools.find(x => x.name===selName); if (!t) return;
  const props = t.inputSchema?.properties || {};
  const args = {};

  for (const [k, s] of Object.entries(props)) {
    const el = document.getElementById('p_'+k); if (!el) continue;
    const { type } = pickSchema(s);
    if (type==='boolean') { args[k] = el.checked; continue; }
    if (!el.value) continue;
    if (type==='integer')            args[k] = parseInt(el.value, 10);
    else if (type==='number')        args[k] = parseFloat(el.value);
    else if (type==='array'||type==='object') {
      try { args[k] = JSON.parse(el.value); } catch { args[k] = el.value; }
    } else args[k] = el.value;
  }

  const btn = document.getElementById('rbtn');
  btn.innerHTML = '<span class="spin"></span>Running…';
  btn.disabled = true;
  const t0 = Date.now();

  try {
    const result = await mcpRequest('tools/call', {name: selName, arguments: args});
    const ms = Date.now()-t0;

    // MCP returns content blocks; extract text
    const raw = result?.content?.map(c => c.text ?? '').join('') ?? JSON.stringify(result);

    document.getElementById('rsec').classList.remove('hidden');
    document.getElementById('rmeta').textContent =
      ms+'ms' + (result?.isError ? ' ⚠ tool error' : '');
    renderResult(raw);
  } catch(err) {
    document.getElementById('rsec').classList.remove('hidden');
    document.getElementById('rmeta').textContent = '';
    const rout = document.getElementById('rout');
    rout.className = 'json-tree plain';
    rout.textContent = 'Error: '+err.message;
    _copyText = 'Error: '+err.message;
  } finally {
    btn.innerHTML = '&#9654; Run Tool';
    btn.disabled = false;
  }
}

// ── JSON tree renderer ────────────────────────────────────────
let _copyText = '';

function jEsc(s) {
  return JSON.stringify(s).slice(1,-1)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function jLeaf(v) {
  if (v === null) return '<span class="jnull">null</span>';
  if (typeof v === 'boolean') return `<span class="jbool">${v}</span>`;
  if (typeof v === 'number') return `<span class="jnum">${v}</span>`;
  return `<span class="jstr">"${jEsc(String(v))}"</span>`;
}

function jNode(v, depth, key, comma) {
  const keyHtml = key !== undefined
    ? `<span class="jkey">"${jEsc(key)}"</span><span class="jsep">: </span>` : '';
  const commaHtml = comma ? `<span class="jsep">,</span>` : '';

  if (v === null || typeof v !== 'object') {
    return `<div class="jleaf">${keyHtml}${jLeaf(v)}${commaHtml}</div>`;
  }

  const isArr = Array.isArray(v);
  const entries = isArr ? v.map((x,i) => [i, x]) : Object.entries(v);
  const open = isArr ? '[' : '{', close = isArr ? ']' : '}';

  if (entries.length === 0) {
    return `<div class="jleaf">${keyHtml}<span class="jbrace">${open}${close}</span>${commaHtml}</div>`;
  }

  const collapsed = depth >= 2;
  const cnt = entries.length;
  const label = isArr ? `${cnt} item${cnt!==1?'s':''}` : `${cnt} key${cnt!==1?'s':''}`;
  const ch = entries.map(([k, vv], i) =>
    jNode(vv, depth+1, isArr ? undefined : String(k), i < cnt-1)
  ).join('');

  return (
    `<div class="jcoll${collapsed?' jcollapsed':''}">` +
      `<div class="jhead" onclick="jTog(this)">` +
        `<span class="jt">${collapsed?'&#9656;':'&#9662;'}</span>` +
        keyHtml +
        `<span class="jbrace">${open}</span>` +
        `<span class="jsum"> ${label} ${close}${comma?',':''}</span>` +
      `</div>` +
      `<div class="jch">${ch}</div>` +
      `<div class="jfoot"><span class="jbrace">${close}</span>${commaHtml}</div>` +
    `</div>`
  );
}

function jTog(head) {
  const coll = head.closest('.jcoll');
  const wasCollapsed = coll.classList.contains('jcollapsed');
  coll.classList.toggle('jcollapsed');
  head.querySelector('.jt').innerHTML = wasCollapsed ? '&#9662;' : '&#9656;';
}

function collapseAll() {
  document.querySelectorAll('#rout .jcoll').forEach(c => {
    if (!c.classList.contains('jcollapsed')) {
      c.classList.add('jcollapsed');
      const t = c.querySelector(':scope > .jhead > .jt');
      if (t) t.innerHTML = '&#9656;';
    }
  });
}

function expandAll() {
  document.querySelectorAll('#rout .jcoll').forEach(c => {
    if (c.classList.contains('jcollapsed')) {
      c.classList.remove('jcollapsed');
      const t = c.querySelector(':scope > .jhead > .jt');
      if (t) t.innerHTML = '&#9662;';
    }
  });
}

function renderResult(raw) {
  const rout = document.getElementById('rout');
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    _copyText = raw;
    rout.className = 'json-tree plain';
    rout.textContent = raw;
    return;
  }
  _copyText = JSON.stringify(parsed, null, 2);
  rout.className = 'json-tree';
  rout.innerHTML = jNode(parsed, 0);
}

function copyRes() {
  navigator.clipboard.writeText(_copyText).then(()=>{
    const b = document.querySelector('.copy-btn');
    b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy', 2000);
  });
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

init();
</script>
</body>
</html>
"""


class PrivacyPageMiddleware:
    """Serve static pages (/, /privacy, /dpa, /status) and static assets (logos, favicon)."""

    def __init__(self, app):
        self.app = app

    async def _send_file(self, send, body: bytes, content_type: bytes):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", content_type),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"public, max-age=604800"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})

    async def _send_404(self, send):
        await send(
            {
                "type": "http.response.start",
                "status": 404,
                "headers": [(b"content-length", b"9")],
            }
        )
        await send(
            {"type": "http.response.body", "body": b"Not Found", "more_body": False}
        )

    async def _send_html(self, send, body: bytes):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"text/html; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"public, max-age=300"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            method = scope.get("method", "")
            path = scope.get("path", "").rstrip("/")

            # ── static HTML pages ──────────────────────────────────────────
            if method == "GET":
                if path in ("", "/"):
                    await self._send_html(send, _LANDING_HTML_BYTES)
                    return
                if path == "/privacy":
                    await self._send_html(send, _PRIVACY_HTML_BYTES)
                    return
                if path == "/dpa":
                    await self._send_html(send, _DPA_HTML_BYTES)
                    return
                if path == "/status":
                    await self._send_html(send, _STATUS_HTML_BYTES)
                    return

                # ── static assets (logos + favicon) ───────────────────────
                if path in ("/favicon.ico", "/favicon.png", "/logo-s.png"):
                    if _LOGO_S_BYTES:
                        await self._send_file(send, _LOGO_S_BYTES, b"image/png")
                    else:
                        await self._send_404(send)
                    return
                if path == "/logo-h.png":
                    if _LOGO_H_BYTES:
                        await self._send_file(send, _LOGO_H_BYTES, b"image/png")
                    else:
                        await self._send_404(send)
                    return

            # ── SSE responses: disable nginx proxy buffering ───────────────
            # nginx buffers SSE by default, which breaks streaming. Injecting
            # X-Accel-Buffering: no instructs nginx to pass chunks through
            # immediately without buffering.
            async def sse_send(message):
                if message["type"] == "http.response.start":
                    headers = list(message.get("headers", []))
                    is_sse = any(
                        n.lower() == b"content-type" and b"text/event-stream" in v
                        for n, v in headers
                    )
                    if is_sse:
                        headers.append((b"x-accel-buffering", b"no"))
                        message = {**message, "headers": headers}
                await send(message)

            await self.app(scope, receive, sse_send)
            return

        await self.app(scope, receive, send)


def _call_http_factory(factory, **kwargs):
    """Call a FastMCP HTTP app factory with best-effort compatibility."""
    try:
        sig = inspect.signature(factory)
        accepted = {k: v for k, v in kwargs.items() if k in sig.parameters}
    except (TypeError, ValueError):
        accepted = kwargs

    try:
        return factory(**accepted)
    except TypeError:
        return factory()


def build_http_app():
    """Build an ASGI app for HTTP transports and wrap it with error logging."""
    transport = "sse" if config.transport == "sse" else "streamable-http"

    if hasattr(mcp, "http_app"):
        app = _call_http_factory(mcp.http_app, path=config.path, transport=transport)
    elif transport == "streamable-http" and hasattr(mcp, "streamable_http_app"):
        app = _call_http_factory(mcp.streamable_http_app, path=config.path)
    elif transport == "sse" and hasattr(mcp, "sse_app"):
        app = _call_http_factory(mcp.sse_app, path=config.path)
    elif hasattr(mcp, "app"):
        app = mcp.app
    else:
        raise RuntimeError("FastMCP does not expose an HTTP ASGI app")

    return PrivacyPageMiddleware(ApiErrorLoggingMiddleware(app))


# ============================================================
# Health check
# ============================================================


_READ_ONLY = ToolAnnotations(readOnlyHint=True)


@mcp.tool(annotations=_READ_ONLY)
async def health_check() -> str:
    """
    Return runtime readiness of the MCP server and every dataset-backed service.

    Call this first before any workflow to confirm the required services are online.
    Returns a lightweight JSON object — no expensive queries are run.

    Response structure:
    - `status`: `"ok"` when the database is reachable, `"degraded"` when not
    - `database`: `"ok"` | `"error"`
    - `cache`: `"ok"` | `"error"` (Redis — cache failure does not degrade tools,
      it only disables response caching)
    - `services`: object with one boolean flag per service group:
      - `icd` — ICD-10-CM/PCS codes (search_medical_codes, infer_complications,
        get_nearby_codes, check_medical_conflict, browse_icd_category)
      - `health_supplement` — Taiwan FDA health foods (search_health_supplement)
      - `food_nutrition` — Taiwan FDA food composition
        (query_food_nutrition, query_food_ingredient,
         search_foods_by_nutrient, analyze_meal_nutrition)
      - `fhir_condition` — FHIR R4 Condition resources (query_fhir_condition,
        validate_fhir_condition)
      - `lab` — LOINC lab tests (search_loinc, query_loinc, interpret_lab_result,
        batch_interpret_lab_results)
      - `guideline` — Taiwan clinical guidelines (search_clinical_guideline,
        query_guideline)
      - `twcore` — TWCore IG CodeSystems (query_twcore_code)
      - `snomed` — SNOMED CT concepts (search_snomed_concept, query_snomed_concept,
        get_snomed_relationships, query_snomed_mapping)

    A `false` flag means the dataset was not loaded or the service failed to
    initialize; those tools will return a service-unavailable error until the
    underlying data is populated and the service restarted.
    """
    pool = database.get_pool()
    db_ok = False
    try:
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        db_ok = True
    except Exception:
        pass

    cache_ok = False
    try:
        client = cache_module.get_client()
        await client.ping()
        cache_ok = True
    except Exception:
        pass

    return json.dumps(
        {
            "status": "ok" if db_ok else "degraded",
            "database": "ok" if db_ok else "error",
            "cache": "ok" if cache_ok else "error",
            "services": {
                "icd": icd_service is not None,
                "health_supplement": health_food_service is not None,
                "food_nutrition": food_nutrition_service is not None,
                "fhir_condition": fhir_condition_service is not None,
                "lab": lab_service is not None,
                "guideline": guideline_service is not None,
                "twcore": twcore_service is not None,
                "snomed": snomed_service is not None,
            },
        },
        ensure_ascii=False,
    )


# ============================================================
# Group 1: ICD-10
# ============================================================


@audited("search_medical_codes")
async def search_medical_codes(
    keyword: str,
    type: Literal["diagnosis", "procedure", "all"] = "all",
    limit: int = 3,
) -> str:
    """
    Search ICD-10-CM 2025 diagnosis codes and ICD-10-PCS 2025 procedure codes.

    Search behavior by `type`:
    - `diagnosis` (ICD-10-CM only): hybrid BM25 + vector embedding re-ranking —
      semantic matches surface even without exact keyword overlap, e.g. '糖尿病'
      surfaces 'E11 Type 2 diabetes mellitus with complications'.
    - `procedure` (ICD-10-PCS only): BM25 full-text only; no vector ranking.
    - `all` (default): runs both searches and returns separate `diagnoses` and
      `procedures` keys in the response.

    Output shape:
    - `diagnoses`: list of `{code, name_zh, name_en}` (ICD-10-CM)
    - `procedures`: list of `{code, name_zh, name_en}` (ICD-10-PCS, empty if data
      not loaded)
    - `procedures_note`: present when PCS data has not been loaded

    Results are ranked by relevance score, not alphabetical. The tool always
    returns up to `limit` items even when no exact match exists — treat results
    as the closest approximations found, not confirmed matches.

    Data source: ICD-10-CM 2025 (NLM) + ICD-10-PCS 2025 (CMS).

    Args:
        keyword: Search term — English name, Chinese name, or code prefix.
                 Examples: 'Diabetes', 'E11', '子宮內膜異位症', '高血壓',
                 'appendicitis', '0DTJ' (PCS prefix), 'N18' (CKD category).
        type: `"diagnosis"` | `"procedure"` | `"all"` (default `"all"`).
        limit: Results per type (default 3, max 10). Applies independently to
               both diagnoses and procedures when `type="all"`.
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.search_codes(keyword, type, limit=limit)


@audited("infer_complications")
async def infer_complications(code: str) -> str:
    """
    Explore the ICD-10-CM hierarchy for a diagnosis code or category prefix.

    This is a pure hierarchy lookup — it traverses the ICD tree, not AI-generated
    clinical inference. Use it to expand a broad code into billable specifics, or
    to find sibling codes when you already have a leaf.

    Behaviour depends on whether child codes exist:
    - **Category/parent code** (e.g. `E11`): returns up to 15 more-specific child
      codes in that subtree — useful to find the correct billable code.
    - **Leaf/specific code** (e.g. `E11.9`): no children exist, so returns up to
      10 sibling codes from the same 3-character category — useful to compare
      nearby specificity options before final code selection.

    Output shape:
    - parent result: `{"base_code", "potential_complications_or_specifics": [...]}`
    - leaf result: `{"message", "related_codes": [...]}`
    Each item: `{code, name_zh}`.

    Args:
        code: ICD-10-CM code or category prefix, e.g. `"E11"` (type 2 diabetes),
              `"E11.9"` (leaf), `"N18"` (CKD), `"N80"` (endometriosis),
              `"I10"` (essential hypertension). Case-insensitive.
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.infer_complications(code)


@audited("get_nearby_codes")
async def get_nearby_codes(code: str) -> str:
    """
    Retrieve the two ICD-10-CM codes immediately before and after a known code.

    Returns exactly 4 neighbors in tabular (alphabetical code) ordering — up to
    2 preceding codes and up to 2 following codes — plus the target code itself.
    These are ordering neighbors, not semantic matches. Use this for coder review
    workflows or "did-you-mean adjacent code" UX before final coding.

    Output shape: `{"target", "nearby_options": [{code, name_zh, rel}, ...]}`
    where `rel` is `"prev"` or `"next"`.
    Results are sorted by code alphabetically.

    Note: if the target code does not exist in the database, neighbors are still
    returned based on alphabetical ordering around that position.

    Args:
        code: ICD-10-CM diagnosis code, e.g. `"E11.9"`, `"I10"`, `"N18.4"`.
              Case-insensitive (normalized to uppercase internally).
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.get_nearby_codes(code)


@audited("check_medical_conflict")
async def check_medical_conflict(diagnosis_code: str, procedure_code: str) -> str:
    """
    Fetch full metadata for one diagnosis + one procedure code side-by-side.

    Use this for coding QA, claim pre-check, or LLM-driven plausibility review.
    The tool returns all available fields for both codes so downstream logic (or
    an LLM) can reason about anatomical alignment, gender/age specificity, and
    clinical intent.

    Output shape:
    ```json
    {
      "diagnosis_info": {code, name_zh, name_en, category, ...},
      "procedure_info": {code, name_zh, name_en, ...},
      "instruction": "Analyze the above for potential contraindications or medical conflicts."
    }
    ```
    - `procedure_info` is a string message when ICD-10-PCS data is not loaded.
    - Fields are `null` when a code is not found in the database.

    Important: this tool returns facts/metadata only — it does NOT emit a
    pass/fail verdict. Downstream rule logic or clinician review must decide.

    Args:
        diagnosis_code: ICD-10-CM code, e.g. `"K35.80"`, `"E11.9"`, `"N18.3"`.
        procedure_code: ICD-10-PCS code, e.g. `"0DTJ0ZZ"`, `"0FB04ZX"`.
                        Requires ICD-10-PCS data to be loaded (see health_check).
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.get_conflict_info(diagnosis_code, procedure_code)


# ============================================================
# Group 1b: ICD-10 category browser
# ============================================================


@audited("browse_icd_category")
async def browse_icd_category(category: str | None = None, limit: int = 50) -> str:
    """
    Browse ICD-10-CM structure by chapter or 3-character category.

    Use this for exploratory workflows where the exact billable code is not
    known yet. Typical two-step flow:
    1. Call without `category` to enumerate all top-level categories with counts
    2. Call with a 3-character category to expand it into specific codes

    Output shapes:
    - **No category** (`category=None`):
      `{"total_categories", "categories": [{category, category_name_zh,
       category_name_en, code_count}, ...]}`
    - **With category** (e.g. `"E11"`):
      `{"category", "total", "codes": [{code, name_zh, name_en}, ...]}`
    - Unknown category returns `{"error": "找不到 category '...'"}`.

    Args:
        category: 3-character ICD category prefix, e.g. `"E11"` (type 2 diabetes),
            `"I10"` (hypertension), `"N18"` (CKD), `"N80"` (endometriosis).
            Omit (or pass `null`) to list all categories.
        limit: Maximum codes returned for a single category (default 50, cap 200).
               Ignored when `category` is omitted.
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.browse_category(category, limit)


# ============================================================
# Group 2: Health Supplement (Taiwan FDA)
# ============================================================


async def _build_health_supplement_result(
    row: dict,
    *,
    mode: str,
    keyword: str,
    icd_code: str | None = None,
    recommended_benefits: list[str] | None = None,
) -> dict:
    result = {
        "permit_no": row.get("permit_no"),
        "product_name": row.get("name"),
        "company": row.get("applicant"),
        "benefits": row.get("benefit_claims"),
        "ingredients": row.get("ingredients", []),
        "specs": row.get("specs", {}),
        "status": row.get("status"),
        "source_url": row.get("source_url"),
    }
    return result


@audited("search_health_supplement")
async def search_health_supplement(
    mode: Literal["keyword", "permit_no", "condition"] = "keyword",
    keyword: str = "",
    limit: int = 3,
) -> str:
    """
    Search Taiwan FDA certified health supplements (健康食品) by three modes.

    Mode reference:
    - `keyword` (default): full-text + semantic search across product name,
      company, ingredient list, and approved benefit claims. Uses hybrid BM25 +
      embedding re-ranking. Returns up to `limit` results (cap 10).
      Example: keyword `"葉黃素"`, `"益生菌"`, `"lutein"`.
    - `permit_no`: look up one product by its Taiwan FDA permit number.
      Supports exact match (e.g. `"健食字第A00022號"`) or bare digits
      (`"A00022"` or `"00022"`). Always returns at most 1 result.
      `limit` is ignored in this mode.
    - `condition`: map a disease name or ICD-10 code to recommended health
      benefit categories, then find certified products matching those benefits.
      Returns extra top-level fields `icd_code` and `recommended_benefits`.
      Example: keyword `"糖尿病"` or `"E11"` or `"高血壓"`.

    Response shape (all modes):
    ```json
    {
      "mode": "keyword" | "permit_no" | "condition",
      "keyword": "<input>",
      "results": [
        {
          "permit_no", "product_name", "company",
          "benefits",      // approved benefit claims (string)
          "ingredients",   // list of ingredient entries
          "specs",         // packaging/dosage specs
          "status",        // approval status
          "source_url"     // FDA product page URL
        }
      ]
    }
    ```
    `condition` mode additionally includes `"icd_code"` and
    `"recommended_benefits"` at the top level.

    Args:
        mode: `"keyword"` | `"permit_no"` | `"condition"`. Default `"keyword"`.
        keyword: In `keyword` mode — product/ingredient/benefit search term.
                 In `permit_no` mode — the permit number or its digits.
                 In `condition` mode — a disease name or ICD-10 code.
        limit: Max results (default 3, cap 10). Applies to `keyword` and
               `condition` modes; ignored for `permit_no` (always returns ≤1).
    """
    if health_food_service is None:
        return _svc_unavailable("Health Supplement Service")
    if not keyword:
        return _json_error("Provide keyword")

    limit = min(max(1, limit), 10)
    async with health_food_service.pool.acquire() as conn:
        if mode == "keyword":
            raw = await health_food_service.search_health_food(keyword, limit=limit)
            payload = json.loads(raw)
            results = []
            for item in payload.get("results", []):
                permit_no = item.get("permit_no")
                if not permit_no:
                    continue
                row = await conn.fetchrow(
                    "SELECT * FROM health_food.items WHERE permit_no = $1", permit_no
                )
                if row:
                    results.append(
                        await _build_health_supplement_result(
                            dict(row), mode=mode, keyword=keyword
                        )
                    )
            return json.dumps(
                {"mode": mode, "keyword": keyword, "results": results},
                ensure_ascii=False,
            )

        if mode == "permit_no":
            row = await conn.fetchrow(
                "SELECT * FROM health_food.items WHERE permit_no = $1", keyword
            )
            if not row:
                digits = re.search(r"\d+", keyword)
                if digits:
                    digits_only = digits.group()
                    if keyword.isdigit():
                        row = await conn.fetchrow(
                            "SELECT * FROM health_food.items WHERE permit_no ILIKE $1 ORDER BY permit_no LIMIT 1",
                            f"%{digits_only}%",
                        )
                    else:
                        rows = await conn.fetch(
                            "SELECT * FROM health_food.items WHERE permit_no ILIKE $1 ORDER BY permit_no LIMIT 50",
                            f"%{digits_only}%",
                        )
                        row = rows[0] if rows else None
            if not row:
                return json.dumps(
                    {"mode": mode, "keyword": keyword, "results": []},
                    ensure_ascii=False,
                )
            return json.dumps(
                {
                    "mode": mode,
                    "keyword": keyword,
                    "results": [
                        await _build_health_supplement_result(
                            dict(row), mode=mode, keyword=keyword
                        )
                    ],
                },
                ensure_ascii=False,
            )

        if mode == "condition":
            raw = await health_food_service.analyze_health_support_for_condition(
                keyword, icd_service=icd_service
            )
            payload = json.loads(raw)
            icd_code = payload.get("icd_code")
            recommended_benefits = payload.get("recommended_benefits", [])
            foods = payload.get("health_foods", [])
            results = []
            for food in foods[:limit]:
                permit_no = food.get("permit_no")
                if not permit_no:
                    continue
                row = await conn.fetchrow(
                    "SELECT * FROM health_food.items WHERE permit_no = $1", permit_no
                )
                if row:
                    results.append(
                        await _build_health_supplement_result(
                            dict(row),
                            mode=mode,
                            keyword=keyword,
                            icd_code=icd_code,
                            recommended_benefits=recommended_benefits,
                        )
                    )
            return json.dumps(
                {
                    "mode": mode,
                    "keyword": keyword,
                    "icd_code": icd_code,
                    "recommended_benefits": recommended_benefits or [],
                    "results": results,
                },
                ensure_ascii=False,
            )

    return _json_error("Provide mode as keyword, permit_no, or condition")


# ============================================================
# Group 4: Food Nutrition
# ============================================================


@audited("query_food_nutrition")
async def query_food_nutrition(
    food_name: str,
    nutrient: str | None = None,
    limit: int = 3,
    detailed: bool = False,
) -> str:
    """
    Search Taiwan FDA food composition database for nutritional content per 100 g.

    Uses hybrid BM25 + semantic embedding re-ranking to find the closest matching
    foods. E.g. `"白米"` may surface `"蓬萊米"` or `"米飯(熟)"`.

    Two output modes controlled by `detailed`:

    **`detailed=False`** (default) — quick lookup, flat nutrient list:
    - Returns up to `limit` foods (cap 10).
    - Supports optional `nutrient` filter (partial ILIKE match, e.g. `"蛋白"`
      matches `"粗蛋白"`). Omit `nutrient` to return all nutrients.
    - Output: `[{food, category, nutrients: [{item, value, unit}, ...]}, ...]`

    **`detailed=True`** — complete nutrient panel, grouped by category:
    - Always returns up to 3 best-matching foods; `limit` is ignored.
    - `nutrient` filter is ignored; always returns the full panel.
    - Nutrient panel covers energy, macronutrients, vitamins (A/B1/B2/B6/B12/C/
      D/E/K/niacin/folate), minerals (Ca/P/Fe/Na/K/Mg/Zn/Mn/Cu/Se/I), fatty
      acids (SFA/MUFA/PUFA/trans/cholesterol/EPA/DHA — EPA/DHA only for seafood).
    - Output: `[{sample_name, common_name, food_category,
      nutrients: {category_name: [{item, value, unit}]}}]`

    Data source: Taiwan FDA Food Composition Database (台灣食品成分資料庫).
    Values are per 100 g edible portion.

    Args:
        food_name: Food name in Chinese or English (e.g. `"白米"`, `"雞蛋"`,
                   `"豆腐"`, `"chicken breast"`, `"salmon"`, `"鮭魚"`).
        nutrient: Nutrient column filter (default mode only). Partial Taiwan FDA
                  column names accepted — e.g. `"粗蛋白"`, `"蛋白"`, `"鈣"`,
                  `"維生素C"`, `"膳食纖維"`, `"熱量"`. Omit to get all nutrients.
        limit: Closest-matching food variants to return (default 3, max 10).
               Applies to `detailed=False` only.
        detailed: `False` (default) for quick flat lookup; `True` for full
                  grouped nutrient panel.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    if detailed:
        return await food_nutrition_service.get_detailed_nutrition(food_name)
    return await food_nutrition_service.search_nutrition(food_name, nutrient, limit=limit)


@audited("query_food_ingredient")
async def query_food_ingredient(
    keyword: str,
    category: Literal[
        "可供食品使用之原料",
        "未確認安全性尚不得使用之原料",
    ] | None = None,
    limit: int = 3,
) -> str:
    """
    Search the Taiwan FDA food ingredient classification database by keyword,
    with an optional category filter.

    Uses hybrid BM25 + semantic embedding re-ranking to find the closest matching
    ingredients even when the exact name is unknown.

    Data coverage: food additives, natural-origin ingredients, flavourings,
    processing aids, and novel food categories
    (台灣食品添加物及食品原料資料庫).

    Categories (`major_category` values in the database):
    - `"可供食品使用之原料"` — approved for food use (1,170 entries)
    - `"未確認安全性尚不得使用之原料"` — safety unconfirmed, not yet permitted (532 entries)
    Omit `category` to search across both.

    Output: `[{name_zh, name_en, major_category, sub_category, note}, ...]`

    Args:
        keyword: Ingredient name in Chinese or English. Examples: `"薑黃"`,
                 `"turmeric"`, `"卡拉膠"`, `"carrageenan"`, `"山梨酸"`,
                 `"sorbic acid"`, `"紅麴"`, `"亞硝酸鈉"`.
        category: Optional filter by `major_category`. Omit to search all.
        limit: Max results (default 3, max 10).
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_food_ingredient(
        keyword, limit=limit, category=category
    )


@audited("search_foods_by_nutrient")
async def search_foods_by_nutrient(nutrient: str, limit: int = 20) -> str:
    """
    Rank Taiwan FDA foods by highest content of a specific nutrient (per 100 g).

    Nutrient resolution order:
    1. Built-in alias map (common synonyms → canonical column name):
       `"蛋白質"` / `"protein"` → `"粗蛋白"`,
       `"維他命C"` / `"vitamin c"` → `"維生素C"`,
       `"calcium"` / `"鈣"` → `"鈣"`,
       `"fat"` / `"脂肪"` → `"粗脂肪"`,
       `"fiber"` / `"纖維"` → `"膳食纖維"`,
       `"EPA"`, `"DHA"` → direct column names.
    2. Partial ILIKE match against Taiwan FDA nutrient column names.
    3. Semantic embedding search if steps 1 and 2 find nothing.

    Results are sorted descending by nutrient value — the food with the highest
    content of the requested nutrient is first.

    Output shape:
    `{"nutrient", "unit", "foods": [{food_name, food_code, category, value}, ...]}`

    Args:
        nutrient: Nutrient name in Chinese or English — aliases and synonyms
                  accepted. Examples: `"粗蛋白"`, `"蛋白質"`, `"protein"`,
                  `"鈣"`, `"calcium"`, `"維生素C"`, `"維他命C"`, `"vitamin c"`,
                  `"膳食纖維"`, `"fiber"`, `"EPA"`, `"DHA"`, `"熱量"`,
                  `"粗脂肪"`, `"fat"`.
        limit: Foods to return (default 20, max 50).
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    limit = min(max(1, limit), 50)
    return await food_nutrition_service.search_foods_by_nutrient(nutrient, limit)


@audited("analyze_meal_nutrition")
async def analyze_meal_nutrition(foods: list[str]) -> str:
    """
    Aggregate nutrition for a meal from multiple foods (100 g per food assumed).

    Resolves each food name against the Taiwan FDA food composition database, then
    sums nutrient values across all items. Returns both per-food breakdowns and
    a combined meal total. Use `query_food_nutrition(detailed=True)` first if
    you need to confirm which row a partial name resolves to.

    Portion assumption: every food in the list is treated as exactly 100 g.
    To adjust for real serving sizes, scale the returned values manually.

    Output shape:
    ```json
    {
      "meal_components": {
        "<food_name>": {"found": true, "food_name": "...", "nutrients": {...}}
      },
      "combined_totals_per_100g_each": {"熱量": ..., "粗蛋白": ..., ...}
    }
    ```
    Foods that cannot be matched appear with `"found": false`.

    Args:
        foods: List of food names in Chinese.
               Example: `["白米飯", "雞胸肉", "青花菜", "豆腐", "鮭魚"]`.
               Partial names are accepted where a single matching row exists.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.analyze_meal_nutrition(foods)


# ============================================================
# Group 5: FHIR Condition
# ============================================================
@audited("query_fhir_condition")
async def query_fhir_condition(
    icd_code: str | None = None,
    diagnosis_keyword: str | None = None,
    patient_id: str = "",
    clinical_status: Literal["active", "inactive", "resolved", "remission"] = "active",
    verification_status: Literal[
        "confirmed", "provisional", "differential", "refuted"
    ] = "confirmed",
    category: Literal[
        "encounter-diagnosis", "problem-list-item"
    ] = "encounter-diagnosis",
    severity: str | None = None,
    onset_date: str | None = None,
    recorded_date: str | None = None,
    additional_notes: str | None = None,
) -> str:
    """
    Generate a FHIR R4 Condition resource from an ICD-10-CM code or a keyword.

    Two routing paths (provide exactly one of `icd_code` or `diagnosis_keyword`):

    **Path A — direct code** (`icd_code` provided):
    Builds the Condition resource directly from the given ICD-10-CM code.
    All optional fields (`patient_id`, `clinical_status`, `verification_status`,
    `category`, `severity`, `onset_date`, `recorded_date`, `additional_notes`)
    are applied to the resource.

    **Path B — keyword search** (`diagnosis_keyword` provided):
    Searches the ICD service for the best-matching diagnosis code first, then
    builds the Condition from that match. In this path, only `patient_id`,
    `clinical_status`, and `verification_status` are forwarded to the resource;
    `category`, `severity`, `onset_date`, `recorded_date`, and
    `additional_notes` are NOT applied — use Path A with the returned code if
    you need those fields populated.

    Output: a FHIR R4 Condition JSON resource with TWCore IG coding extensions.

    Args:
        icd_code: Exact ICD-10-CM code, e.g. `"E11.9"`, `"I10"`, `"N18.3"`.
                  Takes priority over `diagnosis_keyword` if both are given.
        diagnosis_keyword: Diagnosis term in Chinese or English for search-first
                           flow, e.g. `"第二型糖尿病"`, `"diabetes mellitus"`,
                           `"高血壓"`.
        patient_id: Value for `Condition.subject.reference` (e.g. `"Patient/123"`).
        clinical_status: `"active"` | `"inactive"` | `"resolved"` | `"remission"`.
        verification_status: `"confirmed"` | `"provisional"` | `"differential"` |
                             `"refuted"`.
        category: `"encounter-diagnosis"` (default) for a visit diagnosis, or
                  `"problem-list-item"` for a chronic/persistent problem.
                  Only applied in Path A (direct code).
        severity: Optional free-text severity label, e.g. `"mild"`, `"moderate"`,
                  `"severe"`. Only applied in Path A.
        onset_date: `YYYY-MM-DD` onset date. Only applied in Path A.
        recorded_date: `YYYY-MM-DDTHH:MM:SS+08:00` timestamp. Only applied in Path A.
        additional_notes: Optional clinical note string. Only applied in Path A.
    """
    if fhir_condition_service is None:
        return _svc_unavailable("FHIR Condition Service")
    if diagnosis_keyword:
        return await _call_service_json(
            fhir_condition_service,
            "create_condition_from_search",
            keyword=diagnosis_keyword,
            patient_id=patient_id,
            clinical_status=clinical_status,
            verification_status=verification_status,
            severity=severity,
        )
    if not icd_code:
        return _json_error("Provide either icd_code or diagnosis_keyword")
    return await _call_service_json(
        fhir_condition_service,
        "create_condition",
        icd_code=icd_code,
        patient_id=patient_id,
        clinical_status=clinical_status,
        verification_status=verification_status,
        category=category,
        severity=severity,
        onset_date=onset_date,
        recorded_date=recorded_date,
        additional_notes=additional_notes,
    )


@audited("validate_fhir_condition")
async def validate_fhir_condition(condition_json: str) -> str:
    """
    Validate a FHIR R4 Condition resource for required fields and value-set compliance.

    Validation checks performed:
    - `resourceType` must be `"Condition"`
    - `subject` reference must be present
    - `code.coding` must include at least one entry with a system and code
      (ICD-10-CM system expected)
    - `clinicalStatus.coding[0].code` must be one of:
      `active`, `recurrence`, `relapse`, `inactive`, `remission`, `resolved`
    - `verificationStatus.coding[0].code` must be one of:
      `unconfirmed`, `provisional`, `differential`, `confirmed`, `refuted`,
      `entered-in-error`

    Output shape:
    `{"valid": true|false, "errors": ["..."], "resource_type": "Condition"}`

    ⚠️ Basic structural validation only. For production use, validate with the
    official HL7 FHIR Validator or Taiwan TWCore IG validator.

    Args:
        condition_json: JSON string of a FHIR R4 Condition resource.
                        Use `query_fhir_condition` to generate one first.
    """
    if fhir_condition_service is None:
        return _svc_unavailable("FHIR Condition Service")
    try:
        condition = json.loads(condition_json)
        result = fhir_condition_service.validate_condition(condition)
        return fhir_condition_service.to_json_string(result, indent=2)
    except json.JSONDecodeError as e:
        return _json_error(
            f"Invalid JSON: {e}", valid=False, errors=[f"Invalid JSON: {e}"]
        )


# ============================================================
# Group 6: Lab / LOINC
# ============================================================


@audited("search_loinc")
async def search_loinc(
    mode: Literal["code", "category", "specimen", "component"] = "code",
    keyword: str = "",
    category: str | None = None,
    limit: int = 3,
) -> str:
    """
    Discover LOINC codes and categories with mode-specific search behavior.

    Mode reference:
    - `code` (default): search by test name, abbreviation, or analyte keyword.
      Uses hybrid BM25 + semantic embedding re-ranking. Optional `category`
      parameter narrows to a LOINC class (e.g. `"CHEM"`, `"HEM/BC"`, `"UA"`).
      Examples: keyword `"HbA1c"`, `"Glucose Serum"`, `"ALT"`, `"血紅素"`.
    - `category`: list or filter LOINC categories from the local dataset.
      Without `keyword` → returns all categories with counts.
      With `keyword` → client-side filters the category list (case-insensitive
      substring match; no embedding). Useful for finding valid class codes to
      pass back as `category` in `code` mode.
    - `specimen`: search by specimen/system type. Hybrid BM25 + embedding.
      Examples: keyword `"Urine"`, `"Serum"`, `"血清/血漿"`, `"CSF"`.
    - `component`: search by analyte/component (the thing measured). Hybrid
      BM25 + embedding. Examples: `"glucose"`, `"creatinine"`, `"hemoglobin"`.

    Output shapes:
    - `category` mode: `{"mode", "keyword", "total_found", "categories": [...]}`
    - other modes: ranked list of LOINC records `[{loinc_code, long_common_name,
      component, system, method_type, scale_type, class, ...}]`

    Keyword is required for `code`, `specimen`, and `component` modes.
    For `category` mode, omitting `keyword` returns all categories.

    Args:
        mode: `"code"` | `"category"` | `"specimen"` | `"component"`.
        keyword: Query text. Required for `code`, `specimen`, `component` modes.
                 Optional filter for `category` mode.
        category: LOINC class code filter (only for `mode="code"`).
                  Examples: `"CHEM"`, `"HEM/BC"`, `"UA"`, `"MICRO"`.
        limit: Max results (default 3, max 10). Ignored for `category` when
               `keyword` is empty (returns all categories).
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")

    limit = min(max(1, limit), 10)

    if mode == "category":
        raw = await lab_service.list_categories()
        if not keyword:
            return raw
        try:
            parsed = json.loads(raw)
        except Exception:
            return raw
        categories = parsed.get("categories") or []
        filtered = [
            c for c in categories if keyword.lower() in str(c).lower()
        ][:limit]
        return json.dumps(
            {
                "mode": "category",
                "keyword": keyword,
                "total_found": len(filtered),
                "categories": filtered,
            },
            ensure_ascii=False,
        )

    if not keyword:
        return json.dumps(
            {
                "error": f"keyword is required for mode={mode}",
                "mode": mode,
            },
            ensure_ascii=False,
        )

    if mode == "code":
        return await lab_service.search_loinc_code(keyword, category, limit=limit)
    if mode == "specimen":
        return await lab_service.search_by_specimen(keyword, limit=limit)
    if mode == "component":
        return await lab_service.find_related_tests(keyword, limit=limit)

    return json.dumps(
        {"error": f"Unsupported mode: {mode}"},
        ensure_ascii=False,
    )


@audited("query_loinc")
async def query_loinc(
    mode: Literal["detail", "reference_range"] = "detail",
    loinc_code: str = "",
    age: int | None = None,
    gender: Literal["M", "F", "all"] = "all",
) -> str:
    """
    Look up a known LOINC code for full detail or age/gender-stratified reference range.

    Use this after you already know the LOINC code. For discovery, use `search_loinc`.

    Mode reference:
    - `detail` (default): returns full concept record including long common name,
      component, system, method type, scale type, LOINC class, and a patient-friendly
      description. Output: `{loinc_code, long_common_name, component, system,
      method_type, scale_type, class, patient_friendly_name, ...}`.
    - `reference_range`: returns the reference interval for the test stratified
      by `age` and `gender`. Requires both `loinc_code` and `age`.
      Output: `{loinc_code, age, gender, low, high, unit, interpretation_notes}`.
      Returns an error if no reference range data exists for the code.

    Args:
        mode: `"detail"` (default) | `"reference_range"`.
        loinc_code: LOINC code in `NNNNN-N` format, e.g. `"4548-4"` (HbA1c),
                    `"2345-7"` (Glucose), `"718-7"` (Hemoglobin), `"1558-6"`.
        age: Patient age in years. Required for `reference_range` mode.
        gender: `"M"` | `"F"` | `"all"` (default). Used in `reference_range` to
                select sex-specific intervals; ignored in `detail` mode.
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    if not loinc_code:
        return json.dumps({"error": "loinc_code is required"}, ensure_ascii=False)

    if mode == "detail":
        return await lab_service.get_patient_friendly_name(loinc_code)
    if mode == "reference_range":
        if age is None:
            return json.dumps(
                {"error": "age is required for mode=reference_range"},
                ensure_ascii=False,
            )
        return await lab_service.get_reference_range(loinc_code, age, gender)

    return json.dumps(
        {"error": f"Unsupported mode: {mode}"},
        ensure_ascii=False,
    )


@audited("interpret_lab_result")
async def interpret_lab_result(
    loinc_code: str, value: float, age: int, gender: Literal["M", "F", "all"] = "all"
) -> str:
    """
    Interpret one lab result against the applicable LOINC reference range.

    Looks up the age- and gender-stratified reference range for `loinc_code`,
    then compares `value` to it. Returns a structured interpretation with the
    range, the measured value, and a normal/high/low/critical flag.

    Output shape:
    `{loinc_code, value, unit, age, gender, reference_range: {low, high},
     interpretation: "normal"|"high"|"low"|"critical_high"|"critical_low",
     interpretation_note}`

    When to use: you have exactly one test result and want a fast readout.
    For a full panel, use `batch_interpret_lab_results` instead.
    To find LOINC codes, use `search_loinc`.

    ⚠️ Reference values are general guidance only. Final interpretation must
    always consider symptoms, medications, specimen context, and clinician review.

    Args:
        loinc_code: LOINC code in `NNNNN-N` format, e.g. `"4548-4"` (HbA1c),
                    `"2345-7"` (Glucose [Ser/Plas]), `"718-7"` (Hemoglobin),
                    `"1558-6"` (Fasting Glucose).
        value: Measured numeric result in the test's standard unit (e.g. mg/dL,
               g/dL, %).
        age: Patient age in years (integer).
        gender: `"M"` | `"F"` | `"all"` (default, gender-neutral range).
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.interpret_lab_result(loinc_code, value, age, gender)


@audited("batch_interpret_lab_results")
async def batch_interpret_lab_results(
    results_json: str, age: int, gender: Literal["M", "F", "all"] = "all"
) -> str:
    """
    Interpret a full panel of lab results against LOINC reference ranges in one call.

    Panel-level companion to `interpret_lab_result` — avoids repeated single-item
    calls for health checkup panels or EHR result feeds. Evaluates each item
    independently, then returns per-test interpretations and an abnormality summary.

    `results_json` must be a **JSON array** (not an object). Each element must
    have `loinc_code` (string) and `value` (number):
    ```json
    [
      {"loinc_code": "4548-4", "value": 7.2},
      {"loinc_code": "2345-7", "value": 126},
      {"loinc_code": "718-7",  "value": 13.5}
    ]
    ```
    Passing a JSON object or non-array returns an error without calling the service.

    Output shape:
    `{"total_tests", "abnormal_count", "results": [{loinc_code, value, unit,
     interpretation, reference_range: {low, high}}, ...],
     "abnormal_summary": [{loinc_code, interpretation}, ...]}`

    ⚠️ Reference values are general guidance. Final interpretation must be
    reviewed in clinical context with a licensed healthcare professional.

    Args:
        results_json: JSON array string of `{loinc_code, value}` objects (see above).
        age: Patient age in years (integer).
        gender: `"M"` | `"F"` | `"all"` (gender-neutral, default).
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    try:
        results = json.loads(results_json)
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"Invalid JSON: {e}"}, ensure_ascii=False)
    if not isinstance(results, list):
        return _json_error("results_json must be a JSON array of {loinc_code, value} objects")
    return await lab_service.batch_interpret_results(results, age, gender)


# ============================================================
# Group 9: Clinical Guidelines
# ============================================================


@audited("search_clinical_guideline")
async def search_clinical_guideline(keyword: str, limit: int = 3) -> str:
    """
    Search Taiwan clinical practice guidelines by disease name or ICD-10 code.

    Uses hybrid BM25 + semantic embedding ranking — cross-language matching works,
    e.g. `"高血壓"` surfaces hypertension guidelines and `"diabetes"` surfaces
    `"糖尿病"` guidelines. Results are ranked by relevance, not keyword-filtered;
    the tool always returns up to `limit` items even without an exact match.

    Use this tool to discover available guidelines and find the ICD code(s) used
    as keys. Then call `query_guideline(icd_code=..., section=...)` to retrieve
    the full content.

    Output shape:
    `{"keyword", "total_found", "guidelines": [{icd_code, disease_name_zh,
     disease_name_en, summary, has_medication, has_tests, has_goals, ...}, ...]}`

    Args:
        keyword: Disease name in Chinese or English, or ICD-10 code.
                 Examples: `"糖尿病"`, `"E11"`, `"高血壓"`, `"I10"`,
                 `"dyslipidaemia"`, `"E78"`, `"慢性腎臟病"`, `"N18"`.
        limit: Closest-matching guidelines to return (default 3, max 10).
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.search_guideline(keyword, limit=limit)
@audited("query_guideline")
async def query_guideline(
    icd_code: str,
    section: Literal["complete", "medication", "test", "goals", "pathway"] = "complete",
    patient_context_json: str | None = None,
) -> str:
    """
    Retrieve a specific section from a Taiwan clinical practice guideline.

    One stable tool for all guideline content — switch between sections by
    changing `section` without changing the tool name. Use `search_clinical_guideline`
    first to discover available ICD codes and confirm a guideline exists.

    Section reference:
    - `complete` (default): full guideline summary — disease overview, first-line
      and alternative medications, required tests, treatment goals, and pathway.
      Returns the most comprehensive view in one call.
    - `medication`: medication recommendations only — first-line agents,
      second-line/add-on therapy, and special population adjustments (renal,
      hepatic, elderly, pregnancy).
    - `test`: required and recommended diagnostic examinations, lab tests,
      imaging studies, and follow-up monitoring schedule.
    - `goals`: treatment targets and outcome goals, e.g. HbA1c < 7%, BP < 130/80,
      LDL-C < 100 mg/dL.
    - `pathway`: synthesized step-by-step clinical management pathway. Supports
      optional `patient_context_json` to personalize the recommendations.
      Example personalized pathway for a 65-year-old with CKD:
      `patient_context_json='{"age": 65, "comorbidities": ["CKD", "heart failure"]}'`

    Output: JSON object whose shape varies by section; always contains
    `icd_code` and `section` at the top level.

    Args:
        icd_code: Guideline ICD-10 key, e.g. `"E11"` (type 2 DM), `"I10"`
                  (hypertension), `"N18"` (CKD), `"E78"` (dyslipidaemia).
                  Use `search_clinical_guideline` to discover valid keys.
        section: `"complete"` | `"medication"` | `"test"` | `"goals"` | `"pathway"`.
        patient_context_json: Optional JSON object string providing patient context
                              for `section="pathway"` only. Ignored for other sections.
                              Supported keys: `age` (int), `gender` ("M"|"F"),
                              `comorbidities` (list of strings), `current_medications`
                              (list), `lab_values` (object). Any subset is valid.
                              Example: `'{"age": 70, "comorbidities": ["CKD stage 3"]}'`
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    section_map = {
        "complete": "get_complete_guideline",
        "medication": "get_medication_recommendations",
        "test": "get_test_recommendations",
        "goals": "get_treatment_goals",
        "pathway": "suggest_clinical_pathway",
    }
    method_name = section_map.get(section)
    if method_name is None:
        return _json_error(
            f"Unknown guideline section: {section}",
            allowed_sections=list(section_map),
        )
    if method_name == "suggest_clinical_pathway":
        context = None
        if patient_context_json:
            try:
                context = json.loads(patient_context_json)
            except json.JSONDecodeError:
                return _json_error("patient_context_json is not valid JSON")
        return await _call_service_json(guideline_service, method_name, icd_code, context)
    return await _call_service_json(guideline_service, method_name, icd_code)
# ============================================================
# Group 10: TWCore IG
# ============================================================
@audited("query_twcore_code")
async def query_twcore_code(
    category: (
        Literal["all", "medication", "diagnosis", "organization", "administrative"]
        | None
    ) = None,
    keyword: str | None = None,
    code: str | None = None,
    codesystem_ids: list[str] | None = None,
    codesystem_id: str | None = None,
) -> str:
    """
    Browse, search, or look up Taiwan TWCore IG CodeSystem entries.

    Three routing modes — the tool dispatches based on which parameters are provided:

    **List mode** (`category` only, no `keyword` or `code`):
    Returns all CodeSystems grouped under the given category.
    `category` values: `"all"`, `"medication"`, `"diagnosis"`,
    `"organization"`, `"administrative"`.
    Example: `query_twcore_code(category="medication")` → lists medication
    frequency, route, and dosage form codesystems.

    **Lookup mode** (`code` + `codesystem_id`):
    Returns the exact entry for one code within a specific CodeSystem.
    Requires both `code` and `codesystem_id` to be provided.
    Example: `query_twcore_code(code="QD", codesystem_id="medication-frequency-nhi-tw")`
    → returns `{code: "QD", display: "每日一次", system: "..."}`.

    **Search mode** (`keyword`, optionally + `codesystem_ids`):
    Full-text search for a code or display name across one or more CodeSystems.
    `codesystem_ids` narrows to specific systems; omit (or pass `null`) to
    search all CodeSystems.
    Example: `query_twcore_code(keyword="BID")` → searches across all systems.
    Example: `query_twcore_code(keyword="每日", codesystem_ids=["medication-frequency-nhi-tw"])`

    Routing priority (when multiple parameters are given):
    1. If `category` is set and `keyword`/`code` are both absent → list mode
    2. If `code` + `codesystem_id` are both set → lookup mode
    3. If `keyword` is set → search mode
    4. Otherwise → error

    Args:
        category: Category for list mode: `"all"` | `"medication"` | `"diagnosis"` |
                  `"organization"` | `"administrative"`.
        keyword: Search text for search mode (code abbreviation or display name).
        code: Exact code value for lookup mode (e.g. `"QD"`, `"PO"`, `"BID"`).
        codesystem_ids: List of CodeSystem IDs to restrict search mode.
                        Omit to search all systems.
        codesystem_id: Single CodeSystem ID for lookup mode
                       (e.g. `"medication-frequency-nhi-tw"`).
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    if category is not None and keyword is None and code is None:
        return await twcore_service.list_codesystems(category)
    if code and codesystem_id:
        return await twcore_service.lookup_code(code, codesystem_id)
    if keyword:
        return await twcore_service.search_code(keyword, codesystem_ids)
    return _json_error(
        "Provide category, or either (code + codesystem_id) or (keyword + optional codesystem_ids)"
    )


# ============================================================
# Group 11: SNOMED CT
# ============================================================


@audited("search_snomed_concept")
async def search_snomed_concept(
    query: str,
    limit: int = 3,
    hierarchy_filter: int = None,
) -> str:
    """
    Search SNOMED CT International Edition (370,000+ active concepts) by English term.

    Uses hybrid BM25 + semantic embedding re-ranking — semantic matches surface
    even without exact keyword overlap. E.g. `"heart attack"` surfaces
    `"Myocardial infarction (disorder)"` (22298006).

    Results are ranked by relevance and always include up to `limit` items even
    without an exact match — treat results as the closest approximations, not
    confirmed matches. Each result contains `concept_id`, `fsn` (Fully Specified
    Name), `preferred_term`, `active`, and `hierarchy_tag` (the semantic tag in
    parentheses, e.g. `"disorder"`, `"procedure"`, `"substance"`).

    For full concept detail plus parent/child hierarchy, follow up with
    `query_snomed_concept(concept_id=...)`.

    Args:
        query: English clinical term — SNOMED uses English only.
               Examples: `"diabetes mellitus"`, `"myocardial infarction"`,
               `"hypertension"`, `"fracture of femur"`, `"appendectomy"`,
               `"metformin"`, `"insulin"`.
        limit: Closest-matching concepts to return (default 3, max 10).
        hierarchy_filter: Optional SNOMED concept ID to restrict results to one
                          semantic hierarchy. Common roots:
                          - `404684003` Clinical finding (disorder/finding)
                          - `71388002`  Procedure
                          - `373873005` Pharmaceutical/biologic product
                          - `123037004` Body structure
                          - `105590001` Substance
                          - `362981000` Qualifier value
                          Omit to search all hierarchies.
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    results = await snomed_service.search_concepts(
        query, min(limit, 10), hierarchy_filter
    )
    if isinstance(results, str):
        return results  # Already JSON string from cache
    return json.dumps(results, ensure_ascii=False, indent=2)
@audited("query_snomed_concept")
async def query_snomed_concept(
    concept_id: int,
    include_parents: bool = True,
    include_children: bool = True,
    parent_limit: int = 10,
    child_limit: int = 20,
) -> str:
    """
    Fetch a SNOMED CT concept with optional IS-A hierarchy expansion.

    The preferred SNOMED entry point when you want the concept record AND its
    surrounding tree in one call. Reduces multi-hop lookups for hierarchy
    navigation.

    Output shape:
    ```json
    {
      "concept_id": 73211009,
      "concept": {concept_id, fsn, preferred_term, active, definition_status, ...},
      "ancestor_count": 5,
      "ancestors": [{concept_id, fsn, preferred_term, depth}, ...],
      "children_count": 12,
      "children": [{concept_id, fsn, preferred_term}, ...]
    }
    ```
    Omit `ancestors`/`children` keys by setting the corresponding flag to false.

    Args:
        concept_id: SNOMED CT concept ID (integer).
                    Examples: `73211009` (Diabetes mellitus), `44054006` (Type 2 DM),
                    `22298006` (Myocardial infarction), `38341003` (Hypertension).
        include_parents: Include ancestor chain via IS-A relationships (default true).
                         Set false to skip ancestry lookup.
        include_children: Include direct child concepts (default true).
                          Set false to skip children lookup.
        parent_limit: Max ancestor depth to return (default 10, cap 20).
        child_limit: Max child concepts to return (default 20, cap 200).
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")

    concept = await snomed_service.get_concept(concept_id)
    if concept is None:
        return json.dumps(
            {"error": f"Concept {concept_id} not found"}, ensure_ascii=False
        )
    if isinstance(concept, str):
        concept = json.loads(concept)

    result: dict[str, object] = {"concept_id": concept_id, "concept": concept}
    if include_parents:
        parents = await snomed_service.get_ancestors(concept_id, min(parent_limit, 20))
        if isinstance(parents, str):
            parents = json.loads(parents)
        result["ancestor_count"] = len(parents)
        result["ancestors"] = parents
    if include_children:
        children = await snomed_service.get_children(concept_id, min(child_limit, 200))
        if isinstance(children, str):
            children = json.loads(children)
        result["children_count"] = len(children)
        result["children"] = children
    return json.dumps(result, ensure_ascii=False, indent=2)
@audited("get_snomed_relationships")
async def get_snomed_relationships(
    concept_id: int,
    relationship_type_id: int = None,
) -> str:
    """
    Get the clinical attribute relationships (non-IS-A) for a SNOMED CT concept.

    Returns SNOMED defining attributes — the relationships that encode the clinical
    meaning of a concept, excluding IS-A (parent/child) links. Results are grouped
    by relationship type with a human-readable label and list of target concepts.

    Examples of what this reveals:
    - `22298006` (Myocardial infarction):
      Finding site → `80891009` Heart structure,
      Associated morphology → `55641003` Infarct
    - `387517004` (Paracetamol):
      Has active ingredient → `387517004` Paracetamol substance,
      Has dose form → `385055001` Tablet

    Output shape:
    ```json
    {
      "concept_id": 22298006,
      "relationship_count": 3,
      "relationships": [
        {
          "type_id": 363698007,
          "type_label": "Finding site",
          "targets": [{concept_id, fsn, preferred_term}, ...]
        }
      ]
    }
    ```

    Args:
        concept_id: SNOMED CT concept ID (integer). Must be an active concept.
        relationship_type_id: Optional concept ID to filter to one relationship
                              type. Common type IDs:
                              - `363698007` Finding site
                              - `116676008` Associated morphology
                              - `246075003` Causative agent
                              - `127489000` Has active ingredient
                              - `411116001` Has dose form
                              - `42752001`  Due to
                              - `363704007` Procedure site
                              Omit to return all attribute types.
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    results = await snomed_service.get_relationships(concept_id, relationship_type_id)
    if isinstance(results, str):
        return results  # Already JSON string from cache
    return json.dumps(
        {
            "concept_id": concept_id,
            "relationship_count": sum(len(r["targets"]) for r in results),
            "relationships": results,
        },
        ensure_ascii=False,
        indent=2,
    )
@audited("query_snomed_mapping")
async def query_snomed_mapping(
    mode: Literal["icd", "snomed"] = "icd",
    keyword: str = "",
) -> str:
    """
    Map between ICD-10-CM codes and SNOMED CT concepts (bidirectional).

    Mode reference:
    - `icd` (default): treats `keyword` as an ICD-10-CM code and returns all
      mapped SNOMED concepts. Uses cross-map reference sets loaded from SNOMED CT
      RF2 data. Case-insensitive; `"e11.9"` and `"E11.9"` are equivalent.
      Output: `{"mode": "icd", "keyword": "E11.9", "snomed_concepts": [{
        concept_id, fsn, preferred_term, map_rule, map_priority}, ...]}`

    - `snomed`: maps a SNOMED concept to ICD-10 code(s). Accepts either:
      - **Numeric concept ID** (e.g. `"44054006"`): looked up directly.
      - **Text term** (e.g. `"type 2 diabetes"`): first searches for the best
        matching SNOMED concept (1 result), then maps that concept_id to ICD.
        Returns error if no SNOMED concept matches the text.
      Output: `{"mode": "snomed", "keyword": 44054006, "icd10_mappings": [{
        icd_code, icd_name, map_rule, map_priority}, ...]}`

    Mappings come from SNOMED CT ICD-10 map reference sets. A concept may have
    multiple mapped ICD codes (map_priority orders them).

    Args:
        mode: `"icd"` | `"snomed"`. Default `"icd"`.
        keyword: For `icd` mode — ICD-10-CM code, e.g. `"E11.9"`, `"I10"`,
                 `"N18.3"`.
                 For `snomed` mode — numeric SNOMED concept ID (e.g. `"44054006"`)
                 or English concept name (e.g. `"type 2 diabetes mellitus"`).
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    if mode == "icd":
        if not keyword:
            return _json_error("Provide keyword when mode is icd")
        results = await snomed_service.map_icd_to_snomed(keyword)
        return json.dumps(
            {"mode": "icd", "keyword": keyword.upper(), "snomed_concepts": results},
            ensure_ascii=False,
            indent=2,
        )
    if mode == "snomed":
        if not keyword:
            return _json_error("Provide keyword when mode is snomed")
        try:
            concept_id = int(keyword)
        except ValueError:
            if snomed_service is None:
                return _svc_unavailable("SNOMED CT")
            matches = await snomed_service.search_concepts(keyword, 1)
            if not matches:
                return _json_error(
                    "For mode=snomed, keyword must be a numeric concept_id or match a SNOMED concept"
                )
            concept_id = int(matches[0]["concept_id"])
        results = await snomed_service.map_snomed_to_icd(concept_id)
        return json.dumps(
            {"mode": "snomed", "keyword": concept_id, "icd10_mappings": results},
            ensure_ascii=False,
            indent=2,
        )
    return _json_error("Provide mode as icd or snomed")
# ============================================================
# Service → tool mapping (used by DynamicFastMCP for add/remove)
# health_check is always registered via @mcp.tool() and is excluded here.
# ============================================================

_TOOL_CATEGORY_MAP, _TOOL_EXAMPLES, _TOOL_SELECTOR_EXAMPLES, SERVICE_TOOLS = _build_tool_maps()
_STATUS_HTML = _build_status_html()
_STATUS_HTML_BYTES = _STATUS_HTML.encode("utf-8")


# ============================================================
# Entry point
# ============================================================

if __name__ == "__main__":
    if config.transport == "stdio":
        mcp.run(**config.get_run_kwargs())
    else:
        import uvicorn

        uvicorn.run(
            build_http_app(),
            host=config.host,
            port=config.port,
            log_level=config.log_level.lower(),
        )
