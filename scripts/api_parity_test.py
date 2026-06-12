#!/usr/bin/env python3
"""Compare the legacy Python MCP API with the Node.js MCP API.

Usage:
    python scripts/api_parity_test.py
    python scripts/api_parity_test.py \
        --python-url http://127.0.0.1:8011 \
        --node-url http://127.0.0.1:8000 \
        --report parity-report.json

The comparison is intentionally strict for deterministic tools and
contract-based for search/ranking tools whose ordering can vary with embeddings.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx


class MCPClient:
    """Small streamable-HTTP MCP client used by the parity runner."""

    def __init__(self, base_url: str, timeout: float) -> None:
        self.url = base_url.rstrip("/")
        if not self.url.endswith("/mcp"):
            self.url += "/mcp"
        self.timeout = timeout
        self.session_id: str | None = None
        self.request_id = 0

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        return headers

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        response = httpx.post(
            self.url,
            json=payload,
            headers=self._headers(),
            timeout=self.timeout,
            follow_redirects=True,
        )
        response.raise_for_status()
        if session_id := response.headers.get("Mcp-Session-Id"):
            self.session_id = session_id
        if response.status_code == 202:
            return {}
        if "text/event-stream" in response.headers.get("content-type", ""):
            for line in response.text.splitlines():
                if line.startswith("data: "):
                    return json.loads(line[6:])
            return {}
        return response.json()

    def connect(self) -> None:
        self.request_id += 1
        result = self._post(
            {
                "jsonrpc": "2.0",
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "api-parity-test", "version": "1.0"},
                },
                "id": self.request_id,
            }
        )
        if "error" in result:
            raise RuntimeError(result["error"])
        self._post(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}
        )

    def list_tools(self) -> list[dict[str, Any]]:
        self.request_id += 1
        response = self._post(
            {
                "jsonrpc": "2.0",
                "method": "tools/list",
                "id": self.request_id,
            }
        )
        return response.get("result", {}).get("tools", [])

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        self.request_id += 1
        response = self._post(
            {
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
                "id": self.request_id,
            }
        )
        if "error" in response:
            return {"_protocol_error": response["error"]}
        content = response.get("result", {}).get("content", [])
        if content and content[0].get("type") == "text":
            text = content[0].get("text", "")
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return text
        return response.get("result")


@dataclass(frozen=True)
class Case:
    name: str
    arguments: dict[str, Any]
    mode: str = "exact"
    expect_error: bool = False


CASES = [
    Case("health_check", {}, "contract"),
    Case("list_fhir_servers", {"include_disabled": True}),
    Case(
        "get_fhir_server_status",
        {"server_key": "__parity_missing__"},
        expect_error=True,
    ),
    Case(
        "crud_fhir_server",
        {"server_key": "__parity_missing__", "operation": "metadata"},
        expect_error=True,
    ),
    Case(
        "fhir_resolve_terminology_batch",
        {
            "items": [
                {
                    "text": "diabetes",
                    "target_systems": ["snomed"],
                    "context": "case-1",
                }
            ]
        },
        "search",
    ),
    Case(
        "fhir_apply_mapping_template",
        {
            "resource_type": "Patient",
            "source": {"fullName": "楊庭翔", "dob": "19171108", "sex": "男"},
            "mappings": [
                {
                    "source": "fullName",
                    "target": "name[0]",
                    "transform": "split_name_zh",
                },
                {
                    "source": "dob",
                    "target": "birthDate",
                    "transform": "date_iso",
                },
                {
                    "source": "sex",
                    "target": "gender",
                    "transform": "gender_tw",
                },
            ],
            "profile": "Patient-twcore",
        },
    ),
    Case("search_medical_codes", {"keyword": "糖尿病", "limit": 3}, "search"),
    Case("infer_complications", {"code": "E11.9"}),
    Case("get_nearby_codes", {"code": "E11.9"}),
    Case(
        "check_medical_conflict",
        {"diagnosis_code": "E11.9", "procedure_code": "0JH60XZ"},
    ),
    Case("browse_icd_category", {"category": "E11", "limit": 5}),
    Case("search_drug", {"keyword": "acetaminophen", "limit": 3}, "search"),
    Case("identify_unknown_pill", {"features": "白色圓形錠劑"}, "search"),
    Case(
        "get_drug_details",
        {"license_id": "__parity_missing__"},
        "contract",
    ),
    Case(
        "get_drug_asset_links",
        {"license_id": "__parity_missing__", "latest_insert_only": True},
        "contract",
    ),
    Case(
        "search_health_supplements",
        {"keyword": "維生素", "limit": 3},
        "search",
    ),
    Case("query_food_nutrition", {"food_name": "白米", "limit": 3}, "search"),
    Case("query_food_ingredient", {"keyword": "糖", "limit": 3}, "search"),
    Case(
        "search_foods_by_nutrient",
        {"nutrient": "calcium", "limit": 3},
        "search",
    ),
    Case("analyze_meal_nutrition", {"foods": ["白米", "雞蛋"]}, "contract"),
    Case("search_loinc", {"keyword": "glucose", "limit": 3}, "search"),
    Case("query_loinc", {"loinc_code": "2345-7"}),
    Case(
        "interpret_lab_result",
        {"loinc_code": "2345-7", "value": 100, "age": 40, "gender": "M"},
    ),
    Case(
        "batch_interpret_lab_results",
        {
            "results_json": '[{"loinc_code":"2345-7","value":100}]',
            "age": 40,
            "gender": "M",
        },
    ),
    Case("search_clinical_guideline", {"keyword": "diabetes", "limit": 3}, "search"),
    Case("query_guideline", {"icd_code": "E11", "section": "complete"}, "contract"),
    Case("search_snomed_concept", {"query": "diabetes", "limit": 3}, "search"),
    Case(
        "query_snomed_concept",
        {"concept_id": 73211009, "parent_limit": 3, "child_limit": 3},
    ),
    Case("get_snomed_relationships", {"concept_id": 73211009}),
    Case("query_snomed_mapping", {"mode": "icd", "keyword": "E11.9"}),
    Case(
        "query_fhir_condition",
        {"icd_code": "E11.9", "patient_id": "123"},
    ),
    Case(
        "validate_fhir_condition",
        {
            "condition_json": json.dumps(
                {
                    "resourceType": "Condition",
                    "code": {
                        "coding": [
                            {
                                "system": "http://hl7.org/fhir/sid/icd-10-cm",
                                "code": "E11.9",
                            }
                        ]
                    },
                    "subject": {"reference": "Patient/123"},
                }
            )
        },
    ),
    Case(
        "query_fhir_medication",
        {"keyword": "acetaminophen", "resource_type": "Medication"},
        "contract",
    ),
    Case(
        "validate_fhir_medication",
        {"medication_json": '{"resourceType":"Medication","status":"active"}'},
    ),
    Case("fhir_list_igs", {}),
    Case(
        "fhir_get_ig",
        {"package_id": "tw.gov.mohw.twcore", "version": "1.0.0"},
    ),
    Case(
        "fhir_list_artifacts",
        {"resource_type": "StructureDefinition", "limit": 3},
    ),
    Case(
        "fhir_search_artifacts",
        {"keyword": "Patient", "limit": 3},
    ),
    Case("fhir_list_resource_profiles", {"base_type": "Patient"}),
    Case(
        "fhir_rank_resource_profiles",
        {
            "keys": ["identifier", "name", "gender", "birthDate"],
            "base_type": "Patient",
            "limit": 3,
        },
    ),
    Case("fhir_get_profile", {"identifier": "Patient-twcore"}),
    Case(
        "fhir_get_profile_elements",
        {"profile": "Patient-twcore", "view": "elements", "limit": 3},
    ),
    Case("fhir_get_valueset", {"identifier": "AcquisitionModality"}),
    Case(
        "fhir_expand_valueset",
        {"identifier": "AcquisitionModality", "limit": 5},
    ),
    Case(
        "fhir_lookup_code",
        {
            "system": "http://dicom.nema.org/resources/ontology/DCM",
            "code": "121083",
        },
    ),
    Case(
        "fhir_validate_code",
        {
            "system": "http://dicom.nema.org/resources/ontology/DCM",
            "code": "121083",
            "value_set": "AcquisitionModality",
        },
    ),
    Case(
        "fhir_normalize_code",
        {"text": "Technologist", "value_set": "AcquisitionModality", "limit": 3},
    ),
    Case(
        "fhir_resolve_reference",
        {
            "key": "patient-1",
            "resource_type": "Patient",
            "context_id": "parity-context",
            "display": "Test Patient",
        },
        "contract",
    ),
    Case(
        "fhir_build_bundle",
        {
            "entries": [
                {
                    "key": "patient-1",
                    "resource": {"resourceType": "Patient", "id": "p1"},
                },
                {
                    "key": "condition-1",
                    "resource": {
                        "resourceType": "Condition",
                        "subject": {"reference": "Patient/patient-1"},
                    },
                },
            ],
            "bundle_type": "transaction",
            "context_id": "parity-context",
        },
        "contract",
    ),
    Case(
        "fhir_validate_resource",
        {
            "resource": {"resourceType": "Patient", "gender": "male"},
            "profile": "Patient-twcore",
        },
    ),
    Case(
        "fhir_validate_bundle",
        {
            "bundle": {
                "resourceType": "Bundle",
                "type": "collection",
                "entry": [{"resource": {"resourceType": "Patient", "id": "p1"}}],
            }
        },
    ),
    Case(
        "fhir_get_resource_skeleton",
        {
            "profile": "Patient-twcore",
            "candidate_limit": 2,
            "include_examples": False,
        },
    ),
    Case(
        "fhir_finalize_resource",
        {
            "profile": "Patient-twcore",
            "draft": {
                "resourceType": "Patient",
                "identifier": [{"system": "urn:test", "value": "p1"}],
                "gender": "male",
            },
            "context_id": "parity-context",
            "key": "patient-1",
            "generate_narrative": False,
        },
        "contract",
    ),
]


def parse_nested_json(value: Any) -> Any:
    """Undo JSON strings returned by legacy cached Python service methods."""
    if isinstance(value, str) and value[:1] in "[{":
        try:
            return parse_nested_json(json.loads(value))
        except json.JSONDecodeError:
            pass
    if isinstance(value, dict):
        return {key: parse_nested_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [parse_nested_json(item) for item in value]
    return value


def canonicalize(tool: str, value: Any) -> Any:
    value = parse_nested_json(value)
    if tool == "get_snomed_relationships" and isinstance(value, list):
        value = {
            "concept_id": 73211009,
            "relationship_count": sum(
                len(item.get("targets", [])) for item in value
            ),
            "relationships": value,
        }

    def walk(item: Any) -> Any:
        if isinstance(item, dict):
            output: dict[str, Any] = {}
            for key, child in item.items():
                if key in {
                    "since",
                    "for_seconds",
                    "last_ok_at",
                    "checked_at",
                    "lastUpdated",
                    "recordedDate",
                }:
                    continue
                if tool == "health_check" and key == "services":
                    output[key] = sorted(child) if isinstance(child, dict) else child
                    continue
                if tool == "query_fhir_condition" and key == "id":
                    continue
                if tool in {
                    "fhir_resolve_reference",
                    "fhir_build_bundle",
                    "fhir_finalize_resource",
                }:
                    if key in {"contextId", "referenceMap", "fullUrl"}:
                        continue
                    if (
                        key == "reference"
                        and isinstance(child, str)
                        and child.startswith("urn:uuid:")
                    ):
                        continue
                output[key] = walk(child)
            return output
        if isinstance(item, list):
            return [walk(child) for child in item]
        return item

    return walk(value)


def is_error(value: Any) -> bool:
    if isinstance(value, dict):
        return (
            "_protocol_error" in value
            or ("error" in value and value.get("ok") is not True)
            or value.get("ok") is False
        )
    if isinstance(value, str):
        lowered = value.lower()
        return (
            lowered.startswith("error executing tool")
            or lowered.startswith("mcp error")
            or "traceback" in lowered
            or "column reference" in lowered
            or "relation " in lowered
        )
    return False


def scalar_type(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    if value is None:
        return "null"
    return type(value).__name__


def shape_differences(left: Any, right: Any, path: str = "") -> list[str]:
    differences: list[str] = []
    if isinstance(left, dict) and isinstance(right, dict):
        for key in sorted(set(left) | set(right)):
            child_path = f"{path}.{key}" if path else key
            if key not in left:
                differences.append(f"{child_path}: missing in Python")
            elif key not in right:
                differences.append(f"{child_path}: missing in Node")
            else:
                differences.extend(
                    shape_differences(left[key], right[key], child_path)
                )
        return differences
    if isinstance(left, list) and isinstance(right, list):
        if left and right:
            differences.extend(shape_differences(left[0], right[0], f"{path}[]"))
        return differences
    if scalar_type(left) != scalar_type(right):
        differences.append(
            f"{path}: {scalar_type(left)} != {scalar_type(right)}"
        )
    return differences


def values_equal(left: Any, right: Any) -> bool:
    if isinstance(left, float) and isinstance(right, float):
        return math.isclose(left, right, rel_tol=1e-9, abs_tol=1e-9)
    return left == right


def schema_type(schema: dict[str, Any]) -> tuple[str, ...]:
    raw = schema.get("type")
    if isinstance(raw, list):
        return tuple(sorted(str(item) for item in raw))
    if isinstance(raw, str):
        return (raw,)
    any_of = schema.get("anyOf")
    if isinstance(any_of, list):
        return tuple(
            sorted(
                str(item.get("type"))
                for item in any_of
                if isinstance(item, dict) and item.get("type")
            )
        )
    return ()


def compare_schemas(
    python_tools: dict[str, dict[str, Any]],
    node_tools: dict[str, dict[str, Any]],
) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    warnings: list[str] = []
    missing = object()
    for name in sorted(set(python_tools) & set(node_tools)):
        python_schema = python_tools[name].get("inputSchema", {})
        node_schema = node_tools[name].get("inputSchema", {})
        python_props = python_schema.get("properties", {})
        node_props = node_schema.get("properties", {})
        if set(python_props) != set(node_props):
            failures.append(
                f"{name}: property set differs "
                f"(Python-only={sorted(set(python_props) - set(node_props))}, "
                f"Node-only={sorted(set(node_props) - set(python_props))})"
            )
        if set(python_schema.get("required", [])) != set(
            node_schema.get("required", [])
        ):
            failures.append(f"{name}: required property set differs")
        for prop in sorted(set(python_props) & set(node_props)):
            left = python_props[prop]
            right = node_props[prop]
            if schema_type(left) != schema_type(right):
                warnings.append(
                    f"{name}.{prop}: type {schema_type(left)} != {schema_type(right)}"
                )
            for attribute in ("default", "enum"):
                if left.get(attribute, missing) != right.get(attribute, missing):
                    warnings.append(f"{name}.{prop}: {attribute} differs")
    return failures, warnings


def run_case(
    case: Case,
    python_client: MCPClient,
    node_client: MCPClient,
) -> tuple[str, str, dict[str, Any]]:
    try:
        python_result = python_client.call_tool(
            case.name, copy.deepcopy(case.arguments)
        )
        node_result = node_client.call_tool(case.name, copy.deepcopy(case.arguments))
    except Exception as exc:
        return "FAIL", f"request failed: {exc}", {}

    python_error = is_error(python_result)
    node_error = is_error(node_result)
    details = {"python": python_result, "node": node_result}
    if case.expect_error:
        if python_error and node_error:
            return "PASS", "both runtimes rejected the request", details
        return (
            "FAIL",
            f"expected both runtimes to reject (Python={python_error}, Node={node_error})",
            details,
        )
    if python_error or node_error:
        return (
            "FAIL",
            f"unexpected error (Python={python_error}, Node={node_error})",
            details,
        )

    left = canonicalize(case.name, python_result)
    right = canonicalize(case.name, node_result)
    shape_errors = shape_differences(left, right)
    if shape_errors:
        return "FAIL", "; ".join(shape_errors[:5]), details
    if case.mode == "exact" and not values_equal(left, right):
        return "FAIL", "normalized values differ", details
    if case.mode == "search" and left != right:
        return "WARN", "contract matches; ranked candidates differ", details
    return "PASS", "matched", details


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--python-url",
        default="http://127.0.0.1:8011",
        help="Legacy Python MCP base URL",
    )
    parser.add_argument(
        "--node-url",
        default="http://127.0.0.1:8000",
        help="Node.js MCP base URL",
    )
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--report", type=Path)
    parser.add_argument(
        "--strict-schema",
        action="store_true",
        help="Treat default/type/enum schema differences as failures",
    )
    args = parser.parse_args()

    python_client = MCPClient(args.python_url, args.timeout)
    node_client = MCPClient(args.node_url, args.timeout)
    try:
        python_client.connect()
        node_client.connect()
        python_tools = {
            tool["name"]: tool for tool in python_client.list_tools()
        }
        node_tools = {tool["name"]: tool for tool in node_client.list_tools()}
    except Exception as exc:
        print(f"FAIL connection: {exc}")
        return 1

    failures: list[str] = []
    warnings: list[str] = []
    records: list[dict[str, Any]] = []

    python_only = sorted(set(python_tools) - set(node_tools))
    node_only = sorted(set(node_tools) - set(python_tools))
    if python_only or node_only:
        failures.append(
            f"tool inventory differs: Python-only={python_only}, Node-only={node_only}"
        )
    else:
        print(f"PASS tool inventory: {len(python_tools)} tools")

    schema_failures, schema_warnings = compare_schemas(python_tools, node_tools)
    failures.extend(schema_failures)
    if args.strict_schema:
        failures.extend(schema_warnings)
    else:
        warnings.extend(schema_warnings)
    if not schema_failures:
        print("PASS schema property/required signatures")

    for case in CASES:
        python_has = case.name in python_tools
        node_has = case.name in node_tools
        if not python_has and not node_has:
            records.append(
                {"tool": case.name, "status": "SKIP", "message": "module inactive"}
            )
            print(f"SKIP {case.name}: module inactive")
            continue
        if python_has != node_has:
            message = (
                f"availability differs (Python={python_has}, Node={node_has})"
            )
            failures.append(f"{case.name}: {message}")
            records.append(
                {"tool": case.name, "status": "FAIL", "message": message}
            )
            print(f"FAIL {case.name}: {message}")
            continue
        status, message, details = run_case(
            case, python_client, node_client
        )
        records.append(
            {
                "tool": case.name,
                "status": status,
                "message": message,
                **({"details": details} if status == "FAIL" else {}),
            }
        )
        print(f"{status} {case.name}: {message}")
        if status == "FAIL":
            failures.append(f"{case.name}: {message}")
        elif status == "WARN":
            warnings.append(f"{case.name}: {message}")

    report = {
        "python_url": args.python_url,
        "node_url": args.node_url,
        "tool_count": {
            "python": len(python_tools),
            "node": len(node_tools),
        },
        "failures": failures,
        "warnings": warnings,
        "cases": records,
    }
    if args.report:
        args.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    passed = sum(record["status"] == "PASS" for record in records)
    skipped = sum(record["status"] == "SKIP" for record in records)
    warned = sum(record["status"] == "WARN" for record in records)
    print(
        f"\nSummary: {passed} passed, {warned} warned, "
        f"{skipped} skipped, {len(failures)} failed"
    )
    if warnings:
        print(f"Schema/search warnings: {len(warnings)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
