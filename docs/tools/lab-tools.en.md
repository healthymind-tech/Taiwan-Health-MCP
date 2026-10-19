# Lab Tools (Lab / LOINC)

The LOINC surface has been consolidated into four tools: `search_loinc`, `query_loinc`, `interpret_lab_result`, and `batch_interpret_lab_results`.

Defaults: `search_loinc` uses `mode` `code` and `limit` 3 (10 maximum); `query_loinc` uses `mode` `detail`; `gender` always defaults to `all`. The `code` / `specimen` / `component` modes run a hybrid BM25 + semantic search (`code` mode uses score-aware fusion with LOINC `COMMON_TEST_RANK` and status as a prior; **analyte families**: among the terms of one COMPONENT (without its `^` timing / challenge suffix; per-cell and fraction properties form their own family) the ones the query cannot tell apart — the same query words covered, or, when no query word matched, a similarity within 0.2 — are ordered by `COMMON_TEST_RANK`, so "hemoglobin" gets 718-7 rather than a molar or arterial variant while "arterial lactate" still gets the arterial term; the 2 most common terms of every pooled analyte join the pool; the plain analyte of a challenge / timing variant joins too ("Renin^baseline" → Renin); panels and ratios (a COMPONENT with `/`) sink a little unless the query says panel / ratio / `/` / `%` / 比值. **Analyte synonyms**: `loinc.component_names` holds analyte names from Loinc.csv `RELATEDNAMES2` and the zh-CN linguistic variant (folded to Traditional script) — "uric acid" → Urate, "FSH" / 卵泡刺激素 → Follitropin, 泌乳激素 → Prolactin — keeping only names listed on most of the analyte's terms and shared by at most 300 analytes, which drops specimen / timing / class vocabulary; a name of an analyte does not match its ratios (白蛋白 is Albumin, not Albumin/Protein.total) unless the query asks for a ratio or `%`. **Axis words**: `loinc.axis_names` holds the names of every SYSTEM / TIME / METHOD / PROPERTY / SCALE value taken from LOINC itself — Part.csv part and display names ("BldV" = "Venous blood", "24H" = "24 hours") and the Loinc.csv `RELATEDNAMES2` names listed on nearly every term of a value ("Venous", "Random" → Pt, "Dipstick" → Test strip, "Percent" → the fraction properties, "Spinal fluid" → CSF). Specimen / timing / method / property / scale words in an English query ("venous lactate", "salivary cortisol", "CSF glucose", "24 hour urine protein", "random urine sodium", "urine glucose dipstick", "HbA1c by HPLC", "neutrophils %") become constraints: within an analyte family the terms that honour them (by axis value, or because their own name already contains the word) come before the most common term, the analyte's most common terms with that specimen / timing join the pool, and a small prior (±0.1) rewards / penalises agreement; when the query names no axis, ranking is as before. When two specimens that exclude each other appear ("urine blood dipstick"), the first is taken as the specimen. Needs migrations `20261024`, `20261025` and `20261026` plus a LOINC re-import; without them ranking is as before) and fall back to keyword-only with `search_mode: "keyword_only"` when embeddings are unavailable. The whole group is unregistered while `loinc.concepts` holds fewer than 1,000 rows.

> **Maintenance mode**: while the admin console has the `loinc` module in maintenance mode, this group's calls return an `isError` result immediately with error code `MODULE_MAINTENANCE` (`error.message` in English, `error.message_zh` in Traditional Chinese, `error.module` the module key), effective within about 5 seconds; the tools stay in `tools/list`. See the [API reference](../api/index.md#maintenance).

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
