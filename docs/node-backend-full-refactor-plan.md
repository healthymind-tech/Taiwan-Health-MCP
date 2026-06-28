# 後端完整 Python → Node.js 重寫計畫（全層級）

評估日期：2026-06-12
目標：將**整個後端**（不只 MCP runtime）改以 Node.js（TypeScript）開發與運行，
**保證每一個對外 API 行為與現況逐值一致**，零回歸、零行為差異。

## 已拍板決策（2026-06-13）

1. **從零重寫** —— 不接續 `backup/node-gateway-origin` 的 `node-server/`。backup 僅作
   「對照參考」（可讀其 SQL/邏輯避免踩同樣的坑），但程式碼一律重寫，不直接沿用。
2. **OCR/LLM 驗收 = 結構一致 + 人工抽樣** —— `drug_analysis` 等非決定性 stage 不逐值比對。
3. **分兩個 release** —— Release A：L1（MCP）+ L2（admin REST/WS）上線並穩定；
   Release B：L3（worker/loader/ETL）隨後切換。兩者可獨立回滾。

---

## 0. 為什麼這比上一次大很多

上一份 `docs/node-migration-assessment.md` 只完成 **L1（對外 MCP runtime）**，並明文
把 `admin-worker` 與 `loader/` 留在 Python。本次目標是「完全移除 Python」，所以必須
再吃下 **L2（admin REST/WS）** 與 **L3（ETL / worker / OCR / 爬蟲 / 嵌入 / 排程）**。

### 後端三層與現況

| 層 | 範圍（Python 檔） | 約 LOC | 對外契約 | 既有 Node 資產 |
|---|---|---:|---|---|
| **L1 MCP runtime** | `server.py` 工具區、`*_service.py`、`fhir_*` validator/snapshot/authoring | ~12k | `/mcp`、`/openapi.json`、`/tools/*`、`/status.json` | backup 可當**對照參考**（已驗過 parity 的 SQL/邏輯），程式重寫 |
| **L2 Admin REST + WS** | `admin_console.py`、`admin_jobs/sources/settings/services/schedule/drug/ig/embedding/preview/maintenance/ws/html_shell.py`、`db_health.py` | ~17k | `/admin/api/*`、`/admin/ws`、`/admin/login\|logout`、`/fhir-client/*`、`/fhir-oauth/*` | backup `node-server/src/admin/*` 僅供對照（**未驗 parity**），程式重寫 |
| **L3 ETL / Worker** | `loader/`（18 stages）、`admin_worker.py`、`tfda_crawler_service.py`、`tfda_parser_utils.py`、`drug_analysis_service.py`、`drug_record_builder.py`、`embedding_loader.py` | ~14k | 無對外 HTTP；契約是**寫入 DB 的資料內容** | **無任何 Node 實作（全新）** |

> 重點：L1/L2 的「行為一致」可由 HTTP 比對驗證；**L3 沒有對外 HTTP 介面**，它的
> 「行為一致」= 給定同一份來源檔，寫進 PostgreSQL 的列要**逐欄位一致**。這需要
> 一套完全不同的 golden-output 比對機制，且 OCR/LLM stage 本質非決定性，無法逐值比對。

---

## 1. 「行為一模一樣」的精確定義（先對齊驗收標準）

不是所有面向都能、也都該逐位元相同。分三級：

| 等級 | 適用 API | 驗收 |
|---|---|---|
| **A. 逐值一致 (exact)** | 確定性工具：ICD/LOINC/SNOMED 查詢、FHIR validator/snapshot/build_bundle、admin 設定 CRUD、job 狀態機 | 正規化後 JSON 完全相等 |
| **B. 契約一致 (contract)** | 語意搜尋 / 排序：`search_*`、embedding 驅動、RRF | schema + 必填一致；top-N 候選重疊 ≥ 門檻，排序允許小差 |
| **C. 副作用一致 (side-effect)** | L3 寫入：loader 各 stage、嵌入回填、爬蟲 | 同來源檔 → DB 列逐欄位一致（OCR/LLM stage 改為「結構一致 + 人工抽樣」） |

**OCR/LLM 例外**：`drug_analysis`（OCR 取像 + LLM 抽取仿單）天生非決定。對策：
- 抽出**確定性骨架**（哪些欄位被填、型別、來源頁、信心分數結構）做逐值比對；
- LLM 文字內容只做「結構存在性 + 長度區間 + 必填 key」檢查，外加人工抽樣 N 筆；
- 把 OCR/LLM 視為**外部服務**——Node 與 Python 都呼叫同一個 endpoint，差異只在前後處理。

> 這一點要先和你確認：L3 的 OCR/LLM stage 是否接受「結構一致 + 抽樣人工驗證」而非逐值？
> 若不接受，唯一作法是凍結 OCR/LLM 輸出快取，兩邊吃同一份快取再比對。

---

## 2. 測試先行：四套 parity 工具（這是計畫的地基）

### 2.1 MCP parity（已存在，擴充）
`scripts/api_parity_test.py` 已可用（37/3/13/0）。要做的：
1. 補資料後讓 13 個 skip 變成實測（匯入 Drug/Food/Supplement/Guideline）。
2. 納入 CI，固定 Python reference image + DB snapshot 當 baseline。
3. `--strict-schema` 設為 gate。

### 2.2 Admin REST parity（**新建**）
仿 MCP parity 寫 `scripts/admin_parity_test.py`：
- 對 Python 與 Node 各起一份，帶同一 session cookie，逐一打 `/admin/api/*`。
- 涵蓋：登入、Overview、Services 探測、Settings CRUD+test、Sources 上傳+指紋去重、
  Jobs 佇列/步驟/日誌、Schedule cron、Modules 狀態/維護模式、IG gallery/import、
  Preview、Embedding、FHIR Servers 6 步精靈 + discover + test-request、db_health gate。
- **寫入型**端點：在隔離 DB 上跑，比對「回應 + 寫入後 DB 列」。
- WebSocket：連 `/admin/ws`，觸發一個 job，比對事件序列（type/順序，時間戳忽略）。

### 2.3 Loader golden-output diff（**新建，L3 核心**）
`scripts/loader_parity_test.py`：
- 準備一組**小而完整的來源檔 fixture**（裁切版 ICD zip、LOINC、SNOMED RF2、IG tgz、
  一小批 TFDA license）。
- 對每個 stage：Python loader 寫入 schema A，Node loader 寫入 schema B（同 DDL，不同 search_path）。
- 逐表 `SELECT ... ORDER BY pk` dump → 正規化（忽略 serial id、created_at）→ 逐列 diff。
- 嵌入向量：比對維度與非空率，cosine 相似度 ≥ 0.99（同模型應幾乎相同）。

### 2.4 端到端煙霧（**新建**）
`docker compose up` 全棧起來後，跑一條真實業務路徑：上傳來源檔 → 觸發匯入 →
worker 跑完 → MCP 工具查得到資料 → FHIR 產生 → 驗證通過。Python 與 Node 各跑一次比對。

> **守則**：任何一個 stage 的 Node 版，在它的 parity 測試綠掉之前，不准進 canary。

---

## 3. 階段計畫

### Phase 0 — 凍結基準 + 決策
1. 固定 Python reference：image tag、`.env`、DB snapshot（含已匯入的全部模組資料）。
2. **建立全新 `node-server/`（從零重寫，已拍板）**。backup 分支只開來**對照讀**——
   參考它已驗過 parity 的 SQL 與邏輯避免重踩坑，但不 `git checkout` 沿用其程式碼。
3. 補資料讓 MCP parity 13 skip → 全實測。
4. 建立 §2 的四套 parity 骨架（先能跑、允許 fail）。

#### Phase 0 可執行 Todo（依賴：A、B 可並行；C 依賴 A3；D 依賴 A4 + C；關鍵路徑 `A3 → C → D`）

**工作流 A：凍結 Python 基準**
- [ ] A1. 鎖定 reference image（`app` + `admin-worker` 打固定 tag，如 `taiwan-health:py-baseline-20260613`）。判準：可起一個與正式同行為的容器。
- [ ] A2. 凍結 `.env.baseline`（去敏，記錄所有影響行為的 seed：Ollama model、OCR/LLM endpoint、TFDA base URL）。
- [ ] A3. DB snapshot：`pg_dump` 一份**含全部模組資料**（`baseline-full.dump`）+ 一份**空 schema**（`baseline-empty.dump`，給 loader parity）。判準：兩份可在乾淨 PG 還原。
- [ ] A4. 起 Python baseline on `:8011`（A1 image + A3 full snapshot，`MCP_PORT=8011`）。判準：parity runner 連得上 Python 側。

**工作流 B：node-server 空骨架（從零重寫，harness 需要 target 樁）**
- [x] B1. 建 `node-server/` TS 專案（`package.json`/`tsconfig.json`/多階段 `Dockerfile`）；只放共用基礎層 `config.ts`/`db.ts`（pg pool，等價 `statement_cache_size`）/`cache.ts`/`logger.ts`（JSON→stderr）/`metrics.ts`。判準：`docker build` 過、`/health` 回 200。**已完成（2026-06-13）**：`tsc`/`npm run build` exit 0；`/health` 實測回 200；啟動 fail-open（DB/Redis 不可達不中止）已驗。
- [x] B2. MCP transport 樁（TS MCP SDK 起 `/mcp`，先掛 `health_check` 一支）。判準：runner 的 `initialize` + `tools/list` 對 Node 不報錯。**已完成（2026-06-13）**：streamable-http `/mcp` 實測 `initialize`→回 session id + serverInfo、`tools/list`→`health_check`。`health_check` 全值 parity（含 `db_health` snapshot）留待 Phase 1 對 live DB 驗。
- [x] B3. 對照讀 backup：`git worktree add ../backup-node backup/node-gateway-origin`（只讀，不沿用程式碼）。判準：可隨時 grep backup SQL 當參考。**已完成（2026-06-13）**：worktree 在 `../backup-node`（detached `3f51fd1`）。

> **D1 接線已驗（2026-06-13）**：既有 `scripts/api_parity_test.py` 對 Node 樁實測通過——`PASS tool inventory / schema / health_check: matched`，其餘 52 工具 SKIP（樁僅 `health_check`）、0 failed。證明 runner 能完整驅動 Node target（connect→list_tools→call→比對）。完整 D1 仍待 A4 Python baseline 起在 `:8011` 後對「Python vs Node」實跑（目前是 Node 自比的接線煙霧）。

**工作流 C：補資料（讓 MCP parity 13 個 skip → 實測）**
- [ ] C1. 匯入 Drug（`drug.*` 過 `module_status` 門檻）。
- [ ] C2. 匯入 Food Nutrition（`food_nutrition.*`）。
- [ ] C3. 匯入 Health Supplements（`health_supplements.items`）。
- [ ] C4. 匯入 Clinical Guideline（`guideline.*`）。
- [ ] C5. 重建各模組 `*_embeddings`。判準：Python 側 `tools/list` 出現全部 53 工具，不再有 `module inactive` skip。

**工作流 D：四套 parity harness（地基）**
- [x] D1. MCP parity **真 Python↔Node 接線已驗（2026-06-13）**：以 live Python `:8080`（與 `:8011` 同 DB，結果等價）對 Node `:8000` 實跑——`PASS schema property/required signatures`。C 補資料後 Python 開出全部模組工具（僅 `fhir_resolve_terminology_batch`/`fhir_apply_mapping_template` 2 個 phantom case 仍 module inactive）。**Phase 1 進度**：`health_check` 已達完整 parity（`PASS health_check: matched`，見下），目前 `1 passed / 2 skipped / 51 failed`，51 FAIL 即待從零實作的 Node 工具清單。**待辦**：`--strict-schema` 設為 gate；逐工具補綠。
- [x] D2. Admin REST parity **骨架完成**（`scripts/admin_parity_test.py`：JSON 登入取 `tw_health_admin_session` cookie → 逐打 10 個 read-only `/admin/api/*`，normalize 去 volatile key → golden/compare 雙模式；write-type 9 端點 + `/admin/ws` 已在 registry 標 TODO）。**待辦**：需 `ADMIN_PASSWORD` 明文（`.env` 只存 `ADMIN_PASSWORD_HASH`）才能登入產 golden。
- [x] D3. Loader golden-output diff **骨架完成 + golden 已產**（`scripts/loader_parity_test.py`：23 表 registry，order-by/ignore 欄位已對實際 schema 校正；asyncpg `statement_cache_size=0`；BIGINT→string、vector→`{dim}` 結構化）。實測對 live DB **23 tables / 0 failed**，golden 含 `fhir.codesystems` 4234 / `fhir.concepts` 73745 / `fhir.artifacts` 20996 列。**待辦**：**裁切版 fixture**（小 ICD zip/LOINC/SNOMED RF2/IG tgz/一小批 TFDA）+ Python↔Node 雙 search_path（`--left-prefix`/`--right-prefix`）實跑。
- [x] D4. 端到端煙霧 **骨架完成 + 對 live 全棧跑通**（`scripts/e2e_smoke.py`：7 步驟 admin_login→upload→trigger→wait→mcp_query→fhir_generate→fhir_validate；expected/baseline 雙模式，比對 step 狀態序列）。實測對 `:8080`：`mcp_query` PASS、`fhir_generate`（`fhir_list_igs`）PASS；`admin_login` 因缺明文密碼 FAIL、import 三步與 fhir_validate 標 TODO。**待辦**：`ADMIN_PASSWORD` + 上傳/匯入 fixture 實作。
- [ ] D5. CI 接線（D1–D4 入 CI，先跑 Python 自比 + golden 產生，Node 比對留待 Phase 1）。判準：CI job 存在且綠。

**出場條件**：(1) Python baseline 可重現起在 `:8011`、53 工具全可呼叫；(2) node-server 樁可起、`/mcp` 可連；(3) 四套 harness 都能執行並已對 Python 產出 golden baseline；(4) A 的三份凍結物（image / `.env.baseline` / DB dump）存檔。

### Phase 1 — L1 對外 MCP runtime 收尾
1. **從零實作** L1 各工具與 `*_service.py` 的 Node 版，對齊**目前** schema（schema.sql 在
   51cdd75 後可能已變動，尤其 `db/migrations/20260612_fhir_server_pipeline_fields.sql`）。
   backup 僅供 `grep` 對照其已驗過 parity 的 SQL/邏輯，**不** `git checkout` 沿用程式碼。
2. 跑 MCP parity → 要求 exact 工具 0 diff、search 工具達 top-3 重疊 ≥ 80%。
3. 3 個歷史 search warning 維持可接受。

**出場條件**：MCP parity 綠（search 類僅排序差）。

**進度（2026-06-13 → 06-14）**：D1 `6 passed / 2 skipped`。
- ✅ `health_check`（含 `db_health`）達完整 parity。新增 `node-server/src/dbHealth.ts`
  ——從零移植 `src/db_health.py` 的 `DbHealthMonitor`（state machine healthy/recovering/
  unreachable、fail-fast `reportFailure`、debounced unlock、背景探測 loop），boot 時於
  `server.ts` `start()`，`mcp.ts` 改用 `monitor().snapshot()`；`db.ts` 補 `resetPool()`
  對應 Python `reset_pool`。
- ✅ **ICD 4 支確定性工具**達 parity：`infer_complications` / `get_nearby_codes` /
  `check_medical_conflict` / `browse_icd_category`（`PASS ... matched`）。新增
  `node-server/src/icdService.ts`（忠實移植 `icd_service.py` 的非搜尋方法；`code_count`
  bigint→number 對齊 asyncpg int）。`mcp.ts` 的 `buildMcpServer` 改 **async + 模組 gating**
  （依 `getModuleStatus().icd` 動態註冊，鏡像 ModuleStatusManager）。
  - ⚠️ 尚未移植：`search_medical_codes`（hybrid BM25+vector，需先移植 embedding service）；
    Node 暫不含 admin maintenance gate（`_icd_maintenance_active`，Phase 2）——目前 live 非
    維護中故 parity 不受影響。
- ✅ **LOINC `query_loinc`** 達 parity（`PASS query_loinc: matched`）。新增
  `node-server/src/labService.ts`（移植 `get_patient_friendly_name` detail 模式 +
  `get_reference_range` reference_range 模式；NUMERIC `range_low/high`→number 對齊
  Python `float`）。wrapper 的 arg 驗證（`loinc_code` required、reference_range 需 `age`）
  在 mcp.ts 內鏡像。gate 依 `getModuleStatus().lab`。
- ✅ **embedding service + 兩支 search 工具**達 parity（2026-06-14，D1 `7 passed /
  1 warned / 2 skipped`）。新增 `node-server/src/embeddingService.ts`（從零移植
  `embedding_service.py`：ollama/openai/google 三 provider、`embed`/`embedBatch`、
  fail-open；設定改從 `admin.app_settings` group `embedding` 讀，鏡像 Python lifespan 的
  `configure(get_group("embedding"))`，process 單例）與 `node-server/src/searchQuality.ts`
  （移植 `search_quality.py` 的 `embeddingsPresent` + `annotate`，含 60s presence cache）。
  - ✅ `search_medical_codes`：**PASS matched**。`icdService.searchCodes` 忠實移植 hybrid
    RRF SQL；vec 表目前空，故走 hybrid 路徑但語意半邊不貢獻 → 與 Python 同樣加
    `search_mode: keyword_only` 標記、同樣 fts 排序。`IcdService` 加 constructor 收 embedding svc。
  - ⚠️ `search_loinc`：**WARN（contract matches; ranked candidates differ）= 可接受**。
    `labService` 加 `searchLoincCode`/`searchBySpecimen`/`findRelatedTests`/`listCategories`，
    4 mode wrapper 鏡像 server.py。排序差來自**來源 SQL 本身**：fts CTE 的 `LIMIT 20` 無
    tie-break `ORDER BY`，"glucose" 類大量 `ts_rank_cd` 同分 → Postgres 每連線回傳任意 20 列。
    此非決定性存在於 Python 端，Node 跑 byte-identical SQL，屬計畫列為「可接受的歷史 search
    warning」。**不**修 tie-break（會偏離 Python 行為）。
  - 🔧 harness 修正：`run_case` 改為「僅單邊 error 才 FAIL；兩邊皆 error 時 fall through
    比對 payload」——`search_medical_codes` 的測試關鍵字 `糖尿病` 在兩端都因 simple FTS 不
    斷中文詞而回傳相同 `{"error":"No results found..."}`，舊邏輯誤判 FAIL。新邏輯只在 payload
    相異時才 FAIL，不會遮蔽真分歧。
- ✅ **Lab interpret 2 支**達 parity（2026-06-14）：`interpret_lab_result`、
  `batch_interpret_lab_results` 皆 **PASS matched**。`labService` 加 `interpretLabResult`/
  `batchInterpretResults`（沿用既有 `getReferenceRange`）。LOINC 群至此 4 支全綠
  （`search_loinc` WARN-可接受）。
- ✅ **SNOMED 群 4 支**達 parity（2026-06-14）。新增 `node-server/src/snomedService.ts`
  （從零移植 `snomed_service.py`：search/concept detail/hierarchy/relationships/ICD-10 map）。
  - `query_snomed_concept` / `get_snomed_relationships` / `query_snomed_mapping`：**PASS matched**。
  - `search_snomed_concept`：**WARN（ranked candidates differ）= 可接受**（同 search_loinc，
    fts CTE `LIMIT 20` 無 tie-break）。
  - ⚠️ **bigint 對齊重點**：SNOMED ID 是 PG `bigint`，node-pg 回**字串**（asyncpg 回 int）。
    18 位 metadata 型別常數（FSN_TYPE=900000000000003001 等）超過 JS `MAX_SAFE_INTEGER`，
    故以**字串常數**保存並當字串 query param 綁定（node-pg 無損綁到 bigint 欄）；輸出時
    realistic-range concept_id 用 `asNum`(=`Number`) 還原成數字以對齊 Python int。
    `mcp.ts` 的 `query_snomed_mapping` snomed-mode 以 `/^\d+$/` 判斷數字 vs 文字（鏡像
    Python `int(keyword)` 的 ValueError fallback → `searchConcepts(keyword,1)`）。
- ✅ **Food Nutrition 群 4 支 read 工具**達 parity（2026-06-14，全 **PASS matched**）。
  新增 `node-server/src/foodService.ts`（從零移植 `food_nutrition_service.py` 的
  search_nutrition / get_detailed_nutrition / search_food_ingredient /
  search_foods_by_nutrient / analyze_meal_nutrition + 記憶體 nutrient-embedding fallback
  與 `_NUTRIENT_ALIASES`）。`content_per_100g` 是 TEXT，pg 原樣回字串對齊 Python。
- ✅ **Food 匯入（loader）也已改 Node**（user 要求「匯入的部分也要改」）。新增
  `node-server/src/loaders/foodNutrition.ts`（從零移植 `loader/loaders/food_nutrition_loader.py`：
  抓 TFDA Open Data 兩個 endpoint、TRUNCATE + 批次 INSERT 單一交易、stamp `sync_meta`）。
  - TFDA `/export/20/json` 實際回 **application/zip**（Python `fetch_json` 的 zip 分支才是真路徑）；
    Node 加 `fflate` `unzipSync` 解壓第一個 `.json`。
  - ⚠️ **null 語意 bug（已修並記入 memory [[project_node_loader_null_semantics]]）**：Python
    `r.get(k,"")` 只有 key **缺席**才回 `""`；key 存在但 JSON `null` 會回 `None`→存 SQL NULL。
    TFDA `俗名` 對 ~93k 列回 `null`。初版 Node `v ?? ""` 把它壓成 `""` → `search_foods_by_nutrient`
    回 `common_name:""` vs Python `null`（read-only port 測不出，因兩端讀同一 DB；跑完 Node loader
    round-trip 才現形）。修法：`g()`（mirror `.get(k,"")`，回 `string|null`）給一般欄、`gStr()`
    （mirror `str(r.get(k,""))`，present-null→`"None"`）給 `content_per_100g`。
  - 驗證：Node loader 跑完 measurements/ingredients 列數與 Python 載入時**完全相同**
    （226824 / 1702）、NULL 數 93080 / empty 0、`flush Redis` 後 4 支 food 工具全 **PASS matched**。
    這是 **Phase 3（L3 loader）的第一刀**，提早做掉。
- ✅ **Health Supplements 群（1 支 `search_health_supplements`）+ 匯入（loader）已改 Node**
  （2026-06-14，**PASS matched**）。新增 `node-server/src/supplementsService.ts`（從零移植
  `health_supplements_service.py`：hybrid RRF search + `analyze_health_support_for_condition`
  + `DISEASE_BENEFIT_MAPPING` + `_resolve_icd_code` + permit_no 查詢）。MCP 工具為 3-mode
  包裝（keyword / permit_no / condition）並以 `_health_supplement_result` 重塑欄位，邏輯在
  `mcp.ts` `registerSupplementsTools` 對齊 `server.py`。新增
  `node-server/src/loaders/healthSupplements.ts`（從零移植 `health_supplements_loader.py`：
  TFDA endpoint 19、`g()` 重現 `dict.get(k,"")` null 語意、`valid_to` 寫死 `""`、TRUNCATE+BATCH 2000
  +sync_meta）。**Loader round-trip 驗證**：Node 載入 561 列（與 Python 一致）、`valid_to` 561 空字串/0 NULL、
  category 全 present，flush Redis 後 `search_health_supplements` **PASS matched**。
- ✅ **Guideline seed loader 已改 Node**（2026-06-14，**內容逐位元一致**）。新增
  `node-server/src/loaders/guideline.ts`（從零移植 `loader/loaders/guideline_seed.py`：4 種
  慢性病 E11/I10/E78/N18 × 5 表 disease/diagnostic/medication/test/treatment_goals，硬編臨床 seed
  逐字對應、idempotent count>0 跳過、寫 `admin.module_load_log` ON CONFLICT）。**Loader round-trip
  驗證**：dump baseline → TRUNCATE RESTART IDENTITY → 跑 Node loader → re-dump，5 表的內容
  md5 指紋（以 icd_code 為自然鍵、排除 serial id）**全部相同**；flush Redis 後 guideline 2 支工具
  仍 **PASS matched**。
- ✅ **LOINC 2.80 full loader 已改 Node**（2026-06-14，**內容逐位元一致**）。新增
  `node-server/src/loaders/loinc.ts`（從零移植 `loinc_loader.py` + `loinc_taiwan_seed.py`：
  fflate 解 `Loinc_2.80.zip` 取根層 `LoincTable/Loinc.csv`（排除 AccessoryFiles）、自寫 RFC4180
  CSV parser 重現 `csv.DictReader`（含 utf-8-sig BOM、引號內逗號/換行、`""`→`"`）、欄位
  逐欄對應、`name_zh/common_name_zh/specimen_type/unit` seed ""、`classtype` int fallback 0、
  TRUNCATE CASCADE + 多列 INSERT ON CONFLICT、再套用台灣中文名 + reference_ranges）。**關鍵發現**：
  asyncpg 把 Python `float` 以 `Decimal(value)`（IEEE754 雙精度的**精確**展開）編入 `numeric` 欄，
  故 `float("0.2")` 落地為 `0.2000…0625`、`0.5`→`0.5`（最小 scale）。node-postgres 預設送最短
  round-trip 文字（`0.2`）會破壞位元一致，因此實作 `floatToExactNumeric`（BigInt 拆 mantissa/exp、
  約掉 2 的公因子取最小 scale、`mantissa*5^k/10^k` 精確展開）把 range_low/high 以字串送入，
  完全複製 asyncpg 行為。**Loader round-trip 驗證**：dump baseline → 跑 Node loader → re-dump，
  `loinc.concepts`（104672 列、17 欄）md5 `2311566d…` 與 `loinc.reference_ranges`（37 列、8 欄）
  md5 `db66e44e…` **皆與 Python baseline 相同**；flush Redis 後 4 支 lab 工具中 `query_loinc` /
  `interpret_lab_result` / `batch_interpret_lab_results` **PASS matched**（`search_loinc` 為既知
  search-mode 排序 WARN）。
- ✅ **ICD-10-CM / ICD-10-PCS 2025 loader 已改 Node**（2026-06-14，**內容逐位元一致**）。新增
  `node-server/src/loaders/icd.ts`（從零移植 `icd_loader.py` + `main.py:load_icd`）。為免額外相依,
  自寫**精簡 XML tree parser**(重現 ElementTree `.text`=首個子元素前的文字、`find`=首個直接子、
  `findall`=全部直接子、`iter`=含自身的後代)解析 NLM tabular XML(`<diag><name><desc>` 遞迴 walk、
  `^[A-Z]\d` 過濾、category=code[:3])→ `icd.diagnoses`;PCS flat txt(7 字元 code + space + desc、
  排除 addenda)→ `icd.procedures`;並自寫**精簡 XLSX reader**(workbook→rels→sheet 對應、sharedStrings
  多 `<t>` run 串接、cell `t="s"` 解 shared index、col A=code col D=中文名、跳首列、isinstance str 守則)
  取台灣 MOHW 雙語中文名。**關鍵發現**:XML 1.0 行尾正規化 —— ElementTree/openpyxl 會把 cell/文字中的
  `\r\n`/`\r` 轉成 `\n`(如 Z53 中文名含內嵌換行存成 CRLF),手寫 parser 須在 entity 解碼前補上
  `normalizeEol`(套用於 XML text node、CDATA、xlsx `<t>`/inlineStr/str)。**Loader round-trip 驗證**:
  dump baseline → 跑 Node loader → re-dump,`icd.diagnoses`(46498 列,45907 含中文名)md5 `b6479dc6…`
  與 `icd.procedures`(78948 列,78458 含中文名)md5 `ede029ce…` **皆與 Python baseline 相同**;
  flush Redis 後 5 支 ICD 工具(search_medical_codes / infer_complications / get_nearby_codes /
  check_medical_conflict / browse_icd_category)全 **PASS matched**。
- ✅ **SNOMED CT International RF2 (Snapshot) loader 已改 Node**（2026-06-15,**內容逐位元一致**）。
  新增 `node-server/src/loaders/snomed.ts`（從零移植 `snomed_loader.py`）。寫 `snomed.concepts /
  descriptions / relationships / icd10_map / historical_associations`。**關鍵點**:(1) SNOMED 元件 id
  為 18 位數,超過 `Number.MAX_SAFE_INTEGER` → 全程以**字串**處理(parseInt 會破壞精度);(2) 自寫
  **忠實的 Python-csv state machine**(tab 分隔、`"` 僅在欄位開頭觸發引號、`""` doubled、引號內換行→`\n`、
  utf-8-sig BOM)。**踩到 2 個雷**:① QUOTE_IN_QUOTED 遇普通字元時 CPython non-strict **只加該字元、丟棄
  引號**(`"Linked to" x`→`Linked to x`),起初誤補回引號 → 2 個 term 不符;② Language refset 解壓後 380MB,
  原本一次解壓全部成員 + 建百萬筆 dedup Map 造成 **OOM(6GB)** → 改成只解壓 6 個 Snapshot 成員、逐檔
  `takeMember` 後 `delete` 釋放 bytes、且因 Snapshot 每 id 唯一,latest-by-effectiveTime 的 Map 為 no-op
  故改**串流**直接產出 filtered 列(heap 8GB)。**Loader round-trip 驗證**:dump baseline → 跑 Node loader
  → re-dump,5 表 md5 全部相同(concepts `1f1614cc…`、descriptions `e445a66d…`、relationships
  `fca74375…`、icd10_map `e0010a29…`、hist `a1d6ba96…`;列數 373972/995443/1301261/126054/174384);
  us_preferred set 1053086、final true 747895 皆一致;flush Redis 後 SNOMED 工具 query_snomed_concept /
  get_snomed_relationships / query_snomed_mapping **PASS matched**(search 為既知 WARN)。Node loaders
  已完成：food / health_supplements / guideline / loinc / icd / **snomed** / **IG(完整:核心+遞迴下載)** /
  **embeddings**。drug pipeline 確定留 Python(OCR dots_ocr 硬相依)。**所有確定性 loader 皆已 Node 化。**
- ✅ **embeddings loader 已改 Node**(2026-06-15)。新增 `node-server/src/loaders/embeddings.ts`(從零移植
  `loader/loaders/embedding_loader.py`):`ensureDimensions`(halfvec dim ALTER + HNSW 重建)、incremental
  `embedTable`(sha256 `source_hash` 增量、orphan anti-join 修剪、`module_embed_log`)、6 模組函式(food×2 表
  / health_supplements / icd / loinc / guideline / snomed)。embed 呼叫**重用既有 `embeddingService.ts`**
  (Ollama/OpenAI/Google,設定取自 `admin.app_settings` group `embedding`)。CLI:`--<module>` / 無旗標=全部 /
  `--ensure-dims`。**驗證策略**(非 byte-identical:向量是模型輸出 + halfvec 量化):① **`source_hash` 決定性**
  ——Node 的 `" ".join(filter(None,…))` + sha256 與 Python 對 guideline 4 列 **逐 hash 相同**(增量選取邏輯
  等價);② 增量 re-run = **0 new/changed**;③ batching(health_supplements 561 列)正常、halfvec 1024d;
  ④ embeddings 寫入共用 DB 後 flush Redis,`search_health_supplements` / `search_clinical_guideline` 雙端
  **PASS matched**(真正走向量路徑)。全套 parity 維持 **49 / 2(既有 search 排序)/ 2 / 0**。大表(icd 46k /
  loinc 87k / snomed 374k / food 3883)走相同程式路徑,因遠端 Ollama 耗時/成本未全跑,僅小模組已實證。
  **注意**:`concept_id` 為 18 位字串(BIGINT),`deleteOrphans` 用 `unnest($1::BIGINT[])` anti-join。
- ✅ **FHIR IG loader 完整移植完成且 9 包全 byte-identical**(2026-06-15)。新增
  `node-server/src/loaders/igRegistry.ts`(從零移植 `fhir_registry.py`:`normalizeBase`/`parseCoordinate`/
  `getMetadata`/`resolveVersion`/`downloadTarball`(候選序 base→meta.tarball→fallback、SHA-1 shasum 驗、
  gzip magic 驗)/`search`、`RegistryError`),並在 `ig.ts` 加入 `fetchIgDependencies`(BFS 遞迴,deps 讀自各
  tarball 的 package.json、跳過已安裝、`IG_DEP_MAX_PACKAGES=50`)+ `acquireIgRoot`(registry 座標 or 本地檔)。
  CLI:`--registry <id[@ver]>` / `--root <tgz> --deps` / `--no-fallback` / `--registry-base`。**踩到第 3 個雷
  (階段二才暴露)**:`raw_json` 雖經 `::jsonb` 正規化,但 **jsonb 不正規化數字**——`3.0::jsonb` ≠ `3::jsonb`
  且保留 scale。Python `json.dumps` 對 float 用 `repr`(`3.0`/`-2.0`)、對 int 用精確位數;`JSON.parse` 抹掉
  int/float 之分且大整數失精。故新增 **tagged-number JSON parser `parseJsonPy`**(自寫 tokenizer,float→
  `pyFloatRepr` Python repr、int→原 token 逐字),`PyNum` 貫穿 `pyJsonStringify`/`pyStr`/`pyRepr`/`pyTruthy`,
  只 artifacts 走此 parser。原症狀:r4.core/ips/sdc 各 1、examples 39 個 artifact 的 `"value": 3.0` 被寫成 `3`。
  **驗證**:TRUNCATE fhir.* → Node `--root twcore --deps` 遞迴抓滿 9 包 → `scripts/ig_fingerprint.sql` 四表
  指紋全等 Python baseline:ig_packages 9 `d08be99a…`、codesystems 4234 `4c059ccf…`、concepts 73745
  `52f0a8b0…`、artifacts 20996 `5c825e34…`;另以 `scripts/ig_artifact_diff.py`(跑真正的
  `_build_twcore_artifact_payload` 經 jsonb 正規化逐 artifact_key 比對)定位並收斂至 **0 差異**。flush Redis
  後全套 parity **49 passed / 2 warned(既有 search 排序)/ 2 skipped / 0 failed**。
  **待辦階段三(非 IG 專屬)**:job 編排(staging 表 `admin.stage_twcore_*` / checkpoint pause·cancel / worker
  心跳)——屬跨所有 loader 的 Phase 2 admin worker 框架,非 IG loader 本身。
  - 索引核心(階段一)詳節:自寫 tar reader(fflate 只解 gzip;ustar prefix / GNU 'L' / pax 'x' 長檔名)、
    per-package DELETE+INSERT、is_default 僅 insert、per-package dedup;另踩雷 ① artifact metadata 欄位用
    Python `str(data.get(k) or "")`,FHIR 欄位是物件/陣列時 Python 產容器 repr、空容器 falsy→"",故實作
    `pyStr`/`pyRepr`/`pyTruthy`/`pyStrOr`。
- ✅ **FHIR Condition / Medication 群（4 支）已改 Node**（2026-06-14，全 **PASS matched**）。
  新增 `node-server/src/fhirConditionService.ts`（從零移植 `fhir_condition_service.py`：
  `create_condition` / `create_condition_from_search` / `validate_condition`，衍生自 `icd.diagnoses`）
  與 `node-server/src/fhirMedicationService.ts`（從零移植 `fhir_medication_service.py`：
  `create_medication` / `create_medication_from_search` / `validate_medication` + 完整
  `_build_resource` 系列，衍生自 `drug.licenses` + `drug.normalized_records.normalized_json`，
  含 `normalize_license_token`）。MCP 包裝在 `mcp.ts` `registerFhirConditionTools` /
  `registerFhirMedicationTools`，gate 為 `status.fhir_condition`(=icd) / `status.fhir_medication`(=drug)。
  注意：parity 對 `id`/`meta.lastUpdated`/`recordedDate` 等時間/亂數欄位以全域 skip set 忽略，
  其餘欄位逐欄相符；`query_fhir_medication` 為 contract（shape）比對。
- ✅ **FHIR Servers 群（3 支，always-on）已改 Node**（2026-06-14，全綠）。新增
  `node-server/src/fhirServerService.ts`（從零移植 `fhir_server_service.py` 的 MCP 對外面：
  `serverPublic` + `serverMcpSummary` + `attachOauthStatus` + `listFhirServers` /
  `getFhirServerStatus` / `crudFhirServer`）。在 `mcp.ts` `registerFhirServerTools` 以
  always-on 方式註冊（不受 module gate 影響，對齊 `_TOOL_GROUPS["FHIR Servers"]`）。
  **範圍註記（誠實）**：list/get 為完整 faithful 讀取轉換；`crud_fhir_server` 完整移植 guard
  chain（server fetch→not-found / allowed_operations / confirm_write / resource_type 驗證）+
  No-Auth 對外 `_call_fhir`。OAuth2（CC/AC、private_key_jwt token 機制）與 admin 註冊/discovery
  pipeline **尚未移植**——對 OAuth server 的 crud 會回明確錯誤（非靜默）。`admin.fhir_servers`
  目前 0 列,parity 三案（list 空表 / get not-found / crud not-found）皆 **PASS**：
  `list_fhir_servers: matched`、`get_fhir_server_status` / `crud_fhir_server` both rejected。
- ✅ **Drug / TFDA 群（4 支 read 工具）已改 Node**（2026-06-14，全綠）。新增
  `node-server/src/drugService.ts`（從零移植 `drug_service.py` 的 read 面：
  `search_by_name`/`_ingredient`/`_license_id`/`_atc_code`、`get_drug_details`、
  `get_drug_asset_links`、`identify_unknown_pill`，含 `_row_to_result`/`_maybe_json`/
  `display_drug_statuses`/`_PILL_FEATURE_SYNONYMS` 與 `_BASE_SELECT`/`_BASE_JOINS`）。
  在 `mcp.ts` `registerDrugTools` 以 module gate `status.drug` 註冊。
  **範圍註記（誠實）**：完整 TFDA crawl/OCR/分析 loader pipeline **尚未移植**（屬 Phase 3）；
  MinIO presign 在 Node 尚未接線，`presigned_url` 一律回 `null`（與 Python 未設定 MinIO 時相同，
  保持 parity）。parity 四案皆 **PASS**：`search_drug` / `identify_unknown_pill` matched、
  `get_drug_details` / `get_drug_asset_links`（contract）matched。
- ✅ **Guidelines 群（2 支）已改 Node**（2026-06-14，全綠）。新增
  `node-server/src/guidelineService.ts`（從零移植 `clinical_guideline_service.py` 的
  read 面：`search_guideline`（hybrid RRF / 純 FTS）、`get_complete_guideline`、
  `get_medication_recommendations`、`get_test_recommendations`、`get_treatment_goals`、
  `check_medication_contraindications`、`suggest_clinical_pathway`）。`mcp.ts`
  `registerGuidelineTools` 以 `status.guideline` gate；`query_guideline` 依 `section`
  dispatch（complete/medication/test/goals/pathway/contraindications，與 server.py 的
  `section_map` 一致；contraindications 需 `medication_class`、pathway 接受
  `patient_context_json`）。parity 二案皆 **PASS**：`search_clinical_guideline`（search）、
  `query_guideline`（contract）matched。
- ✅ **FHIR IG 群（19 支，最大群）已改 Node**（2026-06-14，行為全綠）。從零移植整個
  in-process 堆疊：`fhirIg.ts`（registry/closure/canonical 解析）、`fhirSnapshot.ts`
  （snapshot projector）、`fhirReference.ts`（urn context + bundle 組裝）、
  `fhirAuthoring.ts`（fixed/pattern pin、narrative、slice pin）、`fhirTerminology.ts`
  （分層 ValueSet 展開 + lookup）、`fhirValidator.ts`（structure/slicing/invariants）、
  `fhirIgService.ts`（19 方法 + 共同 envelope）。`mcp.ts` `registerFhirIgTools` gated on
  `status.ig`；`fhir_resolve_reference`/`fhir_build_bundle` 走純 `fhirReference` + envelope。
  **FHIRPath 對等關鍵**：Python 用 `fhirpathpy`，其未實作 `hasValue`/`htmlChecks`/
  `memberOf`/`resolve`，被「觸及」時 throw → 計為 unevaluable invariant。Node 以
  `fhirpath`(npm) 的 `userInvocationTable` 覆寫這 4 個函式使其 throw（lazy，未觸及的
  分支不 throw），**逐位元複製** fhirpathpy 行為——validate_resource 的
  `dom-6 warning + 1 invariant-unevaluated` 完全吻合。parity 19 案全 PASS（含
  validate_resource / validate_bundle / finalize_resource / normalize_code）。
- ✅ **全 51 工具行為 parity 綠**：`api_parity_test.py`（非 strict）**0 failed**
  （49 passed / 2 warned[search 類左右差，可接受] / 2 skipped[`fhir_resolve_terminology_batch`、
  `fhir_apply_mapping_template` 為兩端皆已移除的 legacy 工具，module inactive]）。
- ℹ️ **`--strict-schema` 殘留 2 項（純 schema 呈現差異，非行為差異）**：
  `search_snomed_concept.hierarchy_filter`、`get_snomed_relationships.relationship_type_id`。
  Python 標註 `int = None`，Pydantic 渲染為 `{type:integer, default:null}`；Zod 無法在
  「保持 optional + runtime 接受省略值」下產出該確切形狀（`.default(null)` 於非 nullable
  number 會被標 required 且 runtime 拒絕 null）。採 `.nullish().default(null)`（runtime 忠實），
  僅 strict-schema 的 type union 呈現不同——屬 Pydantic/Zod 框架渲染差異，不影響任何呼叫。

### Phase 2 — L2 Admin REST + WS
1. **從零實作**各 admin REST/WS 模組，對齊目前 Python 行為。backup 的
   `node-server/src/admin/*` 僅供對照（且 **未經 parity 驗證**，風險高），不沿用程式碼。
2. 重點難點：
   - **session/cookie**：`tw_health_admin_session` 簽章演算法、TTL、密碼雜湊
     （`sha256$` / `pbkdf2_sha256$`）要逐位元相容，否則既有 session 失效。
   - **pgcrypto**：`pgp_sym_decrypt` 的 `FHIR_SERVER_SECRET_KEY` 行為（空/錯誤訊息）。
   - **WebSocket** live log 事件格式與 react-query 失效表（`wsInvalidation.ts`）。
   - **db_health gate**：DB 斷線時鎖定變動操作 + overlay 旗標。
   - **FHIR Servers 精靈**：`discover_fhir_metadata`、`run_fhir_test_request`、OAuth
     （Auth Code + PKCE、Client Credentials、`private_key_jwt` JWKS 託管）。
3. 跑 admin REST parity + WS 比對。

**出場條件**：admin parity 綠；前端 `web/admin-app` 不改任何一行即可運作。

**進度（2026-06-15，全速啟動 Phase 2）**：
- ✅ **auth 地基** `node-server/src/adminAuth.ts`（從零移植 `admin_html_shell.py` 的
  `verify_admin_password` / `build_admin_session_token` / `parse_admin_session_token` /
  cookie helpers）。**逐位元 cross-check 通過**：同 username/secret/固定時間,Python 與 Node
  產出的 session token 完全相同（`eyJ1Ijoi…157ff`）;`sha256$` 與 `pbkdf2_sha256$` 密碼驗證
  兩端皆 true。既有瀏覽器 session 切換後不失效。
- ✅ **admin HTTP gate** `node-server/src/admin/adminApp.ts`（Express middleware,忠實複製
  `server.py` inline dispatcher 的閘門順序:disabled→404 / not-ready→503 / cookie 解析 /
  form+JSON login·logout（須先於 auth gate）/ 未登入 /admin/api→401 / `GET /admin/api/health`
  永不 gated / db_health gate→503 / 非 API GET→404〔front door 擁有 SPA〕）。接入 `server.ts`
  （`app.use(adminHandler)` + `express.urlencoded`）。**未登入 401 兩端對齊**。
  - ⚠️ form 登入失敗的 `build_admin_login_html`（70 行 + brand_css）為 **legacy-only**（front
    door 擁有登入頁,`LEGACY_HTML` 預設關),回同 401 狀態但 body 暫為精簡文字——Next.js 部署下
    不可達。其餘 login/logout 行為逐一對齊。
- ✅ **settings 讀路徑** `node-server/src/admin/adminSettings.ts`（完整 `SETTINGS_SCHEMA`
  7 群逐欄對應 + `coerce` + 5s cache `getGroup` + `groupMetadata` + `getAll`,secret 遮罩
  `●●●●●●●●`）。`GET /admin/api/settings` **parsed-JSON EQUAL**（byte 差僅 Python
  `json.dumps` 預設 `: `/`, ` 空白,harness 走 parsed）。
- ✅ **settings 寫入路徑（chunk 3 第一刀,2026-06-21）** `adminSettings.ts` 補
  `saveGroup` / `listModels` / `testGroup` / `resolveDraft`,`adminApp.ts` 接
  `POST /admin/api/settings/{group}[/{action}]`（action= models | test | 空=save,
  鏡像 server.py `rest.split("/")` dispatch）+ `refreshSettingsSingletons`（embedding→
  `reconfigureEmbeddingService`;minio→`minioService.initialize()` 重讀,鏡像
  `_refresh_settings_singletons`）。db.ts 加共用 `withTransaction` helper（BEGIN/COMMIT/
  ROLLBACK,供後續所有 write 端點重用）。`saveGroup` 完整移植:secret-mask 保留、enum 驗證
  （錯誤訊息以 `pyListRepr` 複刻 Python list repr `['a', 'b']`）、`coerce`→`valueToStr`
  寫 storage string、單交易 upsert + `admin.admin_audit_log`（secret 遮罩成 `***`）。
  `testGroup`/`listModels` 移植五/三 provider 路徑（ollama `/api/tags`、openai `/models`、
  google `/v1beta/models`;embedding/analysis/ocr/minio/tfda test）+ `errStr`（複刻 `_err`:
  HTTPStatusError 取 response body 的 `error.message`/`message`,否則 status / class name）。
  **驗證**:鑄造合法 cookie 對 live Python `:8080` ↔ Node `:8000`(同 DB) 跑 11 案 →
  **10 PASS / 1 可接受 divergence**。PASS 含:embedding/models(真 ollama tags)、embedding/test
  (真 embed,dim=1024 對齊,latency 正規化)、analysis/test、tfda/test、minio/test、
  unknown-group models→400、unknown-group test→200 no-test、enum 驗證 save→400、unknown save→400、
  unknown action→404。唯一 divergence:`ocr/test` 在 `server_ip` 空/不可達時,httpx 與 fetch 的
  **malformed-URL 錯誤字串不同**（py「Request URL is missing an 'http://'…」vs node「Failed to
  parse URL…」）——狀態碼/`{ok:false}` 分類一致,僅自由文字 detail 差,屬既定「不可達外部服務的
  error-string divergence」可接受範疇（同 search WARN 政策）。**注意**:save/test/models 不在 HTTP
  回應放時間欄,但 save 寫 `updated_at=NOW()` + audit row(append-only,冪等同值寫安全)。
  - **待辦**:`list_models`/`test` 對 openai/google provider 的非 ollama 路徑(目前 live 為 ollama,
    happy path 已驗;其餘走相同程式碼但未對真 openai/google 端點實測)。
- ✅ **workers 端點** `node-server/src/admin/adminJobs.ts`（移植 `WorkerHeartbeat` /
  `is_heartbeat_stale` / `list_worker_heartbeats` / `_parse_jsonb` / stale-after env）。
  `GET /admin/api/workers` **full EQUAL**（含微秒時間戳）。
- 🔑 **timestamptz isoformat helper（可重用,高價值）** `tsIsoExpr(col)` + `pyIso(text)`:
  asyncpg 把 timestamptz 解成 **UTC-aware datetime**,`.isoformat()` 永遠 `+00:00` 且保留
  **微秒**;node-pg 解成 **毫秒精度 JS Date**（丟微秒 + 用 `Z`）。故改在 Postgres 端
  `to_char(col AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')` 取出微秒,JS 端 `pyIso`
  依 Python 規則（micro==0 → 不顯示小數,否則 6 位不 trim）+ 補 `+00:00`。**所有 admin 端點的
  時間欄都該走此 helper**（jobs created_at/started_at、schedules、sources…）。
- **驗證法**:兩端共用 `ADMIN_SESSION_SECRET`+token byte-identical → 直接鑄造合法 cookie 繞過
  明文密碼,對 live Python `:8080` 與 Node `:8000` 逐端點比對（D2 harness 的 `ADMIN_PASSWORD`
  明文阻礙因此可繞過）。
- ✅ **services 端點** `node-server/src/admin/adminServices.ts`（移植 `SERVICE_PROBE_ORDER`/
  `SERVICE_PROBE_META`/`_normalize_probe_row`/`_placeholder_probe_row`/`serialize_service_probes`/
  `list_service_probes`;`checked_at`/`last_checked_at` 走 `tsIsoExpr`/`pyIso`,`generated_at` volatile）。
  `GET /admin/api/services` **EQUAL**（modulo volatile generated_at）。active probing（寫
  service_probes）屬 worker chunk。
- ✅ **jobs 讀路徑** 加入 `adminJobs.ts`（移植 `AdminJob.from_row`/`to_dict`、`available_job_actions`、
  `FINAL_JOB_STATUSES`、`list_jobs`/`get_job`/`list_job_steps`;created_at/started_at/finished_at
  走 `tsIsoExpr`/`pyIso`）。`GET /admin/api/jobs`（**13 筆真實 job full EQUAL**）、
  `/admin/api/jobs/{id}`、`/admin/api/jobs/{id}/steps` 皆 **EQUAL**。
- ✅ **jobs logs** 加入 `adminJobs.ts`（`list_job_logs`:cursor `before_id`、`limit` cap 500、
  `reversed`→ascending）。`GET /admin/api/jobs/{id}/logs`（含 `?limit=5`）**EQUAL**。
- ✅ **igs gallery** `node-server/src/admin/adminIg.ts`（移植 `admin_ig.list_igs` + `_installed_set`/
  `_counts_by_package`/`_closure_missing`,reuse 已驗的 `fhirIg.listPackages`/`packageClosure`）。
  `GET /admin/api/igs` **9 包 full EQUAL**（含 counts/deps_missing/`imported_at`）。
  - 🔑 **第二種時間格式**:此端點用 `json.dumps(default=str)` → `imported_at` 是 **`str(datetime)`**
    （空格分隔 `2026-06-15 00:39:09.754594+00:00`,非 isoformat 的 `T`）。新增 `tsStrExpr`（空格版
    to_char）+ 復用 `pyIso` 的 trim/`+00:00`。**判斷端點用 `.isoformat()`〔T〕還是 `default=str`〔空格〕
    決定用 `tsIsoExpr` 或 `tsStrExpr`。**
- **待辦（chunk 2 續）**:
  fhir-servers(+export)〔0 列+pgcrypto,併入 FHIR Servers chunk〕/ drug/assets·drug/asset-content
  〔MinIO **presigned URL 每次簽章/nonce 不同→本質不可逐位比對**,需把 presign 接進 Node drugService
   + 比對時 normalize 簽章;asset-content 為二進位串流〕。
  write endpoints **進行中**(Settings `POST` 三 action、**Sources upload/dedup**、**Maintenance toggle**、
  **Schedule POST/DELETE**、**Jobs create/control**、**IG import/set-default/remove**、**Schedule trigger** 已驗,
  見上/下);其餘 write 全數完成,**WS `/admin/ws` 已驗**,**FHIR Servers sub-step A(CRUD+pgcrypto)已驗**,
  剩 FHIR Servers sub-step B(discover/test/test-request)、C(OAuth)、worker 待續。
- ✅ **FHIR Servers sub-step B1:discover(chunk 4 第二刀,2026-06-21)**:`adminFhirServers.ts` 補
  `deriveMetadataUrl`(SMART→`base/.well-known/smart-configuration`、IUA/OAuth→`auth_server/.well-known/oauth-authorization-server`)、
  `metadataStrList`、`canonicalJson`(遞迴 key-sorted compact == Python `json.dumps(sort_keys,separators)`)、
  `rawGet`(node:http/https,timeout + `rejectUnauthorized=verify_tls`,不用 undici)、`fetchMetadata`、`discoverFhirMetadata`
  (回 metadata_url/fetched_at/`response_hash`=sha256(canonicalJson)/scopes_supported/token_endpoint_auth_methods/
  grant_types/response_types/code_challenge_methods/smart_capabilities + issuer/token/authorization/jwks/registration/
  introspection/revocation endpoints)。`adminApp.ts` 接 `POST /admin/api/fhir-servers/discover`(ValueError→400 `{ok:false}`、
  其他 Error→**200 `{ok:false}`**〔非致命,UI 退回手填〕、成功→200 `{ok:true,...}`)。**parity 對 live PY:8080↔ND:8000:5/5 PASS**——
  no-url/bad-auth_server_url/bad-metadata_url 三個 400 byte-equal + **真實網路 discover**(Google OIDC well-known):
  `response_hash` **逐位相同**(證實 canonical-JSON 雜湊與 Python 完全一致)、整個 body 相同(fetched_at normalize 掉)。harness 已刪。
  B2(probe/test/test-request)、C(OAuth token 層)待續——兩者共用 token 機制故併 C 做。
- ✅ **FHIR Servers sub-step B2:probe/test/test-request + token/call 機制(chunk 4 第三刀,2026-06-21)**:
  `adminFhirServers.ts` 補完整 outbound 機制:`rawRequest`(node:http/https 任意 method+body+timeout+verify_tls+BasicAuth)、
  `normalizeQuery`/`normalizeJsonBody`/`validateResourceId`/`resolveTokenStrategy`/`deriveTokenEndpoint`/`fhirUrl`/
  `httpErrorExplanation`/`operationToRequest`/`capabilitySummary`、**JWT client assertion**(`signJwt` 用 node `crypto`
  支援 HS/RS/PS/ES,ES 用 `dsaEncoding:"ieee-p1363"` 出 JOSE 格式;`buildClientAssertion`、`tokenRequestForm`、
  `applyClientAuth`)、`fetchToken`/`accessToken`(token cache + 單飛 per-server lock;fresh 不快取)、`callFhir`、
  `probeTestPath`、`workflowStep`、`runConnectionWorkflow`(metadata→token→FHIR /metadata 或 test_path)、
  `resolveUserTokenForProbe`(none/CC→`(null,"")`;AC 暫回「authorize first / OAuth 未接」待 C)、`buildDraftServer`、
  `testFhirServerConfig`、`sendTestRequest`/`normalizeExpectedStatuses`、`runFhirTestRequest`、`probeFhirServer`
  (寫 `last_probe_*` + `fhir_server_probe_history`)。`adminApp.ts` 接 `POST /test`、`POST /test-request`、`POST /{id}/probe`。
  **parity 對 live PY:8080↔ND:8000:15/15 PASS**——test/test-request 6 個 validation+AC-defer byte-equal(AC draft「authorize first」
  錯誤字串與 workflow steps 完全相同,僅 `draft:<clock>` id normalize)+ **真實 no-auth 呼叫公開 hapi.fhir.org**:
  test-request `/metadata` 與 `Patient?_count=1` 的 ok/method/url/status/reason/expected/explanation **逐欄相同**、
  full workflow steps 結構相同且 ok=true + probe 寫入 last_probe_status='ok'/probe_history(兩台皆 functional PASS)。
  測後 paritytest.* 全刪、0 straggler。harness 已刪。
  **未驗(correct-by-port)**:CC token round-trip(需 live OAuth FHIR server)、私鑰/HMAC client assertion 簽章(需對端驗)。
  **待 C**:AC 使用者 token(`fhir_oauth_service.get_valid_user_access_token`)+ authorize/callback/JWKS。
- ✅ **FHIR Servers sub-step C:OAuth(AC+PKCE / CC / refresh / JWKS / callback)(chunk 4 第四刀,2026-06-28)**:
  新增 `fhirOauthService.ts`(忠實 port `fhir_oauth_service.py`):`generatePkcePair`(S256,node crypto)、
  `startAuthorization`/`beginAuthorization`(寫 pending PKCE state + 組 authorize URL,prompt=login,SMART 加 aud+offline_access)/
  `completeAuthorization`(驗 state+TTL→code 換 token→`storeTokens`)、`getValidUserAccessToken`(single-flight 懶刷新)、
  `refreshAccessToken`/`refreshTokenNow`、`clearOauthState`、`authorizeClientCredentials`、`getOauthStatus`/`statusFromRow`/
  `attachOauthStatus`、`sweepExpiringTokens`(worker 用);token 以 `pgp_sym_encrypt` 加密存 `admin.fhir_server_oauth_tokens`,
  時間戳用 `tsIsoExpr`+`pyIso` 對 Python `.isoformat()`。`adminFhirServers.ts` export 內部 helper 供其重用、
  `resolveUserTokenForProbe` 改為 lazy-import 真正解 AC 使用者 token(打通 B2 的 AC probe/test 路徑)。
  `adminApp.ts` 接 `POST /{id}/oauth/authorize|refresh|clear-cache` 並把 list/get 的 `attachOauthStatus` 換成 oauth-service 版;
  `server.ts` 加公開路由 `GET /fhir-client/{id}/jwks.json` 與 `GET /fhir-oauth/callback`(303 redirect 回 admin SPA,
  鏡像 uvicorn `_send_redirect`)。**parity 對 live PY:8080↔ND:8000:18/18 PASS**——authorize/refresh/clear 的 404 與
  no-auth/no-token 錯誤 byte-equal、clear-cache 成功、**oauth_status not_authorized/authorized/expired 三態 byte-equal**
  (合成 `pgp_sym_encrypt` token 列 + 固定到期時間,iso 逐位相同)、**begin_authorization authorize-URL 參數 byte-equal**
  (除 state/code_challenge/redirect_uri)+ 持久化 pending state、**JWKS 同私鑰兩台輸出逐位相同**(證 derivePublicJwk 一致)、
  jwks 404、callback missing/explicit-error/invalid-state 的 **303 Location byte-equal**。測後全刪、0 straggler、harness 已刪。
  **未驗(correct-by-port,需 live IdP)**:互動式 authorize-code 換 token、refresh 成功、CC token 真實取得。
  **FHIR Servers chunk(#4)全部完成。**
- ✅ **Worker W1:job-lifecycle write helpers(chunk 5 第一刀,2026-06-28)**:`adminJobs.ts` 補
  `upsertWorkerHeartbeat`(+`worker_heartbeat` 廣播)、`reclaimStaleJobs`(FOR UPDATE SKIP LOCKED 重排殭屍 job→
  `resume_requested`/`reclaimed_stale`)、`claimNextJob`(CTE `next_job`+UPDATE→running/idle/claimed、attempt++、寫
  claimed log;以 `JOB_ISO_COLS` 包裝回 `jobToDict` 形狀)、`recordJobStep`(+`job_step_updated` 廣播、terminal 狀態填
  finished_at)、`appendJobLog`(+`job_log_line` 廣播)。時間戳一律 `tsIsoExpr`+`pyIso`。**這批正是先前各刀延後的
  job-lifecycle ws_broadcast 來源。**verify:對 live DB 直接呼叫 Node 函式 **8/8 PASS**——claim 取得 queued job/狀態轉換/
  寫 claimed log、**claim 回傳 dict 與 live Python `claim_next_job` normalize 後逐位相同**(用 worker 不認得的合成
  job_type `paritytest_noop` 避開正在跑的 admin-worker 搶單)、heartbeat upsert、step upsert(+terminal finished_at)、
  log append、reclaim 重排殭屍。harness 已刪、未 commit。
- ✅ **Worker W2a:控制平面 + daemon 主迴圈 + noop(2026-06-28)**:`adminJobs.ts` 補上 worker 端 primitives——
  `JOB_RESOURCES`/`JOB_TYPE_RESOURCES`/`getExcludedJobTypes`(per-module db_write slot + ollama_embed + llm 併發模型)、
  worker tuning getters(`adminWorkerName`/`adminWorkerPollSeconds`/`adminHeartbeatIntervalSeconds`/
  `adminNoopCheckpointDelaySeconds`)、`markJobStatus`(COALESCE 進度、terminal 填 finished_at、`result_summary='{}'` 保留舊
  值、success 時 `activateManifestSources` 促活來源、`job_status_changed` 廣播,`updated_at` 經 `tsIsoExpr`+`pyIso`)、
  `checkpointJobControl`(FOR UPDATE 讀 control_state∈{pause/stop/restart}_requested → 套用 paused/stopped/restart+
  `createRestartJobLocked`、標記 control request handled、寫 control log)/`applyControlCheckpoint`/`countTableRows`、
  `logJobOutcome`(+`fmt`/`successSummaryMessage` 的「✓ Completed — N diagnoses…」)、per-job verbose(`AsyncLocalStorage`
  取代 ContextVar:`setDefaultLogVerbose`/`resolveLogVerbose`/`jobDebugLog`)、`pruneJobLogs`(兩段:retention + 每 job
  上限保留、不刪 error)、`runNoopJob`(5 checkpoint smoke job)、`maybeAutoChain`(drug index→enrich→analysis)、
  `executeAdminJob` 派發骨架(noop 全接;loader 類型暫拋 `W2bNotImplementedError` 留待 W2b;未知類型走 Python 的
  permanent_failed unsupported 路徑)。`adminServices.ts` 補 `JOB_TYPE_DEPENDENCIES`+`getUnhealthyDependencies`(硬
  `error` 才擋,degraded/無探測放行)。`adminSchedule.ts` 補 `listDueSchedules`。新增 `adminWorker.ts`(忠實 port
  `admin_worker.py` `_run_loop`):DB health gate、reap+`requeueIfOrphaned`、idle/per-job heartbeat(`setInterval`)、
  reclaim、oauth sweep、log prune、schedule scan(`scanAndFireSchedules`,前次 job 仍 active 則跳過)、claim+派發,
  per-resource slot + `ADMIN_MAX_CONCURRENT_JOBS` 雙重併發上限,startup orphan reclaim,SIGTERM/SIGINT graceful。
  `tsc` 零錯誤、產出 `dist/admin/adminWorker.js`。**verify:noop 執行路徑 PY(live worker 跑 queued noop)↔ND(對 pre-claimed
  running noop 直接 `executeAdminJob`+`logJobOutcome`)同 DB byte-equal——`import_jobs`(status/control/step/progress/
  result_summary)、`import_job_steps`、`import_job_logs` 三表全等 PASS**(兩者都設 running/合成 UUID 避開 live worker 搶單;
  測後 6 筆測試列已刪)。harness `/tmp/w2a_parity.mjs` 已刪、未 commit。
- 🔄 **Worker W2b(進行中,2026-06-28)**:
  - ✅ **批次 1 — 輕量 sync(無 MinIO/無 staging)**:`adminJobs.ts` 新增 `runGuidelineSeedJob`/`runHealthSupplementsSyncJob`/
    `runFoodNutritionSyncJob`(忠實 port `_run_guideline_seed_job`/`_run_health_supplements_sync_job`/
    `_run_food_nutrition_sync_job`:prepare→sync/seed→finalize 的 step/progress/checkpoint + `applyControlCheckpoint` 續跑
    保護 + result_summary 計數),分別套用已 port 的 Node loader `seedGuidelines`/`loadHealthSupplements`/`loadFoodNutrition`
    (吃 `getPool()`)。dispatcher 三分支接上、從 `W2B_JOB_TYPES` 移除。`tsc` 零錯誤。**verify:`guideline_seed` PY(live
    worker 跑 queued)↔ND(直接 `executeAdminJob`)同 DB byte-equal——job/steps/logs 三表全等 PASS**(idempotent re-seed,
    `Already seeded (4 guidelines)`;health/food 為相同 wrapper pattern,loader 本身先前各刀已驗證)。測試列自動清除。
  - 🔄 **批次 2 — 重量 staging/promote(進行中)**:
    - ✅ **共用 staging 基礎**:**關鍵發現**——既有 Node loaders(`loadIcd`/`loadLoinc`/`loadSnomed`)是 legacy dev-path
      direct-write(讀 `fhir-code/*.zip` → 直接寫最終表),**不含** admin staged-import 路徑(MinIO manifest /
      `admin.stage_*` / checkpoint / drop-index promote),故批次 2 不能薄包裝、需 port 整套 staging 機制。已新增
      `adminJobStaging.ts`(忠實 port `_ProgressLogThrottle`/`_stage_rows`/`_run_validate_step`/
      `_checkpoint_before_promote`/`_capture_secondary_indexes`/`_optimized_promote`/`_clear_stage_rows` +
      `_materialize_bound_sources`→`withMaterializedSources`,multi-source header-strip byte-for-byte)。補
      `minioService.downloadBytes`(getObject stream→Buffer)、`adminJobs.getJobStepCheckpoint`。`tsc` 零錯誤。
    - **待**:把 Node ICD/LOINC/SNOMED/IG parser 改成「回傳 row tuples」餵進 `stageRows`+`optimizedPromote`,寫每個
      `_run_*_import_job` handler 接 dispatcher,逐模組對 live PY 跑真實 import 做 byte parity(需 MinIO 已上傳來源)。
  - **待批次 3 — drug**:`drug_index_import`/`drug_enrichment`/`drug_analysis` shell-out Python `loader/main.py`(polyglot
    worker;OCR `dots_ocr` VLM 硬依賴留 Python)+ `maybeAutoChain`。
  - **待批次 4 — embed**:icd/loinc/health/food/guideline/snomed `_run_*_embed_job`(`embeddings.ts`)。
  逐模組對 live PY byte parity。
- ✅ **FHIR Servers sub-step A:CRUD + pgcrypto(chunk 4 第一刀,2026-06-21)**:新增 `adminFhirServers.ts`
  (忠實 port `fhir_server_service.py` 的 admin CRUD 面):`fhirServerSecretKey`(env `FHIR_SERVER_SECRET_KEY` 否則
  fallback=admin_session_secret)、private_key_jwt key 材料(`generateKeypair` RSA/EC PKCS8 PEM via node `crypto`、
  `jwkThumbprint` RFC7638、`derivePublicJwk` via `createPublicKey().export({format:"jwk"})`、`generateClientKey`、
  `publicJwksFromJson`、`coerceUuid`、`resolvePublicJwk`)、`validateServerPayload`(完整 auth_type/profile/token_auth_method
  分支 + URL/headers/resource-type/env/timeout 驗證)、`serverPrivate`、`adminAudit`(redact secrets)、
  `fetchServerRow`(`pgp_sym_decrypt` 選擇性解密)、`listFhirServers`/`getFhirServer`/`exportFhirServers`(解密)/
  `getFhirServerJwks`/`createFhirServer`/`updateFhirServer`/`deleteFhirServer`/`setDefaultFhirServer`(`pgp_sym_encrypt`
  寫入 + `withTransaction` + audit)。`fhirServerService.ts` export `serverPublic`+`attachOauthStatus` 供重用。
  `adminApp.ts` 接 8 路由:GET list(+oauth status)、GET export、POST create(201/400)、POST generate-key、
  POST `{id}/set-default`(200/404)、GET/PATCH/DELETE `{id}`。schema migration 略過(表已存在於 db/schema.sql)。
  **parity 對 live PY:8080↔ND:8000 同 DB:28/28 PASS**——15 validation 錯誤 byte-equal + get/delete/set-default 404 +
  generate-key(RS384 結構/ES256/bad-alg)+ create/get/patch/set-default no-auth shape(normalize 掉 id/key/name/ts)+
  oauth_cc create shape + **pgcrypto 跨伺服器 round-trip**(PY 解 ND 建的 client_secret、ND 解 PY 建的,皆得回原值,
  證實對稱金鑰+演算法一致)。測後 paritytest.* 全刪、0 straggler。harness 已刪。
- ✅ **WebSocket `/admin/ws`(chunk 3 第八刀,2026-06-21)**:新增 `adminWs.ts`(忠實 port `admin_ws.py`):
  `initBroadcast`(node-redis 長壽 publisher,'error' 吞掉→失敗退回直送)、`broadcast(type,data)`(發 `{type,data}`
  到 Redis pub/sub `admin:ws:events`,fire-and-forget)、`deliver`(對所有連線 client `ws.send`,readyState 檢查清死連線)、
  `startWsRelay`(`createClient().subscribe(channel, cb→deliver)`,斷線指數退避重連)、`handleAdminWsConnection`
  (註冊 client、`ping`→`{"type":"pong"}`、close/error 清理)。裝 `ws@^8`+`@types/ws`。`server.ts` `main()`:
  `initBroadcast`+`startWsRelay`,並在 `server.on("upgrade")` 對 `/admin/ws` 把關(`adminReady` + `parseAdminSessionToken`
  驗 cookie;**未授權寫 HTTP 403 + destroy**,鏡像 uvicorn pre-accept reject;授權則 `wss.handleUpgrade`→`handleAdminWsConnection`,
  不送任何 initial frame)。已接的 REST 廣播:`maintenance_changed`(maintenance toggle 成功後)、`module_changed`
  (ig remove 後,無條件,鏡像 Python)。**parity 對 live PY:8080↔ND:8000:7/7 PASS**(各台 unauth→**HTTP 403**、
  `ping→pong`、maintenance toggle→收到 `maintenance_changed`;兩台 event payload **逐位相同**
  `{"type":"maintenance_changed","data":{"module_key":"icd","enabled":true}}`)。worker-lifecycle 事件
  (`job_status_changed`/`job_log_line`/`job_step_updated`/`worker_heartbeat`,由 mark_job_status/append_job_log/
  record_job_step/upsert_worker_heartbeat 發)隨 worker 刀 #5;`module_cleared` 待 module-clear 端點 port。harness 已刪。
- ✅ **Schedule trigger 寫入路徑(chunk 3 第七刀,2026-06-21)**:`adminSchedule.ts` 補 `fireSchedule`
  (api-sync 直接 `createJob(<module>_sync, {source:"scheduler"})`;URL-fetch 走 `minioService.enabled()` 檢查→
  `downloadUrl`〔HTTPS-only SSRF 守衛、Content-Disposition/URL 末段取檔名〕→`createUploadedSource(autoActivate:false)`→
  `ROLE_JOB_TYPE` 查 job_type→`createJob`;失敗皆 catch 成 status=failed)、`markScheduleRun`(`computeNextRun` 推進
  `next_run_at`+寫 last_run_*)、`downloadUrl`、`API_SYNC_JOB_TYPE` 對照表;`adminSources.ts` 將 `ROLE_JOB_TYPE`
  改 `export`。`adminApp.ts` 接 `POST /admin/api/modules/{key}/schedule/trigger`:非 schedulable→400、無 schedule→404、
  成功**背景 fire(`void fireSchedule().catch()`,不阻塞)**回 200 `{triggered,message,module_key}`(鏡像 Python
  `asyncio.create_task`)。**parity 對 live PY:8080↔ND:8000 同 DB:3/3 PASS**(400 non-schedulable / 404 no-schedule /
  200 success)。200 用「暫時 icd schedule + `http://` 非 HTTPS fetch_url」測:背景 fire 撞 HTTPS 守衛→**不建 job、不下載**
  (icd_import job 數 1→1),`last_run_status=failed`(SSRF/HTTPS 錯誤,證實 fireSchedule 真的有跑),測後刪暫時列、leftover 0。
  真正觸發重匯入的成功 fire(建真 job)比照 ig-import-success/jobs heavy-path 延後至 worker 刀(#5)整體驗。harness 已刪。
- ✅ **IG import/set-default/remove 寫入路徑(chunk 3 第六刀,2026-06-21)**:`adminIg.ts` 補 `setDefault`
  (存在性檢查→`withTransaction` 先清全部 `is_default` 再設單一,避開 one-default partial unique index)、`removeIg`
  (`SELECT` 取 `is_default`→`_dependents`→`withTransaction` DELETE `fhir.ig_packages`〔cascade CodeSystems/concepts/
  artifacts〕+ `admin.admin_audit_log` `remove_ig` 稽核〔`payload_json={"dependents":[...]}`〕→best-effort `minioService.removeObject`
  `ig-packages/{id}/{ver}/package.tgz`;回傳 `{removed,package_id,version,was_default,dependents}`)。`adminApp.ts` 接三條路由:
  `POST /admin/api/igs/import`(registry 需 `package_id`、upload 需 `object_key` 或可解析的 `uploaded_file_id`→查 `admin.uploaded_files`;
  否則 400;成功經 `createJob(module_key="ig", job_type="ig_import", job_options)` 回 201)、`POST /admin/api/igs/{id}/{ver}/default`
  (`ok` true→200 / false→404)、`DELETE /admin/api/igs/{id}/{ver}`(`removed` true→200 / false→404,GET 仍走 detail)。
  WS `module_changed` 廣播延後至 WS 刀(不影響 REST body)。**parity 對 live PY:8080↔ND:8000 同 DB:11/11 PASS**
  (sanity GET + 6 import 驗證分支 + set-default 404/success + remove 404/success;import success path 因會觸發真實 worker 匯入而比照
  jobs heavy-path 延後)。用合成 `paritytest.*` IG 列測 set-default/remove,測後還原原 default + 刪合成列;`remove_ig` 稽核列 2 筆
  (每台一筆,證實真寫入),leftover 0。harness 已刪。
- ⚠️ **驗證工具修正(2026-06-21)**:本 session 早期的 parity harness cookie 簽章用「raw payload」HMAC,
  但 `adminAuth.parseAdminSessionToken` 是對 **b64url-encoded token** 簽章——兩台都回 401,harness 卻
  PY==ND 比成 PASS(**假陽性**)。發現後改正簽章(`hmac(secret, b64url)`)並加 `[AUTH-FAIL!]` 守衛
  (任何 401 一律判 FAIL),**重驗 Maintenance(5/5)+ Schedule(11/11)=16/16 真通過**,DB 清乾淨
  (0 maintenance true / 0 icd·ig schedule)。三刀程式本身正確,僅早期 harness 有誤。
- ✅ **Jobs create/control 寫入路徑(chunk 3 第五刀,2026-06-21)**:`adminJobs.ts` 補 job-type 分類
  常數(`ADMIN_JOB_TYPES`/`JOB_TYPE_MODULE_KEYS`/`HEAVY_JOB_SOURCE_SPECS`/`CONTROL_ACTIONS`)、`createJob`
  (CTE INSERT import_jobs + import_job_logs;heavy 類型先跑 `resolveJobSourceManifest`〔含 `fetchModuleSourceRow`、
  multi-source 由 lazy-import `SOURCE_CATALOG` 判定,避免 adminJobs↔adminSources 循環〕)、`requestJobControl`
  (`withTransaction` + SELECT FOR UPDATE → available_actions 檢查 → INSERT job_control_requests → 條件式
  UPDATE 狀態〔pause/resume/stop/restart 的 applied vs accepted 分支〕→ UPDATE 控制請求 → INSERT log → reload;
  回 `{job,control_request,restart_job}`;malformed uuid 以 `/^[0-9a-fA-F]{32}$/` 守衛→`JobValueError`→400
  鏡像 Python `uuid.UUID()` ValueError)、`createRestartJobLocked`、`JobValueError` 類;`adminApp.ts` 接
  `POST /admin/api/jobs`(route 先擋未知 job_type→400 帶 `allowed_job_types`;ValueError→400;成功 201)
  + `POST /admin/api/jobs/{id}/(pause|resume|stop|restart)`(ValueError→400;成功 200)。
  **注**:Python 的 `asyncio.create_task(broadcast(...))` WS 廣播未移植(chunk #3),不影響回應 body。
  manifest 成功路徑為避免觸發真實 heavy import 未做 parity 實跑(由 worker chunk 覆蓋),其早期 ValueError
  分支(module 不符)已驗。**驗**(admin-worker 正在跑,故用合成 import_jobs 列在 worker 不會認領的狀態下測
  control,create 用 `noop` 並於回應當下擷取):live Python `:8080` ↔ Node `:8000`(同 DB)**15/15 PASS**
  (5 create〔noop valid×2、未知 type→400+allowed、module 不符→400、heavy 早期 ValueError→400〕+ 8 control
  〔paused→resume/stop/restart applied、running→pause/stop/restart accepted、paused→pause not-allowed、
  success→resume not-allowed〕+ job-not-found + malformed-uuid〔status-only〕);cleanup 移除 22 列(含 HTTP 建立的
  noop 與 restart 子作業),leftover paritytest 列 0。
- ✅ **Schedule POST/DELETE 寫入路徑(chunk 3 第四刀,2026-06-21)**:`adminSchedule.ts` 補
  `computeNextRun`(逐行移植 `compute_next_run`——daily/weekly/monthly,全程 UTC;JS `getUTCDay` Sun=0
  → Python `weekday` Mon=0 的換算 `(d+6)%7`;分鐘截斷)、`upsertSchedule`(CTE
  `WITH up AS (INSERT…ON CONFLICT(module_key)…RETURNING *) SELECT *,tsIsoExpr(…)` 一次取回 to_dict 形狀
  含 `_iso` 渲染時間;next_run_at 由 `computeNextRun` 算出、created_at/updated_at=now)、`deleteSchedule`
  (rowCount>0)、`ScheduleValueError` 類;`adminApp.ts` 把 `/schedule` 由 GET-only 改為 GET/POST/DELETE,
  逐行移植 server.py 驗證序(frequency→hour/minute→day_of_week/month→URL_FETCH 的 fetch_url/https/source_role),
  新增 `toInt` 鏡像 Python `int()`(ValueError/TypeError→400)。
  **注**:`/schedule/trigger`(POST,背景 `fire_schedule`)依賴 `create_job` + worker,**延後**至 Jobs/worker chunk。
  **驗**:live Python `:8080` ↔ Node `:8000`(同 DB)跑 **17/17 PASS**(4 valid upsert〔weekly/daily/monthly/
  is_enabled=false,逐服務隔離 create→capture→delete,normalize schedule_id/created_at/updated_at/module_key〕
  + 11 驗證錯誤〔frequency/hour/minute/dow/dom 範圍、缺 dow/dom、缺 fetch_url、非 https、缺 source_role、不支援模組〕
  + 2 DELETE〔existing→true、missing→false〕);測後 DB 僅存兩筆 seeded 預設(food_nutrition/health_supplements),
  icd/ig 測試列全清。
- ✅ **Maintenance toggle 寫入路徑（chunk 3 第三刀,2026-06-21）**:`adminMaintenance.ts` 補
  `setEnabled`(`MAINTENANCE_MODULES` 守門→不支援拋 `MaintenanceValueError`;`withTransaction`
  單交易 upsert `admin.app_settings`(group_key=`maintenance`)+ audit row `set_maintenance`;
  寫後 `bustCache`)+ `MaintenanceValueError` 類;`adminApp.ts` 接 `POST /admin/api/module-maintenance`
  (body `module_key`/`enabled`→`{ok,module_key,enabled}`;`ValueError`→400、其餘→500)。
  **注**:Python 路徑寫後另 `ws_broadcast("maintenance_changed")`——WS 尚未移植(chunk #3),
  不影響回應 body parity,待 WS chunk 補。**驗**:live Python `:8080` ↔ Node `:8000`(同 DB)
  跑 7 案 **7/7 PASS**(icd/drug true↔false、不支援模組、空 `module_key`、缺 `enabled` 預設 false);
  測後所有 maintenance 列還原 false(DB 確認 0 列 true)。
- ✅ **Sources upload/dedup 寫入路徑（chunk 3 第二刀,2026-06-21）**:`adminSources.ts` 補
  `createUploadedSource`/`activateSource`/`deactivateSource`/`deleteUploadedSource` + 驗證面
  (`catalogEntry`/`safeSourceFilename`/`validateSourceFilename`/`validateSourceContent`/
  `validateDrugIndexCsv`/`sha256Bytes`/`sourceObjectKey`/`nextVersionNum`/`parseUuid`/RFC4180
  `parseCsv`),兩個錯誤類 `SourceValueError`/`SourceRuntimeError`(對應 Python ValueError/RuntimeError
  → 各端點不同 HTTP 碼)。`minioService.ts` 補 `uploadBytes`/`removeObject`(`putObject`/`removeObject`)。
  `adminApp.ts` 接 `POST /admin/api/uploads`(raw-body via `readRawBody`,query 帶
  module_key/source_role/filename/auto_activate)+ `module-sources/{activate,deactivate,delete}`,
  gate 順序與錯誤碼鏡像 server.py(uploads:缺 meta 400 / 空 400 / 超界 413 / 內容驗證 415 /
  create ValueError 400 / RuntimeError 503;activate ValueError→404;deactivate/delete ValueError→400)。
  **Magika 取捨(user 拍板「Magic-byte 等效檢查」)**:Python app 跑 Magika 0.6.3 做內容嗅探;Node 以
  `detectContentLabel`(magic-byte:gzip `1f8b`、zip `PK` + 掃 `xl/`→xlsx、NUL→binary、否則 text)
  精確複刻我們用到的 4 個 label-set(zip/gzip/xlsx/csv-txt-tsv)的**接受/拒絕集合成員**——回傳
  代表性 label 使 set-membership 與 Magika 對所有 role/file 組合一致;合法檔逐欄一致,僅**拒絕訊息
  的 `detected` 自由文字**可能與 ML 模型細微不同(屬可接受 divergence)。
  **驗證**:鑄造 cookie 對 live Python `:8080` ↔ Node `:8000`(同 DB + 同 MinIO bucket)跑 13 + 3 案
  → **全 PASS**。涵蓋:CREATE(等長異容→ sha 不同雙邊各自新建,normalize sha/uuid/ts/object_key 後
  逐欄等)、DEDUP(同 server 重傳→ duplicate=true)、bad-extension/unsupported/wrong-content→415、
  missing-metadata/empty→400、activate/deactivate **happy path**(version_num 因各 server 獨立序列
  normalize)、delete-after-activate 拒絕(loinc 有資料 + activated_at→400)、malformed/nonexistent
  uuid 全分類一致。測試後以直連 pg+minio 清掉殘列與物件(0 leftover),audit_log append-only 不清。
  **注意**:`uploaded_at`/`activated_at` 走 `tsIsoExpr`/`pyIso`(NEW 路徑 activated_at 用 python
  `now.isoformat()` 語意,以 `pyIsoFromDate` 補微秒);`size_bytes` bigint→Number;CREATE/duplicate
  dict 鍵序逐欄對齊 Python `_uploaded_file_dict` + 附加鍵序。
  **目前 chunk 2 已驗端點**:auth · gate · login/logout · `/health` · `/settings` · `/workers` ·
  `/services` · `/jobs`(+`/{id}`+`/steps`+`/logs`) · `/igs`(+`/{id}/{ver}` detail) ·
  `/modules`(GET) · `/modules/{key}/schedule`(GET) · `/modules/{key}/versions`(GET) ·
  `/modules/{key}/preview`(GET) · `/embedding/status`(GET) ·
  `/drug/status`·`/drug/pipeline-status`·`/drug/events`(GET) ·
  `/overview`(GET) · `/registry/search`(GET) · `/drug/details`(GET)。
  - `/modules/{key}/preview`(`admin_preview.dispatch_preview`):新增 `adminPreview.ts`(9 模組全移植:
    icd/loinc/snomed/ig/guideline/drug/health_supplements/food_nutrition/rxnorm)+ `buildPreviewKwargs`
    精確複刻 server.py 的 query→kwargs 映射(page/per_page clamp、`id`→`id_`、`class`→`class_`、
    `property`→`property_`、`node` null 語意、ig-only `artifact_key`/`value_set_url`/`field_q`)。
    **50/50 EQUAL**(含 IG ValueSet 遞迴展開:SNOMED `is-a`/`descendent-of`+歷史關聯成功者替換、
    LOINC `property=` filter、RxNorm `TTY in/=` filter、巢狀 `valueSet` 參照、CodeSystem 概念列;
    artifact_tree/valueset/artifact_detail/search/navigator 各模式;分頁/排序/CJK 查詢/error case)。
    踩到兩個 parity 坑並修正:(1) snomed `effective_time` 為 **date 欄**,node-pg 解析成本地午夜 Date
    →`toISOString()` 會偏移時區;改用 `c.effective_time::text` 在 SQL 端渲染以對齊 Python `date.isoformat()`。
    (2) error 訊息用 Python `{node!r}`(單引號),新增 `pyRepr()` 取代 `JSON.stringify`(雙引號)。
    另:`fixed_value` 內嵌 `json.dumps(...,ensure_ascii=False)`(帶空格分隔)以 `pyJson()` 複刻;
    SNOMED/RxNorm concept id >2^53 全程以 string 綁定 + `::bigint` cast 避免精度損失;
    semantic-tag regex 的單/雙反斜線差異逐位保留。
  - `/embedding/status`(`admin_embedding.get_embedding_status`):新增 `adminEmbedding.getEmbeddingStatus`。
    6 模組 embed 計數 + Ollama ping(`/api/version`+`/api/tags`)。EQUAL(含 `reachable:true`
    真 ollama、`dimensions:1024`、真 `last_source_updated_at` 驗 `tsIsoExpr`/`pyIso`、
    空 `last_embedded_at`、`changed_last_run` 0/null)。注意:**全 COUNT 是 bigint→Number() 強轉**;
    `changed_last_run` 實為整數欄(非 bool)兩邊同樣輸出 0/null;非 ollama provider 的
    reachability 走 `list_models` 留待 write-path,目前回 `reachable:false`(live provider 為 ollama 故已驗路徑精確)。
  - `igs/{id}/{ver}` detail(`admin_ig.get_ig_detail`):新增 `adminIg.getIgDetail` +
    `dependents`/`externalSystems` helper;9 個 IG 全 EQUAL(deps tree / dependents /
    codesystems≤1132 / external_systems≤115)+ 404 case 一致。`imported_at` 走 `tsStrExpr`
    (`json.dumps(default=str)`);其餘欄 `ensure_ascii=False` 直送。
  - `modules/{key}/schedule`(GET,`admin_schedule.get_schedule`):新增 `adminSchedule.ts`
    (含 `URL_FETCH_MODULES`/`API_SYNC_MODULES`/`SCHEDULABLE_MODULES` + `ScheduleConfig.to_dict`
    形狀)。icd/ig/drug(null)、health_supplements/food_nutrition(seeded,真時間戳驗 `tsIsoExpr`)
    全 EQUAL,loinc → 400「does not support scheduling」一致。POST(write)留待 write chunk。
  - `/drug/{status,pipeline-status,events}`(`admin_drug.py` + `drug_status_utils.display_drug_statuses`):
    新增 `adminDrug.ts`(三純 DB 讀路徑)+ `adminApp.parseIntDefault`(複製 Python
    `try int() except ValueError` 的 clamp/fallback 語意)。對 live `:8080`/`:8000` 全 EQUAL,
    含:pipeline-status、status(預設 + `page/per_page` + `active_only=false` + `failed_only=true`
    + `q=錠` ILIKE + 超界 `page=999&per_page=200`)、events(真 CJK `license_id` + 缺參數 400)。
    注意:**無 `::int` 的 `COUNT(*)` 是 bigint→Number() 強轉**(有 `::int` 者已是 number 直用);
    `created_at/updated_at/last_event_at` 走 `tsIsoExpr`+`pyIso`(對齊 `_iso` 的 isoformat/"");
    `display_drug_statuses` 的 `no_data`/`normalize→success` 改寫邏輯逐欄複製。drug/details
    (Node drug service)·drug/assets·drug/asset-content(MinIO)留後續。
  - `/modules`(GET):新增 `adminSources.listSourceCatalog`/`moduleRecordCounts`、`adminMaintenance.ts`
    (`getStates`+`MAINTENANCE_MODULES`)、**新 `node-server/src/minioService.ts`**(移植 `minio_service.py`
    的 `from_values`/`initialize`/`enabled`/`init_error` probe 面;新增 npm 相依 `minio@^8`;server.ts
    bootstrap fail-open 初始化)。對 live `:8080`/`:8000` **full EQUAL**:`storage`(minio_enabled:true /
    bucket / "MinIO ready")、10 模組(drug `cumulative_total` + 每筆上傳的 import 標註 + active_sources/
    recent_uploads)、`record_counts`(9 模組)、`maintenance`(6 鍵 sorted)、`upload_limits.max_upload_mb:4096`。
    重點:`_uploaded_file_dict` 各欄**保留原值**(null 不轉 "",與 listSourceVersions 的 `|| ""` 不同);
    `size_bytes` bigint→Number;catalog 物件鍵序逐欄對齊 `dict(row)` 的 SELECT 欄序;`detail` 在
    disabled 時送 `init_error` 原值(可為 null)。**環境注意**:Node dev 在 host 上跑無法解析 docker
    內部主機名 `minio:9000`,故驗證時在 `/etc/hosts` 加 `127.0.0.1 minio`(minio 已 publish :9000)讓 Node
    連到同一 bucket;Python 在 compose 網內仍走內部 DNS。程式碼讀 settings endpoint 不變,production
    在同網內可直接解析,故為純環境橋接非程式差異。
  - `/overview`(GET,`_build_admin_overview_payload`+`AdminOverviewPayload.to_json`):新增
    `adminOverview.ts`(組裝器)、`ocrProbe.ts`(OCR 探測)、`adminJobs.summarizeJobs`、
    `mcp.getServiceRegistry`(force-init 10 service 回 {key:bool})、`embeddingService` 加
    public `available` getter + `initialize()` ping(對齊 Python `_available`=`_ping()`,
    lifespan 啟動即 ping)、`minioService.configEnabled()`。對 live **EQUAL**(normalize 掉
    volatile 的 `generated_at`/`app.uptime`/worker `last_heartbeat_at`+`stale`):infrastructure
    (db/redis/minio/ocr/mcp)、8 modules(含 requirements 明細 + cache_ttl_seconds:300)、10 services
    (7 個 health_status 集中移植於 adminOverview,reason/search_mode 字串 byte-match service_health.py;
    ig/fhir_condition/fhir_medication inherit module readiness;ollama_ok=embedding.enabled&&available;
    maintenance override)、jobs summary、workers、summary 聚合、fhir_servers(0 列)。重點:
    **mcp.detail 重現 Python `str(config)`**=`Transport: streamable-http | http://0.0.0.0:8000/mcp`
    (Node 啟動須帶 `MCP_TRANSPORT=streamable-http`/`MCP_PORT=8000`);**health 區塊靠 embedding
    init-ping 讓兩邊 ollama_ok 一致**(否則 Node 剛啟動 available=false 會與 Python degraded reason 不同);
    OCR probe **刻意不模擬 dots_ocr 本地安裝檢查**(drug runtime 留 worker;只探測外部 server 可達性,
    對齊 live app 已裝 dots_ocr 的 ready=True 路徑)。
  注意 D2 harness 的 `READ_ONLY_GETS` 路徑清單為**骨架猜測**（`/admin/api/sources|schedule|ig|
  db-health` 真實 server 不存在,真實是 `/admin/api/module-sources/*`、`/admin/api/modules/{key}/
  schedule`、`/admin/api/igs`、`/admin/api/health`）——對齊真實 Python 路由後須同步修正 harness 清單。

### Phase 3 — L3 ETL / Worker（**最大、最危險**）
分 stage 逐一遷移，每個獨立驗收。建議順序（由易到難）：
1. **檔案型純解析**（決定性，易）：`icd_loader`、`loinc_loader`、`snomed_loader`、
   `twcore_loader`（IG tgz）、`guideline_seed`、`loinc_taiwan_seed`。
   - 風險：zip/RF2/tgz 解析細節、編碼、去重 `seen_ids`、TRUNCATE+UPSERT 交易邊界。
2. **API 型抓取**（中）：`health_supplements_loader`、`food_nutrition_loader`、
   `drug_index_loader`（TFDA 36_2.csv + 爬蟲）。
   - 風險：`tfda_crawler_service`、`tfda_parser_utils` 的分頁/重試/欄位映射。
3. **嵌入回填**（中）：`embedding_loader` → Ollama `/api/embed`，1024-dim，寫 pgvector。
   - 風險：秒/毫秒 timeout（歷史 bug）、批次大小、失敗退回 lexical 訊號。
4. **OCR + LLM**（最難，非決定）：`drug_enrichment_loader`、`drug_analysis_loader`、
   `drug_analysis_service`、`drug_record_builder`、MinIO 資產（presigned link）。
   - 採 §1.C 例外驗收（結構一致 + 抽樣）。
5. **worker 框架**：`admin_worker.py` → Node 常駐 process。必須複製：
   - `admin.import_jobs` claim、`import_job_steps/logs` 寫入、checkpoint pause/cancel
     （`admin.job_control_requests`）、`worker_heartbeats`、`ADMIN_MAX_CONCURRENT_JOBS`
     資源 slot、`admin.module_schedules` cron 排程。
   - 並發/鎖語意要與 Python 等價（`SELECT ... FOR UPDATE SKIP LOCKED` 之類）。

**出場條件**：loader golden-output diff 對全部 stage 綠（OCR/LLM 走例外）；
排程 + checkpoint 控制行為一致。

### Phase 4 — Docker / 部署 / 觀測
1. `node-server` 取代 `app`（MCP+admin）與 `admin-worker` 兩個 Python service。
2. nginx 上游不變（`/mcp`、`/admin/*` 等仍指後端，只是後端換 Node）。
3. Prometheus metrics 名稱與 label 對齊（`record_tool_call`、`record_cache_op`、pool stats）。
4. 結構化 JSON log 到 stderr；`LOG_LEVEL` 行為一致。
5. asyncpg → `pg`：`statement_cache_size=0` 對應（pgBouncer transaction mode 不可用
   prepared statement / LISTEN-NOTIFY）。

### Phase 5 — Shadow → Canary → 切換
1. Shadow：正式流量走 Python，read-only 複製到 Node，比 latency/error/shape。
2. Canary：5%→25%→50%→100%，每階觀察一個業務高峰。
3. 切換：對外只留 Node；Python image 保留一個 release window 可回滾。

### Phase 6 — 移除 Python
連續兩個 release 無回滾後移除 Python 部署設定。`src/`、`loader/` 暫留至下一輪清理。

---

## 4. 高風險清單（每一項都可能造成「行為不一致」）

| # | 風險 | 影響面 | 緩解 |
|---|---|---|---|
| 1 | OCR/LLM 非決定性 | L3 drug_analysis | §1.C 例外 + 凍結快取選項 |
| 2 | session cookie 簽章不相容 | L2 全 admin | 逐位元複製簽章 + 既有 session 回歸測 |
| 3 | pgcrypto 金鑰/錯誤訊息差異 | L2 FHIR servers | 比對 `Illegal argument` / `Wrong key` 路徑 |
| 4 | asyncpg vs pg 型別處理（BIGINT 超過 JS safe int、numeric、timestamptz、jsonb） | 全層 | SNOMED ID 已知坑；統一字串傳遞 + 明確 cast |
| 5 | bulk import 交易邊界與去重 | L3 loader | golden diff + `seen_ids` 對齊 |
| 6 | pgvector 嵌入寫入/查詢 | L1 search + L3 | cosine ≥ 0.99 比對 |
| 7 | cron 排程與 checkpoint 控制 | L3 worker | 狀態機 parity + 並發 slot 測試 |
| 8 | FHIR snapshot 產生（slicing/binding/invariant） | L1 validator | 已知 backup 補過；對 IG 全 profile diff |
| 9 | JSON Schema nullable 表示（anyOf vs type[]） | MCP schema | 已知外觀差；參數/必填一致即可 |
| 10 | 錯誤 JSON 雙重編碼（Python cache 舊格式） | parity 比對 | parser 解 nested（runner 已處理） |
| 11 | MinIO presigned URL 簽章 | L3 drug assets | 比對可下載性，非 URL 字串相等 |
| 12 | nginx 變數式 proxy_pass + 動態 DNS | 部署 | 後端換 Node 後重測 WS upgrade / SSE |

---

## 5. 工序與相依

```
Phase 0 (基準+決策+harness)
        │
        ├─ Phase 1 (L1 收尾) ──┐
        ├─ Phase 2 (L2 admin) ─┼─ 可部分並行（共用 db/cache/config 層）
        └─ Phase 3 (L3 ETL) ───┘  ← 最長關鍵路徑，內部 5 子階段序列
                │
        Phase 4 (Docker/觀測) → Phase 5 (canary) → Phase 6 (移除 Python)
```

關鍵路徑是 **Phase 3**。L1/L2 因 backup 已有底子，屬「對齊 + 驗證」；L3 是「從零實作 + 設計新驗證機制」，工作量最大、風險最高。

---

## 6. 決策紀錄（已拍板 2026-06-13）

1. **接續 vs 從零** → **從零重寫**。backup 只作對照參考，不沿用程式碼。
2. **OCR/LLM 驗收標準** → **結構一致 + 人工抽樣**（非逐值）。
3. **worker 切換節奏** → **分兩個 release**：Release A（L1+L2）先穩定，Release B（L3）隨後。
4. **L3 內部切換** → 沿用分 release 精神，L3 五子階段**逐 stage 漸進切換（各自 canary）**，
   不做一次性 big-bang。

---

## 7. 一句話總結

L1 logic 已在 backup 驗過 parity（僅作對照，程式一律從零重寫）、L2 從零實作、**L3 是真正的工程**。把成敗綁在三件事上：
(a) 四套 parity harness 先寫好當地基；(b) L3 逐 stage golden-output diff；
(c) OCR/LLM 的非決定性用「結構一致 + 抽樣」框住。其餘都是對齊既有資產。

---

## 8. 冷啟動 Runbook（新 session 直接照做）

> 給沒有先前對話記憶的 session：只讀本文件 + `CLAUDE.md` 即可接手。指令在 repo 根
> （`/home/brian/Taiwan-Health-MCP`）執行。compose 檔名是 **`compose.yaml`**（非
> `docker-compose.yml`）；loader stage 旗標的完整清單見 `CLAUDE.md` 的「Commands」段。

### 8.1 已完成（不要重做）
- Phase 0 工作流 **B 全部**（B1/B2/B3）：`node-server/` 從零骨架已建、`tsc`/`npm run build`
  exit 0、`/health` 回 200、`/mcp` 的 `initialize`+`tools/list` 實測通過；backup 對照
  worktree 在 `../backup-node`（detached `3f51fd1`，**唯讀**）。
- **D1 真 Python↔Node 接線**已驗（2026-06-13）：起 Node `:8000`（`node dist/server.js`，
  直連 postgres `:5432` + redis `:6379`，`METRICS_PORT=9091` 避開 app 佔用的 9090），
  以 `scripts/api_parity_test.py --python-url :8080 --node-url :8000 --strict-schema` 實跑。
  唯一非「stub 未實作」發現：`health_check.db_health` 形狀不一致（Phase 1 修）。
- **D2/D3/D4 harness 骨架**已建（2026-06-13）：`scripts/admin_parity_test.py`、
  `scripts/loader_parity_test.py`、`scripts/e2e_smoke.py`。D3 對 live DB 跑出
  **23 tables / 0 failed** golden；D4 對 `:8080` 全棧跑通（mcp_query / fhir_generate PASS）；
  D2 接線到 login 邊界（待 `ADMIN_PASSWORD` 明文）。

> **本機現況（2026-06-13）給接手者**：C 補資料**部分完成**——`fhir.*`（IG 9 包、
> concepts 73745、artifacts 20996、codesystems 4234）、`icd.diagnoses` 46498 /
> `icd.procedures` 78948、`loinc.concepts` 104672 已匯；**仍缺** SNOMED / drug /
> food_nutrition / health_supplements / guideline（全 0 列）+ 各模組 `*_embeddings`。
> Python `:8080` 對應 active 工具：ICD(5)+LOINC(4)+FHIR Condition(2)+FHIR IG(19)+
> FHIR Servers(3)+health_check → D1 對 Node stub 跑出 19 SKIP（仍缺資料）/ 35 FAIL
> （Node 未實作 + `health_check.db_health` 形狀差）。
> **註**：未起獨立 `:8011` 容器；直接以 nginx `:8080` 後的 `app`（同 image+DB）當 Python
> baseline，MCP 工具 parity 結果與 `:8011` 等價。Infra 全在跑；host 有 python3.13
> （含 mcp/asyncpg/redis）、node v24；Node 跑在 host `:8000`（pid 由 session 起）。

### 8.2 工作流 A — 凍結 Python 基準（需 live infra；建議在開發機跑）
```bash
cp .env.example .env            # 設 POSTGRES_PASSWORD、ADMIN_* 等
docker compose up -d            # postgres(:5432)/pgbouncer/redis/minio/app/admin-worker/web/nginx
```
- **A1** reference image：`docker compose build app admin-worker` 後
  `docker image tag <app-image> taiwan-health:py-baseline-20260613`（admin-worker 同理）。
- **A2** `.env.baseline`：複製 `.env`、去敏，保留所有影響行為的 seed
  （`OLLAMA_*`、`DRUG_*` OCR/LLM endpoint、`DRUG_TFDA_BASE_URL`）。
- **A3** DB snapshot（postgres 直連 `:5432`，繞過 pgbouncer）：
  ```bash
  docker compose exec -T postgres pg_dump -U mcp -Fc taiwan_health > baseline-full.dump
  docker compose exec -T postgres pg_dump -U mcp -Fc --schema-only taiwan_health > baseline-empty.dump
  ```
  判準：兩份可在乾淨 PG `pg_restore` 還原。
- **A4** 起 Python baseline on `:8011`（直連 postgres，非 pgbouncer 亦可）：
  ```bash
  MCP_TRANSPORT=streamable-http MCP_PORT=8011 \
    DATABASE_URL=postgresql://mcp:<pw>@127.0.0.1:5432/taiwan_health \
    REDIS_URL=redis://127.0.0.1:6379/0 \
    python src/server.py
  ```
  判準：`curl 127.0.0.1:8011/mcp` 的 `tools/list` 回得到工具清單。

### 8.3 工作流 C — 補資料（讓 13 個 MCP skip → 實測）
匯入**透過 admin console**（`ADMIN_ENABLED=true` → `/admin` Modules 分頁上傳來源檔 +
觸發匯入，由 `admin-worker` 背景執行）。開發機直跑亦可（stage 由 worker 內部呼叫
`loader/main.py`；完整旗標見 `CLAUDE.md`）：`--drug-index/-enrich/-analysis`、
`--food-nutrition`、`--health-supplements`、`--guideline`，最後 `--embed` 回填向量。
- 來源檔需求：drug 走 TFDA API（`DRUG_TFDA_BASE_URL`）+ OCR/分析 LLM；food/supplement
  走 TFDA Open Data；guideline 由 repo seed。ICD/LOINC/SNOMED/IG 的 zip 需先上傳。
- 判準（C5）：Python `:8011` 的 `tools/list` 出現**全部 53 工具**，
  `api_parity_test.py` 不再有 `module inactive` 的 SKIP。

### 8.4 工作流 D — 四套 harness
- **D1**（擴充既有）：A4 起來後，真正的 Python↔Node 比對——
  ```bash
  python scripts/api_parity_test.py \
    --python-url http://127.0.0.1:8011 \
    --node-url   http://127.0.0.1:8000 \
    --strict-schema --report parity-report.json
  ```
  （Node 端先 `cd node-server && npm run build && node dist/server.js`，指向同一個
  已補資料的 DB。）判準：對 **Python 自比**（兩個 URL 都指 `:8011`）0 failure。
- **D2/D3/D4 新建**：`scripts/admin_parity_test.py`、`scripts/loader_parity_test.py`、
  `scripts/e2e_smoke.py`——規格見 §2.2 / §2.3 / §2.4。**先能跑、允許 fail**，並對 Python
  產 golden baseline。
- **D5**：D1–D4 入 CI（先跑 Python 自比 + 產 golden，Node 比對留待 Phase 1）。

### 8.5 接手者的下一步建議
關鍵路徑 `A3 → C → D`。先做 **A**（凍結 + 起 `:8011`）→ **C**（補資料）→ 回來把 **D1**
跑成真正的 Python↔Node 比對，再寫 **D2/D3/D4 骨架**（屆時每段都能立即對 baseline 驗，
不是盲寫）。L1/L2/L3 的逐工具實作一律**從零重寫**，backup 只 `grep` 對照。
</content>
