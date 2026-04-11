# 臨床指引工具 (Guideline Tools)

此類別工具提供基於台灣與國際權威機構發布的臨床診療指引查詢功能。

## search_clinical_guideline
搜尋臨床指引文件。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 是 | 疾病名稱或 ICD 代碼 | `"糖尿病"`, `"E11"`, `"Hypertension"` |

### 回傳內容
回傳符合條件的指引標題清單、發布單位與年份。

---

## query_guideline
取得完整或分段的結構化診療指引。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `icd_code` | string | 是 | ICD-10 代碼 | `"E11"` |

### 回傳內容
包含該疾病的完整處置流程：
- **診斷標準** (Criteria)
- **檢查項目** (Laboratory Tests)
- **治療目標** (Targets, 如 HbA1c < 7%)
- **生活型態建議** (Lifestyle)

---

### `section="medication"`
取得指引建議的用藥策略。

### `section="test"`
取得指引建議的檢查項目。

### `section="goals"`
取得治療目標。

### `section="pathway"`
取得臨床路徑建議。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `icd_code` | string | 是 | ICD-10 代碼 | `"E11"` |

### 回傳內容
列出第一線 (First-line)、第二線 (Second-line) 用藥建議，以及特定共病症 (Comorbidity) 下的用藥調整建議。
