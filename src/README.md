# src/ 服務模組說明

本目錄包含 MCP server 入口與目前保留的核心服務模組。

## 模組一覽

| 檔案 | 服務 | MCP 工具數 |
|------|------|-----------|
| `server.py` | 入口點（DynamicFastMCP + lifespan） | 最多 24 |
| `icd_service.py` | ICD-10-CM/PCS 診斷與手術碼 | 5 |
| `drug_service.py` | TFDA 藥物搜尋、資產與外觀查詢 | 4 |
| `health_supplements_service.py` | 台灣健康補充品 | 1 |
| `food_nutrition_service.py` | 食品營養成分 | 4 |
| `fhir_condition_service.py` | FHIR R4 Condition | 2 |
| `fhir_medication_service.py` | FHIR R4 Medication / MedicationKnowledge | 2 |
| `lab_service.py` | LOINC 檢驗碼與參考值 | 4 |
| `clinical_guideline_service.py` | 臨床診療指引 | 2 |
| `twcore_service.py` | TWCore IG CodeSystem | 1 |
| `snomed_service.py` | SNOMED CT International | 4 |

### 跨切面模組

| 檔案 | 說明 |
|------|------|
| `audit.py` | 稽核日誌 |
| `admin_console.py` | Admin Console 的 auth、session 與 HTML helper |
| `admin_jobs.py` | Admin job queue、control verbs、heartbeat、source binding、staged loader adapters 與 drug pipeline jobs |
| `admin_drug.py` | Admin-facing drug pipeline summaries, queue metrics, and license-level status drill-down |
| `admin_services.py` | Admin service probes、cached history serialization、以及 embedding/OCR/analysis/LM 狀態探測 |
| `admin_sources.py` | Admin source upload、去重與 active source 切換 helper |
| `admin_worker.py` | Admin control-plane background worker |
| `cache.py` | Redis TTL 快取 |
| `database.py` | asyncpg pool 單例 |
| `module_status.py` | 資料集載入狀態與工具 gating（含 drug / FHIR 依賴） |
| `metrics.py` | Prometheus 指標 |
| `utils.py` | 結構化 JSON 日誌 |
| `config.py` | 環境變數讀取 |

## server.py

`server.py` 會在 lifespan 內初始化 DB pool、Redis、metrics 與各服務，並依資料集狀態動態註冊工具。
