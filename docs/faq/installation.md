# 安裝問題

### Q: 啟動時出現 "No Excel file found" 錯誤？
**A**: 這表示系統在 `/data` 目錄下找不到 ICD-10 的 Excel 檔案。請確保您已將檔案放入宿主機的掛載目錄，且副檔名為 `.xlsx`。

### Q: Docker 容器一直重啟 (Restarting)？
**A**:
1. 檢查記憶體分配是否足夠（建議至少 2GB）。
2. 檢查日誌 (`docker logs health-mcp`) 是否有 Python 拋出的例外錯誤。
3. 確認埠號 (8000) 未被佔用。

### Q: 為什麼第一次啟動這麼慢？
**A**: 初次啟動時，系統需要解析龐大的 Excel 檔案並寫入 SQLite 資料庫。這是一次性的 ETL 過程，之後重啟會非常快。
