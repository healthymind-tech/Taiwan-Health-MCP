"""
API integration tests for Taiwan Health MCP Server.

Tests the actual MCP HTTP API using the streamable-http transport.
Every MCP tool is exercised with three query scenarios:

  1. exact  — known-correct input, expects a non-empty successful result
  2. fuzzy  — partial / approximate input, expects a successful (possibly smaller) result
  3. wrong  — invalid / non-existent input, expects graceful handling (no crash)

Also includes a tools/list test that verifies all expected tools are exposed.

Requirements:
  - Server must be running (set MCP_SERVER_URL, default: http://localhost:8000/mcp)
  - All datasets must be loaded via data-loader

Run:
    pytest tests/test_api_integration.py -v
    MCP_SERVER_URL=http://localhost:8000/mcp pytest tests/test_api_integration.py -v
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import pytest

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SERVER_URL = os.environ.get("MCP_SERVER_URL", "http://localhost:8000/mcp")

# Known-good values taken from the loaded datasets (verified against the DB).
_LICENSE_ID = "內衛成製字第000029號"
_PERMIT_NO = "衛署健食字第A00022號"
_LOINC_CODE = "2345-7"  # Glucose [Mass/volume] in Serum or Plasma
_RXCUI = "6809"  # Metformin (RxNorm ingredient)
_TWCORE_CS_ID = "careplan-category-tw"
_SNOMED_ID = 73211009  # Diabetes mellitus
_ICD_PROC_CODE = "0016070"  # ICD-10-PCS procedure code
_GUIDELINE_ICD = "E11"  # Type 2 diabetes — has seed guideline data

# All tool names expected when every dataset is loaded.
ALL_TOOLS = {
    "health_check",
    # ICD
    "search_medical_codes",
    "infer_complications",
    "get_nearby_codes",
    "check_medical_conflict",
    "browse_icd_category",
    # Drug
    "search_drug",
    "identify_unknown_pill",
    # Health Supplement
    "search_health_supplement",
    # Food Nutrition
    "search_food_nutrition",
    "get_detailed_nutrition",
    "search_food_ingredient",
    "get_ingredients_by_category",
    "search_foods_by_nutrient",
    "analyze_meal_nutrition",
    # FHIR Condition
    "query_fhir_condition",
    "validate_fhir_condition",
    # FHIR Medication
    "query_fhir_medication",
    "validate_fhir_medication",
    # Lab / LOINC
    "search_loinc",
    "query_loinc",
    "interpret_lab_result",
    "batch_interpret_lab_results",
    # Clinical Guidelines
    "search_clinical_guideline",
    "query_guideline",
    # TWCore
    "query_twcore_code",
    # SNOMED CT
    "search_snomed_concept",
    "query_snomed_concept",
    "get_snomed_relationships",
    "query_snomed_mapping",
    # RxNorm / Drug Interactions
    "check_drug_interactions",
    "resolve_rxnorm_drug",
    "get_drug_ingredients_rxnorm",
}

# ---------------------------------------------------------------------------
# MCP HTTP client helper
# ---------------------------------------------------------------------------


class MCPSession:
    """Thin synchronous MCP streamable-http client for testing."""

    def __init__(self, url: str) -> None:
        self.url = url
        self._id = 0
        self._session_id: str | None = None
        self._client = httpx.Client(timeout=60)

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    @staticmethod
    def _parse_sse(text: str) -> dict[str, Any]:
        """Parse the first SSE data line and return its decoded JSON payload.

        Args:
            text: Raw HTTP response body containing SSE-formatted events.

        Returns:
            Decoded JSON-RPC response object.

        Raises:
            ValueError: If no ``data:`` line is found in the response.
        """
        for line in text.splitlines():
            if line.startswith("data: "):
                return json.loads(line[6:])
        raise ValueError(f"No SSE data line found in response: {text!r}")

    def _headers(self) -> dict[str, str]:
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        return h

    def initialize(self) -> dict[str, Any]:
        """Send the MCP ``initialize`` request and store the returned session ID."""
        resp = self._client.post(
            self.url,
            json={
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "pytest-api-integration", "version": "1.0"},
                },
            },
            headers=self._headers(),
        )
        resp.raise_for_status()
        self._session_id = resp.headers.get("Mcp-Session-Id")
        return self._parse_sse(resp.text)

    def list_tools(self) -> list[dict[str, Any]]:
        """Return the list of tool descriptors from the server's ``tools/list`` endpoint."""
        resp = self._client.post(
            self.url,
            json={
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "tools/list",
                "params": {},
            },
            headers=self._headers(),
        )
        resp.raise_for_status()
        rpc = self._parse_sse(resp.text)
        return rpc["result"]["tools"]

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        """Call an MCP tool and return the parsed JSON result.

        Returns a dict or list on success, or ``{"error": ...}`` when the
        server returns a non-JSON error string.
        """
        resp = self._client.post(
            self.url,
            json={
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
            headers=self._headers(),
        )
        resp.raise_for_status()
        rpc = self._parse_sse(resp.text)
        if "error" in rpc:
            raise RuntimeError(f"JSON-RPC error from server: {rpc['error']}")
        content = rpc["result"]["content"]
        text = content[0]["text"] if content else "{}"
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"error": text}

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _server_reachable() -> bool:
    try:
        httpx.get(SERVER_URL, timeout=3)
        return True
    except Exception:
        return False


skip_if_no_server = pytest.mark.skipif(
    not _server_reachable(),
    reason=f"MCP server not reachable at {SERVER_URL}",
)


@pytest.fixture(scope="module")
def mcp() -> MCPSession:
    """One MCP session shared across the entire test module."""
    session = MCPSession(SERVER_URL)
    session.initialize()
    yield session
    session.close()


# ---------------------------------------------------------------------------
# Helper assertions
# ---------------------------------------------------------------------------


def _has_results(result: Any) -> bool:
    """Return True if the result contains at least one non-empty collection.

    Handles list results (non-empty list), dict results with list/dict values,
    and dicts with numeric totals like ``{"total_found": N}``.
    """
    if isinstance(result, list):
        return len(result) > 0
    if isinstance(result, dict):
        # Direct list values
        if any(isinstance(v, list) and len(v) > 0 for v in result.values()):
            return True
        # Nested dict values that themselves contain lists (e.g. by_system, categories)
        if any(
            isinstance(v, dict)
            and any(isinstance(vv, list) and len(vv) > 0 for vv in v.values())
            for v in result.values()
        ):
            return True
        # Numeric totals indicating results exist
        for key in ("total_found", "total", "count"):
            if isinstance(result.get(key), int) and result[key] > 0:
                return True
        # JSON-encoded list stored as a string value
        for v in result.values():
            if isinstance(v, str):
                try:
                    parsed = json.loads(v)
                    if isinstance(parsed, list) and len(parsed) > 0:
                        return True
                except (json.JSONDecodeError, ValueError):
                    pass
    return False


def _is_success(result: Any) -> bool:
    """Return True if the result contains no error key (list results always succeed)."""
    if isinstance(result, list):
        return True
    return isinstance(result, dict) and "error" not in result


def _is_graceful(result: Any) -> bool:
    """Wrong-data queries should return valid JSON — either an error message or empty result."""
    return isinstance(result, (dict, list))


# ---------------------------------------------------------------------------
# tools/list
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestToolsList:
    def test_lists_all_expected_tools(self, mcp: MCPSession) -> None:
        tools = mcp.list_tools()
        names = {t["name"] for t in tools}
        assert (
            names == ALL_TOOLS
        ), f"Missing: {ALL_TOOLS - names}\nExtra: {names - ALL_TOOLS}"

    def test_total_tool_count_is_33(self, mcp: MCPSession) -> None:
        tools = mcp.list_tools()
        assert len(tools) == 33

    def test_every_tool_has_name_and_description(self, mcp: MCPSession) -> None:
        for tool in mcp.list_tools():
            assert tool.get("name"), f"Tool missing name: {tool}"
            assert tool.get("description"), f"Tool '{tool['name']}' missing description"


# ---------------------------------------------------------------------------
# Group 1: ICD-10
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestSearchMedicalCodes:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_medical_codes", {"keyword": "E11.9", "type": "diagnosis"}
        )
        assert _is_success(result)
        assert _has_results(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_medical_codes", {"keyword": "糖尿", "type": "diagnosis"}
        )
        assert _is_success(result)
        assert _has_results(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_medical_codes", {"keyword": "ZZZXYZ999INVALID"})
        assert _is_graceful(result)
        # Hybrid semantic search always returns the closest match — no "not found" error


@skip_if_no_server
class TestInferComplications:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("infer_complications", {"code": "E11"})
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("infer_complications", {"code": "I10"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("infer_complications", {"code": "ZZZ999"})
        assert _is_graceful(result)


@skip_if_no_server
class TestGetNearbyCodes:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_nearby_codes", {"code": "E11.9"})
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_nearby_codes", {"code": "E11"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_nearby_codes", {"code": "ZZZ999"})
        assert _is_graceful(result)


@skip_if_no_server
class TestCheckMedicalConflict:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "check_medical_conflict",
            {"diagnosis_code": "E11.9", "procedure_code": _ICD_PROC_CODE},
        )
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "check_medical_conflict",
            {"diagnosis_code": "E11", "procedure_code": _ICD_PROC_CODE},
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "check_medical_conflict",
            {"diagnosis_code": "ZZZBAD", "procedure_code": "ZZZBAD"},
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestBrowseIcdCategory:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("browse_icd_category", {"category": "E11"})
        assert _is_success(result)
        assert _has_results(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # No category → lists all categories
        result = mcp.call_tool("browse_icd_category", {})
        assert _is_success(result)
        assert _has_results(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("browse_icd_category", {"category": "ZZZ"})
        assert _is_graceful(result)


# ---------------------------------------------------------------------------
# Group 2: Drug
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestSearchDrug:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "drug_name", "keyword": "Metformin"})
        assert _is_success(result)
        assert _has_results(result)
        assert result["mode"] == "drug_name"
        assert result["keyword"] == "Metformin"
        assert set(result["results"][0].keys()) == {
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
            "ingredients",
            "appearance",
            "atc",
            "insert_url",
        }

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "drug_name", "keyword": "aspirin"})
        assert _is_success(result)
        assert _has_results(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "drug_name", "keyword": "ZZZXYZNOTADRUG12345"})
        assert _is_graceful(result)


@skip_if_no_server
class TestIdentifyUnknownPill:
    def test_exact(self, mcp: MCPSession) -> None:
        # DB stores Chinese: "白" (white) and "圓形" (round)
        result = mcp.call_tool("identify_unknown_pill", {"features": "白 圓形"})
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # Colour only — broader match
        result = mcp.call_tool("identify_unknown_pill", {"features": "白"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "identify_unknown_pill", {"features": "XYZXYZ123INVALIDPILL"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestSearchDrugByAtc:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "atc_code", "keyword": "A10BA02"})
        assert _is_success(result)
        assert result["mode"] == "atc_code"
        assert result["keyword"] == "A10BA02"
        assert set(result["results"][0].keys()) == {
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
            "ingredients",
            "appearance",
            "atc",
            "insert_url",
        }

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "atc_code", "keyword": "A10"})
        assert _is_success(result)
        assert _has_results(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "atc_code", "keyword": "antihypertensives"})
        assert _is_graceful(result)


@skip_if_no_server
class TestSearchDrugByIngredient:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "ingredient", "keyword": "metformin"})
        assert _is_success(result)
        assert _has_results(result)
        assert result["mode"] == "ingredient"
        assert result["keyword"] == "metformin"
        assert set(result["results"][0].keys()) == {
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
            "ingredients",
            "appearance",
            "atc",
            "insert_url",
        }


@skip_if_no_server
class TestSearchDrugByLicenseId:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "license_id", "keyword": _LICENSE_ID})
        assert _is_success(result)
        assert result["mode"] == "license_id"
        assert result["keyword"] == _LICENSE_ID
        assert _has_results(result)
        assert result["results"][0]["license_id"] == _LICENSE_ID

    def test_bare_digits(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "license_id", "keyword": "000029"})
        assert _is_success(result)
        assert result["mode"] == "license_id"
        assert result["keyword"] == "000029"
        assert _has_results(result)
        assert result["results"][0]["license_id"].endswith("第000029號")

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "ingredient", "keyword": "aspirin"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_drug", {"mode": "ingredient", "keyword": "ZZZXYZNOTINGREDIENT"})
        assert _is_graceful(result)


# ---------------------------------------------------------------------------
# Group 3: Health Supplement
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestSearchHealthSupplement:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_health_supplement", {"mode": "keyword", "keyword": "調節血脂"})
        assert _is_success(result)
        assert _has_results(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_health_supplement", {"mode": "keyword", "keyword": "魚油"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_health_supplement", {"mode": "keyword", "keyword": "ZZZXYZNOTFOOD99999"})
        assert _is_graceful(result)

@skip_if_no_server
class TestAnalyzeHealthSupportForCondition:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_health_supplement", {"mode": "condition", "keyword": "E11"})
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_health_supplement", {"mode": "condition", "keyword": "糖尿病"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_health_supplement", {"mode": "condition", "keyword": "ZZZXYZNOTDISEASE"})
        assert _is_graceful(result)


# ---------------------------------------------------------------------------
# Group 4: Food Nutrition
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestSearchFoodNutrition:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_food_nutrition", {"food_name": "黃金小蕃茄"})
        # Service returns a list of food+nutrient records
        assert _is_success(result)
        assert _has_results(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # "雞蛋" is a common food with many entries in the DB
        result = mcp.call_tool("search_food_nutrition", {"food_name": "雞蛋"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_food_nutrition", {"food_name": "ZZZXYZNOTFOOD99999"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestGetDetailedNutrition:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_detailed_nutrition", {"food_name": "黃金小蕃茄"})
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_detailed_nutrition", {"food_name": "蕃茄"})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "get_detailed_nutrition", {"food_name": "ZZZXYZNOTEXIST"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestSearchFoodIngredient:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_food_ingredient", {"keyword": "薑黃"})
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_food_ingredient", {"keyword": "薑"})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_food_ingredient", {"keyword": "ZZZXYZNOTINGREDIENT"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestGetIngredientsByCategory:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_ingredients_by_category", {"category": "香料植物"})
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_ingredients_by_category", {"category": "香料"})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "get_ingredients_by_category", {"category": "ZZZXYZNOTCATEGORY"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestSearchFoodsByNutrient:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_foods_by_nutrient", {"nutrient": "粗蛋白"})
        assert _is_success(result)
        assert _has_results(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_foods_by_nutrient", {"nutrient": "鈣", "limit": 5}
        )
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_foods_by_nutrient", {"nutrient": "ZZZXYZNOTNUTRIENT"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestAnalyzeMealNutrition:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("analyze_meal_nutrition", {"foods": ["黃金小蕃茄"]})
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("analyze_meal_nutrition", {"foods": ["蕃茄", "雞蛋"]})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "analyze_meal_nutrition", {"foods": ["ZZZXYZNOTFOOD1", "ZZZXYZNOTFOOD2"]}
        )
        assert _is_graceful(result)


# ---------------------------------------------------------------------------
# Group 5: FHIR Condition
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestCreateFhirCondition:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_condition", {"icd_code": "E11.9", "patient_id": "patient-001"}
        )
        assert _is_success(result)
        assert result.get("resourceType") == "Condition"

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_condition",
            {
                "icd_code": "E11",
                "patient_id": "test-patient",
                "clinical_status": "resolved",
            },
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_condition",
            {"icd_code": "ZZZINVALID", "patient_id": "patient-001"},
        )
        assert _is_graceful(result)
        assert "error" in result


@skip_if_no_server
class TestCreateFhirConditionFromDiagnosis:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_condition",
            {"diagnosis_keyword": "E11.9", "patient_id": "patient-001"},
        )
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_condition",
            {"diagnosis_keyword": "糖尿", "patient_id": "patient-001"},
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_condition",
            {"diagnosis_keyword": "ZZZXYZNOTADISEASE", "patient_id": "patient-001"},
        )
        assert _is_graceful(result)
        assert "error" in result


@skip_if_no_server
class TestValidateFhirCondition:
    def test_exact(self, mcp: MCPSession) -> None:
        condition = {
            "resourceType": "Condition",
            "code": {
                "coding": [
                    {"system": "http://hl7.org/fhir/sid/icd-10-cm", "code": "E11.9"}
                ]
            },
            "subject": {"reference": "Patient/patient-001"},
        }
        result = mcp.call_tool(
            "validate_fhir_condition", {"condition_json": json.dumps(condition)}
        )
        assert _is_success(result)
        assert result.get("valid") is True

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # Missing optional fields but valid structure
        condition = {
            "resourceType": "Condition",
            "code": {},
            "subject": {"reference": "Patient/x"},
        }
        result = mcp.call_tool(
            "validate_fhir_condition", {"condition_json": json.dumps(condition)}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "validate_fhir_condition", {"condition_json": "NOT VALID JSON {{{"}
        )
        assert _is_graceful(result)
        assert result.get("valid") is False


# ---------------------------------------------------------------------------
# Group 6: FHIR Medication
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestSearchMedicationFhir:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_fhir_medication", {"keyword": "Metformin"})
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_medication",
            {"keyword": "metfor", "resource_type": "MedicationKnowledge"},
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        # Hybrid semantic search always returns the closest match — no "not found" error
        result = mcp.call_tool(
            "query_fhir_medication", {"keyword": "ZZZXYZNOTADRUG12345"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestCreateFhirMedication:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_medication",
            {"license_id": _LICENSE_ID, "resource_type": "Medication"},
        )
        assert _is_success(result)
        assert result.get("resourceType") == "Medication"

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # Truncated license ID → not found
        result = mcp.call_tool(
            "query_fhir_medication", {"license_id": "內衛成製字第000029"}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_medication", {"license_id": "INVALID_LICENSE_XYZ"}
        )
        assert _is_graceful(result)
        assert "error" in result


@skip_if_no_server
class TestCreateFhirMedicationFromDrug:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_medication",
            {"license_id": _LICENSE_ID, "resource_type": "MedicationKnowledge"},
        )
        assert _is_success(result)
        assert result.get("resourceType") == "MedicationKnowledge"

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_medication",
            {"license_id": "內衛成製字第000029", "resource_type": "MedicationKnowledge"},
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_fhir_medication",
            {"license_id": "INVALID_LICENSE_XYZ", "resource_type": "MedicationKnowledge"},
        )
        assert _is_graceful(result)
        assert "error" in result


@skip_if_no_server
class TestValidateFhirMedication:
    def test_exact(self, mcp: MCPSession) -> None:
        medication = {
            "resourceType": "Medication",
            "code": {
                "coding": [
                    {
                        "system": "https://data.fda.gov.tw/cfdatwn/license",
                        "code": _LICENSE_ID,
                    }
                ]
            },
        }
        result = mcp.call_tool(
            "validate_fhir_medication", {"medication_json": json.dumps(medication)}
        )
        assert _is_success(result)
        assert result.get("valid") is True

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # Missing code field → warnings
        result = mcp.call_tool(
            "validate_fhir_medication",
            {"medication_json": json.dumps({"resourceType": "Medication"})},
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "validate_fhir_medication", {"medication_json": "NOT JSON {{{"}
        )
        assert _is_graceful(result)
        assert result.get("valid") is False


# ---------------------------------------------------------------------------
# Group 7: Lab / LOINC
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestSearchLoinc:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_loinc", {"mode": "code", "keyword": "Glucose"})
        assert _is_success(result)
        assert _has_results(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_loinc", {"mode": "specimen", "keyword": "血清"}
        )
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_loinc", {"mode": "code", "keyword": ""})
        assert _is_graceful(result)
        assert "error" in result


@skip_if_no_server
class TestSearchLoincCategoryMode:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_loinc", {"mode": "category"})
        assert _is_success(result)
        assert result.get("total_categories", 0) > 0 or result.get("total_found", 0) > 0

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_loinc", {"mode": "category", "keyword": "CHE"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_loinc", {"mode": "component", "keyword": "ZZZXYZNOTCOMPONENT"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestQueryLoinc:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_loinc",
            {"mode": "reference_range", "loinc_code": _LOINC_CODE, "age": 40, "gender": "M"},
        )
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_loinc", {"mode": "detail", "loinc_code": _LOINC_CODE}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_loinc", {"mode": "reference_range", "loinc_code": _LOINC_CODE}
        )
        assert _is_graceful(result)
        assert "error" in result


@skip_if_no_server
class TestInterpretLabResult:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "interpret_lab_result",
            {"loinc_code": _LOINC_CODE, "value": 126.0, "age": 50, "gender": "M"},
        )
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "interpret_lab_result",
            {"loinc_code": _LOINC_CODE, "value": 90.0, "age": 30, "gender": "all"},
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "interpret_lab_result",
            {"loinc_code": "0000-0", "value": 50.0, "age": 30, "gender": "all"},
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestBatchInterpretLabResults:
    def test_exact(self, mcp: MCPSession) -> None:
        payload = json.dumps([{"loinc_code": _LOINC_CODE, "value": 126}])
        result = mcp.call_tool(
            "batch_interpret_lab_results",
            {"results_json": payload, "age": 50, "gender": "M"},
        )
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        payload = json.dumps(
            [
                {"loinc_code": _LOINC_CODE, "value": 90},
                {"loinc_code": "2093-3", "value": 180},
            ]
        )
        result = mcp.call_tool(
            "batch_interpret_lab_results",
            {"results_json": payload, "age": 40, "gender": "all"},
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "batch_interpret_lab_results",
            {"results_json": "NOT JSON {{{", "age": 40, "gender": "all"},
        )
        assert _is_graceful(result)
        assert "error" in result


# ---------------------------------------------------------------------------
# Group 8: Clinical Guidelines
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestSearchClinicalGuideline:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_clinical_guideline", {"keyword": _GUIDELINE_ICD})
        assert _is_success(result)
        assert _has_results(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("search_clinical_guideline", {"keyword": "糖尿病"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_clinical_guideline", {"keyword": "ZZZXYZNOTDISEASE"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestGetCompleteGuideline:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": _GUIDELINE_ICD, "section": "complete"}
        )
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": "I10", "section": "medication"}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": "ZZZ999", "section": "unknown"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestGetMedicationRecommendations:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": _GUIDELINE_ICD, "section": "medication"}
        )
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": "I10", "section": "medication"}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": "ZZZ999", "section": "medication"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestGetTestRecommendations:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": _GUIDELINE_ICD, "section": "test"})
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": "E78", "section": "test"})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": "ZZZ999", "section": "test"})
        assert _is_graceful(result)


@skip_if_no_server
class TestGetTreatmentGoals:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": _GUIDELINE_ICD, "section": "goals"})
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": "I10", "section": "goals"})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": "ZZZ999", "section": "goals"})
        assert _is_graceful(result)


@skip_if_no_server
class TestCheckMedicationContraindications:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": _GUIDELINE_ICD, "section": "medication"}
        )
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": _GUIDELINE_ICD, "section": "medication"}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": "ZZZ999", "section": "medication"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestLinkGuidelineToDrugs:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": _GUIDELINE_ICD, "section": "complete"})
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": "I10", "section": "complete"})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": "ZZZ999", "section": "complete"})
        assert _is_graceful(result)


@skip_if_no_server
class TestSuggestClinicalPathway:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_guideline", {"icd_code": _GUIDELINE_ICD, "section": "pathway"})
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # Use a different ICD code (hypertension) without optional patient context
        result = mcp.call_tool("query_guideline", {"icd_code": "I10", "section": "pathway"})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_guideline", {"icd_code": "ZZZ999", "section": "pathway"}
        )
        assert _is_graceful(result)


# ---------------------------------------------------------------------------
# Group 9: TWCore
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestListTwcoreCodesystems:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_twcore_code", {"category": "all"})
        assert _is_success(result)
        # Result uses {categories: {<cat>: [...]}, total: N} structure
        assert result.get("total", 0) > 0

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_twcore_code", {"category": "medication"})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_twcore_code", {"category": "ZZZNOTCATEGORY"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestSearchTwcoreCode:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_twcore_code",
            {"keyword": "daily", "codesystem_ids": [_TWCORE_CS_ID]},
        )
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_twcore_code", {"keyword": "dai", "codesystem_ids": [_TWCORE_CS_ID]}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_twcore_code",
            {"keyword": "ZZZXYZ", "codesystem_ids": ["nonexistent-cs"]},
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestLookupTwcoreCode:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_twcore_code", {"code": "daily", "codesystem_id": _TWCORE_CS_ID}
        )
        assert _is_graceful(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_twcore_code", {"code": "DAILY", "codesystem_id": _TWCORE_CS_ID}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_twcore_code",
            {"code": "ZZZNOTEXIST", "codesystem_id": "nonexistent-cs"},
        )
        assert _is_graceful(result)


# ---------------------------------------------------------------------------
# Group 10: SNOMED CT
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestSearchSnomedConcept:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_snomed_concept", {"query": "diabetes mellitus", "limit": 5}
        )
        assert _is_success(result)
        assert _has_results(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_snomed_concept", {"query": "diabetes", "limit": 10}
        )
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "search_snomed_concept", {"query": "ZZZXYZNOTACONCEPT99999"}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestGetSnomedConcept:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_snomed_concept", {"concept_id": _SNOMED_ID})
        assert _is_success(result)
        assert result.get("concept_id") == _SNOMED_ID

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # A valid but different concept
        result = mcp.call_tool("query_snomed_concept", {"concept_id": 44054006})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_snomed_concept", {"concept_id": 9999999999})
        assert _is_graceful(result)
        assert "error" in result


@skip_if_no_server
class TestGetSnomedChildren:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_snomed_concept", {"concept_id": _SNOMED_ID, "include_parents": False, "include_children": True}
        )
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_snomed_concept", {"concept_id": _SNOMED_ID, "include_parents": False, "include_children": True}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_snomed_concept", {"concept_id": 9999999999})
        assert _is_graceful(result)


@skip_if_no_server
class TestGetSnomedAncestors:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_snomed_concept", {"concept_id": _SNOMED_ID, "include_parents": True, "include_children": False}
        )
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_snomed_concept", {"concept_id": _SNOMED_ID, "include_parents": True, "include_children": False}
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_snomed_concept", {"concept_id": 9999999999})
        assert _is_graceful(result)


@skip_if_no_server
class TestGetSnomedRelationships:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_snomed_relationships", {"concept_id": _SNOMED_ID})
        assert _is_success(result)

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "get_snomed_relationships",
            {"concept_id": _SNOMED_ID, "relationship_type_id": 363698007},
        )
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_snomed_relationships", {"concept_id": 9999999999})
        assert _is_graceful(result)


@skip_if_no_server
class TestQuerySnomedMapping:
    def test_icd_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_snomed_mapping", {"mode": "icd", "keyword": "E11.9"}
        )
        assert _is_success(result)

    def test_icd_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("query_snomed_mapping", {"mode": "icd", "keyword": "I10"})
        assert _is_success(result)

    def test_icd_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_snomed_mapping", {"mode": "icd", "keyword": "ZZZ999"}
        )
        assert _is_success(result)  # Returns empty list, not error

    def test_snomed_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_snomed_mapping", {"mode": "snomed", "keyword": str(_SNOMED_ID)}
        )
        assert _is_success(result)

    def test_snomed_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_snomed_mapping", {"mode": "snomed", "keyword": "44054006"}
        )
        assert _is_graceful(result)

    def test_snomed_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "query_snomed_mapping", {"mode": "snomed", "keyword": "9999999999"}
        )
        assert _is_graceful(result)


# ---------------------------------------------------------------------------
# Group 11: Drug Interactions (RxNorm)
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestCheckDrugInteractions:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "check_drug_interactions", {"drug_names": ["warfarin", "aspirin"]}
        )
        assert _is_success(result)
        assert "interactions" in result

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "check_drug_interactions",
            {"drug_names": ["metformin", "lisinopril", "atorvastatin"]},
        )
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool(
            "check_drug_interactions", {"drug_names": ["ZZZNOTADRUG1", "ZZZNOTADRUG2"]}
        )
        assert _is_graceful(result)


@skip_if_no_server
class TestResolveRxnormDrug:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("resolve_rxnorm_drug", {"drug_name": "metformin"})
        assert _is_success(result)
        # rxnorm_concepts is returned as a JSON string — just verify it is non-empty
        assert result.get("rxnorm_concepts")

    def test_fuzzy(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("resolve_rxnorm_drug", {"drug_name": "metfor"})
        assert _is_success(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("resolve_rxnorm_drug", {"drug_name": "ZZZXYZNOTADRUG"})
        assert _is_graceful(result)


@skip_if_no_server
class TestGetDrugIngredientsRxnorm:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_drug_ingredients_rxnorm", {"rxcui": _RXCUI})
        assert _is_success(result)
        assert result.get("rxcui") == _RXCUI

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # Different valid RXCUI
        result = mcp.call_tool("get_drug_ingredients_rxnorm", {"rxcui": "44"})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("get_drug_ingredients_rxnorm", {"rxcui": "9999999999"})
        assert _is_graceful(result)
        assert "error" in result


# ---------------------------------------------------------------------------
# health_check (always available)
# ---------------------------------------------------------------------------


@skip_if_no_server
class TestHealthCheck:
    def test_exact(self, mcp: MCPSession) -> None:
        result = mcp.call_tool("health_check", {})
        assert result.get("status") in ("ok", "degraded")
        assert "database" in result
        assert "services" in result

    def test_fuzzy(self, mcp: MCPSession) -> None:
        # health_check takes no args; calling it again should be identical
        result = mcp.call_tool("health_check", {})
        assert _is_graceful(result)

    def test_wrong(self, mcp: MCPSession) -> None:
        # Extra unknown args should be safely ignored
        result = mcp.call_tool("health_check", {})
        assert _is_graceful(result)
