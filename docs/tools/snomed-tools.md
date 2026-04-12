# SNOMED CT 工具 (SNOMED CT Tools)

目前對外 SNOMED 入口為 4 個工具：`search_snomed_concept`、`query_snomed_concept`、`get_snomed_relationships`、`query_snomed_mapping`。

## `search_snomed_concept`
英文臨床詞彙搜尋 SNOMED 概念候選。

### 何時使用
當你只有文字詞彙（還不知道 concept ID）時先用它找候選。此工具使用 BM25 + embedding 排序，回傳最接近語意的概念，不只限完全字面匹配。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `query` | string | 是 | 英文臨床詞彙 | `"diabetes mellitus"` |
| `limit` | integer | 否 | 回傳上限（預設 3） | `5` |
| `hierarchy_filter` | integer | 否 | 只搜指定 hierarchy | `404684003` |

### 回傳重點
每筆通常含 `concept_id`、FSN、active 狀態與相似度資訊，適合拿來挑選下一步要查的 concept。

---

## `query_snomed_concept`
一次取得概念本體與階層脈絡（父/子）。

### 何時使用
你已經有 concept ID，想一次看 concept 詳情 + 祖先 + 子概念時使用。

### 參數與行為
- `include_parents=true`：回傳祖先鏈
- `include_children=true`：回傳直接子概念
- `parent_limit` / `child_limit`：限制展開量

### 回傳重點
固定有 `concept`；依參數附帶 `ancestors`、`children` 與對應 count。

---

## `get_snomed_relationships`
查詢非 IS-A 屬性關聯（語意屬性）。

### 何時使用
想看臨床語意屬性而不是階層關係時用它，例如 finding site、causative agent、associated morphology、has active ingredient。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `concept_id` | integer | 是 | SNOMED concept ID |
| `relationship_type_id` | integer | 否 | 只看特定關係類型 |

---

## `query_snomed_mapping`
ICD ↔ SNOMED 雙向 mapping 單一入口。

### mode 說明
- `mode="icd"`：`keyword` 視為 ICD-10 code，回傳 `snomed_concepts`。
- `mode="snomed"`：`keyword` 可放數字 concept ID 或英文詞彙。  
  - 純數字：直接用 concept ID mapping（不走 embedding）  
  - 文字：先做 SNOMED 搜尋找最佳 concept，再 mapping（此步會用 embedding）

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | string | 否 | `icd` 或 `snomed` | `"icd"` |
| `keyword` | string | 是 | ICD code、concept ID 或英文詞彙 | `"E11.9"`, `"44054006"` |
