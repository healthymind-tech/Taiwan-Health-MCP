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

1. **`drug_index_import`** — loads the license index from TFDA's standard `36_2.csv`, creating `drug.licenses` and the other base tables.
2. **`drug_enrichment`** — crawls TFDA for electronic inserts, document assets, and pill appearance records, storing the files in MinIO.
3. **`drug_analysis`** — runs OCR (MinerU or Indra, see [OCR providers](#ocr-providers) below) and the analysis LM over the insert documents, extracting structured content into `drug.insert_analysis`. OCR is configured in the admin console under **Integrations → External services → OCR Server** (stored in the `ocr` group of `admin.app_settings`); the analysis LM under **Integrations → Model endpoints** (provider accounts + routes: `admin.llm_providers` / `admin.llm_routes` / `admin.llm_route_members` / `admin.llm_role_routes`). Neither is **ever read from environment variables**.

A `drug_pipeline` job type also exists: one job that runs all three stages per license. The three stages auto-chain as well: each auto-chained job is capped at `DRUG_AUTOCHAIN_BATCH_LIMIT` (200 by default); **a manually queued `drug_enrichment` with no `limit` is not capped** and will crawl the entire backlog.

## OCR providers { #ocr-providers }

`drug_analysis` sends each insert PDF to OCR for Markdown and hands that to the analysis LLM; the LLM stage does not depend on which OCR provider ran.
Choose under External services → OCR:

| Provider | Runs where | Notes |
|----------|------------|-------|
| `mineru` (default) | External HTTP service (`POST {base_url}/file_parse`), usually on a GPU box | Most robust on complex tables and layouts. Settings: base URL, backend, effort, parse method, language, timeout. |
| `indra` | The bundled `ocr-indra` compose container (`POST http://ocr-indra:8000/ocr`), CPU only | [Indra OCR](https://github.com/datalab-to/indra) (`indra-ocr` 0.3.2, ONNX Runtime, ~18 MB of models baked into the image — no internet needed at runtime). Reads a digital PDF's text layer directly and OCRs only scanned pages. Settings: Indra base URL, timeout, DPI (72–400), mode (`auto` / `ocr` / `text`). |

- **Fallback provider** (`fallback_provider`: `none` / `mineru` / `indra`): tried once when the primary is unreachable, returns an HTTP error, times out or produces empty output;
  not tried when the file itself is unreadable (encrypted, corrupt, not a PDF). `drug.insert_analysis.ocr_provider` records the provider that actually produced the Markdown.
- **Service health**: with a fallback configured both are probed; one side down is `degraded` (does not block jobs), only both down is `error`.
- **Test connection**: for Indra it also OCRs the built-in sample PDF, proving Markdown really comes back.
- **Indra limitations**: occasional misreads of rare Traditional Chinese characters on scanned pages; merged cells and ruling-less key/value tables can land in the wrong columns.
- **Indra model licence**: the code is Apache-2.0, the weights are under a **modified OpenRAIL-M** licence — not usable by an entity with more than
  US$20M gross revenue in the prior year or more than US$20M total funding (except personal / research use), or one offering a product that competes with
  Datalab; the restrictions extend to the OCR output. Read the licence section of `services/ocr-indra/README.md` before enabling it.

## Technical architecture
- **Data source**: Taiwan FDA western-medicine licenses (`mcp.fda.gov.tw`), configured via `DRUG_TFDA_BASE_URL`.
- **Database**: the `drug` schema, with tables including `licenses`, `ingredients`, `atc`, `electronic_inserts`, `appearance_records`, `assets`, `asset_variants`, `insert_analysis`, and `normalized_records`, plus import-state tracking tables (`import_runs`, `import_license_state`, `enrichment_queue`, and so on).
- **Object storage**: insert / label / pill-image files are stored in MinIO, and the tools generate time-limited presigned links at response time.
- **Search**: drug search is keyword matching (`ILIKE` substring + `simple` full-text search); there is **no** vector / semantic search and no `drug_embed` job.
- **Admin UI**: the admin console's **Data → Drugs** page shows the pipeline overview, takes `36_2.csv` uploads, and schedules and runs jobs; the **drug explorer** (`/admin/drug/explorer`) shows a single license's inserts, appearance, files, history and LLM calls.

## Dependencies
- **FHIR Medication Service**: generates FHIR Medication / MedicationKnowledge resources from this module's drug data.

## Key limitations
- Insert OCR + LLM analysis is machine-generated and must be reviewed by a clinician.
- `drug_enrichment` and `drug_analysis` require reachable TFDA / OCR (MinerU or ocr-indra) / analysis-LM endpoints.
