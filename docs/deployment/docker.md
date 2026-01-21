# Docker 部署 (推薦)

## 前置需求
- 已安裝 [Docker Desktop](https://www.docker.com/products/docker-desktop) 或 Docker Engine。
- 建議預留至少 2GB RAM 給容器使用（因需載入大量 ICD 與藥品資料）。

## 快速啟動

### 1. 準備環境配置

複製 `.env.example` 為 `.env` 並根據需求調整：

```bash
cp .env.example .env
```

**生產環境建議配置（HTTP 模式）：**

```env
# .env
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_PORT=8000
MCP_PATH=/mcp
```

**本地開發配置（STDIO 模式）：**

```env
# .env
MCP_TRANSPORT=stdio
```

### 2. 使用 Docker Compose（推薦）

專案根目錄已包含 `docker-compose.yml`，支援環境變數配置：

```bash
# 啟動服務（使用 .env 檔案）
docker-compose up -d

# 查看日誌
docker-compose logs -f

# 停止服務
docker-compose down
```

Docker Compose 會自動：
- 讀取 `.env` 檔案的配置
- 掛載 `./data` 和 `./src` 目錄
- 根據 `MCP_PORT` 動態映射埠號

### 3. 手動建置與執行

如果您需要自行建置映像檔：

```bash
# 建置映像檔
docker build -t taiwan-health-mcp .

# 執行容器（HTTP 模式）
docker run -d \
  --name health-mcp \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/src:/app/src \
  -p 8000:8000 \
  -e MCP_TRANSPORT=http \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PORT=8000 \
  -e MCP_PATH=/mcp \
  taiwan-health-mcp
```

## 傳輸模式說明

系統支援三種 MCP 傳輸模式：

| 模式 | 適用場景 | 連線方式 |
| :--- | :--- | :--- |
| **http** ✨ | Docker 生產部署 | `http://localhost:8000/mcp` |
| **stdio** | Claude Desktop 本地整合 | 標準輸入輸出 |
| **sse** | Colab + Ngrok（向後相容） | `http://localhost:8000/sse` |

## 驗證部署

### 檢查容器狀態
```bash
docker ps | grep taiwan-health-mcp
```

### 查看啟動日誌
```bash
docker logs -f taiwanHealthMcp
```

成功啟動時會顯示：

```
==================================================
Taiwan Health MCP Server
==================================================
Transport: http | http://0.0.0.0:8000/mcp
Server is starting...
```

### 測試連線（HTTP 模式）
```bash
curl http://localhost:8000/mcp
```
