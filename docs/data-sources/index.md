# 資料來源

| 資料集 | 版本 / 來源 | 匯入方式 |
|--------|-------------|----------|
| ICD-10-CM / PCS | NLM / CMS 2025 | `data-loader --icd` |
| LOINC | 2.80 | `data-loader --loinc` |
| SNOMED CT | RF2 | `data-loader --snomed` |
| TWCore IG | MoHW | `data-loader --twcore` |
| 臨床指引 | 專案種子資料 | `data-loader --guideline` |
| 台灣健康補充品 | TFDA 開放資料 | `data-loader --health-food` |
| 台灣食品營養 | TFDA 開放資料 | `data-loader --food-nutrition` |

受授權限制的資料集請依 `config/datasets.yaml` 設定本機路徑。
