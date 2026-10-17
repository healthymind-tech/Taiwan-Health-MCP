# 快速開始

## 前置需求

- Docker 與 Docker Compose
- （選用）一台可達的嵌入伺服器（預設為 Ollama，模型 `qwen3-embedding`），用於語意 / 混合搜尋。**端點在管理後台的「模型端點」頁（`/admin/models`）設定，不是環境變數**；未設定時，搜尋自動退回關鍵字模式。
- 部分資料來源需自行取得授權檔案（SNOMED CT、LOINC、ICD-10 zip 等），詳見[資料來源](data-sources/index.md)。

若要在本機開發（非 Docker），需要 **Node.js 20 以上**。本專案已無 Python 執行期相依。

## 啟動服務

```bash
cp .env.example .env                # 設定 POSTGRES_PASSWORD 等必要變數
docker compose up -d
```

`docker compose up -d` 會啟動：

| 服務 | 說明 |
|------|------|
| `nginx` | **單一對外入口**，預設 `:8080`（可用 `WEB_PORT` 調整） |
| `web-v2` | 管理後台 SPA（`web-v2/`，Vite + React + Mantine），由容器內 nginx 提供 |
| `app` | Node MCP 伺服器 + 管理後台 REST API（僅內部網路） |
| `admin-worker` | 背景工作執行器（所有匯入與嵌入工作） |
| `postgres` | PostgreSQL 16 + pgvector |
| `pgbouncer` | 連線池（transaction mode） |
| `redis` | 管理後台即時事件廣播與健康探測（工具回應目前不快取） |
| `minio` + `minio-init` | 藥品資產物件儲存與 bucket 初始化 |

!!! warning "所有流量都走 nginx"
    `app` 容器只在 compose 內部網路上開放 8000 埠（`expose`），**不會對主機發佈**。
    請一律使用 `http://<host>:8080`；`http://<host>:8000` 連不到本系統。

## 啟用管理後台

資料匯入由管理後台觸發、交由 `admin-worker` 背景執行（無獨立的 CLI data-loader 容器）。管理後台預設已啟用（`ADMIN_ENABLED=true`），只需在 `.env` 設好登入憑證與 session 金鑰：

```dotenv
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
# 產生密碼雜湊（Node）：
#   node -e "console.log('sha256$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
# ⚠️ 在 .env 中每個 $ 都要寫成 $$（Docker Compose 會把 $ 當變數展開，
#    雜湊值以字母開頭時會被靜默截斷）。Compose 會把 $$ 還原成單一 $。
ADMIN_PASSWORD_HASH=sha256$$...
# 或改用明文初始密碼（首次啟動時雜湊寫入資料庫）：ADMIN_INITIAL_PASSWORD=...
# 必須換掉 .env.example 的預設值，否則 app 會拒絕啟動：openssl rand -hex 32
ADMIN_SESSION_SECRET=<隨機值>
```

重新啟動後（`docker compose up -d`），於 `http://<host>:8080/admin` 登入。詳見[管理後台](admin/index.md)。

## 載入資料（管理後台各模組頁）

在側邊欄「資料」區（醫療術語、藥品、健康食品、食品營養）與「FHIR → IG 套件庫」依模組匯入：

| 類型 | 模組 | 操作 |
|------|------|------|
| 需上傳來源檔 | ICD-10-CM（CMS order file）/ PCS、LOINC、SNOMED CT、RxNorm、FHIR IG（`package.tgz`） | 於模組頁上傳來源檔後按匯入（IG 也可直接從 FHIR package registry 取得） |
| API 自動抓取 | 藥品（TFDA）、健康補充品、食品營養 | 直接按匯入，或設定排程 |

- **藥物域**為三階段管線（索引 → 爬取豐富 → OCR/LLM 分析）。爬取的 TFDA base URL 與 OCR（MinerU）端點在「外部服務」（`/admin/integrations`）設定；分析 LLM 則在「模型端點」（`/admin/models`）建立 provider 帳號與 profile。
- **嵌入**（語意搜尋）是各模組獨立的 `*_embed` 工作，可在模組頁面執行或排程。
- 匯入進度、步驟時間軸與即時日誌見 **背景工作**（`/admin/jobs`）頁；背景機制見[背景工作與排程](admin/jobs-and-worker.md)。

## 連線客戶端

兩種介面都經由 nginx 前門提供（預設 `:8080`）：

### 1. MCP（原生）

預設以 `streamable-http` 模式在 `http://<host>:8080/mcp` 提供服務。供原生 MCP 客戶端使用（Claude Desktop、Open WebUI v0.6.31+ 的 MCP 連線等）。

### 2. OpenAPI bridge（給只支援 OpenAPI 的客戶端）

對於不支援原生 MCP、只能接 OpenAPI 工具伺服器的客戶端（例如 **Open WebUI 的 External Tools / OpenAPI 類型**），伺服器內建一層 OpenAPI 介面，**不需額外的 mcpo 代理或容器**：

- `GET http://<host>:8080/openapi.json` — 依目前已啟用的工具動態產生 OpenAPI 3.1 規格
- `POST http://<host>:8080/tools/<工具名>` — 以 JSON body 當參數呼叫工具

在客戶端只要填基底網址 `http://<host>:8080`，它會自動抓 `/openapi.json` 並列出全部工具。

> 注意：`/mcp` 與 OpenAPI bridge 預設（`PUBLIC_TOOLS_AUTH_MODE=none`）**不驗證**；對外開放時請設 `PUBLIC_TOOLS_AUTH_MODE=bearer` 與高熵的 `PUBLIC_TOOLS_BEARER_TOKEN`，客戶端帶 `Authorization: Bearer <token>`。詳見[環境變數配置](deployment/configuration.md)。

## 驗證

確認服務與各模組狀態：

```bash
curl http://localhost:8080/openapi.json | head  # 目前已註冊的工具（依模組資料載入狀態變動）
```

各模組的資料筆數與服務健康狀態請看管理後台的「儀表板」與「服務健康」頁；所有工具（含未註冊者與其原因）可在「MCP 工具」頁（`/admin/mcp`）查看與試跑。

也可直接呼叫 `health_check` 工具：

```bash
curl -X POST http://localhost:8080/tools/health_check \
  -H 'Content-Type: application/json' -d '{}'
```

回應包含 DB / 快取 / 各模組狀態、伺服器 `version` 與 `build`（git sha）、`tools_version`、已載入的術語版本（`terminology`）、已安裝的 IG 套件與 `default_ig`。

程式碼層級的測試見[測試指南](development/testing.md)。
