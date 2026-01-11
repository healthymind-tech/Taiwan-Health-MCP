"""
FHIR Medication Service
將台灣 FDA 藥品資料轉換為符合 FHIR R4 標準的 Medication 與 MedicationKnowledge 資源
"""

from datetime import datetime
import json
from typing import Dict, List, Optional

from utils import log_error, log_info


class FHIRMedicationService:
    """
    FHIR Medication 資源建立與管理服務
    符合 FHIR R4 標準，支援台灣 FDA 藥品許可證資料
    """

    # FHIR 標準 Code Systems
    FHIR_RX_NORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm"
    FHIR_ATC_SYSTEM = "http://www.whocc.no/atc"
    FHIR_SNOMED_SYSTEM = "http://snomed.info/sct"
    FHIR_TAIWAN_LICENSE_SYSTEM = "https://data.fda.gov.tw/cfdatwn/license"

    def __init__(self, drug_service):
        """
        初始化 FHIR Medication Service

        Args:
            drug_service: DrugService 實例，用於查詢藥品資訊
        """
        self.drug_service = drug_service
        log_info("FHIR Medication Service initialized")

    # ==========================================
    # FHIR Medication 資源
    # ==========================================

    def create_medication(
        self,
        license_id: str,
        include_ingredients: bool = True,
        include_appearance: bool = True,
    ) -> Dict:
        """
        建立 FHIR Medication 資源

        Args:
            license_id: 藥品許可證字號（例如: "衛署藥製字第012345號"）
            include_ingredients: 是否包含成分資訊
            include_appearance: 是否包含外觀描述

        Returns:
            Dict: FHIR Medication 資源 (JSON 格式)
        """
        try:
            # 1. 從 Drug Service 查詢藥品資訊
            drug_info = self._get_drug_info(license_id)
            if not drug_info:
                return {
                    "error": f"找不到許可證字號: {license_id}",
                    "suggestion": "請使用 search_drug_info 工具查詢藥品",
                }

            # 2. 建立基本 Medication 資源
            medication = {
                "resourceType": "Medication",
                "id": self._generate_medication_id(license_id),
                "meta": {
                    "profile": ["http://hl7.org/fhir/StructureDefinition/Medication"],
                    "lastUpdated": self._get_current_timestamp(),
                },
                "identifier": [
                    {
                        "system": self.FHIR_TAIWAN_LICENSE_SYSTEM,
                        "value": license_id,
                        "use": "official",
                    }
                ],
                "code": self._create_medication_code(drug_info),
                "status": "active",  # active | inactive | entered-in-error
                "manufacturer": {"display": drug_info.get("manufacturer", "")},
                "form": self._create_dosage_form(drug_info.get("form", "")),
            }

            # 3. 加入成分資訊
            if include_ingredients:
                ingredients = self._get_ingredients(license_id)
                if ingredients:
                    medication["ingredient"] = ingredients

            # 4. 加入外觀描述
            if include_appearance:
                appearance = self._get_appearance(license_id)
                if appearance:
                    medication["extension"] = medication.get("extension", [])
                    medication["extension"].append(
                        {
                            "url": "https://twhealth.mohw.gov.tw/fhir/StructureDefinition/medication-appearance",
                            "extension": appearance,
                        }
                    )

            # 5. 加入批號/效期（如果有）
            if drug_info.get("valid_date"):
                medication["batch"] = {"expirationDate": drug_info["valid_date"]}

            log_info(f"FHIR Medication created for: {license_id}")
            return medication

        except Exception as e:
            log_error(f"Failed to create FHIR Medication: {e}")
            return {
                "error": f"建立 FHIR Medication 失敗: {str(e)}",
                "license_id": license_id,
            }

    # ==========================================
    # FHIR MedicationKnowledge 資源
    # ==========================================

    def create_medication_knowledge(self, license_id: str) -> Dict:
        """
        建立 FHIR MedicationKnowledge 資源（藥品知識庫）

        包含更多藥品資訊：適應症、用法用量、ATC分類、包裝等

        Args:
            license_id: 藥品許可證字號

        Returns:
            Dict: FHIR MedicationKnowledge 資源
        """
        try:
            # 1. 查詢藥品資訊
            drug_info = self._get_drug_info(license_id)
            if not drug_info:
                return {"error": f"找不到許可證字號: {license_id}"}

            # 2. 建立 MedicationKnowledge 資源
            med_knowledge = {
                "resourceType": "MedicationKnowledge",
                "id": self._generate_medication_knowledge_id(license_id),
                "meta": {
                    "profile": [
                        "http://hl7.org/fhir/StructureDefinition/MedicationKnowledge"
                    ],
                    "lastUpdated": self._get_current_timestamp(),
                },
                "identifier": [
                    {"system": self.FHIR_TAIWAN_LICENSE_SYSTEM, "value": license_id}
                ],
                "code": self._create_medication_code(drug_info),
                "status": "active",
                "manufacturer": {"display": drug_info.get("manufacturer", "")},
                "doseForm": self._create_dosage_form(drug_info.get("form", "")),
            }

            # 3. 加入適應症
            if drug_info.get("indication"):
                med_knowledge["indication"] = [{"text": drug_info["indication"]}]

            # 4. 加入用法用量
            if drug_info.get("usage"):
                med_knowledge["administrationGuidelines"] = [
                    {
                        "dosage": [
                            {
                                "type": {"text": "標準用法用量"},
                                "dosage": [{"text": drug_info["usage"]}],
                            }
                        ]
                    }
                ]

            # 5. 加入 ATC 分類
            atc_codes = self._get_atc_codes(license_id)
            if atc_codes:
                if "code" in med_knowledge:
                    med_knowledge["code"]["coding"].extend(atc_codes)
                else:
                    med_knowledge["code"] = {"coding": atc_codes}

            # 6. 加入包裝資訊
            if drug_info.get("package"):
                med_knowledge["packaging"] = {"type": {"text": drug_info["package"]}}

            # 7. 加入藥品類別（處方/非處方）
            if drug_info.get("category"):
                med_knowledge["drugCharacteristic"] = med_knowledge.get(
                    "drugCharacteristic", []
                )
                med_knowledge["drugCharacteristic"].append(
                    {
                        "type": {"text": "藥品類別"},
                        "valueCodeableConcept": {"text": drug_info["category"]},
                    }
                )

            # 8. 加入外觀特徵
            appearance_data = self._get_appearance_details(license_id)
            if appearance_data:
                drug_char = med_knowledge.get("drugCharacteristic", [])

                if appearance_data.get("color"):
                    drug_char.append(
                        {
                            "type": {"text": "顏色"},
                            "valueString": appearance_data["color"],
                        }
                    )

                if appearance_data.get("shape"):
                    drug_char.append(
                        {
                            "type": {"text": "形狀"},
                            "valueString": appearance_data["shape"],
                        }
                    )

                if appearance_data.get("marking"):
                    drug_char.append(
                        {
                            "type": {"text": "刻痕"},
                            "valueString": appearance_data["marking"],
                        }
                    )

                if appearance_data.get("image_url"):
                    drug_char.append(
                        {
                            "type": {"text": "外觀圖片"},
                            "valueAttachment": {
                                "url": appearance_data["image_url"],
                                "title": "藥品外觀圖",
                            },
                        }
                    )

                if drug_char:
                    med_knowledge["drugCharacteristic"] = drug_char

            log_info(f"FHIR MedicationKnowledge created for: {license_id}")
            return med_knowledge

        except Exception as e:
            log_error(f"Failed to create FHIR MedicationKnowledge: {e}")
            return {"error": str(e), "license_id": license_id}

    # ==========================================
    # 從藥品名稱或外觀搜尋並建立
    # ==========================================

    def create_medication_from_search(
        self, keyword: str, resource_type: str = "Medication"
    ) -> Dict:
        """
        從藥品名稱搜尋並建立 FHIR 資源

        Args:
            keyword: 搜尋關鍵字（藥品名稱）
            resource_type: "Medication" 或 "MedicationKnowledge"

        Returns:
            包含搜尋結果和 FHIR 資源的 JSON
        """
        try:
            # 搜尋藥品
            search_results = self.drug_service.search_drug(keyword)
            search_data = json.loads(search_results)

            if "error" in search_data or not search_data.get("results"):
                return {
                    "error": f"找不到符合 '{keyword}' 的藥品",
                    "search_results": search_data,
                }

            # 使用第一個結果
            first_result = search_data["results"][0]
            license_id = first_result["license_id"]

            # 建立 FHIR 資源
            if resource_type == "MedicationKnowledge":
                fhir_resource = self.create_medication_knowledge(license_id)
            else:
                fhir_resource = self.create_medication(license_id)

            return {
                "search_results": search_data,
                "selected_drug": first_result,
                f"fhir_{resource_type.lower()}": fhir_resource,
            }

        except Exception as e:
            log_error(f"Failed to create medication from search: {e}")
            return {"error": str(e), "keyword": keyword}

    def create_medication_from_appearance(
        self,
        shape: Optional[str] = None,
        color: Optional[str] = None,
        marking: Optional[str] = None,
    ) -> Dict:
        """
        從藥品外觀識別並建立 FHIR Medication

        Args:
            shape: 形狀
            color: 顏色
            marking: 刻痕

        Returns:
            包含識別結果和 FHIR 資源
        """
        try:
            # 使用外觀識別藥品
            features = {}
            if shape:
                features["shape"] = shape
            if color:
                features["color"] = color
            if marking:
                features["marking"] = marking

            identify_results = self.drug_service.identify_pill_by_appearance(features)
            identify_data = json.loads(identify_results)

            if "error" in identify_data or not identify_data.get("results"):
                return {
                    "error": "無法根據外觀識別藥品",
                    "identify_results": identify_data,
                }

            # 使用第一個結果
            first_result = identify_data["results"][0]
            license_id = first_result["license_id"]

            # 建立 FHIR Medication
            medication = self.create_medication(license_id, include_appearance=True)

            return {
                "identify_results": identify_data,
                "identified_drug": first_result,
                "fhir_medication": medication,
            }

        except Exception as e:
            log_error(f"Failed to create medication from appearance: {e}")
            return {"error": str(e)}

    # ==========================================
    # 私有輔助方法
    # ==========================================

    def _get_drug_info(self, license_id: str) -> Optional[Dict]:
        """從 Drug Service 獲取藥品資訊"""
        details = self.drug_service.get_drug_details_by_license(license_id)
        details_data = json.loads(details)

        if "error" in details_data:
            return None

        return details_data

    def _get_ingredients(self, license_id: str) -> List[Dict]:
        """獲取藥品成分（FHIR ingredient 格式）"""
        drug_info = self._get_drug_info(license_id)
        if not drug_info or "ingredients" not in drug_info:
            return []

        ingredients = []
        for ing in drug_info["ingredients"]:
            ingredient = {
                "itemCodeableConcept": {"text": ing.get("ingredient_name", "")},
                "isActive": True,
            }

            # 加入含量
            if ing.get("content"):
                ingredient["strength"] = {
                    "numerator": {"value": ing["content"], "unit": "mg"}  # 需要解析單位
                }

            ingredients.append(ingredient)

        return ingredients

    def _get_appearance(self, license_id: str) -> List[Dict]:
        """獲取外觀資訊（FHIR extension 格式）"""
        drug_info = self._get_drug_info(license_id)
        if not drug_info or "appearance" not in drug_info:
            return []

        appearance = drug_info["appearance"]
        extensions = []

        if appearance.get("shape"):
            extensions.append({"url": "shape", "valueString": appearance["shape"]})

        if appearance.get("color"):
            extensions.append({"url": "color", "valueString": appearance["color"]})

        if appearance.get("marking"):
            extensions.append({"url": "marking", "valueString": appearance["marking"]})

        return extensions

    def _get_appearance_details(self, license_id: str) -> Dict:
        """獲取外觀詳細資訊"""
        drug_info = self._get_drug_info(license_id)
        if not drug_info or "appearance" not in drug_info:
            return {}

        return drug_info["appearance"]

    def _get_atc_codes(self, license_id: str) -> List[Dict]:
        """獲取 ATC 分類碼"""
        drug_info = self._get_drug_info(license_id)
        if not drug_info or "atc" not in drug_info:
            return []

        atc_codes = []
        for atc in drug_info["atc"]:
            if atc.get("atc_code"):
                atc_codes.append(
                    {
                        "system": self.FHIR_ATC_SYSTEM,
                        "code": atc["atc_code"],
                        "display": atc.get("atc_name_en", ""),
                    }
                )

        return atc_codes

    def _create_medication_code(self, drug_info: Dict) -> Dict:
        """建立藥品編碼 CodeableConcept"""
        coding = []

        # 台灣許可證字號
        if drug_info.get("license_id"):
            coding.append(
                {
                    "system": self.FHIR_TAIWAN_LICENSE_SYSTEM,
                    "code": drug_info["license_id"],
                    "display": drug_info.get("name_zh", ""),
                }
            )

        return {
            "coding": coding,
            "text": drug_info.get("name_zh", drug_info.get("name_en", "")),
        }

    def _create_dosage_form(self, form: str) -> Dict:
        """建立劑型 CodeableConcept"""
        if not form:
            return {"text": ""}

        return {
            "coding": [
                {
                    "system": "http://terminology.hl7.org/CodeSystem/medication-form-codes",
                    "display": form,
                }
            ],
            "text": form,
        }

    def _generate_medication_id(self, license_id: str) -> str:
        """生成 Medication ID"""
        # 移除特殊字元
        clean_id = (
            license_id.replace("衛署", "")
            .replace("衛部", "")
            .replace("字第", "")
            .replace("號", "")
        )
        return f"medication-tw-{clean_id}"

    def _generate_medication_knowledge_id(self, license_id: str) -> str:
        """生成 MedicationKnowledge ID"""
        clean_id = (
            license_id.replace("衛署", "")
            .replace("衛部", "")
            .replace("字第", "")
            .replace("號", "")
        )
        return f"medknowledge-tw-{clean_id}"

    def _get_current_timestamp(self) -> str:
        """獲取當前時間戳（台灣時區 UTC+8）"""
        return datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")

    def to_json_string(self, resource: Dict, indent: int = 2) -> str:
        """將資源轉換為格式化的 JSON 字串"""
        return json.dumps(resource, ensure_ascii=False, indent=indent)
