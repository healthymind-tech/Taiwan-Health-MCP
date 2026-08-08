# ICD Service

## Overview
The ICD service is one of the system's core components, responsible for International Classification of Diseases, 10th Revision (ICD-10) data. It integrates the Clinical Modification (ICD-10-CM) and Procedure Coding System (ICD-10-PCS), providing precise medical code lookup, hierarchical inference, and compatibility checking.

## Features

### 1. Medical code lookup
Several query modes let users find the ICD-10 code they need quickly:
- **Keyword search**: search by Chinese or English keyword (for example「糖尿病」, "Diabetes", or "E11").
- **Type filter**: restrict the search to diagnosis codes or procedure codes.
- **Fuzzy matching**: handles partial-match queries.

### 2. Complication inference
Uses the ICD-10 hierarchy to infer complications or finer subcategories that may accompany a principal diagnosis.
- **Hierarchical analysis**: expands from a parent code (for example E11) to child codes (for example E11.2, with kidney complications).
- **Clinical assistance**: helps clinicians avoid missing potentially relevant conditions in the record.

### 3. Contextual analysis (nearby codes)
Returns the codes immediately before and after a target code in the code list, which helps with:
- **Differential diagnosis**: comparing descriptions of similar conditions.
- **Severity assessment**: seeing codes of differing severity within the same category.

### 4. Category browsing
Browse all diagnosis codes by ICD category:
- **Category list**: grouped by the first three characters (for example E11.x, I10.x)
- **Code enumeration**: returns every diagnosis code and name under a given category

### 5. Diagnosis / procedure conflict detection
The module's advanced capability: validating logical compatibility between a diagnosis and a procedure.
- **Indication check**: confirms the procedure is applicable to the diagnosis.
- **Contraindication warning**: flags medically implausible combinations (for example a male-specific diagnosis code paired with uterine surgery).
- **Structured analysis**: returns detailed information about both sides for comparison.

## Technical architecture
- **Data sources**: ICD-10-CM 2025 (NLM) and ICD-10-PCS 2025 (CMS), loaded through the admin console (Admin → Modules, import stage `icd_import`).
- **Database**: PostgreSQL 16, with two tables — `icd.diagnoses` (diagnosis codes) and `icd.procedures` (procedure codes).
- **PCS degradation**: the `_pcs_available` flag — when ICD-10-PCS is not loaded, the tools degrade automatically and return an informational message rather than an error. PCS 2025 (78,948 rows) lives in `fhir-code/icd/10/icd10pcs/` and is loaded by `icd_import` at the same time.
- **Full-text search**: each table has an FTS index supporting Chinese and English keyword search.

## Dependencies
This is a self-contained foundational module, but the following advanced services depend on it:
- **FHIR Condition Service**: converts ICD codes to the FHIR standard format.
- **Health Supplements Service**: recommends related health information based on a diagnosis.
