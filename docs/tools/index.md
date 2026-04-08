# MCP 工具概覽

Taiwan Health MCP Server 提供 **46 個 MCP 工具**，分為 12 個群組。

---

## 工具分類索引

### 群組 1 — ICD-10 診斷與手術碼（4 個工具）

| 工具 | 說明 |
|------|------|
| `search_medical_codes` | 搜尋 ICD-10-CM 診斷碼或 ICD-10-PCS 手術碼 |
| `infer_complications` | 依據 ICD 階層推論潛在併發症 |
| `get_nearby_codes` | 取得目標碼的前後相鄰碼 |
| `check_medical_conflict` | 診斷碼與手術碼衝突分析 |

[詳細說明](icd-tools.md)

---

### 群組 2 — 台灣 FDA 藥品（3 個工具）

| 工具 | 說明 |
|------|------|
| `search_drug_info` | 以中英文名稱或適應症搜尋 FDA 核准藥品 |
| `get_drug_details` | 依許可證字號取得完整藥品資訊 |
| `identify_unknown_pill` | 依外觀特徵（形狀、顏色、刻痕）識別藥錠 |

[詳細說明](drug-tools.md)

---

### 群組 3 — 台灣 FDA 健康食品（2 個工具）

| 工具 | 說明 |
|------|------|
| `search_health_food` | 搜尋 FDA 核可健康食品 |
| `get_health_food_details` | 依許可證號取得健康食品完整資訊 |

[詳細說明](health-food-tools.md)

---

### 群組 4 — 食品營養（4 個工具）

| 工具 | 說明 |
|------|------|
| `search_food_nutrition` | 搜尋食品營養成分 |
| `get_detailed_nutrition` | 取得特定食品完整營養分析 |
| `search_food_ingredient` | 搜尋食品原料/添加物 |
| `analyze_meal_nutrition` | 分析多種食品組合的整體營養 |

[詳細說明](nutrition-tools.md)

---

### 群組 5 — 健康食品 + ICD 整合（1 個工具）

| 工具 | 說明 |
|------|------|
| `analyze_health_support_for_condition` | 依診斷推薦 FDA 核可保健食品 |

---

### 群組 6 — FHIR Condition（3 個工具）

| 工具 | 說明 |
|------|------|
| `create_fhir_condition` | ICD-10-CM 碼 → FHIR R4 Condition 資源 |
| `create_fhir_condition_from_diagnosis` | 依關鍵字自動搜尋並建立 FHIR Condition |
| `validate_fhir_condition` | 驗證 FHIR R4 Condition 資源 |

[詳細說明](fhir-tools.md)

---

### 群組 7 — FHIR Medication（4 個工具）

| 工具 | 說明 |
|------|------|
| `search_medication_fhir` | 搜尋藥品並建立 FHIR Medication 資源 |
| `create_fhir_medication` | 依許可證字號建立 FHIR Medication |
| `create_fhir_medication_from_drug` | 依許可證字號建立 FHIR MedicationKnowledge |
| `validate_fhir_medication` | 驗證 FHIR Medication/MedicationKnowledge |

[詳細說明](fhir-tools.md)

---

### 群組 8 — 檢驗 / LOINC（5 個工具）

| 工具 | 說明 |
|------|------|
| `search_loinc_code` | 搜尋 LOINC 碼（含中文名稱） |
| `list_lab_categories` | 列出所有檢驗分類 |
| `get_reference_range` | 依 LOINC 碼、年齡、性別取得參考值 |
| `interpret_lab_result` | 判讀單項檢驗結果 |
| `batch_interpret_lab_results` | 批次判讀多項檢驗 |

[詳細說明](lab-tools.md)

---

### 群組 9 — 臨床診療指引（5 個工具）

| 工具 | 說明 |
|------|------|
| `search_clinical_guideline` | 搜尋台灣醫學會臨床指引 |
| `get_complete_guideline` | 取得疾病完整指引（診斷、用藥、檢查、目標） |
| `get_medication_recommendations` | 取得用藥建議 |
| `get_test_recommendations` | 取得建議檢查項目 |
| `get_treatment_goals` | 取得治療目標 |
| `suggest_clinical_pathway` | 依指引規劃臨床路徑 |

[詳細說明](guideline-tools.md)

---

### 群組 10 — TWCore IG（3 個工具）

| 工具 | 說明 |
|------|------|
| `list_twcore_codesystems` | 列出所有 TWCore IG CodeSystem |
| `search_twcore_code` | 跨 CodeSystem 搜尋代碼 |
| `lookup_twcore_code` | 精確查詢單一代碼（回傳 FHIR Coding） |

---

### 群組 11 — SNOMED CT（6 個工具）

> 需先執行 `docker compose --profile loader run --rm data-loader --snomed`

| 工具 | 說明 |
|------|------|
| `search_snomed_concept` | 以英文詞彙搜尋 SNOMED CT 概念 |
| `get_snomed_concept` | 取得概念完整資訊（FSN、同義詞、父概念、ICD-10 對應） |
| `get_snomed_children` | 取得直接子概念（IS-A 關係） |
| `get_snomed_ancestors` | 取得所有祖先概念 |
| `map_icd_to_snomed` | ICD-10 碼 → SNOMED CT 概念 |
| `map_snomed_to_icd` | SNOMED CT 概念 → ICD-10 碼 |

---

### 群組 12 — RxNorm 藥物交互作用（3 個工具）

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
