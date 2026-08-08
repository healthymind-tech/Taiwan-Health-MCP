# Lab Result Interpretation Guide

This guide helps users understand how to use the lab module to interpret laboratory data.

## Foundation: LOINC codes
Before interpreting anything, the most precise approach is to work from LOINC codes, because the same test (glucose, say) can have different specimen sources (whole blood, plasma, urine) or measurement methods. This system supports LOINC first and foremost.

## Example: interpreting a health check-up report

Suppose you receive a check-up report with several flagged values:
1. Fasting glucose: 110 mg/dL
2. Triglyceride: 180 mg/dL
3. Total cholesterol: 240 mg/dL

The patient is a 55-year-old man.

### Step 1: Determine the LOINC codes (if the report does not supply them)

**Tool call**:
```python
search_loinc(mode="code", keyword="空腹血糖")
# Returns: 1558-6 (Glucose [Mass/volume] in Serum or Plasma --Fasting)

search_loinc(mode="code", keyword="三酸甘油酯")
# Returns: 2571-8 (Triglyceride [Mass/volume] in Serum or Plasma)
```

### Step 2: Interpret a single value

Analyse each of these values.

**Tool call**:
```python
interpret_lab_result(loinc_code="1558-6", value=110, age=55, gender="M")
```

**Result**:
The system points out that 110 mg/dL is slightly above the normal value (usually < 100), which is Impaired Fasting Glucose — that is, pre-diabetes. Dietary control and follow-up are recommended.

### Step 3: Batch interpretation

To analyse the whole report at once.

**Tool call**:
```python
batch_interpret_lab_results(
    results_json='[
        {"loinc_code": "1558-6", "value": 110},
        {"loinc_code": "2571-8", "value": 180},
        {"loinc_code": "2093-3", "value": 240}
    ]',
    age=55,
    gender="M"
)
```

**Result**:
The system returns a summary noting that the patient is at risk of metabolic syndrome (high blood glucose, high blood lipids) and suggests consulting cardiology or endocrinology.
