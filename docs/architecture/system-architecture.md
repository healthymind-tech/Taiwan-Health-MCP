# 系統架構

本文件說明 Taiwan ICD10 Health MCP 的完整系統架構設計。

---

## 📐 整體架構

```mermaid
graph TB
    subgraph "Client Layer 使用者層"
        A1[Claude AI]
        A2[其他 MCP 客戶端]
    end

    subgraph "Protocol Layer MCP 協議層"
        B[MCP Server<br/>32 MCP Tools]
    end

    subgraph "Service Layer 服務層"
        C1[ICD Service]
        C2[Drug Service]
        C3[Health Food Service]
        C4[Food Nutrition Service]
        C5[FHIR Condition Service]
        C6[FHIR Medication Service]
        C7[Lab Service]
        C8[Clinical Guideline Service]
    end

    subgraph "Data Access Layer 資料存取層"
        D1[(ICD-10 DB<br/>SQLite)]
        D2[(Drugs DB<br/>SQLite)]
        D3[(Health Foods DB<br/>SQLite)]
        D4[(Nutrition DB<br/>SQLite)]
        D5[(Lab Tests DB<br/>SQLite)]
        D6[(Guidelines DB<br/>SQLite)]
    end

    subgraph "External Data Sources 外部資料源"
        E1[台灣 FDA API<br/>5 個資料集]
        E2[LOINC Official<br/>87,000+ 項]
        E3[衛福部 ICD-10<br/>Excel]
        E4[Taiwan Nutrition DB<br/>食品營養資料]
    end

    A1 --> B
    A2 --> B

    B --> C1
    B --> C2
    B --> C3
    B --> C4
    B --> C5
    B --> C6
    B --> C7
    B --> C8

    C1 --> D1
    C2 --> D2
    C3 --> D3
    C4 --> D4
    C7 --> D5
    C8 --> D6

    C5 -.依賴.-> C1
    C6 -.依賴.-> C2

    E1 -.同步.-> D2
    E2 -.整合.-> D5
    E3 -.匯入.-> D1
    E4 -.匯入.-> D4

    style A1 fill:#e1f5ff
    style A2 fill:#e1f5ff
    style B fill:#fff3e0
    style C1 fill:#f3e5f5
    style C2 fill:#f3e5f5
    style C3 fill:#f3e5f5
    style C4 fill:#f3e5f5
    style C5 fill:#e8f5e9
    style C6 fill:#e8f5e9
    style C7 fill:#f3e5f5
    style C8 fill:#f3e5f5
    style D1 fill:#fff9c4
    style D2 fill:#fff9c4
    style D3 fill:#fff9c4
    style D4 fill:#fff9c4
    style D5 fill:#fff9c4
    style D6 fill:#fff9c4
    style E1 fill:#ffebee
    style E2 fill:#ffebee
    style E3 fill:#ffebee
    style E4 fill:#ffebee
```

---

## 🏗️ 分層架構

### 1. Client Layer (使用者層)

負責與 MCP Server 進行通訊的客戶端。

| 客戶端 | 說明 |
|--------|------|
| **Claude AI** | 主要客戶端，透過 MCP 協議調用工具 |
| **其他 MCP 客戶端** | 任何支援 MCP 協議的應用程式 |

**特點**:

- ✅ 標準化 MCP 協議
- ✅ 支援多客戶端同時連線
- ✅ 即時回應

---

### 2. Protocol Layer (MCP 協議層)

實作 Model Context Protocol (MCP) 標準。

```python
# MCP Server 初始化
mcp = FastMCP("taiwanHealthMcp")

# 工具註冊範例
@mcp.tool()
def search_medical_codes(keyword: str, type: str = "all") -> str:
    """搜尋 ICD-10 診斷/手術碼"""
    return icd_service.search_codes(keyword, type)
```

**功能**:

- 🔹 32 個 MCP Tools
- 🔹 工具註冊與管理
- 🔹 參數驗證
- 🔹 錯誤處理
- 🔹 日誌記錄

**工具分組**:

| 群組 | 數量 | 說明 |
|------|------|------|
| ICD-10 工具 | 4 | 診斷/手術碼相關 |
| 藥品工具 | 3 | FDA 藥品資料 |
| 健康食品工具 | 2 | 健康食品管理 |
| 營養工具 | 5 | 食品營養分析 |
| FHIR 工具 | 7 | FHIR 資源轉換 |
| 檢驗工具 | 5 | LOINC 與檢驗判讀 |
| 臨床指引工具 | 5 | 診療指引查詢 |
| 綜合分析工具 | 1 | 跨模組整合 |

---

### 3. Service Layer (服務層)

核心業務邏輯實作層。

#### 3.1 ICD Service

```mermaid
classDiagram
    class ICDService {
        +excel_path: str
        +data_dir: str
        +db_path: str
        +search_codes(keyword, type) dict
        +infer_complications(code) dict
        +get_nearby_codes(code) dict
        +get_conflict_info(diag_code, proc_code) dict
    }
```

**職責**:

- ICD-10-CM/PCS 資料管理
- 診斷碼搜尋與推論
- FTS5 全文檢索

#### 3.2 Drug Service

```mermaid
classDiagram
    class DrugService {
        +data_dir: str
        +db_path: str
        +search_drug(keyword) dict
        +get_drug_details_by_license(license_id) dict
        +identify_pill_by_appearance(features) dict
    }
```

**職責**:

- 整合 5 個 FDA API
- 藥品資料管理
- 外觀識別

#### 3.3 FHIR Services

```mermaid
classDiagram
    class FHIRConditionService {
        +icd_service: ICDService
        +create_condition(...) dict
        +validate_condition(condition) dict
    }

    class FHIRMedicationService {
        +drug_service: DrugService
        +create_medication(...) dict
        +create_medication_knowledge(...) dict
    }

    FHIRConditionService --> ICDService
    FHIRMedicationService --> DrugService
```

**職責**:

- FHIR R4 資源轉換
- 資源驗證
- 標準化輸出

#### 3.4 Lab Service

```mermaid
classDiagram
    class LabService {
        +data_dir: str
        +db_path: str
        +search_loinc_code(keyword) dict
        +get_reference_range(loinc_code, age, gender) dict
        +interpret_lab_result(...) dict
    }
```

**職責**:

- LOINC 碼管理
- 參考值查詢
- 結果判讀

#### 3.5 Clinical Guideline Service

```mermaid
classDiagram
    class ClinicalGuidelineService {
        +data_dir: str
        +db_path: str
        +search_guideline(keyword) dict
        +get_complete_guideline(icd_code) dict
        +suggest_clinical_pathway(...) dict
    }
```

**職責**:

- 臨床指引管理
- 用藥建議
- 臨床路徑規劃

---

### 4. Data Access Layer (資料存取層)

使用 SQLite 資料庫儲存與管理資料。

#### 資料庫架構

```mermaid
erDiagram
    ICD10_DB ||--o{ DIAGNOSIS : contains
    ICD10_DB ||--o{ PROCEDURE : contains

    DRUGS_DB ||--o{ LICENSES : contains
    DRUGS_DB ||--o{ APPEARANCE : contains
    DRUGS_DB ||--o{ INGREDIENTS : contains
    DRUGS_DB ||--o{ ATC : contains
    DRUGS_DB ||--o{ DOCUMENTS : contains

    LAB_TESTS_DB ||--o{ LOINC_MAPPING : contains
    LAB_TESTS_DB ||--o{ REFERENCE_RANGES : contains

    GUIDELINES_DB ||--o{ DISEASE_GUIDELINES : contains
    GUIDELINES_DB ||--o{ MEDICATION_RECOMMENDATIONS : contains
```

#### 資料表結構

=== "ICD-10 DB"

    | 表名 | 主要欄位 | 索引 |
    |------|---------|------|
    | `diagnosis` | code, name_zh, name_en | code, FTS5 |
    | `procedure` | code, name_zh, name_en | code, FTS5 |

=== "Drugs DB"

    | 表名 | 主要欄位 | 索引 |
    |------|---------|------|
    | `licenses` | license_id, name_zh, indication | license_id, FTS5 |
    | `appearance` | license_id, shape, color, marking | license_id |
    | `ingredients` | license_id, ingredient_name, content | license_id |
    | `atc` | license_id, atc_code | atc_code |

=== "Lab Tests DB"

    | 表名 | 主要欄位 | 索引 |
    |------|---------|------|
    | `loinc_mapping` | loinc_code, loinc_name_zh, category | loinc_code, FTS5 |
    | `reference_ranges` | loinc_code, age_min, age_max, gender, range_low, range_high | loinc_code |

=== "Guidelines DB"

    | 表名 | 主要欄位 | 索引 |
    |------|---------|------|
    | `disease_guidelines` | icd_code, title, publisher | icd_code |
    | `medication_recommendations` | icd_code, drug_class, dosage | icd_code |
    | `test_recommendations` | icd_code, loinc_code, frequency | icd_code |

---

### 5. External Data Sources (外部資料源)

#### 台灣 FDA API

```mermaid
sequenceDiagram
    participant DS as Drug Service
    participant API as FDA API
    participant DB as Drugs DB

    DS->>API: GET /api/36 (許可證)
    API-->>DS: JSON Data
    DS->>API: GET /api/42 (外觀)
    API-->>DS: JSON Data
    DS->>API: GET /api/43 (成分)
    API-->>DS: JSON Data
    DS->>API: GET /api/41 (ATC)
    API-->>DS: JSON Data
    DS->>API: GET /api/39 (仿單)
    API-->>DS: JSON Data

    DS->>DB: INSERT/UPDATE
    DB-->>DS: Success
```

**API 列表**:

| API | 內容 | 更新頻率 |
|-----|------|---------|
| API 36 | 藥品許可證基本資料 | 每日 |
| API 42 | 藥品外觀資料 | 每週 |
| API 43 | 藥品成分資料 | 每日 |
| API 41 | ATC 藥物分類 | 每月 |
| API 39 | 藥品仿單/說明書 | 每週 |

#### LOINC Official

```mermaid
sequenceDiagram
    participant User as 使用者
    participant Script as integrate_loinc.py
    participant LOINC as LOINC CSV
    participant Mapping as Taiwan Mapping
    participant DB as Lab Tests DB

    User->>LOINC: 下載 Loinc.csv
    LOINC-->>User: 200 MB CSV

    User->>Script: 執行整合腳本
    Script->>LOINC: 讀取官方資料
    Script->>Mapping: 讀取台灣對照
    Script->>Script: 合併資料
    Script->>DB: 建立資料庫
    DB-->>Script: Success

    Script-->>User: 整合完成
```

---

## 🔄 資料流程

### 完整診療流程

```mermaid
sequenceDiagram
    participant User as 使用者 (Claude)
    participant MCP as MCP Server
    participant ICD as ICD Service
    participant FHIR1 as FHIR Condition
    participant GL as Guideline Service
    participant Drug as Drug Service
    participant FHIR2 as FHIR Medication
    participant Lab as Lab Service

    User->>MCP: 搜尋診斷: "糖尿病"
    MCP->>ICD: search_codes("糖尿病")
    ICD-->>MCP: E11.9 第二型糖尿病
    MCP-->>User: 診斷結果

    User->>MCP: 建立 FHIR Condition
    MCP->>FHIR1: create_condition(E11.9)
    FHIR1->>ICD: get_diagnosis_info(E11.9)
    ICD-->>FHIR1: 診斷詳細資訊
    FHIR1-->>MCP: FHIR Condition 資源
    MCP-->>User: FHIR JSON

    User->>MCP: 查詢臨床指引
    MCP->>GL: get_complete_guideline(E11)
    GL-->>MCP: 診斷建議、用藥建議、檢查建議
    MCP-->>User: 完整指引

    User->>MCP: 搜尋建議藥品
    MCP->>Drug: search_drug("Metformin")
    Drug-->>MCP: 藥品清單
    MCP-->>User: 搜尋結果

    User->>MCP: 建立 FHIR Medication
    MCP->>FHIR2: create_medication_from_search("Metformin")
    FHIR2->>Drug: get_drug_details()
    Drug-->>FHIR2: 藥品詳細資訊
    FHIR2-->>MCP: FHIR Medication 資源
    MCP-->>User: FHIR JSON

    User->>MCP: 判讀檢驗結果
    MCP->>Lab: interpret_lab_result(HbA1c, 7.2)
    Lab-->>MCP: 偏高，需調整用藥
    MCP-->>User: 判讀結果
```

---

## 🔒 安全性設計

### 資料隱私

- ✅ 不儲存患者個人資料
- ✅ FHIR 資源使用假名化 ID
- ✅ 本地資料庫，不上傳雲端

### API 安全

- ✅ 公開 API 資料（FDA, LOINC）
- ✅ 無需 API Key
- ✅ Rate Limiting 機制

### 資料完整性

- ✅ SQLite ACID 特性
- ✅ 資料驗證機制
- ✅ 錯誤處理與日誌

---

## ⚡ 效能優化

### 快取策略

```python
# FTS5 全文檢索索引
CREATE VIRTUAL TABLE diagnosis_fts USING fts5(
    code, name_zh, name_en
);

# 一般索引
CREATE INDEX idx_license_id ON licenses(license_id);
CREATE INDEX idx_loinc_code ON loinc_mapping(loinc_code);
```

### 資料庫優化

- ✅ FTS5 全文檢索
- ✅ 適當的索引設計
- ✅ 查詢優化
- ✅ 連線池管理

---

## 📊 擴展性設計

### 水平擴展

```mermaid
graph LR
    LB[Load Balancer] --> S1[MCP Server 1]
    LB --> S2[MCP Server 2]
    LB --> S3[MCP Server 3]

    S1 --> DB[(Shared DB)]
    S2 --> DB
    S3 --> DB
```

### 垂直擴展

- 增加記憶體 → 更大的快取
- 增加 CPU → 更快的查詢
- SSD 硬碟 → 更快的 I/O

---

## 🔮 未來架構規劃

### Phase 2: 微服務化

```mermaid
graph TB
    Gateway[API Gateway]

    Gateway --> ICD[ICD Service]
    Gateway --> Drug[Drug Service]
    Gateway --> FHIR[FHIR Service]
    Gateway --> Lab[Lab Service]

    ICD --> Cache1[(Redis Cache)]
    Drug --> Cache2[(Redis Cache)]

    ICD --> DB1[(PostgreSQL)]
    Drug --> DB2[(PostgreSQL)]
```

### Phase 3: 雲端部署

- ☁️ Kubernetes 編排
- 🔄 自動擴展
- 📊 分散式追蹤
- 🔐 進階安全機制

---

## 📖 相關文件

- [資料流程圖](data-flow.md)
- [模組關係圖](module-relations.md)
- [部署架構](deployment.md)

---

!!! info "架構演進"
    本架構設計支援從單機部署到雲端微服務的平滑演進。

    當前版本專注於功能完整性與標準化，未來將逐步引入更多企業級特性。
