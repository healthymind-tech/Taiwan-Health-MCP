# FHIR IG 工具 (FHIR IG Tools)

一套通用、以 IG 為範圍的工具集，建構於多 IG（multi-IG）的 `fhir.*` 儲存之上，用於探索 Implementation Guide、讀取剖面與術語、進行術語驗證，以及以骨架填值方式產生與驗證 FHIR R4 資源。

> **維護模式**：管理後台把 `ig` 模組切到維護模式時，本組全部 22 個工具（含 `fhir_check_grounding` / `fhir_check_completeness`）呼叫會立即回傳 `isError` 結果，錯誤碼 `MODULE_MAINTENANCE`（`error.message` 英文、`error.message_zh` 正體中文，`error.module` 為模組鍵），約 5 秒內生效；工具仍留在 `tools/list` 中。詳見 [API 參考](../api/index.md#maintenance)。

## 共通慣例
- 每個工具都可帶入選用的 `package_id` + `version`。省略 `package_id` 時依下列優先順序決定目標套件，`provenance.resolved_by` 會註明採用哪一條：
    1. `explicit_version` — canonical 參數或 `meta.profile` 以 `url|version` 鎖定版本 → 持有該版本的套件；
    2. `package_arg` / `latest` — 有給 `package_id`（有 `version` 用該版本；沒給 version 則用預設 IG 的版本，否則取最高正式版，只有在沒有正式版時才用 pre-release）；
    3. `meta_profile` / `canonical_owner` — 擁有該 `meta.profile` 或 canonical 參數（profile / ValueSet / system）的套件，手動安裝的 IG 優先；
    4. `default_ig` — 預設 IG（`isDefault`）；
    5. `sole_manual_ig` — 沒有預設 IG 且恰好只有一個手動安裝的 IG。
    都不符合時回傳錯誤 `NO_DEFAULT_IG`（不會任意挑一個套件）。
- `|version` 一律被尊重：指定的版本未安裝時回傳 `ARTIFACT_NOT_FOUND`（訊息列出已安裝的版本），不會默默改用其他版本。
- 回應採用共同信封：`{ok, data, warnings, provenance, error?}`。`provenance` 含 `packageId` / `version` / `fhirVersion` / `source`，以及 `resolved_by`；依賴閉包中同一套件有多個版本時另帶 `closure_versions`（說明 canonical 查詢實際採用哪個版本）。
- 目標 IG 宣告的依賴有未安裝者時，`data.deps_missing` 會列出 `{package_id, version, required_by}`（閉包不完整，結果可能缺漏）。
- 列表 / 搜尋類工具（`fhir_list_artifacts`、`fhir_search_artifacts`、`fhir_list_resource_profiles`）未給 `package_id` 時只查預設 IG；`all_packages=true` 改查所有已安裝套件（每列附 `package_id` / `package_version`，此時忽略 `package_id`）。查無結果時 `data.hint` 會指出其他有命中的套件。
- **精簡輸出 `compact=true`**（`fhir_list_igs`、`fhir_list_artifacts`、`fhir_search_artifacts`、`fhir_list_resource_profiles`，預設 `false`，預設輸出完全不變）：給工具輸出預算有限的 LLM 用。每個型別只回傳 `{id: title}` 對照表，canonical 的共同前綴只寫一次（`canonical_base`；canonical = `canonical_base/<ResourceType>/<id>`），不符合此規則的才列在 `canonicals`；剖面另以 `status` 列出非 active 者；`data.compact` 是一行閱讀說明。`all_packages=true` 時改以 `packages`（`packageId#version` → 該套件的分組）呈現。`fhir_list_igs` 則回傳 `default` 與依安裝來源分組的 `manual` / `dependency`（`packageId#version` → 標題）。TW Core 實測：`fhir_list_resource_profiles` 12.9k → 4.8k 字元、`fhir_list_artifacts`（50 筆）19.9k → 2.8k、`fhir_search_artifacts`（20 筆）8.6k → 1.5k、`fhir_list_igs`（58 個套件）19.6k → 3.7k。
- 模組概念與建議工作流程見 [FHIR IG 服務模組](../modules/fhir-ig-service.md)。

## IG 探索
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_list_igs` | 列出已安裝 IG 套件（packageId / version / title / canonical / fhirVersion / status / isDefault / `installOrigin`（`manual` 手動安裝 / `dependency` 因其他 IG 的依賴而下載）/ dependencies） | `compact` |
| `fhir_get_ig` | 單一 IG 詳情、依賴與各資源型別 artifact 數量；`data.deps_missing` 列出未安裝的依賴 | `package_id`, `version` |
| `fhir_list_artifacts` | 列出 IG 的 conformance artifacts 摘要 | `resource_type`, `grouping_id`, `all_packages`, `limit`（預設 50，上限 200）, `compact` |
| `fhir_search_artifacts` | 以 id / canonical / name / title / description 全文搜尋 artifacts | `keyword`, `resource_type`, `all_packages`, `limit`（預設 20，上限 100）, `compact` |

## 剖面選擇與讀取
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_list_resource_profiles` | 列出可選資源剖面，依約束的基礎資源型別分組 | `base_type`, `all_packages`, `compact` |
| `fhir_rank_resource_profiles` | 依來源欄位鍵與剖面 element path 吻合度排名（僅建議，`selectionRequired:true`） | `keys`, `base_type`, `limit`（預設 5，上限 20） |
| `fhir_get_profile` | 單一剖面摘要（身分 / base / derivation / element 數），支援 id / canonical / key 解析，canonical 可寫成 `url|version`（未安裝的版本回 `ARTIFACT_NOT_FOUND`） | `identifier` |
| `fhir_get_profile_elements` | 讀取剖面 snapshot；`view` = `elements` / `element` / `slices` / `choices` / `binding` / `examples` | `profile`, `view`, `path`, `slice_name`, `limit` |
| `fhir_get_profile_required_elements` | 列出剖面「實際必填」的元素：整條父鏈皆必填才算、必填 slice、choice 型別、invariant 隱含的 value[x] 或 dataAbsentReason（vs-2 / vs-3 / tw-core-4 類，依運算式自動偵測）、target-implied 主要內容；每列附 `grounding_class`（auto / coding / source_fact / workflow_default …）、`required_by`、小型 required binding 的 `allowedCodes` 與填寫提示 `hint`；`derived` 列（如 `Condition.category`）另附 binding 展開的 `allowedCodes`（extensible / preferred 亦然，上限 20 碼）與推導規則（見下方「推導欄位與 Must Support」）。有 profile 的 extension 會依其定義展開（url、ext-1 隱含的 value[x]、必填子 extension），已填元素的基礎資料型別必填子元素也會列出（Narrative.div、Extension.url …），剖面自訂的 error invariant 列在 `invariants`。給 `instance` 時依 discriminator 比對 slice，未出現的 slice 不會帶出其子元素 | `profile`, `instance`（草稿：已填的選填父元素其必填子元素也列出）, `include_target_implied`（預設 `true`）, `include_mustsupport`（預設 `false`；`"defaults"` = 只加有固定值 / 預設值 / 可推導值的 mustSupport 元素；`true` = 所有 mustSupport 元素；加入的列帶 `optional: true`）, `verbosity`（預設 `compact`：id / required_by / grounding_class / fixed·pattern·value / choices / allowedCodes / hint，剖面固定的子樹折疊成一個可直接複製的 `value`；`full` 另含 min / max / types / binding / mustSupport） |

### 推導欄位與 Must Support {#derived-and-mustsupport}

`grounding_class: "derived"` 的元素不是照抄原文，而是由其他已填的值推得。對常見的推導欄位，`hint` 以 `derive:` 開頭給出規則（每條規則轉述所列代碼的官方定義，出處見 `verbosity="full"` 的 `derivation_source`），只在元素的 binding 正是規則描述的 ValueSet 時才套用：

| 元素 | 規則重點 | 出處 |
| :--- | :--- | :--- |
| `Condition.category` | 本次就醫（門診、住院、出院）所下或評估的診斷 → `encounter-diagnosis`（並以 `Condition.encounter` 指向該次就醫）；跨就醫維護的長期問題清單項目 → `problem-list-item`；就醫紀錄中寫下的診斷即使是慢性病也算 `encounter-diagnosis` | FHIR R4 condition-category；US Core Condition Encounter Diagnosis / Problems and Health Concerns |
| `Observation.category` | 依量測內容：檢驗 → `laboratory`，血壓 / 心跳 / 體溫 / 身高體重等 → `vital-signs`，影像、理學檢查、問卷、社會史… | FHIR R4 observation-category；R4 Vital Signs profile |
| `Encounter.diagnosis.use` / `.rank` | 入院 AD、出院 DD、主訴 CC、共病 CM…；主診斷 rank 1，其餘依紀錄順序 | FHIR R4 diagnosis-role；Encounter.diagnosis.rank |
| `MedicationRequest.category` / `MedicationStatement.category` / `courseOfTherapyType` | 依開立情境（住院 / 門診 / 居家 / 出院帶藥）；長期用藥 `continuous`、短期療程 `acute` | FHIR R4 對應 CodeSystem |
| `AllergyIntolerance.category` / `.type` / `.criticality`、`Observation.interpretation` | 依過敏原種類；免疫 vs 非免疫反應；危及生命 → `high`；依參考範圍 N / H / L / HH / LL | FHIR R4 對應 CodeSystem |

沒有規則的 derived 元素，`hint` 改列 binding 中各代碼的 CodeSystem 定義（`pick the code whose meaning fits the record: …`）。

**mustSupport 不等於必填。** `include_mustsupport="defaults"` 只多列出不需原文事實就能填的 mustSupport 元素（剖面固定值 / pattern、如 `verificationStatus` 的慣用預設值、上表的可推導值），而且其父元素都已列出；`true` 則列出全部 mustSupport 元素。兩者加入的列都帶 `optional: true` 與「可省略、不可因此拒答」的提示，`guide` 也會補上同樣說明。預設（`false`）的輸出除 derived 列外不變。

## 術語 / ValueSet
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_get_valueset` | ValueSet 定義摘要 | `identifier` |
| `fhir_expand_valueset` | 展開 ValueSet 並列出成員碼（盡量在本機解析；整個大型外部 code system 不列舉，回 `TOO_BROAD`） | `identifier`, `limit`（預設 500，上限 2000） |
| `fhir_lookup_code` | 1.4.0（v15.2：`accepted_by_validator`、`defined_in`、`alternatives`）；在 CodeSystem 中查詢單一碼的顯示名稱與屬性（RxNorm 查本機 `rxnorm.concepts`）；回應附 `accepted_by_validator`（`fhir_validate_*` 是否接受此碼）；查無此碼時附 `hint`（改用 `fhir_normalize_code`）；此碼不在本套件的節錄版 CodeSystem、但已安裝的完整版有收錄時，附 `defined_in`（套件與名稱）、`reason`（驗證會報 Unknown code）與 `alternatives`（概念連到、驗證器接受的其他系統 coding，例如 ATC）；任何版本都沒有此碼時才附 `near_codes`（拼寫相近的碼） | `system`, `code` |
| `fhir_validate_code` | 驗證 `system`+`code` 是否屬於指定 ValueSet，回傳 `valid` / `invalid` / `unverifiable`；`value_set` 可寫成 `url|version` | `system`, `code`, `value_set` |
| `fhir_normalize_code` | 1.10.0（v16.1 R4：指定 `value_set` 時，SNOMED CT 候選限縮在值集**列舉的概念**與 is-a / descendent-of 篩選內——只列舉代碼的值集（如科別）原本會搜尋整個 SNOMED CT；值集納入整個代碼系統或無法限縮的篩選時不限縮）；1.9.0（v15.2：`accepted_by_validator` / `reason`、相關且被接受的候選優先、`alternatives`）；自由文字（中英文、縮寫、病歷寫法）轉候選碼：SNOMED CT / LOINC / ICD-10，以及任何已安裝 IG 的 CodeSystem（例如健保支付碼 `medical-service-payment-tw`，見 [IG 術語搜尋](../modules/ig-concept-search.md)）。IG 候選附 `matched_term`、`matched_language`、`group`/`siblings`、`linked`（概念連到的其他系統代碼，例如藥品的 ATC 碼）；`system` 可給 canonical、id 或別名（`nhi_payment`）。**藥品**：健保藥品代碼可查 —— `system="medication-nhi-tw"`（TW Core）或 `"nhi-medication"`（TWPAS），文字可為中英文商品名或成分名（`Glucophage 500mg`、`脈優錠 5mg`）；預設 IG 只收錄節錄版 CodeSystem（TW Core 1.0.0 的 `medication-nhi-tw` 僅 35 碼）而另有安裝的套件收錄完整版（TW Core 0.3.2，44,709 碼）時，未指定 `package_id` / `version` 會改查完整版（`warnings` 與 `data.codesystem_copies` 會註明）。**ATC**：本機沒有可搜尋的 WHO ATC（TW Core `medcation-atc-tw` 只有 27 個台灣自訂碼），請先查健保藥品，候選的 `linked` 即其 ATC 碼（來自內建健保用藥 supplement）。**查詢與驗證一致（v15.2）**：每個候選附 `accepted_by_validator`（不接受時附 `reason`），判定規則就是驗證器對解析出的套件所做的代碼檢查；完整版才有的碼仍會列出（可用來辨識藥品）但標為 `false`。最佳候選不被接受時，與它相關（同一 linked 碼、共用罕見字詞、同劑量）且被接受的候選排到前面（無關的碼不會被提前），並以 `data.alternatives` 列出這些候選連到、驗證器接受的其他系統 coding（例如 `{system: "http://www.whocc.no/atc", code: "C08CA01", display: "amlodipine", accepted_by_validator: true, value_sets: [...medcation-atc-tw]}`，對應 MedicationRequest 的 `atc-medication-code` slice）；藥名請留在 `CodeableConcept.text` | `text`, `value_set`, `system`, `limit`（預設 10） |

## 授權、組裝與驗證
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_get_resource_skeleton` | 依剖面產生僅含必填 / mustSupport 結構的空白草稿；`required` 為元素自身 min≥1，`effectiveRequired` 另要求所有父元素皆必填 | `profile`, `candidate_limit`（預設 20，上限 100）, `include_examples`（預設 `true`） |
| `fhir_finalize_resource` | 1.12.0（v16 R4：[結構修正](#content-repair)——空陣列移除、`meta.profile` 字串時也能推得 `resourceType`、無損改形只讓既有錯誤顯露時不撤回；驗證同 `fhir_validate_resource` 1.14.0）；1.11.0（v15.4：`validation` 的 record checks 同 `fhir_validate_resource` 1.13.0：空殼資源）；1.10.0（v15.3：`validation` 的 record checks 同 `fhir_validate_resource` 1.12.0）；1.9.1（v15.2.1：同 `fhir_finalize_bundle` 1.5.1）；1.9.0（v15.2：`alt-coding`；驗證同 `fhir_validate_resource` 1.11.0）；將已寫好的 FHIR JSON 草稿依剖面定稿並驗證：只在草稿已有父節點處釘上 fixed / pattern（含 slice 成員與任何深度的 `_slice` 標記），不補臨床內容；`repair="content"`（預設）先套用與 `fhir_finalize_bundle` 相同的內容修正（見「[內容修正](#content-repair)」），回傳 `changes` / `repair_issues`；有欄位值時改用 `fhir_author_resources`（見「[從欄位值撰寫資源](#authoring)」） | `profile`, `draft`, `context_id`, `key`, `generate_narrative`（預設 `true`）, `repair`（`content` / `ids`）, `timezone`, `site_config` |
| `fhir_resolve_reference` | 以暫時鍵解析資源參照（供 Bundle 內互連） | `key`, `resource_type`, `context_id`, `display` |
| `fhir_build_bundle` | 將多筆資源組裝為 Bundle：`key` 變成確定性的 UUID v5 fullUrl（同一輸入永遠得到同一份 Bundle），資源內以 `key`、`urn:uuid:<key>`、`<Type>/<key>` 寫的引用一律改寫成產生的 fullUrl；給了不合法 `fullUrl` 時依 `fhir_finalize_bundle` 的規則正規化。`data.changes` 列出每一處改寫，`data.unresolved` 列出找不到對應 entry 的引用（1.2.0） | `entries`, `bundle_type`（預設 `transaction`）, `context_id` |
| `fhir_finalize_bundle` | 1.17.0（release v1：缺漏的 fixed / pattern 值才補、已存在且不同的值不覆寫而列為 ambiguous，不產生無效 change，ambiguous 的 `pointer_out` / `patch_out`，見[自動修正](#auto-fix)）；1.12.0（v17.5：無效的 narrative 內部連結、`system|版本`、section display、emptyReason section，見 [document Bundle 補全](#document-completion)）；1.11.0（v17.1 / v17.3：[document Bundle 補全與 narrative 修正](#document-completion)；字串寫成複合型別、STU3 屬性改名、display 唯一對應的錯誤代碼，見[內容修正](#content-repair)）；1.8.0（v16 R4：[結構修正](#content-repair) 補齊——空陣列（ele-1）移除、`meta.profile` 寫成字串時也推得缺漏的 `resourceType`、無損改形（字串 → 陣列、單值 ↔ 陣列、上下移一層）只讓原本被遮住的錯誤顯露時不再撤回；推得的 `resourceType` 只在出現未知的頂層屬性時撤回）；1.7.0（v15.4：`record_issues` 同 `fhir_validate_bundle` 1.16.0 的 record checks：空殼資源）；1.6.0（v15.3：`record_issues` 同 `fhir_validate_bundle` 1.15.0 的 record checks：文字欄位的缺漏敘述、需數值結果的 valueString / note、主診斷以 provisional 代替）；1.5.1（v15.2.1：`alt-coding` 也適用於未宣告 `meta.profile` 的資源）；1.5.0（v15.2：內容修正規則 `alt-coding`）；**在輸出最終 Bundle 前呼叫**：整理 `fullUrl`、`reference` 和 `id`（見下節「Bundle 定稿」），`repair="content"`（預設）另修正可唯一確定的內容錯誤、不能確定的不猜並回報候選（見「[內容修正](#content-repair)」；`repair="ids"` 只整理 id）；數字保留呼叫端的原始寫法（`10.0` 仍是 `10.0`）。回傳整理後的 `bundle`、每一處改動 `changes[{path, from, to, rule}]`、無法確定的引用 `unresolved[{path, reference, candidates}]`、`notes` 與 `id_map`。`bundle_type` 可指定 `Bundle.type`（剖面固定的 type 不會被覆寫） | `bundle`, `package_id`, `version`, `bundle_profile`（目標 Bundle profile 的 canonical 或 id；省略時取 `meta.profile`）, `bundle_type`（R4 bundle-type 代碼）, `repair`（`content` 預設 / `ids`）, `timezone`（site 時區：UTC offset 或 IANA 名稱）, `site_config`（院所設定文字，`timezone:` 行可提供時區） |
| `fhir_validate_resource` | 1.22.0（v19 R3：issue 附 [pointer 與 patches](#v19-pointers)，同 `fhir_validate_bundle` 1.25.0）；1.21.0（parity v1，同 `fhir_validate_bundle` 1.24.0）；1.20.0（v17.5，同 `fhir_validate_bundle` 1.23.0）；1.19.0（v17.3，同 `fhir_validate_bundle` 1.22.0 的 [IG 已知缺陷](#ig-known-defects) 說明）；1.18.0（v17.2，同 `fhir_validate_bundle` 1.21.0 的 [IG 定義值豁免](#ig-defined-values)）；1.17.0（v17，同 `fhir_validate_bundle` 1.20.0 的 R6 內容涵蓋）；1.16.0（v16.2，同 `fhir_validate_bundle` 1.19.0 的 `invariant` 說明）；1.15.0（v16.1，同 `fhir_validate_bundle` 1.18.0 的 `options` / `literals`）；1.14.0（v16 R3，同 `fhir_validate_bundle` 1.17.0 的 [slice / profile 不符說明](#slice-match)）；1.13.1（v15.4 驗證修正，同 `fhir_validate_bundle` 1.16.1）；1.13.0（v15.4，同 `fhir_validate_bundle` 1.16.0）；1.12.0（v15.3，同 `fhir_validate_bundle` 1.15.0）；1.11.1（v15.2.1，同 `fhir_validate_bundle` 1.14.1）；1.11.0（v15.2，同 `fhir_validate_bundle` 1.14.0）；驗證單一資源（結構 + 術語綁定）；未給 `profile` 時取 `meta.profile`。選用的 `source_text` 會另跑 grounding 檢查（見下節） | `resource`, `profile`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |
| `fhir_validate_bundle` | 1.25.0（v19 R3：每個 issue 附指向**送出 Bundle** 的 JSON Pointer `pointer`，error 附已驗證可直接套用的 JSON Patch 候選 `patches`，見 [可直接套用的修正](#v19-pointers)）；1.24.0（parity v1：新參數 `bundle_profile`，等同 validator_cli 的 `-profile`；依官方 7.0.1 原始碼移植解析階段、choice 型別、fixed / pattern、值集與 display、document 規則，見 [與官方 validator 的一致性](#parity-v1)）；1.23.0（v17.5：document Bundle 與 validator_cli 一致，見 [document Bundle 的驗證一致性](#document-parity)）；1.22.0（v17.3：IG 範例本身也過不了的錯誤附 [IG 已知缺陷](#ig-known-defects) 說明；STU3 屬性的改名建議）；1.21.0（v17.2：grounding 與 record checks 豁免 [IG 定義的值](#ig-defined-values)；多藥同行的劑量引文不再誤報 `G-CONTEXT-LABEL`）；1.20.0（v17 R2：[R6 內容涵蓋](#record-checks)——`negated-item-present`、`duplicate-entry`、`text-only-fact`；新參數 `content_checks_severity`）；1.19.0（v16.2 R3：profile invariant 失敗（`Constraint failed: <key>`）附 `invariant`——`need`（`all` 全部要成立 / `one_of` 擇一）、`applies_because`（`條件 implies …` 中成立的條件）、`failed`（不成立的子條件，含缺漏路徑；extension 條件另附 URL、值型別與要寫入的 JSON `write`）與 `hint`；也附在 `slice_match` / `profile_match` 的 `blocking` 錯誤上——Bundle 中 entry 的規則錯誤常只出現在那裡）；1.18.0（v16.1 R2 / R3：[slice_match](#slice-match) 在沒有接近的 slice（`closest: null`）或多個一樣接近時附 `options`——每個可用 slice 與其判別值；看起來像佔位符的 IG 固定值（`NNxxx`、`*`、`<…>`）標明「literal value required by the IG; copy as is」，列於 `literals`）；1.17.0（v16 R3：[slice / profile 不符說明](#slice-match)——`slice_match` / `profile_match`：最接近的 slice / profile、哪個判別條件沒過、`blocking` 擋住比對的前 5 個錯誤，以及 `set_profile` / `add_resource` 建議）；1.16.1（v15.4 驗證修正：SNOMED 中文名稱比對只用完整名詞片語、上下位階層的診斷不判為「另一個概念」（沒有完全相同 ICD 中文名稱時，以詞尾中心詞判斷較廣的上位概念，如「社區型肺炎」→「肺炎」）、IG 中文名稱表啟動時背景載入；無 `source_text` 時「結果欄註記無結果」規則降為 warning）；1.16.0（v15.4 [record checks](#record-checks)：空殼資源——沒有值的 Observation、沒有結構化劑量 / 頻次的用藥、沒有代碼的 Condition，旁註說明「未出 / 未定 / 退件 / 尚難區分」時，病歷證實 → `information-absent` error，否則 warning）；1.15.1（v15.3 R3 補充：SNOMED 代碼以資料推得的中文名稱與中文診斷欄比對，見 [record checks](#record-checks)）；1.15.0（v15.3 [record checks](#record-checks)：`information-absent` 也適用於文字欄位——沒有代碼 / 只有佔位代碼的 `CodeableConcept.text`、`Dosage.text`、代碼需要數值結果的 `valueString` / `note`；主診斷 Condition 以 provisional / differential / 純文字代替病歷未確立的主診斷 → error「病歷沒有確立的主診斷」；有代碼元素的 `G-UNGROUNDED` / `G-VALUE-MISMATCH` 說明比對內容、附 `closest_record_phrase`，沒有明確反證時降為 warning）；1.14.1（v15.2.1：未宣告 profile 的資源也提供替代 coding 建議）；1.14.0（v15.2：Unknown code 建議的相關性門檻、`replace_coding` / `remove_coding` 替代 coding、ATC 依內建 tx.fhir.org 判定表檢查）；驗證整個 Bundle（各 entry 依其 `meta.profile` + Bundle 內參照完整性）。ID 類錯誤（`UUIDs must be valid…`、引用無法解析、缺 fullUrl、bdl-7、不合法 id）附 `suggestions` 與 Bundle 層級的 `id_map` / `id_changes`；`normalize_ids=true` 時先整理再驗證並回傳 `normalized_bundle`（見下節「Bundle 定稿」）。選用的 `source_text` 會另跑 grounding 檢查並合併結果（見後文） | `bundle`, `normalize_ids`（預設 `false`）, `repair`（預設 `ids`；搭配 `normalize_ids` 可設 `content`）, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |

`fhir_validate_resource` / `fhir_validate_bundle` 的 `data` 另回報驗證是否完整：`checked_fully`（所有剖面與 ValueSet 都檢查到、且依賴閉包完整時為 `true`）、`profiles_unchecked`、`valuesets_unchecked`。`valid` 維持 HL7 語意（無法解析的剖面只是 warning），因此 `valid: true` 但 `checked_fully: false` 代表有部分內容沒有被檢查。驗證期間定義 / 術語查詢因資料庫問題失敗時另附 `lookups_failed`（失敗次數），此時一定有一則 `code: "exception"` 的 error issue，`valid` 為 `false`（1.6.1）。`|version` canonical（`meta.profile`、binding、targetProfile、type profile、extension url）的解析方式比照 HL7 validator_cli 7.0.1。

內建 validator 另比照 HL7 validator_cli 7.0.1 檢查（1.6.0 同版）：

- **Extension 使用位置**：依 extension 定義的 `context`（element / extension 型別；`version-specific-use` 限其他 FHIR 版本的 context 略過）與 `contextInvariant` 判斷能否用在該元素，不符時於宿主元素回報 error `The extension <url> v<version> is not allowed to be used at this point (this element is [...]; allowed for this version = e:...)` 或 `... (based on context invariant '...')`；fhirpath 型 context 不在本機評估（不判錯）。
- 未指定版本的 StructureDefinition 取閉包內版本最高的一份（例如 `hl7.fhir.uv.extensions.r4` 的 extension 優先於 R4 core 的同 URL 版本），因此 extension 自身的 invariant（如 `variable` 的 var-1）也會檢查。
- **`Unrecognized property`** 依 core 定義檢查整份資源（同 HL7 JSON parser），剖面不允許的 choice 型別、未知 extension 的 value 底下也會回報；JSON 形狀錯誤（單值寫成陣列）的元素不再往下檢查，與 HL7 相同。
- **RxNorm**：依 `rxnorm.concepts` 檢查碼與 display（tx.fhir.org 接受該 RXCUI 所有 SAB=RXNORM 名稱，不分大小寫），錯誤為 `Wrong Display Name '...' for http://www.nlm.nih.gov/research/umls/rxnorm#<code>. Valid display is '...'`。未知碼只有在本機 RxNorm 版本不舊於 tx.fhir.org（03022026）時才是 error，否則 warning；本機只有偏好名稱（migration 20261030 前匯入）時 display 不符只給 warning；未載入 RxNorm 時給 warning `Display not checked (RxNorm)`。
- IG CodeSystem（`content = complete`）的 `Unknown code` 維持 error；若另一個已安裝套件有同一 CodeSystem 較完整的版本且含此碼（例如 TW Core 0.3.2 的 `medication-nhi-tw`），另附 information 指出該套件與版本。
- **Unknown code 的建議（v15.2）**：IG CodeSystem 的替代碼必須與原碼相關 —— 共用 linked 碼（如同一 ATC）、共用罕見字詞（成分名，而非劑型 / 鹽類）或幾乎相同的名稱，且劑量不變；找不到相關的碼就不給（不再出現 Amlodipine → 無關藥品的建議）。原碼若在完整版中有定義，`near_codes` 式的拼寫建議也不再提供；改以 `replace_coding` 提供它連到、驗證器接受且元素綁定（含 coding slice）允許的其他系統 coding（patch 取代該 Coding，保留 `text`），CodeableConcept 已含該 coding 時則為 `remove_coding`（validator_cli 只要未知碼的 Coding 還在就判定錯誤）。
- **WHO ATC（v15.2）**：本機不持有 ATC，改用內建的 tx.fhir.org 判定表（`node-server/data/terminology/atc-tx-check.json.gz`，只涵蓋 TW Core `medcation-atc-tw` 與健保用藥 supplement 出現的 ATC 碼、不含名稱）：ATC 2026 沒有的碼回報與 validator_cli 相同的 `Unknown code '…' in the CodeSystem 'http://www.whocc.no/atc' version '2026'` error；TW Core ValueSet 的 display 經確認與伺服器一致時才檢查 display（不分大小寫）；表外的碼維持不檢查。
- 直接綁定 ValueSet 的 Coding 元素（如 `Encounter.class`）以 ValueSet URL 當 system 時，只回報綁定 warning，不再報 `The Coding references a value set` error（與 HL7 相同）。

1.7.0（validator v13，評估報告 v13）新增：

- **ValueSet canonical 寫在 `Coding.system`**：IG 自有的 ValueSet（例如 `https://twcore.mohw.gov.tw/ig/twcore/ValueSet/laboratory-code-tw`）寫成 CodeableConcept 內 coding（或未直接綁定的 Coding）的 system，而且同一份資源 / Bundle 有元素綁定到該 ValueSet（或綁定到包含它的 ValueSet，例如 `laboratory-code-tw` 含 `loinc-observation-code`）時，於 `…coding[i].system` 回報 error `The Coding references a value set, not a code system ('<url>')`（HL7 `Terminology_TX_System_ValueSet2`），取代原本的 warning `A definition for CodeSystem … could not be found`。1.6.x 只對 HL7 core / THO 的 ValueSet 報錯（HL7 / THO 維持任何情境都報）。依據（validator_cli 7.0.1 與 7.0.3 逐筆確認）：CLI 只有在「本次執行已載入該 ValueSet」時才認得它是 ValueSet——檢查過綁定到它的元素之後就是 error（同一 CodeableConcept 的前一個 coding、資源中其他元素、Bundle 前面的 entry、批次中前面的檔案），同一筆資源在 JVM 裡第一次出現時只有 warning；從未被當成綁定檢查的 ValueSet（`medication-path-tw`；`medication-nhi-tw` / `medication-fda-tw` 只綁在 `medication[x].coding` 的 slice 上）即使批次執行也只有 warning。我們採用與順序無關的版本：只要驗證的資源 / Bundle 內任何位置檢查了該 ValueSet 的綁定就是 error，否則維持 warning。直接綁定的 Coding 元素（`Encounter.class`、`ImagingStudy.series.modality`）維持只有綁定 warning。這類 error 附 `suggestions`：在該 ValueSet 與它所含的 CodeSystem 中以 code / display 正規化得到的候選（`replace_coding`），以及它所含的 CodeSystem（`replace_system`，含此 code 者排前）。
- **LOINC 屬性 filter 可判定成員**：ValueSet compose 對 `http://loinc.org` 的 `=` / `in` filter（`CLASSTYPE`（數字或 `Laboratory class` 等名稱）、`CLASS`、`STATUS`、`COMPONENT`、`PROPERTY`、`TIME_ASPCT`、`SYSTEM`、`SCALE_TYP`、`METHOD_TYP`、`concept in`）依本機 `loinc.concepts` 判定；本機沒有的碼、其他運算子（regex、is-a…）仍是「無法判定」。因此 `laboratory-code-tw` 等 ValueSet 對 LOINC 碼的綁定檢查不再只是「could not be confirmed」。

1.6.1（validator v8，評估報告 v6）新增：

- **無法解析的 CodeSystem URL 一律是 error，不分元素**：HL7 空間（`http://hl7.org/fhir…`、`http://terminology.hl7.org/…`）的 `Coding.system` / `Quantity.system` 若不是任何已安裝套件的定義，於該 `system` 元素回報 `No definition could be found for URL value '…'`（Coding、CodeableConcept、Encounter.class、Identifier.type、Meta.tag、extension 的 value、contained 資源、巢狀 Bundle 皆同）。`http://hl7.org/fhir/sid/…` 只承認 HL7 validator `SIDUtilities` 的清單（ndc、icpc-2、icd-9、icd-10、cvx、srt、icd-10-cm、icd-9-cm、dsm5 …）；`icd-10-pcs`、`us-mbi` 等不在清單內，因此在任何元素上都會報這個 URL error（1.6.0 把它們視為已知，漏報）。代碼本身維持 warning `A definition for CodeSystem '…' could not be found`（HL7 `UNKNOWN_CODESYSTEM`），HL7 空間以外（IG 自有 URL 等）找不到的 system 也只有這個 warning，與 validator_cli 相同。
- **參照含空白**（`Patient/ 123`、尾端空白）：error `The reference '…' is not a valid reference`（HL7 `REFERENCE_REF_INVALID_REF`）。
- **RxNorm display 指到另一個藥**：display 與該 RXCUI 所有已知名稱（偏好名稱 + alt_names）沒有任何共同的藥名詞（去掉劑量、單位、劑型、途徑、鹽類與功能詞後比對；5 字以上字首相同視為同字），或根本不含拉丁字母（中文商品名）時，即使本機只有偏好名稱也判 **error**，訊息為 `Wrong Display Name '…' for …#<code>. Valid display is '…'; the display denotes a different concept: …`；只是同一藥的另一種寫法（同義詞、鹽類、劑型）在只有偏好名稱時維持 warning，重跑 `rxnorm_import` 載入 alt_names 後即與 tx.fhir.org 相同判 error。SNOMED / LOINC / ICD / CVX 的 display 本來就是 error（validator_cli 亦同），不受影響。
- **查詢失敗絕不當成通過**：驗證期間任何定義 / 術語查詢因資料庫問題失敗（連線中斷、復原模式、timeout；缺表 / 缺欄位除外）時，結果多一則 error issue（`code: "exception"`，`Validation incomplete: N … lookups failed …`），`valid: false`、`checked_fully: false` 並附 `lookups_failed`；validator 本身發生例外時改回傳帶 fatal `exception` issue 的正常結果，而不是失敗的工具呼叫。
- `fhir_validate_bundle`：沒有可用 resource 的 entry（寫成陣列、缺 `resourceType`）不會出現在 `entries`，其 issue（如 `must be a simple value, not an Array`）改列在 Bundle 層的 `issues`，不再遺失。

### IG 已知缺陷（v17.3）{#ig-known-defects}

有些 profile 連 IG 自己的範例都無法通過驗證，例如 TWPAS `Condition-twpas`：`Condition.code.coding` 以 `pattern $this` 切 slice，但各 slice 只有 binding 沒有 pattern，任何 coding 都對不上，而 slicing 是 closed。照範例寫的 instance 永遠不可能合法。

- **偵測**：背景工作 `ig_selfcheck`（管理介面「IG 範例自我檢查」）在每次 IG 匯入後、以及 worker 啟動時補跑尚未檢查的套件。它用本機 validator 驗證套件中每個範例（含範例 Bundle 的各 entry）對應的本套件 profile。若某個 profile 的**每一個**範例都在同一元素違反同一條**結構性規則**（slicing、cardinality、不存在的元素、fixed / pattern），就記為該 profile 的已知缺陷（`known_invalid`）。範例自己的值造成的錯誤（example.org 識別碼、格式、日期類 invariant）、本機術語或參照造成的錯誤、範例 Bundle 多放的 entry，都不列入。結果存在 `fhir.ig_known_defects`。
- **`fhir_get_bundle_blueprint`**：`known_invalid` 列出這類 slice，附原因、範例檔名，以及資訊應改放的位置（同一 Bundle 其他 slice profile 中，綁定同一 ValueSet 的 CodeableConcept，例如 `claim: diagnosis.diagnosisCodeableConcept`），並請一併省略指向它的參照。
- **`fhir_get_minimal_skeleton` / `fhir_get_authoring_fields`**：`warnings` 附同樣的說明。
- **`fhir_validate_*`**：符合已知缺陷的錯誤會加上 `ig_known_defect`，訊息尾端也附上說明（此 entry 多半可省略；資訊應放在哪個元素）。嚴重度、issue 集合與 `valid` 都不變。

### 與官方 validator 的一致性（parity v1）{#parity-v1}

`fhir_validate_bundle` / `fhir_validate_resource` 的判定以 HL7 validator_cli 7.0.1（加 tx.fhir.org）為準，下列規則都依官方原始碼（`org.hl7.fhir.core` 7.0.1）移植：

- **`bundle_profile` 參數**（`fhir_validate_bundle`）：等同 validator_cli 的 `-profile`，Bundle 會同時依它與 `meta.profile` 驗證。請傳入轉換目標的 Bundle profile；不傳時只驗 `meta.profile`，MCP 不會自行推測。
- **解析階段**（`JsonParser`）：不認得的屬性、形狀錯誤（陣列 / 物件 / 原始值）依 base 定義只報一次，訊息同官方。之後的 profile 比對、以 profile 切的 slice 判定、reference 目標 profile 比對都不受這些錯誤影響。只剩不認得屬性的元素，判為 ele-1。
- **choice 型別**：base 不允許的型別是 `Unrecognized property`。base 允許、但 profile 只允許另一種型別時，報 `Extension_PROF_Type`（extension 則報 `Extension_EXT_Type`），並以 profile 的型別繼續驗證。profile 對多型別 choice 定義了子元素時，實際型別的子元素一併適用。
- **值集**：required binding 的 code 推不出 CodeSystem 時，報 `The System URI could not be determined …`。代碼在值集內但 display 錯時，視為不符合 binding，與 tx `$validate-code` 相同。
- **fixed / pattern**：依官方 `checkFixedValue` 逐欄比對，使用官方訊息。
- **其他**：不同 profile 的同一條規則各報一筆。document 的第一個 entry 不是 Composition 時，報 `The first entry in a document must be a composition`，並照常檢查 reachability。

**回歸**：評測方提供的 92 份可重現 Bundle（PAS + IPS），error 類別與官方一致率為 **100%**（少報 0、多報 0）；IPS 範例比對集 28 份與 4 份 language 變體也完全一致。必須依賴術語伺服器的部分（SNOMED is-a 值集、全 LOINC 值集、tx 的 display 候選），由 v18 的官方最終把關處理。

### document Bundle 的驗證一致性（v17.5）{#document-parity}

上線後沒有官方 validator，MCP 判合法就會送出，所以 document Bundle 的判定須與 HL7 validator_cli 7.0.1 + tx.fhir.org 一致。v17.5 補上以下規則：

- **Bundle 內參照**：document / message Bundle 中，Composition 以外每個 entry 的參照都必須能在 Bundle 內解析（同 HL7 的 fullUrl 規則，沒有依 type/id 的後備比對）。解析不到時在 `Bundle` 報 error「Can't find '…' in the bundle (Bundle.entry[n].resource.…)」；有同型別、同 id 但 fullUrl 不符的資源時，附上應改用的 fullUrl。連不到的 entry 也因此判定為無法從 Composition 抵達（error）。
- **Narrative 內部連結**：`<a href="#x">` 找不到對應錨點時報 error。錨點可以是 Bundle 內任一 narrative 的 `id` / `name`，或 resource id。這也會讓該 resource 不符合 profile，進而不符合以 profile 切的 slice，與官方相同。
- **`url|版本` 形式的 uri**（例如 `Coding.system = http://…/v2-0360|2.7`）：必須能解析到該版本，否則報 error。
- **非英語 resource 的 display**：resource 的 `language` 不是英文（例如 `zh-TW`）、而 coding 綁定的是**逐一列出代碼**的 ValueSet 時（SNOMED CT、LOINC），tx.fhir.org 只接受該 ValueSet 列出的 display（例如 IPS `target-diseases-uv-ips` 的「Pertussis (disorder)」），其他 display 都報 error。這已用 validator_cli 實測確認：`zh-TW` / `fr-LU` 會報錯，`en-US` 或不設 language 則不會。
- **LOINC display**：tx.fhir.org 使用 LOINC 2.83。本機 LOINC 版本較舊時，改用內建的 `data/terminology/loinc-tx-display.json.gz`（2,264 個改名的代碼，例如 30954-2「…Narrative」→「…note」，以及 LOINC 的 DisplayName），驗證與 display 修正都以它為準。匯入 2.83 以上的 LOINC 後，自動改回本機資料。

**比對結果**：在 IPS 1.1.0 的 4 個範例及其變體（section display 錯誤、section 不引用 entry、urn:uuid fullUrl 搭配相對參照），以及這些變體經 `fhir_finalize_bundle` 後的結果（共 28 份），加上 4 份 language 變體上，MCP 與 validator_cli 的 error **完全一致**：MCP 少報 0、多報 0。

### document Bundle 補全（v17.1）{#document-completion}

`fhir_finalize_bundle` 以 `repair="content"` 執行時（`fhir_assemble_bundle` 一律如此），若 Bundle.type 為 document，或 Bundle profile 規定為 document，會依 Composition profile 決定性地補全以下項目：

- `Bundle.identifier`：缺漏時補上（`urn:ietf:rfc:3986` + Composition 的 UUID v5；同一份文件得到相同 id）。`Bundle.timestamp`：只有 Composition.date 帶時間與 UTC 時差時才補上，否則回報，不編造時間。
- `Composition.subject` / `author`：缺漏且 Bundle 中只有一個候選（Patient；Practitioner，其次 Organization）時補上。Composition 未宣告 profile 時，依 Bundle profile 的 composition slice 補上 `meta.profile`。
- **section**：讀取 Composition profile 的 section slice（code pattern、title / text 的最小基數、entry 允許的 profile）。每個從 Composition 連不到的 entry，若只有一個 section 接受它，就放進該 section。判斷依序為：宣告的 profile；目標 profile 規定的代碼與必要 code 的 required binding；資源型別。必要且尚無 entry 的 section 優先。section 不存在時會建立，code 的 display 取自 pattern 或術語，title 取 code 的 display，text 由各 entry 的名稱產生。必要 section 缺少、或 entry 有多個可放的 section 時只回報，不建立空 section（emptyReason 是病歷事實）。
- **Narrative**（所有 resource 與 section）：缺 div 時改用 text 中的字串；div 缺 XHTML 命名空間時補上；status 不合法（如 `final`）時改為 `generated`；找不到錨點的內部連結會拿掉 `<a>` 標籤、保留文字（v17.5）。
- **v17.5**：Composition profile 以 pattern 固定的 section 代碼，display 改成術語的正式 display；已有 emptyReason 的 section 不放 entry（改為回報）；`Coding.system` 寫成 `url|版本` 時，版本移到 `Coding.version`。

### Bundle 定稿（fhir_finalize_bundle / normalize_ids）{#bundle-finalize}

模型（尤其是較弱的模型）常把 `fullUrl` 寫成看得懂但不合格式的標籤（`urn:uuid:patient-1`）、引用寫成 `Patient/patient-1` 或裸 id、`Bundle.id` 寫成 urn；這些都和臨床內容無關，官方驗證器卻會整份拒絕。`fhir_finalize_bundle` 把這類編號與連線工作交給工具，規則全部來自 FHIR R4 核心規範與套件的 StructureDefinition，**不針對任何 IG 寫特例**：

| 規則 | 內容 |
| :--- | :--- |
| `fullUrl-uuid`（必做） | 已合法的不動（小寫 `urn:uuid:<UUID>`、`urn:oid:`、絕對 `http(s)://`）；大寫 UUID 轉小寫；其他情況（標籤、缺少、空字串）產生 **確定性的 UUID v5**：固定 namespace，種子為（resourceType、原 fullUrl、resource.id、entry 位置）加上一個 Bundle 層級的 salt（把可改寫欄位去掉後整份 Bundle 的 SHA-256），所以同一輸入永遠得到同一輸出，不同 Bundle 不會撞號 |
| `reference-rewire`（必做） | 依每個資源的 StructureDefinition snapshot（`meta.profile` 可解析時用剖面，否則用核心定義）找出所有 Reference 型別的元素——含 extension 的 `valueReference`（依 url / slice 解析定義）、`Composition.section.entry`、`Provenance.target`、`Identifier.assigner` 等資料型別子元素、backbone、`contained` 資源；原 fullUrl、大小寫不同的 UUID、`Type/id`（對應 `resource.id`）、裸 id 都對應到同一筆 entry，改寫成目標的最終 fullUrl。裸 id / 缺型別的寫法同時符合多筆時，以元素的 `targetProfile` 型別消歧；仍有多筆或找不到 → 列入 `unresolved` 並附同型別 entry 作 `candidates`，不猜。`#contained`、Bundle 外的絕對網址、只有 `identifier` 的邏輯引用不動；`…/_history/v` 照樣解析但保留版本 |
| `resource-id`（必做） | `resource.id` / `Bundle.id` 不符合 `[A-Za-z0-9\-.]{1,64}` 時取最後一段（`urn:uuid:…` → UUID）；仍不合法則 `resource.id` 改用該 entry 的 UUID、`Bundle.id` 改用產生值 |
| bdl-7 | fullUrl 重複只回報（`notes`），不合併、不刪除；指向重複標籤的引用列為 `unresolved`（兩筆 candidates） |
| `bundle-type` / `document-order`（剖面驅動，或呼叫端指定） | `bundle_profile`（或 `meta.profile`）的 StructureDefinition 以 fixed / pattern 固定 `Bundle.type` 時照它設定；呼叫端給 `bundle_type`（R4 bundle-type 代碼）時以規則 `bundle-type`、`reason: "requested by caller (bundle_type)"` 設定，但剖面固定的 type 永遠優先（衝突只在 `notes` 回報）；`type=document` 時把 Composition 移到第一筆。沒有任何 Composition 的 document 不會被自動改型，`notes` 寫明兩條路：`bundle_type=<依 entry 形狀推得的型別>` 或補一筆 Composition。剖面要求的 `Bundle.identifier`、`Bundle.timestamp` 等需要實際值的欄位只在 `notes` 回報，不自行產生 |

輸出 Bundle 除上述欄位外與輸入完全相同（深拷貝、保留 key 順序），**數字也保留原始寫法**：HTTP 層以 JSON.parse 解析請求後 `10.0` 會變成 `10`、`1e3` 變成 `1000`、超過 2^53 的整數被捨入，而 FHIR `decimal` 的精度是值的一部分；因此 `fhir_finalize_bundle`、`fhir_validate_bundle(normalize_ids=true)` 的 `normalized_bundle`、`fhir_build_bundle` 的 entry 資源與 `fhir_finalize_resource` 的 `resource` 會把請求原文中的 `bundle` / `entries` / `draft` 參數以無損方式重讀一次，整理照常在一般的樹上計算（UUID、`changes`、驗證結果完全不變），最後只把每個數字換回呼叫端寫的字串（`10.0`、`1.50`、`0.50`、`-0.0`、`12345678901234567890`，extension 與巢狀陣列內亦然；值相同時才換）。三個入口（`/mcp`、`POST /tools/<name>`、管理主控台的 playground）回傳的位元組相同。已合法的 Bundle 原樣回傳且 `changes` 為空；整理過的再整理一次結果不變。`package_id` 省略時依 `bundle_profile` / `meta.profile` 解析套件，沒有可解析的 IG 時退回 `hl7.fhir.r4.core`。

`fhir_validate_bundle` 整合同一套引擎：預設（`normalize_ids=false`）ID 類錯誤附 `suggestions`（`replace_fullurl` / `replace_reference` / `replace_id` / `move_entry` / `replace_bundle_type`），`data` 另附整份對照表 `id_map`（舊值 → 新值）、`id_changes`（所有必須一起改的路徑）與 `id_unresolved`，沒有 ID 類問題的 Bundle 輸出與 1.6.1 完全相同；`normalize_ids=true` 則先整理再驗證**整理後**的 Bundle，回傳 `normalized_bundle` 與 `id_changes`，每一處已整理的問題以 `information` 等級的 issue 註明。`fhir_get_profile_required_elements` 查 Bundle profile 時另回傳 `bundle_rules`（fullUrl 格式、引用須等於目標 fullUrl、id 格式、剖面固定的 `Bundle.type`（或提示可用 `fhir_finalize_bundle` 的 `bundle_type` 設定）、document / message 順序、必填元素與 entry slice），同樣由核心規範與 StructureDefinition 產生。

### 內容修正（repair="content"）{#content-repair}

`fhir_finalize_bundle` / `fhir_finalize_resource` 的 `repair` 預設為 `"content"`：除了上面的 id 整理，再修正**可唯一確定**的內容錯誤；`repair="ids"` 則與 1.1.0 / 1.5.0 完全相同（只整理 id）。`fhir_validate_bundle` 在 `normalize_ids=true` 時可加 `repair="content"`。`fhir_author_resources` / `fhir_assemble_bundle` 一律套用同一套規則（`node-server/src/fhirRepair/`，同一輸入在各工具得到同一判定與同一修正）。每一處修正列在 `changes[{path, from, to, rule, reason}]`；無法唯一判定的值**不改**，列在 `repair_issues[{path, rule, message, candidates}]`，驗證器原本的 error 保留（該 issue 另附 `repair`）。

| rule | 修正內容 | 不改、回報的情形 |
| :--- | :--- | :--- |
| `display` | 代碼存在、display 只是**同一概念的不同寫法**時改成正式 display，原寫法移到空的 `CodeableConcept.text`。判斷方法：(a) 與驗證器列出的有效 display / designation（含其他語言、LOINC 長短名）在正規化後相同——NFKC、大小寫、標點、字序、單複數、羅馬數字（Type II ↔ Type 2）、SNOMED semantic tag、縮寫字首；(b) 否則以模型的 display 在該代碼系統中搜尋（`fhir_normalize_code`），**該代碼排第一**且為 exact 或與有效 display 共用至少一半的字 | 搜尋結果第一名是**別的代碼**（例：SNOMED `428921007` 配「Pneumonia」→ `233604007` 排第一）、該代碼只排在後面、無法搜尋——視為意思不同：不改，候選為 display 所指的代碼；上下位概念也算不同 |
| `ucum` | Quantity（任何 Quantity 型別元素，含 `component[].valueQuantity`）缺 code、code 不是合法 UCUM、code 是 LOINC 碼（`8310-5`）時，由 `unit`／code 文字推得 UCUM 並設 `system`：UCUM 名稱 / 同義詞 / 符號（`mmHg` → `mm[Hg]`、`°C`/`℃`/`degC` → `Cel`）、`<次數詞>/<時間單位>` 文法（`次/分` → `/min`、`mg/天` → `mg/d`）、µ / μ 寫成的 UCUM 字首 `u` 與省略方括號的單位（`μIU/mL` → `u[IU]/mL`）、除數中連在單位上的係數（小數寫成 annotation：`mL/min/1.73m2` → `mL/min/{1.73_m2}`；整數：`mg/24h` → `mg/(24.h)`）；須符合剖面固定的 code 或 required 的 UCUM ValueSet（剖面固定 `/min` 時的 `min` 讀作 `/min`；與唯一一個允許代碼換算係數為 1 的同義寫法改成該代碼：`1/min` → `/min`）。`code` 是 LOINC 碼又沒有 `unit`、或只有數值沒有 code 與 unit 時：剖面只允許一個單位（fixed / pattern，或只含一個代碼的 required ValueSet）就直接設定（`changes` 的 reason 為「the profile allows only <單位>」；剖面要求 `unit` 時一併填上），否則 LOINC 碼的情形回報 error `quantity-code-not-ucum`（「valueQuantity.code 放的是 LOINC 碼，不是 UCUM 單位，請給單位」） | 不同證據推出不同代碼（code `g` 與 unit `kg`）、推得的代碼不在允許清單（體溫寫 `K`）、推不出來；`system` 是另一個真正的 CodeSystem 時不碰 |
| `roc-date` | date / dateTime / instant 的民國年：有「民國 / ROC」字樣或三位數年份（`115-10-03`、`115/10/03`、`115-10-03T16:05:00`、`民國115年10月3日`）→ +1911，保留精度；時間沿用原本的 offset，沒有 offset 時補 site 時區（見下方 `timezone`） | 一或兩位數年份（`99-10-03`）無法判定；有時間卻沒有 offset 又不知道 site 時區（error，`code: timezone-required`）；四位數年份不處理 |
| `timezone` | 西元年的 dateTime / instant 有時間但沒有 UTC offset（「If a date has a time, it must have a timezone」）→ 補上 site 時區（秒數一併補齊）。site 時區的來源依序為：`timezone` 參數（`+08:00` 或 IANA 名稱 `Asia/Taipei`，IANA 依該時間點計算 offset、含日光節約）→ `site_config` 中的時區行（例如 `- 時區：+08:00`、`timezone: Asia/Taipei`；標籤可為 時區 / timezone / time zone / tz / UTC offset）→ `source_text` 的【院所設定】段落中的同一種行 | 不知道 site 時區（error `timezone-required`，訊息說明如何提供）；`site_config` 寫了多個不同時區；該時間在 IANA 時區中不存在或有歧義（日光節約切換） |
| `system` | `Coding.system` 不是絕對網址（`ICD-10-CM`、`LOINC`、`SNOMED CT`、`loinc.org`、OID）、是 ValueSet 網址（含省略 `/ValueSet/` 的 HL7 核心網址 `http://hl7.org/fhir/condition-code`）、或是解析不到的網址（`…/ns/fhir/CodeSystem#icd-10-cm`、`…/CodeSystem/_ActMedicalServiceCode`、`…/CodeSystem/v3-ActEncounterCode`）→ 依已安裝 CodeSystem 的 name / title / id / 網址末段 / identifier、FHIR R4 外部代碼系統表、網址 fragment / 末段、THO 抽象碼（`_` 開頭）、以網址末段命名的 THO / 核心 ValueSet（取代碼在其中所屬的 CodeSystem）、元素綁定的 ValueSet，找出**唯一一個含有該代碼**的 CodeSystem；都對不到時，再找名稱相近（去掉 `v2-` / `v3-` 與標點後相同、一方為另一方的字首、或 Levenshtein 相似度 ≥ 80%）的已安裝 CodeSystem——更名或退役的名稱（`v3-AdmitSource` → `admit-source`、`v3-GTS` → `v3-GTSAbbreviation`），只在**恰好一個**含有該代碼、且元素的 required / extensible 綁定（可判定時）接受時才改 | 對到多個、或代碼不在對到的系統 |
| `shape` | 無損的結構修正：Coding 寫成 `{coding:[一個]}` 或包在另一個屬性裡（`Encounter.class: {type: {...}}`）、Coding 的 `code` 裡又包一個 Coding、CodeableConcept 寫成單一 Coding、required 綁定的 `code` 元素寫成只有一個 coding 的 CodeableConcept / Coding（`reaction.severity` → `"moderate"`，代碼須在該 ValueSet 中、display / text 不會遺失）、單值元素給了一個元素的陣列、重複元素給了單值、只有一處鄰近元素定義的錯位屬性（`Dosage.doseQuantity` → `doseAndRate[0].doseQuantity`、`entry.meta` → `entry.resource.meta`、`Timing.route` → `Dosage.route`、`doseAndRate.unit` → `doseAndRate.doseQuantity.unit`、`doseAndRate[0].timing` → `Dosage.timing`、寫在資源裡的 `request` → `entry.request`）、缺 `resourceType` 但 `meta.profile` 指向單一資源型別。Bundle 本身：缺 `resourceType` 但 `entry` 是正常的 entry 陣列 → 補 `"Bundle"`（在 INVALID_ARGUMENT 檢查之前；`repair="ids"` 時錯誤訊息會指出位置）；`"entry[1]"`、`"entry2"` 這類鍵名 → 依編號重建 `entry` 陣列；重複的 fullUrl（bdl-7）且資源完全相同 → 刪除後面的副本 | 多個 coding、text 與 display 不同、可能的位置不只一處、編號重複或落在既有 `entry` 陣列內、重複 fullUrl 的資源不同；訊息附正確形狀與範例 |
| `empty` | 空元素（ele-1）：值為 `{}`、`[]`、`""`、`null` 的元素直接移除（變空的父元素下一輪一併移除） | 帶 `_x` 擴充的 `null` 保留 |
| `fixed-slice` | 剖面要求（min ≥ 1）、內容完全由 fixed / pattern 決定的 Coding / CodeableConcept slice 沒有出現 → 補上（例：pulse-oximetry 要求 `code.coding` 同時有兩個固定 coding、vital-signs 的 `category:VSCat`）；新值須經 discriminator 判定屬於該 slice | slice 的必要子元素不是全部固定、已有屬於該 slice 的項目、超過元素上限 |
| `alt-coding` | CodeableConcept 中某 Coding 的碼不在本套件的節錄版 CodeSystem（驗證報 Unknown code，例：TW Core 1.0.0 `medication-nhi-tw` 只有 35 碼）、但已安裝的完整版有定義，且其概念只連到**一個**驗證器接受、又被 coding 元素或某個 coding slice 綁定的 ValueSet 收錄的其他系統 coding（例：健保藥品 → ATC，TW Core `medcation-atc-tw`）→ 以該 coding 取代；CodeableConcept 已含該 coding 時移除未知碼的 Coding；`text` 保留，沒有 `text` 時以原 display 補上（產品名稱不流失）。資源未宣告 profile（無 `meta.profile`）時，改讀該 IG（擁有此 CodeSystem 的套件，否則為解析出的 / 預設 IG）中此資源型別的 profile 綁定：只有一個 profile，或多個 profile 對此元素的綁定一致時才採用，否則不修正，原因中會註明綁定來自哪個 profile；驗證本身仍只依資源宣告的 profile | 連到多個被接受的 coding（回報候選）、沒有被接受或被綁定允許的 coding、原碼在本套件的 CodeSystem 中 |
| `code` | required 綁定的 `code` 值寫成某個代碼的 display 或大小寫不同（`periodUnit: "hour"` → `h`），只限完整、≤ 200 碼的本機展開 | 對到多個或沒有 |

**不會新增錯誤**：每份資源修正前後各驗證一次；若修正後出現原本沒有的 error（例如改好 `system` 後才顯露的 display 錯誤、移入 `meta.profile` 後才開始檢查的剖面規則），相關修正撤回並以 `repair_issues`（warning，`not applied: …`）說明原因。例外（評測方決定）：改好 `system` 後，唯一新出現的 error 是**同一個 Coding** 的 display 檢查（`Wrong Display Name … for <新 system>#<code>`）時，這個錯誤在語意上原本就存在，`system` 的修正保留並列在 `changes`，display 錯誤照常由 `display` 規則回報並附以模型 display 查到的候選；其他任何新 error 仍會撤回。v14.1 起整份 Bundle 也在修正前後各驗證一次：只有在 Bundle 情境才看得到的 error（參照目標、entry slice、document 規則）同樣會讓造成它的修正撤回（依 error 所在路徑、訊息中提到的 entry / fullUrl 追溯；追溯不到時整批不套用）。Bundle 外殼的修正（補 `resourceType`、重建 `entry` 陣列）是讓驗證器能讀取這份 Bundle 的前提，不在此比較之內。同一輸入永遠得到同一結果，修正過的 Bundle 再修正一次 `changes` 為空；數字保留原始寫法。

**v17.3 / v17.1 補充（任何 IG）**：
- `shape`：複合型別元素寫成字串時，轉成該型別唯一的字串元素。`dosageInstruction: "500 mg BID"` → `[{text}]`，Annotation / CodeableConcept / HumanName 等同理；Narrative 轉成 `{status: "generated", div}`，div 內容經 XHTML 逸出並帶命名空間。放錯層級的字串（`Dosage.note`）搬到唯一定義它的元素，必要時轉成 Annotation。
- `shape`：STU3 中 R4 已改名的元素直接改名（`Immunization.vaccineProtocol` → `protocolApplied`，內含 `doseSequence` → `doseNumberPositiveInt`；`date` → `occurrenceDateTime`；`Observation.comment` → `note`），對照表依 FHIR R4 版本變更。R4 已移除的元素（`notGiven`、`doseStatus`）只回報改寫方式，不刪除。
- `code`：Coding 的代碼不存在於其 CodeSystem（例如檢查碼錯誤的 `4548-5`），而 display 恰好是該系統中唯一一個代碼的名稱 → 改成那個代碼。有多個同名代碼時不改。

**v16 結構修正（任何 IG、任何深度）**：以宣告剖面（無則 core）的 StructureDefinition 判斷每個元素的 max —— 重複元素寫成單值 → 一項陣列、max 1 寫成一項陣列 → 取出、`meta.profile` 字串 → 陣列；entry 缺 `resourceType` 而 `meta.profile`（陣列或字串）只指向一種資源型別 → 補上；空的元素（`{}`、`[]`、`""`、`null`，ele-1）移除；`Unrecognized property` 的值只在唯一的上一層 / 下一層有定義時才移過去。這些都是無損改形：若修正後才出現的錯誤只是因為值終於能被讀到（改形後的元素底下、或補好 `meta.profile` 後該資源開始依其剖面驗證、引用它的 profile-match 錯誤），視為原本被遮住的錯誤而不撤回修正；推得的 `resourceType` 只有在出現未知的頂層屬性（型別不對）時撤回。以 TWPAS 1.2.7 與 TW Core 1.0.0 套件內的範例 Bundle 套用上述破壞（每份每筆資源）後修正，錯誤數都回到範例原本的數量（`node-server/scripts/v16-structure-eval/evalRepairs.ts`）。

### 官方 HL7 validator 作為判準（v18 R1）{#official-engine}

正式環境為每個主要 IG（TW Core 1.0.0、TWPAS 1.2.7、IPS 1.1.0、EMPD 0.2.1）各跑一個常駐的官方 validator_cli 7.0.1（compose 服務 `hl7-validator-*`，`services/hl7-validator/`）。設定 `OFFICIAL_VALIDATOR_URLS` 後，`fhir_validate_bundle` / `fhir_validate_resource`（以及 `fhir_finalize_*` 的「不新增錯誤」檢查）的結構、slicing、profile、invariant / FHIRPath、document 與術語 error **直接來自官方引擎的 OperationOutcome**；MCP 只在上面加 `suggestions`、`slice_match`、`pointer` / `patches` 與內容檢查（grounding、record checks）。

| 欄位 | 值 |
|---|---|
| `data.source` | `hl7-validator_cli-7.0.1`（官方）或 `builtin`（內建） |
| `data.engine` | `hl7-official`；官方服務暫時不可用時為 `mcp-fallback`，並附一筆 warning 說明結果來自內建驗證器、可能與 validator_cli 不同 |
| issue `message_id` | 官方的訊息 id（例如 `Unrecognized_property`） |
| `data.official_verdict` | `true`：結果是官方的完整判定；`false`：降級或有無法驗證的代碼 |
| `data.checked_fully` | 降級（`mcp-fallback`）或有 `unverified` 時一律 `false` |
| `data.fallback_reason` | 降級原因（例如官方服務在 120 秒內沒有回應） |
| `data.unverified` | 術語伺服器暫時失敗（逾時、無法連線）而**無法驗證**的項目；不算 error，也不影響 `valid`，但結果不完整，請稍後重驗 |
| issue `location_path` | validator_cli 的 `isn't reachable` / `Can't find … in the bundle` 訊息路徑的 entry 索引有誤（多 1）；MCP 依訊息中的 fullUrl / reference 反查實際元素，`pointer` 與 entry 歸屬依此（官方 `path` 保留原樣） |

官方 HTTP 服務一次處理一個請求，MCP 對每個 validator 一次只送一個（排隊在 MCP 端），送出後 120 秒內沒有回應就降級並說明。術語伺服器的暫時失敗會被 validator_cli 留在記憶體快取中，MCP 偵測到時會重啟該 validator（最多每 10 分鐘一次）以清除。`OFFICIAL_VALIDATOR_MODE`：`prefer`（預設，官方不可用時降級為內建）、`require`（不降級：官方不可用時回 error「無法驗證」）、`off`。沒有常駐服務的 IG 仍由內建驗證器判定，輸出不變（沒有 `engine` 欄位）。術語預設由 tx.fhir.org 判定（只送代碼與 display，不含病人資料）。

#### 失敗的 invariant 說明值與根因（release v1）{#invariant-literals}

每個 `Constraint failed: <key>`（官方或內建驗證器皆同）的 issue 都附 `invariant`：
- `expression`：profile 中該 invariant 的 FHIRPath；`human`：原始說明文字（常為中文）。
- `literals`：從 expression 抽出的字面值——`systems`、`codes`（含其 system 與該 CodeSystem 的 display，說明各代碼適用情境）、`values`、`formats`（`matches()` 的正規表示式）。
- `hint`：可接受的值與規則全文。
- 若實例中有該 system 的 coding 但代碼不被接受，附 `replace_code`（或 `replace_system`）建議並轉成 JSON Patch；多個候選時依 display 與目前代碼的語意相近程度排序，只針對規則所指的那個 coding（例如身分證類識別碼，而不是病歷號）。不會憑空新增實例沒有的 coding。

連鎖錯誤（`Unable to find a profile match`、entry / reference slice 找不到）附 `caused_by`，並附 `root_causes`：沿連鎖追到最底層、不是連鎖錯誤的根因（例如 Composition → Encounter → Patient → `pat-id-1`）。

### 自動修正、ambiguous 與「不新增錯誤」（v19 R1）{#auto-fix}

`fhir_finalize_bundle` 1.14.0 起（`repair="content"`，預設）把**只有一種正確修法**的結構錯誤全部自己修好，其餘標為 `ambiguous`，並保證**finalize 後的 error 是 finalize 前的子集合**。規則全部由 StructureDefinition / snapshot、FHIR R4 規格與驗證器本身的訊息推得，不針對任何 IG：

- **屬性改名**（只在唯一一個合法元素對得上、值可無損讀成該型別時）：choice 型別後綴不合（`doseNumberPositiveInteger` → `doseNumberPositiveInt`，`"1"` 讀成 `1`）、choice 缺後綴（`item` → 值的形狀唯一符合的 `itemCodeableConcept`）、單複數（`periodUnits` → `periodUnit`）、`MedicationStatement.dosageInstruction` → `dosage`、R4 `protocolApplied` 內的 STU3 子元素（`doseSequence` → `doseNumberPositiveInt`）；有多個候選時不改，列為 ambiguous；
- **Bundle 層的 entry**：寫在 Bundle 頂層的 `fullUrl` / `resource`（Bundle 沒有這些元素）→ 移進新的最後一個 entry；
- **fixed / pattern（1.17.0 起，release v1）**：**缺漏的 fixed / pattern 值可以補，已存在且不同的值一律不覆寫**（任何修正類別皆然：fixed_pattern、shape、display、system_code…）。剖面必填、以 fixed / pattern 指定、而 instance 沒寫的元素（`Observation.status: minimum required = 1` 且剖面 `fixedCode: final`）→ 補上該值；驗證器回報 `Value is 'A' but is fixed to 'B'` 時，A 是病歷的值（例如 `preliminary` 是初步報告，不是最終報告），**不改**，列為 `ambiguous`（category `fixed_pattern`，訊息說明病歷值與剖面要求不同；candidates 只有文字說明、沒有自動 patch；status 類元素另提示：結果未完成時，轉換應回報 `insufficient_information`），驗證器的 error 保留。唯一例外是純表示法差異——同一個值的不同 JSON 形狀（`["x"]` / `"x"`、前後空白）或同一 code system 的 URI 別名（`urn:oid:2.16.840.1.113883.6.1` / 結尾 `/` 之於 `http://loinc.org`），這種情況會改寫。同一規則也用在內容修正（`fhir_validate_bundle` 的 `repair="content"`、author / assemble 共用的修正）：剖面要求的 coding slice，若同一個 CodeableConcept 已有同一 system、不同代碼、且不屬於該元素其他 slice 的 coding，就不補上（那是病歷的概念），改為回報。`Bundle.type` 是 Bundle 外殼而非病歷值，仍依剖面固定值設定（見 [Bundle 定稿](#bundle-finalize)）；
- **display**：剖面以 fixed / pattern 釘住的代碼（例如 `Composition.type`、section slice 的 code）→ 驗證器列出的正確 display；代碼未被釘住且 display 指的是別的概念時不改（代碼或 display 哪個錯無法判斷），列為 ambiguous 並附兩種 patch；
- **choice 型別**：剖面只允許一種型別、值可無損讀成該型別（`valueString: "true"` → `valueBoolean: true`）→ 改名；
- **section narrative**：剖面要求 `Composition.section.text` 而 section 有 entry → 由這些 entry 在 Bundle 內的名稱產生（不新增病歷內容）；
- 既有的陣列 / 單值、narrative、system / code、id / reference（v9）與 document 補全照常適用。

1.15.0（v19 R1 第二輪）另加下列規則，同樣只在修法唯一時套用：

- **display（代碼已確定）**：代碼存在於其 CodeSystem（驗證器列得出它的有效 display），且同一 CodeSystem 沒有其他代碼正好叫這個名字（display 或 `fhir_normalize_code` 精確命中的 designation）、寫的 display 與該代碼的名稱有一半以上的字相同（或有共同字且檢索把這個代碼排第一）、required 綁定沒有拒絕這個代碼 → 改成該代碼的 display，原本的寫法保留在 `CodeableConcept.text`（沒有 text 時）。字幾乎不重疊（`ECOG performance status` 寫在 NYHA 的代碼上）代表代碼本身可疑，不改，列為 ambiguous；
- **system（依綁定的 ValueSet）**：元素綁定的 ValueSet 不含 `system#code`，但在**另一個** CodeSystem 下正好有同一個代碼、且 display 完全相同（`v3-ActCode#L 'Low'` → `v3-ObservationInterpretation`）→ 改 system；
- **代碼放錯元素**：code 不在自身元素的 required ValueSet，而同一層只有一個兄弟元素的 required ValueSet 含有它（`AllergyIntolerance.type = 'medication'` → `category`、`criticality = 'unconfirmed'` → `verificationStatus`）→ 搬過去（依目標型別寫成 code / Coding / CodeableConcept，system 與 display 取自 ValueSet；目標可重複時包成陣列）；目標已有同一代碼時只刪除放錯的那份；目標有其他值、或有多個兄弟元素可收時不改；
- **字串元素寫成物件**：`string` / `markdown` 元素寫成只有一個字串屬性的物件（`series: {text: "Tdap"}`）→ 該字串；
- **code 元素寫成 CodeableConcept**：Coding 的 system 是 ValueSet CodeSystem 的 THO / core 對應網址（`terminology.hl7.org/CodeSystem/allergy-intolerance-category` ↔ `hl7.org/fhir/allergy-intolerance-category`）時也視為同一個 CodeSystem；
- **Reference 往下一層**：backbone 上的 `reference` 只有一個 Reference 子元素可收時（`Immunization.performer.reference` → `performer.actor.reference`）→ 搬入；有兩個（`Procedure.performer` 的 `actor` / `onBehalfOf`）不改；
- **STU3 改名**：另加 `Composition.class` → `category`；
- **重複值**：STU3 名稱或錯誤後綴（`doseSequencePositiveInteger`）唯一對應的 R4 元素已經是同一個值 → 刪除重複的那份；值不同時不改；
- **section entry 型別不符**：section slice 不收的資源型別（Results 底下的 MedicationStatement）→ 移到唯一收這個型別、且已存在的 section；沒有 section 收（Medications 底下的 Medication 本身）但 Bundle 內另有 entry 引用它（仍可達）→ 從 section 移除；section 的最後一筆 entry 不動（空 section 需要 emptyReason，屬病歷事實）。

**`exposed_errors`**（finalize 參數，預設 `"strict"`）：改名 / 搬移後，原本因為是未知屬性而沒被驗證的內容開始被驗證，可能出現新的 error。`"strict"` 把這些當成新增 error，撤回該改名；`"allow_under_moved"` 則認為位置在改名 / 搬移後新位置之下的 error 本來就存在（只是被藏住），保留改名、把這些 error 列在 `ambiguous`。`summary.exposed_errors` 回報採用的模式。

**回應欄位**：

- `changes[]` 保留原有 `path` / `from` / `to` / `rule` / `reason`，另加 `pointer`（RFC 6901，以**送出的 Bundle** 為根——document 重排、移除的重複 entry、從 Bundle 層移入的 entry 都換回送出時的位置）、`before`、`after`、`category`（`shape` / `narrative` / `display` / `unrecognized_property` / `system_code` / `ids_references` / `document_structure` / `fixed_pattern`）；搬移 / 改名另有 `moved_to`（值的新位置）；1.17.0 起不會出現前後值相同、位置也相同的無效 change；
- `ambiguous[{pointer, pointer_out?, pointer_note?, message, category, candidates[{description, patch?, patch_out?}]}]`：有多種修法、或需要病歷決定的項目——被撤回的修正（附原修正的 patch）、無法唯一判定的 repair issue（display / code 候選、改名候選、與 fixed / pattern 衝突的病歷值）、找不到或對到多個 entry 的引用、以及修正後仍存在的 R1 類別 error；`patch` 是 RFC 6902 操作，**直接套用在送出的 Bundle** 上（已驗證可套用）。1.17.0 起：`pointer` 一定能在送出的 Bundle 解析；`pointer_out` 指向**回傳（定稿後）的 Bundle**（與 `pointer` 不同時才有，例如 document 重排後的 entry 位置），也一定能解析；元素在該 Bundle 不存在時改指最近的既有上層元素，並在 `pointer_note` 說明；候選的 `patch_out` 是同一修法套用在回傳 Bundle 的版本（路徑或值不同時才有，已以 `patchApplies` 驗證）；
- `summary` 另加 `categories`（各類別修正數）、`ambiguous`、`withdrawn`、`errors_before` / `errors_after`（驗證器的 error 數）。

**不新增錯誤**：finalize 先驗證送出的 Bundle，修正後再驗證一次（以 Bundle profile；訊息比對，忽略 entry 順序與產生的 UUID）。修正後多出的 error 會找出造成它的那一項修正（同一位置 / 同一 entry / Bundle 層），撤回後重跑（最多 3 輪；無法歸因時整份不改），被撤回的修正列在 `ambiguous`。因此一項修正若讓原本讀不到的內容開始被驗證而出現新 error（例如 `dosageInstruction` 改成 `dosage` 後才看得到的 Dosage 錯誤），該修正不套用，交給模型以 patch 處理。

**實測**（`node-server/scripts/parity/finalize-eval.ts`，parity_v1 repro 92 份，結構性 error、不含內容檢查）：1.14.0 為 1384 → 1104（-20.2%）；1.15.0（`exposed_errors="strict"`）為 1384 → 945（**-31.7%，新增 0**）：fixed_pattern 10 → 0、system_code 84 → 18、unrecognized_property 198 → 105、display 76 → 48、shape 60 → 35、ids_references 37 → 30、document_structure 42 → 42。剩下的都沒有唯一修法並列在 `ambiguous`：document_structure 多為根本沒有 Composition、或沒有 section 收得下的 entry；ids_references 是引用了 Bundle 內不存在的 entry；display 是寫的名稱指向另一個概念（代碼本身可疑）；unrecognized_property 是有多個可能位置或 R4 已移除的 STU3 元素（`vaccineProtocol`、`doseStatus`）。`exposed_errors="allow_under_moved"` 為 1384 → 965（-30.3%），其中 45 筆是改名後才看得到、位於新位置之下的 error（以 strict 的定義算是「新增」）。 1.17.0（release v1）為 1384 → 956（-30.9%，新增 0）：不再覆寫已存在且不同的值（1.16.0 有 10 筆：4 筆 `Observation.status` preliminary → final、6 筆 category 的 system / code），這 10 筆 fixed_pattern error 保留並全部列在 `ambiguous`；無效 change 8 → 0；`ambiguous` 的 pointer 無法解析 2 → 0。

### 修正建議（suggestions / caused_by）{#validation-suggestions}

驗證結果的 issue 除了指出錯在哪裡，也盡量附上「要改成什麼」：`suggestions` 是依 `confidence` 由高到低排序的候選（每個 issue 最多 5 個；小型 ValueSet 的綁定錯誤最多 12 個），參照鏈錯誤另有 `caused_by`。兩者都是**附加欄位**——issue 的集合、severity、message 與 `valid` 完全不變；沒有建議時不出現該欄位。

```json
{"severity": "error", "path": "MedicationRequest.dosageInstruction[0].timing.repeat", "message": "Unrecognized property 'periodUnits'",
 "suggestions": [{"value": "periodUnit", "kind": "rename_property", "confidence": 0.82, "reason": "closest element name at this level: 'periodUnit'",
                  "patch": {"op": "move", "from": "MedicationRequest.dosageInstruction[0].timing.repeat.periodUnits", "path": "MedicationRequest.dosageInstruction[0].timing.repeat.periodUnit"}}]}
```

| 錯誤 | `kind` | 建議內容 |
| :--- | :--- | :--- |
| `Unknown code 'X' in the CodeSystem 'http://unitsofmeasure.org'` | `replace_code` | 最接近的合法 UCUM：大小寫（UCUM 區分大小寫）、方括號（`[U]` → `U`、`[UI]/mL` → `[iU]/mL`）、UCUM 單位表的前綴 + 單位、常見臨床寫法（`mcg` → `ug`、`mmHg` → `mm[Hg]`）、非單位的劑型字改用註記（`tab` → `{tablet}`）；每個候選都以 validator 用的同一套 UCUM parser 驗證過 |
| `No definition could be found for URL value 'U'`、`A definition for CodeSystem 'S' could not be found`、`The Coding references a value set, not a code system` | `replace_system` | 誤用的 ValueSet（或同名 ValueSet）所引用的 CodeSystem（`…/CodeSystem/v3-ActEncounterCode` → `…/CodeSystem/v3-ActCode`），以及套件閉包內最接近的 canonical；Coding 有代碼時，含有該代碼的 system 排前面 |
| `Unrecognized property 'p'` | `rename_property` / `move_property` / `remove_property` | 依序：同一層最接近的元素名（大小寫、拼字；含 datatype 子元素、choice 元素的具型別名稱，如 `value` → `valueQuantity`）；該名稱在本資源實際所在的層級（祖先、三層內的子孫含 datatype 子元素、祖先的同層 backbone / datatype；`timing.periodUnit` → `timing.repeat.periodUnit`、`dosageInstruction[0].note` → `MedicationRequest.note`、`Patient.city` → `Patient.address[0].city`）；語意相同且值形狀相符的同層元素（信心較低，證據來自 FHIR 元素的 `alias` / `short` 與一小張 FHIR 通用同義詞表：`every: 8` 旁有 `periodUnit` → `period`、Range 的 `upperLimit` → `high`、`zip` → `postalCode`、`comment` → `note`）；都沒有時才建議移除（`patch.op = remove`），`reason` 列出該層的元素名（上限 14 個）與帶有此名稱的其他資源型別（如 `reasonCode` 放在 Observation → 「是 Encounter、Procedure… 的元素」） |
| `The type 'date' is not allowed for Condition.onset[x]` | `rename_property` | 允許型別中符合值形狀的具型別名稱（`onsetDate` → `onsetDateTime`） |
| 值不在 required / extensible ValueSet 內 | `choose_code` | ValueSet 展開後的代碼：≤ 50 個代碼的 ValueSet 一律全列（展開不占查詢額度），依字串相似度排序；小型 ValueSet（≤ 12）字串都不像時改依語意相似度（embedding 端點；取不到時維持字串順序），大型者取與原代碼 / display 最接近者（含 `fhir_normalize_code`） |
| 值不在元素的 ValueSet，但它是同一資源另一個有綁定元素的合法代碼（`criticality: "severe"` → `reaction[0].severity`） | `move_value` | 該值應搬去的元素實例路徑（`patch.op = move`）：從資源剖面（`meta.profile` / 驗證指定的剖面）與基底定義的 snapshot 找 required / extensible 綁定且型別相容（code → code、CodeableConcept → CodeableConcept）的元素，以 validator 的成員檢查確認；目標已有值時信心較低 |
| 其他 CodeSystem 的 `Unknown code` | `replace_code` / `replace_system` | validator 會接受的拼寫修正（大小寫、ICD 小數點、LOINC 連字號）、名稱與 display / text 相符的代碼（`fhir_normalize_code`）、IG CodeSystem 的相近代碼，以及代碼形狀相符的其他術語（LOINC 代碼放在 SNOMED system）；代碼存在於該元素綁定 ValueSet（含 slice 綁定）所含的**其他** CodeSystem（IG 本地的 `CodeSystem/v2-0203` 與 HL7 同名 CodeSystem 同在 `identifier-type-tw`）或其他 base 下同名 CodeSystem 時 → `replace_system`（0.9；ValueSet 只收錄該 CodeSystem 的部分代碼且不含此代碼時 0.6） |
| `No definition could be found for URL value 'U'`，U 是 `Coding.system` 且 Coding 有 code / display | `replace_coding` / `replace_system` | 找出該元素綁定的 ValueSet（剖面與基底定義的 snapshot：含 slice、`.coding` 子元素、maxValueSet / additional binding），用 Coding 的 display / code 在這些 ValueSet 內做 `fhir_normalize_code` 檢索 → 整組 `{system, code, display}`（`dosageInstruction.route` 的 `oral` → SNOMED `26643006` Oral route、TW `medication-path-tw` `PO` 口服），`value` 為代碼、`system` / `display` 另附；另列這些 ValueSet 所引用的 CodeSystem（含有該代碼者 0.9，沒有者 0.35） |
| `Wrong Display Name` | `replace_display`（+ `replace_code`） | validator 列出的有效 display（各術語格式一致），若寫的 display 其實是另一個代碼的名稱，也提示改代碼 |
| `Unable to find a profile match for urn:uuid:X` | `caused_by` | 被參照資源本身的錯誤（`fullUrl`、`entry`、`path`、`message`）；它本身沒有錯時，改列它對該參照要求的剖面驗證時的錯誤（附 `profile`）；X 是標籤式引用時另附 `replace_reference` |
| `UUIDs must be valid and lowercase`、缺 fullUrl、`URN reference is not locally contained`、`Entry N matches … by type and id`、`Relative Reference … missing a fullUrl`、`Invalid Resource id`、bdl-7 / bdl-11 | `replace_fullurl` / `replace_reference` / `replace_id` / `move_entry` / `replace_bundle_type` | `fhir_finalize_bundle` 會套用的確定性修正值（同一輸入永遠相同）；無法解析的引用列出同型別 entry 的 fullUrl 作候選（信心較低）；整份對照表在 `data.id_map` / `id_changes`（見「Bundle 定稿」） |
| `Constraint failed: bdl-11`（document 卻完全沒有 Composition；bdl-12 的 message / MessageHeader 亦同；隨之而來的 bdl-9 / bdl-10 只附第 1 種） | `replace_value` / `add_resource` | 1. `Bundle.type` 改成 entry 形狀支持的型別：沒有 request → `collection`（0.8）；每筆都有 `request` → `transaction`（0.7），彼此沒有引用時另列 `batch`（0.4）；部分有 request → `transaction` / `collection`；每筆都有 `search` → `searchset`。剖面固定了 `Bundle.type` 時不建議改型。2. 補一筆 Composition（或 MessageHeader）作第一筆 entry（`patch.op = add`，`Bundle.entry[0]`），`reason` 列出核心 StructureDefinition 要求的元素（status、type、date、author、title …）。Composition 存在但不在第一筆時由上一列的 `move_entry` 處理 |

`patch` 以 validator 的點路徑表示（`op`: `replace` / `move` / `remove`，`move` 另有 `from`；移到尚不存在的重複元素時路徑帶 `[0]`）。`confidence` 是啟發式分數，不是機率，但各 `kind` 的區間固定：完全 / 大小寫改名 > 移動 > 語意改名 > 移除；建議是輔助，套用後請再驗證一次。建議的排序與內容對同一輸入是固定的（決定性），計算失敗時該 issue 只是沒有建議，不影響驗證結果。評估方式與數據見 `node-server/scripts/suggestions-eval/`。

> 程序內驗證以剖面 snapshot 與術語綁定為基礎，比對基準為 HL7 validator_cli 7.0.1（稽核方式與結果見 `node-server/scripts/validator-audit/`），但不等同官方 HL7 FHIR Validator 的一致性認證。

### slice / profile 不符說明（slice_match / profile_match）{#slice-match}

三種錯誤（訊息與 HL7 validator_cli 相同、不變）會多一個說明欄位（v16 R3，`fhirSuggestions/slices.ts`，對任何 IG 通用）：

| 錯誤 | 欄位 | 內容 |
|---|---|---|
| `This element does not match any known slice defined in the profile P and slicing is CLOSED` | `slice_match` | `closest`：最接近的 slice（依判別條件評分：resourceType、meta.profile 關係、fixed / pattern 值、required 綁定）與其 profile；`others`；`failed`：沒過的判別條件與原因（`meta-profile-missing` / `-misspelled` / `-other-version` / `-not-array` / `-other`、`resource-type-differs`、`pattern-differs`、`value-missing`、`not-in-valueset`、`reference-unresolved`）；`blocking`：該資源依最接近 profile 驗證的前 5 個錯誤（`blocking_total` 為總數）；`hint` |
| `Slice 'S': a matching slice is required, but not found (from P)` | `slice_match` | `closest.item`：最可能填這個 slice 的項目（優先沒對上任何 slice 的）與它沒過的原因、`blocking`；沒有同型別的項目時 `closest: null`，`hint` 與 `add_resource` 建議說明要依哪個 profile 撰寫（不會自行產生） |
| `Unable to find a profile match for R among choices: …` | `profile_match` | `target`（被引用的資源、宣告的 meta.profile）、`closest` profile、`failed`、`blocking` |
| `Constraint failed: <key>: …`（profile invariant） | `invariant` | v16.2：不成立的子條件與缺漏路徑；extension 條件附 URL、值型別與 `write`（要寫入的 JSON）；`條件 implies …` 只在條件成立時說明 |

`blocking` 來自該資源自己已報的錯誤（它宣告了該 profile 時），否則對最接近的 profile 單獨驗證一次（每次呼叫最多 12 組，依錯誤順序事先規劃，結果可重現）。meta.profile 沒有提供線索、多個同型別 slice 分數相近時，會各驗一次，取錯誤最少（不符的 fixed / pattern 值另加權）的那個。最接近的 profile 唯一、而資源沒有正確宣告它時，附 `set_profile` 建議（`patch` 設定 `meta.profile`；`confidence` 0.9 表示沒有其他錯誤，0.6 表示仍需修正 `blocking`）。以 TWPAS 範例 Bundle 破壞單筆 entry（刪除必填元素，並可再刪除或拼錯 meta.profile）評估：1,752 個相關錯誤全部附說明；關於該 entry 的 426 個中 421 個（98.8%）最接近的 profile 正確、426 個 `blocking` 都指出被刪的元素（`node-server/scripts/v16-structure-eval/evalSlices.ts`）。

<!-- v19 R3 -->
### 可直接套用的修正（pointer / patches，v19 R3）{#v19-pointers}

`fhir_validate_bundle` / `fhir_validate_resource` 的每個 issue（`issues` 與 `entries[i].issues`，含 record checks）另附：

- **`pointer`**：RFC 6901 JSON Pointer，以**呼叫端送出的那一份** Bundle / 資源為根，例如 `/entry/3/resource/code/coding/0/display`。由驗證器的 `path`（`Bundle.entry[3].resource.code.coding[0].display`）換算，支援 `.value.ofType(string)` → `valueString`、`value[x]`、`[url='…']`、`extension('…')`、`/*Type/id*/` 註解與單一資源的根型別。
- **`pointer_kind`**：`element`（指到 issue 所說的元素本身）或 `ancestor`（該元素不存在，例如缺少必填元素，pointer 指向應加入該元素的父元素）。
- **`patches`**（只有 error / fatal，且有候選時）：`[{ops, reason, kind, confidence}]`，`ops` 是 RFC 6902 JSON Patch，每個 path 都是送出 Bundle 中的 JSON Pointer（陣列索引正確，`/-` 表示附加）。來源：`suggestions[].patch`（改名 / 搬移 → `move`、替換 → `replace`、新增 → `add`、刪除 → `remove`；`replace_fullurl` 另含指向該 fullUrl 的所有 reference）、只有一種修法的形狀錯誤（單值包成陣列、單元素陣列拆開、空陣列 / null / 空字串 / 空物件移除、剖面固定的字串值）、其他 issue 的修正（拼錯 / 放錯位置的屬性改名後補上必填元素；所有屬性都無法辨識而為空的元素（ele-1）；只被可修正的錯誤擋住的 slice / profile 比對）、closed slice 的判別值（如 Coding.system，取自 IG，不取自病歷）。**每個候選回傳前都會在送出 Bundle 的深拷貝上實際套用**，套不上的一律捨棄；多個候選彼此獨立，擇一套用。病歷值不會被捏造：缺少的臨床內容只有 pointer，沒有 patch。
- **`entries[i].pointer`**：該 entry 在送出 Bundle 中的位置（`/entry/<索引>`）。

`normalize_ids=true` 時驗證的是 `normalized_bundle`，document 的 entry 可能被重排（Composition 移到第一筆）；pointer 與 patch 都依定稿器的 entry 排列換回送出 Bundle 的位置，並以 fullUrl（經 `id_changes` 還原改名前的值）確認是同一筆 entry。預設模式下 ID 類 `suggestions` 的路徑也改為送出 Bundle 的位置（先前是重排後的位置）。既有欄位（`path`、`suggestions`、severity、訊息、`valid`）完全不變。

<!-- end v19 R3 -->

## IG 結構：Bundle 藍圖與最小骨架 {#ig-structure}

撰寫要符合某個 Bundle profile 的 Bundle（例如事前審查申請、文件 Bundle）時，先用這兩個工具取得 IG 的**結構知識**，再撰寫資源。兩者都只讀 StructureDefinition snapshot、IG 的 ValueSet 與 IG 自己的範例，適用任何已安裝的 IG（不含任何 IG 專屬規則）。

| 工具 | 回傳 | 參數 |
| :--- | :--- | :--- |
| `fhir_get_bundle_blueprint` | Bundle profile 的藍圖（整個回應 ≤ 4,000 字元）：`slices`（每個 entry slice 的名稱、`min..max`、要求的 resource profile；profile 名稱接在 `profile_base` 之後，否則為完整 URL；省略 `min..max` 表示 `0..*`）、`entry.slicing`（discriminator、是否 **closed**——closed 時不屬於任何 slice 的 entry 即為錯誤——以及是否 ordered）、`type`（固定的 Bundle.type）、`references`（各 slice profile 要求的 slice 間引用，包含 extension 內與有 slice 的 backbone 內的引用，target profile 也比對其衍生的 profile；例如 `claim: extension:encounter.valueReference -> encounter`、`coverage: payor -> organizationOrg`；無後綴 = 必填，`if X used` = 有填 X 時必填）、`recipe`（怎麼寫：每個 entry 的 `resource.meta.profile` 設為其 slice 的 profile、包含所有必填 slice、fullUrl 用 urn:uuid、引用寫目標 entry 的 fullUrl；document / message 的首筆資源）。`omitted` 記錄因長度省略的引用與 slice 數；`view="references"` 回傳全部引用 | `bundle_profile`, `package_id`, `version`, `view`（`summary` 預設 / `references`） |
| `fhir_get_minimal_skeleton` | 剖面的**最小合法骨架**與**每個必填值的來源**（整個回應 ≤ 6,000 字元）：`skeleton`（遞迴列出所有必填元素：必填 slice、extension（依其定義展開 url 與 value）、已填入的 fixed / pattern、`meta.profile`；把每個 `<...>` 換成實際值）與 `table` 的 `[path, value_source, how]` 列；`conditional`（profile invariant `<條件> implies (a.exists() and …)` 帶出的條件必填，條件文字在 `conditions`）、`rules` / `more_rules`（其他 invariant）、`examples`（範例實例數 / 相異數）、`omitted` ；`slices`（v16.1：骨架中每個 slicing 元素——CLOSED，或有必填 slice 的 OPEN——的判別方式與每個可用 slice：`[名稱, min..max, 範本]`，範本是該 slice 的 fixed / pattern 值加上要填的 `<...>`；必填的 CLOSED 元素沒有必填 slice 時，骨架放第一個 slice 的範本而不是對不上任何 slice 的通用寫法）、`literals`（看起來像佔位符、但 IG 規定要原樣照抄的值，例如 `NNxxx`）| `profile`, `package_id`, `version` |

`value_source` 的判定（全部由資料推得）：

| 值 | 意義與規則 |
| :--- | :--- |
| `ig-constant` | 剖面的 fixed / pattern（含 extension url，已填在骨架中）；或在 IG 自己的**所有**範例實例中**完全相同**的值（至少 2 個實例，值不同就不算）。可採用的元素依資源種類而定（1.6.0 起，v17.4）：身分類資源（Organization、Location、Practitioner、PractitionerRole、Patient、RelatedPerson、Person、Group）以及任何資源的 name / telecom / address / identifier / contact 等身分 / 聯絡元素，**一律不從範例取值**（範例醫院、診所、檢驗所、醫師、病人只是眾多之一，照抄就是捏造），改為 `record`；唯一例外是**國家級給付 / 主管機關**的 Organization profile——由 profile 推得、不寫死任何機構名稱或網址：(a) profile 把 `Organization.type` 以 fixed / pattern 釘為 organization-type 的 `govt` / `pay` / `ins`，或 (b) IG 自己的 profile 只從給付 / 主管類參照（`*.payor`、`*.insurer`、`*.payer`、`*.authority`，例如 `Coverage.payor`、`ClaimResponse.insurer`）指向它、沒有其他元素指向它（同時被 custodian / performer / assigner 等指向的通用機構 profile 不算），或 (c) 衍生自前兩者。這類機構 IG 在每個範例都重用同一個時，其任何元素皆可（例如 TWPAS 的健保署：`Coverage-twpas` 的 `Coverage.payor` 與 `ClaimResponse-twpas` 的 `ClaimResponse.insurer` 只指向 TW Core `Organization-govt-twcore`，該 profile 的 type 也釘為 `govt`），`how` 會說明判定依據；HealthcareService、Endpoint、OrganizationAffiliation 的非身分元素照舊；其他資源只限工作流程 / 推導類代碼（required / extensible 綁定的狀態類元素、boolean），且需至少 2 個**相異**實例——病歷事實（日期、數值、姓名、識別碼、性別）與主要臨床代碼一律不算 |
| `code-lookup` | 綁定為 required（或 coding 為必填）的代碼元素：小型綁定直接列出代碼（含顯示名稱），大型的指出 ValueSet，以 `fhir_normalize_code` / `fhir_expand_valueset` 查詢；preferred / example 綁定的代碼只是示意，不列出 |
| `text-allowed` | 綁定不是 required、且 coding 非必填的 CodeableConcept：只寫 `{text}` 也合法（有合適代碼時再加 coding） |
| `derivable` | 不需要病歷事實即可算出：引用（目標 entry 的 fullUrl）、`sequence` / `rank` 編號、工作流程預設值、既有的推導規則、有綁定之 Quantity 的 system、`insurance.focal`、撰寫日期類元素（`Claim.created`、`authoredOn`、`recordedDate`、名稱為 recorded date 的 extension 等：用病歷中該項的日期，否則用就診 / 文件日期）；以及（v20 R5）**可由病歷推得**的元素——病歷沒有逐字寫出代碼、但已決定其值：`Condition.verificationStatus`（診斷欄 Dx / Impression / A: / 診斷 未加保留 → confirmed，疑似 → provisional，r/o / 待排除 → differential）、`Observation.interpretation`（數值後的 H / L / HH / LL / ↑ / ↓ 標記，或病歷的參考範圍：超出 → H / L，範圍內 → N）、`MedicationRequest.category`（出院帶藥 → discharge、門診 → outpatient、住院 → inpatient；限綁定中有這類代碼）。這些列的 `how` 為 `derive from the record: <規則> (record cue: <線索>)`，屬於病歷事實，請依線索填寫；它們優先於範例常數與工作流程預設值 |
| `record` | 其餘：必須來自病歷的臨床或行政事實 |

只有 `record` 列需要病歷；`ig-constant`、`code-lookup`、`text-allowed`、`derivable` 的值病歷沒寫並不是拒答的理由。骨架以外的元素都是選填。建議流程：`fhir_get_bundle_blueprint` → 每個 slice profile 呼叫 `fhir_get_minimal_skeleton(profile, package_id)` → 撰寫資源（自行寫 JSON，或 `fhir_author_resources` + `fhir_assemble_bundle`）→ `fhir_finalize_bundle` / `fhir_validate_bundle`（帶 `bundle_profile`）。`package_id` 請傳要撰寫的 IG——範例常數以該 IG 的範例為準（該 IG 沒有此 profile 的範例時才用 profile 所屬套件的範例）。

### 預填表單（fhir_get_bundle_form，v19）{#bundle-form}

`fhir_get_bundle_form` 回傳一份**結構已經正確的骨架 Bundle**，模型只需要填值，不需要再決定結構。

| 參數 | 說明 |
| :--- | :--- |
| `bundle_profile` | Bundle profile 的 id 或 canonical（`|version` 依其版本） |
| `package_id`、`version` | 選擇 IG，與其他 `fhir_*` 工具相同 |
| `entries` | 選填：模型計畫寫入的 entry，`[{profile, count?}]`（profile id / canonical，或資源型別名稱；`count` 1–5） |
| `bundle_type` | 選填：profile 沒有固定 `Bundle.type` 時使用（未給時：profile 要求 Composition 為 `document`，否則 `collection`） |

骨架包含：Bundle profile 的每個必要 entry slice（依 min 次數）與計畫的 entry（對應到其 profile 所符合的 slice；slicing 為 closed 且無對應 slice 時不加入並附 warning）、必填 reference 指向的目標但 Bundle 中尚無者（加入該目標的 slice，或在 open slicing 時加入目標 profile）；每個 entry 的 resource 都是該 profile 的完整最小骨架（必填元素、fixed / pattern、`meta.profile`、必填 extension 與 slice；closed slicing 的必填元素依 IG 範例最常用的 slice）；`Bundle.meta.profile`、`Bundle.type`；可重現的 `fullUrl`（urn:uuid v5）；entry 間的 reference 全部接好（含 extension 內）——只有一個候選時直接填 fullUrl，多個候選時不猜，改為 placeholder 並在 `allowed` 列出候選；document Bundle 的 Composition 放在第一個 entry、必要 section（含判別用的 section code）、計畫的 entry 所屬的 section（選填 section 會加入並標為選填），以及 `section.entry`、`identifier` / `timestamp`；transaction / batch 的 `entry.request`。表單的 Bundle 內不會出現空陣列（空陣列本身就是官方 error，ele-1）：沒有任何 entry（剖面沒有必要 slice、也沒帶 `entries`）時省略 `entry`，並在 `notes` 提示帶入 `entries`（1.0.1）。

**placeholder**：每個需要由病歷（或代碼查詢）提供的值，在骨架中是字串 token `<<P<n>:<value_source>>>`，對應 `placeholders[n]`：

| 欄位 | 說明 |
| :--- | :--- |
| `pointer` | 該 token 在 `bundle` 中的 JSON Pointer（RFC 6901） |
| `type` | FHIR 資料型別：把 token 換成該型別的 JSON 值（primitive → 字串 / 數字 / 布林；`Reference` → `{"reference": "<某個 entry 的 fullUrl>"}`） |
| `what` | 要填什麼（一句話） |
| `value_source` | `record` / `code-lookup` / `text-allowed` / `derivable`，與 `fhir_get_minimal_skeleton` 相同 |
| `required` | `false` 表示選填（條件必填的元素、為計畫 entry 加入的選填 section）：`if_empty` 說明不填時刪除 |
| `allowed` | 選填：小型綁定的代碼（`{system, code, display}`，選代碼時同時設定其 system）或 reference 的候選 fullUrl |
| `target` | 選填：reference 的目標型別 |
| `example` | 選填：IG 範例中的值或該綁定中的一個代碼（只示範格式，不可當成病歷事實）；身分類資源與身分類元素一律不給（見下） |
| `format` | 選填：profile `matches('…')` invariant 要求的正規表示式（1.2.0 起也含 `x.all(code.matches('…'))` / `x.all(toString().matches('…'))`，此時 `format_rule` 註明來源規則 `{key, human}`） |
| `max_length` | 選填：該值的 `maxLength`（1.1.0） |
| `value_set` | 選填：代碼太多無法列出的必要綁定（如以 ValueSet 綁定的機構代碼）：從此 ValueSet 選一個代碼（1.1.0） |
| `rules` | 選填：條件會檢查這個值的 profile 規則；`allowed` 中帶 `triggers` 的代碼會讓該規則要求 Bundle 再包含其他內容（排在最後）。1.2.0：無法有把握解析的規則以原文（`key: human`）掛在它讀取的 placeholder 上，不猜 |
| `choose_one` | 選填（1.2.0）：這個 placeholder 是「多選一」規則中**被放進表單的那一個選項**：`{rule: {key, human}, options: [{path, what, chosen?}], note}`；要改用其他選項時，換掉整個元素，絕不同時填多個 |
| `required_if` | 選填（1.2.0）：只有條件成立時才必填（此時 `required: false`）：`{rule: {key, human}, condition, when: {expression, context, depends_on}, element, placeholders}`——`when.expression` 是在 `when.context`（`""` = Bundle，`/entry/<i>/resource` = 該資源）上求值的 FHIRPath，`placeholders` 是條件讀取的 placeholder；條件不成立時刪除 `element` |

另有 `entries`（每個 entry 的 index、fullUrl、resourceType、profile、slice、加入原因）、`prefilled`（已填入的預設值，病歷另有記載時才改）、`references`（已接好的 reference）、`summary`、`notes`、`self_check`、`omitted`（回應 ≤ 30,000 字元；超過時依序縮短 `what`、省略 example / display / references，`prefilled` 只縮成 pointer + value_source、不省略，placeholder 一律不省略）。填完後交給 `fhir_finalize_bundle` / `fhir_validate_bundle`（帶 `bundle_profile`）。

**1.1.0（評測回饋）**：

- **不從 IG 範例帶入身分資料**：身分類資源（Organization、Location、Practitioner、PractitionerRole、Patient、RelatedPerson、Person、Group）的任何值，以及任何資源中的身分 / 聯絡元素（name、telecom、address、identifier、contact、alias、photo），只要值**只來自 IG 範例**，就不預填、也不放進 `example`——一律是 `record` placeholder（範例診所的名稱、電話、地址、範例中的外國機構識別碼都會被模型照抄，等同捏造）。只有 profile 以 fixed / pattern 釘住的值會預填；因此「全國唯一的機構」的定義是：其身分（識別碼 system + value，或 reference）由 profile 本身以 fixed / pattern 指定，而非由範例推得。其他資源的工作流程代碼（status / intent 等，`fhir_get_minimal_skeleton` 的規則）照舊。`fhir_get_minimal_skeleton` 1.6.0 起採用同一嚴格規則，唯一例外是國家級給付 / 主管機關（見「[值的來源](#ig-structure)」），其 ig-constant 仍是 grounding 豁免的依據。
- **資料型別規則**：有 `value` 的 ContactPoint 一定帶 `system` placeholder（cpt-2，`allowed` 為 phone / fax / email …）；Age / Duration / Distance / Count 依其資料型別 StructureDefinition 的約束（age-1、drt-1、dis-1、cnt-3）補上 `code` placeholder 與規則固定的 `system`（`http://unitsofmeasure.org`，列在 `prefilled`），時間單位列在 `allowed`（Age：age-units）；複合型別的 placeholder 展開成最小內容（Ratio → numerator + denominator，rat-1；Quantity、Period、Identifier …）；編碼元素的必要子元素（如 `Medication.form.text`）也有 placeholder；「至少一個」規則（org-1：name 或 identifier）在都沒有時補上其中一個。
- **每個 entry 都有連結**：每個 entry 都必須經由 reference（正向或反向，同 validator_cli 的 document 規則）連到根 entry（document / message）或其他 entry（collection 等）。沒有連結的 entry 依序：放進列有它、且可重複的未決 reference（例如 Composition.author 在 Patient / Practitioner / Organization 間未決時，放入沒有人引用的 Practitioner）；或用它自己的選填 reference 指向表單的中心 entry（其他 entry 都引用的那一個，例如 Encounter.subject → 唯一的 Patient）；或由表單中唯一能引用它的元素引用；否則不放進表單並在 `notes` 說明（必要 slice 或非 document 的計畫 entry 則保留並附 warning）。絕不在多個位置之間猜測。
- **`self_check`**：建好後檢查表單本身（placeholder 視為有值）：沒有空陣列 / 空物件 / 空字串、每個 reference 都指向 entry 的 fullUrl、每個 entry 都有連結、ContactPoint 有 system、Quantity 類有 system + code。乾淨時為 `{ok: true}`，否則 `{ok: false, problems}` 並附 warning。

**1.2.0（profile invariant → 表單結構）**：每個 entry 剖面與 Bundle 剖面的資源層級 constraint，**只依其 FHIRPath** 轉成表單結構與 placeholder 提示（不寫任何 IG 特例）：

- **多選一**：`a.exists() or b.exists() or …` 都不在表單中時，只放入**第一個**選項；`x.where(p).exists()` 若有多個 slice 的 pattern 滿足 `p`（例如「身分證、護照或居留證至少一種」），只放入第一個（mustSupport 優先）slice。被放入的選項的 placeholder 帶 `choose_one`，列出所有選項。
- **條件必填**：`G implies (x.exists() and …)`、`A or (x.exists() and …)`、`X.where(C).all(y.exists())`：條件讀取的是病歷要填的 placeholder（例如醫令類別代碼）時，必要元素以 placeholder 放入並標 `required_if`（`required: false`、`if_empty`）；條件由預填 / fixed 值就能決定時，成立即為一般必填、不成立則不放入。
- **格式**：`x.matches('re')`、`x.all(code.matches('re'))`、`x.all(toString().matches('re'))` → placeholder 的 `format` + `format_rule`。
- **Bundle 層級規則**：`entry.resource.ofType(X).where(c).exists() implies entry.resource.ofType(Y).y.exists()` 這類跨 entry 規則，把元素加到 Y entry（沒有就建立），`required_if.when.context` 為 `""`（在整個 Bundle 上求值）。
- 新增元素依 snapshot 建立：先找 `where()` 條件滿足的 slice（含其 fixed / pattern / 必填子元素），否則依 `where()` 中的等式；在複本上進行，所有步驟都能解析才採用（不會只放半個元素）。無法有把握解析的規則以原文掛在 `rules`。

回應壓縮時（`omitted.level` ≥ 1），規則只以 key 引用（`rule: {key}`、`rules: [key]`），文字列在 `rule_text`；`required_if.when` 改為 `conditions` 表的 key（同一條件只列一次）。IG 範例值在 `what` 縮短之後才省略。

驗收（ISSUES_v19 (b)，離線以本機套件快取執行 `node-server/scripts/ig-blueprint/form-eval.mts`）：TW Core `Bundle-twcore`（計畫 5 個 entry）、TWPAS `Bundle-twpas`、`Bundle-immunologic-agent-twpas`、IPS `Bundle-uv-ips`（計畫 6 個 entry）、EMPD `Bundle-EMPD`、`Bundle-DS` 的骨架，依 placeholder 的 `type` 填入假值（有 `allowed` 取第一個、有 `format` 產生符合的值、有 `example` 用 example；`choose_one` 只填所給的選項；`required_if` 依填入的條件值求 `when`，不成立就刪除 `element`）後，以內建 validator 驗證皆為 0 個非術語 error。

## 從欄位值撰寫資源 {#authoring}

模型不再自己寫 FHIR JSON：它只給**欄位值**，MCP 依剖面組出資源、驗證、存在每個任務專屬的 **context**，最後由 key 清單組裝 Bundle。所有規則都來自解析到的套件 StructureDefinition / ValueSet 與 FHIR R4 核心，**不針對任何 IG 寫特例**（TW Core、TWPAS 或其他已安裝 IG 都一樣）。

| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_get_authoring_fields` | 剖面的「填寫表」：`fields`（必填 / 預期 / IG 範例中常用，`why` 說明原因）、`more`（其餘 mustSupport 欄位與 record link）、`omitted`（因長度省略者，不會默默丟掉）。**Record link**：選填、IG 未標 mustSupport、範例也沒用到，但其必填 Reference 子元素指向同一 IG（同 canonical base）中非實體類型（不是 Patient / Practitioner / Organization / Location 等人員或機構主檔）剖面的 backbone，例如 `Encounter.diagnosis`，會列在 `fields` 並附全部子欄位（`condition`、`use`、`rank`）與範例 `{condition: {ref: "condition"}}`；直接指向這類剖面的 reference（`Encounter.reasonReference`、`Condition.encounter`、`Procedure.reasonReference`、`Observation.hasMember` / `derivedFrom`）列在 `more` 並附 `targets`。整個回應（envelope、warnings、provenance，非 ASCII 字元以 `\uXXXX` 計）不超過 6,000 字元（保留 150 字元餘裕），實際長度見 `data.response_chars`。每個欄位有 `kind` + `format`（值怎麼寫）、`source`（record / facility / code / fixed / default / derived）、小型 `binding.codes`、`targets`、`children`；`auto: true` 的欄位由 MCP 自動補（`value` 顯示補什麼），`pins` 顯示剖面在你要填的欄位裡固定的部分（identifier system、component code、單位）。慣例預設值只在**必填**欄位上是 `auto`；選填欄位（`Patient.active` 等）列為一般選填欄位，`format` / `example` 只提示慣例值。**可由病歷推得的欄位**（v20 R5：`Condition.verificationStatus`、`Observation.interpretation`、`MedicationRequest.category`，規則同 `fhir_get_minimal_skeleton` 的 `derivable`）是 `source: "derived"` 但**沒有** `auto`，`format` 以 `derive from the record: …` 開頭：病歷有對應線索時一定要寫；只要 profile 允許該元素（任何 cardinality）且綁定含規則的代碼（IG 自訂 ValueSet 以 display 對應）就列在 `fields`；必填者仍保留工作流程預設值作為未填時的後備 | `profile`, `package_id`, `version`, `include_more`（預設 `true`） |
| `fhir_author_resources` | 1.10.0（v16：驗證同 `fhir_validate_resource` 1.14.0）；1.9.0（v15.4：驗證同 `fhir_validate_resource` 1.13.0）；1.8.0（v15.3：驗證同 `fhir_validate_resource` 1.12.0）；1.7.0（v15.2：`alt-coding` 修正、候選附 `accepted_by_validator`）；一次撰寫多筆資源（8 筆以上沒問題）：`{key, profile, fields}`；MCP 補 `meta.profile`、fixed / pattern、slice、必填欄位的 workflow 預設值、可推導的值（例如有 encounter 的 Condition.category）、display、UCUM 單位、民國日期轉 ISO，並做下述「自動修正」，然後驗證並存進 context。回傳 `{context_id, storage, results[{key, status, resource, provenance, missing, refs, issues, notes}], summary, settings}` | `context_id`（第一次省略）, `resources`, `timezone`, `apply_defaults`（`required` / `none`）, `site_config` |
| `fhir_context` | 檢視或清理 context：`list`（每個 key 的狀態與引用）、`get`（單一 key 的完整結果）、`delete`（單一 key 或整個 context） | `context_id`, `action`, `key` |
| `fhir_assemble_bundle` | 1.10.0（v16 R5：有 `bundle_profile` 時，驗證前先把每筆資源放進對應的 entry slice，回報 [`bundle_slices`](#assemble-slices)；修正同 `fhir_finalize_bundle` 1.8.0、驗證同 `fhir_validate_bundle` 1.17.0）；1.9.0（v15.4：資源同 `fhir_author_resources` 1.9.0、驗證同 `fhir_validate_bundle` 1.16.0）；1.8.0（v15.3：資源同 `fhir_author_resources` 1.8.0、驗證同 `fhir_validate_bundle` 1.15.0）；1.7.0（v15.2：同 `fhir_author_resources` 1.7.0 / `fhir_finalize_bundle` 1.5.0 / `fhir_validate_bundle` 1.14.0）；由 key 清單組 Bundle：每個 entry 的 fullUrl 是該 key 的確定性 urn:uuid，經 `fhir_finalize_bundle` 的規則定稿、`fhir_validate_bundle` 驗證（給 `source_text` 時另做 grounding）；issue 都帶 `key` 與模型欄位名 | `context_id`, `keys`, `bundle_type`, `bundle_profile`, `identifier`, `timestamp`, `source_text`, `site_config`, `allow_invalid` |

**流程**

1. 規劃每筆資源一個 key（`patient-1`、`enc-1`、`cond-1`、`obs-wbc` …）。
2. 每個剖面呼叫一次 `fhir_get_authoring_fields(profile)`。
3. 第一批呼叫 `fhir_author_resources` **不帶** `context_id`，保留回傳的 `data.context_id`；互相參照寫 `{ref: "<key>"}`，可以指向還沒建立的 key（狀態 `refs_pending`，組裝時再解析），循環引用（`Encounter.diagnosis` ↔ `Condition.encounter`）沒有問題。
4. `status: invalid` 的資源用**同一 key + `merge: true`** 只重送要改的欄位（`null` 代表刪除該欄位）；issue 帶 `key`、`field`（模型欄位名）、`path`（FHIR 路徑）與 `suggestions`。
5. `fhir_assemble_bundle(context_id, keys, bundle_type)`；document 型 Bundle 先撰寫 Composition（`section.entry` 用 `{ref}`），並由病歷給 `identifier` / `timestamp`（bdl-9 / bdl-10）。

**值的寫法（value grammar）**

| 類型 | 可接受的寫法 |
| :--- | :--- |
| string / code / boolean / integer / decimal | JSON 純量；數字保留原始寫法（`12.50` 仍是 `12.50`，`1e2` 仍是 `1e2`） |
| coding / codeableConcept | `{system, code, display?}`；多個碼用陣列；沒有 required binding 時可只給 `{text}` 或字串 |
| quantity | `{value, unit}`（單位文字或 UCUM，MCP 補 UCUM system / code）或字串 `"95 mg/dL"` |
| date / dateTime / instant | ISO `2026-06-15`、`2026-06-15T06:00`，或民國 `115/06/15`、`115/06/15 06:00`（精度保留）。沒有時區的時間需要 `timezone`（例如 `"+08:00"`，記在 context 上），否則回報錯誤——**不會猜時區** |
| period | `{start, end?}`，日期寫法同上 |
| identifier | `{value, system?, type?}`；slice 寫成 `identifier:medicalRecord` |
| reference | `{ref: "<key>"}`（同一 context 的資源）或 `{reference: "Patient/123"}`（外部） |
| choice `value[x]` | 給 `value`，由值的形狀決定型別（quantity → `valueQuantity`，`{system, code}` → `valueCodeableConcept` …），也可直接寫 `valueQuantity` |
| component | `[{code, value}]` 或 `component:<slice>` `{value}` |
| extension slice | `extension:<slice>` 給 `{value: …}` 或直接給值（`{ref}`、`{system, code}`…），MCP 依 extension 定義寫成 `{url, value[x]}`；已帶 `url` 的 FHIR JSON 原樣保留 |
| dosage | `{text?, route?, dose?, frequency?/timing?, period?, asNeeded?}` |

**原則**：模型的值優先（只有 fixed / pattern 會覆蓋，衝突時回報錯誤；被術語判為錯誤的 display 依下述「自動修正」換成代碼的 display）；病歷或院所才知道的值（日期、數值、識別碼、姓名、劑量、時區、Bundle.identifier / timestamp）**絕不捏造**，缺少時列在 `missing`；MCP 補的值在 `provenance` 標為 `fixed` / `default` / `derived` / `lookup`。

**自動修正（列在 `results[].notes`）**

- **display 由代碼決定**：模型寫的 display 若在代碼可解析時被術語規則（與 `fhir_validate_resource` 相同的檢查）判為錯誤，就換成該代碼的 display（`provenance` 為 `lookup`，note `display replaced for <field> (was '<舊值>')`）；該 CodeableConcept 沒有 `text` 時，模型原本的字移到 `.text`（`provenance` 為 `model`），不會遺失。大小寫不同視為正確；只差空白時改成正確寫法、不另加 note。此規則**不更動 code**；代碼無法解析時保留模型的 display（由驗證回報未知代碼）。例如 LOINC `1988-5` 寫成 display `CRP` → display 換成 `C reactive protein [Mass/volume] in Serum or Plasma`，`text` 為 `CRP`。
- **system 修正**（1.2.0）：模型寫的 `Coding.system` 只在下列兩種情況、且答案唯一時才改（`provenance` 為 `lookup`，note `system corrected for <field>: …`），其餘一律照寫、交給驗證回報（附 v10 的 `suggestions`），**絕不猜**：
  - **system 是 ValueSet URL**（任一已安裝套件的 ValueSet，或 `/CodeSystem/` ↔ `/ValueSet/` 的同名 twin）：code 在該 ValueSet 內（展開 / `valueSetContains`）所屬的 CodeSystem 只有一個時改成它，例如 `Composition.type` 寫成 `{system: "https://twcore.mohw.gov.tw/ig/twcore/ValueSet/loinc-type-doc-code", code: "11488-4"}` → `system: "http://loinc.org"`（note `'<ValueSet URL>' is a ValueSet; code '11488-4' belongs to http://loinc.org`）。（1.3.0）ValueSet 含 filter 定義的 include（例如 `laboratory-code-tw` = LOINC `CLASSTYPE` filter + 健保支付標準代碼的列舉）時，本機展開只是部分內容，不能用來否定成員資格：code 存在於 ValueSet 所含的某個 CodeSystem，且 filter 可判定並成立 → 修正，note 為 `… belongs to http://loinc.org (membership confirmed)`；filter 無法判定、但 code 只存在於 ValueSet 所含 CodeSystem 中的一個 → 修正，note 為 `(membership unverifiable; the code exists only in <CS> among the ValueSet's systems)`。`code: {system, code}` 與原始寫法 `code: {coding: [{system, code}]}` 相同處理。同一 code 在該 ValueSet 中屬於多個 CodeSystem → 回報錯誤並附 `candidates`；code 不在 ValueSet 內（`laboratory`、`WBC`、`hs-Troponin I` 這類不是代碼的值）→ 不修正，驗證回報 `The Coding references a value set, not a code system` error（附候選，見 validator 1.7.0），`status` 為 `invalid`，`fhir_assemble_bundle` 與 `fhir_validate_bundle` 的判定相同。
  - **system URL 解析不到任何定義**（依驗證器的 URL 規則：HL7 空間的 URL 只在 HL7 validator 會報「No definition could be found for URL value」時才算；不是 CodeSystem、ValueSet，也不是已知的外部術語）：在該元素綁定的 ValueSet（含 slice 與 additional binding，與 `fhirSuggestions/bindings.ts` 相同的綁定走訪）中，含有此 code 的 CodeSystem 恰好一個時改成它——先比對完全相同的 code，沒有才比對不分大小寫（唯一時連 code 一起改成正確寫法），最後才比對完全相同且唯一的 display（code 一併換成該 display 的 code）。例如 `MedicationRequest.dosageInstruction.route` 寫成 `{system: "http://terminology.hl7.org/CodeSystem/route", code: "PO"}` → `https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-path-tw`（display 依 display 規則補「口服」）。多個 CodeSystem 都有、或都沒有（例如 `oral`）→ 不改，驗證錯誤的 `suggestions` 會提供 `replace_coding` / `replace_system`。
  - 修正後 display 依上一條規則檢查 / 補齊。
- **單一值包成陣列**：重複元素（max > 1）收到單一物件 / 純量時包成一個元素的陣列，任何深度都適用，包含模型直接傳入的 FHIR 形狀（`code: {coding: {system, code}}`、巢狀物件裡的 `identifier: {…}`、`telecom: {…}`、帶 `url` 的 extension 內的 `extension`、`doseAndRate`）；note `wrapped <path> into an array`。頂層欄位只給一個值本來就是合法寫法，不加 note。

**預設值政策（`apply_defaults`）**：`"required"`（預設）只在剖面**必填**（min ≥ 1，含必填 slice）且模型沒給的欄位補 workflow 預設值（`Observation.status` → `final`、`Encounter.status` → `finished` …）或剖面的 `defaultValue[x]`；選填欄位（`Patient.active`、`Practitioner.active`、`Organization.active`、`Immunization.primarySource`、`MedicationRequest.dispenseRequest.numberOfRepeatsAllowed`、0..1 的 `Condition.clinicalStatus` …）**一律不自動補**，病歷有寫才給。`"none"` 完全不補預設值，必填欄位缺值時列在 `missing`。設定記在 context 上（與 `timezone` 相同）。可推導的值（Condition.category 等）不受影響。

**院所設定（`site_config`）**：與 `fhir_check_grounding` 的 `site_config` 相同格式的自由文字——其中每個 `http(s)` URL 都視為院所的 identifier system，各行文字可作為 Organization 值與 Practitioner identifier 的依據。`fhir_author_resources` 把它存在 context 上（再次傳入時只**附加**尚未存在的行），`fhir_assemble_bundle` 的 `site_config` 會與 context 的合併；有 `source_text` 時一起交給 grounding，院所的 identifier system 與機構資料便以 `site_config` 為依據，不會被標成未 grounding（`G-SYSTEM-NOT-SITE`）。不寫入 log、不回傳原文（`settings.site_config_lines` 只回報行數）。範例：

```json
{"site_config": "病歷號 system: https://hospital.example.tw/mrn\n機構: 範例醫院 醫事機構代碼 0123456789", "resources": [
  {"key": "patient-1", "profile": "Patient-twcore", "fields": {"identifier:medicalRecord": {"value": "MR-00012345", "system": "https://hospital.example.tw/mrn"}}}
]}
```

**Context**：context id 為 128 位元亂數（32 位 hex），存在 Redis `authoring:ctx:<id>`，閒置 60 分鐘清除、每次呼叫都會延長；Redis 不可用時退回單一程序記憶體（回應 `storage: "memory"`，重啟即遺失）。`{ref: key}` 對應到 `urn:uuid:<UUID v5(context id, key)>`——單筆驗證與最終 Bundle 用同一個值，因此**同一 context + 同一 keys 永遠得到位元組相同的 Bundle**。病歷內容不寫入 log（只記 id、筆數、位元組數）。

**錯誤碼**（`{ok: false, data: null, error: {code, message, message_zh, hint, hint_zh, retryable}}`）

| code | 何時 | 下一步 |
| :--- | :--- | :--- |
| `CONTEXT_EXPIRED` | context id 不存在或已過期（不會回傳部分結果） | 不帶 `context_id` 重新開始，以相同 key 與欄位重建全部資源 |
| `KEY_NOT_FOUND` | 組裝 / `get` 的 key 不在 context | `fhir_context action=list` 查看，補建或移除 |
| `UNRESOLVED_REFERENCE` | 某資源引用的 key 不在 `keys` 或不在 context；`error.refused` 列出 key / field / ref_key | 把 ref_key 加入 keys、補建，或以 merge 改欄位 |
| `INVALID_RESOURCE` | 有資源仍有驗證錯誤；`error.refused` 列出 key / field / 錯誤 | 以 merge 修正後重新組裝（`allow_invalid=true` 僅在使用者明確接受時） |
| `MISSING_COMPOSITION` | document 型 Bundle 但沒有撰寫 Composition；`error.missing.fields` 列出它需要的欄位 | 依病歷撰寫 Composition，放在 keys 第一個 |
| `CONTEXT_CONFLICT` | 同一 context 同時被多處寫入且一直衝突 | 重試一次 |
| `INVALID_ARGUMENT` | 參數錯誤（重複 key、缺 profile、`bundle_type` 不合法、`timestamp` 不是 instant …） | 依訊息修正 |

**範例**

```json
{"timezone": "+08:00", "resources": [
  {"key": "patient-1", "profile": "Patient-twcore", "fields": {"identifier:idCardNumber": {"value": "A123456789"}, "name:official": {"text": "王小明"}, "gender": "male", "birthDate": "80/03/15"}},
  {"key": "enc-1", "profile": "Encounter-twcore", "fields": {"class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "IMP"}, "subject": {"ref": "patient-1"}, "period": {"start": "115/06/10 14:30", "end": "2026-06-15T10:00"}, "diagnosis": [{"condition": {"ref": "cond-1"}, "rank": 1}]}},
  {"key": "cond-1", "profile": "Condition-twcore", "fields": {"code": {"system": "http://hl7.org/fhir/sid/icd-10-cm", "code": "J18.9"}, "subject": {"ref": "patient-1"}, "encounter": {"ref": "enc-1"}}},
  {"key": "obs-wbc", "profile": "Observation-laboratoryResult-twcore", "fields": {"code": [{"system": "http://loinc.org", "code": "6690-2"}, {"system": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medical-service-payment-tw", "code": "08011C"}], "subject": {"ref": "patient-1"}, "effectiveDateTime": "2026-06-11T06:00", "value": {"value": 12.50, "unit": "10*3/uL"}}}
]}
```

修正：`{"context_id": "<id>", "resources": [{"key": "obs-wbc", "merge": true, "fields": {"value": "11.8 10*3/uL"}}]}`；組裝：`{"context_id": "<id>", "keys": ["patient-1", "enc-1", "cond-1", "obs-wbc"], "bundle_type": "collection", "bundle_profile": "Bundle-twcore"}`。

`fhir_finalize_resource`（1.4.0）仍適用於「已經寫好的 FHIR JSON 草稿」：只在草稿已有父節點的地方釘上 fixed / pattern 值（含 slicing discriminator 可判定的 slice 成員，以及任何深度的 `_slice` 標記，標記一律移除）、單一系統的 `coding.system`、把 `{reference: <key>}` 改成 context 的 urn、產生 narrative 並驗證，**不會補任何臨床內容**；有欄位值時請改用 `fhir_author_resources`。

### 依 Bundle 剖面放入 entry slice（bundle_slices）{#assemble-slices}

`fhir_assemble_bundle` 給了 `bundle_profile`（v16 R5，`authoring/bundleSlices.ts`，任何 IG）時，驗證**之前**先依 Bundle 剖面的 entry slicing 放置每筆資源：資源宣告的 meta.profile、撰寫時的 profile 決定 slice，否則取同型別唯一或明顯最接近的 slice；資源是依該 slice 的 profile 撰寫、但 meta.profile 沒寫時補上；slicing 為 `ordered` 時依 slice 順序排列。`bundle_slices` 回報 `entries`（每個 key 的 slice 與決定方式）、`missing`（未滿 min 的 slice 與「請依某 profile 撰寫」的指引——絕不自行產生資源）、`excess`（超過 max）、`unmatched`（closed slicing 時沒有 slice 收的資源），並在 `warnings` 摘要。以 TWPAS / TW Core 範例 Bundle 拆成每筆一個 key（去掉 meta.profile、順序反轉）重新組裝：每筆都放回原 slice、meta.profile 補回，驗證錯誤不多於原範例；刪掉必填 slice 的 key 時列在 `missing`（`authoring/bundleSlices.ig.test.ts`）。

## 依據原文檢查（grounding / completeness）

符合剖面（conformance-valid）不代表忠於病歷：模型可能填入病歷沒寫的診斷碼、日期或劑量，而 validator 照樣通過。
下列工具以**確定性規則**（不呼叫 LLM、不用 embedding、不用亂數）比對 Bundle 與病歷原文。術語名稱只查本機資料庫（ICD-10-CM / PCS、LOINC、SNOMED CT、RxNorm、CVX、IG CodeSystem），不呼叫外部 terminology server。

| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_check_grounding` | 檢查 Bundle 中每個臨床事實與代碼是否有病歷原文支持（evidence map 或自動定位），含日期 / 數字 / 單位 / 身分證 / 劑量 / 頻次正規化，以及段落、否定、既往史規則。輸出與 `fhir_validate_bundle` 同構（`entries[].issues`、`issues`），另含 `grounding` 摘要（units_checked、coverage …） | `bundle`, `source_text`（必填）, `site_config`, `evidence_map`, `mode`, `verbosity`（預設 `warnings`）, `policy`, `instruction_markers` |
| `fhir_check_completeness` | 缺漏報告：依呼叫端提供的結構化 `targets`（resourceType、品項、別名、代碼、日期規則），逐一判斷病歷是否寫了必填事實，回傳 found / missing / stated_absent / unknown、缺漏清單、追問句模板與可直接使用的 `abstention`（insufficient_information） | `targets`, `source_text`（必填）, `site_config`, `extracted_facts`（模型自述的事實，工具會驗證而非採信）, `instruction_markers` |

**模式**（`fhir_check_grounding.mode`；`fhir_validate_*` 的 `grounding`）

| 模式 | 有 evidence 的元素 | 沒有 evidence 的元素 |
| :--- | :--- | :--- |
| `strict` | 驗證引文（必須逐字出現於病歷、值相符、段落與情境正確） | error `G-UNGROUNDED` |
| `auto` | 同上 | 工具自動在病歷中定位支持文字；找到給 information `G-AUTO-LOCATED`，找不到或只在情境不符處找到給 error |

預設：有 `evidence_map` 時為 `strict`，否則 `auto`。`evidence_map` 可為 `[{path, quote}]` 或 `{path: quote}`；path 可寫 `Bundle.entry[2].resource.code`、`entry[2].code`、`<fullUrl>|code`、省略 list index 或 `value[x]`。
每個 issue 帶 `rule`、`source:"grounding"`，`message` 以 `[grounding:<RULE>]` 開頭。`【轉換目標】` 等指示行（`instruction_markers`）永遠不算證據；`site_config` 只能作為 `identifier.system` 的依據。

**`fhir_validate_bundle` / `fhir_validate_resource` 的 grounding 參數**（向下相容）

- 沒有 `source_text`，或 `grounding="off"`：輸出與未擴充前**逐位元相同**。
- 有 `source_text`：先跑原本的 conformance，再跑 grounding 並合併：
  `data.conformanceValid`（原 `valid`）、`data.groundingValid`、`data.valid = conformanceValid ∧ groundingValid`、
  grounding issue 依 entry 併入 `entries[i].issues`（Bundle 層級併入 `issues`）、`entries[i].valid` 同步、
  `data.grounding` 摘要、`data.source = "builtin+grounding"`、`provenance.groundingVersion`。
- 呼叫端應檢查回應中有 `data.groundingValid`；沒有代表伺服器版本不支援，不可當成已檢查。
- `fhir_validate_resource` 把單一資源當作 Bundle 的唯一 entry 檢查，issue path 以資源為根（如 `Condition.code`）；無法跟隨參照，因此依賴其他資源的規則看不到上下文。

### IG 定義的值不是病歷事實（v17.2）{#ig-defined-values}

IG 本身規定的值不需要、也不會出現在病歷中。grounding（`G-UNGROUNDED`、`G-CONTEXT-*`、`G-STATED-ABSENT`）與 record checks（`ungrounded-value`、`information-absent`、`value-from-other-event`、`incomplete-value`、`insufficient-precision`）一律豁免下列值，不論出現在資源的哪個位置，豁免數計入 `grounding.exempt`：

- 宣告的 profile（`meta.profile`）中的 `fixed[x]` / `pattern[x]`；
- `fhir_get_minimal_skeleton` 標為 `ig-constant` 的每個值（與 skeleton 用同一個函式計算，兩者不會不一致）。Bundle 中有行政實體（Organization 等）時，也納入 IG 範例中同類型資源所用 profile 的 ig-constant，例如付款機構的名稱與 OID。v17.4 起，從範例取得的身分值（名稱、識別碼、電話、地址）只限**國家級給付 / 主管機關**（判定方式見上方 `ig-constant` 說明）；IG 範例中的醫院、診所、檢驗所、醫師、病人一律不豁免——例如病歷寫「臺大醫院」、Bundle 卻照抄 IG 範例醫院的名稱 / 識別碼，grounding 與 record checks 會照常報錯；
- profile invariant 為 `value[x]` 規定的答案字面值（例如 `value.ofType(string) = 'class1'`）。只豁免 `value[x]` 字串，其他元素的比較條件（如 `gender = 'male'`）不算。

數量（Quantity）與單純數字永遠不豁免。同一行列出多個藥品時，劑量 / 頻次的 evidence 引文判給該行中位於引文前、最接近的藥名；若那是這筆資源自己的藥，就不報 `G-CONTEXT-LABEL`。

**版本與隱私**

- `provenance` 帶 `tool`、`toolVersion`、`lexiconVersion` / `lexiconSha256`、`terminologyVersion` 與 `sourceSha256`（病歷全文 SHA-256 的前 16 碼）。`health_check` 回報 `tools_version`、`lexicon_version`、`lexicon_sha256`。
- 病歷全文（`source_text`）與院所設定不會寫入 log、metric label 或 provenance，只留 `sourceSha256`；格式錯誤的 JSON 請求本文也不會被記錄。

> 規則與詞彙表（`tw-lexicon`）以台灣病歷寫法為準；`fhir_check_completeness` 需要呼叫端讀轉換目標後提供 `targets`，不解析自然語言目標。檢查結果是輔助，不取代臨床人員審閱。

## 病歷是否真的提供了這項資訊（record checks）{#record-checks}

> **parity v2（2026-11-01）**：內容類 error 一律要有 `source_text` 才成立。沒有 `source_text` 的呼叫是純驗證，所有 record checks 的發現都保留，但嚴重度一律為 warning（evidence 註明 `no source_text`），不會改變官方 validator 給的判定。

病歷刻意缺少某項資訊時，模型常常仍會「填上東西」：把「尚未取號」寫進病歷號、把只到月份的日期寫進 `Encounter.period.start`、把「待排除」的診斷寫成確立的 Condition。這些值有時格式合法，甚至字串真的出現在病歷裡，所以 validator 與 grounding 都會通過。**record checks** 是驗證之後的一層（`node-server/src/recordChecks/`，與 [修正建議](#validation-suggestions) 一樣在 validator 之後執行，不改動 InstanceValidator，validator parity 稽核不受影響），專門回報「病歷其實沒有提供這項資訊」。

**只回報、不修正**：不會改寫或刪除任何值，要不要改為回報 `insufficient_information` 由模型決定。

| 規則 | `code` | 需要 `source_text` | 嚴重度 | 判斷 |
| :--- | :--- | :--- | :--- | :--- |
| R1 | `information-absent` | 否 | error | 需要結構化值的欄位（`Identifier.value`、`Coding.code`、日期、`Quantity.value`、Reference、姓名、聯絡方式、`Observation.valueString`、批號、沒有代碼的 CodeableConcept 文字）的**整個值**都是在描述「資訊不存在 / 未知 / 待補 / 尚未取得 / 尚未確立」：例如「尚未取號」「建檔失敗」「尚在申請」「不詳」「待確認」「unknown」「pending」「not yet assigned」。訊息為「病歷沒有提供這項資訊」 |
| R1 | `information-absent`（文字欄位，v15.3） | 否 | error | 文字型欄位的**整個值**是「不存在 / 未定 / 未出 / 未確立 / 待補 / 待排除 / 重抽中 / pending / not yet …」的敘述：`CodeableConcept.text`（沒有 coding，或 coding 都是佔位——沒有 code、v3-NullFlavor / data-absent-reason、代碼本身是 unknown / TBD / --）、藥品資源的 `Dosage.text`，以及代碼需要**數值結果**的 Observation 的 `valueString`（沒有 value[x] 時其 `note`）。是否需要數值結果依序看：LOINC `SCALE_TYP` = Qn 或數量型 `PROPERTY`（MCnc、SCnc、NCnc、CCnc …，由工具從 `loinc.concepts` 查得）、Coding 上的 LOINC 名稱（「[Mass/volume]」「-mCnc」）、生命徵象代碼、vital-signs profile / category、有 low / high 的 referenceRange、同代碼的其他 Observation 有 valueQuantity；只有在這種結果欄位裡，「溶血、凝固、檢體不足、QNS、詳見報告」也算沒有結果，「3 h」「07:00」這類測量時間不算內容。例：`Condition.code = {"text": "暫不下診斷"}`、`valueString = "檢體溶血，重抽中（報告未出）"`。訊息指出是哪一個主要臨床欄位（診斷、檢驗結果、藥品、劑量） |
| R1 | `information-absent`（空殼資源，v15.4） | 否（error 需要） | error / warning | 資源**沒有本應承載的主要值**，卻在旁邊的欄位說明「沒有」：Observation 沒有 `value[x]`、也沒有 component 值（有 `hasMember` 的 panel 不算；只有 `valueString` 而它本身是缺漏敘述時也算，括號內的參考範圍 / 偵測極限如「(< 14)」不算結果）；MedicationRequest / MedicationStatement 沒有結構化劑量或頻次（`doseAndRate`、`timing.repeat`、`timing.code` 都沒有）；Condition 沒有真正的 coding、只有文字。旁邊的欄位——`dataAbsentReason`（代碼與文字）、`note`、narrative `text`、`valueString`、`dosageInstruction.text` / `patientInstruction` / `additionalInstruction`、`statusReason`、`code.text`——**逐子句**判斷（支配規則：子句被缺漏述語支配、且同一欄位沒有任何子句寫出結果，例如「陰性，檢體輕微溶血」不算）。述語分類：結果未出 / 未回（pending-result）、檢體退件 / 不予發報（rejected-specimen）、儀器錯誤（machine-error，含 Err-3）、未定 / 待確認（undecided）、尚難區分 / 鑑別中（indistinguishable）、要看之後的結果（conditional-on-future-result，「要看 Cr 報告」「依…結果調整」「視…而定」）、未做（not-done）。**嚴重度**：有 `source_text` 且病歷中關於**這個項目**的敘述（以代碼文字 / display / 生命徵象標籤 / 術語名稱含中文 / 藥名找到該項目，取該處子句與同句後續子句直到寫出數值為止；Condition 另看診斷欄；或以旁註本身找病歷中相同 / 改寫的子句）寫著未出 / 未定 / 退件 → error，訊息「這筆資源沒有提供病歷中應有的值；病歷寫的是「…」」並提示「若轉換目標需要這個值，請回報 insufficient_information，不要建立空的資源」；病歷寫的是「未做」（本次未做 X 光、拒絕抽血）→ warning；病歷沒有這樣寫或找不到該項目 → warning；沒有 `source_text` → 只有旁註本身是缺漏敘述時給 warning（只有 `dataAbsentReason` 代碼或「未做」→ 不報，所以乾淨的呼叫輸出不變）；`entered-in-error` 不報，`cancelled` / `not-taken` 至多 warning、有未做理由時不報。已由其他規則回報的資源不重複回報。v15.3 的結果欄 note 規則（沒有 `value[x]` 的 Observation，note 說沒有結果、而代碼需要數值結果）在沒有 `source_text` 時同樣只給 warning（1.17.1；有 `source_text` 時仍為 error） |
| R2 | `identifier-format` | 否 | error（見下） | 依 `Identifier.system` 檢查格式：身分證字號（`http://www.moi.gov.tw`）格式與檢查碼；居留證統一證號（`http://www.immigration.gov.tw`）新式 / 舊式格式與檢查碼；任何識別碼不能是敘述句；`site_config` 可為院內系統（病歷號、健保卡號…）指定格式 |
| R3 | `insufficient-precision` | 是 | error | 事件時間（`Encounter.period`、`Observation.effective[x]` / `issued`、`MedicationRequest.authoredOn`、`DiagnosticReport`、`Specimen.collection`、`Composition.date` …，型別 dateTime / instant）只到年或月 |
| R3 | `incomplete-value` | 是 | error | 作為值的 Quantity（`valueQuantity`、`doseQuantity` …）沒有 `value`；藥品只有自由文字、沒有任何代碼，也沒有結構化劑量 |
| R4 | `unconfirmed-as-confirmed` | 是 | error / warning | Condition 沒有標成 provisional / differential / unconfirmed，而病歷中關於它的句子明確表示尚未確立（待排除、尚未確立、鑑別診斷、r/o、differential、not established）→ error；只是語氣保留（疑似、可能、possible、suspected）→ warning。病歷同時有「確診 / 證實 / confirmed」或有未加限定的提及時不報 error |
| R4 | `symptom-for-unconfirmed-diagnosis` | 是 | warning | Condition 用 ICD-10 症狀碼（R00–R99），而病歷的主診斷 / 診斷段落寫著「待排除…」，且 Bundle 中沒有 provisional / differential 的 Condition（病歷主診斷欄可判定時改由下面的主診斷欄規則報 error） |
| R4 | `unconfirmed-as-confirmed`（主診斷欄） | 是 | error / warning | 病歷的**主診斷欄**（Dx / Diagnosis / Impression / Assessment / A: / 診斷 / 主診斷 / 臆斷 …）整體未確立——只有鑑別診斷（鑑別診斷 / DDx / r/o 標題）、欄位層級的限定（未下診斷、診斷未定、no definitive diagnosis、「快篩結果出來前不下診斷」「待…結果後再下診斷」）、或每一項都被限定——而 Condition 沒有標成 provisional / differential / unconfirmed：它是其中一個鑑別項目、`code.text` 抄錄了鑑別清單、是症狀碼（ICD-10 R00–R99、SNOMED finding 語意標籤，或病歷只在主訴 / 現病史 / 檢查提到）代替主診斷，或是病歷沒有確立的其他診斷 → error（只有疑似 / 可能 → warning）。病歷其他地方確立的共病（過去病史、計畫、另一個主診斷欄中未限定的項目）不報 |
| R4 | `information-absent`（沒有診斷） | 是 | error | 有段落結構的病歷完全沒有診斷欄（或診斷欄是空的「診斷：」），而 Condition（不是 provisional / differential、不是 problem-list-item）只出現在主訴 / 現病史 / 檢查，或病歷中找不到 |
| R4 | `information-absent`（主診斷以 provisional / differential 代替，v15.3） | 是 | error | 病歷**沒有任何已確立的主診斷欄**，且明確寫出未確立（只有鑑別診斷、「未下診斷 / 暫不下診斷 / diagnosis pending」等欄位層級限定、每一項都是待排除 / r/o，或「診斷：」是空的），而本次的**主診斷 Condition** 標成 provisional / differential / unconfirmed，或 code 只有文字 → 訊息「病歷沒有確立的主診斷」。主診斷的判定見下；只有語氣保留（疑似 / possible）的診斷欄不報（provisional 本來就是疑似診斷的正確寫法）；病歷主診斷已確立時，次要的 r/o 項目標成 differential 是正確寫法，一律不報 |
| R1 | `information-absent`（陳述缺漏、無值識別碼） | 是 | error | 病歷把欄位寫成缺漏（「病歷號：申請中」「採檢日期：無法辨識」「血糖：機器錯誤，未得數值」「處方：待藥師確認」），且病歷別處沒有給這個欄位值，Bundle 卻有值 → 值不在病歷中時報 `information-absent`，值是病歷中其他事件的（例如用就診日代替採檢日）時報 `value-from-other-event`。有 `system` 但沒有 `value` 的識別碼：病歷沒有這個號碼 → `information-absent`；病歷有 → `incomplete-value` 並附號碼 |
| R5 | `ungrounded-value` | 是 | error（紀錄性時間、衍生數量、參考範圍為 warning） | 每個 `Identifier.value`、date / dateTime / instant 與 `Quantity.value` 都必須在病歷（識別碼另含 `site_config`）中找得到：正規化後相符或有明確推導（見下）。找不到時訊息為「病歷中找不到這個值」，`evidence` 列出比對範圍、試過的正規化形式與最接近的病歷候選。日期在病歷中但時間沒有（典型是就診日 + 補上的 `T00:00:00`）也是 error；只寫日期而日期相符則通過。0、負數、999 這類病歷沒有的值另註明像佔位值 |
| R5 | `value-from-other-event` | 是 | error / warning | 值在病歷中，但屬於另一個時間點、事件或欄位：病歷寫第一次測量「機器錯誤、未得數值」、模型把第二次的值寫在第一次的時間 → error；兩次測量的值與時間對調 → warning；日期在病歷中只是過去事件（上次 / 曾 / previous）或出生日期 → error；號碼在病歷中是另一種號碼（把住院號寫成病歷號）→ error。只有能判定時才報 |
| R5 | `stale-value`（v17.4） | 是 | error | 值在病歷中，但病歷中它**每一次**出現的子句（以逗號、分號、句號、括號為界）都標示它不是本次的值：「已不適用」「前次」「舊值」「移植前」「待補」「未測量」「作廢」「not applicable」「previous」「pending」等。例：「體重 本次未測量（…112/10 移植前體重 63 kg 已不適用）」而 Bundle 寫 63 kg。訊息引用病歷原文，請回報 insufficient_information。只要有任何一處是本次的值（「體重 65 kg（前次 63 kg）」寫 65）就不報。 |
| R4 | `unconfirmed-as-confirmed`（必要欄位文字，v17.4） | 否 | error | 診斷欄位（`Claim.diagnosis.diagnosisCodeableConcept`、`Condition.code`、`reasonCode`）或宣告 profile 要求的 CodeableConcept，括號外的文字含「尚未確立」「待病理」「待確認」「pending」「to be determined」「不明」：不論有無代碼都報。只有保留語（「疑」「r/o」「suspected」「provisional」）時，只在沒有真正代碼、而且 resource 無法自己標示 provisional 時才報（verificationStatus 為 provisional / differential 的 Condition 是正確寫法）。「不明原因發燒」「unknown primary」「undetermined significance」這類本身就是診斷名稱的說法，以及括號內修飾其他事物的文字（「PSA 升高（未確立惡性腫瘤）」），都不報。 |
| R5 | `identifier-truncated`（v20） | 是 | error | 病歷明寫的識別碼要逐字保留：值在病歷中每一次出現，都只是較長識別碼的一段（識別碼以空白 / 標點 / 「：:，、」等為界；開頭的欄位標籤如「病歷號」「證號」「ID」「No.」不算；前後只接英數字 / 連字號，或「…字第<值>號」的證號格式）。例：病歷「醫字第035190號」而值寫 `035190`。`suggestions` 給 `replace_value` = 病歷中的完整片段。宣告 profile 把該 identifier（slice）的 value 限定為純數字（regex / patternString / `matches('^[0-9]+$')` 類 invariant）時，數字部分即正確，不報；識別碼格式表接受值而不接受片段時亦不報。值旁接其他中文字（「A123456789男」）無法判斷，不報。 |
| R7 | `code-meaning-mismatch`（v20） | 是 | error | 代碼語法與值集都對，但意思與病歷不符。比對 coding 的**官方名稱**（本地術語表：LOINC 長名 / 短名 / component / 中文名、SNOMED 描述與中文名、ICD-10-CM 標題與中文名、健保 / TFDA 藥名、IG CodeSystem designation；不用模型自填的 display）與病歷對應的名稱：CodeableConcept.text 或模型 display（病歷中有寫的那一段）、Observation 數值前的標籤（「Hb 10.2」→ Hb）。相似度用 grounding 的加權名稱包含（雙向、縮寫與中英對照展開）＋資料衍生的縮寫對照（`fhir.term_thesaurus`、`fhir.abbreviation_lexicon`：PEFR ↔ PEF）。無關（< 0.2；ICD / LOINC 部分相關 < 0.7）時，再以 `fhir_normalize_code`（限該 coding 的系統）查病歷名稱：候選中沒有這個代碼、且有候選明確指稱病歷名稱（ICD 上下位碼不算；藥品不得與原代碼共用成分字）才報 error，附 `record_phrase`、`code_display` 與 `replace_code` 候選。無法比較（翻不過去的另一種語言、表上沒有的縮寫）或沒有候選時不報。 |

**v20 內容檢查誤報修正（R6）**：(1) 量測標籤與代碼名稱改用資料衍生的縮寫對照（`fhir.term_thesaurus` + `fhir.abbreviation_lexicon`，經術語 provider 一次預取）比對——「PEFR 410 L/min」與 LOINC 短名「PEF Airway PFM」共用展開「Peak expiratory flow rate」，不再是 `G-CONTEXT-LABEL`；(2) 民國日期區間的結束日（`114/06/02–115/08/31`、`114/06/02 08:00-115/08/31`，另 `~` `至` `到`）兩端都讀為日期；(3) 過敏：病歷只有「停藥 / 已停用 / discontinued」時，不再建議 `AllergyIntolerance.clinicalStatus` inactive——停藥不代表過敏解除，只有「已不過敏」「耐受測試 / 激發試驗陰性」「resolved」「no longer allergic」等明確字句才算。誤報率以 `node-server/scripts/content-fp/run.ts` 量測：IG 範例（TW Core 1.0.0、TWPAS 1.2.7、IPS 1.1.0、EMPD 0.2.1；Bundle 與每個單一資源範例）由決定性 renderer 轉成陳述每一項事實的合成病歷（中英標籤、三種日期寫法含民國區間、縮寫），任何 error 皆為誤報；依檢查代碼統計佔事實的百分比。

**R1 怎麼避免誤報**：值必須「整個」由缺漏述詞（詞彙表 `record-checks-lexicon`，中英文，含「尚未 / 還沒 / 待 / 無法 × 取號 / 建檔 / 提供 / 帶來 …」與「…中」「…失敗」的組合變化）、欄位名詞（病歷號、身分證、ID、date …）、填充詞（家屬說、目前、yet …）與標點組成，且至少有一個缺漏述詞；只要還有其他內容（另一個字詞、三位以上數字）就不算。因此「家族史不詳」只影響它自己那個欄位（如果模型把它寫成值），「不明原因發燒」「Hypertension, unspecified」「王不明」都不會被當成缺漏。HL7 / FHIR 自己定義的代碼（`gender = unknown`、v3-NullFlavor `UNK` …）是合法代碼，不檢查。「無 / none / N/A / -」只在識別碼、日期、數量、姓名、參照這類欄位才算缺漏。

**R2 格式與檢查碼**（系統 URL 取自 TW Core IG v1.0.0 `Patient-twcore` / `Practitioner-twcore` 的 identifier slice）

| 格式名 | 系統 | 規則 |
| :--- | :--- | :--- |
| `tw-national-id` | `http://www.moi.gov.tw` | 1 英文字母 + 1／2 + 8 位數字；檢查碼：字母轉兩位數（A=10 … 依 ABCDEFGHJKLMNPQRSTUVXYWZIO），十位 ×1、個位 ×9，其後 8 位依序 ×8…×1，加檢查碼，總和為 10 的倍數。第二碼為 8／9 時提示應使用居留證系統 |
| `tw-resident-certificate` | `http://www.immigration.gov.tw` | 新式（2021-01-02 起）：1 英文字母 + 8／9 + 8 位數字，檢查碼同身分證；舊式（2030-12-31 前有效）：2 英文字母（第二碼 A–D）+ 8 位數字，第二碼取字母代碼的個位數（A→0 … D→3），其餘同身分證 |
| `tw-nhi-card` | （TW Core 未定義系統 URL，需由 `site_config` 指定） | 12 位數字（組間可有空白 / 連字號） |
| `tw-passport` | （由 `site_config` 指定） | 9 位數字 |

`site_config` 語法（每行一條，與其他院所設定寫在同一段文字）：`identifier-format <system> <格式>`，`<格式>` 是上表的格式名或 JavaScript 正規表示式（比對整個值），例如 `identifier-format https://hospital.example.tw/mrn [0-9]{7,8}`、`identifier-format https://hospital.example.tw/nhi-card tw-nhi-card`。院所規則會取代同一系統的內建規則；不合法的正規表示式會被忽略並寫在 `record_checks.notes`。只有檢查碼不符、而病歷（或 `site_config`）中寫的正是這個值時，降為 warning（病歷本身就是這個號碼，請向來源確認）。

**R3 如何搜尋病歷**：日期——在病歷各行（排除轉換目標、院所設定、家族史段落）找同一年／月內、精度到日的日期（西元、民國、年月日、月日寫法）；找到時訊息為「病歷有更完整的值 '<日期>'」並附原文行，找不到則為「病歷沒有提供更完整的日期」。數量——在提到該項目名稱（`code.text`、display、生命徵象別名）的行中，找名稱之後單位相容的數字。藥品——在提到藥名的行中找劑量（數字 + mg / g / mcg / mL / IU / 錠 …），並檢查藥名文字本身是否含劑量。`evidence` 說明搜尋範圍與結果。只有歷史性質的時間（`Condition.onset`、`Procedure.performed`、`Immunization.occurrence`、`MedicationStatement.effective` …）與 `date` 型別（`birthDate`）不檢查精度。

**R4 的範圍**：在病歷中定位 Condition 的名稱（`code.text`、display、ICD-10 碼），以句子（。；;）為範圍判斷限定詞：前置詞（待排除、r/o、鑑別診斷、疑似 …）作用到下一個逗號為止，後置詞（尚未確立、not established、？…）作用在同一子句或緊接的短子句（「A、B、C，尚未確立」）；`rule out` 段落的整行都算明確。**括號內的限定詞只作用在括號內的概念**：「A：Elevated PSA（未確立惡性腫瘤）」的「未確立」修飾的是惡性腫瘤，Condition 是 Elevated PSA 時不報（寫成確立的惡性腫瘤才報）；括號內只有限定詞時（「肺炎（待排除）」「(r/o)」「(?)」）才修飾括號前的項目。

**主診斷欄怎麼讀**：標題（詞彙表 `diagnosisSlot`，中英文；`次診斷 / comorbidities` 不算主診斷）後的文字與其續行（編號項目），以 、 ； , ／ vs 或 等頂層分隔切成項目；開頭的前置限定詞（鑑別 A／B／C、待排除 A、B、r/o A vs B）作用到同一行之後所有項目，同一行最後只有後置限定詞的項目（…，尚未確立）作用到它之前的項目；「已排除 / ruled out / 不支持」的行是已排除的項目（既不是確立也不是待定）。任何一個主診斷欄中未限定的項目與 Condition 相符時，一律視為確立。

**R6 民國年換算錯誤的修正建議（`recordChecks/dateSuggestions.ts`）**：日期判為無依據（record checks 的 `ungrounded-value`，以及 `fhir_validate_bundle` / `fhir_validate_resource` / `fhir_assemble_bundle` 回傳的 grounding `G-UNGROUNDED` / `G-VALUE-MISMATCH`）時，若病歷有同月同日、只差年份的日期——典型是民國年換算錯（病歷「民國92年8月25日」寫成 1983-08-25，正確 2003-08-25；「民國47年6月20日」寫成 1959-06-20，正確 1958-06-20；以 +1900 / +1910 / +1912 換算、把民國年直接當西元年如 0092-08-25；只寫年或年月時限於這些已知錯誤與 ±1 / ±11 年），或病歷是同月同日的西元日期——issue 會附 `suggestions`：`kind: "replace_value"`、`patch: {op: "replace", path, value}`，`value` 是病歷的日期（原值的時間部分保留），`reason` 引用病歷原文並寫出換算規則（民國 N 年 = 西元 N+1911）。只有一個候選時信心 0.95，record checks 的訊息也直接寫出正確值；多個候選時全部列出，寫在這個欄位標籤下的（如 birthDate 的「出生日期」）排前面。issue 的嚴重度不變（仍是 error），也不會自動套用。`fhir_check_grounding` 本身的輸出不變（它與參考實作逐位元比對）。

**R6 內容涵蓋（ISSUES_v17 R2，`recordChecks/coverage.ts`，需要 `source_text`）**——對照病歷原文、轉換目標與 Bundle，以決定性方式（不用 LLM）回報內容問題，每項附 entry 路徑、病歷原文片段（`located_quotes`）與建議（`suggestions`）：

| 代碼 | 嚴重度 | 規則 |
|---|---|---|
| `negated-item-present` | error | 病歷在提到某項目的句子中否定它（本次不開立、未執行、取消、已停用、否認、待排程…），而 Bundle 中這個項目寫成已發生或進行中（`status` active / completed、`clinicalStatus` active…）；或【轉換目標】寫「不需轉換 / 排除」的項目（含整個類別，例如「過敏史不需轉換」；「其他 X」與帶修飾語的類別只排除沒有明列的部分）出現在 Bundle 中。項目名稱取自該資源自己的代碼 display / text，狀態依 FHIR R4 核心定義判斷；同一項目若在病歷別處被正面提到（例如另行開立）就不報。建議為刪除 entry 或應改的狀態 |
| `duplicate-entry` | error | 除了 id、meta、narrative、identifier 以外內容相同的 entry，或代表同一件事（Condition / AllergyIntolerance：同一代碼；Observation：同代碼、時間與數值；用藥：同藥品、劑量與 intent；Procedure / Immunization：同代碼與時間；Encounter：同期間與類別）。建議只保留一筆 |
| `text-only-fact` | warning（`content_checks_severity: "error"` 改為 error） | 用藥資源的 `Dosage.text` 寫了單次劑量、頻次（QD / BID / 每日兩次…）、途徑（PO / IV / 口服…）或天數（共 28 天…），但對應的結構化元素（`doseAndRate.doseQuantity`、`timing.code`、`route`、`dispenseRequest.expectedSupplyDuration`）是空的。建議附上結構化寫法（單位與代碼仍須符合 profile 的綁定） |
| `record-fact-missing` | warning（`content_checks_severity: "error"` 改為 error） | 病歷明確寫了、但對應欄位空著：科別 → `Encounter.serviceType`；「共 28 天」→ `dispenseRequest.expectedSupplyDuration`；藥品那一行的劑量 / 頻次 / 途徑；病人姓名——只看宣告的 profile 標為 mustSupport / 必填、或 IG 範例中至少一半有用到的元素。**可由病歷推得的事實**（v20 R5，`fhir_validate_bundle` 1.31.0 / `fhir_validate_resource` 1.28.0）：診斷欄（Dx / Impression / A: / 診斷）的項目 → `Condition.verificationStatus`（未加保留 confirmed、疑似 provisional、r/o / 待排除 differential，沿用 v15.3 診斷欄解析）；數值後的 H / L / HH / LL / ↑ / ↓ / * 或參考範圍 → `Observation.interpretation`（H / L / HH / LL，範圍內 N，只有 * 時 A）；出院帶藥 / 門診處方 / 住院醫囑標題（否則病歷唯一的就診型態）→ `MedicationRequest.category`（discharge / outpatient / inpatient）——只要 profile 有該元素（任何 cardinality）且綁定含對應代碼（IG 自訂 ValueSet 取 display 相符的代碼）就報。需要 profile 資訊，由 `fhir_validate_bundle` / `fhir_validate_resource` 自動查詢；沒有 `source_text` 時一律不報 |

**R5 怎麼找值（`recordChecks/recordValues.ts`）**：只看病歷本文（轉換目標【轉換目標】與院所設定段不算），識別碼另查 `site_config` 全文。
- 識別碼：NFKC、不分大小寫、去掉 - _ . / 空白，比對完整 token、分隔片段的連續組合、去掉前導 0、黏在一起的英文標籤前綴（MRN00775310）。系統產生的識別碼（`urn:uuid`、Bundle / Composition / Claim identifier）不檢查。
- 日期：西元、民國（114/06/10、民國114年6月10日）、年月日、斜線、月日（以病歷中的年份補年）、英文月份；時間含 HH:MM(:SS)、上午 / 下午 N 點 M 分、am / pm、日期後緊接的 HHMM；site 時區（`site_config` 的 `timezone:`，預設 +08:00）換算後也比對。推導：入院第 N 天 / hospital day N / HD#N（入院日 + N−1）、術後第 N 天 / POD#N（手術日 + N）、第 N 天、N 天前 / N 天後、昨天 / 前天 / 今天 / 隔天 / 次日、N 週前 / 後、N 個月前 / 後、主訴的病程（咳嗽 3 天 → 3 或 2 天前）、療程行的天數（處方 … 7 天 → 起日 + 6 或 7）、N 年前 / N 年（年份）、年齡（54 歲 → 出生年）、「N 分鐘 / 小時 後 / 前」。中文數字可讀（入院第三天）。錨點是病歷自己的日期：入院類用入院日、術後類用手術日、其他用同一行的日期，否則最近的上一個日期行（出生日期不算）；`Encounter.period.start` 與 `Patient.birthDate` 必須是病歷寫出的日期。紀錄性時間（`authoredOn`、`recordedDate`、`issued` …）日期找不到只給 warning、不檢查時間；工具或文件自己產生的時間（`Bundle.timestamp`、`Composition.date`、`Provenance.recorded` …）不檢查。
- 數量：日期與時間以外的每個數字（所以 0 或 14 不會被「08:00」「2025/03/14」撐腰），含單位、中文數字、「半」、分數；單位相容才算（兩邊都是已知單位時），可換算單位（質量 / 體積 / 長度 / 時間、°F ↔ °C、葡萄糖 mg/dL ↔ mmol/L、10^3/uL ↔ /uL）、身高體重算 BMI、明寫的乘積（500 mg x 2）。衍生數量（`dispenseRequest.quantity`、`expectedSupplyDuration`、Claim item 數量）另接受同一行數字的乘積，找不到時只給 warning；參考範圍找不到為 warning；分母不檢查。

**主診斷 Condition 怎麼判定（v15.3 R2，`diagnosisSlot.ts` `primaryCondition`）**：依序——(1) `Encounter.diagnosis` 指向 Bundle 內 Condition 的項目中，排除 use 為 CM（共病）者，取 `rank` 最小者，沒有 rank 時取第一筆；全部都是共病時視為沒有主診斷；(2) 否則 category 為 encounter-diagnosis（且不是 problem-list-item）的 Condition：只有一筆就是它，多筆時取第一筆名稱對得上病歷診斷欄項目者，否則取第一筆；(3) 否則唯一一筆不是 problem-list-item、也不是病歷在診斷欄以外（過去病史 / 計畫 / 檢驗）寫明的共病的 Condition；(4) 都不成立時不判定、不報。refuted / entered-in-error 的 Condition 一律不算。只檢查主診斷這一筆，其他 Condition 不受此規則影響。

**代碼的 grounding 訊息（v15.3 R3，`recordChecks/codeGrounding.ts`）**：`fhir_validate_bundle` / `fhir_validate_resource`（以及背後的 `fhir_author_resources` / `fhir_assemble_bundle`）帶 `source_text` 時，grounding 對**有代碼的元素**（CodeableConcept / Coding，例如 `Condition.code = 'sct#…'`）回報的 `G-UNGROUNDED` / `G-VALUE-MISMATCH` 會被改寫：訊息說明比對的是「代碼的意思」——`text`、display、工具從術語表查到的名稱（英文 + 中文）與 ICD-10 碼——和病歷各行（轉換目標、院所設定、家族史除外），因為病歷不會寫代碼本身；issue 附 `closest_record_phrase = {text, similarity, section}`（病歷各子句中最相近者；相似度為 grounding 的加權名稱涵蓋率（含縮寫與中英對照展開），中文對中文另取 concept-search 正規化後的字元 bigram Dice，取較大者；低於 0.1 時為 null）、`compared` 與 `grounding_code_check`。**只有在有明確反證時才維持 error**（`contradicted`）：這是本次主診斷 Condition 的代碼、與病歷所有子句都不相關（相似度 < 0.25），而且病歷有診斷欄、其每一項都能與這個代碼比較（同一語言、兩邊都有 ICD-10 碼，或中英對照能翻譯 ≥ 80% 的中文；只有縮寫的項目不算）且都不相似——也就是病歷寫的是別的診斷。其他情況都降為 warning 並加 `downgraded_from: "error"`：有相關敘述（`related`，相似度 ≥ 0.25，代碼可能只是換了說法）、或無法確定（`uncertain`：不同語言無法比較、病歷沒有診斷欄、共病、藥品、檢驗代碼）。降級後若該 entry / grounding 已無 error，`entries[i].valid`、`groundingValid`、`valid` 與 `grounding` 的 errors / warnings 計數會依剩下的 issue 重算；`data.record_checks.grounding_codes = {examined, warnings, errors}`。`fhir_check_grounding` 本身的輸出完全不變（它與參考實作逐位元比對）。

**SNOMED 代碼的中文名稱（v15.3 R3 補充，`grounding/snomedChinese.ts`，`fhir_validate_bundle` 1.15.1 / `fhir_validate_resource` 1.12.1）**：SNOMED CT 只有英文名稱，過去中文診斷欄永遠「無法比較」，錯的 SNOMED 主診斷只會是 `uncertain`。現在比對時另外使用由資料推得的中文名稱（不是手寫翻譯表），各帶來源與信心值：IG 的中文 designation / ValueSet 中文 display（0.9 / 0.85）；SNOMED → ICD-10 對應（`snomed.icd10_map` 的 map group 1、優先序最高的**無條件**規則 TRUE / OTHERWISE TRUE）的 ICD-10-CM 中文名稱（目標碼 0.75；其前有條件規則或以 ICD-10-CM 子碼命名時 0.65；三碼類目 0.6），並去掉「未明示」「無併發症」「部位未明示」等分類慣例片段；以及挖掘出的中英詞對（`fhir.term_thesaurus` 的 bilingual）逐字翻譯英文名稱（≥ 80% 的實詞能翻譯才採用，信心 0.8 × 涵蓋率 × 最弱詞的 Dice）。判定：信心 ≥ 0.5 的中文名稱參與「最相近敘述」（`related`）；≥ 0.6 才能讓中文診斷欄的項目變成「可比較」；可比較的項目要與代碼的**所有**英文 / 中文名稱、以及對應 ICD 三碼類目內所有中文名稱（0.3，只用來擋 error）的相似度都 < 0.25 才算「別的診斷」，若只有 ICD 推得的中文名稱可比較則要 < 0.15（ICD 對應是多對一、較粗）；診斷欄寫的 ICD 碼與對應目標同一三碼類目時一律不算不同。成立時為 error（`contradicted`，訊息註明是以哪個中文名稱、哪個來源比對），否則依舊為 warning。用到的名稱列在 `compared.chinese_names = [{name, source, confidence}]`；`fhir_check_grounding` 與其他工具的輸出都不含這些名稱。 **1.17.1 補強**：ICD 中文名稱只保留完整名詞片語（「其他或未明示之」這類限定前綴整段移除，以虛詞 / 黏著詞素開頭的名稱（「或氣喘」「性氣喘」）與少一個字的尾段一律捨棄）；挖掘詞對的翻譯若沒有被該概念的 ICD 中文名稱佐證，信心最多 0.55（只當相關證據，不會讓診斷欄變成可比較）。**階層保護**：診斷欄項目的 SNOMED 概念（由其 ICD-10 碼反查 `snomed.icd10_map`，或由完全相同的 ICD 中文名稱）若與代碼的概念相同、為其祖先或子孫（`snomed.concept_ancestors`），就不算「別的診斷」——例如 lower respiratory tract infection 對「社區型肺炎 (J18.9)」只會是 warning。只有縮寫的診斷欄項目改依病歷原本的大小寫判斷。IG designation 表改為一次輕量查詢（只讀含中文的套件，正式環境約 0.6 秒），single-flight、背景更新、程式啟動時預先載入；第一次載入未完成時請求最多等 2 秒，之後不帶 IG 名稱繼續，且該次所有中文名稱的信心都壓在可比較門檻以下——這段期間的結果可能是 warning，之後同樣的輸入可能變成 error，反之不會。

**空殼資源（v15.4，`recordChecks/emptyShell.ts`，`fhir_validate_bundle` 1.16.0）**：模型不再把「報告未出」寫成值，而是建立一筆沒有值的資源、把原因寫在 `note` / `dataAbsentReason` / `dosageInstruction.text`。這類資源依上表「空殼資源」列處理。缺漏述語以**分類加樣式**（`lexicon.ts` 的 `ABSENCE_CLASSES`，NFKC + 小寫後比對）而非逐字清單定義，所以「報告尚未回傳」「結果還沒出來」「待 CT 正式報告」「result not back yet」共用同一個樣式；否定（無溶血、no hemolysis）、寫出結果的子句（陰性、正常、帶單位的數值）、只說「追蹤中 / 原因不明」的子句都不算缺漏。「溶血 / 凝固 / hemolyzed」只在代碼需要數值結果的 Observation 才算缺漏（血清外觀的結果可以是「溶血」）。命名診斷加上「待確認」且標成 provisional 是疑似診斷的正確寫法，不報。病歷的診斷欄寫「A 與 B 尚難區分 / cannot differentiate」時，該欄視為未確立（確立寫法的 A 會得到 `unconfirmed-as-confirmed`）。`dataAbsentReason` 不再被當作 R1 的值欄位（它是 FHIR 表達缺值的正確方式），改作旁註證據。

**輸出**

- 每個 issue：`severity`、`code`（上表）、`path`、`message`（中文 / 英文）、`message_zh`、`message_en`、`rule`（R1–R5）、`source: "record-checks"`、`evidence`（判斷依據），需要病歷的規則另有 `located_quotes`。
- `fhir_validate_bundle` / `fhir_validate_resource`：issue 依 entry 併入 `entries[i].issues`（Bundle 層級併入 `issues`），**error 會讓 `entries[i].valid` 與 `data.valid` 變成 false**（`conformanceValid` / `groundingValid` 維持原意）；帶 `source_text` 或有任何發現時加上 `data.record_checks = {ok, errors, warnings, rules, source_text, notes?, grounding_codes?}`。沒有 `source_text` 時只跑 R1、R2（R1 的陳述缺漏與無值識別碼、R3–R5 都需要病歷）；**沒有 `source_text` 且沒有任何發現時，輸出與未加這一層前逐位元相同**（沒有 `record_checks`，也沒有額外的 provenance 欄位）。
- `fhir_author_resources`：同 `fhir_validate_resource`，出現在 `results[].issues`（error 使 status 為 `invalid`）；可選 `source_text`（不存入 context）加跑 R3 / R4；`site_config` 的格式規則一併套用。
- `fhir_assemble_bundle`：同 `fhir_validate_bundle`（帶 `source_text` 時跑 R3 / R4），issue 帶 key / field。
- `fhir_finalize_bundle`：可選 `source_text`；結果在 `data.record_issues` 與 `data.record_checks`（Bundle 與 `changes` 不變），有 error 時加一則 warning。
- `fhir_finalize_resource`：可選 `source_text`；issue 併入 `data.validation.issues`（error 使 `validation.valid` 為 false），草稿不會被修改。
- 上述各工具都遵守同一條：沒有 `source_text` 且沒有發現時輸出不變。
- 有輸出時，`provenance` 增加 `recordChecksVersion`、`recordChecksLexicon`、`recordChecksLexiconSha256`。病歷原文不寫入 log。

## 事實涵蓋與放行判斷 {#release-gate}

兩個工具都在 FHIR IG 群組（模組閘門 `ig`、與 `fhir_validate_bundle` 相同的 metrics / 錯誤邊界 / 重量級工具併發上限），完全決定性（不呼叫 LLM），對所有 IG 通用，不寫入病歷原文、quote 或事實值到 log。

### fhir_check_fact_coverage（v18 R3 = v20 R4）{#fact-coverage}

輸入 `bundle`、`source_text`、`facts: [{item, attribute, value, quote, resource_type?}]`、`package_id?`、`version?`。每個事實依序判斷：

1. **quote 在病歷中**：NFKC（全形 → 半形、小寫）並合併空白後比對，再以 grounding 的正規化（去掉空白與多數標點）比對；兩者都找不到 → `quote_not_in_record`（依據是捏造的）。
2. **可用**：quote 所在子句（以 ，,；;。、括號、清單編號切開）若有否定（grounding `NEG_CUES`，前置、10 字內）、未確立（record checks 的 `cuesIn`：疑似、r/o、待排除…）、舊值 / 前次（`OBS_HIST_CUES` 與 v17.4 stale 詞彙）、待補 / 不適用 / 未做（`clausesOf` 的缺漏類別）→ `not_usable`。事實本身就在說這個狀態時（值是「無」「negative」「provisional」「inactive」…，或值 / attribute 含該詞）仍可用。不可用的事實不可寫成目前的值；轉換目標需要它時應回報 insufficient_information。
3. **寫在結構化元素**：只找事實所屬 resource type 的 entry（由 `item` / `attribute` 推得，例如 藥 / 劑量 / 途徑 → MedicationRequest 等、體溫 / 檢驗 → Observation、診斷 → Condition、就診 → Encounter；也可用 `resource_type` 指定）。`text`（Narrative、CodeableConcept.text、Dosage.text）、`note`、`display`（單獨）、`comment`、`patientInstruction` 不算；HumanName / Address 的 `text` 算。術語等價：
   - 途徑：PO / 口服 / oral ↔ code、display 或術語名稱指向該途徑的 Coding（SNOMED `26643006` 或 IG 途徑值集的代碼）；
   - 頻次：BID / 一天兩次 / Q12H ↔ `Timing.repeat` 每日次數相同（frequency 2 / period 1 / periodUnit d），或 `timing.code`；
   - 日期：民國（114/06/02、114年6月2日）與西元寫法 ↔ FHIR date / dateTime / Period，比到事實的精度；
   - 數量：同數值且單位相容，或可換算（0.5 g = 500 mg、cm ↔ m），各種數字寫法（12.50、中文數字）；多個數字（120/80 mmHg）每個都要找到；
   - 代碼：`Coding.code`，或該 Coding 的 display / 術語名稱（同義詞、中文名稱）相同或大部分重疊；
   - 性別（男 / M ↔ male）、布林、其他字串（正規化後相等；HumanName 也比 family + given）。識別碼必須完整相等（`醫字第035190號` ≠ `035190`）。
   
   找到 → `covered`（`found_at`）；否則 `missing`，若值只出現在別的 resource type 則 `reason_code: "found-in-other-resource"` 並附 `found_elsewhere`。
4. **建議路徑**：`missing` 的事實附 `suggested_paths`，依該類 entry 的 `meta.profile` 的 authoring fields（`fhir_get_authoring_fields` 的 `fields`，detail full）排序：attribute 對應的元素名（途徑 → `dosageInstruction.route`、天數 → `dispenseRequest.expectedSupplyDuration`…）優先，再看欄位型別能否放這個值；沒有 entry 或沒有 profile 時用 FHIR R4 的基本元素名。

輸出 `data`：

| 欄位 | 說明 |
| :--- | :--- |
| `facts[]` | `index`、`status`（`covered` \| `missing` \| `quote_not_in_record` \| `not_usable`）、`reason_code`（`fact-covered` / `fact-missing` / `found-in-other-resource` / `quote-not-in-record` / `fact-not-usable`）、`reason`、`resource_types`、`found_at?: [{pointer (RFC 6901), path, value, how}]`、`found_elsewhere?`、`suggested_paths?`、`markers?: [{cls, cue}]`（`negated` / `unconfirmed` / `stale` / `pending` / `not-applicable` / `not-done`）、`clause?`、`quote_match?`（`exact` / `normalized`） |
| `summary` | `total`、`covered`、`missing`、`quote_not_in_record`、`not_usable`、`coverage`（covered ÷（total − not_usable），無可判斷時 null）、`complete`（無 missing 且無 quote_not_in_record） |

### fhir_release_check（v18 R4 + v20 R1）{#release-check}

輸入 `bundle`、`source_text`、`facts?`、`targets?: [{resourceType?, profile?, what?, code?: {system?, code}, min?, facts?: [index]}]`、`site_config?`、`package_id?`、`version?`、`bundle_profile?`、`require_official?`（預設 true）。**以下全部成立才回傳 `release: true`**：

1. **官方驗證 0 error**：以 `fhir_validate_bundle` 相同的管線驗證（有設定官方 validator 時用官方引擎，見「[官方 HL7 validator 作為判準](#official-engine)」）。結果必須是 `official_verdict: true` 且不是 `checked_fully: false`；MCP fallback、未驗證代碼、沒有官方引擎 → `not-officially-verified`。`require_official=false` 只供開發環境使用（接受 MCP 判定並在 `validation.note` 註明）。
2. **grounding 與 record checks 0 error**：同一次驗證帶 `source_text`（`source: "grounding"` / `"record-checks"` 的 error）。
3. **事實涵蓋完整**（有 `facts` 時）：`missing` → `fact-missing` / `fact-in-other-resource`；`quote_not_in_record` → `quote-not-in-record`；不可用卻寫進 Bundle → `unusable-fact-written`。
4. **完整性（v20 R1）**：每個 `targets` 項目在 Bundle 中的數量 ≥ `min`（預設 1；依 resourceType、meta.profile、code 比對），否則 `missing-target`。缺的項目所需的事實（`facts` 索引，預設為推得該 resource type 的事實）全部不可用或沒有依據時，改報 `insufficient-information`。沒有 `targets` 時：Bundle 剖面（`bundle_profile` 或 `meta.profile`）必填的 entry slice 要在（`missing-entry-slice`）；事實推得 ≥ 2 種 resource type 而 Bundle 只有 ≤ 1 筆內容 entry（Composition / MessageHeader 不算）→ `suspected-empty-bundle`。

輸出 `data`：`release`、`next`（`send` \| `fix` \| `insufficient_information`）、`reasons: [{code, message, pointer?, count, check}]`（`check` = `validation` / `content` / `facts` / `completeness`；每類 issue 最多列 25 筆，其餘合併成一筆 `count`）、`validation {completed, errors, warnings, source, engine, official_verdict, checked_fully, officially_verified, fallback_reason?, unverified?}`、`content {completed, source_text, grounding_errors, record_check_errors, warnings}`、`facts`（同 `fhir_check_fact_coverage` 的 `summary` 加 `results`，沒有 facts 時為 null）、`completeness {entries, targets? | entry_slices?, fact_resource_types?, suspected_empty?}`。

理由代碼：`validation-failed`、`validation-error`、`not-officially-verified`、`grounding-error`、`record-check-error`、`no-source-text`、`fact-missing`、`fact-in-other-resource`、`quote-not-in-record`、`unusable-fact-written`、`missing-target`、`insufficient-information`、`missing-entry-slice`、`suspected-empty-bundle`。`next` 為 `insufficient_information` 時不可送出，案件轉為「無法自動轉換」；`release: false` 的 Bundle 一律不可送出。

**限制**：resource type 與元素的對應是以中英關鍵字推得（可用 `resource_type` 指定）；缺項目「沒有任何事實」時也視為病歷未提供（insufficient_information），若事實清單漏列會被誤判。途徑 / 頻次等價以 grounding 詞彙表與術語名稱為準，IG 自訂代碼的 display 沒有指出途徑時不會被認出。

## 工具版本 {#tool-versions}

行為由固定測資鎖定的工具各有自己的版本（`node-server/src/toolVersions.ts`）；同一輸入的輸出改變時就會升版。`health_check` 的 `tools_version` 回報目前值，其餘工具沿用伺服器版本（`version`，目前 `1.1.0`）。

| 工具 | 版本 |
| :--- | :--- |
| `fhir_validate_bundle` | 1.13.0（R6：無依據日期的民國年換算修正建議，含回傳的 grounding issue）；1.12.0（[record checks](#record-checks) v15.1：帶 `source_text` 時每個識別碼 / 日期 / 數量都要在病歷中找得到（`ungrounded-value`）、其他時間點 / 事件 / 欄位的值（`value-from-other-event`）、陳述缺漏與無值識別碼、主診斷欄規則、括號內限定詞的範圍；沒有 `source_text` 時輸出不變）；1.11.2（`normalize_ids` + `repair="content"` 同 `fhir_finalize_bundle` 1.3.2）；1.11.1（`normalize_ids` + `repair="content"` 的內容修正同 `fhir_finalize_bundle` 1.3.1）；1.11.0（[record checks](#record-checks)：information-absent / identifier-format 一律檢查，帶 `source_text` 另檢查精度、數值、藥品與未確立診斷；`data.record_checks`）；1.10.0（`repair="content"` 搭配 `normalize_ids=true`：先做內容修正再驗證，`content_changes` / `repair_issues`）；1.9.0（validator v13：ValueSet canonical 當 `Coding.system` 為 error、LOINC 屬性 filter 可判定成員）；1.8.0（`normalized_bundle` 保留數字原始寫法；document / message 缺首筆資源的 bdl-11 / bdl-12 附 `replace_value` / `add_resource` 建議；1.7.0：`normalize_ids`、ID 類錯誤的 `suggestions` 與 `id_map` / `id_changes`） |
| `fhir_validate_resource` | 1.10.0（R6，同 `fhir_validate_bundle` 1.13.0）；1.9.0（record checks 同 `fhir_validate_bundle` 1.12.0）；1.8.0（[record checks](#record-checks)，同 `fhir_validate_bundle` 1.11.0）；1.7.0（validator v13：ValueSet canonical 當 `Coding.system` 為 error 並附候選、LOINC 屬性 filter 可判定成員）；1.6.2（validator v8：HL7 空間未知 CodeSystem 一律 error、參照含空白、RxNorm display 指到另一個藥、查詢失敗 / 例外的 `exception` issue；1.6.0：issue 的 `suggestions` / `caused_by`） |
| `fhir_finalize_bundle` | 1.4.1（R6：`record_issues` 的無依據日期附修正建議）；1.4.0（`source_text` 的 `data.record_issues` 同 `fhir_validate_bundle` 1.12.0 的 record checks）；1.3.2（評測方決定：同一 Coding 因 system 修正而顯露的 display 錯誤不撤回該修正；剖面只允許一個單位時直接設定並記錄在 `changes`）；1.3.1（v14.1 內容修正：`timezone` / `empty` / `fixed-slice` 規則、UCUM 等價與 annotation、`quantity-code-not-ucum`、ValueSet 名稱與更名的 system、更多結構修正、Bundle 外殼與重複 fullUrl、整份 Bundle 的修正驗證、`site_config` 參數）；1.3.0（[record checks](#record-checks)：可選 `source_text`、`data.record_issues` / `record_checks`，只回報不修正）；1.2.0（`repair` 參數，預設 `content`：display / ucum / roc-date / system / shape / code 內容修正、驗證不新增錯誤、`repair_issues`、`timezone`；`repair="ids"` 同 1.1.0）；1.1.0（數字保留原始寫法、`bundle_type` 參數、document 缺 Composition 的提示；1.0.1：Bundle 定稿：fullUrl-uuid / reference-rewire / resource-id / bundle-type / document-order） |
| `fhir_build_bundle` | 1.2.1（entry 資源的數字保留原始寫法；1.2.0：共用 Bundle 定稿引擎：確定性 UUID、key / urn:uuid:key / Type/key 引用改寫、不合法 fullUrl 正規化、`changes`） |
| `fhir_get_profile_required_elements` | 1.4.1（`bundle_rules.bundle_type` 提及 `fhir_finalize_bundle` 的 `bundle_type`；1.4.0：Bundle profile 的 `bundle_rules`；1.3.0：derived 列的 allowedCodes 與推導規則、`include_mustsupport="defaults"`、`optional`） |
| `fhir_list_igs`、`fhir_list_artifacts`、`fhir_search_artifacts`、`fhir_list_resource_profiles`（新增 `compact`） | 1.3.0 |
| `fhir_get_ig`、`fhir_rank_resource_profiles`、`fhir_get_profile`、`fhir_get_profile_elements`、`fhir_get_valueset`、`fhir_expand_valueset`、`fhir_get_resource_skeleton` | 1.2.0 |
| `fhir_validate_code` | 1.3.0（ValueSet 對 LOINC 的 `=` / `in` 屬性 filter（CLASSTYPE、CLASS、STATUS…）依本機 LOINC 判定，原本為 `unverifiable` 的結果可能變成 `valid` / `invalid`） |
| `fhir_finalize_resource` | 1.8.1（R6：`validation` 的無依據日期附修正建議）；1.8.0（`validation` 的 record checks 同 `fhir_validate_resource` 1.9.0）；1.7.2（同 `fhir_finalize_bundle` 1.3.2）；1.7.1（內容修正同 `fhir_finalize_bundle` 1.3.1、`site_config` 參數、`timezone` 可用 IANA 名稱）；1.7.0（[record checks](#record-checks) 併入 `validation`、可選 `source_text`）；1.6.0（`repair` / `timezone`：與 `fhir_finalize_bundle` 1.2.0 相同的內容修正，`changes` / `repair_issues`）；1.5.0（驗證規則同 `fhir_validate_resource` 1.7.0）；1.4.0（slice 成員依 discriminator 釘上 fixed / pattern、任何深度的 `_slice` 標記且一律移除；1.3.2：`resource` 保留草稿的數字原始寫法；1.3.1：驗證規則同 `fhir_validate_resource` 1.6.1；1.3.0：驗證 issue 的 `suggestions` / `caused_by`） |
| `fhir_lookup_code` | 1.3.2（RxNorm 碼可查） |
| `fhir_normalize_code` | 1.8.0（節錄版 CodeSystem 改查已安裝的完整版、候選 `linked`、別名解析到預設 IG 以外的 CodeSystem） |
| `fhir_check_grounding` | 1.4.0（v17.4：[IG 定義值](#ig-defined-values)的豁免收窄為 fixed / pattern、invariant 字面值與國家級給付 / 主管機關的範例身分值；範例醫院等不再豁免；`fhir_validate_bundle` 1.29.0、`fhir_validate_resource` 1.26.0、`fhir_finalize_bundle` 1.18.0、`fhir_finalize_resource` 1.23.0、`fhir_author_resources` / `fhir_assemble_bundle` 1.19.0 同步，沒有 `source_text` 時輸出不變）；1.1.0 |
| `fhir_check_completeness` | 1.1.1 |
| `fhir_check_fact_coverage` | 1.0.0（v18 R3 / v20 R4：事實契約檢查，見「[事實涵蓋](#fact-coverage)」） |
| `fhir_release_check` | 1.0.0（v18 R4 + v20 R1：放行判斷與完整性檢查，見「[放行判斷](#release-check)」） |
| `fhir_author_resources` | 1.6.1（R6：無依據日期附修正建議）；1.6.0（驗證同 `fhir_validate_resource` 1.9.0：帶 `source_text` 時的 record checks v15.1）；1.5.2（同 `fhir_finalize_bundle` 1.3.2）；1.5.1（內容修正同 `fhir_finalize_bundle` 1.3.1；context 的 `site_config` 時區行可作為 site 時區）；1.5.0（[record checks](#record-checks) 的 issue 出現在 `results[].issues`、可選 `source_text`）；1.4.0（system 修正與 display 檢查改用共用修正層：display 只在同一概念時才替換，意思不同則保留並以 warning 附候選；UCUM / 民國年 / system 名稱 / 結構修正與 finalize 工具一致；修正不新增驗證錯誤）；1.3.0（含 filter 的 ValueSet 寫在 system 時也能修正並註明成員資格 confirmed / unverifiable；未修正的 ValueSet system 為 error，驗證同 1.7.0）；1.2.0（ValueSet URL / 解析不到的 URL 寫在 `Coding.system` 時，答案唯一才自動改成正確的 CodeSystem 並加 note）；1.1.0（display 由代碼決定、單一值包成陣列、預設值只補必填欄位與 `apply_defaults`、`site_config`、結果的 `notes` / `settings`；1.0.0：從欄位值撰寫資源，見「[從欄位值撰寫資源](#authoring)」） |
| `fhir_assemble_bundle` | 1.6.0（R6，驗證同 `fhir_validate_bundle` 1.13.0）；1.5.0（資源同 `fhir_author_resources` 1.6.0、驗證同 `fhir_validate_bundle` 1.12.0）；1.4.2（同 `fhir_finalize_bundle` 1.3.2）；1.4.1（資源依 `fhir_author_resources` 1.5.1、定稿依 `fhir_finalize_bundle` 1.3.1）；1.4.0（驗證依 `fhir_validate_bundle` 1.11.0，含 [record checks](#record-checks)）；1.3.0（定稿一律 `repair="content"`、`repair_issues`，資源依 `fhir_author_resources` 1.4.0）；1.2.0（資源依 `fhir_author_resources` 1.3.0、驗證依 `fhir_validate_bundle` 1.9.0）；1.1.0（`site_config` 與 context 的合併後交給 grounding；1.0.0：由 key 清單組 Bundle） |
| `fhir_get_authoring_fields` | 1.4.0（v20 R5：`Condition.verificationStatus` / `Observation.interpretation` / `MedicationRequest.category` 為可由病歷推得的欄位——`source: "derived"` 不再 `auto`，`format` 寫明推導規則與病歷線索，profile 允許即列出；先前 interpretation / category 標為 auto「MCP derives it」但組合器其實不推導）；1.2.0（record link：連到同一 IG 其他紀錄資源的 backbone（`Encounter.diagnosis`）列為欄位並附子欄位與 `{condition: {ref}}` 範例，直接 reference 列在 `more` 並附 `targets`；長度上限改以整個回應計算，新增 `response_chars`）；1.1.0（預設值只在必填欄位上是 `auto`，選填欄位改為提示慣例值；1.0.0：剖面的填寫表） |
| `fhir_get_minimal_skeleton` | 1.7.0（v20 R5：必填的 `Condition.verificationStatus` / `Observation.interpretation` / `MedicationRequest.category` 在綁定含規則代碼時為 `derivable`，`how` = `derive from the record: <規則> (record cue: <線索>)`，優先於範例常數與工作流程預設值）；1.6.0（v17.4：範例值的嚴格規則——身分類資源與身分 / 聯絡元素不再是範例 `ig-constant`，改為 `record`；只保留 profile fixed / pattern、非身分資源的工作流程代碼，以及國家級給付 / 主管機關的範例身分值，見「[值的來源](#ig-structure)」）；1.6.0（v17.4：範例值的嚴格規則——身分類資源與身分 / 聯絡元素不再是範例 `ig-constant`，改為 `record`；只保留 profile fixed / pattern、非身分資源的工作流程代碼，以及國家級給付 / 主管機關的範例身分值，見「[值的來源](#ig-structure)」）；1.5.0（v19：必填 slice 的判別元素（例如 section code）即使 profile 設為選填也放入骨架；未切片元素為必填時 slice 的子元素也必填；Narrative 為 `{status, div}`；choice 允許代碼型別時以該型別撰寫；必填 coding slice 自己的 required 綁定決定代碼 / system；slice 的 pinned 值補進原本的 coding，不另增一筆）；1.2.0（v16.2：簡短 profile id 也在 IG 的依賴套件中解析（有歧義時回 `AMBIGUOUS_ARTIFACT` 並列出候選）；小型值集的代碼一律附 display（`code=display`），精簡層級也不省略）；1.1.0（v16.1：`slices` 展開骨架中的 slicing、`literals`、值集受限代碼的查詢方式，見「[IG 結構](#ig-structure)」）|
| `fhir_get_bundle_form` | 1.2.0（profile invariant 依 FHIRPath 轉成 `choose_one` / `required_if` / `format` / Bundle 層級規則，無法解析者掛 `rules`，見「[預填表單](#bundle-form)」）；1.1.0（評測回饋：不從 IG 範例帶入身分資料、資料型別規則、每個 entry 都有連結、`self_check`，見「[預填表單](#bundle-form)」）；1.0.1（release v1：不輸出空陣列，沒有 entry 時省略 `entry` 並提示帶入 `entries`）；1.0.0（v19 R2：Bundle 剖面的預填表單，見「[預填表單](#bundle-form)」） |
| `fhir_get_bundle_blueprint`、`fhir_get_minimal_skeleton` | 1.0.0（v16：Bundle 藍圖與最小骨架 + 值的來源，見「[IG 結構](#ig-structure)」） |
| `fhir_context` | 1.0.1（`get` 的結果帶 `notes`） |
| `query_fhir_condition`、`query_fhir_medication` | 1.2.0（不再以目前時間填 `recordedDate` / `note.time` / `meta.lastUpdated`——只在呼叫端提供時出現） |
