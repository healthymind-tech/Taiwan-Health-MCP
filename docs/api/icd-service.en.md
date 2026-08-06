# ICD Service API

## class `ICDService`

### `__init__(self, pool)`
Initialise the ICD service; takes a `pg.Pool` connection pool (through pgBouncer).

- **pool**: the `pg.Pool` connection pool, injected by the process startup sequence in `server.ts`.

### `async initialize(self)`
Check whether the `icd.procedures` table has data and set the `_pcs_available` flag.

### `async search_codes(self, keyword: str, type: str = "all") -> str`
Full-text search over ICD-10-CM diagnosis codes or ICD-10-PCS procedure codes.

- **keyword**: the search string (Chinese and English both supported).
- **type**: `"diagnosis"`, `"procedure"`, or `"all"`.
- **Returns**: a formatted text result.

### `async infer_complications(self, code: str) -> str`
Infer potential complications from the ICD hierarchy, listing child codes (such as E11.2) under a parent code (such as E11).

### `async get_nearby_codes(self, code: str) -> str`
Retrieve the codes adjacent to the target code within its classification.

### `async browse_category(self, category: str = None, limit: int = 50) -> str`
Browse the list of diagnosis codes by three-character category.

### `async get_conflict_info(self, diagnosis_code: str, procedure_code: str) -> dict`
Retrieve the detailed information used for diagnosis / procedure conflict analysis.
