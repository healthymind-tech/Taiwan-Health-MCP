# ICD Service API

## class `ICDService`

### `__init__(self, excel_path: str, data_dir: str)`
初始化 ICD 服務，載入或建立 SQLite 資料庫。

- **excel_path**: 原始 ICD-10 Excel 檔案的路徑。
- **data_dir**: 資料目錄，用於儲存轉換後的 SQLite db。

### `search_codes(self, keyword: str, type: str = "all") -> str`
搜尋 ICD 代碼。

- **keyword**: 搜尋字串。
- **type**: "diagnosis", "procedure" 或 "all"。
- **Returns**: 格式化的文字結果。

### `infer_complications(self, code: str) -> str`
推論併發症代碼。

- **code**: 父代碼 (如 E11)。

### `get_nearby_codes(self, code: str) -> str`
取得相鄰的代碼。

### `get_conflict_info(self, diagnosis_code: str, procedure_code: str) -> dict`
取得用於衝突檢查的詳細資訊。
