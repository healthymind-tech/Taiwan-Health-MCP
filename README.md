# Taiwan Health MCP Server

> 🇹🇼 台灣醫療健康資料整合 MCP 伺服器
> 整合 ICD-10-CM、SNOMED CT、RxNorm、LOINC、FDA 藥品/保健食品/營養、TWCore IG、臨床指引，支援 FHIR R4 標準

[![FHIR](https://img.shields.io/badge/FHIR-R4-blue)](http://hl7.org/fhir/R4/)
[![Python](https://img.shields.io/badge/Python-3.12-green)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-orange)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## ✨ 專案特色

- 🇹🇼 **台灣在地化** — 整合台灣 FDA、衛福部官方開放資料，支援繁體中文
- 🔗 **國際標準** — 符合 FHIR R4、ICD-10-CM 2025、LOINC 2.80、SNOMED CT、RxNorm、ATC
- 🏥 **56 個 MCP 工具** — 涵蓋診斷、藥品、檢驗、指引、術語、藥物交互作用
- 🏗️ **生產就緒** — PostgreSQL 16 + pgBouncer + Redis + Prometheus，支援每秒數百請求
- 🔄 **自動同步** — FDA 藥品/保健食品/營養資料每週自動更新

---

## 🚀 快速開始

### 前置需求

- Docker + Docker Compose
- 至少 4 GB 可用記憶體

### 1. 準備環境

```bash
git clone https://github.com/healthymind-tech/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
cp .env.example .env
cp config/datasets.example.yaml config/datasets.yaml
# 編輯 .env，至少設定 POSTGRES_PASSWORD
# 視部署環境編輯 config/datasets.yaml，指定各 dataset 的實際檔案位置
```

### 2. 啟動服務

```bash
docker compose up -d
```

這會啟動四個容器：`postgres`、`pgbouncer`、`redis`、`app`（MCP server）。

### 3. 載入術語資料

術語資料（ICD、LOINC、SNOMED CT 等）需手動下載後，在 `config/datasets.yaml`
設定檔案位置，再執行 loader：

```bash
# 全部載入（建議首次部署）
docker compose --profile loader run --rm data-loader --all

# 僅初始化 FDA 動態資料
docker compose --profile loader run --rm data-loader --fda
docker compose --profile loader run --rm data-loader --drug
docker compose --profile loader run --rm data-loader --health-food
docker compose --profile loader run --rm data-loader --food-nutrition

# 或依需求單項載入
docker compose --profile loader run --rm data-loader --icd        # ICD-10-CM 2025
docker compose --profile loader run --rm data-loader --loinc      # LOINC 2.80
docker compose --profile loader run --rm data-loader --twcore     # TWCore IG
docker compose --profile loader run --rm data-loader --guideline  # 臨床指引
docker compose --profile loader run --rm data-loader --snomed     # SNOMED CT（5-15 分鐘）
docker compose --profile loader run --rm data-loader --rxnorm     # RxNorm
```

`DATASETS_CONFIG` 預設為 `/app/config/datasets.yaml`。若未設定，loader 會回退到舊的
`/app/fhir-code` 目錄規則。新部署建議使用 `config/datasets.yaml`，避免依賴固定檔名與固定目錄結構。

> `--all` 現在也會初始化 Taiwan FDA 藥品、健康食品、營養資料。
> app 仍會在首次啟動或資料過期時自動同步，但若想在部署階段先灌資料，請使用 `data-loader --all` 或 `--fda`。

### 4. 確認服務正常

```bash
# 查看服務狀態
docker compose ps

# 健康檢查（需先建立 MCP session）
curl http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'
```

### 5. 連接 Claude Desktop

在 `claude_desktop_config.json` 加入：

```json
{
  "mcpServers": {
    "taiwan-health": {
      "url": "http://localhost:8000/mcp",
      "transport": "streamable-http"
    }
  }
}
```

---

## 🏗️ 基礎架構

| 元件 | 版本 | 用途 |
|------|------|------|
| PostgreSQL | 16-alpine | 主要資料庫（所有術語資料） |
| pgBouncer | edoburu/latest | 連線池（transaction mode，500 client → 30 PG 連線） |
| Redis | 7-alpine | 回應快取（TTL 策略，`@cached` 裝飾器） |
| Prometheus | — | 指標監控（預設 port 9090） |
| FastMCP | 1.x | MCP server 框架 |
| asyncpg | — | 高效能 PostgreSQL 非同步驅動 |

### PostgreSQL Schema

`audit` | `icd` | `drug` | `health_food` | `food_nutrition` | `loinc` | `guideline` | `twcore` | `snomed` | `rxnorm`

---

## 📋 核心功能（56 個 MCP 工具）

| 群組 | 工具數 | 功能 |
|------|--------|------|
| ICD-10 | 4 | ICD-10-CM 診斷碼搜尋、併發症推論、衝突檢查 |
| 藥品 (FDA) | 3 | 藥品查詢、詳細資訊、外觀識別 |
| 健康食品 (FDA) | 2 | 健康食品查詢、保健分析 |
| 營養 (FDA) | 4 | 營養成分、膳食分析、食品原料 |
| 健康食品+ICD 整合 | 1 | 疾病-保健食品對應分析 |
| FHIR Condition | 3 | ICD-10 → FHIR R4 Condition 轉換、驗證 |
| FHIR Medication | 4 | 藥品 → FHIR R4 Medication/MedicationKnowledge |
| 檢驗 (LOINC) | 5 | LOINC 碼查詢、參考值、結果判讀、批次判讀 |
| 臨床指引 | 5 | 指引查詢、用藥/檢查建議、治療目標、臨床路徑 |
| TWCore IG | 3 | 台灣核心 CodeSystem 查詢（30+ 健保碼系統） |
| SNOMED CT | 6 | 概念搜尋、階層查詢、ICD-10 雙向對應 |
| RxNorm | 3 | 藥物交互作用檢查、藥品名稱解析、成分查詢 |

---

## 📦 資料集

| 資料集 | 版本 | 授權 | 說明 |
|--------|------|------|------|
| ICD-10-CM | 2025 (NLM) | 公開 | 診斷碼 |
| ICD-10-PCS | 2025 (CMS) | 公開 | 手術/處置碼（78,948 筆，`--icd` 同時載入） |
| LOINC | 2.80 | LOINC License（免費） | 87,000+ 檢驗碼 |
| SNOMED CT International | 20250601 | SNOMED License（免費） | 370,000+ 臨床概念、IS-A 階層 |
| RxNorm | 2024-06-03 | 公開 (NLM) | 藥品命名、藥物交互作用 |
| TWCore IG | v1.0.0 | 公開 (MOHW) | 30+ 台灣健保 CodeSystem |
| Taiwan FDA 藥品 | 每週更新 | 公開 (FDA) | 66,000+ 藥品許可證 |
| Taiwan FDA 健康食品 | 每週更新 | 公開 (FDA) | 核可健康食品 |
| Taiwan FDA 營養 | 每週更新 | 公開 (FDA) | 食品營養成分資料庫 |
| 臨床指引 | 自整理 | — | 台灣醫學會指引（種子資料） |

---

## ⚠️ 重要限制

- **健康食品疾病對應** — 開發者整理，未經醫學驗證，不適合直接面向患者
- **FHIR 驗證** — 僅檢查必要欄位；生產環境請使用 HL7 FHIR Validator
- **ICD-10-PCS** — 已內建 2025 版（78,948 筆），`--icd` 自動同時載入 CM 和 PCS；`icd.procedures` 未載入時工具自動降級
- **SNOMED CT** — 需有效的 SNOMED International 授權（多數用途免費）
- **藥物交互作用** — RxNorm `interacts_with` 不含嚴重程度評級，須由臨床醫師確認
- **pgBouncer transaction mode** — 不相容於 `LISTEN/NOTIFY` 和 named prepared statements（asyncpg 已設 `statement_cache_size=0`）

---

## 🤝 貢獻

歡迎貢獻！詳見 [CONTRIBUTING.md](CONTRIBUTING.md)。

主要需求：
- 補充/驗證臨床指引種子資料
- 新增 LOINC 中文對照
- 補充健康食品疾病對應（需醫學審核）
- 補充/驗證臨床指引種子資料

---

## 📞 聯絡

- **GitHub Issues**: [回報問題](https://github.com/healthymind-tech/Taiwan-Health-MCP/issues)
- **Email**: [support@healthymind-tech.com](mailto:support@healthymind-tech.com)

---

## 🙏 致謝

- 台灣衛生福利部、TFDA（ICD、藥品、健康食品、營養資料）
- Regenstrief Institute（LOINC）
- SNOMED International（SNOMED CT）
- National Library of Medicine（RxNorm、ICD-10-CM）
- HL7 International（FHIR）
- WHO（ICD、ATC）
- Twinkle AI — 感謝社群串接本專案打造 Twinkle Health Agent

**⭐ 如果這個專案對您有幫助，請給我們一個 Star！**
