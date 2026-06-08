# 資料來源

所有資料匯入都在**管理後台（Admin → Modules）**操作,由 `admin-worker` 背景執行（已無 CLI data-loader）。下表的「匯入階段」對應 worker 內部使用的 loader 階段名稱。

| 資料集 | 版本 / 來源 | 匯入方式（Admin → Modules） | 匯入階段 | 授權 |
|--------|-------------|------------------------------|----------|------|
| ICD-10-CM / PCS | NLM / CMS 2025 | 上傳 zip → 匯入 | `--icd` | 公開（zip 需自備） |
| LOINC | 2.80（Regenstrief） | 上傳 zip → 匯入 | `--loinc` | 需 LOINC 授權 |
| SNOMED CT | International RF2 | 上傳 RF2 zip → 匯入 | `--snomed` | 需 SNOMED 授權 |
| FHIR IG（TWCore 等） | MoHW / packages.fhir.org | 上傳 `package.tgz` 或 Admin → IG 抓取 | `--twcore` | 公開 |
| 臨床指引 | 專案種子資料 | 直接執行（內建） | `--guideline` | 專案內建 |
| 藥品（台灣 FDA / TFDA） | TFDA `36_2.csv` + 線上爬取 | API 抓取 + 爬取分析 | `--drug-index` → `--drug-enrich` → `--drug-analysis` | 開放資料 |
| 台灣健康補充品 | TFDA 開放資料 | API 抓取 | `--health-supplements` | 開放資料 |
| 台灣食品營養 | TFDA 開放資料 | API 抓取 | `--food-nutrition` | 開放資料 |
| RxNorm（概念參考） | NLM | 上傳 `RxNorm_full_*.zip` → 匯入（IG ValueSet 展開用） | — | 公開 |

## 說明

- **受授權限制的來源檔**（SNOMED、LOINC、ICD zip、RxNorm 等）請自行取得後,於 Admin → Sources / Modules 上傳。
- **藥品域**為三階段管線（索引 → 線上爬取豐富 → OCR/LLM 分析），其中爬取與分析階段需設定 TFDA / OCR / 分析 LLM 端點（見 `.env` 的 `DRUG_*`,或於 Admin → Settings 管理）。詳見[藥品服務模組](../modules/drug-service.md)。
- **FHIR IG** 採多 IG（package-scoped）設計；除主 IG 外，可在 Admin → Sources 綁定相依套件（如 `hl7.terminology.r4`、`hl7.fhir.r4.core`）。詳見[FHIR IG 服務模組](../modules/fhir-ig-service.md)。
- **RxNorm** 目前僅作為概念參考術語載入，用於 FHIR IG ValueSet 的 TTY 展開，**不**對外提供獨立的藥物交互作用工具。
- **嵌入**：每個模組匯入後自動回填 `*_embeddings` 向量表（需 Ollama）；也可於模組頁面單獨重建。

各別來源細節：[ICD-10](icd10.md)、[LOINC](loinc.md)、[臨床指引](guidelines.md)。
