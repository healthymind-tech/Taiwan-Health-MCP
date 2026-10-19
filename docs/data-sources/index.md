# 資料來源

所有資料匯入都在**管理後台**操作，由 `admin-worker` 背景執行（已無 CLI data-loader）：術語類在 **醫療術語 → <模組>**、FHIR IG 在 **FHIR → IG 套件庫**、藥品與 TFDA 開放資料在 **資料** 區。每個模組頁的「資料生命週期」分頁負責上傳來源檔、匯入與向量回填。下表的「匯入階段」是 `admin.import_jobs.job_type` 的實際值——建立工作時送出的就是這些字串。

| 資料集 | 版本 / 來源 | 匯入方式 | 匯入階段 | 授權 |
|--------|-------------|----------|----------|------|
| ICD-10-CM | CMS 2026-04-01（「Code Descriptions in Tabular Order」，完整碼集含第 7 碼） | 上傳 zip → 匯入 | `icd_import` | 公開（zip 需自備） |
| ICD-10-PCS | CMS 2025 | 上傳 zip → 匯入（與 CM 同一個工作） | `icd_import` | 公開 |
| WHO ICD-10（選用） | tx.fhir.org `2019-covid-expanded`（FHIR JSON） | 上傳 JSON → 匯入（與 CM 同一個工作） | `icd_import` | WHO |
| LOINC | 2.80（Regenstrief） | 上傳 zip → 匯入 | `loinc_import` | 需 LOINC 授權 |
| SNOMED CT | International RF2（目前 20250601） | 上傳 RF2 zip → 匯入 | `snomed_import` | 需 SNOMED 授權 |
| RxNorm（概念參考） | NLM | 上傳 `RxNorm_full_*.zip` → 匯入（IG ValueSet 展開用） | `rxnorm_import` | 需 UMLS 帳號 |
| FHIR IG（TWCore 等） | MoHW / packages.fhir.org | 從 registry 安裝或上傳 `package.tgz`；相依 IG 自動下載 | `ig_import` | 公開 |
| 藥品（台灣 FDA / TFDA） | TFDA `36_2.csv` + 線上爬取 | 上傳 CSV + 爬取分析 | `drug_index_import` → `drug_enrichment` → `drug_analysis` | 開放資料 |
| 台灣健康補充品 | TFDA 開放資料 | API 抓取 | `health_supplements_sync` | 開放資料 |
| 台灣食品營養 | TFDA 開放資料 | API 抓取 | `food_nutrition_sync` | 開放資料 |

CVX（287 碼）、ISO 3166 與 UCUM 不需匯入：它們以內建表 / 函式庫的形式隨程式碼提供，只供 FHIR validator 使用。

## 說明

- **受授權限制的來源檔**（SNOMED、LOINC、ICD zip、RxNorm 等）請自行取得後，於對應模組頁上傳。實際用過的檔案清單見[測試資料檔清單](test-data.md)。
- **藥品域**為三階段管線（索引 → 線上爬取豐富 → OCR/LLM 分析）。TFDA 位址在 **整合 → 外部服務** 設定（`.env` 的 `DRUG_*` 只在首次啟動時當種子值）；OCR（MinerU 或 Indra）在 **整合 → 外部服務 → OCR Server**；分析 LLM 在 **整合 → 模型端點**。詳見[藥品服務模組](../modules/drug-service.md)。
- **FHIR IG** 採多 IG（package-scoped）設計；套件宣告的相依套件（如 `hl7.terminology.r4`、`hl7.fhir.r4.core`）會自動從 FHIR registry 下載，registry 無法提供時才需手動上傳。詳見[FHIR IG 服務模組](../modules/fhir-ig-service.md)。
- **RxNorm** 目前僅作為概念參考術語載入，用於 FHIR IG ValueSet 的 TTY 展開與 FHIR validator 的 RxNorm 碼 / display 檢查（匯入時保留每個 RXCUI 的所有 SAB=RXNORM 名稱與版本，見 migration `20261030_rxnorm_display_names`），**不**對外提供獨立的藥品工具。
- **嵌入**：`*_embeddings` 向量表由各模組獨立的 `*_embed` 工作（`icd_embed`、`loinc_embed`、`snomed_embed`、`health_supplements_embed`、`food_nutrition_embed`）回填，可在模組頁執行或排程。嵌入端點在 **整合 → 模型端點** 設定（provider 帳號 + embedding 路由，存於 `admin.llm_providers` / `admin.llm_routes` 等表，不從環境變數讀取）；端點不可用時，搜尋自動退回關鍵字模式。

各別來源細節：[ICD-10](icd10.md)、[LOINC](loinc.md)。
