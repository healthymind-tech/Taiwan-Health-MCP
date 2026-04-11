# 臨床指引工具 (Guideline Tools)

此類別工具提供基於台灣與國際權威機構發布的臨床診療指引查詢功能。

## search_clinical_guideline
搜尋臨床指引文件。

### 何時使用
當你只知道疾病名稱、疾病分類或 ICD 代碼，還不確定要看哪份指引時，用這個工具先找候選文件。它是「找到對的指引文件」的入口，不是內容摘要工具。

### 模式與回傳
- 目前只有單一模式，輸入一個 `keyword` 即可。
- 搜尋結果會回傳指引標題、發布單位、年份與對應摘要資訊。
- 若你要看內容，請再呼叫 `query_guideline`。

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 是 | 疾病名稱或 ICD 代碼 | `"糖尿病"`, `"E11"`, `"Hypertension"` |

### 回傳內容
回傳符合條件的指引標題清單、發布單位與年份。

---

## query_guideline
取得完整或分段的結構化診療指引。

### 模式說明
- `section="complete"`：完整指引摘要，包含診斷、藥物、檢查、治療目標與臨床脈絡
- `section="medication"`：只回傳用藥建議，例如第一線、第二線、加成與特殊族群調整
- `section="test"`：只回傳檢查與追蹤項目，例如抽血、影像、量測頻率
- `section="goals"`：只回傳治療目標，例如 HbA1c、血壓、LDL-C 目標
- `section="pathway"`：回傳整理過的臨床路徑，適合快速閱讀流程與下一步決策

### 模式選擇
| 模式 | 適合何時使用 | 回傳重點 |
| :--- | :--- | :--- |
| `complete` | 你要先看整份指引的全貌 | 診斷、藥物、檢查、目標、路徑的整體摘要 |
| `medication` | 你只在意治療藥物怎麼選 | 第一線、第二線、加成與共病調整 |
| `test` | 你要排查檢查、抽血、影像或追蹤 | 建議檢查與頻率、順序、注意事項 |
| `goals` | 你要看治療指標有沒有達標 | HbA1c、血壓、LDL-C 等治療目標 |
| `pathway` | 你要讓 LLM 讀成流程圖或步驟清單 | 條列式 clinical pathway，利於後續決策 |

### 參數
| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `icd_code` | string | 是 | ICD-10 代碼 | `"E11"` |

### 回傳內容
回傳內容會依 `section` 不同而改變：
- `complete`：完整處置流程
- `medication`：第一線、第二線與特殊情境用藥建議
- `test`：檢查項目與追蹤建議
- `goals`：治療目標與目標值
- `pathway`：臨床路徑與步驟建議

### 使用情境
- 如果你要讓 LLM 先抓大方向，用 `section="complete"`
- 如果你只想要藥物建議，選 `section="medication"`
- 如果你要規劃檢查流程，選 `section="test"`
- 如果你要評估治療指標是否達標，選 `section="goals"`
- 如果你要產生條列式決策流程，選 `section="pathway"`

### 注意事項
- `query_guideline` 是統一入口，適合在同一個對話裡切換不同 section。
- 若你只需要單一資訊，`get_medication_recommendations`、`get_test_recommendations`、`get_treatment_goals` 仍可直接使用，但它們只是分段的舊入口。
