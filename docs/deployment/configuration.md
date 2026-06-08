# 環境配置

系統透過環境變數進行配置。複製 `.env.example` 為 `.env` 後修改：

```bash
cp .env.example .env
```

---

## 完整環境變數清單

### PostgreSQL

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `POSTGRES_PASSWORD` | **必填** | PostgreSQL 密碼 |
| `POSTGRES_DB` | `taiwan_health` | 資料庫名稱 |
| `POSTGRES_USER` | `mcp` | 資料庫使用者 |

### MCP 傳輸

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `MCP_TRANSPORT` | `streamable-http` | 傳輸模式：`streamable-http` \| `stdio` |
| `MCP_HOST` | `0.0.0.0` | 監聽主機（HTTP 模式） |
| `MCP_PORT` | `8000` | 監聽埠號（HTTP 模式） |
| `MCP_PATH` | `/mcp` | HTTP 端點路徑（streamable-http 模式） |

### 資料庫連線（由 compose.yaml 自動組合）

| 變數 | 說明 |
|------|------|
| `DATABASE_URL` | App 連接 pgBouncer：`postgresql://mcp:{pass}@pgbouncer:5432/taiwan_health` |

> App 透過 pgBouncer（port 5432 內部）連線；`admin-worker` 在執行匯入時直接連接 PostgreSQL（`@postgres:5432`）以支援大量寫入。

### Redis

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `REDIS_URL` | `redis://redis:6379/0` | Redis 連線 URL |

### 監控

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `METRICS_PORT` | `9090` | Prometheus 指標端點埠號 |
| `LOG_LEVEL` | `INFO` | 日誌等級：`DEBUG` \| `INFO` \| `WARNING` \| `ERROR` |

---

## MCP 傳輸模式

### streamable-http（生產環境，推薦）

```env
MCP_TRANSPORT=streamable-http
MCP_HOST=0.0.0.0
MCP_PORT=8000
MCP_PATH=/mcp
```

Claude Desktop 連線設定：

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

### stdio（本地開發 / Claude Desktop 直接啟動）

```env
MCP_TRANSPORT=stdio
```

Claude Desktop 設定：

```json
{
  "mcpServers": {
    "taiwan-health": {
      "command": "python",
      "args": ["src/server.py"],
      "env": {
        "DATABASE_URL": "postgresql://mcp:pass@localhost:5432/taiwan_health",
        "REDIS_URL": "redis://localhost:6379/0",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

---

## .env.example 完整範本

```env
# ── PostgreSQL ─────────────────────────────────────────────────
POSTGRES_DB=taiwan_health
POSTGRES_USER=mcp
POSTGRES_PASSWORD=change_me_please

# ── MCP Server ─────────────────────────────────────────────────
MCP_TRANSPORT=streamable-http
MCP_HOST=0.0.0.0
MCP_PORT=8000
MCP_PATH=/mcp

# ── Monitoring ─────────────────────────────────────────────────
LOG_LEVEL=INFO
METRICS_PORT=9090
```

---

## 資源限制建議（生產環境）

在 `docker-compose.override.yml` 加入資源限制：

```yaml
services:
  app:
    deploy:
      resources:
        limits:
          memory: 2G
  postgres:
    deploy:
      resources:
        limits:
          memory: 4G
  redis:
    deploy:
      resources:
        limits:
          memory: 512M
```

---

## pgBouncer 進階設定

pgBouncer 透過 `edoburu/pgbouncer` image 的環境變數設定，重要參數（見 `compose.yaml`）：

| 參數 | 值 | 說明 |
|------|-----|------|
| `POOL_MODE` | `transaction` | 每次查詢後釋放連線（最高效率） |
| `MAX_CLIENT_CONN` | `500` | 最多 500 個客戶端連線 |
| `DEFAULT_POOL_SIZE` | `30` | 最多 30 個 PostgreSQL 連線 |
| `MIN_POOL_SIZE` | `5` | 預熱連線數 |
| `AUTH_TYPE` | `scram-sha-256` | 安全驗證方式 |
| `IGNORE_STARTUP_PARAMETERS` | `extra_float_digits` | asyncpg 相容性設定 |
