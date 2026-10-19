# ICD Service API

`IcdService` (`node-server/src/icdService.ts`) backs the MCP ICD-10 tool group.
Every method returns a JSON-serialisable object (the MCP tool wraps it as a JSON string in `content[0].text`).
Database access always goes through the shared `pg` pool in `db.ts` (via pgBouncer); nothing is injected through the constructor.

## class `IcdService`

### `constructor(embeddingSvc: EmbeddingService | null = null)`
Takes the shared `EmbeddingService`; with `null` the diagnosis search is keyword-only. `mcp.ts` creates a lazy singleton.

### `async initialize(): Promise<void>`
Checks whether `icd.procedures` has rows, which decides whether ICD-10-PCS search is available.

### `async searchCodes(keyword, type = "all", limit = 3)`
`type` is `"diagnosis" | "procedure" | "all"`; `limit` is capped at 10. Diagnoses use score-aware hybrid ranking of full-text and vector candidates (`terminologyRanking.ts` + `hybridRank.ts`; exact vector scan, not HNSW); procedures are BM25 only.
Returns `{diagnoses?, procedures?, procedures_note?}`, plus `search_mode: "keyword_only"` when vectors are unavailable; `{error}` when nothing matches. Backs `search_medical_codes`.

### `async inferComplications(code)`
Pure hierarchy lookup: with children returns `{base_code, potential_complications_or_specifics}` (up to 15), otherwise codes of the same category as `{message, related_codes}` (up to 10). Backs `infer_complications`.

### `async getNearbyCodes(code)`
Returns the 2 codes before and the 2 after in alphabetical order as `{target, nearby_options}`. Backs `get_nearby_codes`.

### `async browseCategory(category = null, limit = 50)`
Without `category` lists every category with counts; with one, expands its codes (`limit` capped at 200). Backs `browse_icd_category`.

### `async getConflictInfo(diagnosisCode, procedureCode)`
Returns full data for one diagnosis and one procedure code side by side — facts only, no verdict. Backs `check_medical_conflict`.
