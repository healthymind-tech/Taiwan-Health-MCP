# 檢驗服務模組 (Lab Service)

## 模組概述
檢驗服務模組負責整合實驗室檢驗項目的參考數據與標準編碼，特別著重於台灣健保檢驗代碼與國際檢驗標準 (LOINC) 的對應。此模組旨在提升檢驗數據的互通性與解讀的一致性。

## 主要功能

### 1. 檢驗項目查詢與 LOINC 對應
- **代碼映射**：提供本地檢驗代碼與 LOINC (Logical Observation Identifiers Names and Codes) 的對照查詢。
- **標準化名稱**：提供檢驗項目的標準中英文名稱，減少同項異名的混淆。

### 2. 參考值範圍 (Reference Ranges)
提供各類檢驗項目的標準參考區間，協助判讀結果：
- **數值範圍**：提供正常值的上下限（如：血紅素 Hb 13.5-17.5 g/dL）。
- **單位換算**：支援常見單位的識別。
- **性別與年齡差異**：部分項目支援依據性別或年齡層提供不同的參考標準。

### 3. 異常判讀輔助（`interpret_lab_result`）
依病患年齡 / 性別挑選適用的參考區間，將數值標記為 `H`（偏高）、`L`（偏低）或 `N`（正常），並附上參考區間、來源備註與一句通用說明（例如「高於正常參考值，建議進一步評估」）。**不**產生病因推論；臨床意義由呼叫端或醫療人員判斷。只有在 `loinc.reference_ranges` 有該碼的參考值時才能判讀。

### 4. 依檢體類型搜尋
依血液、尿液、糞便等檢體類型篩選 LOINC 檢驗項目。

### 5. 相關檢驗查詢
找出相同 analyte（分析物）的所有相關 LOINC 檢驗，協助選擇最適合的檢驗方法。

### 6. LOINC 完整概念細節
取得單一 LOINC 碼的完整資訊，包含中文病患友善名稱、單位、檢體、方法等。

### 7. 批次結果判讀（`batch_interpret_lab_results`）
一次傳入多項檢驗值（`results_json`，每筆含 `loinc_code` 與 `value`），回傳 `total_tests`、`abnormal_count`、`normal_count` 與每項的判讀結果；查不到參考值的項目會被略過。

## 技術架構
- **資料來源**：LOINC 2.80（`Loinc_2.80.zip`，約 10.5 萬個 concept），於管理後台 **醫療術語 → LOINC** 上傳並匯入（匯入階段 `loinc_import`）。另有兩個專案自行整理的選用來源：`loinc_taiwan_mapping`（台灣常用檢驗中文名稱，`data/loinc/taiwan_mapping.csv`，約 30 筆）與 `loinc_reference_ranges`（年齡 / 性別分層參考值，`data/loinc/lab_reference_ranges.csv`，約 40 筆）。
- **FHIR validator 用的附加內容**：匯入時另保留 LOINC zip AccessoryFiles 中的 answer（LA）、part（LP）、answer list（LL）與 group（LG）代碼（`loinc.other_codes`）及版本（`loinc.editions`），供 FHIR validator 檢查這些代碼與 display；本地版本達到 tx.fhir.org 所用版本（目前 2.82）時，未知的 LOINC 碼才會報 error，否則為 warning（2.80 < 2.82，因此目前是 warning）。
- **LOINC 結構表**（migration `20261020_loinc_structure.sql`）：`loinc.part_links`（各軸 part：COMPONENT / PROPERTY / TIME / SYSTEM / SCALE / METHOD）、`loinc.answer_list_items` / `loinc.answer_list_links`（answer list）、`loinc.panel_items`（panel 成員）、`loinc.map_to`（MapTo 取代碼），與 `loinc.concepts` 在同一個 promote transaction 寫入，供管理後台的術語瀏覽使用。
- **資料庫**：PostgreSQL 16，`loinc.concepts`（LOINC 碼）、`loinc.reference_ranges`（參考值）、上述附加表，以及向量表 `loinc.concept_embeddings`（由 `loinc_embed` 回填）。
- **術語瀏覽**：模組頁的「資料預覽」分頁提供六軸 facet 篩選、單一 term 詳情（parts、answer list、panel、MapTo）與 LA/LP/LL/LG 代碼查詢，後端為 `/admin/api/terminology/loinc/*`（`facets`、`facet-values`、`term`、`code`）。
- **結構化輸出**：回傳資料可直接用於產生 FHIR Observation 資源。

## 應用場景
1. **健康檢查報告系統**：自動標示紅字異常項目並加上解釋。
2. **電子病歷整合**：將院內檢驗碼標準化為 LOINC 以利跨院交換。
3. **個人健康管理**：協助民眾理解健檢報告中的專業術語與數值意義。
