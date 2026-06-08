# Taiwan Health MCP Server

> 台灣醫療健康資料整合 MCP 伺服器
> 整合 ICD-10-CM/PCS、SNOMED CT、LOINC、台灣 FDA 藥品 / 健康補充品 / 食品營養、臨床指引，以及 FHIR R4 IG 授權與驗證工具

[![FHIR](https://img.shields.io/badge/FHIR-R4-blue)](http://hl7.org/fhir/R4/)
[![Python](https://img.shields.io/badge/Python-3.12-green)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-1.25-orange)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

以官方 **`mcp` SDK**（`mcp.server.fastmcp.FastMCP`）建構，對外提供約 **51 個工具**，涵蓋 12 個工具群組。專為高吞吐量的生產級 SaaS 部署設計。

## 專案特色

- **台灣在地化資料**：台灣 FDA 藥品（含仿單 / 外觀 / OCR 分析）、健康補充品、食品營養、臨床指引、TWCore IG。
- **國際術語支援**：ICD-10-CM/PCS 2025、SNOMED CT International、LOINC 2.80、FHIR R4。
- **FHIR IG 授權工具**：多 IG（package-scoped）剖面 / ValueSet 查詢、術語驗證、骨架填值（skeleton-fill）資源產生與驗證。
- **語意 / 混合搜尋**：以 Ollama 嵌入模型（`qwen3-embedding`）為基礎，無嵌入時自動退回關鍵字搜尋。
- **動態工具啟用**：依各模組資料載入狀態自動註冊 / 移除可用 MCP 工具。
- **管理後台**：可選的 Admin Console（上傳來源檔、執行 / 排程匯入、管理設定與外部 FHIR 伺服器、即時監控背景工作）。
- **生產部署設計**：PostgreSQL 16（pgvector）、pgBouncer、Redis、MinIO、Prometheus、背景 worker。

## 快速開始

```bash
git clone https://github.com/audi0417/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
cp .env.example .env                          # 設定 POSTGRES_PASSWORD 等
cp config/datasets.example.yaml config/datasets.yaml
docker compose up -d                          # postgres / pgbouncer / redis / minio / app / admin-worker
docker compose --profile loader run --rm data-loader --all
```

若只想個別初始化模組：

```bash
docker compose --profile loader run --rm data-loader --icd
docker compose --profile loader run --rm data-loader --loinc
docker compose --profile loader run --rm data-loader --twcore
docker compose --profile loader run --rm data-loader --guideline
docker compose --profile loader run --rm data-loader --snomed
docker compose --profile loader run --rm data-loader --health-supplements
docker compose --profile loader run --rm data-loader --food-nutrition

# 藥物域 — 三階段管線，依序執行：
docker compose --profile loader run --rm data-loader --drug-index    # 36_2.csv 許可證索引
docker compose --profile loader run --rm data-loader --drug-enrich   # TFDA 爬取仿單 / 外觀 / 文件資產
docker compose --profile loader run --rm data-loader --drug-analysis # 仿單 OCR + LLM 分析
```

## 工具群組

| 群組 | 工具 |
|------|------|
| ICD-10 | `search_medical_codes`、`infer_complications`、`get_nearby_codes`、`check_medical_conflict`、`browse_icd_category` |
| 藥品 / TFDA | `search_drug`、`identify_unknown_pill`、`get_drug_details`、`get_drug_asset_links` |
| 檢驗 / LOINC | `search_loinc`、`query_loinc`、`interpret_lab_result`、`batch_interpret_lab_results` |
| 臨床指引 | `search_clinical_guideline`、`query_guideline` |
| SNOMED CT | `search_snomed_concept`、`query_snomed_concept`、`get_snomed_relationships`、`query_snomed_mapping` |
| FHIR Condition | `query_fhir_condition`、`validate_fhir_condition` |
| FHIR Medication | `query_fhir_medication`、`validate_fhir_medication` |
| FHIR IG（授權 / 驗證） | `fhir_list_igs`、`fhir_get_ig`、`fhir_list_artifacts`、`fhir_search_artifacts`、`fhir_list_resource_profiles`、`fhir_rank_resource_profiles`、`fhir_get_profile`、`fhir_get_profile_elements`、`fhir_get_valueset`、`fhir_expand_valueset`、`fhir_lookup_code`、`fhir_validate_code`、`fhir_normalize_code`、`fhir_resolve_reference`、`fhir_build_bundle`、`fhir_validate_resource`、`fhir_validate_bundle`、`fhir_get_resource_skeleton`、`fhir_finalize_resource` |
| 健康補充品 | `search_health_supplements` |
| 食品營養 | `query_food_nutrition`、`query_food_ingredient`、`search_foods_by_nutrient`、`analyze_meal_nutrition` |
| FHIR 伺服器 | `list_fhir_servers`、`get_fhir_server_status`、`crud_fhir_server` |
| 系統 | `health_check` |

> 模組相關工具會依資料載入狀態自動啟用 / 停用；FHIR 伺服器與系統工具則永遠註冊。

## 資料庫 Schema

`audit` | `admin` | `icd` | `drug` | `health_supplements` | `food_nutrition` | `loinc` | `guideline` | `fhir`（multi-IG）| `snomed` | `rxnorm`

完整定義見 `db/schema.sql`（PostgreSQL 容器首次啟動時自動套用），增量變更見 `db/migrations/`。

## 管理後台（選用）

預設停用。於 `.env` 設定 `ADMIN_ENABLED=true` 並提供 `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET` 後，可於 `/admin` 存取 Admin Console，用於上傳來源檔、執行與排程資料匯入、管理設定與外部 FHIR 伺服器，以及監控由 `admin-worker` 執行的背景工作。詳見 `docs/admin/`。

## 開發與測試

```bash
pip install -r requirements.txt
pip install pytest pytest-asyncio
python -m pytest tests/ -v
```

## 文件

完整文件請見 [`docs/`](docs/) 與 MkDocs 設定（`mkdocs.yml`）。

## 致謝

- 台灣衛生福利部、TFDA
- Regenstrief Institute（LOINC）
- SNOMED International
- National Library of Medicine（RxNorm / UMLS）
- HL7 International（FHIR）
- WHO
