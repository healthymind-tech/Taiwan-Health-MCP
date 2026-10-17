# Lab Service

## Overview
The lab service integrates reference data and standard coding for laboratory tests, with particular emphasis on mapping Taiwan NHI lab codes to the international lab standard (LOINC). The module aims to improve the interoperability of lab data and the consistency of its interpretation.

## Features

### 1. Test lookup and LOINC mapping
- **Code mapping**: cross-reference lookup between local lab codes and LOINC (Logical Observation Identifiers Names and Codes).
- **Standardised names**: standard Chinese and English names for each test, reducing confusion when one test has several names.

### 2. Reference ranges
Standard reference intervals for each category of test, to assist interpretation:
- **Numeric ranges**: upper and lower bounds of the normal range (for example haemoglobin Hb 13.5–17.5 g/dL).
- **Unit conversion**: recognises common units.
- **Sex and age differences**: some tests provide different reference standards by sex or age band.

### 3. Abnormality interpretation (`interpret_lab_result`)
Picks the reference interval that applies to the patient's age / sex, flags the value `H` (high), `L` (low) or `N` (normal), and returns the interval, its source note and a generic sentence (for example "above the normal reference value; further evaluation advised"). It does **not** infer causes — clinical meaning is for the caller or a clinician to judge. A value can only be interpreted when `loinc.reference_ranges` holds a range for that code.

### 4. Search by specimen type
Filter LOINC tests by specimen type such as blood, urine, or stool.

### 5. Related test lookup
Find all related LOINC tests for the same analyte, helping select the most appropriate method.

### 6. Full LOINC concept details
Retrieve complete information for a single LOINC code, including a patient-friendly Chinese name, units, specimen, and method.

### 7. Batch result interpretation (`batch_interpret_lab_results`)
Submit many values at once (`results_json`, each item with `loinc_code` and `value`) and get back `total_tests`, `abnormal_count`, `normal_count` and the per-item interpretations; items without a reference range are skipped.

## Technical architecture
- **Data sources**: LOINC 2.80 (`Loinc_2.80.zip`, about 105k concepts), uploaded and imported on the **Terminology → LOINC** page of the admin console (import stage `loinc_import`). Two optional, project-curated sources: `loinc_taiwan_mapping` (Chinese names of tests common in Taiwan, `data/loinc/taiwan_mapping.csv`, about 30 rows) and `loinc_reference_ranges` (age/sex-stratified reference ranges, `data/loinc/lab_reference_ranges.csv`, about 40 rows).
- **Extra content for the FHIR validator**: the import also keeps the answer (LA), part (LP), answer-list (LL) and group (LG) codes of the LOINC zip AccessoryFiles (`loinc.other_codes`) and the release version (`loinc.editions`), so the FHIR validator can check those codes and displays; unknown LOINC codes are errors only when the local release is at least the version tx.fhir.org uses (currently 2.82), warnings otherwise (2.80 < 2.82, so warnings today).
- **LOINC structure tables** (migration `20261020_loinc_structure.sql`): `loinc.part_links` (per-axis parts: COMPONENT / PROPERTY / TIME / SYSTEM / SCALE / METHOD), `loinc.answer_list_items` / `loinc.answer_list_links` (answer lists), `loinc.panel_items` (panel membership) and `loinc.map_to` (MapTo replacements), written in the same promote transaction as `loinc.concepts` and read by the admin terminology browser.
- **Database**: PostgreSQL 16 — `loinc.concepts` (LOINC codes), `loinc.reference_ranges` (reference values), the extra tables above, and the vector table `loinc.concept_embeddings` (backfilled by `loinc_embed`).
- **Terminology browsing**: the module page's "Data preview" tab offers six-axis facet filtering, a single-term view (parts, answer lists, panels, MapTo) and LA/LP/LL/LG code lookup, backed by `/admin/api/terminology/loinc/*` (`facets`, `facet-values`, `term`, `code`).
- **Structured output**: the returned data can be used directly to generate FHIR Observation resources.

## Use cases
1. **Health check-up report systems**: automatically flag abnormal values and attach explanations.
2. **EMR integration**: standardise in-house lab codes to LOINC for cross-hospital exchange.
3. **Personal health management**: help the public understand the terminology and values in their check-up reports.
