"""
FHIR Medication Service — converts Taiwan FDA drug data to FHIR R4 Medication/MedicationKnowledge resources.
"""

import json
from datetime import datetime
from typing import Dict, List, Optional

from utils import log_error, log_info


class FHIRMedicationService:
    FHIR_ATC_SYSTEM             = "http://www.whocc.no/atc"
    FHIR_TAIWAN_LICENSE_SYSTEM  = "https://data.fda.gov.tw/cfdatwn/license"

    def __init__(self, drug_service):
        self.drug_service = drug_service
        log_info("FHIR Medication Service initialized")

    async def initialize(self) -> None:
        pass  # no own tables

    async def _get_drug_info(self, license_id: str) -> Optional[Dict]:
        details_str = await self.drug_service.get_drug_details_by_license(license_id)
        data = json.loads(details_str)
        return None if "error" in data else data

    async def create_medication(
        self,
        license_id: str,
        include_ingredients: bool = True,
        include_appearance: bool = True,
    ) -> Dict:
        try:
            drug = await self._get_drug_info(license_id)
            if not drug:
                return {"error": f"找不到許可證字號: {license_id}"}

            now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
            medication: Dict = {
                "resourceType": "Medication",
                "id": f"medication-{license_id.replace(' ', '-')}",
                "meta": {"profile": ["http://hl7.org/fhir/StructureDefinition/Medication"], "lastUpdated": now},
                "identifier": [{"system": self.FHIR_TAIWAN_LICENSE_SYSTEM, "value": license_id, "use": "official"}],
                "code": self._medication_code(drug),
                "status": "active",
                "manufacturer": {"display": drug.get("manufacturer", "")},
                "form": {"coding": [{"display": drug.get("form", "")}]},
            }

            if include_ingredients and drug.get("ingredients"):
                medication["ingredient"] = [
                    {
                        "itemCodeableConcept": {"text": i.get("ingredient_name", "")},
                        "isActive": True,
                        **({"strength": {"numerator": {"value": i["ingredient_qty"], "unit": "mg"}}}
                           if i.get("ingredient_qty") else {}),
                    }
                    for i in drug["ingredients"]
                ]

            if include_appearance and drug.get("appearance"):
                app = drug["appearance"]
                medication["extension"] = [
                    {"url": "https://twhealth.mohw.gov.tw/fhir/StructureDefinition/medication-appearance",
                     "extension": [
                         {"url": k, "valueString": v}
                         for k, v in app.items() if v and k in ("shape", "color", "marking")
                     ]}
                ]

            if drug.get("valid_date"):
                medication["batch"] = {"expirationDate": drug["valid_date"]}

            return medication
        except Exception as e:
            log_error(f"create_medication error: {e}")
            return {"error": str(e), "license_id": license_id}

    async def create_medication_knowledge(self, license_id: str) -> Dict:
        try:
            drug = await self._get_drug_info(license_id)
            if not drug:
                return {"error": f"找不到許可證字號: {license_id}"}

            now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
            mk: Dict = {
                "resourceType": "MedicationKnowledge",
                "id": f"medknowledge-{license_id.replace(' ', '-')}",
                "meta": {"profile": ["http://hl7.org/fhir/StructureDefinition/MedicationKnowledge"], "lastUpdated": now},
                "identifier": [{"system": self.FHIR_TAIWAN_LICENSE_SYSTEM, "value": license_id}],
                "code": self._medication_code(drug),
                "status": "active",
                "manufacturer": {"display": drug.get("manufacturer", "")},
                "doseForm": {"coding": [{"display": drug.get("form", "")}]},
            }

            if drug.get("indication"):
                mk["indication"] = [{"text": drug["indication"]}]

            if drug.get("usage"):
                mk["administrationGuidelines"] = [
                    {"dosage": [{"type": {"text": "標準用法用量"}, "dosage": [{"text": drug["usage"]}]}]}
                ]

            if drug.get("atc"):
                atc_codings = [
                    {"system": self.FHIR_ATC_SYSTEM, "code": a["atc_code"], "display": a.get("atc_name", "")}
                    for a in drug["atc"] if a.get("atc_code")
                ]
                if atc_codings:
                    mk["code"]["coding"].extend(atc_codings)

            if drug.get("package"):
                mk["packaging"] = {"type": {"text": drug["package"]}}

            return mk
        except Exception as e:
            log_error(f"create_medication_knowledge error: {e}")
            return {"error": str(e), "license_id": license_id}

    async def create_medication_from_search(self, keyword: str, resource_type: str = "Medication") -> Dict:
        search_str = await self.drug_service.search_drug(keyword)
        search_data = json.loads(search_str)
        if "error" in search_data or not search_data.get("results"):
            return {"error": f"找不到符合 '{keyword}' 的藥品"}

        first = search_data["results"][0]
        lid = first["license_id"]
        if resource_type == "MedicationKnowledge":
            resource = await self.create_medication_knowledge(lid)
        else:
            resource = await self.create_medication(lid)

        return {"search_results": search_data, "selected_drug": first,
                f"fhir_{resource_type.lower()}": resource}

    def validate_medication(self, medication: Dict) -> Dict:
        errors, warnings = [], []
        rt = medication.get("resourceType")
        if rt not in ("Medication", "MedicationKnowledge"):
            errors.append("resourceType must be 'Medication' or 'MedicationKnowledge'")
        if "code" not in medication:
            warnings.append("code is recommended")
        return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}

    def to_json_string(self, resource: Dict, indent: int = 2) -> str:
        return json.dumps(resource, ensure_ascii=False, indent=indent)

    def _medication_code(self, drug: Dict) -> Dict:
        return {
            "coding": [{"system": self.FHIR_TAIWAN_LICENSE_SYSTEM,
                        "code": drug.get("license_id", ""), "display": drug.get("name_en", "")}],
            "text": drug.get("name_zh", drug.get("name_en", "")),
        }
