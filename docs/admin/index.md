# 管理後台 (Admin Console)

管理後台是一個 session 認證的操作介面，掛載於 `/admin`，供操作者上傳來源檔、執行與排程資料匯入、管理設定與外部 FHIR 伺服器，並即時監控背景工作。**預設停用**。

## 啟用

於 `.env` 設定下列變數後重新啟動 `app`：

```dotenv
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
# 產生密碼雜湊：
# python -c "import hashlib; print('sha256$' + hashlib.sha256(b'change-me').hexdigest())"
ADMIN_PASSWORD_HASH=sha256$...
ADMIN_SESSION_SECRET=change_this_admin_session_secret
ADMIN_SESSION_TTL_MINUTES=240
ADMIN_MAX_UPLOAD_MB=512
# 外部 FHIR 伺服器 OAuth token / client secret 的對稱加密金鑰（pgcrypto）。
# 未設定時回退至 ADMIN_SESSION_SECRET。
FHIR_SERVER_SECRET_KEY=
```

密碼雜湊支援 `sha256$<hex>` 或 `pbkdf2_sha256$<iterations>$<salt>$<hex>`。四個變數齊備（`admin_ready`）時 `/admin` 才會開放。

> 管理後台需要 `admin-worker` 容器一起運作（背景工作執行器）。`docker compose up -d` 會一併啟動。

> **重要：** `FHIR_SERVER_SECRET_KEY`（或其回退值 `ADMIN_SESSION_SECRET`）必須在 `app` 與 `admin-worker` 兩個容器上**完全一致**。worker 會以此金鑰 `pgp_sym_decrypt` 外部 FHIR 伺服器的 OAuth token 與 client secret；若 worker 的金鑰為空或不同，會在背景工作（如排程 FHIR 任務、token 更新）時拋出 `Illegal argument to function`（金鑰為空）或 `Wrong key or corrupt data`（金鑰不符）。

## 介面組成

現代介面為 React SPA（`admin-ui/`），另保留伺服器渲染的 HTML shell 作為退路。主要頁籤：

| 頁籤 | 用途 |
|------|------|
| **Overview** | 系統總覽：DB / 各模組 / worker / 外部 FHIR 伺服器健康狀態。 |
| **Services** | 各服務 / 模組的可用性與探測（probe）結果。 |
| **Tasks** | 匯入工作佇列、進度、步驟時間軸與即時日誌（見[背景工作與排程](jobs-and-worker.md)）。 |
| **Modules** | 各資料模組的來源檔、匯入、排程、預覽（preview）、嵌入與維護模式。 |
| **Settings** | DB-backed 設定（Ollama / MinIO / OCR / 分析 LLM / TFDA / worker 調校），可線上測試與熱套用。 |
| **FHIR Servers** | 登錄與管理外部 FHIR R4 伺服器、認證與健康檢查。 |

對應的後端模組見 `src/admin_*.py`（`admin_console.py` 為組合入口）。

## 設定（Settings）與優先序

Bootstrap 變數（DB / Redis / MCP transport / `ADMIN_*` 認證）只存在於 `.env`。其餘外部系統設定（Ollama 嵌入、MinIO、藥品 OCR/分析、TFDA base URL、worker 調校）為 **seed-only**：`.env` 僅在首次啟動、`admin.app_settings` 為空時讀取一次以種子化；之後請在 Settings 頁籤管理與測試（支援熱套用），編輯 `.env` 對已種子化的資料庫無效。

## 來源檔（Sources）

於 Modules / Sources 上傳各資料集的來源檔（ICD zip、LOINC zip、SNOMED RF2、FHIR IG `package.tgz` 等），並可指定 source role（例如 IG 相依套件 `twcore_tho`、`twcore_fhir_core`）。系統會以檔案指紋阻擋重複上傳。

## 維護模式（Maintenance Mode）

各模組可切換維護模式：開啟後，該模組的 MCP 工具會暫停回應（回傳維護中訊息），可安全地進行重載或清除，避免讀寫競態。

## 外部 FHIR 伺服器

在 FHIR Servers 頁籤登錄外部 FHIR R4 伺服器，設定允許的資源型別 / 操作、OAuth 認證（含 `private_key_jwt` 金鑰產生與公開 JWKS 託管）、token 策略與健康檢查路徑。MCP 端透過 `list_fhir_servers` / `get_fhir_server_status` / `crud_fhir_server` 使用，並由伺服器代為處理 token —— 呼叫端不經手任何密鑰。

## DB 健康閘門

`src/db_health.py` 為中央 DB 健康監測：當 PostgreSQL 無法連線時，會鎖定所有變動性操作並在 UI 顯示遮罩（overlay），避免在資料庫異常時進行匯入或修改。
