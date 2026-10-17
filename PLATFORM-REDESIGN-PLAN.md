# Taiwan Health MCP 平台重整規劃

> 日期：2026-10-15
> 範圍：模型閘道（Embedding / LLM）、管理後台前端重寫、模組資料生命週期、物件儲存由 MinIO 改為 RustFS
> 狀態：設計提案，待確認後分階段實作

---

## 0. 現況盤點（為什麼要改）

這份規劃建立在對現有程式碼的實際調查上，先列出會影響設計的事實。

### 0.1 模型設定

- `admin.llm_profiles` 一張表同時承載 embedding 與 analysis，一列 = 一個 provider 端點 + 一個模型。
- 策略（failover / weighted）存在 `admin.app_settings`，斷路器與 RPM/TPM 限流都是**程序內記憶體**，`app` 與 `admin-worker` 各算各的，兩個程序加起來會超過 provider 的真實限制。
- 線上資料庫目前有四個 embedding profile，模型字串分別是 `Qwen3-Embedding-0.6B-4bit-DWQ`（mlx）、`qwen3-embedding:0.6b-q8_0`（Ollama）、`Qwen/Qwen3-Embedding-0.6B`（SiliconFlow）、`Qwen3-Embedding-0.6B`（vLLM）。commit `78021e5` 的 `normalizeModelName()` 把它們視為同一模型，但 4-bit、8-bit 與 fp16 量化產生的向量**並不相同**，這正是使用者要求「必須完全一樣」的風險點。
- SiliconFlow profile 的 `base_url` 被填成 `…/v1/embeddings`，而嵌入 job 的連線探測固定打 `${base}/models`，所以探測到 `…/v1/embeddings/models` 得到 404，這是昨天 `snomed_embed` 連續 `embedding_unreachable` 的原因。SNOMED 嵌入目前停在 134,448 / 373,972。
- `rateLimiter.ts` 的 TPM 實作是每個 token 推一個時間戳，`waitUntilMs` 再用 `Math.min(...array)` 展開，高 TPM 時會 RangeError。
- `retryable_failed` 的 job 設了 `next_retry_at`，但 `claimNextJob` 只認領 `queued` 與 `paused + llm_unavailable`，所以不會自動重試。

### 0.2 前端

- Next.js 14 只用來掛一個 React Router SPA 加登入頁，`middleware.ts` 僅做 cookie 有無的檢查。
- 前端呼叫 `POST /admin/api/modules/{key}/clear`，**後端沒有這條路由**（`adminApp.ts` 只有 versions / schedule / preview）。這就是「刪除 Terminology 直接報錯」的根因。
- 嵌入資料與匯入資料沒有獨立的刪除動作：沒有任何程式碼會 `DELETE`/`TRUNCATE` 各模組的 `*_embeddings` 表；ICD / SNOMED 頁的 Clear 宣稱會連來源檔一起刪，但對應的 API 不存在。
- `deleteUploadedSource` 在模組已有資料且該檔曾啟用時直接拒絕刪除，使用者看到的也是錯誤訊息。
- 沒有前端測試，CI 也不跑任何測試。

### 0.3 物件儲存

- `minioService.ts`（233 行）是唯一的封裝層，對外只有 `uploadBytes` / `uploadStream` / `getObjectStream` / `downloadBytes` / `listObjects` / `removeObject` / `bucketExists+makeBucket`。
- presigned URL 目前**沒有**實作（`drugService.ts` 的 `presigned_url` 恆為 `null`，資產改走同源的 admin proxy）。
- 備份 job 用 `uploadStream` 串流 ZIP，依賴 SDK 內建的 multipart。
- 設定存在 `admin.app_settings` 的 `minio` group，`.env` 只做首次 seed。

---

## 1. 模型閘道（Model Gateway）

### 1.1 目標

把「設定一堆 profile 然後 failover」改成一個可組合、可視覺化、跨程序共享限流的閘道：

1. Provider 與 Model 分層：先設 provider，再從 provider 的模型清單挑一個模型組成 profile。
2. Embedding 全系統鎖定單一模型：系統一旦有任何嵌入資料，就只能加入向量**完全一致**的 profile；換模型必須走「全部重新嵌入」流程並明確警告。
3. 限流在 provider 與 profile 兩層都能設 RPM / TPM / 併發。
4. 積木式 group：profile 與 group 都可以是 group 的成員，group 之間再組 group，策略可選 load-balance 或 fallback。每個角色最終收斂成一個 root group，系統內部只對 root group 發請求。
5. 閘道在限制內可以盡量併發塞請求。
6. 後台有即時流量拓樸圖，看得到流量往哪個節點跑。
7. LLM 走同一套結構，但不做模型一致性鎖定。

### 1.2 資料模型

新 schema 放在 `admin`，以 migration `202610xx_model_gateway.sql` 新增並折回 `db/schema.sql`。

```sql
-- 一個可呼叫的模型伺服器
CREATE TABLE admin.model_providers (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    adapter       TEXT NOT NULL,                 -- 'openai' | 'ollama' | 'google' | 'siliconflow' | 'vllm'
    base_url      TEXT NOT NULL,
    api_key       TEXT NOT NULL DEFAULT '',      -- pgp_sym_encrypt with FHIR_SERVER_SECRET_KEY
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    limits        JSONB NOT NULL DEFAULT '{}',   -- {rpm, tpm, concurrency}
    model_catalog JSONB NOT NULL DEFAULT '[]',   -- cached /models result + fetched_at
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- provider × model = profile（閘道的葉節點）
CREATE TABLE admin.model_profiles (
    id            BIGSERIAL PRIMARY KEY,
    provider_id   BIGINT NOT NULL REFERENCES admin.model_providers(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('embedding', 'chat')),
    name          TEXT NOT NULL UNIQUE,
    model         TEXT NOT NULL,
    params        JSONB NOT NULL DEFAULT '{}',   -- embedding: {dimensions}; chat: {temperature, max_tokens, timeout_ms, max_token_budget}
    limits        JSONB NOT NULL DEFAULT '{}',   -- 覆寫 provider 的 {rpm, tpm, concurrency}
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    -- embedding 專用：一致性測試結果
    fingerprint   JSONB,                         -- {dimensions, vector_sha256, cosine_to_canonical, tested_at}
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 可巢狀的路由群組
CREATE TABLE admin.model_groups (
    id            BIGSERIAL PRIMARY KEY,
    role          TEXT NOT NULL CHECK (role IN ('embedding', 'chat')),
    name          TEXT NOT NULL UNIQUE,
    strategy      TEXT NOT NULL CHECK (strategy IN ('failover', 'weighted', 'round_robin')),
    is_root       BOOLEAN NOT NULL DEFAULT FALSE,
    limits        JSONB NOT NULL DEFAULT '{}',   -- 群組層級的總併發上限（選填）
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_model_groups_one_root ON admin.model_groups(role) WHERE is_root;

CREATE TABLE admin.model_group_members (
    group_id      BIGINT NOT NULL REFERENCES admin.model_groups(id) ON DELETE CASCADE,
    member_type   TEXT NOT NULL CHECK (member_type IN ('profile', 'group')),
    member_id     BIGINT NOT NULL,
    priority      INTEGER NOT NULL DEFAULT 100,  -- failover 順序
    weight        INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (group_id, member_type, member_id)
);

-- 全系統的 embedding 模型鎖
CREATE TABLE admin.embedding_lock (
    singleton     BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    dimensions    INTEGER NOT NULL,
    canonical     JSONB NOT NULL,                -- {test_texts_version, vectors_sha256[], locked_by_profile_id}
    locked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by     TEXT
);

-- 每次呼叫一列（短期保留），供拓樸圖與統計
CREATE TABLE admin.model_call_log (
    id            BIGSERIAL PRIMARY KEY,
    role          TEXT NOT NULL,
    profile_id    BIGINT,
    provider_id   BIGINT,
    route_path    BIGINT[] NOT NULL,             -- root → … → profile 的 group id 路徑
    status        TEXT NOT NULL,                 -- 'ok' | 'error' | 'rate_limited' | 'circuit_open'
    latency_ms    INTEGER,
    prompt_tokens INTEGER, completion_tokens INTEGER,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- admin.model_stats：由 model_call_log 彙總成每分鐘 bucket（取代 llm_profile_stats）
```

規則：

- group 成員加入時做循環檢查（DFS），禁止 A 包含 B 且 B 包含 A。
- 一個 role 恰好一個 `is_root` group；系統只向 root 發請求。
- embedding 的 group 與 profile 只接受 `fingerprint` 與 `embedding_lock` 相符的成員（見 1.4）。
- chat 的 group 成員不限模型，但 UI 顯示每個成員的模型與參數，避免誤用。

### 1.3 Provider 的模型清單

每個 adapter 實作 `listModels()`：

| adapter | 來源 |
|---------|------|
| openai / vllm / siliconflow | `GET {base}/models`（SiliconFlow 的 `/models` 在部分帳號不可用時，退回內建清單並標示「內建」）|
| ollama | `GET {base}/api/tags` |
| google | `GET /v1beta/models` 過濾 `embedContent` 能力 |

結果快取在 `model_providers.model_catalog`，UI 有「重新整理」按鈕。建立 profile 時模型欄位是從清單選，但允許手動輸入（清單 API 不可用時）。

### 1.4 Embedding 一致性與模型鎖

**系統內建測試文字**（放在 `node-server/src/gateway/canonicalTexts.ts`，版本化）：

```ts
export const CANONICAL_TEXTS_VERSION = 1;
export const CANONICAL_TEXTS = [
  "第2型糖尿病合併糖尿病腎病變",                 // zh-TW 臨床
  "Acetaminophen 500 mg film-coated tablet",     // 英文藥品
  "血清肌酸酐 Serum creatinine [Mass/volume] in Serum or Plasma",  // 混合
];
```

**一致性測試流程**（`POST /admin/api/gateway/profiles/{id}/test`）：

1. 以候選 profile 嵌入三段文字，取得向量。
2. 若 `embedding_lock` 不存在：測試只驗證連線與維度，結果存入 `fingerprint`。
3. 若存在：與 `canonical` 的向量比對。判定方式：
   - 維度必須相等。
   - 預設為 **bit-exact**：向量 float32 序列化後的 SHA-256 必須相同，符合「要完全一模一樣」的要求。
   - UI 同時顯示 cosine similarity；系統設定 `gateway.embedding_match_mode` 可切到 `tolerant`（cosine ≥ 0.9999 且維度相同），用於同一模型在不同推理引擎上有浮點誤差的情況。**預設 exact，由管理者有意識地放寬。**
4. 通過者 `fingerprint.matches_lock = true`，才可加入任何 embedding group。

> 註：目前線上的四個 profile 之中，4-bit DWQ、q8_0、fp16 彼此不會 bit-exact，甚至 cosine 也可能低於 0.9999。這套設計會把它們判定為「不同模型」，這是刻意的。

**鎖的建立與解除**：

- 第一次有任何 `*_embeddings` 表寫入前，閘道以當時 root group 內第一個通過測試的 profile 建立 `embedding_lock`。
- 鎖存在時，UI 在 Embedding 區塊頂端顯示「目前系統鎖定模型：{model} / {dims} 維，於 {date} 由 {profile} 建立」。
- 「切換模型」是獨立的 wizard，不是改個下拉選單：
  1. 選擇新的 profile 並通過連線測試。
  2. 顯示影響清單：每個模組的嵌入列數、預估重嵌時間（依最近一次 embed job 的吞吐估算）、期間語意搜尋會退化為 keyword-only。
  3. 要求輸入模組名稱或「RE-EMBED」確認字串。
  4. 送出後建立一個 `embedding_switch` job：TRUNCATE 所有 `*_embeddings`、必要時 ALTER 向量維度、重寫 `embedding_lock`、為每個已載入模組排入 `*_embed` job（依序或並行受閘道併發控制）。
  5. 完成前，Overview 顯示「嵌入重建中 x / y 模組」橫幅。

### 1.5 閘道執行期（`node-server/src/gateway/`）

```
gateway/
  index.ts              // getGateway(): 單例，app 與 worker 各一個
  topology.ts           // 從 DB 讀 providers/profiles/groups，建成樹，監聽設定變更（Redis pub/sub 通知重載）
  router.ts             // resolve(role) → 依策略展開成嘗試順序；weighted 抽籤、round_robin 計數器、failover 依 priority
  limiter.ts            // Redis Lua token bucket：rpm/tpm/concurrency，key = gw:{scope}:{id}；Redis 不可用時退回程序內實作
  breaker.ts            // 每個 profile 的斷路器（連續失敗 → 冷卻 → 半開試探），狀態也放 Redis 讓兩個程序共享
  adapters/
    openaiCompatible.ts // openai / vllm / siliconflow
    ollama.ts
    google.ts
  embed.ts              // gateway.embed(texts, {priority}) → number[][]
  chat.ts               // gateway.chat(messages, opts) → {content, usage}；沿用 analysisLlmClient 的 budget 升級與 transport retry
  callLog.ts            // 寫 model_call_log + 即時計數器（Redis INCR + /admin/ws 廣播）
```

關鍵行為：

- **admission 不丟錯而是等待**：限流滿了就 `await limiter.acquire()`，有上限等待時間（預設 60 秒）超過才拋 `GatewayBackpressure`。現在的做法是直接丟 `Rate limit` 錯誤讓 profile 進冷卻，會把健康的端點誤判為壞掉。
- **併發**：`concurrency` 是信號量，provider 與 profile 各一層，group 可選填總上限。嵌入 job 改成 `pLimit(gateway.capacity())` 的批次泵，持續把 batch 塞進閘道，直到限制飽和。
- **token 計數**：優先用回應的 `usage`，沒有時用 `tiktoken`-free 的字元估算（現在的 chars/10），並在 call log 標示 `tokens_estimated`。
- **跨程序一致**：限流與斷路器狀態放 Redis（已經在 stack 裡但閒置），key TTL 120 秒；Redis 斷線時退回程序內實作並記 warning。
- **熱重載**：任何 gateway 設定寫入後 `PUBLISH gw:reload`，兩個程序都重建拓樸，不用重啟。

### 1.6 即時流量視覺化

- 後端：`GET /admin/api/gateway/topology` 回傳節點（root group、子 group、profile、provider）與邊；`GET /admin/api/gateway/live` 回傳最近 60 秒每個節點的 req/min、tokens/min、p50/p95 延遲、錯誤率、限流命中、斷路器狀態；同時透過既有 `/admin/ws` 每 2 秒推一次增量。
- 前端：用 React Flow 畫有向圖，邊的粗細 = 請求流量，顏色 = 健康（綠 / 黃限流中 / 紅斷路）、節點顯示即時數字與迷你 sparkline。點節點開側欄看該節點的 call log、限流設定、最近錯誤。
- 歷史：`admin.model_stats` 每分鐘 bucket，保留 30 天，Dashboard 畫趨勢。

### 1.7 LLM（chat）角色的差異

- 不做 fingerprint 與 lock；profile 可以是不同模型。
- 保留 `analysisLlmClient.ts` 的 token budget 升級、reasoning 模型判斷、transport retry，搬進 `gateway/chat.ts`。
- `drugAnalysisService.ts` 改呼叫 `gateway.chat()`；`llm_call_log`（prompt / reply 稽核）維持不變。
- OCR（MinerU）不是模型 profile，維持在 Integrations 設定。

### 1.8 遷移

- migration 把每個 `llm_profiles` 列拆成 provider（以 base_url + api_key 去重）與 profile，並為兩個 role 各建一個 root `failover` group 包含全部啟用的 profile。
- embedding 的 lock 在遷移時**不自動建立**：遷移後 UI 要求管理者跑一次一致性測試並選定鎖定模型（因為現有 profile 彼此不一致）。
- `llm_profiles`、`llm_profile_stats` 保留一個版本後移除；Settings 的 Export / Import 格式升級為 v2。

### 1.9 API

```
GET/POST           /admin/api/gateway/providers
GET/PATCH/DELETE   /admin/api/gateway/providers/{id}
POST               /admin/api/gateway/providers/{id}/models        # 重新抓模型清單
GET/POST           /admin/api/gateway/profiles
GET/PATCH/DELETE   /admin/api/gateway/profiles/{id}
POST               /admin/api/gateway/profiles/{id}/test           # 連線 + 一致性測試
GET/POST           /admin/api/gateway/groups
GET/PATCH/DELETE   /admin/api/gateway/groups/{id}
PUT                /admin/api/gateway/groups/{id}/members           # 整組取代，附循環檢查
GET                /admin/api/gateway/embedding-lock
POST               /admin/api/gateway/embedding-lock/switch        # 建立 embedding_switch job
GET                /admin/api/gateway/topology
GET                /admin/api/gateway/live
GET                /admin/api/gateway/calls?profile_id=&since=      # call log 查詢
```

所有寫入都進 `admin.admin_audit_log`，api_key 永不回傳（沿用 `has_api_key`）。

---

## 2. 管理後台前端重寫

### 2.1 技術選型（建議）

| 項目 | 選擇 | 理由 |
|------|------|------|
| 建置 | Vite + React 19 + TypeScript | 不需要 SSR；靜態輸出讓 nginx 直接服務，`web` 容器可以移除 |
| 路由 | TanStack Router | 型別安全的路徑與 search params，巢狀 layout，深連結友善 |
| 資料 | TanStack Query（沿用）+ WebSocket 失效化（沿用概念重寫） | 已驗證的模式 |
| UI 元件 | Mantine v7 | 完整的表格、表單、Modal、Notification、Stepper、暗色模式，不需要再寫一套 CSS；醫院後台重功能一致性 |
| 表格 | Mantine DataTable 或 TanStack Table | 排序、分頁、欄位隱藏、虛擬捲動（SNOMED 預覽） |
| 表單 | react-hook-form + zod | 與後端 zod schema 共用一份，型別與驗證不再漂移 |
| 圖表 | ECharts（趨勢） + React Flow（拓樸） | |
| i18n | i18next，zh-TW 預設、en 備用 | 文件網站已經雙語，後台也該雙語 |
| 測試 | Vitest + Testing Library；Playwright e2e | CI 跑 typecheck、unit、e2e |

若你偏好 Tailwind 生態，替代方案是 shadcn/ui + Tailwind v4，代價是 Modal / Table / Notification 都要自己組。**我的建議是 Mantine。**

### 2.2 部署形態

- `web/` 目錄砍掉 Next.js，改為 Vite 專案，`npm run build` 產出 `dist/`。
- nginx 直接以 `root` 服務 `/admin`（SPA fallback 到 `index.html`），`web` 容器與 `BACKEND_INTERNAL_URL` 消失。
- 登入頁併入 SPA；未登入由 `GET /admin/api/me` 回 401 觸發導向，後端本來就是唯一權威，Next middleware 的 cookie 檢查沒有安全價值。
- 開發：`vite dev` 以 proxy 把 `/admin/api`、`/admin/ws` 轉到 `app`。

### 2.3 資訊架構（從需求端重畫）

```
/admin
├─ Dashboard          系統健康、模組狀態卡（資料 / 嵌入 / 工具是否註冊）、worker、最近 job、閘道流量 sparkline、告警
├─ Data
│  ├─ Terminologies   ICD-10 / LOINC / SNOMED CT / RxNorm / FHIR IG
│  │   每個模組頁固定五個區塊（見 2.4）
│  ├─ Taiwan FDA      藥品（索引 / 豐富 / 分析 / Explorer）、健康補充品、食品營養
│  └─ Schedules       所有模組排程一覽
├─ Jobs               佇列、篩選、詳情（步驟時間軸、日誌、checkpoint）、重試 / 暫停 / 停止
├─ Model Gateway
│  ├─ Providers
│  ├─ Profiles        含一致性測試結果
│  ├─ Groups          拖拉組合 group，策略與權重
│  ├─ Embedding Lock  目前鎖定模型、切換 wizard
│  └─ Traffic         即時拓樸圖 + 歷史趨勢
├─ Integrations       Object storage（RustFS）、OCR（MinerU）、FHIR Servers、TFDA crawler
├─ Security           帳號密碼、Passkeys、Session、稽核日誌、公開工具面 auth 狀態
└─ System             備份 / 還原、設定匯出匯入、worker 調校、版本資訊
```

### 2.4 模組頁的資料生命週期（解決「只想刪嵌入」）

每個 terminology 模組頁有五個獨立區塊，每個區塊有自己的狀態與動作：

| 區塊 | 顯示 | 動作 |
|------|------|------|
| Sources | 已上傳檔案、版本、啟用中的版本、SHA | 上傳、啟用 / 停用版本、**刪除檔案**（已匯入的也可刪，只提示「資料仍在，之後無法重新匯入除非再上傳」） |
| Imported data | 列數、最後匯入時間、來源版本、預覽 | 匯入 / 重新匯入、**清除匯入資料**（連帶清除嵌入，因為嵌入依附資料；提示會一起清） |
| Embeddings | 覆蓋率 x / y、最後執行、是否過時、鎖定模型 | 建立 / 續跑、**僅清除嵌入**（保留資料與來源檔）、重建 |
| Schedule | 下次執行、歷史 | 編輯、立即執行 |
| Maintenance | 維護模式開關、工具註冊狀態 | 開關 |

後端對應：

```
POST /admin/api/modules/{key}/clear   body: { scope: "embeddings" | "data" | "sources" | "all", confirm: "<module key>" }
```

實作為 `module_clear` job（走 worker，受模組的 `db_write_<module>` 資源槽位保護，避免與匯入並行），步驟：

- `embeddings`：`TRUNCATE <module>.*_embeddings`，重設 `module_embed_log`。
- `data`：既有 loader 的 truncate SQL + 上一項 + 重設 `module_load_log`，`moduleStatus` 自動下架工具。
- `sources`：刪 `module_sources` / `uploaded_files` 與物件。
- `all`：以上全部。

每一個都寫 `admin_audit_log` 並要求輸入確認字串。藥品模組的 scope 另有 `assets`（MinIO 物件）與 `analysis`（OCR / LLM 結果），之後細化。

### 2.5 設計方向

- 色彩：中性灰底、單一品牌色（建議深青 teal）做主動作，狀態色只用於狀態（成功綠 / 警告琥珀 / 錯誤紅 / 進行中藍），不拿來裝飾。
- 版面：固定左側導覽 240px，內容最大寬 1280px，窄螢幕導覽收合為 drawer；所有表格在容器內水平捲動，頁面本身永不橫向捲。
- 密度：後台以資訊密度優先，行高 1.4、表格列高 36px，可切 comfortable / compact。
- 一致的危險操作模式：紅色按鈕 → Modal 列出影響 → 輸入確認字串 → 執行 → toast + 稽核紀錄。
- 長任務一律顯示在 Jobs，頁面上只放「已排入」連結與即時進度條，不做假的同步等待。
- 所有錯誤訊息要有「下一步」：例如嵌入探測失敗要顯示實際打的 URL 與 HTTP 狀態（現在只有 `siliconflow: HTTP 404`，看不出是 base_url 多了 `/embeddings`）。

### 2.6 QA 方式

- 開發中用 Playwright MCP 做探索性 QA：每完成一個頁面就以瀏覽器實際操作一輪（上傳、匯入、清除嵌入、切換 group、看拓樸圖），截圖留存到 `web/qa/`。
- 腳本化 e2e 放 `web/e2e/`，以 docker compose 起一套測試 stack（小型資料集：ICD 1k 列、LOINC 1k 列），在 GitHub Actions 跑。
- 本機 Playwright MCP 設定已改為 `--browser chromium`（原本指向未安裝的 Chrome），下次 session 生效。

---

## 3. 物件儲存：MinIO → RustFS

### 3.1 判斷

RustFS 是 Apache 2.0 的 S3 相容物件儲存，支援 multipart、presigned URL、SigV4，有 Docker 映像與 MinIO 遷移路徑；但它仍年輕，大檔讀取效能與穩定性的第三方驗證有限。對本專案而言風險可控，原因是：

- 我們只用最基本的 S3 操作（put / get / list / delete / bucket）。
- 唯一的封裝層是 `minioService.ts`，替換範圍小。
- 備份 job 已經是串流 multipart，正好是要驗證的重點。

### 3.2 作法

1. **SDK 改為 AWS SDK v3**（`@aws-sdk/client-s3` + `@aws-sdk/lib-storage`），不再依賴 `minio` npm 套件；`uploadStream` 用 `Upload` 做 multipart，`listObjects` 用 `ListObjectsV2` 分頁（目前的 `listObjects` 沒分頁）。保留 `objectStorageService.ts` 的既有函式簽名，呼叫端零改動。
2. 設定群組 `minio` 改名 `object_storage`，key：`endpoint`、`region`（預設 `us-east-1`）、`access_key`、`secret_key`、`bucket`、`force_path_style`（預設 true）、`secure`。seed 來源 `.env` 改為 `S3_*`，向下相容讀 `MINIO_*` 一個版本。
3. compose：`minio` + `minio-init` 換成 `rustfs/rustfs:<pinned>`，port 9000（API）/ 9001（console，綁 127.0.0.1），volume `rustfs_data`；bucket 由 app 啟動時 `CreateBucket` 建立（現在就是這樣做），不需要 init 容器。
4. `drug.*.minio_uri` 欄位值 `minio://bucket/key` 改為 `s3://bucket/key`，migration 一次 `UPDATE`；程式讀取兩種前綴。
5. **資料搬遷**：MinIO 與 RustFS 並行一段時間，用 `rclone sync`（或 `mc mirror`）把 bucket 複製過去，比對物件數與 ETag 後切換 `object_storage.endpoint`，熱重載即可。不走 RustFS 宣稱的「二進位直接取代、沿用磁碟格式」路徑，那是 alpha 功能。
6. 驗證清單：上傳 1 GB SNOMED zip（multipart）、備份 job 產出 ZIP 並能下載還原、藥品資產上傳與 Explorer 讀取、刪除物件、分頁列出 10k+ 物件。
7. Integrations 頁顯示 RustFS 健康（`HEAD bucket`）、容量、物件數，與一鍵「測試連線」。

---

## 4. 一併處理的既有缺陷

這些在重整前就該修，大多是小改：

| 問題 | 修法 |
|------|------|
| `POST /admin/api/modules/{key}/clear` 不存在 | 併入 2.4 的 `module_clear` job |
| 嵌入探測對 `…/v1/embeddings` 打 `/models` 得 404 | profile 建立時正規化 base_url（去掉 `/embeddings`、`/chat/completions` 尾段），探測失敗訊息帶完整 URL |
| `retryable_failed` 不會自動重試 | `claimNextJob` 增加 `status = 'retryable_failed' AND next_retry_at <= NOW() AND attempt_count < max_attempts` 分支；`max_attempts` 預設 5 存 `job_options` |
| rateLimiter TPM 每 token 一筆 + `Math.min(...spread)` | 由 1.5 的 Redis token bucket 取代 |
| SiliconFlow timeout 不重試（訊息比對 `timeout` 不符 AbortError） | 閘道統一以 `err.name === 'AbortError'` 判斷 |
| `normalizeModelName` 把不同量化視為同模型 | 由 1.4 的 fingerprint 取代，刪除 `normalizeModelName` |
| `deleteUploadedSource` 對已匯入檔案直接報錯 | 改為允許並提示（2.4） |
| 文件：管理後台「預設停用」、job 型別名稱過時、根目錄三份 md 不在文件網站 | 重整完成後統一更新 `docs/`（雙語）並移除根目錄的 SILICONFLOW_* / JOB_INTEGRITY_* |

---

## 5. 實施順序

| 階段 | 內容 | 相依 | 估計 |
|------|------|------|------|
| P0 立即修補 | 第 4 節的 clear 路由（暫以同步 API 實作）、base_url 正規化、retryable_failed 認領 | 無 | 1 到 2 天 |
| P1 物件儲存 | `objectStorageService.ts`（AWS SDK）、設定群組改名、compose 改 RustFS、rclone 搬遷、驗證清單 | 無 | 2 到 3 天 |
| P2 閘道後端 | schema + migration、`gateway/` 執行期、Redis 限流、call log、API、遷移舊 profile；舊前端以相容層暫時可用 | P0 | 1.5 到 2 週 |
| P3 新前端 | Vite 專案骨架、設計 token、Dashboard / Data / Jobs / Gateway / Integrations / Security / System 逐頁實作，每頁配 Playwright MCP 探索 QA 與 e2e | P1、P2 的 API | 3 到 4 週 |
| P4 切換與收尾 | nginx 改靜態服務、移除 `web` 容器與 Next.js、移除 `llm_profiles`、docs 雙語更新、CI 加 typecheck / test / e2e | P3 | 3 到 5 天 |

每個階段獨立可部署，P1 與 P2 可以並行。

---

## 6. 需要你拍板的決定

1. **Embedding 一致性判定**：預設 bit-exact，提供 tolerant 模式由管理者放寬。這會讓你現有的 mlx / Ollama / vLLM / SiliconFlow 四個端點被判定為不同模型，需要選一個當鎖定模型並重嵌。接受嗎？
2. **UI 元件庫**：Mantine（建議）或 shadcn/ui + Tailwind。
3. **移除 `web` 容器**：改為 nginx 直接服務 Vite 靜態輸出。
4. **RustFS 版本**：先在測試環境以最新 stable tag 驗證第 3.2 節清單，再決定正式版本。
5. **後台語言**：zh-TW 為主、en 為輔（與文件網站一致）。
6. **流量圖的參考對象**：我把「像 9Roacher 一樣」理解為 Kiali / Grafana node graph 那種即時拓樸流量圖。如果你指的是別的工具，請告訴我名稱。
