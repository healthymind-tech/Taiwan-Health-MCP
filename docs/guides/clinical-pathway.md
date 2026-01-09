# 臨床路徑規劃指南 (Clinical Pathway)

本指南展示如何結合「ICD 服務」與「臨床指引服務」來建立標準化的臨床路徑 (Clinical Pathway)。臨床路徑是一種針對特定疾病群體，以時間為軸線，規範檢查、治療與護理流程的計畫。

## 規劃流程

### 第一階段：定義納入條件 (Inclusion Criteria)
明確定義適用此路徑的病患群體。

- **工具**：`search_medical_codes`
- **操作**：確定主要的 ICD-10 診斷碼。
- **範例**：社區型肺炎 (Community-Acquired Pneumonia) -> 診斷碼範圍 `J13` ~ `J18`。

### 第二階段：制定處置基準
依據權威指引設定標準處置。

- **工具**：`get_complete_guideline`
- **操作**：獲取該疾病的標準診療流程。
- **範例應用**：
    - **Day 1 (急診/門診)**：
        - 檢驗：CXR (胸部X光), CBC/DC, CRP。 -> 使用 `search_loinc_code` 標準化檢驗單。
        - 評估：PSI 或 CURB-65 嚴重度評分。
    - **治療啟動**：
        - 使用 `get_medication_recommendations("J15")` 查詢抗生素建議。
        - 例如：第一線使用 Beta-lactam + Macrolide。

### 第三階段：設定監測指標 (Monitoring)
設定治療成效的評估點。

- **工具**：`tools/lab-tools`
- **操作**：定義檢驗值的追蹤頻率與目標。
- **範例**：住院 48-72 小時追蹤發炎指數 (CRP) 變化。

### 第四階段：出院準備 (Discharge Planning)
- **衛教**：查詢相關的照護建議（若指引中有包含）。
- **追蹤**：設定回診時間。

## 自動化輔助
在 HIS 系統中，可設計一個「路徑啟動按鈕」：
1. 醫師輸入診斷 `J15.9`。
2. 系統呼叫 `mcp.get_complete_guideline("J15.9")`。
3. 自動帶出建議的 Order Set (檢驗套餐 + 藥物套餐)。
4. 醫師確認修改後發送，大幅節省時間並確保品質。
