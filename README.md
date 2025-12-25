# Taiwan ICD10 Health MCP Server

> 🇹🇼 台灣醫療健康資料整合 MCP 伺服器
> 整合 ICD-10、FDA 藥品、保健食品、營養資料、LOINC 檢驗、臨床指引，支援 FHIR R4 標準

[![FHIR](https://img.shields.io/badge/FHIR-R4-blue)](http://hl7.org/fhir/R4/)
[![Python](https://img.shields.io/badge/Python-3.8+-green)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-orange)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## ✨ 專案特色

- 🇹🇼 **台灣在地化** - 專為台灣醫療環境設計，支援繁體中文
- 🔗 **標準化整合** - 符合國際 FHIR R4、LOINC、ICD-10、ATC 標準
- 📊 **官方資料** - 整合台灣 FDA、衛福部官方開放資料
- 🤖 **AI 整合** - 透過 MCP 協議與 Claude 無縫對接
- 🔄 **持續更新** - 資料可自動同步最新資訊

---

## 🚀 快速開始

### 安裝

```bash
# 1. Clone 專案
git clone https://github.com/yourusername/Taiwan-ICD10-Health-MCP.git
cd Taiwan-ICD10-Health-MCP

# 2. 安裝相依套件
pip install -r requirements.txt

# 3. 準備資料（下載 ICD-10 Excel 檔案到 data/ 目錄）

# 4. 啟動服務
python src/server.py
```

### Docker 啟動（推薦）

```bash
docker-compose up -d
```

---

## 📋 核心功能

### 1. ICD-10 診斷與手術碼查詢
- 診斷碼（ICD-10-CM）與手術碼（ICD-10-PCS）搜尋
- 診斷併發症推論
- 診斷與手術碼衝突檢查
- 轉換為 **FHIR Condition** 資源

### 2. 台灣 FDA 藥品資料整合
整合 5 個官方資料集：
- 藥品許可證（名稱、適應症、製造商）
- 藥品外觀識別（形狀、顏色、刻痕、圖片）
- 藥品成分（有效成分、含量）
- ATC 藥物分類（WHO 標準）
- 藥品仿單/說明書
- 轉換為 **FHIR Medication/MedicationKnowledge** 資源

### 3. 健康食品管理
- 台灣 FDA 核可健康食品查詢
- 健康聲稱（Health Claims）查詢
- 疾病與保健食品關聯分析

### 4. 營養與食品管理
- 食品營養成分查詢
- 膳食營養分析
- 食品原料/添加物查詢

### 5. LOINC 檢驗碼整合
- LOINC 碼對照（台灣常用 30+ 項，可擴展至 87,000+ 項）
- 檢驗參考值查詢（依年齡、性別）
- 檢驗結果自動判讀
- 批次判讀多項檢驗

### 6. 臨床診療指引
- 台灣醫學會臨床指引查詢
- 診斷建議、用藥建議、檢查建議
- 治療目標與臨床路徑規劃

### 7. FHIR R4 標準轉換
- **FHIR Condition** - ICD-10 診斷資源
- **FHIR Medication** - 藥品資源
- **FHIR MedicationKnowledge** - 藥品知識庫
- 符合國際醫療資訊交換標準

---

## 🛠️ MCP 工具清單

本服務提供 **32 個 MCP 工具**，分為 10 個群組：

<details>
<summary><b>Group 1: ICD-10 Tools (4 個)</b></summary>

- `search_medical_codes` - 搜尋診斷/手術碼
- `infer_complications` - 推論疾病併發症
- `get_nearby_codes` - 查詢鄰近碼（鑑別診斷）
- `check_medical_conflict` - 檢查診斷與手術碼衝突

</details>

<details>
<summary><b>Group 2: Drug Tools (3 個)</b></summary>

- `search_drug_info` - 搜尋台灣 FDA 藥品
- `get_drug_details` - 取得藥品詳細資訊
- `identify_unknown_pill` - 根據外觀識別藥品

</details>

<details>
<summary><b>Group 3: Composite Analysis (1 個)</b></summary>

- `analyze_treatment_plan` - 診斷與藥物關聯分析

</details>

<details>
<summary><b>Group 4: Health Food Tools (2 個)</b></summary>

- `search_health_food` - 搜尋健康食品
- `get_health_food_details` - 健康食品詳細資訊

</details>

<details>
<summary><b>Group 5: Nutrition & Dietary Tools (5 個)</b></summary>

- `search_food_nutrition` - 搜尋食品營養資訊
- `get_detailed_nutrition` - 取得詳細營養成分
- `search_food_ingredient` - 搜尋食品原料
- `get_ingredients_by_category` - 依分類查詢原料
- `analyze_meal_nutrition` - 膳食營養分析

</details>

<details>
<summary><b>Group 6: Comprehensive Health Analysis (1 個)</b></summary>

- `analyze_health_support_for_condition` - 疾病與保健整合分析

</details>

<details>
<summary><b>Group 7: FHIR Interoperability Tools (3 個)</b></summary>

- `create_fhir_condition` - 建立 FHIR Condition 資源
- `create_fhir_condition_from_diagnosis` - 從診斷建立 Condition
- `validate_fhir_condition` - 驗證 FHIR Condition

</details>

<details>
<summary><b>Group 8: Laboratory & LOINC Tools (5 個)</b></summary>

- `search_loinc_code` - 搜尋 LOINC 碼
- `list_lab_categories` - 列出檢驗分類
- `get_reference_range` - 查詢參考值範圍
- `interpret_lab_result` - 判讀檢驗結果
- `batch_interpret_lab_results` - 批次判讀

</details>

<details>
<summary><b>Group 9: Clinical Guideline Tools (5 個)</b></summary>

- `search_clinical_guideline` - 搜尋臨床指引
- `get_complete_guideline` - 取得完整指引
- `get_medication_recommendations` - 取得用藥建議
- `get_test_recommendations` - 取得檢查建議
- `get_treatment_goals` - 取得治療目標
- `suggest_clinical_pathway` - 建議臨床路徑

</details>

<details>
<summary><b>Group 10: FHIR Medication Tools (4 個)</b></summary>

- `create_fhir_medication` - 建立 FHIR Medication 資源
- `create_fhir_medication_knowledge` - 建立藥品知識庫
- `create_fhir_medication_from_name` - 從藥品名稱建立
- `identify_pill_to_fhir` - 從外觀識別並建立 FHIR

</details>

---

## 💡 使用範例

### 範例 1: 完整診療流程

```python
from src.icd_service import ICDService
from src.fhir_condition_service import FHIRConditionService
from src.clinical_guideline_service import ClinicalGuidelineService

# 1. 搜尋診斷
icd = ICDService('data/icd.xlsx', 'data')
result = icd.search_codes("糖尿病", type="diagnosis")

# 2. 建立 FHIR Condition
fhir = FHIRConditionService(icd)
condition = fhir.create_condition(
    icd_code="E11.9",
    patient_id="patient-001",
    clinical_status="active"
)

# 3. 查詢臨床指引
guideline = ClinicalGuidelineService('data')
pathway = guideline.suggest_clinical_pathway("E11")
```

### 範例 2: 藥品查詢與 FHIR 轉換

```python
from src.drug_service import DrugService
from src.fhir_medication_service import FHIRMedicationService

# 1. 搜尋藥品
drug = DrugService('data')
result = drug.search_drugs("普拿疼")

# 2. 建立 FHIR Medication
fhir_med = FHIRMedicationService(drug)
medication = fhir_med.create_medication_from_search(
    keyword="普拿疼",
    resource_type="Medication"
)
```

### 範例 3: 檢驗結果判讀

```python
from src.lab_service import LabService

lab = LabService('data')

# 判讀單項檢驗
result = lab.interpret_lab_result(
    loinc_code="1558-6",  # 空腹血糖
    value=126,
    age=50,
    gender="M"
)

# 批次判讀
batch = lab.batch_interpret_results([
    {"loinc_code": "1558-6", "value": 126},
    {"loinc_code": "4548-4", "value": 7.2}
], age=55, gender="M")
```

---

## 📚 文件

### 模組實作說明
- **[src/README.md](src/README.md)** - 完整模組說明（實作方式、輸入輸出、使用範例）

### 測試
```bash
# FHIR Medication 測試
python test_fhir_medication.py

# LOINC 與臨床指引測試
python test_lab_and_guideline.py
```

---

## 🗂️ 專案架構

```
Taiwan-ICD10-Health-MCP/
├── src/
│   ├── server.py                      # MCP 伺服器（32 tools）
│   ├── icd_service.py                 # ICD-10 服務
│   ├── drug_service.py                # 藥品服務
│   ├── health_food_service.py         # 健康食品服務
│   ├── food_nutrition_service.py      # 營養服務
│   ├── lab_service.py                 # LOINC 檢驗服務
│   ├── clinical_guideline_service.py  # 臨床指引服務
│   ├── fhir_condition_service.py      # FHIR Condition
│   ├── fhir_medication_service.py     # FHIR Medication
│   ├── utils.py                       # 工具函式
│   └── README.md                      # 模組說明文件 📖
├── data/
│   ├── loinc_official/                # LOINC 資料
│   └── lab_reference_ranges.csv       # 檢驗參考值
├── scripts/
│   └── integrate_loinc.py             # LOINC 整合腳本
├── test_fhir_medication.py            # 測試腳本
├── test_lab_and_guideline.py          # 測試腳本
└── README.md                          # 專案說明（本文件）
```

---

## 📊 資料來源

### 台灣官方資料
- 衛福部 ICD-10 中文化資料
- FDA 藥品資料（5 個 API）
- FDA 健康食品資料

### 國際標準
- **FHIR R4** - HL7 International
- **LOINC** - Regenstrief Institute
- **ICD-10** - WHO
- **ATC** - WHO

---

## 🔄 版本資訊

### v1.1.0 (2024-12-25)
- ✨ 新增 FHIR Medication Service
- ✨ 新增 FHIR MedicationKnowledge 支援
- ✨ 新增 4 個 FHIR Medication MCP 工具
- 📚 新增完整模組說明文件

### v1.0.0 (2024-12-20)
- ✨ 初始發布
- ✨ 8 個核心服務模組
- ✨ 28 個 MCP 工具
- ✨ FHIR R4 標準支援

---

## 🤝 貢獻

歡迎貢獻！請遵循以下步驟：

1. Fork 專案
2. 建立功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交變更 (`git commit -m 'Add AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 開啟 Pull Request

### 貢獻方向
- 新增更多 LOINC 中文對照
- 補充臨床診療指引資料
- 實作更多 FHIR 資源
- 改善效能與快取機制

---

## 📝 授權

本專案採用 **MIT License** - 詳見 [LICENSE](LICENSE) 檔案

### 資料授權
- 台灣政府開放資料 - 政府資料開放授權條款
- LOINC - LOINC License（免費用於臨床、研究）
- FHIR - HL7 FHIR License

---

## 📞 聯絡資訊

- **GitHub Issues**: [回報問題](https://github.com/yourusername/Taiwan-ICD10-Health-MCP/issues)
- **文件**: 參閱 [src/README.md](src/README.md)

---

## 🙏 致謝

感謝以下組織提供開放資料：
- 🇹🇼 中華民國衛生福利部
- 🇹🇼 台灣食品藥物管理署 (TFDA)
- 🌍 Regenstrief Institute (LOINC)
- 🌍 HL7 International (FHIR)
- 🌍 World Health Organization (ICD, ATC)

---

**⭐ 如果這個專案對您有幫助，請給我們一個 Star！**
