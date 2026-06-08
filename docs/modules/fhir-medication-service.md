# FHIR Medication 服務模組 (FHIR Medication Service)

## 模組概述
FHIR Medication 服務模組將藥品服務模組的台灣 FDA 藥品資料，轉換為 FHIR R4 的 `Medication` 與 `MedicationKnowledge` 資源，並提供基本驗證。此模組讓藥品資料能以 FHIR 標準格式在系統間交換。

## 主要功能

### 1. 產生 FHIR Medication / MedicationKnowledge（`query_fhir_medication`）
- 以藥品關鍵字（`keyword`）或許可證字號（`license_id`）查詢。
- 以 `resource_type` 指定輸出 `Medication` 或 `MedicationKnowledge`。
- 編碼採用 TFDA 許可證字號 CodeSystem（`https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id`），並帶入成分資訊。

### 2. 驗證 FHIR Medication（`validate_fhir_medication`）
對傳入的 Medication JSON 進行基本結構驗證（必填欄位、編碼系統），回傳 `{"valid", "resource_type", "errors"}`。

## 技術架構
- **資料來源**：讀取藥品服務模組（`drug_service`）的正規化藥品資料。
- **可用性**：本模組的可用性衍生自藥物域（`drug`）—藥品資料未載入時工具自動降級。
- **驗證範圍**：僅基本結構與必填欄位驗證；完整 IG 一致性請改用 FHIR IG 模組的驗證工具或官方 HL7 FHIR Validator。

## 依賴關係
- **Drug Service**：提供來源藥品資料。
- 與 **FHIR IG 模組** 互補：IG 模組提供剖面 / 術語層級的進階驗證與授權能力。
