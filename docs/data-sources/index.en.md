# Data Sources

Every data import is performed in the **admin console (Admin → Modules)** and executed in the background by `admin-worker` (there is no longer a CLI data loader). The "import stage" column below corresponds to the loader stage names used internally by the worker.

| Dataset | Version / source | How to import (Admin → Modules) | Import stage | Licensing |
|---------|------------------|----------------------------------|--------------|-----------|
| ICD-10-CM / PCS | NLM / CMS 2025 | Upload the zip → import | `--icd` | Public (bring your own zip) |
| LOINC | 2.80 (Regenstrief) | Upload the zip → import | `--loinc` | LOINC license required |
| SNOMED CT | International RF2 | Upload the RF2 zip → import | `--snomed` | SNOMED license required |
| FHIR IG (TWCore and others) | MoHW / packages.fhir.org | Upload `package.tgz`, or fetch from Admin → IG | `--twcore` | Public |
| Drugs (Taiwan FDA / TFDA) | TFDA `36_2.csv` + online crawl | API fetch + crawl and analysis | `--drug-index` → `--drug-enrich` → `--drug-analysis` | Open data |
| Taiwan health supplements | TFDA open data | API fetch | `--health-supplements` | Open data |
| Taiwan food nutrition | TFDA open data | API fetch | `--food-nutrition` | Open data |
| RxNorm (concept reference) | NLM | Upload `RxNorm_full_*.zip` → import (for IG ValueSet expansion) | — | Public |

## Notes

- **Licensed source files** (SNOMED, LOINC, the ICD zips, RxNorm, and so on) must be obtained yourself and uploaded under Admin → Sources / Modules.
- The **drug domain** is a three-stage pipeline (index → online enrichment crawl → OCR/LLM analysis). The crawl and analysis stages require TFDA / OCR / analysis-LLM endpoints to be configured (see `DRUG_*` in `.env`, or manage them in Admin → Settings). See [Drug Service](../modules/drug-service.md).
- **FHIR IG** uses a multi-IG (package-scoped) design; besides the primary IG, dependency packages (such as `hl7.terminology.r4` and `hl7.fhir.r4.core`) can be bound under Admin → Sources. See [FHIR IG Service](../modules/fhir-ig-service.md).
- **RxNorm** is currently loaded as concept-only reference terminology, used for TTY expansion of FHIR IG ValueSets. It does **not** expose a standalone drug interaction tool.
- **Embeddings**: the `*_embeddings` vector tables are backfilled by each module's separate `*_embed` job, runnable or schedulable from the module page. The embedding endpoint lives in `admin.llm_profiles` (configured in Admin → Settings, Ollama by default); when the endpoint is unavailable, search falls back to keyword mode automatically.

Per-source details: [ICD-10](icd10.md), [LOINC](loinc.md).
