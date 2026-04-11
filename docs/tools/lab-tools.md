# 檢驗工具 (Lab Tools)

此類別工具涵蓋 LOINC 檢驗碼搜尋、分類瀏覽、參考值查詢與結果判讀。典型流程是先找 code，再看詳細定義，最後再做單項或批次判讀。

## 搜尋與瀏覽

### `search_loinc_code`
用檢驗名稱、縮寫、分析物或 specimen 關鍵字搜尋 LOINC 候選碼。這是「找可能的 code」的起點，適合中英混雜、縮寫、院內俗稱或尚未標準化的檢驗名稱。

| 參數名 | 型別 | 必填 | Defaults | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 是 | - | 檢驗名稱、縮寫、分析物或 specimen 相關詞 | `"血糖"`, `"HbA1c"`, `"WBC"`, `"creatinine"` |
| `category` | string | 否 | - | LOINC 大類篩選；先用 `list_lab_categories` 看可用值 | `"CHEM"`, `"HEM/BC"`, `"SERO"`, `"UA"` |
| `limit` | integer | 否 | `3` | 回傳候選數量，數值越大召回越高 | `5` |

**使用情境**
- 你只有檢驗俗名，還沒有標準碼
- 你想先找到最像的候選碼，再交給 `get_loinc_detail`
- 你要從中文、英文或縮寫中找對應的標準檢驗碼

### `list_lab_categories`
列出目前資料庫中可用的 LOINC 大類。這是 `search_loinc_code` 的分類瀏覽入口，適合先看有哪些 broad class，再決定要不要加 category filter。

**使用情境**
- 不知道可用的大類名稱
- 想先確認 CHEM、HEM/BC、SERO、UA 等分類是否存在
- 想理解本部署的 LOINC 字典如何分組

### `search_loinc_by_specimen`
依檢體類型搜尋 LOINC 項目。當你知道 specimen，但不確定 analyte 或 test code 時，用這個工具找候選檢驗。

| 參數名 | 型別 | 必填 | Defaults | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `specimen_type` | string | 是 | - | 檢體名稱或 LOINC specimen code | `"血清/血漿"`, `"全血"`, `"Urine"`, `"Ser/Plas"` |
| `limit` | integer | 否 | `3` | 回傳候選數量 | `5` |

## 詳細查詢

### `get_loinc_detail`
取得單一 LOINC code 的完整軸向資訊。這是「已經知道 code，想看完整定義」的工具。

**適合看什麼**
- component、property、system、method、specimen type
- code 狀態與完整 concept 表示
- 對照院內名稱時確認是不是選到相同檢驗層級

### `find_related_loinc_tests`
依分析物找出同一 component 的相關 LOINC 檢驗，並按 specimen system 分組。這適合比較同一分析物在不同 specimen 下的標準碼差異。

| 參數名 | 型別 | 必填 | Defaults | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `component` | string | 是 | - | 分析物或成分名稱 | `"Glucose"`, `"血糖"`, `"Creatinine"` |
| `limit` | integer | 否 | `3` | 回傳候選數量 | `5` |

**使用情境**
- 你想比較血清、全血、尿液的同一分析物對應哪些 LOINC
- 你想確認某個 analyte 是否有更合適的 specimen 版本

## 參考值與判讀

### `get_reference_range`
依 LOINC code、年齡與性別查參考值範圍。這是臨床判讀前的標準值查詢步驟。

| 參數名 | 型別 | 必填 | Defaults | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `loinc_code` | string | 是 | - | 目標 LOINC code | `"1558-6"` |
| `age` | integer | 是 | - | 年齡，用來選擇對應分層 | `45` |
| `gender` | string | 否 | `"all"` | `M`、`F` 或 `all` | `"M"` |

**使用情境**
- 你已經有 code，想知道正常範圍
- 你要把結果值與年齡/性別分層做比較
- 你要在解讀數值前先確認 reference interval

### `interpret_lab_result`
單項檢驗結果判讀。輸入 code、數值、年齡與性別後，回傳 high / normal / low 類型的判讀結果與對應參考值。

| 參數名 | 型別 | 必填 | Defaults | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `loinc_code` | string | 是 | - | 目標 LOINC code | `"1558-6"` |
| `value` | number | 是 | - | 檢驗數值 | `126.5` |
| `age` | integer | 是 | - | 年齡 | `50` |
| `gender` | string | 否 | `"all"` | `M`、`F` 或 `all` | `"F"` |

**使用情境**
- 你只要快速判斷單一結果是否異常
- 你要在報告摘要中加上結構化判讀
- 你需要與 reference range 連動的簡短臨床提示

### `batch_interpret_lab_results`
批次判讀多個檢驗結果。適合整份報告、健檢套組或一次多筆上傳的結果。

| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `results_json` | string | 是 | JSON 陣列，格式為 `[{"loinc_code":"...","value":...}, ...]` |
| `age` | integer | 是 | 年齡 |
| `gender` | string | 否 | `M`、`F` 或 `all` |

**使用情境**
- 你有一整包 lab panel 要判讀
- 你要一次看多個 abnormal flags
- 你要用 LLM 整理整份報告重點

## 選擇建議
- 先找 code：`search_loinc_code`
- 先看分類：`list_lab_categories`
- 已知檢體：`search_loinc_by_specimen`
- 已知分析物：`find_related_loinc_tests`
- 已知 code 要看定義：`get_loinc_detail`
- 要看正常值：`get_reference_range`
- 要判讀單項：`interpret_lab_result`
- 要判讀整批：`batch_interpret_lab_results`
