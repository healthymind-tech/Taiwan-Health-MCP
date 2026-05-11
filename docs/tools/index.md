# MCP 工具概覽

Taiwan Health MCP 提供 **28 個**工具函數，由動態 registry 管理。工具會根據已載入的資料集自動啟用或停用（`health_check` 永遠可用）。

快速接入：在 Claude Desktop `claude_desktop_config.json` 加入：

```json
{
  "mcpServers": {
    "taiwan-health": {
      "url": "https://tw-health-mcp.healthymind-tech.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

---

## 工具分類索引

### 系統（1 個）

| 工具 | 說明 |
|------|------|
| `health_check` | 回傳 MCP server 與每個資料集的就緒狀態（永遠可用） |

---

### ICD-10（5 個） — [詳細說明](icd-tools.md)

| 工具 | 說明 |
|------|------|
| `search_medical_codes` | ICD-10-CM 2025 診斷碼 + ICD-10-PCS 2025 處置碼搜尋 |
| `infer_complications` | 依 ICD-10 階層推論潛在併發症或子代碼 |
| `get_nearby_codes` | 取得指定碼的前後相鄰碼 |
| `check_medical_conflict` | 並排取得一組診斷碼 + 處置碼的完整詮釋資料 |
| `browse_icd_category` | 依章節或三碼分類瀏覽 ICD-10-CM 結構 |

---

### 藥品（2 個） — [詳細說明](drug-tools.md)

| 工具 | 說明 |
|------|------|
| `search_drug` | 統一入口：TFDA 藥品名稱 / ATC / 成分 / 許可證 / RxNorm 解析 / 交互作用 |
| `identify_unknown_pill` | 依外觀（顏色、形狀、刻痕）辨識台灣 FDA 藥品 |

---

### 健康補充品（1 個） — [詳細說明](health-food-tools.md)

| 工具 | 說明 |
|------|------|
| `search_health_supplement` | 查詢 TFDA 核可健康食品（關鍵字 / 許可證 / 疾病情境推薦） |

---

### 食品與營養（4 個） — [詳細說明](nutrition-tools.md)

| 工具 | 說明 |
|------|------|
| `query_food_nutrition` | 查詢每 100g 的食品營養成分 |
| `query_food_ingredient` | 查詢食品原料合規分類 |
| `search_foods_by_nutrient` | 依特定營養素含量排序列出食品 |
| `analyze_meal_nutrition` | 餐點多品項營養彙總分析 |

---

### FHIR（4 個） — [詳細說明](fhir-tools.md)

| 工具 | 說明 |
|------|------|
| `query_fhir_condition` | ICD-10 碼或關鍵字 → FHIR R4 Condition 資源 |
| `validate_fhir_condition` | 驗證 FHIR R4 Condition 必要欄位與 value set |
| `query_fhir_medication` | 台灣 FDA 藥品 → FHIR R4 Medication / MedicationKnowledge |
| `validate_fhir_medication` | 驗證 FHIR R4 Medication 結構與欄位語意 |

---

### LOINC / Lab（4 個） — [詳細說明](lab-tools.md)

| 工具 | 說明 |
|------|------|
| `search_loinc` | 依模式搜尋 87,000+ LOINC 碼與分類 |
| `query_loinc` | 查詢已知 LOINC 碼的完整詮釋資料與參考值 |
| `interpret_lab_result` | 單項檢驗結果對照 LOINC 參考值範圍判讀 |
| `batch_interpret_lab_results` | 批次判讀多項檢驗結果 |

---

### 臨床指引（2 個） — [詳細說明](guideline-tools.md)

| 工具 | 說明 |
|------|------|
| `search_clinical_guideline` | 依疾病名稱或 ICD-10 碼搜尋台灣臨床指引 |
| `query_guideline` | 取得臨床指引特定段落內容 |

---

### TWCore IG（1 個） — [詳細說明](twcore-tools.md)

| 工具 | 說明 |
|------|------|
| `query_twcore_code` | 台灣核心 30+ CodeSystem 統一查詢入口（藥品、診斷、機構、行政） |

---

### SNOMED CT（4 個） — [詳細說明](snomed-tools.md)

| 工具 | 說明 |
|------|------|
| `search_snomed_concept` | 搜尋 SNOMED CT 370,000+ 臨床概念（英文） |
| `query_snomed_concept` | 取得概念詳情與可選 IS-A 階層展開 |
| `get_snomed_relationships` | 取得概念的臨床屬性關聯（非 IS-A） |
| `query_snomed_mapping` | ICD-10-CM ↔ SNOMED CT 雙向對應 |
