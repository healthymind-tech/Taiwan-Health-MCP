# 隱私政策頁面

Taiwan Health MCP Server 在 `/privacy` 路徑提供一個靜態 HTML 隱私政策頁面，
供 Anthropic Connectors Directory 審核及使用者查閱。

## 存取方式

伺服器啟動後，隱私政策頁面可透過以下 URL 存取：

```
https://<your-domain>/privacy
```

本地測試：

```bash
curl http://localhost:8000/privacy
```

## 實作方式

隱私政策由 `server.py` 中的 `PrivacyPageMiddleware` 提供，
攔截所有 `GET /privacy` 請求並回傳靜態 HTML。
不依賴資料庫或快取，即使服務尚未完全初始化也可存取。

回應標頭：
- `Content-Type: text/html; charset=utf-8`
- `Cache-Control: public, max-age=86400`（可由 HTTPS proxy 快取一天）

## 隱私政策摘要

| 項目 | 說明 |
|------|------|
| 個人資料收集 | 不收集任何個人資料 |
| Audit log | 僅記錄工具名稱、SHA-256(參數)、執行時間、時間戳記 |
| 原始參數值 | 永不寫入 log（HIPAA 設計） |
| 第三方分享 | 不分享給任何第三方（Anthropic 自身遙測除外） |
| 資料保留 | Audit log 保留 90 天；Redis 快取依 TTL 自動過期 |
| 使用者帳號 | 不需要帳號，不儲存 session token 或 cookie |

## 更新隱私政策

隱私政策內容直接定義在 `src/server.py` 的 `_PRIVACY_HTML` 字串中。
若需更新，修改該字串後重新部署即可。

若使用 HTTPS proxy（Nginx、Cloudflare 等），可在 proxy 層設定快取，
無需每次請求都到達 app server：

```nginx
location /privacy {
    proxy_pass http://app:8000/privacy;
    proxy_cache_valid 200 1d;
}
```
