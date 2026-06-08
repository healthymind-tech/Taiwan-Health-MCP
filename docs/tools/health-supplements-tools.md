# 健康補充品工具 (Health Supplements Tools)

此類別工具整合台灣 FDA 核可健康補充品的查詢與疾病情境推薦。

## `search_health_supplements`
單一入口，三種模式：

- `mode="keyword"`：搜尋產品名稱、公司、成分、功效
- `mode="permit_no"`：依許可證號查詢，支援完整字串與 digits only，例如 `A00022`、`000029`
- `mode="condition"`：依疾病 / ICD 情境推薦對應的核可補充品

### 模式選擇
| 模式 | 適合何時使用 | 查詢重點 | 回傳結果重點 |
| :--- | :--- | :--- | :--- |
| `keyword` | 你知道產品名、功效詞、或想先找有哪些產品 | 產品名稱 / 公司 / 成分 / 功效 | 回傳對應產品的統一摘要清單 |
| `permit_no` | 你已知健康補充品許可證號，或只剩尾碼數字 | 許可證號 / bare digits | 精準對應單一產品，適合確認核可資訊 |
| `condition` | 你想從疾病情境反查可參考的核可補充品 | ICD / 疾病名稱 | 回傳頂層 `icd_code` 與 `recommended_benefits`，results 是可參考產品 |

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | string | 是 | `keyword` / `permit_no` / `condition` | `"keyword"` |
| `keyword` | string | 是 | 查詢關鍵字；`condition` 時可填疾病名稱或 ICD-10 代碼 | `"魚油"`, `"A00022"`, `"E11"` |
| `limit` | integer | 否 | 結果上限，預設 3 | `5` |

### 回傳格式
所有模式都回傳相同 top-level 結構，但只有 `condition` 模式會額外帶出頂層的 `icd_code` 與 `recommended_benefits`：

```json
{
  "mode": "keyword",
  "keyword": "魚油",
  "results": [...]
}
```

### 每筆結果欄位
所有模式的每筆結果都使用相同欄位：

- `permit_no`
- `product_name`
- `company`
- `benefits`
- `ingredients`
- `specs`
- `status`
- `source_url`

`condition` 模式會額外填入頂層：
- `icd_code`
- `recommended_benefits`

> 注意：`icd_code` 與 `recommended_benefits` 不會出現在每個 `results[]` item 裡，只會出現在 `condition` 模式的 top-level 回傳中。

### 使用建議
- 如果你想找合法產品，先用 `keyword`。
- 如果你在核對證書資料，用 `permit_no`。
- 如果你要從疾病角度整理可參考產品，用 `condition`。
