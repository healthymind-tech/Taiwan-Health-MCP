# ICD-10 Tools

This group provides lookup and logical analysis over ICD-10-CM (diagnoses) and ICD-10-PCS (procedures).

## search_medical_codes
Search ICD-10 diagnosis or procedure codes.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | Yes | Search keyword (code, Chinese name, or English name) | `"糖尿病"`, `"E11"`, `"Appendectomy"` |
| `type` | string | No | Search type, `"all"` by default.<br>Allowed values: `"diagnosis"`, `"procedure"`, `"all"` | `"diagnosis"` |
| `limit` | integer | No | Cap per result class, 3 by default | `5` |

### How the search works
`diagnosis` runs a hybrid BM25 + vector re-ranking search; `procedure` is BM25 only; `all`
(the default) does both and returns them under separate `diagnoses` / `procedures` keys.
Results are ordered by relevance, not alphabetically by code.

---

## infer_complications
Infer potential complications or child codes from the ICD-10 hierarchy.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `code` | string | Yes | Base diagnosis code | `"E11"` |

### Purpose
When the user supplies only a vague diagnosis (such as "diabetes"), this tool lists the specific subdivisions under that category (such as nephropathy or retinopathy) to help clarify the condition.

---

## get_nearby_codes
Retrieve the codes immediately before and after a target code in the list.

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
| `limit` | integer | No | Cap on codes returned when expanding a category, 50 by default | `100` |

### Purpose
Without `category`, returns `{"total_categories", "categories": [...]}`; with a category (such as `E11`), returns every diagnosis code under it as `{"category", "total", "codes": [...]}`. Suitable for listing categories first and then drilling down.

> Every tool returns JSON (a JSON string inside the MCP `content[0].text` block); none of them emit a plain-text format.
