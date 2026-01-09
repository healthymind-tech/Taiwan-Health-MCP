# 專案結構

```text
.
├── data/                      # 資料儲存目錄 (Excel, SQLite, JSON)
├── docs/                      # MkDocs 文件原始碼
├── src/                       # Python 原始碼
│   ├── server.py              # 程式進入點 (Entry Point)，定義 MCP Tools
│   ├── icd_service.py         # ICD 核心邏輯
│   ├── drug_service.py        # 藥品核心邏輯
│   ├── fhir_*_service.py     # FHIR 轉換邏輯
│   ├── lab_service.py         # 檢驗邏輯
│   └── utils.py               # 共用工具函式 (Log, Config)
├── tests/                     # 測試程式碼
├── mkdocs.yml                 # 文件設定檔
├── requirements.txt           # Python 套件依賴
└── Dockerfile                 # 建置腳本
```

## 設計模式
本專案採用 **Service-Repository Pattern** 的變體：
- **Services** (`*_service.py`)：負責商業邏輯（如搜尋演算法、FHIR 轉換規則）。
- **Data Access**：直接在 Service 類別中處理 SQLite 連線（簡化設計，未完全拆分 Repository 層）。
- **MCP Layout** (`server.py`)：負責與 MCP 協定對接，處理輸入驗證與日誌，不包含複雜商業邏輯。
