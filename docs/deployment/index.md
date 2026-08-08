# 部署指南

本章節說明如何將 Taiwan Health MCP 伺服器部署至生產環境。本專案採 Container-first 策略，強烈建議使用 Docker 部署以確保環境一致性。

## 支援環境
- **作業系統**：Linux (Ubuntu/CentOS)、macOS、Windows (WSL2)
- **容器平台**：Docker、Kubernetes、Podman
- **Node.js 版本**：20 以上（裸機部署或本機開發時）。本專案已無 Python 執行期相依。

## 服務組成

`docker compose up -d` 會啟動下列服務：

| 服務 | 說明 |
|------|------|
| `nginx` | **單一對外入口**（預設 `:8080`，由 `WEB_PORT` 設定）。把 `/mcp`、`/openapi.json`、`/tools/*`、`/admin/api/*`、`/admin/ws`、`/fhir-client/*`、`/fhir-oauth/*` 導向 `app`，其餘全部導向 `web`。 |
| `web` | Next.js 前端：`/admin` 管理後台 SPA。 |
| `app` | Node MCP 伺服器 + 管理後台 REST API。**只在 compose 內部網路上 `expose` 8000 埠，不對主機發佈。** |
| `admin-worker` | 背景工作執行器：所有匯入（含藥品三階段管線）與嵌入工作。 |
| `postgres` | PostgreSQL 16 + pgvector。 |
| `pgbouncer` | 連線池（transaction mode）。 |
| `redis` | 回應快取。 |
| `minio` + `minio-init` | 藥品資產物件儲存與 bucket 初始化。 |

資料匯入由管理後台觸發、在 `admin-worker` 內執行，已無獨立的 data-loader 容器。

!!! warning "對外只開 nginx"
    不要在文件或客戶端設定中使用 `http://<host>:8000` —— `app` 沒有對主機開放該埠。
    所有流量（含 MCP）都必須經由 `http://<host>:8080`。

## 部署選項

### [架構與容器部署](../architecture/deployment.md)
基礎設施拓樸、容器組成與啟動流程。快速啟動步驟見[快速開始](../getting-started.md)。

### [環境變數配置](configuration.md)
各項系統參數的設定方式，含 bootstrap 變數（`.env`）與 seed-only 設定（首次啟動後改於 Admin → Settings 管理）。

### [效能與監控](performance.md)
高併發場景的優化建議、連線池與快取策略、Prometheus 監控。

!!! note "公開頁面已移出本專案"
    對外的宣傳頁與法務頁（`/`、`/status`、`/privacy`、`/dpa`）已改由獨立的宣傳網站專案提供，
    不再由 `web` 服務發送。`/privacy` 是登記於 Anthropic Connectors Directory 的網址，
    移轉後務必在 `nginx/nginx.conf` 補上 301 導向（該檔已留有 TODO 區塊）。

## 資料庫遷移
首次啟動時 `db/schema.sql` 會自動套用。既有環境的增量變更位於 `db/migrations/`，請依檔名日期順序套用。
