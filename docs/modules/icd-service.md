# ICD 服務模組 (ICD Service)

## 模組概述
ICD 服務模組是本系統的核心組件之一，專門負責處理國際疾病分類第十版（ICD-10）的相關數據。此模組整合了臨床修訂版（ICD-10-CM）與處置編碼（ICD-10-PCS），提供精確的醫療編碼查詢、階層推論與相容性檢查功能。

## 主要功能

### 1. 醫療編碼查詢
支援多種查詢方式，讓使用者能快速找到所需的 ICD-10 編碼：
- **關鍵字搜尋**：支援透過中英文關鍵字搜尋（例如：「糖尿病」、「Diabetes」、「E11」）。
- **類型過濾**：可指定搜尋「診斷碼」（Diagnosis）或「處置碼」（Procedure）。
- **模糊比對**：能處理部分匹配的查詢請求。

### 2. 併發症推論 (Complication Inference)
利用 ICD-10 的階層結構，自動推論主要診斷可能伴隨的併發症或更細緻的子分類。
- **階層分析**：從母代碼（例如 E11）推展至子代碼（例如 E11.2 伴有腎臟併發症）。
- **臨床輔助**：協助醫療人員不錯漏潛在的相關病情記錄。

### 3. 上下文關聯分析 (Nearby Codes)
提供目標代碼在編碼列表中的前後文資訊，有助於：
- **鑑別診斷**：比較相近的病況描述。
- **嚴重度評估**：查看同一類別中不同嚴重程度的編碼。

### 4. 類別瀏覽 (Category Browse)
依 ICD 類別瀏覽所有診斷碼：
- **類別清單**：依前三碼分類（如 E11.x、I10.x）
- **診斷碼列舉**：回傳指定類別下所有診斷碼與名稱

### 5. 診斷與處置衝突檢測 (Conflict Detection)
這是本模組的高級功能，用於驗證「診斷」與「處置」之間的邏輯相容性。
- **適應症檢查**：確認該處置是否適用於該診斷。
- **禁忌症警示**：標示出醫療上不合理的組合（例如：男性診斷代碼配對子宮手術）。
- **結構化分析**：同時回傳雙方的詳細資訊以供比對。

## 技術架構
- **資料來源**：ICD-10-CM 與 ICD-10-PCS（CMS），經由管理後台（Admin → Modules，匯入階段 `icd_import`）載入。ICD-10-CM 建議上傳 CMS「Code Descriptions in Tabular Order」zip（例如 `april-1-2026-code-descriptions-tabular-order.zip`）：內含完整碼集（header 碼 + 含第 7 碼的 billable 碼，2026-04-01 版共 98,186 碼），匯入後 FHIR validator 對未知的 ICD-10-CM 碼會報 error（與 tx.fhir.org 相同）。只上傳「Code Tables, Tabular and Index」zip（tabular XML）也可匯入，第 7 碼會自動展開，但未知碼只給 warning。 另可上傳選用來源「WHO ICD-10 (FHIR JSON)」（WHO ICD-10 的 FHIR CodeSystem 或展開後的 ValueSet，例如以 `node-server/scripts/validator-audit/harness/fetch_tx_terms.py` 取得的 tx.fhir.org 版本 `2019-covid-expanded`，13,831 碼），由同一個 `icd_import` 匯入 `icd.icd10_who`，FHIR validator 即可檢查 `http://hl7.org/fhir/sid/icd-10` 的代碼與 display。
- **資料庫**：PostgreSQL 16，`icd.diagnoses`（診斷碼）與 `icd.procedures`（手術碼）兩張資料表。
- **PCS 降級**：`_pcs_available` flag — ICD-10-PCS 未載入時工具自動降級，回傳提示訊息而非錯誤。PCS 2025（78,948 筆）位於 `fhir-code/icd/10/icd10pcs/`，`icd_import` 自動同時載入。
- **全文搜尋**：各表建有 FTS index，支援中英文關鍵字搜尋。

## 依賴關係
本模組為獨立基礎模組，但被以下進階服務所依賴：
- **FHIR Condition Service**：轉換 ICD 代碼為 FHIR 標準格式。
- **Health Supplements Service**：依據診斷建議相關保健資訊。
