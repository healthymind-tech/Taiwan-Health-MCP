# src/ 服務模組說明

本目錄包含 MCP server 入口與目前保留的核心服務模組。

## 模組一覽

| 檔案 | 服務 | MCP 工具數 |
|------|------|-----------|
| `server.py` | 入口點（DynamicFastMCP + lifespan） | 最多 24 |
| `icd_service.py` | ICD-10-CM/PCS 診斷與手術碼 | 5 |
| `health_supplement_service.py` | 台灣健康補充品 | 1 |
| `food_nutrition_service.py` | 食品營養成分 | 4 |
| `fhir_condition_service.py` | FHIR R4 Condition | 2 |
| `lab_service.py` | LOINC 檢驗碼與參考值 | 4 |
| `clinical_guideline_service.py` | 臨床診療指引 | 2 |
| `twcore_service.py` | TWCore IG CodeSystem | 1 |
| `snomed_service.py` | SNOMED CT International | 4 |

### 跨切面模組

| 檔案 | 說明 |
|------|------|
| `audit.py` | 稽核日誌 |
| `cache.py` | Redis TTL 快取 |
| `database.py` | asyncpg pool 單例 |
| `dataset_status.py` | 資料集載入狀態與工具 gating |
| `metrics.py` | Prometheus 指標 |
| `utils.py` | 結構化 JSON 日誌 |
| `config.py` | 環境變數讀取 |

## server.py

`server.py` 會在 lifespan 內初始化 DB pool、Redis、metrics 與各服務，並依資料集狀態動態註冊工具。

## 已移除領域

既有藥物領域相關模組與工具已自系統移除。
