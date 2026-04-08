# 更新日誌

---

## [v2.0.0] — 2026-04-08（當前版本）

### ✨ 新增功能

#### 基礎架構全面升級（PostgreSQL + pgBouncer + Redis + Prometheus）
- 從 SQLite 遷移至 **PostgreSQL 16**，支援生產環境高並發
- 新增 **pgBouncer** 連線池（transaction mode，500 client → 30 PG 連線）
- 新增 **Redis 7** 回應快取（`@cached` 裝飾器，TTL 策略）
- 新增 **Prometheus** 指標（`mcp_tool_requests_total`、`mcp_tool_duration_seconds` 等）
- 新增結構化 JSON 日誌（`src/utils.py`，輸出至 stderr）
- 新增稽核日誌（`src/audit.py`，`@audited` 裝飾器，SHA-256 參數雜湊，HIPAA 合規）

#### 新增服務與工具（本版本新增 14 個 MCP 工具；目前總數為 56 個）
- **SNOMED CT Service**（6 個工具）— 概念搜尋、IS-A 階層、ICD-10 雙向對應
- **RxNorm Drug Interaction Service**（3 個工具）— 藥物交互作用檢查、名稱解析、成分查詢
- **TWCore IG Service**（3 個工具）— 30+ 台灣健保 CodeSystem 查詢

#### 資料載入器（Data Loader）
- 新增獨立 Docker 容器（`profiles: [loader]`）
- 支援 `--icd`、`--loinc`、`--twcore`、`--guideline`、`--snomed`、`--rxnorm`、`--all`
- 直接連接 PostgreSQL（繞過 pgBouncer）適合大量寫入

#### 新增資料集
- **SNOMED CT International RF2**（20250601，370,000+ 概念）
- **RxNorm Full Release**（2024-06-03）
- **TWCore IG v1.0.0**（衛福部，30+ CodeSystem）
- **ICD-10-CM 2025**（NLM）
- **LOINC 2.80**（Regenstrief Institute）

### 🔧 修復

#### FDA 藥品同步去重（Bug Fix）
- FDA Open Data 原始資料包含重複 `license_id`，導致 `DUPLICATE KEY` 錯誤
- 修復：寫入前使用 `seen_ids` set 去重，確保每個 license_id 只寫入一次
- 現可成功同步 66,266 筆不重複藥品許可證

#### FastMCP Lifespan-per-Session 冪等性修復（Bug Fix）
- FastMCP `streamable-http` 模式對每個 MCP session 執行 lifespan，導致：
  - Prometheus port 重複綁定（Address already in use）
  - 多個 DrugService 實例同時執行 sync，觸發 duplicate key
  - 多個 scheduler 實例同時啟動
- 修復：
  - `server.py`：`_init_lock + _initialized` 全域 flag，只有第一個 session 執行初始化
  - `database.init_pool()`、`cache.init_client()`：idempotent，已初始化則回傳現有實例
  - `metrics.start_metrics_server()`：`_metrics_server_started` flag
  - 各 sync service：`asyncio.Lock` 防並發，`if not scheduler.running` 防重複啟動

#### FDA 同步兩階段寫入（架構改善）
- 重寫 DrugService、HealthFoodService、FoodNutritionService
- 所有 HTTP 請求完成後才開始 DB transaction（防止部分寫入狀態）
- 使用共享 `httpx.AsyncClient` 提升效率

#### ICD-10-PCS 整合
- 從 CMS 下載 `icd10pcs_tables_2025.zip`（78,948 筆手術碼）
- `--icd` loader 同時載入 ICD-10-CM（診斷碼）和 ICD-10-PCS（手術碼）
- `icd_loader.py` 新增 `load_icd10pcs()`，解析 CMS flat codes 格式（7碼 + 說明）
- file picker 優先排除 addenda 差異表，選取主要碼表
- `ICDService._pcs_available` flag：PCS 未載入時工具回傳說明性訊息而非錯誤

### 🏗️ 架構變更

- **Docker Compose** 新增 pgBouncer 服務（`edoburu/pgbouncer`）
- **Dockerfile** 改為多階段建置（builder + runtime），非 root 使用者執行
- **fhir-code/** 目錄整理：所有子目錄改為小寫，各資料集歸類至獨立子目錄
- **data-loader** 移至獨立 Docker 容器（`Dockerfile.loader`）

### 📖 文件更新
- 完整重寫 `README.md`、`CLAUDE.md`、`src/README.md`
- 更新 `docs/` 下所有主要文件（架構、部署、工具清單、資料來源）
- 新增 `fhir-code/README.md`（資料集說明與授權連結）

---

## [v1.1.0] — 2026-01-21

### ✨ 新增功能
- 統一配置管理系統（`src/config.py`）
- 支援 `streamable-http` 傳輸模式
- `.env.example` 範本檔案
- TWCore IG Service（初版）

---

## [v1.0.0] — 初始版本

- ICD-10 診斷與手術碼查詢（SQLite）
- 台灣 FDA 藥品、健康食品、營養資料
- LOINC 檢驗碼
- FHIR R4 Condition/Medication 轉換
- 台灣臨床診療指引
- 32 個 MCP 工具
