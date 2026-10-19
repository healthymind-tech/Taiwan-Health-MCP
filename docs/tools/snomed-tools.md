# SNOMED CT 工具 (SNOMED CT Tools)

目前對外 SNOMED 入口為 4 個工具：`search_snomed_concept`、`query_snomed_concept`、`get_snomed_relationships`、`query_snomed_mapping`。

> **維護模式**：管理後台把 `snomed` 模組切到維護模式時，本組工具呼叫會立即回傳 `isError` 結果，錯誤碼 `MODULE_MAINTENANCE`（`error.message` 英文、`error.message_zh` 正體中文，`error.module` 為模組鍵），約 5 秒內生效；工具仍留在 `tools/list` 中。詳見 [API 參考](../api/index.md#maintenance)。

## `search_snomed_concept`
英文臨床詞彙搜尋 SNOMED 概念候選。

### 何時使用
當你只有文字詞彙（還不知道 concept ID）時先用它找候選。此工具以全文 + embedding 的分數感知混合排序（比對每個概念所有有效名稱：FSN 與同義詞），回傳最接近語意的概念，不只限完全字面匹配；完全等於某名稱的概念優先，停用（inactive）概念排在後面。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `query` | string | 是 | 英文臨床詞彙 | `"diabetes mellitus"` |
| `limit` | integer | 否 | 回傳上限（預設 3，上限 10） | `5` |
| `hierarchy_filter` | integer | 否 | 只回傳某概念（通常是頂層階層的 concept ID）的 IS-A 後代 | `404684003` |

### 回傳重點
每筆含 `concept_id`、`fsn`、`preferred_term`、`active` 與 `hierarchy_tag`，適合拿來挑選下一步要查的 concept；完整資料用 `query_snomed_concept`。

---

## `query_snomed_concept`
一次取得概念本體與階層脈絡（父/子）。

### 何時使用
你已經有 concept ID，想一次看 concept 詳情 + 祖先 + 子概念時使用。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `concept_id` | integer | 是 | SNOMED concept ID | `73211009` |
| `include_parents` | boolean | 否 | 回傳祖先鏈，預設 `true` | `false` |
| `include_children` | boolean | 否 | 回傳直接子概念，預設 `true` | `false` |
| `parent_limit` | integer | 否 | 祖先展開上限，預設 10，上限 20 | `20` |
| `child_limit` | integer | 否 | 子概念展開上限，預設 20，上限 200 | `50` |

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
| `relationship_type_id` | integer | 否 | 只回傳某一種關聯類型（例如 `363698007` finding site） |

回傳 `{concept_id, relationship_count, relationships}`，依關聯類型分組，每組附易讀標籤與目標概念清單。

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
| `mode` | string | 否 | `icd` 或 `snomed`，預設 `icd` | `"icd"` |
| `keyword` | string | 是 | ICD code、concept ID 或英文詞彙 | `"E11.9"`, `"44054006"` |
