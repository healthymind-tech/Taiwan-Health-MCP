# 管理後台 (Admin Console)

管理後台是一個 session 認證的操作介面，掛載於 `/admin`，供操作者上傳來源檔、執行與排程資料匯入、管理模型端點、設定與外部 FHIR 伺服器，並即時監控背景工作。**預設啟用**（`ADMIN_ENABLED=true`）——它是唯一能匯入資料的途徑；資料載入完成後可設為 `false` 以縮小公開部署的受攻擊面（MCP 工具、worker 與排程匯入照常運作）。

## 啟用與登入

於 `.env` 設定下列變數後重新啟動 `app`：

```dotenv
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
# 二擇一：明文初始密碼（首次啟動時雜湊後寫入資料庫），或預先算好的雜湊
ADMIN_INITIAL_PASSWORD=
# 產生密碼雜湊（Node）：
#   node -e "console.log('sha256$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
# ⚠️ 在 .env 中每個 $ 都要寫成 $$（Docker Compose 會把 $ 當變數展開，
#    雜湊值以字母開頭時會被靜默截斷）。Compose 會把 $$ 還原成單一 $。
ADMIN_PASSWORD_HASH=sha256$$...
ADMIN_SESSION_SECRET=<openssl rand -hex 32>
ADMIN_SESSION_TTL_MINUTES=240
ADMIN_MAX_UPLOAD_MB=512
# 外部 FHIR 伺服器 OAuth token / client secret 的對稱加密金鑰（pgcrypto）。
# 未設定時回退至 ADMIN_SESSION_SECRET。
FHIR_SERVER_SECRET_KEY=
```

密碼雜湊支援 `sha256$<hex>` 或 `pbkdf2_sha256$<iterations>$<salt>$<hex>`。`ADMIN_INITIAL_PASSWORD` 與 `ADMIN_PASSWORD_HASH` 並存時以前者為準，且兩者都只在首次啟動、資料庫尚無憑證列時使用。`/admin` 開放的條件是 `ADMIN_ENABLED=true`、`ADMIN_USERNAME`、`ADMIN_SESSION_SECRET` 皆有值，且 `ADMIN_PASSWORD_HASH` 與 `ADMIN_INITIAL_PASSWORD` 至少其一有值（404 = 後台關閉、503 = 已啟用但設定不齊、401 = 帳密錯誤）。

登入網址為 `http://<host>:8080/admin`（經由 nginx 前門；`app` 容器不對主機開埠）。

> 管理後台需要 `admin-worker` 容器一起運作（背景工作執行器）。`docker compose up -d` 會一併啟動。

> **重要：** `FHIR_SERVER_SECRET_KEY`（或其回退值 `ADMIN_SESSION_SECRET`）必須在 `app` 與 `admin-worker` 兩個容器上**完全一致**。worker 會以此金鑰 `pgp_sym_decrypt` 外部 FHIR 伺服器的 OAuth token 與 client secret；若 worker 的金鑰為空或不同，會在背景工作時拋出 `Illegal argument to function`（金鑰為空）或 `Wrong key or corrupt data`（金鑰不符）。

## 介面組成

管理介面是 **`web-v2/`** 的 React SPA（Vite + React 19 + Mantine 8），建置後的靜態檔由獨立的 `web-v2` 容器（自帶 nginx）提供；根目錄 `nginx/nginx.conf` 把 `/admin` 頁面導向 `web-v2`，`/admin/api/*` 與 `/admin/ws` 則直接導向 `app`。存取控制由後端 API 的 session cookie（預設名稱 `tw_health_admin_session`，可用 `ADMIN_SESSION_COOKIE` 覆寫）負責，未登入時 SPA 會導向 `/admin/login`。

> 舊的 Next.js 前端（`web/` + `web/admin-app/`）已被取代，僅保留在 compose profile `legacy-web` 供回滾使用，預設不啟動。

側邊欄（`web-v2/src/layout/nav.ts`）分為五區：

| 區塊 | 頁面（路徑相對於 `/admin`） | 用途 |
|------|------|------|
| **總覽** | 儀表板 `/`、背景工作 `/jobs` | 系統狀態一覽；匯入 / 嵌入 / 同步工作的佇列、步驟時間軸與即時日誌（見[背景工作與排程](jobs-and-worker.md)）。 |
| **資料** | 醫療術語 `/terminology`（各模組 `/terminology/<icd\|loinc\|snomed\|rxnorm>`）、藥品 `/drug`（藥品瀏覽器 `/drug/explorer`）、健康食品 `/data/health_supplements`、食品營養 `/data/food_nutrition` | 各模組的來源檔、匯入、排程、資料預覽、嵌入、維護模式與清除；術語模組另有瀏覽器（見下文）。 |
| **FHIR** | IG 套件庫 `/fhir/ig`、FHIR 伺服器 `/fhir-servers` | FHIR IG 匯入 / 相依套件 / 移除保護；外部 FHIR R4 伺服器登錄、認證與健康檢查。 |
| **整合** | 模型端點 `/models`、MCP 工具 `/mcp`、外部服務 `/integrations` | Embedding 與分析 LLM 的 provider 帳號與 profile；MCP 端點、工具目錄與線上測試；OCR（MinerU）、物件儲存、TFDA、FHIR package registry、worker 設定。 |
| **系統** | 服務健康 `/health`、備份與設定 `/system`、帳號安全 `/security` | 基礎設施探測與 worker 心跳；系統備份與設定匯出 / 匯入；密碼與 passkey。 |

對應的後端模組見 `node-server/src/admin/*.ts`（`adminApp.ts` 為路由入口）。

登入方式除密碼外，另支援 **passkey / WebAuthn**（`node-server/src/admin/webauthn.ts`），於「帳號安全」頁管理；passkey 僅能在 HTTPS 的 RP 網域（或本機 localhost）上使用，設定見[環境變數配置](../deployment/configuration.md)。

## MCP 工具頁（`/admin/mcp`）

由 `node-server/src/admin/adminMcp.ts` 提供 API（`GET /admin/api/mcp/overview`、`GET /admin/api/mcp/tools`、`POST /admin/api/mcp/tools/{name}/invoke`），分三個分頁：

- **總覽**：對外端點（`/mcp`、`/openapi.json`、`/tools/{name}`、JWKS、OAuth 回呼）、驗證模式、伺服器版本與用戶端設定範本。
- **工具目錄**：`mcp.ts` 定義的全部 63 個工具，含是否已註冊；未註冊的工具會標示原因（模組資料表與門檻筆數）；模組維護中的工具與群組會加上「維護中」徽章。
- **測試台**：以預填範例直接執行任一已註冊工具，與 `POST /tools/{name}` 走同一處理程序（有速率限制）；模組維護中時「執行」按鈕停用並說明原因。

## 模型端點（`/admin/models`）

嵌入與分析 LLM 的端點**完全不從環境變數讀取**，存放於下列資料表（migration `20261016_llm_providers_and_routes.sql`）：

| 資料表 | 內容 |
|--------|------|
| `admin.llm_providers` | Provider 帳號：某一 provider 類型的具名帳號（同類型可多個），含 URL、憑證、帳號層級限制。 |
| `admin.llm_routes` | Profile：一個策略（`single` / `fallback` / `round_robin` / `load_balance`）加上一組成員；`kind` 為 `analysis` 或 `embedding`。 |
| `admin.llm_route_members` | 成員：某 provider 帳號上的一個模型（帶自己的參數），**或另一個 profile**（可巢狀，禁止循環）。 |
| `admin.llm_role_routes` | 每個角色（`analysis` / `embedding`）使用哪個 profile。 |

舊的 `admin.llm_profiles` 已改名為 `admin.llm_profiles_legacy`，只供回滾。

- **Provider adapter**：`node-server/src/providers/registry.ts` 共註冊 24 個 adapter——OpenAI、Azure OpenAI、Anthropic、Gemini、Bedrock、Mistral、Cohere、Voyage、Jina、DeepSeek、xAI、Groq、OpenRouter、Together、Fireworks、SiliconFlow、DashScope、Moonshot、Zhipu、Volcengine、MiniMax、OpenAI 相容伺服器（vLLM、LM Studio、LiteLLM…）、Ollama，以及 ChatGPT。舊值 `vllm` / `google` / `azure` / `claude` 會自動對應到新 id（migration `20261015_llm_provider_registry.sql` 一併改寫已存資料）。
- **ChatGPT 登入**：`chatgpt` provider 使用 OpenAI 的「Sign in with ChatGPT」PKCE 流程（`admin/chatgptOAuth.ts`）。由於 redirect 只能是本機 loopback，操作者需把瀏覽器最後的網址貼回後台完成交換；token 存於 `admin.llm_providers.oauth`，不會離開伺服器。
- **Embedding 身分（fingerprint）**：`admin/embeddingIdentity.ts` 以一組固定探測文字的向量作為系統的嵌入身分（`admin.embedding_identity` / `admin.embedding_fingerprints`，定義在 `db/schema.sql` 與 `db/migrations/20261021_embedding_identity.sql`；程式啟動時也會以 `CREATE TABLE IF NOT EXISTS` 補建）。任何新端點要加入 embedding profile，每個探測文字的 cosine 都必須 ≥ 0.95，才算「同一個模型」。已有向量時要換模型，必須走受保護的切換流程：停用嵌入角色 → 停止 embed 工作 → 清除向量 → 採用新身分 → 重新排入各模組的 embed 工作。
- 角色層級參數（嵌入的 timeout / batch size / concurrency、分析的 max retries）存於 `admin.app_settings` 的 `embedding` / `analysis` 群組。

## 設定（Settings）與優先序

Bootstrap 變數（DB / Redis / MCP transport / `ADMIN_*` 認證）起始於 `.env`。首次啟動會把
`ADMIN_INITIAL_PASSWORD`（雜湊後）或 `ADMIN_PASSWORD_HASH` 寫入 `admin.admin_credentials`，之後登入只驗證資料庫中的 hash。
seed 使用 `ON CONFLICT DO NOTHING`，因此 credential row 建立後修改 `.env` 或重啟服務都不會
覆蓋有效密碼。密碼與 passkey 都在「帳號安全」（`/admin/security`）管理。

其餘外部系統設定（MinIO、TFDA base URL、FHIR package registry、worker 調校）為 **seed-only**：`.env` 僅在首次啟動、
對應鍵尚未存在時讀取一次以種子化 `admin.app_settings`；之後請在「外部服務」（`/admin/integrations`）管理與測試，
編輯 `.env` 對已種子化的資料庫無效。其中 TFDA 與 registry 可直接修改（熱套用）；**MinIO 與 worker 調校在後台為唯讀群組**。

OCR（MinerU）端點存於 `admin.app_settings` 的 `ocr` 群組，**不從 `.env` 種子化**，只能在「外部服務 → OCR」設定與測試。

「備份與設定」（`/admin/system`）的設定匯出 / 匯入（格式版本 3）可在不同環境間搬移一份可用的設定：內含 `admin.app_settings` 各群組、provider 帳號 / profile / 角色綁定（含金鑰）、passkey 與其 RP ID。舊的 v1 / v2 匯出檔仍可匯入。匯出檔含明文密鑰，請視同憑證保管。

## 系統備份 { #system-backups }

「備份與設定」頁可逐項選擇設定與憑證、PostgreSQL database、MinIO object storage。
建立備份只會排入 `system_backup` 背景工作；worker 將 PostgreSQL custom dump 與 MinIO 物件
逐段串流進 ZIP，再以 multipart upload 寫回 MinIO 的 `system-backups/` prefix，不會在單一
HTTP request 或 Node 記憶體中組裝整份備份。完成後可由備份歷史透過同源 API 串流下載。

備份包含 API keys、登入憑證與醫療資料，應視同 production secret 管理。資料庫 dump 可用
PostgreSQL 16 `pg_restore` 還原；object storage 檔案位於 ZIP 的 `object-storage/` 目錄。

## 來源檔（Sources）

於各模組頁的來源檔區上傳來源檔（ICD-10-CM CMS order file zip、ICD-10-PCS、LOINC zip、SNOMED RF2、RxNorm zip、FHIR IG `package.tgz` 等），並可指定 source role（例如 IG 相依套件、選用的 WHO ICD-10 來源）。系統會以檔案指紋（SHA-256）阻擋重複上傳；檔案存於 MinIO，工作執行時再取回。

> 上傳需送出 `Content-Type: application/octet-stream`（SPA 已如此送出），否則會被 express 的 JSON parser 攔下並回 413。

## 術語瀏覽器

「醫療術語」各模組頁與 IG 套件庫內建唯讀瀏覽器，資料來自 `GET /admin/api/terminology/*`（`node-server/src/admin/termViz/`）：

| 瀏覽器 | API 前綴 | 內容 |
|--------|----------|------|
| ICD-10-CM 樹 / WHO ICD-10 樹 | `icd/cm/*`、`icd/who/*` | 章節 → 類目 → 碼的階層、路徑與搜尋 |
| ICD-10-PCS 軸向 | `icd/pcs/*` | 依前三碼表格與第 4–7 軸篩選 |
| SNOMED CT 圖 | `snomed/*` | 概念鄰域（父 / 子 / 屬性關聯）與搜尋 |
| LOINC 軸向 | `loinc/*` | 六軸 facet 篩選、單一 term 詳情、LA / LP / LL 碼 |
| RxNorm | `rxnorm/*` | 摘要、依 TTY 搜尋、概念詳情 |
| IG CodeSystem 樹 | `ig/codesystem*` | IG 套件內 CodeSystem 的概念階層與搜尋 |

## 維護模式（Maintenance Mode）

`drug`、`icd`、`loinc`、`snomed`、`ig`、`rxnorm` 模組可切換維護模式（`POST /admin/api/module-maintenance`，狀態存於 `admin.app_settings` 的 `maintenance` 群組），用來在重載或清除資料時暫停該模組的 MCP 工具：維護中的模組，其工具呼叫（`/mcp`、`/tools/*`、後台 playground）會立即回傳錯誤碼 `MODULE_MAINTENANCE`（中英文訊息），工具仍留在 `tools/list` 中（避免用戶端工具清單變動）。狀態快取 5 秒，切換後約 5 秒內生效。ICD-10 與 FHIR Condition 跟隨 `icd`、Drug 與 FHIR Medication 跟隨 `drug`、Lab 跟隨 `loinc`、FHIR IG 跟隨 `ig`；`rxnorm` 沒有自己的工具，旗標只作標示。模組頁會顯示工具「暫停（維護中）」，MCP 工具頁的工具卡也會標示「維護中」。錯誤格式見 [API 參考](../api/index.md#maintenance)。

## 外部 FHIR 伺服器

在「FHIR 伺服器」頁登錄外部 FHIR R4 伺服器，設定允許的資源型別 / 操作、OAuth 認證（含 `private_key_jwt` 金鑰產生與公開 JWKS 託管於 `/fhir-client/<id>/jwks.json`）、token 策略與健康檢查路徑。OAuth Authorization Code 回呼完成後會導回 `/admin/fhir-servers`。

MCP 端透過 `list_fhir_servers` / `get_fhir_server_status` / `crud_fhir_server` 使用，並由伺服器代為處理 token —— 呼叫端不經手任何密鑰。

> `crud_fhir_server` 是系統中唯一可能產生寫入的工具：寫入操作必須該伺服器的 allow-list 允許，且呼叫端帶入 `confirm_write=true`。

## DB 健康閘門

`node-server/src/dbHealth.ts` 為中央 DB 健康監測：當 PostgreSQL 無法連線時，會鎖定所有變動性操作並在 UI 顯示遮罩（overlay），避免在資料庫異常時進行匯入或修改。
