# 快速開始

## 前置需求

- Docker 與 Docker Compose
- （選用）一台可達的 Ollama 伺服器，用於語意 / 混合搜尋（`OLLAMA_BASE_URL`）。未設定時，搜尋自動退回關鍵字模式。
- 部分資料來源需自行取得授權檔案（SNOMED CT、LOINC、ICD-10 zip 等），詳見[資料來源](data-sources/index.md)。

## 啟動服務

```bash
cp .env.example .env                # 設定 POSTGRES_PASSWORD 等必要變數
docker compose up -d
```

`docker compose up -d` 會啟動：`postgres`、`pgbouncer`、`redis`、`minio`、`minio-init`（建立 bucket）、`app`（MCP 伺服器 + 管理後台）以及 `admin-worker`（背景工作執行器）。

## 啟用管理後台

資料匯入由管理後台觸發、交由 `admin-worker` 背景執行（已無獨立的 CLI data-loader 容器），因此請先在 `.env` 啟用管理後台：

```dotenv
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
# python -c "import hashlib; print('sha256$' + hashlib.sha256(b'change-me').hexdigest())"
ADMIN_PASSWORD_HASH=sha256$...
ADMIN_SESSION_SECRET=change_this_admin_session_secret
```

重新啟動後（`docker compose up -d`），於 `http://<host>:8000/admin` 登入。詳見[管理後台](admin/index.md)。

## 載入資料（管理後台 → Modules）

在 Modules 頁籤依模組匯入：

| 類型 | 模組 | 操作 |
|------|------|------|
| 需上傳來源檔 | ICD-10-CM/PCS、LOINC、SNOMED CT、FHIR IG（`package.tgz`） | 於 Sources / Modules 上傳來源檔後按匯入 |
| API 自動抓取 | 藥品（TFDA）、健康補充品、食品營養 | 直接按匯入，或設定排程 |
| 內建種子資料 | 臨床指引 | 直接執行 |

- **藥物域**為三階段管線（索引 → 爬取豐富 → OCR/LLM 分析），其中爬取與分析需設定 TFDA / OCR / 分析 LLM 端點（見 `.env` 的 `DRUG_*`，或於 Settings 頁籤管理）。
- **嵌入**（語意搜尋）會在各模組匯入後自動回填，也可於模組頁面單獨重建。
- 匯入進度、步驟時間軸與即時日誌見 **Tasks** 頁籤；背景機制見[背景工作與排程](admin/jobs-and-worker.md)。

> 開發時若要直接執行單一 loader 階段，`loader/main.py` 的各階段仍存在（由 worker 呼叫），可在 worker 容器內以模組方式執行。

## 連線客戶端

伺服器在同一個埠(預設 8000)同時提供兩種介面:

### 1. MCP（原生）

預設以 `streamable-http` 模式在 `http://<host>:8000/mcp` 提供服務（見 `.env` 的 `MCP_TRANSPORT` / `MCP_PORT` / `MCP_PATH`）。供原生 MCP 客戶端使用(Claude Desktop、Open WebUI v0.6.31+ 的 MCP 連線等)。若要供 Claude Desktop 以 stdio 模式使用，設定 `MCP_TRANSPORT=stdio`。

### 2. OpenAPI bridge（給只支援 OpenAPI 的客戶端）

對於不支援原生 MCP、只能接 OpenAPI 工具伺服器的客戶端(例如 **Open WebUI 的 External Tools / OpenAPI 類型**),伺服器內建一層 OpenAPI 介面,**不需額外的 mcpo 代理或容器**:

- `GET http://<host>:8000/openapi.json` — 依目前已啟用的工具動態產生 OpenAPI 3.1 規格
- `POST http://<host>:8000/tools/<工具名>` — 以 JSON body 當參數呼叫工具

在客戶端只要填基底網址 `http://<host>:8000`,它會自動抓 `/openapi.json` 並列出全部工具。

> 例:Open WebUI → Settings → Tools → 以 **OpenAPI** 類型新增,URL 填 `http://<host>:8000`。
>
> 注意:`/mcp` 與 OpenAPI bridge 目前皆**未強制驗證**;對外開放時請在前面加反向代理或 token。

## 驗證

```bash
pip install pytest pytest-asyncio
python -m pytest tests/ -v
```

或先用 `health_check` 工具確認伺服器與各模組狀態。
