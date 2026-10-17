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

`deploy/staging/compose.yaml` 是一套與正式環境完全隔離的 stack：自己的 Postgres（由正式 DB dump 還原）、
Redis、MinIO（只鏡像來源檔與部分藥品資產）、app、worker 與本前端，入口 `http://<host>:8090/admin/`。

```bash
docker compose -f deploy/staging/compose.yaml up -d --build
```

還原後執行 `/home/brian/twh-staging-data/neutralize.sql`：停止繼承來的工作與排程、刪除 OAuth token、
停用所有模型端點，避免 staging 與正式環境搶用外部資源。

## 切換正式環境

1. 將本分支的後端變更（`/admin/api/modules/{key}/clear`、`/admin/api/me`、`jobs?limit=`、刪除來源檔的 FK 修正）
   部署到 `app` 與 `admin-worker`。
2. 在 `compose.yaml` 加入 `web-v2` 服務（`BACKEND_UPSTREAM=app:8000`），把根目錄 `nginx/nginx.conf` 的
   `/admin` 與 `/` 導向 `web-v2:80`，或直接讓 `web-v2` 取代 `nginx` 成為前門。
3. 將 `server.ts` 的 OAuth callback 轉址目標由 `/admin/modules/fhir-servers` 改為 `/admin/fhir-servers`。
4. 確認後移除 `web/` 與 `web` 容器。
