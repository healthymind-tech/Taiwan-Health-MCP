# Drug Service API

## class `DrugService`

### `__init__(self, pool)`
初始化藥品服務，接受 asyncpg 連線池。

### `async search_drug(self, keyword: str) -> str`
FTS 搜尋藥品名稱或適應症。

- **keyword**: 藥名（中/英）或適應症關鍵字。

### `async get_drug_details_by_license(self, license_id: str) -> str`
依許可證字號取得完整藥品資料，含三層模糊匹配回退。

### `async identify_pill(self, features: str) -> str`
依外觀特徵辨識藥錠（顏色、形狀、刻痕）。

### `async search_by_atc(self, query: str) -> str`
依 ATC 代碼或藥理分類名稱搜尋藥品。

### `async search_by_ingredient(self, ingredient_name: str) -> str`
依有效成分名稱搜尋含有該成分的藥品。
