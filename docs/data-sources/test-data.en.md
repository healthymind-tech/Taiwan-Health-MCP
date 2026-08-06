# Test Data Files

This document records the source files actually used when **rebuilding the whole system from scratch**: where each file comes from, where it goes, and which module it feeds. The full wipe-and-rebuild on 2026-07-14 (`docker compose down -v` → `up -d --build` → re-import every module) followed exactly this list.

`fhir-code/` is **not in version control at all** (the files are large, some are license-restricted, and all of them can be obtained again). This list is therefore the only record of that folder — when moving to another machine, use it to restore the files. The two LOINC mapping tables the project compiled itself, which cannot be downloaded anywhere, live in `data/loinc/` under version control (see below).

## File list

These live under `fhir-code/` in the repository root. Only the first 16 characters of each `sha256` are listed, enough to confirm you have the same file.

| File | Size | sha256 (first 16) | Module / source_role |
|---|---|---|---|
| `icd/10/icd10cm/icd10cm-table-index-2025.zip` | 20 MB | `7e0fa0cae6348fb6` | icd / `icd10cm` |
| `icd/10/icd10pcs/icd10pcs_tables_2025.zip` | 648 KB | `728d9b8f5c315548` | icd / `icd10pcs` |
| `icd/10/1.2023年中文版ICD-10-CM_PCS_1131118V3(…).xlsx` | 7 MB | `1bf34d1f92930f29` | icd / `icd_zh_tw` |
| `loinc/2.80/Loinc_2.80.zip` | 74 MB | `5a6b10dd6ed29704` | loinc / `loinc` |
| `snomed/SnomedCT_InternationalRF2_PRODUCTION_20250601T120000Z.zip` | 540 MB | `3d6c189288e375d4` | snomed / `snomed_ct` |
| `rxnorm/RxNorm_full_06032024.zip` | 241 MB | `fc612ca0abee8955` | rxnorm / `rxnorm_full` |
| `twcoreig/v1.0.0/package.tgz` | 2.8 MB | `2fa1419fa48d1545` | ig / `ig` |
| (only after download) `36_2.csv` | 44 MB | — | drug / `drug_index_csv` |

`umls/umls-2024AA-metathesaurus-full.zip` (4 GB) is also in the folder, but **no import flow currently uses it** — skip it when rebuilding.

### The two LOINC mapping tables kept in version control

`data/loinc/taiwan_mapping.csv` (loinc / `loinc_taiwan_mapping`) and
`data/loinc/lab_reference_ranges.csv` (loinc / `loinc_reference_ranges`) were compiled by the project itself
(Taiwan lab code mappings and reference values collated from several medical centres) and **cannot be downloaded anywhere**, so they live under `data/` and travel with the repo — not under `fhir-code/` (that entire folder stays out of version control). `loinc_import` needs both roles; remember to upload them alongside the LOINC zip.

## Where each file comes from

**ICD-10-CM / PCS 2025**: the official CMS annual release (<https://www.cms.gov/medicare/coding-billing/icd-10-codes>).
The Chinese-name XLSX comes from the MoHW Chinese edition of the ICD-10-CM/PCS mapping file.

**LOINC 2.80**: the Regenstrief Institute (<https://loinc.org/downloads/>); requires registering an account to download.

**SNOMED CT International RF2**: requires an active license (obtainable through an NLM / UMLS account);
<https://www.nlm.nih.gov/healthit/snomedct/>. Not redistributable.

**RxNorm Full Release**: NLM, requires a UMLS account; <https://www.nlm.nih.gov/research/umls/rxnorm/>.
This project uses it only as concept-only reference terminology (for IG ValueSet expansion), not as a standalone drug tool.

**TW Core IG `package.tgz`**: obtain `tw.gov.mohw.twcore` from <https://packages.fhir.org>.
The import **fetches dependency packages recursively and automatically** (hl7.terminology, hl7.fhir.r4.core, hl7.fhir.r4.examples, and so on), ending with 9 packages and roughly 21,000 artifacts in the database — so this one tgz is all you need to prepare.

**TFDA drug licenses `36_2.csv`**: not in the repo, and there is no need to place it in `fhir-code/` by hand. Download it directly:

```bash
curl -L "https://data.fda.gov.tw/data/opendata/export/36/csv" -o drug36.zip
# This is a zip containing 36_2.csv (roughly 44 MB, 71,921 rows, UTF-8 with BOM)
```

The two other plausible-looking URLs (`cacheData/36_2.csv` and `codedata/datadownload/36`) both return 404.

Health supplements and food nutrition need **no source file**: `health_supplements_sync` / `food_nutrition_sync` call the TFDA Open Data API directly.

## Rebuild procedure

Restore settings (OCR / TFDA / registry addresses, LLM profiles, passkeys) from a Settings export:

```bash
curl -X POST localhost:8080/admin/api/settings/import \
     -H 'Content-Type: application/json' \
     --data-binary @tw-health-settings-YYYY-MM-DD.json
```

> That export contains API keys and passkeys — **keep it out of version control**. Keep your own backup.

Upload source files through Admin → Sources (or the API; note the `Content-Type: application/octet-stream` header, without which express's 4 MB parser intercepts the body):

```bash
curl -X POST "localhost:8080/admin/api/uploads?module_key=icd&source_role=icd10cm&filename=icd10cm-table-index-2025.zip&auto_activate=true" \
     -H 'Content-Type: application/octet-stream' \
     --data-binary @fhir-code/icd/10/icd10cm/icd10cm-table-index-2025.zip
```

Then queue the jobs in order: `icd_import`, `loinc_import`, `snomed_import`, `rxnorm_import`,
`ig_import` (which needs `job_options.object_key`, the MinIO object key of that source file),
`health_supplements_sync`, `food_nutrition_sync`, and `drug_index_import`.

!!! warning "The drug pipeline chains automatically"
    A successful `drug_index_import` auto-chains into `drug_enrichment`, which then chains into `drug_analysis`.
    Enrichment crawls the official TFDA site and analysis calls OCR + an LLM — both cost money and time,
    and there are over twenty thousand licenses pending. Auto-chaining is now capped at 200 per batch
    (`DRUG_AUTOCHAIN_BATCH_LIMIT`) and advances gradually; stop it from the Jobs page if you do not want it to run.
    For a small-scale check, queue a `drug_enrichment` with `{"limit": 30}` yourself.

## The data volumes this list produces

The actual result after the 2026-07-14 wipe-and-rebuild, usable for checking whether an import completed:

| Module | Rows |
|---|---|
| ICD | 46,498 diagnoses + 78,948 procedures |
| LOINC | 104,672 concepts |
| SNOMED CT | 373,972 concepts |
| RxNorm | 222,199 concepts |
| FHIR IG | 9 packages / 20,996 artifacts |
| Drugs | 66,395 licenses |
| Health supplements | 565 |
| Food nutrition | 1,702 |

Semantic search needs the `*_embed` jobs run separately (which need a reachable Ollama). **Without embeddings, Chinese keyword search finds almost nothing** — Postgres's `simple` tokenizer treats a whole Chinese product name as a single token, so substring matching fails. This is not a bug; the design relies on vector search to cover it.
