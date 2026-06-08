# FHIR Bundle 轉換提示詞(多資源、互相引用、依賴序組 Bundle)

這份提示詞示範如何讓語言模型透過本專案的 `fhir_*` MCP 工具(Taiwan Health MCP 的
FHIR-IG toolset),把**一整包扁平 JSON**(多個 list、每個 list 是一種資源、彼此用
外鍵互相引用)逐步轉成「合規且完整」的 TW Core FHIR **Bundle**。

與[單一資源版](fhir-patient-conversion-prompt.md)的差異:
- 一次有**很多**資源、**多種**型別,而且**互相引用**。
- 轉換順序「**被引用者優先**」:先處理不主動引用別人的資源(如 Organization),
  再處理引用它們的資源,最後才是引用最多的(如 Observation / Encounter)。
- 收尾用 `fhir_build_bundle` + `fhir_validate_bundle` 組成並驗證整包 Bundle。

> **前置條件**:LLM 連的是本專案的 `fhir_*` 工具(FHIR-IG toolset)。需先部署:
> 重建 `fhir.*` schema、匯入 TW Core IG、`pip install fhirpathpy`,並重啟 app + admin-worker。

---

## 提示詞(可直接複製)

````markdown
你是一位 FHIR 資料轉換助理,可以使用一套 `fhir_*` MCP 工具(Taiwan Health MCP 的 FHIR-IG toolset)。
你的任務:把下面這一整包扁平 JSON(多個資源、彼此互相引用)轉換成一個「合規且完整」的 TW Core FHIR **Bundle**(type 用 `collection`)。

**重要:沒有任何欄位會直接告訴你某筆資料是哪個 `resourceType`,也沒有現成的 urn。資源型別、Profile、跨資源參照,都由你自己觀察欄位、用工具查證後決定。**

# 待轉換的來源資料
```json
{
  "patients": [
    { "id": "1", "idSystem": "https://www.tph.mohw.gov.tw", "idNumber": "H225602126", "active": true, "name": "陳佳豪", "telecomSystem": "phone", "telecomUse": "mobile", "telecomValue": "0989174087", "gender": "female", "birthDate": "1956-03-11", "address": "桃園市桃園區復興路102巷32弄41號", "organization": "1" }
  ],
  "organizations": [
    { "id": "1", "identifierValue": "0132010014", "idSystem": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/organization-identifier-tw", "active": true, "type": "prov", "name": "臺北市立聯合醫院", "telecomSystem": "phone", "telecomUse": "work", "telecomValue": "02-2555-3000", "address": "臺北市信義區莊敬路270號" }
  ],
  "encounters": [
    { "id": "1", "idSystem": "https://www.tph.mohw.gov.tw/fhir/encounter", "status": "finished", "class": "EMER", "type": "EMER", "reasonCode": "Cond-0019", "serviceType": "emergency", "serviceTypeText": "急診", "patientId": "1", "periodStart": "2026-06-01T08:22:15.238Z", "periodEnd": "2026-06-01T08:47:15.238Z", "serviceProviderId": "1", "participantType": "ATND", "practitionerId": "1", "conditionId": "1", "diagnosisUse": "AD", "admitSource": "emd" }
  ],
  "practitionerroles": [
    { "id": "1", "identifierValue": "KP00018", "idSystem": "https://www.tph.mohw.gov.tw", "active": true, "practitionerId": "1", "organizationId": "1", "roleCode": "PR-0008", "roleText": "急診醫師", "specialtyCode": "Spec-0004", "periodStart": "2024-01-01T08:00:00+08:00", "periodEnd": "2026-12-31T17:00:00+08:00", "telecomSystem": "phone", "telecomUse": "work", "telecomValue": "02-2312-3456" }
  ],
  "practitioners": [
    { "id": "1", "medicalLicenseNumber": "醫字第045678號", "medicalLicenseSystem": "https://www.tph.mohw.gov.tw/fhir/practitioner-license", "active": true, "name": "陳冠辰", "telecomSystem": "phone", "telecomUse": "work", "telecomValue": "0907960949", "address": "新北市板橋區民生路3段276號7樓", "gender": "male", "birthday": "1966-02-17", "qualificationCode": "Qual-0001", "qualificationIssuer": "1" }
  ],
  "conditions": [
    { "id": "1", "clinicalStatus": "active", "verificationStatus": "confirmed", "category": "encounter-diagnosis", "severity": "24484000", "conditionCode": "Cond-0023", "conditionText": "突發胸痛", "patientId": "1", "onsetDate": "2026-06-01T08:22:15.238Z", "asserterId": "1", "recorderId": "1", "note": "突發胸痛，伴隨冒冷汗。" }
  ],
  "observationVitalSigns": [
    { "id": "1", "status": "final", "categoryCode": "vital-signs", "observationCode": "VS-0006", "patientId": "1", "encounterId": "1", "effectiveDate": "2026-06-01T08:22:15.238Z", "performerId": "1", "valueQuantity": 92, "valueUnit": "/min", "rangeLow": 60, "rangeHigh": 100 },
    { "id": "2", "status": "final", "categoryCode": "vital-signs", "observationCode": "VS-0012", "patientId": "1", "encounterId": "1", "effectiveDate": "2026-06-01T08:22:15.238Z", "performerId": "1", "valueQuantity": 94, "valueUnit": "%", "rangeLow": 95, "rangeHigh": 100 }
  ]
}
```

# 核心原則(務必遵守)
1. **不要預設資源型別**:每一筆的 `resourceType` 由你從欄位推斷,再用工具確認 IG 裡有對應 Profile。
2. **分工**:你只填「語意值」。所有「機械欄位」——`meta.profile`、`fixed`/`pattern`、code 的 `system` URL、reference 的 urn——一律交給 `fhir_finalize_resource` 釘,**不要自己編造**。
3. **參照的型別靠語意,不是靠 id**:同一個 id 在不同欄位可能指向不同型別的資源(例如某個 `asserterId` 指向病人、`recorderId` 指向醫事人員,值卻一樣)。每個外鍵指向哪個型別,由「它要填進去的 FHIR element 的語意」決定;模糊時**明說你的假設**。
4. **來源的內部代碼不是 FHIR 代碼**:像 `Cond-0023`、`VS-0006`、`PR-0008`、`Spec-0004`、`Qual-0001`、`serviceType:"emergency"` 這類不透明碼,要用**伴隨的人類文字**(`conditionText`、`serviceTypeText`、`roleText`…)去 `fhir_normalize_code` 找真正的 SNOMED/LOINC/HL7 代碼,再 `fhir_validate_code` 確認。**若只有不透明碼、沒有文字也查不到對照** → 據實回報 `unverifiable`,不要硬編一個碼。
5. **不可幻覺**:任何 canonical URL、system URL、代碼 display 都從工具查;查不到就回報。
6. **誠實**:工具回 `unverifiable`/`warning`/`found:false` 時據實處理,不要當成通過。
7. 每一步先說明「你要做什麼、為什麼」,再呼叫工具,並摘要工具回傳的關鍵內容。

---

# 階段一 — 盤點、解析參照、排序、預鑄 urn

**Step 0 — 確認 IG**
- 呼叫 `fhir_list_igs`,確認預設 IG 是 TW Core(`tw.gov.mohw.twcore`)。之後不必每次帶 package_id。

**Step 1 — 盤點所有資源,給每筆一個穩定 key**
- 走訪每個頂層 list,**每個元素 = 一筆資源**。
- 為每筆指定一個跨整包唯一、且編碼了型別的 key:`<type>-<本地id>`,例如 `org-1`、`practitioner-1`、`patient-1`、`practitionerrole-1`、`condition-1`、`encounter-1`、`observation-1`、`observation-2`。
- 列一張表:`key | 來源 list | 你初步判斷的 resourceType`。型別最終仍要在階段二用工具確認。

**Step 2 — 解析每筆的跨資源參照(外鍵 → (型別, key))**
- 逐筆找出所有「指向別筆資源」的欄位,解析成目標 `(resourceType, key)`。本例的對照(你要自己推導、並用 FHIR 語意驗證):
  - patients.`organization` → Organization(`managingOrganization`)
  - practitioners.`qualificationIssuer` → Organization(`qualification.issuer`)
  - practitionerroles.`practitionerId` → Practitioner、`organizationId` → Organization
  - conditions.`patientId` → Patient(`subject`)、`recorderId` → Practitioner(`recorder`)、`asserterId` → **依語意判斷**(本例輸出視為病人本人 → Patient)。**這裡 `recorderId` 與 `asserterId` 值相同但型別不同,務必分清楚。**
  - encounters.`patientId` → Patient(`subject`)、`practitionerId` → Practitioner(`participant.individual`)、`conditionId` → Condition(`diagnosis.condition`)、`serviceProviderId` → Organization(`serviceProvider`)
  - observationVitalSigns.`patientId` → Patient(`subject`)、`encounterId` → Encounter(`encounter`)、`performerId` → **依語意判斷**(本例為醫事人員 → Practitioner)
- 任何你無法明確判定型別的外鍵,**標記出來並說明你採用的假設**,不要默默猜。

**Step 3 — 建依賴圖,拓樸排序(被引用者優先)**
- 用 Step 2 的結果畫出「誰引用誰」。轉換順序從**不主動引用任何人的資源**開始,逐層往上。本例典型順序:
  `Organization → Practitioner → Patient → PractitionerRole → Condition → Encounter → Observation(VS-0006) → Observation(VS-0012)`。
- 若偵測到環(A 引 B、B 又引 A),不要卡住——下一步的「預鑄 urn」就是為了打破環,届時順序只影響可讀性,不影響正確性。

**Step 4 — 在同一個 build context 內,為每個 key 預鑄 urn**
- 對**第一個** key 呼叫 `fhir_resolve_reference(key="org-1", resource_type="Organization")`(不帶 context_id)→ 記下回傳的 `contextId`,之後每次都帶它。
- 對**其餘每一個** key 都呼叫一次 `fhir_resolve_reference(key=<該key>, resource_type=<型別>, context_id=<contextId>)`,各自取得穩定 urn。
- 現在每筆資源在被建立前就已有 urn,**前向引用與環都不成問題**。階段二填參照時一律寫 `"<Type>/<key>"`(例如 `"Patient/patient-1"`),finalize 會依 context 改寫成 urn。

---

# 階段二 — 逐一轉換(照 Step 3 的順序,一次一筆)

對排序後的每一筆資源,重複以下 a–e。**效率提示**:同一個 Profile 的 skeleton 只需取一次,之後同型別的多筆共用。

- **a. 選 Profile**:對該筆,呼叫 `fhir_rank_resource_profiles(keys=[<該筆的欄位名>])`(不帶 base_type),必要時搭配 `fhir_list_resource_profiles()`,選定一個具體 Profile,並說明理由。
  - **Observation 要逐筆選**:不同 `observationCode` 對到不同 Profile(例如心率 → `Observation-heart-rate-twcore`、血氧 → `Observation-pulse-oximetry-twcore`)。用該筆的代碼/文字判斷,別全部套同一個。
- **b. 取 skeleton**:`fhir_get_resource_skeleton(profile=<選定Profile>)`。讀 required / 陣列 / slicing / 各欄位 binding(含 candidateCodes)/ `autoPinned`(不要碰)。
- **c. 填語意值**:對照該筆來源。
  - 參照欄位填 `"<Type>/<key>"`(例:`subject` 填 `"Patient/patient-1"`、`encounter` 填 `"Encounter/encounter-1"`)。
  - 需要編碼的欄位走 `fhir_normalize_code`(用人類文字)→ `fhir_validate_code`;不透明內部碼依核心原則 4 處理。
  - `identifier` 的 system/type、code 的 system 等機械欄位**留給 finalize**(skeleton 標 `autoPinned` 者一律不填)。
  - 量值單位(如 `/min`、`%`)填進 `valueQuantity`,UCUM 的 `system`/`code` 若 skeleton 要求就用工具確認。
- **d. Finalize**:`fhir_finalize_resource(profile=<選定Profile>, draft=<你的draft>, context_id=<contextId>, key=<該筆的key>)`。
  - `valid: true` → 收下回傳的 `resource`(連同 key 暫存到一份清單)。
  - `valid: false` → **只**針對 `issues` 修正(用 `fhir_get_profile_elements(view="binding")` / `fhir_expand_valueset` 查允許值,用 normalize→validate 查碼),再次 finalize,直到 `valid: true`。
- **e.** 繼續下一筆,直到所有資源都 finalize 成功。

---

# 階段三 — 組 Bundle + 驗證 + 交付

**Step 5 — 組裝**
- 把階段二蒐集到的每筆 `resource` 連同其 key 組成 entries,呼叫:
  `fhir_build_bundle(entries=[{"resource": <資源>, "key": "<key>"}, …], bundle_type="collection", context_id=<contextId>)`
- 讀回傳的 `unresolved`:**必須是空的**。若有未解析的參照,代表某個 `"<Type>/<key>"` 沒對到任何 entry → 回去修(通常是 key 拼錯或漏轉某筆),再重組。

**Step 6 — 驗證整包**
- `fhir_validate_bundle(bundle=<上一步的bundle>)`。讀每個 entry 的 `valid` 與 `referenceIssues`。
  - 全 valid 且無 referenceIssues → 完成。
  - 否則只修有問題的那幾筆(回階段二對該筆 finalize),再重新 build + validate。

**Step 7 — 交付**
- 輸出最終 `valid` 的 Bundle JSON(`fhir_build_bundle` 回傳、且通過 `fhir_validate_bundle` 的那個)。
- 附一段對照說明:每筆資源的 `key → urn`、跨資源參照如何串(哪個欄位指向哪個 key)、哪些代碼是你查出來的(及來源 ValueSet)、哪些是 finalize 釘的機械欄位、以及任何你標為 `unverifiable` / 採用假設之處。

開始吧,從 Step 0。
````

---

## 設計重點

- **「被引用者優先」+ 先預鑄 urn**:`fhir_resolve_reference` 用 `key` 鑄出穩定 urn,
  讓資源在建立前就能被引用。先一次性對所有 key 預鑄,再照拓樸序逐一轉換——
  這同時讓**前向引用**與**環狀引用**(FHIR 常見 Encounter↔Condition)都不會卡住,
  拓樸序此時只影響可讀性,不影響正確性。
- **參照的「型別」靠語意,不是靠 id**:扁平資料用 per-list 本地 id,同一個 id 值在
  不同欄位可能指向不同型別(例:`recorderId` → Practitioner、`asserterId` → Patient,
  值都是 `"1"`)。所以 key 一定要編碼型別(`patient-1` / `practitioner-1`),
  且每個外鍵的目標型別由「它要填進去的 element 語意」決定。
- **不透明內部碼 ≠ FHIR 碼**:`Cond-xxxx`/`VS-xxxx`/`PR-xxxx`/`Spec-xxxx`/`Qual-xxxx`
  要用伴隨的人類文字走 `normalize → validate` 翻成真碼;**只有碼沒有文字也查不到對照
  時,回報 `unverifiable` 而非硬編**——避免示範裡那種「無中生有一個 SNOMED 碼」的幻覺。
- **Profile 逐筆選(尤其 Observation)**:vital-signs 依量測項目分流到不同 Profile;
  同一 Profile 的 skeleton 可快取重用,降低大量資料時的工具呼叫量。
- **收尾用 `collection`**:`fhir_build_bundle(bundle_type="collection")` 不加
  `request`;`unresolved` 必須為空,再以 `fhir_validate_bundle` 檢查 entry 合規性與
  內部參照完整性。
