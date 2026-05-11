# TWCore IG 工具 (TWCore Tools)

此類別工具提供臺灣核心實作指引 (TW Core IG) 的即時代碼查詢功能，即時從官方 IG 取得最新資料，涵蓋 30 個 CodeSystem。

資料來源: [https://twcore.mohw.gov.tw/ig/twcore/](https://twcore.mohw.gov.tw/ig/twcore/)

---

## list_twcore_codesystems

列出 TWCore 所有可用的 CodeSystem 清單（30 個官方標準代碼系統）。

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `category` | string | 否 | 篩選分類，預設 `"all"` | `"medication"` |

**category 可選值：**

| 值 | 說明 | 涵蓋 CodeSystem 數 |
| :--- | :--- | ---: |
| `all` | 全部（預設） | 30 |
| `medication` | 藥品相關（使用頻率、給藥途徑、品項、ATC碼） | 7 |
| `diagnosis` | 診斷分類（ICD-10-CM/PCS、ICD-9） | 7 |
| `organization` | 醫療機構/人員/科別 | 5 |
| `administrative` | 行政/人口（郵遞區號、婚姻、職業） | 7 |
| `technical` | 系統/技術（照護計畫、識別碼） | 4 |

### 回傳範例

```json
{
  "category": "medication",
  "total": 7,
  "codesystems": [
    {
      "id": "medication-frequency-nhi-tw",
      "name": "藥品使用頻率",
      "url": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-frequency-nhi-tw",
      "json_endpoint": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem-medication-frequency-nhi-tw.json"
    }
  ]
}
```

---

## search_twcore_medication

搜尋 TWCore 藥品相關標準代碼，即時從官方 IG 取得最新資料。

涵蓋 7 個 CodeSystem：
- 藥品使用頻率（QD、BID、TID、AC、PC、PRN 等）
- 給藥途徑（口服、注射、外用等）
- 健保用藥品項
- 中藥用藥品項
- 食藥署藥品許可證
- 醫療器材許可證
- ATC 藥理治療分類碼

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 是 | 搜尋關鍵字（代碼或中文說明） | `"BID"`, `"口服"`, `"中藥"` |

### 回傳範例

```json
{
  "keyword": "BID",
  "results": [
    {
      "code": "BID",
      "display": "每日兩次",
      "codesystem": "medication-frequency-nhi-tw",
      "fhir_system": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-frequency-nhi-tw"
    }
  ],
  "total": 1
}
```

---

## search_twcore_diagnosis

搜尋 TWCore 診斷/處置分類標準代碼，涵蓋多版本 ICD。

涵蓋 7 個 CodeSystem：
- ICD-10-CM 2023 / 2021 / 2014 版（疾病診斷碼）
- ICD-10-PCS 2023 / 2021 / 2014 版（處置碼）
- ICD-9-CM 2001 版

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 是 | ICD 碼或疾病名稱 | `"E11"`, `"糖尿病"`, `"K35"` |

### 回傳範例

```json
{
  "keyword": "E11",
  "results": [
    {
      "code": "E11",
      "display": "第二型糖尿病",
      "codesystem": "icd-10-cm-2023-tw",
      "version": "2023",
      "fhir_system": "http://hl7.org/fhir/sid/icd-10-cm"
    }
  ],
  "total": 1
}
```

---

## search_twcore_organization

搜尋 TWCore 醫療機構、人員、科別標準代碼。

涵蓋 5 個 CodeSystem：
- 醫事人員類別（醫師、護理師、藥師等）
- 醫事機構代碼
- 就醫科別（門診掛號科別）
- 診療科別
- 醫療服務給付項目

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 是 | 搜尋關鍵字 | `"內科"`, `"藥師"`, `"家醫科"` |

---

## search_twcore_administrative

搜尋 TWCore 行政/人口統計標準代碼。

涵蓋 7 個 CodeSystem：
- 郵遞區號（3碼 / 5碼 / 6碼）
- 婚姻狀態
- 行業分類（主計總處）
- 職業分類（壽險公會、勞動部）

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 是 | 搜尋關鍵字 | `"台北"`, `"100"`, `"已婚"`, `"工程師"` |

---

## lookup_twcore_code

精確查詢單一代碼，回傳完整資訊及 FHIR Coding 格式。

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `code` | string | 是 | 代碼（大小寫不敏感） | `"BID"`, `"E11"` |
| `codesystem_id` | string | 是 | CodeSystem ID（從 `list_twcore_codesystems` 取得） | `"medication-frequency-nhi-tw"` |

**常用 CodeSystem ID：**

| ID | 說明 |
| :--- | :--- |
| `medication-frequency-nhi-tw` | 藥品使用頻率 |
| `medication-path-tw` | 給藥途徑 |
| `medical-consultation-department-nhi-tw` | 就醫科別 |
| `icd-10-cm-2023-tw` | ICD-10-CM 2023 版 |
| `icd-10-pcs-2023-tw` | ICD-10-PCS 2023 版 |

### 回傳範例

```json
{
  "code": "BID",
  "display": "每日兩次",
  "codesystem_id": "medication-frequency-nhi-tw",
  "version": "2024",
  "fhir_coding": {
    "system": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-frequency-nhi-tw",
    "code": "BID",
    "display": "每日兩次"
  }
}
```
