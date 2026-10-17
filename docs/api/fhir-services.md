# FHIR Services API

FHIR 相關的三個服務類別都在 `node-server/src/`，方法回傳可序列化成 JSON 的物件。

## class `FHIRConditionService`（`fhirConditionService.ts`）

直接讀取 `icd.diagnoses`（經 `db.ts` 共用連線池），不依賴其他服務實例。

### `async createCondition(icdCode, patientId, opts = {})`
由 ICD-10-CM 碼建立 FHIR R4 `Condition`（system `http://hl7.org/fhir/sid/icd-10-cm`），`opts` 含 clinical / verification status、category、severity、日期與註記。對應 `query_fhir_condition` 的路徑 A。

### `async createConditionFromSearch(keyword, patientId, opts = {})`
先以關鍵字搜尋 ICD 碼再建立 `Condition`，只套用 clinical / verification status 與 severity。對應路徑 B。

### `validateCondition(condition)`
基本結構驗證，回傳 `{valid, errors, warnings}`。對應 `validate_fhir_condition`。

## class `FHIRMedicationService`（`fhirMedicationService.ts`）

### `async createMedication(licenseId, resourceType = "Medication")`
由 TFDA 許可證建立 `Medication` 或 `MedicationKnowledge`（CodeSystem `https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id`），只使用正規化的 TFDA 資料。

### `async createMedicationFromSearch(keyword, resourceType = "Medication")`
先搜尋藥品再建立資源。

### `validateMedication(medication)`
基本結構驗證，回傳 `{valid, resource_type, errors}`。對應 `validate_fhir_medication`。

## class `FHIRIGService`（`fhirIgService.ts`）

多 IG 的剖面 / 術語 / 驗證 / 授權服務，支撐全部 `fhir_*` 工具。每個方法回傳共同信封 `{ok, data, warnings, provenance, error?}` 的 JSON 字串；目標套件的解析規則（`provenance.resolved_by`、`NO_DEFAULT_IG`、`|version`）與各工具參數見 [FHIR IG 工具](../tools/fhir-ig-tools.md)。
