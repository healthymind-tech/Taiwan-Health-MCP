# 快速開始

本指南帶您快速部署 Taiwan Health MCP Server。

---

## 📋 系統需求

| 項目 | 最低需求 | 建議規格 |
|------|---------|---------|
| Docker Engine | 24+ | 最新穩定版 |
| Docker Compose | v2+ | — |
| RAM | 4 GB | 8 GB（載入 SNOMED CT 時） |
| 磁碟空間 | 10 GB | 20 GB（含完整術語資料） |
| 作業系統 | Linux / macOS / Windows (WSL2) | Linux |

---

## 🚀 部署步驟

### 步驟 1 — Clone 專案

```bash
git clone https://github.com/healthymind-tech/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
```

### 步驟 2 — 設定環境變數

```bash
cp .env.example .env
cp config/datasets.example.yaml config/datasets.yaml
```

編輯 `.env`：

```env
# 必填
POSTGRES_PASSWORD=your_secure_password

# 可選（以下為預設值）
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

### 步驟 3 — 啟動服務

```bash
docker compose up -d
```

啟動後確認所有容器狀態：

```bash
docker compose ps
```

正常輸出：

```
NAME                          STATUS
taiwanHealthMcp_postgres      healthy
taiwanHealthMcp_pgbouncer     healthy
taiwanHealthMcp_redis         healthy
taiwanHealthMcp               running
```

### 步驟 4 — 載入術語資料（可選但建議）

FDA 藥品、健康食品、營養資料可透過 `data-loader --fda` 預先初始化；若未預先載入，MCP server 在**首次收到連線時**也會自動從 FDA API 同步。

其他術語資料（ICD-10、LOINC、SNOMED CT、RxNorm、TWCore IG、臨床指引）需要：

1. 複製並編輯 `config/datasets.yaml`
2. 從官方來源申請並下載原始資料，並在 `config/datasets.yaml` 指定實際檔案位置
2. 執行 data-loader：

> 注意：SNOMED CT、RxNorm、UMLS 等授權資料不得提交到 git，也不得以 Google Drive 或其他鏡像方式散佈。

```bash
# 全部載入
docker compose --profile loader run --rm data-loader --all

# 或只載入 FDA 動態資料
docker compose --profile loader run --rm data-loader --fda
docker compose --profile loader run --rm data-loader --drug
docker compose --profile loader run --rm data-loader --health-food
docker compose --profile loader run --rm data-loader --food-nutrition

# 或按需載入
docker compose --profile loader run --rm data-loader --icd
docker compose --profile loader run --rm data-loader --loinc
docker compose --profile loader run --rm data-loader --twcore
docker compose --profile loader run --rm data-loader --guideline
docker compose --profile loader run --rm data-loader --snomed    # 需 5-15 分鐘
docker compose --profile loader run --rm data-loader --rxnorm
```

若未設定 `DATASETS_CONFIG`，loader 仍會回退到舊的 `FHIR_CODE_DIR` 目錄規則；新部署建議使用 `config/datasets.yaml`。

### 步驟 5 — 驗證服務

```bash
# 建立 MCP session
SESSION=$(curl -si http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":"2024-11-05",
    "capabilities":{},
    "clientInfo":{"name":"test","version":"1"}
  }}' | grep mcp-session-id | awk '{print $2}' | tr -d '\r')

# 呼叫 health_check 工具
curl http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
    "name":"health_check","arguments":{}
  }}'
```

正常回應：

```json
{
  "status": "ok",
  "database": "ok",
  "cache": "ok",
  "services": {
    "icd": true, "drug": true, "health_food": true,
    "food_nutrition": true, "fhir_condition": true, "fhir_medication": true,
    "lab": true, "guideline": true, "twcore": true,
    "snomed": true, "drug_interactions": true
  }
}
```

---

## 🔌 連接 Claude Desktop

在 `claude_desktop_config.json` 加入以下設定：

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

儲存後重啟 Claude Desktop，即可在對話中使用所有 56 個醫療工具。

---

## 🛠️ 本地開發模式

若不使用 Docker，需要本地安裝 PostgreSQL 16 和 Redis 7：

```bash
# 安裝相依套件
pip install -r requirements.txt

# 設定環境變數
export DATABASE_URL=postgresql://mcp:pass@localhost:5432/taiwan_health
export REDIS_URL=redis://localhost:6379/0

# STDIO 模式
python src/server.py

# HTTP 模式
MCP_TRANSPORT=streamable-http python src/server.py
```

---

## 📊 監控

Prometheus 指標端點：`http://localhost:9090/metrics`

```bash
# 查看 MCP 工具呼叫統計
curl -s http://localhost:9090/metrics | grep mcp_tool

# 查看快取命中率
curl -s http://localhost:9090/metrics | grep mcp_cache
```

---

## ❓ 常見問題

**Q: FDA 資料什麼時候同步？**
A: 首次 MCP session 連線時若資料為空或過期（>7天）會自動觸發同步。排程：藥品每週二 02:00 UTC，健康食品和營養每週一 02:30/03:00 UTC。

**Q: SNOMED CT 和 RxNorm 工具回傳「service not available」？**
A: 這些資料集需要手動下載並執行 data-loader。詳見 `fhir-code/README.md`。

**Q: 如何知道術語資料是否載入成功？**
A: 執行 `health_check` 工具，確認對應服務的值為 `true`。也可直接查詢 PostgreSQL：
```bash
docker exec taiwanHealthMcp_postgres psql -U mcp -d taiwan_health \
  -c "SELECT schemaname, tablename, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 20;"
```

**Q: 可以只使用部分功能嗎？**
A: 是的。未載入資料的服務會優雅降級，回傳說明性錯誤訊息，不影響其他工具。
