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
| `mcp_cache_operations_total{prefix,result}` | Counter | 只在 `cached()` 被使用時才會增加；目前沒有呼叫點 |
