# 背景工作與排程 (Jobs & Worker)

資料匯入是長時間、可能耗用大量資源的工作，因此**不**在 MCP 伺服器程序內執行，而是交由獨立的 `admin-worker` 容器處理。管理後台只負責「下指令、看進度」，實際執行與檢查點控制由 worker 完成。

## 架構

- **`src/admin_worker.py`** 是獨立程序（compose 服務 `admin-worker`）。它輪詢 `admin.import_jobs`，認領排隊中的工作，執行對應的 loader 階段，並寫入步驟與日誌。
- **`src/admin_jobs.py`** 提供管理後台的工作 API（建立 / 查詢 / 取消 / 暫停）。
- **`src/admin_schedule.py`** 管理排程（`admin.module_schedules`）；worker 每輪檢查 `next_run_at` 以觸發定期匯入。
- **`src/admin_ws.py`** 透過 WebSocket 推送即時日誌與進度給 UI。

## 工作生命週期

1. 操作者在 Modules 頁籤觸發匯入（或排程到期）→ 建立 `admin.import_jobs` 一筆工作。
2. worker 認領工作，更新狀態，並逐步寫入：
   - **`admin.import_job_steps`** — 步驟時間軸（每個階段的開始 / 結束 / 狀態）。
   - **`admin.import_job_logs`** — 詳細日誌行（供即時串流與事後檢視）。
3. 過程中可由 UI 送出**檢查點控制**請求（`admin.job_control_requests`）：worker 在安全的檢查點檢查並回應 **暫停 / 取消**，避免中途破壞資料一致性。
4. 完成後寫入 `admin.module_load_log` / `admin.module_embed_log` 等結果紀錄。

## 並行與資源槽

- `ADMIN_MAX_CONCURRENT_JOBS` 限制 worker 同時執行的工作數，以控制尖峰記憶體。
- 匯入以「每模組資源槽」分配：ICD / LOINC / TWCore / SNOMED 等可平行，但同一模組不會同時重入。

## 心跳與失聯偵測

worker 定期寫入 `admin.worker_heartbeats`（間隔 `ADMIN_HEARTBEAT_INTERVAL_SECONDS`）。若超過 `ADMIN_WORKER_STALE_AFTER_SECONDS` 未更新，系統視該 worker 為失聯（stale），UI 會據此顯示警示。

## 相關環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `ADMIN_WORKER_NAME` | `admin-worker` | worker 識別名稱 |
| `ADMIN_WORKER_POLL_SECONDS` | `3` | 輪詢佇列間隔 |
| `ADMIN_HEARTBEAT_INTERVAL_SECONDS` | `15` | 心跳間隔 |
| `ADMIN_WORKER_STALE_AFTER_SECONDS` | `45` | 判定失聯的門檻 |
| `ADMIN_MAX_CONCURRENT_JOBS` | `4`–`5` | 同時執行工作上限（0 = 僅受資源槽限制） |

> 這些屬於 worker 調校參數；部分可於 Admin → Settings 線上調整。

## 排程

排程在 Modules 頁籤設定（簡單選項：daily / weekly / monthly + 時間），寫入 `admin.module_schedules`。worker 每輪檢查到期排程並自動建立匯入工作。健康補充品與食品營養等定期更新的資料集，即透過此機制排程，而非在服務程序內自帶排程器。
