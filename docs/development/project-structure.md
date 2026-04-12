# 專案結構

```text
.
├── src/                        # MCP server 與所有 service 模組
│   ├── server.py               # 入口點，DynamicFastMCP + 工具 registry / 動態註冊
│   ├── dataset_status.py       # DatasetStatusManager — 動態工具啟用/停用（5 分鐘 TTL）
│   ├── *_service.py            # ICD / Drug / Lab / Guideline / SNOMED / TWCore 等服務
│   ├── database.py             # asyncpg pool 單例
│   ├── cache.py                # Redis 快取裝飾器
│   ├── audit.py                # 稽核日誌裝飾器
│   ├── metrics.py              # Prometheus 指標
│   └── utils.py                # 結構化日誌與共用工具
├── loader/                     # data-loader 入口與各資料載入器
│   ├── main.py                 # CLI：--all / --icd / --fda / --drug / --rxnorm（Drug 有 RxNorm-first 防呆）
│   ├── dataset_config.py       # datasets.yaml 解析
│   ├── dataset_resolver.py     # dataset 路徑解析與 fallback
│   └── loaders/                # ICD / LOINC / TWCore / SNOMED / RxNorm / FDA loaders
├── config/                     # 設定檔範本
│   ├── datasets.example.yaml   # dataset 路徑設定範本
│   └── datasets.yaml           # 本機部署用設定（建議不納入版控）
├── fhir-code/                  # 術語原始資料與 seed 檔
│   ├── icd/                    # ICD-10-CM / PCS / 中文對照 Excel
│   ├── loinc/                  # LOINC zip 與台灣對照 CSV
│   ├── twcoreig/               # TWCore package.tgz
│   ├── snomed/                 # SNOMED CT 授權 zip
│   ├── rxnorm/                 # RxNorm 授權 zip
│   └── umls/                   # UMLS 授權 zip（預留）
├── db/                         # PostgreSQL schema、seed 與 migration SQL
│   ├── schema.sql              # 初次建庫 schema
│   ├── migrations/             # 版本升級 migration（含 no-data-loss 腳本）
│   └── seeds/                  # 種子資料 SQL
├── docs/                       # MkDocs 文件原始碼
├── tests/                      # pytest 測試
├── compose.yaml                # Docker Compose 主設定
├── Dockerfile                  # app image
├── Dockerfile.loader           # data-loader image
├── mkdocs.yml                  # 文件站設定
├── requirements.txt            # 執行環境依賴
└── requirements-dev.txt        # 測試依賴
```

## 設計模式
本專案採用以 **Service Layer** 為中心的結構：

- **Services** (`src/*_service.py`)：封裝查詢、FHIR 轉換、FDA 同步與術語邏輯。
- **Infrastructure** (`database.py`、`cache.py`、`audit.py`、`metrics.py`)：處理 PostgreSQL、Redis、稽核與監控。
- **MCP Entry** (`src/server.py`)：定義工具函式、初始化服務、管理 transport 與 HTTP 錯誤 logging；`DynamicFastMCP` 子類覆寫 `list_tools` 以觸發動態工具同步。工具分類、範例參數與 dataset-gating 由同一份 registry 衍生，避免手動同步。
- **Dataset Status** (`src/dataset_status.py`)：查詢各 schema 的資料量，與門檻比對後透過 `add_tool`/`remove_tool` 動態控制工具可見性；快取 5 分鐘。
- **Data Loader** (`loader/`)：負責將靜態術語資料與 FDA API 資料寫入 PostgreSQL。

## 設定與部署

- 應用程式執行設定放在 `.env`
- dataset 路徑設定放在 `config/datasets.yaml`
- 若未提供 `DATASETS_CONFIG`，loader 會回退到 `/app/fhir-code` 的舊目錄規則
- 容器化部署以 `compose.yaml` 為主
