# 資料處理協議頁面 (DPA)

Taiwan Health MCP Server 在 `/dpa` 路徑提供靜態 HTML 資料處理協議（Data Processing Agreement），
供 Anthropic Remote MCP Server 目錄審核及使用者查閱。

## 存取方式

```
https://<your-domain>/dpa
```

本地測試（經由 nginx 前門，預設 `:8080`）：

```bash
curl http://localhost:8080/dpa
```

## DPA 摘要

| 項目 | 說明 |
|------|------|
| 資料控制者 | HealthyMind Tech（Operator） |
| 處理目的 | 僅用於回應 MCP 工具呼叫請求 |
| 個人資料收集 | 不收集任何 PII 或個人健康資料 |
| Audit log | 保留工具名稱、SHA-256(參數)、時間戳記，保留 90 天 |
| 原始參數 | 永不寫入 log（HIPAA 設計） |
| Redis 快取 | 依 TTL 自動過期（1–24 小時） |
| 次處理者 | PostgreSQL、Redis（自建）、Anthropic 平台 |
| 資料境外傳輸 | 僅透過 Anthropic 平台（美國）；Operator 本身不境外傳輸 |
| 安全措施 | HTTPS、Docker 網路隔離、append-only audit log |
| 違反通知 | 72 小時內通知（依法規要求） |
| 準據法 | 中華民國（台灣）法律，台北地方法院管轄 |

## 唯讀範圍與唯一例外

49 個工具中有 48 個對系統自身的資料做唯讀查詢。唯一例外是 **`crud_fhir_server`**：
它會把 FHIR 請求轉送到**管理者已明確登錄**的外部 FHIR 伺服器。寫入操作
（create / update / patch / delete）必須同時滿足兩個條件才會執行 ——
該伺服器的 allow-list 允許該操作，且呼叫端帶入 `confirm_write=true`。

此類請求中的個人健康資料由呼叫端提供、直接轉送至該外部伺服器，本服務不予保留。
啟用外部伺服器寫入權限的 Operator，對該處理行為負控制者責任。

## 實作方式

`/dpa` 由 **Next.js `web` 服務**提供（不再是後端的中介層）：

| 項目 | 位置 |
|------|------|
| 路由 | `web/app/dpa/route.ts`（`export const dynamic = "force-static"`） |
| 內容 | `web/legacy/dpa.html` |
| 深色模式注入 | `web/lib/legacy.ts` 的 `withDarkMode()` |
| 回應標頭 | `Content-Type: text/html; charset=utf-8` |

nginx 將所有非 API 路徑導向 `web`，因此 `/dpa` 不經過 `app` 容器。

## 更新 DPA

1. 修改 `web/legacy/dpa.html`。
2. 重新建置並部署 `web` 服務：

   ```bash
   docker compose build web && docker compose up -d --no-deps web
   ```
