# ICD-10 Data Source

## ICD-10-CM / PCS
- **CM (Clinical Modification)**: used for diagnosis coding.
    - Source: the annual release from the US CMS (Centers for Medicare & Medicaid Services) (<https://www.cms.gov/medicare/coding-billing/icd-10-codes>).
    - Recommended file: the "Code Descriptions in Tabular Order" zip (containing `icd10cm_order_YYYY.txt`) — the complete code set: header codes plus billable codes including 7th characters / placeholder `X` (98,186 codes in the 2026-04-01 release). Only with this file is `icd.editions.complete` true, and only then does the FHIR validator treat unknown ICD-10-CM codes as errors.
    - Also accepted: the "Code Tables, Tabular and Index" zip (`icd10cm_tabular_YYYY.xml`); 7th characters are expanded, but unknown codes stay warnings.
- **PCS (Procedure Coding System)**: used for procedure and surgical coding.
    - Source: as above (the flat codes TXT inside the ICD-10-PCS zip).

## WHO ICD-10 (optional)
- **Purpose**: lets the FHIR validator check codes and displays of `http://hl7.org/fhir/sid/icd-10`; the ICD lookup tools are unaffected.
- **File**: a WHO ICD-10 FHIR CodeSystem or expanded ValueSet JSON, e.g. `2019-covid-expanded` (13,831 codes) fetched from tx.fhir.org with `node-server/scripts/validator-audit/harness/fetch_tx_terms.py`. Written to `icd.icd10_who`.

## Taiwan Chinese names
- **Source**: the Ministry of Health and Welfare's bilingual "Chinese edition of ICD-10-CM/PCS" XLSX (source role `icd_zh_tw`, optional).
- Chinese names only fill `name_zh`; the code set itself always follows the CMS release.

## File format and import
Upload on the **Terminology → ICD-10** page of the admin console, "Data lifecycle" tab; the `icd_import` stage processes every role in one job:

| Source role | File | Required |
|-------------|------|----------|
| `icd10cm` | CMS ICD-10-CM zip (order file or tabular XML) | Yes |
| `icd10pcs` | CMS ICD-10-PCS zip | No (procedure features degrade without it) |
| `icd_zh_tw` | MOHW bilingual XLSX (sheets `ICD-10-CM` and `ICD-10-PCS`, code in column A, Chinese name in column D) | No |
| `icd10_who` | WHO ICD-10 FHIR JSON | No |

The import writes staging tables first, then swaps `icd.*` and writes `icd.editions` in one promote transaction.
