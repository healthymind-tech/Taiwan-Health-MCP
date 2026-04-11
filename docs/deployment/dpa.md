# 資料處理協議頁面 (DPA)

Taiwan Health MCP Server 在 `/dpa` 路徑提供靜態 HTML 資料處理協議（Data Processing Agreement），
供 Anthropic Remote MCP Server 目錄審核及使用者查閱。

## 存取方式

```
https://<your-domain>/dpa
```

本地測試：

```bash
curl http://localhost:8000/dpa
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

## 實作方式

DPA 頁面由 `server.py` 中的 `PrivacyPageMiddleware` 提供，
與 `/privacy` 頁面共用同一個中介層。攔截 `GET /dpa` 請求並回傳靜態 HTML。

回應標頭：
- `Content-Type: text/html; charset=utf-8`
- `Cache-Control: public, max-age=86400`

## 更新 DPA

DPA 內容定義在 `src/server.py` 的 `_DPA_HTML` 字串中。修改後重新部署即可。

## Nginx 快取設定（選用）

```nginx
location /dpa {
    proxy_pass http://app:8000/dpa;
    proxy_cache_valid 200 1d;
}
```
