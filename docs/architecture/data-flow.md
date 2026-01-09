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
2. **Server (`server.py`)** 接收並路由至 `search_medical_codes` 函式。
3. **Service (`icd_service.py`)** 建構 SQL 查詢：
   ```sql
   SELECT code, description FROM diagnosis 
   WHERE description LIKE '%糖尿病%'
   ```
4. **Database (`icd.db`)** 執行查詢並回傳 Rows。
5. **Service** 將 Rows 轉換為格式化字串。
6. **Server** 封裝回應回傳 Client。

## 資料初始化流程 (ETL)

當容器啟動時：

1. **Server** 檢查 `/data` 目錄下的 DB 檔案是否存在。
2. 若不存在，**Service (`__init__`)** 啟動 ETL 程序：
   - 讀取原始 Excel/JSON (e.g., `icd10cm.xlsx`)。
   - 使用 Pandas 進行資料清洗 (Drop NA, Rename Columns)。
   - 建立 SQLite Table Schema。
   - 批次寫入 (Batch Insert) 資料。
   - 建立索引 (Create Index) 以優化搜尋。
3. 初始化完成，服務準備就緒。
