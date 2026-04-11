# Drug Service API

`DrugService` 負責台灣 FDA 藥品資料的搜尋、藥證查詢、外觀辨識與成分搜尋。

## class `DrugService`

### `__init__(self, pool)`
初始化藥品服務，接受 asyncpg 連線池。

### `async search_drug(self, keyword: str) -> str`
藥品搜尋主入口。實際行為由 `search_drug(mode=...)` 對應的 service wrapper 決定，底層可用來搜尋藥名、ATC code 前綴、有效成分或許可證字號。

### `async search_by_atc(self, query: str) -> str`
依 ATC code 前綴搜尋藥品，不使用 embedding。

### `async search_by_license_id(self, license_id: str) -> str`
依台灣 FDA 許可證字號查詢單一藥品，支援完整字串與 bare digits。

### `async get_drug_details_by_license(self, license_id: str) -> str`
取得完整藥品資料。這是內部 helper，供公開的 `search_drug(mode="license_id", ...)` 與 FHIR Medication 服務使用。

### `async identify_pill(self, features: str) -> str`
依外觀特徵辨識藥錠（顏色、形狀、刻痕）。

### `async search_by_ingredient(self, ingredient_name: str) -> str`
依有效成分名稱搜尋含有該成分的藥品。
