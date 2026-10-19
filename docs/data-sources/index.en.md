# Data Sources

Every data import is performed in the **admin console** and executed in the background by `admin-worker` (there is no longer a CLI data loader): terminologies under **Terminology → <module>**, FHIR IGs under **FHIR → IG packages**, drugs and TFDA open data under **Data**. Each module page's "Data lifecycle" tab handles source uploads, imports and vector backfills. The "import stage" column below gives the actual `admin.import_jobs.job_type` value — these are the strings a job is created with.

| Dataset | Version / source | How to import | Import stage | Licensing |
|---------|------------------|---------------|--------------|-----------|
| ICD-10-CM | CMS 2026-04-01 ("Code Descriptions in Tabular Order", complete code set incl. 7th characters) | Upload the zip → import | `icd_import` | Public (bring your own zip) |
| ICD-10-PCS | CMS 2025 | Upload the zip → import (same job as CM) | `icd_import` | Public |
| WHO ICD-10 (optional) | tx.fhir.org `2019-covid-expanded` (FHIR JSON) | Upload the JSON → import (same job as CM) | `icd_import` | WHO |
| LOINC | 2.80 (Regenstrief) | Upload the zip → import | `loinc_import` | LOINC license required |
| SNOMED CT | International RF2 (currently 20250601) | Upload the RF2 zip → import | `snomed_import` | SNOMED license required |
| RxNorm (concept reference) | NLM | Upload `RxNorm_full_*.zip` → import (for IG ValueSet expansion) | `rxnorm_import` | UMLS account required |
| FHIR IG (TWCore and others) | MoHW / packages.fhir.org | Install from the registry or upload `package.tgz`; dependency IGs download automatically | `ig_import` | Public |
| Drugs (Taiwan FDA / TFDA) | TFDA `36_2.csv` + online crawl | Upload the CSV + crawl and analysis | `drug_index_import` → `drug_enrichment` → `drug_analysis` | Open data |
| Taiwan health supplements | TFDA open data | API fetch | `health_supplements_sync` | Open data |
| Taiwan food nutrition | TFDA open data | API fetch | `food_nutrition_sync` | Open data |

CVX (287 codes), ISO 3166 and UCUM need no import: they ship with the code as built-in tables / a library and are used only by the FHIR validator.

## Notes

- **Licensed source files** (SNOMED, LOINC, the ICD zips, RxNorm, and so on) must be obtained yourself and uploaded on the corresponding module page. The files actually used are listed in [Test data files](test-data.md).
- The **drug domain** is a three-stage pipeline (index → online enrichment crawl → OCR/LLM analysis). The TFDA address is set under **Integrations → External services** (the `DRUG_*` keys in `.env` only seed it on first boot); OCR (MinerU or Indra) under **Integrations → External services → OCR Server**; the analysis LM under **Integrations → Model endpoints**. See [Drug Service](../modules/drug-service.md).
- **FHIR IG** uses a multi-IG (package-scoped) design; declared dependency packages (such as `hl7.terminology.r4` and `hl7.fhir.r4.core`) are downloaded automatically from the FHIR registry — upload one by hand only when the registry cannot supply it. See [FHIR IG Service](../modules/fhir-ig-service.md).
- **RxNorm** is currently loaded as concept-only reference terminology, used for TTY expansion of FHIR IG ValueSets and for the FHIR validator's RxNorm code / display checks (the import keeps every SAB=RXNORM name of each RXCUI and the release, see migration `20261030_rxnorm_display_names`). It does **not** expose a standalone drug tool.
- **Embeddings**: the `*_embeddings` vector tables are backfilled by each module's separate `*_embed` job (`icd_embed`, `loinc_embed`, `snomed_embed`, `health_supplements_embed`, `food_nutrition_embed`), runnable or schedulable from the module page. The embedding endpoint is configured under **Integrations → Model endpoints** (provider accounts + an embedding route, stored in `admin.llm_providers` / `admin.llm_routes` and related tables, never read from env); when the endpoint is unavailable, search falls back to keyword mode automatically.

Per-source details: [ICD-10](icd10.md), [LOINC](loinc.md).
