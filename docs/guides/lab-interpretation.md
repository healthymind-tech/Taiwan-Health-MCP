# 檢驗結果判讀指南

本指南協助使用者理解如何利用檢驗模組來解讀實驗室數據。

## 基礎觀念：LOINC 代碼
在進行判讀前，最精確的方式是使用 LOINC 代碼，因為同一種檢驗（如葡萄糖）可能有不同的檢體來源（全血、血漿、尿液）或檢測方法。本系統優先支援 LOINC。

## 範例：解讀健康檢查報告

假設您收到一份健檢報告，其中有幾項紅字：
1. 空腹血糖 (Glucose, Fasting): 110 mg/dL
2. 三酸甘油酯 (Triglyceride): 180 mg/dL
3. 總膽固醇 (Cholesterol): 240 mg/dL

患者為 55 歲男性。

### 步驟一：確認 LOINC 代碼 (若報告未提供)

**呼叫工具**：
```python
search_loinc(mode="code", keyword="空腹血糖")
# 系統回傳: 1558-6 (Glucose [Mass/volume] in Serum or Plasma --Fasting)

search_loinc(mode="code", keyword="三酸甘油酯")
# 系統回傳: 2571-8 (Triglyceride [Mass/volume] in Serum or Plasma)
```

### 步驟二：單項判讀

針對這幾項數值進行分析。

**呼叫工具**：
```python
interpret_lab_result(loinc_code="1558-6", value=110, age=55, gender="M")
```

**結果**：
工具依年齡 / 性別選出適用的參考區間（`data/loinc/lab_reference_ranges.csv` 中空腹血糖為 70–100 mg/dL），回傳 `result.flag = "H"`、`status = "偏高 (High)"`、參考區間與來源，以及一句通用說明「高於正常參考值，建議進一步評估」。工具**不會**下診斷；「空腹血糖受損（糖尿病前期）」這類臨床解讀由呼叫端（LLM）或醫療人員依結果判斷。

### 步驟三：批次判讀

若要一次分析整份報告。

**呼叫工具**：
```python
batch_interpret_lab_results(
    results_json='[
        {"loinc_code": "1558-6", "value": 110},
        {"loinc_code": "2571-8", "value": 180},
        {"loinc_code": "2093-3", "value": 240}
    ]',
    age=55,
    gender="M"
)
```

**結果**：
工具回傳 `total_tests`、`abnormal_count`、`normal_count` 與每一項的判讀（三項皆為 `H`）。沒有參考值的檢驗會被略過，不計入總數。整體風險評估（例如是否有代謝症候群的疑慮）同樣交由呼叫端或醫療人員判斷。
