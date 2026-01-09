# Docker 部署 (推薦)

## 前置需求
- 已安裝 [Docker Desktop](https://www.docker.com/products/docker-desktop) 或 Docker Engine。
- 建議預留至少 2GB RAM 給容器使用（因需載入大量 ICD 與藥品資料）。

## 快速啟動

### 1. 取得映像檔
您可以直接從 GitHub Container Registry 拉取，或自行建置。

```bash
# 自行建置
git clone https://github.com/audi0417/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
docker build -t taiwan-health-mcp .
```

### 2. 準備資料卷 (Data Volume)
為了持久化儲存 SQLite 資料庫，建議掛載本地目錄。

```bash
mkdir -p ./data
```

### 3. 執行容器
```bash
docker run -d \
  --name health-mcp \
  -v $(pwd)/data:/app/data \
  -p 8000:8000 \
  -e LOG_LEVEL=INFO \
  taiwan-health-mcp
```

## Docker Compose
專案根目錄已包含 `docker-compose.yml`，可直接使用：

```bash
docker-compose up -d
```

## 驗證部署
檢查容器日誌以確認服務已成功初始化：

```bash
docker logs -f health-mcp
```

若看到 `MCP Server initialized successfully` 字樣，即代表服務運作正常。
