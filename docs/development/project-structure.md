# 專案結構

```text
.
├── src/                        # MCP server 與所有 service 模組
│   ├── server.py               # 入口點，註冊 56 個 MCP 工具
│   ├── *_service.py            # ICD / Drug / Lab / Guideline / SNOMED / TWCore 等服務
│   ├── database.py             # asyncpg pool 單例
│   ├── cache.py                # Redis 快取裝飾器
│   ├── audit.py                # 稽核日誌裝飾器
│   ├── metrics.py              # Prometheus 指標
│   └── utils.py                # 結構化日誌與共用工具
├── loader/                     # data-loader 入口與各資料載入器
│   ├── main.py                 # CLI：--all / --icd / --fda / --snomed ...
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
├── db/                         # PostgreSQL schema 與 seed SQL
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
- **MCP Entry** (`src/server.py`)：負責註冊工具、初始化服務、管理 transport 與 HTTP 錯誤 logging。
- **Data Loader** (`loader/`)：負責將靜態術語資料與 FDA API 資料寫入 PostgreSQL。

## 設定與部署

- 應用程式執行設定放在 `.env`
- dataset 路徑設定放在 `config/datasets.yaml`
- 若未提供 `DATASETS_CONFIG`，loader 會回退到 `/app/fhir-code` 的舊目錄規則
- 容器化部署以 `compose.yaml` 為主
