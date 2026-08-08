# SNOMED CT Tools

The public SNOMED surface consists of four tools: `search_snomed_concept`, `query_snomed_concept`, `get_snomed_relationships`, and `query_snomed_mapping`.

## `search_snomed_concept`
Search SNOMED concept candidates by English clinical term.

### When to use it
Use it first when you only have a text term and do not yet know the concept ID. The tool ranks with BM25 + embeddings, returning the closest concepts semantically rather than only exact literal matches.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `query` | string | Yes | English clinical term | `"diabetes mellitus"` |
| `limit` | integer | No | Result cap (3 by default) | `5` |

### What comes back
Each row typically carries `concept_id`, the FSN, active status, and similarity information — enough to pick the concept to query next.

---

## `query_snomed_concept`
Retrieve the concept itself plus its hierarchical context (parents / children) in one call.

### When to use it
Use it when you already have a concept ID and want concept details, ancestors, and children together.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `concept_id` | integer | Yes | SNOMED concept ID | `73211009` |
| `include_parents` | boolean | No | Return the ancestor chain, `true` by default | `false` |
| `include_children` | boolean | No | Return direct child concepts, `true` by default | `false` |
| `parent_limit` | integer | No | Cap on ancestors expanded, 10 by default | `20` |
| `child_limit` | integer | No | Cap on children expanded, 20 by default | `50` |

### What comes back
`concept` is always present; `ancestors`, `children`, and their counts are attached according to the parameters.

---

## `get_snomed_relationships`
Query non-IS-A attribute relationships (semantic attributes).

### When to use it
Use it to see clinical semantic attributes rather than hierarchy — for example finding site, causative agent, associated morphology, or has active ingredient.

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `concept_id` | integer | Yes | SNOMED concept ID |

---

## `query_snomed_mapping`
A single entry point for bidirectional ICD ↔ SNOMED mapping.

### Modes
- `mode="icd"`: `keyword` is treated as an ICD-10 code, returning `snomed_concepts`.
- `mode="snomed"`: `keyword` may be a numeric concept ID or an English term.
  - Purely numeric: maps directly by concept ID (no embeddings involved)
  - Text: performs a SNOMED search for the best concept first, then maps (this step uses embeddings)

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | string | No | `icd` or `snomed` | `"icd"` |
| `keyword` | string | Yes | ICD code, concept ID, or English term | `"E11.9"`, `"44054006"` |
