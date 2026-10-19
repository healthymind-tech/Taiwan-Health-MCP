# 部署指南

本章節說明如何將 Taiwan Health MCP 伺服器部署至生產環境。本專案採 Container-first 策略，強烈建議使用 Docker 部署以確保環境一致性。

完整的變數清單見[環境變數配置](configuration.md)；本頁是**按順序執行的部署流程**。

## 支援環境
- **作業系統**：Linux (Ubuntu/CentOS)、macOS、Windows (WSL2)
- **容器平台**：Docker Engine 24 以上 + Docker Compose v2（`docker compose`，非舊版 `docker-compose`）
- **Node.js 版本**：20 以上（裸機部署或本機開發時）。本專案已無 Python 執行期相依。

### 資源需求

| 項目 | 最低 | 建議 | 備註 |
|------|------|------|------|
| CPU | 2 core | 4 core 以上 | 匯入與嵌入工作為主要負載 |
| 記憶體 | 8 GB | 16 GB 以上 | `admin-worker` 單一容器就設定了 `--max-old-space-size=8192`（FHIR IG 匯入需要） |
| 磁碟 | 20 GB | 100 GB 以上 | PostgreSQL + MinIO 藥品資產（仿單 / 標籤 / 外觀圖）會持續成長 |

嵌入、OCR（MinerU）與分析 LLM 都是**外部 HTTP 服務**，不含在本 compose stack 內，需另行準備並在管理後台設定。唯一的例外是選用的 CPU OCR 容器 `ocr-indra`（`services/ocr-indra/`，Indra OCR）：它隨 compose 啟動、只接在內部網路 `ocr`（不對外連線、無 host port），在「外部服務 → OCR」把供應者（或備援）設為 `indra` 才會被使用；模型授權限制見 `services/ocr-indra/README.md`。

## 服務組成

`docker compose up -d` 會啟動下列服務：

| 服務 | 說明 |
|------|------|
| `nginx` | **對外入口**（預設 `:8080`，由 `WEB_PORT` 設定）。把 `/mcp`、`/openapi.json`、`/tools/*`、`/admin/api/*`、`/admin/ws`、`/fhir-client/*`、`/fhir-oauth/*` 導向 `app`，其餘（`/admin` 頁面）全部導向 `web-v2`。 |
| `web-v2` | 管理後台 SPA（`web-v2/`，Vite + React + Mantine）的靜態檔，由容器內的 nginx 提供。 |
| `app` | Node MCP 伺服器 + 管理後台 REST API。**只在 compose 內部網路上 `expose` 8000 埠，不對主機發佈。** |
| `admin-worker` | 背景工作執行器：所有匯入（含藥品三階段管線）與嵌入工作。 |
| `postgres` | PostgreSQL 16 + pgvector。 |
| `pgbouncer` | 連線池（transaction mode）。 |
| `redis` | 管理後台即時事件廣播與健康探測（工具回應目前**沒有**快取）。 |
| `minio` + `minio-init` | 來源檔、藥品資產與系統備份的物件儲存，以及 bucket 初始化。 |

舊的 Next.js 前端 `web` 只保留在 compose profile `legacy-web`（供回滾），**預設不啟動**；需要時以 `docker compose --profile legacy-web up -d web` 啟動，並同時還原 `nginx/nginx.conf` 的 `$th_frontend`。

資料匯入由管理後台觸發、在 `admin-worker` 內執行，已無獨立的 data-loader 容器。

!!! warning "應用流量只走 nginx"
    不要在文件或客戶端設定中使用 `http://<host>:8000` —— `app` 沒有對主機開放該埠。
    所有應用流量（含 MCP）都必須經由 `http://<host>:8080`。

    （`postgres` 與 `minio` 另有對主機發佈的埠，屬於維運用途，正式環境請見[對外埠與強化](#external-ports)。）

---

## 部署流程

### 步驟 1：取得程式碼

```bash
git clone https://github.com/healthymind-tech/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
```

### 步驟 2：建立 `.env`

```bash
cp .env.example .env
```

`.env.example` 的預設值**不能直接上生產環境**。以下是必須處理的項目：

#### 2-1. 必填 / 必改變數

| 變數 | 為何必要 | 建議做法 |
|------|----------|----------|
| `POSTGRES_PASSWORD` | 未設定時 `docker compose` 會直接失敗（compose 以 `:?` 強制要求）；**沿用 `.env.example` 的預設值時 `app` 會拒絕啟動** | `openssl rand -hex 24` |
| `ADMIN_ENABLED` | 預設 `true`（`/admin` 是**唯一**能匯入資料的途徑）。資料載入完成後可設 `false` 縮小公開部署的受攻擊面 | 依需求 |
| `ADMIN_USERNAME` | 管理後台帳號 | 預設 `admin`，可自訂 |
| `ADMIN_INITIAL_PASSWORD`<br>或 `ADMIN_PASSWORD_HASH` | 沒有憑證就無法登入 | 二擇一，見 2-2 |
| `ADMIN_SESSION_SECRET` | session cookie 簽章金鑰（知道它就能偽造任何使用者的登入，不需密碼）；同時是 `FHIR_SERVER_SECRET_KEY` 的回退值。**沿用 `.env.example` 的預設值時 `app` 會拒絕啟動** | `openssl rand -hex 32` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | 預設 `minioadmin` / `minioadmin`，等同無密碼 | 各自 `openssl rand -hex 16` |
| `PUBLIC_BASE_URL` | 對外 origin，用於 OAuth2 redirect_uri 與 WebAuthn RP ID 推導 | `https://your-domain.example.com` |
| `PUBLIC_TOOLS_AUTH_MODE` / `PUBLIC_TOOLS_BEARER_TOKEN` | 預設 `none`，代表 `/mcp` 與 `/tools/*` 完全不驗證 | 對外開放時設 `bearer` + `openssl rand -hex 32` |
| `WEB_PORT` | 對外埠 | 預設 `8080`，依環境調整 |

一次產生所有隨機值：

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "ADMIN_SESSION_SECRET=$(openssl rand -hex 32)"
echo "FHIR_SERVER_SECRET_KEY=$(openssl rand -hex 32)"
echo "MINIO_ACCESS_KEY=$(openssl rand -hex 16)"
echo "MINIO_SECRET_KEY=$(openssl rand -hex 16)"
echo "PUBLIC_TOOLS_BEARER_TOKEN=$(openssl rand -hex 32)"
```

#### 2-2. 設定管理後台密碼

兩種方式擇一：

**(a) 明文初始密碼（較簡單）** —— 只在首次啟動、資料庫尚無憑證列時使用，之後永久忽略：

```dotenv
ADMIN_INITIAL_PASSWORD=your-strong-password
```

**(b) 預先算好的雜湊**：

```bash
node -e "console.log('sha256\$' + require('crypto').createHash('sha256').update('change-me').digest('hex'))"
```

```dotenv
ADMIN_PASSWORD_HASH=sha256$$1a2b3c...
```

兩者同時存在時 `ADMIN_INITIAL_PASSWORD` 優先。密碼雜湊支援 `sha256$<hex>` 與 `pbkdf2_sha256$<iterations>$<salt>$<hex>`。

!!! danger "`.env` 中的每個 `$` 都要寫成 `$$`"
    Docker Compose 會對 `.env` 做變數展開，單一 `$` 會被當成變數參照。
    當雜湊值以字母開頭時（例如 `sha256$abc…`），`$abc…` 會被當成未定義變數而**靜默截斷成 `sha256`**，
    結果是登入永遠失敗且沒有明顯錯誤訊息。

    請把每個 `$` 都寫成 `$$`（Compose 會還原成單一 `$`）。`pbkdf2_sha256$...$...$...` 含多個 `$`，每個都要加倍。
    密碼本身或 `ADMIN_SESSION_SECRET` 含 `$` 時同理。

#### 2-3. 加密金鑰的一致性

`FHIR_SERVER_SECRET_KEY` 是外部 FHIR 伺服器 OAuth token / client secret 的 pgcrypto 對稱金鑰，
未設定時回退為 `ADMIN_SESSION_SECRET`。`compose.yaml` 已把它同時傳給 `app` 與 `admin-worker`，
**兩者必須一致**，否則 worker 解密會拋 `Illegal argument to function`（金鑰為空）
或 `Wrong key or corrupt data`（金鑰不符）。

#### 2-4. 認清「只讀一次」的設定

seed-only 設定（MinIO、TFDA 爬蟲、FHIR package registry、worker 調校）**只在首次啟動時
從 `.env` 讀取一次**寫入 `admin.app_settings`（`seedIfEmpty()` 以 `ON CONFLICT DO NOTHING`
逐鍵寫入），之後改 `.env` 一律無效。但它們事後的可改性**並不相同**：

| 設定群組 | 首次啟動後如何修改 |
|----------|-------------------|
| TFDA 爬蟲、FHIR package registry | 管理後台「外部服務」（`/admin/integrations`）直接改（支援熱套用） |
| **MinIO（Storage）**、**Worker Tuning** | 後台**唯讀**，標示為 "Owned by the deployment (.env / compose)"。但因為值早已種子化進資料庫、程式也是讀資料庫，**改 `.env` 同樣沒有效果** —— 只能直接 `UPDATE admin.app_settings` 再重啟對應服務。 |
| 模型端點（嵌入 / 分析 LLM）、OCR | **完全不從 `.env` 讀取**：嵌入與分析 LLM 在「模型端點」（`/admin/models`）設定，OCR 在「外部服務 → OCR」設定 |

`ADMIN_MAX_CONCURRENT_JOBS` 是例外：它不進 `admin.app_settings`，worker 每次啟動都直接讀環境變數，改 `.env` 後重啟 worker 即生效。

!!! danger "MinIO 憑證務必在首次啟動前就設定好"
    `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` 有兩個消費者，行為並不一致：

    - `minio` 容器**每次啟動都會**從 `.env` 讀取，作為 root 帳密（`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`）；
    - `app` / `admin-worker` 用的是**首次啟動時種子化進 `admin.app_settings`** 的那份（`seedIfEmpty()` 以 `ON CONFLICT DO NOTHING` 寫入，之後永不覆寫）。

    首次啟動後才改 `.env`，會讓 MinIO 伺服器帳密與應用端儲存的設定**不一致**，導致物件儲存讀寫失敗。

    而且 **「外部服務」中的 MinIO 群組是唯讀的**（標示為 "Owned by the deployment (.env / compose)"），
    無法從後台修正。若已經發生，只能直接改資料庫：

    ```sql
    UPDATE admin.app_settings SET value = '<new-access-key>'
     WHERE group_key = 'minio' AND key = 'access_key';
    UPDATE admin.app_settings SET value = '<new-secret-key>'
     WHERE group_key = 'minio' AND key = 'secret_key';
    ```

    改完重啟 `app` 與 `admin-worker`。

詳見[環境變數配置](configuration.md#settings-precedence)。

#### 2-5. 最小可用 `.env` 範例

```dotenv
# --- 對外 ---
WEB_PORT=8080
PUBLIC_BASE_URL=https://taiwan-health-mcp.example.com

# --- 資料庫 ---
POSTGRES_DB=taiwan_health
POSTGRES_USER=mcp
POSTGRES_PASSWORD=<openssl rand -hex 24>

# --- MCP ---
MCP_PORT=8000
MCP_PATH=/mcp
PUBLIC_TOOLS_AUTH_MODE=bearer
PUBLIC_TOOLS_BEARER_TOKEN=<openssl rand -hex 32>

# --- 管理後台 ---
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
ADMIN_INITIAL_PASSWORD=<強密碼；含 $ 請寫成 $$>
ADMIN_SESSION_SECRET=<openssl rand -hex 32>
ADMIN_COOKIE_SECURE=true          # TLS 在外部 proxy 終止時明確設定
FHIR_SERVER_SECRET_KEY=<openssl rand -hex 32>

# --- 物件儲存（seed-only：首次啟動才讀）---
MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=<openssl rand -hex 16>
MINIO_SECRET_KEY=<openssl rand -hex 16>
MINIO_BUCKET=taiwan-health-drug-assets
```

### 步驟 3：建置與啟動

```bash
BUILD_SHA=$(git rev-parse --short HEAD) docker compose build   # 建置 app / admin-worker / web-v2 映像
docker compose up -d
```

`compose.yaml` 會把環境變數 `BUILD_SHA`（未設定時為 `dev`）當作 build arg 傳給 `app` 與 `admin-worker`：`app` 在 `health_check` 回應的 `build` 欄位回報它，`admin-worker` 則記在啟動日誌（`Admin worker started` 的 `build` 欄位）。`web-v2` 不使用它。

首次啟動時 PostgreSQL 容器會自動套用 `db/schema.sql`，`minio-init` 會建立 bucket 後結束（狀態顯示為 exited 屬正常）。

### 步驟 4：驗證

確認容器狀態，`postgres` / `redis` / `minio` / `pgbouncer` 應為 `healthy`：

```bash
docker compose ps
```

確認服務與各模組狀態：

```bash
curl http://localhost:8080/openapi.json | head  # 目前已註冊的工具
curl -X POST http://localhost:8080/tools/health_check -H 'Content-Type: application/json' -d '{}'
```

`health_check` 回傳 DB / 快取 / 各模組狀態、伺服器 `version`、`build`（git sha）、`tools_version`（個別工具版本）、已載入的術語版本（`terminology`）、已安裝的 IG 套件與 `default_ig`。

啟動失敗時先看日誌：

```bash
docker compose logs -f app admin-worker
```

### 步驟 5：登入管理後台並設定模型端點

瀏覽 `http://<host>:8080/admin`，以步驟 2 的帳密登入。

登入後設定外部模型端點（這些**不能**由 `.env` 設定）：

| 頁面 | 設定內容 | 未設定的後果 |
|------|----------|--------------|
| 模型端點（`/admin/models`）→ Embedding | 建立 provider 帳號，再建立 embedding profile 並綁到 embedding 角色（例如 Ollama `qwen3-embedding`） | 搜尋退回關鍵字模式；**中文關鍵字搜尋幾乎查不到東西** |
| 模型端點（`/admin/models`）→ 分析 | 藥品仿單抽取用 LLM 的 profile | 藥品分析階段無法執行 |
| 外部服務（`/admin/integrations`）→ OCR | 供應者（MinerU 位址，或 `indra` → `http://ocr-indra:8000`）與選用的備援 | 仿單 PDF 無法 OCR |

設定可用「備份與設定」（`/admin/system`）的設定匯出 / 匯入在不同環境間搬移。詳見[管理後台](../admin/index.md)。

### 步驟 6：載入資料

在各模組頁（「醫療術語」、「藥品」、「健康食品」、「食品營養」、「IG 套件庫」）依模組匯入；需授權的來源檔（ICD-10、LOINC、SNOMED CT、RxNorm、FHIR IG）須先上傳，藥品 / 健康補充品 / 食品營養則由 API 自動抓取。

!!! warning "手動排入的 `drug_enrichment` 不受批次上限保護"
    `DRUG_AUTOCHAIN_BATCH_LIMIT`（預設 200）**只作用於自動串接產生的工作**。
    手動排入且未帶 `limit` 的 `drug_enrichment` 會爬完整個待辦佇列，
    對 TFDA 網站發出數萬次請求。

步驟與排程說明見[快速開始](../getting-started.md)與[背景工作與排程](../admin/jobs-and-worker.md)。

---

## 日常維運

### 更新與重新部署

只改了應用程式碼時，不需要重啟整個 stack：

```bash
git pull
BUILD_SHA=$(git rev-parse --short HEAD) docker compose build app admin-worker web-v2
docker compose up -d --no-deps app admin-worker web-v2
```

!!! warning "`admin-worker` 是另一個映像"
    `admin-worker` 由 `Dockerfile.worker` 從同一份 `node-server/` 原始碼建置。改了工作 / 載入程式碼
    （`adminJobs.ts`、`*Service.ts`、`loaders/*`）卻只重建 `app`，worker 會繼續執行舊程式碼且不會報錯。

### 回滾標籤

重新部署前，先把目前執行中的映像加上回滾標籤，出問題時可以直接切回：

```bash
LABEL=rollback-pre-$(date +%Y%m%d)
for svc in app admin-worker web-v2; do
  docker tag taiwan-health-mcp-$svc:latest taiwan-health-mcp-$svc:$LABEL
done
```

（映像名稱前綴為 compose 專案名，以 `docker images` 為準。）回滾時把標籤改回 `:latest` 再 `docker compose up -d --no-deps <服務>`。資料庫遷移不會隨映像回滾，套用 migration 前請另行備份資料庫。

改了 `nginx/nginx.conf`（單一檔案 bind mount，原地編輯後 reload 即可）：

```bash
docker compose exec nginx nginx -s reload    # 或 docker compose restart nginx
```

改了 `.env` 中的 **bootstrap 變數**（DB / Redis / MCP / `ADMIN_*`）才需要重建容器：

```bash
docker compose up -d
```

（改 seed-only 區塊無效，見 2-4。）

### 資料庫遷移

首次啟動時 `db/schema.sql` 會自動套用。**既有環境**升級後需自行套用 `db/migrations/` 下的增量變更，依檔名日期順序：

```bash
docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < db/migrations/20261020_loinc_structure.sql
```

2026-10 新增的 migration（依序套用；內容已併入 `db/schema.sql`）：

| 檔案 | 內容 |
|------|------|
| `20261015_llm_provider_registry.sql` | 純資料：把舊 provider 值改寫為 registry id（`vllm` → `openai_compatible`、`google` → `gemini`…） |
| `20261016_llm_providers_and_routes.sql` | 新增 `admin.llm_providers` / `llm_routes` / `llm_route_members` / `llm_role_routes`，搬移舊資料，`admin.llm_profiles` 改名為 `admin.llm_profiles_legacy` |
| `20261017_icd10cm_complete_edition.sql` | ICD-10-CM 完整版：`short_name_en`、`is_header` 欄位與 `icd.editions` |
| `20261018_terminology_completeness_v4.sql` | LOINC LA/LP/LL/LG 碼與 `loinc.editions`、SNOMED inactive 概念 / 描述、`first_released`、`snomed.editions`、WHO ICD-10（`icd.icd10_who`） |
| `20261019_ig_install_origin.sql` | `fhir.ig_packages.install_origin` / `installed_for` |
| `20261020_loinc_structure.sql` | LOINC 軸向 part link、answer list、panel、MapTo 表 |
| `20261021_embedding_identity.sql` | `admin.embedding_identity` / `admin.embedding_fingerprints`（embedding 身分；程式執行期也會補建，套用與否皆冪等） |
| `20261022_ig_concept_search.sql` | IG 術語搜尋：`fhir.concept_index_cs` / `_concepts` / `_terms`、`fhir.concept_embeddings`、`fhir.term_thesaurus`、`fhir.codesystem_supplements`。套用後於管理後台 IG 套件庫 → 術語搜尋索引按「補建索引」（`ig_concept_index`，會接著跑 `ig_embed`） |
| `20261023_umls_terms.sql` | 選用的 UMLS 同義字表 `fhir.umls_terms` / `fhir.umls_release`（需 UMLS 授權；未載入時引擎照常運作） |

套用 `20261017`、`20261018`、`20261020` 後，需重新匯入對應模組（ICD、LOINC、SNOMED CT）才會填入新表。

依序套用全部（已套用過的檔案請自行剔除，本專案未內建遷移版本追蹤）：

```bash
for f in $(ls db/migrations/*.sql | sort); do
  echo "applying $f"
  docker compose exec -T postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < "$f"
done
```

!!! tip "帳號密碼由容器內部環境變數展開"
    上面的 `$POSTGRES_USER` / `$POSTGRES_DB` 是**在容器內**展開的（所以整段包在單引號的 `sh -c` 裡），
    不需要在主機端 export 或手動代入。

!!! note "直連 postgres 而非 pgbouncer"
    遷移請走 `postgres` 容器。pgBouncer 為 transaction mode，不適合執行 DDL 批次。

### 備份

兩種做法：

**(a) 管理後台（推薦）** ——「備份與設定」（`/admin/system`）可勾選設定與憑證、PostgreSQL database、MinIO object storage，排入 `system_backup` 背景工作，產出的 ZIP 寫回 MinIO 的 `system-backups/` prefix，可從備份歷史下載。

**(b) 手動**：

```bash
# PostgreSQL（custom format，供 pg_restore 使用）
docker compose exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backup-$(date +%F).dump

# MinIO 物件（volume 層級）
docker run --rm -v taiwan-health-mcp_minio_data:/data -v "$PWD":/backup \
  alpine tar czf /backup/minio-$(date +%F).tar.gz -C /data .
```

> volume 名稱前綴為 compose 專案名（預設是目錄名），實際名稱以 `docker volume ls` 為準。

備份內含 API keys、登入憑證與醫療資料，**應視同 production secret 管理**。

### 對外埠與強化 { #external-ports }

`compose.yaml` 目前對主機發佈的埠：

| 服務 | 埠 | 綁定 | 正式環境建議 |
|------|-----|------|--------------|
| `nginx` | `${WEB_PORT}` → 80 | 全介面 | 前面加 TLS 反向代理 |
| `postgres` | `5432` | **全介面** | 改綁 `127.0.0.1:5432:5432` 或移除 |
| `minio` | `9000` | **全介面** | 改綁 `127.0.0.1:9000:9000` 或移除 |
| `minio` console | `9001` | `127.0.0.1` | 保持現狀 |
| `redis` | `6379` | `127.0.0.1` | 保持現狀 |
| `app` metrics | `${METRICS_PORT}` | `127.0.0.1` | 保持現狀 |

上線前的檢查清單：

- [ ] `POSTGRES_PASSWORD`、`ADMIN_SESSION_SECRET`、`FHIR_SERVER_SECRET_KEY` 皆為隨機強值
- [ ] MinIO 憑證已改掉 `minioadmin` 預設值
- [ ] `postgres:5432` / `minio:9000` 已改綁 `127.0.0.1` 或以防火牆阻擋
- [ ] `PUBLIC_TOOLS_AUTH_MODE=bearer` 並設定高熵 token（若 `/mcp` 對公網開放）
- [ ] TLS 已在前置 proxy 終止，且 `ADMIN_COOKIE_SECURE=true`
- [ ] `.env` 權限收斂（`chmod 600 .env`）且未進版控

用 `docker-compose.override.yml` 覆寫埠綁定，不必改動 `compose.yaml`：

```yaml
services:
  postgres:
    ports:
      - "127.0.0.1:5432:5432"
  minio:
    ports:
      - "127.0.0.1:9000:9000"
```

同一份 override 也適合放[資源限制](configuration.md#resource-limits)。

### 疑難排解

| 症狀 | 可能原因 | 處置 |
|------|----------|------|
| `docker compose up` 立刻失敗並提示 `POSTGRES_PASSWORD is required` | `.env` 未設定該變數 | 補上（compose 以 `:?` 強制要求） |
| `/admin` 回 404 | `ADMIN_ENABLED` 被設為 false | 改回 `true` 後 `docker compose up -d` |
| `/admin` 回 503 | 已啟用但認證變數不齊 | 看啟動日誌的 `missing` 欄位,補齊後重啟 |
| 管理後台密碼正確卻登入失敗 | `.env` 中的 `$` 未寫成 `$$`，雜湊被截斷 | 見 2-2 的警告框 |
| 改了 `.env` 的密碼卻沒生效 | 憑證在首次啟動即寫入 `admin.admin_credentials`，seed 為 `ON CONFLICT DO NOTHING` | 改到「帳號安全」（`/admin/security`）修改密碼 |
| worker 拋 `Illegal argument to function` / `Wrong key or corrupt data` | `FHIR_SERVER_SECRET_KEY` 為空或 `app` 與 worker 不一致 | 見 2-3 |
| 改了 `.env` 的 TFDA / registry 設定沒有效果 | 該群組為 seed-only，只在首次啟動讀取 | 改到「外部服務」（`/admin/integrations`） |
| 改了 `.env` 的 MinIO / worker 調校沒有效果 | seed-only，且後台為唯讀群組 | 直接 `UPDATE admin.app_settings` 後重啟服務（見 2-4） |
| 中文搜尋幾乎查不到結果 | 嵌入端點未設定，退回關鍵字模式 | 於「模型端點」（`/admin/models`）設定 embedding profile |
| IG 匯入時 worker OOM | `NODE_OPTIONS` 被調低，或容器記憶體上限不足 | 保留 `--max-old-space-size=8192`，容器上限給到 10G |
| `http://<host>:8000` 連不上 | 設計如此，`app` 不對主機開埠 | 一律使用 `http://<host>:${WEB_PORT}` |
| 改了工作 / 載入程式碼卻沒生效 | 只重建了 `app`，`admin-worker` 仍是舊映像 | `docker compose build admin-worker && docker compose up -d --no-deps admin-worker` |

---

## 隔離測試環境（staging）

`deploy/staging/compose.yaml` 是一套與正式環境完全隔離的 stack（compose 專案名 `twh-staging`）：自己的 Postgres、Redis、MinIO、`app`、`admin-worker` 與 `web-v2`；由 `web-v2` 容器直接擔任前門（其 nginx 以 `BACKEND_UPSTREAM` 代理後端），預設發佈在 `${STAGING_PORT:-8090}`，入口 `http://<host>:8090/admin/`。

啟動前需建立**不進版控**的 `deploy/staging/.env`，至少包含：

| 變數 | 用途 |
|------|------|
| `STAGING_DB_PASSWORD` | staging Postgres 密碼（未設定時 compose 直接失敗） |
| `STAGING_MINIO_PASSWORD` | staging MinIO root 密碼（未設定時 compose 直接失敗） |
| `STAGING_RESTORE_DIR` | 主機上放正式 DB dump 的目錄，唯讀掛載到 Postgres 的 `/restore`（未設定時 compose 直接失敗） |
| `STAGING_HOST` / `STAGING_PORT` | 選用；組出 `PUBLIC_BASE_URL`，預設埠 `8090` |

```bash
BUILD_SHA=$(git rev-parse --short HEAD) docker compose -p twh-staging -f deploy/staging/compose.yaml up -d --build
```

注意事項：

- `app` / `admin-worker` 另外讀取根目錄 `.env`（`env_file`），再以 staging 專屬值覆寫 DB / Redis / MinIO 連線。
- staging 走 http，因此設 `ADMIN_COOKIE_SECURE=false`，並使用自己的 cookie 名稱 `ADMIN_SESSION_COOKIE=tw_health_admin_session_staging`——cookie 依主機而非埠區分，與正式環境同機時，正式環境的 `Secure` cookie 會蓋掉同名 cookie，導致 staging 登入迴圈。
- Postgres 把主機目錄 `${STAGING_RESTORE_DIR}` 唯讀掛載為 `/restore`以便從正式 DB dump 還原；還原後應停用繼承來的工作 / 排程與模型端點，避免與正式環境搶用外部資源。

---

## 延伸閱讀

### [架構與容器部署](../architecture/deployment.md)
基礎設施拓樸、容器組成與啟動流程。

### [環境變數配置](configuration.md)
各項系統參數的完整清單，含 bootstrap 變數（`.env`）與 seed-only 設定（首次啟動後改於管理後台「外部服務」管理）。

### [效能與監控](performance.md)
高併發場景的優化建議、連線池與快取策略、Prometheus 監控。

!!! note "公開頁面已移出本專案"
    對外的宣傳頁與法務頁（`/`、`/status`、`/privacy`、`/dpa`）已改由獨立的宣傳網站專案提供，
    不再由本專案的前端服務發送。`/privacy` 是登記於 Anthropic Connectors Directory 的網址，
    移轉後務必在 `nginx/nginx.conf` 補上 301 導向（該檔已留有 TODO 區塊）。
