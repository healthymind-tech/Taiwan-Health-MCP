# 藥品工具 (Drug Tools)

此類別工具提供台灣 FDA 藥品資料庫的查詢、辨識與分析功能。

## search_drug
依藥名、ATC code、許可證字號或有效成分搜尋藥品。
`drug_name` 與 `ingredient` 會使用 hybrid BM25 + semantic embedding 搜尋（若 embeddings 可用）。
`atc_code` 為 code-only 模式，只接受 ATC code 前綴，例如 `A10` 或 `A10BA02`，不做 embedding。
`license_id` 可輸入完整許可證字號，或僅輸入尾碼數字，例如 `000029`。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | string | 是 | 搜尋模式：`drug_name`、`atc_code`、`ingredient`、`license_id` | `"drug_name"` |
| `keyword` | string | 是 | 搜尋關鍵字；`drug_name` 用藥名/適應症，`atc_code` 只接受 ATC code 前綴，`ingredient` 用成分名，`license_id` 用許可證字號或尾碼數字 | `"Metformin"`, `"A10BA02"`, `"aspirin"`, `"000029"` |
| `limit` | integer | 否 | 回傳筆數上限 | `5` |

### 回傳內容
回傳符合條件的藥品列表，包含：
- 許可證字號
- 中文品名
- 英文品名
- `usage` / `form` / `package`
- 主成分或適應症摘要
- `ingredients`、`appearance`、`atc_code`、`insert_url`
  
四種模式的回傳格式完全一致：
```json
{"mode":"drug_name","keyword":"Metformin","results":[...]}
```
每筆 `results` 都包含相同欄位：
- `license_id`
- `name_zh`
- `name_en`
- `indication`
- `usage`
- `form`
- `package`
- `category`
- `manufacturer`
- `valid_date`
- `ingredients`
- `appearance`
- `atc_code`
- `insert_url`

### 模式說明
- `drug_name`：搜尋商品名、學名或適應症關鍵字
- `atc_code`：搜尋 ATC code 前綴
- `ingredient`：搜尋有效成分、INN 或學名
- `license_id`：搜尋單一許可證字號，支援 bare digits，例如 `000029`

---

---

## identify_unknown_pill
**【影像/特徵辨識】** 根據外觀特徵辨識不明藥丸。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `features` | string | 是 | 描述藥丸特徵的關鍵字（形狀、顏色、刻痕、標記） | `"圓形 白色 YP"`, `"oval pink"` |

### 用途
當使用者持有不明藥物，僅能描述外觀時使用。
