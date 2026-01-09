# 部署指南

本章節說明如何將 Taiwan Health MCP 伺服器部署至生產環境。本專案採 Container-first 策略，強烈建議使用 Docker 進行部署以確保環境一致性。

## 支援環境
- **作業系統**：Linux (Ubuntu/CentOS), macOS, Windows (WSL2)
- **容器平台**：Docker, Kubernetes, Podman
- **Python 版本**：3.10+ (若需裸機部署)

## 部署選項

### [Docker 部署 (推薦)](docker.md)
最快速的啟動方式，包含所有相依套件與資料庫設定。

### [環境變數配置](configuration.md)
說明各項系統參數的設定方式，如資料路徑、日誌層級等。

### [效能與監控](performance.md)
針對高併發場景的優化建議與日誌管理策略。
