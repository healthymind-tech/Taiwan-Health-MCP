# 藥品工具 (Drug Tools)

此類別工具整合台灣 FDA（TFDA）西藥許可證資料，提供藥品搜尋、藥錠外觀辨識、藥品詳情與官方文件資產下載連結。

## search_drug
單一入口，四種搜尋模式。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | string | 否 | `drug_name` / `ingredient` / `license_id` / `atc_code`，預設 `drug_name` | `"ingredient"` |
| `keyword` | string | 是 | 依 `mode` 解讀的搜尋詞 | `"普拿疼"`, `"acetaminophen"`, `"000029"`, `"N02BE01"` |
| `limit` | integer | 否 | 結果上限，預設 3，上限 10 | `5` |
| `include_cancelled` | boolean | 否 | 是否納入已註銷許可證，預設 `false` | `true` |

### 模式選擇
| 模式 | 適合何時使用 | 查詢重點 |
| :--- | :--- | :--- |
| `drug_name` | 已知藥品中英文名稱 | 藥品名稱 |
| `ingredient` | 想找含某成分的藥品 | 成分文字 |
| `license_id` | 已知許可證字號或尾碼數字 | 許可證字號 |
| `atc_code` | 依 ATC 分類查藥 | ATC 碼 |

### 回傳格式
```json
{ "mode": "drug_name", "keyword": "普拿疼", "include_cancelled": false, "results": [...] }
```

---

## identify_unknown_pill
以藥錠外觀關鍵字辨識不明藥品。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `features` | string | 是 | 空白分隔的外觀關鍵字（顏色 / 形狀 / 刻痕 / 標記 / 尺寸 / 刻字） | `"white round"`, `"白 圓形"` |

### 用途
每個關鍵字以交集（conjunctive）比對外觀描述、顏色、形狀、符號、刻痕、尺寸與刻字欄位。英文顏色 / 形狀詞會以內建同義詞表擴展。需先以 `--drug-enrich` 載入外觀資料。

---

## get_drug_details
回傳單一許可證的正規化藥品紀錄。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `license_id` | string | 是 | 許可證字號 | `"衛署藥製字第000480號"` |
| `include_cancelled` | boolean | 否 | 是否納入已註銷許可證，預設 `false` | `true` |

### 用途
`search_drug` 的詳情版。回應由 PostgreSQL 中的正規化 JSON 組成，並附上目前各階段（stage）的可用性與文件數量。

---

## get_drug_asset_links
回傳藥品文件資產的 metadata 與即時產生的 MinIO 下載連結。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `license_id` | string | 否 | 許可證字號（與 `asset_id` 擇一） | `"衛署藥製字第000480號"` |
| `asset_id` | string | 否 | 指定單一資產 ID | — |
| `asset_group` | string | 否 | `insert`（電子仿單）/ `label`（外盒標籤）/ `shape`（外觀圖）/ `analysis`（分析輸出） | `"insert"` |
| `latest_insert_only` | boolean | 否 | 只取最新一份仿單，預設 `false` | `true` |

### 用途
回傳的下載連結為有時效的預簽（presigned）URL。需先以 `--drug-enrich`（資產）與 `--drug-analysis`（分析輸出）載入對應資料。
