# ICD Service

## Overview
The ICD service is one of the system's core components, responsible for International Classification of Diseases, 10th Revision (ICD-10) data. It integrates the Clinical Modification (ICD-10-CM) and Procedure Coding System (ICD-10-PCS), providing precise medical code lookup, hierarchical inference, and compatibility checking.

## Features

### 1. Medical code lookup
Several query modes let users find the ICD-10 code they need quickly:
- **Keyword search**: search by Chinese or English keyword (for example「糖尿病」, "Diabetes", or "E11").
- **Type filter**: restrict the search to diagnosis codes or procedure codes.
- **Hybrid search**: diagnosis codes are ranked by BM25 full-text search plus vector similarity (merged with RRF). Vectors must first be backfilled by the `icd_embed` job; when the embedding endpoint is unavailable the search falls back to keywords and is marked `search_mode: "keyword_only"`.

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
`check_medical_conflict` helps judge the logical compatibility of a diagnosis and a procedure (for example a male-specific diagnosis code paired with uterine surgery).
- **Structured data**: returns the full rows for both the diagnosis code and the procedure code, with an instruction asking the caller (the LLM) to analyse contraindications.
- **The caller decides**: the tool has **no** built-in indication / contraindication rule base; the conflict judgement is left to the caller, reasoning over the returned data.
- **When PCS is not loaded**: the procedure side returns an "ICD-10-PCS data not loaded" notice.

## Technical architecture
- **Data sources**: ICD-10-CM and ICD-10-PCS (CMS), uploaded and imported on the **Terminology → ICD-10** page of the admin console, "Data lifecycle" tab (import stage `icd_import`). Source roles:
    - `icd10cm` (required): upload the CMS "Code Descriptions in Tabular Order" zip (it holds `icd10cm_order_YYYY.txt`, e.g. `april-1-2026-code-descriptions-tabular-order.zip`). It is the complete code set (header codes plus billable codes including 7th characters / placeholder `X` — 98,186 codes in the 2026-04-01 release) and keeps the CMS short title and the header flag. The "Code Tables, Tabular and Index" zip (tabular XML) is also accepted — 7th characters are expanded — but it does not count as a complete edition.
    - `icd10pcs`: the ICD-10-PCS zip (CMS flat codes TXT).
    - `icd_zh_tw` (optional): the MOHW bilingual XLSX, for Chinese names.
    - `icd10_who` (optional): "WHO ICD-10 (FHIR JSON)" — a WHO ICD-10 FHIR CodeSystem or expanded ValueSet (e.g. the tx.fhir.org edition `2019-covid-expanded`, 13,831 codes, fetched with `node-server/scripts/validator-audit/harness/fetch_tx_terms.py`), imported into `icd.icd10_who` so the FHIR validator can check codes and displays of `http://hl7.org/fhir/sid/icd-10`.
- **Edition record and strict judgement**: every import writes `icd.editions` (`edition`, `source_format` = `cms-order` / `tabular-xml`, `complete`, `code_count`) in the same promote transaction. Only when the local table is a complete CMS order-file edition does the FHIR validator report unknown ICD-10-CM codes as **errors** (as tx.fhir.org does); with tabular XML, or no recorded edition, they stay warnings. WHO ICD-10 works the same way: strict only when the complete `2019-covid-expanded` edition is loaded.
- **Database**: PostgreSQL 16 — `icd.diagnoses` (diagnosis codes, with `short_name_en` and `is_header`), `icd.procedures` (procedure codes), `icd.editions`, `icd.icd10_who`, and the vector table `icd.diagnosis_embeddings`.
- **PCS degradation**: the `pcsAvailable` flag in `icdService.ts` — when `icd.procedures` is empty, the procedure features degrade automatically and return an informational message rather than an error.
- **Vector search uses an exact scan on purpose**: the diagnosis vector query orders by `(embedding <=> $v) + 0` so the planner stays off the HNSW index — the ~50k near-duplicate 7th-character codes make HNSW recall collapse (diabetes queries returned fracture codes). An exact scan of ~98k rows takes about 0.35 s.
- **Terminology browsing**: the "Data preview" tab of the same module page offers an ICD-10-CM chapter tree, a WHO ICD-10 tree and an ICD-10-PCS seven-axis table browser, backed by `/admin/api/terminology/icd/*` (`cm/children`, `cm/path`, `cm/search`, `who/*`, `pcs/browse`, `pcs/table`, `pcs/codes`, `pcs/code`, `pcs/search`).
- **Local development**: without an admin upload the loader falls back to `fhir-code/icd/10/` (overridable with `ICD_CM_ZIP`, `ICD_PCS_ZIP` and similar env vars); see [Test data files](../data-sources/test-data.md).

## Dependencies
This is a self-contained foundational module, but the following advanced services depend on it:
- **FHIR Condition Service**: converts ICD codes to the FHIR standard format.
- **Health Supplements Service**: its `condition` mode resolves a diagnosis keyword through ICD search.
- **FHIR IG validator**: judges ICD-10-CM / WHO ICD-10 codes and displays against `icd.*`.
