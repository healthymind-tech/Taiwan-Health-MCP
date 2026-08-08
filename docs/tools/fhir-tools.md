# FHIR Condition / Medication 工具 (FHIR Tools)

此類別工具將本地端的 ICD-10 診斷與台灣 FDA 藥品資料，轉換為 FHIR R4 `Condition` / `Medication` / `MedicationKnowledge` 資源，並提供基本驗證。進階的剖面 / 術語層級授權與驗證，請見 [FHIR IG 工具](fhir-ig-tools.md)。

## query_fhir_condition
由 ICD-10 診斷產生 FHIR R4 `Condition` 資源。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `icd_code` | string | 否 | 直接指定 ICD-10-CM 碼（與 `diagnosis_keyword` 擇一，優先於關鍵字） | `"E11.9"` |
| `diagnosis_keyword` | string | 否 | 診斷關鍵字（中英文），用於反查 ICD 碼 | `"第二型糖尿病"` |
| `patient_id` | string | 否 | 連結的 Patient 參照，預設空字串 | `"patient-001"` |
| `clinical_status` | string | 否 | `active`（預設）/ `inactive` / `resolved` / `remission` | `"resolved"` |
| `verification_status` | string | 否 | `confirmed`（預設）/ `provisional` / `differential` / `refuted` | `"provisional"` |
| `category` | string | 否 | `encounter-diagnosis`（預設）/ `problem-list-item` | `"problem-list-item"` |
| `severity` | string | 否 | 嚴重程度 | `"moderate"` |
| `onset_date` | string | 否 | 發病日期 | `"2026-01-15"` |
| `recorded_date` | string | 否 | 記錄日期 | `"2026-02-01"` |
| `additional_notes` | string | 否 | 補充註記，寫入 `Condition.note` | `"追蹤中"` |

> `icd_code` 與 `diagnosis_keyword` 至少要給一個；兩者皆省略時無法決定要編碼哪個診斷。

### 用途
自動將 ICD-10-CM 碼映射至 `Condition.code.coding`，填入標準 system URI（`http://hl7.org/fhir/sid/icd-10-cm`）與疾病名稱，並依上述參數填入 clinicalStatus、verificationStatus、category、subject 等屬性。

---

## validate_fhir_condition
驗證 FHIR `Condition` 資源的基本結構。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `condition_json` | string | 是 | 待驗證的 Condition JSON 字串 |

### 回傳格式
```json
{ "valid": true, "errors": [], "warnings": [] }
```

> 與 `validate_fhir_medication` 不同，這個工具的回傳**沒有** `resource_type`，但多一個 `warnings`
> 陣列（例如缺少建議欄位時）。`valid` 只看 `errors` 是否為空，warnings 不影響判定。

---

## query_fhir_medication
由台灣 FDA 藥品產生 FHIR R4 `Medication` 或 `MedicationKnowledge` 資源。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 否 | 藥品關鍵字（與 `license_id` 擇一） | `"普拿疼"` |
| `license_id` | string | 否 | 許可證字號 | `"衛署藥製字第000480號"` |
| `resource_type` | string | 否 | `Medication` 或 `MedicationKnowledge` | `"MedicationKnowledge"` |

### 用途
編碼採用 TFDA 許可證字號 CodeSystem（`https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id`），並帶入成分資訊。

---

## validate_fhir_medication
驗證 FHIR `Medication` 資源的基本結構。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `medication_json` | string | 是 | 待驗證的 Medication JSON 字串 |

### 回傳格式
```json
{ "valid": true, "resource_type": "Medication", "errors": [] }
```

> 這兩個驗證工具僅做基本結構與必填欄位檢查。需要剖面一致性（IG conformance）驗證時，請改用 `fhir_validate_resource` / `fhir_validate_bundle`。
