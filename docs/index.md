# Taiwan Health MCP Server

<div align="center">

# 🇹🇼 台灣醫療健康資料整合 MCP 伺服器

**整合 ICD-10、SNOMED CT、RxNorm、LOINC、FDA 藥品/保健食品/營養、TWCore IG、臨床指引，支援 FHIR R4 標準**

[![FHIR](https://img.shields.io/badge/FHIR-R4-blue)](http://hl7.org/fhir/R4/)
[![Python](https://img.shields.io/badge/Python-3.12-green)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-orange)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-yellow)](https://github.com/healthymind-tech/Taiwan-Health-MCP/blob/main/LICENSE)

[快速開始](getting-started.md){ .md-button .md-button--primary }
[查看 GitHub](https://github.com/healthymind-tech/Taiwan-Health-MCP){ .md-button }

</div>

---

## ✨ 專案特色

<div class="grid cards" markdown>

-   :flag_tw: __台灣在地化__

    ---

    整合台灣 FDA、衛福部官方開放資料，支援繁體中文

-   :link: __國際標準__

    ---

    FHIR R4、ICD-10-CM 2025、LOINC 2.80、SNOMED CT、RxNorm、ATC

-   :bar_chart: __30 個 MCP 工具__

    ---

    涵蓋診斷、藥品、術語、檢驗、指引；RxNorm 能力整併至 `search_drug`

-   :robot: __AI 整合__

    ---

    透過 MCP 協議與 Claude 無縫對接

-   :arrows_counterclockwise: __自動同步__

    ---

    FDA 藥品/保健食品/營養每週自動更新

-   :shield: __生產就緒__

    ---

    PostgreSQL + pgBouncer + Redis + Prometheus，支援高並發

</div>

---

## 🎯 核心功能

### 1. ICD-10 診斷與手術碼查詢
- ✅ ICD-10-CM 診斷碼搜尋（2025 版）
- ✅ ICD-10-PCS 手術碼搜尋（需下載 PCS zip）
- ✅ 診斷併發症推論
- ✅ 診斷與手術碼衝突檢查

### 2. 台灣 FDA 藥品資料
整合 5 個官方資料集，66,000+ 藥品許可證：
- ✅ 藥品名稱、適應症、製造商
- ✅ 外觀識別（形狀、顏色、刻痕）
- ✅ 有效成分與含量
- ✅ ATC 藥物分類（WHO 標準）
- ✅ 轉換為 FHIR Medication/MedicationKnowledge

### 3. SNOMED CT 臨床術語
- ✅ 370,000+ 概念全文搜尋
- ✅ IS-A 階層查詢（ancestors/children）
- ✅ ICD-10 ↔ SNOMED 雙向對應

### 4. RxNorm 藥物語義與交互作用（併入 Drug 工具）
- ✅ 多藥交互作用檢查
- ✅ 藥品名稱 → RXCUI 解析
- ✅ 藥物成分查詢

### 5. LOINC 檢驗碼
- ✅ 87,000+ LOINC 碼搜尋
- ✅ 參考值查詢（依年齡、性別）
- ✅ 檢驗結果自動判讀、批次判讀

### 6. 臨床診療指引
- ✅ 台灣醫學會臨床指引查詢
- ✅ 用藥建議、檢查建議、治療目標
- ✅ 臨床路徑規劃

### 7. TWCore IG
- ✅ 30+ 台灣健保 CodeSystem
- ✅ 給藥途徑、科別、健保碼查詢

---

## 📊 系統架構

```mermaid
graph TB
    subgraph "使用者層"
        A[Claude AI]
    end

    subgraph "MCP 協議層"
        B[MCP Server<br/>30 個工具]
    end

    subgraph "服務層"
        C1[ICD Service]
        C2[Drug Service]
        C3[FHIR Service]
        C4[Lab Service]
        C5[Guideline Service]
    end

    subgraph "資料層"
        D1[(ICD-10 DB)]
        D2[(Drug DB)]
        D3[(LOINC DB)]
        D4[(Guideline DB)]
    end

    subgraph "外部資料源"
        E1[台灣 FDA API]
        E2[LOINC 官方]
        E3[衛福部 ICD-10]
    end

    A --> B
    B --> C1
    B --> C2
    B --> C3
    B --> C4
    B --> C5

    C1 --> D1
    C2 --> D2
    C4 --> D3
    C5 --> D4

    E1 -.->|同步| D2
    E2 -.->|整合| D3
    E3 -.->|匯入| D1

    style A fill:#e1f5ff
    style B fill:#fff3e0
    style C1 fill:#f3e5f5
    style C2 fill:#f3e5f5
    style C3 fill:#f3e5f5
    style C4 fill:#f3e5f5
    style C5 fill:#f3e5f5
```

[查看詳細架構](architecture/system-architecture.md){ .md-button }

---

## 🚀 快速開始

=== "Docker（推薦）"

    ```bash
    # 1. Clone 並準備環境
    git clone https://github.com/healthymind-tech/Taiwan-Health-MCP.git
    cd Taiwan-Health-MCP
    cp .env.example .env
    cp config/datasets.example.yaml config/datasets.yaml
    # 編輯 .env，設定 POSTGRES_PASSWORD
    # 編輯 config/datasets.yaml，指定各資料集實際檔案位置

    # 2. 啟動所有服務
    docker compose up -d

    # 3. 載入術語資料（需先在 config/datasets.yaml 指定檔案位置）
    docker compose --profile loader run --rm data-loader --all

    # 4. 查看日誌
    docker compose logs -f app
    ```

=== "本地開發"

    ```bash
    pip install -r requirements.txt

    # stdio 模式（Claude Desktop）
    DATABASE_URL=postgresql://mcp:pass@localhost:5432/taiwan_health \
    REDIS_URL=redis://localhost:6379/0 \
    python src/server.py

    # HTTP 模式
    MCP_TRANSPORT=streamable-http \
    DATABASE_URL=postgresql://... \
    python src/server.py
    ```

[詳細安裝說明](getting-started.md){ .md-button .md-button--primary }

> 既有環境升級請先套用 `db/migrations/2026-04-12_drug_schema_no_loss.sql`，確保 RxNorm 併入 `drug.*` 與新約束一致。

---

## 🛠️ MCP 工具清單

本服務提供 **30 個 MCP 工具**，包含 `health_check` 與 29 個領域工具，主要分為 11 個工具群組；工具分類與 status page 範例由同一份 registry 生成，避免文件和實作分岔。

| 群組 | 工具數 | 主要功能 |
|------|--------|---------|
| 系統 | 1 | `health_check`：資料庫、快取、dataset ready 狀態 |
| ICD-10 | 5 | 診斷/手術碼搜尋、併發症推論、衝突檢查、分類瀏覽 |
| 藥品 | 2 | `search_drug`（含 RxNorm modes）、`identify_unknown_pill` |
| 健康補充品 | 1 | `search_health_supplement` |
| 食品與營養 | 6 | 營養成分、膳食分析、食品原料、營養排序 |
| FHIR Condition | 2 | ICD-10 / 關鍵字 → FHIR R4 Condition |
| FHIR Medication | 2 | 藥品 / 關鍵字 → FHIR Medication/MedicationKnowledge |
| LOINC / Lab | 4 | `search_loinc`、`query_loinc`、單項/批次判讀 |
| 臨床指引 | 2 | 指引查詢與分段內容 |
| TWCore IG | 1 | 台灣健保 CodeSystem 統一查詢 |
| SNOMED CT | 4 | 概念搜尋、階層、關聯、ICD-10 對應 |

[查看完整工具清單](tools/index.md){ .md-button }

---

## 📚 文件導覽

<div class="grid cards" markdown>

-   :material-file-document: __架構設計__

    ---

    系統架構、資料流程、模組關係

    [:octicons-arrow-right-24: 查看架構文件](architecture/index.md)

-   :material-api: __API 參考__

    ---

    完整的 API 參考文件與範例

    [:octicons-arrow-right-24: 查看 API 文件](api/index.md)

-   :material-docker: __部署指南__

    ---

    Docker 部署、環境配置、監控

    [:octicons-arrow-right-24: 查看部署文件](deployment/index.md)

-   :material-book-open-variant: __使用指南__

    ---

    實用的使用指南與最佳實踐

    [:octicons-arrow-right-24: 查看使用指南](guides/index.md)

-   :material-hammer-wrench: __開發指南__

    ---

    開發環境設置、測試、貢獻指南

    [:octicons-arrow-right-24: 查看開發文件](development/index.md)

</div>

---

## 📊 資料來源

| 資料集 | 版本 | 用途 |
|--------|------|------|
| ICD-10-CM | 2025 (NLM) | 診斷碼 |
| LOINC | 2.80 | 檢驗碼 |
| SNOMED CT International | 20250601 | 臨床術語階層 |
| RxNorm | 2024-06-03 | 藥物交互作用 |
| TWCore IG | v1.0.0 | 台灣健保碼系統 |
| Taiwan FDA | 每週更新 | 藥品/健康食品/營養 |
| 臨床指引 | 自整理 | 台灣醫學會指引 |

[查看資料來源詳情](data-sources/index.md){ .md-button }

---

## 🙏 致謝

- 台灣衛生福利部、TFDA（ICD、藥品、健康食品、營養）
- Regenstrief Institute（LOINC）
- SNOMED International（SNOMED CT）
- National Library of Medicine（RxNorm、ICD-10-CM）
- HL7 International（FHIR）
- Twinkle AI — 感謝社群串接本專案打造 Twinkle Health Agent

<div align="center">

**⭐ 如果這個專案對您有幫助，請給我們一個 Star！**

[GitHub](https://github.com/healthymind-tech/Taiwan-Health-MCP){ .md-button .md-button--primary }

</div>
