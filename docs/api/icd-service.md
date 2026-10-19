# ICD Service API

`IcdService`（`node-server/src/icdService.ts`）提供 MCP ICD-10 工具群組背後的查詢。
所有方法回傳可直接序列化成 JSON 的物件（MCP 工具再把它包成 `content[0].text` 的 JSON 字串）。
資料庫存取一律經由 `db.ts` 的共用 `pg` 連線池（透過 pgBouncer），不由建構子注入。

## class `IcdService`

### `constructor(embeddingSvc: EmbeddingService | null = null)`
傳入共用的 `EmbeddingService`；為 `null` 時診斷搜尋只走關鍵字。由 `mcp.ts` 延遲建立單例。

### `async initialize(): Promise<void>`
檢查 `icd.procedures` 是否有資料，決定 ICD-10-PCS 搜尋是否可用。

### `async searchCodes(keyword, type = "all", limit = 3)`
`type` 為 `"diagnosis" | "procedure" | "all"`，`limit` 上限 10。診斷走全文 + 向量的分數感知混合排序（`terminologyRanking.ts` + `hybridRank.ts`；向量端精確掃描，不走 HNSW），處置只走 BM25。
回傳 `{diagnoses?, procedures?, procedures_note?}`，向量不可用時另帶 `search_mode: "keyword_only"`；完全無結果時回傳 `{error}`。對應工具 `search_medical_codes`。

### `async inferComplications(code)`
純階層查詢：有子代碼時回傳 `{base_code, potential_complications_or_specifics}`（最多 15 筆），否則回傳同類別代碼 `{message, related_codes}`（最多 10 筆）。對應 `infer_complications`。

### `async getNearbyCodes(code)`
依代碼字母順序回傳前後各 2 碼 `{target, nearby_options}`。對應 `get_nearby_codes`。

### `async browseCategory(category = null, limit = 50)`
不給 `category` 時列出所有類別與筆數；給類別時展開其代碼（`limit` 上限 200）。對應 `browse_icd_category`。

### `async getConflictInfo(diagnosisCode, procedureCode)`
並列回傳一組診斷碼與處置碼的完整資料，只提供事實、不做判定。對應 `check_medical_conflict`。
