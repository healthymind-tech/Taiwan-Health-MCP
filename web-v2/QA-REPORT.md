# 管理控制台 v2：交付與 QA 報告（2026-10-15）

## 怎麼看

| 項目 | 位置 |
|------|------|
| 新版控制台（隔離的 staging） | `http://<主機>:8090/admin/`，帳號 `admin` / 密碼 `admin`（沿用正式環境的帳號資料） |
| 正式環境（未動） | `http://<主機>:8080/admin/`，所有容器、資料庫、MinIO 都沒有被改動 |
| 前端原始碼 | `web-v2/`（分支 `feature/admin-ui-v2`，尚未 commit） |
| staging 設定 | `deploy/staging/compose.yaml`（compose project `twh-staging`） |
| QA 截圖 | `web-v2/qa/`（`crawl/` 是全頁面巡檢，桌機 1440 與手機 390 寬，含深色模式） |

staging 是正式資料庫的複本（2026-10-15 凌晨 dump），因此可以安全測試刪除、清除等破壞性操作。
為避免影響正式環境，複本已做以下處理：停止繼承來的工作與排程、刪除 FHIR OAuth token、**停用全部模型端點**
（所以畫面上會看到「嵌入服務無法連線」，這是預期的）。MinIO 只鏡像了來源檔、IG 套件與 150 張藥證的仿單與圖片，
其他藥證的圖片在 staging 會顯示「檔案不存在於物件儲存」。

## 做了什麼

**全新前端**（`web-v2/`，約 2.3 萬行 TypeScript）：Vite 7 + React 19 + Mantine 8 + TanStack Query + react-router 7。
沒有使用任何瀏覽器原生表單元件；所有確認視窗、下拉選單、勾選框、上傳區都是自訂元件。
全頁 RWD（手機寬 390 無水平捲動）、淺色 / 深色模式、Ctrl+K 頁面搜尋、WebSocket 即時更新。

| 區塊 | 頁面 |
|------|------|
| 總覽 | 儀表板（需要注意的項目、模組狀態、工作、基礎設施）、背景工作列表、工作詳情（進度、預估剩餘時間、步驟時間軸、即時日誌、暫停 / 停止 / 重新開始） |
| 醫療術語 | ICD-10、LOINC、SNOMED CT、RxNorm：來源檔 → 匯入 → 向量嵌入三段生命週期，資料預覽、排程（台灣時間）、維護標示、危險操作；FHIR IG 套件庫（Registry 搜尋安裝、上傳、相依樹、構件瀏覽） |
| 食藥署 | 藥品管線控制台、藥品瀏覽器（篩選全部存在網址列）、藥品詳情（結構化分析、仿單 PDF / 圖片檢視、處理歷程、LLM 呼叫紀錄）、健康食品、食品營養 |
| 整合 | 模型端點（Embedding / 分析 LLM、流量走向圖）、外部服務設定（含 OCR 測試）、FHIR 伺服器（四步驟精靈、能力聲明、OAuth、請求主控台） |
| 系統 | 服務健康探測、系統備份與設定匯出入、密碼與通行金鑰 |

**你提到的問題**

- **刪除 Terminology 會報錯** → 修好了。原因有兩個：前端呼叫的 `POST /admin/api/modules/{key}/clear` 後端根本不存在；
  另外 `import_jobs` 以 FK（NO ACTION）參照來源檔，只要檔案曾被匯入過，刪除就會 500。
- **只想刪向量、不刪匯入資料** → 新增了。每個模組可以分別「只清除向量嵌入」「清除匯入資料」「只刪除來源檔」「全部清除」，
  每個動作都會先顯示實際要刪的筆數，並要求輸入模組代碼確認。已在 staging 實測：清除 ICD 向量後 46,498 筆向量歸零、
  125,446 筆診斷碼完整保留。

## 後端變更（只部署在 staging，正式環境未套用）

| 變更 | 檔案 |
|------|------|
| 新增 `GET/POST /admin/api/modules/{key}/clear`（範圍：embeddings / data / sources / all） | `node-server/src/admin/adminModuleClear.ts`、`adminApp.ts` |
| 刪除來源檔：先解除 `import_jobs` 的參照；只在有匯入工作進行中才拒絕 | `adminSources.ts` |
| 新增 `GET /admin/api/me`（顯示登入者）；`GET /admin/api/jobs?limit=`（上限 500） | `adminApp.ts` |
| 物件不存在時藥品資產回 404 而不是 500 | `adminApp.ts` |
| **修正：更新授權碼模式（IUA / SMART）的 FHIR 伺服器時會清掉已存的 client secret**（連切換啟用都會） | `adminFhirServers.ts` |
| 修正：FHIR 回應超過 30 萬字元就不解析，導致 HAPI 這類大型伺服器沒有能力聲明 | `adminFhirServers.ts` |
| 修正：請求主控台的 Content-Type 大小寫判斷會送出重複標頭 | `adminFhirServers.ts` |
| OAuth callback 導回 `/admin/fhir-servers`（新版路徑） | `server.ts` |

`npm run typecheck` 與 `npm test`（81 個）皆通過。

## QA 怎麼做的

1. 腳本化巡檢：26 個路由 × 桌機 / 手機，另含深色模式，記錄 console 錯誤、例外、失敗的 API、水平溢出與殘留骨架。
   最終結果只剩 staging 缺圖造成的預期 404。
2. 實際操作流程（Playwright）：登入、清除向量、刪除來源檔（含被工作參照的檔案）、上傳缺少的 LOINC 對照檔、
   觸發匯入並看即時進度（匯入成功）、建立 FHIR 伺服器（連 HAPI 公開測試伺服器、測試、儲存、探測、主控台）。
3. QA 中發現並已修正的前端問題：側欄品牌遮住搜尋框、toast 內的連結因為不在 router 內導致整頁崩潰、
   清除後覆蓋率延遲更新、重新整理按鈕每 3 秒閃爍、手機日誌太擠、IG 預設卡片字過大、
   未存變更提示攔不到瀏覽器「上一頁」（改用 data router + `useBlocker`）、維護模式文案不實。

## 發現但沒有改的後端問題（需要你決定）

1. **維護模式對 MCP 沒有作用**：只有管理後台讀這個旗標，MCP 工具照常回應。UI 已改為誠實說明。
2. **「設為使用中」對下次匯入沒有作用**：`resolveJobSourceManifest` 取的是最新上傳的檔案，不看哪個是使用中（`adminJobs.ts` 約 790 行）。
3. **藥品自動串接會清空整個佇列**：即使只處理一張藥證，成功後也會一直串下一批 200 張直到沒有待處理（`maybeAutoChain`）。
4. **排程的藥品與 IG 匯入不會成功**：排程建立的工作沒有帶下載的檔案 ID / object key（`adminSchedule.ts` 約 381 行）。
5. **Embedding 一致性檢查太寬鬆**：`normalizeModelName` 會把 0.6B 與 8B、不同量化視為同一模型。
6. **TPM 限流實作在高數值下會出錯**（`rateLimiter.ts`），且 app 與 worker 各自計算。
7. **設定匯入不是原子操作**：設定群組先寫入，模型端點驗證失敗時已部分套用。
8. **登出或改密碼不會讓其他裝置的 session 失效**（無狀態 cookie）。
9. `retryable_failed` 的工作不會自動重試（`claimNextJob` 不認領這個狀態）。
10. `db/schema.sql` 宣告 `import_jobs` 的 FK 為 `ON DELETE SET NULL`，正式資料庫卻是 `NO ACTION`（migration 漂移）。

這些多數已寫在昨天的 `PLATFORM-REDESIGN-PLAN.md`，模型閘道重構時會一併處理。

## 上線到正式環境的步驟

見 `web-v2/README.md` 的「切換正式環境」。簡單說：部署本分支的後端變更 → 讓 nginx 把 `/admin` 導向 `web-v2` → 移除舊的 `web/`。

## 環境上的變動

- 為了讓 Playwright MCP 能用，建立了 `/opt/google/chrome → ~/.cache/ms-playwright/chromium-1228/chrome-linux64` 的 symlink（`sudo rm /opt/google/chrome` 可移除），
  並在 `~/.claude.json` 的 playwright 參數加了 `--browser chromium`（原檔備份在 `~/.claude.json.bak-*`）。
- staging 的資料在 `/home/brian/twh-staging-data/`（DB dump 約 1.5 GB）。不需要時：
  `docker compose -f deploy/staging/compose.yaml down -v` 並刪除該目錄。

## 2026-10-15 補記：用 IP 存取時登入後被導回登入頁

- 原因：`.env` 的 `PUBLIC_BASE_URL` 是 https，後端因此送出帶 `Secure` 的 session cookie；staging 走 http + IP，
  瀏覽器直接丟棄 cookie。先前 QA 都走 `localhost`（Chrome 視為安全來源，會接受 Secure cookie），所以沒測出來。
- 修正：`deploy/staging/compose.yaml` 對 staging 設定 `ADMIN_COOKIE_SECURE=false`、`PUBLIC_BASE_URL=http://<staging-host>:8090`；
  `web-v2/nginx.conf.template` 加 `absolute_redirect off`（原本 `/admin` 轉址會掉 port 8090）。
- 驗證：以實際 IP `http://<staging-host>:8090` 用瀏覽器登入、重新整理、切換頁面皆維持登入。
- 注意：通行金鑰（WebAuthn）需要 https，staging 的 http 環境無法註冊或使用，請用密碼登入。

## 2026-10-15 補記：醫療術語總覽頁、外觀三選一

- 側欄重整：「資料」（醫療術語、藥品、健康食品、食品營養）、「FHIR」（IG 套件庫、FHIR 伺服器）。
- 新增 `/terminology` 總覽：每個術語一列（狀態、資料筆數、向量覆蓋率、上次匯入、排程、進行中工作），
  需要處理的排最前面，可篩選與搜尋；點選進入 `/terminology/<key>`。術語清單由 `lib/meta.ts` 的 `MODULES` 產生，
  新增術語不需改選單。個別術語可用 Ctrl+K 直接跳轉。
- 舊網址自動轉址：`/data/icd` → `/terminology/icd`、`/data/ig` → `/fhir/ig`；健康食品與食品營養維持 `/data/<key>`。
- 外觀選單：淺色 / 深色 / 跟隨系統，預設跟隨系統（登入頁也有）。
- QA（實際 IP、桌機 / 手機 / 深色）：無錯誤、無水平溢出；三種外觀切換、重新整理後保留、跟隨系統時隨 OS 即時切換皆驗證。

## 2026-10-15 — IG import stack overflow, provider registry

**IG import "Maximum call stack size exceeded" (old + new UI).**
- Cause 1: `concepts.push(...pp.concepts)` spread a package's concepts as call arguments; twcore 0.3.2 alone has ~837k (V8 overflows past ~120k). Same pattern fixed in `rateLimiter` (TPM `Math.min(...)`), FHIR ValueSet expansion, preview and validator (`arrayUtils.pushAll/minOf`).
- Cause 2 (hidden behind 1): every resource was parsed and held at once, and the worker staged the whole dependency closure in memory → heap OOM at 4 GB. Now resources are parsed one at a time and the worker stages one package at a time (checkpoint per package).
- Verified on staging with the real registry: `tw.gov.mohw.nhi.pas` (53 packages) imported — 1,026,477 concepts, 11,186 CodeSystems, 83,478 artifacts; peak heap ~1.4 GB. Regression test `loaders/ig.test.ts` (300k-concept tgz).

**Provider registry (Models page).** 23 providers, each adapter written from the vendor's official docs (`node-server/src/providers/`). `openai` = official API only (URL locked); self-hosted is `openai_compatible` or `ollama`. Existing rows migrated by `db/migrations/20261015_llm_provider_registry.sql` (applied on staging). Form is rendered from `GET /admin/api/llm-providers`. Browser QA over http://<staging-host>:8090 (desktop light/dark, 390 px): grouped provider picker, fixed/region URLs, per-provider knobs, validation, edit, test — no console errors, no horizontal scroll. Live checks: all 3 staging embedding endpoints test OK through adapters, model listing OK, semantic search OK.

## 2026-10-15 — Provider accounts + composable Profiles (9Router-style)

- Data model: `admin.llm_providers` (named accounts, several per provider type), `admin.llm_routes` + `admin.llm_route_members` (profiles: single / fallback / round_robin / load_balance; members = account+model with knobs, or another profile), `admin.llm_role_routes`. Migration `db/migrations/20261016_llm_providers_and_routes.sql` converts the old per-endpoint rows (dry-run on a copy, then applied on staging). Settings export v3 (`llm`), v2 files still import.
- Runtime: profiles expand to the flat candidate list every caller already used; loops are rejected on save (with the path) and guarded at runtime; embedding profiles must share one base model + dimensions.
- UI (`/models`): 總覽 (role → profile, animated flow) · Provider 帳號 (card wall, 3-step wizard with live model list) · Profiles (block builder: palette → drag/+ → sortable members with weights/knobs/per-model test; live animated preview; 試跑 highlights the path taken).
- Browser QA over http://<staging-host>:8090 (desktop light/dark, 390 px): wizard (Ollama → test → 4 models → save), builder (+, drag-in, nest, load-balance 3/1/0 → 75%/25%/backup, save, test run answered by qwen3:8b in 26.8 s with path highlight), no console errors, no page horizontal scroll. API: loop / mixed-embedding / wrong-role rejected; delete-in-use blocked. 198 backend tests.
- Subscription logins: Claude Pro/Max not implemented (prohibited by Anthropic, blocked server-side since 2026-01); OpenAI "Sign in with ChatGPT" pending a decision (preview, consumer data terms, 127.0.0.1 callback).

## 2026-10-15 — Sign in with ChatGPT (OpenAI official SIWC, preview)

- Provider `chatgpt` (category 訂閱帳號登入): official flow only — `dynamic_agent_client` registration, PKCE S256, `ext_agent_host_id` per install, loopback redirect `http://127.0.0.1:1455/auth/callback` with paste-back (server is remote), RS256 ID-token verification against OpenAI JWKS, `chatgpt.tokens.use.direct` required; inference `POST /v1/responses` (`store:false`, `stream:true`, success only on `response.completed`). Refresh serialized with a row lock (rotating refresh tokens; app + worker are separate processes); terminal refresh errors mark the account "需重新登入".
- Guardrails: 4 terms must be ticked before sign-in; tokens never leave the server (not in API responses, not in settings export); subscription accounts don't serve role traffic unless "允許角色正式使用" is on; API-key creation for this provider is refused.
- Claude Pro/Max subscription login: not implemented (Anthropic prohibits third-party use of Claude.ai credentials and blocks it server-side; would require impersonating Claude Code). The Anthropic account form points to the Max/Team monthly API credits instead.
- QA: authorize URL params verified; the real sign-in page sits behind Cloudflare bot checks so headless Chrome cannot complete it — needs one manual sign-in. UI flow (terms gate, popup, paste validation, localized errors) checked desktop + mobile dark. 203 backend tests (ID token: signature/aud/nonce/exp/issuer/tamper).

## 2026-10-15 — Embedding fingerprint (one model system-wide)

- `admin/embeddingIdentity.ts`: 6 fixed probe texts embedded by the system's model = identity (versioned). Any embedding endpoint must reproduce them (per-probe cosine ≥ 0.95) to join a profile or serve the role; verdicts cached per (account, model, dims, identity version). Bootstrap: with vectors present, the identity is taken from the model currently serving the role; with none, from the first model saved. Calibration on real endpoints: same model on Ollama q8 vs SiliconFlow 0.9993–0.9996; Qwen3-Embedding-4B@1024 ≈ −0.02.
- Switch (`POST /admin/api/llm/embedding/switch`, REINDEX confirmation when vectors exist): shut role → cancel/wait embed jobs → TRUNCATE 6 vector tables → adopt identity + bind new single-model profile → reopen → (after flag TTL) queue re-index per module. Failure reopens the role.
- Staging QA: identity bootstrapped (qwen3-embedding:0.6b-q8_0, 1024, 525,123 vectors); same model "不需要切換"; different model blocked from profiles and shows the re-index warning; unreachable endpoints show 連不上 instead of erroring; in-service models tolerated when down. The destructive switch itself was NOT executed on staging (would wipe 525k vectors). 206 backend tests.

## 2026-10-15 — Deleting a referenced profile

- `GET /admin/api/llm/routes/:id/impact` → plan: profiles that lose the member (modified), profiles left empty and deleted too (cascade, recursive upward), roles bound to a deleted profile (unbound — service stops), roles whose tree contains it (path changes), child profiles kept. Delete (`POST …/delete` / `DELETE`) with impact requires the profile name as confirmation; references removed, cascade deleted, roles unbound in one transaction, positions renumbered, audit-logged.
- UI: delete modal shows the plan grouped (服務中斷 / 一併刪除 / 會被修改 / 路徑改變 / 保留) with type-the-name confirmation. Staging QA: QA-A ⊂ QA-B (only member) and QA-C (+model) → deleting QA-A deleted QA-B, left QA-C with 1 member; bound default profile shows 角色會中斷 (not deleted). 208 backend tests incl. pure plan tests.

## 2026-10-16 — Models page: browser-QA fixes + LLM API hardening

**UI fixes** (browser QA on staging :8090, desktop 1440 + mobile 390 touch; screenshots `/tmp/claude-1000/qa-ui-fix/`):
- Errors in 繁體中文: backend responses carry `code` + `params` (`admin/llmErrorCodes.ts`, attached in `adminLlmApi.ts`, settings import); the console translates them (`pages/models/llmErrors.ts`, also used by ChatgptConnect), falling back to known phrasings, then the raw text. Messages point at the real 「切換模型…」 button; same model with other dims now says exactly that. Verified: dims-mismatch save → 「…向量維度是 768，系統…是 1024 維，不能加入…」; badge 「維度不符」 + 中文 tooltip; simulated 400 `invalid_url` → 中文.
- Mobile switch modal: account Select now taps/selects normally (dropdown `strategy: fixed`; the absolute dropdown was widening the viewport 390↔553 and closing itself). Doc width stays 390 while open.
- Mobile builder: settings scroll with the content, strategy is a Select, pane switcher is sticky; fixed header 380 px → 53 px.
- Account wizard: server-rejection alert clears on edit/test; client-side http(s) URL check on blur (Next disabled); empty name shows a field error; mobile stepper one row (34 px); the wizard's successful test is saved with a new account (card shows 「連線正常・4 個模型」 instead of 「尚未測試」).
- Esc on the unsaved-changes confirm closes only the confirm (wizard + builder); confirm close button is named 「關閉」.
- SystemMap: focus dimming cleared on blur; role nodes toggle a pinned highlight (aria-pressed).
- Builder preview: compact flow fits the column on desktop (no clipping), scrolls on phones with an edge fade + 「左右滑動」 hint; source ripple no longer cut off.
- Monospace only on input text (label/description/error keep UI font). Palette rows: drag handle is a separate button (no nested interactive elements). Same child profile cannot be added twice (palette shows 已加入; server rejects `member_duplicate_profile`). In-use account delete: button disabled, no type-to-confirm; profile cascade notify reads 「已刪除「QA-UIFIX-C」，連同「QA-UIFIX-P」」.

**API hardening** (`llmRouting.ts`, `adminLlmApi.ts`, `adminSettings.ts`, `embeddingIdentity.ts`, `providers/registry.ts`):
- Settings import validated in full first (virtual graph + fingerprint, endpoints already serving are not re-probed), then written in ONE transaction; a bad document changes nothing and returns 400. Subscription (OAuth) accounts are kept, with their members put back into the same-named profile.
- `/accounts/test` with an `id` but another provider/URL gets no stored key and does not overwrite that account's `last_test`. Fixed-URL providers (openai, anthropic, …) ignore a typed URL; "openai + own URL → openai_compatible" only for v2 imports.
- 400 instead of 500/accepted: unknown role, `enabled` not boolean, weight outside 0–1000, rpm `true`/`[5]`, profile name > 120, binding a role to a profile with no enabled model, concurrent PUT-parent/DELETE-child (FK). 404 for missing account/profile. Unknown / other-role knobs are dropped on save. `api_key: null` clears an optional key.
- Embedding: check reports HTTP 4xx/5xx as `incompatible` (not 連不上); new profiles no longer inherit grandfathering — only endpoints a profile already had are exempt, so name/description edits of a stale profile work and `GET routes` flags `stale` (badge 「與系統模型不一致」). Switch refuses a model that reproduces the current vectors, is single-flight (in-process + conditional state claim), stops jobs with `stop` (the old `cancel` action never existed) and closes auto-retrying ones; the step message counts only jobs actually stopped.
- Legacy v2 import keeps differing rpm/tpm per member instead of dropping them.

**Results:** node-server 407 tests pass (new: `llmErrorCodes`, `llmRoutingValidation`, `llmRoutingImport`, `draftTarget`, switch lock/same-model), typecheck clean; web-v2 typecheck + build OK. API QA (`/tmp/claude-1000/qa-api/run_all.sh`, isolated QA stack): 117 → 135 / 140. Remaining 5 are expectation changes: 2.17 / 3.7 / 7.6 now 404 (was 400) for missing ids; 8.16 strips the other-role knob instead of 400 (scenario text allows either); 10.2 round-trip keeps the OAuth account (count equal instead of −1), as intended. QA baseline restored; all QA-UIFIX- entities deleted; staging back to 5 accounts / 2 profiles / original role bindings.

## 2026-10-17 — IG 套件庫：缺少的相依可直接下載 / 上傳

**What changed**
- Backend (`node-server/src/`): `admin/igDependencies.ts` (pure: missing-dependency closure over installed packages, alias info, who needs it — direct / indirect, status `missing | queued | downloading | failed` from recent `ig_import` jobs, last failure reason + `reason_code`). New endpoints in `adminApp.ts` / `adminIg.ts`: `GET /admin/api/igs/dependencies`, `POST /admin/api/igs/dependencies/download {package_id, version}` (409 if installed, reuses an active job instead of duplicating), `POST /admin/api/igs/dependencies/download-all`, `POST /admin/api/igs/{id}/{ver}/fill-dependencies`, `POST /admin/api/igs/inspect-upload {uploaded_file_id}` (reads package.json of an uploaded .tgz). `POST /admin/api/igs/import` accepts optional `expected_package` for uploads (backward compatible).
- `ig_import` job: new `ig_source: "dependencies"` (exact packages + their missing deps, no root re-import, never moves the default IG; nothing fetchable → `permanent_failed` with `ig_dependency_<kind>`; some requested failed → `partial_success`). `loaders/igRegistry.ts`: `fetchPackage` (a primary-registry metadata 404 no longer stops the packages2 fallback), every attempt kept in the error, `classifyRegistryFailure` (`not_found | network | checksum | invalid_package | unknown`). `loaders/ig.ts`: `fetchPackageClosure` shared by root and dependency-only imports; missing entries carry `reason_code`.
- UI (`pages/ig/`): `MissingDepsModal.tsx` opened from the card badge 「缺 N 個相依」 (now a real button), the KPI 「缺少的相依」 (StatCard is keyboard-operable when clickable) and the drawer (「補齊相依（N）」 + 「下載或上傳缺少的相依」). Per dependency: 從 Registry 下載 (inline job progress), 上傳 .tgz (upload → id/version check → mismatch warning with 重新選擇 / 仍要匯入), failure in zh-TW with next step + technical details + job link. Bulk: 全部重新下載 / 補齊此 IG 的相依; per-IG dialog also offers 重新匯入此 IG (confirm). Finished jobs toast (success / partial / failure reason).

**Staging QA** (:8090, screenshots `/tmp/claude-1000/qa-igdep/`). Staging had no missing deps, so `hl7.fhir.uv.cds-hooks-library@1.0.1` and `hl7.fhir.us.udap-security@0.1.0` were removed via the API and a fixture IG `qa.igdep.fixture@0.0.1` → `qa.igdep.does-not-exist@9.9.9` was inserted.
- Desktop 1440 light: KPI → dialog with 3 deps, required-by chips (direct / 間接, 還有 N 個) — `01`, `02`. Failure: nonexistent package → 下載失敗 「Registry 找不到這個版本」 + upload suggestion, details list 404 from packages.fhir.org, packages2.fhir.org and metadata — `03`, `04`. Keyboard: focus card badge + Enter opens the per-IG dialog, drawer stays closed — `05`. Registry download with inline progress → 所有相依皆已安裝 + toast — `06`, `07`. Drawer entry points — `08`, `09`. Upload: wrong tarball → 套件不符 warning; re-pick correct .tgz → import → installed — `10`–`13`. Esc with dialog over drawer closes only the dialog (fixed during QA). Bulk 全部重新下載（3）→ two installed, fixture dep failed, 部分完成 toast — `15`–`17`.
- Mobile 390 dark: no horizontal overflow (page and full-screen dialog, also with upload panel and expanded error details), badge tap target 34 px, buttons 36 px — `18`–`23`; drawer alert in dark — `24`.
- Tests: node-server 582 pass (new `admin/igDependencies.test.ts`, `igRegistry.test.ts` + 4, `ig.test.ts` + 1), typecheck clean; web-v2 typecheck + build OK.
- Cleanup: fixture removed; both packages restored through the new flow; `GET /igs/dependencies` = [], 58 packages / 135,155 artifacts as before, default IG unchanged. The two QA uploads remain as inactive files in the IG source uploads.

## 2026-10-17 — IG 套件庫：分頁、搜尋與篩選

**What changed**
- DB: `db/migrations/20261019_ig_install_origin.sql` (folded into `db/schema.sql`) adds `fhir.ig_packages.install_origin` (`manual | dependency`, default `manual`, CHECK) and `installed_for` (JSONB `{package_id, version}` of the IG that pulled a dependency in). Backfill: (1) job history — first package of a registry/upload `ig_import` without `expected_package` → manual; packages after the first → dependency of that job's root; `ig_source: dependencies` jobs and `expected_package` uploads → dependency (installed_for = `requested_for`); manual evidence wins, else the latest dependency job; (2) no job evidence → dependency if another installed IG declares it directly (core 4.0.0 ≡ 4.0.1), else manual. Staging result: 2 manual (twcore 1.0.0, nhi.pas 1.2.7), 56 dependency; rule 2 alone (job history blanked in a rolled-back transaction) gives the same split.
- Importer: `admin/igOrigin.ts` (pure; tests `igOrigin.test.ts`) decides origin per promoted package; `runIgImportJob` and the CLI `indexPackages` write it. Upsert keeps "manual" sticky and the first installer of a dependency. `POST /admin/api/igs/import` (upload) accepts optional `requested_for`; the missing-dependency upload sends it.
- `GET /admin/api/igs` adds `install_origin`, `installed_for` (+ title, installed), `required_by` (direct installed dependents, alias-aware), `description` (ImplementationGuide resource, ≤500 chars), `counts.examples` (`package/example/*`). Tolerates a DB without the migration (origin null). Detail adds `install_origin`, `installed_for`.
- UI: client-side filtering/paging (`pages/ig/igFilters.ts`; the list API returns everything, ~1.4 s for 58 IGs). Search (name, package id, canonical, version, description; multi-term AND; 250 ms debounce; `<mark>` highlights; description/canonical excerpt when the match isn't visible), 安裝方式, 相依狀態, FHIR 版本, 預設 IG / 含範例 chips, sort (名稱 / 最近安裝 / 內容最多), facet counts, active-filter pills (removable by keyboard) + 全部清除, empty state with 清除篩選, pagination 12/24/48 with 「顯示第 x–y 個，符合 n / 共 N 個」. All state in the URL (`q, origin, deps, fhir, default, examples, sort, page, size`); discrete changes push history, typing replaces; any filter change resets page. Cards show 手動安裝 / 依賴安裝 badge and 「由 X 帶入」 (or 「被 X 等 n 個 IG 依賴」); drawer shows 安裝方式. Phones: search + 「篩選」 button (count badge) opening a bottom drawer with all filters + sort.

**Staging QA** (:8090, Chromium, script `/tmp/claude-1000/qa-igfilter/runner/qa.mjs`, results `/tmp/claude-1000/qa-igfilter/results.txt`, screenshots `/tmp/claude-1000/qa-igfilter/01`–`14`): 35/35 checks pass, no console errors.
- 1440 light: default 24 of 58 (`01`); search highlight (`02`); description-only match with excerpt (`03`); Esc clears; manual = 2 (`04`); dependency = 56 over 3 pages, reload keeps filter+page, back/forward walk pages (`05`); filter change resets page; size 48; search + origin + FHIR = 5 with 3 pills (`06`); pill removal; 相依完整 = 58; 有缺少相依 → empty state → 清除篩選 (`07`); sort by size; 預設 IG chip = 1; 含範例 = 22; drawer 安裝方式 (`08`); Tab from search reaches the clear button / filters.
- 有缺少相依 with data: staging has none, so one package's `deps_missing` was injected via request interception (no staging change) → 1 result (`09`).
- 390 dark touch: no horizontal scroll (390), filters collapsed, drawer (`11`) applies origin + FHIR, badge 「已套用 2 個篩選」, pagination fits (`13`), empty state (`14`).
- Tests: node-server 588 pass + typecheck; web-v2 typecheck + build OK. Migration applied by hand on staging; no IG package added/removed.

## 2026-10-17 — IG 套件庫：安全移除（相依 / 預設 IG 保護）與清理未使用的相依

**What changed**
- Backend: new pure module `node-server/src/admin/igRemoval.ts` (tests `igRemoval.test.ts`, 16 cases, faked transaction). `dependentsOf` = installed IGs needing the target directly or transitively (BFS over reverse edges, core 4.0.0 ≡ 4.0.1 via `canonicalDependencyVersion`, cycle-safe, reports `direct` + `via`). `planRemoval` refuses with stable codes: `IG_HAS_DEPENDENTS` (409, + `dependents`), `IG_IS_DEFAULT` (409, + `default_candidates`; only when another IG could take over), `IG_INVALID_NEW_DEFAULT` (400), `IG_NOT_FOUND` (404), `IG_DEPENDENCY_IN_USE` (409, bulk cleanup), `IG_NO_TARGETS` (400); `blockers` lists every reason. `removeIgPackages` locks `fhir.ig_packages` (`FOR UPDATE`), re-plans inside the transaction, deletes, moves the default when `new_default` is given, and writes one `admin.admin_audit_log` row per package (`remove_ig` / `remove_ig_forced`, payload `forced`, `forced_by`, `reason`, broken `dependents`, `was_default`, `new_default`); forced removals are also logged (warning). The detail endpoint's `dependents` is now alias-aware.
- Endpoints: `DELETE /admin/api/igs/{id}/{ver}[?force=true][&new_default=id@ver]` (previously always deleted — staging's audit log shows `cds-hooks-library` removed 4× while `davinci-crd` depended on it); `GET /admin/api/igs/{id}/{ver}/removal-impact` (dependents, default candidates, `orphaned` = dependency installs that become unused); `GET /admin/api/igs/unused-dependencies` (`install_origin='dependency'` packages not reachable from any manual / unknown-origin / default IG); `POST /admin/api/igs/unused-dependencies/remove {packages?}` (set-level check, never forced). Module-wide clear (DangerZone) removes every package, so it cannot strand a dependent and is unchanged.
- UI (`web-v2/src/pages/ig/`): `RemoveIgModal.tsx` replaces the confirm dialog — counts, dependents (direct / 間接 + via, 預設 badge) with what breaks (validation, ValueSet expansion, code lookup), default-IG block with a 「新的預設 IG」 select, orphaned-dependency hint; with dependents the primary 「移除 IG」 is disabled and a separate 「強制刪除」 needs the package id typed (DeleteProfileModal pattern). `UnusedDepsModal.tsx` (「清理未使用的相依」 from a gallery notice and the 維護與危險操作 tab; selection kept closed so a package is only removed together with the unused packages still declaring it). `igRemoval.ts` translates the codes to zh-TW.

**Staging QA** (:8090, script `/tmp/claude-1000/qa2/igdelete.mjs`, results/screenshots `/tmp/claude-1000/qa-igdelete/`): 34/34 checks pass, no console errors.
- Throwaways installed for the test: `hl7.fhir.uv.pocd@0.3.0` (registry import → manual) and `hl7.fhir.uv.livd@0.3.0` (dependency download → unused dependency).
- 1440 light: gallery notice 「1 個依賴安裝的套件已不被任何 IG 使用」 (`01`); `hl7.terminology.r4@6.2.0` → 5 dependents (2 direct, 3 indirect incl. `tw.gov.mohw.nhi.pas@1.2.7`), primary disabled, 強制刪除 disabled until the exact id is typed (not clicked), Esc closes the modal only (`02`); default `twcore@1.0.0` → primary disabled until a new default is chosen, force section hides afterwards (not clicked) (`03`); faked "no dependents" impact → real DELETE returns 409 `IG_HAS_DEPENDENTS`, shown in zh-TW and impact refreshed (`04`); unused modal lists only livd (`05`); settings section (`06`).
- 390 dark: same flows, no horizontal scroll, full-screen modals (`07`–`10`), cancel autofocused.
- Real deletes, throwaways only: pocd via keyboard (Tab → 移除 IG → Enter) → 200 + toast (`11`, `12`); livd via 清理未使用的相依 → 200, notice gone (`13`). Audit rows `remove_ig` with `reason: manual` / `unused_dependency_cleanup`.
- Staging IG set afterwards is identical to before (58 packages, origins and default compared by diff). Nothing was force-deleted.
- Tests: node-server 604 pass + typecheck; web-v2 typecheck + build OK. Deployed app + web-v2 (no job code changed, admin-worker not rebuilt).

## Theme switch animation (2026-10-17, staging :8090)

Evidence: `/tmp/claude-1000/qa-theme/` — `<case>-<w>-<to-dark|to-light>-{0..4,final}.png` (frames captured with CDP animation playback at 0.1x), `strip-*.png` contact sheets, `rec-1440.webm` / `rec-390.webm` (real-speed video, both directions). Script: `/tmp/claude-1000/qa2/theme.mjs`.

- View Transitions (Chromium), 1440 + 390: circular reveal expands from the theme toggle, both directions; no layout shift, `scrollWidth - innerWidth = 0`, `.theme-vt` class removed afterwards.
- With Spotlight modal open (switched via Ctrl+J): overlay, blurred backdrop and modal all covered by the reveal.
- `prefers-reduced-motion: reduce`: instant switch, no transition classes.
- Fallback (startViewTransition removed): ~260 ms colour cross-fade, `theme-fading` class removed afterwards.
- a11y: toggle `aria-label` updates (外觀：深色 / 淺色), polite live region announces 「外觀已設為…」.
- No console / page errors in any run. web-v2 typecheck + build OK; only web-v2 redeployed.

## 2026-10-17 — MCP 工具：端點總覽、工具目錄與測試台

**What changed**
- Backend: `mcp.ts` exposes a static catalog (`toolCatalog()`, `TOOL_GROUPS`, `WRITE_CAPABLE_TOOLS`, `catalogToolInputSchema`, `registeredToolNames`) derived by running the existing `register*` functions against a recording stub (placeholder service throws if touched), so the catalog cannot drift from what MCP serves. `health_check` moved into `registerSystemTools` (same order). The OpenAPI registry is now built into a fresh map and swapped at the end of `buildMcpServer` (no half-built registry for a concurrent `/tools` call). `/openapi.json` and MCP `initialize` + `tools/list` were dumped before/after on a local server and on staging: byte-identical.
- `moduleStatus.ts`: `MODULE_REQUIREMENTS`, `DERIVED_MODULES`, `getModuleCounts()` (uncached counts for the "why disabled" view; gating unchanged).
- New `admin/adminMcp.ts` (+ `adminMcpDeps.ts` wiring): `GET /admin/api/mcp/overview` (public URLs from PUBLIC_BASE_URL or request origin, auth mode, `bearer_configured` only — never the token, CORS, server version/build/lexicon, TOOLS_VERSION, per-FHIR-server JWKS URL), `GET /admin/api/mcp/tools` (63 tools: group, zh title, description, version, enabled + reason `always_on | module_ready | module_data_missing | module_check_failed | service_unavailable`, gate table/minimum/count, write-capable, JSON Schema identical to the OpenAPI bridge, examples), `POST /admin/api/mcp/tools/{name}/invoke` (same `invokeRegisteredTool` as `POST /tools/{name}`; 404 unknown, 409 disabled, 428 for a confirmed `crud_fhir_server` write without `confirm_write_operation`, 429 at 60/min per admin; returns `http_status`, `elapsed_ms`, `tool_ok`, zod `issues`). Logs only tool, status, elapsed and a 12-char sha256 of the arguments. Behind the session gate and the DB-health gate.
- `admin/mcpToolExamples.ts` (+ generated `mcpToolExampleFixtures.ts`: TW Core 1.0.0 example Patient / Condition / Bundle, grounding G01/G10/G08 and completeness C08a/C08u fixtures — fictional records): 1–3 named presets per tool, default preset read-only for `crud_fhir_server`.
- Bug fixes found by running every example: `snomedService.searchConcepts` with `hierarchy_filter` failed (`desc` used as a SQL alias → syntax error); `getRelationships` with `relationship_type_id` failed (unused bind parameter `$3` → "could not determine data type"). Both always errored before.
- UI (`web-v2/src/pages/mcp/`, route `/admin/mcp`, nav 整合 → MCP 工具): tabs 端點與連線 / 工具目錄 / 測試台, all state in the URL. Catalog: group tiles with enabled/total, search (name, title, description, params; highlight), group + status filters, cards with version, 唯讀/可寫入, param chips, disabled reason + 前往匯入, details with param table. Playground: tool picker, presets, schema-driven form (enum select, bounded numbers, switches, tags, JSON editors with validation, optional fields pre-filled and 送出 toggle), raw-JSON mode, Ctrl+Enter, collapsible JSON tree / raw result, copy result, 複製為 curl, write confirmation (type the server key), per-browser history (localStorage, guarded).
- Tests: `admin/adminMcp.test.ts` (catalog payload/reasons, overview hides token, invoke path incl. zod errors, disabled, write confirmation, rate limit, no argument logging) and `admin/mcpToolExamples.test.ts` (63 tools, unique, every tool has examples, every example parses with `z.object(shape).strict()`, JSON-string args parse, crud default read-only). node-server 694 pass + typecheck; web-v2 typecheck OK.

**Staging QA** (:8090, script `/tmp/claude-1000/qa2/mcpqa.mjs`, results `/tmp/claude-1000/qa-mcp/results-ui.txt`, `tool-runs.txt`, screenshots `/tmp/claude-1000/qa-mcp/01`–`16`): 38/38 UI checks pass, no console errors.
- Every enabled tool (58/58) run once through the UI with its default example: all 成功 (HTTP 200, `tool_ok`). The 5 disabled tools (健康食品 1, 食品營養 4: staging tables empty, threshold 10) show 資料不足 with table/count and Run disabled; their examples are schema-tested only.
- Clipboard: staging is plain http on an IP, where `navigator.clipboard` does not exist; the QA stubs it. Copy buttons (here and elsewhere in the console) work on https / localhost only.

## 2026-10-17 — Terminology「資料預覽」視覺化（staging :8090）

**What changed**
- 「資料預覽」tab of ICD / SNOMED / LOINC / RxNorm now opens a structure-aware explorer (`web-v2/src/pages/terminology/explorer/`); the old flat table is one click away (`?view=table`). IG CodeSystems: the IG drawer's CodeSystem tab and the artifact browser's CodeSystem detail show the nested concept tree.
  - ICD-10-CM: lazy, virtualised tree chapter → block → category → subcategory → billable (98k codes, only visible rows mounted), 7th characters folded into A/D/S chips with meanings, search that reveals + highlights the path in one request, detail card with path crumbs, keyboard (↑↓←→ Enter Home End), mobile drill-down list with slide transitions. WHO ICD-10: same tree (chapters / nested blocks from `icd.icd10_who`).
  - ICD-10-PCS: section → body system → operation navigator, official table grid (rows × axes 4–7, click values to build a code), 7-axis coloured breakdown with validity, matching DB codes.
  - SNOMED CT: focus-concept graph (parents above incl. polyhierarchy, children below paged, attribute relationships right, ICD-10 maps left with links into the ICD tree), SVG edges drawn on, re-focus via View Transitions (clicked card morphs into the focus), back/forward/home, inactive concepts with historical associations (REPLACED BY → …).
  - LOINC: facets for the 6 axes + class + status with counts and bars, term drawer with animated axis bar + Part codes, Taiwan mapping, reference-range band chart, answer lists (LL → LA), panel members with lazily expandable sub-panels, in-panels, MapTo.
  - RxNorm: TTY layer map + search + name-derived relationship graph (no RXNREL in the DB — stated in the UI).
- Backend: `node-server/src/admin/termViz/*` (`GET /admin/api/terminology/*`, admin session + DB-health gate, read-only, params never logged) + static CMS structure tables `node-server/src/data/icd10{cm,pcs}*.data.ts` (generated by `node-server/scripts/gen-icd-structure.mjs`). LOINC loader now also imports part links, answer lists, panels, MapTo (migration `db/migrations/20261020_loinc_structure.sql`, applied on staging only; staging LOINC re-imported).
- Tests: `termViz.test.ts` (19, faked DB) + loader tests; node-server 694 pass + typecheck; web-v2 typecheck + build OK. Deployed staging app, admin-worker, web-v2.

**QA** (script `/tmp/claude-1000/qa2/termviz.mjs`, screenshots `/tmp/claude-1000/qa-termviz/`): 1440 light/dark, 390 dark (+ full-page), no horizontal scroll, no console errors.
- ICD search reveal E11.21 and S93.401A (stem row with A chip active), deep link T36.0X1A, keyboard nav; PCS 0DTJ4ZZ + table 0DT; WHO E11.2; SNOMED 44054006 → parent → child → back, inactive 9258009 (REPLACED BY Uterine structure); LOINC 2345-7, 4548-4 (range band), 883-9 (answer list), 24323-8 (panel + sub-panel 24326-1); RxNorm 6809 / 861027; IG twcore icd-10-pcs-2014-tw (truncation warning vs 0.3.2) and r4.core condition-clinical (nested tree, keyboard).
- Performance (staging, warm): tree roots API 3 ms (cold 87 ms), path reveal 6–9 ms, SNOMED neighbourhood 30–50 ms, LOINC facets 2 ms cached / 120 ms cold, RxNorm concept 11–15 ms. Tab click → first content ≈ 0.9 s for ICD / SNOMED / LOINC (incl. lazy chunk load).

## 2026-10-19 — Embedding 模型更換：不再丟原始錯誤，改為引導（staging :8090）

**Incident (production)**: no `admin.embedding_identity` row, vectors from Qwen3-Embedding-0.6B; the vLLM server was redeployed with `qwen3-embedding-4b`; editing the embedding profile to the 4B model failed with 「操作失敗：HTTP 404 … The model `Qwen3-Embedding-0.6B` does not exist.」. Root causes: (1) identity seeding took `currentRoleLeaves()[0]` blindly — the now-404 vLLM member — and its transport error escaped as a raw 500; (2) a model change by profile edit is correctly refused, but only as an English message with no path forward; (3) `send_dimensions` / native-size problems (4B = 2560) were only discovered after the fact; (4) the switch truncated vectors but left the `halfvec(1024)` columns to the first embed job (which sized them from the profile's `dimensions` knob, not the stored vectors).

**What changed**
- `admin/embeddingDiagnosis.ts` (new): every embedding failure → `{code, params}`: `embedding_model_not_found` (+ the server's model list), `embedding_dims_unsupported` (returned vs configured, `send_dimensions`, Matryoshka guess, vLLM `--hf-overrides '{"is_matryoshka": true}'` hint), `embedding_endpoint_unreachable`, `embedding_endpoint_auth`, `embedding_endpoint_error`, `embedding_no_vectors`.
- `admin/embeddingIdentity.ts`: `establishIdentity` re-embeds a few stored texts (rebuilt like the loader, verified by `source_hash`; `admin/embeddingSamples.ts`) with each candidate — role members, then other embedding profiles, then the members being saved — and adopts the first that reproduces the stored vectors; unreachable/404 endpoints are skipped; none → `embedding_identity_unresolved` (409, every attempt). Profile edit / role binding to another model → `embedding_model_change_requires_switch` (409: current model/dims, requested account/model/dims/returned dims/params, vector counts, re-index estimate, endpoint issue). `precheckSwitch` (no side effects), `embeddingRoleHealth` (per-member probe, 60 s cache). The switch re-types every `*_embeddings` column in the wipe transaction (`admin/embeddingColumns.ts`, shared with the loader, which now sizes columns from the identity first); step-0 failures are coded.
- API: `POST /admin/api/llm/embedding/precheck`, `GET|POST /admin/api/llm/embedding/health`, `POST /admin/api/llm/embedding/establish`; `CodedProfileError` → `{error, detail, code, params}`; unknown provider failures → `endpoint_failed`; account / model / route tests and settings import carry codes.
- UI: `EmbeddingGuide` dialog (why, from → to, steps, estimate, dims warning, 「改用切換模型流程」 opening the switch pre-filled); switch dialog with 預先檢查 (blocking reason + one-click fixes: pick a served model, 改為 N 維, toggle 送出維度參數), column re-type notice, REINDEX only after a passing pre-check; overview 「Embedding 路由降級」 alert + 失敗 badges; 「確認現有向量的模型並建立指紋」 button; member test shows served models; raw server text only under 「技術細節」.
- Tests: `admin/embeddingGuidance.test.ts` (19: seeding fallback / never adopting an unreachable or other-model endpoint / unresolved, the incident end-to-end, change detection, pre-check, production-situation switch incl. ALTER 8 → 12, error mapping). node-server 798 pass + typecheck; web-v2 typecheck + build.

**Staging QA** (scripts `/tmp/claude-1000/qa2/embfix.mjs`, `embfix2.mjs`; screenshots `/tmp/claude-1000/qa-embfix/{desktop,mobile}-NN-*.png`). Production situation simulated: identity row deleted (vectors 596,363 @1024 kept), staging's `vllm · Qwen/Qwen3-Embedding-0.6B` member already 404s on the vLLM that now serves `qwen3-embedding-4b`.
- API repro of the exact production PUT (`members: [{account vllm, model qwen3-embedding-4b, params {dimensions:1024}}]`): HTTP 409 `embedding_model_change_requires_switch`, identity seeded from `gpu server · qwen3-embedding:0.6b-q8_0` (verified against stored vectors, `tried: 1`), `requested_returned_dims: 2560`, endpoint issue `embedding_dims_unsupported`, estimate 58–124 min. Nothing saved.
- Pre-checks: 4B@1024 + send_dimensions → `embedding_dims_unsupported` (vLLM rejected `dimensions`, returned 2560); `Qwen3-Embedding-0.6B` on vLLM → `embedding_model_not_found`, available `[qwen3-embedding-4b]`; 4B@2560 → ok, `alter_columns` 1024 → 2560; Ollama 0.6B → `embedding_switch_same_model` (similarity 1.0); SiliconFlow 0.6B without identity → same model via stored samples (0.9988).
- UI 1440 + 390: overview degraded alert (01), establish button (02), guidance dialog (03/04), switch pre-filled with vllm / qwen3-embedding-4b / 1024 (05), pre-check dims unsupported with both fixes (06), send_dimensions rejected (07), 改為 2560 維 → passes, REINDEX warning, switch button disabled until REINDEX (08), member test 404 → served model chip (09), all endpoints disabled → 「無法確認系統目前的 Embedding 模型」 with attempts (10, 1440), establish success toast (11). No horizontal scroll; only console error is the expected 409 response.
- The full re-index switch was **not** run on staging (shared GPU, ~1–2 h); the switch path incl. the column ALTER is covered by the unit test. Staging's embedding config was restored afterwards (identity row v1 from 2026-10-15 and fingerprints reloaded from a dump; routes/members unchanged; accounts 1/3/4 were briefly disabled for screenshot 10 and re-enabled).

## 2026-10-19 — 全系統錯誤處理 QA：原始錯誤、脆弱相依、前置檢查

**Why.** A raw transport error ("HTTP 404 from http://…/v1/embeddings: {…}") reached the operator on save. The whole console + worker + MCP tools were audited for that class of defect: raw errors shown to users, single-candidate dependencies, late failures, ambiguous empty states, MCP errors without a next step, partial failures.

**What changed**
- Shared mechanism `node-server/src/admin/adminErrorCodes.ts` (tests `adminErrorCodes.test.ts`): every admin error body (status ≥ 400) passing `sendJson` gains `code` + `message_zh` + `hint_zh` (original `error` / `detail` kept; bodies that already carry a `code` — LLM API, IG removal, MODULE_MAINTENANCE — untouched; `/admin/api/llm/*` is sent raw). Known English messages first (sources, jobs, settings, FHIR/OAuth, IG, backups, playground), then the technical cause in `detail` (missing table/column → apply migration, duplicate key, FK, invalid input, timeouts, ECONNREFUSED / DNS / timeout / TLS / bad port, upstream HTTP 4xx/5xx, MinIO), else a generic message naming the failed operation. Also: connection tests (`explainServiceTest`), service probes + history (`explainProbe`), dashboard infrastructure (`detail_zh`), job errors (`last_error_zh` / `last_error_hint_zh`), drug recent events (`error_zh`), FHIR connection test / probe + each workflow step + stored `last_probe_error_zh`. `httpErrors.ts`: bad JSON / too large / unhandled errors on `/admin/*` explained.
- Console: `ApiError` carries `code`, `hint`, `rawMessage`; `errorMessage()` = zh message + next step; `notify.error` / `ErrorState` render message, next step and a small 「技術細節」. Non-JSON 502/504/503/413 from nginx explained (`BACKEND_UNAVAILABLE` …). Field-matching code switched to `rawMessage`.
- Preconditions: `admin/jobPrechecks.ts` (tests) — 409 `JOB_ALREADY_ACTIVE` for a second whole-module import/sync/embed/backup; 409 `OCR_NOT_CONFIGURED` / `ANALYSIS_LM_NOT_CONFIGURED` for drug analysis / pipeline. `worker_warning` on job creation when no worker heartbeats + app-wide 「背景 Worker 已失聯」 banner (`layout/WorkerOfflineBanner.tsx`). IG upload import refuses a non-package .tgz (422 `IG_PACKAGE_INVALID` / `IG_PACKAGE_NO_IDENTITY`) instead of installing `ig-root@0.0.0`. Source uploads check release-zip members (`SOURCE_ARCHIVE_WRONG`) and LOINC CSV headers (`CSV_COLUMNS_MISSING`). Settings save/import reject non-numeric values (`SETTING_NOT_NUMBER`) and return 400 (not 500) for out-of-range / bad URL / env-managed. Password change requires ≥ 12 chars server-side (was: any non-empty).
- Brittle dependencies / stale state: single-file source roles now bind the **active** upload (was: newest upload, even inactive); worker dependency gate re-probes a cached `error` before failing a job; registry autocomplete falls back to packages2.fhir.org and reports a real error instead of an empty list; registry `not_found` root import → `permanent_failed` `ig_package_not_found` (was retryable worker exception); OCR / TFDA save reports a failing connection as a warning (`connection`), never blocking the save; settings import validates model endpoints before writing any group (no half-applied import).
- FHIR server create/update with a taken `server_key` → 409 `FHIR_SERVER_KEY_TAKEN` (was raw `duplicate key …`).
- MCP tools (`toolErrors.ts`, separate pass): argument errors name the parameter, rule, example and parameter list; unknown/disabled tools explained; SQL / driver errors classified and never leaked; not-found results carry `hint` / `suggestions`; external FHIR transport errors classified. Playground shows the same `code` / `message` / `hint`. toolVersions bumped where output changed.

**Staging QA** (:8090; API transcript in this section, browser script `/tmp/claude-1000/qa2/errafter.mjs`, `workeroff.mjs`; screenshots `/tmp/claude-1000/qa-errors/after/*-{1440,390}.png`; before: `/tmp/claude-1000/qa-errors/before/`). 1440 and 390: all checks pass, no horizontal scroll, only console error = the expected 400 of the rejected upload.
- Settings import bad JSON / `"abc"` number / version 9; password `x` / wrong current; backup 404; bad job type; unknown playground tool → all coded zh + hint.
- OCR test: port 9 (`UPSTREAM_PORT_BLOCKED`), example.com (404 → 「找不到 /health」), DNS, the real unreachable server (EHOSTUNREACH) — zh + hint + 技術細節 (`01`). OCR save with the unchanged value → saved + `connection` warning.
- 服務健康 / 儀表板 show zh probe text (`02`, `03`). FHIR throwaway server: DNS failure on test / probe (toast + Alert + step text in zh, `04`), 404 metadata → Base URL hint, duplicate key → 409.
- Upload `bad.zip` to LOINC → 「找不到 LoincTable/Loinc.csv」 (`08`); `bad.csv` to Taiwan mapping → missing columns; non-package .tgz import → 422, no job, no `ig-root` IG.
- Registry import `qa.nonexistent.pkg@9.9.9` → `permanent_failed` + zh reason on job page (`06`).
- Worker stopped: job creation returns `worker_warning`, banner on every page with queued count (`09`); worker restarted, the queued `noop` job finished.
- MCP: `/tmp/claude-1000/qa-errors/mcp/after*.txt` vs `before*.txt`.
- Tests: node-server 803 pass + typecheck; web-v2 typecheck + build OK. Deployed staging app, admin-worker, web-v2.
- Cleanup: FHIR throwaway and QA uploads deleted; OCR settings identical; 58 IGs, default twcore 1.0.0; worker online. Leftover job records (no effect): `08e05036` (ig_import, failed by design), `420fc702` (noop, success).
