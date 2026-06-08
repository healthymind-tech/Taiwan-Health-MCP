# SNOMED CT 服務模組 (SNOMED Service)

## 模組概述
SNOMED CT 服務模組整合 SNOMED CT International 版術語，提供概念搜尋、概念詳情、關聯（階層與屬性）查詢，以及 SNOMED ↔ ICD-10 對應。SNOMED CT 是目前涵蓋面最廣的臨床術語系統，本模組讓系統能以標準概念表達臨床語意並與 ICD-10 互通。

## 主要功能

### 1. 概念搜尋（`search_snomed_concept`）
以中英文關鍵字搜尋 SNOMED CT 概念，回傳 concept ID、FSN（完整指定名稱）與 preferred term。支援語意 / 混合搜尋（需 Ollama 嵌入服務），無嵌入時退回關鍵字。

### 2. 概念詳情（`query_snomed_concept`）
以 concept ID 取得單一概念的完整資訊，包含：
- **FSN 與 preferred term**
- **祖先（ancestors）**：沿 `is-a` 階層往上的概念與深度。
- **子概念（children）**：直接子代概念。

### 3. 關聯查詢（`get_snomed_relationships`）
取得某概念的所有關聯，依關聯類型（relationship type）分組，列出每個屬性的目標概念，例如 finding site、associated morphology 等。

### 4. SNOMED ↔ ICD-10 對應（`query_snomed_mapping`）
雙向對應：
- **`mode="icd"`**：輸入 ICD-10 碼（例如 `E11.9`），回傳對應的 SNOMED 概念。
- **`mode="snomed"`**：輸入 SNOMED concept ID（例如 `44054006`），回傳對應的 ICD-10 對照。

## 技術架構
- **資料來源**：SNOMED CT International RF2（`SnomedCT_InternationalRF2_PRODUCTION_*.zip`），由 data-loader `--snomed` 載入（資料量大，約 5–15 分鐘）。
- **資料庫**：`snomed` schema，含 `concepts`、`descriptions`、`relationships`、`icd10_map`、`historical_associations` 與 `concept_embeddings`。
- **可用性閘門**：`snomed.concepts` 需達門檻（10 萬筆）才會註冊對應工具，否則自動降級。

## 關鍵限制
- 使用 SNOMED CT 需要有效的 SNOMED International 授權（多數用途免費）。未載入資料時相關工具不會啟用。
