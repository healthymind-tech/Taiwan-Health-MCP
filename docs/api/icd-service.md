# ICD Service API

## class `ICDService`

### `__init__(self, pool)`
初始化 ICD 服務，接受 asyncpg 連線池（透過 pgBouncer）。

- **pool**: asyncpg 連線池，由 `server.py` lifespan 注入。

### `async initialize(self)`
檢查 `icd.procedures` 資料表是否有資料，設定 `_pcs_available` flag。

### `async search_codes(self, keyword: str, type: str = "all") -> str`
全文搜尋 ICD-10-CM 診斷碼或 ICD-10-PCS 手術碼。

- **keyword**: 搜尋字串（支援中英文）。
- **type**: `"diagnosis"`, `"procedure"` 或 `"all"`。
- **Returns**: 格式化文字結果。

### `async infer_complications(self, code: str) -> str`
依 ICD 階層推論潛在併發症，從父代碼（如 E11）列出子代碼（如 E11.2）。

### `async get_nearby_codes(self, code: str) -> str`
取得目標碼在分類中的前後相鄰碼。

### `async browse_category(self, category: str = None, limit: int = 50) -> str`
依前三碼類別瀏覽診斷碼清單。

### `async get_conflict_info(self, diagnosis_code: str, procedure_code: str) -> dict`
取得用於診斷碼與手術碼衝突分析的詳細資訊。
