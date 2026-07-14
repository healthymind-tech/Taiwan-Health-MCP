# Taiwan Health MCP Server

> 台灣醫療健康資料整合 MCP 伺服器
> 整合 ICD-10-CM/PCS、SNOMED CT、LOINC、台灣 FDA 藥品 / 健康補充品 / 食品營養、臨床指引，以及 FHIR R4 IG 授權與驗證工具

[![FHIR](https://img.shields.io/badge/FHIR-R4-blue)](http://hl7.org/fhir/R4/)
[![Node.js](https://img.shields.io/badge/Node.js-20-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.12-orange)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

以官方 **TypeScript MCP SDK**（`@modelcontextprotocol/sdk`）建構的 Node.js 伺服器，對外提供 **51 個工具**，涵蓋 12 個工具群組。專為高吞吐量的生產級 SaaS 部署設計。

> **後端執行環境**：整個後端（MCP server、管理後台 REST API、背景 worker、所有資料載入器）皆為 **Node.js / TypeScript**，程式碼位於 [`node-server/`](node-server/)。前端（公開頁面與管理後台 SPA）為 Next.js，位於 [`web/`](web/)。本專案已無 Python 執行期相依。

## 專案特色

- **台灣在地化資料**：台灣 FDA 藥品（含仿單 / 外觀 / OCR + LLM 分析）、健康補充品、食品營養、臨床指引、TWCore IG。
- **國際術語支援**：ICD-10-CM/PCS 2025、SNOMED CT International、LOINC 2.80、FHIR R4。
- **FHIR IG 授權工具**：多 IG（package-scoped）剖面 / ValueSet 查詢、術語驗證、骨架填值（skeleton-fill）資源產生與驗證。
- **語意 / 混合搜尋**：以嵌入模型（預設 Ollama `qwen3-embedding`）為基礎，無嵌入時自動退回關鍵字搜尋。
- **動態工具啟用**：依各模組資料載入狀態自動註冊 / 移除可用 MCP 工具。
- **管理後台**：可選的 Admin Console（上傳來源檔、執行 / 排程匯入、管理設定與外部 FHIR 伺服器、即時監控背景工作）。
- **生產部署設計**：PostgreSQL 16（pgvector）、pgBouncer、Redis、MinIO、Prometheus、背景 worker，前置 nginx 單一入口。

## 快速開始

```bash
git clone https://github.com/healthymind-tech/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
cp .env.example .env                          # 設定 POSTGRES_PASSWORD、ADMIN_* 等
docker compose up -d
```

`docker compose up -d` 會啟動：

| 服務 | 說明 |
|------|------|
| `nginx` | **單一對外入口**，預設 `:8080`（`WEB_PORT`） |
| `web` | Next.js 前端：公開頁面 + `/admin` 管理後台 SPA |
| `app` | Node MCP 伺服器 + 管理後台 REST API（`node dist/server.js`；只在內部網路，不對主機開埠） |
| `admin-worker` | 背景工作執行器（所有匯入與嵌入工作，`node dist/admin/adminWorker.js`） |
| `postgres` | PostgreSQL 16 + pgvector |
| `pgbouncer` | 連線池（transaction mode） |
| `redis` | 回應快取 |
| `minio` + `minio-init` | 藥品資產物件儲存 |

> **重要**：`app` 容器**不對主機開放 8000 埠**，所有流量都必須經過 nginx。請一律使用 `http://<host>:8080`（或你設定的 `WEB_PORT`）。

程式碼變更後重新部署：

```bash
docker compose build app web && docker compose up -d --no-deps app web
```

## 載入資料（透過管理後台）

資料匯入由 **Admin Console** 觸發、交由 `admin-worker` 背景執行（無獨立的 CLI data-loader 容器）。

1. 在 `.env` 啟用管理後台：

   ```dotenv
   ADMIN_ENABLED=true
   ADMIN_USERNAME=admin
   # 產生密碼雜湊（Node；本專案已無 Python 相依）：
   #   node -e "console.log('sha256$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
   # ⚠️ 在 .env 中，每個 $ 都要寫成 $$（Docker Compose 會把 $ 當變數展開，
   #    當雜湊值以字母開頭時會被靜默截斷）。Compose 會把 $$ 還原成單一 $。
   ADMIN_PASSWORD_HASH=sha256$$...
   ADMIN_SESSION_SECRET=change_this_admin_session_secret
   ```

   重新啟動後（`docker compose up -d`），於 `http://<host>:8080/admin` 登入。

2. 在 **Modules** 頁籤依模組匯入資料：

   - **需上傳來源檔**（在 Sources / Modules 上傳後按匯入）：ICD-10-CM/PCS、LOINC、SNOMED CT、RxNorm、FHIR IG（`package.tgz`）。
   - **由 API 自動抓取**（直接按匯入或設定排程）：藥品（TFDA，三階段：索引 → 爬取豐富 → OCR/LLM 分析）、健康補充品、食品營養。
   - **內建種子資料**（直接執行）：臨床指引。

3. 嵌入（語意搜尋）為獨立的 `*_embed` 工作，可於各模組頁面執行。嵌入 / OCR / 分析 LLM 的端點在 **Settings** 頁籤設定（存於 `admin.llm_profiles`，**不透過環境變數**）。

匯入進度、步驟時間軸與即時日誌可在 **Tasks** 頁籤查看。詳見[管理後台文件](docs/admin/index.md)與[背景工作與排程](docs/admin/jobs-and-worker.md)。

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
>
> 除 `crud_fhir_server` 外，所有工具皆為唯讀。`crud_fhir_server` 可對**已由管理者登錄**的外部 FHIR 伺服器執行寫入（create / update / patch / delete），且必須該伺服器的 allow-list 允許、呼叫端並帶入 `confirm_write=true`。

## 連接客戶端

兩種介面都經由 nginx 前門提供（預設 `:8080`）：

| 介面 | 端點 | 適用客戶端 |
|------|------|-----------|
| **MCP**（streamable-http） | `http://<host>:8080/mcp` | 原生 MCP 客戶端（Claude Desktop、Open WebUI v0.6.31+ 的 MCP 連線等） |
| **OpenAPI bridge** | `GET http://<host>:8080/openapi.json`、`POST http://<host>:8080/tools/<工具名>` | 僅支援 OpenAPI 工具伺服器的客戶端（如 Open WebUI 的 External Tools / OpenAPI 類型） |

`/openapi.json` 依「目前已啟用的工具」動態產生 OpenAPI 3.1 規格；每個工具對應 `POST /tools/<工具名>`，以 JSON body 當參數呼叫。客戶端只要填基底網址 `http://<host>:8080`，即會自動抓取 `/openapi.json`。

> 注意：這兩個介面目前皆**未強制驗證**（與既有設計一致）；對外開放時請在前面加反向代理或 token。

## 資料庫 Schema

`audit` | `admin` | `icd` | `drug` | `health_supplements` | `food_nutrition` | `loinc` | `guideline` | `fhir`（multi-IG）| `snomed` | `rxnorm`

完整定義見 `db/schema.sql`（PostgreSQL 容器首次啟動時自動套用），增量變更見 `db/migrations/`。

## 管理後台（選用）

預設停用。於 `.env` 設定 `ADMIN_ENABLED=true` 並提供 `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET` 後，可於 `/admin` 存取，用於上傳來源檔、執行與排程資料匯入、管理設定與外部 FHIR 伺服器，以及監控由 `admin-worker` 執行的背景工作。詳見 [`docs/admin/`](docs/admin/index.md)。

## 開發

```bash
# 後端（MCP + admin REST + worker）
cd node-server
npm install
npm run build          # tsc -> dist/
npm run typecheck      # tsc --noEmit
npm test               # node --test（node-server/src/**/*.test.ts）

# 前端（公開頁面 + 管理後台 SPA）
cd web
npm install
npm run build
npm run typecheck
```

詳見[開發指南](docs/development/index.md)與[測試指南](docs/development/testing.md)。

## 文件

完整文件請見 [`docs/`](docs/)，線上版由 MkDocs 發佈於 [GitHub Pages](https://healthymind-tech.github.io/Taiwan-Health-MCP)（設定見 `mkdocs.yml`）。

## 致謝

- 台灣衛生福利部、TFDA
- Regenstrief Institute（LOINC）
- SNOMED International
- National Library of Medicine（RxNorm / UMLS）
- HL7 International（FHIR）
- WHO
