"""
FHIR Condition Service
將 ICD-10 診斷碼轉換為符合 FHIR R4 標準的 Condition 資源
"""

from datetime import datetime
import json
from typing import Dict, List, Literal, Optional
from uuid import uuid4

from utils import log_error, log_info


class FHIRConditionService:
    """
    FHIR Condition 資源建立與管理服務
    符合 FHIR R4 標準，支援台灣 ICD-10-CM 編碼系統
    """

    # FHIR 標準 Code Systems
    FHIR_ICD10_CM_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm"
    FHIR_SNOMED_SYSTEM = "http://snomed.info/sct"
    FHIR_CLINICAL_STATUS_SYSTEM = (
        "http://terminology.hl7.org/CodeSystem/condition-clinical"
    )
    FHIR_VERIFICATION_STATUS_SYSTEM = (
        "http://terminology.hl7.org/CodeSystem/condition-ver-status"
    )
    FHIR_CATEGORY_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-category"
    FHIR_SEVERITY_SYSTEM = "http://snomed.info/sct"

    def __init__(self, icd_service):
        """
        初始化 FHIR Condition Service

        Args:
            icd_service: ICDService 實例，用於查詢 ICD-10 編碼資訊
        """
        self.icd_service = icd_service
        log_info("FHIR Condition Service initialized")

    def create_condition(
        self,
        icd_code: str,
        patient_id: str,
        clinical_status: Literal[
            "active", "inactive", "resolved", "remission"
        ] = "active",
        verification_status: Literal[
            "confirmed", "provisional", "differential", "refuted"
        ] = "confirmed",
        category: Literal[
            "problem-list-item", "encounter-diagnosis"
        ] = "encounter-diagnosis",
        severity: Optional[Literal["mild", "moderate", "severe"]] = None,
        onset_date: Optional[str] = None,
        recorded_date: Optional[str] = None,
        additional_notes: Optional[str] = None,
    ) -> Dict:
        """
        建立 FHIR Condition 資源

        Args:
            icd_code: ICD-10-CM 診斷碼 (例如: "E11.9")
            patient_id: 患者 ID
            clinical_status: 臨床狀態
                - active: 活動中（症狀持續）
                - inactive: 非活動（無症狀但未治癒）
                - resolved: 已解決
                - remission: 緩解期
            verification_status: 驗證狀態
                - confirmed: 已確診
                - provisional: 臨時診斷
                - differential: 鑑別診斷
                - refuted: 已排除
            category: 分類
                - problem-list-item: 問題清單項目
                - encounter-diagnosis: 就診診斷
            severity: 嚴重程度 (mild/moderate/severe)
            onset_date: 發病日期 (ISO 8601 格式: YYYY-MM-DD)
            recorded_date: 記錄日期時間 (ISO 8601: YYYY-MM-DDTHH:MM:SS+08:00)
            additional_notes: 額外備註

        Returns:
            Dict: FHIR Condition 資源 (JSON 格式)
        """
        try:
            # 1. 從 ICD Service 查詢診斷碼資訊
            icd_info = self._get_icd_info(icd_code)
            if not icd_info:
                log_error(f"ICD code not found: {icd_code}")
                return {
                    "error": f"ICD-10 code '{icd_code}' not found in database",
                    "suggestion": "Please verify the code or use search_medical_codes tool",
                }

            # 2. 建立 FHIR Condition 資源結構
            condition = {
                "resourceType": "Condition",
                "id": self._generate_id(icd_code, patient_id),
                "meta": {
                    "profile": ["http://hl7.org/fhir/StructureDefinition/Condition"],
                    "lastUpdated": self._get_current_timestamp(),
                },
                "clinicalStatus": self._create_codeable_concept(
                    system=self.FHIR_CLINICAL_STATUS_SYSTEM,
                    code=clinical_status,
                    display=self._get_clinical_status_display(clinical_status),
                ),
                "verificationStatus": self._create_codeable_concept(
                    system=self.FHIR_VERIFICATION_STATUS_SYSTEM,
                    code=verification_status,
                    display=self._get_verification_status_display(verification_status),
                ),
                "category": [
                    self._create_codeable_concept(
                        system=self.FHIR_CATEGORY_SYSTEM,
                        code=category,
                        display=self._get_category_display(category),
                    )
                ],
                "code": self._create_condition_code(icd_info),
                "subject": {
                    "reference": f"Patient/{patient_id}",
                    "display": f"患者 {patient_id}",
                },
                "recordedDate": recorded_date or self._get_current_timestamp(),
            }

            # 3. 添加可選欄位
            if severity:
                condition["severity"] = self._create_severity(severity)

            if onset_date:
                condition["onsetDateTime"] = onset_date

            if additional_notes:
                condition["note"] = [
                    {"text": additional_notes, "time": self._get_current_timestamp()}
                ]

            log_info(f"FHIR Condition created successfully for ICD code: {icd_code}")
            return condition

        except Exception as e:
            log_error(f"Failed to create FHIR Condition: {e}")
            return {
                "error": f"Failed to create FHIR Condition: {str(e)}",
                "icd_code": icd_code,
                "patient_id": patient_id,
            }

    def create_condition_from_search(
        self, keyword: str, patient_id: str, **kwargs
    ) -> Dict:
        """
        從關鍵字搜尋並建立 FHIR Condition

        Args:
            keyword: 搜尋關鍵字（疾病名稱或 ICD 碼）
            patient_id: 患者 ID
            **kwargs: 其他參數（同 create_condition）

        Returns:
            Dict: 搜尋結果與 FHIR Condition 資源
        """
        try:
            # 搜尋診斷碼
            search_results = self.icd_service.search_codes(keyword, type="diagnosis")
            search_data = json.loads(search_results)

            if "diagnoses" not in search_data or not search_data["diagnoses"]:
                return {
                    "error": f"No diagnosis found for keyword: {keyword}",
                    "search_results": search_data,
                }

            # 使用第一個搜尋結果建立 Condition
            first_result = search_data["diagnoses"][0]
            icd_code = first_result["code"]

            condition = self.create_condition(
                icd_code=icd_code, patient_id=patient_id, **kwargs
            )

            return {
                "search_results": search_data,
                "selected_code": icd_code,
                "fhir_condition": condition,
            }

        except Exception as e:
            log_error(f"Failed to create condition from search: {e}")
            return {"error": str(e), "keyword": keyword}

    def create_condition_bundle(
        self,
        conditions: List[Dict],
        bundle_type: Literal["collection", "document", "transaction"] = "collection",
    ) -> Dict:
        """
        建立 FHIR Bundle（包含多個 Condition 資源）

        Args:
            conditions: Condition 資源列表
            bundle_type: Bundle 類型

        Returns:
            Dict: FHIR Bundle 資源
        """
        bundle = {
            "resourceType": "Bundle",
            "id": str(uuid4()),
            "type": bundle_type,
            "timestamp": self._get_current_timestamp(),
            "total": len(conditions),
            "entry": [],
        }

        for condition in conditions:
            if "error" not in condition:
                bundle["entry"].append(
                    {
                        "fullUrl": f"Condition/{condition.get('id', 'unknown')}",
                        "resource": condition,
                    }
                )

        log_info(f"FHIR Bundle created with {len(bundle['entry'])} conditions")
        return bundle

    def validate_condition(self, condition: Dict) -> Dict:
        """
        驗證 FHIR Condition 資源是否符合規範

        Args:
            condition: FHIR Condition 資源

        Returns:
            Dict: 驗證結果
        """
        validation_results = {"valid": True, "errors": [], "warnings": []}

        # 必要欄位檢查
        required_fields = ["resourceType", "code", "subject"]
        for field in required_fields:
            if field not in condition:
                validation_results["valid"] = False
                validation_results["errors"].append(f"Missing required field: {field}")

        # resourceType 檢查
        if condition.get("resourceType") != "Condition":
            validation_results["valid"] = False
            validation_results["errors"].append("resourceType must be 'Condition'")

        # clinicalStatus 與 verificationStatus 檢查
        if "clinicalStatus" not in condition and "verificationStatus" not in condition:
            validation_results["warnings"].append(
                "At least one of clinicalStatus or verificationStatus should be present"
            )

        return validation_results

    # --- Private Helper Methods ---

    def _get_icd_info(self, icd_code: str) -> Optional[Dict]:
        """從 ICD Service 獲取診斷碼資訊"""
        results = self.icd_service._query_db(
            "SELECT code, name_zh, name_en FROM diagnoses WHERE code = ?", (icd_code,)
        )
        return results[0] if results else None

    def _create_codeable_concept(
        self, system: str, code: str, display: str, text: Optional[str] = None
    ) -> Dict:
        """建立 CodeableConcept 結構"""
        concept = {"coding": [{"system": system, "code": code, "display": display}]}
        if text:
            concept["text"] = text
        return concept

    def _create_condition_code(self, icd_info: Dict) -> Dict:
        """建立診斷碼 CodeableConcept（包含 ICD-10 和中文描述）"""
        return {
            "coding": [
                {
                    "system": self.FHIR_ICD10_CM_SYSTEM,
                    "code": icd_info["code"],
                    "display": icd_info.get("name_en", ""),
                }
            ],
            "text": icd_info.get("name_zh", icd_info.get("name_en", "")),
        }

    def _create_severity(self, severity: str) -> Dict:
        """建立嚴重程度 CodeableConcept"""
        severity_map = {
            "mild": {"code": "255604002", "display": "Mild"},
            "moderate": {"code": "6736007", "display": "Moderate"},
            "severe": {"code": "24484000", "display": "Severe"},
        }

        severity_info = severity_map.get(severity, severity_map["moderate"])
        return self._create_codeable_concept(
            system=self.FHIR_SEVERITY_SYSTEM,
            code=severity_info["code"],
            display=severity_info["display"],
        )

    def _generate_id(self, icd_code: str, patient_id: str) -> str:
        """生成 Condition ID"""
        return f"condition-{patient_id}-{icd_code.replace('.', '-')}-{uuid4().hex[:8]}"

    def _get_current_timestamp(self) -> str:
        """獲取當前時間戳（台灣時區 UTC+8）"""
        return datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")

    def _get_clinical_status_display(self, code: str) -> str:
        """獲取臨床狀態顯示名稱"""
        status_map = {
            "active": "Active",
            "inactive": "Inactive",
            "resolved": "Resolved",
            "remission": "Remission",
        }
        return status_map.get(code, code)

    def _get_verification_status_display(self, code: str) -> str:
        """獲取驗證狀態顯示名稱"""
        status_map = {
            "confirmed": "Confirmed",
            "provisional": "Provisional",
            "differential": "Differential",
            "refuted": "Refuted",
            "entered-in-error": "Entered in Error",
        }
        return status_map.get(code, code)

    def _get_category_display(self, code: str) -> str:
        """獲取分類顯示名稱"""
        category_map = {
            "problem-list-item": "Problem List Item",
            "encounter-diagnosis": "Encounter Diagnosis",
        }
        return category_map.get(code, code)

    def to_json_string(self, condition: Dict, indent: int = 2) -> str:
        """
        將 Condition 資源轉換為格式化的 JSON 字串

        Args:
            condition: FHIR Condition 資源
            indent: 縮排空格數

        Returns:
            str: 格式化的 JSON 字串
        """
        return json.dumps(condition, ensure_ascii=False, indent=indent)
