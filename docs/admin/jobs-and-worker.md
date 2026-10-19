# 背景工作與排程

## 元件

- **`node-server/src/admin/adminWorker.ts`** 是獨立程序（compose 服務 `admin-worker`，以 `Dockerfile.worker` 建置的**獨立映像**）。它輪詢 `admin.import_jobs` 認領排隊中的工作，執行對應的載入階段，並寫入 `admin.import_job_steps` / `admin.import_job_logs`。
- **`node-server/src/admin/adminJobs.ts`** 提供工作 API（建立 / 查詢 / 取消 / 暫停）與所有工作型別的執行邏輯。
- **`node-server/src/admin/adminJobStaging.ts`** 提供重量級匯入的 staging / promote 機制（先寫暫存表 `admin.stage_*`，再於單一交易內原子換上；各術語的 edition 列也在同一個 promote 交易內寫入）。
- **`node-server/src/admin/adminSchedule.ts`** 管理排程（`admin.module_schedules`）；worker 每 `ADMIN_SCHEDULE_SCAN_INTERVAL_SECONDS`（預設 60 秒）檢查一次 `next_run_at` 以觸發定期匯入。
- **`node-server/src/admin/adminWs.ts`** 透過 WebSocket（`/admin/ws`）推送即時日誌與進度給 UI。

!!! warning "改了工作 / 載入程式碼要連 worker 一起重建"
    `admin-worker` 與 `app` 是兩個映像。改動 `adminJobs.ts`、`*Service.ts`、`loaders/*` 後只重建 `app`，
    worker 會繼續執行舊程式碼且不會報錯：

    ```bash
    docker compose build admin-worker && docker compose up -d --no-deps admin-worker
    ```

## 工作型別

| 工作型別 | 模組 | 說明 |
|----------|------|------|
| `icd_import` / `loinc_import` / `snomed_import` / `rxnorm_import` / `ig_import` | 對應模組 | 由管理後台上傳的來源檔匯入（來源檔存於 MinIO，工作執行時取回）。`ig_import` 另會自 FHIR package registry 下載缺少的相依套件，並記錄每個套件的 `install_origin`（`manual` / `dependency`），最後為匯入的套件建立 IG 術語搜尋索引並排入 `ig_embed`。 |
| `health_supplements_sync` / `food_nutrition_sync` | 對應模組 | 由 TFDA Open Data API 抓取。 |
| `drug_index_import` | `drug` | 由 `36_2.csv` 授權證索引匯入 `drug.licenses`，並排入 enrichment 佇列。 |
| `drug_enrichment` | `drug` | 爬取 TFDA 網站取得仿單 / 標籤 / 外觀資產，上傳 MinIO。 |
| `drug_analysis` | `drug` | 仿單 PDF → OCR（MinerU / Indra，可設備援）→ 分析 LLM → `drug.insert_analysis`。 |
| `icd_embed` / `loinc_embed` / `snomed_embed` / `health_supplements_embed` / `food_nutrition_embed` | 對應模組 | 回填 `*_embeddings` 向量表（需嵌入角色有可用的 profile）。 |
| `ig_concept_index` | `ig` | 建立 / 補建 IG 術語搜尋索引（CodeSystem 名稱、所有語言 designation、supplement、連結名稱、選用的 UMLS 同義字）與縮寫表，之後視需要排入 `ig_embed`。見 [IG 術語搜尋](../modules/ig-concept-search.md)。 |
| `ig_embed` | `ig` | 為 IG 術語名稱補齊向量（`fhir.concept_embeddings`，內容定址、增量）。 |
| `umls_import` | `ig` | 選用（需 UMLS 授權）：由來源 `ig/umls_metathesaurus` 載入 UMLS 同義字（`fhir.umls_terms`），之後排入 `ig_concept_index`。 |
| `system_backup` | — | 系統備份（見[管理後台](index.md#system-backups)）。 |

三個藥品階段全部以 TypeScript 原生執行（`node-server/src/loaders/drugIndex.ts`、`drugEnrichment.ts`、`drugAnalysis.ts`）。

## 控制與併發

- **暫停 / 取消**：以 checkpoint 為基礎——worker 在安全點檢查 `admin.job_control_requests`，因此暫停不會留下半套資料。
- **心跳**：worker 定期寫入 `admin.worker_heartbeats`；超過 `ADMIN_WORKER_STALE_AFTER_SECONDS`（預設 45 秒）未更新即視為失聯，其執行中的工作會被回收（reclaim）重新排隊；worker 啟動時也會回收自己名下遺留的 `running` 工作。
- **併發上限**：`ADMIN_MAX_CONCURRENT_JOBS`（預設 4）限制同時執行的工作數；另有各模組的資源槽位，避免同一模組並行寫入。

## 建立工作前的檢查

`POST /admin/api/jobs` 在排入工作前先檢查（`node-server/src/admin/jobPrechecks.ts`），問題會立即以中文說明回報，而不是等 worker 執行後才失敗：

- **重複的整模組工作**：`icd_import`、`loinc_import`、`snomed_import`、`rxnorm_import`、`umls_import`、`ig_concept_index`、
  兩個 TFDA 同步、所有 `*_embed` 與 `system_backup`，若已有同類型工作在排隊 / 執行 / 暫停，回 409 `JOB_ALREADY_ACTIVE`（附 `active_job_id`）。
  `ig_import` 與藥品工作不受限（可針對不同套件 / 許可證並行）。
- **藥品仿單分析的前置設定**：`drug_analysis`（`retry_stage=normalize` 除外）與 `drug_pipeline` 在 OCR 或分析 LLM 未設定時回 409
  （`OCR_NOT_CONFIGURED` / `ANALYSIS_LM_NOT_CONFIGURED`，提示到「外部服務 → OCR」或「模型端點」）。
- **沒有 Worker 在線**：工作照常排入（Worker 上線後會自動接手），但回應附 `worker_warning`，介面會提示「工作暫時不會執行」。
  另外，只要沒有任何 Worker 回報心跳，每一頁上方都會顯示「背景 Worker 已失聯」橫幅與啟動指令。

查詢失敗時這些檢查一律放行（fail-open），由 worker 回報真正的錯誤。

Worker 執行前的**服務相依檢查**（例如藥品工作需要 MinIO、OCR、分析 LLM）若在 `admin.service_probes` 看到上次探測為 `error`，
會先對那幾個服務重新探測一次，只有仍然失敗才把工作標為 `permanent_failed`——服務修好後不必先到「服務健康」手動探測。

## 分析 LLM 不可用時的自動恢復

若某個 `drug_analysis` 工作因分析角色的所有 profile 都失敗而暫停（`last_error_code = 'llm_unavailable'`），
worker 會在 `admin.import_jobs.next_retry_at` 到期後自動重新認領；退避時間每次加倍（2 分鐘 → 上限 30 分鐘），
手動恢復可略過退避。由人手動暫停、或錯誤碼不是 `llm_unavailable` 的 `paused` 工作**永遠不會**被自動恢復。

單次 LLM 呼叫逾時預設 600 秒、傳輸層重試 3 次；可在模型端點頁針對個別成員以 `timeout_ms` 參數覆寫。

## 自動串接（藥品管線）

藥品三階段會自動串接：`drug_index_import` 完成後排入 `drug_enrichment`，後者完成後排入 `drug_analysis`。

自動串接產生的工作會帶上批次上限 `DRUG_AUTOCHAIN_BATCH_LIMIT`（預設 200 筆授權證），
完成後再從自身串接下一批，讓待辦佇列逐步消化，同時保留操作者在批次之間停止的機會。

!!! warning "手動排入的工作不受批次上限保護"
    批次上限只作用於**自動串接**產生的工作。若透過 API 或 UI 手動排入
    `drug_enrichment` 而未指定 `limit`，該工作會一次處理整個待辦佇列
    （可能是數萬筆對 TFDA 網站的爬取）。需要限量時請明確帶入 `limit`。

## 監控

工作進度、步驟時間軸與即時日誌可在管理後台的 **背景工作**（`/admin/jobs`）頁查看；個別模組頁也會列出該模組的工作。
