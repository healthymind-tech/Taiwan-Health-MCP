# ICD-10 Tools

This group provides lookup and hierarchy browsing over ICD-10-CM (diagnoses) and ICD-10-PCS (procedures). Data comes from `icd.diagnoses` / `icd.procedures`, populated by the `icd_import` job; the loaded ICD-10-CM edition (for example the complete `2026-04-01` edition loaded from the CMS "Code Descriptions in Tabular Order" file, including 7th characters and placeholder X) is reported by `health_check` under `terminology.icd10cm`. The whole group is unregistered while `icd.diagnoses` holds fewer than 10,000 rows.

> **Maintenance mode**: while the admin console has the `icd` module in maintenance mode, this group's calls return an `isError` result immediately with error code `MODULE_MAINTENANCE` (`error.message` in English, `error.message_zh` in Traditional Chinese, `error.module` the module key), effective within about 5 seconds; the tools stay in `tools/list`. See the [API reference](../api/index.md#maintenance).

## search_medical_codes
Search ICD-10 diagnosis or procedure codes.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | Yes | Search keyword (code, Chinese name, or English name) | `"糖尿病"`, `"E11"`, `"Appendectomy"` |
| `type` | string | No | Search type, `"all"` by default.<br>Allowed values: `"diagnosis"`, `"procedure"`, `"all"` | `"diagnosis"` |
| `limit` | integer | No | Cap per result class, 3 by default, 10 maximum (50 for an IG CodeSystem) | `5` |
| `system` | string | No | Omit for ICD-10 (by `type`). `icd10cm` / `icd10pcs`, or any CodeSystem of an installed IG: canonical, id or alias words (e.g. `nhi_payment` = the NHI medical service payment codes). IG CodeSystems go through [IG Concept Search](../modules/ig-concept-search.md) and return `{keyword, system, codesystem, results[], clauses?, search_mode?, alternatives?, searched_copy?}`; every result carries `accepted_by_validator` (whether the validator accepts it, as `fhir_normalize_code`), and an excerpt CodeSystem is searched in its installed full copy | `"nhi_payment"` |

### How the search works
`diagnosis` runs a hybrid BM25 + vector re-ranking search; `procedure` is BM25 only; `all`
(the default) does both and returns them under separate `diagnoses` / `procedures` keys.
Results are ordered by relevance, not alphabetically by code: the candidates are the union of full-text matches (shortest names first) and the nearest vectors, ordered by score-aware fusion — the lexical score measures how far query and name cover each other (a query that *is* a name beats longer sub-concepts that merely contain it; qualifiers such as "unspecified" / 未明示 cost nothing), the semantic score is the cosine similarity rescaled within the pool, plus a small code-depth prior (a short query prefers I50 / I50.9 over I50.813). The two nearest vectors always stay in the result, so weak keyword hits can no longer push a strong semantic match out of the top-k (the old RRF failure).
The vector side deliberately runs an exact scan instead of the HNSW index: the complete ICD-10-CM has many near-duplicate codes that differ only in the 7th character, and HNSW recall collapses on that data.
When the embedding endpoint is unavailable or `icd.diagnosis_embeddings` is empty the search falls back to keyword-only and the response carries `search_mode: "keyword_only"`.
When ICD-10-PCS is not loaded, `procedures` is an empty array with a `procedures_note`.

---

## infer_complications
List a code's child codes from the ICD-10-CM hierarchy (pure hierarchy lookup — no clinical inference).

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `code` | string | Yes | Base diagnosis code | `"E11"` |

### Purpose
When the user supplies only a vague diagnosis (such as "diabetes"), this tool lists the specific subdivisions under that category (such as nephropathy or retinopathy) to help clarify the condition.
With children it returns `{base_code, potential_complications_or_specifics}` (up to 15); for a leaf code it returns other codes of the same category as `{message, related_codes}` (up to 10).

---

## get_nearby_codes
Retrieve the 2 codes immediately before and the 2 after a target code in alphabetical order (ordering neighbours, not semantic matches).

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `code` | string | Yes | Target code | `"I10"` |

### Purpose
Useful for reviewing codes of differing severity or similar character within the same disease spectrum, which assists differential diagnosis.

---

## check_medical_conflict
Fetch the full definitions of one diagnosis code and one procedure code side by side for coding QA.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `diagnosis_code` | string | Yes | ICD-10-CM diagnosis code | `"K35.80"` (acute appendicitis) |
| `procedure_code` | string | Yes | ICD-10-PCS procedure code | `"0DTJ0ZZ"` (appendectomy) |

### Purpose
Returns the detailed definitions of both sides for comparison. **The tool reports facts only and makes no compatibility judgement** — it returns no pass/fail verdict, so deciding whether the pair conflicts is left to the caller.

---

## browse_icd_category
Browse diagnosis codes by ICD category.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `category` | string | No | Category code (first three characters). Omit to return the list of all categories | `"E11"` |
| `limit` | integer | No | Cap on codes returned when expanding a category, 50 by default, 200 maximum | `100` |

### Purpose
Without `category`, returns `{"total_categories", "categories": [...]}`; with a category (such as `E11`), returns every diagnosis code under it as `{"category", "total", "codes": [...]}`. Suitable for listing categories first and then drilling down.

> Every tool returns JSON (a JSON string inside the MCP `content[0].text` block); none of them emit a plain-text format.
