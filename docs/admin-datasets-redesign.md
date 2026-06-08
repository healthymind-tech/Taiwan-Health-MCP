# Admin Panel — Modules Tab Redesign

**Status**: Planning — confirmed, ready to implement  
**Scope**: Major UI/UX refactor of admin panel  

---

## 確認的決策 (Confirmed Decisions)

| 議題 | 決定 |
|------|------|
| 頁籤結構 | Overview / Services / Tasks / **Modules** (移除 Imports, Drug, Embeddings) |
| admin_console.py 拆分 | 拆成多個 `admin_html_*.py` 檔案 |
| 排程功能 | v1 必做；DB table + admin-worker 掃描；簡單選項 (daily/weekly/monthly + 時間) |
| 排程技術 | `admin.module_schedules` 新 table；admin-worker 每輪檢查 next_run_at |
| 版本管理 | 歷史紀錄（不支援 rollback）；自動用 activated_at 排序編號 (v1/v2/v3…) |
| Embedding | 完全分散進各 module sub-page，**移除全域 Embeddings tab** |
| RxNorm | **完全移除** — 不在 Modules tab 顯示 |
| UMLS | **完全移除** — 不在 Modules tab 顯示 |
| ICD-10 preview | 樹狀 accordion (lazy load，展開才抓子節點) |
| SNOMED preview | 顯示 top-level concepts + 展開子樹 |
| Drug preview | 保留 phase stats card (Phase 1/2/3) + license list，邏輯優化 |
| Preview API 格式 | 各 module 各自客製 JSON（不強制共用格式）|
| Clinical Guidelines | 只顯示 seed 資料 preview + Run Seed 按鈕 |
| Health Supplements / Food Nutrition | 顯示目前排程 + 可從 UI 修改執行時間 |
| URL fetch 範圍 | ICD-10 (CMS)、TWCore IG (衛福部)、FDA Drug CSV (FDA Open Data) |

---

## 新 Modules 子頁籤清單

| Sub-tab | Module key | Source 類型 | Embedding | URL fetch |
|---------|-------------|------------|-----------|-----------|
| ICD-10 | `icd` | File (ZIP × 2 + optional XLSX) | ✅ | ✅ CMS |
| LOINC | `loinc` | File (ZIP + optional CSV × 2) | ✅ | ✗ (需登入) |
| SNOMED CT | `snomed` | File (ZIP ~540MB) | ✅ | ✗ (需 license) |
| TWCore IG | `twcore` | File (tgz) | ✗ | ✅ 衛福部 |
| Clinical Guidelines | `guideline` | Seed (no file) | ✅ | ✗ |
| Taiwan FDA Drug | `drug` | CSV upload + crawl + OCR/LLM | ✅ future | ✅ FDA Open Data |
| Taiwan FDA Health Supplements | `health_supplements` | API auto-sync | ✅ | 改為 schedule UI |
| Taiwan FDA Food Nutrition | `food_nutrition` | API auto-sync | ✅ | 改為 schedule UI |

---

## 每個 Module Sub-page 版面

```
┌────────────────────────────────────────────────────────────────────┐
│  [ICD-10] [LOINC] [SNOMED] [TWCore] [Guidelines] [Drug] [Health Supplements] [Food Nutrition] │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─── 版本歷史 ──────────────────────────────────────────────┐   │
│  │  v3  2026-05-31 14:32  active ●  (current)               │   │
│  │  v2  2025-11-01 09:10                                     │   │
│  │  v1  2025-01-15 22:00                                     │   │
│  │                                                           │   │
│  │  [↑ Upload new version]                                   │   │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─── 匯入 & 排程 ────────────────────────────────────────────┐  │
│  │  Active source: icd10cm-table-index-2025.zip (v3)         │  │
│  │  Last import: 2026-05-20 14:32  Status: success           │  │
│  │  [Run Import]                                             │  │
│  │  ─────────────────────────────────────────────────────── │  │
│  │  Schedule: Weekly • Monday 02:00 UTC                     │  │
│  │  URL: https://www.cms.gov/...                            │  │
│  │  Next run: 2026-06-02 02:00 UTC  [Edit Schedule]        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─── Embedding ──────────────────────────────────────────────┐  │
│  │  87,234 / 95,001 embedded  91.8%  ████████████░░          │  │
│  │  Last run: 2026-05-28  Model: qwen3-embedding:0.6b        │  │
│  │  Ollama: ● online  [Run Embed]                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─── 目前任務 ───────────────────────────────────────────────┐  │
│  │  icd_import  running  stage 2/3  [Pause] [Stop]           │  │
│  │  icd_embed   queued                                       │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─── 資料預覽 ───────────────────────────────────────────────┐  │
│  │  [Search: ___________]  95,001 diagnoses / 78,020 procs   │  │
│  │  ▶ Chapter I: Certain infectious and parasitic diseases   │  │
│  │    ▶ A00–A09: Intestinal infectious diseases              │  │
│  │      ▶ A00: Cholera                                       │  │
│  │        • A00.0  Cholera due to V. cholerae 01, biovar…   │  │
│  │        • A00.1  Cholera due to V. cholerae El Tor         │  │
│  └────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## 檔案結構變更

### 新增檔案

| 檔案 | 職責 |
|------|------|
| `src/admin_html_shell.py` | CSS variables、page shell HTML、auth helpers、shared JS utils |
| `src/admin_html_overview.py` | Overview tab HTML + JS |
| `src/admin_html_services.py` | Services tab HTML + JS |
| `src/admin_html_tasks.py` | Tasks tab HTML + JS |
| `src/admin_html_modules.py` | Modules tab HTML + JS（sub-tab bar、版本管理、匯入區、排程區、embedding 區、任務區） |
| `src/admin_html_preview.py` | 各 module 的 preview 區 HTML builder（各自客製） |
| `src/admin_schedule.py` | `admin.module_schedules` DB helpers；schedule scan 邏輯（供 worker 呼叫） |

### 修改檔案

| 檔案 | 變更 |
|------|------|
| `src/admin_console.py` | 瘦身為 re-export + `build_admin_overview_html()` 組合各 module；移除原有大量 HTML/JS inline |
| `src/admin_worker.py` | 加入 schedule scan loop（每輪主 loop 掃描 `next_run_at ≤ NOW()` 的 schedule） |
| `src/server.py` | 新增 preview API endpoints；新增 schedule CRUD endpoints |
| `db/schema.sql` | 新增 `admin.module_schedules`；`admin.module_sources` 加 `version_num` |

---

## DB Schema 變更

### 新 table: `admin.module_schedules`

```sql
CREATE TABLE IF NOT EXISTS admin.module_schedules (
    schedule_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_key     TEXT NOT NULL UNIQUE,  -- 每個 module 最多一個 schedule
    source_role     TEXT NOT NULL,          -- 要存放的 source_role（如 'icd10cm'）
    fetch_url       TEXT NOT NULL,          -- 要抓取的 HTTP URL
    frequency       TEXT NOT NULL,          -- 'daily' | 'weekly' | 'monthly'
    day_of_week     SMALLINT,               -- 0=Mon…6=Sun，frequency='weekly' 時用
    day_of_month    SMALLINT,               -- 1–28，frequency='monthly' 時用
    hour_utc        SMALLINT NOT NULL DEFAULT 2,
    minute_utc      SMALLINT NOT NULL DEFAULT 0,
    is_enabled      BOOL NOT NULL DEFAULT TRUE,
    last_run_at     TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ,
    last_run_status TEXT,                   -- 'success' | 'failed' | null
    last_run_job_id UUID REFERENCES admin.import_jobs(job_id) ON DELETE SET NULL,
    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 修改 table: `admin.module_sources`

```sql
ALTER TABLE admin.module_sources
    ADD COLUMN IF NOT EXISTS version_num INT;  -- 由 activate_source() 計算並填入
```

`activate_source()` 時計算：
```sql
SELECT COALESCE(MAX(version_num), 0) + 1
FROM admin.module_sources
WHERE module_key = $1 AND source_role = $2;
```

---

## 新增 API Endpoints

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/admin/api/modules/{key}/versions` | 版本歷史列表（依 activated_at 排序） |
| `GET` | `/admin/api/modules/{key}/preview?...` | 資料預覽（各 module 客製 JSON） |
| `GET` | `/admin/api/modules/{key}/schedule` | 取得排程設定 |
| `POST` | `/admin/api/modules/{key}/schedule` | 建立或更新排程 |
| `DELETE` | `/admin/api/modules/{key}/schedule` | 刪除排程 |

### Preview API 各 module 回傳格式

#### ICD-10 (tree, lazy load)
```
GET /admin/api/modules/icd/preview?node=root           → chapters[]
GET /admin/api/modules/icd/preview?node=A00-A09        → diag[]
GET /admin/api/modules/icd/preview?q=cholera&limit=20  → flat search results
```

#### LOINC (paginated table)
```
GET /admin/api/modules/loinc/preview?page=1&q=sodium&class=CHEM
→ { total, page, rows: [{loinc_num, long_common_name, shortname, class, status, name_zh}] }
```

#### SNOMED (top-level + lazy tree)
```
GET /admin/api/modules/snomed/preview?node=root        → top-level IS-A roots
GET /admin/api/modules/snomed/preview?node=<concept_id>→ children
GET /admin/api/modules/snomed/preview?q=diabetes       → search results
```

#### TWCore IG (master-detail)
```
GET /admin/api/modules/twcore/preview                  → all codesystems[]
GET /admin/api/modules/twcore/preview?cs_id=xxx        → concepts for that CS
```

#### Guidelines (hierarchy)
```
GET /admin/api/modules/guideline/preview               → disease list + guideline summary
GET /admin/api/modules/guideline/preview?id=1          → full guideline detail
```

#### Drug (license list + phase stats)
```
GET /admin/api/modules/drug/preview?page=1&q=&quality=  → license rows + phase stats
```

#### Health Supplements
```
GET /admin/api/modules/health_supplements/preview?page=1&q=   → permit rows
```

#### Food Nutrition
```
GET /admin/api/modules/food_nutrition/preview?page=1&q=→ food rows
GET /admin/api/modules/food_nutrition/preview?mode=ingredients&q= → ingredient rows
```

---

## 詳細 TODO 清單

### Phase A — 檔案重組（不改功能，只拆 admin_console.py）

- [ ] **A1** 建立 `src/admin_html_shell.py`
  - 移出：CSS variables + reset、page shell `<html>…<body>`、`build_admin_login_html()`
  - 移出：`build_admin_session_token()`、`verify_admin_password()`、session helpers
  - 移出：共用 JS utilities（`showAdminTab()`, `toast()`, `fetchJSON()` 等）

- [ ] **A2** 建立 `src/admin_html_overview.py`
  - 移出：`build_admin_overview_html()` 及其 HTML/JS

- [ ] **A3** 建立 `src/admin_html_services.py`
  - 移出：Services tab 的 HTML + `loadServiceProbes()` / `runServiceProbes()` JS

- [ ] **A4** 建立 `src/admin_html_tasks.py`
  - 移出：Tasks tab 的 HTML + job table JS（`loadJobs()`, `renderJobRow()`, `showJobDetail()` 等）
  - **保留全域 task list**（跨所有 module 的 job）

- [ ] **A5** 建立 `src/admin_html_modules.py`（骨架）
  - 新增 Modules tab 主框架（sub-tab bar + 8 個 sub-tab panel 骨架）
  - 先只放 placeholder `<div>` 給各 module，內容 Phase B~D 再填

- [ ] **A6** 瘦身 `src/admin_console.py`
  - 只保留 re-export + `build_admin_page_html()` 組合各 module
  - 移除舊 Imports / Drug / Embeddings tab HTML

- [ ] **A7** 確認 server.py import 路徑全部更新，不 break 現有功能
  - 執行 `python -m pytest tests/ -v` 確認測試通過

---

### Phase B — 版本管理

- [ ] **B1** DB migration：`admin.module_sources` 加 `version_num INT`
  - 更新 `db/schema.sql`
  - 更新 `src/admin_sources.py` 的 `activate_source()` — 計算並填入 version_num
  - 補寫 migration script（已有資料的回填：按 activated_at 排序補版號）

- [ ] **B2** 新增 API `GET /admin/api/modules/{key}/versions`
  - 回傳：`[{ version_num, source_id, original_filename, uploaded_at, activated_at, is_active, job_status }]`
  - 在 server.py 加 route handler

- [ ] **B3** Modules sub-page 加「版本歷史」區塊
  - 在 `admin_html_modules.py` 實作每個 module sub-panel 的版本歷史 section
  - JS：`loadVersionHistory(moduleKey)` → `GET /admin/api/modules/{key}/versions`
  - 顯示：v3/v2/v1 列表；active badge；upload 時間；對應 import job 狀態

- [ ] **B4** 整合上傳按鈕
  - 現有 upload modal 已可上傳；確認上傳後自動刷新版本歷史 section

---

### Phase C — 排程功能

- [ ] **C1** 建立 `src/admin_schedule.py`
  - `ScheduleConfig` dataclass
  - `get_schedule(pool, module_key) -> ScheduleConfig | None`
  - `upsert_schedule(pool, module_key, config, requested_by) -> ScheduleConfig`
  - `delete_schedule(pool, module_key) -> bool`
  - `compute_next_run(frequency, day_of_week, day_of_month, hour_utc, minute_utc) -> datetime`
  - `list_due_schedules(pool) -> list[ScheduleConfig]` — 回傳 `next_run_at ≤ NOW()` 的 schedule

- [ ] **C2** DB migration：`admin.module_schedules` 新 table
  - 更新 `db/schema.sql`（schema 見上方）

- [ ] **C3** 新增 API endpoints
  - `GET /admin/api/modules/{key}/schedule` — 回傳目前 schedule 設定（或 null）
  - `POST /admin/api/modules/{key}/schedule` — 建立/更新（body：`{fetch_url, frequency, day_of_week?, day_of_month?, hour_utc, minute_utc}`）
  - `DELETE /admin/api/modules/{key}/schedule` — 刪除排程
  - 在 server.py 加 route handlers
  - 加 schedule 支援的 module 白名單驗證：`icd`, `twcore`, `drug`（CSV URL）；Health Supplements / Food Nutrition 只能改執行時間（`fetch_url` 鎖定為 FDA API）

- [ ] **C4** `admin_worker.py` 加排程掃描
  - 主 loop 最後加：`due = await list_due_schedules(pool)` — 若有到期 schedule，建立對應 import job 並更新 `last_run_at` / `next_run_at`
  - 確保重複觸發防護（check `last_run_job_id` 對應的 job 是否還在 running）

- [ ] **C5** Modules sub-page 加「排程」區塊（在匯入區內）
  - 顯示：目前排程設定（或「No schedule」）、下次執行時間、上次執行結果
  - [Edit Schedule] → modal（frequency 下拉選單 + 時間輸入 + URL 輸入）
  - [Remove Schedule] 按鈕
  - Health Supplements / Food Nutrition：URL 欄位 disabled（鎖定 FDA API）

---

### Phase D — Embedding 整合

- [ ] **D1** 在各 module sub-page 加 Embedding 區塊
  - 從 `GET /admin/api/embedding/status` 取對應 module 的數據
  - 顯示：embedded count / total / %, progress bar, last run time, model name
  - Ollama 狀態 badge（online/offline）
  - [Run Embed] 按鈕 → `POST /admin/api/jobs {job_type: "{key}_embed"}`（僅對有 embedding 的 module 顯示）
  - 沒有 embedding 的 module（TWCore IG、Clinical Guidelines seed）不顯示此區塊

- [ ] **D2** 移除全域 Embeddings tab
  - 從 `admin_html_shell.py` 的 tab bar 移除 Embeddings tab button
  - 確認所有 embed job 的 WebSocket 即時更新 也在各 module sub-page 生效

---

### Phase E — 資料預覽 API

- [ ] **E1** 新增 preview route dispatcher 在 server.py
  - `GET /admin/api/modules/{key}/preview?...` → 根據 key dispatch 到對應 handler
  - key 白名單：`icd`, `loinc`, `snomed`, `twcore`, `guideline`, `drug`, `health_supplements`, `food_nutrition`

- [ ] **E2** ICD-10 preview handler
  - `?node=root` → SELECT DISTINCT category FROM icd.diagnoses ORDER BY 1（chapters）
  - `?node={chapter}` → SELECT code, name_en, name_zh FROM icd.diagnoses WHERE code LIKE '{prefix}%' AND LENGTH(code) <= 3（sections/categories）
  - `?node={category}` → child codes
  - `?q={text}&type={cm|pcs}` → full text search（ILIKE）limit 50

- [ ] **E3** LOINC preview handler
  - `?page=1&q=&class=&status=ACTIVE` → paginated table（20/page）
  - 回傳：`{total, page, rows: [{loinc_num, long_common_name, shortname, class, status, name_zh, name_en}]}`

- [ ] **E4** SNOMED preview handler
  - `?node=root` → top-level concept_ids（無 IS-A parent 的 active concepts）
  - `?node={concept_id}` → child concepts（IS-A relationship）
  - `?q={text}` → search descriptions ILIKE, limit 30
  - 回傳各 node 的：concept_id, FSN term, active, child_count, icd10_map_targets[]

- [ ] **E5** TWCore IG preview handler
  - `GET .../preview` → all codesystems（cs_id, name, category, concept_count, fetched_at）
  - `GET .../preview?cs_id={id}` → concepts for that codesystem（code, display, definition）

- [ ] **E6** Clinical Guidelines preview handler
  - `GET .../preview` → disease list（icd_code, disease_name_zh/en, guideline_title, pub_year, guideline_source）
  - `GET .../preview?id={id}` → full guideline（+ diagnostic/medication/test recommendations, treatment goals）

- [ ] **E7** Drug preview handler
  - `GET .../preview?page=1&q=&quality=` → license rows + phase stats header
  - Phase stats：Phase1 total/active, Phase2 ei_complete count, Phase3 pdf_ocr count, queue depth
  - License rows：license_id, chinese_name, english_name, drug_category, quality_confidence badge, pipeline status icons

- [ ] **E8** Health Supplements preview handler
  - `GET .../preview?page=1&q=` → `{total, page, rows: [{permit_no, name, applicant, benefit_claims, valid_to}]}`

- [ ] **E9** Food Nutrition preview handler
  - `GET .../preview?mode=foods&page=1&q=` → food rows（sample_name, category, nutrient summary count）
  - `GET .../preview?mode=ingredients&page=1&q=` → ingredient rows（name_zh, name_en, category）

---

### Phase F — 資料預覽 UI

- [ ] **F1** 在 `src/admin_html_preview.py` 建立各 module 的 preview section HTML builder

- [ ] **F2** ICD-10 accordion tree
  - 初始載入：expand 第一層 chapters
  - 每個 chapter row 有 ▶ toggle → JS `loadICDChildren(node)` → GET `.../preview?node={node}`
  - Search bar → debounce 300ms → GET `.../preview?q={q}` → 切換成 flat search results 模式

- [ ] **F3** LOINC table
  - 分頁 pagination bar（< 1 2 3 … >）
  - CLASS filter dropdown（動態從資料取得）
  - STATUS filter（ACTIVE / ALL）
  - Search input（debounce）

- [ ] **F4** SNOMED tree
  - 與 ICD-10 accordion 類似架構，但 node 是 concept_id
  - 顯示 FSN term + concept_id + child_count
  - Search mode（輸入關鍵字切換）

- [ ] **F5** TWCore IG master-detail
  - 左欄：codesystem list（點選 highlight）
  - 右欄：concept table（code, display, definition）
  - 點選 codesystem → GET `.../preview?cs_id={id}` → refresh right panel

- [ ] **F6** Clinical Guidelines hierarchy
  - disease list with accordion
  - 展開顯示 guideline summary + recommendation tabs（diagnostic / medication / test / goals）

- [ ] **F7** Drug license list
  - Phase stats card（Phase 1/2/3 統計，保留目前設計邏輯）
  - License table with quality badge（color-coded：index_only=gray, ei_partial=yellow, ei_complete=green, pdf_ocr=blue）
  - Search + quality filter

- [ ] **F8** Health Supplements list
  - Simple paginated table + search

- [ ] **F9** Food Nutrition
  - Tab 切換：Foods / Ingredients
  - Each tab: paginated table + search

---

### Phase G — Health Supplements / Food Nutrition 排程 UI

- [ ] **G1** 這兩個 module 的 APScheduler 目前排程硬碼在 code 中
  - 在 `admin.module_schedules` 建立對應 row（fetch_url = FDA API URL，locked）
  - Worker 改為讀 DB 取排程時間，不再硬碼
  - `fetch_url` 對這兩個 module 是 read-only（UI 不允許修改）

- [ ] **G2** Schedule UI
  - 顯示：頻率、執行時間、下次執行時間
  - 允許修改：執行時間（hour_utc + minute_utc）
  - 不允許修改：fetch_url（FDA API 固定）

---

### Phase H — WebSocket 即時更新延伸

- [ ] **H1** 現有 WebSocket event `job_updated` 已廣播
  - 確認 modules sub-page 的 task 區塊也訂閱並即時刷新
  - 確認 embed 區塊在 embed job 完成後自動刷新 progress bar

---

### Phase I — 測試

- [ ] **I1** 補充 `tests/test_admin_console.py`
  - 版本歷史 API 回傳格式測試
  - 排程 CRUD API 測試
  - compute_next_run() 正確性測試（含 daylight saving edge case）

- [ ] **I2** 補充 `tests/test_admin_jobs.py`
  - Schedule scan 觸發 import job 的測試（mock `list_due_schedules`）

---

## 開發順序建議

```
Phase A (拆檔) → B (版本管理) → C (排程) → D (Embedding 整合)
→ E (Preview API) → F (Preview UI) → G (FDA API 排程遷移) → H (WS) → I (測試)
```

Phase A 是所有後續工作的基礎，必須先完成。
Phase B+C 可以並行（DB migration 獨立，UI 各自）。
Phase E+F 可以 module by module 逐一實作，不必一次全做。

---

## 受影響的現有測試

執行前先跑：
```bash
python -m pytest tests/ -v
```

預期 Phase A 後可能 break 的測試：
- `tests/test_admin_console.py` — import path 變更
- `tests/test_admin_services.py` — 同上

Phase B DB migration 需要額外確認：現有 `admin.module_sources` 的資料在 `version_num = NULL` 時不影響現有功能。
