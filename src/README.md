# src/ — 服務模組說明

本目錄包含 MCP server 入口與所有 11 個服務模組。

---

## 模組一覽

| 檔案 | 服務 | MCP 工具數 |
|------|------|-----------|
| `server.py` | 入口點（FastMCP + lifespan） | 56 |
| `icd_service.py` | ICD-10-CM/PCS 診斷與手術碼 | 4 |
| `drug_service.py` | 台灣 FDA 藥品 | 3 |
| `health_food_service.py` | 台灣 FDA 健康食品 | 2+1 |
| `food_nutrition_service.py` | 食品營養成分 | 4 |
| `fhir_condition_service.py` | FHIR R4 Condition | 3 |
| `fhir_medication_service.py` | FHIR R4 Medication | 4 |
| `lab_service.py` | LOINC 檢驗碼與參考值 | 5 |
| `clinical_guideline_service.py` | 臨床診療指引 | 5 |
| `twcore_service.py` | TWCore IG CodeSystem | 3 |
| `snomed_service.py` | SNOMED CT International | 6 |
| `drug_interaction_service.py` | RxNorm 藥物交互作用 | 3 |

### 跨切面模組

| 檔案 | 說明 |
|------|------|
| `audit.py` | `@audited` 裝飾器 — 稽核日誌（SHA-256 參數雜湊） |
| `cache.py` | `@cached` 裝飾器 — Redis TTL 快取 |
| `database.py` | asyncpg pool 單例（`statement_cache_size=0`） |
| `metrics.py` | Prometheus 指標（Counter/Histogram/Gauge） |
| `utils.py` | 結構化 JSON 日誌（輸出至 stderr） |
| `config.py` | `AppConfig.from_env()` — 環境變數讀取 |

---

## 1. ICD Service（`icd_service.py`）

**資料來源**: `icd.diagnoses`、`icd.procedures`（PostgreSQL）

**主要方法**:
- `search_codes(keyword, type)` — 全文搜尋診斷碼/手術碼
- `infer_complications(code)` — 依 ICD 階層推論併發症
- `get_nearby_codes(code)` — 取得前後相鄰碼
- `get_conflict_info(diagnosis_code, procedure_code)` — 衝突分析

**注意**: `_pcs_available` flag — PCS 資料未載入時工具自動降級，回傳提示訊息而非錯誤。PCS 2025（78,948 筆）已內建於 `fhir-code/icd10pcs/`，`--icd` 自動同時載入。

---

## 2. Drug Service（`drug_service.py`）

**資料來源**: `drug.*`（PostgreSQL），從台灣 FDA Open Data API 同步

**主要方法**:
- `search_drug(keyword)` — FTS 搜尋藥品名稱/適應症
- `get_drug_details_by_license(license_id)` — 完整藥品資訊
- `identify_pill(features)` — 依外觀識別藥錠

**同步**: 啟動時若資料為空或過期（>7天）自動觸發；排程每週二 02:00 UTC。

**兩階段寫入**:
1. 用 shared `httpx.AsyncClient` 抓取所有 5 個端點
2. 單一 `TRUNCATE + INSERT` transaction

**去重**: 寫入前以 `seen_ids` set 對 `license_id` 去重（FDA 資料品質問題）。

**並發保護**: `asyncio.Lock` 防止多個 session 觸發並發同步。

---

## 3. Health Food Service（`health_food_service.py`）

**資料來源**: `health_food.items`（PostgreSQL），從 FDA Open Data 同步

**主要方法**:
- `search_health_food(keyword)` — 搜尋核可健康食品
- `get_health_food_details(permit_no)` — 詳細資訊
- `analyze_health_support_for_condition(diagnosis_keyword, icd_service)` — 疾病-保健食品分析

**排程**: 每週一 02:30 UTC

> ⚠️ 疾病-保健食品對應（`DISEASE_BENEFIT_MAPPING`）為開發者整理，未經醫學審核。

---

## 4. Food Nutrition Service（`food_nutrition_service.py`）

**資料來源**: `food_nutrition.*`（PostgreSQL），從 FDA Open Data 同步

**主要方法**:
- `search_nutrition(food_name, nutrient)` — 搜尋食品營養成分
- `get_detailed_nutrition(food_name)` — 完整營養分析
- `search_food_ingredient(keyword)` — 搜尋食品原料
- `analyze_meal_nutrition(foods)` — 膳食組合分析

**排程**: 每週一 03:00 UTC

---

## 5. FHIR Condition Service（`fhir_condition_service.py`）

**資料來源**: 讀取 `icd_service`

**主要方法**:
- `create_condition(...)` — ICD-10 碼 → FHIR R4 Condition
- `create_condition_from_search(keyword, ...)` — 關鍵字搜尋後建立 Condition
- `validate_condition(condition)` — 基本欄位驗證

---

## 6. FHIR Medication Service（`fhir_medication_service.py`）

**資料來源**: 讀取 `drug_service`

**主要方法**:
- `create_medication(license_id)` — FHIR R4 Medication
- `create_medication_knowledge(license_id)` — FHIR R4 MedicationKnowledge（含 ATC、適應症）
- `create_medication_from_search(keyword, resource_type)` — 搜尋後建立
- `validate_medication(resource)` — 驗證

---

## 7. Lab Service（`lab_service.py`）

**資料來源**: `loinc.*`（PostgreSQL），需 data-loader `--loinc`

**主要方法**:
- `search_loinc_code(keyword, category)` — 搜尋 LOINC 碼
- `list_categories()` — 列出所有分類
- `get_reference_range(loinc_code, age, gender)` — 參考值
- `interpret_lab_result(loinc_code, value, age, gender)` — 結果判讀
- `batch_interpret_results(results, age, gender)` — 批次判讀

---

## 8. Clinical Guideline Service（`clinical_guideline_service.py`）

**資料來源**: `guideline.*`（PostgreSQL），需 data-loader `--guideline`

**主要方法**:
- `search_guideline(keyword)` — 指引搜尋
- `get_complete_guideline(icd_code)` — 完整指引
- `get_medication_recommendations(icd_code)` — 用藥建議
- `get_test_recommendations(icd_code)` — 建議檢查
- `get_treatment_goals(icd_code)` — 治療目標
- `suggest_clinical_pathway(icd_code, context)` — 臨床路徑

---

## 9. TWCore Service（`twcore_service.py`）

**資料來源**: `twcore.*`（PostgreSQL），需 data-loader `--twcore`；資料不存在時降級為即時抓取

**主要方法**:
- `list_codesystems(category)` — 列出所有 TWCore CodeSystem
- `search_code(keyword, codesystem_ids)` — 跨系統搜尋代碼
- `lookup_code(code, codesystem_id)` — 精確查詢（回傳 FHIR Coding）

---

## 10. SNOMED Service（`snomed_service.py`）

**資料來源**: `snomed.*`（PostgreSQL），需 data-loader `--snomed`

**主要方法**:
- `search_concepts(query, limit, hierarchy_filter)` — FTS 搜尋 + 選用階層篩選
- `get_concept(concept_id)` — FSN、同義詞、父概念、ICD-10 對應
- `get_children(concept_id, limit)` — 直接子概念（IS-A）
- `get_ancestors(concept_id, max_depth)` — 所有祖先（遞迴 CTE）
- `map_icd_to_snomed(icd_code)` — ICD-10 → SNOMED
- `map_snomed_to_icd(concept_id)` — SNOMED → ICD-10

**常數**: `FSN_TYPE = 900000000000003001`, `IS_A_TYPE = 116680003`

---

## 11. Drug Interaction Service（`drug_interaction_service.py`）

**資料來源**: `rxnorm.*`（PostgreSQL），需 data-loader `--rxnorm`

**主要方法**:
- `check_interactions(drug_names)` — 解析藥品名稱 → RXCUI → 查詢 `interacts_with`
- `resolve_drug(drug_name)` — FTS 解析藥品名稱為 RxNorm 概念
- `get_drug_ingredients(rxcui)` — 藥物成分查詢（追蹤 `has_ingredient` 關係）

**注意**: RxNorm `interacts_with` 不含嚴重程度評級，僅表示潛在交互作用，須臨床確認。

---

## server.py — 入口點

`FastMCP` 實例化後掛載 lifespan，lifespan 使用 `_init_lock + _initialized` 確保只在第一個 session 時執行初始化（FastMCP streamable-http 模式對每個 session 執行 lifespan）。

啟動順序：
1. Prometheus metrics server（非 stdio 模式）
2. asyncpg pool（透過 pgBouncer，`statement_cache_size=0`）
3. Redis client
4. DB pool stats collector（background task）
5. 11 個服務初始化（各自 try/except，失敗服務降級）
6. Redis warm-up cache
