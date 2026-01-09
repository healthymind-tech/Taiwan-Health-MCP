# FHIR 相關問題

### Q: 產生的 Condition 資源是哪個版本？
**A**: 目前完全遵循 **FHIR R4 (Release 4)** 標準。

### Q: 為什麼 Medication 資源沒有使用 RxNorm？
**A**: 台灣藥品使用衛福部許可證字號作為主要識別碼。雖然 RxNorm 是國際標準，但在台灣本地化應用中，許可證字號更具實用性與法規效力。我們使用自定義 System URI (`http://tw-fda.gov.tw/product-license`) 來封裝。

### Q: 可以直接將產出的 JSON 匯入 Google Health API 嗎？
**A**: 理論上可以，因為格式符合標準。但請注意 Google Health API 可能對某些欄位有特定的驗證規則 (Validation Rules)，可能需要微調。
