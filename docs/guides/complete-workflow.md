# 完整診療流程模擬

本指南示範一個典型的門診場景：一位患有第二型糖尿病的患者就診，醫師進行評估、開立處方並完成病歷記錄。我們將展示如何使用 MCP 工具來輔助此流程。

## 場景描述
- **患者**：王小明 (Patient-001)
- **主訴**：口渴、多尿，近期血糖控制不佳。
- **初步診斷**：第二型糖尿病。

## 步驟一：確認診斷編碼 (ICD-10)

首先，我們需要找到正確的 ICD-10 代碼。

**呼叫工具**：
```python
search_medical_codes(keyword="第二型糖尿病")
```

**預期結果**：
系統回傳多個相關代碼，我們選擇最符合的 **E11.9** (Type 2 diabetes mellitus without complications)。

## 步驟二：查詢臨床指引

在開立處方前，確認目前的治療指引建議。

**呼叫工具**：
```python
get_medication_recommendations(icd_code="E11")
```

**預期結果**：
指引建議第一線用藥為 Metformin (二甲雙胍)。

## 步驟三：查詢藥品資訊

搜尋台灣核准的 Metformin 藥品。

**呼叫工具**：
```python
search_drug_info(keyword="Metformin")
```

**預期結果**：
找到多項藥品，例如「庫魯化錠 (Glucophage)」。
進一步查詢詳細資訊以確認禁忌症：

```python
get_drug_details(license_id="衛署藥輸字第021938號")
```

## 步驟四：開立處方與衝突檢查

假設醫師決定開立 Metformin，並想確認與患者原本服用的藥物是否有交互作用（可使用 analyze_treatment_plan）。這裡我們檢查診斷與處方是否一致。

**呼叫工具**：
```python
analyze_treatment_plan(diagnosis_keyword="E11", drug_keyword="Glucophage")
```

**預期結果**：
系統確認適應症符合。

## 步驟五：生成 FHIR 病歷紀錄

最後，將此次診斷記錄轉換為標準的 FHIR 格式以儲存至資料庫。

**呼叫工具**：
```python
create_fhir_condition(
    icd_code="E11.9",
    patient_id="Patient-001",
    clinical_status="active",
    verification_status="confirmed",
    onset_date="2024-01-09"
)
```

**產出**：
一個符合 FHIR R4 標準的 JSON 物件，隨時可以交換至其他 HIS 系統。

---
透過以上步驟，我們完成了一個標準化且具備決策支援的診療流程。
