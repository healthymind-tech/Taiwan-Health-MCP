# 效能優化

## 啟動速度優化
本系統在伺服器啟動時直接連接 PostgreSQL，資料已預先載入，無需每次 ETL。
- **首次部署**：需先執行 data-loader 載入術語資料（ICD 約 1 分鐘，SNOMED CT 約 5-15 分鐘）。
- **後續啟動**：服務直接連接 PostgreSQL，啟動時間秒級完成。
- **mcp SDK lifespan-per-session**：`streamable-http` 模式下每個 MCP session 觸發一次 lifespan，但 `_init_lock + _initialized` 確保只有第一個 session 執行初始化，後續 session 重用已建立的連線池與 Redis。

**建議**：確保 PostgreSQL 資料 Volume 持久化（`compose.yaml` 預設已設定），以保留已載入的術語資料。

## 查詢效能
- **pgBouncer 連線池**：transaction mode，500 client 連線對應 30 PG 連線，支援高並發。
- **Redis 快取**：`@cached` 裝飾器對常用查詢進行 TTL-based 快取，減少 DB 壓力。啟動時執行 warm-up cache 預載常用查詢。
- **FTS 索引**：各主要搜尋欄位均建有 PostgreSQL Full-Text Search index。
- **asyncpg**：非同步 PostgreSQL 驅動，`statement_cache_size=0` 支援 pgBouncer transaction mode。

## 併發處理
MCP Server 基於 `mcp` SDK（uvicorn/asyncio）框架。若需處理大量請求：
1. 調整 pgBouncer `max_client_conn`（預設 500）與 `default_pool_size`（預設 30）。
2. Redis 快取命中率可透過 Prometheus 監控（`mcp_cache_operations_total`）。
3. 多個容器實例可共用同一 PostgreSQL 與 Redis。
