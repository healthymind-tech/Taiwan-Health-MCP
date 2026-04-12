# 檢驗工具 (Lab / LOINC)

目前 LOINC 對外入口已收斂為 4 個工具：`search_loinc`、`query_loinc`、`interpret_lab_result`、`batch_interpret_lab_results`。

## 1) `search_loinc`（搜尋入口）

單一搜尋入口，透過 `mode` 切換查詢意圖。

### Mode: `code`
- 目的：用檢驗名稱、縮寫、關鍵字找候選 LOINC 碼
- 參數：`keyword` 必填，`category` 選填，`limit` 選填
- 範例：`search_loinc(mode="code", keyword="HbA1c", category="CHEM", limit=5)`

### Mode: `category`
- 目的：列出所有可用 LOINC 分類（可用 `keyword` 篩選分類名稱）
- 參數：`keyword` 選填，`limit` 選填
- 範例：`search_loinc(mode="category")`
- 範例：`search_loinc(mode="category", keyword="CHE")`

### Mode: `specimen`
- 目的：依檢體類型找候選檢驗碼
- 參數：`keyword` 必填（檢體名），`limit` 選填
- 範例：`search_loinc(mode="specimen", keyword="Urine", limit=5)`

### Mode: `component`
- 目的：依分析物（analyte/component）找相關檢驗碼
- 參數：`keyword` 必填（分析物），`limit` 選填
- 範例：`search_loinc(mode="component", keyword="Glucose", limit=5)`

---

## 2) `query_loinc`（細節/參考值入口）

單一查詢入口，透過 `mode` 切換 detail 與 reference range。

### Mode: `detail`
- 目的：查單一 LOINC code 的完整概念細節
- 參數：`loinc_code` 必填
- 範例：`query_loinc(mode="detail", loinc_code="2345-7")`

### Mode: `reference_range`
- 目的：查單一 LOINC code 的參考值範圍
- 參數：`loinc_code`、`age` 必填，`gender` 選填（`M`/`F`/`all`）
- 範例：`query_loinc(mode="reference_range", loinc_code="2345-7", age=45, gender="M")`

---

## 3) `interpret_lab_result`

單項結果判讀。

- 參數：`loinc_code`、`value`、`age` 必填，`gender` 選填
- 範例：`interpret_lab_result(loinc_code="1558-6", value=126, age=45, gender="M")`

---

## 4) `batch_interpret_lab_results`

批次結果判讀（整份報告）。

- 參數：`results_json`、`age` 必填，`gender` 選填
- `results_json` 格式：
```json
[{"loinc_code":"2345-7","value":126},{"loinc_code":"718-7","value":15.2}]
```
- 範例：`batch_interpret_lab_results(results_json='[...]', age=45, gender="M")`

---

## 使用順序建議

1. 先找碼：`search_loinc(mode="code" | "specimen" | "component")`  
2. 再看細節：`query_loinc(mode="detail", ...)`  
3. 需要參考值：`query_loinc(mode="reference_range", ...)`  
4. 要判讀數值：`interpret_lab_result` 或 `batch_interpret_lab_results`  
