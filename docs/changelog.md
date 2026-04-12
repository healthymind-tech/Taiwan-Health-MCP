# 更新日誌

---

## [v2.2.0] — 2026-04-12（當前版本）

### 🔍 Drug 搜尋品質改善

- `drug_name` mode 改用 `ts_rank_cd + setweight` 排序（藥名權重 A、適應症權重 C），取代舊版 `ORDER BY license_id`，結果現依相關度排序
- `atc_code` 正則式放寬：接受 1–7 字元（舊版 2–7），單一字母（如 `"C"`）現為有效輸入

### 🌉 RxNorm → TFDA 橋接

- `rxnorm_resolve` 與 `rxnorm_ingredients` 新增 RXCUI→ATC→TFDA 橋接邏輯：
  - 成功時直接回傳台灣 FDA 藥品完整記錄（`license_id`、`manufacturer`、`indication` 等欄位皆填滿）
  - 無 ATC 對應時 fallback 至 RxNorm-only 結果（維持舊行為）
- 新增 `DrugService.search_by_atc_codes(atc_codes: list[str], limit)` 方法支援精確 ATC code 批次查詢
- `rxnorm_resolve` fallback 現正確套用 `limit` 參數（舊版 fallback 不受 limit 限制）

### 🗑️ 移除未使用 embedding 資料表

- 刪除 `drug.license_embeddings`：內容由 name + 幾百字 indication 串接而成，向量主要由 indication 決定，同成分多許可證向量幾乎相同；從未被查詢
- 刪除 `drug.atc_embeddings`：同樣從未被查詢
- 新增遷移腳本：`db/migrations/2026-04-12_drop_unused_drug_embeddings.sql`
- `loader/loaders/embedding_loader.py` 移除對應的 embed 段落與 `_EMBEDDING_COLUMNS` 項目
- `src/drug_service.py` 移除 `_generate_embeddings()` 方法及其呼叫

### 🔧 其他修復

- `interaction` mode：N+1 查詢修復，成分名稱改為單次批次查詢（`WHERE rxcui = ANY($1)`）
- `_normalize_drug_mode_payload`：`mode`/`keyword` 改為強制覆蓋（原為 `setdefault`，導致 bridge path 回傳 `mode="atc_codes"` 而非呼叫端指定的 mode）

---

## [v2.1.0] — 2026-04-12

### 🔁 工具整併與命名一致化

- MCP 對外工具收斂為 **30 個**（含 `health_check`）
- Lab / LOINC 整併為 4 個入口：
  - `search_loinc`（`code` / `category` / `specimen` / `component`）
  - `query_loinc`（`detail` / `reference_range`）
  - `interpret_lab_result`
  - `batch_interpret_lab_results`
- RxNorm 三項能力併入 `search_drug`：
  - `rxnorm_resolve`（藥名 → RXCUI）
  - `rxnorm_ingredients`（RXCUI → 成分）
  - `interaction`（多藥交互作用）
- Drug、Health Supplement、Guideline、TWCore、SNOMED 相關整併入口維持一致的 mode/section 參數風格

### 📖 文件與 metadata

- 更新 README、工具索引、測試題庫與架構文件中的工具數量與入口名稱
- 補齊 mode 型工具 metadata，包含：
  - mode 用法與參數要求
  - 是否使用 embedding（依 mode 說明）
  - 回傳格式說明
- Status page 參數表單改進：enum 與 `anyOf + enum` 皆使用 `select`

### 🧱 Drug 載入防呆與重構規格

- data-loader 新增 RxNorm-first 防呆：
  - `load_drug()` 前檢查 `drug.rx_concepts`，未達門檻時阻擋匯入並提示先執行 `--rxnorm`
- 新增架構規格文件：
  - `docs/architecture/drug-domain-v2-spec.md`
  - 定義 Drug Domain V2（RxNorm-first）資料模型、匯入順序、遷移策略

### 🗃️ Drug 無資料遺失遷移

- 新增 migration：`db/migrations/2026-04-12_drug_schema_no_loss.sql`
  - 舊 `rxnorm.*` 自動併入 `drug.rx_*`
  - 寫入前先備份異常/重複列到 `migration_backup.*`
  - 對齊 `db/schema.sql`：`NOT NULL`、FK、`documents.doc_type='insert'`、去重索引
- FDA 藥品匯入寫入策略調整：
  - `loader/loaders/drug_loader.py`、`src/drug_service.py` 子表 insert 改為 `ON CONFLICT DO NOTHING`
  - 避免來源重複列在新唯一索引下造成匯入失敗

---

## [v2.0.0] — 2026-04-08

### ✨ 新增功能

#### 基礎架構全面升級（PostgreSQL + pgBouncer + Redis + Prometheus）
- 從 SQLite 遷移至 **PostgreSQL 16**，支援生產環境高並發
- 新增 **pgBouncer** 連線池（transaction mode，500 client → 30 PG 連線）
- 新增 **Redis 7** 回應快取（`@cached` 裝飾器，TTL 策略）
- 新增 **Prometheus** 指標（`mcp_tool_requests_total`、`mcp_tool_duration_seconds` 等）
- 新增結構化 JSON 日誌（`src/utils.py`，輸出至 stderr）
- 新增稽核日誌（`src/audit.py`，`@audited` 裝飾器，SHA-256 參數雜湊，HIPAA 合規）

#### 新增服務與工具（本版本新增 14 個 MCP 工具；後續版本已再整併入口）
- **SNOMED CT Service**（4 個工具）— 概念搜尋、上下層脈絡、屬性關聯、ICD-10 雙向對應
- **RxNorm Drug Interaction Service**（3 個工具）— 藥物交互作用檢查、名稱解析、成分查詢
- **TWCore IG Service**（1 個工具）— 30+ 台灣健保 CodeSystem 查詢

#### 資料載入器（Data Loader）
- 新增獨立 Docker 容器（`profiles: [loader]`）
- 支援 `--icd`、`--loinc`、`--twcore`、`--guideline`、`--snomed`、`--rxnorm`、`--drug`、`--health-food`、`--food-nutrition`、`--fda`、`--all`
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
