# FHIR IG MCP 工具集 —— 資料就緒度評估與多 IG 設計

!!! info "歷史文件（設計評估，已實作）"
    這是 FHIR IG 工具集的**設計評估**，撰寫於實作之前，內容假設後端為 Python
    （文中的 `src/admin_jobs.py`、`src/twcore_service.py`、`pip install fhirpathpy`
    等均已不存在）。工具集已實作完成：19 個 `fhir_*` 工具現以 TypeScript 提供，
    FHIRPath 驗證由 npm 套件 `fhirpath` 在行程內執行，**不需要任何額外安裝**。
    本文保留作為決策紀錄；目前的工具說明請見 [FHIR IG 工具](tools/fhir-ig-tools.md)。

**狀態：** 評估／規劃（尚未變更程式碼）
**日期：** 2026-06-07
**範圍：** 25 個工具的 FHIR-IG 驅動 MCP 伺服器規格（IG 探索 → 剖面選擇 → StructureDefinition → 術語 → 對應 → 參照/Bundle → 驗證），對照本倉庫目前實際儲存的資料進行評估，並以 `fhir-code/twcoreig/v1.0.0/package.tgz` 原始檔作為對照依據。
**前瞻性限制：** 平台未來會匯入**多個 IG 套件**。以下每個工具從第一天起就設計為 IG-scoped（以 `ig = {packageId, version}` 選擇），而非寫死 TW Core。

---

## 0. 結論摘要（TL;DR）

我們需要的原始資料**幾乎已經全部在資料庫裡**。TWCore 的管理後台匯入（`src/admin_jobs.py` → `twcore.artifacts`）會吃下 `package.tgz` 內**每一個 `.json` 資源**，並把**完整的 FHIR JSON 存進 `twcore.artifacts.raw_json`（JSONB）**——包含帶有完整 `snapshot.element` 的 StructureDefinition（binding、slicing、choice type）、帶 `compose` 的 ValueSet、CodeSystem、ConceptMap、SearchParameter、ImplementationGuide、CapabilityStatement，以及全部 98 個 example。CodeSystem 的 concept 另外解析進 `twcore.concepts`。

因此 **25 個工具中有 17 個的資料已完全齊備**——它們需要的是解析／服務程式碼，而不是新資料。在下列設計決策之後，**不需要任何外部服務**，也**沒有「儲存式對應」的缺口**：

| 缺口 | 影響工具 | 原因 | 在 `package.tgz` 裡？ |
|---|---|---|---|
| **內建驗證器**（行程內 Python） | 24、25 | 一致性檢查（結構 + 術語 + FHIRPath 不變式 + slicing）——以 Python 原生撰寫，**不需 Java sidecar、不需外部服務**（見 §3 缺口 1）。所有輸入（snapshot、constraint 運算式、slicing 規則、extension 定義）都已在 `raw_json` 內；FHIRPath 由純 Python 的 `fhirpathpy` 函式庫在行程內處理。 | ✅ 資料齊備；只需撰寫服務程式碼 |
| **外部／filter 型 ValueSet 的展開** | 15、16、17 | 許多 TWCore ValueSet 是對 `http://snomed.info/sct` 做 `filter`，或參照 HL7 THO 系統，而非內嵌列舉。內嵌與本地持有的系統（我們有 SNOMED/LOINC/ICD schema）可正常展開；其餘需要匯入相依套件或外部術語伺服器。 | ⚠️ 部分——設計上已回傳 `TERMINOLOGY_SERVER_REQUIRED` |

**沒有儲存式對應樣板。** 原規格的工具 19–21（`get_mapping_template` / `plan_mapping` / `apply_mapping`）假設存在一套決定性、事先核可的「來源→FHIR」規則庫——那是**前 LLM 時代的產物**。我們用 **schema-guided fill**（§3 缺口 2）**取代**它：伺服器依剖面 snapshot 即時產出一份空白、帶註解的骨架，LLM 填入**語意**空格，系統則決定性地釘住**機制**欄位並驗證。這**消除了唯一「來源資料完全不存在」的缺口**——不需要新的對應 schema，也不需要管理後台的編輯介面。其餘一切都只是對既有資料做解析與服務。

---

## 1. 我們今天實際儲存了什麼（資料盤點）

### 1.1 `twcore.artifacts` —— 金礦
`src/admin_jobs.py`（TWCore 匯入）會走訪每一個 `package/*.json` 成員，對每個帶有 `resourceType` 的資源寫入一列：

```
twcore.artifacts(
  artifact_key PK,            -- "{resourceType}/{id}"  ← 注意：非 package-scoped（多 IG 問題，§4）
  resource_type, artifact_id, canonical_url, name, title, status,
  kind, base_type, derivation,
  grouping_id, grouping_name, -- 來自 IG 的 definition.grouping
  description, package_path,
  child_count, concept_count,
  raw_json JSONB,             -- ★ 完整的 FHIR 資源
  imported_at
)
```

已對照 `package.tgz` 驗證：

- **StructureDefinition-Condition-twcore**：`raw_json` 帶有 `snapshot.element`（47 個 element）與 `differential.element`（35 個）。Binding（`element.binding.strength` + `valueSet`）、slicing（`element.slicing.discriminator/rules`）與 choice type（`Condition.onset[x]` → `[dateTime, Age, Period, Range, string]`）全都在該 snapshot 內。→ **工具 7–13 的資料完全齊備。**
- **ValueSet** 以 artifact 形式儲存 → `raw_json.compose`。→ 工具 14 齊備；15/16/17 為部分（見 §3）。
- **98 個 example** 也以 artifact 形式儲存（其 `resource_type` 是實例型別，例如 `AllergyIntolerance`、`Bundle`、`Condition`；並帶有 `meta.profile`）。→ **工具 12 可透過比對 `raw_json.meta.profile` 支援。**
- **ImplementationGuide**、**CapabilityStatement**、**SearchParameter**、**OperationDefinition**、**ConceptMap（×6）**——全部以 artifact 存在且具完整 raw_json。
- `artifact_id|canonical_url|name|title|...` 上已建立 FTS GIN 索引。

### 1.2 `twcore.codesystems` + `twcore.concepts` —— 已解析的術語
```
twcore.codesystems(cs_id PK, name, category, fetched_at, concept_count)
twcore.concepts(id, cs_id FK, code, display, definition)   -- code+display 上有 GIN FTS
```
已為 IG 定義的 CodeSystem 填入資料（例如 `category-code-tw`、健保／SNOMED-TW 系統）。→ 工具 16（lookup）、以及 14/15 對 IG 內部系統的內嵌展開均有支援。

### 1.3 已上線的服務方法（`src/twcore_service.py`）
`list_codesystems`、`search_code`、`lookup_code`、`search_artifacts`、`get_artifact(include_raw)`。這些已涵蓋工具 3、4、14、16 的**底層基礎**，以及工具 7 探索面向的一半。

### 1.4 我們在別處持有的跨領域術語（影響展開／查詢）
獨立的 `snomed.*`、`loinc.*`、`icd.*` schema 存有完整的 SNOMED CT / LOINC / ICD 內容。由於許多 TWCore ValueSet 是對 SNOMED 做 filter，**我們能做的本地展開比「只看 IG」的直覺判斷更多**——前提是把 ValueSet filter 執行器接到那些 schema。

---

## 2. 逐工具就緒度矩陣（25 個工具）

圖例：✅ 資料完全齊備（只需服務程式碼）· 🟡 部分／需衍生邏輯或選用相依套件 · 🔴 需要新的儲存或外部引擎（資料不在 IG 內）。

### A. IG 探索
| # | 工具 | 狀態 | 資料來源／缺口 |
|---|---|---|---|
| 1 | `fhir_list_igs` | 🟡 | 身分資訊（packageId/version/canonical/fhirVersion）存在於 `package.json` 與 ImplementationGuide 的 raw_json，但目前**沒有 IG 註冊表**，也還沒有 package 欄位。需要 `fhir.ig_packages`（§4）。 |
| 2 | `fhir_get_ig` | 🟡 | `dependencies` 與 `fhirVersion` 取自 ImplementationGuide raw_json；`artifactCounts` = `GROUP BY resource_type`。需要註冊表。 |
| 3 | `fhir_list_artifacts` | ✅ | 直接查 `twcore.artifacts`。大致等同既有的 `search_artifacts(list mode)`。 |
| 4 | `fhir_search_artifacts` | ✅ | 既有的 `search_artifacts` + FTS 索引。 |

### B. 剖面選擇
| # | 工具 | 狀態 | 資料來源／缺口 |
|---|---|---|---|
| 5 | `fhir_list_resource_profiles` | ✅ | `WHERE resource_type='StructureDefinition' AND kind='resource' AND derivation='constraint'`，再依 `base_type` 分組。所有欄位皆已存在。 |
| 6 | `fhir_rank_resource_profiles` | 🟡 | 新的評分邏輯：把輸入的 keys 與剖面 element path（自 snapshot 解析）比對。不需外部資料，純衍生。必須回傳候選 + `selectionRequired:true`，絕不自動對應。 |
| 7 | `fhir_get_profile` | ✅ | artifact 欄位 + `raw_json.meta`。 |

### C. StructureDefinition —— **合併為單一工具，以 `view` 參數切換**（皆解析 `raw_json.snapshot.element`，資料 100% 齊備）
**已決定：** 規格中的工具 8–13（六個 snapshot 讀取器，含 D 組的 `get_element_binding`）合併為單一的 `fhir_get_profile_elements(profile, view, path?)`。這確立了**工具集全域的粒度規則：同一份底層資料的多種讀取視圖，一律收斂到 `view`/`mode` 參數之後**，以維持 `tools/list` 精簡（它是疊加在既有 29 個工具之上的）。每個規格工具成為一個 `view` 值：

| `view` | 取代規格工具 | 回傳 |
|---|---|---|
| `elements`（預設） | 8 `get_profile_elements` | 完整且對 LLM 友善的 element 投影（min/max/types/mustSupport/binding/fixed/pattern/constraints） |
| `element` | 9 `get_element` | 依 `path`（+ `sliceName`）取單一 element |
| `slices` | 10 `get_element_slices` | `element.slicing` + slice 子元素（已驗證，例如 `Condition.code.extension`） |
| `choices` | 11 `get_choice_types` | `[x]` element 型別 + `jsonProperty` + 輸入型別建議（已驗證 `Condition.onset[x]`） |
| `binding` | 13 `get_element_binding` | `element.binding` 的 strength 與 valueSet |
| `examples` | 12 `get_profile_examples` | `raw_json.meta.profile` 含該 canonical 的 example artifact |

`element`/`slices`/`choices`/`binding` 需帶 `path`；`elements`/`examples` 則省略。全部 ✅——資料完全齊備。

### D. 術語
| # | 工具 | 狀態 | 資料來源／缺口 |
|---|---|---|---|
| 13 | ~~`fhir_get_element_binding`~~ → `view:"binding"` | ✅ | 已併入合併後的 `fhir_get_profile_elements`（C 組）。 |
| 14 | `fhir_get_valueset` | ✅ | ValueSet artifact 的 `raw_json.compose`。 |
| 15 | `fhir_expand_valueset` | 🟡 | 內嵌 `compose.include.concept` → ✅。SNOMED `filter`（is-a 等）→ 以新的 filter 邏輯對 `snomed.*` 執行。HL7 THO／外部 → 僅在相依套件已匯入時可行（選用的 source role `twcore_tho`、`twcore_fhir_core` 已存在），否則回傳 `TERMINOLOGY_SERVER_REQUIRED`。 |
| 16 | `fhir_lookup_code` | 🟡 | IG 系統 → `twcore.concepts`；SNOMED/LOINC/ICD → 跨 schema 查詢；真正外部者 → `found:null` + 警告（**絕不可**編造 display）。 |
| 17 | `fhir_validate_code` | 🟡 | 成員檢查 = 先展開再判斷包含；覆蓋範圍同 #15。 |
| 18 | `fhir_normalize_code` | 🟡 | 我們有 embedding（語意比對）+ `twcore.concepts`（別名／display）+ 6 個 ConceptMap。需新的推薦邏輯；輸出必須由 #17 再次驗證。 |

### E. 對應 —— **重新設計：schema-guided fill（無儲存式樣板）**
規格中的 19–21 **移除**，改為兩個無樣板的工具（§3 缺口 2）。LLM 負責語意對應，系統負責機制釘定與驗證。

| # | 工具 | 狀態 | 資料來源／缺口 |
|---|---|---|---|
| ~~19~~ | ~~`fhir_get_mapping_template`~~ | ❌ 移除 | 儲存式樣板概念捨棄（前 LLM 時代產物）。 |
| ~~20~~ | ~~`fhir_plan_mapping`~~ | ❌ 移除 | 由骨架 + 驗證器迴圈取代。 |
| ~~21~~ | ~~`fhir_apply_mapping`~~ | ❌ 移除 | 由 `fhir_finalize_resource` 取代。 |
| 19′ | `fhir_get_resource_skeleton` | ✅ | 自 `snapshot.element` 即時投影出的空白、帶註解填寫表單（path、cardinality、type、choice[x] 屬性、required binding 的 ValueSet **與候選碼**、標為 auto-pinned 的 fixed/pattern、slicing、mustSupport、short，並附官方 example 作為 few-shot）。資料 100% 齊備。 |
| 20′ | `fhir_finalize_resource` | 🟡 | 對 LLM 填好的 draft 執行決定性步驟：釘住 `fixed`/`pattern`/`meta.profile`、附上已驗證碼的 `system` URL、解析參照（#22）、執行內建驗證器（#24），回傳 `{resource, validation, trace}`。純邏輯，無儲存式對應。 |

### F. 參照 / Bundle
| # | 工具 | 狀態 | 資料來源／缺口 |
|---|---|---|---|
| 22 | `fhir_resolve_reference` | 🟡 | 純邏輯，但需要一個暫時性的**參照脈絡儲存**（以建置工作階段為單位，用 `referenceContextId` 索引）。不需 IG 資料。 |
| 23 | `fhir_build_bundle` | 🟡 | 純邏輯（urn:uuid 改寫、參照對照表）。IG 內已有 Bundle 剖面可供後續驗證。資料面 ✅。 |

### G. 驗證
| # | 工具 | 狀態 | 資料來源／缺口 |
|---|---|---|---|
| 24 | `fhir_validate_resource` | 🟡 | **以 Python 在行程內建置**（§3 缺口 2）：結構（cardinality/required/type/fixed/pattern）+ binding 成員檢查 + 透過 `fhirpathpy` 的 FHIRPath 不變式 + 常見 slicing。無 Java、無 sidecar。所有輸入皆在 `raw_json`。定位為預檢；下游 FHIR 伺服器仍是權威驗證者。 |
| 25 | `fhir_validate_bundle` | 🟡 | 逐 entry = #24；內部參照完整性 = 本地邏輯。使用同一個行程內驗證器。 |

**統計（依規格能力計，對應重新設計後為 24 項）：** ✅ 12 · 🟡 12 · 🔴 0。舊的 🔴 對應三工具已消失；`fhir_get_resource_skeleton`（✅）與 `fhir_finalize_resource`（🟡）在不需任何新來源資料的前提下取代了它們。驗證器（24、25）為 🟡 行程內 Python；術語展開（15–18）為 🟡 廣度部分覆蓋——沒有任何一項被卡住，也沒有任何一項需要外部服務。

**合併後實際註冊的 `fhir_*` 工具約 19 個**（C 組的六個 snapshot 讀取器收斂為一個帶 `view` 參數的工具，見 §C）。分佈：A 4 · B 3 · C 1 · D 5 · E 2 · F 2 · G 2。新增一個 IG 套件**不會**增加任何工具。

---

## 3. 缺口與選項

### 缺口 1 —— 內建驗證器（工具 24–25）：行程內 Python，**不需外部服務**
我們以 Python 原生撰寫驗證器並在 MCP 行程內執行。**沒有 Java sidecar、沒有 `validator_cli.jar`、沒有額外容器、沒有網路往返。**它需要的一切都已在 `twcore.artifacts.raw_json` 內（snapshot、`constraint.expression` 的 FHIRPath 字串、`slicing`，以及 extension 定義——extension 本身也是 StructureDefinition artifact）。

驗證器對解析後的 `snapshot.element` 單次走訪即完成四項檢查：

| 檢查 | 做法（全部在行程內） | 覆蓋率 |
|---|---|---|
| **結構** | 以 `snapshot.element` 對照實例走訪：required（`min≥1`）、cardinality（`max`）、type / `choice[x]` 解析、`fixed[x]` / `pattern[x]`、`maxLength` | ~100%——可攔下絕大多數撰寫錯誤 |
| **術語 binding** | 對 `required` 強度的 binding，透過 §3 缺口 3 的展開解析器檢查 coding 是否為成員 | 與展開能力同寬；無法解析的外部 VS → **警告，絕不誤判為錯誤** |
| **不變式（FHIRPath）** | 以 **`fhirpathpy`**（fhirpath.js 的純 Python 移植，是一個 `pip install`，**不是**服務）評估每個 `constraint.expression` | R4 不變式的 ~85–95%；需要術語伺服器的運算式（對外部 VS 的 `memberOf`）→ 警告 |
| **Slicing / 參照** | 解析 `value` / `pattern` discriminator 以將陣列項目指派到 slice，再逐一驗證；檢查 Bundle 內部 `reference` ↔ `fullUrl` 的完整性 | 常見情境完整覆蓋；罕見的 `type`/`profile` discriminator 延後 |

**為什麼行程內是正確選擇，而非妥協：**資源真正的目的地是一台運行中的 FHIR 伺服器（我們已有 `list_fhir_servers` / `crud_fhir_server`），而**那台伺服器才是權威驗證者**。我們的職責是快速、可解釋的**預檢**，在送出前攔下 80–95% 的錯誤。就這個目的而言，原生驗證器完全勝任——而且唯一會變動的只有 `requirements.txt`（一個純 Python 相依），`docker compose` 完全不動。

**誠實契約：**回應會標示 `source: "builtin"`。凡是無法在本地執行的檢查（例如外部 VS 無法展開、或不支援的 FHIRPath 函式），都會發出 `information`/`warning` issue 說明——**絕不可**靜默回傳 `valid:true`。規格中 `ok`（工具有執行）與 `valid`（資源符合）的區分予以保留。

*未採用：* Java HL7-Validator sidecar。它會增加一個容器、一個 JVM 與一次網路往返，換來的是在下游伺服器已具權威性的前提下我們並不需要的窮盡式邊界案例一致性。若未來出現需要離線官方級一致性的需求，可以在不改變任何工具契約的情況下，以設定開關的形式後補。

### 缺口 2 —— 對應的重新設計：schema-guided fill（取代工具 19–21，**無儲存式樣板**）
原規格儲存一套決定性的「來源→FHIR」規則集（`get_mapping_template` → `plan_mapping` → `apply_mapping`）。那是**前 LLM 時代的產物**：決定性規則庫（FHIR Mapping Language / StructureMap / 手寫 ETL）之所以存在，正是因為不具智慧的系統無法推斷來源欄位 `conditionCode` **意指** `Condition.code`。有 LLM 在迴圈中，語意對應就是 LLM 的工作。因此我們完全捨棄儲存式樣板，改以兩個無樣板的工具取代。

**分工——從樣板時代唯一存留下來的規則：**LLM 填**語意**空格，系統決定性地釘住**機制**欄位。**絕不可**要求 LLM 產生 `fixed`/`pattern` 值、`meta.profile`、code 的 `system` URL 或參照接線——那些容易產生幻覺，一律由程式釘定。

**1. `fhir_get_resource_skeleton(profile)` —— 帶註解的填寫表單（✅ 資料齊備）。** 自所選剖面的 `snapshot.element` 即時投影。對每個 LLM 可填／須填的 element 提供：path、cardinality（是否必填？是否陣列？）、type、要使用的 `choice[x]` JSON 屬性、required binding 的 ValueSet **與候選碼**（透過缺口 3 的展開）、`mustSupport`、簡短說明，以及任何**標為 auto-pinned（「由系統填寫，請勿碰」）**的 `fixed`/`pattern` 值。官方 IG example（工具 12）作為 few-shot 一併附上。這本質上就是工具 8–13 已在讀取的同一份 snapshot 資料的「生成導向視圖」。

**2. `fhir_finalize_resource(profile, draft, referenceContextId)` —— 決定性收尾（🟡 純邏輯）。** 接收 LLM 填好的 draft，然後：釘住 `fixed`/`pattern`、附上 `meta.profile`、填入已驗證碼的 `system` URL、解析參照（#22）、執行內建驗證器（上述 #1／工具 24–25），並回傳 `{resource, validation, trace}`。驗證失敗時，issue 回饋給 LLM 修正，再重新 finalize。沒有儲存式對應、沒有 `fhir.mapping_*` schema、**沒有管理後台編輯介面**。

**工作流程：**
```
list/rank profiles (5,6) → LLM picks profile
  → get_resource_skeleton → LLM fills semantic blanks
     (using terminology tools 13–18 to choose/validate codes)
  → finalize_resource → system pins fixed/pattern/meta.profile, resolves refs, validates
  → on failure: feed validator issues back → LLM fixes → re-finalize
  → build_bundle (23) + validate_bundle (25)
```

**團隊有意識接受的取捨：**儲存式樣板是決定性的（相同輸入 → 相同輸出、編譯一次、每筆零推論成本），適合無人值守的百萬列登錄載入。LLM 填值則是隨機性的（模糊詞彙在不同執行間可能解析到不同的碼），且每筆需要一次推論——這對**互動式／人在迴圈中／中小量**（也就是本 MCP 的實際用途）最理想。機制釘定步驟加上驗證器把關，可回收大部分治理與可重現性保證；殘餘的選碼非決定性則以低 temperature 加驗證器加以控制。若未來出現無人值守批次的需求，可以在**不改變這些工具契約**的前提下後補一條編譯式樣板路徑。

### 缺口 3 —— ValueSet 展開廣度（工具 15–17）
分層展開解析器：

1. 內嵌 `compose.include.concept` → 取自 raw_json（永遠可行）。
2. `compose.include.system` 指向本地持有的系統（`twcore.concepts`、`snomed`、`loinc`、`icd`）→ 在本地展開／查詢，**包含**對 `snomed.*` 執行簡單 `filter`（`is-a`、`=`）。
3. 相依套件的系統（HL7 THO、base FHIR）→ 若該套件已匯入則可展開（`twcore_tho` / `twcore_fhir_core` 這兩個 source role 已會餵進 `twcore.artifacts`/`concepts`）。
4. 其餘 → `TERMINOLOGY_SERVER_REQUIRED`（或委派給已設定的外部 TS）。規格的回應格式已可容納此情況。

---

## 4. 多 IG 架構（從第一天就納入設計）

**目前的資料模型假設只有單一 IG。**需要移除的具體單一 IG 耦合：

- Schema 名稱直接叫 `twcore`；`artifact_key = "{resourceType}/{id}"` 與 `cs_id` **不是 package-scoped** → 兩個 IG 若都定義 `StructureDefinition/Patient` 或同 id 的 CodeSystem 就會**衝突**。
- 沒有已安裝套件的註冊表；`list_codesystems` 退回寫死的登錄表。
- Canonical URL 解析隱含地假設「在唯一那個 IG 之內」。

### 4.1 一般化 schema（邏輯上把 `twcore` 更名為 `fhir`）
引入套件註冊表，並為每一列 artifact／術語加上套件身分：
```
fhir.ig_packages(
  package_id, version,            -- PK (package_id, version)
  canonical, fhir_version, title, status,
  is_default BOOL, dependencies JSONB,   -- [{packageId, version}]
  imported_at)

fhir.artifacts(
  package_id, package_version,    -- ← 新增，屬於 PK 的一部分
  artifact_key, ... raw_json,     -- PK (package_id, package_version, artifact_key)
  ...)
fhir.codesystems(package_id, package_version, cs_id, ...)   -- PK (..., cs_id)
fhir.concepts(package_id, package_version, cs_id, code, ...)
```
遷移路徑：暫時保留 `twcore.*` 作為實體位置並加上套件欄位（預設 `tw.gov.mohw.twcore` / `1.0.0`），或者引入 `fhir.*` 並讓匯入流程寫入 package-scoped 的列。使用者已表明**會重新匯入**，因此相較於原地遷移，採用帶套件鍵的全新 `fhir.*` schema 更佳；`db/schema.sql` 為權威來源，不需遷移檔（沿用專案既有慣例）。

### 4.2 IG 選擇器（每個工具）
所有 IG-scoped 工具都接受：
```json
{ "ig": { "packageId": "tw.gov.mohw.twcore", "version": "1.0.0" } }
```
- `version` 為選填 → 解析為 `fhir.ig_packages` 中標記 `is_default`（或最高 semver）的套件。
- 拒絕模稜兩可的裸字串 `"twcore"`；必須提供真正的 `packageId`。
- 每個回應的 provenance 區塊都回報解析後的 `packageId/version/fhirVersion`，讓呼叫端能在 IG 升級後偵測到漂移。

### 4.3 跨相依的 canonical 解析器
TW Core 的剖面會參照 base FHIR R4 的 element 與 HL7 THO 的 ValueSet。解析器在收到 canonical URL 與來源套件後，依序搜尋：**(a)** 目標套件，接著 **(b)** 它在 `fhir.ig_packages` 中的 `dependencies`（遞移）。這是目前選用式 `twcore_tho` / `twcore_fhir_core` 側載機制的一般化版本。若無法解析 → 明確回傳 `ARTIFACT_NOT_FOUND` / `VALUESET_NOT_FOUND`，絕不用猜的。

### 4.4 MCP 工具形態
- 一套以 `ig` 參數化的通用工具集（`fhir_*`），**而非**每個 IG 一套工具。新增 IG = 匯入一個套件；不需要新工具。
- **粒度規則（已決定）：**同一份底層資料的多種讀取視圖收斂到 `view`/`mode` 參數之後，而非拆成多個工具——以在既有 29 個工具之上維持 `tools/list` 精簡。首次套用：C 組的六個 snapshot 讀取器 → 單一 `fhir_get_profile_elements(profile, view, path?)`。結果約為 19 個註冊的 `fhir_*` 工具。
- 沿用既有的共同信封（`{ok,data,warnings,provenance}`）與規格中的錯誤碼列舉。
- 註冊於新的 `_TOOL_GROUPS["fhir_ig"]` 群組；以 `fhir.ig_packages` 非空作為可見性閘門（與 `ModuleStatusManager` 的動態顯示／隱藏一致）。

---

## 5. 分階段路線圖（資料優先、風險最低者優先）

**Phase 0 —— 多 IG 基礎（讓其餘一切成為可能）。** `fhir.ig_packages` 註冊表 + artifacts/codesystems/concepts 的套件欄位；更新匯入流程以寫入 package-scoped 的列並註冊套件；IG 選擇器與 canonical 解析器輔助函式。工具 1、2 順帶完成。

**Phase 1 —— 探索與 StructureDefinition（資料全部 ✅）。** 工具 3–13：由 `artifacts` 加上一個 `snapshot.element` 投影器提供服務。價值最高、零新資料、無外部相依。這是「LLM 能探索任何已匯入 IG 並讀取每個剖面／element／binding」的里程碑。

**Phase 2 —— 術語（🟡）。** 工具 14–18：分層展開解析器（§3 缺口 3）、跨本地 schema 查詢、以 embedding 與 ConceptMap 做 normalize。先出內嵌 + 本地；THO／外部藏在解析器分層之後。

**Phase 3 —— 參照/Bundle（🟡，純邏輯）。** 工具 22、23 加上暫時性參照脈絡儲存。與對應無關；可與 Phase 1/2 並行落地。

**Phase 4 —— 驗證（🟡，行程內 Python）。** 工具 24/25：內建驗證器（§3 缺口 2）——結構 + binding + FHIRPath 不變式（`fhirpathpy`）+ 常見 slicing，全部在行程內。唯一新增相依是一個純 Python pip 套件；容器與基礎設施皆不變。

**Phase 5 —— Schema-guided fill（🟡，無儲存式樣板）。** `fhir_get_resource_skeleton`（Phase 1 snapshot 讀取器的生成導向投影 + 缺口 3 的候選碼 + 工具 12 的 example）與 `fhir_finalize_resource`（決定性釘定 + 參照解析 + 驗證）。**沒有 `fhir.mapping_*` schema、沒有管理後台編輯介面。**它排在最後，只是因為它組合了前面所有階段——Phase 1（element/骨架）、2（選碼／驗碼）、3（參照解析）、4（驗證輸出）——而不是因為它需要新資料。

---

## 6. 待決事項（動工前需要使用者裁示）

1. **Schema 策略：**採用全新的 package-scoped `fhir.*` schema（考量既定的重新匯入，較佳），還是在既有 `twcore.*` 上加套件欄位？
2. **驗證器範圍（已決定 → 行程內 Python，無 sidecar）：**出貨完整的內建驗證器（結構 + binding + 透過 `fhirpathpy` 的 FHIRPath 不變式 + 常見 slicing）。剩下的子選項：第一版是否納入 `value`/`pattern` 的 slicing discriminator，還是把所有 slicing 延到後續？
3. **對應（已決定 → 無儲存式樣板）：**移除 `get_mapping_template`/`plan_mapping`/`apply_mapping`，改採 schema-guided fill（`fhir_get_resource_skeleton` + `fhir_finalize_resource`）。沒有對應 schema、沒有編輯介面。**已決定：**`finalize_resource` **不**自動迴圈——它驗證後回傳 `{resource, validation issues}`；由 LLM 修正 draft 再重新呼叫。工具只負責驗證／釘定，語意修正歸 LLM。
4. **工具粒度（已決定 → 合併）：**StructureDefinition 讀取器（8–13）收斂為單一 `fhir_get_profile_elements(profile, view, path?)`；`view`/`mode` 參數規則成為工具集全域風格。結果約 19 個註冊的 `fhir_*` 工具。（可選後續：術語 D 組未來也能同樣收斂，但目前保持分立，因為每個動詞在語意上各自獨立。）

---

## 7. 結論

- **資料：**規格的 ~70% 已經躺在 `twcore.artifacts.raw_json` 與 `twcore.concepts` 裡；`package.tgz` 確認 StructureDefinition／術語／剖面／example 類工具所需資料無一缺漏。這些**不需要**重新抓取 IG。
- **真正要新建的：**(1) 多 IG 套件註冊表 + package-scoped 鍵，(2) 以 **schema-guided fill**（`fhir_get_resource_skeleton` + `fhir_finalize_resource`）取代儲存式對應樣板——沒有對應 schema、沒有編輯介面，(3) 一個**行程內 Python 驗證器**（結構 + binding + 透過 `fhirpathpy` 的 FHIRPath + value/pattern slicing——**無外部服務**），(4) 外部系統的 ValueSet 展開廣度。
- **無外部服務、無儲存式對應：**唯一新增的執行期相依是一個純 Python pip 套件（`fhirpathpy`）。`docker compose` 完全不動；LLM 對著即時產生的帶註解骨架做語意欄位對應，系統釘住機制欄位，驗證器把關輸出；下游 FHIR 伺服器仍是權威驗證者，我們的是預檢。
- **設計規則得以維持：**一套以 `{packageId, version}` 參數化的通用 `fhir_*` 工具集，搭配具相依感知的 canonical 解析器——因此匯入下一個 IG 套件不會增加任何工具。
