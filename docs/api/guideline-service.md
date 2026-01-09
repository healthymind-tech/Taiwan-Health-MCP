# Guideline Service API

## class `ClinicalGuidelineService`

### `__init__(self, data_dir: str)`
初始化指引服務。

### `search_guideline(self, keyword: str) -> str`
搜尋臨床指引標題。

### `get_complete_guideline(self, icd_code: str) -> str`
取得完整結構化指引內容。
