# API 參考

本章節描述可直接在 Python 服務層使用的主要服務類別。所有服務皆以 `__init__(self, pool, ...)` 建構，並提供 `async initialize()`；初始化依賴 PostgreSQL 連線池（透過 pgBouncer）。

## 服務類別

| 類別 | 檔案 | 資料 |
|------|------|------|
| `ICDService` | `icd_service.py` | `icd.*` |
| `DrugService` | `drug_service.py` | `drug.*` |
| `DrugAnalysisService` | `drug_analysis_service.py` | `drug.insert_analysis` |
| `HealthSupplementsService` | `health_supplements_service.py` | `health_supplements.*` |
| `FoodNutritionService` | `food_nutrition_service.py` | `food_nutrition.*` |
| `LabService` | `lab_service.py` | `loinc.*` |
| `ClinicalGuidelineService` | `clinical_guideline_service.py` | `guideline.*` |
| `FHIRConditionService` | `fhir_condition_service.py` | 讀取 `icd.*` |
| `FHIRMedicationService` | `fhir_medication_service.py` | 讀取 `drug_service` |
| `FHIRIGService` | `fhir_ig_service.py` | `fhir.*`（多 IG） |
| `FHIRServerService` | `fhir_server_service.py` | `admin.fhir_servers` |
| `SNOMEDService` | `snomed_service.py` | `snomed.*` |
| `EmbeddingService` | `embedding_service.py` | Ollama `/api/embed` |
| `MinIOService` | `minio_service.py` | MinIO bucket |

## 相關文件

- [FHIR Services API](fhir-services.md)
- [模組總覽](../modules/icd-service.md)
- 服務的對外 MCP 工具見[工具參考](../tools/icd-tools.md)。
