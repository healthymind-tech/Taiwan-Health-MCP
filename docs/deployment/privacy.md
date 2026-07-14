# 隱私政策頁面

Taiwan Health MCP Server 在 `/privacy` 路徑提供一個靜態 HTML 隱私政策頁面，
供 Anthropic Connectors Directory 審核及使用者查閱。

## 存取方式

伺服器啟動後，隱私政策頁面可透過以下 URL 存取：

```
https://<your-domain>/privacy
```

本地測試（經由 nginx 前門，預設 `:8080`）：

```bash
curl http://localhost:8080/privacy
```

## 實作方式

`/privacy` 由 **Next.js `web` 服務**提供（不再是後端的中介層）：

| 項目 | 位置 |
|------|------|
| 路由 | `web/app/privacy/route.ts`（`export const dynamic = "force-static"`） |
| 內容 | `web/legacy/privacy.html` |
| 深色模式注入 | `web/lib/legacy.ts` 的 `withDarkMode()`（在 `</head>` 前插入 theme script 與 CSS） |
| 回應標頭 | `Content-Type: text/html; charset=utf-8` |

nginx 將所有非 API 路徑導向 `web`，因此 `/privacy` 不經過 `app` 容器，
即使後端或資料庫異常也能存取。

## 隱私政策摘要

| 項目 | 說明 |
|------|------|
| 個人資料收集 | 不收集任何個人資料 |
| Audit log | 僅記錄工具名稱、SHA-256(參數)、執行時間、時間戳記 |
| 原始參數值 | 永不寫入 log（HIPAA 設計） |
| 第三方分享 | 不分享給任何第三方（Anthropic 自身遙測除外） |
| 資料保留 | Audit log 保留 90 天；Redis 快取依 TTL 自動過期 |
| 使用者帳號 | MCP 工具面不需要帳號，不儲存 session token 或 cookie |
| 寫入行為 | 系統本身的醫療資料為唯讀。唯一例外是 `crud_fhir_server`，它會把請求轉送到**管理者已登錄的外部 FHIR 伺服器**（詳見 [DPA](dpa.md)） |

## 更新隱私政策

1. 修改 `web/legacy/privacy.html`。
2. 重新建置並部署 `web` 服務：

   ```bash
   docker compose build web && docker compose up -d --no-deps web
   ```
