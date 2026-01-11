# Taiwan ICD10 Health MCP - 模組說明文件

> 本文件說明所有服務模組的實作方式、使用方法、輸入輸出格式

---

## 📑 目錄

1. [ICD Service](#1-icd-service) - ICD-10 診斷與手術碼
2. [Drug Service](#2-drug-service) - 台灣 FDA 藥品資料
3. [Health Food Service](#3-health-food-service) - 健康食品管理
4. [Food Nutrition Service](#4-food-nutrition-service) - 營養與食品管理
5. [FHIR Condition Service](#5-fhir-condition-service) - FHIR 診斷資源
6. [FHIR Medication Service](#6-fhir-medication-service) - FHIR 藥品資源
7. [Lab Service](#7-lab-service) - LOINC 檢驗碼與參考值
8. [Clinical Guideline Service](#8-clinical-guideline-service) - 臨床診療指引

---

## 1. ICD Service

### 📋 功能說明

提供 ICD-10-CM（診斷碼）與 ICD-10-PCS（手術碼）的查詢、推論、衝突檢查功能。

### 🔧 實作方式

- **資料來源**: 台灣衛福部 ICD-10 中文化 Excel 檔案
- **資料儲存**: SQLite 資料庫（`icd10.db`）
- **建立流程**:
  1. 讀取 Excel 檔案（pandas）
  2. 解析診斷碼與手術碼工作表
  3. 建立 SQLite 資料庫（diagnosis, procedure 資料表）
  4. 建立全文檢索索引（FTS5）

### 📥 輸入格式

#### `search_codes(keyword, type)`
```python
keyword: str  # 搜尋關鍵字（中文/英文/ICD碼）
type: str     # "diagnosis" / "procedure" / "all"
```

#### `infer_complications(code)`
```python
code: str     # 基礎診斷碼（例如: "E11"）
```

#### `get_nearby_codes(code)`
```python
code: str     # 目標診斷碼
```

#### `get_conflict_info(diagnosis_code, procedure_code)`
```python
diagnosis_code: str   # ICD-10-CM 診斷碼
procedure_code: str   # ICD-10-PCS 手術碼
```

### 📤 輸出格式

```json
{
  "keyword": "糖尿病",
  "type": "diagnosis",
  "total_found": 25,
  "results": [
    {
      "code": "E11.9",
      "name_zh": "第二型糖尿病，無併發症",
      "name_en": "Type 2 diabetes mellitus without complications"
    }
  ]
}
```

### 💡 使用範例

```python
from icd_service import ICDService

icd = ICDService('data/icd_file.xlsx', 'data')

# 搜尋診斷碼
result = icd.search_codes("糖尿病", type="diagnosis")

# 推論併發症
complications = icd.infer_complications("E11")

# 查詢鄰近碼
nearby = icd.get_nearby_codes("E11.9")

# 檢查衝突
conflict = icd.get_conflict_info("K35.80", "0DTJ0ZZ")
```

---

## 2. Drug Service

### 📋 功能說明

整合台灣 FDA 5 個開放資料 API，提供藥品查詢、外觀識別、成分分析功能。

### 🔧 實作方式

- **資料來源**:
  - API 36: 藥品許可證基本資料
  - API 42: 藥品外觀資料
  - API 43: 藥品成分資料
  - API 41: ATC 藥物分類
  - API 39: 藥品仿單/說明書

- **資料儲存**: SQLite 資料庫（`drugs.db`）
- **資料表結構**:
  - `licenses`: 許可證基本資料
  - `appearance`: 外觀資料（形狀、顏色、刻痕、圖片）
  - `ingredients`: 成分資料
  - `atc`: ATC 分類
  - `documents`: 仿單文件

- **建立流程**:
  1. 呼叫 FDA API 取得 JSON 資料
  2. 解析 JSON 並正規化資料
  3. 建立關聯式資料庫
  4. 建立 FTS5 全文檢索索引

### 📥 輸入格式

#### `search_drug(keyword)`
```python
keyword: str  # 藥品名稱、適應症（中文/英文）
```

#### `get_drug_details_by_license(license_id)`
```python
license_id: str  # 許可證字號（例如: "衛署藥製字第058498號"）
```

#### `identify_pill_by_appearance(features)`
```python
features: dict  # {"shape": "圓形", "color": "白色", "marking": "500"}
```

### 📤 輸出格式

#### 搜尋結果
```json
{
  "keyword": "普拿疼",
  "total_found": 15,
  "results": [
    {
      "license_id": "衛署藥製字第058498號",
      "name_zh": "普拿疼錠500毫克",
      "name_en": "PANADOL TABLETS 500MG",
      "manufacturer": "葛蘭素史克藥廠股份有限公司",
      "indication": "退燒、止痛",
      "form": "錠劑"
    }
  ]
}
```

#### 藥品詳細資訊
```json
{
  "license_id": "衛署藥製字第058498號",
  "name_zh": "普拿疼錠500毫克",
  "manufacturer": "葛蘭素史克藥廠股份有限公司",
  "indication": "退燒、止痛（緩解頭痛、牙痛...）",
  "usage": "成人每次1-2錠，每日3-4次",
  "form": "錠劑",
  "ingredients": [
    {
      "ingredient_name": "ACETAMINOPHEN",
      "content": "500",
      "unit": "mg"
    }
  ],
  "appearance": {
    "shape": "橢圓形",
    "color": "白色",
    "marking": "PANADOL 500",
    "image_url": "https://..."
  },
  "atc": [
    {
      "atc_code": "N02BE01",
      "atc_name_en": "Paracetamol"
    }
  ]
}
```

### 💡 使用範例

```python
from drug_service import DrugService

drug = DrugService('data')

# 搜尋藥品
results = drug.search_drug("普拿疼")

# 取得詳細資訊
details = drug.get_drug_details_by_license("衛署藥製字第058498號")

# 外觀識別
pill = drug.identify_pill_by_appearance({
    "shape": "圓形",
    "color": "白色",
    "marking": "500"
})
```

---

## 3. Health Food Service

### 📋 功能說明

提供台灣 FDA 核可健康食品查詢、健康聲稱分析、疾病與保健整合分析。

### 🔧 實作方式

- **資料來源**: 台灣 FDA 健康食品資料集
- **資料儲存**: SQLite 資料庫（`health_foods.db`）
- **資料表**: `health_foods`（許可證號、品名、功效成分、保健功效、注意事項）

### 📥 輸入格式

#### `search_health_food(keyword)`
```python
keyword: str  # 產品名稱或保健功效（例如: "靈芝", "調節血脂"）
```

#### `get_health_food_details(license_number)`
```python
license_number: str  # 健康食品許可證號
```

#### `analyze_health_support_for_condition(diagnosis_keyword, icd_service, food_nutrition_service)`
```python
diagnosis_keyword: str       # 疾病名稱或 ICD 碼
icd_service: ICDService      # ICD 服務實例
food_nutrition_service: FoodNutritionService  # 營養服務實例
```

### 📤 輸出格式

```json
{
  "keyword": "調節血脂",
  "total_found": 8,
  "results": [
    {
      "license_number": "衛部健食字第A00123號",
      "product_name": "XXX紅麴膠囊",
      "category": "調節血脂功能",
      "functional_ingredients": "紅麴",
      "health_benefit": "有助於降低血中總膽固醇",
      "claims": "本產品有助於降低血中總膽固醇...",
      "warnings": "服用降血脂藥物者，使用前請諮詢醫師"
    }
  ]
}
```

### 💡 使用範例

```python
from health_food_service import HealthFoodService

health = HealthFoodService('data')

# 搜尋健康食品
results = health.search_health_food("調節血脂")

# 疾病與保健整合分析
analysis = health.analyze_health_support_for_condition(
    diagnosis_keyword="高血脂",
    icd_service=icd_service,
    food_nutrition_service=food_service
)
```

---

## 4. Food Nutrition Service

### 📋 功能說明

提供食品營養成分查詢、膳食分析、食品原料查詢功能。

### 🔧 實作方式

- **資料來源**: 台灣食品營養成分資料庫
- **資料儲存**: SQLite 資料庫（`nutrition.db`）
- **資料表**:
  - `food_nutrition`: 食品營養成分
  - `food_ingredients`: 食品原料/添加物

### 📥 輸入格式

#### `search_nutrition(food_name, nutrient)`
```python
food_name: str   # 食品名稱（例如: "白米", "雞蛋"）
nutrient: str    # 特定營養素（可選）
```

#### `get_detailed_nutrition(food_name)`
```python
food_name: str   # 食品名稱
```

#### `analyze_diet_plan(foods)`
```python
foods: list      # 食品名稱列表（例如: ["白米", "雞胸肉", "青花菜"]）
```

### 📤 輸出格式

```json
{
  "food_name": "白米",
  "nutrition": {
    "calories": 183,
    "protein": 3.6,
    "fat": 0.6,
    "carbohydrate": 40.1,
    "fiber": 0.5,
    "calcium": 5,
    "iron": 0.5
  },
  "unit": "每100克"
}
```

### 💡 使用範例

```python
from food_nutrition_service import FoodNutritionService

food = FoodNutritionService('data')

# 查詢營養成分
nutrition = food.search_nutrition("白米")

# 膳食分析
meal = food.analyze_diet_plan(["白米", "雞胸肉", "青花菜"])
```

---

## 5. FHIR Condition Service

### 📋 功能說明

將 ICD-10-CM 診斷碼轉換為符合 FHIR R4 標準的 Condition 資源。

### 🔧 實作方式

- **標準**: FHIR R4 (Fast Healthcare Interoperability Resources)
- **依賴**: ICD Service
- **實作重點**:
  - 臨床狀態管理（active, inactive, resolved, remission）
  - 驗證狀態管理（confirmed, provisional, differential, refuted）
  - 嚴重程度分級（mild, moderate, severe）
  - 時間戳記（台灣時區 UTC+8）

### 📥 輸入格式

#### `create_condition(icd_code, patient_id, ...)`
```python
icd_code: str              # ICD-10-CM 診斷碼
patient_id: str            # 患者識別碼
clinical_status: str       # "active" | "inactive" | "resolved" | "remission"
verification_status: str   # "confirmed" | "provisional" | "differential" | "refuted"
category: str             # "encounter-diagnosis" | "problem-list-item"
severity: str             # "mild" | "moderate" | "severe" (可選)
onset_date: str           # 發病日期 "YYYY-MM-DD" (可選)
recorded_date: str        # 記錄日期時間 (可選)
additional_notes: str     # 額外備註 (可選)
```

### 📤 輸出格式

```json
{
  "resourceType": "Condition",
  "id": "condition-tw-E11.9-20241225",
  "meta": {
    "profile": ["http://hl7.org/fhir/StructureDefinition/Condition"],
    "lastUpdated": "2024-12-25T14:30:00+08:00"
  },
  "clinicalStatus": {
    "coding": [{
      "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
      "code": "active",
      "display": "Active"
    }]
  },
  "verificationStatus": {
    "coding": [{
      "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
      "code": "confirmed",
      "display": "Confirmed"
    }]
  },
  "category": [{
    "coding": [{
      "system": "http://terminology.hl7.org/CodeSystem/condition-category",
      "code": "encounter-diagnosis",
      "display": "Encounter Diagnosis"
    }]
  }],
  "severity": {
    "coding": [{
      "system": "http://snomed.info/sct",
      "code": "6736007",
      "display": "Moderate"
    }]
  },
  "code": {
    "coding": [{
      "system": "http://hl7.org/fhir/sid/icd-10-cm",
      "code": "E11.9",
      "display": "第二型糖尿病，無併發症"
    }],
    "text": "第二型糖尿病，無併發症"
  },
  "subject": {
    "reference": "Patient/patient-001"
  },
  "onsetDateTime": "2024-01-15",
  "recordedDate": "2024-12-25T14:30:00+08:00"
}
```

### 💡 使用範例

```python
from fhir_condition_service import FHIRConditionService

fhir = FHIRConditionService(icd_service)

# 建立 FHIR Condition
condition = fhir.create_condition(
    icd_code="E11.9",
    patient_id="patient-001",
    clinical_status="active",
    verification_status="confirmed",
    severity="moderate",
    onset_date="2024-01-15"
)

# 從疾病名稱建立
result = fhir.create_condition_from_search(
    keyword="糖尿病",
    patient_id="patient-001"
)

# 驗證 FHIR 資源
validation = fhir.validate_condition(condition)
```

---

## 6. FHIR Medication Service

### 📋 功能說明

將台灣 FDA 藥品資料轉換為 FHIR R4 Medication 與 MedicationKnowledge 資源。

### 🔧 實作方式

- **標準**: FHIR R4
- **依賴**: Drug Service
- **支援資源類型**:
  - **Medication**: 基本藥品資源
  - **MedicationKnowledge**: 完整藥品知識庫

- **實作重點**:
  - 整合 5 個 FDA API 資料集
  - 支援 ATC 藥物分類（WHO 標準）
  - 台灣許可證系統識別碼
  - 藥品外觀描述與圖片

### 📥 輸入格式

#### `create_medication(license_id, include_ingredients, include_appearance)`
```python
license_id: str              # 許可證字號
include_ingredients: bool    # 是否包含成分（預設: True）
include_appearance: bool     # 是否包含外觀（預設: True）
```

#### `create_medication_knowledge(license_id)`
```python
license_id: str              # 許可證字號
```

#### `create_medication_from_search(keyword, resource_type)`
```python
keyword: str                 # 藥品名稱
resource_type: str           # "Medication" | "MedicationKnowledge"
```

#### `create_medication_from_appearance(shape, color, marking)`
```python
shape: str                   # 形狀（可選）
color: str                   # 顏色（可選）
marking: str                 # 刻痕（可選）
```

### 📤 輸出格式

#### Medication Resource
```json
{
  "resourceType": "Medication",
  "id": "medication-tw-藥製058498",
  "meta": {
    "profile": ["http://hl7.org/fhir/StructureDefinition/Medication"],
    "lastUpdated": "2024-12-25T14:30:00+08:00"
  },
  "identifier": [{
    "system": "https://data.fda.gov.tw/cfdatwn/license",
    "value": "衛署藥製字第058498號",
    "use": "official"
  }],
  "code": {
    "coding": [{
      "system": "https://data.fda.gov.tw/cfdatwn/license",
      "code": "衛署藥製字第058498號",
      "display": "普拿疼錠500毫克"
    }],
    "text": "普拿疼錠500毫克"
  },
  "status": "active",
  "manufacturer": {
    "display": "葛蘭素史克藥廠股份有限公司"
  },
  "form": {
    "coding": [{
      "system": "http://terminology.hl7.org/CodeSystem/medication-form-codes",
      "display": "錠劑"
    }],
    "text": "錠劑"
  },
  "ingredient": [{
    "itemCodeableConcept": {
      "text": "ACETAMINOPHEN"
    },
    "isActive": true,
    "strength": {
      "numerator": {
        "value": "500",
        "unit": "mg"
      }
    }
  }],
  "extension": [{
    "url": "https://twhealth.mohw.gov.tw/fhir/StructureDefinition/medication-appearance",
    "extension": [
      {"url": "shape", "valueString": "橢圓形"},
      {"url": "color", "valueString": "白色"},
      {"url": "marking", "valueString": "PANADOL 500"}
    ]
  }]
}
```

#### MedicationKnowledge Resource
```json
{
  "resourceType": "MedicationKnowledge",
  "id": "medknowledge-tw-藥製058498",
  "indication": [{
    "text": "退燒、止痛（緩解頭痛、牙痛、咽喉痛...）"
  }],
  "administrationGuidelines": [{
    "dosage": [{
      "type": {"text": "標準用法用量"},
      "dosage": [{
        "text": "成人每次1-2錠，每日3-4次，每次間隔4-6小時"
      }]
    }]
  }],
  "code": {
    "coding": [{
      "system": "http://www.whocc.no/atc",
      "code": "N02BE01",
      "display": "Paracetamol"
    }]
  },
  "drugCharacteristic": [
    {"type": {"text": "顏色"}, "valueString": "白色"},
    {"type": {"text": "形狀"}, "valueString": "橢圓形"},
    {"type": {"text": "刻痕"}, "valueString": "PANADOL 500"}
  ]
}
```

### 💡 使用範例

```python
from fhir_medication_service import FHIRMedicationService

fhir_med = FHIRMedicationService(drug_service)

# 建立 Medication
medication = fhir_med.create_medication(
    license_id="衛署藥製字第058498號",
    include_ingredients=True,
    include_appearance=True
)

# 建立 MedicationKnowledge
med_knowledge = fhir_med.create_medication_knowledge(
    license_id="衛署藥製字第058498號"
)

# 從藥品名稱建立
result = fhir_med.create_medication_from_search(
    keyword="普拿疼",
    resource_type="Medication"
)

# 從外觀識別並建立
result = fhir_med.create_medication_from_appearance(
    shape="圓形",
    color="白色",
    marking="500"
)
```

---

## 7. Lab Service

### 📋 功能說明

提供 LOINC 碼對照、檢驗參考值查詢、檢驗結果判讀功能。

### 🔧 實作方式

- **資料來源**:
  - 台灣常用檢驗項目中文對照表（30+ 項）
  - 支援整合 LOINC 官方資料（87,000+ 項）
  - 台灣醫院檢驗參考值

- **資料儲存**: SQLite 資料庫（`lab_tests.db`）
- **資料表**:
  - `loinc_mapping`: LOINC 碼對照表
  - `reference_ranges`: 參考值（依年齡、性別區分）

### 📥 輸入格式

#### `search_loinc_code(keyword, category)`
```python
keyword: str      # 檢驗名稱、LOINC 碼、縮寫
category: str     # 分類篩選（可選）
```

#### `get_reference_range(loinc_code, age, gender)`
```python
loinc_code: str   # LOINC 碼
age: int          # 患者年齡
gender: str       # "M" | "F" | "all"
```

#### `interpret_lab_result(loinc_code, value, age, gender)`
```python
loinc_code: str   # LOINC 碼
value: float      # 檢驗數值
age: int          # 患者年齡
gender: str       # "M" | "F" | "all"
```

#### `batch_interpret_results(results, age, gender)`
```python
results: list     # [{"loinc_code": "1558-6", "value": 126}, ...]
age: int
gender: str
```

### 📤 輸出格式

#### 搜尋 LOINC 碼
```json
{
  "keyword": "血糖",
  "total_found": 3,
  "results": [
    {
      "loinc_code": "1558-6",
      "loinc_name_zh": "空腹血糖",
      "loinc_name_en": "Fasting glucose [Mass/volume] in Serum or Plasma",
      "common_name_zh": "AC Sugar, FBS",
      "category": "生化檢驗-血糖",
      "specimen_type": "血清或血漿",
      "unit": "mg/dL"
    }
  ]
}
```

#### 檢驗結果判讀
```json
{
  "loinc_code": "1558-6",
  "test_name_zh": "空腹血糖",
  "test_name_en": "Fasting glucose",
  "value": 126,
  "unit": "mg/dL",
  "reference_range": {
    "low": 70,
    "high": 100,
    "applicable_to": "成人（18-120歲）"
  },
  "interpretation": "偏高",
  "status": "abnormal_high",
  "clinical_significance": "空腹血糖 ≥ 126 mg/dL 可能為糖尿病，建議重複檢測確認",
  "recommendation": "建議諮詢醫師，進行糖化血色素（HbA1c）檢查"
}
```

### 💡 使用範例

```python
from lab_service import LabService

lab = LabService('data')

# 搜尋 LOINC 碼
results = lab.search_loinc_code("血糖")

# 查詢參考值
ref_range = lab.get_reference_range("1558-6", age=45, gender="M")

# 判讀檢驗結果
interpretation = lab.interpret_lab_result(
    loinc_code="1558-6",
    value=126,
    age=50,
    gender="M"
)

# 批次判讀
batch_result = lab.batch_interpret_results(
    results=[
        {"loinc_code": "1558-6", "value": 126},
        {"loinc_code": "4548-4", "value": 7.2}
    ],
    age=55,
    gender="M"
)
```

---

## 8. Clinical Guideline Service

### 📋 功能說明

提供台灣臨床診療指引查詢、用藥建議、檢查建議、治療目標、臨床路徑規劃。

### 🔧 實作方式

- **資料來源**: 台灣醫學會臨床診療指引
- **涵蓋疾病**: 糖尿病、高血壓、高血脂等慢性病
- **資料儲存**: SQLite 資料庫（`clinical_guidelines.db`）
- **資料表**:
  - `disease_guidelines`: 疾病指引總覽
  - `diagnostic_recommendations`: 診斷建議
  - `medication_recommendations`: 用藥建議
  - `test_recommendations`: 檢查建議
  - `treatment_goals`: 治療目標

### 📥 輸入格式

#### `search_guideline(keyword)`
```python
keyword: str      # 疾病名稱或 ICD 碼
```

#### `get_complete_guideline(icd_code)`
```python
icd_code: str     # ICD-10 碼（例如: "E11", "I10"）
```

#### `get_medication_recommendations(icd_code)`
```python
icd_code: str     # ICD-10 碼
```

#### `suggest_clinical_pathway(icd_code, patient_context)`
```python
icd_code: str            # ICD-10 碼
patient_context: dict    # {"age": 60, "gender": "M", "comorbidities": [...]}
```

### 📤 輸出格式

#### 完整診療指引
```json
{
  "icd_code": "E11",
  "disease_name": "第二型糖尿病",
  "guideline": {
    "title": "台灣第二型糖尿病臨床照護指引",
    "publisher": "台灣糖尿病學會",
    "version": "2022",
    "last_updated": "2022-01-01"
  },
  "diagnostic_recommendations": [
    {
      "step": 1,
      "title": "初步診斷",
      "description": "測量空腹血糖或糖化血色素",
      "criteria": "空腹血糖 ≥ 126 mg/dL 或 HbA1c ≥ 6.5%",
      "evidence_level": "A"
    }
  ],
  "medication_recommendations": [
    {
      "line": "第一線",
      "drug_class": "Biguanides",
      "example_drugs": "Metformin",
      "dosage_guideline": "起始劑量 500mg bid，最大劑量 2550mg/day",
      "contraindications": "腎功能不全（eGFR < 30）、肝功能異常",
      "evidence_level": "A"
    }
  ],
  "test_recommendations": [
    {
      "test_name": "糖化血色素",
      "loinc_code": "4548-4",
      "frequency": "每3個月",
      "indication": "所有糖尿病患者",
      "target": "< 7%"
    }
  ],
  "treatment_goals": [
    {
      "parameter": "HbA1c",
      "target_value": "< 7%",
      "timeframe": "3個月內達成",
      "note": "年長者可放寬至 < 8%"
    }
  ]
}
```

#### 臨床路徑
```json
{
  "icd_code": "E11",
  "patient_context": {
    "age": 60,
    "gender": "M",
    "comorbidities": ["高血壓", "高血脂"]
  },
  "clinical_pathway": {
    "step1_diagnosis": {
      "title": "診斷確認",
      "actions": ["測量空腹血糖", "測量 HbA1c", "排除第一型糖尿病"]
    },
    "step2_baseline_tests": {
      "title": "基礎檢查",
      "tests": [
        {"name": "腎功能", "loinc": "2160-0"},
        {"name": "肝功能", "loinc": "1742-6"},
        {"name": "血脂", "loinc": "2093-3"}
      ]
    },
    "step3_treatment_initiation": {
      "title": "治療啟始",
      "medications": [
        {"drug": "Metformin", "dosage": "500mg bid"}
      ],
      "lifestyle": ["飲食控制", "運動計畫"]
    },
    "step4_monitoring": {
      "title": "追蹤監測",
      "frequency": "每3個月",
      "tests": ["HbA1c", "空腹血糖"]
    },
    "step5_treatment_goals": {
      "HbA1c": "< 7%",
      "空腹血糖": "80-130 mg/dL",
      "飯後血糖": "< 180 mg/dL"
    }
  }
}
```

### 💡 使用範例

```python
from clinical_guideline_service import ClinicalGuidelineService

guideline = ClinicalGuidelineService('data')

# 搜尋診療指引
results = guideline.search_guideline("糖尿病")

# 取得完整指引
complete = guideline.get_complete_guideline("E11")

# 取得用藥建議
medications = guideline.get_medication_recommendations("E11")

# 建議臨床路徑
pathway = guideline.suggest_clinical_pathway(
    icd_code="E11",
    patient_context={
        "age": 60,
        "gender": "M",
        "comorbidities": ["高血壓", "高血脂"]
    }
)
```

---

## 🔗 模組間協作

### 範例 1: 完整診療流程

```python
# 1. 搜尋診斷
icd_result = icd_service.search_codes("糖尿病", type="diagnosis")
icd_code = icd_result['results'][0]['code']  # "E11.9"

# 2. 建立 FHIR Condition
condition = fhir_condition_service.create_condition(
    icd_code=icd_code,
    patient_id="patient-001",
    clinical_status="active"
)

# 3. 查詢臨床指引
guideline = guideline_service.get_complete_guideline("E11")

# 4. 取得建議用藥
medications = guideline_service.get_medication_recommendations("E11")

# 5. 搜尋對應藥品
drug_result = drug_service.search_drug("Metformin")

# 6. 建立 FHIR Medication
medication = fhir_medication_service.create_medication_from_search(
    keyword="Metformin",
    resource_type="Medication"
)

# 7. 查詢應做檢驗
tests = guideline_service.get_test_recommendations("E11")

# 8. 判讀檢驗結果
lab_result = lab_service.interpret_lab_result(
    loinc_code="1558-6",  # 空腹血糖
    value=126,
    age=60,
    gender="M"
)
```

### 範例 2: 用藥安全檢查

```python
# 1. 識別藥品
pill = drug_service.identify_pill_by_appearance({
    "shape": "圓形",
    "color": "白色",
    "marking": "500"
})

# 2. 取得詳細資訊
details = drug_service.get_drug_details_by_license(
    pill['results'][0]['license_id']
)

# 3. 建立 FHIR MedicationKnowledge
med_knowledge = fhir_medication_service.create_medication_knowledge(
    license_id=pill['results'][0]['license_id']
)

# 4. 檢查適應症與患者診斷是否符合
# ... 比對邏輯
```

---

## 📊 資料庫結構總覽

| 資料庫 | 資料表 | 主要欄位 | 索引 |
|--------|--------|---------|------|
| icd10.db | diagnosis | code, name_zh, name_en | code, FTS5 |
| icd10.db | procedure | code, name_zh, name_en | code, FTS5 |
| drugs.db | licenses | license_id, name_zh, indication | license_id, FTS5 |
| drugs.db | appearance | license_id, shape, color, marking | license_id |
| drugs.db | ingredients | license_id, ingredient_name, content | license_id |
| drugs.db | atc | license_id, atc_code | license_id, atc_code |
| health_foods.db | health_foods | license_number, product_name, category | license_number, FTS5 |
| nutrition.db | food_nutrition | food_name, calories, protein, ... | food_name, FTS5 |
| nutrition.db | food_ingredients | ingredient_name, category | ingredient_name, FTS5 |
| lab_tests.db | loinc_mapping | loinc_code, loinc_name_zh, category | loinc_code, FTS5 |
| lab_tests.db | reference_ranges | loinc_code, age_min, age_max, gender | loinc_code |
| clinical_guidelines.db | disease_guidelines | icd_code, title, publisher | icd_code |
| clinical_guidelines.db | medication_recommendations | icd_code, drug_class, dosage | icd_code |

---

## 🧪 測試

### 執行測試

```bash
# FHIR Medication 測試
python test_fhir_medication.py

# LOINC 與臨床指引測試
python test_lab_and_guideline.py
```

### 測試涵蓋

- ✅ ICD-10 查詢與推論
- ✅ 藥品搜尋與外觀識別
- ✅ 健康食品與營養分析
- ✅ FHIR Condition 轉換
- ✅ FHIR Medication 轉換
- ✅ LOINC 對照與檢驗判讀
- ✅ 臨床指引查詢

---

## 📝 授權與資料來源

### 政府開放資料
- 台灣衛福部 ICD-10 中文化資料
- 台灣 FDA 藥品資料（API 36, 42, 43, 41, 39）
- 台灣 FDA 健康食品資料
- 採用政府資料開放授權條款

### 國際標準
- **FHIR R4**: HL7 International License
- **LOINC**: Regenstrief Institute License（免費用於臨床、研究）
- **ICD-10**: WHO License
- **ATC**: WHO License

---

## 🔧 維護與更新

### 更新 ICD-10 資料
```python
# 下載最新 ICD-10 Excel 檔案
# 重新執行 ICDService 初始化
icd_service = ICDService('new_icd_file.xlsx', 'data')
```

### 更新藥品資料
```python
# DrugService 會自動從 FDA API 取得最新資料
drug_service = DrugService('data')
```

### 更新 LOINC 資料
```bash
# 下載最新 LOINC 官方檔案
# 執行整合腳本
python scripts/integrate_loinc.py
```

---

## 📞 技術支援

- **GitHub Issues**: 回報問題與建議
- **文件**: 參閱專案根目錄 README.md

---

**版本**: 1.1.0
**最後更新**: 2024-12-25
**維護者**: Taiwan-ICD10-Health-MCP Team
