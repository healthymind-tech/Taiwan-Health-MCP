# Lab Service API

## class `LabService`

### `__init__(self, data_dir: str)`
初始化檢驗服務。

### `search_loinc_code(self, keyword: str, category: str = None) -> str`
搜尋 LOINC 代碼。

### `get_reference_range(self, loinc_code: str, age: int, gender: str) -> str`
取得參考值範圍。

### `interpret_lab_result(self, loinc_code: str, value: float, ...) -> str`
判讀單一檢驗數值。

### `batch_interpret_results(self, results: list, ...) -> str`
批次判讀檢驗結果。
