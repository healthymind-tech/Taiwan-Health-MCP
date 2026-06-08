# 資料來源

| 資料集 | 版本 / 來源 | 載入指令 | 授權 |
|--------|-------------|----------|------|
| ICD-10-CM / PCS | NLM / CMS 2025 | `data-loader --icd` | 公開（zip 需自備） |
| LOINC | 2.80（Regenstrief） | `data-loader --loinc` | 需 LOINC 授權 |
| SNOMED CT | International RF2 | `data-loader --snomed` | 需 SNOMED 授權 |
| FHIR IG（TWCore 等） | MoHW / packages.fhir.org | `data-loader --twcore` 或 Admin → IG | 公開 |
| 臨床指引 | 專案種子資料 | `data-loader --guideline` | 專案內建 |
| 藥品（台灣 FDA / TFDA） | TFDA `36_2.csv` + 線上爬取 | `data-loader --drug-index` → `--drug-enrich` → `--drug-analysis` | 開放資料 |
| 台灣健康補充品 | TFDA 開放資料 | `data-loader --health-supplements` | 開放資料 |
| 台灣食品營養 | TFDA 開放資料 | `data-loader --food-nutrition` | 開放資料 |
| RxNorm（概念參考） | NLM | `rxnorm/RxNorm_full_*.zip`（IG ValueSet 展開用） | 公開 |

## 說明

- **受授權限制的來源檔**（SNOMED、LOINC、ICD zip、RxNorm 等）請自行取得後，依 `config/datasets.yaml`（`DATASETS_CONFIG`）設定本機路徑；未設定時，loader 退回 `/app/fhir-code/` 的傳統目錄慣例。
- **藥品域**為三階段管線（索引 → 線上爬取豐富 → OCR/LLM 分析），其中 `--drug-enrich` 與 `--drug-analysis` 需設定 TFDA / OCR / 分析 LLM 端點（見 `.env` 的 `DRUG_*`）。詳見[藥品服務模組](../modules/drug-service.md)。
- **FHIR IG** 採多 IG（package-scoped）設計；除主 IG 外，可在 Admin → Sources 綁定相依套件（如 `hl7.terminology.r4`、`hl7.fhir.r4.core`）。詳見[FHIR IG 服務模組](../modules/fhir-ig-service.md)。
- **RxNorm** 目前僅作為概念參考術語載入，用於 FHIR IG ValueSet 的 TTY 展開，**不**對外提供獨立的藥物交互作用工具。
- **嵌入**：每次載入後自動回填 `*_embeddings` 向量表（需 Ollama）；可單獨以 `data-loader --embed` 重建。

各別來源細節：[ICD-10](icd10.md)、[LOINC](loinc.md)、[臨床指引](guidelines.md)。
