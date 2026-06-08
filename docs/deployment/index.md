# 部署指南

本章節說明如何將 Taiwan Health MCP 伺服器部署至生產環境。本專案採 Container-first 策略，強烈建議使用 Docker 部署以確保環境一致性。

## 支援環境
- **作業系統**：Linux (Ubuntu/CentOS)、macOS、Windows (WSL2)
- **容器平台**：Docker、Kubernetes、Podman
- **Python 版本**：3.12+（裸機部署時）

## 服務組成
`docker compose up -d` 會啟動：`postgres`（pgvector）、`pgbouncer`、`redis`、`minio` + `minio-init`、`app`（MCP 伺服器 + 管理後台），以及 `admin-worker`（背景工作執行器）。資料匯入由管理後台觸發、在 `admin-worker` 內執行，已無獨立的 data-loader 容器。

## 部署選項

### [架構與容器部署](../architecture/deployment.md)
基礎設施拓樸、容器組成與啟動流程。快速啟動步驟見[快速開始](../getting-started.md)。

### [環境變數配置](configuration.md)
各項系統參數的設定方式，含 bootstrap 變數（`.env`）與 seed-only 設定（首次啟動後改於 Admin → Settings 管理）。

### [效能與監控](performance.md)
高併發場景的優化建議、連線池與快取策略、Prometheus 監控。

### [資料處理附錄 (DPA)](dpa.md)
資料處理與合規說明。

### [隱私政策頁面](privacy.md)
`/privacy` 端點說明，供 Anthropic Connectors Directory 審核使用。

## 資料庫遷移
首次啟動時 `db/schema.sql` 會自動套用。既有環境的增量變更位於 `db/migrations/`，請依檔名日期順序套用。
