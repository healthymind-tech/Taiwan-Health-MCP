# 效能優化

## 啟動速度

本系統在伺服器啟動時直接連接 PostgreSQL，資料已預先載入，無需每次 ETL。

- **首次部署**：需先於管理後台（Admin → Modules）匯入術語資料（ICD 約 1 分鐘，SNOMED CT 約 5-15 分鐘）。
- **後續啟動**：服務直接連接 PostgreSQL，啟動時間秒級完成。
- **初始化模型**：Node 伺服器在行程啟動時（`node-server/src/server.ts` 的 `main()`）建立一次連線池、Redis 與各服務；MCP session 各自持有 transport，但共用這些行程層級的單例。（舊 Python `mcp` SDK 的 lifespan-per-session 問題已不存在。）

**建議**：確保 PostgreSQL 資料 Volume 持久化（`compose.yaml` 預設已設定），以保留已載入的術語資料。

## 查詢效能

- **pgBouncer 連線池**：transaction mode，500 client 連線對應 30 PG 連線，支援高並發。
- **Redis 快取**：`cached()` 包裝常用查詢做 TTL-based 快取（`node-server/src/cache.ts`），快取失效時 fail-open（直接查 DB，不影響可用性）。
- **FTS 索引**：各主要搜尋欄位均建有 PostgreSQL Full-Text Search index。
- **`pg` 驅動**：使用 unnamed prepared statements，以相容 pgBouncer transaction mode。

## 併發處理

MCP 伺服器以 Node.js（Express + `@modelcontextprotocol/sdk`）實作。若需處理大量請求：

1. 調整 pgBouncer `MAX_CLIENT_CONN`（預設 500）與 `DEFAULT_POOL_SIZE`（預設 30）。
2. Redis 快取命中率可透過 Prometheus 監控（`mcp_cache_operations_total`）。
3. 多個容器實例可共用同一 PostgreSQL 與 Redis。

## 背景工作

- `ADMIN_MAX_CONCURRENT_JOBS` 限制 `admin-worker` 同時執行的工作數（compose 預設 4）；各模組另有資源槽位，避免同一模組並行匯入。
- `admin-worker` 的 `NODE_OPTIONS=--max-old-space-size=8192` 是必要的：IG 匯入會把相依套件（如 `hl7.fhir.r4.examples`）整包載入記憶體。**不要調低**。

## 監控

Prometheus 指標端點在 `METRICS_PORT`（預設 9090，僅綁定 `127.0.0.1`）。
