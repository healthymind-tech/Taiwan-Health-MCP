# Changelog

本專案版本記錄，格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.0.0/)，
版號依循 [Semantic Versioning](https://semver.org/lang/zh-TW/)（0.x 階段 minor 版可能含破壞性變更）。

## [0.1.0] - 2026-08-02

首個 Beta 版本。後端已完成從 Python 到 Node.js / TypeScript 的全面遷移，
提供 49 個 MCP 工具（11 個工具群組），涵蓋 ICD-10-CM/PCS、LOINC、SNOMED CT、
台灣 FDA 藥品／健康補充品／食品營養，以及 FHIR R4 IG 授權與驗證。

### 新增
- **MCP 伺服器**：以官方 TypeScript MCP SDK 建構，動態工具啟用（依模組資料載入狀態自動註冊 / 移除工具）。
- **ICD-10-CM/PCS**：診斷／手術碼搜尋、鄰近碼、分類瀏覽、併發症推論、診斷／手術衝突檢查。
- **LOINC**：檢驗項目搜尋、參考區間查詢、單筆與批次檢驗判讀。
- **SNOMED CT**：概念搜尋、概念詳情、關聯查詢、SNOMED ↔ ICD-10 對應。
- **台灣 FDA 藥品**：藥名／成分／許可證號／ATC 搜尋、外觀辨識、藥品詳情、文件資產下載；三階段管線（索引 → 爬取豐富 → OCR/LLM 分析）。
- **健康補充品／食品營養**：關鍵字與病症對應搜尋、營養素查詢、餐點營養分析。
- **FHIR R4**：Condition / Medication 資源產生與驗證。
- **FHIR IG（多 IG）授權工具集**：剖面／ValueSet 查詢與展開、術語驗證、參照解析、Bundle 組裝、骨架填值（skeleton-fill）資源產生與驗證；預設 TWCore v1.0.0，可安裝並切換多個 IG。
- **FHIR 伺服器**：外部 FHIR 伺服器登錄、狀態查詢，`crud_fhir_server` 提供受控寫入（allow-list + `confirm_write` 雙重確認）。
- **語意 / 混合搜尋**：以嵌入模型（預設 Ollama）強化搜尋，無嵌入時退回關鍵字。
- **管理後台（Admin Console）**：資料來源上傳、匯入排程與即時進度、LLM / OCR 端點設定、外部 FHIR 伺服器管理、背景工作監控。
- **生產部署**：Docker Compose 一鍵啟動（nginx / web / app / admin-worker / postgres+pgvector / pgBouncer / redis / minio / prometheus）。

### 變更
- 後端全面由 Python 遷移為 Node.js / TypeScript（`node-server/`），移除獨立 CLI data-loader，改由 Admin Console 觸發、`admin-worker` 背景執行。
- 前端改為 Next.js（`web/`），管理後台改為掛載於 `/admin` 的 React SPA。

### 移除
- 移除臨床指引（Clinical Guideline）模組（資料庫 schema／後端服務／MCP 工具／管理後台頁面／文件）。此模組初期需求與架構規劃不足，後續將以 POC 重新設計後再實作。
- 清理過時的開發歷史與規劃文件（遷移評估、重構計畫、階段性交接紀錄等），並修正文件中殘留的舊版工具數量、Python 檔名等過時引用。
