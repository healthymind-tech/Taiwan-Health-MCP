# 開發指南

感謝您有興趣參與 Taiwan Health MCP 的開發！本區塊文件協助新進開發者快速熟悉專案架構與開發流程。

## 專案結構速覽

| 路徑 | 內容 |
|------|------|
| `node-server/` | **整個後端**（Node.js / TypeScript）：MCP 伺服器、管理後台 REST API、背景 worker、所有資料載入器。 |
| `node-server/src/*Service.ts` | 各領域服務（`icdService.ts`、`drugService.ts`、`labService.ts`、`snomedService.ts`、`fhirIgService.ts` …）。 |
| `node-server/src/mcp.ts` | MCP 工具註冊（工具群組與輸入 schema）。 |
| `node-server/src/server.ts` | 入口點：HTTP 介面（`/mcp`、`/openapi.json`、`/tools/*`）與行程初始化。 |
| `node-server/src/admin/` | 管理後台後端（`adminApp.ts` 路由、`adminJobs.ts` 工作、`adminWorker.ts` 背景 worker、`adminSettings.ts` 設定 …）。 |
| `node-server/src/loaders/` | 各模組載入器（`icd.ts`、`loinc.ts`、`snomed.ts`、`rxnorm.ts`、`ig.ts`、`drug*.ts`、`embeddings.ts` …）。 |
| `node-server/src/admin/termViz/` | 管理後台術語瀏覽的唯讀 API（`/admin/api/terminology/*`：ICD 樹、PCS 軸、SNOMED 圖、LOINC 軸、RxNorm、IG CodeSystem 樹）。 |
| `node-server/src/providers/` | 模型 provider adapter（OpenAI、Azure OpenAI、Anthropic、Gemini、Bedrock、Ollama、OpenAI 相容伺服器、ChatGPT 登入 … 共 24 個），供 embedding 與分析 LLM 路由使用。 |
| `node-server/src/grounding/` | 確定性的紀錄忠實度引擎（`fhir_check_grounding`、`fhir_check_completeness`）。 |
| `node-server/scripts/validator-audit/` | 內建 FHIR validator 與 HL7 validator_cli 7.0.1 的比對工具與稽核報告（`REPORT.md`）。 |
| `web-v2/` | **正式環境的管理後台**：Vite + React + Mantine 的靜態 SPA，由自己的 nginx 容器（compose 服務 `web-v2`）服務，掛在 `/admin/`。 |
| `web/` | 舊版 Next.js 管理後台（`web/admin-app/`），已由 `web-v2/` 取代；compose 服務 `web` 只在 profile `legacy-web` 下才會啟動，僅留作回滾。 |
| `db/` | `schema.sql` 與 `migrations/`。 |
| `src/prompts/` | 執行期讀取的 LLM prompt（藥品分析）。**這是 `src/` 目錄唯一剩下的內容。** |
| `data/loinc/` | 人工整理、無法從外部重新下載的 LOINC 對照表。 |
| `docs/` | MkDocs 文件來源（即本網站）。 |

> 本專案已無 Python 執行期相依；`node-server/` 以外沒有後端程式碼。

## 本機開發

```bash
# 後端
cd node-server
npm install
npm run build          # tsc -> dist/
npm run dev            # tsx watch src/server.ts
npm run typecheck
npm test

# 管理後台前端（web-v2）
cd web-v2
npm install
npm run dev            # vite，http://localhost:5173/admin/，API 代理到 ADMIN_BACKEND（預設 http://127.0.0.1:8090）
npm run typecheck      # tsc -b --noEmit
npm run build          # 輸出 dist/
```

完整堆疊請用 Docker：`docker compose up -d`（見[快速開始](../getting-started.md)）。
改完程式碼後重新部署：`docker compose build app web-v2 && docker compose up -d --no-deps app web-v2`。
`admin-worker` 是另一個映像（`Dockerfile.worker`），改到工作 / 載入器程式碼時也要重建：
`docker compose build admin-worker && docker compose up -d --no-deps admin-worker`。

## 文件導引

### [程式風格](code-style.md)
命名、註解與程式碼慣例（程式碼與註解使用英文）。

### [測試指南](testing.md)
如何執行測試（`npm test`）與端對端驗證。

### [貢獻流程](contributing.md)
Pull Request 規範與程式碼審查標準。

## 新增服務的步驟

1. 建立 `node-server/src/<name>Service.ts`（類別，建構子收 `pg.Pool`，提供 `async initialize()`）。
2. 在 `server.ts` 的初始化流程中建立該服務實例（任一服務初始化失敗時應優雅降級，不影響其他服務）。
3. 在 `mcp.ts` 新增工具註冊函式（輸入 schema 用 `zod`），並登錄到對應的工具群組。
4. 若需依資料載入狀態動態啟用，於 `moduleStatus.ts` 的 `REQUIREMENTS`（對外匯出為 `MODULE_REQUIREMENTS`）加入資料表與最低筆數門檻，並在 `mcp.ts` 中以 `if (status.<key>)` 包住該群組的註冊。
5. 若工具輸出受 fixture 固定，在 `toolVersions.ts` 的 `TOOLS_VERSION` 登記版本；同一輸入的輸出改變時要調升。
