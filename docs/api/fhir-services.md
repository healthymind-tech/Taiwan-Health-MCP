# FHIR Services API

## class `FHIRConditionService`

### `__init__(self, icd_service: ICDService)`
初始化，需傳入 `ICDService` 實例以協助查找代碼。

### `create_condition(...) -> dict`
建立 FHIR Condition 資源物件 (Dict)。

### `create_condition_from_search(...) -> dict`
搜尋後建立 Condition 資源。

## class `FHIRMedicationService`

### `__init__(self, drug_service: DrugService)`
初始化，需傳入 `DrugService` 實例。

### `create_medication(license_id: str) -> dict`
建立 FHIR Medication 資源。
