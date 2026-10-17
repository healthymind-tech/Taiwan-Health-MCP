# FHIR Services API

The three FHIR service classes live in `node-server/src/`; methods return JSON-serialisable objects.

## class `FHIRConditionService` (`fhirConditionService.ts`)

Reads `icd.diagnoses` directly (through the shared pool in `db.ts`); it does not depend on another service instance.

### `async createCondition(icdCode, patientId, opts = {})`
Builds a FHIR R4 `Condition` from an ICD-10-CM code (system `http://hl7.org/fhir/sid/icd-10-cm`); `opts` covers clinical / verification status, category, severity, dates and notes. Backs Path A of `query_fhir_condition`.

### `async createConditionFromSearch(keyword, patientId, opts = {})`
Searches an ICD code by keyword first, then builds the `Condition`; applies only clinical / verification status and severity. Backs Path B.

### `validateCondition(condition)`
Basic structural validation, returns `{valid, errors, warnings}`. Backs `validate_fhir_condition`.

## class `FHIRMedicationService` (`fhirMedicationService.ts`)

### `async createMedication(licenseId, resourceType = "Medication")`
Builds a `Medication` or `MedicationKnowledge` from a TFDA license (CodeSystem `https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id`), using normalised TFDA data only.

### `async createMedicationFromSearch(keyword, resourceType = "Medication")`
Searches the drug first, then builds the resource.

### `validateMedication(medication)`
Basic structural validation, returns `{valid, resource_type, errors}`. Backs `validate_fhir_medication`.

## class `FHIRIGService` (`fhirIgService.ts`)

The multi-IG profile / terminology / validation / authoring service behind every `fhir_*` tool. Each method returns a JSON string in the shared envelope `{ok, data, warnings, provenance, error?}`; package-resolution rules (`provenance.resolved_by`, `NO_DEFAULT_IG`, `|version`) and per-tool parameters are in [FHIR IG Tools](../tools/fhir-ig-tools.md).
