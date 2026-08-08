# Lab Service API

`LabService` handles LOINC search, category browsing, reference range lookup, and lab result interpretation.

## class `LabService`

### `__init__(self, pool)`
Initialise the lab service; takes a `pg.Pool` connection pool.

### `async search_loinc_code(self, keyword: str, category: str = None) -> str`
Search for candidate LOINC codes. Suitable for finding likely test codes from a test name, abbreviation, analyte, or specimen phrase.

### `async list_categories(self) -> str`
List the LOINC top-level categories available in the database.

### `async get_reference_range(self, loinc_num: str, age: int, gender: str = "all") -> str`
Retrieve the reference range for a single LOINC code by age and sex.

### `async interpret_lab_result(self, loinc_num: str, value: float, age: int, gender: str = "all") -> str`
Interpret a single lab value, producing a structured high / normal / low result.

### `async search_by_specimen(self, specimen_type: str) -> str`
Search LOINC entries by specimen type.

### `async find_related_tests(self, component: str) -> str`
Find related LOINC tests for the same analyte, usually grouped by specimen system.

### `async get_patient_friendly_name(self, loinc_num: str) -> str`
Retrieve the full LOINC concept detail and a patient-friendly name.

### `async batch_interpret_results(self, results: list, age: int, gender: str = "all") -> str`
Interpret many results at once — suitable for a full panel or an entire report.
