# 架構設計文件

本章節深入探討 Taiwan Health MCP 的技術實作細節，包括系統架構、資料流向以及模組間的相依關係。這些文件有助於架構師與資深開發者評估本系統的整合性與擴展性。

## 文件索引

### [系統架構概觀](system-architecture.md)
從高層次視角說明 MCP Server 與 Client 的互動模式。

### [資料流程 (Data Flow)](data-flow.md)
追蹤從使用者請求到資料庫查詢，最終回傳結構化回應的完整路徑。

### [模組關係圖](module-relations.md)
展示各服務模組 (Service Layer) 之間的耦合關係與依賴方向。

### [部署架構](deployment.md)
說明容器化部署的拓撲結構與資料持久層設計。
