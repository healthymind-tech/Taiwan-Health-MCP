"""
FHIR Condition Service — converts ICD-10 diagnosis codes to FHIR R4 Condition resources.
"""

import json
from datetime import datetime
from typing import Dict, List, Literal, Optional
from uuid import uuid4

import asyncpg

from utils import log_error, log_info


class FHIRConditionService:
    FHIR_ICD10_CM_SYSTEM        = "http://hl7.org/fhir/sid/icd-10-cm"
    FHIR_CLINICAL_STATUS_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-clinical"
    FHIR_VERIFICATION_SYSTEM    = "http://terminology.hl7.org/CodeSystem/condition-ver-status"
    FHIR_CATEGORY_SYSTEM        = "http://terminology.hl7.org/CodeSystem/condition-category"
    FHIR_SEVERITY_SYSTEM        = "http://snomed.info/sct"

    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool
        log_info("FHIR Condition Service initialized")

    async def initialize(self) -> None:
        pass  # no own tables

    async def _get_icd_info(self, icd_code: str) -> Optional[Dict]:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT code, name_zh, name_en FROM icd.diagnoses WHERE code = $1", icd_code
            )
        return dict(row) if row else None

    async def create_condition(
        self,
        icd_code: str,
        patient_id: str,
        clinical_status: Literal["active", "inactive", "resolved", "remission"] = "active",
        verification_status: Literal["confirmed", "provisional", "differential", "refuted"] = "confirmed",
        category: Literal["problem-list-item", "encounter-diagnosis"] = "encounter-diagnosis",
        severity: Optional[Literal["mild", "moderate", "severe"]] = None,
        onset_date: Optional[str] = None,
        recorded_date: Optional[str] = None,
        additional_notes: Optional[str] = None,
    ) -> Dict:
        try:
            icd_info = await self._get_icd_info(icd_code)
            if not icd_info:
                return {"error": f"ICD-10 code '{icd_code}' not found in database"}

            now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
            condition: Dict = {
                "resourceType": "Condition",
                "id": f"condition-{patient_id}-{icd_code.replace('.', '-')}-{uuid4().hex[:8]}",
                "meta": {"profile": ["http://hl7.org/fhir/StructureDefinition/Condition"], "lastUpdated": now},
                "clinicalStatus": self._codeable_concept(self.FHIR_CLINICAL_STATUS_SYSTEM, clinical_status,
                                                          self._status_display(clinical_status, "clinical")),
                "verificationStatus": self._codeable_concept(self.FHIR_VERIFICATION_SYSTEM, verification_status,
                                                              self._status_display(verification_status, "verification")),
                "category": [self._codeable_concept(self.FHIR_CATEGORY_SYSTEM, category,
                                                     self._status_display(category, "category"))],
                "code": {
                    "coding": [{"system": self.FHIR_ICD10_CM_SYSTEM,
                                "code": icd_info["code"], "display": icd_info.get("name_en", "")}],
                    "text": icd_info.get("name_zh", icd_info.get("name_en", "")),
                },
                "subject": {"reference": f"Patient/{patient_id}"},
                "recordedDate": recorded_date or now,
            }
            if severity:
                severity_map = {"mild": ("255604002", "Mild"), "moderate": ("6736007", "Moderate"),
                                "severe": ("24484000", "Severe")}
                code, display = severity_map.get(severity, ("6736007", "Moderate"))
                condition["severity"] = self._codeable_concept(self.FHIR_SEVERITY_SYSTEM, code, display)
            if onset_date:
                condition["onsetDateTime"] = onset_date
            if additional_notes:
                condition["note"] = [{"text": additional_notes, "time": now}]

            return condition
        except Exception as e:
            log_error(f"create_condition error: {e}")
            return {"error": str(e), "icd_code": icd_code}

    async def create_condition_from_search(self, keyword: str, patient_id: str, **kwargs) -> Dict:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT code, name_zh, name_en FROM icd.diagnoses
                   WHERE to_tsvector('simple', COALESCE(code,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                         @@ plainto_tsquery('simple', $1)
                   LIMIT 5""",
                keyword,
            )
        if not rows:
            return {"error": f"No diagnosis found for keyword: {keyword}"}

        first = dict(rows[0])
        condition = await self.create_condition(icd_code=first["code"], patient_id=patient_id, **kwargs)
        return {"search_results": [dict(r) for r in rows], "selected_code": first["code"], "fhir_condition": condition}

    def validate_condition(self, condition: Dict) -> Dict:
        errors, warnings = [], []
        for field in ("resourceType", "code", "subject"):
            if field not in condition:
                errors.append(f"Missing required field: {field}")
        if condition.get("resourceType") != "Condition":
            errors.append("resourceType must be 'Condition'")
        if "clinicalStatus" not in condition and "verificationStatus" not in condition:
            warnings.append("At least one of clinicalStatus or verificationStatus should be present")
        return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}

    def to_json_string(self, condition: Dict, indent: int = 2) -> str:
        return json.dumps(condition, ensure_ascii=False, indent=indent)

    # ---- helpers ----

    @staticmethod
    def _codeable_concept(system: str, code: str, display: str) -> Dict:
        return {"coding": [{"system": system, "code": code, "display": display}]}

    @staticmethod
    def _status_display(code: str, kind: str) -> str:
        maps = {
            "clinical":      {"active": "Active", "inactive": "Inactive", "resolved": "Resolved", "remission": "Remission"},
            "verification":  {"confirmed": "Confirmed", "provisional": "Provisional", "differential": "Differential", "refuted": "Refuted"},
            "category":      {"problem-list-item": "Problem List Item", "encounter-diagnosis": "Encounter Diagnosis"},
        }
        return maps.get(kind, {}).get(code, code)
