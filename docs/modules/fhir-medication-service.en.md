# FHIR Medication Service

## Overview
The FHIR Medication service converts Taiwan FDA drug data from the drug service module into FHIR R4 `Medication` and `MedicationKnowledge` resources, with basic validation. It lets drug data be exchanged between systems in the standard FHIR format.

## Features

### 1. Generate FHIR Medication / MedicationKnowledge (`query_fhir_medication`)
- Query by drug keyword (`keyword`) or license number (`license_id`).
- Use `resource_type` to select `Medication` or `MedicationKnowledge` output.
- Coding uses the TFDA license number CodeSystem (`https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id`) and carries ingredient information.

### 2. Validate FHIR Medication (`validate_fhir_medication`)
Performs basic structural validation of the supplied Medication JSON (required fields, coding systems) and returns `{"valid", "resource_type", "errors"}`.

## Technical architecture
- **Data source**: reads normalized drug data from the drug service module (`drug_service`).
- **Availability**: derived from the drug domain — the tools degrade automatically when drug data is not loaded.
- **Validation scope**: basic structure and required fields only. For full IG conformance, use the FHIR IG module's validation tools or the official HL7 FHIR Validator.

## Dependencies
- **Drug Service**: supplies the source drug data.
- Complementary to the **FHIR IG module**, which provides advanced profile- and terminology-level validation and authoring.
