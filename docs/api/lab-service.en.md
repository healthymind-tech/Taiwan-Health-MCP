# Lab Service API

`LabService` (`node-server/src/labService.ts`) handles LOINC search, category browsing, reference-range lookup and lab-result interpretation,
backing the four tools `search_loinc`, `query_loinc`, `interpret_lab_result` and `batch_interpret_lab_results`.
Database access goes through the shared pool in `db.ts`; methods return JSON-serialisable objects.

## class `LabService`

### `constructor(embeddingSvc: EmbeddingService | null = null)`
Takes the shared `EmbeddingService`; with `null` searches are keyword-only.

### `async searchLoincCode(keyword, category = null, limit = 3)`
Searches candidate LOINC codes by test name, abbreviation or analyte (BM25 + semantic hybrid); `category` narrows to one LOINC class. Carries `search_mode: "keyword_only"` when vectors are unavailable.

### `async searchBySpecimen(specimenType, limit = 3)`
Searches LOINC items by specimen type.

### `async findRelatedTests(component, limit = 3)`
Finds related LOINC tests for the same analyte, grouped by specimen system (`by_system`).

### `async listCategories()`
Lists the LOINC classes available in the database.

### `async getPatientFriendlyName(loincNum)`
Full concept detail and patient-friendly name for one LOINC code (`query_loinc` `detail` mode).

### `async getReferenceRange(loincNum, age, gender = "all")`
Reference range by age and sex (`"M" | "F" | "all"`) (`query_loinc` `reference_range` mode).

### `async interpretLabResult(loincNum, value, age, gender = "all")`
Interprets one value: returns the range, the measured value and a normal / high / low flag.

### `async batchInterpretResults(results, age, gender = "all")`
Interprets an array of `{loinc_code, value}` in one call — suited to a full lab report.

> Reference values are general guidance only and do not replace clinical judgement.
