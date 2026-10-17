# FHIR IG 工具 (FHIR IG Tools)

一套通用、以 IG 為範圍的工具集，建構於多 IG（multi-IG）的 `fhir.*` 儲存之上，用於探索 Implementation Guide、讀取剖面與術語、進行術語驗證，以及以骨架填值方式產生與驗證 FHIR R4 資源。

## 共通慣例
- 每個工具都可帶入選用的 `package_id` + `version`；兩者皆省略時鎖定**預設 IG**（`isDefault`）。
- 回應採用共同信封：`{ok, data, warnings, provenance, error?}`。
- 模組概念與建議工作流程見 [FHIR IG 服務模組](../modules/fhir-ig-service.md)。

## IG 探索
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_list_igs` | 列出已安裝 IG 套件（packageId / version / title / canonical / fhirVersion / status / isDefault / dependencies） | — |
| `fhir_get_ig` | 單一 IG 詳情與各資源型別 artifact 數量 | `package_id`, `version` |
| `fhir_list_artifacts` | 列出 IG 的 conformance artifacts 摘要 | `resource_type`, `grouping_id`, `limit`（預設 50，上限 200） |
| `fhir_search_artifacts` | 以 id / canonical / name / title / description 全文搜尋 artifacts | `keyword`, `resource_type`, `limit`（預設 20，上限 100） |

## 剖面選擇與讀取
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_list_resource_profiles` | 列出可選資源剖面，依約束的基礎資源型別分組 | `base_type` |
| `fhir_rank_resource_profiles` | 依來源欄位鍵與剖面 element path 吻合度排名（僅建議，`selectionRequired:true`） | `keys`, `base_type`, `limit`（預設 5，上限 20） |
| `fhir_get_profile` | 單一剖面摘要（身分 / base / derivation / element 數），支援 id / canonical / key 解析 | `identifier` |
| `fhir_get_profile_elements` | 讀取剖面 snapshot；`view` = `elements` / `element` / `slices` / `choices` / `binding` / `examples` | `profile`, `view`, `path`, `slice_name`, `limit` |
| `fhir_get_profile_required_elements` | 列出剖面「實際必填」的元素：整條父鏈皆必填才算、必填 slice、choice 型別、invariant 隱含的 value[x] 或 dataAbsentReason（vs-2 / vs-3 / tw-core-4 類，依運算式自動偵測）、target-implied 主要內容；每列附 `grounding_class`（auto / coding / source_fact / workflow_default …）、`required_by`、小型 required binding 的 `allowedCodes` 與填寫提示 `hint`。有 profile 的 extension 會依其定義展開（url、ext-1 隱含的 value[x]、必填子 extension），已填元素的基礎資料型別必填子元素也會列出（Narrative.div、Extension.url …），剖面自訂的 error invariant 列在 `invariants`。給 `instance` 時依 discriminator 比對 slice，未出現的 slice 不會帶出其子元素 | `profile`, `instance`（草稿：已填的選填父元素其必填子元素也列出）, `include_target_implied`（預設 `true`）, `include_mustsupport`（預設 `false`）, `verbosity`（預設 `compact`：id / required_by / grounding_class / fixed·pattern·value / choices / allowedCodes / hint，剖面固定的子樹折疊成一個可直接複製的 `value`；`full` 另含 min / max / types / binding / mustSupport） |

## 術語 / ValueSet
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_get_valueset` | ValueSet 定義摘要 | `identifier` |
| `fhir_expand_valueset` | 展開 ValueSet 並列出成員碼 | `identifier`, `limit` |
| `fhir_lookup_code` | 在 CodeSystem 中查詢單一碼的顯示名稱與屬性 | `system`, `code` |
| `fhir_validate_code` | 驗證 `system`+`code` 是否屬於指定 ValueSet | `system`, `code`, `value_set` |
| `fhir_normalize_code` | 以自由文字對照 ValueSet，回傳最合適標準碼 | `text`, `value_set`, `system`, `limit`（預設 10） |

## 授權、組裝與驗證
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_get_resource_skeleton` | 依剖面產生僅含必填 / mustSupport 結構的空白草稿；`required` 為元素自身 min≥1，`effectiveRequired` 另要求所有父元素皆必填 | `profile`, `candidate_limit`（預設 20，上限 100）, `include_examples`（預設 `true`） |
| `fhir_finalize_resource` | 將草稿依剖面定稿並回傳完整資源 | `profile`, `draft`, `context_id`, `key`, `generate_narrative`（預設 `true`） |
| `fhir_resolve_reference` | 以暫時鍵解析資源參照（供 Bundle 內互連） | `key`, `resource_type`, `context_id`, `display` |
| `fhir_build_bundle` | 將多筆資源組裝為 Bundle | `entries`, `bundle_type`（預設 `transaction`）, `context_id` |
| `fhir_validate_resource` | 驗證單一資源（結構 + 術語綁定）；未給 `profile` 時取 `meta.profile`。選用的 `source_text` 會另跑 grounding 檢查（見下節） | `resource`, `profile`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |
| `fhir_validate_bundle` | 驗證整個 Bundle（各 entry 依其 `meta.profile` + Bundle 內參照完整性）。選用的 `source_text` 會另跑 grounding 檢查並合併結果（見下節） | `bundle`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |

> 程序內驗證以剖面 snapshot 與術語綁定為基礎，不等同官方 HL7 FHIR Validator 的一致性認證。

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
