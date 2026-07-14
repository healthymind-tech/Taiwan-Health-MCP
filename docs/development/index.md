# 開發指南

感謝您有興趣參與 Taiwan Health MCP 的開發！本區塊文件協助新進開發者快速熟悉專案架構與開發流程。

## 專案結構速覽

| 路徑 | 內容 |
|------|------|
| `node-server/` | **整個後端**（Node.js / TypeScript）：MCP 伺服器、管理後台 REST API、背景 worker、所有資料載入器。 |
| `node-server/src/*Service.ts` | 各領域服務（`icdService.ts`、`drugService.ts`、`labService.ts`、`snomedService.ts`、`fhirIgService.ts` …）。 |
| `node-server/src/mcp.ts` | MCP 工具註冊（工具群組與輸入 schema）。 |
| `node-server/src/server.ts` | 入口點：HTTP 介面（`/mcp`、`/openapi.json`、`/tools/*`、`/status.json`）與行程初始化。 |
| `node-server/src/admin/` | 管理後台後端（`adminApp.ts` 路由、`adminJobs.ts` 工作、`adminWorker.ts` 背景 worker、`adminSettings.ts` 設定 …）。 |
| `node-server/src/loaders/` | 各模組載入器（`icd.ts`、`loinc.ts`、`snomed.ts`、`rxnorm.ts`、`ig.ts`、`drug*.ts`、`embeddings.ts` …）。 |
| `web/` | Next.js 前端：公開頁面（`app/`）+ 管理後台 SPA（`admin-app/`）+ 舊版靜態 HTML（`legacy/`）。 |
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

# 前端
cd web
npm install
npm run dev            # next dev -p 3000
```

完整堆疊請用 Docker：`docker compose up -d`（見[快速開始](../getting-started.md)）。
改完程式碼後重新部署：`docker compose build app web && docker compose up -d --no-deps app web`。

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
4. 若需依資料載入狀態動態啟用，於 `moduleStatus.ts` 的 `SERVICE_MODULES` 加入門檻，並在每個工具開頭加上服務可用性守衛。
