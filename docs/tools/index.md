# MCP 工具概覽

本頁面列出 Taiwan Health MCP 伺服器所提供的 **43 個**工具函數。這些工具設計用於讓大型語言模型 (LLM) 或其他客戶端程式呼叫，以獲取結構化的醫療數據或執行特定的分析任務。

## 工具分類索引

### 1. ICD-10 診斷與處置工具（4 個）
用於查詢標準化疾病與手術編碼、併發症推論、診斷衝突檢查。
- [詳細說明](icd-tools.md)

### 2. 台灣 FDA 藥品工具（4 個）
查詢 TFDA 核准藥品、外觀識別、綜合治療計畫分析。
- [詳細說明](drug-tools.md)

### 3. 健康食品工具（2 個）
查詢 TFDA 核可健康食品與保健功效。
- [詳細說明](health-food-tools.md)

### 4. 營養與飲食工具（5 個）
食品營養成分查詢、膳食分析、食品原料查詢。
- [詳細說明](nutrition-tools.md)

### 5. 檢驗工具 LOINC（5 個）
LOINC 碼對照、參考值查詢、檢驗結果判讀、批次判讀。
- [詳細說明](lab-tools.md)

### 6. 臨床指引工具（6 個）
台灣醫學會臨床指引查詢、診療建議、治療路徑規劃。
- [詳細說明](guideline-tools.md)

### 7. FHIR 互通性工具（7 個）
產生符合 FHIR R4 標準的 Condition、Medication、MedicationKnowledge 資源。
- [詳細說明](fhir-tools.md)

### 8. TWCore IG 工具（6 個）
即時查詢臺灣核心實作指引 30 個 CodeSystem（藥品、診斷、機構、行政）。
- [詳細說明](twcore-tools.md)

### 9. FDA 藥品不良反應工具（3 個）
查詢 openFDA FAERS 不良反應報告、安全性摘要、召回紀錄。
- [詳細說明](fda-adverse-events-tools.md)

### 10. 綜合分析工具（1 個）
跨資料來源的治療計畫分析（ICD-10 × 藥品 × 健康食品）。

---

## 如何呼叫工具

本伺服器遵循 Model Context Protocol (MCP) 標準。客戶端透過標準 JSON-RPC 格式發送工具呼叫請求，確保參數名稱與型別符合各工具文件的定義。

快速接入：在 Claude Desktop `claude_desktop_config.json` 加入：

```json
{
  "mcpServers": {
    "taiwan-health": {
      "url": "https://tw-health-mcp.healthymind-tech.com/mcp",
      "type": "streamable-http"
    }
  }
}
```
