# 常見問題 (FAQ)

這裡彙整了使用者在使用 Taiwan Health MCP 時最常遇到的問題。

## 分類瀏覽

### [操作與使用](usage.md)
查詢不到資料、關鍵字搜尋技巧等。

### [LOINC 相關](loinc.md)
LOINC 代碼對應與參考值疑問。

## 快速解答

### Q: 為什麼有些工具沒有出現？
**A**: 模組相關工具會依資料載入狀態自動啟用 / 停用。若對應模組尚未以 data-loader 載入（未達 row-count 門檻），相關工具就不會註冊。先用 `health_check` 確認各模組狀態，或執行對應的 `data-loader` 指令。

### Q: 搜尋結果為什麼像是只用關鍵字、不夠「語意」？
**A**: 語意 / 混合搜尋需要可達的 Ollama 嵌入服務（`OLLAMA_BASE_URL`）。未設定或無法連線時，搜尋會退回關鍵字模式，回應會帶 `keyword_only` 訊號。

### Q: 安裝與部署問題？
**A**: 見[快速開始](../getting-started.md)與[部署指南](../deployment/index.md)。

### Q: FHIR 格式與驗證問題？
**A**: 基本 Condition / Medication 轉換見[FHIR 工具](../tools/fhir-tools.md)；剖面 / 術語層級的授權與驗證見[FHIR IG 服務模組](../modules/fhir-ig-service.md)。
