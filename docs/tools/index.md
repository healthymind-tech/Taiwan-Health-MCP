# MCP 工具概覽

Taiwan Health MCP Server 提供 **37 個 MCP 工具**，其中包含 1 個 `health_check` 基礎工具，以及 11 個主要領域群組共 37 個工具。status page 與動態註冊使用同一份工具 registry，新增或調整工具時請同步更新群組定義與對應說明。

---

## 基礎工具

| 工具 | 說明 |
|------|------|
| `health_check` | 檢查資料庫、快取與各服務初始化狀態 |

---

## 工具分類索引

### 群組 1 — ICD-10 診斷與手術碼（5 個工具）

| 工具 | 說明 |
|------|------|
| `search_medical_codes` | 搜尋 ICD-10-CM 診斷碼或 ICD-10-PCS 手術碼 |
| `infer_complications` | 依據 ICD 階層推論潛在併發症 |
| `get_nearby_codes` | 取得目標碼的前後相鄰碼 |
| `check_medical_conflict` | 診斷碼與手術碼衝突分析 |
| `browse_icd_category` | 依 ICD 類別瀏覽診斷碼 |

[詳細說明](icd-tools.md)

---

### 群組 2 — 台灣 FDA 藥品（3 個工具）

| 工具 | 說明 |
|------|------|
| `search_drug` | 單一藥品搜尋入口，`mode` 可切換 `drug_name` / `atc_code` / `ingredient` / `license_id`；`drug_name` / `ingredient` 用語意搜尋，`atc_code` 只接受 code 前綴，`license_id` 支援 bare digits；回傳統一 detail-shaped 結果 |
| `identify_unknown_pill` | 依外觀特徵（形狀、顏色、刻痕）識別藥錠 |

[詳細說明](drug-tools.md)

---

### 群組 3 — 台灣 FDA 健康補充品（1 個工具）

| 工具 | 說明 |
|------|------|
| `search_health_supplement` | 單一健康補充品入口，`mode` 可切換 `keyword` / `permit_no` / `condition`；只有 `condition` 會回傳頂層 `icd_code` / `recommended_benefits`，results item 不含這兩欄 |

[詳細說明](health-food-tools.md)

---

### 群組 4 — 食品營養（6 個工具）

| 工具 | 說明 |
|------|------|
| `search_food_nutrition` | 搜尋食品營養成分 |
| `get_detailed_nutrition` | 取得特定食品完整營養分析 |
| `search_food_ingredient` | 搜尋食品原料/添加物 |
| `get_ingredients_by_category` | 依分類查詢食品原料 |
| `search_foods_by_nutrient` | 依特定營養素排名食品 |
| `analyze_meal_nutrition` | 分析多種食品組合的整體營養 |

[詳細說明](nutrition-tools.md)

---

### 群組 5 — FHIR Condition（2 個工具）

| 工具 | 說明 |
|------|------|
| `query_fhir_condition` | ICD-10/關鍵字 → FHIR R4 Condition 資源 |
| `validate_fhir_condition` | 驗證 FHIR R4 Condition 資源 |

[詳細說明](fhir-tools.md)

---

### 群組 6 — FHIR Medication（2 個工具）

| 工具 | 說明 |
|------|------|
| `query_fhir_medication` | 藥品/許可證字號 → FHIR Medication / MedicationKnowledge |
| `validate_fhir_medication` | 驗證 FHIR Medication/MedicationKnowledge |

[詳細說明](fhir-tools.md)

---

### 群組 7 — 檢驗 / LOINC（8 個工具）

| 工具 | 說明 |
|------|------|
| `search_loinc_code` | 搜尋 LOINC 檢驗碼與別名；用來先找到可能的 test code，再搭配 `get_loinc_detail` 或 `get_reference_range` 深入查看 |
| `list_lab_categories` | 列出所有檢驗分類 |
| `get_reference_range` | 依 LOINC 碼、年齡、性別取得參考值 |
| `interpret_lab_result` | 判讀單項檢驗結果 |
| `search_loinc_by_specimen` | 依檢體類型搜尋 LOINC |
| `find_related_loinc_tests` | 找出相同 analyte 的相關檢驗 |
| `get_loinc_detail` | 取得 LOINC 完整概念細節 |
| `batch_interpret_lab_results` | 批次判讀多項檢驗 |

[詳細說明](lab-tools.md)

---

### 群組 8 — 臨床診療指引（2 個工具）

| 工具 | 說明 |
|------|------|
| `search_clinical_guideline` | 搜尋台灣醫學會臨床指引 |
| `query_guideline` | 統一指引入口，`section` 可切換 `complete` / `medication` / `test` / `goals` / `pathway`，適合在同一工具下切換不同層次的臨床內容 |

[詳細說明](guideline-tools.md)

---

### 群組 9 — TWCore IG（1 個工具）

| 工具 | 說明 |
|------|------|
| `query_twcore_code` | 依 code 或 keyword 查詢 TWCore CodeSystem |

---

### 群組 10 — SNOMED CT（4 個工具）

> 需先執行 `docker compose --profile loader run --rm data-loader --snomed`

| 工具 | 說明 |
|------|------|
| `search_snomed_concept` | 以英文詞彙搜尋 SNOMED CT 概念，適合先找候選概念與相似詞 |
| `query_snomed_concept` | 取得概念、父概念與子概念的一次性查詢，適合閱讀分類樹脈絡 |
| `get_snomed_relationships` | 取得非 IS-A 的屬性與關聯，適合看 finding site / causative agent / active ingredient |
| `query_snomed_mapping` | 單一 SNOMED mapping 入口，`mode` 可切換 `icd` / `snomed`；適合雙向轉碼 |

---

### 群組 11 — RxNorm 藥物交互作用（3 個工具）

> 需先執行 `docker compose --profile loader run --rm data-loader --rxnorm`

| 工具 | 說明 |
|------|------|
| `check_drug_interactions` | 檢查多種藥物間的交互作用 |
| `resolve_rxnorm_drug` | 藥品名稱 → RxNorm RXCUI |
| `get_drug_ingredients_rxnorm` | 依 RXCUI 取得藥物成分 |

---

## 如何呼叫工具

本伺服器遵循 Model Context Protocol (MCP) 標準，使用 JSON-RPC 2.0 格式。

```bash
# 建立 session
curl http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":"2024-11-05",
    "capabilities":{},
    "clientInfo":{"name":"my-client","version":"1"}
  }}'

# 呼叫工具（使用上面取得的 mcp-session-id）
curl http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
    "name":"search_medical_codes",
    "arguments":{"keyword":"糖尿病","type":"diagnosis"}
  }}'
```

---

## 服務降級

SNOMED CT 和 RxNorm 工具在資料未載入時會回傳結構化錯誤，而非拋出例外：

```json
{
  "error": "SNOMED CT service is not available",
  "hint": "Run the data-loader to populate this dataset, then restart the server."
}
```

其他所有工具（ICD、藥品、LOINC 等）在初始化失敗時同樣降級為錯誤訊息。
