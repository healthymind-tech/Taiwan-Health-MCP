# LOINC Integration Guide (for IT / developers)

This guide is written for hospital information system (HIS) developers and data engineers, explaining how to map in-house lab codes to standard LOINC codes.

## Why LOINC?
Hospitals commonly use their own codes (such as GLU-AC), but exchanging data between institutions or uploading to a health passbook requires a common language. LOINC is that standard.

## Integration strategy

### 1. Build a mapping table
Use the `search_loinc(mode="code", ...)` tool to find the standard code that best matches each in-house item.

**Comparing the key attributes**:
When choosing a LOINC code, confirm that these six axes agree:
1. **Component**: the analyte (such as glucose)
2. **Property**: the measured property (such as mass concentration)
3. **Time aspect**: the timing (such as Pt = point in time, or 24H)
4. **System**: the specimen type (such as serum/plasma or urine)
5. **Scale**: the measurement scale (such as quantitative)
6. **Method**: the measurement method (a method-less code is acceptable when it does not affect interpretation)

**Using the tool**:
```python
# Search for "urine protein"
search_loinc(mode="code", keyword="Urine Protein")
# The results distinguish qualitative from quantitative
```

### 2. Verify the reference ranges
Once mapped, use `query_loinc(mode="reference_range", ...)` to confirm that the standard reference values for that LOINC code are close to the in-house laboratory's. A large discrepancy may mean the wrong code was chosen (for example a code with different units or a different measurement method).

### 3. Automate the conversion
In the exporter module:
1. Read the in-house lab result.
2. Convert it to LOINC via the mapping table.
3. Call or consult `query_loinc(mode="reference_range", ...)` to fill in standard reference range information (where in-house data is missing).
4. Package it as a FHIR Observation resource.

## Common issues
- **Unit conversion**: LOINC usually has a default unit (such as mg/dL). If the hospital uses mmol/L, convert the numeric value during the transformation.
