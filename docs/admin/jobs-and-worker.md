# 背景工作與排程

## 元件

- **`node-server/src/admin/adminWorker.ts`** 是獨立程序（compose 服務 `admin-worker`）。它輪詢 `admin.import_jobs` 認領排隊中的工作，執行對應的載入階段，並寫入 `admin.import_job_steps` / `admin.import_job_logs`。
- **`node-server/src/admin/adminJobs.ts`** 提供工作 API（建立 / 查詢 / 取消 / 暫停）與所有工作型別的執行邏輯。
- **`node-server/src/admin/adminJobStaging.ts`** 提供重量級匯入的 staging / promote 機制（先寫暫存表，再原子換上）。
- **`node-server/src/admin/adminSchedule.ts`** 管理排程（`admin.module_schedules`）；worker 每輪檢查 `next_run_at` 以觸發定期匯入。
- **`node-server/src/admin/adminWs.ts`** 透過 WebSocket（`/admin/ws`）推送即時日誌與進度給 UI。

## 工作型別

| 工作型別 | 模組 | 說明 |
|----------|------|------|
| `icd_import` / `loinc_import` / `snomed_import` / `rxnorm_import` / `ig_import` | 對應模組 | 由管理後台上傳的來源檔匯入（來源檔存於 MinIO，工作執行時取回）。 |
| `health_supplements_import` / `food_nutrition_import` | 對應模組 | 由 TFDA Open Data API 抓取。 |
| `guideline_import` | `guideline` | 內建種子資料。 |
| `drug_index_import` | `drug` | 由 `36_2.csv` 授權證索引匯入 `drug.licenses`，並排入 enrichment 佇列。 |
| `drug_enrichment` | `drug` | 爬取 TFDA 網站取得仿單 / 標籤 / 外觀資產，上傳 MinIO。 |
| `drug_analysis` | `drug` | 仿單 PDF → MinerU OCR → 分析 LLM → `drug.insert_analysis`。 |
| `*_embed` | 對應模組 | 回填 `*_embeddings` 向量表（需嵌入服務可用）。 |

三個藥品階段全部以 TypeScript 原生執行（`node-server/src/loaders/drugIndex.ts`、`drugEnrichment.ts`、`drugAnalysis.ts`）。

## 控制與併發

- **暫停 / 取消**：以 checkpoint 為基礎——worker 在安全點檢查 `admin.job_control_requests`，因此暫停不會留下半套資料。
- **心跳**：worker 定期寫入 `admin.worker_heartbeats`；超過 `ADMIN_WORKER_STALE_AFTER_SECONDS`（預設 45 秒）未更新即視為失聯。
- **併發上限**：`ADMIN_MAX_CONCURRENT_JOBS`（預設 4）限制同時執行的工作數；另有各模組的資源槽位，避免同一模組並行寫入。

## 自動串接（藥品管線）

藥品三階段會自動串接：`drug_index_import` 完成後排入 `drug_enrichment`，後者完成後排入 `drug_analysis`。

自動串接產生的工作會帶上批次上限 `DRUG_AUTOCHAIN_BATCH_LIMIT`（預設 200 筆授權證），
完成後再從自身串接下一批，讓待辦佇列逐步消化，同時保留操作者在批次之間停止的機會。

!!! warning "手動排入的工作不受批次上限保護"
    批次上限只作用於**自動串接**產生的工作。若透過 API 或 UI 手動排入
    `drug_enrichment` 而未指定 `limit`，該工作會一次處理整個待辦佇列
    （可能是數萬筆對 TFDA 網站的爬取）。需要限量時請明確帶入 `limit`。

## 監控

工作進度、步驟時間軸與即時日誌可在管理後台的 **Tasks** 頁籤查看。
