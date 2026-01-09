# LOINC 整合指南 (For IT/Developers)

本指南專為醫療資訊系統 (HIS) 開發者或資料工程師設計，說明如何將院內專屬的檢驗代碼對應至標準的 LOINC 編碼。

## 為什麼需要 LOINC？
醫院內部常使用自定義代碼（如 GLU-AC），但跨院交換或上傳至健康存摺時，需要通用語言。LOINC 即為此標準。

## 整合策略

### 1. 建立對應表 (Mapping Table)
利用 `search_loinc_code` 工具來尋找與院內項目最匹配的標準碼。

**關鍵屬性比對**：
在選擇 LOINC 碼時，必須確認以下六個屬性 (Axes) 是否一致：
1. **Component**: 檢測物（如 Glucose）
2. **Property**: 測量性質（如 Mass Concentration 質量濃度）
3. **Time Aspect**: 時間點（如 Pt = Point in time 或 24H）
4. **System**: 檢體類別（如 Serum/Plasma 或是 Urine）
5. **Scale**: 量測尺度（如 Quantitative 定量）
6. **Method**: 檢測方法（若不影響判讀可選無方法碼）

**工具應用**：
```python
# 搜尋 "尿液蛋白"
search_loinc_code(keyword="Urine Protein")
# 結果中區分 "定性 (Qualitative)" 與 "定量 (Quantitative)"
```

### 2. 驗證參考值
Mapping 完成後，使用 `get_reference_range` 確認該 LOINC 碼的標準參考值是否與院內實驗室的標準相近。若差異過大，可能選錯了代碼（例如選到不同單位或不同檢測方法的碼）。

### 3. 自動化轉換流程
在資料匯出模組 (Exporter) 中：
1.讀取院內 Lab 結果。
2.查表轉換為 LOINC。
3.呼叫或參考 `get_reference_range` 補齊標準參考值資訊（若院內資料缺失）。
4.打包為 FHIR Observation 資源。

## 常見問題
- **單位換算**：LOINC 通常有預設單位（如 mg/dL）。若院內使用 mmol/L，需在轉換時進行數值換算。
