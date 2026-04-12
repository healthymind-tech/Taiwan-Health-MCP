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
from drug_interaction_service import DrugInteractionService
from drug_service import DrugService
from embedding_service import EmbeddingService
from fhir_condition_service import FHIRConditionService
from fhir_medication_service import FHIRMedicationService
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
drug_service: DrugService | None = None
health_food_service: HealthFoodService | None = None
food_nutrition_service: FoodNutritionService | None = None
fhir_condition_service: FHIRConditionService | None = None
fhir_medication_service: FHIRMedicationService | None = None
lab_service: LabService | None = None
guideline_service: ClinicalGuidelineService | None = None
twcore_service: TWCoreService | None = None
snomed_service: SNOMEDService | None = None
drug_interaction_service: DrugInteractionService | None = None

# FastMCP (streamable-http mode) runs the lifespan once per session, not per
# process.  Guard all one-time initialization behind a lock + flag so that
# the second session simply reuses the already-initialized resources.
_init_lock: asyncio.Lock | None = None  # created lazily inside async context
_initialized: bool = False
_db_stats_task: asyncio.Task | None = None
_dataset_status = DatasetStatusManager()


@asynccontextmanager
async def lifespan(server):
    global icd_service, drug_service, health_food_service, food_nutrition_service
    global fhir_condition_service, fhir_medication_service, lab_service, guideline_service, twcore_service
    global snomed_service, drug_interaction_service
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
                ("DrugService", lambda: DrugService(pool, embedding_svc)),
                ("HealthFoodService", lambda: HealthFoodService(pool, embedding_svc)),
                (
                    "FoodNutritionService",
                    lambda: FoodNutritionService(pool, embedding_svc),
                ),
                ("FHIRConditionService", lambda: FHIRConditionService(pool)),
                ("FHIRMedicationService", lambda: FHIRMedicationService(drug_service)),
                ("LabService", lambda: LabService(pool, embedding_svc)),
                (
                    "ClinicalGuidelineService",
                    lambda: ClinicalGuidelineService(pool, embedding_svc),
                ),
                ("TWCoreService", lambda: TWCoreService(pool)),
                ("SNOMEDService", lambda: SNOMEDService(pool, embedding_svc)),
                ("DrugInteractionService", lambda: DrugInteractionService(pool)),
            ]:
                try:
                    svc = factory()
                    await svc.initialize()
                    if name == "ICDService":
                        icd_service = svc
                    elif name == "DrugService":
                        drug_service = svc
                    elif name == "HealthFoodService":
                        health_food_service = svc
                    elif name == "FoodNutritionService":
                        food_nutrition_service = svc
                    elif name == "FHIRConditionService":
                        fhir_condition_service = svc
                    elif name == "FHIRMedicationService":
                        fhir_medication_service = svc
                    elif name == "LabService":
                        lab_service = svc
                    elif name == "ClinicalGuidelineService":
                        guideline_service = svc
                    elif name == "TWCoreService":
                        twcore_service = svc
                    elif name == "SNOMEDService":
                        snomed_service = svc
                    elif name == "DrugInteractionService":
                        drug_interaction_service = svc
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


def _empty_drug_result_item() -> dict:
    """Return the canonical result item shape for all search_drug modes."""
    return {
        "license_id": None,
        "name_zh": None,
        "name_en": None,
        "indication": None,
        "usage": None,
        "form": None,
        "package": None,
        "category": None,
        "manufacturer": None,
        "valid_date": None,
        "ingredients": [],
        "appearance": {},
        "atc": [],
        "rxnorm": [],
        "insert_url": None,
    }


def _normalize_atc_entries(entries: object) -> list[dict]:
    """Normalize ATC rows to [{atc_code, atc_name}]."""
    if not isinstance(entries, list):
        return []
    normalized: list[dict] = []
    seen: set[str] = set()
    for row in entries:
        if not isinstance(row, dict):
            continue
        code = row.get("atc_code") or row.get("code")
        name = row.get("atc_name") or row.get("name")
        if not code and not name:
            continue
        key = f"{code or ''}|{name or ''}"
        if key in seen:
            continue
        seen.add(key)
        normalized.append({"atc_code": code, "atc_name": name})
    return normalized


def _normalize_rxnorm_entries(entries: object) -> list[dict]:
    """Normalize RxNorm rows to [{rxcui, name, tty, atc_code}]."""
    if not isinstance(entries, list):
        return []
    normalized: list[dict] = []
    seen: set[str] = set()
    for row in entries:
        if not isinstance(row, dict):
            continue
        rxcui = row.get("rxcui")
        if not rxcui:
            continue
        name = row.get("name")
        tty = row.get("tty")
        atc_code = row.get("atc_code")
        key = f"{rxcui}|{atc_code or ''}"
        if key in seen:
            continue
        seen.add(key)
        normalized.append(
            {"rxcui": str(rxcui), "name": name, "tty": tty, "atc_code": atc_code}
        )
    return normalized


def _normalize_ingredient_entries(entries: object) -> list[dict]:
    """Normalize ingredient rows to a shared shape for all search_drug modes."""
    if not isinstance(entries, list):
        return []
    normalized: list[dict] = []
    for row in entries:
        if not isinstance(row, dict):
            continue
        name = row.get("ingredient_name") or row.get("name")
        qty = row.get("ingredient_qty")
        unit = row.get("ingredient_unit")
        rxcui = row.get("rxcui")
        tty = row.get("tty")
        if not any([name, qty, unit, rxcui, tty]):
            continue
        normalized.append(
            {
                "ingredient_name": name,
                "ingredient_qty": qty,
                "ingredient_unit": unit,
                "rxcui": str(rxcui) if rxcui else None,
                "tty": tty,
            }
        )
    return normalized


async def _load_rxnorm_by_atc_codes(atc_codes: list[str]) -> dict[str, list[dict]]:
    """Map ATC code -> RxNorm concept candidates."""
    codes = sorted({c.strip().upper() for c in atc_codes if isinstance(c, str) and c.strip()})
    if not codes:
        return {}
    try:
        pool = database.get_pool()
    except RuntimeError:
        return {}
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT m.atc_code, m.rxcui, c.name, c.tty
            FROM drug.rx_atc_map m
            LEFT JOIN drug.rx_concepts c ON c.rxcui = m.rxcui
            WHERE UPPER(m.atc_code) = ANY($1::text[])
            ORDER BY m.atc_code, m.rxcui
            """,
            codes,
        )
    by_code: dict[str, list[dict]] = {}
    for row in rows:
        code = (row["atc_code"] or "").upper()
        by_code.setdefault(code, []).append(
            {
                "rxcui": row["rxcui"],
                "name": row["name"],
                "tty": row["tty"],
                "atc_code": row["atc_code"],
            }
        )
    return by_code


async def _load_atc_by_rxcuis(rxcuis: list[str]) -> dict[str, list[dict]]:
    """Map RXCUI -> ATC rows."""
    keys = sorted({str(r).strip() for r in rxcuis if str(r).strip()})
    if not keys:
        return {}
    try:
        pool = database.get_pool()
    except RuntimeError:
        return {}
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT rxcui, atc_code, atc_name
            FROM drug.rx_atc_map
            WHERE rxcui = ANY($1::text[])
            ORDER BY rxcui, atc_code
            """,
            keys,
        )
    by_rxcui: dict[str, list[dict]] = {}
    for row in rows:
        by_rxcui.setdefault(row["rxcui"], []).append(
            {"atc_code": row["atc_code"], "atc_name": row["atc_name"]}
        )
    return by_rxcui


async def _normalize_drug_result_items(items: list[dict]) -> list[dict]:
    """Canonicalize result items and enrich FDA items with rxnorm mappings by ATC."""
    atc_codes: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        atc_rows = _normalize_atc_entries(item.get("atc"))
        atc_codes.extend(
            [row["atc_code"] for row in atc_rows if isinstance(row.get("atc_code"), str)]
        )
    rxnorm_by_atc = await _load_rxnorm_by_atc_codes(atc_codes)

    normalized: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out = _empty_drug_result_item()
        for key in (
            "license_id",
            "name_zh",
            "name_en",
            "indication",
            "usage",
            "form",
            "package",
            "category",
            "manufacturer",
            "valid_date",
            "insert_url",
        ):
            out[key] = item.get(key)

        out["ingredients"] = _normalize_ingredient_entries(item.get("ingredients"))
        out["appearance"] = item.get("appearance") if isinstance(item.get("appearance"), dict) else {}
        out["atc"] = _normalize_atc_entries(item.get("atc"))

        merged_rxnorm = _normalize_rxnorm_entries(item.get("rxnorm"))
        for atc_row in out["atc"]:
            code = (atc_row.get("atc_code") or "").upper()
            merged_rxnorm.extend(rxnorm_by_atc.get(code, []))
        out["rxnorm"] = _normalize_rxnorm_entries(merged_rxnorm)
        normalized.append(out)
    return normalized


async def _normalize_drug_mode_payload(raw_payload: object, mode: str, keyword: str) -> str:
    """Normalize FDA-backed mode payloads to the canonical result shape."""
    payload: object = raw_payload
    if isinstance(raw_payload, str):
        try:
            payload = json.loads(raw_payload)
        except json.JSONDecodeError:
            return raw_payload
    if not isinstance(payload, dict):
        return json.dumps(payload, ensure_ascii=False)

    payload["mode"] = mode
    payload["keyword"] = keyword
    results = payload.get("results")
    if isinstance(results, list):
        payload["results"] = await _normalize_drug_result_items(results)
    else:
        payload["results"] = []
    return json.dumps(payload, ensure_ascii=False)


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
that provides read-only access to Taiwan FDA, ICD-10, LOINC, SNOMED CT, RxNorm,
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
  <li>RxNorm — U.S. National Library of Medicine (public domain)</li>
  <li>Taiwan FDA drug, health food, and nutrition data — Taiwan FDA open data</li>
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
users. All 30 tools perform outbound database lookups against pre-loaded public
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
      structured, read-only access to Taiwan's medical, pharmaceutical, and
      clinical knowledge — 30 tools, production-grade, HIPAA-audited.
    </p>
    <div class="endpoint-box">
      <span class="label">MCP endpoint</span>
      <code>https://tw-health-mcp.healthymind-tech.com/mcp</code>
    </div>
    <div class="badge-row">
      <span class="badge">30 Tools</span>
      <span class="badge">ICD-10-CM 2025</span>
      <span class="badge">LOINC 2.80</span>
      <span class="badge">SNOMED CT</span>
      <span class="badge">RxNorm</span>
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
      SNOMED CT concept hierarchies, resolve drug names via RxNorm, search
      Taiwan FDA-approved drugs and health foods, access clinical practice
      guidelines, and generate FHIR R4-compliant resources — all through natural
      language conversation with Claude.
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
        <div class="icon">💊</div>
        <h3>Drug &amp; Pharmacy</h3>
        <p style="font-size:0.93rem;color:#555;">
          Taiwan FDA drug database (auto-synced every Tuesday) plus
          RxNorm terminology and drug interaction checking.
        </p>
        <ul>
          <li>Search by drug name, ingredient, or ATC class</li>
          <li>Pill identification by appearance features</li>
          <li>RxNorm concept resolution &amp; ingredient lookup</li>
          <li>Drug–drug interaction checking (RxNorm)</li>
          <li>FHIR Medication resource generation</li>
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
          <li>Condition &amp; Medication resource generation</li>
          <li>FHIR resource validation</li>
          <li>TWCore CodeSystem lookup &amp; search</li>
          <li>Diagnosis-to-FHIR one-step conversion</li>
          <li>Drug-to-FHIR one-step conversion</li>
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
        <td>RxNorm</td>
        <td>Full release — NLM (public domain)</td>
        <td>Static (data-loader)</td>
      </tr>
      <tr>
        <td>Taiwan FDA Drugs</td>
        <td>Open Data — Taiwan FDA</td>
        <td>Auto-sync every Tuesday 02:00 UTC</td>
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
      <div class="example-header">Example 3 — Drug identification &amp; interaction check</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "幫我查一顆白色橢圓形藥丸，上面印有 MET 500，並確認它和 Warfarin 有沒有交互作用"
        </div>
        <ol class="steps">
          <li>Server runs pill identification: white + oval + marking "MET 500"</li>
          <li>Returns top matches — likely Metformin 500 mg products with manufacturer details</li>
          <li>Resolves Metformin and Warfarin to RxNorm concepts</li>
          <li>Checks drug interaction database — no direct RxNorm interaction flagged for this pair</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 4 — FHIR resource generation</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "幫我把診斷 E11.9 和藥品 Metformin 500mg 轉成 TWCore FHIR 格式"
        </div>
        <ol class="steps">
          <li>Server calls <code>query_fhir_condition</code> for E11.9</li>
          <li>Generates TWCore-compliant FHIR Condition resource with ICD-10 coding</li>
          <li>Calls <code>query_fhir_medication</code> for Metformin</li>
          <li>Returns valid FHIR R4 JSON resources ready for EMR integration</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 5 — Nutrition analysis</div>
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
      All 30 tools are read-only. The server does not accept writes, does not
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
    "drug": {
        "category": "Drug",
        "tools": [
            (
                "search_drug",
                "search_drug",
                {"mode": "drug_name", "keyword": "Metformin", "limit": 5},
            ),
            (
                "search_drug",
                "search_drug",
                {"mode": "atc_code", "keyword": "A10BA02", "limit": 5},
            ),
            (
                "search_drug",
                "search_drug",
                {"mode": "ingredient", "keyword": "metformin", "limit": 5},
            ),
            (
                "search_drug",
                "search_drug",
                {"mode": "license_id", "keyword": "000029"},
            ),
            (
                "search_drug",
                "search_drug",
                {"mode": "rxnorm_resolve", "keyword": "atorvastatin", "limit": 5},
            ),
            (
                "search_drug",
                "search_drug",
                {"mode": "rxnorm_ingredients", "keyword": "41493"},
            ),
            (
                "search_drug",
                "search_drug",
                {
                    "mode": "interaction",
                    "drug_names": ["warfarin", "aspirin"],
                },
            ),
            (
                "identify_unknown_pill",
                "identify_unknown_pill",
                {"features": "white round"},
            ),
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
    "fhir_medication": {
        "category": "FHIR R4",
        "tools": [
            (
                "query_fhir_medication",
                "query_fhir_medication",
                {"keyword": "Metformin", "resource_type": "MedicationKnowledge"},
            ),
            (
                "validate_fhir_medication",
                "validate_fhir_medication",
                {
                    "medication_json": '{"resourceType":"Medication","code":{"coding":[{"system":"https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-fda-tw","code":"衛部藥製字第059686號","display":"Metformin 500mg"}]},"ingredient":[{"itemCodeableConcept":{"coding":[{"code":"metformin"}]},"strength":{"numerator":{"value":500,"unit":"mg"}}}]}'
                },
            ),
        ],
    },
    "twcore": {
        "category": "TWCore IG",
        "tools": [
            ("query_twcore_code", "query_twcore_code", {"category": "medication"}),
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
                "search_food_nutrition",
                "search_food_nutrition",
                {"food_name": "雞蛋", "nutrient": "粗蛋白"},
            ),
            ("get_detailed_nutrition", "get_detailed_nutrition", {"food_name": "白米"}),
            (
                "search_food_ingredient",
                "search_food_ingredient",
                {"keyword": "維生素C"},
            ),
            (
                "get_ingredients_by_category",
                "get_ingredients_by_category",
                {"category": "Omega-3脂肪酸"},
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

    const applyByField = () => {
      const v = el.value;
      const example = fieldMap[v];
      if (example) applyExample(toolName, example, true);
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

    This is the first tool to call before large workflows. It checks:
    - database connectivity (`database`)
    - cache connectivity (`cache`)
    - per-service dataset load state (`services.<service_name>`)

    Top-level `status` is:
    - `ok` when the database is reachable
    - `degraded` when the database check fails

    Reported service flags:
    `icd`, `drug`, `health_supplement`, `food_nutrition`, `fhir_condition`,
    `fhir_medication`, `lab`, `guideline`, `twcore`, `snomed`.

    Notes:
    - This tool is always available, even if some datasets are not loaded.
    - `services.<name> = false` means the related tool group is temporarily
      unavailable and should be retried after data/service recovery.
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
                "drug": drug_service is not None,
                "health_supplement": health_food_service is not None,
                "food_nutrition": food_nutrition_service is not None,
                "fhir_condition": fhir_condition_service is not None,
                "fhir_medication": fhir_medication_service is not None,
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

    Diagnosis search uses hybrid BM25 + semantic similarity (vector search) to
    return the top closest matching codes — not just exact keyword matches.
    For example, querying '糖尿病' also surfaces 'Type 2 diabetes mellitus'.
    Procedure search uses BM25 full-text only (no vector search).
    Data source: ICD-10-CM 2025 (NLM) and ICD-10-PCS 2025 (CMS).

    Output: returns the top `limit` results ranked by semantic similarity score,
    not keyword-filtered records. The tool always returns up to `limit` items
    even when no exact match exists — treat results as the closest approximations
    found in the database, not confirmed matches.

    Args:
        keyword: Search term — English name, Chinese name, or code prefix
                 (e.g., 'Diabetes', 'E11', '子宮內膜異位', '0DTJ').
        type: 'diagnosis' (ICD-10-CM only) | 'procedure' (ICD-10-PCS only)
              | 'all' (both, default).
        limit: Number of closest-matching results to return per type (default 3,
               max 10). Increase only when you need more candidate codes to review.
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.search_codes(keyword, type, limit=limit)


@audited("infer_complications")
async def infer_complications(code: str) -> str:
    """
    Explore the ICD-10-CM hierarchy for a diagnosis code or category prefix.

    Use this when you want to see how a diagnosis expands into more specific
    billable codes or what nearby variants exist in the same category. This is
    a hierarchy lookup, not AI-generated clinical inference.

    Behaviour depends on the input:
    - Broad category like `E11`: returns more-specific child codes that may act
      as candidate subcodes or finer-grained diagnoses.
    - Leaf code like `E11.9`: returns sibling or related codes in the same
      category when no children exist.
    - Other codes: follows the ICD tree and returns the most relevant branch.

    Args:
        code: ICD-10-CM code or category prefix (e.g., 'E11' for type 2 diabetes,
              'E11.9' for a leaf code, 'N80' for endometriosis). 3–7 characters.
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.infer_complications(code)


@audited("get_nearby_codes")
async def get_nearby_codes(code: str) -> str:
    """
    Retrieve ICD-10-CM entries immediately around a known diagnosis code.

    Use this when you already have a candidate code and need local taxonomy
    context (nearby variants, severity neighbors, or adjacent billable options)
    before final coding.

    Output behavior:
    - returns the target code plus nearby rows in ICD tabular ordering
    - neighbors are not semantic matches; they are ordering neighbors
    - useful for coder review workflows and UI "next/previous code" helpers

    Args:
        code: ICD-10-CM diagnosis code (for example `E11.9`, `I10`, `N18.4`).
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.get_nearby_codes(code)


@audited("check_medical_conflict")
async def check_medical_conflict(diagnosis_code: str, procedure_code: str) -> str:
    """
    Compare one diagnosis code and one procedure code in a structured payload.

    Use this for coding QA, claim pre-check, or LLM reasoning when a caller
    wants evidence for compatibility between a diagnosis and a procedure.
    The tool returns normalized metadata for both sides so downstream logic can
    evaluate anatomical alignment, intent, and likely plausibility.

    Important:
    - This tool returns facts/metadata, not a hard pass-fail verdict.
    - Final adjudication should be done by rule logic or clinical review.

    Args:
        diagnosis_code: ICD-10-CM diagnosis code (for example `K35.80`, `E11.9`).
        procedure_code: ICD-10-PCS procedure code (for example `0DTJ0ZZ`).
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
    known yet. Typical flow:
    1) call without `category` to inspect major ICD groupings
    2) call with a 3-character category to expand into specific codes

    Output behavior:
    - `category=None`: chapter/category listing for navigation
    - `category='E11'` style input: codes under that diagnosis family

    Args:
        category: Optional 3-character ICD category such as `E11`, `I10`, `N80`.
            Leave empty to list top-level browse entries.
        limit: Maximum returned codes for category expansion (default 50, max 200).
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.browse_category(category, limit)


# ============================================================
# Group 2: Drug (Taiwan FDA)
# ============================================================


@audited("search_drug")
async def search_drug(
    mode: Literal[
        "drug_name",
        "atc_code",
        "ingredient",
        "license_id",
        "rxnorm_resolve",
        "rxnorm_ingredients",
        "interaction",
    ] = "drug_name",
    keyword: str = "",
    drug_names: list[str] | None = None,
    limit: int = 3,
) -> str:
    """
    Unified drug endpoint for Taiwan FDA product search + RxNorm terminology queries.

    Modes:
    - `drug_name`: Taiwan FDA drug name/indication search (hybrid BM25 + embedding)
    - `atc_code`: Taiwan FDA ATC code prefix search (code-only, no embedding)
    - `ingredient`: Taiwan FDA ingredient search (hybrid BM25 + embedding)
    - `license_id`: Taiwan FDA license lookup; supports full license or bare digits
    - `rxnorm_resolve`: resolve free-text drug name to RxNorm concepts (RXCUI)
    - `rxnorm_ingredients`: retrieve ingredient composition by RXCUI
    - `interaction`: check interactions among multiple drugs via RxNorm

    Response shape is unified across all modes:
    - top level: `mode`, `keyword`, `results`
    - every `results[]` item includes the same canonical keys:
      `license_id`, `name_zh`, `name_en`, `indication`, `usage`, `form`,
      `package`, `category`, `manufacturer`, `valid_date`, `ingredients`,
      `appearance`, `atc`, `rxnorm`, `insert_url`
    - `atc` is always a list of `{atc_code, atc_name}` (possibly empty)
    - `rxnorm` is always a list of `{rxcui, name, tty, atc_code}` (possibly empty)
    - `ingredients` is always a list of
      `{ingredient_name, ingredient_qty, ingredient_unit, rxcui, tty}`
      so FDA and RxNorm modes share one ingredient schema.

    Notes on enrichment:
    - FDA modes (`drug_name`, `atc_code`, `ingredient`, `license_id`) include
      full FDA detail fields and are enriched with `rxnorm` by ATC mapping.
    - RxNorm modes include `rxnorm` and mapped `atc` by RXCUI; FDA-specific
      fields remain `null` / empty where no product mapping exists.
    - `interaction` mode additionally returns top-level `interaction` summary.

    Args:
        mode: One of `drug_name`, `atc_code`, `ingredient`, `license_id`,
            `rxnorm_resolve`, `rxnorm_ingredients`, or `interaction`.
        keyword: Search term in Chinese or English. For `atc_code`, use an ATC
            code prefix such as `A10` or `A10BA02`. For `ingredient`, use a
            generic/INN ingredient name. For `license_id`, use a Taiwan FDA
            license number or bare digits such as `000029`. For
            `rxnorm_ingredients`, provide RXCUI. For `interaction`, this field
            is ignored.
        drug_names: Required only when `mode="interaction"`. Provide at least
            2 drug names, for example `["warfarin", "aspirin"]`.
        limit: Number of closest-matching results to return (default 3, max 10).
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    if mode == "drug_name":
        if not keyword:
            return _json_error("Provide keyword")
        raw = await drug_service.search_drug(keyword, limit=limit)
        return await _normalize_drug_mode_payload(raw, "drug_name", keyword)
    if mode == "atc_code":
        import re

        if not keyword:
            return _json_error("Provide keyword")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,6}", keyword):
            return _json_error(
                "ATC code mode accepts ATC code prefixes only (e.g. A10, A10BA02)."
            )
        raw = await drug_service.search_by_atc(keyword, limit=limit)
        return await _normalize_drug_mode_payload(raw, "atc_code", keyword)
    if mode == "ingredient":
        if not keyword:
            return _json_error("Provide keyword")
        raw = await drug_service.search_by_ingredient(keyword, limit=limit)
        return await _normalize_drug_mode_payload(raw, "ingredient", keyword)
    if mode == "license_id":
        if not keyword:
            return _json_error("Provide keyword")
        raw = await drug_service.search_by_license_id(keyword)
        return await _normalize_drug_mode_payload(raw, "license_id", keyword)
    if drug_interaction_service is None:
        return _svc_unavailable("Drug Service")
    if mode == "rxnorm_resolve":
        if not keyword:
            return _json_error("Provide keyword")
        resolved = await drug_interaction_service.resolve_drug(keyword)
        if isinstance(resolved, str):
            try:
                resolved = json.loads(resolved)
            except json.JSONDecodeError:
                resolved = []
        if not isinstance(resolved, list):
            resolved = []

        all_rxcuis = [str(r.get("rxcui")) for r in resolved if isinstance(r, dict) and r.get("rxcui")]
        atc_by_rxcui = await _load_atc_by_rxcuis(all_rxcuis)

        # Bridge to TFDA: find Taiwan FDA drugs via ATC codes from IN/PIN concepts.
        # Prefer ingredient-level concepts for ATC lookup (most specific mapping).
        in_rxcuis = [
            str(r.get("rxcui")) for r in resolved
            if isinstance(r, dict) and r.get("rxcui") and r.get("tty") in ("IN", "PIN", "MIN")
        ] or all_rxcuis[:3]
        atc_codes = sorted({
            row["atc_code"]
            for rxcui in in_rxcuis
            for row in atc_by_rxcui.get(rxcui, [])
            if isinstance(row, dict) and row.get("atc_code")
        })
        if atc_codes and drug_service is not None:
            raw = await drug_service.search_by_atc_codes(atc_codes, limit=limit)
            return await _normalize_drug_mode_payload(raw, "rxnorm_resolve", keyword)

        # Fallback: no TFDA match — return RxNorm-only items (capped at limit)
        items: list[dict] = []
        for concept in resolved[:limit]:
            if not isinstance(concept, dict):
                continue
            rxcui = str(concept.get("rxcui") or "").strip()
            row = _empty_drug_result_item()
            row["name_en"] = concept.get("name")
            row["atc"] = atc_by_rxcui.get(rxcui, [])
            row["rxnorm"] = _normalize_rxnorm_entries(
                [{"rxcui": rxcui, "name": concept.get("name"), "tty": concept.get("tty")}]
            )
            items.append(row)
        return json.dumps(
            {"mode": "rxnorm_resolve", "keyword": keyword, "results": items},
            ensure_ascii=False,
        )
    if mode == "rxnorm_ingredients":
        if not keyword:
            return _json_error("Provide keyword")
        payload = await drug_interaction_service.get_drug_ingredients(keyword)
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                payload = None
        if not isinstance(payload, dict):
            return json.dumps(
                {"mode": "rxnorm_ingredients", "keyword": keyword, "results": []},
                ensure_ascii=False,
            )
        rxcui = str(payload.get("rxcui") or "").strip()
        ingredients = payload.get("ingredients")

        # Collect RXCUIs for ATC lookup: concept itself + its ingredient children.
        # ATC is typically assigned at IN level, so ingredient RXCUIs are preferred.
        all_rxcuis = [rxcui] if rxcui else []
        if isinstance(ingredients, list):
            all_rxcuis += [
                str(ing.get("rxcui"))
                for ing in ingredients
                if isinstance(ing, dict) and ing.get("rxcui")
            ]
        atc_by_rxcui = await _load_atc_by_rxcuis(all_rxcuis)
        atc_codes = sorted({
            row["atc_code"]
            for rows in atc_by_rxcui.values()
            for row in rows
            if isinstance(row, dict) and row.get("atc_code")
        })

        # Bridge to TFDA: return Taiwan FDA drug records when ATC codes are available.
        if atc_codes and drug_service is not None:
            raw = await drug_service.search_by_atc_codes(atc_codes, limit=limit)
            return await _normalize_drug_mode_payload(raw, "rxnorm_ingredients", keyword)

        # Fallback: no TFDA match — return RxNorm-only result
        row = _empty_drug_result_item()
        row["name_en"] = payload.get("name")
        row["atc"] = atc_by_rxcui.get(rxcui, [])
        row["rxnorm"] = _normalize_rxnorm_entries(
            [{"rxcui": rxcui, "name": payload.get("name"), "tty": payload.get("tty")}]
        )
        if isinstance(ingredients, list):
            row["ingredients"] = _normalize_ingredient_entries(
                [
                    {
                        "ingredient_name": ing.get("name") if isinstance(ing, dict) else None,
                        "ingredient_qty": None,
                        "ingredient_unit": None,
                        "rxcui": ing.get("rxcui") if isinstance(ing, dict) else None,
                        "tty": ing.get("tty") if isinstance(ing, dict) else None,
                    }
                    for ing in ingredients
                ]
            )
        return json.dumps(
            {"mode": "rxnorm_ingredients", "keyword": keyword, "results": [row]},
            ensure_ascii=False,
        )
    if mode == "interaction":
        if not drug_names or len(drug_names) < 2:
            return _json_error(
                "Provide drug_names with at least 2 drug names when mode is interaction"
            )
        result = await drug_interaction_service.check_interactions(drug_names)
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except json.JSONDecodeError:
                result = {"error": "Invalid cached interaction payload"}
        if not isinstance(result, dict):
            result = {"error": "Invalid interaction payload"}
        resolved = result.get("resolved_drugs")
        if not isinstance(resolved, list):
            resolved = []
        rxcuis = [
            str(item.get("rxcui"))
            for item in resolved
            if isinstance(item, dict) and item.get("rxcui")
        ]
        atc_by_rxcui = await _load_atc_by_rxcuis(rxcuis)
        items: list[dict] = []
        for item in resolved:
            if not isinstance(item, dict):
                continue
            rxcui = str(item.get("rxcui") or "").strip()
            row = _empty_drug_result_item()
            row["name_en"] = item.get("name")
            row["atc"] = atc_by_rxcui.get(rxcui, [])
            row["rxnorm"] = _normalize_rxnorm_entries(
                [
                    {
                        "rxcui": rxcui,
                        "name": item.get("name"),
                        "tty": item.get("tty"),
                    }
                ]
            )
            items.append(row)
        return json.dumps(
            {
                "mode": "interaction",
                "keyword": "",
                "results": items,
                "interaction": {
                    "interaction_count": result.get("interaction_count", 0),
                    "interactions": result.get("interactions", []),
                    "resolved_drugs": resolved,
                    "unresolved_drugs": result.get("unresolved_drugs", []),
                },
            },
            ensure_ascii=False,
        )
    return _json_error(
        "Provide mode as drug_name, atc_code, ingredient, license_id, "
        "rxnorm_resolve, rxnorm_ingredients, or interaction"
    )


@audited("search_drug_info")
async def search_drug_info(keyword: str, limit: int = 3) -> str:
    """
    Search Taiwan FDA approved drugs (66,000+ licenses) by name or indication.

    Searches across Chinese trade name, English trade name, generic ingredient name,
    and indication fields using hybrid BM25 + semantic similarity (vector search).
    Use `search_drug(mode="license_id", keyword=...)` to retrieve full information
    for a specific license.
    Data source: Taiwan FDA open data.

    Output: returns the top `limit` results ranked by semantic similarity score,
    not keyword-filtered records. Results are the closest matches in the database —
    they may be semantically related even when the exact term is absent.

    Args:
        keyword: Drug trade name, generic name, or indication in Chinese or English
                 (e.g., 'Panadol', '普拿疼', 'aspirin', '阿斯匹林', 'hypertension').
        limit: Number of closest-matching results to return (default 3, max 10).
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.search_drug(keyword, limit=limit)


@audited("identify_unknown_pill")
async def identify_unknown_pill(features: str) -> str:
    """
    Identify a Taiwan FDA drug by pill appearance (color, shape, imprint markings).

    Searches the appearance fields (shape, color, marking) in the Taiwan FDA drug
    database. All keywords must match (AND logic) — more keywords = narrower results.
    The service expands common English descriptors (`white`, `round`, `oval`, etc.)
    into Chinese synonyms used in FDA appearance data. If an imprint-like token with
    digits causes zero matches (for example `M500`), the service retries once with
    digit-containing tokens removed.
    Returns up to 5 matching drugs with license ID, trade name, and appearance
    description.

    ⚠️ For reference only — always confirm pill identity with a licensed pharmacist.

    Args:
        features: Space-separated appearance keywords in Chinese or English
                  (e.g., '白 圓形', '橙色 橢圓', 'white round',
                   '粉紅 菱形 PFIZER'). Each keyword is matched against shape,
                  color, and marking fields independently.
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.identify_pill(features)


# ============================================================
# Group 3: Health Supplement (Taiwan FDA)
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
    Search Taiwan FDA health supplements using a single unified entry point.

    `keyword` mode searches product names, companies, ingredients, and
    approved benefit claims. `permit_no` mode looks up a permit number and
    supports bare digits such as `A00022` or `000029`. `condition` mode maps a
    disease keyword / ICD code to recommended benefits and returns matching
    certified products. All result items share the same item schema.

    The top-level response always has the same shape:
    `{"mode", "keyword", "results"}` for `keyword` and `permit_no` mode.
    In `condition` mode, top-level fields additionally include
    `icd_code` and `recommended_benefits`.
    Each result is detail-shaped and includes `permit_no`, `product_name`,
    `company`, `benefits`, `ingredients`, `specs`, `status`, `source_url`.

    Embedding behavior:
    - `keyword`: hybrid BM25 + embedding ranking
    - `permit_no`: exact or digit-assisted permit lookup (no embedding)
    - `condition`: ICD/benefit mapping + product retrieval (no embedding ranking)
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


@audited("search_food_nutrition")
async def search_food_nutrition(
    food_name: str, nutrient: str | None = None, limit: int = 3
) -> str:
    """
    Search Taiwan FDA food composition database for nutritional content per 100 g.

    Uses hybrid BM25 + semantic similarity (vector search) to find the closest
    matching foods — e.g., querying '白米' may surface '蓬萊米' or '米飯'.
    Data source: Taiwan FDA Food Composition Database.

    Output: returns the top `limit` food variants ranked by semantic similarity
    score, not keyword-filtered records. Results are the closest food names found
    in the database even when an exact entry does not exist.

    Args:
        food_name: Food name in Chinese or English (e.g., '白米', '雞蛋', '豆腐',
                   'chicken breast', 'salmon').
        nutrient: Optional nutrient name to filter results. Accepts partial names
                  and Taiwan FDA convention (e.g., '粗蛋白', '蛋白', '鈣', '維生素C',
                  '膳食纖維'). Returns all nutrients if omitted.
        limit: Number of closest-matching food variants to return (default 3, max 10).
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_nutrition(
        food_name, nutrient, limit=limit
    )


@audited("get_detailed_nutrition")
async def get_detailed_nutrition(food_name: str) -> str:
    """
    Return the full nutrient panel for one food name from Taiwan composition data.

    This tool is designed for deep per-item inspection, not top-N retrieval.
    It performs partial-name matching (`ILIKE`) and may return multiple variants
    when the keyword is broad (for example `鮭魚` can match multiple salmon rows).

    Output includes broad nutrient families such as:
    - energy/water/macronutrients
    - vitamins (A/B/C/D/E/K, folate, niacin)
    - minerals (Ca, P, Fe, Na, K, Mg, Zn, Mn, Cu, Se, I)
    - fatty acids (including EPA/DHA when present), cholesterol, trans fats

    Args:
        food_name: Food name or partial food name in Chinese, such as `糙米`,
            `雞胸`, `全脂牛奶`, `鮭魚`.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.get_detailed_nutrition(food_name)


@audited("search_food_ingredient")
async def search_food_ingredient(keyword: str, limit: int = 3) -> str:
    """
    Search Taiwan FDA food ingredient classification database by ingredient name.

    Uses hybrid BM25 + semantic similarity (vector search) to return the top
    closest matching ingredients — not just exact keyword matches. Returns
    ingredient category, permitted uses, and regulatory status.
    Data covers additives, natural ingredients, flavourings, and processing aids
    as classified by Taiwan FDA.

    Args:
        keyword: Ingredient name in Chinese or English (e.g., '薑黃', 'turmeric',
                 '卡拉膠', 'carrageenan', '山梨酸', 'sorbic acid').
        limit: Number of closest-matching results to return (default 3, max 10).

    Output: returns the top `limit` results ranked by semantic similarity score,
    not keyword-filtered records. The tool always returns up to `limit` items
    even when no exact match exists — treat results as the closest approximations
    found in the database, not confirmed matches.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_food_ingredient(keyword, limit=limit)


@audited("get_ingredients_by_category")
async def get_ingredients_by_category(category: str) -> str:
    """
    List all registered ingredients under one Taiwan FDA ingredient category.

    Use this for category-level regulatory review (for example listing all
    ingredients under additives or flavor-plant classes). If category is not
    known, call `search_food_ingredient` first to discover valid names.

    Output behavior:
    - returns entries only from the specified category
    - no semantic ranking is applied in this endpoint

    Args:
        category: Exact category string used in the source dataset, such as
            `香料植物及其製品`, `食品添加物`, `水產品`, `穀類及其製品`.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.get_ingredients_by_category(category)


@audited("search_foods_by_nutrient")
async def search_foods_by_nutrient(nutrient: str, limit: int = 20) -> str:
    """
    Find foods ranked by content of a specific nutrient (highest first, per 100 g),
    from Taiwan's food composition database.

    Accepts common synonyms via a built-in alias map — e.g., '蛋白質' → '粗蛋白',
    '維他命C' → '維生素C', 'protein' → '粗蛋白', 'calcium' → '鈣', 'fat' → '粗脂肪'.
    Falls back to partial ILIKE matching and then semantic embedding if no alias match.
    Results are sorted by nutrient content descending (highest content first).

    Args:
        nutrient: Nutrient name in Chinese or English — aliases and common synonyms
                  are accepted (e.g., '粗蛋白', '蛋白質', 'protein', '鈣', 'calcium',
                  '維生素C', '維他命C', 'vitamin c', '膳食纖維', 'fiber', 'EPA', 'DHA').
        limit: Number of foods to return (default 20, max 50).
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_foods_by_nutrient(nutrient, limit)


@audited("analyze_meal_nutrition")
async def analyze_meal_nutrition(foods: list[str]) -> str:
    """
    Aggregate nutrition for a meal from multiple foods (100 g assumed per item).

    This is the meal-level companion to `get_detailed_nutrition`.
    The tool resolves each food name, then sums nutrient values across all items.
    It returns both per-item details and total meal values.

    Important assumption:
    - each listed food is treated as 100 g
    - callers should rescale totals if real serving sizes differ

    Args:
        foods: List of food names such as `['白米飯', '雞胸肉', '青花菜', '豆腐']`.
            Partial names are accepted where matching rows exist.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.analyze_meal_nutrition(foods)


# ============================================================
# Group 5: FHIR Condition
# ============================================================


@audited("create_fhir_condition")
async def create_fhir_condition(
    icd_code: str,
    patient_id: str,
    clinical_status: Literal["active", "inactive", "resolved", "remission"] = "active",
    verification_status: Literal[
        "confirmed", "provisional", "differential", "refuted"
    ] = "confirmed",
    category: Literal[
        "encounter-diagnosis", "problem-list-item"
    ] = "encounter-diagnosis",
    severity: str = None,
    onset_date: str = None,
    recorded_date: str = None,
    additional_notes: str = None,
) -> str:
    """
    Build a FHIR R4 Condition resource from an ICD-10-CM code.

    Looks up the ICD-10-CM code description and constructs a valid FHIR R4
    Condition JSON resource. The resource includes the TWCore IG profile reference
    and uses the Taiwan FHIR coding system. Does not persist to any FHIR server —
    returns the resource JSON for downstream use.

    Args:
        icd_code: ICD-10-CM diagnosis code (e.g., 'E11.9' for type 2 diabetes
                  without complications).
        patient_id: Patient reference identifier (e.g., 'patient-001').
        clinical_status: 'active' | 'inactive' | 'resolved' | 'remission'
                         (default: 'active').
        verification_status: 'confirmed' | 'provisional' | 'differential'
                             | 'refuted' (default: 'confirmed').
        category: 'encounter-diagnosis' | 'problem-list-item'
                  (default: 'encounter-diagnosis').
        severity: 'mild' | 'moderate' | 'severe' (optional).
        onset_date: Date of onset in YYYY-MM-DD format (optional).
        recorded_date: Recording timestamp in YYYY-MM-DDTHH:MM:SS+08:00 (optional).
        additional_notes: Free-text clinical note to attach (optional).
    """
    if fhir_condition_service is None:
        return _svc_unavailable("FHIR Condition Service")
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


@audited("create_fhir_condition_from_diagnosis")
async def create_fhir_condition_from_diagnosis(
    diagnosis_keyword: str,
    patient_id: str,
    clinical_status: Literal["active", "inactive", "resolved", "remission"] = "active",
    verification_status: Literal[
        "confirmed", "provisional", "differential", "refuted"
    ] = "confirmed",
    severity: str | None = None,
) -> str:
    """
    Search by disease keyword and auto-create a FHIR R4 Condition resource.

    Searches the ICD-10-CM database for the best-matching code, then builds
    a FHIR R4 Condition resource using that code. Use create_fhir_condition
    if you already have the exact ICD-10-CM code.
    Does not persist to any FHIR server — returns the resource JSON.

    Args:
        diagnosis_keyword: Disease name in Chinese or English
                           (e.g., '第二型糖尿病', 'Diabetes mellitus type 2',
                            '高血壓', 'hypertension').
        patient_id: Patient reference identifier (e.g., 'patient-001').
        clinical_status: 'active' | 'inactive' | 'resolved' | 'remission'
                         (default: 'active').
        verification_status: 'confirmed' | 'provisional' | 'differential'
                             | 'refuted' (default: 'confirmed').
        severity: 'mild' | 'moderate' | 'severe' (optional).
    """
    if fhir_condition_service is None:
        return _svc_unavailable("FHIR Condition Service")
    return await _call_service_json(
        fhir_condition_service,
        "create_condition_from_search",
        keyword=diagnosis_keyword,
        patient_id=patient_id,
        clinical_status=clinical_status,
        verification_status=verification_status,
        severity=severity,
    )


@audited("create_fhir_condition_query")
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
    Unified FHIR Condition entry point.

    Use this when you want a FHIR R4 Condition resource from either an exact
    ICD-10-CM code or a diagnosis keyword. If `diagnosis_keyword` is provided,
    the tool searches the ICD service first and then builds the Condition from
    the best match. If `icd_code` is provided, it builds the Condition directly.

    Args:
        icd_code: Exact ICD-10-CM diagnosis code, such as 'E11.9' or 'I10'.
        diagnosis_keyword: Diagnosis name or keyword in Chinese or English,
            such as '第二型糖尿病', 'diabetes mellitus', or '高血壓'.
        patient_id: Patient identifier to place in Condition.subject.reference.
        clinical_status: FHIR clinical status. Common values include active,
            inactive, resolved, and remission.
        verification_status: FHIR verification status. Common values include
            confirmed, provisional, differential, and refuted.
        category: FHIR Condition category. Use 'encounter-diagnosis' for a
            visit diagnosis or 'problem-list-item' for a persistent problem.
        severity: Optional severity label such as mild, moderate, or severe.
        onset_date: Optional onset date in YYYY-MM-DD.
        recorded_date: Optional timestamp in YYYY-MM-DDTHH:MM:SS+08:00.
        additional_notes: Optional clinical note to attach to the resource.
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

    Checks for the presence and format of required fields (resourceType, subject,
    code with ICD-10-CM coding, clinicalStatus, verificationStatus) and validates
    status values against allowed value-sets. Returns a validation result with
    a list of errors if any.

    ⚠️ This is a basic structural validation only. For production use, validate
    with the official HL7 FHIR Validator or Taiwan TWCore IG validator.

    Args:
        condition_json: JSON string of the FHIR R4 Condition resource to validate.
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
# Group 7: FHIR Medication
# ============================================================


@audited("search_medication_fhir")
async def search_medication_fhir(
    keyword: str, resource_type: str = "Medication"
) -> str:
    """
    Search Taiwan FDA drugs by name and return a FHIR R4 Medication resource.

    Uses hybrid BM25 + semantic similarity to find the closest-matching drug,
    then builds a FHIR resource for that top result. Use create_fhir_medication
    if you already have the exact license ID. Does not persist to any FHIR server.

    Args:
        keyword: Drug name in Chinese or English (e.g., 'Metformin', '二甲雙胍',
                 '普拿疼', 'atorvastatin').
        resource_type: 'Medication' (basic — code, form, ingredient) |
                       'MedicationKnowledge' (extended — adds ATC class,
                       dosage instructions, indications).
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    return await _call_service_json(
        fhir_medication_service,
        "create_medication_from_search",
        keyword,
        resource_type,
    )


@audited("create_fhir_medication")
async def create_fhir_medication(license_id: str) -> str:
    """
    Build a FHIR R4 `Medication` resource from an exact Taiwan FDA license ID.

    Choose this when you need a compact medication object (identity, coding,
    dosage form, ingredients) without expanded knowledge sections.

    Output behavior:
    - returns one FHIR JSON object with `resourceType = Medication`
    - does not persist to an external FHIR server
    - returns service error payload when license is missing or unresolved

    Recommended flow:
    1) call `search_drug(mode="license_id", ...)` to confirm license
    2) pass returned `license_id` here for deterministic resource generation

    Args:
        license_id: Taiwan FDA license string, typically from
            `search_drug(mode="license_id", keyword=...)`, for example
            `衛部藥製字第059686號`.
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    return await _call_service_json(
        fhir_medication_service, "create_medication", license_id
    )


@audited("create_fhir_medication_knowledge")
async def create_fhir_medication_from_drug(license_id: str) -> str:
    """
    Build a FHIR R4 `MedicationKnowledge` resource from one license ID.

    Choose this when you need richer structured drug knowledge such as ATC,
    route/form context, indications, cautions, and storage/manufacturer detail.

    Output behavior:
    - returns one FHIR JSON object with `resourceType = MedicationKnowledge`
    - does not persist to an external FHIR server
    - returns service error payload when license is missing or unresolved

    Recommended flow:
    1) use `search_drug` to choose an exact license
    2) call this tool for full knowledge-level resource output

    Args:
        license_id: Taiwan FDA license string from `search_drug` output, such as
            `衛部藥製字第059686號`.
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    return await _call_service_json(
        fhir_medication_service, "create_medication_knowledge", license_id
    )


@audited("create_fhir_medication_query")
async def query_fhir_medication(
    license_id: str | None = None,
    keyword: str | None = None,
    resource_type: Literal["Medication", "MedicationKnowledge"] = "Medication",
) -> str:
    """
    Unified entry point for FHIR medication resource generation.

    Request patterns:
    - `keyword` path: find best matching drug then generate resource
    - `license_id` path: generate resource directly from exact license

    `resource_type` controls response schema:
    - `Medication`: concise medication representation
    - `MedicationKnowledge`: richer product knowledge representation

    Output behavior:
    - always returns one FHIR resource JSON
    - no writeback to external FHIR endpoints

    Args:
        license_id: Exact Taiwan FDA license ID (optional when `keyword` used).
        keyword: Drug keyword in Chinese/English for lookup-first flow.
        resource_type: Target FHIR resource type (`Medication` or
            `MedicationKnowledge`).
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    if keyword:
        return await _call_service_json(
            fhir_medication_service,
            "create_medication_from_search",
            keyword,
            resource_type,
        )
    if not license_id:
        return _json_error("Provide either license_id or keyword")
    if resource_type == "MedicationKnowledge":
        return await _call_service_json(
            fhir_medication_service, "create_medication_knowledge", license_id
        )
    return await _call_service_json(
        fhir_medication_service, "create_medication", license_id
    )


@audited("validate_fhir_medication")
async def validate_fhir_medication(medication_json: str) -> str:
    """
    Validate structure and core field semantics of FHIR medication resources.

    Supported resource types:
    - `Medication`
    - `MedicationKnowledge`

    Validation focus:
    - required fields by resource type
    - code/coding structure sanity
    - ingredient block structure consistency

    Output behavior:
    - returns machine-readable validation result
    - includes error list when validation fails

    ⚠️ This is server-side structural validation, not full profile conformance.
    Use HL7/TWCore validator tooling for production-grade profile validation.

    Args:
        medication_json: Raw JSON string containing a FHIR Medication or
            MedicationKnowledge resource.
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    try:
        resource = json.loads(medication_json)
        result = fhir_medication_service.validate_medication(resource)
        return fhir_medication_service.to_json_string(result, indent=2)
    except json.JSONDecodeError as e:
        return _json_error(
            f"Invalid JSON: {e}", valid=False, errors=[f"Invalid JSON: {e}"]
        )


# ============================================================
# Group 8: Lab / LOINC
# ============================================================


@audited("search_loinc")
async def search_loinc(
    mode: Literal["code", "category", "specimen", "component"] = "code",
    keyword: str = "",
    category: str | None = None,
    limit: int = 3,
) -> str:
    """
    Unified LOINC discovery tool with mode-specific search behavior.

    Mode guide:
    - `code`: search by test name, abbreviation, or analyte keyword
    - `category`: browse/list LOINC category names from local dataset
    - `specimen`: search by specimen type (for example urine, serum/plasma)
    - `component`: search by analyte/component (for example glucose, creatinine)

    Embedding usage:
    - `code`, `specimen`, `component`: BM25 + embedding ranking
    - `category`: category listing/filter only (no embedding ranking)

    Response patterns:
    - `category`: returns category list payload (`categories`, `total_found`)
    - other modes: returns ranked matching test records from Lab service

    Args:
        mode: One of `code`, `category`, `specimen`, `component`.
        keyword: Query text. Required for all modes except `category`.
            Examples: `HbA1c`, `Glucose`, `Urine`, `血清/血漿`.
        category: Optional class filter when `mode="code"` (for example `CHEM`).
        limit: Maximum results to return (default 3, max 10).
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
    Unified LOINC lookup tool for code detail and reference ranges.

    Mode guide:
    - `detail`: return full concept detail and patient-friendly naming for one code
    - `reference_range`: return demographic range using code + age + gender

    Use this after you already know the exact LOINC code. For discovery/search,
    use `search_loinc`.

    Args:
        mode: `detail` or `reference_range`.
        loinc_code: Required LOINC code in `NNNNN-N` format.
        age: Required only when `mode="reference_range"`.
        gender: `M`, `F`, or `all`; only applies in `reference_range` mode.
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

    This tool combines a code lookup with a clinical comparison. It returns a
    normal / high / low style interpretation together with the matched reference
    range, so it is the right entry point when you already have a numeric result
    and want a quick clinical readout.

    When to use:
    - you know the test code and have a single numeric value
    - you want a quick abnormality flag before reading the detailed report
    - you want a structured output that can be summarized in a care workflow

    When not to use:
    - if you only need to find a code, use `search_loinc(mode="code", ...)`
    - if you want to process a full panel, use `batch_interpret_lab_results`

    ⚠️ Reference values are general guidance only. Final interpretation should
    always consider symptoms, medications, specimen context, and clinician review.

    Args:
        loinc_code: The LOINC code to interpret, for example `1558-6` or
            `718-7`.
        value: The measured numeric value in the test's standard unit.
        age: Patient age in years.
        gender: `M`, `F`, or `all`.
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.interpret_lab_result(loinc_code, value, age, gender)


@audited("batch_interpret_lab_results")
async def batch_interpret_lab_results(
    results_json: str, age: int, gender: Literal["M", "F", "all"] = "all"
) -> str:
    """
    Interpret multiple lab results at once against their reference ranges.

    This is the panel-level companion to `interpret_lab_result`. It is designed
    for cases where you already have a batch of LOINC code + value pairs, such as
    a full lab report, a health checkup panel, or a results feed from an EHR.
    The tool evaluates each item, returns a per-test interpretation, and avoids
    repeated round-trips to the single-result endpoint.

    Use this when:
    - you have more than one lab result to review
    - you want a compact abnormality summary for an entire report
    - you need a structured batch output that is easier for LLM summarization

    ⚠️ Reference values are for general guidance. Final interpretation should
    still be reviewed in clinical context with a licensed healthcare professional.

    Args:
        results_json: JSON array of result objects, each with 'loinc_code' (str)
                      and 'value' (number). Example:
                      [{"loinc_code": "1558-6", "value": 126},
                       {"loinc_code": "4548-4", "value": 7.2},
                       {"loinc_code": "718-7",  "value": 13.5}]
        age: Patient age in years (integer).
        gender: 'M' (male) | 'F' (female) | 'all' (gender-neutral, default).
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    try:
        results = json.loads(results_json)
        return await lab_service.batch_interpret_results(results, age, gender)
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"Invalid JSON: {e}"}, ensure_ascii=False)


# ============================================================
# Group 9: Clinical Guidelines
# ============================================================


@audited("search_clinical_guideline")
async def search_clinical_guideline(keyword: str, limit: int = 3) -> str:
    """
    Search Taiwan clinical practice guidelines by disease name or ICD-10 code.

    Uses hybrid BM25 + semantic similarity — e.g., '高血壓' also surfaces
    hypertension guidelines, and 'diabetes' surfaces '糖尿病' guidelines.
    Returns the top closest matching guidelines (default 3, max 10).
    Use get_complete_guideline to retrieve the full content for a specific guideline.

    Args:
        keyword: Disease name in Chinese or English, or ICD-10 code
                 (e.g., '糖尿病', 'E11', '高血壓', 'I10', 'dyslipidaemia', 'E78').
        limit: Number of closest-matching results to return (default 3, max 10).

    Output: returns the top `limit` results ranked by semantic similarity score,
    not keyword-filtered records. The tool always returns up to `limit` items
    even when no exact match exists — treat results as the closest approximations
    found in the database, not confirmed matches.
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.search_guideline(keyword, limit=limit)


@audited("get_complete_guideline")
async def get_complete_guideline(icd_code: str) -> str:
    """
    Retrieve the full guideline package for one ICD diagnosis code.

    This is the broadest guideline endpoint and typically returns combined
    sections such as diagnosis context, medication recommendations, tests,
    targets, and pathway hints in one payload.

    Use this when:
    - you need complete context in a single call
    - you are building summary views or care-plan drafts
    - you do not want to orchestrate per-section calls

    Output behavior:
    - returns a multi-section guideline payload for the specified ICD
    - section keys are consistent with `query_guideline(section="complete")`

    Args:
        icd_code: ICD-10 diagnosis code such as `E11`, `I10`, `E78`, `N18`.
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await _call_service_json(
        guideline_service, "get_complete_guideline", icd_code
    )


@audited("query_guideline")
async def query_guideline(
    icd_code: str,
    section: Literal["complete", "medication", "test", "goals", "pathway"] = "complete",
) -> str:
    """
    Unified guideline entry point for Taiwan clinical practice guidelines.

    Use this when you want one stable tool for guideline retrieval instead of
    separate section-specific tools. The `section` parameter controls the
    shape of the response:

    - `complete`: full guideline summary, including diagnosis overview,
      medications, tests, goals, and care-path context.
    - `medication`: medication recommendations only, such as first-line,
      second-line, add-on, and special population adjustments.
    - `test`: recommended examinations, labs, imaging, and follow-up checks.
    - `goals`: treatment targets and outcome goals, such as HbA1c or BP goals.
    - `pathway`: synthesized step-by-step clinical pathway for the disease.

    The returned JSON always matches the selected section; callers can switch
    sections without changing tool name.

    Args:
        icd_code: Guideline diagnosis code such as 'E11', 'I10', or 'N18'.
        section: The guideline section to retrieve.
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
        return await _call_service_json(guideline_service, method_name, icd_code, None)
    return await _call_service_json(guideline_service, method_name, icd_code)


@audited("get_medication_recommendations")
async def get_medication_recommendations(icd_code: str) -> str:
    """
    Retrieve only the medication section for a diagnosis guideline.

    Typical content includes first-line, second-line, add-on choices, and
    disease-specific cautions or special population notes.

    Use this when medication planning is needed without pulling full guideline
    content.

    Output behavior:
    - returns the medication-focused section only
    - typically includes recommendation tiering and caution notes

    ⚠️ Recommendations are decision-support content and must be clinician-verified.

    Args:
        icd_code: ICD-10 code such as `I10`, `E11`, `E78`.
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await _call_service_json(
        guideline_service, "get_medication_recommendations", icd_code
    )


@audited("get_test_recommendations")
async def get_test_recommendations(icd_code: str) -> str:
    """
    Retrieve only the recommended investigations for a diagnosis.

    This section-focused endpoint returns tests/exams associated with the
    selected disease, including monitoring patterns when available.

    Output behavior:
    - returns test/exam recommendations only
    - may include suggested follow-up cadence depending on guideline coverage
    - excludes medication and target sections by design

    Use this section when building:
    - baseline diagnostic workup checklists
    - follow-up monitoring plans
    - lab ordering suggestions in care pathways

    Args:
        icd_code: ICD-10 diagnosis code such as `E11`, `N18`, `I10`.
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await _call_service_json(
        guideline_service, "get_test_recommendations", icd_code
    )


@audited("get_treatment_goals")
async def get_treatment_goals(icd_code: str) -> str:
    """
    Retrieve target outcomes and treatment goals for one diagnosis.

    Example target domains include glycemic, blood pressure, lipid, and
    progression-control goals depending on disease type.

    Use this when target tracking is required without medication/test detail.

    Output behavior:
    - returns goal/target section only
    - suitable for monitoring dashboards and follow-up planning
    - excludes medication and test recommendation content

    Typical uses:
    - target tracking for chronic disease follow-up
    - shared-care plan summaries
    - alert threshold configuration

    ⚠️ Final individualized targets must be set by qualified clinicians.

    Args:
        icd_code: ICD-10 diagnosis code such as `E11`, `I10`, `E78`, `N18`.
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await _call_service_json(guideline_service, "get_treatment_goals", icd_code)


@audited("check_medication_contraindications")
async def check_medication_contraindications(
    icd_code: str, medication_class: str
) -> str:
    """
    Check Taiwan guideline contraindications for a medication class given a diagnosis.

    Searches the guideline for the given diagnosis and returns:
    (1) any recommendation entries that mention the queried medication class
    (including both recommended and contraindicated uses), and
    (2) all absolute contraindication entries for the disease regardless of
    medication class. Useful for verifying whether a specific drug class is
    appropriate or contraindicated for a patient with a given diagnosis.

    ⚠️ Always verify with a licensed clinician before making any prescribing
    or deprescribing decisions.

    Args:
        icd_code: Diagnosis ICD-10 code (e.g., 'E11' for type 2 diabetes,
                  'N18' for CKD, 'I50' for heart failure).
        medication_class: Medication class or drug name to query in Chinese or
                          English (e.g., 'SGLT2抑制劑', 'Metformin', 'ACE抑制劑',
                          'NSAIDs', '磺醯尿素類').
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await _call_service_json(
        guideline_service,
        "check_medication_contraindications",
        icd_code,
        medication_class,
    )


@audited("link_guideline_to_drugs")
async def link_guideline_to_drugs(icd_code: str) -> str:
    """
    Map guideline-recommended therapies to Taiwan FDA licensed drug products.

    This endpoint bridges clinical recommendations and local product
    availability, which is useful for formulary checks and implementation
    planning.

    Output typically includes recommendation classes and matched license-level
    candidates when present.

    Use this when:
    - guideline advice must be grounded in local market availability
    - downstream flows need concrete Taiwan FDA license candidates

    Args:
        icd_code: ICD-10 diagnosis code such as `E11`, `I10`, `E78`.
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await _call_service_json(
        guideline_service, "link_guideline_to_drugs", icd_code
    )


@audited("suggest_clinical_pathway")
async def suggest_clinical_pathway(
    icd_code: str, patient_context_json: str | None = None
) -> str:
    """
    Suggest a step-by-step clinical management pathway based on Taiwan guidelines.

    Use this when you want a synthesized plan rather than raw guideline text.
    The pathway moves from assessment to treatment and follow-up, and can be
    personalised with patient context when provided.

    ⚠️ For clinical decision support only. All management decisions must be made
    by a licensed healthcare professional.

    Args:
        icd_code: ICD-10 code (e.g., 'E11' for type 2 diabetes, 'I10' for
                  hypertension).
        patient_context_json: Optional JSON string with patient details to
                              personalise the pathway. Supported fields:
                              {"age": 65, "gender": "M",
                               "comorbidities": ["CKD", "心衰竭"],
                               "current_medications": ["metformin"],
                               "allergies": ["sulfonamides"]}
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    context = None
    if patient_context_json:
        try:
            context = json.loads(patient_context_json)
        except json.JSONDecodeError:
            pass
    return await _call_service_json(
        guideline_service, "suggest_clinical_pathway", icd_code, context
    )


# ============================================================
# Group 10: TWCore IG
# ============================================================


@audited("list_twcore_codesystems")
async def list_twcore_codesystems(category: str = "all") -> str:
    """
    List available TWCore CodeSystems, optionally filtered by domain category.

    This is the discovery step before `search_twcore_code`,
    `lookup_twcore_code`, or `query_twcore_code` with explicit IDs.

    Output behavior:
    - `all`: returns all known CodeSystems
    - category filter: returns only IDs in that domain

    Typical workflow:
    1) call this tool to get IDs
    2) feed IDs into `search_twcore_code` or `query_twcore_code`

    Output fields generally include:
    - CodeSystem ID
    - human-readable title/display
    - category tag
    - system URI (when available)

    Args:
        category: One of `all`, `medication`, `diagnosis`, `organization`,
            `administrative`.
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    return await twcore_service.list_codesystems(category)


@audited("search_twcore_code")
async def search_twcore_code(keyword: str, codesystem_ids: list[str]) -> str:
    """
    Search TWCore codes/displays across one or more specified CodeSystems.

    Use this when you have a text fragment and want candidate coded terms
    without requiring an exact code match.

    Output behavior:
    - returns matching rows grouped or labeled by CodeSystem
    - search scope is limited to the provided `codesystem_ids`
    - uses code/display text matching within each selected CodeSystem

    Args:
        keyword: Code fragment or display text, for example `QD`, `每天一次`,
            `HOSP`, `醫院`.
        codesystem_ids: Target CodeSystem IDs, such as
            `['medication-frequency-nhi-tw', 'organization-identifier-tw']`.
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    return await twcore_service.search_code(keyword, codesystem_ids)


@audited("lookup_twcore_code")
async def lookup_twcore_code(code: str, codesystem_id: str) -> str:
    """
    Perform exact code lookup in one TWCore CodeSystem.

    Use this when you already know the exact code value and need canonical
    coding output (`system`, `code`, `display`) instead of fuzzy candidates.

    Output behavior:
    - returns one canonical coding record when found
    - returns not-found error payload when code does not exist in that system
    - does not perform fuzzy search; exact code match is required

    Args:
        code: Exact code value, for example `QD`, `BID`, `HOSP`.
        codesystem_id: Single TWCore CodeSystem ID, for example
            `medication-frequency-nhi-tw`.
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    return await twcore_service.lookup_code(code, codesystem_id)


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
    Unified TWCore endpoint with list/search/lookup behavior in one tool.

    Supported patterns:
    - list mode: set `category` only
    - search mode: set `keyword` + `codesystem_ids`
    - lookup mode: set `code` + `codesystem_id`

    This tool is useful for callers that prefer one stable entry point instead
    of switching across three TWCore-specific tool names.

    Args:
        category: Category selector for list mode (`all`, `medication`,
            `diagnosis`, `organization`, `administrative`).
        keyword: Search text for search mode, such as `QD` or `每日一次`.
        code: Exact code for lookup mode.
        codesystem_ids: One or more CodeSystem IDs for search mode.
        codesystem_id: Single CodeSystem ID for lookup mode.
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    if category is not None and keyword is None and code is None:
        return await twcore_service.list_codesystems(category)
    if code and codesystem_id:
        return await twcore_service.lookup_code(code, codesystem_id)
    if keyword and codesystem_ids is not None:
        return await twcore_service.search_code(keyword, codesystem_ids)
    return _json_error(
        "Provide category, or either (code + codesystem_id) or (keyword + codesystem_ids)"
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
    Search SNOMED CT International edition (370,000+ concepts) by English term.

    Uses hybrid BM25 + semantic similarity to return the top closest matching
    concepts — not just exact keyword matches. For example, 'heart attack' also
    surfaces 'Myocardial infarction (disorder)'. Results include concept ID,
    preferred FSN, term type, and active status.
    Use query_snomed_concept for full details plus parent and child context.

    Args:
        query: English clinical term (e.g., 'diabetes mellitus', 'myocardial
               infarction', 'hypertension', 'fracture of femur').
        limit: Number of closest-matching results to return (default 3, max 10).
        hierarchy_filter: Optional SNOMED concept ID to restrict search to a
                          specific hierarchy. Common roots:
                          404684003 (Clinical finding),
                          71388002 (Procedure),
                          373873005 (Pharmaceutical/biologic product),
                          123037004 (Body structure).

    Output: returns the top `limit` results ranked by semantic similarity score,
    not keyword-filtered records. The tool always returns up to `limit` items
    even when no exact match exists — treat results as the closest approximations
    found in the database, not confirmed matches.
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    results = await snomed_service.search_concepts(
        query, min(limit, 100), hierarchy_filter
    )
    if isinstance(results, str):
        return results  # Already JSON string from cache
    return json.dumps(results, ensure_ascii=False, indent=2)


@audited("get_snomed_concept")
async def get_snomed_concept(concept_id: int) -> str:
    """
    Retrieve one SNOMED concept record with terminology and mapping context.

    Returned concept detail includes:
    - preferred FSN / active terms
    - active synonym set
    - direct IS-A parents (up to service limits)
    - ICD mapping content when available (target/rule/group/priority fields)

    Use this when you already know the concept ID and need authoritative detail
    without extra hierarchy expansion controls.

    Output behavior:
    - returns one concept object
    - returns `{ "error": "Concept <id> not found" }` if missing

    Args:
        concept_id: Numeric SNOMED CT concept ID, for example `73211009`,
            `38341003`, `22298006`.
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    result = await snomed_service.get_concept(concept_id)
    if result is None:
        return json.dumps(
            {"error": f"Concept {concept_id} not found"}, ensure_ascii=False
        )
    if isinstance(result, str):
        return result  # Already JSON string from cache
    return json.dumps(result, ensure_ascii=False, indent=2)


@audited("query_snomed_concept")
async def query_snomed_concept(
    concept_id: int,
    include_parents: bool = True,
    include_children: bool = True,
    parent_limit: int = 10,
    child_limit: int = 20,
) -> str:
    """
    Get a SNOMED concept with optional parent and child expansion.

    Use this when you want the concept itself plus its immediate hierarchy
    context in one call. By default the tool includes the concept record, the
    ancestor chain, and the direct children. This is the preferred SNOMED
    entry point when you want to understand a concept and its surrounding tree.

    Args:
        concept_id: SNOMED CT concept ID such as 73211009 or 44054006.
        include_parents: Include ancestor concepts above the target concept.
        include_children: Include direct child concepts beneath the target.
        parent_limit: Maximum ancestor depth to return.
        child_limit: Maximum number of child concepts to return.
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


@audited("get_snomed_children")
async def get_snomed_children(concept_id: int, limit: int = 50) -> str:
    """
    Return direct IS-A child concepts for a SNOMED parent concept.

    This endpoint traverses one level downward only. It is ideal for exploring
    subtype branches from a broad clinical concept.

    Output keys include:
    - `concept_id`
    - `children_count`
    - `children` (child concept rows)

    This endpoint does not include ancestor context; pair with
    `query_snomed_concept` when both sides of hierarchy are needed.

    Common uses:
    - building "expand descendants" UI trees
    - narrowing from broad disease classes to specific phenotypes
    - preparing pick-lists for downstream mapping

    Args:
        concept_id: Parent concept ID such as `73211009` (Diabetes mellitus).
        limit: Maximum returned children (default 50, max 200).
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    results = await snomed_service.get_children(concept_id, min(limit, 200))
    return json.dumps(
        {"concept_id": concept_id, "children_count": len(results), "children": results},
        ensure_ascii=False,
        indent=2,
    )


@audited("get_snomed_ancestors")
async def get_snomed_ancestors(concept_id: int, max_depth: int = 10) -> str:
    """
    Return ancestor chain for a SNOMED concept via IS-A upward traversal.

    This endpoint is useful for:
    - deriving parent taxonomy for grouping/classification
    - understanding how a specific concept rolls up to higher abstractions

    Output keys include `ancestor_count` and ordered `ancestors` rows.

    This endpoint does not include descendants; use `query_snomed_concept`
    for a combined concept + parents + children response.

    Common uses:
    - deriving disease roll-up categories
    - explaining classification lineage in audit output
    - grouping concept-level analytics by parent class

    Args:
        concept_id: SNOMED concept ID such as `44054006`.
        max_depth: Maximum IS-A traversal depth (default 10, max 20).
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    results = await snomed_service.get_ancestors(concept_id, min(max_depth, 20))
    return json.dumps(
        {
            "concept_id": concept_id,
            "ancestor_count": len(results),
            "ancestors": results,
        },
        ensure_ascii=False,
        indent=2,
    )


@audited("get_snomed_relationships")
async def get_snomed_relationships(
    concept_id: int,
    relationship_type_id: int = None,
) -> str:
    """
    Get the clinical attribute relationships (non-IS-A) for a SNOMED CT concept.

    Returns relationships that define the clinical meaning of a concept, grouped
    by relationship type. These attributes describe properties such as the
    anatomical site involved, the causative agent, the associated morphology,
    or the active ingredient. Results are grouped by relationship type with a
    human-readable label and list of target concepts for each type.

    Args:
        concept_id: SNOMED CT concept ID
                    (e.g., 22298006 for 'Myocardial infarction' to get
                     Finding site → Heart structure,
                     Associated morphology → Infarct).
        relationship_type_id: Optional SNOMED concept ID of a specific relationship
                              type to filter results. Common type IDs:
                              363698007 = Finding site,
                              116676008 = Associated morphology,
                              246075003 = Causative agent,
                              127489000 = Has active ingredient,
                              411116001 = Has dose form.
                              Omit to return all relationship types.
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


@audited("map_icd_to_snomed")
async def map_icd_to_snomed(icd_code: str) -> str:
    """
    Map one ICD code to candidate SNOMED concepts.

    This is the directional helper for ICD → SNOMED conversion when source
    data is diagnosis-oriented and destination normalization requires SNOMED.

    Output payload:
    - `icd_code` (normalized uppercase)
    - `snomed_concepts` (matched concept list with mapping metadata)

    Notes:
    - mapping availability depends on source map coverage
    - one ICD code may map to zero, one, or multiple SNOMED targets

    Use this when:
    - claims/diagnosis data arrives as ICD but downstream ontology uses SNOMED
    - you need standardized concept IDs for terminology reasoning

    Args:
        icd_code: ICD-10 code such as `E11.9`, `I10`, `E78.5`.
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    results = await snomed_service.map_icd_to_snomed(icd_code)
    return json.dumps(
        {"icd_code": icd_code.upper(), "snomed_concepts": results},
        ensure_ascii=False,
        indent=2,
    )


@audited("query_snomed_mapping")
async def query_snomed_mapping(
    mode: Literal["icd", "snomed"] = "icd",
    keyword: str = "",
) -> str:
    """
    Unified ICD↔SNOMED mapping endpoint with explicit direction mode.

    Mode behavior:
    - `mode="icd"`: keyword is treated as ICD code and mapped to SNOMED concepts
    - `mode="snomed"`: keyword is treated as SNOMED concept ID; if non-numeric,
      the service first attempts concept search and then maps best match to ICD

    Output shape:
    - icd mode: `{"mode","keyword","snomed_concepts"}`
    - snomed mode: `{"mode","keyword","icd10_mappings"}`

    Args:
        mode: Mapping direction, `icd` or `snomed`.
        keyword: Source value. ICD examples: `E11.9`, `I10`.
            SNOMED examples: `73211009`, `44054006`, or searchable term.
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


@audited("map_snomed_to_icd")
async def map_snomed_to_icd(concept_id: int) -> str:
    """
    Map one SNOMED concept to ICD-10 target codes.

    This is the directional helper for SNOMED → ICD conversion and returns
    ICD mappings with rule/group metadata where available.

    Notes:
    - one SNOMED concept may map to multiple ICD targets
    - mapping output depends on map table coverage and rules

    Use this when:
    - SNOMED-coded clinical findings must be exported to ICD workflows
    - billing/reporting interfaces require ICD targets

    Args:
        concept_id: SNOMED CT concept ID, for example `73211009`, `38341003`.
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    results = await snomed_service.map_snomed_to_icd(concept_id)
    return json.dumps(
        {"concept_id": concept_id, "icd10_mappings": results},
        ensure_ascii=False,
        indent=2,
    )


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
