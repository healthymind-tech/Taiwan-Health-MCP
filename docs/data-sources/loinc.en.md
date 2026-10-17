# LOINC Data Source

## International standard
- **Authority**: the Regenstrief Institute (<https://loinc.org/downloads/>, account required)
- **Version**: LOINC 2.80 (`Loinc_2.80.zip`).
- **Content**: about 105k concepts (laboratory tests and clinical observations) from `LoincTable/Loinc.csv`, written to `loinc.concepts`.
- **AccessoryFiles**: the import also takes the answer (LA), part (LP), answer-list (LL) and group (LG) codes (`loinc.other_codes`), per-axis part links, answer lists, panel membership and MapTo replacements (`loinc.part_links`, `loinc.answer_list_items` / `_links`, `loinc.panel_items`, `loinc.map_to`), and the release version (`loinc.editions`). The former are used by the FHIR validator, the structure tables by the LOINC browser in the admin console.

## Taiwan Chinese mapping
- **File**: `data/loinc/taiwan_mapping.csv` (source role `loinc_taiwan_mapping`, optional), columns `loinc_code, name_zh, common_name_zh, specimen_type, unit`, about 30 tests common in Taiwan.
- Curated by the project and downloadable nowhere, so it is kept in version control; the import merges it into the Chinese columns of `loinc.concepts`.

## Reference range data
- **File**: `data/loinc/lab_reference_ranges.csv` (source role `loinc_reference_ranges`, optional), about 40 rows stratified by age / sex, written to `loinc.reference_ranges`.
- **Source**: compiled from published material of the NTUH Department of Laboratory Medicine and Taiwanese societies (diabetes, lipid, nephrology) — see each row's `source` column.
- **Caution**: reference values vary slightly between laboratories depending on instruments and reagents. The values this system provides are for general reference only. `interpret_lab_result` can only interpret codes that have a reference range.
