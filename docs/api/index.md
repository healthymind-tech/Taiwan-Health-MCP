# API 參考文件 (Python SDK)

本章節詳細說明本專案核心 Python 類別 (Classes) 的介面定義。若您不是透過 MCP 協定，而是直接在 Python 專案中引用本專案的程式碼 (`src/`)，請參考此處說明。

## 模組列表

### [ICD Service API](icd-service.md)
處理 ICD-10 相關邏輯的核心類別 `ICDService`。

### [Drug Service API](drug-service.md)
處理藥品資料與辨識的核心類別 `DrugService`。

### [FHIR Services API](fhir-services.md)
包含 `FHIRConditionService` 與 `FHIRMedicationService`，負責產出 FHIR 資源。

### [Lab Service API](lab-service.md)
處理 LOINC 與檢驗數值的類別 `LabService`。

### [Guideline Service API](guideline-service.md)
管理臨床指引資料的 `ClinicalGuidelineService`。

## 初始化範例

目前服務初始化依賴 PostgreSQL 連線池（`asyncpg`），不再使用本地 SQLite/Excel 路徑注入：

```python
import asyncio
import asyncpg

from src.icd_service import ICDService
from src.drug_service import DrugService


async def main():
    pool = await asyncpg.create_pool(
        "postgresql://mcp:password@localhost:5432/taiwan_health",
        statement_cache_size=0,  # through pgBouncer transaction mode
    )
    icd_svc = ICDService(pool)
    drug_svc = DrugService(pool)

    await icd_svc.initialize()
    await drug_svc.initialize()

    print(await icd_svc.search_codes("diabetes", "diagnosis", limit=3))


asyncio.run(main())
```
