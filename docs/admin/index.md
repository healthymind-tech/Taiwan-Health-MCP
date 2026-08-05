# 管理後台 (Admin Console)

管理後台是一個 session 認證的操作介面，掛載於 `/admin`，供操作者上傳來源檔、執行與排程資料匯入、管理設定與外部 FHIR 伺服器，並即時監控背景工作。**預設停用**。

## 啟用

於 `.env` 設定下列變數後重新啟動 `app`：

```dotenv
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
# 產生密碼雜湊（Node）：
#   node -e "console.log('sha256$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
# ⚠️ 在 .env 中每個 $ 都要寫成 $$（Docker Compose 會把 $ 當變數展開，
#    雜湊值以字母開頭時會被靜默截斷）。Compose 會把 $$ 還原成單一 $。
ADMIN_PASSWORD_HASH=sha256$$...
ADMIN_SESSION_SECRET=change_this_admin_session_secret
ADMIN_SESSION_TTL_MINUTES=240
ADMIN_MAX_UPLOAD_MB=512
# 外部 FHIR 伺服器 OAuth token / client secret 的對稱加密金鑰（pgcrypto）。
# 未設定時回退至 ADMIN_SESSION_SECRET。
FHIR_SERVER_SECRET_KEY=
```

密碼雜湊支援 `sha256$<hex>` 或 `pbkdf2_sha256$<iterations>$<salt>$<hex>`。也可改用 `ADMIN_INITIAL_PASSWORD` 直接給明文初始密碼（僅首次啟動有效）。`/admin` 開放的條件是 `ADMIN_ENABLED=true`、`ADMIN_USERNAME`、`ADMIN_SESSION_SECRET` 皆有值，且 `ADMIN_PASSWORD_HASH` 與 `ADMIN_INITIAL_PASSWORD` 至少其一有值。

登入網址為 `http://<host>:8080/admin`（經由 nginx 前門；`app` 容器不對主機開埠）。

> 管理後台需要 `admin-worker` 容器一起運作（背景工作執行器）。`docker compose up -d` 會一併啟動。

> **重要：** `FHIR_SERVER_SECRET_KEY`（或其回退值 `ADMIN_SESSION_SECRET`）必須在 `app` 與 `admin-worker` 兩個容器上**完全一致**。worker 會以此金鑰 `pgp_sym_decrypt` 外部 FHIR 伺服器的 OAuth token 與 client secret；若 worker 的金鑰為空或不同，會在背景工作時拋出 `Illegal argument to function`（金鑰為空）或 `Wrong key or corrupt data`（金鑰不符）。

## 介面組成

管理介面是 React SPA，位於 **`web/admin-app/`**，由 Next.js 前端（`web` 服務）以 `/admin` catch-all 路由掛載；`web/middleware.ts` 以 `tw_health_admin_session` cookie 做存取控制。

主要頁籤：

| 頁籤 | 用途 |
|------|------|
| **Overview** | 系統總覽：DB / 各模組 / worker / 外部 FHIR 伺服器健康狀態。 |
| **Services** | 各服務 / 模組的可用性與探測（probe）結果。 |
| **Tasks** | 匯入工作佇列、進度、步驟時間軸與即時日誌（見[背景工作與排程](jobs-and-worker.md)）。 |
| **Modules** | 各資料模組的來源檔、匯入、排程、預覽、嵌入與維護模式。 |
| **Settings** | 依 Embedding、Analysis LM、OCR、整合服務、Privacy、Backup 等子頁分類；可管理 DB-backed 設定、LLM Profiles、登入憑證與系統備份。 |
| **FHIR Servers** | 登錄與管理外部 FHIR R4 伺服器、認證與健康檢查。 |

對應的後端模組見 `node-server/src/admin/*.ts`（`adminApp.ts` 為路由入口）。

登入方式除密碼外，另支援 **passkey / WebAuthn**（`node-server/src/admin/webauthn.ts`）；
passkey 僅能在 HTTPS 的 RP 網域（或本機 localhost）上使用，設定見[環境變數配置](../deployment/configuration.md)。

## 設定（Settings）與優先序

Bootstrap 變數（DB / Redis / MCP transport / `ADMIN_*` 認證）起始於 `.env`。首次啟動會把
`ADMIN_PASSWORD_HASH` 寫入 `admin.admin_credentials`，之後登入只驗證資料庫中的 hash。
seed 使用 `ON CONFLICT DO NOTHING`，因此 credential row 建立後修改 `.env` 或重啟服務都不會
覆蓋有效密碼。密碼與 passkey 都在 Settings → Privacy 管理。

其餘外部系統設定（MinIO、TFDA base URL、worker 調校）為 **seed-only**：`.env` 僅在首次啟動、
`admin.app_settings` 為空時讀取一次以種子化；之後請在 Settings 頁籤管理與測試（支援熱套用），
編輯 `.env` 對已種子化的資料庫無效。

**模型端點（嵌入 / OCR / 分析 LLM）完全不從環境變數讀取**，只存在於 `admin.llm_profiles`，
僅能在 Settings 子頁設定。可用 Settings → Backup & restore 的 JSON Export / Import 在不同環境間搬移一份可用的設定。

## 系統備份

Settings → Backup & restore 可逐項選擇設定與憑證、PostgreSQL database、MinIO object storage。
建立備份只會排入 `system_backup` 背景工作；worker 將 PostgreSQL custom dump 與 MinIO 物件
逐段串流進 ZIP，再以 multipart upload 寫回 MinIO 的 `system-backups/` prefix，不會在單一
HTTP request 或 Node 記憶體中組裝整份備份。完成後可由備份歷史透過同源 API 串流下載。

備份包含 API keys、登入憑證與醫療資料，應視同 production secret 管理。資料庫 dump 可用
PostgreSQL 16 `pg_restore` 還原；object storage 檔案位於 ZIP 的 `object-storage/` 目錄。

## 來源檔（Sources）

於 Modules / Sources 上傳各模組的來源檔（ICD zip、LOINC zip、SNOMED RF2、RxNorm zip、FHIR IG `package.tgz` 等），並可指定 source role（例如 IG 相依套件）。系統會以檔案指紋阻擋重複上傳；檔案存於 MinIO，工作執行時再取回。

> 上傳需送出 `Content-Type: application/octet-stream`，否則會被 express 的 JSON parser 攔下並回 413。

## 維護模式（Maintenance Mode）

各模組可切換維護模式：開啟後，該模組的 MCP 工具會暫停回應（回傳維護中訊息），可安全地進行重載或清除，避免讀寫競態。

## 外部 FHIR 伺服器

在 FHIR Servers 頁籤登錄外部 FHIR R4 伺服器，設定允許的資源型別 / 操作、OAuth 認證（含 `private_key_jwt` 金鑰產生與公開 JWKS 託管於 `/fhir-client/<id>/jwks.json`）、token 策略與健康檢查路徑。

MCP 端透過 `list_fhir_servers` / `get_fhir_server_status` / `crud_fhir_server` 使用，並由伺服器代為處理 token —— 呼叫端不經手任何密鑰。

> `crud_fhir_server` 是系統中唯一可能產生寫入的工具：寫入操作必須該伺服器的 allow-list 允許，且呼叫端帶入 `confirm_write=true`。

## DB 健康閘門

`node-server/src/dbHealth.ts` 為中央 DB 健康監測：當 PostgreSQL 無法連線時，會鎖定所有變動性操作並在 UI 顯示遮罩（overlay），避免在資料庫異常時進行匯入或修改。
