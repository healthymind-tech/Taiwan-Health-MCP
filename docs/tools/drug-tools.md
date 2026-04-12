# 藥品工具 (Drug Tools)

此類別工具提供台灣 FDA 藥品資料庫的查詢、辨識與分析功能。

## search_drug
單一藥品查詢入口，整合 FDA 藥證資料與 RxNorm 術語能力。
`mode` 支援 7 種：`drug_name`、`atc_code`、`ingredient`、`license_id`、`rxnorm_resolve`、`rxnorm_ingredients`、`interaction`。

### 模式選擇
| 模式 | 適合何時使用 | 查詢重點 | 回傳結果重點 |
| :--- | :--- | :--- | :--- |
| `drug_name` | 你知道商品名、學名、或適應症關鍵字 | 藥名（權重 A）/ 適應症（權重 C），以 `ts_rank_cd` 排序 | FDA 藥品 detail + `atc` + `rxnorm` |
| `atc_code` | 你已經知道 ATC code 或前綴 | ATC code 前綴（1–7 字元） | 只做結構化 code 比對，不做語意搜尋 |
| `ingredient` | 你想找含特定成分的藥 | 成分、INN、學名（BM25 + embedding hybrid） | FDA 藥品 detail + `atc` + `rxnorm` |
| `license_id` | 你已知藥證號，或只剩尾碼數字 | 許可證字號 / bare digits | 精確定位單一藥品 detail |
| `rxnorm_resolve` | 你需要把藥名標準化成 RXCUI，或用藥名查台灣藥品 | 英文藥名 / 商品名 | 優先橋接至台灣 FDA 藥品；無 ATC 對應時 fallback 回 RxNorm-only |
| `rxnorm_ingredients` | 你已知 RXCUI，想查其成分組成與台灣對應藥品 | RXCUI | 優先橋接至台灣 FDA 藥品；無 ATC 對應時回傳 RxNorm 概念與成分 |
| `interaction` | 你要做多藥交互作用檢查 | `drug_names`（至少 2 個） | 回傳統一 `results` + 額外 `interaction` 摘要 |

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | string | 是 | 模式：`drug_name` / `atc_code` / `ingredient` / `license_id` / `rxnorm_resolve` / `rxnorm_ingredients` / `interaction` | `"rxnorm_resolve"` |
| `keyword` | string | 依 mode | `drug_name`/`ingredient` 用藥名或成分；`atc_code` 只接受 code 前綴（1–7 字元，例如 `"C"` 或 `"A10BA02"`）；`license_id` 可用 bare digits；`rxnorm_ingredients` 請給 RXCUI；`interaction` 會忽略 | `"Metformin"`, `"A10BA02"`, `"000029"`, `"860975"` |
| `drug_names` | string[] | `interaction` 必填 | 多藥交互作用輸入（至少 2 個藥名） | `["warfarin","aspirin"]` |
| `limit` | integer | 否 | 回傳筆數上限 | `5` |

### 回傳內容
所有 mode 的頂層格式一致：
```json
{"mode":"drug_name","keyword":"Metformin","results":[...]}
```
每筆 `results` 都是統一 schema（7 種 mode 相同）：
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
- `atc`（list of `{atc_code, atc_name}`）
- `rxnorm`（list of `{rxcui, name, tty, atc_code}`）
- `insert_url`

補充：`ingredients` 在所有 mode 也統一為同一格式：
- list of `{ingredient_name, ingredient_qty, ingredient_unit, rxcui, tty}`
- FDA 查詢通常帶 `ingredient_name/qty/unit`，`rxcui/tty` 可能為空
- RxNorm 組成查詢通常帶 `ingredient_name/rxcui/tty`，`qty/unit` 可能為空

`interaction` mode 另外會在頂層多一個 `interaction` 物件，包含：
- `interaction_count`
- `interactions`
- `resolved_drugs`
- `unresolved_drugs`

### 補充說明
- `drug_name` 使用 PostgreSQL `ts_rank_cd + setweight`：藥名欄位（`name_zh`、`name_en`）權重 A，適應症（`indication`）權重 C，結果依相關度排序。
- `ingredient` 使用 BM25 + embedding hybrid（RRF），適合中英文成分名稱模糊搜尋。
- `atc_code` 只接受 code / prefix（1–7 字元），不接受自然語言分類詞；如果輸入 `降血糖`，請改用 `drug_name`。
- `license_id` 會先嘗試完整字串比對，再處理 bare digits，例如 `000029`。
- `rxnorm_resolve` 與 `rxnorm_ingredients` 在有 ATC 對應資料時，會自動橋接回台灣 FDA 藥品（RXCUI → `drug.rx_atc_map` → `drug.atc` → `drug.licenses`）；無 ATC 對應時 fallback 至 RxNorm-only 結果。
- FDA 模式會自動補 `rxnorm`（由 ATC 對應映射）。
- RxNorm 模式會自動補 `atc`（由 RXCUI 對應映射）。
- `interaction` 模式批次查詢成分名稱（無 N+1 問題）。

---

---

## identify_unknown_pill
**【影像/特徵辨識】** 根據外觀特徵辨識不明藥丸。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `features` | string | 是 | 描述藥丸特徵的關鍵字（形狀、顏色、刻痕、標記） | `"圓形 白色 YP"`, `"white round"` |

### 用途
當使用者持有不明藥物，僅能描述外觀時使用。

### 比對規則
- 關鍵字是 **AND** 邏輯（關鍵字越多，結果越窄）。
- 常見英文外觀詞（例如 `white`, `round`, `oval`）會自動擴展成中文同義詞查詢。
- 若輸入含數字刻印（例如 `M500`）且 0 筆，系統會自動再試一次，移除含數字 token 後做寬鬆比對。
