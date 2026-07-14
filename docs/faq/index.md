# 常見問題 (FAQ)

這裡彙整了使用者在使用 Taiwan Health MCP 時最常遇到的問題。

## 分類瀏覽

### [操作與使用](usage.md)
查詢不到資料、關鍵字搜尋技巧等。

### [LOINC 相關](loinc.md)
LOINC 代碼對應與參考值疑問。

## 快速解答

### Q: 為什麼有些工具沒有出現？
**A**: 模組相關工具會依資料載入狀態自動啟用 / 停用。若對應模組尚未匯入（未達 row-count 門檻），相關工具就不會註冊。先用 `health_check` 確認各模組狀態，或於 Admin → Modules 匯入對應模組。

### Q: 搜尋結果為什麼像是只用關鍵字、不夠「語意」？
**A**: 語意 / 混合搜尋需要一個可達的嵌入端點（預設為 Ollama）。端點設定在管理後台 **Settings → LLM Profiles**（存於 `admin.llm_profiles`），**不是環境變數**。未設定或無法連線時，搜尋會退回關鍵字模式，回應會帶 `keyword_only` 訊號。另外請注意：各模組的向量需先由 `*_embed` 工作回填，否則即使端點可用也只有關鍵字結果。

### Q: 安裝與部署問題？
**A**: 見[快速開始](../getting-started.md)與[部署指南](../deployment/index.md)。

### Q: FHIR 格式與驗證問題？
**A**: 基本 Condition / Medication 轉換見[FHIR 工具](../tools/fhir-tools.md)；剖面 / 術語層級的授權與驗證見[FHIR IG 服務模組](../modules/fhir-ig-service.md)。
