# SNOMED CT 工具 (SNOMED CT Tools)

此類別工具提供 SNOMED CT 概念搜尋、階層導覽與 ICD 對應。

## `search_snomed_concept`
搜尋 SNOMED CT 概念。

### 何時使用
當你只有英文臨床詞彙，想先找到最可能的 SNOMED 概念時使用。這是「找概念」的入口，不是概念詳情頁。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `query` | string | 是 | 英文臨床詞彙 | `"diabetes mellitus"`, `"myocardial infarction"` |
| `limit` | integer | 否 | 回傳筆數上限 | `3` |
| `hierarchy_filter` | integer | 否 | 限縮到某個 SNOMED hierarchy 根節點 | `404684003` |

### 回傳內容
回傳最接近的概念清單，每筆通常包含 concept ID、FSN、term type、active 狀態與相似度資訊。這個工具適合做語意搜尋與概念候選探索。

---

## `query_snomed_concept`
一次取得 SNOMED 概念、父概念與子概念。

### 何時使用
當你已經知道 concept ID，想一次看這個概念本身、往上層的脈絡、以及往下層的子概念時使用。這是最適合做分類樹閱讀的工具。

### 模式說明
- `include_parents=true`：回傳祖先鏈，幫你看上層分類
- `include_children=true`：回傳直接子概念，幫你看下層展開
- `parent_limit` / `child_limit`：控制展開深度與數量

### 回傳內容
回傳一個 JSON，其中包含：
- `concept`：該概念的完整資料
- `ancestors`：可選的祖先清單
- `children`：可選的子概念清單
- `ancestor_count` / `children_count`：方便 UI 顯示數量

---

## `get_snomed_concept`
取得單一 SNOMED 概念完整資料。

### 何時使用
當你只想看某個 concept 的基本資料、同義詞、ICD 對應時使用。比 `query_snomed_concept` 更精簡，適合已知 concept ID 的快速查詢。

---

## `get_snomed_children`
取得 SNOMED 概念的直接子概念。

### 何時使用
當你想從一個上位概念往下展開，查看有哪些更細的 subtype 時使用。

---

## `get_snomed_ancestors`
取得 SNOMED 概念的祖先鏈。

### 何時使用
當你想知道某個概念屬於哪些更大的分類，或要往上找父層脈絡時使用。

---

## `get_snomed_relationships`
取得 SNOMED 概念的屬性關聯。

### 何時使用
當你想看 finding site、causative agent、associated morphology、has active ingredient 等非 IS-A 關聯時使用。

---

## `query_snomed_mapping`
ICD ↔ SNOMED 雙向對應查詢。

### 模式說明
- `mode="icd"`：用 ICD code 找對應 SNOMED concept
- `mode="snomed"`：用 SNOMED concept ID 或搜尋詞找對應 ICD code

### 何時使用
當你不確定要從哪個系統出發時，用這個單一入口切換方向即可。

### 回傳內容
- `mode="icd"`：回傳 `snomed_concepts`
- `mode="snomed"`：回傳 `icd10_mappings`
