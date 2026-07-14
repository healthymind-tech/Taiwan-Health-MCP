# 環境配置

系統透過環境變數與資料庫設定（`admin.app_settings` / `admin.llm_profiles`）兩層來配置。複製 `.env.example` 為 `.env` 後修改：

```bash
cp .env.example .env
```

## 設定優先序（重要）

| 類別 | 存放位置 | 說明 |
|------|----------|------|
| **Bootstrap 變數** | 只在 `.env` | DB / Redis / MCP transport / `ADMIN_*` 認證 / `WEB_PORT`。系統啟動前就要知道，不進資料庫。 |
| **Seed-only 設定** | `.env` → `admin.app_settings` | MinIO、TFDA 爬蟲、worker 調校等。**只在首次啟動、資料表為空時讀取一次**以種子化；之後請在 Admin → Settings 管理（支援熱套用）。編輯 `.env` 對已種子化的資料庫無效。 |
| **模型端點** | 只在資料庫（`admin.llm_profiles`） | 嵌入、OCR（MinerU）、分析 LLM。**完全不從環境變數讀取**，只能在 Admin → Settings 設定，可用 Settings → Export / Import 在不同環境間搬移。 |

---

## Bootstrap 變數（`.env`）

### 對外埠

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `WEB_PORT` | `8080` | **nginx 前門對主機發佈的埠**。這是系統唯一的對外入口。 |

> `app` 容器只在內部網路 `expose` `MCP_PORT`（8000），不對主機發佈。客戶端一律連 `http://<host>:${WEB_PORT}`。

### PostgreSQL

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `POSTGRES_PASSWORD` | **必填** | PostgreSQL 密碼（未設定時 compose 會直接失敗） |
| `POSTGRES_DB` | `taiwan_health` | 資料庫名稱 |
| `POSTGRES_USER` | `mcp` | 資料庫使用者 |
| `DATABASE_URL` | 由 compose 組出 | `postgresql://<user>:<pass>@pgbouncer:5432/<db>`。只有在 Docker 外執行時才需手動設定。 |

### Redis

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `REDIS_URL` | `redis://redis:6379/0`（compose 設定；程式預設 `redis://localhost:6379/0`） | Redis 連線 URL |

### MCP 傳輸

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `MCP_TRANSPORT` | `streamable-http`（compose）；程式預設 `stdio` | `streamable-http` \| `sse` \| `stdio` |
| `MCP_HOST` | `0.0.0.0` | 監聽主機（HTTP 模式） |
| `MCP_PORT` | `8000` | **容器內部**監聽埠。不對主機發佈。 |
| `MCP_PATH` | `/mcp` | HTTP 端點路徑 |
| `PUBLIC_TOOLS_AUTH_MODE` | `none` | 公開 MCP/OpenAPI bridge 驗證模式：`none` 或 `bearer`。正式環境建議使用 `bearer`。 |
| `PUBLIC_TOOLS_BEARER_TOKEN` | 空 | bearer 模式必要的 token；應使用高熵隨機值。 |
| `PUBLIC_TOOLS_CORS_ORIGINS` | 空 | 允許的瀏覽器 origin（逗號分隔）。bearer 模式不可使用 `*`；空值代表不允許跨來源瀏覽器呼叫。 |

### 應用與監控

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `LOG_LEVEL` | `INFO` | `DEBUG` \| `INFO` \| `WARNING` \| `ERROR` |
| `METRICS_PORT` | `9090` | Prometheus 指標端點（僅綁 `127.0.0.1`） |

### 管理後台認證

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `ADMIN_ENABLED` | `false` | 設 `true` 才會掛載 `/admin` |
| `ADMIN_USERNAME` | `admin` | 操作者帳號 |
| `ADMIN_PASSWORD_HASH` | 空 | `sha256$<hex>` 或 `pbkdf2_sha256$<iterations>$<salt>$<hex>` |
| `ADMIN_SESSION_SECRET` | 空 | session cookie 簽章金鑰 |
| `ADMIN_SESSION_TTL_MINUTES` | `240` | session 有效期 |
| `ADMIN_COOKIE_SECURE` | 空（自動） | `true` / `false`。空值時，`PUBLIC_BASE_URL` 使用 HTTPS 就加入 cookie `Secure` 屬性。TLS 在外部 proxy 終止且未設定 public URL 時應明確設為 `true`。 |
| `ADMIN_MAX_UPLOAD_MB` | `512` | 來源檔上傳上限 |
| `FHIR_SERVER_SECRET_KEY` | 空（回退為 `ADMIN_SESSION_SECRET`） | 外部 FHIR 伺服器 OAuth token / client secret 的 pgcrypto 對稱金鑰。**`app` 與 `admin-worker` 必須一致**，否則 worker 解密會拋 `Illegal argument to function`（金鑰為空）或 `Wrong key or corrupt data`（金鑰不符）。 |

`ADMIN_ENABLED` / `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET` 四者齊備，`/admin` 才會開放。

產生密碼雜湊（Node）：

```bash
node -e "console.log('sha256$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
```

!!! warning "`.env` 中的 `$` 要寫成 `$$`"
    Docker Compose 會對 `.env` 做變數展開，單一 `$` 會被當成變數參照，
    導致雜湊值（尤其開頭是字母時）被靜默截斷。請把每個 `$` 都寫成 `$$`，
    Compose 會還原成單一 `$`。

### Passkey / WebAuthn（選用）

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `PUBLIC_BASE_URL` | 空 | 對外 origin（`scheme://host`），用於組出 OAuth2 redirect_uri，並作為 WebAuthn RP ID 的推導來源。空值時由請求的 `Host` 標頭推導。 |
| `WEBAUTHN_RP_ID` | `PUBLIC_BASE_URL` 的 host，再回退至 `taiwan-health-mcp.gugulu.tw` | 管理後台所在的可註冊網域 |
| `WEBAUTHN_RP_NAME` | `Taiwan Health MCP — Admin` | OS passkey 提示中顯示的名稱 |
| `WEBAUTHN_ORIGIN` | `https://<WEBAUTHN_RP_ID>` | 允許的 origin 清單（逗號分隔） |

`compose.yaml` 會將這四個變數傳入 `app`。正式部署至少應設定
`PUBLIC_BASE_URL`；只有需要覆寫自動推導值時才設定 `WEBAUTHN_*`。

---

## Seed-only 設定（首次啟動後改於 Admin → Settings）

### MinIO（藥品資產）

| 變數 | 預設值 |
|------|--------|
| `MINIO_ENDPOINT` | `minio:9000`（Docker 外請用 `localhost:9000`） |
| `MINIO_ACCESS_KEY` | `minioadmin` |
| `MINIO_SECRET_KEY` | `minioadmin` |
| `MINIO_BUCKET` | `taiwan-health-drug-assets` |
| `MINIO_SECURE` | `false` |
| `MINIO_PRESIGN_TTL_SECONDS` | `3600` |

### 藥品 / TFDA 爬蟲

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `DRUG_TFDA_BASE_URL` | `https://mcp.fda.gov.tw` | TFDA 網站 base URL |
| `DRUG_HTTP_TIMEOUT` | `30` | 單次 HTTP 逾時（秒） |
| `DRUG_CRAWLER_CONCURRENCY` | `4` | 爬蟲並行度 |
| `DRUG_AUTOCHAIN_BATCH_LIMIT` | `200` | 自動串接（index → enrichment → analysis）時，每個後續工作處理的授權證上限。**只作用於自動串接產生的工作**；手動排入的工作若沒帶 `limit`，會處理整個待辦佇列。 |
| `DRUG_ANALYSIS_PROMPT_PATH` | `src/prompts/drug/analysis_prompt.txt` | 分析 LLM 的 system prompt 路徑 |

### 背景 worker 調校

| 變數 | 預設值（程式） | 說明 |
|------|--------|------|
| `ADMIN_WORKER_NAME` | `admin-worker` | worker 識別名稱（心跳與工作認領用） |
| `ADMIN_WORKER_POLL_SECONDS` | `3` | 佇列輪詢間隔 |
| `ADMIN_HEARTBEAT_INTERVAL_SECONDS` | `15` | 心跳間隔 |
| `ADMIN_WORKER_STALE_AFTER_SECONDS` | `45` | 超過此秒數無心跳即視為失聯 |
| `ADMIN_MAX_CONCURRENT_JOBS` | `4` | 同時執行的工作數上限（另有各模組資源槽位限制） |
| `ADMIN_SCHEDULE_SCAN_INTERVAL_SECONDS` | `60` | 排程掃描間隔 |
| `NODE_OPTIONS` | `--max-old-space-size=8192`（compose 設定於 worker） | IG 匯入會整包載入相依套件，**不要調低**。 |

### 本機開發用的來源檔路徑

生產環境的來源檔由管理後台上傳至 MinIO；下列變數只在本機直接執行 loader 時用來指定檔案位置。

| 變數 | 預設值 |
|------|--------|
| `FHIR_CODE_DIR` | `<repo>/fhir-code` |
| `ICD_CM_ZIP` / `ICD_PCS_ZIP` / `ICD_XLSX` | `fhir-code/icd/10/...` 下的對應檔 |
| `LOINC_ZIP_PATH` | `fhir-code/loinc/2.80/Loinc_2.80.zip` |
| `LOINC_MAPPING_CSV` / `LOINC_RANGES_CSV` | `data/loinc/` 下的對照表 |
| `SNOMED_ZIP` | `fhir-code/snomed/SnomedCT_InternationalRF2_PRODUCTION_*.zip` |
| `RXNORM_ZIP` | `fhir-code/rxnorm/RxNorm_full_*.zip` |
| `IG_TGZ` | `fhir-code/twcoreig/**/package.tgz` |

---

## MCP 客戶端設定

### streamable-http（生產環境，推薦）

Claude Desktop：

```json
{
  "mcpServers": {
    "taiwan-health": {
      "url": "http://<host>:8080/mcp",
      "transport": "streamable-http"
    }
  }
}
```

### stdio（本機直接啟動行程）

需先在 `node-server/` 執行 `npm install && npm run build`：

```json
{
  "mcpServers": {
    "taiwan-health": {
      "command": "node",
      "args": ["/absolute/path/to/node-server/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "DATABASE_URL": "postgresql://mcp:pass@localhost:5432/taiwan_health",
        "REDIS_URL": "redis://localhost:6379/0"
      }
    }
  }
}
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
  admin-worker:
    deploy:
      resources:
        limits:
          memory: 10G     # IG 匯入需要，配合 NODE_OPTIONS=--max-old-space-size=8192
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
| `POOL_MODE` | `transaction` | 每次交易後釋放連線 |
| `MAX_CLIENT_CONN` | `500` | 最多 500 個客戶端連線 |
| `DEFAULT_POOL_SIZE` | `30` | 最多 30 個 PostgreSQL 連線 |
| `MIN_POOL_SIZE` | `5` | 預熱連線數 |
| `AUTH_TYPE` | `scram-sha-256` | 驗證方式 |
| `IGNORE_STARTUP_PARAMETERS` | `extra_float_digits` | 驅動相容性設定 |
