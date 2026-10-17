# Admin Console v2

管理控制台的全新前端，取代 `web/`（Next.js + `web/admin-app/`）。

| 項目 | 選擇 |
|------|------|
| 建置 | Vite 7 + React 19 + TypeScript（strict） |
| UI | Mantine 8（全部元件客製，無瀏覽器原生表單元件） |
| 路由 / 資料 | react-router 7、TanStack Query 5、`/admin/ws` WebSocket 即時失效化 |
| 部署 | 靜態檔由 nginx 服務（本目錄的 `Dockerfile`），同一個容器也代理後端 API |

## 開發

```bash
cd web-v2
npm install
npm run dev          # http://localhost:5173/admin/ ，API 代理到 ADMIN_BACKEND（預設 http://127.0.0.1:8090）
npm run typecheck
npm run build        # 輸出 dist/
```

`ADMIN_BACKEND=http://127.0.0.1:8080 npm run dev` 可指向其他後端。

## 目錄

```
src/
  theme.ts              設計 token：品牌色、中性色、深色模式、元件預設值
  styles.css            全域樣式
  layout/               AppShell、側邊欄導覽（nav.ts）、資料庫斷線遮罩
  components/           共用元件：PageHeader、SectionCard、StatCard、DataTable（手機自動轉卡片）、
                        confirmAction（含輸入確認）、UploadDropzone（含進度）、LogViewer …
  lib/                  api、WebSocket、query keys、格式化、模組與工作的顯示資料（meta.ts）
  pages/                各頁面（一個資料夾一個區塊）
```

## 隔離測試環境（staging）

`deploy/staging/compose.yaml` 是一套與正式環境完全隔離的 stack（compose 專案名 `twh-staging`）：自己的 Postgres
（由正式 DB dump 還原）、Redis、MinIO（只鏡像來源檔與部分藥品資產）、app、worker 與本前端，入口
`http://<host>:${STAGING_PORT:-8090}/admin/`。staging 的 `web-v2` 容器本身就是前門（同時代理後端 API），不經根目錄的 `nginx`。

啟動前須建立**不進版控**的 `deploy/staging/.env`，至少設定 `STAGING_DB_PASSWORD` 與 `STAGING_MINIO_PASSWORD`
（未設定時 compose 直接報錯）；`STAGING_HOST` / `STAGING_PORT` 可選。app / worker 另外讀根目錄的 `.env`。

```bash
docker compose -p twh-staging -f deploy/staging/compose.yaml up -d --build
```

staging 用自己的 session cookie 名稱（`ADMIN_SESSION_COOKIE=tw_health_admin_session_staging`）並關閉 Secure cookie：
cookie 以主機區分、不分埠，與正式環境同主機時，正式環境的 Secure cookie 會蓋掉同名 cookie，導致 staging 登入無限迴圈。

還原後執行還原目錄中的 `neutralize.sql`（compose 把主機上的還原目錄掛在 `/restore`）：停止繼承來的工作與排程、
刪除 OAuth token、停用所有模型端點，避免 staging 與正式環境搶用外部資源。

## 正式環境

根目錄 `compose.yaml` 的 `web-v2` 服務（`BACKEND_UPSTREAM=app:8000`）提供本前端；根目錄 `nginx/nginx.conf` 把
`/admin`、`/admin/` 與其餘頁面導向 `web-v2:80`，`/admin/api/*`、`/admin/ws`、`/mcp`、`/openapi.json`、`/tools/*`、
`/fhir-client/*`、`/fhir-oauth/*` 直接導向 `app`。舊的 Next.js `web/` 服務移到 compose profile `legacy-web`（預設不啟動，
僅供回滾：`docker compose --profile legacy-web up -d web` 並還原 `nginx.conf`）。

重新部署本前端：

```bash
docker compose build web-v2 && docker compose up -d --no-deps web-v2
```

本專案沒有 web-v2 的測試套件；提交前請跑 `npm run typecheck` 與 `npm run build`。
