# FHIR IG 服務模組 (FHIR IG Service)

## 模組概述
FHIR IG 服務模組是一套通用、以 IG 為範圍（IG-scoped）的工具集，建構於多 IG（multi-IG）的 `fhir.*` 資料儲存之上。它讓 LLM 能探索已安裝的 Implementation Guide、讀取剖面（StructureDefinition）與術語（ValueSet / CodeSystem）、進行術語驗證，並以「骨架填值」（skeleton-fill）方式產生與驗證符合剖面的 FHIR R4 資源。預設 IG 為 TWCore v1.0.0，但可安裝並切換多個 IG。

每個工具都可帶入選用的 `package_id` + `version`，回應採用共同信封：`{ok, data, warnings, provenance, error?}`。

### 目標套件的解析順序
未明確指定時，工具依下列優先順序決定要用哪個 IG 套件，並把結果寫在 `provenance.resolved_by`：

1. `explicit_version`：canonical 參數（或 `meta.profile`）帶 `|version`，且有已安裝套件持有該版本——**不會**悄悄改用其他版本；
2. `package_arg`：呼叫端給了 `package_id`（+ `version`）；`latest`：只給 `package_id` 未給版本時，取該套件最高的正式版；
3. `meta_profile`：未給 `package_id` 時，改用持有該資源 `meta.profile` 的套件（驗證工具）；
4. `canonical_owner`：未給 `package_id` 時，改用持有 canonical 參數（profile / ValueSet / system）的套件；
5. `default_ig`：預設 IG；
6. `sole_manual_ig`：未設定預設 IG、且恰好只有一個手動安裝的 IG。

都不成立時回傳錯誤碼 `NO_DEFAULT_IG`（不會任意挑一個套件）。版本比較採 SemVer 2.0 precedence（`-ballot`、`-snapshot1`、`-cibuild` 等 FHIR 標籤視為 pre-release）；`|version` 依 HL7 規則比對（精確版本，否則同 major.minor 中最高者，或萬用字元）。若套件宣告的相依套件未安裝，`data.deps_missing` 會列出；同一閉包中同一套件有多個版本時，`provenance.closure_versions` 會標示 canonical 查詢實際使用的版本。

## 工具分組

### 1. IG 探索
- **`fhir_list_igs`**：列出已安裝的 IG 套件，含 `packageId`、`version`、`title`、`canonical`、`fhirVersion`、`status`、`isDefault` 與宣告的相依套件。多個 IG 並存時先用此工具挑選。
- **`fhir_get_ig`**：單一 IG 的詳情，含身分、相依與各資源型別的 artifact 數量。
- **`fhir_list_artifacts`**：以摘要列出 IG 的 conformance artifacts（StructureDefinition / ValueSet / CodeSystem / examples…），可依 `resource_type` 或 `grouping_id` 過濾。
- **`fhir_search_artifacts`**：以 id / canonical URL / name / title / description 全文搜尋 artifacts。
- 上述列表 / 搜尋工具（含 `fhir_list_resource_profiles`）未給 `package_id` 時只看預設 IG；`all_packages=true` 改為涵蓋所有已安裝套件；零筆結果時 `data.hint` 會指出哪些其他套件有符合項目。

### 2. 剖面選擇與讀取
- **`fhir_list_resource_profiles`**：列出 IG 可選的資源剖面（constraint StructureDefinition），依其約束的基礎資源型別分組（例如 `Patient` → `Patient-twcore`）。
- **`fhir_rank_resource_profiles`**：依你打算填入的來源欄位鍵（keys）與各剖面 element path 的吻合度，對候選剖面排名。此工具**僅供建議**，回應帶有 `selectionRequired:true`，最終仍須自行挑選，不會自動對應。
- **`fhir_get_profile`**：單一剖面 / StructureDefinition 的摘要（身分、base definition、derivation、element 數）。可用 artifact id、canonical URL 或 artifact_key 解析；相依 IG 定義的 canonical 會遞移解析。
- **`fhir_get_profile_required_elements`**：列出剖面實際要求的所有元素（含必要祖先下的 min≥1、必要 slice、choice type、invariant 隱含的 value 或 dataAbsentReason，以及轉換目標隱含的主要內容），每列標示來源類別（`auto` / `coding` / `source_fact` / `workflow_default`）與填寫提示。`verbosity=compact`（預設）或 `full`；可帶 `instance`（草稿）讓已填的選用父節點連帶要求其子元素。撰寫資源前先呼叫，確保必填欄位齊全。
- **`fhir_get_profile_elements`**：讀取剖面 snapshot 的結構真相（cardinality、types、bindings、slicing、choice[x]、constraints）。同一工具提供多種 `view`：`elements`、`element`、`slices`、`choices`、`binding`、`examples`。

### 3. 術語 / ValueSet
- **`fhir_get_valueset`**：取得 ValueSet 定義摘要。
- **`fhir_expand_valueset`**：展開 ValueSet，列出實際成員碼。
- **`fhir_lookup_code`**：在指定 CodeSystem 中查詢單一碼的顯示名稱與屬性。
- **`fhir_validate_code`**：驗證某 `system`+`code` 是否屬於指定 ValueSet。
- **`fhir_normalize_code`**：以自由文字（例如「流行性感冒」）對照 ValueSet 或 code system，回傳排序後的候選碼；已安裝 IG 的 CodeSystem（例如健保支付碼）走 [IG 術語搜尋](ig-concept-search.md) 引擎。

### 4. 授權、組裝與驗證
- **`fhir_get_resource_skeleton`**：依剖面產生「骨架」資源—僅含必填 / mustSupport 結構的空白草稿，供逐步填值。
- **`fhir_finalize_resource`**：將草稿（draft）依剖面定稿，補齊結構並回傳完整資源。
- **`fhir_resolve_reference`**：以暫時鍵（key）解析資源參照，供 Bundle 內互相連結。
- **`fhir_build_bundle`**：將多筆資源組裝為 `transaction` / `collection` 等型別的 Bundle。
- **`fhir_validate_resource`**：依 `meta.profile` 指定的剖面驗證單一資源（結構 + 術語綁定）。
- **`fhir_validate_bundle`**：驗證整個 Bundle（每個 entry 依其 `meta.profile`，另檢查 Bundle 內參照完整性）。
- 兩個驗證工具都回報驗證是否完整：`checked_fully`、`profiles_unchecked`、`valuesets_unchecked`（`valid` 的語意與 HL7 相同；有剖面或 ValueSet 無法檢查時會明確標出，而不是默默當作通過）。選用參數 `source_text` / `site_config` / `evidence_map` 會另外加上 grounding 檢查結果；不帶這些參數時輸出與未加 grounding 前完全相同。

### 5. 紀錄忠實度（grounding，確定性、不使用 LLM）
- **`fhir_check_grounding`**：比對 Bundle 與來源病歷文字——每個已填的臨床事實與代碼都必須能在病歷中找到依據（evidence map 或自動定位），含日期 / 數值 / 單位 / 識別碼 / 劑量 / 頻次正規化，以及段落、否定與病史規則；問題以 `fhir_validate_bundle` 的格式回傳。
- **`fhir_check_completeness`**：缺口報告——比較轉換目標所需的事實（剖面必要 + 目標隱含元素）與病歷實際記載的內容，回傳缺漏項目、病歷中明確記載「無」的行、範本化的澄清問題，以及現成的 `insufficient_information` 物件。

`source_text` 屬於臨床資料，伺服器**絕不記錄其內容**（只記 SHA-256）。各工具的版本號由 `node-server/src/toolVersions.ts` 管理，可從 `health_check` 的 `tools_version` 取得。

## 技術架構
- **資料來源**：FHIR IG 套件（`package.tgz`），於管理後台 **FHIR → IG 套件庫** 從套件 registry 安裝或上傳 tgz（匯入階段 `ig_import`）。套件宣告的相依 IG（如 `hl7.terminology.r4`、`hl7.fhir.r4.core`）會**自動從 FHIR registry 下載**（預設 `https://packages.fhir.org`，失敗時退到 `https://packages2.fhir.org`；registry 位址可在 **整合 → 外部服務** 設定），各自以 package-scoped IG 索引，使跨系統的 ValueSet 綁定能展開出真實碼。registry 無法提供的相依套件才需要手動上傳。
- **安裝來源**：`fhir.ig_packages.install_origin` 記錄套件是 `manual`（管理者安裝）或 `dependency`（為滿足其他 IG 的相依而下載），`installed_for` 記錄是哪個 IG 拉進來的（migration `20261019_ig_install_origin.sql`）；手動安裝的標記在重新匯入時保留。IG 套件庫會列出缺少的相依套件與無人使用的相依套件。
- **刪除保護**：刪除其他已安裝 IG（直接或遞移）相依的套件，或刪除預設 IG，預設會被拒絕；必須指定新的預設 IG（`new_default`）或明確 `force`（記入稽核紀錄）。
- **資料庫**：`fhir` schema —`ig_packages`、`codesystems`、`concepts`、`artifacts`（皆 package-scoped，支援多 IG）。管理後台的 IG 詳情可瀏覽 IG 內 CodeSystem 的概念樹（`/admin/api/terminology/ig/*`）。
- **驗證引擎**：以 `fhirValidator.ts` / `fhirTerminology.ts` / `fhirSnapshot.ts` / `fhirReference.ts` / `fhirAuthoring.ts` 在程序內完成 snapshot 產生、術語綁定檢查、參照解析與骨架填值。判定規則以 HL7 `validator_cli` 7.0.1 + tx.fhir.org 為對照基準，並以 corpus 逐筆比對（稽核紀錄見 `node-server/scripts/validator-audit/REPORT.md`）。離線術語：ICD-10-CM / WHO ICD-10（`icd.*`）、LOINC（含 LA/LP/LL/LG）、SNOMED CT（含 inactive 內容）、RxNorm、CVX（內建 287 碼，版本 20250715）、ISO 3166（內建，版本 2018）、UCUM（`@lhncbc/ucum-lhc` 語法檢查，無法載入時標示 unchecked 而非判錯）。

## 授權工作流程（建議）
1. `fhir_list_igs` →（必要時）選定目標 IG。
2. `fhir_list_resource_profiles` / `fhir_rank_resource_profiles` → 挑選剖面。
3. `fhir_get_profile_elements`（`choices` / `binding` / `slices`）→ 了解結構與術語約束。
4. `fhir_get_profile_required_elements` → 確認必填元素；`fhir_get_resource_skeleton` → 取得骨架，逐步填入欄位（必要時用 `fhir_normalize_code` / `fhir_validate_code` 處理編碼）。
5. `fhir_finalize_resource` → 定稿；多筆資源以 `fhir_resolve_reference` + `fhir_build_bundle` 組裝。
6. `fhir_validate_resource` / `fhir_validate_bundle` → 驗證（有來源病歷時加 `source_text`，或另呼叫 `fhir_check_grounding` / `fhir_check_completeness`）。

## 關鍵限制
- 程序內驗證以剖面 snapshot 與術語綁定為基礎，雖以 HL7 validator_cli 7.0.1 為對照基準，仍**不**等同官方 HL7 FHIR Validator 的一致性認證。
- 工具僅提供建議與結構協助，剖面選擇與最終內容由呼叫端負責。

> 進階說明見 [FHIR Authoring Walkthrough](../fhir-authoring-walkthrough.md)。
