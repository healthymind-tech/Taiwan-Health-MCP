# Taiwan Health MCP Server

台灣醫療健康資料整合 MCP 伺服器，以官方 TypeScript MCP SDK（`@modelcontextprotocol/sdk`）建構的 Node.js 服務，提供 **63 個工具**（12 個工具群組），涵蓋國際術語、台灣在地資料、臨床計算器，以及 FHIR R4 IG 授權 / 驗證。

## 目前能力

- **ICD-10**（ICD-10-CM 2026-04-01 CMS 完整版含第 7 碼、ICD-10-PCS；FHIR 驗證另可選用 WHO ICD-10）：診斷與手術碼搜尋、鄰近碼、分類瀏覽、併發症推論、診斷 / 手術衝突檢查。
- **LOINC**：檢驗項目搜尋、參考區間查詢、單筆與批次檢驗判讀。
- **SNOMED CT**：概念搜尋、概念詳情、關聯（階層 / 屬性）查詢、SNOMED ↔ ICD-10 對應。
- **藥品（台灣 FDA / TFDA）**：藥品搜尋（藥名 / 成分 / 許可證號 / ATC）、外觀辨識、藥品詳情、文件資產下載連結。
- **健康補充品（台灣 FDA）**：關鍵字 / 許可字號 / 病症對應搜尋。
- **食品營養（台灣 FDA）**：營養素查詢、成分查詢、依營養素找食物、餐點營養分析。
- **FHIR R4**：Condition / Medication 產生與驗證。
- **FHIR IG（多 IG）**：剖面 / ValueSet 查詢與展開、術語查詢與驗證、參照解析、Bundle 組裝、骨架填值資源產生與驗證，以及依病歷原文檢查 Bundle 的忠實度（grounding）與缺漏（completeness）。
- **FHIR 伺服器**：外部 FHIR 伺服器登錄、狀態查詢與 CRUD 操作。
- **臨床計算器**：台灣臨床常用驗證計分（CHA₂DS₂-VASc、Wells、DAS28、BMI、eGFR、HAS-BLED、CURB-65、qSOFA、GCS 等），純函數、永久註冊。

## 架構摘要

- **執行環境**：後端全部為 Node.js / TypeScript（`node-server/`）；管理後台前端為 `web-v2/`（Vite + React + Mantine 的靜態 SPA，由 `web-v2` 容器的 nginx 提供）。舊的 Next.js `web/` 只保留在 compose profile `legacy-web` 供回滾。
- **對外入口**：nginx 單一前門（預設 `:8080`），將 `/mcp`、`/openapi.json`、`/tools/*`、`/admin/api/*`、`/admin/ws`、`/fhir-client/*`、`/fhir-oauth/*` 導向 `app`，其餘（`/admin` 頁面）導向 `web-v2`。
- **基礎設施**：PostgreSQL 16（pgvector）、pgBouncer、Redis、MinIO、Prometheus，以及可選的嵌入服務（預設 Ollama）。
- **動態工具註冊**：63 個工具中，模組相依的工具依各模組資料載入狀態（資料表筆數門檻）自動啟用 / 停用；FHIR 伺服器、臨床計算器與 `health_check` 永遠註冊。實際註冊的工具以 `GET /openapi.json` 或管理後台「MCP 工具」頁為準。
- **語意 / 混合搜尋**：以嵌入向量強化搜尋，無嵌入時退回關鍵字。
- **管理後台與背景 worker**：Admin Console（預設啟用，是唯一的資料匯入途徑）與 `admin-worker` 處理資料匯入、排程、模型端點（provider 帳號 + profile）與 MCP 工具目錄 / 線上測試。

## 快速入口

- [快速開始](getting-started.md)
- [模組](modules/icd-service.md)
- [MCP 工具](tools/icd-tools.md)
- [資料來源](data-sources/index.md)
- [部署](deployment/index.md)
- [管理後台](admin/index.md)
- [開發指南](development/index.md)
