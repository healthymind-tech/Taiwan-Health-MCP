# 監控與日誌

---

## Prometheus 指標

Prometheus 指標端點預設在 `http://localhost:9090/metrics`，由 app 容器在非 stdio 模式啟動時自動開啟。

### 可用指標

| 指標名稱 | 類型 | 標籤 | 說明 |
|---------|------|------|------|
| `mcp_tool_requests_total` | Counter | `tool`, `status` | 工具呼叫總次數（status: success/error） |
| `mcp_tool_duration_seconds` | Histogram | `tool` | 工具執行延遲（buckets: 10ms ~ 10s） |
| `mcp_cache_operations_total` | Counter | `prefix`, `result` | 快取操作（result: hit/miss/error） |
| `mcp_db_pool_size` | Gauge | — | asyncpg pool 總連線數 |
| `mcp_db_pool_checked_out` | Gauge | — | 目前使用中的連線數 |

### 查詢範例

```bash
# 工具呼叫統計
curl -s http://localhost:9090/metrics | grep mcp_tool_requests

# 平均延遲（各工具）
curl -s http://localhost:9090/metrics | grep mcp_tool_duration

# 快取命中率
curl -s http://localhost:9090/metrics | grep mcp_cache

# DB pool 使用率
curl -s http://localhost:9090/metrics | grep mcp_db_pool
```

---

## 結構化日誌

App 輸出 JSON 格式日誌至 **stderr**（stdout 保留給 MCP stdio transport）。

### 日誌格式

每行一個 JSON 物件：

```json
{
  "ts": "2026-04-08T03:04:29",
  "level": "INFO",
  "logger": "taiwan_health_mcp",
  "msg": "Drug DB sync completed",
  "licenses": 66266,
  "taskName": "Task-15"
}
```

### 查看日誌

```bash
# 即時追蹤 app 日誌
docker compose logs -f app

# 篩選特定等級
docker compose logs app 2>&1 | grep '"level": "ERROR"'

# 篩選特定服務
docker compose logs app 2>&1 | grep "Drug DB"

# 查看所有服務日誌
docker compose logs -f
```

### 日誌等級

透過 `LOG_LEVEL` 環境變數設定：

| 等級 | 說明 |
|------|------|
| `DEBUG` | 詳細除錯資訊 |
| `INFO` | 正常操作訊息（預設） |
| `WARNING` | 非致命異常 |
| `ERROR` | 服務初始化失敗、同步失敗 |

---

## 稽核日誌

所有工具呼叫都會被 `@audited` 裝飾器記錄到 PostgreSQL `audit.query_log` 表：

```sql
-- 查看最近 20 筆工具呼叫
SELECT tool_name, status, duration_ms, params_hash, called_at
FROM audit.query_log
ORDER BY called_at DESC
LIMIT 20;

-- 各工具呼叫統計
SELECT tool_name, COUNT(*), AVG(duration_ms)
FROM audit.query_log
GROUP BY tool_name
ORDER BY COUNT(*) DESC;
```

> 注意：`params_hash` 為 SHA-256(params)，絕不儲存原始參數值（HIPAA 合規）。

---

## 健康檢查

### MCP health_check 工具

```bash
SESSION=$(curl -si http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":"2024-11-05","capabilities":{},
    "clientInfo":{"name":"monitor","version":"1"}
  }}' | grep mcp-session-id | awk '{print $2}' | tr -d '\r')

curl -s http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"health_check","arguments":{}}}'
```

回應示例（全部正常）：

```json
{
  "status": "ok",
  "database": "ok",
  "cache": "ok",
  "services": {
    "icd": true, "drug": true, "health_supplement": true,
    "food_nutrition": true, "fhir_condition": true,
    "fhir_medication": true, "lab": true, "guideline": true,
    "twcore": true, "snomed": true
  }
}
```

### Docker 容器狀態

```bash
# 查看所有容器健康狀態
docker compose ps

# PostgreSQL 健康檢查
docker exec taiwanHealthMcp_postgres pg_isready -U mcp -d taiwan_health

# Redis 健康檢查
docker exec taiwanHealthMcp_redis redis-cli ping

# pgBouncer 連線狀態
docker exec taiwanHealthMcp_pgbouncer nc -z 127.0.0.1 5432 && echo "OK"
```

### 資料庫資料量確認

```bash
docker exec taiwanHealthMcp_postgres psql -U mcp -d taiwan_health -c "
SELECT schemaname, tablename, n_live_tup AS rows
FROM pg_stat_user_tables
WHERE n_live_tup > 0
ORDER BY n_live_tup DESC;"
```

---

## 常見問題排查

### Drug DB sync failed - duplicate key

FDA 原始資料含重複 `license_id`。v2+ 版本已在寫入前自動去重（`seen_ids` set），此錯誤不應再出現。若仍出現，請確認使用最新版本的 `drug_service.py`。

### Prometheus port already in use

`mcp` SDK 在 streamable-http 模式下對每個 session 執行 lifespan。`metrics.start_metrics_server()` 已加入 `_metrics_server_started` flag 防止重複綁定。若仍出現此錯誤，請更新 `src/metrics.py`。

### 服務顯示 false

對應術語資料未載入。執行相應的 data-loader 指令後重啟 app：

```bash
docker compose --profile loader run --rm data-loader --snomed
docker compose restart app
```
