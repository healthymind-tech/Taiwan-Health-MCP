# 監控與日誌

## 日誌管理
系統日誌分為兩大類：
1. **系統日誌 (System Logs)**：服務啟動、錯誤堆疊 (Stack trace)。
2. **工具呼叫日誌 (Audit Logs)**：記錄每次工具呼叫的參數與執行時間 (如 `Tool called: search_medical_codes...`)。

### 檢視方式
- **Docker**：`docker logs health-mcp`
- **Stdio**：若以 Stdio 模式運行，日誌會輸出至 `stderr`，不會干擾 `stdout` 的 JSON-RPC 通訊。

## 健康檢查 (Health Check)
目前版本尚未內建特定 Health Check API Endpoint (因 MCP 主要為工具介面)。
建議監控容器狀態：
- Check if process is running.
- Check if `drugs.db` and `icd.db` files exist and are readable.
