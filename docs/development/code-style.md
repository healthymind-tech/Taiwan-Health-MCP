# 程式風格

本專案的程式碼與註解一律使用**英文**；面向使用者的文件使用正體中文。

## TypeScript（`node-server/`、`web/`）

- **格式**：TypeScript 5.7，ESM（`"type": "module"`），相對 import 需帶 `.js` 副檔名（對應編譯輸出）。
- **命名**：檔案 camelCase（`drugService.ts`、`adminJobs.ts`）；型別與類別 PascalCase；函式與變數 camelCase。
- **型別**：公開函式要標注參數與回傳型別。避免 `any`；不得已時加註原因。
- **驗證**：MCP 工具的輸入 schema 以 `zod` 定義。
- **日誌**：一律走 `logger.ts`（`logInfo` / `logWarning` / `logError`），輸出結構化 JSON 到 **stderr**。
  **絕不要寫入 stdout** —— 那是 MCP stdio transport 的通道。
- **資料庫**：loader 接收 `pg.Pool`，沿用該檔案既有的 `batchInsert` 模式。

## 註解

註解解釋**為什麼**，或說明程式碼本身無法表達的限制；不要複述下一行在做什麼。

Python → Node 遷移期間，為了與舊行為逐值一致而刻意保留的怪癖，都帶有註解說明它復刻的是
哪個行為、以及改掉會壞掉什麼（例如 `drugRecordBuilder.ts` 的 `pick()` / `dictGet()`，其輸出
會被持久化成 `normalized_records.normalized_json`）。**不要「順手清理」這些。**

## 匯入規則（重要）

大量匯入遵循「先全部抓取、再原子寫入」：

1. 先完成整個網路階段（把資料全部取回）。
2. 再在一個 transaction 內寫入（`TRUNCATE` / `UPSERT`）。
3. 寫入前先對來源資料去重（TFDA Open Data 偶有重複主鍵）。

**絕不要**在 transaction 內交錯進行 HTTP 抓取與資料庫寫入。

## Commit

沿用 Conventional Commits：`feat:`、`fix:`、`refactor:`、`docs:`、`chore:`。
主旨簡短具體；PR 描述變更內容、關聯 issue、資料或 schema 影響，以及測試證據。
