# ICD 服務模組 (ICD Service)

## 模組概述
ICD 服務模組是本系統的核心組件之一，專門負責處理國際疾病分類第十版（ICD-10）的相關數據。此模組整合了臨床修訂版（ICD-10-CM）與處置編碼（ICD-10-PCS），提供精確的醫療編碼查詢、階層推論與相容性檢查功能。

## 主要功能

### 1. 醫療編碼查詢
支援多種查詢方式，讓使用者能快速找到所需的 ICD-10 編碼：
- **關鍵字搜尋**：支援透過中英文關鍵字搜尋（例如：「糖尿病」、「Diabetes」、「E11」）。
- **類型過濾**：可指定搜尋「診斷碼」（Diagnosis）或「處置碼」（Procedure）。
- **混合搜尋**：診斷碼以 BM25 全文檢索 + 向量相似度（RRF 合併）排序；向量需先由 `icd_embed` 工作回填，嵌入端點不可用時退回關鍵字並標示 `search_mode: "keyword_only"`。

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
`check_medical_conflict` 用於協助判斷「診斷」與「處置」之間的邏輯相容性（例如：男性診斷代碼配對子宮手術）。
- **結構化資料**：同時回傳診斷碼與處置碼兩邊的完整資料列，並附上要求呼叫端（LLM）分析禁忌症的指示。
- **判斷由呼叫端進行**：本工具**不含**內建的適應症 / 禁忌症規則庫，衝突判斷交由呼叫端依回傳資料推論。
- **PCS 未載入時**：處置端回傳「ICD-10-PCS data not loaded」提示。

## 技術架構
- **資料來源**：ICD-10-CM 與 ICD-10-PCS（CMS），於管理後台 **醫療術語 → ICD-10** 的「資料生命週期」分頁上傳來源檔並匯入（匯入階段 `icd_import`）。來源角色（source role）：
    - `icd10cm`（必要）：建議上傳 CMS「Code Descriptions in Tabular Order」zip（內含 `icd10cm_order_YYYY.txt`，例如 `april-1-2026-code-descriptions-tabular-order.zip`）。內含完整碼集（header 碼 + 含第 7 碼 / placeholder `X` 的 billable 碼，2026-04-01 版共 98,186 碼），並保留 CMS short title 與 header 旗標。也可上傳「Code Tables, Tabular and Index」zip（tabular XML），第 7 碼會自動展開，但不視為完整版。
    - `icd10pcs`：ICD-10-PCS zip（CMS flat codes TXT）。
    - `icd_zh_tw`（選用）：衛福部中英對照 XLSX，提供中文名稱。
    - `icd10_who`（選用）：「WHO ICD-10 (FHIR JSON)」——WHO ICD-10 的 FHIR CodeSystem 或展開後的 ValueSet（例如以 `node-server/scripts/validator-audit/harness/fetch_tx_terms.py` 取得的 tx.fhir.org 版本 `2019-covid-expanded`，13,831 碼），匯入 `icd.icd10_who`，FHIR validator 即可檢查 `http://hl7.org/fhir/sid/icd-10` 的代碼與 display。
- **版本紀錄與嚴格判定**：每次匯入在同一個 promote transaction 內寫入 `icd.editions`（`edition`、`source_format` = `cms-order` / `tabular-xml`、`complete`、`code_count`）。只有本地載入的是完整的 CMS order file 版本時，FHIR validator 才會對未知的 ICD-10-CM 碼報 **error**（與 tx.fhir.org 相同）；tabular XML 或未記錄版本時只給 warning。WHO ICD-10 亦同：僅在載入 `2019-covid-expanded` 完整版時才嚴格判定。
- **資料庫**：PostgreSQL 16，`icd.diagnoses`（診斷碼，含 `short_name_en`、`is_header`）、`icd.procedures`（處置碼）、`icd.editions`、`icd.icd10_who`，以及向量表 `icd.diagnosis_embeddings`。
- **PCS 降級**：`icdService.ts` 的 `pcsAvailable` 旗標——`icd.procedures` 為空時，處置相關功能自動降級，回傳提示訊息而非錯誤。
- **向量搜尋刻意走精確掃描**：診斷碼的向量查詢以 `ORDER BY (embedding <=> $v) + 0` 讓 planner 不使用 HNSW 索引——約 5 萬筆近乎重複的第 7 碼會讓 HNSW 的 recall 崩潰（例如糖尿病查詢回傳骨折碼）；約 98k 筆精確掃描約 0.35 秒。
- **術語瀏覽**：同一模組頁的「資料預覽」分頁提供 ICD-10-CM 章節樹、WHO ICD-10 樹與 ICD-10-PCS 七軸表格瀏覽，後端為 `/admin/api/terminology/icd/*`（`cm/children`、`cm/path`、`cm/search`、`who/*`、`pcs/browse`、`pcs/table`、`pcs/codes`、`pcs/code`、`pcs/search`）。
- **本機開發**：未經管理後台上傳時，載入器退回讀取 `fhir-code/icd/10/`（可用 `ICD_CM_ZIP`、`ICD_PCS_ZIP` 等環境變數覆寫），見[測試資料檔清單](../data-sources/test-data.md)。

## 依賴關係
本模組為獨立基礎模組，但被以下進階服務所依賴：
- **FHIR Condition Service**：轉換 ICD 代碼為 FHIR 標準格式。
- **Health Supplements Service**：`condition` 模式以 ICD 搜尋解析診斷關鍵字。
- **FHIR IG 驗證器**：以 `icd.*` 判定 ICD-10-CM / WHO ICD-10 的代碼與 display。
