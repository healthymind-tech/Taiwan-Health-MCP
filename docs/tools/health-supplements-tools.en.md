# Health Supplement Tools

This group covers lookup of Taiwan FDA-approved health supplements and condition-driven recommendations.

## `search_health_supplements`
A single entry point with three modes:

- `mode="keyword"`: search product name, company, ingredients, and health claims
- `mode="permit_no"`: look up by license number, accepting both the full string and digits only — for example `A00022` or `000029`
- `mode="condition"`: recommend approved supplements for a disease / ICD context

### Choosing a mode
| Mode | When to use it | What it searches | What comes back |
| :--- | :--- | :--- | :--- |
| `keyword` | You know the product name or a claim term, or want to see what exists | Product name / company / ingredients / claims | A uniform summary list of matching products |
| `permit_no` | You have the supplement license number, or only its trailing digits | License number / bare digits | An exact match on one product, ideal for confirming approval details |
| `condition` | You want to work back from a disease context to supplements worth considering | ICD code / disease name | Top-level `icd_code` and `recommended_benefits`, with results being the candidate products |

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | string | Yes | `keyword` / `permit_no` / `condition` | `"keyword"` |
| `keyword` | string | Yes | Search keyword; for `condition`, a disease name or ICD-10 code | `"魚油"`, `"A00022"`, `"E11"` |
| `limit` | integer | No | Result cap, 3 by default | `5` |

### Response format
Every mode returns the same top-level structure, but only `condition` mode adds the top-level `icd_code` and `recommended_benefits`:

```json
{
  "mode": "keyword",
  "keyword": "魚油",
  "results": [...]
}
```

### Fields on each result
Every mode uses the same fields on each result:

- `permit_no`
- `product_name`
- `company`
- `benefits`
- `ingredients`
- `specs`
- `status`
- `source_url`

`condition` mode additionally populates, at the top level:
- `icd_code`
- `recommended_benefits`

> Note: `icd_code` and `recommended_benefits` never appear inside individual `results[]` items — only in the top-level response of `condition` mode.

### Usage advice
- To find legally approved products, start with `keyword`.
- To verify certificate data, use `permit_no`.
- To compile candidate products from a disease perspective, use `condition`.
