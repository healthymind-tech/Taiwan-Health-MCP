# FHIR Services API

## class `FHIRConditionService`

### `__init__(self, icd_service: ICDService)`
Initialisation; requires an `ICDService` instance.

### `create_condition(...) -> dict`
Create a FHIR Condition resource.

### `create_condition_from_search(...) -> dict`
Search first, then create a Condition resource.

### `validate_condition(condition: dict) -> dict`
Validate the Condition structure.
