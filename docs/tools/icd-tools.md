# ICD-10 工具 (ICD Tools)

此類別工具提供對 ICD-10-CM (診斷) 與 ICD-10-PCS (處置) 的查詢與階層瀏覽功能。資料來自 `icd_import` 匯入的 `icd.diagnoses` / `icd.procedures`；目前載入的 ICD-10-CM 版本（例如以 CMS「Code Descriptions in Tabular Order」載入的完整版 `2026-04-01`，含第 7 碼與佔位字元 X）可由 `health_check` 的 `terminology.icd10cm` 查得。`icd.diagnoses` 少於 10,000 筆時整組工具不會註冊。

> **維護模式**：管理後台把 `icd` 模組切到維護模式時，本組工具呼叫會立即回傳 `isError` 結果，錯誤碼 `MODULE_MAINTENANCE`（`error.message` 英文、`error.message_zh` 正體中文，`error.module` 為模組鍵），約 5 秒內生效；工具仍留在 `tools/list` 中。詳見 [API 參考](../api/index.md#maintenance)。

## search_medical_codes
搜尋 ICD-10 診斷或處置代碼。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 是 | 搜尋關鍵字（代碼、中文名稱或英文名稱） | `"糖尿病"`, `"E11"`, `"Appendectomy"` |
| `type` | string | 否 | 搜尋類型，預設為 `"all"`。<br>可選值：`"diagnosis"` (診斷), `"procedure"` (處置), `"all"` | `"diagnosis"` |
| `limit` | integer | 否 | 每類結果上限，預設 3，上限 10 | `5` |

### 搜尋方式
`diagnosis` 走 BM25 + 向量重排序的混合搜尋；`procedure` 只走 BM25；`all`（預設）兩者都做，
並以獨立的 `diagnoses` / `procedures` 鍵分開回傳。結果依相關性排序（關鍵字與向量結果以 RRF 融合），不是依代碼字母順序。
向量部分刻意做精確掃描而不走 HNSW 索引：完整版 ICD-10-CM 有大量只差第 7 碼的近似碼，HNSW 的召回率在這種資料上會崩潰。
embedding 端點不可用或 `icd.diagnosis_embeddings` 為空時退回純關鍵字搜尋，回應會帶 `search_mode: "keyword_only"`。
未載入 ICD-10-PCS 時 `procedures` 為空陣列並附 `procedures_note`。

---

## infer_complications
依 ICD-10-CM 階層列出代碼的子代碼（純階層查詢，不做臨床推論）。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `code` | string | 是 | 基礎診斷代碼 | `"E11"` |

### 用途
當使用者僅提供模糊的診斷（如「糖尿病」）時，此工具可列出該類別下的具體細分（如「腎病變」、「視網膜病變」），協助釐清病情。
有子代碼時回傳 `{base_code, potential_complications_or_specifics}`（最多 15 筆）；代碼已是末端碼時改回傳同一類別的其他代碼 `{message, related_codes}`（最多 10 筆）。

---

## get_nearby_codes
取得目標代碼依字母順序排列時的前 2 個與後 2 個代碼（排序上的鄰居，不是語意相近）。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `code` | string | 是 | 目標代碼 | `"I10"` |

### 用途
用於查看同一疾病頻譜中不同嚴重程度或性質相近的編碼，有助於鑑別診斷。

---

## check_medical_conflict
並列取出一組診斷碼與處置碼的完整定義，供編碼品管比對。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `diagnosis_code` | string | 是 | ICD-10-CM 診斷碼 | `"K35.80"` (急性闌尾炎) |
| `procedure_code` | string | 是 | ICD-10-PCS 處置碼 | `"0DTJ0ZZ"` (闌尾切除術) |

### 用途
回傳雙方的詳細定義以供比對。**此工具只提供事實,不做相容性判定**——它不會回傳通過 / 不通過的結論,是否衝突需由呼叫端自行判斷。

---

## browse_icd_category
依 ICD 類別瀏覽診斷碼。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `category` | string | 否 | 類別代碼（前三碼）。省略時回傳所有類別清單 | `"E11"` |
| `limit` | integer | 否 | 展開類別時的代碼數上限，預設 50，上限 200 | `100` |

### 用途
不帶 `category` 時回傳 `{"total_categories", "categories": [...]}`；帶入類別（如 `E11`）時回傳該類別下所有診斷碼 `{"category", "total", "codes": [...]}`。適合先列類別再逐層展開瀏覽。

> 所有工具都以 JSON 回傳（MCP `content[0].text` 內為 JSON 字串），沒有純文字格式的輸出。
