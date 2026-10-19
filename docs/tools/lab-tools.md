# 檢驗工具 (Lab / LOINC)

目前 LOINC 對外入口已收斂為 4 個工具：`search_loinc`、`query_loinc`、`interpret_lab_result`、`batch_interpret_lab_results`。

預設值：`search_loinc` 的 `mode` 預設 `code`、`limit` 預設 3（上限 10）；`query_loinc` 的 `mode` 預設 `detail`；`gender` 一律預設 `all`。`code` / `specimen` / `component` 模式為 BM25 + 語意混合搜尋（`code` 模式以分數感知融合排序，並以 LOINC 的 `COMMON_TEST_RANK` 與狀態作為先驗；**分析物族群**：同一 COMPONENT（去掉 `^` 時間 / 挑戰後綴，逐細胞量與分率另成一族）中查詢分不出來的術語——涵蓋的查詢字詞相同，或查詢沒有字詞命中時語意相似度差距 ≤ 0.2——依 `COMMON_TEST_RANK` 排序，所以「hemoglobin」得到 718-7 而不是莫耳單位或動脈血的變體，「arterial lactate」仍得到動脈血那一筆；候選池另加入每個分析物最常用的 2 筆術語；挑戰 / 時間變體的原始分析物也會加入（「Renin^baseline」→ Renin）；panel 與比值（COMPONENT 含 `/`）除非查詢提到 panel / ratio / `/` / `%` / 比值，否則略降。**分析物同義字**：`loinc.component_names` 收錄 Loinc.csv `RELATEDNAMES2` 與 zh-CN 語言變體（轉為正體字）的分析物名稱（「uric acid」→ Urate、「FSH」/「卵泡刺激素」→ Follitropin、「泌乳激素」→ Prolactin），只保留出現在該分析物多數術語、且不超過 300 個分析物共用的名稱，以剔除檢體 / 時間 / 類別等軸向詞；分析物的名稱不會命中它的比值（「白蛋白」是 Albumin，不是 Albumin/Protein.total），除非查詢要的是比值或 `%`。**軸向詞**：`loinc.axis_names` 收錄每個 SYSTEM / TIME / METHOD / PROPERTY / SCALE 值的名稱，全部取自 LOINC 本身——Part.csv 的 part 名稱與顯示名稱（「BldV」=「Venous blood」、「24H」=「24 hours」），以及 Loinc.csv `RELATEDNAMES2` 中幾乎出現在該值每筆術語上的名稱（「Venous」、「Random」→ Pt、「Dipstick」→ Test strip、「Percent」→ 各種分率性質、「Spinal fluid」→ CSF）。英文查詢中的檢體 / 時間 / 方法 / 性質 / 尺度詞（「venous lactate」、「salivary cortisol」、「CSF glucose」、「24 hour urine protein」、「random urine sodium」、「urine glucose dipstick」、「HbA1c by HPLC」、「neutrophils %」）會成為限制條件：同一分析物族群中符合條件的術語（軸值相符，或術語本身名稱已含該字）排在最常用術語之前，該分析物在該檢體 / 時間下最常用的術語會加入候選池，另有 ±0.1 的小先驗獎勵 / 懲罰；查詢未提到任何軸向時照舊排序。若查詢同時出現兩個互斥的檢體（「urine blood dipstick」），以第一個為檢體。需 migration `20261024`、`20261025`、`20261026` 並重新匯入 LOINC；未套用時照舊排序），embedding 不可用時退回純關鍵字並帶 `search_mode: "keyword_only"`。`loinc.concepts` 少於 1,000 筆時整組工具不會註冊。

> **維護模式**：管理後台把 `loinc` 模組切到維護模式時，本組工具呼叫會立即回傳 `isError` 結果，錯誤碼 `MODULE_MAINTENANCE`（`error.message` 英文、`error.message_zh` 正體中文，`error.module` 為模組鍵），約 5 秒內生效；工具仍留在 `tools/list` 中。詳見 [API 參考](../api/index.md#maintenance)。

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
