# ICD-10 Tools

This group provides lookup and logical analysis over ICD-10-CM (diagnoses) and ICD-10-PCS (procedures).

## search_medical_codes
Search ICD-10 diagnosis or procedure codes.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | Yes | Search keyword (code, Chinese name, or English name) | `"糖尿病"`, `"E11"`, `"Appendectomy"` |
| `type` | string | No | Search type, `"all"` by default.<br>Allowed values: `"diagnosis"`, `"procedure"`, `"all"` | `"diagnosis"` |

### Example response
```text
Found 5 matches:
1. [E11.9] Type 2 diabetes mellitus without complications (第二型糖尿病，無併發症)
...
```

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
**[Advanced tool]** Check compatibility between a diagnosis and a procedure.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `diagnosis_code` | string | Yes | ICD-10-CM diagnosis code | `"K35.80"` (acute appendicitis) |
| `procedure_code` | string | Yes | ICD-10-PCS procedure code | `"0DTJ0ZZ"` (appendectomy) |

### Purpose
Answers questions such as "is this surgery appropriate for this condition?" or "do these two conflict?". The result includes the detailed definitions of both sides for comparison.

---

## browse_icd_category
Browse diagnosis codes by ICD category.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `category` | string | No | Category code (first three characters). Omit to return the list of all categories | `"E11"` |

### Purpose
Without `category`, returns `{"total_categories", "categories": [...]}`; with a category (such as `E11`), returns every diagnosis code under it as `{"category", "total", "codes": [...]}`. Suitable for listing categories first and then drilling down.

> Most search tools also accept a `limit` parameter to cap the number of results.
