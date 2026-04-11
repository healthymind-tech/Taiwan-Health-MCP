# Lab Service API

`LabService` 負責 LOINC 搜尋、分類瀏覽、參考值查詢與檢驗結果判讀。

## class `LabService`

### `__init__(self, pool)`
初始化檢驗服務，接受 asyncpg 連線池。

### `async search_loinc_code(self, keyword: str, category: str = None) -> str`
搜尋 LOINC 候選碼。這是 code discovery 入口，適合用 test name、abbreviation、analyte 或 specimen phrase 找可能的檢驗碼。

### `async list_categories(self) -> str`
列出資料庫可用的 LOINC 大類，讓呼叫端先知道有哪些 category 可以當搜尋條件。

### `async get_reference_range(self, loinc_num: str, age: int, gender: str = "all") -> str`
依年齡與性別取得單一 LOINC 的參考值範圍。

### `async interpret_lab_result(self, loinc_num: str, value: float, age: int, gender: str = "all") -> str`
判讀單一檢驗數值，輸出 high / normal / low 類型的結構化結果。

### `async search_by_specimen(self, specimen_type: str) -> str`
依檢體類型搜尋 LOINC 項目。當你知道 specimen，但不確定 analyte 或 code 時，用這個找候選。

### `async find_related_tests(self, component: str) -> str`
找出同一 analyte 的相關 LOINC 檢驗，通常會按 specimen system 分組，方便比較不同 specimen 的版本。

### `async get_patient_friendly_name(self, loinc_num: str) -> str`
取得 LOINC 完整概念細節與病患友善名稱。

### `async batch_interpret_results(self, results: list, age: int, gender: str = "all") -> str`
批次判讀多筆結果。適合 full panel 或整份 report 的輸入。
