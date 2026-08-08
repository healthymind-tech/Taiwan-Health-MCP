# Lab Service

## Overview
The lab service integrates reference data and standard coding for laboratory tests, with particular emphasis on mapping Taiwan NHI lab codes to the international lab standard (LOINC). The module aims to improve the interoperability of lab data and the consistency of its interpretation.

## Features

### 1. Test lookup and LOINC mapping
- **Code mapping**: cross-reference lookup between local lab codes and LOINC (Logical Observation Identifiers Names and Codes).
- **Standardised names**: standard Chinese and English names for each test, reducing confusion when one test has several names.

### 2. Reference ranges
Standard reference intervals for each category of test, to assist interpretation:
- **Numeric ranges**: upper and lower bounds of the normal range (for example haemoglobin Hb 13.5–17.5 g/dL).
- **Unit conversion**: recognises common units.
- **Sex and age differences**: some tests provide different reference standards by sex or age band.

### 3. Abnormality interpretation
More than numbers — an initial explanation of clinical meaning:
- **High values**: suggests potentially related pathological states (for example a high white cell count may indicate infection).
- **Low values**: suggests possible nutritional deficiency or reduced function.

### 4. Search by specimen type
Filter LOINC tests by specimen type such as blood, urine, or stool.

### 5. Related test lookup
Find all related LOINC tests for the same analyte, helping select the most appropriate method.

### 6. Full LOINC concept details
Retrieve complete information for a single LOINC code, including a patient-friendly Chinese name, units, specimen, and method.

### 7. Batch result interpretation
Submit many test values at once and get every abnormality flag and explanation back in one call — suitable for automated analysis of health check-up reports.

## Technical architecture
- **Data sources**: LOINC 2.80 (87,000+ codes, loaded through the admin console, Admin → Modules, import stage `loinc_import`), plus seed data for tests commonly used in Taiwan (built into `node-server/src/loaders/loinc.ts`, roughly 30 rows).
- **Database**: PostgreSQL 16, with `loinc.concepts` (LOINC codes) and `loinc.reference_ranges` (age/sex-stratified reference values).
- **Structured output**: the returned data can be used directly to generate FHIR Observation resources.

## Use cases
1. **Health check-up report systems**: automatically flag abnormal values and attach explanations.
2. **EMR integration**: standardise in-house lab codes to LOINC for cross-hospital exchange.
3. **Personal health management**: help the public understand the terminology and values in their check-up reports.
