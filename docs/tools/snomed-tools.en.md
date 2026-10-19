# SNOMED CT Tools

The public SNOMED surface consists of four tools: `search_snomed_concept`, `query_snomed_concept`, `get_snomed_relationships`, and `query_snomed_mapping`.

> **Maintenance mode**: while the admin console has the `snomed` module in maintenance mode, this group's calls return an `isError` result immediately with error code `MODULE_MAINTENANCE` (`error.message` in English, `error.message_zh` in Traditional Chinese, `error.module` the module key), effective within about 5 seconds; the tools stay in `tools/list`. See the [API reference](../api/index.md#maintenance).

## `search_snomed_concept`
Search SNOMED concept candidates by English clinical term.

### When to use it
Use it first when you only have a text term and do not yet know the concept ID. The tool ranks full-text and embedding candidates with score-aware fusion over every active name of a concept (FSN and synonyms), returning the closest concepts semantically rather than only exact literal matches; a concept whose name the query is ranks first, and inactive concepts sink.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `query` | string | Yes | English clinical term | `"diabetes mellitus"` |
| `limit` | integer | No | Result cap (3 by default, 10 maximum) | `5` |
| `hierarchy_filter` | integer | No | Return only IS-A descendants of one concept (usually a top-level hierarchy concept ID) | `404684003` |

### What comes back
Each row carries `concept_id`, `fsn`, `preferred_term`, `active` and `hierarchy_tag` — enough to pick the concept to query next; use `query_snomed_concept` for the full record.

### How `hierarchy_filter` works
`hierarchy_filter` restricts results to that concept and its IS-A descendants (the concept itself included). The full-text half is always the hierarchy's best literal matches; the vector half depends on the hierarchy's size:

- **≤ 1,000 concepts** (e.g. Heart structure): an exact vector comparison against every member (the same ordering as an unfiltered search).
- **> 1,000 concepts** (e.g. Body structure 42,697, Procedure 59,616, Substance 27,725): a walk of the HNSW vector index that keeps only members, bounded to 1,000 visited entries. Membership is one primary-key probe into `snomed.concept_ancestors` (each concept's IS-A ancestors, built at import). A filtered search therefore costs about as much as an unfiltered one (an exact scan of a large hierarchy used to take 40–130 s); the trade-off is that a query with no literal or semantic tie to the hierarchy (e.g. "fracture of femur" within Substance) can return fewer results, or none, instead of the hierarchy's "least distant" concepts.

Until `snomed.concept_ancestors` exists (migration `20261028_snomed_concept_ancestors.sql` not applied), the descendant set is expanded on every call instead — same results, 0.2–0.5 s more per call (warm cache).

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
| `parent_limit` | integer | No | Cap on ancestors expanded, 10 by default, 20 maximum | `20` |
| `child_limit` | integer | No | Cap on children expanded, 20 by default, 200 maximum | `50` |

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
| `relationship_type_id` | integer | No | Return only one relationship type (e.g. `363698007` finding site) |

Returns `{concept_id, relationship_count, relationships}`, grouped by relationship type, each group with a readable label and its target concepts.

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
| `mode` | string | No | `icd` or `snomed`, `icd` by default | `"icd"` |
| `keyword` | string | Yes | ICD code, concept ID, or English term | `"E11.9"`, `"44054006"` |
