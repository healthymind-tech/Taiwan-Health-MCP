# FHIR Condition Service

## Overview
This module converts local ICD-10 diagnosis data into `Condition` resources conforming to the HL7 FHIR (Fast Healthcare Interoperability Resources) R4 standard. It is a key component for healthcare interoperability, ensuring Taiwan's diagnosis records can connect with international health information systems.

## Core features

### 1. ICD-10 to FHIR Condition
Automatically wraps structured ICD-10 data into a FHIR JSON object:
- **Code conversion**: maps ICD-10-CM codes correctly into the `Condition.code.coding` field.
- **System identification**: fills in the standard system URI (`http://hl7.org/fhir/sid/icd-10-cm`) automatically.
- **Text description**: carries over the standard ICD-10 disease name.

### 2. Attribute configuration
Supports setting the full range of Condition resource attributes:
- **Clinical status**: set the clinical status (such as `active`, `resolved`, `remission`).
- **Verification status**: set the verification status (such as `confirmed`, `provisional`).
- **Category**: distinguish an encounter diagnosis from a problem list entry.
- **Severity**: annotate severity (mild, moderate, severe).
- **Patient link**: associate the resource with a specific Patient resource (`subject`).

### 3. Dates and notes
- **Onset date**: record when the condition began.
- **Recorded date**: record when the data was entered.
- **Notes**: supports adding unstructured clinical notes.

## Technical detail

### Example resource structure (JSON)
```json
{
  "resourceType": "Condition",
  "clinicalStatus": {
    "coding": [
      {
        "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
        "code": "active"
      }
    ]
  },
  "code": {
    "coding": [
      {
        "system": "http://hl7.org/fhir/sid/icd-10-cm",
        "code": "E11.9",
        "display": "Type 2 diabetes mellitus without complications"
      }
    ]
  },
  "subject": {
    "reference": "Patient/example"
  }
}
```

## Use cases
1. **EMR exchange**: exchanging patient diagnosis records between hospitals.
2. **Health passbook integration**: formatting clinical data for upload to a personal health management platform.
3. **Insurance claim automation**: insurers receiving standardised diagnosis data for adjudication.
