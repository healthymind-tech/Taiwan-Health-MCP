# 資料來源

所有資料匯入都在**管理後台（Admin → Modules）**操作,由 `admin-worker` 背景執行（已無 CLI data-loader）。下表的「匯入階段」是 `admin.import_jobs.job_type` 的實際值——建立工作時送出的就是這些字串。

| 資料集 | 版本 / 來源 | 匯入方式（Admin → Modules） | 匯入階段 | 授權 |
|--------|-------------|------------------------------|----------|------|
| ICD-10-CM / PCS | NLM / CMS 2025 | 上傳 zip → 匯入 | `icd_import` | 公開（zip 需自備） |
| LOINC | 2.80（Regenstrief） | 上傳 zip → 匯入 | `loinc_import` | 需 LOINC 授權 |
| SNOMED CT | International RF2 | 上傳 RF2 zip → 匯入 | `snomed_import` | 需 SNOMED 授權 |
| FHIR IG（TWCore 等） | MoHW / packages.fhir.org | 上傳 `package.tgz` 或 Admin → IG 抓取 | `ig_import` | 公開 |
| 藥品（台灣 FDA / TFDA） | TFDA `36_2.csv` + 線上爬取 | API 抓取 + 爬取分析 | `drug_index_import` → `drug_enrichment` → `drug_analysis` | 開放資料 |
| 台灣健康補充品 | TFDA 開放資料 | API 抓取 | `health_supplements_sync` | 開放資料 |
| 台灣食品營養 | TFDA 開放資料 | API 抓取 | `food_nutrition_sync` | 開放資料 |
| RxNorm（概念參考） | NLM | 上傳 `RxNorm_full_*.zip` → 匯入（IG ValueSet 展開用） | — | 公開 |

## 說明

- **受授權限制的來源檔**（SNOMED、LOINC、ICD zip、RxNorm 等）請自行取得後,於 Admin → Sources / Modules 上傳。
- **藥品域**為三階段管線（索引 → 線上爬取豐富 → OCR/LLM 分析），其中爬取與分析階段需設定 TFDA / OCR / 分析 LLM 端點（見 `.env` 的 `DRUG_*`,或於 Admin → Settings 管理）。詳見[藥品服務模組](../modules/drug-service.md)。
- **FHIR IG** 採多 IG（package-scoped）設計；除主 IG 外，可在 Admin → Sources 綁定相依套件（如 `hl7.terminology.r4`、`hl7.fhir.r4.core`）。詳見[FHIR IG 服務模組](../modules/fhir-ig-service.md)。
- **RxNorm** 目前僅作為概念參考術語載入，用於 FHIR IG ValueSet 的 TTY 展開，**不**對外提供獨立的藥物交互作用工具。
- **嵌入**：`*_embeddings` 向量表由各模組獨立的 `*_embed` 工作回填，可在模組頁面執行或排程。嵌入端點存於 `admin.llm_profiles`（於 Admin → Settings 設定，預設為 Ollama）；端點不可用時，搜尋自動退回關鍵字模式。

各別來源細節：[ICD-10](icd10.md)、[LOINC](loinc.md)。
