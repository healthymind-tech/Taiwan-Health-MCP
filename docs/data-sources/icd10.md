# ICD-10 資料來源

## ICD-10-CM/PCS
- **CM (Clinical Modification)**：用於診斷編碼。
    - 來源：美國 CMS (Centers for Medicare & Medicaid Services) 發布之最新版本。
- **PCS (Procedure Coding System)**：用於處置與手術編碼。
    - 來源：同上。

## 台灣健保修訂
- **來源**：衛生福利部中央健康保險署。
- **差異處理**：
    - 部分代碼在台灣健保申報系統中有特定規範或不給付項目，本系統在備註欄位中會盡量標註（目前主要仍以國際標準為主）。
    - 中文譯名採用健保署公告之「國際疾病分類第十版中文版」。

## 檔案格式
系統讀取位於 `data/` 目錄下的 Excel 檔案 (`icd10cm_pcs_xxxx.xlsx`) 進行初始化。該檔案需包含兩個 Sheet：`diagnosis` 與 `procedure`。
