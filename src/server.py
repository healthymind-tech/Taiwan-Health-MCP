import asyncio
import inspect
import json
from contextlib import asynccontextmanager
from typing import Callable

from mcp.server.fastmcp import FastMCP

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

    return ApiErrorLoggingMiddleware(app)


# ============================================================
# Health check
# ============================================================


@mcp.tool()
async def health_check() -> str:
    """Returns server health status and which services are available."""
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
    Search for ICD-10-CM (Diagnosis) or ICD-10-PCS (Procedure) codes.

    Args:
        keyword: Search term (e.g., 'Diabetes', 'E11', '子宮內膜異位').
        type: Filter by 'diagnosis', 'procedure', or 'all'. Default is 'all'.
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.search_codes(keyword, type)


@audited("infer_complications")
async def infer_complications(code: str) -> str:
    """
    Infers potential complications or specific sub-conditions based on ICD hierarchy.

    Args:
        code: The base diagnosis code (e.g., 'E11', 'N80').
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.infer_complications(code)


@audited("get_nearby_codes")
async def get_nearby_codes(code: str) -> str:
    """
    Retrieves codes immediately preceding and following the target code.

    Args:
        code: The target diagnosis code.
    """
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.get_nearby_codes(code)


@audited("check_medical_conflict")
async def check_medical_conflict(diagnosis_code: str, procedure_code: str) -> str:
    """
    Retrieves and compares a diagnosis code (ICD-10-CM) and a procedure code (ICD-10-PCS)
    to provide structured data for medical conflict analysis.

    Args:
        diagnosis_code: ICD-10-CM diagnosis code (e.g., 'K35.80').
        procedure_code: ICD-10-PCS procedure code (e.g., '0DTJ0ZZ').
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
    Browse ICD-10-CM diagnosis codes by category.
    Call with no arguments to list all categories; provide a category code to list its codes.

    Args:
        category: 3-character ICD category (e.g., 'E11', 'I10'). Omit to list all categories.
        limit: Max codes to return per category (default 50, max 200).
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
    Search for Taiwan FDA approved drugs by name (Chinese/English) or indication.

    Args:
        keyword: Drug name or symptom (e.g., 'Panadol', '普拿疼', '頭痛').
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.search_drug(keyword)


@audited("get_drug_details")
async def get_drug_details(license_id: str) -> str:
    """
    Get comprehensive details for a specific drug license ID including ingredients,
    usage, appearance, and package insert links.

    Args:
        license_id: The license ID from search results (e.g., '衛部藥製字第058498號').
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.get_drug_details_by_license(license_id)


@audited("identify_unknown_pill")
async def identify_unknown_pill(features: str) -> str:
    """
    Identify a pill based on visual features (shape, color, markings).

    Args:
        features: Keywords describing the pill (e.g., 'white circle YP', 'oval pink').
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.identify_pill(features)


@audited("search_drug_by_atc")
async def search_drug_by_atc(query: str) -> str:
    """
    Search Taiwan FDA approved drugs by ATC (Anatomical Therapeutic Chemical) code or class name.

    Args:
        query: ATC code prefix (e.g., 'A10', 'C09') or therapeutic class name
               (e.g., 'paracetamol', 'metformin', 'antihypertensives').
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    return await drug_service.search_by_atc(query)


@audited("search_drug_by_ingredient")
async def search_drug_by_ingredient(ingredient_name: str) -> str:
    """
    Find Taiwan FDA approved drugs containing a specific active ingredient.

    Args:
        ingredient_name: Ingredient name in Chinese or English
                         (e.g., 'metformin', '二甲雙胍', 'aspirin', '阿斯匹林').
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
    Search for Taiwan FDA approved health foods by name or health benefit.

    Args:
        keyword: Product name or health benefit (e.g., '靈芝', '調節血脂', '護肝').
    """
    if health_food_service is None:
        return _svc_unavailable("Health Food Service")
    return await health_food_service.search_health_food(keyword)


@audited("get_health_food_details")
async def get_health_food_details(permit_no: str) -> str:
    """
    Get comprehensive details for a specific health food by permit number.

    Args:
        permit_no: The permit number from search results (e.g., '衛部健食字第A00123號').
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
    Search for nutritional information of foods from Taiwan's food composition database.

    Args:
        food_name: Name of the food (e.g., '白米', '雞蛋', 'chicken breast').
        nutrient: Optional specific nutrient filter (e.g., '粗蛋白', '鈣').
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_nutrition(food_name, nutrient)


@audited("get_detailed_nutrition")
async def get_detailed_nutrition(food_name: str) -> str:
    """
    Get comprehensive nutritional breakdown for a specific food item.

    Args:
        food_name: The specific food name (e.g., '糙米', '雞胸肉').
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.get_detailed_nutrition(food_name)


@audited("search_food_ingredient")
async def search_food_ingredient(keyword: str) -> str:
    """
    Search for food ingredients/materials in Taiwan's regulatory database.

    Args:
        keyword: Ingredient name in Chinese or English (e.g., '薑黃', 'turmeric').
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_food_ingredient(keyword)


@audited("get_ingredients_by_category")
async def get_ingredients_by_category(category: str) -> str:
    """
    Get all approved food ingredients in a specific category.

    Args:
        category: Category name (e.g., '香料植物', '食品添加物').
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
    Analyze the combined nutritional composition of multiple foods.

    Args:
        foods: List of food names (e.g., ['白米', '雞胸肉', '青花菜']).
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
    Integrated analysis: given a diagnosis, recommend Taiwan FDA-approved health foods
    and relevant dietary notes.

    ⚠️ Health foods are NOT medicine and cannot replace medical treatment.

    Args:
        diagnosis_keyword: Disease name or ICD-10 code (e.g., 'E11', '糖尿病', 'hypertension').
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
    Convert an ICD-10-CM code to a FHIR R4 Condition resource.

    Args:
        icd_code: ICD-10-CM code (e.g., 'E11.9').
        patient_id: Patient identifier (e.g., 'patient-001').
        clinical_status: active | inactive | resolved | remission
        verification_status: confirmed | provisional | differential | refuted
        category: encounter-diagnosis | problem-list-item
        severity: mild | moderate | severe (optional)
        onset_date: YYYY-MM-DD (optional)
        recorded_date: YYYY-MM-DDTHH:MM:SS+08:00 (optional)
        additional_notes: Free text note (optional)
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
    Search by disease keyword and auto-create a FHIR Condition resource.

    Args:
        diagnosis_keyword: Disease name or keyword (e.g., '第二型糖尿病', 'Diabetes').
        patient_id: Patient identifier.
        clinical_status: active | inactive | resolved | remission
        verification_status: confirmed | provisional | differential | refuted
        severity: mild | moderate | severe (optional)
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
    Validate a FHIR R4 Condition resource against required field rules.

    Args:
        condition_json: JSON string of the FHIR Condition resource.
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
    Search drugs and auto-create a FHIR Medication or MedicationKnowledge resource.

    Args:
        keyword: Drug name (e.g., 'Metformin', '二甲雙胍').
        resource_type: 'Medication' or 'MedicationKnowledge'
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
    Create a FHIR R4 Medication resource from a Taiwan FDA license ID.

    Args:
        license_id: Taiwan FDA drug license ID (e.g., '衛部藥製字第058498號').
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    result = await fhir_medication_service.create_medication(license_id)
    return fhir_medication_service.to_json_string(result, indent=2)


@audited("create_fhir_medication_knowledge")
async def create_fhir_medication_from_drug(license_id: str) -> str:
    """
    Create a FHIR R4 MedicationKnowledge resource (includes ATC, dosage, indication).

    Args:
        license_id: Taiwan FDA drug license ID.
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    result = await fhir_medication_service.create_medication_knowledge(license_id)
    return fhir_medication_service.to_json_string(result, indent=2)


@audited("validate_fhir_medication")
async def validate_fhir_medication(medication_json: str) -> str:
    """
    Validate a FHIR Medication or MedicationKnowledge resource.

    Args:
        medication_json: JSON string of the FHIR resource.
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
    Search LOINC codes (Taiwan lab tests mapped to international standard).

    Args:
        keyword: Test name or abbreviation (e.g., '血糖', 'HbA1c', 'WBC', 'Glucose').
        category: Optional class filter (e.g., '血液常規', 'CHEM').
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.search_loinc_code(keyword, category)


@audited("list_lab_categories")
async def list_lab_categories() -> str:
    """List all available lab test categories."""
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.list_categories()


@audited("get_reference_range")
async def get_reference_range(loinc_code: str, age: int, gender: str = "all") -> str:
    """
    Get lab reference range for a specific LOINC code, age, and gender.

    Args:
        loinc_code: LOINC code (e.g., '1558-6' for fasting glucose).
        age: Patient age in years.
        gender: 'M' (male) | 'F' (female) | 'all' (default)
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.get_reference_range(loinc_code, age, gender)


@audited("interpret_lab_result")
async def interpret_lab_result(
    loinc_code: str, value: float, age: int, gender: str = "all"
) -> str:
    """
    Interpret a lab result by comparing to reference range (high/normal/low).

    Args:
        loinc_code: LOINC code.
        value: Measured value.
        age: Patient age.
        gender: 'M' | 'F' | 'all'
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.interpret_lab_result(loinc_code, value, age, gender)


@audited("search_loinc_by_specimen")
async def search_loinc_by_specimen(specimen_type: str) -> str:
    """
    Find LOINC lab tests by specimen/sample type.

    Args:
        specimen_type: Specimen type in Chinese or English
                       (e.g., '血清/血漿', '全血', 'Urine', 'Ser/Plas', 'Bld').
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
    Get full LOINC concept detail including all axes: component, property, time_aspect,
    system, scale_type, method_type, specimen_type, and patient-friendly display name.

    Args:
        loinc_num: LOINC code (e.g., '2345-7' for serum glucose).
    """
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.get_patient_friendly_name(loinc_num)


@audited("batch_interpret_lab_results")
async def batch_interpret_lab_results(
    results_json: str, age: int, gender: str = "all"
) -> str:
    """
    Batch-interpret multiple lab results at once.

    Args:
        results_json: JSON array: [{"loinc_code": "1558-6", "value": 126}, ...]
        age: Patient age.
        gender: 'M' | 'F' | 'all'
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
    Search Taiwan Medical Society clinical practice guidelines.

    Args:
        keyword: Disease name or ICD-10 code (e.g., '糖尿病', 'E11').
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.search_guideline(keyword)


@audited("get_complete_guideline")
async def get_complete_guideline(icd_code: str) -> str:
    """
    Get the full clinical guideline for a disease: diagnosis, medications,
    lab tests, and treatment goals.

    Args:
        icd_code: ICD-10 code (e.g., 'E11').
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.get_complete_guideline(icd_code)


@audited("get_medication_recommendations")
async def get_medication_recommendations(icd_code: str) -> str:
    """
    Get medication recommendations for a specific diagnosis.

    Args:
        icd_code: ICD-10 code (e.g., 'I10' for hypertension).
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.get_medication_recommendations(icd_code)


@audited("get_test_recommendations")
async def get_test_recommendations(icd_code: str) -> str:
    """
    Get recommended lab tests and examinations for a specific diagnosis.

    Args:
        icd_code: ICD-10 code.
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.get_test_recommendations(icd_code)


@audited("get_treatment_goals")
async def get_treatment_goals(icd_code: str) -> str:
    """
    Get treatment targets and goals for a specific diagnosis.

    Args:
        icd_code: ICD-10 code.
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.get_treatment_goals(icd_code)


@audited("check_medication_contraindications")
async def check_medication_contraindications(
    icd_code: str, medication_class: str
) -> str:
    """
    Check guideline contraindications for a specific medication class in the context
    of a diagnosis. Returns matching recommendations and all contraindications for that disease.

    ⚠️ Always verify with a licensed clinician before making prescribing decisions.

    Args:
        icd_code: Diagnosis ICD-10 code (e.g., 'E11' for type 2 diabetes).
        medication_class: Medication class or drug name to check
                          (e.g., 'SGLT2抑制劑', 'Metformin', 'ACE抑制劑').
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.check_medication_contraindications(
        icd_code, medication_class
    )


@audited("link_guideline_to_drugs")
async def link_guideline_to_drugs(icd_code: str) -> str:
    """
    Cross-reference clinical guideline medication recommendations with Taiwan FDA
    approved drug licenses. Shows which guideline-recommended drugs have licensed
    products available in Taiwan.

    Args:
        icd_code: ICD-10 code (e.g., 'E11', 'I10', 'E78').
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.link_guideline_to_drugs(icd_code)


@audited("suggest_clinical_pathway")
async def suggest_clinical_pathway(
    icd_code: str, patient_context_json: str | None = None
) -> str:
    """
    Suggest a step-by-step clinical pathway based on Taiwan guidelines.

    Args:
        icd_code: ICD-10 code.
        patient_context_json: Optional JSON with patient context (age, comorbidities, etc.).
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
    List all available TWCore IG CodeSystems.

    Args:
        category: all | medication | diagnosis | organization | administrative
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    return await twcore_service.list_codesystems(category)


@audited("search_twcore_code")
async def search_twcore_code(keyword: str, codesystem_ids: list[str]) -> str:
    """
    Search for a code across one or more TWCore CodeSystems.

    Args:
        keyword: Code or display term to search.
        codesystem_ids: List of CodeSystem IDs to search (from list_twcore_codesystems).
    """
    if twcore_service is None:
        return _svc_unavailable("TWCore Service")
    return await twcore_service.search_code(keyword, codesystem_ids)


@audited("lookup_twcore_code")
async def lookup_twcore_code(code: str, codesystem_id: str) -> str:
    """
    Exact lookup of a single code in a TWCore CodeSystem.
    Returns a FHIR Coding object.

    Args:
        code: The code to look up.
        codesystem_id: The CodeSystem ID (e.g., 'medication-frequency-nhi-tw').
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
    Search SNOMED CT International edition concepts by English term.

    Args:
        query: Search term (e.g., 'diabetes mellitus', 'myocardial infarction').
        limit: Maximum results (default 20, max 100).
        hierarchy_filter: Optional SNOMED concept ID to restrict results to that
                          hierarchy (e.g., 404684003 for Clinical findings).
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
    Get full details for a SNOMED CT concept: FSN, synonyms, parents, ICD-10 mappings.

    Args:
        concept_id: SNOMED CT concept ID (e.g., 73211009 for 'Diabetes mellitus').
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
    Get direct child concepts (IS-A relationships pointing to this concept).

    Args:
        concept_id: SNOMED CT concept ID.
        limit: Maximum children to return (default 50).
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
    Get all ancestor concepts by following IS-A relationships upward.

    Args:
        concept_id: SNOMED CT concept ID.
        max_depth: Maximum traversal depth (default 10).
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
    Get all non-IS-A relationships for a SNOMED CT concept (attributes that describe
    clinical meaning: finding site, causative agent, associated morphology, has ingredient, etc.).

    Args:
        concept_id: SNOMED CT concept ID.
        relationship_type_id: Optional SNOMED relationship type concept ID to filter
                              (e.g., 246075003 = Causative agent,
                                     127489000 = Has active ingredient,
                                     363698007 = Finding site,
                                     116676008 = Associated morphology).
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
    Find SNOMED CT concepts that map to a given ICD-10 code (via extended map).

    Args:
        icd_code: ICD-10 code (e.g., 'E11.9', 'I10').
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
    Get all ICD-10 codes that a SNOMED CT concept maps to.

    Args:
        concept_id: SNOMED CT concept ID.
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
    Check for drug-drug interactions among a list of drugs using RxNorm data.

    Args:
        drug_names: List of drug names (generic or brand; e.g., ['warfarin', 'aspirin', 'metformin']).
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
    Resolve a drug name to its RxNorm concepts (RXCUI and term type).

    Args:
        drug_name: Drug name in English (generic or brand; e.g., 'atorvastatin', 'Lipitor').
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
    Get a drug's ingredient components via RxNorm.

    Args:
        rxcui: RxNorm concept unique identifier (from resolve_rxnorm_drug).
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
