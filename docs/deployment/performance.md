# 效能優化

## 啟動速度

本系統在伺服器啟動時直接連接 PostgreSQL，資料已預先載入，無需每次 ETL。

- **首次部署**：需先於管理後台各模組頁（「醫療術語」等）匯入術語資料（ICD 約 1 分鐘，SNOMED CT 約 5-15 分鐘）。
- **後續啟動**：服務直接連接 PostgreSQL，啟動時間秒級完成。
- **初始化模型**：Node 伺服器在行程啟動時（`node-server/src/server.ts` 的 `main()`）建立一次連線池、Redis 與各服務；MCP session 各自持有 transport，但共用這些行程層級的單例。（舊 Python `mcp` SDK 的 lifespan-per-session 問題已不存在。）

**建議**：確保 PostgreSQL 資料 Volume 持久化（`compose.yaml` 預設已設定），以保留已載入的術語資料。

## 查詢效能

- **pgBouncer 連線池**：transaction mode，500 client 連線對應 30 PG 連線，支援高並發。
- **Redis 快取（目前未啟用）**：`node-server/src/cache.ts` 提供 `cached(ttl, prefix)`——Redis 為後端、fail-open（快取錯誤時直接執行函式）的 memoizer，但**目前沒有任何服務或工具呼叫它**，每次工具呼叫都會查 PostgreSQL。要為熱門讀取路徑加快取，以 `cached()` 包裝即可。
- **FTS 索引**：各主要搜尋欄位均建有 PostgreSQL Full-Text Search index。
- **向量搜尋**：各 `*_embeddings` 表使用 pgvector。ICD 的語意搜尋刻意**不走 HNSW 索引**、改為精確掃描（`ORDER BY (embedding <=> …) + 0`）：約 5 萬個幾乎重複的第 7 碼代碼會讓 HNSW 的召回率崩潰，精確掃描約 98k 列、約 0.35 秒。
- **`pg` 驅動**：使用 unnamed prepared statements，以相容 pgBouncer transaction mode。

## 併發處理

MCP 伺服器以 Node.js（Express + `@modelcontextprotocol/sdk`）實作。若需處理大量請求：

1. 調整 pgBouncer `MAX_CLIENT_CONN`（預設 500）與 `DEFAULT_POOL_SIZE`（預設 30）。
2. 以 Prometheus 的 `mcp_db_pool_size` / `mcp_db_pool_checked_out` 觀察連線池使用量。
3. 多個容器實例可共用同一 PostgreSQL 與 Redis。

### 重負載工具的併發上限（ops-v1 O4）

`fhir_validate_bundle`、`fhir_validate_resource`、`fhir_finalize_bundle`、`fhir_finalize_resource`、`fhir_author_resources`、`fhir_assemble_bundle`、`fhir_check_grounding`、`fhir_check_completeness` 共用一個行程內的併發閘門（`node-server/src/toolConcurrency.ts`，MCP、`POST /tools/<name>` 與管理台 playground 都經過它）：

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `MCP_HEAVY_TOOL_CONCURRENCY` | `4` | 同時執行的重負載呼叫數上限；`0` = 不限制 |
| `MCP_HEAVY_TOOL_QUEUE_TIMEOUT_MS` | `60000` | 超過上限的呼叫依序排隊，最多等這麼久 |
| `MCP_HEAVY_TOOL_MAX_QUEUE` | `32` | 排隊上限；滿了立即回覆 |

等不到位置的呼叫回傳 `isError`，`error.code = "BUSY"`、`retry_after_s`、`concurrency_limit`，不會拖垮整個服務；其他工具不排隊。用戶端（例如評測程式）同時送出的這類呼叫請不要超過 `MCP_HEAVY_TOOL_CONCURRENCY`。Prometheus 的 `mcp_heavy_tools_running` / `mcp_heavy_tools_queued` 顯示目前狀態。

### 記憶體上限（ops-v1 O3）

每個容器都有 `mem_limit`（`memswap_limit` 相同，不使用 swap），可用環境變數覆寫：Postgres `PG_MEM_LIMIT`（6g；`PG_SHARED_BUFFERS` 2560MB、`PG_MAINTENANCE_WORK_MEM` 512MB、`PG_EFFECTIVE_CACHE_SIZE` 6GB，以 `command` 的 `-c` 設定，優先於 `postgresql.auto.conf`）、`app` `APP_MEM_LIMIT`（5g，V8 heap `APP_MAX_OLD_SPACE_MB` 3584）、`admin-worker` `WORKER_MEM_LIMIT`（9g，heap `WORKER_MAX_OLD_SPACE_MB` 8192）、Redis 768m、MinIO 1g、pgBouncer / nginx / web-v2 256m、ocr-indra 2g。某個容器超過上限時只有它被 OOM 終止，`restart: unless-stopped` 讓它自動重啟，不會拖垮整台主機。Node 的 heap 上限一定要小於容器上限。

### 記憶體安全網（v22）

`app` 的記憶體指標一律是「上次 major GC 之後仍存活的 heap ÷ heap 上限」（Prometheus `mcp_heap_live_ratio`）。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `MCP_HEAVY_TOOL_HEAP_RATIO` / `MCP_TOOL_HEAP_RATIO` | `0.8` / `0.9` | 超過時重負載 / 其他工具不開始執行，回 `BUSY`（`reason: "memory"`） |
| `MCP_CACHE_SHED_RATIO` | `0.7` | 超過時所有跨請求快取各丟掉最久未用的一半（每分鐘最多一次） |
| `MCP_BUILD_ADMIT_RATIO` | `0.85` | 大型記憶體建構（大型 IG CodeSystem 的概念索引）先估算所需記憶體；放不下時先清空快取，仍放不下就拒絕，整個工具呼叫回 `BUSY`（memory） |
| `MCP_HEAP_ALERT_RATIO` / `MCP_HEAP_ALERT_MINUTES` | `0.75` / `10` | 持續超過時寫一行 error log，`mcp_heap_alert = 1` |
| `MCP_HEAP_ROTATE_RATIO` / `MCP_HEAP_ROTATE_MINUTES` / `MCP_HEAP_EMERGENCY_RATIO` | `0.85` / `5` / `0.95` | 自我輪替：清空快取、新連線與呼叫回 503 + `Retry-After`、等進行中的呼叫做完（最多 `MCP_ROTATE_DRAIN_MS` 330 秒）、結束程序（exit 75），由 restart policy 起新的行程 |
| `MCP_SESSION_IDLE_MS` / `MCP_MAX_SESSIONS` | `3600000` / `500` | 閒置的 MCP session 自動關閉；未知的 session id 回 404，用戶端重新 initialize |
| `OFFICIAL_VALIDATOR_RECYCLE_HOURS` | `24` | 每個常駐驗證器服務這麼久後先排空再重啟（`0` = 不回收） |

用戶端收到 503 時請依 `Retry-After` 重試，輪替期間最久可能持續到最長的進行中呼叫結束（約 5 分鐘）。驗證器 JVM 預設 `-Xmx2048m`（`VALIDATOR_JAVA_XMX`，3 GB 容器：JVM 在負載下會把整個 heap 撐滿，另外還需要約 0.6 GB），GC log 在容器內 `/tmp/gc.log`。`app` 與 `admin-worker` 以 `init: true`（tini）執行、不產生 core dump。

## 背景工作

- `ADMIN_MAX_CONCURRENT_JOBS` 限制 `admin-worker` 同時執行的工作數（compose 預設 4）；各模組另有資源槽位，避免同一模組並行匯入。
- `admin-worker` 的 `NODE_OPTIONS=--max-old-space-size=8192` 是必要的：IG 匯入會把相依套件（如 `hl7.fhir.r4.examples`）整包載入記憶體。**不要調低**。
- 主機記憶體有限時，避免同時跑多個大型匯入（例如 SNOMED CT 與 IG）；閒置的 worker 也可能保留數 GB heap，大型匯入前可先重啟 worker。

## 監控

Prometheus 指標端點在 `METRICS_PORT`（預設 9090，僅綁定 `127.0.0.1`）的 `/metrics`。`node-server/src/metrics.ts` 定義了：

| 指標 | 類型 | 現況 |
|------|------|------|
| `mcp_db_pool_size` / `mcp_db_pool_checked_out` | Gauge | 由 DB 統計收集器定期更新 |
| `mcp_tool_requests_total{tool,status}` / `mcp_tool_duration_seconds{tool}` | Counter / Histogram | 每次工具呼叫都會記錄（MCP、`POST /tools/<name>`、管理台 playground 共用同一個派送點，`mcp.ts` 的 `withToolMetrics`）。標籤只有工具名稱與 `status`（`success` / `error`，丟出例外或回傳 `isError` 算 `error`），不記錄任何參數；參數驗證失敗、未進入 handler 的呼叫不計入 |
| `mcp_heavy_tools_running` / `mcp_heavy_tools_queued` | Gauge | 重負載工具併發閘門的執行中 / 排隊數（ops-v1） |
| `nodejs_heap_size_used_bytes`、`process_resident_memory_bytes` 等 | Gauge | prom-client 預設的行程指標（記憶體、CPU、event loop 延遲、GC；ops-v1） |
| `mcp_cache_operations_total{prefix,result}` | Counter | 只在 `cached()` 被使用時才會增加；目前沒有呼叫點 |
