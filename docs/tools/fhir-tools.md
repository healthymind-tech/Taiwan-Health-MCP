# FHIR 工具 (FHIR Tools)

此類別工具依據 HL7 FHIR R4 標準，將本地端的醫療數據轉換為具備互通性的 FHIR 資源 (JSON 格式)。

## create_fhir_condition
建立 FHIR Condition (病情/診斷) 資源。

### 參數
| 參數名 | 型別 | 必填 | Defaults | 說明 |
| :--- | :--- | :--- | :--- | :--- |
| `icd_code` | string | 是 | - | ICD-10-CM 診斷碼 |
| `patient_id` | string | 是 | - | 患者識別碼 |
| `clinical_status` | string | 否 | `"active"` | 臨床狀態 (`active`, `recurrence`, `relapse`...) |
| `verification_status` | string | 否 | `"confirmed"` | 確診狀態 (`confirmed`, `provisional`...) |
| `category` | string | 否 | `"encounter-diagnosis"` | 診斷類別 |
| `severity` | string | 否 | - | 嚴重度 (`mild`, `moderate`, `severe`) |
| `onset_date` | string | 否 | - | 發病日期 (YYYY-MM-DD) |

### 用途
當已知確切的 ICD 代碼時，使用此工具生成標準化的 FHIR JSON。

---

## create_fhir_condition_from_diagnosis
**【智慧轉換】** 從疾病名稱自動建立 FHIR Condition 資源。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `diagnosis_keyword` | string | 是 | 疾病關鍵字 | `"第二型糖尿病"`, `"Hypertension"` |
| `patient_id` | string | 是 | 患者識別碼 | `"pat-001"` |
| ... | ... | ... | (同上相關狀態參數) | |

### 用途
當使用者不清楚 ICD 代碼，僅提供疾病名稱時，此工具會先呼叫 ICD 搜尋服務找到最匹配的代碼，再生成 FHIR 資源。
