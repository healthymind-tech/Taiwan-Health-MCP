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
search_loinc_code(keyword="空腹血糖")
# 系統回傳: 1558-6 (Glucose [Mass/volume] in Serum or Plasma --Fasting)

search_loinc_code(keyword="三酸甘油酯")
# 系統回傳: 2571-8 (Triglyceride [Mass/volume] in Serum or Plasma)
```

### 步驟二：單項判讀

針對這幾項數值進行分析。

**呼叫工具**：
```python
interpret_lab_result(loinc_code="1558-6", value=110, age=55, gender="M")
```

**結果**：
系統會指出 110 mg/dL 略高於正常值 (通常 < 100)，屬於「空腹血糖受損 (Impaired Fasting Glucose)」，即糖尿病前期。建議飲食控制並追蹤。

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
系統會回傳一份摘要，指出患者有「代謝症候群」的風險（血糖高、血脂高），建議諮詢心臟科或新陳代謝科。
