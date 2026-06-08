# Taiwan Health MCP Server

台灣醫療健康資料整合 MCP 伺服器，以官方 `mcp` SDK 建構，提供約 **51 個工具**（12 個工具群組），涵蓋國際術語、台灣在地資料，以及 FHIR R4 IG 授權 / 驗證。

## 目前能力

- **ICD-10**：診斷與手術碼搜尋、鄰近碼、分類瀏覽、併發症推論、診斷 / 手術衝突檢查。
- **LOINC**：檢驗項目搜尋、參考區間查詢、單筆與批次檢驗判讀。
- **SNOMED CT**：概念搜尋、概念詳情、關聯（階層 / 屬性）查詢、SNOMED ↔ ICD-10 對應。
- **藥品（台灣 FDA / TFDA）**：藥品搜尋（藥名 / 成分 / 許可證號 / ATC）、外觀辨識、藥品詳情、文件資產下載連結。
- **健康補充品（台灣 FDA）**：關鍵字 / 許可字號 / 病症對應搜尋。
- **食品營養（台灣 FDA）**：營養素查詢、成分查詢、依營養素找食物、餐點營養分析。
- **臨床指引**：指引搜尋與分段查詢（用藥 / 檢驗 / 治療目標等）。
- **FHIR R4**：Condition / Medication 產生與驗證。
- **FHIR IG（多 IG）**：剖面 / ValueSet 查詢與展開、術語查詢與驗證、參照解析、Bundle 組裝、骨架填值資源產生與驗證。
- **FHIR 伺服器**：外部 FHIR 伺服器登錄、狀態查詢與 CRUD 操作。

## 架構摘要

- **基礎設施**：PostgreSQL 16（pgvector）、pgBouncer、Redis、MinIO、Prometheus，以及可選的 Ollama 嵌入服務。
- **動態工具註冊**：依各模組資料載入狀態自動啟用 / 停用對應工具。
- **語意 / 混合搜尋**：以嵌入向量強化搜尋，無嵌入時退回關鍵字。
- **管理後台與背景 worker**：可選的 Admin Console 與 `admin-worker` 處理資料匯入與排程。

## 快速入口

- [快速開始](getting-started.md)
- [模組](modules/icd-service.md)
- [MCP 工具](tools/icd-tools.md)
- [資料來源](data-sources/index.md)
- [部署](deployment/index.md)
- [管理後台](admin/index.md)
- [開發指南](development/index.md)
