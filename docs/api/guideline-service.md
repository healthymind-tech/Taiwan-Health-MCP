# Guideline Service API

## class `ClinicalGuidelineService`

### `__init__(self, pool)`
初始化指引服務，接受 asyncpg 連線池。資料經由管理後台（匯入階段 `--guideline`）預先載入至 `guideline.*` schema。

### `async search_guideline(self, keyword: str) -> str`
搜尋臨床指引標題與 ICD 碼。

### `async query_guideline(self, icd_code: str, section: str = "complete") -> str`
取得完整或分段的指引內容。

`section` 對應：
- `complete`：完整指引摘要
- `medication`：用藥建議
- `test`：檢查建議
- `goals`：治療目標
- `pathway`：臨床路徑
