# ICD-10 資料來源

## ICD-10-CM / PCS
- **CM (Clinical Modification)**：用於診斷編碼。
    - 來源：美國 CMS (Centers for Medicare & Medicaid Services) 年度釋出（<https://www.cms.gov/medicare/coding-billing/icd-10-codes>）。
    - 建議檔案：「Code Descriptions in Tabular Order」zip（內含 `icd10cm_order_YYYY.txt`），即完整碼集——header 碼加上含第 7 碼 / placeholder `X` 的 billable 碼（2026-04-01 版共 98,186 碼）。只有載入這種檔案時，`icd.editions.complete` 才為真，FHIR validator 才會把未知的 ICD-10-CM 碼當 error。
    - 亦可接受：「Code Tables, Tabular and Index」zip（`icd10cm_tabular_YYYY.xml`），第 7 碼會自動展開，但未知碼只給 warning。
- **PCS (Procedure Coding System)**：用於處置與手術編碼。
    - 來源：同上（ICD-10-PCS zip 內的 flat codes TXT）。

## WHO ICD-10（選用）
- **用途**：讓 FHIR validator 檢查 `http://hl7.org/fhir/sid/icd-10` 的代碼與 display，不影響 ICD 查詢工具。
- **檔案**：WHO ICD-10 的 FHIR CodeSystem 或展開後的 ValueSet JSON，例如以 `node-server/scripts/validator-audit/harness/fetch_tx_terms.py` 從 tx.fhir.org 取得的 `2019-covid-expanded`（13,831 碼）。寫入 `icd.icd10_who`。

## 台灣中文名稱
- **來源**：衛生福利部「中文版 ICD-10-CM/PCS」中英對照 XLSX（來源角色 `icd_zh_tw`，選用）。
- 中文名稱只補進 `name_zh`；代碼集合仍以 CMS 版本為準。

## 檔案格式與匯入
於管理後台 **醫療術語 → ICD-10** 的「資料生命週期」分頁上傳，匯入階段 `icd_import` 一次處理所有角色：

| 來源角色 | 檔案 | 必要 |
|----------|------|------|
| `icd10cm` | CMS ICD-10-CM zip（order file 或 tabular XML） | 是 |
| `icd10pcs` | CMS ICD-10-PCS zip | 否（未載入時處置功能降級） |
| `icd_zh_tw` | 衛福部中英對照 XLSX（工作表 `ICD-10-CM`、`ICD-10-PCS`，A 欄代碼、D 欄中文名稱） | 否 |
| `icd10_who` | WHO ICD-10 FHIR JSON | 否 |

匯入先寫入 staging 表，再於單一 promote transaction 內替換 `icd.*` 並寫入 `icd.editions`。
