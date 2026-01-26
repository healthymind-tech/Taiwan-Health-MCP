# 環境配置

本系統主要透過環境變數 (Environment Variables) 進行配置。

## 關鍵設定

| 變數名稱 | 預設值 | 說明 |
| :--- | :--- | :--- |
| `DATA_DIR` | `/app/data` | 資料檔案儲存路徑 (包含 Excel, SQLite) |
| `LOG_LEVEL` | `INFO` | 日誌層級 (`DEBUG`, `INFO`, `WARNING`, `ERROR`) |
| `HOST` | `0.0.0.0` | 監聽位址 |
| `PORT` | `8000` | 監聽埠號 |

## 資料目錄結構
`DATA_DIR` 指向的路徑應包含以下檔案結構（容器啟動時會自動檢查或生成部分檔案）：

```text
/data
├── icd10cm_pcs_xxxx.xlsx  (原始 ICD 資料)
├── drugs.db               (藥品資料庫 - 自動生成)
├── icd.db                 (ICD 資料庫 - 自動生成)
└── ...
```

## 調整記憶體限制
若在 Docker 中運行，建議透過資源限制參數保護宿主機：

```yaml
# docker-compose.yml
services:
  mcp-server:
    deploy:
      resources:
        limits:
          memory: 4G
```
