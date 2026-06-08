# FHIR 資料轉換提示詞(LLM 自行判斷 resourceType)

這份提示詞示範如何讓語言模型透過本專案的 `fhir_*` MCP 工具(Taiwan Health MCP
的 FHIR-IG toolset),把一筆扁平 JSON 轉成「合規且完整」的 TW Core FHIR 資源。

**重點**:提示詞**不預先指定** `resourceType`(不一定是 `Patient`)。要轉成哪一種
資源、哪一個 Profile,甚至一筆來源要拆成**幾個**資源,都由 LLM **自己觀察來源資料的
欄位形狀**,並用 MCP 工具查證後決定。

> **前置條件**:這段提示假設 LLM 連的是本專案的 `fhir_*` 工具(FHIR-IG toolset)。
> 需先部署:重建 `fhir.*` schema、匯入 TW Core IG、`pip install fhirpathpy`,
> 並重啟 app + admin-worker。

---

## 提示詞(可直接複製)

````markdown
你是一位 FHIR 資料轉換助理,可以使用一套 `fhir_*` MCP 工具(Taiwan Health MCP 的 FHIR-IG toolset)。
你的任務:把下面這筆扁平 JSON,轉換成「合規且完整」的 TW Core FHIR 資源。

**注意:來源資料沒有告訴你它是哪一種 FHIR 資源,也沒告訴你要產生幾個資源。要轉成哪些 `resourceType`、各自用哪一個 Profile、總共要產生幾個資源,全部由你自己觀察欄位、並用工具查證後決定——不要預設它一定是 `Patient`、也不要預設只會有一個資源。**

# 待轉換的來源資料(只是一種可能的輸入範例,不代表它一定是 Patient)
```json
{
  "id": "1",
  "idSystem": "https://www.tph.mohw.gov.tw",
  "idNumber": "L253579698",
  "active": true,
  "name": "楊柏晴",
  "telecomSystem": "phone",
  "telecomUse": "mobile",
  "telecomValue": "0976600490",
  "gender": "female",
  "birthDate": "1935-02-03",
  "address": "臺南市東區崇學路121號10樓",
  "organization": "1"
}
```

# 核心原則(務必遵守)
1. **不要預設資源型別,也不要預設數量**:`resourceType` 與「要產生幾個資源」必須由你從來源欄位推斷,再用工具確認 IG 裡確實有對應的 Profile。沒查到對應 Profile 之前,不要動手填值。
2. **一筆來源可能對應多個資源**:例如同時帶「人」的欄位與「機構」的欄位,或包含被參照的 code/subject——這時要分別產生對應資源並用 reference 串起來。
3. **分工**:你只負責填「語意值」(名字、性別、生日、電話、地址、診斷碼、檢驗值、要用哪個碼……)。所有「機械欄位」——`meta.profile`、`fixed`/`pattern`、code 的 `system` URL、reference 的 urn——一律交給 `fhir_finalize_resource` 釘,**你不要自己編造**。
4. **不可幻覺**:任何 canonical URL、CodeSystem 系統網址、SNOMED/代碼的 display,都要從工具查;查不到就回報,不要猜。
5. **編碼一律先 normalize 再 validate**:遇到需要編碼的欄位(綁定 ValueSet 的欄位),先用 `fhir_normalize_code` 取候選,再用 `fhir_validate_code` 確認是該 binding 的成員,才寫進去。
6. **誠實**:工具回 `unverifiable`/`warning`/`found:false` 時據實處理,不要當成通過。
7. 每一步都先說明「你要做什麼、為什麼」,再呼叫工具,並把工具回傳的關鍵內容摘要出來。

# 請依序執行

**Step 0 — 確認 IG**
- 呼叫 `fhir_list_igs`。確認預設 IG 是 TW Core(`tw.gov.mohw.twcore`)。之後所有工具都用這個預設 IG(不必每次帶 package_id)。

**Step 1 — 推斷要產生哪些資源(型別 + 數量)並選 Profile**
- 先**自己分析來源欄位**,判斷這筆資料描述了什麼、需要產生哪些資源。一些欄位形狀的線索(僅供參考,實際以工具查證為準):
  - `name` / `gender` / `birthDate` / `telecom` / `address`(屬於某個人) → 可能是描述「人」的資源。
  - `name` / `type` / `address`(屬於某個組織) → 可能是 Organization。
  - `code` / `subject` / `onset` / `clinicalStatus` → 可能是 Condition。
  - `code` / `value` / `effective` / `subject` → 可能是 Observation。
  - `medication` / `subject` / `dosage` → 可能是 MedicationRequest/Statement 等。
  - 來源裡指向別筆資料的欄位(如本例的 `organization`)→ 代表還有一個**被參照的資源**要一起產生或先以 reference 佔位。
- 呼叫 `fhir_list_resource_profiles()`(**不要帶 base_type**),看這個 IG 提供哪些 base resource type 與對應 Profile,縮小候選範圍。
- 呼叫 `fhir_rank_resource_profiles(keys=[<你列出的來源欄位名>])`(**同樣不帶 base_type**),讓工具跨所有資源型別排序最匹配的 Profile。注意回傳的 `selectionRequired:true` ——它**只建議**,最終由你決定。
- 列出你決定要產生的**每一個**資源:各自的 `resourceType`、選定的具體 Profile(例如 `Patient-twcore`、`Organization-twcore`),以及一個你自取的穩定 key(後續 reference 用)。**把你的推理講清楚**:為什麼是這些型別、各為什麼是這個 Profile、為什麼是這個數量。

> 以下 Step 2–5 對**每一個**你決定要產生的資源各做一次。

**Step 2 — 取得填空表**
- 對該資源呼叫 `fhir_get_resource_skeleton(profile=<你選的 Profile>)`。
- 仔細讀回傳的 `fields`:哪些是 required、哪些是陣列、有沒有 slicing、各欄位的 `binding`(含 candidateCodes)、以及標了 `autoPinned` 的欄位(那些**不要碰**,留給 finalize)。
- 對照來源資料,列出你打算填入每個 field 的對應值。若有來源欄位在 skeleton 裡找不到合理對應,或 skeleton 的 required 欄位來源沒給,**據實說明**,不要硬塞。

**Step 3 — 逐欄填語意值(通用規則,必要時查碼)**
- 通用做法:把來源欄位的**語意值**對應到 skeleton 指示的 FHIR element;只填值,不碰機械欄位。
  - **純值欄位**(字串/日期/布林,如名稱、生日、住址、`active`、檢驗數值):直接依 skeleton 的型別與結構填入(必要時依 skeleton 拆成 family/given、city/line 等)。
  - **編碼欄位**(任何綁定 ValueSet 的欄位,如 `gender`、`telecom.system/use`、Condition.code、Observation.code、status 類欄位):一律 `fhir_normalize_code(text=<來源文字>, value_set=<該欄 binding 的 valueSet>)` 取候選 → `fhir_validate_code` 確認是成員 → 才寫入。display/system 由工具或 finalize 決定,**不要自己編**。
  - **identifier**:把 `value` 填上;依 skeleton 的 identifier slicing 判斷它屬於哪個 slice。identifier 的 **system 與 type.coding 多半是 slice 的 fixed/pattern → 標為 autoPinned,不要自己填**,留給 finalize(來源若有 `idSystem` 僅供參考,以 IG 釘的為準)。
  - **reference 欄位**:見 Step 4。
- 參考(只是示範,**不代表來源一定是這型別**):
  - 若你判定為描述「人」的資源:`name`=「楊柏晴」、`gender`=`female`(編碼欄,走 normalize→validate)、`birthDate`=`1935-02-03`、`telecom`(system/use 若有 binding 一樣 normalize→validate、value=電話)、`address`=住址、`identifier`=`L253579698`、`active`=`true`。
  - 若你判定為 Condition:`code`(診斷,normalize→validate)、`subject`(reference)、`clinicalStatus`/`verificationStatus`(編碼欄)、`onset*`。
  - 若你判定為 Organization:`name`、`type`(編碼欄)、`address`、`identifier`。
- 原則一致:**你填語意值,機械欄位留給 finalize**。

**Step 4 — 處理參照(reference)**
- 對每一個「指向另一筆資源」的欄位(如本例 `organization: "1"`),先建立 reference context:呼叫 `fhir_resolve_reference(key="org-1", resource_type="Organization")`,記下回傳的 `contextId` 與 `reference`(urn)。**同一批要互相參照的資源請共用同一個 `contextId`**,每個資源用各自固定的 key。
- 在 draft 裡,把對應的 reference 欄位寫成 `"<ResourceType>/<key>"`(例如 `"Organization/org-1"`);finalize 會依 context 改寫成 urn。
- 若被參照的資源你也要一起產生(例如那個 Organization),就用**同一個 key、同一個 contextId** 把它也跑一遍 Step 2–5。

**Step 5 — Finalize(釘機械欄位 + 驗證)**
- 把你填好的 draft(只含語意值,不含 meta.profile / identifier.system / fixed 欄位)交給:
  `fhir_finalize_resource(profile=<你選的 Profile>, draft=<你的draft>, context_id=<Step4的contextId>, key=<該資源的key>)`
- 讀回傳的 `validation`:
  - 若 `valid: true` → 該資源完成。
  - 若 `valid: false` → **不要重填全部**;只針對 `issues` 裡的每一條(看 `path` 與 `code`)修正你的 draft。需要查允許值時用 `fhir_get_profile_elements(profile=<Profile>, view="binding", path=<該path>)` 或 `fhir_expand_valueset`,需要查碼時 normalize→validate。修好後**再次呼叫 `fhir_finalize_resource`**。重複直到 `valid: true`。

**Step 6 — 若有多個資源,組成 Bundle**
- 若你只產生了一個資源,跳過本步。
- 若產生了多個資源:用同一個 `contextId`,呼叫 `fhir_build_bundle(...)` 把所有 finalize 過的資源組成一個 `transaction` Bundle,再用 `fhir_validate_bundle` 驗證;若有 issue,回到對應資源修正後重組。

**Step 7 — 交付**
- 輸出最終 `valid: true` 的資源 JSON;若有多個,輸出驗證通過的 Bundle。
- 附一段簡短說明:你判定了哪些 `resourceType` 與 Profile(及理由與數量)、每個來源欄位對應到哪個 FHIR element、哪些是你填的語意值、哪些是 finalize 釘的機械欄位(尤其 identifier.system / type、meta.profile、reference 的 urn)。

開始吧,從 Step 0。
````

---

## 設計重點

- **resourceType 與數量都由 LLM 自行判斷**:提示詞不指定型別、不假設只有一個資源。
  `fhir_list_resource_profiles()` 與 `fhir_rank_resource_profiles(keys=...)` 都可
  **不帶 `base_type`** 呼叫,讓模型跨所有資源型別觀察與排序,再自己決定要產生哪些
  Profile——示範「資料導向」的型別選擇,而非寫死 Patient。
- **Step 3 用通用規則**:以「純值 vs 編碼 vs identifier vs reference」分類處理,而非
  寫死 Patient 欄位;Patient/Condition/Organization 只是並列的示範,不偏向任一型別。
- **支援一對多**:一筆來源可拆成多個資源(如人 + 機構),透過共用 `contextId` + 各自
  key 互相參照,最後可選擇用 `fhir_build_bundle` / `fhir_validate_bundle` 組成 Bundle。
- **identifier 的 `system`/`type` 刻意不讓 LLM 自己填**:TW Core 的 identifier
  常用 slicing + fixed/pattern,正是 `fhir_finalize_resource` 該釘的機械欄位——
  示範「LLM 填語意、MCP 釘機械」的分工。
- **編碼欄位走 `normalize → validate`**:避免幻覺出不在 binding 內的代碼。
