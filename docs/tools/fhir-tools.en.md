# FHIR Condition / Medication Tools

This group converts local ICD-10 diagnoses and Taiwan FDA drug data into FHIR R4 `Condition` / `Medication` / `MedicationKnowledge` resources, with basic validation. For advanced profile- and terminology-level authoring and validation, see [FHIR IG Tools](fhir-ig-tools.md).

## query_fhir_condition
Generate a FHIR R4 `Condition` resource from an ICD-10 diagnosis.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `diagnosis_keyword` | string | Yes | Diagnosis keyword (Chinese, English, or an ICD code) | `"第二型糖尿病"` |
| `patient_id` | string | No | The Patient reference to link | `"patient-001"` |

### Purpose
Maps the ICD-10-CM code into `Condition.code.coding` automatically, filling in the standard system URI (`http://hl7.org/fhir/sid/icd-10-cm`) and the disease name, and allows setting clinicalStatus, verificationStatus, category, subject, and other attributes.

---

## validate_fhir_condition
Validate the basic structure of a FHIR `Condition` resource.

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `condition_json` | string | Yes | The Condition JSON string to validate |

### Response format
```json
{ "valid": true, "resource_type": "Condition", "errors": [] }
```

---

## query_fhir_medication
Generate a FHIR R4 `Medication` or `MedicationKnowledge` resource from Taiwan FDA drug data.

### Parameters
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | No | Drug keyword (supply this or `license_id`) | `"普拿疼"` |
| `license_id` | string | No | License number | `"衛署藥製字第000480號"` |
| `resource_type` | string | No | `Medication` or `MedicationKnowledge` | `"MedicationKnowledge"` |

### Purpose
Coding uses the TFDA license number CodeSystem (`https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id`) and carries ingredient information.

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
