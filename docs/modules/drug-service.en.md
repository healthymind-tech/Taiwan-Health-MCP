# Drug Service

## Overview
The drug service integrates Taiwan FDA (TFDA) western-medicine license data, providing drug search, pill appearance identification, drug details, and download links for official document assets (package inserts / carton labels / pill images). The data is built around TFDA's standard license index and progressively enriched by a multi-stage pipeline.

## Features

### 1. Drug search (`search_drug`)
Four search modes are supported:

- **`drug_name`**: search by Chinese or English drug name (for example「普拿疼」or "acetaminophen").
- **`ingredient`**: search by ingredient text.
- **`license_id`**: exact lookup by license number (for example「衛署藥製字第000480號」or the numeric ID).
- **`atc_code`**: search by ATC classification code (for example "N02BE01").

`include_cancelled` optionally includes revoked licenses; `limit` defaults to 3 with a maximum of 10.

### 2. Pill identification (`identify_unknown_pill`)
Matches space-separated appearance keywords (colour, shape, score line, imprint, size, engraving) by intersection to help identify an unknown tablet. English colour and shape terms are expanded through a built-in synonym table — for example `"white round"` or `"白 圓形"`.

### 3. Drug details (`get_drug_details`)
Returns the normalized drug record for a single license, assembled from normalized JSON stored in PostgreSQL, along with the current availability and document counts for each stage.

### 4. Document asset links (`get_drug_asset_links`)
Returns persisted asset metadata and generates presigned MinIO download links on the fly. The `asset_group` values are `insert` (electronic package insert), `label` (carton label), `shape` (pill image), and `analysis` (analysis output).

## Data pipeline (three stages)
Drug data is built by three import stages, triggered and monitored from the drug page of the admin console (executed in the background by `admin-worker`):

1. **`--drug-index`** — loads the license index from TFDA's standard `36_2.csv`, creating `drug.licenses` and the other base tables.
2. **`--drug-enrich`** — crawls TFDA for electronic inserts, document assets, and pill appearance records, storing the files in MinIO.
3. **`--drug-analysis`** — runs OCR (`DRUG_OCR_*`) and LLM analysis (`DRUG_ANALYSIS_*`) over the insert documents, extracting structured content into `drug.insert_analysis`.

`--drug` is equivalent to running index + enrich in one go.

## Technical architecture
- **Data source**: Taiwan FDA western-medicine licenses (`mcp.fda.gov.tw`), configured via `DRUG_TFDA_BASE_URL`.
- **Database**: the `drug` schema, with tables including `licenses`, `ingredients`, `atc`, `electronic_inserts`, `appearance_records`, `assets`, `insert_analysis`, and `normalized_records`, plus import-state tracking tables (`import_runs`, `import_license_state`, `enrichment_queue`, and so on).
- **Object storage**: insert / label / pill-image files are stored in MinIO, and the tools generate time-limited presigned links at response time.
- **Embedding search**: the drug index supports semantic / hybrid search (requires a working embedding endpoint, configured in Admin → Settings; falls back to keyword search when unset).

## Dependencies
- **FHIR Medication Service**: generates FHIR Medication / MedicationKnowledge resources from this module's drug data.

## Key limitations
- Insert OCR + LLM analysis is machine-generated and must be reviewed by a clinician.
- `--drug-enrich` and `--drug-analysis` require reachable TFDA / OCR / analysis-LLM endpoints.
