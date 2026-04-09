import asyncio
import inspect
import json
from contextlib import asynccontextmanager
from typing import Callable

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

            # ── Services ──────────────────────────────────────────────────
            for name, factory in [
                ("ICDService", lambda: ICDService(pool)),
                ("DrugService", lambda: DrugService(pool)),
                ("HealthFoodService", lambda: HealthFoodService(pool)),
                ("FoodNutritionService", lambda: FoodNutritionService(pool)),
                ("FHIRConditionService", lambda: FHIRConditionService(pool)),
                ("FHIRMedicationService", lambda: FHIRMedicationService(drug_service)),
                ("LabService", lambda: LabService(pool)),
                ("ClinicalGuidelineService", lambda: ClinicalGuidelineService(pool)),
                ("TWCoreService", lambda: TWCoreService(pool)),
                ("SNOMEDService", lambda: SNOMEDService(pool)),
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


_PRIVACY_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy – Taiwan Health MCP Server</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto;
           padding: 0 24px; line-height: 1.7; color: #222; }
    h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 2rem; }
    p, li { font-size: 0.97rem; } code { background: #f4f4f4; padding: 1px 5px;
    border-radius: 3px; font-size: 0.9rem; }
  </style>
</head>
<body>
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
</body>
</html>
"""

_PRIVACY_HTML_BYTES = _PRIVACY_HTML.encode("utf-8")


class PrivacyPageMiddleware:
    """Serve a static privacy policy page at GET /privacy."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("method") == "GET":
            path = scope.get("path", "")
            if path == "/privacy" or path == "/privacy/":
                await send(
                    {
                        "type": "http.response.start",
                        "status": 200,
                        "headers": [
                            (b"content-type", b"text/html; charset=utf-8"),
                            (
                                b"content-length",
                                str(len(_PRIVACY_HTML_BYTES)).encode(),
                            ),
                            (b"cache-control", b"public, max-age=86400"),
                        ],
                    }
                )
                await send(
                    {
                        "type": "http.response.body",
                        "body": _PRIVACY_HTML_BYTES,
                        "more_body": False,
                    }
                )
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
    Returns server health status and dataset availability for all services.

    Reports database and cache connectivity, plus which of the 11 service
    datasets are loaded and ready (ICD, Drug, Health Food, Food Nutrition,
    FHIR Condition, FHIR Medication, Lab/LOINC, Clinical Guideline, TWCore,
    SNOMED CT, RxNorm). Always available regardless of dataset load status.
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
                "health_food": health_food_service is not None,
                "food_nutrition": food_nutrition_service is not None,
                "fhir_condition": fhir_condition_service is not None,
                "fhir_medication": fhir_medication_service is not None,
                "lab": lab_service is not None,
                "guideline": guideline_service is not None,
                "twcore": twcore_service is not None,
                "snomed": snomed_service is not None,
                "drug_interactions": drug_interaction_service is not None,
            },
        },
        ensure_ascii=False,
    )


# ============================================================
# Group 1: ICD-10
# ============================================================


@audited("search_medical_codes")
async def search_medical_codes(keyword: str, type: str = "all") -> str:
    """
    Search ICD-10-CM 2025 diagnosis codes and ICD-10-PCS 2025 procedure codes.

    Searches by keyword (English or Chinese), code prefix, or partial match.
    Returns a list of matching codes with their descriptions. Data source:
    ICD-10-CM 2025 (NLM) and ICD-10-PCS 2025 (CMS), Taiwan region.

    Args:
        keyword: Search term — English name, Chinese name, or code prefix
                 (e.g., 'Diabetes', 'E11', '子宮內膜異位', '0DTJ').
        type: 'diagnosis' (ICD-10-CM only) | 'procedure' (ICD-10-PCS only)
              | 'all' (both, default).
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.search_codes(keyword, type)


@audited("infer_complications")
async def infer_complications(code: str) -> str:
    """
    List specific sub-codes and child diagnoses under a given ICD-10-CM category.

    Traverses the ICD-10-CM hierarchy to return all more-specific codes that
    fall under the given category code. Useful for understanding the full scope
    of a diagnosis or finding the most specific code for billing/documentation.
    Note: this is a hierarchical lookup, not AI-based clinical inference.

    Args:
        code: ICD-10-CM category or code prefix (e.g., 'E11' for type 2 diabetes,
              'N80' for endometriosis). 3–7 characters.
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.infer_complications(code)


@audited("get_nearby_codes")
async def get_nearby_codes(code: str) -> str:
    """
    Retrieve ICD-10-CM codes adjacent to a given code in the classification order.

    Returns the codes immediately before and after the target code within the
    ICD-10-CM tabular order. Useful for exploring neighbouring diagnoses and
    understanding classification context (e.g., similar conditions coded nearby).

    Args:
        code: ICD-10-CM diagnosis code (e.g., 'E11.9', 'I10').
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.get_nearby_codes(code)


@audited("check_medical_conflict")
async def check_medical_conflict(diagnosis_code: str, procedure_code: str) -> str:
    """
    Retrieve structured data for a diagnosis-procedure pair to support conflict analysis.

    Returns the full description and metadata for both an ICD-10-CM diagnosis code
    and an ICD-10-PCS procedure code side-by-side. The returned data (body site,
    procedure type, diagnosis category) enables the calling model to reason about
    whether the procedure is clinically appropriate for the diagnosis.
    This tool does not perform automatic conflict detection — it provides the raw
    data needed for the model to make that determination.

    Args:
        diagnosis_code: ICD-10-CM diagnosis code (e.g., 'K35.80' for acute appendicitis).
        procedure_code: ICD-10-PCS procedure code (e.g., '0DTJ0ZZ' for appendectomy).
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
    Browse ICD-10-CM diagnosis codes by top-level chapter or 3-character category.

    Call with no arguments to list all ICD-10-CM chapters and 3-character categories.
    Provide a category code to list all specific codes within that category.
    Useful for exploring the classification structure or generating a pick-list
    of codes for a specific disease area.

    Args:
        category: 3-character ICD-10-CM category code (e.g., 'E11', 'I10', 'N80').
                  Omit to list all top-level categories.
        limit: Maximum number of codes to return (default 50, max 200).
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.browse_category(category, limit)


# ============================================================
# Group 2: Drug (Taiwan FDA)
# ============================================================


@audited("search_drug_info")
async def search_drug_info(keyword: str) -> str:
    """
    Search Taiwan FDA approved drugs (66,000+ licenses) by name or indication.

    Searches across Chinese trade name, English trade name, generic ingredient name,
    and indication fields. Data source: Taiwan FDA open data, updated weekly.
    Returns license ID, trade name, manufacturer, and dosage form for each match.
    Use get_drug_details to retrieve full information for a specific result.

    Args:
        keyword: Drug trade name, generic name, or indication in Chinese or English
                 (e.g., 'Panadol', '普拿疼', 'aspirin', '阿斯匹林', 'hypertension').
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.search_drug(keyword)


@audited("get_drug_details")
async def get_drug_details(license_id: str) -> str:
    """
    Get full details for a Taiwan FDA drug license: ingredients, dosage, usage, appearance.

    Returns all available fields for the license: trade name (Chinese/English),
    manufacturer, active ingredients with strengths, dosage form, administration
    route, indication, contraindications, storage conditions, appearance description
    (color/shape/markings), and NHI reimbursement status.

    Args:
        license_id: Taiwan FDA drug license ID from search_drug_info results
                    (e.g., '衛部藥製字第058498號').
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.get_drug_details_by_license(license_id)


@audited("identify_unknown_pill")
async def identify_unknown_pill(features: str) -> str:
    """
    Identify a Taiwan FDA drug by pill appearance (color, shape, imprint markings).

    Searches the appearance fields in the Taiwan FDA drug database. For best results
    use Chinese color/shape terms as they appear in the database. Returns matching
    drugs with license ID, trade name, and appearance description.

    ⚠️ For reference only — always confirm pill identity with a licensed pharmacist.

    Args:
        features: Space-separated appearance keywords in Chinese or English
                  (e.g., '白 圓形', '橙色 橢圓', 'white round YP',
                   '粉紅 菱形 PFIZER').
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.identify_pill(features)


@audited("search_drug_by_atc")
async def search_drug_by_atc(query: str) -> str:
    """
    Search Taiwan FDA approved drugs by WHO ATC code or therapeutic class name.

    The ATC (Anatomical Therapeutic Chemical) classification organises drugs by
    therapeutic use and chemical properties. Supports prefix search on ATC codes
    (up to 7 levels) and free-text search on ATC class names.

    Args:
        query: ATC code prefix (e.g., 'A10' for diabetes drugs, 'C09' for ACE
               inhibitors/ARBs, 'N02BE' for paracetamol) or class name in English
               (e.g., 'antihypertensives', 'metformin', 'statins').
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.search_by_atc(query)


@audited("search_drug_by_ingredient")
async def search_drug_by_ingredient(ingredient_name: str) -> str:
    """
    Find Taiwan FDA approved drugs that contain a specific active ingredient.

    Searches the ingredient field of all licensed drug products. Useful for
    finding all brand-name products that contain a given generic ingredient,
    or for checking which drugs in the Taiwan market share the same active component.

    Args:
        ingredient_name: Active ingredient in Chinese or English, generic or INN name
                         (e.g., 'metformin', '二甲雙胍', 'aspirin', '阿斯匹林',
                          'atorvastatin', '阿托伐他汀').
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.search_by_ingredient(ingredient_name)


# ============================================================
# Group 3: Health Food (Taiwan FDA)
# ============================================================


@audited("search_health_food")
async def search_health_food(keyword: str) -> str:
    """
    Search Taiwan FDA certified health foods (健康食品) by name or approved health benefit.

    Health foods (健康食品) in Taiwan are products that have received an official
    health benefit certification from the Taiwan FDA — they are distinct from
    ordinary food supplements. Returns permit number, product name, manufacturer,
    and certified health claims. Use get_health_food_details for full information.
    Data source: Taiwan FDA open data, updated weekly.

    Args:
        keyword: Product name, brand, or certified health benefit claim in Chinese
                 (e.g., '靈芝', '調節血脂', '護肝', '益生菌', '葡萄糖胺').
    """
    if health_food_service is None:
        return _svc_unavailable("Health Food Service")
    return await health_food_service.search_health_food(keyword)


@audited("get_health_food_details")
async def get_health_food_details(permit_no: str) -> str:
    """
    Get full details for a Taiwan FDA certified health food by permit number.

    Returns all available fields: product name, manufacturer, certified health
    benefit claims, main ingredients, recommended dosage, cautions, and permit
    validity status.

    Args:
        permit_no: Taiwan FDA health food permit number from search_health_food
                   results (e.g., '衛部健食字第A00123號').
    """
    if health_food_service is None:
        return _svc_unavailable("Health Food Service")
    return await health_food_service.get_health_food_details(permit_no)


# ============================================================
# Group 4: Food Nutrition
# ============================================================


@audited("search_food_nutrition")
async def search_food_nutrition(food_name: str, nutrient: str | None = None) -> str:
    """
    Search Taiwan FDA food composition database for nutritional content per 100 g.

    Returns energy (kcal), macronutrients (protein, fat, carbohydrate, dietary fibre),
    and key micronutrients for matching foods. Nutrient names follow Taiwan FDA
    convention (e.g., '粗蛋白' for protein, '粗脂肪' for fat). Data source:
    Taiwan FDA Food Composition Database, updated weekly.

    Args:
        food_name: Food name in Chinese or English (e.g., '白米', '雞蛋', '豆腐',
                   'chicken breast', 'salmon').
        nutrient: Optional nutrient name to filter and display (e.g., '粗蛋白', '鈣',
                  '維生素C', '膳食纖維'). Returns all nutrients if omitted.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_nutrition(food_name, nutrient)


@audited("get_detailed_nutrition")
async def get_detailed_nutrition(food_name: str) -> str:
    """
    Get the complete nutritional profile for a food (per 100 g) from Taiwan's database.

    Returns the full nutrient panel: energy, water content, protein, fat,
    carbohydrates, dietary fibre, ash, vitamins (A, B1, B2, B6, B12, C, D, E, K,
    niacin, folate), minerals (Ca, P, Fe, Na, K, Mg, Zn, Mn, Cu, Se, I),
    fatty acid profile (saturated, monounsaturated, polyunsaturated, EPA, DHA),
    cholesterol, and trans fats where available.

    Args:
        food_name: Exact or near-exact food name in Chinese (e.g., '糙米', '雞胸肉',
                   '全脂牛奶', '大西洋鮭魚').
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.get_detailed_nutrition(food_name)


@audited("search_food_ingredient")
async def search_food_ingredient(keyword: str) -> str:
    """
    Search Taiwan FDA food ingredient classification database by ingredient name.

    Returns ingredient category, permitted uses, and regulatory status for matching
    food ingredients/raw materials. Data covers additives, natural ingredients,
    flavourings, and processing aids as classified by Taiwan FDA.

    Args:
        keyword: Ingredient name in Chinese or English (e.g., '薑黃', 'turmeric',
                 '卡拉膠', 'carrageenan', '山梨酸', 'sorbic acid').
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_food_ingredient(keyword)


@audited("get_ingredients_by_category")
async def get_ingredients_by_category(category: str) -> str:
    """
    List all Taiwan FDA approved food ingredients within a specific category.

    Returns a complete list of ingredients belonging to the given classification
    category. Use search_food_ingredient first to discover category names.

    Args:
        category: Exact category name as stored in the Taiwan FDA ingredient database
                  (e.g., '香料植物及其製品', '食品添加物', '水產品', '穀類及其製品').
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.get_ingredients_by_category(category)


@audited("search_foods_by_nutrient")
async def search_foods_by_nutrient(nutrient: str, limit: int = 20) -> str:
    """
    Find foods ranked by content of a specific nutrient (per 100g), from Taiwan's
    food composition database. Note: nutrient names follow Taiwan FDA naming convention
    (e.g., '粗蛋白' for protein, '粗脂肪' for fat, '鈣', '鐵', '維生素C').

    Args:
        nutrient: Nutrient name (e.g., '粗蛋白', '鈣', '鐵', '膳食纖維', '鉀', 'EPA', 'DHA').
        limit: Number of foods to return (default 20, max 50).
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_foods_by_nutrient(nutrient, limit)


@audited("analyze_meal_nutrition")
async def analyze_meal_nutrition(foods: list[str]) -> str:
    """
    Calculate the combined nutritional totals for a multi-food meal (per 100 g each).

    Looks up each food in the Taiwan FDA composition database and sums all nutrients
    across the listed foods. Returns per-food breakdown and aggregate totals for
    energy, macronutrients, and key micronutrients.
    Note: values assume 100 g of each food; adjust manually for actual serving sizes.

    Args:
        foods: List of food names in Chinese (e.g., ['白米飯', '雞胸肉', '青花菜',
               '豆腐']). Each name should match a food in the database.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.analyze_meal_nutrition(foods)


# ============================================================
# Group 5: Health Food + ICD integrated analysis
# ============================================================


@audited("analyze_health_support_for_condition")
async def analyze_health_support_for_condition(diagnosis_keyword: str) -> str:
    """
    Map a diagnosis to relevant Taiwan FDA certified health foods and dietary notes.

    Cross-references the diagnosis against a curated disease-to-health-food mapping,
    then retrieves matching certified health food products. Also includes general
    dietary considerations associated with the condition.

    ⚠️ This mapping is developer-curated and NOT medically validated. Health foods
    are NOT medicine and cannot replace prescription treatment. Not suitable for
    direct patient-facing use without expert clinical review.

    Args:
        diagnosis_keyword: Disease name in Chinese/English or ICD-10 code
                           (e.g., 'E11', 'E78', '糖尿病', '高血脂', 'hypertension').
    """
    if health_food_service is None:
        return _svc_unavailable("Health Food Service")
    return await health_food_service.analyze_health_support_for_condition(
        diagnosis_keyword, icd_service=icd_service
    )


# ============================================================
# Group 6: FHIR Condition
# ============================================================


@audited("create_fhir_condition")
async def create_fhir_condition(
    icd_code: str,
    patient_id: str,
    clinical_status: str = "active",
    verification_status: str = "confirmed",
    category: str = "encounter-diagnosis",
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
    result = await fhir_condition_service.create_condition(
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
    return fhir_condition_service.to_json_string(result, indent=2)


@audited("create_fhir_condition_from_diagnosis")
async def create_fhir_condition_from_diagnosis(
    diagnosis_keyword: str,
    patient_id: str,
    clinical_status: str = "active",
    verification_status: str = "confirmed",
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
    result = await fhir_condition_service.create_condition_from_search(
        keyword=diagnosis_keyword,
        patient_id=patient_id,
        clinical_status=clinical_status,
        verification_status=verification_status,
        severity=severity,
    )
    return fhir_condition_service.to_json_string(result, indent=2)


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
        return json.dumps(
            {"valid": False, "errors": [f"Invalid JSON: {e}"]}, ensure_ascii=False
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

    Finds the best-matching drug in the Taiwan FDA database and builds a FHIR
    Medication or MedicationKnowledge resource. Use create_fhir_medication if
    you already have the license ID. Does not persist to any FHIR server.

    Args:
        keyword: Drug name in Chinese or English (e.g., 'Metformin', '二甲雙胍',
                 '普拿疼', 'atorvastatin').
        resource_type: 'Medication' (basic — code, form, ingredient) |
                       'MedicationKnowledge' (extended — adds ATC class,
                       dosage instructions, indications).
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    return json.dumps(
        await fhir_medication_service.create_medication_from_search(
            keyword, resource_type
        ),
        ensure_ascii=False,
        indent=2,
    )


@audited("create_fhir_medication")
async def create_fhir_medication(license_id: str) -> str:
    """
    Build a FHIR R4 Medication resource from a Taiwan FDA drug license ID.

    Retrieves the drug record and constructs a FHIR R4 Medication resource with
    code (using Taiwan FDA license system), dosage form, and active ingredients.
    Does not persist to any FHIR server — returns the resource JSON.

    Args:
        license_id: Taiwan FDA drug license ID from search_drug_info results
                    (e.g., '衛部藥製字第058498號').
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    result = await fhir_medication_service.create_medication(license_id)
    return fhir_medication_service.to_json_string(result, indent=2)


@audited("create_fhir_medication_knowledge")
async def create_fhir_medication_from_drug(license_id: str) -> str:
    """
    Build a FHIR R4 MedicationKnowledge resource from a Taiwan FDA drug license ID.

    Extends the basic Medication resource with knowledge-level detail: ATC
    classification, available dosage forms, administration routes, indications,
    contraindications, and storage conditions. Does not persist to any FHIR server.

    Args:
        license_id: Taiwan FDA drug license ID from search_drug_info results
                    (e.g., '衛部藥製字第058498號').
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    result = await fhir_medication_service.create_medication_knowledge(license_id)
    return fhir_medication_service.to_json_string(result, indent=2)


@audited("validate_fhir_medication")
async def validate_fhir_medication(medication_json: str) -> str:
    """
    Validate a FHIR R4 Medication or MedicationKnowledge resource for required fields.

    Checks for resourceType, code with valid coding system, and ingredient list.
    Returns a validation result with a list of errors if any field is missing
    or malformed.

    ⚠️ This is a basic structural validation only. For production use, validate
    with the official HL7 FHIR Validator or Taiwan TWCore IG validator.

    Args:
        medication_json: JSON string of the FHIR R4 Medication or
                         MedicationKnowledge resource to validate.
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    try:
        resource = json.loads(medication_json)
        result = fhir_medication_service.validate_medication(resource)
        return fhir_medication_service.to_json_string(result, indent=2)
    except json.JSONDecodeError as e:
        return json.dumps(
            {"valid": False, "errors": [f"Invalid JSON: {e}"]}, ensure_ascii=False
        )


# ============================================================
# Group 8: Lab / LOINC
# ============================================================


@audited("search_loinc_code")
async def search_loinc_code(keyword: str, category: str | None = None) -> str:
    """
    Search LOINC 2.80 codes (87,000+ codes) by test name or abbreviation.

    Returns matching LOINC codes with long common name, component (analyte),
    specimen type, and scale. Use get_loinc_detail for the full LOINC axes
    breakdown of a specific code. Use list_lab_categories to see available
    category filters.

    Args:
        keyword: Test name, abbreviation, or analyte in Chinese or English
                 (e.g., '血糖', 'HbA1c', 'WBC', 'Glucose', 'creatinine',
                  'TSH', '甲狀腺刺激素').
        category: Optional LOINC class filter (e.g., 'CHEM', 'HEM/BC',
                  'SERO', 'UA'). Use list_lab_categories to discover values.
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.search_loinc_code(keyword, category)


@audited("list_lab_categories")
async def list_lab_categories() -> str:
    """
    List all LOINC class categories available in the database.

    Returns category codes and names that can be used as the `category` filter
    in search_loinc_code. Categories follow the LOINC CLASS axis
    (e.g., CHEM, HEM/BC, SERO, UA, MICRO, COAG).
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.list_categories()


@audited("get_reference_range")
async def get_reference_range(loinc_code: str, age: int, gender: str = "all") -> str:
    """
    Get the clinical reference range for a LOINC lab test, stratified by age and gender.

    Returns lower bound, upper bound, unit, and the age-gender stratum that matched.
    Reference ranges are drawn from the local database (populated from standard
    clinical references). Not all LOINC codes have reference ranges — returns
    an appropriate message when none is available.

    Args:
        loinc_code: LOINC code (e.g., '1558-6' for fasting plasma glucose,
                    '4548-4' for HbA1c).
        age: Patient age in years (integer).
        gender: 'M' (male) | 'F' (female) | 'all' (gender-neutral, default).
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.get_reference_range(loinc_code, age, gender)


@audited("interpret_lab_result")
async def interpret_lab_result(
    loinc_code: str, value: float, age: int, gender: str = "all"
) -> str:
    """
    Interpret a single lab result as High / Normal / Low against its reference range.

    Returns the interpretation flag, the applicable reference range (lower/upper bound,
    unit), and the LOINC test name. Uses age- and gender-stratified reference ranges
    where available. For batch interpretation of multiple results, use
    batch_interpret_lab_results.

    ⚠️ Reference values are for general guidance. Always interpret in clinical context
    with a licensed healthcare professional.

    Args:
        loinc_code: LOINC code for the test (e.g., '1558-6' for fasting glucose,
                    '718-7' for haemoglobin).
        value: The measured numeric result value (in the test's standard unit).
        age: Patient age in years (integer).
        gender: 'M' (male) | 'F' (female) | 'all' (gender-neutral, default).
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.interpret_lab_result(loinc_code, value, age, gender)


@audited("search_loinc_by_specimen")
async def search_loinc_by_specimen(specimen_type: str) -> str:
    """
    Find LOINC lab tests by specimen or sample type.

    Searches the LOINC System axis for tests collected from the specified specimen.
    Specimen names in this database follow Chinese conventions used in Taiwan.

    Args:
        specimen_type: Specimen type in Chinese (preferred) or LOINC system code
                       (e.g., '血清/血漿', '全血', '尿液', '脊髓液',
                        '糞便', 'Ser/Plas', 'BLD', 'Urine').
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.search_by_specimen(specimen_type)


@audited("find_related_loinc_tests")
async def find_related_loinc_tests(component: str) -> str:
    """
    Find all LOINC tests that measure the same analyte (component), grouped by specimen system.
    Useful for discovering all variants of a test (e.g., all glucose measurements across
    different timing and specimen types).

    Args:
        component: Analyte/component name (e.g., 'Glucose', 'Creatinine', 'Hemoglobin',
                   'Cholesterol', 'Sodium').
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.find_related_tests(component)


@audited("get_loinc_detail")
async def get_loinc_detail(loinc_num: str) -> str:
    """
    Get the complete LOINC concept record for a single LOINC code.

    Returns all six LOINC axes (Component, Property, Time Aspect, System,
    Scale Type, Method Type), specimen type, long common name, short name,
    display name, LOINC class, and status (active/deprecated). Useful when
    you need to understand exactly what a LOINC code measures and how.

    Args:
        loinc_num: LOINC code in 'NNNNN-N' format
                   (e.g., '2345-7' for glucose in serum/plasma,
                    '4548-4' for HbA1c, '718-7' for haemoglobin in blood).
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.get_patient_friendly_name(loinc_num)


@audited("batch_interpret_lab_results")
async def batch_interpret_lab_results(
    results_json: str, age: int, gender: str = "all"
) -> str:
    """
    Interpret multiple lab results at once against their reference ranges.

    Processes a list of LOINC code + value pairs and returns High/Normal/Low
    interpretation for each, along with the applicable reference range. More
    efficient than calling interpret_lab_result repeatedly.

    ⚠️ Reference values are for general guidance. Always interpret in clinical
    context with a licensed healthcare professional.

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
async def search_clinical_guideline(keyword: str) -> str:
    """
    Search Taiwan clinical practice guidelines by disease name or ICD-10 code.

    Returns matching guidelines with their associated ICD-10 code, guideline title,
    and issuing medical society. Data is sourced from Taiwan Medical Society
    guidelines (seed data — manually curated, covers common chronic conditions
    such as diabetes, hypertension, dyslipidaemia, CKD).
    Use get_complete_guideline to retrieve the full content for a specific guideline.

    Args:
        keyword: Disease name in Chinese or English, or ICD-10 code
                 (e.g., '糖尿病', 'E11', '高血壓', 'I10', 'dyslipidaemia', 'E78').
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.search_guideline(keyword)


@audited("get_complete_guideline")
async def get_complete_guideline(icd_code: str) -> str:
    """
    Get the complete Taiwan clinical guideline for a disease by ICD-10 code.

    Returns the full guideline in one call: diagnostic criteria, first-line
    and second-line medication recommendations (with drug classes and notes),
    recommended lab tests and monitoring schedule, and treatment targets.
    Use search_clinical_guideline to find the correct ICD-10 code first.

    Args:
        icd_code: ICD-10 code for the disease (e.g., 'E11' for type 2 diabetes,
                  'I10' for hypertension, 'E78' for dyslipidaemia, 'N18' for CKD).
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.get_complete_guideline(icd_code)


@audited("get_medication_recommendations")
async def get_medication_recommendations(icd_code: str) -> str:
    """
    Get Taiwan guideline medication recommendations for a specific diagnosis.

    Returns drug classes, individual drugs, line of therapy (first-line,
    second-line, add-on), dosing notes, and special population considerations
    as documented in the Taiwan clinical guideline for that condition.

    ⚠️ Always verify with a licensed clinician before making prescribing decisions.

    Args:
        icd_code: ICD-10 code (e.g., 'I10' for hypertension, 'E11' for type 2
                  diabetes, 'E78' for dyslipidaemia).
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.get_medication_recommendations(icd_code)


@audited("get_test_recommendations")
async def get_test_recommendations(icd_code: str) -> str:
    """
    Get recommended lab tests and examinations for a diagnosis per Taiwan guidelines.

    Returns a list of recommended investigations including lab tests (with LOINC
    codes where available), imaging studies, and other examinations, along with
    their recommended frequency/timing as documented in the Taiwan guideline.

    Args:
        icd_code: ICD-10 code (e.g., 'E11' for type 2 diabetes, 'N18' for CKD,
                  'I10' for hypertension).
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.get_test_recommendations(icd_code)


@audited("get_treatment_goals")
async def get_treatment_goals(icd_code: str) -> str:
    """
    Get quantitative treatment targets for a diagnosis per Taiwan clinical guidelines.

    Returns specific numeric targets (e.g., HbA1c < 7%, BP < 130/80 mmHg,
    LDL-C < 70 mg/dL) and qualitative goals documented in the Taiwan guideline
    for the given condition. Targets may differ by subgroup or comorbidity.

    ⚠️ Individual treatment targets should be determined by a licensed clinician.

    Args:
        icd_code: ICD-10 code (e.g., 'E11' for type 2 diabetes, 'I10' for
                  hypertension, 'E78' for dyslipidaemia, 'N18' for CKD).
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.get_treatment_goals(icd_code)


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
    return await guideline_service.check_medication_contraindications(
        icd_code, medication_class
    )


@audited("link_guideline_to_drugs")
async def link_guideline_to_drugs(icd_code: str) -> str:
    """
    Cross-reference Taiwan guideline drug recommendations with FDA licensed products.

    For each drug class or drug name mentioned in the guideline for the given
    diagnosis, searches the Taiwan FDA drug database to find licensed products
    available in Taiwan. Returns the guideline recommendation alongside matching
    Taiwan FDA license records.

    Args:
        icd_code: ICD-10 code (e.g., 'E11' for type 2 diabetes, 'I10' for
                  hypertension, 'E78' for dyslipidaemia).
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.link_guideline_to_drugs(icd_code)


@audited("suggest_clinical_pathway")
async def suggest_clinical_pathway(
    icd_code: str, patient_context_json: str | None = None
) -> str:
    """
    Suggest a step-by-step clinical management pathway based on Taiwan guidelines.

    Generates an ordered clinical pathway (initial assessment → diagnosis →
    first-line treatment → monitoring → escalation) by synthesising the guideline
    content for the given diagnosis. Optionally personalises the pathway when
    patient context is provided (e.g., adjusts drug recommendations based on
    comorbidities or age).

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
    return await guideline_service.suggest_clinical_pathway(icd_code, context)


# ============================================================
# Group 10: TWCore IG
# ============================================================


@audited("list_twcore_codesystems")
async def list_twcore_codesystems(category: str = "all") -> str:
    """
    List all CodeSystems defined in the Taiwan Core FHIR Implementation Guide (TWCore IG).

    TWCore IG v1.0.0 defines 30+ CodeSystems covering Taiwan NHI-specific code sets
    including drug frequency codes, diagnosis category codes, organization types,
    administrative divisions, and medical specialty codes used in Taiwan's national
    health information exchange infrastructure.

    Args:
        category: Filter by category — 'all' (default) | 'medication' |
                  'diagnosis' | 'organization' | 'administrative'.
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    return await twcore_service.list_codesystems(category)


@audited("search_twcore_code")
async def search_twcore_code(keyword: str, codesystem_ids: list[str]) -> str:
    """
    Search for a code or display term across one or more TWCore IG CodeSystems.

    Performs a case-insensitive search across both code values and display names
    within the specified CodeSystems. Returns matching codes with their system URL,
    code, and display name as a FHIR Coding object. Use list_twcore_codesystems
    to find available CodeSystem IDs.

    Args:
        keyword: Code value or display term to search for
                 (e.g., 'QD', '每天一次', 'HOSP', '醫院').
        codesystem_ids: List of CodeSystem IDs to search within, obtained from
                        list_twcore_codesystems (e.g.,
                        ['medication-frequency-nhi-tw',
                         'organization-identifier-tw']).
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    return await twcore_service.search_code(keyword, codesystem_ids)


@audited("lookup_twcore_code")
async def lookup_twcore_code(code: str, codesystem_id: str) -> str:
    """
    Exact lookup of a single code in a TWCore IG CodeSystem. Returns a FHIR Coding.

    Retrieves the FHIR Coding object (system URL, code, display) for an exact
    code match. Use this when you have a known code and need the full FHIR
    representation for inclusion in a FHIR resource.

    Args:
        code: The exact code value to look up (e.g., 'QD', 'BID', 'HOSP').
        codesystem_id: TWCore IG CodeSystem ID from list_twcore_codesystems
                       (e.g., 'medication-frequency-nhi-tw').
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    return await twcore_service.lookup_code(code, codesystem_id)


# ============================================================
# Group 11: SNOMED CT
# ============================================================


@audited("search_snomed_concept")
async def search_snomed_concept(
    query: str,
    limit: int = 20,
    hierarchy_filter: int = None,
) -> str:
    """
    Search SNOMED CT International edition (20250601, 370,000+ concepts) by English term.

    Performs full-text search across all SNOMED descriptions (FSNs and synonyms),
    ranking Fully Specified Names (FSNs) above synonyms. Results include concept ID,
    preferred term, term type (FSN/Synonym), and active status.
    Use get_snomed_concept for full details (parents, mappings) of a specific result.

    Args:
        query: English clinical term (e.g., 'diabetes mellitus', 'myocardial
               infarction', 'hypertension', 'fracture of femur').
        limit: Maximum number of results to return (default 20, max 100).
        hierarchy_filter: Optional SNOMED concept ID to restrict search to a
                          specific hierarchy. Common roots:
                          404684003 (Clinical finding),
                          71388002 (Procedure),
                          373873005 (Pharmaceutical/biologic product),
                          123037004 (Body structure).
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
    Get full details for a SNOMED CT concept by concept ID.

    Returns: Fully Specified Name (FSN), all active synonyms, active status,
    direct parent concepts (IS-A relationships, up to 20), and all ICD-10
    extended map entries (map target code, map rule, map group/priority).

    Args:
        concept_id: SNOMED CT concept ID (integer)
                    (e.g., 73211009 for 'Diabetes mellitus',
                     38341003 for 'Hypertensive disorder',
                     22298006 for 'Myocardial infarction').
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


@audited("get_snomed_children")
async def get_snomed_children(concept_id: int, limit: int = 50) -> str:
    """
    Get the direct child concepts of a SNOMED CT concept in the IS-A hierarchy.

    Returns concepts that have an active IS-A relationship pointing to the given
    concept — i.e., concepts that are a subtype of this concept. Useful for
    navigating from a general concept to more specific subtypes.

    Args:
        concept_id: SNOMED CT concept ID of the parent concept
                    (e.g., 73211009 for 'Diabetes mellitus' to get its subtypes
                     such as type 1, type 2, gestational diabetes).
        limit: Maximum number of child concepts to return (default 50, max 200).
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
    Get all ancestor concepts of a SNOMED CT concept by traversing IS-A upward.

    Follows IS-A relationships from the given concept toward the SNOMED root,
    returning all ancestors up to `max_depth` levels up. Each ancestor includes
    its depth relative to the starting concept. Useful for understanding the
    full classification path and finding parent categories for grouping.

    Args:
        concept_id: SNOMED CT concept ID (e.g., 44054006 for 'Diabetes mellitus
                    type 2' to see its full hierarchy up to 'Clinical finding').
        max_depth: Maximum number of IS-A hops to traverse upward
                   (default 10, max 20).
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
    Find SNOMED CT concepts that map to a given ICD-10 code via SNOMED extended map.

    Uses the SNOMED CT ICD-10 extended map (part of the International release)
    to find all SNOMED concepts whose map target includes the given ICD-10 code.
    Each result includes the SNOMED concept ID, FSN, and map rule/advice that
    defines when the mapping applies.

    Args:
        icd_code: ICD-10-CM or ICD-10 code to reverse-map from
                  (e.g., 'E11.9', 'I10', 'E78.5'). Case-insensitive.
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    results = await snomed_service.map_icd_to_snomed(icd_code)
    return json.dumps(
        {"icd_code": icd_code.upper(), "snomed_concepts": results},
        ensure_ascii=False,
        indent=2,
    )


@audited("map_snomed_to_icd")
async def map_snomed_to_icd(concept_id: int) -> str:
    """
    Get all ICD-10 codes that a SNOMED CT concept maps to via the extended map.

    Returns all map entries for the concept including map target (ICD-10 code),
    map rule (condition under which the mapping applies, e.g., 'TRUE', or a
    clinical condition), map advice, and map group/priority for complex mappings
    where multiple rules must be evaluated in sequence.

    Args:
        concept_id: SNOMED CT concept ID (e.g., 73211009 for 'Diabetes mellitus',
                    38341003 for 'Hypertensive disorder').
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
# Group 12: Drug Interactions (RxNorm)
# ============================================================


@audited("check_drug_interactions")
async def check_drug_interactions(drug_names: list[str]) -> str:
    """
    Check for drug-drug interactions among a list of drugs using RxNorm interaction data.

    Resolves each drug name to its RxCUI, then queries RxNorm
    `interacts_with` relationships to identify known interaction pairs.
    Returns each interacting pair with the RxNorm interaction concept.

    ⚠️ RxNorm interaction data indicates potential interactions but does NOT include
    severity ratings or clinical significance. All findings must be verified by
    a licensed pharmacist or clinician before clinical use.

    Args:
        drug_names: List of 2 or more drug names in English — generic (INN) or
                    brand name (e.g., ['warfarin', 'aspirin', 'metformin'],
                    ['Lipitor', 'amiodarone']). Minimum 2 drugs required.
    """
    if drug_interaction_service is None:
        return _svc_unavailable("Drug Interactions (RxNorm)")
    if not drug_names or len(drug_names) < 2:
        return json.dumps(
            {"error": "Provide at least 2 drug names to check for interactions"},
            ensure_ascii=False,
        )
    result = await drug_interaction_service.check_interactions(drug_names)
    if isinstance(result, str):
        return result  # Already JSON string from cache
    return json.dumps(result, ensure_ascii=False, indent=2)


@audited("resolve_rxnorm_drug")
async def resolve_rxnorm_drug(drug_name: str) -> str:
    """
    Resolve a drug name to its RxNorm concepts (RXCUI, term type, synonym variants).

    Searches the RxNorm database (NLM) for concepts matching the drug name.
    Returns a list of matching RxNorm concepts with RXCUI identifiers and term
    types (IN = ingredient, BN = brand name, SCD = clinical drug, etc.).
    Use the RXCUI from this result with get_drug_ingredients_rxnorm or
    check_drug_interactions. Supports English names only (generic or brand).

    Args:
        drug_name: Drug name in English — generic (INN) or brand name
                   (e.g., 'atorvastatin', 'Lipitor', 'metformin', 'Glucophage').
    """
    if drug_interaction_service is None:
        return _svc_unavailable("Drug Interactions (RxNorm)")
    results = await drug_interaction_service.resolve_drug(drug_name)
    return json.dumps(
        {"query": drug_name, "rxnorm_concepts": results},
        ensure_ascii=False,
        indent=2,
    )


@audited("get_drug_ingredients_rxnorm")
async def get_drug_ingredients_rxnorm(rxcui: str) -> str:
    """
    Get the active ingredient components of a drug concept via RxNorm relationships.

    Follows RxNorm `has_ingredient` and `has_precise_ingredient` relationships
    to list all ingredient concepts associated with the given RXCUI. Useful for
    determining the active substances in a multi-ingredient product or for
    verifying that two drugs share the same ingredient.

    Args:
        rxcui: RxNorm Concept Unique Identifier (string) obtained from
               resolve_rxnorm_drug (e.g., '41493' for atorvastatin,
               '6809' for metformin).
    """
    if drug_interaction_service is None:
        return _svc_unavailable("Drug Interactions (RxNorm)")
    result = await drug_interaction_service.get_drug_ingredients(rxcui)
    if result is None:
        return json.dumps({"error": f"RXCUI {rxcui} not found"}, ensure_ascii=False)
    if isinstance(result, str):
        return result  # Already JSON string from cache
    return json.dumps(result, ensure_ascii=False, indent=2)


# ============================================================
# Service → tool mapping (used by DynamicFastMCP for add/remove)
# health_check is always registered via @mcp.tool() and is excluded here.
# ============================================================

SERVICE_TOOLS: dict[str, list[tuple[Callable, str]]] = {
    "icd": [
        (search_medical_codes, "search_medical_codes"),
        (infer_complications, "infer_complications"),
        (get_nearby_codes, "get_nearby_codes"),
        (check_medical_conflict, "check_medical_conflict"),
        (browse_icd_category, "browse_icd_category"),
    ],
    "drug": [
        (search_drug_info, "search_drug_info"),
        (get_drug_details, "get_drug_details"),
        (identify_unknown_pill, "identify_unknown_pill"),
        (search_drug_by_atc, "search_drug_by_atc"),
        (search_drug_by_ingredient, "search_drug_by_ingredient"),
    ],
    "health_food": [
        (search_health_food, "search_health_food"),
        (get_health_food_details, "get_health_food_details"),
        (analyze_health_support_for_condition, "analyze_health_support_for_condition"),
    ],
    "food_nutrition": [
        (search_food_nutrition, "search_food_nutrition"),
        (get_detailed_nutrition, "get_detailed_nutrition"),
        (search_food_ingredient, "search_food_ingredient"),
        (get_ingredients_by_category, "get_ingredients_by_category"),
        (search_foods_by_nutrient, "search_foods_by_nutrient"),
        (analyze_meal_nutrition, "analyze_meal_nutrition"),
    ],
    "fhir_condition": [
        (create_fhir_condition, "create_fhir_condition"),
        (create_fhir_condition_from_diagnosis, "create_fhir_condition_from_diagnosis"),
        (validate_fhir_condition, "validate_fhir_condition"),
    ],
    "fhir_medication": [
        (search_medication_fhir, "search_medication_fhir"),
        (create_fhir_medication, "create_fhir_medication"),
        (create_fhir_medication_from_drug, "create_fhir_medication_from_drug"),
        (validate_fhir_medication, "validate_fhir_medication"),
    ],
    "lab": [
        (search_loinc_code, "search_loinc_code"),
        (list_lab_categories, "list_lab_categories"),
        (get_reference_range, "get_reference_range"),
        (interpret_lab_result, "interpret_lab_result"),
        (search_loinc_by_specimen, "search_loinc_by_specimen"),
        (find_related_loinc_tests, "find_related_loinc_tests"),
        (get_loinc_detail, "get_loinc_detail"),
        (batch_interpret_lab_results, "batch_interpret_lab_results"),
    ],
    "guideline": [
        (search_clinical_guideline, "search_clinical_guideline"),
        (get_complete_guideline, "get_complete_guideline"),
        (get_medication_recommendations, "get_medication_recommendations"),
        (get_test_recommendations, "get_test_recommendations"),
        (get_treatment_goals, "get_treatment_goals"),
        (check_medication_contraindications, "check_medication_contraindications"),
        (link_guideline_to_drugs, "link_guideline_to_drugs"),
        (suggest_clinical_pathway, "suggest_clinical_pathway"),
    ],
    "twcore": [
        (list_twcore_codesystems, "list_twcore_codesystems"),
        (search_twcore_code, "search_twcore_code"),
        (lookup_twcore_code, "lookup_twcore_code"),
    ],
    "snomed": [
        (search_snomed_concept, "search_snomed_concept"),
        (get_snomed_concept, "get_snomed_concept"),
        (get_snomed_children, "get_snomed_children"),
        (get_snomed_ancestors, "get_snomed_ancestors"),
        (get_snomed_relationships, "get_snomed_relationships"),
        (map_icd_to_snomed, "map_icd_to_snomed"),
        (map_snomed_to_icd, "map_snomed_to_icd"),
    ],
    "rxnorm": [
        (check_drug_interactions, "check_drug_interactions"),
        (resolve_rxnorm_drug, "resolve_rxnorm_drug"),
        (get_drug_ingredients_rxnorm, "get_drug_ingredients_rxnorm"),
    ],
}


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
