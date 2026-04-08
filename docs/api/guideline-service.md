# Guideline Service API

## class `ClinicalGuidelineService`

### `__init__(self, pool)`
初始化指引服務，接受 asyncpg 連線池。資料由 data-loader `--guideline` 預先載入至 `guideline.*` schema。

### `async search_guideline(self, keyword: str) -> str`
搜尋臨床指引標題與 ICD 碼。

### `async get_complete_guideline(self, icd_code: str) -> str`
取得疾病完整指引（診斷、用藥、檢查、治療目標）。

### `async get_medication_recommendations(self, icd_code: str) -> str`
取得指引中的用藥建議。

### `async get_test_recommendations(self, icd_code: str) -> str`
取得指引中的建議檢查項目。

### `async get_treatment_goals(self, icd_code: str) -> str`
取得指引中的治療目標。

### `async check_medication_contraindications(self, icd_code: str, medication_class: str) -> str`
檢查特定疾病下的用藥禁忌。

### `async link_guideline_to_drugs(self, icd_code: str) -> str`
將指引建議對應至台灣 FDA 核准藥品清單。

### `async suggest_clinical_pathway(self, icd_code: str, patient_context_json: str = None) -> str`
依指引與病患背景生成臨床路徑建議。
