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
| `fhir_lookup_code` | 在 CodeSystem 中查詢單一碼的顯示名稱與屬性（RxNorm 查本機 `rxnorm.concepts`）；查無此碼時附 `hint`（改用 `fhir_normalize_code`）與 `near_codes`（IG CodeSystem 中相近的碼） | `system`, `code` |
| `fhir_validate_code` | 驗證 `system`+`code` 是否屬於指定 ValueSet，回傳 `valid` / `invalid` / `unverifiable`；`value_set` 可寫成 `url|version` | `system`, `code`, `value_set` |
| `fhir_normalize_code` | 自由文字（中英文、縮寫、病歷寫法）轉候選碼：SNOMED CT / LOINC / ICD-10，以及任何已安裝 IG 的 CodeSystem（例如健保支付碼 `medical-service-payment-tw`，見 [IG 術語搜尋](../modules/ig-concept-search.md)）。IG 候選附 `matched_term`、`matched_language`、`group`/`siblings`、`linked`（概念連到的其他系統代碼，例如藥品的 ATC 碼）；`system` 可給 canonical、id 或別名（`nhi_payment`）。**藥品**：健保藥品代碼可查 —— `system="medication-nhi-tw"`（TW Core）或 `"nhi-medication"`（TWPAS），文字可為中英文商品名或成分名（`Glucophage 500mg`、`脈優錠 5mg`）；預設 IG 只收錄節錄版 CodeSystem（TW Core 1.0.0 的 `medication-nhi-tw` 僅 35 碼）而另有安裝的套件收錄完整版（TW Core 0.3.2，44,709 碼）時，未指定 `package_id` / `version` 會改查完整版（`warnings` 與 `data.codesystem_copies` 會註明）。**ATC**：本機沒有可搜尋的 WHO ATC（TW Core `medcation-atc-tw` 只有 27 個台灣自訂碼），請先查健保藥品，候選的 `linked` 即其 ATC 碼（來自內建健保用藥 supplement） | `text`, `value_set`, `system`, `limit`（預設 10） |

## 授權、組裝與驗證
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_get_resource_skeleton` | 依剖面產生僅含必填 / mustSupport 結構的空白草稿；`required` 為元素自身 min≥1，`effectiveRequired` 另要求所有父元素皆必填 | `profile`, `candidate_limit`（預設 20，上限 100）, `include_examples`（預設 `true`） |
| `fhir_finalize_resource` | 將已寫好的 FHIR JSON 草稿依剖面定稿並驗證：只在草稿已有父節點處釘上 fixed / pattern（含 slice 成員與任何深度的 `_slice` 標記），不補臨床內容；`repair="content"`（預設）先套用與 `fhir_finalize_bundle` 相同的內容修正（見「[內容修正](#content-repair)」），回傳 `changes` / `repair_issues`；有欄位值時改用 `fhir_author_resources`（見「[從欄位值撰寫資源](#authoring)」） | `profile`, `draft`, `context_id`, `key`, `generate_narrative`（預設 `true`）, `repair`（`content` / `ids`）, `timezone`, `site_config` |
| `fhir_resolve_reference` | 以暫時鍵解析資源參照（供 Bundle 內互連） | `key`, `resource_type`, `context_id`, `display` |
| `fhir_build_bundle` | 將多筆資源組裝為 Bundle：`key` 變成確定性的 UUID v5 fullUrl（同一輸入永遠得到同一份 Bundle），資源內以 `key`、`urn:uuid:<key>`、`<Type>/<key>` 寫的引用一律改寫成產生的 fullUrl；給了不合法 `fullUrl` 時依 `fhir_finalize_bundle` 的規則正規化。`data.changes` 列出每一處改寫，`data.unresolved` 列出找不到對應 entry 的引用（1.2.0） | `entries`, `bundle_type`（預設 `transaction`）, `context_id` |
| `fhir_finalize_bundle` | **在輸出最終 Bundle 前呼叫**：整理 `fullUrl`、`reference` 和 `id`（見下節「Bundle 定稿」），`repair="content"`（預設）另修正可唯一確定的內容錯誤、不能確定的不猜並回報候選（見「[內容修正](#content-repair)」；`repair="ids"` 只整理 id）；數字保留呼叫端的原始寫法（`10.0` 仍是 `10.0`）。回傳整理後的 `bundle`、每一處改動 `changes[{path, from, to, rule}]`、無法確定的引用 `unresolved[{path, reference, candidates}]`、`notes` 與 `id_map`。`bundle_type` 可指定 `Bundle.type`（剖面固定的 type 不會被覆寫） | `bundle`, `package_id`, `version`, `bundle_profile`（目標 Bundle profile 的 canonical 或 id；省略時取 `meta.profile`）, `bundle_type`（R4 bundle-type 代碼）, `repair`（`content` 預設 / `ids`）, `timezone`（site 時區：UTC offset 或 IANA 名稱）, `site_config`（院所設定文字，`timezone:` 行可提供時區） |
| `fhir_validate_resource` | 驗證單一資源（結構 + 術語綁定）；未給 `profile` 時取 `meta.profile`。選用的 `source_text` 會另跑 grounding 檢查（見下節） | `resource`, `profile`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |
| `fhir_validate_bundle` | 驗證整個 Bundle（各 entry 依其 `meta.profile` + Bundle 內參照完整性）。ID 類錯誤（`UUIDs must be valid…`、引用無法解析、缺 fullUrl、bdl-7、不合法 id）附 `suggestions` 與 Bundle 層級的 `id_map` / `id_changes`；`normalize_ids=true` 時先整理再驗證並回傳 `normalized_bundle`（見下節「Bundle 定稿」）。選用的 `source_text` 會另跑 grounding 檢查並合併結果（見後文） | `bundle`, `normalize_ids`（預設 `false`）, `repair`（預設 `ids`；搭配 `normalize_ids` 可設 `content`）, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |

`fhir_validate_resource` / `fhir_validate_bundle` 的 `data` 另回報驗證是否完整：`checked_fully`（所有剖面與 ValueSet 都檢查到、且依賴閉包完整時為 `true`）、`profiles_unchecked`、`valuesets_unchecked`。`valid` 維持 HL7 語意（無法解析的剖面只是 warning），因此 `valid: true` 但 `checked_fully: false` 代表有部分內容沒有被檢查。驗證期間定義 / 術語查詢因資料庫問題失敗時另附 `lookups_failed`（失敗次數），此時一定有一則 `code: "exception"` 的 error issue，`valid` 為 `false`（1.6.1）。`|version` canonical（`meta.profile`、binding、targetProfile、type profile、extension url）的解析方式比照 HL7 validator_cli 7.0.1。

內建 validator 另比照 HL7 validator_cli 7.0.1 檢查（1.6.0 同版）：

- **Extension 使用位置**：依 extension 定義的 `context`（element / extension 型別；`version-specific-use` 限其他 FHIR 版本的 context 略過）與 `contextInvariant` 判斷能否用在該元素，不符時於宿主元素回報 error `The extension <url> v<version> is not allowed to be used at this point (this element is [...]; allowed for this version = e:...)` 或 `... (based on context invariant '...')`；fhirpath 型 context 不在本機評估（不判錯）。
- 未指定版本的 StructureDefinition 取閉包內版本最高的一份（例如 `hl7.fhir.uv.extensions.r4` 的 extension 優先於 R4 core 的同 URL 版本），因此 extension 自身的 invariant（如 `variable` 的 var-1）也會檢查。
- **`Unrecognized property`** 依 core 定義檢查整份資源（同 HL7 JSON parser），剖面不允許的 choice 型別、未知 extension 的 value 底下也會回報；JSON 形狀錯誤（單值寫成陣列）的元素不再往下檢查，與 HL7 相同。
- **RxNorm**：依 `rxnorm.concepts` 檢查碼與 display（tx.fhir.org 接受該 RXCUI 所有 SAB=RXNORM 名稱，不分大小寫），錯誤為 `Wrong Display Name '...' for http://www.nlm.nih.gov/research/umls/rxnorm#<code>. Valid display is '...'`。未知碼只有在本機 RxNorm 版本不舊於 tx.fhir.org（03022026）時才是 error，否則 warning；本機只有偏好名稱（migration 20261030 前匯入）時 display 不符只給 warning；未載入 RxNorm 時給 warning `Display not checked (RxNorm)`。
- IG CodeSystem（`content = complete`）的 `Unknown code` 維持 error；若另一個已安裝套件有同一 CodeSystem 較完整的版本且含此碼（例如 TW Core 0.3.2 的 `medication-nhi-tw`），另附 information 指出該套件與版本。
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
| `code` | required 綁定的 `code` 值寫成某個代碼的 display 或大小寫不同（`periodUnit: "hour"` → `h`），只限完整、≤ 200 碼的本機展開 | 對到多個或沒有 |

**不會新增錯誤**：每份資源修正前後各驗證一次；若修正後出現原本沒有的 error（例如改好 `system` 後才顯露的 display 錯誤、移入 `meta.profile` 後才開始檢查的剖面規則），相關修正撤回並以 `repair_issues`（warning，`not applied: …`）說明原因。例外（評測方決定）：改好 `system` 後，唯一新出現的 error 是**同一個 Coding** 的 display 檢查（`Wrong Display Name … for <新 system>#<code>`）時，這個錯誤在語意上原本就存在，`system` 的修正保留並列在 `changes`，display 錯誤照常由 `display` 規則回報並附以模型 display 查到的候選；其他任何新 error 仍會撤回。v14.1 起整份 Bundle 也在修正前後各驗證一次：只有在 Bundle 情境才看得到的 error（參照目標、entry slice、document 規則）同樣會讓造成它的修正撤回（依 error 所在路徑、訊息中提到的 entry / fullUrl 追溯；追溯不到時整批不套用）。Bundle 外殼的修正（補 `resourceType`、重建 `entry` 陣列）是讓驗證器能讀取這份 Bundle 的前提，不在此比較之內。同一輸入永遠得到同一結果，修正過的 Bundle 再修正一次 `changes` 為空；數字保留原始寫法。

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

## 從欄位值撰寫資源 {#authoring}

模型不再自己寫 FHIR JSON：它只給**欄位值**，MCP 依剖面組出資源、驗證、存在每個任務專屬的 **context**，最後由 key 清單組裝 Bundle。所有規則都來自解析到的套件 StructureDefinition / ValueSet 與 FHIR R4 核心，**不針對任何 IG 寫特例**（TW Core、TWPAS 或其他已安裝 IG 都一樣）。

| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_get_authoring_fields` | 剖面的「填寫表」：`fields`（必填 / 預期 / IG 範例中常用，`why` 說明原因）、`more`（其餘 mustSupport 欄位與 record link）、`omitted`（因長度省略者，不會默默丟掉）。**Record link**：選填、IG 未標 mustSupport、範例也沒用到，但其必填 Reference 子元素指向同一 IG（同 canonical base）中非實體類型（不是 Patient / Practitioner / Organization / Location 等人員或機構主檔）剖面的 backbone，例如 `Encounter.diagnosis`，會列在 `fields` 並附全部子欄位（`condition`、`use`、`rank`）與範例 `{condition: {ref: "condition"}}`；直接指向這類剖面的 reference（`Encounter.reasonReference`、`Condition.encounter`、`Procedure.reasonReference`、`Observation.hasMember` / `derivedFrom`）列在 `more` 並附 `targets`。整個回應（envelope、warnings、provenance，非 ASCII 字元以 `\uXXXX` 計）不超過 6,000 字元（保留 150 字元餘裕），實際長度見 `data.response_chars`。每個欄位有 `kind` + `format`（值怎麼寫）、`source`（record / facility / code / fixed / default / derived）、小型 `binding.codes`、`targets`、`children`；`auto: true` 的欄位由 MCP 自動補（`value` 顯示補什麼），`pins` 顯示剖面在你要填的欄位裡固定的部分（identifier system、component code、單位）。慣例預設值只在**必填**欄位上是 `auto`；選填欄位（`Patient.active` 等）列為一般選填欄位，`format` / `example` 只提示慣例值 | `profile`, `package_id`, `version`, `include_more`（預設 `true`） |
| `fhir_author_resources` | 一次撰寫多筆資源（8 筆以上沒問題）：`{key, profile, fields}`；MCP 補 `meta.profile`、fixed / pattern、slice、必填欄位的 workflow 預設值、可推導的值（例如有 encounter 的 Condition.category）、display、UCUM 單位、民國日期轉 ISO，並做下述「自動修正」，然後驗證並存進 context。回傳 `{context_id, storage, results[{key, status, resource, provenance, missing, refs, issues, notes}], summary, settings}` | `context_id`（第一次省略）, `resources`, `timezone`, `apply_defaults`（`required` / `none`）, `site_config` |
| `fhir_context` | 檢視或清理 context：`list`（每個 key 的狀態與引用）、`get`（單一 key 的完整結果）、`delete`（單一 key 或整個 context） | `context_id`, `action`, `key` |
| `fhir_assemble_bundle` | 由 key 清單組 Bundle：每個 entry 的 fullUrl 是該 key 的確定性 urn:uuid，經 `fhir_finalize_bundle` 的規則定稿、`fhir_validate_bundle` 驗證（給 `source_text` 時另做 grounding）；issue 都帶 `key` 與模型欄位名 | `context_id`, `keys`, `bundle_type`, `bundle_profile`, `identifier`, `timestamp`, `source_text`, `site_config`, `allow_invalid` |

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

**版本與隱私**

- `provenance` 帶 `tool`、`toolVersion`、`lexiconVersion` / `lexiconSha256`、`terminologyVersion` 與 `sourceSha256`（病歷全文 SHA-256 的前 16 碼）。`health_check` 回報 `tools_version`、`lexicon_version`、`lexicon_sha256`。
- 病歷全文（`source_text`）與院所設定不會寫入 log、metric label 或 provenance，只留 `sourceSha256`；格式錯誤的 JSON 請求本文也不會被記錄。

> 規則與詞彙表（`tw-lexicon`）以台灣病歷寫法為準；`fhir_check_completeness` 需要呼叫端讀轉換目標後提供 `targets`，不解析自然語言目標。檢查結果是輔助，不取代臨床人員審閱。

## 病歷是否真的提供了這項資訊（record checks）{#record-checks}

病歷刻意缺少某項資訊時，模型常常仍會「填上東西」：把「尚未取號」寫進病歷號、把只到月份的日期寫進 `Encounter.period.start`、把「待排除」的診斷寫成確立的 Condition。這些值有時格式合法，甚至字串真的出現在病歷裡，所以 validator 與 grounding 都會通過。**record checks** 是驗證之後的一層（`node-server/src/recordChecks/`，與 [修正建議](#validation-suggestions) 一樣在 validator 之後執行，不改動 InstanceValidator，validator parity 稽核不受影響），專門回報「病歷其實沒有提供這項資訊」。

**只回報、不修正**：不會改寫或刪除任何值，要不要改為回報 `insufficient_information` 由模型決定。

| 規則 | `code` | 需要 `source_text` | 嚴重度 | 判斷 |
| :--- | :--- | :--- | :--- | :--- |
| R1 | `information-absent` | 否 | error | 需要結構化值的欄位（`Identifier.value`、`Coding.code`、日期、`Quantity.value`、Reference、姓名、聯絡方式、`Observation.valueString`、批號、沒有代碼的 CodeableConcept 文字）的**整個值**都是在描述「資訊不存在 / 未知 / 待補 / 尚未取得 / 尚未確立」：例如「尚未取號」「建檔失敗」「尚在申請」「不詳」「待確認」「unknown」「pending」「not yet assigned」。訊息為「病歷沒有提供這項資訊」 |
| R2 | `identifier-format` | 否 | error（見下） | 依 `Identifier.system` 檢查格式：身分證字號（`http://www.moi.gov.tw`）格式與檢查碼；居留證統一證號（`http://www.immigration.gov.tw`）新式 / 舊式格式與檢查碼；任何識別碼不能是敘述句；`site_config` 可為院內系統（病歷號、健保卡號…）指定格式 |
| R3 | `insufficient-precision` | 是 | error | 事件時間（`Encounter.period`、`Observation.effective[x]` / `issued`、`MedicationRequest.authoredOn`、`DiagnosticReport`、`Specimen.collection`、`Composition.date` …，型別 dateTime / instant）只到年或月 |
| R3 | `incomplete-value` | 是 | error | 作為值的 Quantity（`valueQuantity`、`doseQuantity` …）沒有 `value`；藥品只有自由文字、沒有任何代碼，也沒有結構化劑量 |
| R4 | `unconfirmed-as-confirmed` | 是 | error / warning | Condition 沒有標成 provisional / differential / unconfirmed，而病歷中關於它的句子明確表示尚未確立（待排除、尚未確立、鑑別診斷、r/o、differential、not established）→ error；只是語氣保留（疑似、可能、possible、suspected）→ warning。病歷同時有「確診 / 證實 / confirmed」或有未加限定的提及時不報 error |
| R4 | `symptom-for-unconfirmed-diagnosis` | 是 | warning | Condition 用 ICD-10 症狀碼（R00–R99），而病歷的主診斷 / 診斷段落寫著「待排除…」，且 Bundle 中沒有 provisional / differential 的 Condition（病歷主診斷欄可判定時改由下面的主診斷欄規則報 error） |
| R4 | `unconfirmed-as-confirmed`（主診斷欄） | 是 | error / warning | 病歷的**主診斷欄**（Dx / Diagnosis / Impression / Assessment / A: / 診斷 / 主診斷 / 臆斷 …）整體未確立——只有鑑別診斷（鑑別診斷 / DDx / r/o 標題）、欄位層級的限定（未下診斷、診斷未定、no definitive diagnosis、「快篩結果出來前不下診斷」「待…結果後再下診斷」）、或每一項都被限定——而 Condition 沒有標成 provisional / differential / unconfirmed：它是其中一個鑑別項目、`code.text` 抄錄了鑑別清單、是症狀碼（ICD-10 R00–R99、SNOMED finding 語意標籤，或病歷只在主訴 / 現病史 / 檢查提到）代替主診斷，或是病歷沒有確立的其他診斷 → error（只有疑似 / 可能 → warning）。病歷其他地方確立的共病（過去病史、計畫、另一個主診斷欄中未限定的項目）不報 |
| R4 | `information-absent`（沒有診斷） | 是 | error | 有段落結構的病歷完全沒有診斷欄（或診斷欄是空的「診斷：」），而 Condition（不是 provisional / differential、不是 problem-list-item）只出現在主訴 / 現病史 / 檢查，或病歷中找不到 |
| R1 | `information-absent`（陳述缺漏、無值識別碼） | 是 | error | 病歷把欄位寫成缺漏（「病歷號：申請中」「採檢日期：無法辨識」「血糖：機器錯誤，未得數值」「處方：待藥師確認」），且病歷別處沒有給這個欄位值，Bundle 卻有值 → 值不在病歷中時報 `information-absent`，值是病歷中其他事件的（例如用就診日代替採檢日）時報 `value-from-other-event`。有 `system` 但沒有 `value` 的識別碼：病歷沒有這個號碼 → `information-absent`；病歷有 → `incomplete-value` 並附號碼 |
| R5 | `ungrounded-value` | 是 | error（紀錄性時間、衍生數量、參考範圍為 warning） | 每個 `Identifier.value`、date / dateTime / instant 與 `Quantity.value` 都必須在病歷（識別碼另含 `site_config`）中找得到：正規化後相符或有明確推導（見下）。找不到時訊息為「病歷中找不到這個值」，`evidence` 列出比對範圍、試過的正規化形式與最接近的病歷候選。日期在病歷中但時間沒有（典型是就診日 + 補上的 `T00:00:00`）也是 error；只寫日期而日期相符則通過。0、負數、999 這類病歷沒有的值另註明像佔位值 |
| R5 | `value-from-other-event` | 是 | error / warning | 值在病歷中，但屬於另一個時間點、事件或欄位：病歷寫第一次測量「機器錯誤、未得數值」、模型把第二次的值寫在第一次的時間 → error；兩次測量的值與時間對調 → warning；日期在病歷中只是過去事件（上次 / 曾 / previous）或出生日期 → error；號碼在病歷中是另一種號碼（把住院號寫成病歷號）→ error。只有能判定時才報 |

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

**R5 怎麼找值（`recordChecks/recordValues.ts`）**：只看病歷本文（轉換目標【轉換目標】與院所設定段不算），識別碼另查 `site_config` 全文。
- 識別碼：NFKC、不分大小寫、去掉 - _ . / 空白，比對完整 token、分隔片段的連續組合、去掉前導 0、黏在一起的英文標籤前綴（MRN00775310）。系統產生的識別碼（`urn:uuid`、Bundle / Composition / Claim identifier）不檢查。
- 日期：西元、民國（114/06/10、民國114年6月10日）、年月日、斜線、月日（以病歷中的年份補年）、英文月份；時間含 HH:MM(:SS)、上午 / 下午 N 點 M 分、am / pm、日期後緊接的 HHMM；site 時區（`site_config` 的 `timezone:`，預設 +08:00）換算後也比對。推導：入院第 N 天 / hospital day N / HD#N（入院日 + N−1）、術後第 N 天 / POD#N（手術日 + N）、第 N 天、N 天前 / N 天後、昨天 / 前天 / 今天 / 隔天 / 次日、N 週前 / 後、N 個月前 / 後、主訴的病程（咳嗽 3 天 → 3 或 2 天前）、療程行的天數（處方 … 7 天 → 起日 + 6 或 7）、N 年前 / N 年（年份）、年齡（54 歲 → 出生年）、「N 分鐘 / 小時 後 / 前」。中文數字可讀（入院第三天）。錨點是病歷自己的日期：入院類用入院日、術後類用手術日、其他用同一行的日期，否則最近的上一個日期行（出生日期不算）；`Encounter.period.start` 與 `Patient.birthDate` 必須是病歷寫出的日期。紀錄性時間（`authoredOn`、`recordedDate`、`issued` …）日期找不到只給 warning、不檢查時間；工具或文件自己產生的時間（`Bundle.timestamp`、`Composition.date`、`Provenance.recorded` …）不檢查。
- 數量：日期與時間以外的每個數字（所以 0 或 14 不會被「08:00」「2025/03/14」撐腰），含單位、中文數字、「半」、分數；單位相容才算（兩邊都是已知單位時），可換算單位（質量 / 體積 / 長度 / 時間、°F ↔ °C、葡萄糖 mg/dL ↔ mmol/L、10^3/uL ↔ /uL）、身高體重算 BMI、明寫的乘積（500 mg x 2）。衍生數量（`dispenseRequest.quantity`、`expectedSupplyDuration`、Claim item 數量）另接受同一行數字的乘積，找不到時只給 warning；參考範圍找不到為 warning；分母不檢查。

**輸出**

- 每個 issue：`severity`、`code`（上表）、`path`、`message`（中文 / 英文）、`message_zh`、`message_en`、`rule`（R1–R5）、`source: "record-checks"`、`evidence`（判斷依據），需要病歷的規則另有 `located_quotes`。
- `fhir_validate_bundle` / `fhir_validate_resource`：issue 依 entry 併入 `entries[i].issues`（Bundle 層級併入 `issues`），**error 會讓 `entries[i].valid` 與 `data.valid` 變成 false**（`conformanceValid` / `groundingValid` 維持原意）；帶 `source_text` 或有任何發現時加上 `data.record_checks = {ok, errors, warnings, rules, source_text, notes?}`。沒有 `source_text` 時只跑 R1、R2（R1 的陳述缺漏與無值識別碼、R3–R5 都需要病歷）；**沒有 `source_text` 且沒有任何發現時，輸出與未加這一層前逐位元相同**（沒有 `record_checks`，也沒有額外的 provenance 欄位）。
- `fhir_author_resources`：同 `fhir_validate_resource`，出現在 `results[].issues`（error 使 status 為 `invalid`）；可選 `source_text`（不存入 context）加跑 R3 / R4；`site_config` 的格式規則一併套用。
- `fhir_assemble_bundle`：同 `fhir_validate_bundle`（帶 `source_text` 時跑 R3 / R4），issue 帶 key / field。
- `fhir_finalize_bundle`：可選 `source_text`；結果在 `data.record_issues` 與 `data.record_checks`（Bundle 與 `changes` 不變），有 error 時加一則 warning。
- `fhir_finalize_resource`：可選 `source_text`；issue 併入 `data.validation.issues`（error 使 `validation.valid` 為 false），草稿不會被修改。
- 上述各工具都遵守同一條：沒有 `source_text` 且沒有發現時輸出不變。
- 有輸出時，`provenance` 增加 `recordChecksVersion`、`recordChecksLexicon`、`recordChecksLexiconSha256`。病歷原文不寫入 log。

## 工具版本 {#tool-versions}

行為由固定測資鎖定的工具各有自己的版本（`node-server/src/toolVersions.ts`）；同一輸入的輸出改變時就會升版。`health_check` 的 `tools_version` 回報目前值，其餘工具沿用伺服器版本（`version`，目前 `1.1.0`）。

| 工具 | 版本 |
| :--- | :--- |
| `fhir_validate_bundle` | 1.12.0（[record checks](#record-checks) v15.1：帶 `source_text` 時每個識別碼 / 日期 / 數量都要在病歷中找得到（`ungrounded-value`）、其他時間點 / 事件 / 欄位的值（`value-from-other-event`）、陳述缺漏與無值識別碼、主診斷欄規則、括號內限定詞的範圍；沒有 `source_text` 時輸出不變）；1.11.2（`normalize_ids` + `repair="content"` 同 `fhir_finalize_bundle` 1.3.2）；1.11.1（`normalize_ids` + `repair="content"` 的內容修正同 `fhir_finalize_bundle` 1.3.1）；1.11.0（[record checks](#record-checks)：information-absent / identifier-format 一律檢查，帶 `source_text` 另檢查精度、數值、藥品與未確立診斷；`data.record_checks`）；1.10.0（`repair="content"` 搭配 `normalize_ids=true`：先做內容修正再驗證，`content_changes` / `repair_issues`）；1.9.0（validator v13：ValueSet canonical 當 `Coding.system` 為 error、LOINC 屬性 filter 可判定成員）；1.8.0（`normalized_bundle` 保留數字原始寫法；document / message 缺首筆資源的 bdl-11 / bdl-12 附 `replace_value` / `add_resource` 建議；1.7.0：`normalize_ids`、ID 類錯誤的 `suggestions` 與 `id_map` / `id_changes`） |
| `fhir_validate_resource` | 1.9.0（record checks 同 `fhir_validate_bundle` 1.12.0）；1.8.0（[record checks](#record-checks)，同 `fhir_validate_bundle` 1.11.0）；1.7.0（validator v13：ValueSet canonical 當 `Coding.system` 為 error 並附候選、LOINC 屬性 filter 可判定成員）；1.6.2（validator v8：HL7 空間未知 CodeSystem 一律 error、參照含空白、RxNorm display 指到另一個藥、查詢失敗 / 例外的 `exception` issue；1.6.0：issue 的 `suggestions` / `caused_by`） |
| `fhir_finalize_bundle` | 1.4.0（`source_text` 的 `data.record_issues` 同 `fhir_validate_bundle` 1.12.0 的 record checks）；1.3.2（評測方決定：同一 Coding 因 system 修正而顯露的 display 錯誤不撤回該修正；剖面只允許一個單位時直接設定並記錄在 `changes`）；1.3.1（v14.1 內容修正：`timezone` / `empty` / `fixed-slice` 規則、UCUM 等價與 annotation、`quantity-code-not-ucum`、ValueSet 名稱與更名的 system、更多結構修正、Bundle 外殼與重複 fullUrl、整份 Bundle 的修正驗證、`site_config` 參數）；1.3.0（[record checks](#record-checks)：可選 `source_text`、`data.record_issues` / `record_checks`，只回報不修正）；1.2.0（`repair` 參數，預設 `content`：display / ucum / roc-date / system / shape / code 內容修正、驗證不新增錯誤、`repair_issues`、`timezone`；`repair="ids"` 同 1.1.0）；1.1.0（數字保留原始寫法、`bundle_type` 參數、document 缺 Composition 的提示；1.0.1：Bundle 定稿：fullUrl-uuid / reference-rewire / resource-id / bundle-type / document-order） |
| `fhir_build_bundle` | 1.2.1（entry 資源的數字保留原始寫法；1.2.0：共用 Bundle 定稿引擎：確定性 UUID、key / urn:uuid:key / Type/key 引用改寫、不合法 fullUrl 正規化、`changes`） |
| `fhir_get_profile_required_elements` | 1.4.1（`bundle_rules.bundle_type` 提及 `fhir_finalize_bundle` 的 `bundle_type`；1.4.0：Bundle profile 的 `bundle_rules`；1.3.0：derived 列的 allowedCodes 與推導規則、`include_mustsupport="defaults"`、`optional`） |
| `fhir_list_igs`、`fhir_list_artifacts`、`fhir_search_artifacts`、`fhir_list_resource_profiles`（新增 `compact`） | 1.3.0 |
| `fhir_get_ig`、`fhir_rank_resource_profiles`、`fhir_get_profile`、`fhir_get_profile_elements`、`fhir_get_valueset`、`fhir_expand_valueset`、`fhir_get_resource_skeleton` | 1.2.0 |
| `fhir_validate_code` | 1.3.0（ValueSet 對 LOINC 的 `=` / `in` 屬性 filter（CLASSTYPE、CLASS、STATUS…）依本機 LOINC 判定，原本為 `unverifiable` 的結果可能變成 `valid` / `invalid`） |
| `fhir_finalize_resource` | 1.8.0（`validation` 的 record checks 同 `fhir_validate_resource` 1.9.0）；1.7.2（同 `fhir_finalize_bundle` 1.3.2）；1.7.1（內容修正同 `fhir_finalize_bundle` 1.3.1、`site_config` 參數、`timezone` 可用 IANA 名稱）；1.7.0（[record checks](#record-checks) 併入 `validation`、可選 `source_text`）；1.6.0（`repair` / `timezone`：與 `fhir_finalize_bundle` 1.2.0 相同的內容修正，`changes` / `repair_issues`）；1.5.0（驗證規則同 `fhir_validate_resource` 1.7.0）；1.4.0（slice 成員依 discriminator 釘上 fixed / pattern、任何深度的 `_slice` 標記且一律移除；1.3.2：`resource` 保留草稿的數字原始寫法；1.3.1：驗證規則同 `fhir_validate_resource` 1.6.1；1.3.0：驗證 issue 的 `suggestions` / `caused_by`） |
| `fhir_lookup_code` | 1.3.2（RxNorm 碼可查） |
| `fhir_normalize_code` | 1.8.0（節錄版 CodeSystem 改查已安裝的完整版、候選 `linked`、別名解析到預設 IG 以外的 CodeSystem） |
| `fhir_check_grounding` | 1.1.0 |
| `fhir_check_completeness` | 1.1.1 |
| `fhir_author_resources` | 1.6.0（驗證同 `fhir_validate_resource` 1.9.0：帶 `source_text` 時的 record checks v15.1）；1.5.2（同 `fhir_finalize_bundle` 1.3.2）；1.5.1（內容修正同 `fhir_finalize_bundle` 1.3.1；context 的 `site_config` 時區行可作為 site 時區）；1.5.0（[record checks](#record-checks) 的 issue 出現在 `results[].issues`、可選 `source_text`）；1.4.0（system 修正與 display 檢查改用共用修正層：display 只在同一概念時才替換，意思不同則保留並以 warning 附候選；UCUM / 民國年 / system 名稱 / 結構修正與 finalize 工具一致；修正不新增驗證錯誤）；1.3.0（含 filter 的 ValueSet 寫在 system 時也能修正並註明成員資格 confirmed / unverifiable；未修正的 ValueSet system 為 error，驗證同 1.7.0）；1.2.0（ValueSet URL / 解析不到的 URL 寫在 `Coding.system` 時，答案唯一才自動改成正確的 CodeSystem 並加 note）；1.1.0（display 由代碼決定、單一值包成陣列、預設值只補必填欄位與 `apply_defaults`、`site_config`、結果的 `notes` / `settings`；1.0.0：從欄位值撰寫資源，見「[從欄位值撰寫資源](#authoring)」） |
| `fhir_assemble_bundle` | 1.5.0（資源同 `fhir_author_resources` 1.6.0、驗證同 `fhir_validate_bundle` 1.12.0）；1.4.2（同 `fhir_finalize_bundle` 1.3.2）；1.4.1（資源依 `fhir_author_resources` 1.5.1、定稿依 `fhir_finalize_bundle` 1.3.1）；1.4.0（驗證依 `fhir_validate_bundle` 1.11.0，含 [record checks](#record-checks)）；1.3.0（定稿一律 `repair="content"`、`repair_issues`，資源依 `fhir_author_resources` 1.4.0）；1.2.0（資源依 `fhir_author_resources` 1.3.0、驗證依 `fhir_validate_bundle` 1.9.0）；1.1.0（`site_config` 與 context 的合併後交給 grounding；1.0.0：由 key 清單組 Bundle） |
| `fhir_get_authoring_fields` | 1.2.0（record link：連到同一 IG 其他紀錄資源的 backbone（`Encounter.diagnosis`）列為欄位並附子欄位與 `{condition: {ref}}` 範例，直接 reference 列在 `more` 並附 `targets`；長度上限改以整個回應計算，新增 `response_chars`）；1.1.0（預設值只在必填欄位上是 `auto`，選填欄位改為提示慣例值；1.0.0：剖面的填寫表） |
| `fhir_context` | 1.0.1（`get` 的結果帶 `notes`） |
| `query_fhir_condition`、`query_fhir_medication` | 1.2.0（不再以目前時間填 `recordedDate` / `note.time` / `meta.lastUpdated`——只在呼叫端提供時出現） |
