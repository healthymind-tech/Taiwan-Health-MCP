# Lab Service API

## class `LabService`

### `__init__(self, pool)`
初始化檢驗服務，接受 asyncpg 連線池。

### `async search_loinc_code(self, keyword: str, category: str = None) -> str`
搜尋 LOINC 代碼（87,000+ 碼，含中文名稱）。

### `async list_categories(self) -> str`
列出所有檢驗分類。

### `async get_reference_range(self, loinc_num: str, age: int, gender: str = "all") -> str`
依年齡、性別取得 LOINC 參考值範圍。

### `async interpret_lab_result(self, loinc_num: str, value: float, age: int, gender: str = "all") -> str`
判讀單一檢驗數值，標記正常/偏高/偏低並說明臨床意義。

### `async search_by_specimen(self, specimen_type: str) -> str`
依檢體類型（血液、尿液等）搜尋 LOINC 檢驗項目。

### `async find_related_tests(self, component: str) -> str`
找出相同 analyte 的所有相關 LOINC 檢驗。

### `async get_patient_friendly_name(self, loinc_num: str) -> str`
取得 LOINC 完整概念細節（含中文病患友善名稱）。

### `async batch_interpret_results(self, results: list, age: int, gender: str = "all") -> str`
批次判讀多項檢驗結果。
