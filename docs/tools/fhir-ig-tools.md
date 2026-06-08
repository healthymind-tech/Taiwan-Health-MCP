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

## 術語 / ValueSet
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_get_valueset` | ValueSet 定義摘要 | `identifier` |
| `fhir_expand_valueset` | 展開 ValueSet 並列出成員碼 | `identifier`, `limit` |
| `fhir_lookup_code` | 在 CodeSystem 中查詢單一碼的顯示名稱與屬性 | `system`, `code` |
| `fhir_validate_code` | 驗證 `system`+`code` 是否屬於指定 ValueSet | `system`, `code`, `value_set` |
| `fhir_normalize_code` | 以自由文字對照 ValueSet，回傳最合適標準碼 | `text`, `value_set` |

## 授權、組裝與驗證
| 工具 | 說明 | 主要參數 |
| :--- | :--- | :--- |
| `fhir_get_resource_skeleton` | 依剖面產生僅含必填 / mustSupport 結構的空白草稿 | `profile` |
| `fhir_finalize_resource` | 將草稿依剖面定稿並回傳完整資源 | `profile`, `draft` |
| `fhir_resolve_reference` | 以暫時鍵解析資源參照（供 Bundle 內互連） | `key`, `resource_type` |
| `fhir_build_bundle` | 將多筆資源組裝為 Bundle | `entries`, `bundle_type` |
| `fhir_validate_resource` | 依 `meta.profile` 驗證單一資源（結構 + 術語綁定） | `resource` |
| `fhir_validate_bundle` | 驗證整個 Bundle | `bundle` |

> 程序內驗證以剖面 snapshot 與術語綁定為基礎，不等同官方 HL7 FHIR Validator 的一致性認證。
