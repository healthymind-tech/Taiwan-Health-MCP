# FHIR IG 服務模組 (FHIR IG Service)

## 模組概述
FHIR IG 服務模組是一套通用、以 IG 為範圍（IG-scoped）的工具集，建構於多 IG（multi-IG）的 `fhir.*` 資料儲存之上。它讓 LLM 能探索已安裝的 Implementation Guide、讀取剖面（StructureDefinition）與術語（ValueSet / CodeSystem）、進行術語驗證，並以「骨架填值」（skeleton-fill）方式產生與驗證符合剖面的 FHIR R4 資源。預設 IG 為 TWCore v1.0.0，但可安裝並切換多個 IG。

每個工具都可帶入選用的 `package_id` + `version`（皆省略時鎖定預設 IG），回應採用共同信封：`{ok, data, warnings, provenance, error?}`。

## 工具分組

### 1. IG 探索
- **`fhir_list_igs`**：列出已安裝的 IG 套件，含 `packageId`、`version`、`title`、`canonical`、`fhirVersion`、`status`、`isDefault` 與宣告的相依套件。多個 IG 並存時先用此工具挑選。
- **`fhir_get_ig`**：單一 IG 的詳情，含身分、相依與各資源型別的 artifact 數量。
- **`fhir_list_artifacts`**：以摘要列出 IG 的 conformance artifacts（StructureDefinition / ValueSet / CodeSystem / examples…），可依 `resource_type` 或 `grouping_id` 過濾。
- **`fhir_search_artifacts`**：以 id / canonical URL / name / title / description 全文搜尋 artifacts。

### 2. 剖面選擇與讀取
- **`fhir_list_resource_profiles`**：列出 IG 可選的資源剖面（constraint StructureDefinition），依其約束的基礎資源型別分組（例如 `Patient` → `Patient-twcore`）。
- **`fhir_rank_resource_profiles`**：依你打算填入的來源欄位鍵（keys）與各剖面 element path 的吻合度，對候選剖面排名。此工具**僅供建議**，回應帶有 `selectionRequired:true`，最終仍須自行挑選，不會自動對應。
- **`fhir_get_profile`**：單一剖面 / StructureDefinition 的摘要（身分、base definition、derivation、element 數）。可用 artifact id、canonical URL 或 artifact_key 解析；相依 IG 定義的 canonical 會遞移解析。
- **`fhir_get_profile_elements`**：讀取剖面 snapshot 的結構真相（cardinality、types、bindings、slicing、choice[x]、constraints）。同一工具提供多種 `view`：`elements`、`element`、`slices`、`choices`、`binding`、`examples`。

### 3. 術語 / ValueSet
- **`fhir_get_valueset`**：取得 ValueSet 定義摘要。
- **`fhir_expand_valueset`**：展開 ValueSet，列出實際成員碼。
- **`fhir_lookup_code`**：在指定 CodeSystem 中查詢單一碼的顯示名稱與屬性。
- **`fhir_validate_code`**：驗證某 `system`+`code` 是否屬於指定 ValueSet。
- **`fhir_normalize_code`**：以自由文字（例如「流行性感冒」）對照 ValueSet，回傳最合適的標準碼。

### 4. 授權、組裝與驗證
- **`fhir_get_resource_skeleton`**：依剖面產生「骨架」資源—僅含必填 / mustSupport 結構的空白草稿，供逐步填值。
- **`fhir_finalize_resource`**：將草稿（draft）依剖面定稿，補齊結構並回傳完整資源。
- **`fhir_resolve_reference`**：以暫時鍵（key）解析資源參照，供 Bundle 內互相連結。
- **`fhir_build_bundle`**：將多筆資源組裝為 `transaction` / `collection` 等型別的 Bundle。
- **`fhir_validate_resource`**：依 `meta.profile` 指定的剖面驗證單一資源（結構 + 術語綁定）。
- **`fhir_validate_bundle`**：驗證整個 Bundle。

## 技術架構
- **資料來源**：FHIR IG 套件（`package.tgz`），經由管理後台（Admin → Modules / IG，匯入階段 `--twcore`）匯入。相依套件（如 `hl7.terminology.r4`、`hl7.fhir.r4.core`）可額外綁定並各自以 package-scoped IG 索引，使跨系統的 ValueSet 綁定能展開出真實碼。
- **資料庫**：`fhir` schema —`ig_packages`、`codesystems`、`concepts`、`artifacts`（皆 package-scoped，支援多 IG）。
- **驗證引擎**：以 `fhir_validator.py` / `fhir_terminology.py` / `fhir_snapshot.py` / `fhir_reference.py` / `fhir_authoring.py` 在程序內完成 snapshot 產生、術語綁定檢查、參照解析與骨架填值。

## 授權工作流程（建議）
1. `fhir_list_igs` →（必要時）選定目標 IG。
2. `fhir_list_resource_profiles` / `fhir_rank_resource_profiles` → 挑選剖面。
3. `fhir_get_profile_elements`（`choices` / `binding` / `slices`）→ 了解結構與術語約束。
4. `fhir_get_resource_skeleton` → 取得骨架，逐步填入欄位（必要時用 `fhir_normalize_code` / `fhir_validate_code` 處理編碼）。
5. `fhir_finalize_resource` → 定稿；多筆資源以 `fhir_resolve_reference` + `fhir_build_bundle` 組裝。
6. `fhir_validate_resource` / `fhir_validate_bundle` → 驗證。

## 關鍵限制
- 程序內驗證以剖面 snapshot 與術語綁定為基礎，**不**等同官方 HL7 FHIR Validator 的一致性認證。
- 工具僅提供建議與結構協助，剖面選擇與最終內容由呼叫端負責。

> 進階說明見 [FHIR Authoring Walkthrough](../fhir-authoring-walkthrough.md)。
