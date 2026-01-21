# 環境配置

本系統主要透過環境變數 (Environment Variables) 進行配置。

## 快速開始

專案根目錄提供了 `.env.example` 範本檔案，請複製並修改：

```bash
cp .env.example .env
```

然後根據您的部署環境編輯 `.env` 檔案。

## MCP 傳輸模式配置

系統支援三種 MCP 傳輸模式，透過 `MCP_TRANSPORT` 環境變數設定：

### stdio 模式（本地開發）
適用於 Claude Desktop 等本地整合環境：

```bash
MCP_TRANSPORT=stdio
```

### http 模式（生產部署）✨ 推薦
適用於 Docker 生產環境，使用 Streamable HTTP 協定：

```bash
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_PORT=8000
MCP_PATH=/mcp
```

連線 URL：`http://localhost:8000/mcp`

### sse 模式（向後相容）
適用於 Colab + Ngrok 等場景，使用 Server-Sent Events：

```bash
MCP_TRANSPORT=sse
MCP_HOST=0.0.0.0
MCP_PORT=8000
```

連線 URL：`http://localhost:8000/sse`

## 完整環境變數清單

### MCP 傳輸配置

| 變數名稱 | 預設值 | 說明 |
| :--- | :--- | :--- |
| `MCP_TRANSPORT` | `stdio` | 傳輸模式：`stdio` \| `http` \| `sse` |
| `MCP_HOST` | `0.0.0.0` | 監聽主機（僅 http/sse 模式） |
| `MCP_PORT` | `8000` | 監聽埠號（僅 http/sse 模式） |
| `MCP_PATH` | `/mcp` | HTTP 端點路徑（僅 http 模式） |

### 系統配置

| 變數名稱 | 預設值 | 說明 |
| :--- | :--- | :--- |
| `DATA_DIR` | `/app/data` | 資料檔案儲存路徑 (包含 Excel, SQLite) |
| `LOG_LEVEL` | `INFO` | 日誌層級 (`DEBUG`, `INFO`, `WARNING`, `ERROR`) |

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
