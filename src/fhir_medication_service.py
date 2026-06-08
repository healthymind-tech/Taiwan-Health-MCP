"""
FHIR Medication Service — derives FHIR R4 Medication resources from
normalized TFDA drug records without any RxNorm dependency.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Dict, Literal, Optional

from database import PoolLike
from drug_record_builder import normalize_license_token
from utils import log_error, log_info


class FHIRMedicationService:
    FHIR_MEDICATION_PROFILE = "http://hl7.org/fhir/StructureDefinition/Medication"
    FHIR_MEDICATION_KNOWLEDGE_PROFILE = (
        "http://hl7.org/fhir/StructureDefinition/MedicationKnowledge"
    )
    TFDA_LICENSE_SYSTEM = "https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id"
    EXT_BASE = "https://mcp.fda.gov.tw/fhir/StructureDefinition"
    UCUM_SYSTEM = "http://unitsofmeasure.org"

    def __init__(self, pool: PoolLike):
        self.pool = pool
        log_info("FHIR Medication Service initialized")

    async def initialize(self) -> None:
        pass

    async def _get_drug_record(self, license_id: str) -> Optional[Dict[str, Any]]:
        token = normalize_license_token(license_id)
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT
                    l.license_id,
                    l.is_active,
                    l.cancellation_status,
                    n.normalized_json
                FROM drug.normalized_records n
                JOIN drug.licenses l ON l.license_id = n.license_id
                WHERE l.license_id = $1 OR l.license_token = $2
                ORDER BY CASE
                    WHEN l.license_id = $1 THEN 0
                    WHEN l.license_token = $2 THEN 1
                    ELSE 2
                END
                LIMIT 1
                """,
                license_id,
                token,
            )
        if not row:
            return None
        return {
            "license_id": row["license_id"],
            "is_active": bool(row["is_active"]),
            "cancellation_status": row["cancellation_status"] or "",
            "normalized_json": self._coerce_json(row["normalized_json"]),
        }

    async def _search_drug_records(
        self, keyword: str, limit: int = 5
    ) -> list[Dict[str, Any]]:
        like = f"%{keyword}%"
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                WITH ranked AS (
                    SELECT
                        l.license_id,
                        CASE
                            WHEN COALESCE(l.chinese_name, '') = $1 OR COALESCE(l.english_name, '') = $1 THEN 0
                            WHEN COALESCE(l.chinese_name, '') ILIKE $2 OR COALESCE(l.english_name, '') ILIKE $2 THEN 1
                            WHEN COALESCE(l.indications_text, '') ILIKE $2 THEN 2
                            ELSE 3
                        END AS match_rank
                    FROM drug.licenses l
                    JOIN drug.normalized_records n ON n.license_id = l.license_id
                    WHERE l.is_listed
                      AND (
                        COALESCE(l.chinese_name, '') ILIKE $2
                        OR COALESCE(l.english_name, '') ILIKE $2
                        OR COALESCE(l.indications_text, '') ILIKE $2
                        OR EXISTS (
                            SELECT 1
                            FROM jsonb_array_elements(COALESCE(n.normalized_json #> '{ingredients,active}', '[]'::jsonb)) i
                            WHERE COALESCE(i->>'name', i->>'成分', '') ILIKE $2
                               OR COALESCE(i->>'raw_text', '') ILIKE $2
                        )
                      )
                )
                SELECT
                    l.license_id,
                    l.is_active,
                    l.cancellation_status,
                    n.normalized_json,
                    ranked.match_rank
                FROM ranked
                JOIN drug.licenses l ON l.license_id = ranked.license_id
                JOIN drug.normalized_records n ON n.license_id = l.license_id
                ORDER BY ranked.match_rank, l.is_active DESC, l.license_id
                LIMIT $3
                """,
                keyword,
                like,
                min(max(limit, 1), 5),
            )
        return [
            {
                "license_id": row["license_id"],
                "is_active": bool(row["is_active"]),
                "cancellation_status": row["cancellation_status"] or "",
                "normalized_json": self._coerce_json(row["normalized_json"]),
            }
            for row in rows
        ]

    async def create_medication(
        self,
        license_id: str,
        resource_type: Literal["Medication", "MedicationKnowledge"] = "Medication",
    ) -> Dict[str, Any]:
        try:
            record = await self._get_drug_record(license_id)
            if not record:
                return {"error": f"Drug license '{license_id}' not found in database"}
            normalized = record["normalized_json"]
            return self._build_resource(
                normalized,
                license_id=record["license_id"],
                is_active=record["is_active"],
                resource_type=resource_type,
            )
        except Exception as exc:
            log_error(f"create_medication error: {exc}")
            return {"error": str(exc), "license_id": license_id}

    async def create_medication_from_search(
        self,
        keyword: str,
        resource_type: Literal["Medication", "MedicationKnowledge"] = "Medication",
    ) -> Dict[str, Any]:
        matches = await self._search_drug_records(keyword)
        if not matches:
            return {"error": f"No drug found for keyword: {keyword}"}
        first = matches[0]
        resource = self._build_resource(
            first["normalized_json"],
            license_id=first["license_id"],
            is_active=first["is_active"],
            resource_type=resource_type,
        )
        return {
            "search_results": [
                {
                    "license_id": item["license_id"],
                    "name_zh": self._nested_get(
                        item["normalized_json"], "drug", "chinese_name"
                    ),
                    "name_en": self._nested_get(
                        item["normalized_json"], "drug", "english_name"
                    ),
                    "is_active": item["is_active"],
                    "cancellation_status": item["cancellation_status"],
                }
                for item in matches
            ],
            "selected_license_id": first["license_id"],
            "fhir_medication": resource,
        }

    def validate_medication(self, medication: Dict[str, Any]) -> Dict[str, Any]:
        errors: list[str] = []
        resource_type = medication.get("resourceType")
        if resource_type not in {"Medication", "MedicationKnowledge"}:
            errors.append("resourceType must be 'Medication' or 'MedicationKnowledge'")

        code = medication.get("code")
        if not isinstance(code, dict) or not code.get("coding"):
            errors.append("code.coding must be present with at least one entry")

        ingredients = medication.get("ingredient", [])
        if ingredients is not None:
            if not isinstance(ingredients, list):
                errors.append("ingredient must be an array")
            else:
                for idx, item in enumerate(ingredients):
                    if not isinstance(item, dict):
                        errors.append(f"ingredient[{idx}] must be an object")
                        continue
                    if (
                        "itemCodeableConcept" not in item
                        and "itemReference" not in item
                    ):
                        errors.append(
                            f"ingredient[{idx}] must include itemCodeableConcept or itemReference"
                        )

        return {
            "valid": len(errors) == 0,
            "resource_type": resource_type or "",
            "errors": errors,
        }

    def to_json_string(self, medication: Dict[str, Any], indent: int = 2) -> str:
        return json.dumps(medication, ensure_ascii=False, indent=indent)

    def _build_resource(
        self,
        normalized: Dict[str, Any],
        *,
        license_id: str,
        is_active: bool,
        resource_type: Literal["Medication", "MedicationKnowledge"],
    ) -> Dict[str, Any]:
        if resource_type not in {"Medication", "MedicationKnowledge"}:
            raise ValueError(
                "resource_type must be 'Medication' or 'MedicationKnowledge'"
            )

        token = normalize_license_token(license_id) or license_id
        now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
        drug = (
            normalized.get("drug", {})
            if isinstance(normalized.get("drug"), dict)
            else {}
        )
        companies = (
            normalized.get("companies", {})
            if isinstance(normalized.get("companies"), dict)
            else {}
        )
        applicant = (
            companies.get("applicant", {})
            if isinstance(companies.get("applicant"), dict)
            else {}
        )
        manufacturers = companies.get("manufacturers", [])
        ingredients = self._build_ingredients(normalized.get("ingredients", {}))
        display_name = (
            drug.get("english_name") or drug.get("chinese_name") or license_id
        )
        text_name = drug.get("chinese_name") or drug.get("english_name") or license_id

        common: Dict[str, Any] = {
            "identifier": [
                {
                    "use": "official",
                    "system": self.TFDA_LICENSE_SYSTEM,
                    "value": license_id,
                }
            ],
            "code": {
                "coding": [
                    {
                        "system": self.TFDA_LICENSE_SYSTEM,
                        "code": license_id,
                        "display": display_name,
                    }
                ],
                "text": text_name,
            },
            "extension": self._build_common_extensions(
                normalized, applicant, manufacturers
            ),
        }

        if resource_type == "Medication":
            medication = {
                "resourceType": "Medication",
                "id": f"medication-{token.lower()}",
                "meta": {
                    "profile": [self.FHIR_MEDICATION_PROFILE],
                    "lastUpdated": now,
                },
                "status": "active" if is_active else "inactive",
                **common,
                "doseForm": self._text_codeable_concept(drug.get("dosage_form", "")),
                "ingredient": ingredients,
            }
            return medication

        medication_knowledge = {
            "resourceType": "MedicationKnowledge",
            "id": f"medicationknowledge-{token.lower()}",
            "meta": {
                "profile": [self.FHIR_MEDICATION_KNOWLEDGE_PROFILE],
                "lastUpdated": now,
            },
            "status": "active" if is_active else "inactive",
            **common,
            "associatedMedication": [
                {
                    "reference": f"Medication/medication-{token.lower()}",
                    "display": text_name,
                }
            ],
            "doseForm": self._text_codeable_concept(drug.get("dosage_form", "")),
            "ingredient": ingredients,
            "monograph": self._build_monographs(normalized),
            "drugCharacteristic": self._build_drug_characteristics(normalized),
        }
        return medication_knowledge

    def _build_common_extensions(
        self,
        normalized: Dict[str, Any],
        applicant: Dict[str, Any],
        manufacturers: Any,
    ) -> list[Dict[str, Any]]:
        drug = (
            normalized.get("drug", {})
            if isinstance(normalized.get("drug"), dict)
            else {}
        )
        usage = (
            normalized.get("usage", {})
            if isinstance(normalized.get("usage"), dict)
            else {}
        )
        quality = (
            normalized.get("quality", {})
            if isinstance(normalized.get("quality"), dict)
            else {}
        )
        extensions: list[Dict[str, Any]] = []
        self._append_string_extension(
            extensions,
            "tfda-drug-category",
            drug.get("drug_category", ""),
        )
        self._append_string_extension(
            extensions,
            "tfda-license-type",
            drug.get("license_type", ""),
        )
        self._append_string_extension(
            extensions,
            "tfda-package",
            drug.get("package", ""),
        )
        self._append_string_extension(
            extensions,
            "tfda-applicant-name",
            applicant.get("name", ""),
        )
        self._append_string_extension(
            extensions,
            "tfda-applicant-address",
            applicant.get("address", ""),
        )
        for manufacturer in manufacturers if isinstance(manufacturers, list) else []:
            if not isinstance(manufacturer, dict):
                continue
            if manufacturer.get("name"):
                extensions.append(
                    {
                        "url": f"{self.EXT_BASE}/tfda-manufacturer",
                        "extension": [
                            {
                                "url": "name",
                                "valueString": manufacturer.get("name", ""),
                            },
                            {
                                "url": "country",
                                "valueString": manufacturer.get("country", ""),
                            },
                            {
                                "url": "process",
                                "valueString": manufacturer.get("process", ""),
                            },
                        ],
                    }
                )
        for indication in (
            usage.get("purpose", []) if isinstance(usage.get("purpose"), list) else []
        ):
            if indication:
                extensions.append(
                    {
                        "url": f"{self.EXT_BASE}/tfda-indication",
                        "valueString": str(indication),
                    }
                )
        self._append_string_extension(
            extensions,
            "tfda-quality-confidence",
            quality.get("confidence", ""),
        )
        return extensions

    def _build_monographs(self, normalized: Dict[str, Any]) -> list[Dict[str, Any]]:
        insert_content = (
            normalized.get("insert_content", {})
            if isinstance(normalized.get("insert_content"), dict)
            else {}
        )
        packaging = (
            normalized.get("packaging_and_labeling", {})
            if isinstance(normalized.get("packaging_and_labeling"), dict)
            else {}
        )
        monographs: list[Dict[str, Any]] = []
        for document in insert_content.get("insert_documents", []):
            monograph = self._monograph_from_document(document, "Insert PDF")
            if monograph:
                monographs.append(monograph)
        for document in packaging.get("label_documents", []):
            monograph = self._monograph_from_document(document, "Label PDF")
            if monograph:
                monographs.append(monograph)
        return monographs

    def _monograph_from_document(
        self, document: Any, label: str
    ) -> Optional[Dict[str, Any]]:
        if not isinstance(document, dict):
            return None
        filename = document.get("filename", "")
        source_url = document.get("source_url", "")
        minio = (
            document.get("minio", {}) if isinstance(document.get("minio"), dict) else {}
        )
        reference: Dict[str, Any] = {
            "display": filename or source_url or label,
        }
        minio_uri = minio.get("uri", "")
        if minio_uri:
            reference["identifier"] = {"system": "urn:minio:uri", "value": minio_uri}
        elif source_url:
            reference["identifier"] = {"system": "urn:source:url", "value": source_url}
        return {"type": {"text": label}, "source": reference}

    def _build_drug_characteristics(
        self, normalized: Dict[str, Any]
    ) -> list[Dict[str, Any]]:
        appearance = (
            normalized.get("appearance", {})
            if isinstance(normalized.get("appearance"), dict)
            else {}
        )
        records = (
            appearance.get("records", [])
            if isinstance(appearance.get("records"), list)
            else []
        )
        if not records:
            return []
        first = records[0] if isinstance(records[0], dict) else {}
        characteristics: list[Dict[str, Any]] = []
        for label, key in (
            ("color", "color"),
            ("shape", "shape"),
            ("imprint", "imprint"),
            ("size", "size"),
            ("description", "description"),
        ):
            value = first.get(key, "")
            if value:
                characteristics.append(
                    {
                        "type": {"text": label},
                        "valueString": str(value),
                    }
                )
        return characteristics

    def _build_ingredients(self, ingredients_block: Any) -> list[Dict[str, Any]]:
        if not isinstance(ingredients_block, dict):
            return []
        entries: list[Dict[str, Any]] = []
        for is_active, bucket_name in ((True, "active"), (False, "inactive")):
            for item in (
                ingredients_block.get(bucket_name, [])
                if isinstance(ingredients_block.get(bucket_name), list)
                else []
            ):
                if not isinstance(item, dict):
                    continue
                name = item.get("name") or item.get("成分") or ""
                if not name:
                    continue
                ingredient: Dict[str, Any] = {
                    "itemCodeableConcept": {"text": str(name)},
                    "isActive": is_active,
                }
                strength = self._ratio_from_amount(
                    item.get("amount") or item.get("含量") or item.get("raw_text") or ""
                )
                if strength:
                    ingredient["strength"] = strength
                entries.append(ingredient)
        return entries

    def _ratio_from_amount(self, amount_text: str) -> Optional[Dict[str, Any]]:
        if not amount_text:
            return None
        match = re.match(
            r"^\s*(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>mg|g|mcg|μg|ug|mL|ml|IU|%)\b",
            str(amount_text),
            re.IGNORECASE,
        )
        if not match:
            return None
        value = float(match.group("value"))
        unit = match.group("unit")
        normalized_unit = {"ml": "mL", "ug": "ug"}.get(unit.lower(), unit)
        return {
            "numerator": {
                "value": value,
                "unit": normalized_unit,
                "system": self.UCUM_SYSTEM,
                "code": normalized_unit,
            },
            "denominator": {
                "value": 1,
                "unit": "1",
                "system": self.UCUM_SYSTEM,
                "code": "1",
            },
        }

    def _append_string_extension(
        self, target: list[Dict[str, Any]], name: str, value: str
    ) -> None:
        if value:
            target.append({"url": f"{self.EXT_BASE}/{name}", "valueString": str(value)})

    @staticmethod
    def _text_codeable_concept(text: str) -> Dict[str, Any]:
        return {"text": text} if text else {}

    @staticmethod
    def _nested_get(data: Dict[str, Any], *keys: str) -> str:
        current: Any = data
        for key in keys:
            if not isinstance(current, dict):
                return ""
            current = current.get(key, "")
        return str(current) if current not in (None, "") else ""

    @staticmethod
    def _coerce_json(value: Any) -> Dict[str, Any]:
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                return {}
        return {}
