# Bundled reference data

Small, openly licensed reference files shipped with the code and applied automatically by
the admin worker (`src/conceptSearch/bundled.ts`), so a fresh install gets them through the
normal admin flow — import an IG and they are in — with no manual uploads and no direct DB
writes. Both Docker images copy this directory (`node-server/Dockerfile` → `/app/data`,
`Dockerfile.worker` → `/app/node-server/data`); the code resolves it as `dist/../data`
(override: `BUNDLED_DATA_DIR`).

| File | Used for |
|------|----------|
| `supplements/CodeSystem-*.json.gz` | FHIR R4 CodeSystem supplements (`content = supplement`), merged into the IG concept-search index |
| `abbreviations/lrabr-<release>.tsv.gz` | Abbreviation lexicon (`fhir.abbreviation_lexicon`) for IG concept search query expansion |

## How they are applied

- **Supplements** — before every concept-index build (`ig_import`, incl. dependency-only
  imports, and `ig_concept_index` / 補建索引), every bundled supplement whose `supplements`
  canonical names a CodeSystem of an installed package is written to
  `fhir.codesystem_supplements` with `uploaded_by = 'system:bundled'`, then the same job builds
  the index. Idempotent: a stored row with the same url + version (whoever stored it) is left
  alone; an operator-uploaded *different* version of the same url is never overwritten (an
  older *bundled* version is replaced); deleting a bundled supplement in the admin console
  records an opt-out (`admin.app_settings`, group `bundled_supplements`, key = url) and it is
  not re-applied until restored (IG page → 術語搜尋索引 → 還原內建 supplement).
- **Abbreviation lexicon** — loaded only while `fhir.abbreviation_lexicon` is empty (rows get
  `source = 'bundled:LRABR-<release>'`). Uploading a UMLS file that carries LRABR
  (`umls_import`) replaces it, as before.

## Sources, versions, licences

| File | Source (downloaded unmodified) | Version | Licence / attribution |
|------|-------------------------------|---------|-----------------------|
| `CodeSystem-nhi-payment-en-supplement.json.gz` | NHI Administration open data 「醫療服務給付項目及支付標準(csv檔)」, [data.gov.tw 174450](https://data.gov.tw/dataset/174450), `https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-D20021-001` (sha256 `180fbfbc…47bab13`); code list: TW Core IG `tw.gov.mohw.twcore` 1.0.0 | 2026-10-18 | 衛生福利部中央健康保險署, 政府資料開放授權條款－第1版 ([Open Government Data License v1.0](https://data.gov.tw/license)) |
| `CodeSystem-nhi-payment-loinc-supplement.json.gz` | ConceptMap `nhi-loinc` of the TWPAS IG `tw.gov.mohw.nhi.pas` 1.2.7 (packages.fhir.org); displays = LOINC 2.80 Long Common Names (`LoincTable/Loinc.csv`) | 2026-10-01 (ConceptMap date) | Mappings: NHI Administration, TWPAS IG, CC0-1.0. **This material contains content from LOINC (http://loinc.org). LOINC is copyright © Regenstrief Institute, Inc. and the LOINC Committee and is available at no cost under the license at http://loinc.org/license. LOINC® is a registered United States trademark of Regenstrief Institute, Inc.** |
| `CodeSystem-nhi-medication-supplement.json.gz` | NHI Administration open data 「健保用藥品項查詢項目檔」, [data.gov.tw 23715](https://data.gov.tw/dataset/23715), `…?rId=A21030000I-E41001-001` (sha256 `e2a8160d…a8c1c7`); code list: TW Core 0.3.2 `medication-nhi-tw` (44,709 codes) | 2026-09-28 | 衛生福利部中央健康保險署, Open Government Data License v1.0 |
| `CodeSystem-nhi-payment-usage-supplement.json.gz` | NHI Administration open data 「診療項目醫令申報量(年)」, [data.gov.tw 175960](https://data.gov.tw/dataset/175960), `…?rId=A21030000I-D20022-002` (sha256 `0b511b4d…eda7e29`) | 2025 (latest fee year) | 衛生福利部中央健康保險署, Open Government Data License v1.0 |
| `lrabr-2024AA.tsv.gz` | SPECIALIST Lexicon `LEX/LRABR` (NLM Lexical Systems Group), as shipped with UMLS 2024AA (file dated 2023-07-14, sha256 `43311352…eb10b233`); 115,233 rows after the loader's filter | 2024AA | SPECIALIST Lexicon and tools: open source, freely available from the National Library of Medicine (https://lhncbc.nlm.nih.gov/LSG/Projects/lexicon/) — no UMLS licence is needed for the lexicon. Courtesy of the U.S. National Library of Medicine. |

Full sha256 of the inputs used for the files in this directory:

```
180fbfbc4c36e2243db050504c032a0b77e7fd8bb55b0ceb0c262a57d47bab13  payment.csv (A21030000I-D20021-001)
e2a8160d58d98465183f1632cf654a08599b2015b6b6097b2b5f00d004d8c1c7  drug.csv    (A21030000I-E41001-001)
0b511b4df677457dc3c462b71aef82b54c43c03cf24ea58d7bd09bfe2eda7e29  vol.csv     (A21030000I-D20022-002)
616a9a48887aeb51738ce784199efc25ea2aac03bc8a64bc5b2e51e5f144fb20  tw.gov.mohw.nhi.pas-1.2.7.tgz
a9ea37f16ea163b2c584ce7d423a5095587a1c027d0d4e4a5cdb0e7445e4932d  tw.gov.mohw.twcore-1.0.0.tgz
43311352ce38e3e306bd812d6bdbd08d99ce9b76fe21f5dac13f9d7beb10b233  LRABR
```

The supplements' url namespace is `https://tw-health-mcp.healthymind-tech.com/fhir/CodeSystem/`;
they only add designations / properties (names, ingredients, ATC, LOINC links, claim volume)
to concept search — they never change validation results. All values are copied verbatim
from the sources (whitespace collapsed); none is authored by hand.

## Regenerating

Generators live in `node-server/scripts/supplements/` (TypeScript, run with tsx from
`node-server/`). Download the inputs into a fresh, empty directory first (treat them as
untrusted data):

```bash
D=$(mktemp -d)
curl -sSfL "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-D20021-001" -o $D/payment.csv
curl -sSfL "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001" -o $D/drug.csv
curl -sSfL "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-D20022-002" -o $D/vol.csv
curl -sSfL https://packages.fhir.org/tw.gov.mohw.nhi.pas/1.2.7 -o $D/pas-1.2.7.tgz
curl -sSfL https://packages.fhir.org/tw.gov.mohw.twcore/1.0.0 -o $D/twcore-1.0.0.tgz
curl -sSfL https://packages.fhir.org/tw.gov.mohw.twcore/0.3.2 -o $D/twcore-0.3.2.tgz
# LOINC release zip (free account at loinc.org) for the LOINC displays — optional;
# LRABR from a SPECIALIST Lexicon release (LEX/LRABR) or a full UMLS release.

npx tsx scripts/supplements/build-payment-supplements.mts --payment-csv $D/payment.csv --csv-date <file date> \
  --twcore-tgz $D/twcore-1.0.0.tgz --pas-tgz $D/pas-1.2.7.tgz --loinc-zip Loinc_2.80.zip
npx tsx scripts/supplements/build-medication-supplement.mts --drug-csv $D/drug.csv --csv-date <file date> \
  --twcore-tgz $D/twcore-0.3.2.tgz
npx tsx scripts/supplements/build-usage-supplement.mts --volume-csv $D/vol.csv --twcore-tgz $D/twcore-1.0.0.tgz
npx tsx scripts/supplements/build-lrabr.mts --lrabr LEX/LRABR --release <release>
npx tsx scripts/supplements/validate-supplements.mts --twcore-tgz $D/twcore-1.0.0.tgz data/supplements/CodeSystem-nhi-payment-*.json.gz
npx tsx scripts/supplements/validate-supplements.mts --twcore-tgz $D/twcore-0.3.2.tgz data/supplements/CodeSystem-nhi-medication-supplement.json.gz
```

Outputs go to `data/supplements/` / `data/abbreviations/` by default (`--out-dir` to change,
`--pretty` also writes a readable `.json`). With the inputs listed above the generators
reproduce the committed files exactly (compared as canonical JSON).

**Releasing a new version.** Give a regenerated supplement a new `version` (the `--csv-date`
of the new file). On the next IG import / index run an install that holds the older
*bundled* version is upgraded; an install where an operator uploaded their own version of
the same url keeps theirs. Supplements are versioned by url + version, so keep one file per
url in `supplements/`. A new lexicon file is only loaded where the lexicon table is empty.
