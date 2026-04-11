# FHIR 工具 (FHIR Tools)

此類別工具依據 HL7 FHIR R4 標準，將本地端醫療資料轉成可互通的 FHIR JSON。

## `query_fhir_condition`
建立 FHIR Condition 資源。

### 模式說明
- `icd_code`：已知確切 ICD-10-CM 時，直接建立 Condition
- `diagnosis_keyword`：只知道疾病名稱時，先搜尋 ICD 再建立 Condition

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `icd_code` | string | 否 | ICD-10-CM 診斷碼 | `"E11.9"` |
| `diagnosis_keyword` | string | 否 | 疾病名稱或關鍵字 | `"第二型糖尿病"` |
| `patient_id` | string | 是 | 病人識別碼 | `"patient-001"` |
| `clinical_status` | string | 否 | `active` / `inactive` / `resolved` / `remission` | `"active"` |
| `verification_status` | string | 否 | `confirmed` / `provisional` / `differential` / `refuted` | `"confirmed"` |
| `category` | string | 否 | `encounter-diagnosis` 或 `problem-list-item` | `"encounter-diagnosis"` |
| `severity` | string | 否 | 嚴重度 | `"mild"` |
| `onset_date` | string | 否 | 發病日期 | `"2024-01-01"` |

### 回傳內容
回傳完整 FHIR Condition JSON。若使用 `diagnosis_keyword`，會先做 ICD 搜尋，再以最佳匹配建立資源。

---

## `validate_fhir_condition`
驗證 FHIR Condition JSON。

### 用途
檢查 resourceType、subject、code、clinicalStatus、verificationStatus 等基本欄位是否存在，適合在送出或儲存前做結構檢查。

---

## `query_fhir_medication`
建立 FHIR Medication 或 MedicationKnowledge。

### 模式說明
- `license_id`：已知藥證時直接建立
- `keyword`：只知道藥名時先搜尋再建立
- `resource_type="Medication"`：基本藥品資源
- `resource_type="MedicationKnowledge"`：延伸藥品知識資源，含 ATC、用途與使用資訊

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `license_id` | string | 否 | 台灣 FDA 藥證字號 | `"衛部藥製字第059686號"` |
| `keyword` | string | 否 | 藥名或同義詞 | `"Metformin"` |
| `resource_type` | string | 否 | `Medication` 或 `MedicationKnowledge` | `"MedicationKnowledge"` |

### 回傳內容
回傳完整 FHIR Medication / MedicationKnowledge JSON；若輸入 `keyword`，會先搜尋最相關藥品再建立資源。

---

## `validate_fhir_medication`
驗證 FHIR Medication / MedicationKnowledge JSON。

### 用途
檢查藥品資源結構是否完整，適合在傳送到下游系統前做檢查。
