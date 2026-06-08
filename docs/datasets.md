# Taiwan Health MCP — Module Reference

This document describes every module in the system: what the user must supply,
the structure of the input data, the full processing pipeline, the final
PostgreSQL schema, and which AI capabilities (embedding / OCR / LLM) are required.

**Audience**: developers building on or extending this codebase.  
**Authoritative code**: `loader/`, `src/`, `db/schema.sql`.

---

## Quick-reference table

| Module | Source type | User provides | Embedding | OCR | LLM |
|---|---|---|---|---|---|
| ICD-10-CM/PCS | File (ZIP) | ZIP from CMS + optional XLSX | ✅ diagnoses only | — | — |
| LOINC | File (ZIP) | ZIP from Regenstrief | ✅ | — | — |
| SNOMED CT | File (ZIP) | RF2 ZIP from SNOMED International | ✅ | — | — |
| RxNorm | File (ZIP) | RxNorm full ZIP from NLM | — | — | — |
| TWCore IG | File (tgz) | package.tgz from MOHW / live fetch | — | — | — |
| Clinical Guidelines | Seed data | Nothing — bundled in repo | ✅ | — | ⚠️ future |
| Taiwan FDA Drug | CSV upload + crawl | One or more `36_2.csv` from FDA Open Data | ⚠️ future | ✅ | ✅ |
| Taiwan FDA Health Supplements | API auto-sync | Nothing — auto from FDA API | ✅ | — | — |
| Taiwan FDA Food Nutrition | API auto-sync | Nothing — auto from FDA API | ✅ | — | — |
| UMLS | File (ZIP) | UMLS Metathesaurus ZIP from NLM | ⚠️ future | — | — |

---

## fhir-code/ directory layout

All source files live in `fhir-code/` (mounted read-only at `/app/fhir-code/` in the `data-loader` container).

```
fhir-code/
├── icd/10/
│   ├── icd10cm/
│   │   └── icd10cm-table-index-2025.zip                          19.1 MB  ← ICD-10-CM 2025
│   ├── icd10pcs/
│   │   └── icd10pcs_tables_2025.zip                               0.6 MB  ← ICD-10-PCS 2025
│   └── 1.2023年中文版ICD-10-CM_PCS_1131118V3(...).xlsx            (opt.)  ← Chinese names
├── loinc/
│   ├── 2.80/
│   │   └── Loinc_2.80.zip                                        73.9 MB  ← LOINC 2.80
│   ├── taiwan_mapping.csv                                          (opt.)  ← TW Chinese name/unit overrides
│   └── lab_reference_ranges.csv                                   (opt.)  ← TW reference ranges
├── snomed/
│   └── SnomedCT_InternationalRF2_PRODUCTION_20250601T120000Z.zip 539.1 MB ← SNOMED CT Jun 2025
├── rxnorm/
│   └── RxNorm_full_06032024.zip                                  240.3 MB ← RxNorm Jun 2024
├── twcoreig/
│   └── v1.0.0/
│       └── package.tgz                                             2.7 MB  ← TWCore IG v1.0.0
└── umls/
    └── umls-2024AA-metathesaurus-full.zip                       4,079.5 MB ← UMLS 2024AA (loader TBD)
```

Files excluded from git (require licensed download): `snomed/`, `rxnorm/`, `umls/`.

---

## 1. ICD-10-CM/PCS

### Source type
Static loader — user provides files once; reimport only on new annual releases.

### What the user must supply

| File (relative to `fhir-code/`) | Size | Where to obtain | Notes |
|---|---|---|---|
| `icd/10/icd10cm/icd10cm-table-index-2025.zip` | 19.1 MB | https://www.cms.gov/medicare/coding-billing/icd-10-codes | Contains `icd10cm_tabular_2025.xml` |
| `icd/10/icd10pcs/icd10pcs_tables_2025.zip` | 648 KB | https://www.cms.gov/medicare/coding-billing/icd-10-codes (or bundled in repo) | Contains `icd10pcs_tables_2025.xml` |
| `icd/10/1.2023年中文版ICD-10-CM_PCS_1131118V3(...).xlsx` | — | 衛福部/台灣健保署 | Optional. If absent, `name_zh` is empty; codes still load |

File placement: `fhir-code/` is mounted read-only at `/app/fhir-code/` inside the `data-loader` container.

### Input data structure

**icd10cm_tabular_2025.xml** (XML tree):
```
<ICD10CM.tabular>
  <chapter>
    <section id="...">
      <desc>...</desc>
      <diag>
        <name>A00.0</name>         ← code
        <desc>Cholera due to Vibrio cholerae 01, biovar cholerae</desc>
        <diag>...</diag>           ← child codes (billable)
      </diag>
    </section>
  </chapter>
</ICD10CM.tabular>
```

**icd10pcs_tables_2025.xml** — PCS table XML (different structure, code built by concatenating axis values).

**XLSX** (optional): two columns: ICD code, Chinese name.

### Processing pipeline

```
[ZIP] → unzip in memory → parse XML → build (code, name_en, category) tuples
      → optional XLSX merge → TRUNCATE+INSERT into staging table
      → promote to icd.diagnoses / icd.procedures
      → update admin.module_load_log
```

Admin job type: `icd_import`  
Stages: validate → stage → promote

### Final DB schema

```sql
-- icd schema
icd.diagnoses   (code TEXT PK, name_en TEXT, name_zh TEXT, category TEXT)
icd.procedures  (code TEXT PK, name_en TEXT, name_zh TEXT)

-- embedding (diagnoses only)
icd.diagnosis_embeddings  (code TEXT PK, embedding halfvec(1024), embedded_at TIMESTAMPTZ)
```

### AI requirements

| Capability | Used for | Input text |
|---|---|---|
| Embedding (Ollama) | Semantic search over ICD codes | `code || ' ' || name_zh || ' ' || name_en` |

---

## 2. LOINC

### Source type
Static loader — update annually when Regenstrief releases a new version.

### What the user must supply

| File (relative to `fhir-code/`) | Size | Where to obtain | Notes |
|---|---|---|---|
| `loinc/2.80/Loinc_2.80.zip` | 73.9 MB | https://loinc.org/downloads/ (free account) | Main LOINC table (~100k rows) |
| `loinc/taiwan_mapping.csv` | — | Bundled in repo | Taiwan Chinese name + specimen + unit overrides. Columns: `loinc_code, name_zh, common_name_zh, specimen_type, unit` |
| `loinc/lab_reference_ranges.csv` | — | Bundled in repo | Taiwan hospital reference ranges. Columns: `loinc_code, test_name_zh, test_name_en, age_min, age_max, gender, range_low, range_high, unit, interpretation, source` |

### Input data structure

**Loinc.csv** (inside ZIP) — ~87k rows, tab/comma-separated:

| Column | Description |
|---|---|
| `LOINC_NUM` | Primary key (e.g. `2951-2`) |
| `COMPONENT` | Measured entity (e.g. `Sodium`) |
| `PROPERTY` | Property type (`SCnc`, `MCnc`, …) |
| `TIME_ASPCT` | Time aspect (`Pt`, `24H`, …) |
| `SYSTEM` | System measured in (`Ser/Plas`, …) |
| `SCALE_TYP` | Scale (`Qn`, `Ord`, `Nom`, …) |
| `METHOD_TYP` | Method (optional) |
| `LONG_COMMON_NAME` | Full human-readable name |
| `SHORTNAME` | Short display name |
| `CLASS` | Grouping class |
| `CLASSTYPE` | 1=Lab, 2=Clinical, 3=Claims attachment, 4=Survey |
| `STATUS` | `ACTIVE`, `DISCOURAGED`, `DEPRECATED`, `TRIAL` |
| `CONSUMER_NAME` | Patient-facing name |

**Taiwan additions** (loaded separately or hard-coded):
- `name_zh` — Chinese name
- `common_name_zh` — Chinese common name
- `specimen_type` — specimen type in Chinese
- `unit` — default unit

### Processing pipeline

```
[ZIP] → unzip in memory → parse Loinc.csv → stage rows
      → promote to loinc.concepts
      → load reference_ranges (from LoincTable/LoincTableCore/...)
      → update admin.module_load_log
```

Admin job type: `loinc_import`  
Stages: validate → stage → promote

### Final DB schema

```sql
loinc.concepts (
  loinc_num TEXT PK, component TEXT, property TEXT, time_aspect TEXT,
  system TEXT, scale_type TEXT, method_type TEXT,
  long_common_name TEXT, shortname TEXT, class TEXT, classtype SMALLINT,
  status TEXT, consumer_name TEXT,
  name_zh TEXT, common_name_zh TEXT, specimen_type TEXT, unit TEXT
)

loinc.reference_ranges (
  id SERIAL PK, loinc_num TEXT FK→loinc.concepts,
  age_min INT, age_max INT, gender TEXT,
  range_low NUMERIC, range_high NUMERIC, unit TEXT, interpretation TEXT
)

loinc.concept_embeddings (loinc_num TEXT PK, embedding halfvec(1024), embedded_at TIMESTAMPTZ)
```

### AI requirements

| Capability | Used for | Input text |
|---|---|---|
| Embedding (Ollama) | Semantic search over lab tests | `long_common_name || ' ' || shortname || ' ' || name_zh || ' ' || common_name_zh || ' ' || component || ' ' || specimen_type` |

---

## 3. SNOMED CT

### Source type
Static loader — update when SNOMED International releases a new production RF2.

### What the user must supply

| File (relative to `fhir-code/`) | Size | Where to obtain | Notes |
|---|---|---|---|
| `snomed/SnomedCT_InternationalRF2_PRODUCTION_20250601T120000Z.zip` | 539.1 MB | https://mlds.ihtsdotools.org/ (SNOMED license — free for most uses) | Filename pattern: `SnomedCT_InternationalRF2_PRODUCTION_*.zip` |

### Input data structure

**SNOMED CT RF2 format** (inside ZIP) — tab-separated files:

| File pattern | Content |
|---|---|
| `Snapshot/Terminology/sct2_Concept_Snapshot_*.txt` | concept_id, effectiveTime, active, moduleId, definitionStatusId |
| `Snapshot/Terminology/sct2_Description_Snapshot-en_*.txt` | description_id, conceptId, typeId, term, active, languageCode |
| `Snapshot/Terminology/sct2_Relationship_Snapshot_*.txt` | relationship_id, sourceId, destinationId, typeId, active, characteristicTypeId |
| `Snapshot/Refset/Map/der2_iIISSSCCRefset_ExtendedMap_*.txt` | Extended map to ICD-10 codes |

Key `typeId` values: `900000000000003001` = FSN (Fully Specified Name), `900000000000013009` = Synonym.

### Processing pipeline

```
[ZIP] → unzip → parse RF2 TSV files → stage (concepts, descriptions, relationships, icd10_map)
      → promote to snomed.* tables
      → update admin.module_load_log
```

Admin job type: `snomed_import`  
Stages: validate → stage_concepts → stage_descriptions → stage_relationships → stage_map → promote

### Final DB schema

```sql
snomed.concepts      (concept_id BIGINT PK, effective_time DATE, active BOOL, module_id BIGINT, definition_status_id BIGINT)
snomed.descriptions  (description_id BIGINT PK, concept_id BIGINT FK, type_id BIGINT, term TEXT, active BOOL, language_code TEXT)
snomed.relationships (relationship_id BIGINT PK, source_id BIGINT FK, destination_id BIGINT FK, type_id BIGINT, active BOOL, characteristic_type_id BIGINT)
snomed.icd10_map     (id SERIAL PK, referenced_component_id BIGINT FK, map_target TEXT, map_rule TEXT, map_advice TEXT, map_priority SMALLINT, map_group SMALLINT, active BOOL)

snomed.concept_embeddings (concept_id BIGINT PK, embedding halfvec(1024), embedded_at TIMESTAMPTZ)
```

### AI requirements

| Capability | Used for | Input text | Scale |
|---|---|---|---|
| Embedding (Ollama) | Semantic search over clinical concepts | One FSN term per active concept | ~360k concepts — expect 1–2+ hours |

---

## 4. RxNorm

### Source type
Static loader — update when NLM publishes a new monthly full release.

### What the user must supply

| File (relative to `fhir-code/`) | Size | Where to obtain | Notes |
|---|---|---|---|
| `rxnorm/RxNorm_full_06032024.zip` | 240.3 MB | https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html (free UMLS account) | Filename pattern: `RxNorm_full_MMDDYYYY.zip` |

### Input data structure

**RxNorm RRF (Rich Release Format)** files (inside ZIP):

| File | Content |
|---|---|
| `rrf/RXNCONSO.RRF` | Concept names: RXCUI, LAT, STR, TTY (term type), SAB (source) |
| `rrf/RXNREL.RRF` | Relationships: RXCUI1, RELA, RXCUI2 — `interacts_with` edges used for interaction checks |
| `rrf/RXNSAT.RRF` | Attributes: RXCUI, ATN, ATV — used for ingredient info |

### Processing pipeline

```
[ZIP] → unzip → parse RXNCONSO.RRF + RXNREL.RRF → load drug.rx_concepts and drug.rx_interactions
```

**Important**: Run `--rxnorm` before `--drug` / `--fda`. The drug index loader bridges `license_id` → `RxCUI` via ingredient name matching to populate `drug.rx_norms` and `drug.rx_interactions`.

### Final DB schema

> Note: RxNorm tables are prefixed `rx_*` within the `drug` schema.

```sql
drug.rx_concepts     (rxcui TEXT PK, name TEXT, tty TEXT, sources TEXT[])
drug.rx_interactions (rxcui1 TEXT, rxcui2 TEXT, relationship TEXT, source TEXT,
                      PRIMARY KEY (rxcui1, rxcui2, relationship))
drug.rx_norms        (license_id TEXT FK→drug.licenses, rxcui TEXT FK→drug.rx_concepts,
                      match_method TEXT, match_score NUMERIC)
```

### AI requirements

None. RxNorm lookup is exact string/code matching; no embedding or LLM.

---

## 5. TWCore IG

### Source type
Static loader + live fetch fallback. Run `--twcore` to load from file; the service also fetches live from the MOHW FHIR server on cache miss.

### What the user must supply

| File (relative to `fhir-code/`) | Size | Where to obtain | Notes |
|---|---|---|---|
| `twcoreig/v1.0.0/package.tgz` | 2.7 MB | 衛福部 FHIR IG publish site | Version subfolder matters; loader resolves the tgz via glob pattern |

### Input data structure

**FHIR NPM package** (tgz) — contains JSON files in `package/`:
- `CodeSystem-*.json` — FHIR CodeSystem resources
- Each has: `id`, `name`, `title`, `description`, `concept[]` (with `code`, `display`, `definition`)

### Processing pipeline

```
[tgz] → extract → parse CodeSystem JSON files → stage (codesystems, concepts)
      → promote to twcore.* tables
```

Admin job type: `twcore_import`

### Final DB schema

```sql
twcore.codesystems (cs_id TEXT PK, name TEXT, category TEXT, fetched_at TIMESTAMPTZ, concept_count INT)
twcore.concepts    (id SERIAL PK, cs_id TEXT FK, code TEXT, display TEXT, definition TEXT)
```

### AI requirements

None. Used for FHIR code validation; no embedding needed.

---

## 6. Clinical Guidelines

### Source type
Seed data — hard-coded in `loader/loaders/guideline_seed.py`. No user file needed.

### What the user must supply

Nothing. The seed data is bundled. To add new guidelines, edit `guideline_seed.py` directly.

> **Planned future extension**: accept user-uploaded PDF or structured JSON files representing clinical guidelines, trigger LLM summarization to populate `guideline_summary`.

### Input data structure (seed format)

Each guideline is a Python dict in the seed file:
```python
{
  "icd_code": "E11",
  "disease_name_zh": "第二型糖尿病",
  "disease_name_en": "Type 2 Diabetes Mellitus",
  "guideline_title": "台灣糖尿病診治指引 2023",
  "guideline_source": "中華民國糖尿病學會",
  "publication_year": 2023,
  "guideline_summary": "...",
  "diagnostic_recommendations": [
    {"step_order": 1, "recommendation_type": "lab", "description": "...", "evidence_level": "A"}
  ],
  "medication_recommendations": [...],
  "test_recommendations": [...],
  "treatment_goals": [...]
}
```

### Processing pipeline

```
[seed dict in code] → insert/upsert into guideline.* tables
                    → update admin.module_load_log
```

Admin job type: `guideline_seed`

### Final DB schema

```sql
guideline.disease_guidelines (
  id SERIAL PK, icd_code TEXT, disease_name_zh TEXT, disease_name_en TEXT,
  guideline_title TEXT, guideline_source TEXT, publication_year INT, guideline_summary TEXT
)
guideline.diagnostic_recommendations  (id SERIAL PK, guideline_id INT FK, step_order INT, recommendation_type TEXT, description TEXT, evidence_level TEXT)
guideline.medication_recommendations  (id SERIAL PK, guideline_id INT FK, line_of_therapy TEXT, medication_class TEXT, medication_examples TEXT, dosage_guidance TEXT, contraindications TEXT, evidence_level TEXT)
guideline.test_recommendations        (id SERIAL PK, guideline_id INT FK, test_category TEXT, test_name TEXT, loinc_code TEXT, frequency TEXT, indication TEXT, evidence_level TEXT)
guideline.treatment_goals             (id SERIAL PK, guideline_id INT FK, goal_type TEXT, target_parameter TEXT, target_value TEXT, timeframe TEXT)

guideline.guideline_embeddings (id INT PK, embedding halfvec(1024), embedded_at TIMESTAMPTZ)
```

### AI requirements

| Capability | Used for | Input text |
|---|---|---|
| Embedding (Ollama) | Semantic search for guideline lookup | `disease_name_zh || ' ' || disease_name_en || ' ' || guideline_title || ' ' || guideline_summary` |
| LLM (future) | Auto-summarize PDF guidelines into `guideline_summary` | Full guideline PDF text |

---

## 7. Taiwan FDA Drug

This is the most complex module. It operates in three distinct phases and the
data quality depends on which sources are available for each license.

### Source type
Three-phase pipeline:
1. **Phase 1 — Index Import**: user uploads CSV(s) via Admin UI
2. **Phase 2 — Enrichment**: system crawls TFDA website per license
3. **Phase 3 — Analysis**: OCR + LLM structured extraction from insert PDFs

### What the user must supply

| Source | Where to obtain | Notes |
|---|---|---|
| `36_2.csv` (drug index) | https://data.fda.gov.tw — search "藥品許可證" open data | Multiple active CSVs are merged at import time |

The CSV is UTF-8-BOM encoded. Multiple files can be activated simultaneously; the loader concatenates them (stripping duplicate headers) before import.

### Phase 1 — Index CSV structure

CSV columns (all text):

| Column | DB field | Description |
|---|---|---|
| `許可證字號` | `license_id` (PK) | e.g. `衛署藥製字第000001號` |
| `中文品名` | `chinese_name` | Drug Chinese name |
| `英文品名` | `english_name` | Drug English name |
| `藥品類別` | `drug_category` | e.g. `西藥`, `中藥` |
| `劑型` | `dosage_form` | e.g. `錠劑`, `膠囊劑` |
| `適應症` | `indications_text` | Plain-text indications |
| `主成分略述` | `main_ingredient_summary` | Semicolon-separated active ingredients |
| `用法用量` | `usage_text_from_index` | Dosage instructions (brief) |
| `包裝` | `package` | Pack size description |
| `申請商名稱` | `applicant_name` | Marketing authorization holder |
| `申請商地址` | `applicant_address` | |
| `申請商統一編號` | `applicant_tax_id` | ROC business ID |
| `製造商名稱` | `manufacturer_name` | |
| `製造廠廠址` | `manufacturer_factory_address` | |
| `製造廠公司地址` | `manufacturer_company_address` | |
| `製造廠國別` | `manufacturer_country` | |
| `製程` | `manufacturing_process` | |
| `許可證種類` | `license_type` | |
| `管制藥品分類級別` | `controlled_drug_level` | Narcotic/controlled classification |
| `舊證字號` | `old_license_no` | Previous license number if re-issued |
| `通關簽審文件編號` | `customs_clearance_no` | |
| `包裝與國際條碼` | `barcode_text` | |
| `有效日期` | `valid_until` | YYYY/MM/DD |
| `發證日期` | `issue_date` | YYYY/MM/DD |
| `異動日期` | `last_changed_date` | YYYY/MM/DD |
| `註銷狀態` | `cancellation_status` | Non-empty → cancelled license |
| `註銷日期` | `cancellation_date` | YYYY/MM/DD |
| `註銷理由` | `cancellation_reason` | |

**Active license**: `cancellation_status` is empty AND `cancellation_date` is empty.

### Phase 2 — TFDA enrichment (crawler)

The enrichment worker visits `https://www.fda.gov.tw/...` for each queued `license_id` and scrapes:

| Data scraped | Stored in | Description |
|---|---|---|
| Electronic insert page | `drug.electronic_inserts` | Basic info, sections (適應症, 用法用量, etc.), ingredient list, ATC codes, PDF links |
| Insert PDFs | `drug.assets` (asset_group=`insert`) + MinIO | `insert_pdf` type; latest version flagged `is_latest_for_analysis=TRUE` |
| Label PDFs | `drug.assets` (asset_group=`label`) + MinIO | Alternative label documents |
| Appearance records | `drug.appearance_records` + `drug.assets` (asset_group=`shape`) | Tablet shape, color, imprint; shape images in MinIO |

### Phase 2 — Electronic insert structure

`drug.electronic_inserts.sections_json` contains the structured sections from the TFDA drug page:

```json
{
  "適應症": "text...",
  "用法用量": "text...",
  "警語及副作用": "text...",
  "禁忌": "text...",
  "注意事項": "text...",
  "成分": "text...",
  "儲存方法": "text...",
  "有效期間": "text..."
}
```

### Phase 3 — OCR + LLM analysis

Triggered for each license that has at least one `insert_pdf` in MinIO with `storage_status='success'`.

**OCR provider**: `dots_ocr` (DotsOCR library, wraps a vLLM server running Qwen2.5-VL-7B-Instruct)
- `DRUG_OCR_PROVIDER` = `dots_ocr`
- `DRUG_OCR_VLLM_SERVER_IP` + `DRUG_OCR_VLLM_PORT` (default `127.0.0.1:8002`)
- `DRUG_OCR_MODEL_NAME` = `Qwen/Qwen2.5-VL-7B-Instruct`
- Output: Markdown text saved to MinIO as `*.ocr.md`

**LLM analysis provider**: `openai` | `vllm` | `ollama`
- `DRUG_ANALYSIS_PROVIDER` (default `openai`)
- `DRUG_ANALYSIS_BASE_URL` (default `http://127.0.0.1:8001/v1`)
- `DRUG_ANALYSIS_MODEL_NAME` (default `qwen2.5:7b`)
- `DRUG_ANALYSIS_API_KEY`
- Input: OCR markdown + system prompt
- Output: structured JSON saved to MinIO as `*.analysis.json`

**Analysis output schema** (LLM must match exactly):
```json
{
  "藥品特性": "string",
  "有效成分及含量": [{"成分": "string", "含量": "string"}],
  "其他成分": [{"成分": "string", "含量": "string"}],
  "用途(適應症)": ["string"],
  "使用上注意事項": {
    "有下列情形者，請勿使用": ["string"],
    "有下列情形者，使用前請洽醫師診治": ["string"],
    "有下列情形者，使用前請先諮詢醫師藥師藥劑生": ["string"],
    "其他使用上注意事項": ["string"]
  },
  "用法用量": ["string"],
  "警語": {
    "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生": ["string"],
    "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治": ["string"]
  },
  "儲存方式": ["string"]
}
```

### Data quality levels — all combinations

Each license ends up with one of these quality states in `drug.normalized_records.quality_confidence`:

| Situation | Available data | `quality_confidence` | `primary_insert_source` | Clinical usability |
|---|---|---|---|---|
| **A — Index only** | CSV row only. No EI, no PDF. | `index_only` | `index` | Minimal: name, category, brief ingredient summary, rough indications |
| **B — Index + EI partial** | EI scraped but `sections` dict is empty (TFDA page rendered no structured sections). | `ei_partial` | `electronic_insert` | Slightly better: manufacturer details, ATC codes, ingredient list from EI |
| **C — Index + EI complete** | EI scraped with non-empty `sections` dict. No PDF. | `ei_complete` | `electronic_insert` | Good: full structured indications, dosage, warnings from TFDA website |
| **D — Index + EI complete + PDF** | Both EI and insert PDF stored in MinIO. OCR+LLM pending. | `ei_complete` → (after analysis) `pdf_ocr` | `electronic_insert` → `pdf_insert` | Best: PDF analysis supersedes EI for ingredient precision and warning details |
| **E — Index + PDF only** | Insert PDF stored but EI unavailable/failed. OCR+LLM pending. | `index_only` → (after analysis) `pdf_ocr` | `index` → `pdf_insert` | Good after analysis: PDF is the authoritative source |
| **F — PDF storage failed** | EI scraped, PDF downloaded but MinIO write failed. | Same as C but `ocr_status='retryable_failed'` | `electronic_insert` | Retry storage → proceed to analysis |
| **G — PDF OCR done** | PDF OCR markdown + LLM analysis JSON in MinIO. Normalized record refreshed. | `pdf_ocr` | `pdf_insert` | Best achievable: fully structured insert |

**Pipeline state machine per license** (`drug.import_license_state`):

```
index_status:             pending → success
electronic_insert_status: pending → success | no_data | retryable_failed | partial_success
insert_pdf_status:        pending → success | no_data | retryable_failed | partial_success
label_pdf_status:         pending → success | no_data | retryable_failed | partial_success
shape_status:             pending → success | no_data | retryable_failed | partial_success
storage_status:           pending → success | no_data | retryable_failed | partial_success
ocr_status:               pending → success | no_data | retryable_failed
analysis_status:          pending → success | no_data | retryable_failed
normalize_status:         pending → success | retryable_failed
```

### Final DB schema (drug domain)

```sql
-- Phase 1: index data
drug.licenses (
  license_id TEXT PK, snapshot_id UUID, row_hash TEXT, license_token TEXT,
  is_active BOOL,           -- FALSE if cancellation_status or cancellation_date is set
  is_listed BOOL,           -- FALSE if not present in the most recent combined CSV
  cancellation_status TEXT, cancellation_date DATE, cancellation_reason TEXT,
  valid_until DATE, issue_date DATE, last_changed_date DATE,
  license_type TEXT, old_license_no TEXT, customs_clearance_no TEXT,
  chinese_name TEXT, english_name TEXT, drug_category TEXT,
  controlled_drug_level TEXT, dosage_form TEXT, package TEXT,
  indications_text TEXT, main_ingredient_summary TEXT,
  applicant_name TEXT, applicant_address TEXT, applicant_tax_id TEXT,
  manufacturer_name TEXT, manufacturer_factory_address TEXT,
  manufacturer_company_address TEXT, manufacturer_country TEXT,
  manufacturing_process TEXT, usage_text_from_index TEXT, barcode_text TEXT,
  raw_index_json JSONB,     -- original CSV row preserved verbatim
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)

drug.ingredients (
  ingredient_id BIGSERIAL PK, license_id TEXT FK, name TEXT, amount TEXT, unit TEXT,
  raw_text TEXT, source TEXT,   -- 'index_summary' | 'normalized_record' | 'electronic_insert'
  sort_order INT, raw_json JSONB
)

drug.atc (atc_id BIGSERIAL PK, license_id TEXT FK, code TEXT, name TEXT, source TEXT, raw_json JSONB)

-- Phase 2: enrichment data
drug.electronic_inserts (
  license_id TEXT PK FK,
  source_url TEXT,
  basic_info_json JSONB,         -- {許可證字號, 中文品名, 英文品名, 劑型, ...}
  manufacturers_json JSONB,      -- [{name, address, country}]
  sections_json JSONB,           -- {適應症, 用法用量, 警語及副作用, ...}
  ingredients_json JSONB,        -- {active: [...], inactive: [...]}
  atc_codes_json JSONB,          -- [{ATC Code, ATC名稱, 中文分類名稱}]
  label_pdfs_json JSONB,         -- [{url, filename, upload_date}]
  history_pdfs_json JSONB,
  public_pdfs_json JSONB,
  paper_pdfs_json JSONB,
  authorizations_json JSONB,
  raw_page_hash TEXT,
  scraped_at TIMESTAMPTZ, parse_status TEXT, last_error_message TEXT
)

drug.appearance_records (
  appearance_id UUID PK, license_id TEXT FK, shape_id TEXT,
  appearance_no TEXT, detail_url TEXT,
  description TEXT, color TEXT, shape TEXT, scoring TEXT, symbol TEXT,
  size TEXT, imprint TEXT,
  raw_json JSONB, scraped_at TIMESTAMPTZ
)

drug.assets (
  asset_id UUID PK, license_id TEXT FK, appearance_id UUID FK,
  asset_type TEXT,            -- 'insert_pdf' | 'label_pdf' | 'shape_image' | 'ocr_markdown' | 'analysis_json'
  asset_group TEXT,           -- 'insert' | 'label' | 'shape' | 'analysis'
  source_page TEXT, source_url TEXT,
  source_filename TEXT, normalized_filename TEXT,
  upload_date DATE, mime_type TEXT, size_bytes BIGINT, sha256 TEXT,
  bucket TEXT, object_key TEXT, minio_uri TEXT,     -- MinIO locator
  etag TEXT, version_id TEXT,
  download_status TEXT, storage_status TEXT,
  is_latest_for_analysis BOOL,   -- TRUE for the newest insert_pdf per license
  retry_count INT, last_error_code TEXT, last_error_message TEXT,
  last_attempt_at TIMESTAMPTZ, downloaded_at TIMESTAMPTZ, stored_at TIMESTAMPTZ
)

-- Phase 3: analysis data
drug.insert_analysis (
  analysis_id UUID PK,
  license_id TEXT FK, source_asset_id UUID FK,   -- the insert_pdf that was analyzed
  ocr_asset_id UUID FK,                          -- the ocr_markdown asset
  analysis_asset_id UUID FK,                     -- the analysis_json asset
  primary_insert_source TEXT,                    -- 'pdf_insert'
  ocr_provider TEXT, analysis_provider TEXT,
  ocr_status TEXT, analysis_status TEXT,
  normalized_json JSONB,                         -- analysis output (matches ANALYSIS_TEMPLATE above)
  last_error_code TEXT, last_error_message TEXT,
  last_attempt_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
)

-- Denormalized: best available data merged from all sources
drug.normalized_records (
  license_id TEXT PK FK,
  normalized_json JSONB,          -- full merged record (see below)
  primary_insert_source TEXT,     -- 'index' | 'electronic_insert' | 'pdf_insert'
  quality_confidence TEXT,        -- 'index_only' | 'ei_partial' | 'ei_complete' | 'pdf_ocr'
  missing_fields JSONB,           -- list of field names absent from this record
  conflict_fields JSONB,          -- list of field names where sources disagreed
  source_errors JSONB,            -- list of error strings from enrichment
  normalized_at TIMESTAMPTZ
)

-- Pipeline state tracking
drug.import_license_state (
  license_id TEXT PK FK,
  current_run_id UUID FK,
  index_status TEXT, electronic_insert_status TEXT, insert_pdf_status TEXT,
  label_pdf_status TEXT, shape_status TEXT, storage_status TEXT,
  ocr_status TEXT, analysis_status TEXT, normalize_status TEXT,
  next_retry_at TIMESTAMPTZ, retry_count INT,
  last_error_code TEXT, last_error_message TEXT, updated_at TIMESTAMPTZ
)

drug.enrichment_queue (
  queue_id BIGSERIAL PK, license_id TEXT FK,
  reason TEXT,     -- 'new_index_entry' | 'relisted_index_entry' | 'index_row_changed'
  priority INT, status TEXT, available_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ, claimed_by TEXT, attempt_count INT, last_error_message TEXT
)

drug.import_stage_events (
  event_id BIGSERIAL PK, run_id UUID FK, license_id TEXT FK,
  stage TEXT, from_status TEXT, to_status TEXT,
  error_code TEXT, error_message TEXT, payload JSONB, created_at TIMESTAMPTZ
)
```

### `normalized_json` structure (drug.normalized_records)

```json
{
  "license_id": "衛署藥製字第000001號",
  "license_token": "000001",
  "identifiers": {"chinese_name": "...", "english_name": "...", "old_license_no": "..."},
  "classification": {"drug_category": "西藥", "controlled_drug_level": "", "license_type": "製造"},
  "product": {"dosage_form": "錠劑", "package": "...", "barcode_text": "..."},
  "status": {"is_active": true, "is_listed": true, "cancellation_status": "", "valid_until": "2030-01-01"},
  "dates": {"issue_date": "...", "last_changed_date": "...", "cancellation_date": null},
  "parties": {
    "applicant": {"name": "...", "address": "...", "tax_id": "..."},
    "manufacturer": {"name": "...", "factory_address": "...", "company_address": "...", "country": "台灣", "process": ""}
  },
  "ingredients": {
    "active": [{"name": "...", "amount": "...", "unit": "...", "raw_text": "..."}],
    "inactive": []
  },
  "atc_codes": [{"code": "R05CB06", "name": "ambroxol"}],
  "clinical": {
    "indications": "...",
    "usage": "...",
    "warnings": "...",
    "contraindications": "...",
    "precautions": "...",
    "storage": "..."
  },
  "analysis": null,   // null until Phase 3 completes; then matches ANALYSIS_TEMPLATE
  "assets": {
    "insert_pdfs": [{"asset_id": "...", "normalized_filename": "...", "minio_uri": "...", "upload_date": "..."}],
    "label_pdfs": [...],
    "appearance_records": [{"shape_id": "...", "description": "...", "color": "...", "images": [...]}]
  },
  "source": {
    "primary_insert_source": "electronic_insert",
    "errors": []
  },
  "quality": {
    "confidence": "ei_complete",
    "missing_fields": [],
    "conflict_fields": []
  },
  "normalized_at": "2026-01-01T00:00:00Z"
}
```

### AI requirements

| Capability | Used for | Provider config |
|---|---|---|
| OCR (vision LLM) | Convert insert PDF pages to Markdown | `DRUG_OCR_PROVIDER=dots_ocr`, `DRUG_OCR_VLLM_SERVER_IP:PORT`, model `Qwen/Qwen2.5-VL-7B-Instruct` |
| LLM (text) | Extract structured fields from OCR Markdown | `DRUG_ANALYSIS_PROVIDER` (`openai`/`vllm`/`ollama`), `DRUG_ANALYSIS_BASE_URL`, `DRUG_ANALYSIS_MODEL_NAME` |
| Embedding (future) | Semantic search over drug normalized records | Planned: `chinese_name || ' ' || indications_text || ' ' || main_ingredient_summary` |

---

## 8. Taiwan FDA Health Supplements

### Source type
API auto-sync — pulled from the Taiwan FDA Open Data API. No user file needed.
The re-sync cadence is configured per module in the admin console
(`admin.module_schedules`, e.g. daily/weekly/monthly + time) and executed by the
`admin-worker`; it is not a fixed hardcoded cron. It can also be triggered on
demand from the Modules tab.

### What the user must supply

Nothing. Data is pulled from Taiwan FDA Open Data API automatically.

### API source

```
GET https://data.fda.gov.tw/codedata/datadownload/<module_id>
```

Response: JSON array of health supplements permit objects.

### Input data structure (API response per item)

| Field | DB column | Description |
|---|---|---|
| `許可證字號` | `permit_no` (PK) | e.g. `衛部健食字第A00001號` |
| `中文品名` | `name` | Product name |
| `申請商名稱` | `applicant` | Applicant company |
| `功效` | `benefit_claims` | Health benefit claims |
| `有效日期(起)` | `valid_from` | Validity start |
| `有效日期(迄)` | `valid_to` | Validity end |
| `產品種類` | `category` | |

### Processing pipeline

```
FDA Open Data API → fetch JSON → TRUNCATE + INSERT (atomic sync)
                 → update health_supplements.sync_meta
```

Job type: `health_supplements_sync`

### Final DB schema

```sql
health_supplements.items (
  permit_no TEXT PK, name TEXT, applicant TEXT,
  benefit_claims TEXT, valid_from TEXT, valid_to TEXT, category TEXT
)
health_supplements.sync_meta (key TEXT PK, value TEXT, updated_at TIMESTAMPTZ)

health_supplements.item_embeddings (permit_no TEXT PK, embedding halfvec(1024), embedded_at TIMESTAMPTZ)
```

### AI requirements

| Capability | Used for | Input text |
|---|---|---|
| Embedding (Ollama) | Semantic search over health supplements products | `name || ' ' || benefit_claims` |

---

## 9. Taiwan FDA Food Nutrition

### Source type
API auto-sync — pulled from the Taiwan FDA Open Data API. No user file needed.
The re-sync cadence is configured per module in the admin console
(`admin.module_schedules`, e.g. daily/weekly/monthly + time) and executed by the
`admin-worker`; it is not a fixed hardcoded cron. It can also be triggered on
demand from the Modules tab.

### What the user must supply

Nothing. Two modules pulled from FDA Open Data API automatically.

### Input data structure

**Measurements** (nutrition data — long/narrow format, one row per food × nutrient):

| Field | DB column | Description |
|---|---|---|
| `食品分類` | `food_category` | Category (e.g. `穀物類`) |
| `樣品名稱` | `sample_name` | Food item name (PK-like) |
| `俗名` | `common_name` | Common name |
| `英文名稱` | `english_name` | English name |
| `營養素項目` | `nutrient_item` | Nutrient name (e.g. `蛋白質`) |
| `每100克含量` | `content_per_100g` | Value per 100g |
| `單位` | `content_unit` | Unit (e.g. `公克`, `毫克`) |
| `營養素分類` | `nutrient_category` | Macro / Micro / Mineral / Vitamin |

**Ingredients**: separate API endpoint — ingredient list with Chinese and English names, category hierarchy.

### Processing pipeline

```
FDA Open Data API (measurements) → TRUNCATE + INSERT
FDA Open Data API (ingredients)  → TRUNCATE + INSERT
update food_nutrition.sync_meta
```

Job type: `food_nutrition_sync`

### Final DB schema

```sql
-- long format: one row per food × nutrient (~100k+ rows)
food_nutrition.measurements (
  id SERIAL PK, food_category TEXT, sample_name TEXT, common_name TEXT, english_name TEXT,
  nutrient_item TEXT, content_per_100g TEXT, content_unit TEXT, nutrient_category TEXT
)

food_nutrition.ingredients (
  id SERIAL PK, name_zh TEXT, name_en TEXT, major_category TEXT, sub_category TEXT, note TEXT
)
food_nutrition.sync_meta (key TEXT PK, value TEXT, updated_at TIMESTAMPTZ)

-- embeddings are food-level, not measurement-level
food_nutrition.food_embeddings       (sample_name TEXT PK, embedding halfvec(1024), embedded_at TIMESTAMPTZ)
food_nutrition.ingredient_embeddings (id INT PK, embedding halfvec(1024), embedded_at TIMESTAMPTZ)
```

### AI requirements

| Capability | Used for | Input text |
|---|---|---|
| Embedding (Ollama) — foods | Semantic search over food items | `sample_name || ' ' || common_name || ' ' || english_name` |
| Embedding (Ollama) — ingredients | Semantic search over ingredients | `name_zh || ' ' || name_en` |

---

## 10. UMLS (file present — loader not yet implemented)

### Status
The ZIP is **physically present** at `fhir-code/umls/umls-2024AA-metathesaurus-full.zip` (4.0 GB).
The data loader has no `--umls` flag yet. Schema tables and loader code are planned for a future phase.

### File present

| File (relative to `fhir-code/`) | Size | Where to obtain |
|---|---|---|
| `umls/umls-2024AA-metathesaurus-full.zip` | 4,079.5 MB | https://uts.nlm.nih.gov/uts/signup-login (free UMLS license) |

> **Note**: excluded from git. Must be downloaded separately and placed here before running the future UMLS loader.

### ZIP contents (RRF format) — relevant files

| File inside ZIP | Content |
|---|---|
| `META/MRCONSO.RRF` | Concept names across all vocabularies: RXCUI, SAB (source), TTY, STR |
| `META/MRREL.RRF` | Concept relationships: RXCUI1, RELA, RXCUI2 |
| `META/MRSTY.RRF` | Semantic types per concept |
| `META/MRHIER.RRF` | Concept hierarchy |

### Planned use
- Cross-vocabulary mapping (ICD-10 ↔ SNOMED CT ↔ LOINC ↔ MeSH ↔ RxNorm)
- Synonym expansion for semantic search fallback
- MeSH term lookup for clinical decision support

### AI requirements (planned)
Embedding: yes — ~3M+ concepts across all vocabularies; will likely be filtered to medically relevant subsets (ICD, SNOMED, LOINC, MeSH, RxNorm sources only).

---

## Cross-cutting: Embedding infrastructure

All embedding tables share this pattern:

| Aspect | Detail |
|---|---|
| Vector type | `halfvec(N)` where N = `OLLAMA_EMBED_DIMENSIONS` (default `1024`) |
| Index type | HNSW with `halfvec_cosine_ops` (created automatically by loader) |
| Model | `OLLAMA_EMBED_MODEL` (default `qwen3-embedding:0.6b`) |
| Batch size | `OLLAMA_EMBED_BATCH_SIZE` (default `32`) |
| Timeout | `OLLAMA_EMBED_TIMEOUT` (default `30s` per batch) |
| Dimension change | `ensure_dimensions()` — ALTER TABLE + DROP/RECREATE HNSW index |
| Resuming | `ON CONFLICT DO UPDATE` — safe to re-run, overwrites existing vectors |

To switch embedding model: set `OLLAMA_EMBED_DIMENSIONS` to the new model's output size and re-run the embed job. The loader alters all embedding columns automatically.

---

## Cross-cutting: Admin job system

Every module import is tracked as an `admin.import_jobs` row with:
- `job_type`: identifies the pipeline (e.g. `icd_import`, `drug_enrichment`)
- `status`: `queued → running → success | partial_success | retryable_failed | permanent_failed`
- `progress_current / progress_total`: for embedding jobs = items embedded; for others = steps
- `current_step`: named phase within the job
- `checkpoint_json` (per step): resumable state across worker restarts
- `result_summary_json`: final counts and outcome

Worker: `admin-worker` container (`src/admin_worker.py`) — single-threaded, claims jobs from `admin.import_jobs` by setting `status='claimed'`.
