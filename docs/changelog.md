# 更新日誌

本頁面記錄 Taiwan Health MCP Server 的重要版本更新與變更內容。

---

## [未發布] - 2026-01-21

### ✨ 新增功能

#### 統一配置管理系統
- 新增 `src/config.py` 模組，提供統一的 MCP 配置管理
- 支援三種傳輸模式：
  - **stdio**：標準輸入輸出（Claude Desktop 本地開發）
  - **http**：Streamable HTTP（Docker 生產部署，推薦）
  - **sse**：Server-Sent Events（Colab + Ngrok，向後相容）

#### 環境變數配置
- 新增 `.env.example` 範本檔案，提供完整的配置範例
- 支援透過環境變數動態配置傳輸模式與網路設定
- 新增環境變數：
  - `MCP_TRANSPORT`：傳輸模式選擇
  - `MCP_HOST`：監聽主機
  - `MCP_PORT`：監聽埠號
  - `MCP_PATH`：HTTP 端點路徑

### 🔄 變更

#### Docker 部署優化
- 更新 `docker-compose.yml`，支援環境變數動態配置
- 埠號映射支援透過 `MCP_PORT` 環境變數設定
- 自動讀取 `.env` 檔案進行配置

#### 伺服器啟動優化
- 更新 `src/server.py`，使用新的配置管理系統
- 啟動時顯示配置資訊，提升可見性
- 移除硬編碼的 `sse` 傳輸模式，改為動態配置

### 📖 文件更新

- 更新 [環境配置文件](deployment/configuration.md)，新增 MCP 傳輸模式說明
- 更新 [Docker 部署指南](deployment/docker.md)，說明 `.env` 檔案使用方式
- 更新 [開發環境設置](development/setup.md)，新增環境變數配置步驟

### 🔧 技術細節

- 使用 Python `dataclass` 實現配置類別
- 支援環境變數驗證與預設值
- 提供 `get_run_kwargs()` 方法，簡化 `mcp.run()` 參數傳遞

---

## [v0.1.0] - 2024-XX-XX

### 初始版本
- 實作 ICD-10 診斷碼查詢服務
- 實作台灣藥品資料查詢服務
- 實作 FHIR R4 整合功能
- 實作檢驗數據 LOINC 映射
- 實作臨床指引查詢服務
- 提供 Docker 容器化部署
- 建立完整 MkDocs 技術文件

---

## 版本命名規則

本專案遵循 [語義化版本](https://semver.org/lang/zh-TW/) 規範：

- **主版本號 (MAJOR)**：不相容的 API 修改
- **次版本號 (MINOR)**：向下相容的功能性新增
- **修訂號 (PATCH)**：向下相容的問題修正

---

## 相關連結

- [GitHub Repository](https://github.com/audi0417/Taiwan-Health-MCP)
- [問題回報](https://github.com/audi0417/Taiwan-Health-MCP/issues)
- [貢獻指南](../CONTRIBUTING.md)
