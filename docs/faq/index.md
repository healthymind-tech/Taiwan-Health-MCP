# 常見問題 (FAQ)

這裡彙整了使用者在使用 Taiwan Health MCP 時最常遇到的問題。

## 分類瀏覽

### [操作與使用](usage.md)
查詢不到資料、關鍵字搜尋技巧等。

### [LOINC 相關](loinc.md)
LOINC 代碼對應與參考值疑問。

## 快速解答

### Q: 為什麼有些工具沒有出現？
**A**: 模組相關工具會依資料載入狀態自動啟用 / 停用。若對應模組尚未匯入（未達 row-count 門檻），相關工具就不會註冊。先用 `health_check` 確認各模組狀態（`services`），或於管理後台的模組頁匯入。管理後台 **整合 → MCP 工具** 的工具目錄也會列出每個工具目前是否註冊、以及未註冊的原因。

### Q: 搜尋結果為什麼像是只用關鍵字、不夠「語意」？
**A**: 語意 / 混合搜尋需要一個可達的嵌入端點（例如 Ollama）。端點設定在管理後台 **整合 → 模型端點**（provider 帳號 + embedding 路由，存於 `admin.llm_providers` / `admin.llm_routes` 等表），**不是環境變數**。未設定或無法連線時，搜尋會退回關鍵字模式，回應會帶 `keyword_only` 訊號。另外請注意：各模組的向量需先由 `*_embed` 工作回填，否則即使端點可用也只有關鍵字結果。

### Q: FHIR IG 工具回傳 `NO_DEFAULT_IG`？
**A**: 呼叫時沒有帶 `package_id`、參數裡的 canonical 也找不到所屬套件，而系統又沒有設定預設 IG（且手動安裝的 IG 不只一個）。請在管理後台 **FHIR → IG 套件庫** 設定預設 IG，或呼叫時指定 `package_id`。實際採用的套件會寫在回應的 `provenance.resolved_by`。

### Q: 安裝與部署問題？
**A**: 見[快速開始](../getting-started.md)與[部署指南](../deployment/index.md)。

### Q: FHIR 格式與驗證問題？
**A**: 基本 Condition / Medication 轉換見[FHIR 工具](../tools/fhir-tools.md)；剖面 / 術語層級的授權與驗證見[FHIR IG 服務模組](../modules/fhir-ig-service.md)。
