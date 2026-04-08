# 資料來源概覽

Taiwan Health MCP Server 整合以下七類資料集。靜態術語資料透過 data-loader 匯入 PostgreSQL；FDA 動態資料由 app 自動週期同步。

---

## 資料集總覽

| 資料集 | 版本 | 授權 | 同步方式 | 規模 |
|--------|------|------|---------|------|
| ICD-10-CM | 2025 (NLM) | 公開 | data-loader `--icd` | ~95,000 診斷碼 |
| ICD-10-PCS | 2025 (CMS) | 公開 | data-loader `--icd`（自動，與 CM 同步） | 78,948 手術碼 |
| LOINC | 2.80 (Regenstrief) | LOINC License | data-loader `--loinc` | 87,000+ 檢驗碼 |
| SNOMED CT International | 20250601 RF2 | SNOMED License | data-loader `--snomed` | 370,000+ 概念 |
| RxNorm | 2024-06-03 (NLM) | UMLS License | data-loader `--rxnorm` | 數十萬藥品/關係 |
| TWCore IG | v1.0.0 (MOHW) | 公開 | data-loader `--twcore` | 30+ CodeSystem |
| 臨床指引 | 自整理 | — | data-loader `--guideline` | 種子資料 |
| Taiwan FDA 藥品 | 每週更新 | 公開 (FDA) | 自動（app 啟動時） | 66,000+ 許可證 |
| Taiwan FDA 健康食品 | 每週更新 | 公開 (FDA) | 自動（app 啟動時） | 數百項 |
| Taiwan FDA 營養 | 每週更新 | 公開 (FDA) | 自動（app 啟動時） | 200,000+ 筆測量 |

---

## 靜態術語資料（需 data-loader）

### ICD-10-CM 2025

- **來源**: NLM（美國國家醫學圖書館）
- **檔案**: `fhir-code/icd/10/icd10cm/icd10cm-table-index-2025.zip`（~20 MB）
- **Schema**: `icd.diagnoses`
- **下載**: [CMS ICD-10](https://www.cms.gov/medicare/coding-billing/icd-10-codes)

### ICD-10-PCS 2025

- **來源**: CMS（美國醫療保險）
- **檔案**: `fhir-code/icd/10/icd10pcs/icd10pcs_tables_2025.zip`（已備齊，~648 KB）
- **Schema**: `icd.procedures`（78,948 筆手術碼；未載入時工具自動降級）
- **載入**: `--icd` 自動同時載入 CM 和 PCS，無需分別執行
- **下載**: [CMS ICD-10-PCS](https://www.cms.gov/medicare/coding-billing/icd-10-codes)

### LOINC 2.80

- **來源**: Regenstrief Institute
- **檔案**: `fhir-code/loinc/2.80/Loinc_2.80.zip`（~74 MB，需授權，不納入 git）
- **台灣設定**: `fhir-code/loinc/taiwan_mapping.csv`（中文名稱）、`fhir-code/loinc/lab_reference_ranges.csv`（參考值）
- **Schema**: `loinc.concepts`, `loinc.reference_ranges`
- **授權申請**: [loinc.org/license](https://loinc.org/license/)（免費，需註冊）

### SNOMED CT International RF2

- **來源**: SNOMED International
- **檔案**: `fhir-code/snomed/SnomedCT_InternationalRF2_PRODUCTION_*.zip`（~540 MB，需授權，不納入 git）
- **Schema**: `snomed.concepts`, `snomed.descriptions`, `snomed.relationships`, `snomed.icd10_map`
- **授權申請**: [snomed.org/get-snomed](https://www.snomed.org/get-snomed)（多數用途免費，需註冊）
- **散佈限制**: 不得在本 repo、PR 附件、Google Drive 或其他鏡像分享原始檔
- **載入時間**: 5-15 分鐘

### RxNorm Full Release

- **來源**: NLM（需 UMLS 帳號）
- **檔案**: `fhir-code/rxnorm/RxNorm_full_*.zip`（~241 MB，需授權，不納入 git）
- **Schema**: `rxnorm.concepts`, `rxnorm.relationships`
- **授權申請**: [uts.nlm.nih.gov](https://uts.nlm.nih.gov/uts/signup-login)（免費，需申請 UMLS 帳號）
- **散佈限制**: 不得在本 repo、PR 附件、Google Drive 或其他鏡像分享原始檔

### TWCore IG v1.0.0

- **來源**: 衛福部 (MOHW)
- **檔案**: `fhir-code/twcoreig/package.tgz`（~2.8 MB）
- **Schema**: `twcore.codesystems`, `twcore.concepts`
- **說明**: 30+ 台灣健保 CodeSystem，含健保藥品碼、給藥途徑、科別代碼等

### 臨床指引種子資料

- **來源**: 開發者整理（基於台灣醫學會指引）
- **Schema**: `guideline.diseases`, `guideline.medications`, `guideline.lab_tests`, `guideline.treatment_goals`
- **注意**: 未經正式醫學審核，不適合直接用於臨床決策

---

## 動態 FDA 資料（自動同步）

### 台灣 FDA 藥品（5 個 API）

MCP app 啟動時若資料為空或超過 7 天未更新，自動觸發同步；之後每週二 02:00 UTC 定期更新。

| API | 內容 | 端點 |
|-----|------|------|
| master | 藥品許可證主表 | `export/36/json` |
| appearance | 外觀識別（形狀、顏色） | `export/42/json` |
| ingredients | 有效成分 | `export/43/json` |
| atc | ATC 藥物分類 | `export/41/json` |
| documents | 仿單連結 | `export/39/json` |

**去重注意**：FDA 原始資料偶爾含重複 `license_id`，系統在寫入前自動去重。

### 台灣 FDA 健康食品

- 端點：`export/19/json`
- 排程：每週一 02:30 UTC

### 台灣 FDA 食品營養

- 端點：`export/20/json`（營養成分）+ `export/4/json`（食品原料）
- 排程：每週一 03:00 UTC

---

## 授權申請連結

以下資料集因授權規定**不可再散佈**，不納入本 git 儲存庫。請自行至官方申請帳號後下載，放入對應的 `fhir-code/` 子目錄。文件僅可提供官方申請頁面，不可提供 Google Drive 或其他第三方鏡像連結。

| 資料集 | 申請連結 | 費用 |
|--------|---------|------|
| LOINC | [loinc.org/license](https://loinc.org/license/) | 免費 |
| SNOMED CT | [snomed.org/get-snomed](https://www.snomed.org/get-snomed) | 免費（多數用途） |
| RxNorm / UMLS | [uts.nlm.nih.gov](https://uts.nlm.nih.gov/uts/signup-login) | 免費 |
| ICD-10-CM/PCS | [CMS ICD-10](https://www.cms.gov/medicare/coding-billing/icd-10-codes) | 免費 |

---

## 資料目錄結構

下載後，將檔案放入對應目錄，再執行 data-loader。

```
fhir-code/
├── icd/
│   └── 10/
│       ├── icd10cm/
│       │   └── icd10cm-table-index-2025.zip      (~20 MB)
│       ├── icd10pcs/                              ✅ 已備齊
│       │   └── icd10pcs_tables_2025.zip          (~648 KB)
│       └── *.xlsx                                (台灣衛福部中文名稱，選用)
├── loinc/
│   ├── 2.80/
│   │   └── Loinc_2.80.zip                        (~74 MB，需授權)
│   ├── taiwan_mapping.csv                        ✅ 已備齊（中文名稱）
│   └── lab_reference_ranges.csv                 ✅ 已備齊（參考值）
├── snomed/
│   └── SnomedCT_InternationalRF2_PRODUCTION_*.zip (~540 MB，需授權)
├── rxnorm/
│   └── RxNorm_full_*.zip                         (~241 MB，需 UMLS 帳號)
├── twcoreig/
│   └── package.tgz                               ✅ 已備齊 (~2.8 MB)
└── umls/                                         (尚未整合，預留目錄)
    └── umls-2024AA-metathesaurus-full.zip        (需 UMLS 帳號)
```
