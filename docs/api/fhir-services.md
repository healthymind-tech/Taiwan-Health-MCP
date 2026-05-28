# FHIR Services API

## class `FHIRConditionService`

### `__init__(self, icd_service: ICDService)`
初始化，需傳入 `ICDService` 實例。

### `create_condition(...) -> dict`
建立 FHIR Condition 資源。

### `create_condition_from_search(...) -> dict`
搜尋後建立 Condition 資源。

### `validate_condition(condition: dict) -> dict`
驗證 Condition 結構。
