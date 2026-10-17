# FHIR Condition / Medication Tools

This group converts local ICD-10 diagnoses and Taiwan FDA drug data into FHIR R4 `Condition` / `Medication` / `MedicationKnowledge` resources, with basic validation. For advanced profile- and terminology-level authoring and validation, see [FHIR IG Tools](fhir-ig-tools.md).

> **Maintenance mode**: the Condition tools follow the `icd` module and the Medication tools follow the `drug` module. While the admin console has that module in maintenance mode, calls return an `isError` result immediately with error code `MODULE_MAINTENANCE` (`error.message` in English, `error.message_zh` in Traditional Chinese, `error.module` the module key), effective within about 5 seconds; the tools stay in `tools/list`. See the [API reference](../api/index.md#maintenance).

## query_fhir_condition
Generate a FHIR R4 `Condition` resource from an ICD-10 diagnosis.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `icd_code` | string | No | An ICD-10-CM code given directly (Path A, full field support; supply this or `diagnosis_keyword`) | `"E11.9"` |
| `diagnosis_keyword` | string | No | Diagnosis keyword (Chinese or English): searched first, then the resource is built (Path B; when both are given the keyword wins) | `"第二型糖尿病"` |
| `patient_id` | string | No | The Patient reference to link; empty string by default | `"patient-001"` |
| `clinical_status` | string | No | `active` (default) / `inactive` / `resolved` / `remission` | `"resolved"` |
| `verification_status` | string | No | `confirmed` (default) / `provisional` / `differential` / `refuted` | `"provisional"` |
| `category` | string | No | `encounter-diagnosis` (default) / `problem-list-item` | `"problem-list-item"` |
| `severity` | string | No | Severity | `"moderate"` |
| `onset_date` | string | No | Onset date | `"2026-01-15"` |
| `recorded_date` | string | No | Recorded date | `"2026-02-01"` |
| `additional_notes` | string | No | Extra notes, written into `Condition.note` | `"under follow-up"` |

> At least one of `icd_code` and `diagnosis_keyword` must be supplied; with both omitted the tool returns `{"error": "Provide either icd_code or diagnosis_keyword"}`. Path B (keyword) applies only `patient_id`, `clinical_status`, `verification_status` and `severity`; the other fields (category, dates, notes) take effect on Path A only.

### Purpose
Maps the ICD-10-CM code into `Condition.code.coding` automatically, filling in the standard system URI (`http://hl7.org/fhir/sid/icd-10-cm`) and the disease name, then populates clinicalStatus, verificationStatus, category, subject, and the other attributes from the parameters above.

---

## validate_fhir_condition
Validate the basic structure of a FHIR `Condition` resource.

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `condition_json` | string | Yes | The Condition JSON string to validate |

### Response format
```json
{ "valid": true, "errors": [], "warnings": [] }
```

> Unlike `validate_fhir_medication`, this tool's response carries **no** `resource_type`, but
> adds a `warnings` array (for recommended fields that are missing, for example). `valid`
> reflects only whether `errors` is empty; warnings do not affect it.

---

## query_fhir_medication
Generate a FHIR R4 `Medication` or `MedicationKnowledge` resource from Taiwan FDA drug data.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | No | Drug keyword: searched first, then the resource is built (Path B; supply this or `license_id`) | `"普拿疼"` |
| `license_id` | string | No | License number (Path A; when both are given the license number wins) | `"衛署藥製字第000480號"` |
| `resource_type` | string | No | `Medication` (default) or `MedicationKnowledge` | `"MedicationKnowledge"` |

### Purpose
Coding uses the TFDA license number CodeSystem (`https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id`) and carries ingredient information. Resources are derived from normalised TFDA data only — RxNorm is not used.

---

## validate_fhir_medication
Validate the basic structure of a FHIR `Medication` resource.

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `medication_json` | string | Yes | The Medication JSON string to validate |

### Response format
```json
{ "valid": true, "resource_type": "Medication", "errors": [] }
```

> These two validation tools perform basic structure and required-field checks only. When profile conformance (IG conformance) validation is needed, use `fhir_validate_resource` / `fhir_validate_bundle` instead.
