# FDA 藥品不良反應工具 (FDA Adverse Events Tools)

此類別工具即時查詢 openFDA FAERS（FDA Adverse Event Reporting System）資料庫，提供全球藥品不良反應報告、安全性摘要與召回紀錄。

資料來源: [openFDA Drug API](https://open.fda.gov/apis/drug/)  
速率限制: 240 req/min（無 API key）

!!! warning "免責聲明"
    此資料來自 FDA 自發性不良反應報告系統（FAERS），報告存在因果關係未確立、漏報、重複報告等限制，**不代表藥品與不良反應之間存在確定的因果關係**。臨床決策仍須參考完整的藥品仿單與專業醫療意見。

---

## search_adverse_events

搜尋特定藥品的不良反應報告，回傳個別報告的詳細資訊。

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `drug_name` | string | 是 | 藥品名稱（英文通用名或商品名） | `"warfarin"`, `"aspirin"` |
| `limit` | integer | 否 | 回傳筆數，預設 10，最多 100 | `20` |

### 回傳欄位

| 欄位 | 說明 |
| :--- | :--- |
| `report_id` | FDA 安全報告編號 |
| `report_date` | 報告收受日期 |
| `serious` | 是否為嚴重不良反應（1=是） |
| `serious_criteria.death` | 是否造成死亡 |
| `serious_criteria.hospitalization` | 是否導致住院 |
| `serious_criteria.life_threatening` | 是否危及生命 |
| `serious_criteria.disability` | 是否造成永久失能 |
| `reactions` | 不良反應列表（MedDRA 術語） |
| `drugs_involved` | 同時使用的藥品列表（最多 10 筆） |
| `patient_age` | 病患年齡 |
| `patient_sex` | 病患性別（1=男, 2=女） |
| `country` | 報告來源國家 |

### 回傳範例

```json
{
  "drug_name": "warfarin",
  "count": 10,
  "total": 284523,
  "results": [
    {
      "report_id": "18362849",
      "report_date": "20240115",
      "serious": "1",
      "serious_criteria": {
        "death": null,
        "hospitalization": "1",
        "life_threatening": null,
        "disability": null
      },
      "reactions": ["HAEMORRHAGE", "INTERNATIONAL NORMALISED RATIO INCREASED"],
      "drugs_involved": ["WARFARIN", "AMIODARONE"],
      "patient_age": "72",
      "patient_sex": "1",
      "country": "US"
    }
  ]
}
```

---

## get_drug_safety_summary

取得藥品安全性摘要，包含最常見不良反應排行、總報告數、嚴重報告比率。

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `drug_name` | string | 是 | 藥品名稱（英文） | `"metformin"` |

### 回傳欄位

| 欄位 | 說明 |
| :--- | :--- |
| `total_adverse_event_reports` | 全球不良反應報告總數 |
| `serious_reports` | 嚴重報告數 |
| `serious_rate` | 嚴重報告比率（%） |
| `top_reactions` | 最常見不良反應 TOP 15（依報告次數排序） |
| `data_source` | 資料來源（openFDA / FAERS） |
| `disclaimer` | 免責聲明 |

### 回傳範例

```json
{
  "drug_name": "metformin",
  "total_adverse_event_reports": 43821,
  "serious_reports": 18294,
  "serious_rate": "41.7%",
  "top_reactions": [
    { "reaction": "LACTIC ACIDOSIS", "count": 892 },
    { "reaction": "NAUSEA", "count": 743 },
    { "reaction": "DIARRHOEA", "count": 681 }
  ],
  "data_source": "openFDA (FAERS)",
  "disclaimer": "此資料來自 FDA 自發性不良反應報告系統，不代表因果關係確立。"
}
```

---

## check_drug_recall

查詢藥品在 FDA 的召回紀錄（Class I / II / III）。

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `drug_name` | string | 是 | 藥品名稱（英文） | `"metformin"` |

### 召回等級說明

| 等級 | 風險程度 |
| :--- | :--- |
| Class I | 最嚴重，使用可能導致嚴重健康危害或死亡 |
| Class II | 可能造成暫時性或可逆性健康危害 |
| Class III | 不太可能造成健康危害，但違反 FDA 規定 |

### 回傳欄位

| 欄位 | 說明 |
| :--- | :--- |
| `recall_number` | FDA 召回編號 |
| `recall_initiation_date` | 召回啟動日期 |
| `status` | 召回狀態（Ongoing / Completed） |
| `classification` | 召回等級（Class I / II / III） |
| `product_description` | 產品描述 |
| `reason_for_recall` | 召回原因 |
| `recalling_firm` | 召回廠商 |
| `distribution_pattern` | 發行範圍 |
| `voluntary_mandated` | 自願/強制召回 |

### 回傳範例

```json
{
  "drug_name": "metformin",
  "count": 3,
  "total": 3,
  "recalls": [
    {
      "recall_number": "Z-0123-2024",
      "recall_initiation_date": "20240301",
      "status": "Completed",
      "classification": "Class II",
      "product_description": "Metformin HCl Tablets, 500mg",
      "reason_for_recall": "NDMA impurity above acceptable daily intake level",
      "recalling_firm": "XYZ Pharmaceuticals",
      "distribution_pattern": "Nationwide",
      "voluntary_mandated": "Voluntary: Firm initiated"
    }
  ],
  "note": "Class I: 最嚴重（可能致命）, Class II: 可能暫時性危害, Class III: 輕微"
}
```
