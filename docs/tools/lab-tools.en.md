# Lab Tools (Lab / LOINC)

The LOINC surface has been consolidated into four tools: `search_loinc`, `query_loinc`, `interpret_lab_result`, and `batch_interpret_lab_results`.

## 1) `search_loinc` (search entry point)

A single search entry point; `mode` switches the query intent.

### Mode: `code`
- Purpose: find candidate LOINC codes by test name, abbreviation, or keyword
- Parameters: `keyword` required, `category` optional, `limit` optional
- Example: `search_loinc(mode="code", keyword="HbA1c", category="CHEM", limit=5)`

### Mode: `category`
- Purpose: list every available LOINC category (filter category names with `keyword`)
- Parameters: `keyword` optional, `limit` optional
- Example: `search_loinc(mode="category")`
- Example: `search_loinc(mode="category", keyword="CHE")`

### Mode: `specimen`
- Purpose: find candidate test codes by specimen type
- Parameters: `keyword` required (specimen name), `limit` optional
- Example: `search_loinc(mode="specimen", keyword="Urine", limit=5)`

### Mode: `component`
- Purpose: find related test codes by analyte / component
- Parameters: `keyword` required (analyte), `limit` optional
- Example: `search_loinc(mode="component", keyword="Glucose", limit=5)`

---

## 2) `query_loinc` (detail / reference range entry point)

A single query entry point; `mode` switches between detail and reference range.

### Mode: `detail`
- Purpose: full concept detail for a single LOINC code
- Parameters: `loinc_code` required
- Example: `query_loinc(mode="detail", loinc_code="2345-7")`

### Mode: `reference_range`
- Purpose: the reference range for a single LOINC code
- Parameters: `loinc_code` and `age` required, `gender` optional (`M`/`F`/`all`)
- Example: `query_loinc(mode="reference_range", loinc_code="2345-7", age=45, gender="M")`

---

## 3) `interpret_lab_result`

Interpretation of a single result.

- Parameters: `loinc_code`, `value`, and `age` required, `gender` optional
- Example: `interpret_lab_result(loinc_code="1558-6", value=126, age=45, gender="M")`

---

## 4) `batch_interpret_lab_results`

Batch interpretation (an entire report).

- Parameters: `results_json` and `age` required, `gender` optional
- `results_json` format:
```json
[{"loinc_code":"2345-7","value":126},{"loinc_code":"718-7","value":15.2}]
```
- Example: `batch_interpret_lab_results(results_json='[...]', age=45, gender="M")`

---

## Suggested order of use

1. Find the code: `search_loinc(mode="code" | "specimen" | "component")`
2. Review the detail: `query_loinc(mode="detail", ...)`
3. Get a reference range: `query_loinc(mode="reference_range", ...)`
4. Interpret values: `interpret_lab_result` or `batch_interpret_lab_results`
