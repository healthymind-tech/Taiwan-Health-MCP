# Taiwan Health MCP Server

> 台灣醫療健康資料整合 MCP 伺服器
> 整合 ICD-10-CM、SNOMED CT、LOINC、台灣健康食品/食品營養、TWCore IG、臨床指引，支援 FHIR R4 Condition

[![FHIR](https://img.shields.io/badge/FHIR-R4-blue)](http://hl7.org/fhir/R4/)
[![Python](https://img.shields.io/badge/Python-3.12-green)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-orange)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## 專案特色

- 台灣在地化資料整合：台灣 FDA 健康食品與食品營養、TWCore IG、臨床指引
- 國際術語支援：ICD-10-CM/PCS、SNOMED CT、LOINC、FHIR R4
- 動態工具啟用：依資料集載入狀態自動註冊可用 MCP 工具
- 生產部署設計：PostgreSQL 16、pgBouncer、Redis、Prometheus

## 快速開始

```bash
git clone https://github.com/healthymind-tech/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
cp .env.example .env
cp config/datasets.example.yaml config/datasets.yaml
docker compose up -d
docker compose --profile loader run --rm data-loader --all
```

若只想個別初始化資料集，可使用：

```bash
docker compose --profile loader run --rm data-loader --icd
docker compose --profile loader run --rm data-loader --loinc
docker compose --profile loader run --rm data-loader --twcore
docker compose --profile loader run --rm data-loader --guideline
docker compose --profile loader run --rm data-loader --snomed
docker compose --profile loader run --rm data-loader --health-food
docker compose --profile loader run --rm data-loader --food-nutrition
```

## 目前能力

- ICD-10 診斷與手術碼搜尋、鄰近碼、分類瀏覽、衝突資訊
- SNOMED CT 概念搜尋、階層查詢、關聯查詢、ICD 對應
- LOINC 搜尋、參考區間查詢、單項與批次檢驗判讀
- 臨床指引搜尋、分段查詢與臨床路徑建議
- 台灣健康食品搜尋與食品營養分析
- TWCore CodeSystem 查詢
- FHIR Condition 產生與驗證

## 資料庫 Schema

目前主要 schema：

`audit` | `icd` | `health_food` | `food_nutrition` | `loinc` | `guideline` | `twcore` | `snomed`

## 開發與測試

```bash
python -m pytest tests/ -v
python -m pytest tests/test_tools_fhir.py -v
python -m pytest tests/test_dataset_resolver.py -v
```

## 文件

完整文件請見 `docs/` 與 MkDocs 設定。

## 致謝

- 台灣衛生福利部、TFDA
- Regenstrief Institute
- SNOMED International
- National Library of Medicine
- HL7 International
- WHO
