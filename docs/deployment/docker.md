# Docker 部署指南

## 前置需求

- Docker Engine 24+ 和 Docker Compose v2
- 至少 4 GB 可用 RAM（SNOMED CT 載入期間需更多）
- 至少 10 GB 磁碟空間（含術語資料）

---

## 快速啟動

### 1. 準備環境配置

```bash
cp .env.example .env
cp config/datasets.example.yaml config/datasets.yaml
```

編輯 `.env`，**必要**欄位：

```env
# 必填 — 資料庫密碼
POSTGRES_PASSWORD=your_secure_password_here

# 可選 — 以下為預設值
POSTGRES_DB=taiwan_health
POSTGRES_USER=mcp
MCP_TRANSPORT=streamable-http
MCP_HOST=0.0.0.0
MCP_PORT=8000
MCP_PATH=/mcp
LOG_LEVEL=INFO
METRICS_PORT=9090
DATASETS_CONFIG=/app/config/datasets.yaml
```

編輯 `config/datasets.yaml`，將 ICD、LOINC、TWCore、SNOMED CT、RxNorm 等資料集
指向您的實際掛載路徑。若未設定 `DATASETS_CONFIG`，loader 仍會回退到舊的
`/app/fhir-code` 目錄慣例。

### 2. 啟動所有服務

```bash
docker compose up -d
```

這會啟動以下容器：

| 容器 | 說明 |
|------|------|
| `taiwanHealthMcp_postgres` | PostgreSQL 16 資料庫 |
| `taiwanHealthMcp_pgbouncer` | pgBouncer 連線池 |
| `taiwanHealthMcp_redis` | Redis 快取 |
| `taiwanHealthMcp` | MCP Server（app） |

### 3. 確認服務狀態

```bash
docker compose ps
# 所有服務應顯示 "healthy" 或 "running"

docker compose logs -f app
# 查看 MCP server 日誌
```

### 4. 載入術語資料

FDA 藥品、健康食品、營養資料可透過 `data-loader --fda` 預先初始化；若未預先載入，app 在首次啟動或資料過期時也會自動從 FDA Open Data API 同步。

其他術語資料（ICD、LOINC、SNOMED CT 等）需要先從官方來源合法取得，再於
`config/datasets.yaml` 指定原始檔案位置後執行 data-loader：

```bash
# 編輯 config/datasets.yaml 後執行

# 全部載入（建議首次部署）
docker compose --profile loader run --rm data-loader --all

# 或只載入 FDA 動態資料
docker compose --profile loader run --rm data-loader --fda
docker compose --profile loader run --rm data-loader --drug
docker compose --profile loader run --rm data-loader --health-food
docker compose --profile loader run --rm data-loader --food-nutrition

# 或單獨載入
docker compose --profile loader run --rm data-loader --icd
docker compose --profile loader run --rm data-loader --loinc
docker compose --profile loader run --rm data-loader --twcore
docker compose --profile loader run --rm data-loader --guideline
docker compose --profile loader run --rm data-loader --snomed    # 約 5-15 分鐘
docker compose --profile loader run --rm data-loader --rxnorm    # 約 5-10 分鐘
```

> 注意：受授權限制的 SNOMED CT、RxNorm、UMLS 原始檔不得提交至 git，也不得在文件中提供 Google Drive 或其他鏡像下載點。
> `config/datasets.yaml` 為本機部署檔案，建議自行維護，不納入版控。

---

## 服務架構說明

### pgBouncer（連線池）

```yaml
POOL_MODE: transaction          # asyncpg 需設定 statement_cache_size=0
MAX_CLIENT_CONN: 500            # 最多 500 個 MCP 客戶端連線
DEFAULT_POOL_SIZE: 30           # 最多 30 個 PostgreSQL 連線
AUTH_TYPE: scram-sha-256        # 安全驗證
```

App 連接 pgBouncer（`@pgbouncer:5432`），data-loader 直接連接 PostgreSQL（`@postgres:5432`）以支援大量寫入。

### Redis（快取）

```yaml
maxmemory: 512mb
maxmemory-policy: allkeys-lru   # LRU 淘汰策略
```

Redis 快取所有工具的查詢回應，大幅提升重複查詢的效能。

### Prometheus（監控）

Prometheus 指標端點預設在 `http://localhost:9090/metrics`，提供：
- 工具呼叫次數與延遲
- 快取命中率
- DB pool 使用率

---

## 連接 Claude Desktop

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

### STDIO 模式（本地直接執行）

若要以 stdio 模式搭配 Claude Desktop 使用：

```json
{
  "mcpServers": {
    "taiwan-health": {
      "command": "docker",
      "args": [
        "compose", "-f", "/path/to/Taiwan-Health-MCP/compose.yaml",
        "run", "--rm", "-e", "MCP_TRANSPORT=stdio", "app"
      ]
    }
  }
}
```

---

## 資料持久化

Docker volumes：

| Volume | 內容 |
|--------|------|
| `postgres_data` | PostgreSQL 資料（術語資料庫） |
| `redis_data` | Redis 持久化資料 |

```bash
# 清除所有資料（謹慎操作）
docker compose down -v
```

---

## 常用操作

```bash
# 重啟 app（不影響資料庫）
docker compose restart app

# 重建映像
docker compose build app
docker compose up -d app

# 查看即時日誌
docker compose logs -f app

# 進入 PostgreSQL
docker exec -it taiwanHealthMcp_postgres \
  psql -U mcp -d taiwan_health

# 手動觸發藥品同步（不需重啟）
# 等待下次排程（週二 02:00 UTC）或重啟 app 觸發 stale 檢查

# 停止所有服務
docker compose down

# 停止並刪除 volumes（資料將遺失）
docker compose down -v
```

---

## 故障排除

### App 無法連接資料庫

```bash
# 確認 pgBouncer 健康狀態
docker compose ps pgbouncer

# 確認環境變數
docker compose exec app env | grep DATABASE_URL
```

### 術語資料未載入

```bash
# 確認 config/datasets.yaml 指向的檔案存在
cat config/datasets.yaml

# 重新執行 loader
docker compose --profile loader run --rm data-loader --icd
```

### 健康檢查失敗

```bash
# 建立 session 並呼叫 health_check 工具
SESSION=$(curl -si http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  | grep mcp-session-id | awk '{print $2}' | tr -d '\r')

curl http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"health_check","arguments":{}}}'
```

### Prometheus 指標

```bash
curl http://localhost:9090/metrics | grep mcp_
```
