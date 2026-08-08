# 把你的資料轉成 FHIR —— 授權流程怎麼運作

> **狀態：**說明 FHIR-IG 授權工具集（`fhir_*` 工具）的**設計**。工程規格與設計決策見
> [`fhir-ig-mcp-toolset-assessment.md`](./fhir-ig-mcp-toolset-assessment.md)。
> 本頁是**面向使用者的操作導覽**。

這個 MCP 伺服器讓語言模型（LLM）把你的來源資料——結構化的院內紀錄，**或一段自由文字的臨床病歷**——轉成符合某個 Implementation Guide（IG，例如 TW Core、US Core、IPS）的有效 FHIR 資源。本頁用一個具體範例逐步說明整個過程。

---

## 唯一要記住的概念：誰負責什麼

這個轉換是一種分工，界線始終不變：

| | 職責 |
|---|---|
| **LLM** | **語意與意義**——讀懂來源、決定要建立哪種資源、為「流行性感冒」挑出正確的碼、填入每個欄位的**值**。 |
| **MCP 伺服器** | **結構、術語、機制與一致性**——告訴 LLM *有哪些欄位、允許什麼值*、提供合法碼表、釘住 LLM **不可自行編造**的機制性欄位（固定值、profile URL、system URL、參照），並驗證結果。 |

**LLM 絕不編造** canonical URL、code system URL、SNOMED 顯示名稱或 `meta.profile`——這些都來自伺服器。LLM 填的是**語意**空格，伺服器釘的是**機制**欄位。

---

## 開始之前：要用哪個 IG？

FHIR 資源只有對著目標 IG 才有意義。**同一組**臨床事實（一位病人、一個流感診斷）可以依**資料要送到哪裡**而對應到 TW Core、US Core 或 IPS——資料本身不會告訴你答案。所以 IG 是依**情境**決定，而不是從內容猜測，順序如下：

1. **部署預設值**——多數安裝綁定單一 IG（例如台灣的醫院 → TW Core）。有一個套件被標記為預設，LLM 不需要選。
2. **明確指示**——呼叫端應用或使用者說「產生 TW Core FHIR」。每個工具都接受 `ig = {packageId, version}` 參數，所以選擇永遠是明確的。
3. **知情選擇**——若安裝了多個 IG 且未指定，LLM 呼叫 `fhir_list_igs`（回傳每個套件的 `title`、`jurisdiction` 與預設旗標），再對照使用者意圖與內容線索（中文文字、中華民國身分證號、健保申報 → `jurisdiction = TW`）。
4. **仍然模稜兩可 → 詢問。**系統會問使用者，而不是用猜的。

因為每個 IG-scoped 工具都接受 `ig`，你可以明確指定**任何已匯入的 IG**：`fhir_get_profile(ig=US-Core, "Patient")` 與 `fhir_get_profile(ig=TW-Core, "Patient")` 會回傳不同的剖面。要支援新國家的 IG，只要匯入它的套件即可——不需要新工具。

---

## 實例演練

**輸入——一段非結構化的臨床病歷（自由文字）：**

> 「病人王小明,男性,生日 1985年3月12日,身分證 A123456789。因急性發燒至門診就醫,經醫師確診為**流行性感冒**,2026/6/1 發病,目前持續追蹤中。」

**目標：**產生符合 TW Core 的 FHIR——一個 `Patient` 與一個 `Condition`，包進一個 Bundle。

圖例：**[LLM]** = 模型自行推理（沒有工具呼叫）· **[MCP]** = 一次工具呼叫。

### 階段 0 —— 讀懂文字 *（無工具呼叫）*

**[LLM]** 讀病歷並抽出臨床事實：

```
Patient:   name=王小明, sex=male, birth=1985-03-12, national-id=A123456789
Diagnosis: influenza, clinical status=active, verification=confirmed, onset=2026-06-01
```

它也判斷需要一個 **Patient** 與一個 **Condition**。此時它**還不知道**要用哪些 FHIR 欄位或碼——那正是伺服器的職責。

### 階段 1 —— 決定 IG

依照上述規則。在綁定台灣的部署中，答案就是「TW Core 1.0.0」。不確定時：**[MCP] `fhir_list_igs`** → 依 `jurisdiction` / 意圖挑選 → 模稜兩可就詢問。

### 階段 2 —— 決定剖面

- **[MCP] `fhir_list_resource_profiles(ig)`** → 回傳該 IG 的剖面：`Patient-twcore`、`Condition-twcore`、`Encounter-twcore`……
- **[MCP] `fhir_rank_resource_profiles(ig, facts)`** *（選用）* → 把診斷事實餵進去，伺服器對候選剖面排名（`Condition-twcore` 居首，附上吻合欄位的佐證）。**它只給建議**——最終由 **[LLM]** 拍板。

### 階段 3 —— 逐一建立資源（先 Patient，因為 Condition 會參照它）

#### 3A · Patient

1. **[MCP] `fhir_get_resource_skeleton(ig, Patient-twcore)`** → 從剖面即時衍生出一份**空白、帶註解的填寫表單**：
   ```
   identifier  (1..*, required; sliced — national ID uses slice "NN";
                system is auto-pinned, you only supply value)
   name        (1..*, required: family / given)
   gender      (0..1; allowed: male | female | other | unknown)
   birthDate   (0..1; date)
   [meta.profile → auto-filled by the server; do not touch]
   ```
2. **[LLM]** 以階段 0 的事實填入**語意**空格：
   ```
   identifier[0].value = "A123456789"
   name = { family: "王", given: ["小明"] }
   gender = "male"          ← 取自骨架中列出的允許值
   birthDate = "1985-03-12"
   ```
   對於編碼欄位，它可以用 **[MCP] `fhir_validate_code`** 再確認一次。
3. **[MCP] `fhir_finalize_resource(ig, Patient-twcore, draft, refCtx)`** → 伺服器釘住**機制性**欄位（身分證 slice 的 `identifier.system`、`identifier.type`、`meta.profile`），執行驗證器，回傳 `{ resource, validation: pass }`。這個 Patient 會登記進**參照脈絡**（`refCtx`），讓其他資源可以指向它。

#### 3B · Condition

1. **[MCP] `fhir_get_resource_skeleton(ig, Condition-twcore)`** →
   ```
   clinicalStatus     (allowed: active | recurrence | ...)
   verificationStatus (allowed: confirmed | provisional | ...)
   category           (allowed: encounter-diagnosis | problem-list-item)
   code               (1..1, required; bound to a SNOMED diagnosis ValueSet)
   subject            (1..1, required; Reference → Patient-twcore)
   onset[x]           (choice; use onsetDateTime for a date)
   ```
2. **[LLM]** 填入容易的語意空格：`clinicalStatus=active`、`verificationStatus=confirmed`、`onsetDateTime=2026-06-01`。
3. **關鍵步驟——把自由文字「流行性感冒」轉成標準碼：**
   - **[MCP] `fhir_normalize_code(input="流行性感冒", target = Condition.code 的 ValueSet)`** → 依語意相似度回傳**候選碼**，例如 SNOMED `6142004 | Influenza`。
   - **[MCP] `fhir_validate_code`** → 確認該碼確實屬於綁定的 ValueSet → LLM 才寫入 `code`。
   - *（LLM 在這裡絕不可自行編造碼——一律先 normalize，再 validate。）*
4. **接上參照：[MCP] `fhir_resolve_reference(refCtx, target=Patient, source=王小明)`** → 回傳 `urn:uuid:…` → 寫入 `subject.reference`。
5. **[MCP] `fhir_finalize_resource(ig, Condition-twcore, draft, refCtx)`** → 假設驗證器發現 **`category` 為必填但缺漏**。伺服器**不會替你修**，而是回傳 `{ resource, issues: [category missing] }`。
6. **[LLM]** 讀取該問題，用 **[MCP] `fhir_get_profile_elements(ig, Condition-twcore, view="binding", path="Condition.category")`** 查允許值，設定 `category="encounter-diagnosis"`，然後**再呼叫一次 `fhir_finalize_resource`** → 這次**通過**。

### 階段 4 —— 組裝與整體驗證

- **[MCP] `fhir_build_bundle([Patient, Condition], type="transaction", refCtx)`** → 把兩者包成 Bundle，將參照改寫為 `urn:uuid:`，回傳 bundle 與參照對照表。
- **[MCP] `fhir_validate_bundle(bundle)`** → 檢查每一個 entry **以及**內部參照完整性（Condition.subject 確實指向 bundle 內的 Patient）→ 通過。

**通過驗證的 Bundle 就是你的輸出檔。**

---

## 流程一覽

```
free-text / source data
  │
  ├─[LLM]  understand it, extract facts, decide which resources are needed
  │
  ├─ resolve IG  (deployment default ▸ explicit ▸ informed choice ▸ ask)
  │
  ├─[MCP] list / rank profiles ──▶ [LLM] pick the profile
  │
  ├─ for each resource:
  │     [MCP] get_resource_skeleton     ← blanks + allowed values + candidate codes
  │       └─[LLM] fill the semantic blanks
  │            ├─[MCP] normalize_code → validate_code     (free text → standard code)
  │            └─[MCP] resolve_reference                  (link to other resources)
  │     [MCP] finalize_resource         ← pin mechanical fields + validate
  │       └─ failed? returns issues → [LLM] fixes → finalize again
  │
  └─[MCP] build_bundle → validate_bundle ──▶ final Bundle file
```

---

## 為什麼這樣設計

- **沒有對應樣板要維護。**舊系統需要手寫的「欄位 A → 欄位 B」規則檔，因為軟體無法理解語意。有了 LLM，模型會對著伺服器交給它的骨架即時完成語意對應——沒有東西需要撰寫或版本控管。
- **LLM 無法漂移成無效的 FHIR。**它只填語意值；機制部分由伺服器釘住，結果由驗證器把關。任何伺服器無法在本地查證的事項都會以**警告**回報，絕不會靜默地標成「有效」。
- **這是預檢，不是最終權威。**當你把 Bundle 送到真正的 FHIR 伺服器時，**那台**伺服器才做權威驗證。本流程的職責是及早攔下絕大多數錯誤，並給出清楚、可修正的回饋。
- **一套工具，多個 IG。**每個工具都接受 `ig` 選擇器，所以同一套流程今天適用 TW Core，明天也適用任何你匯入的 IG——不需要新工具。

---

## 工具速查

| 階段 | 工具 | 作用 |
|---|---|---|
| IG | `fhir_list_igs` / `fhir_get_ig` | 列出已安裝 IG（title、jurisdiction、預設）/ 單一 IG 詳情 |
| 探索 | `fhir_list_artifacts` / `fhir_search_artifacts` | 瀏覽 / 搜尋某 IG 的剖面、ValueSet 等 |
| 剖面 | `fhir_list_resource_profiles` / `fhir_rank_resource_profiles` / `fhir_get_profile` | 列出可選剖面 / 依你的資料排名候選 / 剖面摘要 |
| 結構 | `fhir_get_profile_elements(view=…)` | 一個工具多種視圖：`elements`、`element`、`slices`、`choices`、`binding`、`examples` |
| 術語 | `fhir_get_valueset` / `fhir_expand_valueset` / `fhir_lookup_code` / `fhir_validate_code` / `fhir_normalize_code` | 檢視 / 展開 ValueSet、查詢或驗證碼、自由文字 → 候選碼 |
| 授權 | `fhir_get_resource_skeleton` / `fhir_finalize_resource` | 取得帶註解的填寫表單 / 釘住機制欄位並驗證 |
| 組裝 | `fhir_resolve_reference` / `fhir_build_bundle` | 連結資源 / 打包成 Bundle |
| 驗證 | `fhir_validate_resource` / `fhir_validate_bundle` | 對單一資源 / 整個 bundle 做一致性檢查 |
