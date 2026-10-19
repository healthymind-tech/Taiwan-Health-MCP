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
| `fhir_finalize_resource` | 將草稿依剖面定稿並回傳完整資源 | `profile`, `draft`, `context_id`, `key`, `generate_narrative`（預設 `true`） |
| `fhir_resolve_reference` | 以暫時鍵解析資源參照（供 Bundle 內互連） | `key`, `resource_type`, `context_id`, `display` |
| `fhir_build_bundle` | 將多筆資源組裝為 Bundle | `entries`, `bundle_type`（預設 `transaction`）, `context_id` |
| `fhir_validate_resource` | 驗證單一資源（結構 + 術語綁定）；未給 `profile` 時取 `meta.profile`。選用的 `source_text` 會另跑 grounding 檢查（見下節） | `resource`, `profile`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |
| `fhir_validate_bundle` | 驗證整個 Bundle（各 entry 依其 `meta.profile` + Bundle 內參照完整性）。選用的 `source_text` 會另跑 grounding 檢查並合併結果（見下節） | `bundle`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |

`fhir_validate_resource` / `fhir_validate_bundle` 的 `data` 另回報驗證是否完整：`checked_fully`（所有剖面與 ValueSet 都檢查到、且依賴閉包完整時為 `true`）、`profiles_unchecked`、`valuesets_unchecked`。`valid` 維持 HL7 語意（無法解析的剖面只是 warning），因此 `valid: true` 但 `checked_fully: false` 代表有部分內容沒有被檢查。`|version` canonical（`meta.profile`、binding、targetProfile、type profile、extension url）的解析方式比照 HL7 validator_cli 7.0.1。

內建 validator 另比照 HL7 validator_cli 7.0.1 檢查（1.6.0 同版）：

- **Extension 使用位置**：依 extension 定義的 `context`（element / extension 型別；`version-specific-use` 限其他 FHIR 版本的 context 略過）與 `contextInvariant` 判斷能否用在該元素，不符時於宿主元素回報 error `The extension <url> v<version> is not allowed to be used at this point (this element is [...]; allowed for this version = e:...)` 或 `... (based on context invariant '...')`；fhirpath 型 context 不在本機評估（不判錯）。
- 未指定版本的 StructureDefinition 取閉包內版本最高的一份（例如 `hl7.fhir.uv.extensions.r4` 的 extension 優先於 R4 core 的同 URL 版本），因此 extension 自身的 invariant（如 `variable` 的 var-1）也會檢查。
- **`Unrecognized property`** 依 core 定義檢查整份資源（同 HL7 JSON parser），剖面不允許的 choice 型別、未知 extension 的 value 底下也會回報；JSON 形狀錯誤（單值寫成陣列）的元素不再往下檢查，與 HL7 相同。
- **RxNorm**：依 `rxnorm.concepts` 檢查碼與 display（tx.fhir.org 接受該 RXCUI 所有 SAB=RXNORM 名稱，不分大小寫），錯誤為 `Wrong Display Name '...' for http://www.nlm.nih.gov/research/umls/rxnorm#<code>. Valid display is '...'`。未知碼只有在本機 RxNorm 版本不舊於 tx.fhir.org（03022026）時才是 error，否則 warning；本機只有偏好名稱（migration 20261030 前匯入）時 display 不符只給 warning；未載入 RxNorm 時給 warning `Display not checked (RxNorm)`。
- IG CodeSystem（`content = complete`）的 `Unknown code` 維持 error；若另一個已安裝套件有同一 CodeSystem 較完整的版本且含此碼（例如 TW Core 0.3.2 的 `medication-nhi-tw`），另附 information 指出該套件與版本。
- 直接綁定 ValueSet 的 Coding 元素（如 `Encounter.class`）以 ValueSet URL 當 system 時，只回報綁定 warning，不再報 `The Coding references a value set` error（與 HL7 相同）。

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
| `Unrecognized property 'p'` | `rename_property` / `move_property` | 同一層最接近的元素名（含 datatype 子元素、choice 元素的具型別名稱，如 `value` → `valueQuantity`），或該名稱實際所在的層級（`timing.periodUnit` → `timing.repeat.periodUnit`） |
| `The type 'date' is not allowed for Condition.onset[x]` | `rename_property` | 允許型別中符合值形狀的具型別名稱（`onsetDate` → `onsetDateTime`） |
| 值不在 required / extensible ValueSet 內 | `choose_code` | ValueSet 展開後的代碼：小型 ValueSet 全列並依相似度排序，大型者取與原代碼 / display 最接近者（含 `fhir_normalize_code`） |
| 其他 CodeSystem 的 `Unknown code` | `replace_code` / `replace_system` | validator 會接受的拼寫修正（大小寫、ICD 小數點、LOINC 連字號）、名稱與 display / text 相符的代碼（`fhir_normalize_code`）、IG CodeSystem 的相近代碼，以及代碼形狀相符的其他術語（LOINC 代碼放在 SNOMED system） |
| `Wrong Display Name` | `replace_display`（+ `replace_code`） | validator 列出的有效 display（各術語格式一致），若寫的 display 其實是另一個代碼的名稱，也提示改代碼 |
| `Unable to find a profile match for urn:uuid:X` | `caused_by` | 被參照資源本身的錯誤（`fullUrl`、`entry`、`path`、`message`）；它本身沒有錯時，改列它對該參照要求的剖面驗證時的錯誤（附 `profile`） |

`patch` 以 validator 的點路徑表示（`op`: `replace` / `move`，`move` 另有 `from`）。`confidence` 是啟發式分數，不是機率；建議是輔助，套用後請再驗證一次。建議的排序與內容對同一輸入是固定的（決定性），計算失敗時該 issue 只是沒有建議，不影響驗證結果。評估方式與數據見 `node-server/scripts/suggestions-eval/`。

> 程序內驗證以剖面 snapshot 與術語綁定為基礎，比對基準為 HL7 validator_cli 7.0.1（稽核方式與結果見 `node-server/scripts/validator-audit/`），但不等同官方 HL7 FHIR Validator 的一致性認證。

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

## 工具版本 {#tool-versions}

行為由固定測資鎖定的工具各有自己的版本（`node-server/src/toolVersions.ts`）；同一輸入的輸出改變時就會升版。`health_check` 的 `tools_version` 回報目前值，其餘工具沿用伺服器版本（`version`，目前 `1.1.0`）。

| 工具 | 版本 |
| :--- | :--- |
| `fhir_validate_resource`、`fhir_validate_bundle` | 1.6.0（issue 的 `suggestions` / `caused_by`） |
| `fhir_get_profile_required_elements` | 1.3.0（derived 列的 allowedCodes 與推導規則、`include_mustsupport="defaults"`、`optional`） |
| `fhir_list_igs`、`fhir_list_artifacts`、`fhir_search_artifacts`、`fhir_list_resource_profiles`（新增 `compact`） | 1.3.0 |
| `fhir_get_ig`、`fhir_rank_resource_profiles`、`fhir_get_profile`、`fhir_get_profile_elements`、`fhir_get_valueset`、`fhir_expand_valueset`、`fhir_validate_code`、`fhir_get_resource_skeleton` | 1.2.0 |
| `fhir_finalize_resource` | 1.3.0（驗證 issue 的 `suggestions` / `caused_by`） |
| `fhir_lookup_code` | 1.3.2（RxNorm 碼可查） |
| `fhir_normalize_code` | 1.8.0（節錄版 CodeSystem 改查已安裝的完整版、候選 `linked`、別名解析到預設 IG 以外的 CodeSystem） |
| `fhir_check_grounding` | 1.1.0 |
| `fhir_check_completeness` | 1.1.1 |
