# Drug Service API

## class `DrugService`

### `__init__(self, data_dir: str)`
初始化藥品服務。

### `search_drug(self, keyword: str) -> str`
搜尋藥品。

- **keyword**: 藥名或適應症。

### `get_details(self, license_id: str) -> str`
取得詳細藥品資料。

### `identify_pill(self, features: str) -> str`
辨識藥丸。

- **features**: 外觀描述字串。
