# Drug Service API

`DrugService` 負責台灣 FDA 藥品資料的搜尋、藥證查詢、外觀辨識與成分搜尋。

## class `DrugService`

### `__init__(self, pool)`
初始化藥品服務，接受 asyncpg 連線池。

### `async search_drug(self, keyword: str, limit: int) -> str`
依藥名或適應症關鍵字搜尋台灣 FDA 藥品。使用 PostgreSQL `ts_rank_cd + setweight`：`name_zh`/`name_en` 權重 A，`indication` 權重 C，結果依相關度降冪排序。
所有 `search_drug` mode 最終都會被正規化成同一個結果 item schema，固定包含
`atc`（`atc_code/atc_name`）與 `rxnorm`（`rxcui/name/tty/atc_code`）欄位。

### `async search_by_atc(self, query: str, limit: int) -> str`
依 ATC code 前綴搜尋藥品（1–7 字元），不使用 embedding。

### `async search_by_atc_codes(self, atc_codes: list[str], limit: int) -> str`
依精確 ATC code 清單搜尋台灣 FDA 藥品（完整 code，無前綴展開）。供 `rxnorm_resolve` 與 `rxnorm_ingredients` 模式做 RXCUI→ATC→TFDA 橋接使用，不帶快取（caller 負責）。

### `async search_by_license_id(self, license_id: str) -> str`
依台灣 FDA 許可證字號查詢單一藥品，支援完整字串與 bare digits。

### `async get_drug_details_by_license(self, license_id: str) -> str`
取得完整藥品資料。這是內部 helper，供公開的 `search_drug(mode="license_id", ...)` 與 FHIR Medication 服務使用。

### `async identify_pill(self, features: str) -> str`
依外觀特徵辨識藥錠（顏色、形狀、刻痕）。支援常見英文外觀詞自動擴展（如 `white`/`round`/`oval`），若含數字刻印導致無結果，會自動做一次移除數字 token 的寬鬆重試。

### `async search_by_ingredient(self, ingredient_name: str) -> str`
依有效成分名稱搜尋含有該成分的藥品。
