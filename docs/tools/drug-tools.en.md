# Drug Tools

This group integrates Taiwan FDA (TFDA) western-medicine license data, providing drug search, pill identification, drug details, and official document asset download links.

## search_drug
A single entry point with four search modes.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | string | No | `drug_name` / `ingredient` / `license_id` / `atc_code`, `drug_name` by default | `"ingredient"` |
| `keyword` | string | Yes | The search term, interpreted according to `mode` | `"普拿疼"`, `"acetaminophen"`, `"000029"`, `"N02BE01"` |
| `limit` | integer | No | Result cap, 3 by default, maximum 10 | `5` |
| `include_cancelled` | boolean | No | Whether to include revoked licenses, `false` by default | `true` |

### Choosing a mode
| Mode | When to use it | What it searches |
| :--- | :--- | :--- |
| `drug_name` | The Chinese or English drug name is known | Drug name |
| `ingredient` | Looking for drugs containing an ingredient | Ingredient text |
| `license_id` | The license number or its trailing digits is known | License number |
| `atc_code` | Looking up drugs by ATC classification | ATC code |

### Response format
```json
{ "mode": "drug_name", "keyword": "普拿疼", "include_cancelled": false, "results": [...] }
```

---

## identify_unknown_pill
Identify an unknown drug from tablet appearance keywords.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `features` | string | Yes | Space-separated appearance keywords (colour / shape / score line / marking / size / engraving) | `"white round"`, `"白 圓形"` |

### Purpose
Each keyword is matched conjunctively against the appearance description, colour, shape, symbol, score line, size, and engraving fields. English colour and shape terms are expanded through a built-in synonym table. Appearance data must be loaded first by a `drug_enrichment` job (Admin → Modules).

---

## get_drug_details
Return the normalized drug record for a single license.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `license_id` | string | Yes | License number | `"衛署藥製字第000480號"` |
| `include_cancelled` | boolean | No | Whether to include revoked licenses, `false` by default | `true` |

### Purpose
The detail counterpart to `search_drug`. The response is assembled from normalized JSON in PostgreSQL, along with the current availability and document counts for each stage.

---

## get_drug_asset_links
Return drug document asset metadata plus freshly generated MinIO download links.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `license_id` | string | No | License number (supply this or `asset_id`) | `"衛署藥製字第000480號"` |
| `asset_id` | string | No | A specific asset ID | — |
| `asset_group` | string | No | `insert` (electronic package insert) / `label` (carton label) / `shape` (pill image) / `analysis` (analysis output) | `"insert"` |
| `latest_insert_only` | boolean | No | Return only the newest insert, `false` by default | `true` |

### Purpose
The returned download links are time-limited presigned URLs. The corresponding data must be loaded first by `drug_enrichment` (assets) and `drug_analysis` (analysis output) jobs.
