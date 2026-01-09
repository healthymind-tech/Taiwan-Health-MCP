# FHIR 病況服務模組 (FHIR Condition Service)

## 模組概述
本模組專責將本地端的 ICD-10 診斷資料轉換為符合 HL7 FHIR (Fast Healthcare Interoperability Resources) R4 標準的 `Condition` 資源。這是實現醫療資訊互通性的關鍵組件，確保台灣的診斷紀錄能與國際醫療資訊系統接軌。

## 核心功能

### 1. ICD-10 轉 FHIR Condition
自動將結構化的 ICD-10 資料封裝為 FHIR JSON 物件：
- **編碼轉換**：將 ICD-10-CM 代碼正確映射至 `Condition.code.coding` 欄位。
- **系統識別**：自動填入標準 System URI (`http://hl7.org/fhir/sid/icd-10-cm`)。
- **文字描述**：自動帶入標準的 ICD-10 疾病名稱。

### 2. 屬性配置
支援設定完整的 Condition 資源屬性：
- **Clinical Status**：設定臨床狀態（如 `active`, `resolved`, `remission`）。
- **Verification Status**：設定確診狀態（如 `confirmed`, `provisional`）。
- **Category**：區分就診診斷（Encounter Diagnosis）或問題清單（Problem List）。
- **Severity**：標註嚴重程度（如輕度、中度、重度）。
- **病患連結**：關聯至特定的 Patient 資源 (`Subject`)。

### 3. 時間與備註
- **Onset Date**：記錄發病日期。
- **Recorded Date**：記錄資料輸入時間。
- **Notes**：支援添加非結構化的臨床備註。

## 技術細節

### 資源結構範例 (JSON)
```json
{
  "resourceType": "Condition",
  "clinicalStatus": {
    "coding": [
      {
        "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
        "code": "active"
      }
    ]
  },
  "code": {
    "coding": [
      {
        "system": "http://hl7.org/fhir/sid/icd-10-cm",
        "code": "E11.9",
        "display": "Type 2 diabetes mellitus without complications"
      }
    ]
  },
  "subject": {
    "reference": "Patient/example"
  }
}
```

## 應用場景
1. **電子病歷交換 (EMRes)**：醫院間交換病患診斷紀錄。
2. **健康存摺整合**：將臨床資料格式化以上傳至個人健康管理平台。
3. **保險理賠自動化**：保險公司接收標準化的診斷資料進行審核。
