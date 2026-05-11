# Taiwan Health MCP

> Taiwan's medical-grade MCP: ICD-10, TFDA drugs, SNOMED CT, RxNorm, LOINC, clinical guidelines — free and open source.

[![FHIR](https://img.shields.io/badge/FHIR-R4-blue)](http://hl7.org/fhir/R4/)
[![Python](https://img.shields.io/badge/Python-3.12-green)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-1.25-orange)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Website](https://img.shields.io/badge/Website-tw--health--mcp-blue)](https://tw-health-mcp.healthymind-tech.com/)
[![Docs](https://img.shields.io/badge/Docs-GitHub%20Pages-informational)](https://healthymind-tech.github.io/Taiwan-Health-MCP)

28 tools. Taiwan-specific clinical data. Works with Claude Desktop today.

🌐 **[tw-health-mcp.healthymind-tech.com](https://tw-health-mcp.healthymind-tech.com/)**

---

## Quick Start — Claude Desktop

### Option 1: Use our hosted endpoint（不需自架）

在 `claude_desktop_config.json` 加入：

```json
{
  "mcpServers": {
    "taiwan-health": {
      "url": "https://tw-health-mcp.healthymind-tech.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

重啟 Claude Desktop 即可使用。

### Option 2: Self-host with Docker

```bash
git clone https://github.com/healthymind-tech/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
cp .env.example .env
cp config/datasets.example.yaml config/datasets.yaml
# 編輯 .env，至少設定 POSTGRES_PASSWORD
docker compose up -d
docker compose --profile loader run --rm data-loader --all
```

服務啟動後在 `claude_desktop_config.json` 填入 `http://localhost:8000/mcp`。

詳細安裝步驟 → **[Getting Started](https://healthymind-tech.github.io/Taiwan-Health-MCP/getting-started/)**

---

## 🎬 使用場景

### 1. Drug interaction risk analysis（醫師場景）

| | |
|---|---|
| **Scenario** | 分析多種藥物交互作用風險，查詢 TFDA 核准用法用量 |
| **Tools used** | `search_drug` (interaction mode) |
| **Demo** | *(影片即將上線)* |

### 2. ICD-10 code lookup（開發者場景）

| | |
|---|---|
| **Scenario** | 搜尋 ICD-10 診斷碼，產生 FHIR R4 Condition 資源 |
| **Tools used** | `search_medical_codes`, `query_fhir_condition` |
| **Demo** | *(影片即將上線)* |

### 3. Lab result interpretation（研究者場景）

| | |
|---|---|
| **Scenario** | 查詢 LOINC 碼並自動判讀 HbA1c、eGFR、ALT 檢驗結果 |
| **Tools used** | `search_loinc`, `interpret_lab_result` |
| **Demo** | *(影片即將上線)* |

---

## 📋 工具清單（28 個）

| 群組 | 工具 | 說明 |
|------|------|------|
| 系統 | `health_check` | 服務與資料集狀態（永遠可用） |
| [ICD-10](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/icd-tools/) | `search_medical_codes` `infer_complications` `get_nearby_codes` `check_medical_conflict` `browse_icd_category` | ICD-10-CM 2025 診斷碼 + ICD-10-PCS 2025 處置碼 |
| [藥品](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/drug-tools/) | `search_drug` `identify_unknown_pill` | TFDA 藥品搜尋、RxNorm 整合、藥物交互作用、外觀辨識 |
| [健康補充品](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/health-food-tools/) | `search_health_supplement` | TFDA 核可健康食品查詢 |
| [營養](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/nutrition-tools/) | `query_food_nutrition` `query_food_ingredient` `search_foods_by_nutrient` `analyze_meal_nutrition` | 食品營養成分、原料查詢、餐點分析 |
| [FHIR](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/fhir-tools/) | `query_fhir_condition` `validate_fhir_condition` `query_fhir_medication` `validate_fhir_medication` | FHIR R4 Condition / Medication 資源產生與驗證 |
| [LOINC / Lab](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/lab-tools/) | `search_loinc` `query_loinc` `interpret_lab_result` `batch_interpret_lab_results` | 87,000+ LOINC 碼查詢、參考值、結果判讀 |
| [臨床指引](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/guideline-tools/) | `search_clinical_guideline` `query_guideline` | 台灣臨床指引搜尋與段落查詢 |
| [TWCore IG](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/twcore-tools/) | `query_twcore_code` | 台灣核心 30+ CodeSystem 統一查詢 |
| [SNOMED CT](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/snomed-tools/) | `search_snomed_concept` `query_snomed_concept` `get_snomed_relationships` `query_snomed_mapping` | 370,000+ 概念、IS-A 階層、ICD-10 雙向對應 |

📖 **[完整 API 文件與參數說明 →](https://healthymind-tech.github.io/Taiwan-Health-MCP/tools/)**

---

## 🏗️ 基礎架構

| 元件 | 版本 | 用途 |
|------|------|------|
| PostgreSQL + pgvector | 16-alpine | 主要資料庫（所有術語資料 + 向量搜尋） |
| pgBouncer | latest | 連線池（transaction mode，500 clients → 30 PG 連線） |
| Redis | 7-alpine | 回應快取（`@cached` 裝飾器，LRU 策略） |
| asyncpg | — | 高效能 PostgreSQL 非同步驅動 |
| MCP SDK | 1.25 | 官方 MCP SDK（`FastMCP`） |
| Python | 3.12 | — |

---

## 📦 資料集

| 資料集 | 版本 | 說明 |
|--------|------|------|
| ICD-10-CM | 2025 (NLM) | 診斷碼 |
| ICD-10-PCS | 2025 (CMS) | 手術/處置碼（78,948 筆） |
| LOINC | 2.80 | 87,000+ 檢驗碼 |
| SNOMED CT International | 20250601 | 370,000+ 臨床概念、IS-A 階層 |
| RxNorm | 2024-06-03 | 藥品命名、藥物交互作用（整合進 `search_drug`） |
| TWCore IG | v1.0.0 | 30+ 台灣健保 CodeSystem |
| Taiwan FDA 藥品 | 每週更新 | 66,000+ 藥品許可證 |
| Taiwan FDA 健康補充品 | 每週更新 | 核可健康補充品 |
| Taiwan FDA 營養 | 每週更新 | 食品營養成分資料庫 |
| 臨床指引 | 自整理 | 台灣醫學會指引（種子資料） |

---

## ⚠️ 重要限制

- **健康補充品疾病對應** — 開發者整理，未經醫學驗證，不適合直接面向患者
- **FHIR 驗證** — 僅檢查必要欄位；生產環境請使用 [HL7 FHIR Validator](https://www.hl7.org/fhir/validation.html)
- **SNOMED CT** — 需有效的 SNOMED International 授權（多數用途免費）
- **藥物交互作用** — RxNorm `interacts_with` 不含嚴重程度評級，須由臨床醫師確認

---

## 🤝 貢獻

歡迎貢獻！詳見 [CONTRIBUTING.md](CONTRIBUTING.md)。

主要需求：補充臨床指引種子資料、新增 LOINC 中文對照、補充健康補充品疾病對應（需醫學審核）。

---

## 📞 聯絡

- **GitHub Issues**: [回報問題](https://github.com/healthymind-tech/Taiwan-Health-MCP/issues)
- **Email**: [support@healthymind-tech.com](mailto:support@healthymind-tech.com)

---

## 👥 Contributors

<a href="https://github.com/healthymind-tech/Taiwan-Health-MCP/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=healthymind-tech/Taiwan-Health-MCP" />
</a>

Made with [contrib.rocks](https://contrib.rocks).

---

## 🙏 致謝

- 台灣衛生福利部、TFDA（ICD、藥品、健康補充品、營養資料）
- Regenstrief Institute（LOINC）
- SNOMED International（SNOMED CT）
- National Library of Medicine（RxNorm、ICD-10-CM）
- HL7 International（FHIR）
- WHO（ICD、ATC）
- Twinkle AI — 感謝社群串接本專案打造 Twinkle Health Agent

---

**⭐ 如果這個專案對您有幫助，請給我們一個 Star！**

## ⭐ Star History

<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="https://api.star-history.com/svg?repos=healthymind-tech/Taiwan-Health-MCP&type=Date&theme=dark"
  />
  <source
    media="(prefers-color-scheme: light)"
    srcset="https://api.star-history.com/svg?repos=healthymind-tech/Taiwan-Health-MCP&type=Date"
  />
  <img
    alt="Star History Chart"
    src="https://api.star-history.com/svg?repos=healthymind-tech/Taiwan-Health-MCP&type=Date"
  />
</picture>
