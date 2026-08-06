# SNOMED CT Service

## Overview
The SNOMED CT service integrates the SNOMED CT International edition terminology, providing concept search, concept details, relationship (hierarchy and attribute) queries, and SNOMED ↔ ICD-10 mapping. SNOMED CT is the broadest clinical terminology in use today; this module lets the system express clinical semantics as standard concepts and interoperate with ICD-10.

## Features

### 1. Concept search (`search_snomed_concept`)
Search SNOMED CT concepts by Chinese or English keyword, returning the concept ID, FSN (Fully Specified Name), and preferred term. Semantic / hybrid search is supported (requires a working embedding endpoint, configured in Admin → Settings); without embeddings it falls back to keyword search.

### 2. Concept details (`query_snomed_concept`)
Retrieve full information for a single concept by concept ID, including:
- **FSN and preferred term**
- **Ancestors**: concepts up the `is-a` hierarchy, with depth.
- **Children**: direct child concepts.

### 3. Relationship queries (`get_snomed_relationships`)
Retrieve all relationships for a concept, grouped by relationship type, listing the target concept of each attribute — for example finding site or associated morphology.

### 4. SNOMED ↔ ICD-10 mapping (`query_snomed_mapping`)
Bidirectional mapping:
- **`mode="icd"`**: given an ICD-10 code (for example `E11.9`), return the corresponding SNOMED concepts.
- **`mode="snomed"`**: given a SNOMED concept ID (for example `44054006`), return the corresponding ICD-10 mapping.

## Technical architecture
- **Data source**: SNOMED CT International RF2 (`SnomedCT_InternationalRF2_PRODUCTION_*.zip`), loaded through the admin console (Admin → Modules, import stage `--snomed`). The dataset is large — expect roughly 5–15 minutes.
- **Database**: the `snomed` schema, with `concepts`, `descriptions`, `relationships`, `icd10_map`, `historical_associations`, and `concept_embeddings`.
- **Availability gate**: `snomed.concepts` must reach the threshold (100,000 rows) before the corresponding tools are registered; otherwise they degrade automatically.

## Key limitations
- Using SNOMED CT requires an active SNOMED International license (free for most uses). The related tools are not enabled while the data is unloaded.
