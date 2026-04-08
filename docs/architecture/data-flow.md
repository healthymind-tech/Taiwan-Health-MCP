# 資料流程 (Data Flow)

本文件描述系統中關鍵操作的資料流向。

## 查詢請求流程 (Query Request)

當使用者詢問「查詢糖尿病代碼」時：

1. **Client** 發送 JSON-RPC 請求：
   ```json
   {
     "jsonrpc": "2.0",
     "method": "tools/call",
     "params": {
       "name": "search_medical_codes",
       "arguments": { "keyword": "糖尿病" }
     }
   }
   ```
2. **Server (`server.py`)** 接收後，`@audited` 裝飾器記錄 SHA-256(params) 至 `audit.query_log`，`@cached` 裝飾器先查詢 Redis 快取。
3. 若快取命中，直接回傳快取結果。
4. 若快取未命中，**Service (`icd_service.py`)** 透過 asyncpg 透過 pgBouncer 建構 FTS 查詢：
   ```sql
   SELECT code, description FROM icd.diagnoses
   WHERE to_tsvector('simple', description) @@ plainto_tsquery('simple', '糖尿病')
   ```
5. **PostgreSQL 16** 執行查詢並回傳 Rows。
6. **Service** 將 Rows 轉換為格式化字串，結果存入 Redis 快取（TTL 86400s）。
7. **Server** 封裝回應回傳 Client，Prometheus 計數器更新。

## 資料初始化流程 (Data Loader)

術語資料由獨立的 data-loader 容器載入，不在伺服器啟動時進行：

1. 執行 `docker compose --profile loader run --rm data-loader --icd`（或其他旗標）。
2. **loader/main.py** 直接連接 PostgreSQL（繞過 pgBouncer），讀取 `config/datasets.yaml` 取得原始檔案路徑。
3. 各 loader（`icd_loader.py`、`loinc_loader.py` 等）解析原始 zip 檔，批次寫入對應 schema。
4. 載入完成後重啟 MCP server，服務初始化時連接已有資料的 PostgreSQL。

## FDA 動態同步流程 (Auto Sync)

藥品/健康食品/營養資料由各服務的排程器自動同步：

1. 伺服器啟動後，Drug/HealthFood/FoodNutrition service 排程器啟動。
2. 排程到時（或資料過期 > 7 天）觸發同步：
   - **Phase 1**：透過 `httpx.AsyncClient` 抓取所有 FDA API 端點資料（在 DB 連線外）。
   - **Phase 2**：對來源資料去重（`seen_ids`），以單一 `TRUNCATE + INSERT` transaction 原子寫入。
3. 更新 `sync_meta` 紀錄同步時間。
