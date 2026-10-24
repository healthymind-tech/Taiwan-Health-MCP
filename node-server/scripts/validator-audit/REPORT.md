# 內建 FHIR validator 稽核報告（2026-10-16）

## 1. 結論

- 使用者回報的三項問題**全部屬實**（根因見 §2）。
- 修正後共比對 **2280 筆**，valid / invalid 判定與 oracle（validator.dicom.tw，後端為 HL7 validator）**全部一致**：
  - 誤拒 0 筆、誤收 0 筆
  - precision 1.0、recall 1.0
  - 另在 staging 透過 HTTP 跑了 174 筆，174/174 一致
- 使用者指定的負例全部仍報 error，結果與 oracle 一致（§4）。
- TW Core、PAS、R4 core 的 constraint 中，沒有任何一條用到不支援的 FHIRPath 函式（§6）。
- `npm run typecheck` 通過，`npm test` 419/419 通過。

## 2. 三項指控：是否屬實與根因

舊程式碼位置以 `HEAD` a8af7d9 為準。

### Claim 1：多型 `value` 解析不到 `value[x]`，並出現「unsupported FHIRPath function」— 屬實

- `fhirValidator.ts:265` 呼叫 `fhirpath.evaluate(...)` 時，FHIR model 參數傳了 `undefined`。
  - 引擎因此不知道 R4 型別，`value` 對應不到 `valueQuantity`，`ofType` / `is` / `as` 也全部失效。
  - 結果是 vs-2、vs-3、ext-1、tw-core-4、lab-result 被誤判為失敗。
- `:232-243` 刻意讓 `hasValue`、`htmlChecks`、`memberOf`、`resolve` 一呼叫就 throw；`:280-288` 再把這些失敗彙總成「unsupported FHIRPath function」的 information。
  - 換句話說，這些 invariant 從來沒有真正被檢查過。
- 基線 159 個 IG 範例中，invariant 造成的誤拒：ext-1 7 筆、vs-2 11 筆、tw-core-4 7 筆、vs-3 2 筆、lab-result 2 筆、tw-core-2 1 筆。

### Claim 2：基數跨重複父節點計算 — 屬實

- `fhirValidator.ts:34-59` 的 `getAtPath()` 把所有重複父節點底下的值攤平成一個清單，`validateStructure()`（`:101-124`）再拿這個清單去算 `max`。
  - 例如兩個 identifier 各有一個 `use`，會被報成「Patient.identifier.use occurs 2 times」。
- `min` 檢查（`:109`、`:118`）一樣是跨父節點彙總，所以某一筆缺了必填欄位，會被其他筆的值掩蓋。
- 舊的 slicing 邏輯（約 `:214`）同樣用攤平後的清單，而且只驗 `meta.profile`，沒有驗 base 定義。
- 這是基線中最大宗的問題：37 筆誤拒、140 則錯誤。

### Claim 3：ValueSet expansion 漏掉巢狀 concept — 屬實

- `loaders/ig.ts:621` 匯入 IG 時，只把最上層的 `CodeSystem.concept` 寫進 `fhir.concepts`，巢狀的 `concept.concept` 全被丟掉。
  - 例如 `inactive` 底下的 `resolved` 就是這樣不見的。
- `fhirTerminology.ts:283-305` 列舉整個 code system 時直接讀 `fhir.concepts`，所以 expansion 漏碼。
- `fhirIgService.ts:591` 的 `validateCode` 用這個 expansion 判斷成員資格，因此 `resolved` 被判為 invalid。

### 附帶發現

- **Bundle 內未解析的 reference 被當成 invalid**（`fhirIgService.ts:1039`）。
  - HL7 在 collection / transaction bundle 只給 warning（`Bundle_BUNDLE_Not_Local`）。
- **`Resource.id` 的語法沒有檢查**。
  - R4 core 4.0.1 的 snapshot 把 `Resource.id` 標成 `fhir-type = "string"`。
  - 所以沒有 `meta.profile` 的資源，`id: "bad id!"` 不會被抓。

## 3. 變更內容

- **`fhirValidator.ts`（重寫）**：新的 `InstanceValidator`。
  - **基數**：按每個父節點各自計算。
  - **Slicing**：依各種 discriminator 把每個重複項分到對應的 slice，再檢查各 slice 的基數與 closed slicing。
  - **`value[x]`**：依 JSON key 決定型別；沒有子元素定義的 datatype，改用該 datatype 自己的 SD 驗證。
  - **其餘涵蓋**：extension、primitive（`Resource.id` 一律以 `id` 型別檢查）、fixed / pattern、binding，並同時套用 base 定義與所有 profile。
  - **Bundle reference**：解析方式改成與 HL7 `resolveInBundle` 相同。
    - 絕對網址只比對 entry 的 `fullUrl`。
    - 相對 reference 先用引用者所在 entry 的 RESTful `fullUrl` 補成絕對網址，再比對。
    - versioned reference 需要 `fullUrl` 與 `meta.versionId` 都相符。
    - bundle 內找不到的 `urn:` 給 warning。
  - **Bundle 層級規則**：
    - 除了 transaction / batch 及其 response，每個 entry 都必須有 `fullUrl`。
    - RESTful `fullUrl` 的結尾必須是該 entry 的 `/Type/id`。
    - document 的 Composition 中，subject、author、encounter、custodian、attester.party、section.entry 都必須能在 bundle 內解析；message 的 `focus` 同理。
    - 孤立 entry：document 報 error，message 報 warning。
- **`fhirPath.ts`（新）**：使用 fhirpath.js 並帶入 R4 model，在本地提供 `resolve` / `memberOf` / `htmlChecks`；任何例外都回傳「無法評估」（information），不會報成 error。
- **`fhirCodeSystem.ts`（新）**：直接從 CodeSystem 原始 JSON 建索引（含巢狀 concept），並處理 compose filter（is-a、descendent-of、is-not-a、generalizes 等）與規則式的成員判斷。
- **`fhirValidationResolver.ts`（新）**：從 DB 讀取 SD / ValueSet / CodeSystem 的 resolver。
- **`fhirTerminology.ts`、`fhirIgService.ts`**：改接上述新模組。
- **`fhirIg.ts`**（可選）：把相依宣告中的 r4.core 4.0.0 對應到 4.0.1，需要搭配 `loaders/igRegistry.ts`。validator 的修正不依賴這項變更。
- **測試**：`fhirValidator.test.ts`、`fhirPath.test.ts`、`fhirCodeSystem.test.ts`、`fhirTestKit.test.ts`。正負例都有，bundle 規則的每個案例都先送 oracle 確認過行為。

## 4. 使用者指定案例（93 筆，93/93 一致）

| 案例 | Oracle | 我們 |
|------|--------|------|
| 體溫 Observation 使用 `valueQuantity` | valid | valid |
| vital sign 沒有 value / dataAbsentReason / component（24 筆） | vs-2 error | vs-2 error |
| 有 dataAbsentReason、沒有 value（22 筆） | valid | valid |
| component 沒有 value（5 筆） | vs-3 error | vs-3 error |
| 一個 identifier 帶兩個 system（6 筆） | 結構 error | 結構 error |
| 多個 identifier（5 筆） | valid | valid |
| extension 同時有 value 和子 extension（6 筆） | ext-1 error | ext-1 error |
| clinicalStatus = `foo` | binding error | binding error |
| clinicalStatus = `resolved` / `remission` / `inactive` | valid | valid |
| TW Core Condition 缺 category | required error | required error |

## 5. 修正前後數據

| 語料 | 筆數 | 修正前（HEAD） | 修正後 |
|------|------|----------------|--------|
| IG 範例（TW Core 98 + PAS 61） | 159 | 99 筆一致；誤拒 59、誤收 1；precision 0.048 | **159/159** |
| Bundle（TW Core 20 + PAS 10） | 30 | 使用者回報為 5/60、0/30 | **30/30** |
| Mutation 全量 | 1910 | — | **1910/1910** |
| 使用者案例 | 93 | — | **93/93** |
| MedicationDispense mutation | 31 | — | 31/31 |
| 大型 PAS bundle | 6 | — | 6/6 |
| Reference 探針 | 51 | 47/51 | **51/51** |
| **合計** | **2280** | | **2280/2280** |

**Error 位置的對齊程度**（逐筆比較兩邊去重後的 error 位置）：

- 寬鬆比對下只有 6 筆不同，全部是路徑寫法不同，例如 `event.ofType(Coding)` 對上 `eventCoding`。
- 嚴格比對下有 99 筆（4.3%）位置不同，全部是兩邊都判為 invalid 的項目。差異來源：
  - **連鎖錯誤**：HL7 在型別錯誤之後還會繼續報後續錯誤，我們報完型別錯誤就停止。
  - **同一個錯誤報在不同層級**：pattern 不符時，HL7 報在 `coding[0].code`，我們報在 `coding[0]`。
  - **同一條規則、訊息不同**。
  - **terminology server 判定的 system 未知**（12 筆）：我們在同一筆用 pattern / binding 錯誤判為 invalid。
  - **HL7 本身的路徑 index 偏移 bug**。

## 6. FHIRPath constraint 盤點

| 目標 | 閉包套件數 | SD 數 | constraint 使用次數 | 不重複 constraint | 解析失敗 | 不支援函式 |
|------|-----------|-------|-------------------|------------------|---------|-----------|
| TW Core 1.0.0 | 9 | 1115 | 8092 | 282 | 0 | **0** |
| PAS 1.2.7 | 56 | 3112 | 26273 | 522 | 0 | **0** |

2280 次驗證中共出現 31 則 `invariant-unevaluated`，全部是 information 等級。來源都是型別已被 mutation 破壞的資源，這些資源本來就已被判為 invalid。

## 7. 殘餘差異與風險

1. **沒有使用者的 gold bundle**：使用者那 90 份 gold bundle 不在本機，正例只來自 IG 自帶的範例，以及用範例組成的 bundle。建議取得後放進 `corpus/` 重跑一次。
2. **連鎖錯誤報得比 HL7 少**：值的型別錯誤時，我們不會繼續報後續的連鎖錯誤，但 valid / invalid 判定相同。
3. **本地無法判定的碼與 ValueSet**：
   - 本地沒有的 SNOMED / LOINC 碼只給 warning。
   - 本地無法判定的 ValueSet 給 information。
   - 這是刻意設計成寧可放過，也不誤拒。
4. **Message bundle 只檢查 `focus`**：MessageHeader 的其他 reference 沒有用探針確認過。
5. **Bundle 內的 reference 解析比以前嚴格**：
   - 以前會用 type/id 退而求其次對到 entry。
   - 現在與 HL7 一致，不再這樣做。
6. **極大的 bundle 沒有做壓力測試。**

## 8. 重跑方式

見 [README.md](README.md)。oracle 回應快取在 `/tmp/claude-1000/val/oracle_cache`（本機）。

---

# v2：第二輪外部回報（2026-10-16）

外部使用者以官方 `validator_cli 7.0.1 -ig tw.gov.mohw.twcore#1.0.0 -tx tx.fhir.org` 對 541 份 LLM 產生的 bundle 比對：
誤拒 0，但 398 份 invalid 中有 20 份被我們放行（sensitivity 0.95）。本輪修正 A–F 各項。

## v2.1 方法

- **主要比對目標改為 CLI oracle**：在本機 docker（`eclipse-temurin:21-jre`，記憶體上限 3.5 GB）跑同版
  `validator_cli.jar` 7.0.1 + tx.fhir.org，即回報者的驗收環境（`harness/cli_oracle.py`）。validator.dicom.tw
  （dicom oracle）保留作第二參考。
- **以 HL7 原始碼為規格**：用 CFR 反編譯 7.0.1 jar（Apache-2.0）中的 `InstanceValidator`、
  `StandAloneValidatorFetcher`、`BasePolicyAdvisorForFullValidation`、`ValueSetValidator`、`SIDUtilities`、
  `OIDUtilities`、`RegexUtils`，逐條移植成 TypeScript；每條移植規則在程式中註明來源 class / method。
  產品內不嵌入任何 Java 元件，CLI 只作測試 oracle。
- 新 corpus：`v2_probes`（456 筆規則探針）、`mut_v2`（945 筆 A–F mutation，`gen_v2_mutations.py`）。

## v2.2 兩個 oracle 的差異（已釐清，非本系統問題）

| 項目 | CLI 7.0.1 | dicom | 原因 |
|------|-----------|-------|------|
| HL7 空間的 URL 無法解析（`No definition could be found for URL value`） | error | 不檢查 | dicom 走 HAPI 的 resource fetcher，`resolveURL` 一律回 true |
| SNOMED inactive 描述當 display | error（"no longer considered a correct display"） | 接受 | tx 版本不同 |
| `obs-pregnancy-status-example`（SNOMED US edition version）、PAS `Condition` / `bun-imm` | error | valid | CLI 端 tx / 套件解析環境差異；IG 範例本身 |
| PAS 內 `…/CodeSystem/icd-10-pcs-2023-tw` 的未知碼 | 只有 warning（CS 找不到） | error | TW Core 0.3.2 該 CS 以 ValueSet URL 發佈；CLI 不解析 |

本系統以 CLI 為準；上表 dicom 端的不一致視為已解釋殘差。

## v2.3 各項結論

| 項 | 是否屬實 | 根因 | 修正（移植來源） |
|----|----------|------|------------------|
| A display | 屬實 | ICD-10-CM / ISO 3166 被列為 silent；LOINC / SNOMED 不符只給 warning；IG CodeSystem 比對忽略空白、接受任何語言 designation | 規則：忽略大小寫、空白有意義（`Wrong whitespace in Display Name`）、error。LOINC 只接受 LONG_COMMON_NAME 與 SHORTNAME；SNOMED 只接受 active 英文 FSN / 同義詞；ICD-10-CM 用 tabular 標題；ISO 3166 內建 tx.fhir.org 對照表（291 個 alpha-2 含 user-assigned、249 alpha-3、249 numeric）；IG CodeSystem 移植 `ValueSetValidator` 的語言規則；DCM 改為檢查 display。無本地資料的系統給 information。 |
| B 未知 URL | 屬實 | 沒有實作 HL7 的 URL 解析檢查；巢狀 complex extension 的絕對 URL 子 extension 漏報 | 移植 `checkPrimitive` → `validateReference` → `resolveUrl` → `StandAloneValidatorFetcher.resolveURL`（`isKnownSpace`、`findBaseUrl`、SID 清單等）；套用於所有 uri / url（含 Identifier.system、Quantity.system、Extension.url）。已知與否以 DB 內任一套件是否有該 canonical 判定。 |
| C UCUM | 屬實 | 未檢查 | `@lhncbc/ucum-lhc` 7.1.9；只對 type = Quantity（含 SimpleQuantity / MoneyQuantity）與 Coding 檢查，Age / Duration 不檢查（同 HL7 `checkQuantity`）。約 230 個單位與兩個 oracle 全數一致。 |
| D OID | 屬實 | 只檢查 `oid` 型別 | 移植 `OIDUtilities.isValidOID` + `RegexUtils.splitRegexMatch`（Java split 會丟掉結尾空字串）+「最後一個點的位置 ≥ 4 或 1.3 開頭」；另含 `urn:uuid:` 小寫 UUID 檢查 |
| E ValueSet 當 system | 屬實 | 未檢查 | `checkTerminologyCoding` / `isValueSet`；只對 HL7 core / THO 的 ValueSet 報 error（IG 本地 ValueSet 兩個 oracle 都只報 unknown CodeSystem） |
| F1 vital signs | 屬實 | 只認 10 個 magic LOINC；HL7 另有替代碼表（3141-9、8331-1、8480-6…）與 SNOMED 碼表 | 逐字移植 `BasePolicyAdvisorForFullValidation.getImpliedProfilesForObservation`；另修 `getCriteriaForDiscriminator` 會往必要子 slice 找 fixed 值（bp component 判別先前判不出來） |
| F2 多重 slice | 規則屬實，案例未重現 | 第一個符合就停 | 移植 `matchSlice`：同時符合兩個 slice → error `Element matches more than one slice`。MedicationRequest-twcore 的具體案例用 15 種變體都無法在 CLI 重現 |

## v2.4 結果（vs CLI oracle，staging 經 HTTP 驗證，與本機一致）

| 語料 | 筆數 | invalid | 修正前 TP / 誤收 / 誤拒 | 修正後 TP / 誤收 / 誤拒 | sensitivity 前 → 後 |
|------|------|---------|--------------------------|--------------------------|---------------------|
| v2_probes + mut_v2 | 1401 | 858 | 331 / 527 / 0 | 841 / 17 / **0** | 0.386 → **0.980** |
| 既有 2280 筆 | 2280 | 1934 | 1923 / 11 / 3 | 1923 / 11 / **0** | 0.994 → 0.994 |

- 對 dicom oracle：既有 2280 筆為 2277/2280（3 筆即 v2.2 表最後一列）；v2 語料的差異全部屬 v2.2 表前兩列。
- 修正後的 17 筆誤收：8 筆是 CLI 對 IG 範例本身的環境性拒絕（v2.2 第三列）；4 筆 LOINC answer code（LA…）display；
  1 筆 CVX display；1 筆 SNOMED 版本差（本地 2025-06 release 無該 concept 的 active 描述）；
  ICD-10-CM 未知碼 1、ICD-10（WHO）display 1、TW Core 本地 ValueSet 當 system 1。
- `npm run typecheck` 通過；`npm test` 436/436。

## v2.5 殘餘風險

1. **版本差**：tx.fhir.org 用 ICD-10-CM 2026-04-01、較新的 SNOMED / LOINC；本地為 ICD-10-CM FY2025、SNOMED 20250601、LOINC 2.80。
   本地沒有的碼一律只給 warning；但「新版才加入的同義詞 / 改過的標題」被當 display 用時會被我們誤拒（未觀察到，但無法排除）。
2. 未檢查（沒有本地資料）：LOINC answer / part code、CVX、ICD-10（WHO）、RxNorm、ATC 的 display；ICD-10-CM 的 7th-character 碼。
3. B 規則以「DB 內任一套件有此 canonical」判定已知；若 tx.fhir.org 認得、但 DB 套件裡沒有的 HL7 URL，會被誤拒（目前全部語料 0 筆）。
4. F2 的 TW Core 實例未重現。

---

# v3：第三輪外部回報 — ICD-10-CM 碼表不完整（issue G，2026-10-16）

回報：本地 ICD-10-CM 缺 7th-character 碼（`fhir_lookup_code` 查 S93.411A、S06.0X0A 為 found:false）；
`fhir_validate_*` 遇到本地沒有的 ICD-10-CM 碼只給 warning，不報 Unknown code，也不檢查 display。

## v3.1 根因（屬實）

| 位置（`HEAD` a8af7d9） | 問題 |
|------|------|
| `loaders/icd.ts:328` `walkDiag` / `:339` `parseTabularXml` | 只收 tabular XML 中有 `<name>` 的 `diag` 節點。7th character 只以祖先節點上的 `sevenChrDef` 定義（S93.411 + A/D/S，placeholder X 補到 6 碼），從未展開 → 51,485 個 7 碼全部缺漏（FY2025 表 46,498 列，完整碼表 98,186）。極小 XML parser 也丟掉屬性（`<extension char="A">`），本來就無法展開。 |
| `loaders/icd.ts:361-363`、`:533-535`（order TXT 分支） | header 旗標讀反（`"1"` 是 billable 卻被跳過）、沒補點號（`S93411A`），所以 CMS order file 也無法用。 |
| `fhirValidationResolver.ts` ICD-10-CM 分支（v2 版） | 找不到 → 一律 warning（因為碼表不完整，只能如此）。 |
| `fhirTerminology.ts` `externalDisplays` | 只比對 tabular 標題；tx.fhir.org 另接受 CMS short title（designation `synonym`）。 |

## v3.2 Oracle 行為（tx.fhir.org，ICD-10-CM version `2026-04-01`；validator_cli 7.0.1 逐筆確認）

- 碼集 = CMS「Code Descriptions in Tabular Order」order file 的**全部** 98,186 列：header（S93、S93.41、S93.411、QA0）與 billable 都是合法 concept；chapter / section 範圍（`S00-T88`）不是。
- 點號必須在第 3 碼之後（`S93411A`、`A09.` → Unknown code）；大小寫不敏感（`s93.411a` → 只有 information）。
- display = order file long title，short title 也接受；比對忽略大小寫、空白有意義；用 ASCII（`Sezary disease`），tabular XML 的變音符號版（`Sézary`）是 Wrong Display Name。
- 未知碼：`error` `Unknown code '<c>' in the CodeSystem 'http://hl7.org/fhir/sid/icd-10-cm' version '2026-04-01'`，位置 `…coding[n].code`。
- tabular XML 展開 7th character 會多出 76 個 order file 沒有的碼（如 S06.1X7D：表中以 prose 註明 7/8 只能接 A）；描述除變音符號外與 order file 逐字相同（151 筆差異全部是變音）。
- 隨機抽 150 個本地碼送 tx `$validate-code`：150/150 存在、display 完全相同。

## v3.3 修正

- **Loader**（`loaders/icd.ts`）：`parseIcd10cmRelease` 接受兩種 CMS zip。
  - 優先讀 order file（`parseCmsOrderTxt`）：全部 header + billable、補點號、long / short title、header 旗標。
  - 只有 tabular XML 時以 `expandTabular` 展開 7th character（最近祖先的 `sevenChrDef`、placeholder X），變音符號另存 ASCII 版當替代 display；此路徑**不標 complete**。
  - edition：zip 名稱的 interim 日期（`april-1-2026-…` → `2026-04-01`），否則內檔年份 → `FY2026`。
  - complete = order file + 有 header + ≥ 90,000 列。admin job 在同一個 promote transaction 寫碼表與 `icd.editions`。
- **Schema**：`db/migrations/20261017_icd10cm_complete_edition.sql`（已併入 `db/schema.sql`）：`icd.diagnoses` / `admin.stage_icd_diagnoses` 加 `short_name_en`、`is_header`；新表 `icd.editions`。
- **Validator**（`fhirValidationResolver.ts`）：`icd10cmStrict()` = edition complete 且不舊於 `ICD10CM_STRICT_MIN_EDITION`（`2026-04-01`，即 tx.fhir.org 目前的版本；`FYyyyy` 視為 (yyyy-1)-10-01）時，找不到 → error，訊息同 HL7；否則仍為 warning（含 edition 說明），**不會靜默略過**。display 接受 long / short title，訊息只列 long title（同 tx）。查碼大小寫不敏感。
- **`fhir_lookup_code`**：7 碼可查到；strict edition 下查無時 warning 改為 HL7 的 Unknown code 訊息。
- 其他 ICD 工具（`search_medical_codes`、`browse_icd_category`、`infer_complications`、`get_nearby_codes`、`query_fhir_condition`）SQL 不變，staging 實測正常；7 碼現在也有中文名（台灣 2023 雙語檔原本就含 7 碼：96,780 / 98,186 有中文）。
- 測試：`src/loaders/icd.test.ts`（6 項）。

## v3.4 結果（vs CLI oracle；staging DB = CMS order file 2026-04-01，98,186 碼）

| 語料 | 筆數 | 修正前 一致 / 誤收 / 誤拒 | 修正後 一致 / 誤收 / 誤拒 |
|------|------|------|------|
| `icd_v3_probes`（G0–G4、真實 bundle、規則探針） | 29 | 15 / 13 / **1**（`Sezary` ASCII display 被誤拒） | **29 / 0 / 0** |
| `icd_v3_mut`（seed 20261017） | 145 | 85 / 60 / 0 | **145 / 0 / 0** |
| v2 語料（`v2_probes` + `mut_v2`） | 1401 | 1384 / 17 / 0 | 1385 / 16 / 0（ICD 未知碼 `Z99.999` 修正） |
| 既有 2280 筆 | 2280 | 2269 / 11 / 0 | 2269 / 11 / 0 |
| **合計** | **3855** | | **3828 / 27 / 0** |

- G0 / G0b valid；G1、G2、G4 Unknown code；G3 Wrong Display Name；兩種真實 bundle 樣式 invalid；正向對照 bundle valid — 全與 CLI 相同。
- `fhir_lookup_code`（staging HTTP）：S93.411A、S06.0X0A、A09 → found:true；S06.0XX0A、Z99.99 → found:false。
- staging 經 HTTP（`:8090`）跑 `icd_v3_*` 與 `v2_probes`，結果與本機相同。
- 剩下 27 筆誤收全部是 v2.4 已列的非 ICD 項目。明細在 `results/summary_v3_cli.json`。

## v3.5 LOINC / SNOMED：維持 warning

- tx.fhir.org 目前用 **LOINC 2.82**（本地 2.80）；**SNOMED International 20250201**（本地 20250601）。
- **SNOMED**：本地 `snomed.concepts` 只有 active concept（373,972 列，全部 active）。tx 對 inactive concept 只給 warning（`INACTIVE_CONCEPT_FOUND`）。
  - 語料中有 2 個 inactive concept：6369005 出現在 26 筆、9258009 出現在 16 筆，CLI 都是 valid。
  - 若改成 error，這 42 筆會被誤拒。
- **LOINC**：語料 84 個不重複 LOINC 碼中，本地沒有的 15 個都是 answer / part code（LA… / LP…，已另外處理）或空字串。term code 缺漏為 0。
  - 但 2.81 / 2.82 新增的碼本地沒有，改成 error 就會誤拒。
- 建議：
  - LOINC：比照 ICD 的做法（記錄 edition，與 tx 同版才 strict），匯入 2.82 後再開 strict。
  - SNOMED：需要先把 inactive concept 一起匯入，並與 tx 同版。
  - 本輪不改。

## v3.6 殘餘風險

1. **tx.fhir.org 換版**：tx 換到 FY2027（2026-10-01 版）以後，本地若還是 2026-04-01，FY2027 新增的碼會被誤拒。對策是同步匯入新版的 order file。反過來，本地先換版而 tx 還沒換時，FY2027 刪除的碼也會被誤拒。
2. **只上傳 tabular XML zip 時不標 complete**：未知碼仍然只給 warning；display 同時接受變音版與 ASCII 版。
3. **大小寫不同的碼**：HL7 會給 information，我們不報。判定相同。
4. **新碼缺 embedding**：約 51k 個新碼還沒有 embedding，`search_medical_codes` 的語意排序只涵蓋舊碼。需要跑 `icd_embed` job 補齊（會呼叫外部 embedding）。

---

# v4：剩餘 27 筆誤收全數處理（術語補齊，2026-10-16）

目標：對 validator_cli 7.0.1 + tx.fhir.org（CLI oracle）全部語料誤收 0、誤拒 0。v3 結束時誤拒 0、誤收 27
（既有 2280 筆 11、v2 語料 16）。

## v4.1 27 筆逐項：根因 → 修正 → 結果

| # | 語料 / key | oracle error | 根因 | 修正（移植來源） | 現在 |
|---|-----------|--------------|------|------------------|------|
| 1–8 | `obs-pregnancy-status-example`（examples、bundles twcore-6 / twcore-18、mutations M15、mut_v2 A-case / A-lcn / A-sctsyn / A-short） | `VALUESET_VALUE_MISMATCH_CHANGED`（coding.version = SNOMED US edition，ValueSet include 未指定版本 → tx 以 International edition 為準） | 未實作 Coding.version 與 ValueSet include 版本比對；且 preferred binding 完全不檢查 | `ValueSetValidator.determineVersion` 的版本分支（`versionIsMoreDetailed` = 前綴比對）；tx issue 不因 binding strength 降級（`InstanceValidator.calculateSeverityForTxIssuesAndUpdateErrors`），所以 required / extensible / preferred 都檢查 | 一致 |
| 9–19 | PAS `Condition/con-diagnosis`、`con-comorbidity`（examples、mut_v2 A-lcn / A-short ×2）、`pas-0-collection`、`Bundle/bun-imm`（examples + perf ×3） | `Validation_VAL_Profile_NotSlice`（不符 slice `icd10-cm-2023`，`memberOf`）；bun-imm 其餘 `Reference_REF_CantMatchChoice`、bundle entry slice 錯誤全是這個的連鎖 | 我們以 artifact id 退而求其次解析 CodeSystem：TW Core 0.3.2 把 `CodeSystem/icd-10-cm-2023-tw` 以 ValueSet URL 發佈，HL7 依 canonical 找不到 → memberOf 為 false；我們卻判為 member | 驗證時只依精確 canonical 解析 CodeSystem（不做 id fallback）；slicing 的 `memberOf` 遇到「封閉套件與 tx.fhir.org 都無法解析的 code system」→ 非成員（`InstanceValidator.sliceMatches → evaluateSlicingExpression`）。binding 路徑仍只給 warning（與 CLI 相同） | 一致（bun-imm 的連鎖錯誤一併消失） |
| 20–23 | mut_v2 `con-example#A-swap`、`qr-example#A-swap`、`qr-example#A-zh`、`obs-diagnostic-min#A-ws` | LOINC answer code（LA6752-5、LA20278-0、LA11883-8）display 錯 / 空白錯 | 本地沒有 LOINC answer / part 碼，LA 碼一律略過 | LOINC loader 匯入 AccessoryFiles 的 LA / LP / LL / LG（`loinc.other_codes`）與版本（`loinc.editions`）；display 規則依 CLI 探針：LA = DisplayText、LL = AnswerListName、LP = PartName 或 PartDisplayName | 一致 |
| 24 | mut_v2 `imm-example#A-ws` | CVX display 空白錯 | CVX 列為 silent | 內建 tx.fhir.org 的 CVX 表（`fhirCvx.ts`，version 20250715，287 碼，CDC 公有領域） | 一致 |
| 25 | mut_v2 `pro-example#A-zh` | SNOMED 9258009（inactive concept）display 錯 | 本地只有 active concept | SNOMED loader 保留 inactive concept 與描述（`snomed.inactive_*`）+ 首次發佈日 + edition（`snomed.editions`） | 一致 |
| 26 | v2_probes `A-icd10who-A09` | WHO ICD-10 display 錯 | 沒有 WHO ICD-10 資料（silent） | `icd_import` 新增選用來源 `icd10_who`（FHIR CodeSystem JSON）；以 `fetch_tx_terms.py` 取 tx.fhir.org 版 `2019-covid-expanded`（13,831 碼）匯入 `icd.icd10_who` | 一致 |
| 27 | v2_probes `F2b-nhi-vs-as-system` | `Terminology_TX_System_ValueSet2` | **oracle 批次汙染**：同一資源單獨跑（全新 JVM）CLI 只給 warning `UNKNOWN_CODESYSTEM`、valid；同型探針 `X-fda-vs`、`X-path-vs`、`X-nhi-vs-2` 在另一批也都只是 warning | 不改程式；harness 加 `CLI_ISO_CACHE`（單筆重跑結果優先），記錄於 `results/oracle_isolated.json` | 與單筆 oracle 一致 |

## v4.2 新規則（全部先以 CLI 探針確認，`v4_probes`）

| 系統 | tx.fhir.org 行為（CLI 實測） | 我們 |
|------|------------------------------|------|
| LOINC LA / LP / LL | display 忽略大小寫、空白有意義；LP 的 PartName 與 PartDisplayName 都可；DEPRECATED part → warning | `judgeLoincOther` |
| LOINC LG（group / parent group） | **一律** `Unknown code … version '2.82'`（tx 的 LOINC 不含 group，6 個碼確認） | 一律 error |
| LOINC 非 term 碼的檢查碼 | 錯檢查碼 → Unknown code | LOINC Mod-10，前綴貢獻常數依數字長度奇偶（LA 5/2、LL 1/1、LP 2/7、LG 2/6）；2.80 全部 104,575 個 LA/LL/LP/LG 碼無一例外。任何版本都不存在 → error |
| LOINC 未知碼（檢查碼正確） | error（2.82） | 本地 2.80 < 2.82 → warning；`loinc.editions` ≥ 2.82 時自動改 error |
| SNOMED inactive concept | warning `INACTIVE_CONCEPT_FOUND`；display = 該 concept 的 active 描述 | 同 |
| SNOMED inactive 描述當 display | error `INACTIVE_DISPLAY_FOUND` | 同 |
| SNOMED 未知碼 | error（version 20250201） | strict（本地 International + 含 inactive + 版本 ≥ 2025-02-01）→ error；首次發佈晚於 2025-02-01 的 concept / 描述視為 tx 版本不存在（`S-new-after-tx` 一致）；2025-02-01 之後才 inactive 的描述仍算有效（`S-desc-inactivated-after-tx` 一致） |
| SNOMED Coding.version（ValueSet 未指定版本） | International URI 或其前綴延伸 → OK；US / NL / 亂寫 → `VALUESET_VALUE_MISMATCH_CHANGED` error；沒有 binding → 不檢查 | `codingVersionIssue` |
| CVX | 碼為精確字串（`08` 有效、`8` 未知）；short 與 long description 都可 | 內建表 |
| WHO ICD-10 | 碼大小寫敏感（`a09` 未知）；chapter（`I`）、block（`A00-A09`）是有效碼；標題與 long description 都可；ICD-10-CM 7 碼（`S93.411A`）未知 | `icd.icd10_who`；edition = `2019-covid-expanded` 時 strict |
| IG 本地 ValueSet 當 Coding.system | 單筆執行一律只有 warning `UNKNOWN_CODESYSTEM` | 不變（warning） |

## v4.3 變更

- **新檔**：`src/fhirExternalTerminology.ts`（純函式：上述規則與 tx 版本常數 `LOINC_TX_VERSION` = 2.82、
  `SNOMED_TX_EDITION_DATE` = 2025-02-01、`ICD10_WHO_TX_EDITION` = 2019-covid-expanded）、`src/fhirCvx.ts`（CVX 表）、
  `src/fhirExternalTerminology.test.ts`（14 項）。
- **`fhirValidationResolver.ts`**：`checkCode` 接 Coding.version；LOINC LA/LP/LL/LG、SNOMED、CVX、WHO ICD-10 改走新規則；
  `codeSystemResolvable()`；ValueSet membership 改用精確 canonical。
- **`fhirValidator.ts`**：`CodeCheck.extra`（INACTIVE / DEPRECATED warning）、`checkCodingVersions`（含 preferred binding）、
  slicing `memberOf` 的不可解析 code system → 非成員。
- **`fhirTerminology.ts`**：新表查詢（缺表 / 缺欄位時退回「未持有」）、`loadCodeSystemIndex(…, exact)`、
  `fhir_lookup_code` 可查 LA/LP/LL、CVX、WHO ICD-10。
- **Loaders / jobs**：`loaders/loinc.ts`（other codes + 版本）、`loaders/snomed.ts`（inactive 內容、RF2 Full 首次發佈日——只記錄
  發佈前 3 年內有變動的元件，其餘 NULL = 更早；日期字串 intern，worker heap 峰值約 2.9 GB < 4 GB 上限）、`loaders/icd.ts`
  （WHO ICD-10 JSON parser）；`admin/adminJobs.ts` 三個 import job 各加 stage 步驟並在同一 promote transaction 寫 edition；
  `admin/adminSources.ts` 新增選用來源 `icd/icd10_who`；`admin/adminModuleClear.ts` 清除時一併清新表。
- **Schema**：`db/migrations/20261018_terminology_completeness_v4.sql`（已併入 `db/schema.sql`，空 DB 實測可套用）。
- **文件**：`docs/modules/{icd,lab,snomed}-service(.en).md`。

## v4.4 staging 資料（twh-staging，經 admin job 匯入）

| 來源 | 版本 | 列數 |
|------|------|------|
| LOINC other codes（`loinc_import`） | 2.80 | 104,607（LA 20,033、LP 72,740、LL 4,621、LG 7,168、parent group 45） |
| SNOMED CT（`snomed_import`） | International 2025-06-01 | active concept 373,972、active 描述 995,443、inactive concept 148,382、inactive / inactive-concept 描述 671,772；記錄首次發佈日：concept 46k、描述 132k |
| WHO ICD-10（`icd_import` 選用來源） | 2019-covid-expanded（tx.fhir.org） | 13,831 |
| CVX（內建） | 20250715（tx.fhir.org） | 287 |

匯入耗時（staging）：LOINC 約 40 秒、ICD 約 30 秒、SNOMED 約 7 分鐘。

## v4.5 結果（vs CLI oracle；staging DB；本機 in-process 與 staging HTTP `:8090` 結果相同）

| 語料 | 筆數 | v3 一致 / 誤收 / 誤拒 | v4 一致 / 誤收 / 誤拒 |
|------|------|------|------|
| 既有 2280 筆（examples、bundles、mutations、user_cases、mut_dis、perf、refprobe×3） | 2280 | 2269 / 11 / 0 | **2280 / 0 / 0** |
| v2（v2_probes + mut_v2） | 1401 | 1385 / 16 / 0 | **1401 / 0 / 0** |
| v3（icd_v3_probes + icd_v3_mut） | 174 | 174 / 0 / 0 | **174 / 0 / 0** |
| v4_probes（新規則探針） | 79 | （修正前 61 / 17 / 1） | 78 / **1** / 0 |
| v4_mut（新術語 mutation 家族） | 376 | （修正前 237 / 139 / 0） | **376 / 0 / 0** |
| **合計** | **4310** | | **4309 / 1 / 0** |

- 原本的 27 筆：26 筆修正後一致；`F2b-nhi-vs-as-system` 為 oracle 批次汙染（單筆重跑 valid），與單筆結果一致。
  另把 27 筆背後的 22 個不同資源全部單筆重跑：其餘 21 個判定與批次相同（`results/oracle_isolated.json`）。
- HTTP（`MCP_BASE=http://<staging-host>:8090`）：v4_probes、v4_mut、v2_probes、mut_v2、bundles、examples、perf、icd_v3_probes 與本機結果相同。
- `npm run typecheck` 通過；`npm test` 456/456；`web` typecheck 通過。

## v4.6 殘差（無法離線比對）

1. **`v4_probes` `S-us-version-fab`**（自建規則探針，不在原 27 筆）：偽造但檢查碼正確的 International namespace SCTID，
   Coding.version = SNOMED **US edition**。tx.fhir.org 以 US edition 20250901 判為 Unknown code。我們沒有 US edition（需 NLM
   UMLS 授權）；US edition 可能以比本地 2025-06-01 更新的 International 版為基礎，若照判 error 會誤拒新碼，因此只給 warning。
2. **LOINC 未知碼仍是 warning**（偽造但檢查碼正確的 LA/LP/LL 碼、2.81/2.82 新碼）：本地 2.80 < tx 2.82。v4_mut 的偽造 LA
   碼全被 LA 檢查碼規則抓到，所以語料中沒有誤收，但「檢查碼正確的偽造碼」仍會漏判。取得 **LOINC 2.82**（loinc.org 需免費帳號
   登入下載，本次無法自動取得）並以 `loinc_import` 匯入後，`loinc.editions` = 2.82 會自動切成 error。
3. **tx.fhir.org 換版耦合**：`SNOMED_TX_EDITION_DATE`（2025-02-01）、`LOINC_TX_VERSION`（2.82）、`ICD10_WHO_TX_EDITION`、
   內建 CVX 表（20250715）、`ICD10CM_STRICT_MIN_EDITION` 都代表 tx.fhir.org 目前的版本。tx 換版後需更新常數 / 重新抓表
   （`fetch_tx_terms.py`），否則新加入的碼可能被誤拒（SNOMED：tx 新版才有、本地已有但首次發佈晚於常數的 concept）。
4. **WHO ICD-10 授權**：資料取自 tx.fhir.org 的 `$expand`（WHO 版權）。程式碼庫不內含此資料；由 operator 以選用來源上傳。
   商業 SaaS 使用前請確認 WHO ICD-10 授權條款。CVX 為 CDC 公有領域，已內建。
5. **批次汙染**：validator_cli 同批資源會互相影響術語判定，以後新增語料若出現無法解釋的單筆差異，先單筆重跑。

## v4.7 Production 上線步驟（使用者決定時機；本輪 production 未動）

1. 套 migration（可線上執行，只有 `CREATE TABLE` 與 nullable `ADD COLUMN`）：
   `docker exec -i taiwanHealthMcp_postgres psql -U <user> -d <db> -v ON_ERROR_STOP=1 < db/migrations/20261018_terminology_completeness_v4.sql`
   （v3 的 `20261017_icd10cm_complete_edition.sql` 若尚未套用要先套）。
2. 重建並重啟 **app 與 admin-worker 兩個 image**（worker 是獨立 image）：`docker compose build app admin-worker && docker compose up -d --no-deps app admin-worker`。
   production 目前跑的是 overlay image，請依 staging-stack 備忘先比對 dist 差異再部署。
3. 重跑匯入（admin console → Modules；全部走 staging → promote，一個 transaction 切換）：
   - `loinc_import`（staging 約 40 秒）：寫入 LA/LP/LL/LG 與 `loinc.editions`。
   - `snomed_import`（staging 約 7 分鐘；worker heap 峰值約 2.9 GB，production worker 為 8 GB）：inactive 內容、首次發佈日、`snomed.editions`。
     embedding 表不受影響。
   - ICD：上傳選用來源「WHO ICD-10 (FHIR JSON)」（`fetch_tx_terms.py` 產生的 `icd10who.json`，1.3 MB）後跑 `icd_import`（約 30 秒）。
   - CVX 隨程式碼內建，無需匯入。
4. 驗證：`MCP_BASE=http://<host>:8080 ORACLE=cli CLI_ISO_CACHE=… python3 -I harness/compare.py corpus/v4_probes.json.gz out.json`。
   未重跑匯入前，新規則自動退回 warning（缺表 / 缺 edition），不會誤拒。

## v5 無 code 的 Coding 與 binding 型 slice（required-elements 稽核發現，2026-10-17）

- **現象**：`fhir_get_profile_required_elements` 的充分性稽核刪掉 slice 的 `code` 後（3 筆：`DiagnosticReport/dia-example`、
  `Bundle/bun-message-request-example#entry[3]` 的 `code.coding:LOINCObservationCode.code`，`Observation/obs-occupation-example`
  的 `value[x].coding:LiaRocOccupation.code`），validator_cli 報 `Validation_VAL_Profile_MatchMultiple`（Element matches more than one
  slice），我們判 valid。另有 2 筆 mutation（`M14-empty-string-…coding.0.code`）兩邊都 invalid，但我們少了 MatchMultiple。
- **根因（7.0.1 反編譯確認）**：`$this` + required binding 的 discriminator 會變成 `memberOf('<vs>')`
  （`InstanceValidator.sliceMatches`）。`FHIRPathEngine.funcMemberOf` → `BaseWorkerContext.validateCode` →
  `ValueSetValidator.validateCode` 只在 Coding **有 code** 時才檢查 ValueSet 成員（`valueset != null && code.hasCode()`），
  沒有 code（或 `""`，JSON parser 會丟掉）時只剩 CodeSystem 檢查：沒有 system → warning（isOk），system 是套件內的本地
  CodeSystem → 無 error。於是該 Coding 符合**每一個** binding 型 slice；`matchSlice` 保留第一個 slice，之後每多符合一個就報一次
  MatchMultiple。
- **修正**（`fhirValidator.ts` `codelessCodingMember`、`fhirValidationResolver.ts` `codeSystemLocal`）：無 code 的 Coding，在 ValueSet
  可解析、且 (無 system 或 system 是 closure 內 content=complete/fragment、非 tx 端處理的 CodeSystem) 時視為 binding slice 成員；
  LOINC / SNOMED 等交給 tx 的系統與無法解析的系統維持「不符合」。MatchMultiple 改為與 HL7 相同：保留第一個 slice，每個額外 slice
  各報一次（`a/b` 形式的 re-slice 例外）。
- **結果（staging HTTP，vs CLI oracle 快取）**：全部 15 個語料 4,310 筆 FR 0 / FA 1（`S-us-version-fab`，修正前即存在）→ 不變；
  required-elements 稽核的 257 筆刪除 mutant FA 3 → **0**。與修正前逐位元比較，4,333 筆回應中只有 2 筆改變（上述 M14 兩筆多了
  MatchMultiple，與 CLI 相同）。

---

# v6：`|version` canonical、驗證完整性回報、slice 成員的 base 規則（2026-10-17）

## v6.1 變更與 HL7 來源（validator_cli 7.0.1，CFR 反編譯）

| 項 | 變更 | HL7 來源 |
|----|------|----------|
| `|version` | 不再 strip 版本：meta.profile、呼叫端 `profile`、binding ValueSet、targetProfile、type profile、Extension.url、slice 的 profile discriminator 都以原字串解析。`url|ver` 只會解析到該版本（`pickCanonicalVersion`）：① resource 自身 `version` 完全相同 → ② 請求為 maj.min 形狀時取該版本線最高版（`|1.0`、`|1.0.9` 都解析到 1.0.0）→ ③ 萬用字元（`1.0.x`）→ ④ 否則視為未安裝。候選範圍 = 目標 IG 的依賴閉包（與 CLI 只載入 `-ig` 閉包相同）。無版本的行為完全不變。 | `BaseWorkerContext.fetchResourceWithExceptionByVersion` → `CanonicalResourceManager.getByPackage(url, version, pvlist)`（`url|maj.min` 索引在 `see()` 中指向該版本線最高版）、`VersionUtilities.getMajMin / removeLabels`；binding 走 `BaseValidator.resolveBindingReference → findTxResource` |
| 未安裝版本 | meta.profile → warning `Profile reference '<url|ver>' has not been checked because it could not be found`，該 profile 不檢查（valid 可維持 true）；required binding 的 ValueSet → warning，binding 不檢查；**targetProfile → error** `Unable to resolve the profile reference`；**type profile → error** `Unknown profile`（兩者皆 CLI 探針確認）。 | `InstanceValidator.startInner` meta.profile 迴圈（`Validation_VAL_Profile_Unknown` / `VALIDATION_VAL_PROFILE_UNKNOWN_ERROR`）、`checkReference`（`Reference_REF_CantResolveProfile`）、`checkChildByDefinition`（`Validation_VAL_Unknown_Profile`）、`Terminology_TX_ValueSet_NotFound` |
| 完整性（P0） | 每個「未檢查」的 issue 帶機器可讀的 `unchecked: {kind: "profile"｜"valueSet", canonical}`；`completenessOf(issues, deps_missing)` → `{checked_fully, profiles_unchecked, valuesets_unchecked}`。**決策**：`valid` 維持 HL7 語意（未知 profile 是 warning），不完整性另以 `checked_fully: false` 明示；`deps_missing` 為 0 以外也算不完整。 | — |
| slice 成員 | 符合 slice 的元素，除了 slice 定義外**也完整檢查一次 slicing base element**（子元素基數、fixed/pattern、binding、invariant）。TW Core 0.3.2 `Patient.identifier.system` 1..1 只在 base，slice `idCardNumber` 沒有 → 以前判 valid、HL7 判 error。complex extension 的子 extension 在 base pass 不再誤報「Sub-extension url not defined」。 | `InstanceValidator.checkChild`：`ei.getDefinition()`（slice）與 `ei.getSlice()`（slicer）各跑一次 `checkChildByDefinition`；`matchSlice` 設定 `setSlice(slicer)` |
| 截斷的 CodeSystem | 判定不變（`content: complete` → Unknown code error，與 HL7 同）；CodeSystem 描述含「僅擷取部分代碼」等字樣、或 `count` 大於實際 concept 數時，另加一則 information 提示（附全國專門術語服務平臺連結）。全語料 18 則，皆在既有 error 旁。 | — |

`toolVersions.ts`：`fhir_validate_resource` / `fhir_validate_bundle` → 1.3.0（`fhir_validate_code` 不受影響）。

## v6.2 回歸（hard gate）

CLI 快取在 /tmp 被清除，本輪以 validator_cli 7.0.1 + tx.fhir.org **重新產生全部 4,310 筆**（11 批，約 40 分鐘）；`F2b-nhi-vs-as-system` 依 v4 規則單筆重跑（`CLI_ISO_CACHE`，再次確認單筆為 valid）。

| | 一致 | 誤收 | 誤拒 |
|---|---|---|---|
| 修改前（本輪基線，同一 DB） | 4,309 | 1（`S-us-version-fab`） | 0 |
| 修改後 | **4,309** | **1**（同一筆） | **0** |

- 本機 in-process 修改前後逐筆比較：4,310 筆中 **verdict 改變 0 筆**；199 筆 invalid 項目的 error 集合變化（訊息多了 `|4.0.1` 等版本字串，與 HL7 訊息相同；以及 base pass 多報的 HL7 同款 error，如 1.0.0 同時報 `identifier:idCardNumber.system` 與 `identifier.system`）。
- 效能：全語料總耗時 110 s → 99 s（無退化）。
- grounding `run_gates.py` 對 staging（`:8090`，部署後）：**ALL PASS**（T1–T9、DET、T7 p95 67 ms）。
- `npm run typecheck` 通過；`npm test` 634/634（含新增 `src/fhirValidator.v6.test.ts` 9 項）。

## v6.3 新探針（`corpus/v6_probes.json.gz`，`harness/gen_v6.py`；30/30 與 CLI 一致）

| 探針 | CLI | 我們 | 說明 |
|------|-----|------|------|
| M-tw `Patient-twcore` 無版本 / `|1.0.0` / `|1.0` / `|1.0.9` / `|1.0.x`（缺 system） | invalid | invalid | maj.min 與萬用字元都解析到 1.0.0 |
| M-tw `|1` / `|0.3.2`（DB 有但不在 1.0.0 閉包）/ `|9.9.9` | valid + profile 未檢查 warning | valid、`profiles_unchecked` | |
| M-pas 無版本 / `|0.3.2`（PAS 閉包 = TW Core 0.3.2） | invalid | invalid | 同時驗證 slice 修正 |
| M-pas `|1.0.0`（不在 PAS 閉包） | valid + warning | valid、unchecked | |
| E `person-age|1.0.0` / `|1.0` / `|9.9.9` / `|0.3.2` | invalid（`EXT_VER_URL_*`、fixed url 不符） | invalid（fixed url 不符 / extension 找不到） | 判定一致；訊息不同 |
| S-032 identifier 缺 system（idCard / MR）、S-100 | invalid | invalid | 修正前 S-032 兩筆、M-pas 兩筆為誤收 |
| B required binding `marital-status` 無版本 / `|4.0.1` / `|4.0` | invalid | invalid | |
| B `|9.9.9` | valid | valid、`valuesets_unchecked` | |
| T targetProfile `Practitioner|4.0.1` | valid | valid | |
| T `|9.9.9`、`Practitioner-twcore|0.3.2`、混合 | invalid（`Reference_REF_CantResolveProfile`） | invalid（同訊息） | |
| Y type profile `Identifier|4.0.1` / `|9.9.9` | valid / invalid（`Unknown profile`） | 同 | |

B / T / Y 用自建 profile（overlay：CLI 以 `-ig <file>` 載入，`localValidate.ts` 疊在 DB 閉包前）。

## v6.4 殘餘與待辦

1. ~~**`checked_fully` 等欄位尚未出現在 tool 回應**~~（已解決：`validateCore` 與 bundle 回應已帶 `checked_fully` / `profiles_unchecked` / `valuesets_unchecked`）：`completenessOf()` 與 issue 上的 `unchecked` 已就緒（staging 回應的 issue 已帶 `unchecked`），但 `data` 由 `fhirIgService.validateCore`（他人負責檔案）組裝，需加一行：`return { valid, profile, source, issues, ...validator.completenessOf(issues, pkg._depsMissing || []) }`。
2. ~~已解決：`fhirIg` 改用 `pickCanonicalVersion`（HL7 規則），`|1.0.9` 兩邊都解析到 1.0.0~~ 原狀況：`fhirIg.resolveCanonicalVersioned` 的 `versionMatches` 只接受同版本或 `1.0` / `1.0.x`；HL7 另把 `|1.0.9` 解析到 1.0.0（maj.min 索引）。validator 以 `pickCanonicalVersion`（HL7 規則，CLI 確認）為準，兩者在「不存在的 patch 版本」上不同。
3. Extension.url 帶版本：HL7 另報 `EXT_VER_URL_NOT_ALLOWED / _REVERSION`，我們只報 fixed url 不符（判定相同）。
4. 未帶版本、閉包內也找不到的 targetProfile：維持不判定（只加 information + unchecked）；HL7 為 error，但目前所有閉包的無版本 targetProfile 都解析得到。

---

# v7：評估報告 v5 的漏報（2026-10-20）

探針 `corpus/v7_probes.json.gz`（`harness/gen_v7.py`，48 筆，全部由 TW Core 1.0.0 範例合成，無 CARVE 內容），以 validator_cli 7.0.1 + tx.fhir.org（`-ig tw.gov.mohw.twcore#1.0.0`）產生 oracle。staging 已停用，本輪 `localValidate.ts` 以唯讀方式連 production DB。

## v7.1 根因與修正

| # | 漏報 | 根因 | 修正（HL7 來源） |
|---|------|------|------------------|
| 1 | `The extension …/variable … is not allowed to be used at this point` + var-1 | (a) 完全沒有檢查 `StructureDefinition.context`；(b) 無版本的 extension URL 取到 R4 core 的副本（4.0.1，沒有 var-1），HL7 取版本最高的副本（`hl7.fhir.uv.extensions.r4`，訊息帶 `v5.x`） | (a) `checkExtensionContext` 移植：宿主元素的 literal path + NodeStack logical paths（`pushInternal` / `isRealPath`）比對 element context（`Element`/`Any`、`Resource`、`CanonicalResource`、逐段比對含 `x[x]`、基底型別鏈），extension context，`version-specific-use` 過濾，`contextInvariant`（`Profile_EXT_Not_Here`）；fhirpath context 不評估（不判錯）。(b) `rankHl7Current`：無版本 StructureDefinition 依 `CanonicalResourceManager` 的 MetadataResourceVersionComparator（major.minor 最高者為 current）選副本 |
| 2 | `Unrecognized property 'slice'`（code.coding[0] 底下） | 未知屬性只在 profile walk 走得到的地方報；剖面不允許的 choice 型別（如 bodyweight 的 valueCodeableConcept）、未知 extension 的 value 底下不會往下走。HL7 的未知屬性由 JSON parser 依 core 定義檢查，與剖面無關 | `structuralPass`：依 core 定義走整份資源；同 HL7 parser，單值寫成陣列、primitive 寫成物件、同一 choice 的第二個值都不往下（CLI 確認） |
| 3 | `Unknown code 'I13.0'`（icd-10-cm-2023-tw） | validator 在 TW Core 1.0.0 閉包下本來就報 error（探針 I-* 與 CLI 一致）；漏報出現在「驗證時閉包不同」（例如 meta.profile 指向 PAS → TW Core 0.3.2 閉包，該版 CodeSystem 掛在 ValueSet URL，HL7 也只 warning）或 coding 根本沒被走到（同 #2） | 判定不變；另加 information：其他已安裝套件有同一 CodeSystem 較完整且含此碼的版本時指出 `package#version`（例：TW Core 1.0.0 `medication-nhi-tw` 35 碼 vs 0.3.2 全量） |
| 4 | `No definition could be found for URL value …/v3-ActEncounterCode` 時有時無 | 本機判定對同一輸入是確定的；CLI 只有在 `Encounter.class` 是物件時才報（R5 寫法的陣列被 parser 丟棄，兩邊都只報形狀錯誤 + min 1），所以不同回合的輸出形狀會讓結果不同。另找到兩個真的非確定來源：`definitionExists` 在 DB 錯誤時把 fail-open 的 `true` 快取 30 分鐘（期間該 URL 不再檢查）；`tableHasRows` 在 DB 錯誤時把「術語未載入」快取 30 分鐘（期間 LOINC / SNOMED / ICD 檢查靜默略過） | 兩者 DB 錯誤不再快取（缺表 42P01 仍快取）。另：直接綁定的 Coding（`Encounter.class`，extensible）以 ValueSet URL 當 system 時 HL7 只給 binding warning，不報 `The Coding references a value set`（A-class-vs，原為誤拒） |
| 5 | RxNorm Wrong Display Name | RxNorm 在 `SILENT_SYSTEMS`，完全不檢查 | `judgeRxnorm`：碼 + display 對 `rxnorm.concepts`（tx.fhir.org 接受 RXCUI 的所有 SAB=RXNORM 名稱，不分大小寫；探針 R-psn-atom / R-sy-atom 確認）；未知碼只有本機版本 ≥ tx 版本（03022026）才 error；只有偏好名稱時（舊匯入）display 不符為 warning；未載入為 warning `Display not checked (RxNorm)`。loader 改存所有 RXNORM 名稱（`alt_names`）與版本（`rxnorm.editions`，migration `20261030_rxnorm_display_names`，匯入 job 會自行套用 DDL） |

## v7.2 結果（vs CLI）

| | 一致 | 誤收 | 誤拒 |
|---|---|---|---|
| 既有 16 個 corpus（4,340 筆）修改前 | 4,339 | 1（`S-us-version-fab`） | 0 |
| 修改後 | **4,339** | **1**（同一筆） | **0** |
| v7 探針（48）修改前 | 32 | 16 | 0 |
| v7 探針修改後 | **45** | **3** | **0** |

- 既有語料本機 verdict 改變 **0 筆**；新增 error 72 則（mut_v2 `B-extnested` 的 patient-nationality / birthPlace context 錯誤），CLI 全部也有。
- v7 剩餘 3 筆：R-wrong-display / R-unknown 是資料面（production `rxnorm.concepts` 尚無 `alt_names`，版本 06032024 舊於 tx 的 03022026 → 目前只給 warning；重跑 `rxnorm_import` 後 display 錯誤即為 error，未知碼要等匯入新版 RxNorm）；X-resource-context-on-observation 是 CLI 自動載入 `hl7.fhir.uv.extensions#5.3.0`（本機未安裝；已安裝的 5.2.0 副本 context 為 `Resource`）。
- 訊息格式：`The extension <url> v<version> is not allowed to be used at this point (this element is [<paths>]; allowed for this version = e:…)`，與 CLI 的 `Extension_EXTP_Context_Wrong(_VER)` 相同；CLI 對同一 extension 會用 core 與 extensions 兩份定義各報一次，我們只用選中的那份報一次。

---

# v8：評估報告 v6 的漏報（2026-10-20）

探針 `corpus/v8_probes.json.gz`（`harness/gen_v8.py`，48 筆，45 筆為 Bundle，全部由 TW Core 1.0.0 範例合成），以 validator_cli 7.0.1 + tx.fhir.org（`-ig tw.gov.mohw.twcore#1.0.0`）產生 oracle。本輪**不碰 production DB**：只啟動 staging 的 Postgres 容器（`twh-staging-postgres-1`，與 production 相同的 IG 套件與術語版本，`rxnorm.concepts` 同樣沒有 `alt_names`）作為本機 package cache，跑完即停。「修正前」數字以 production（build aa6362c = HEAD）的 `POST /tools/fhir_validate_*` 取得（48 筆，唯讀）。

## v8.1 根因

評估端回報 6 份 bundle「明明含 `…/CodeSystem/v3-ActEncounterCode` 卻被判 valid、單獨重送又報 error」。本機以 18 種元素 / 情境（Encounter.class、Encounter.type、Condition.category、Observation.category slice、extension 的 valueCoding / valueCodeableConcept、contained、classHistory、Identifier.type、Meta.tag、Quantity.system、`|version`、無 meta.profile、R5 陣列、巢狀 Bundle、transaction、document 樣式、resource tool）對 production 逐一重送，**18/18 都報 error**，判定對同一輸入是確定的。真正的「時有時無」來自兩個基礎設施事件，production Postgres 日誌可證：

| 時間（UTC） | 事件 | validator 的行為（修正前） |
|---|---|---|
| 2026-10-19 17:48、18:13–18:19 | `column "alt_names" does not exist`（migration 20261030 尚未套用；RxNorm 查詢退回第二道 SQL） | 無害（有 fallback） |
| 2026-10-19 17:57:45 | `server process (PID 20537) exited with exit code 2` → `terminating any other active server processes` → `the database system is in recovery mode`（**Postgres 當機**，正在跑評估） | 所有定義 / 術語查詢失敗 → resolver 全部 **fail-open**（`definitionExists` → true、`codeSystemResolvable` → true、`tableHasRows` → false）→ 該 URL 不檢查、術語檢查靜默略過、剖面抓不到 → 回傳 `valid: true` 或 400 `tool_call_failed`（評估端「只看 error」兩者都等於沒抓到） |

其餘各類漏報（`extension-observation-category-tw` + slice required、`Unrecognized property`、`Invalid Resource id`、`variable`）本機探針全部命中（C-* 3/3、U-* 4/4、D-* 3/3、X-* 2/2，CLI 同），與上面同一根因。另外找到四個**確定性**的漏報與一個回報面的漏失：

| # | 漏報 | 根因 | 修正（HL7 來源） |
|---|------|------|------------------|
| 1 | `No definition could be found for URL value 'http://hl7.org/fhir/sid/icd-10-pcs'` | `fhirUriRules.ts` 的 `KNOWN_SIDS` 比 HL7 `SIDUtilities` 多了 `icd-10-pcs`、`us-mbi`、`eui-48`（「為安全起見視為已知」），URL 解析規則因此跳過 | 清單改為與反編譯的 `SIDUtilities.CODE_SYSTEMS` / `ID_SYSTEMS` / `isPassPortSID` 完全相同（`isKnownSid`）。CLI 探針確認：icd-10-pcs 只有 URL error + `UNKNOWN_CODESYSTEM` warning，**沒有** `Terminology_TX_System_Unknown`（一度加上的 `Unknown Code System` error 已拿掉以維持訊息層級的一致） |
| 2 | `The reference '…' is not a valid reference` | 沒有這條規則；含空白的參照只會「解析不到」→ collection bundle 裡只剩 near-miss warning | `checkReference`：`ref` 不符 `\S+` → error `REFERENCE_REF_INVALID_REF`（`InstanceValidator.checkReference`，rule 2025-05-07） |
| 3 | RxNorm display 是另一個藥（`code 是 thyroglobulin、display 寫 Clopidogrel`） | 本機只有偏好名稱（無 `alt_names`）時一律 warning，評估端只看 error | `displayDenotesDifferentDrug`：display 與該 RXCUI 所有已知名稱去掉劑量 / 單位 / 劑型 / 途徑 / 鹽類 / 功能詞後，沒有任何共同藥名詞（≥5 字字首相同視為同字），或不含拉丁字母（中文商品名）→ **error**，訊息為 tx 原句 + `; the display denotes a different concept: …`；同一藥的另一種寫法維持 warning（載入 alt_names 後即 error）。SNOMED / LOINC / ICD / CVX 的 display 本來就是 error（CLI 亦同），不變 |
| 4 | entry 的 resource 寫成陣列 / 缺 resourceType | `validateBundle` 只為有 `resourceType` 的 entry 產生 `entries` 列，該 entry 的 issue（`must be a simple value, not an Array` 等）**整個不出現在回應**（`valid` 已是 false，但只看 issue 的讀者看不到任何 error） | 這類 entry 的 issue 改列在 Bundle 層 `issues` |
| 5 | 查詢失敗被當成通過 | resolver 各處 fail-open（刻意「寧可放過」），DB 當機 / 復原期間回傳乾淨的 `valid: true`；validator 例外則變成 400 | `db.ts` `trackQueryFailures()`（AsyncLocalStorage）記錄驗證期間每一次失敗的 `query()`（缺表 42P01 / 缺欄位 42703 / 3F000 除外，那是設計內的 fallback）；`validateCore` 有失敗即加一則 error issue `code: "exception"`（`Validation incomplete: N … lookups failed …`），`valid: false`、`checked_fully: false`、`lookups_failed`。validator 例外、以及驗證開始前的 DB 失敗（`resolve()`）改回傳帶 fatal `exception` issue 的正常結果（HL7 validator_cli 對內部例外也是 fatal issue），不再是失敗的工具呼叫。以 `DATABASE_URL` 指向關閉的 port 驗證：兩個 tool 都回 `ok: true, valid: false, [fatal exception]` |

## v8.2 探針結果

| 類別 | 筆數 | 修正前（production）命中目標 error | 修正後（本機）| CLI |
|---|---|---|---|---|
| A 無法解析的 THO CodeSystem URL（18 種元素 / 情境） | 18 | 18 | 18 | 18 |
| P `sid/icd-10-pcs` | 5 | **0** | 5 | 5 |
| C category 寫成 extension / 錯 system（slice `category:twcore`） | 3 | 3 | 3 | 3 |
| U `Unrecognized property` | 4 | 4 | 4 | 4 |
| D `Invalid Resource id` | 3 | 3 | 3 | 3 |
| F 參照含空白 | 2 | **0** | 2 | 2 |
| X `variable`（context + var-1） | 2 | 2 | 2 | 2 |
| R RxNorm display | 4 | **0** | 3 | 4 |
| S entry 沒有可用 resource | 3 | **0**（issue 遺失） | 3 | 3 |
| **合計（應為 invalid 的 44 筆）** | 44 | **30（68.2%）** | **43（97.7%）** | 44 |
| V 有效對照 | 3 | 3 valid | 3 valid | 3 valid |

vs CLI（verdict）：48 筆 **47 一致、誤收 1、誤拒 0**。唯一不一致 `R-synonym-display`（`Thyroglobulin 100 mg tablet`）：tx.fhir.org 判 Wrong Display Name，本機只有偏好名稱、而且 display 與它共享藥名詞，依設計維持 warning；重跑 `rxnorm_import`（載入 `alt_names`）後即為 error。

## v8.3 既有語料回歸（本機 vs CLI 快取，staging Postgres 容器）

| 語料 | 筆數 | 一致 / 誤收 / 誤拒 |
|------|------|------|
| examples、bundles、mutations、user_cases、mut_dis、perf、refprobe×3、v2_probes、mut_v2、icd_v3_probes、icd_v3_mut、v4_mut、v6_probes | 4,261 | **4,261 / 0 / 0** |
| v4_probes | 79 | 78 / 1（`S-us-version-fab`，v4 起即存在）/ 0 |
| v7_probes | 48 | **46** / 2 / 0（修正前 45 / 3：`R-wrong-display` 改為命中——同 v8 #3；剩 `R-unknown`（本機 RxNorm 版本舊於 tx）與 `X-resource-context-on-observation`（CLI 自動載入 extensions 5.3.0）） |
| v8_probes | 48 | 47 / 1（`R-synonym-display`）/ 0 |
| **合計** | **4,436** | **4,432 / 4 / 0** |

既有 16 個語料 + v7（4,388 筆）：修正前 4,384 / 4 / 0 → 修正後 **4,385 / 3 / 0**，沒有新的誤拒。

## v8.4 其他

- `toolVersions.ts`：`fhir_validate_resource` / `fhir_validate_bundle` 1.6.0 → **1.6.1**，`fhir_finalize_resource` 1.3.0 → **1.3.1**；`docs/tools/fhir-ig-tools.md` 與 `.en.md` 同步更新。
- 單元測試：`src/fhirValidator.v8.test.ts`（SIDUtilities 對齊、icd-10-pcs 在 Coding / extension value 的 URL error、非 HL7 空間維持 warning、參照空白、`rxDrugWords` / `displayDenotesDifferentDrug` / `judgeRxnorm` 升級、`trackQueryFailures` + `lookupFailureIssue` + `completenessOf`）。`npm test` 956 項：955 通過、1 略過（私有 fixture 不在本機）、0 失敗；`npm run typecheck` 通過。
- 評估端 harness 注意：`compare_local.py` 把「工具呼叫失敗」算成 invalid（`ours_valid = bool(valid) and not errors`），所以 parity 數字看不到 DB 當機造成的 400；評估端只看 issue，因此看到的是「valid」。修正 #5 後兩種讀法都會看到 error / fatal。
- `harness/gen_v8.py` 的 V-* 對照把 `Encounter/enc-example` 的 `identifier.system`（`http://healthcare.example.org/…`）拿掉：example.org URL 對 CLI 與本機都是 error（`TYPE_SPECIFIC_CHECKS_DT_URL_EXAMPLE`），不是本輪的對象。

---

# v13：ValueSet canonical 當 `Coding.system`、filter 定義的 ValueSet（評估報告 v13，2026-10-25）

探針 `corpus/v13_probes.json.gz`（`harness/gen_v13.py`，18 筆，全部由 TW Core 1.0.0 範例合成），oracle 為 validator_cli 7.0.1 + tx.fhir.org（`-ig tw.gov.mohw.twcore#1.0.0`），兩種跑法：**一筆一個 JVM**（`CLI_CACHE=… cli_oracle.py` 逐筆呼叫）與**全部同一個 JVM**（一次批次）；L1 / L6 另以 7.0.3（2026-10-21）重跑，結果與 7.0.1 相同。本機以唯讀 session 連 production DB。

## v13.1 validator_cli 什麼時候報 `The Coding references a value set, not a code system`

| 探針 | 情境 | 單筆 JVM | 同一 JVM（批次） | 本機（修正後） |
|---|---|---|---|---|
| L1 / L2 / L9 / L10 | `Observation.code`（綁定 `laboratory-code-tw`）的 coding，system = `laboratory-code-tw`，code 為真 LOINC / `WBC` / NHI 碼 / `hs-Troponin I` | warning `UNKNOWN_CODESYSTEM` | **error** | **error** |
| L3 / L4 | system = 被 `laboratory-code-tw` include 的 `loinc-observation-code` / `laboratory-category-tw` | warning | **error** | **error** |
| L5 | system = 無關的 `medication-path-tw` | warning | warning | warning |
| L6 | `Observation.method` 的 coding，system = `laboratory-code-tw`（同資源的 `code` 綁定它） | **error** | **error** | **error** |
| L7 | 同 L1 但沒有 meta.profile（core 的 example 綁定） | warning | error（批次中其他檔案已載入） | warning |
| L8 | 第二個 coding（第一個是正確的 LOINC） | **error** | **error** | **error** |
| E1 / E2 | 直接綁定的 Coding（`ImagingStudy.series.modality`），system = 綁定的 ValueSet / 無關 ValueSet | 只有綁定 warning | 只有綁定 warning | 只有綁定 warning |
| E3 / E4 | `Encounter.class`（直接綁定）同上 | 只有綁定 warning | 只有綁定 warning | 只有綁定 warning |
| M1 | `medicationCodeableConcept` 的 coding，system = `medication-nhi-tw`（只綁在 `medication[x].coding` slice 上） | warning | warning | warning |
| B1 / B2 / B3 | collection Bundle：一筆 / 兩筆 lab-vs Observation / 先正確再 lab-vs | warning（B1） | **error**（每一筆） | **error** |

結論：CLI 的規則是「system 是**它已載入**的 ValueSet → error」。IG 的 ValueSet 是延遲載入的：檢查過綁定到它（或綁定到 include 它的 ValueSet）的元素之後才算已載入，因此同一個 coding 在 JVM 裡第一次出現時只有 warning，之後（同一 CodeableConcept 的下一個 coding、同資源其他元素、Bundle 後面的 entry、批次後面的檔案）就是 error。只綁在 Coding slice 上的 ValueSet（`medication-nhi-tw` / `medication-fda-tw`）與沒有任何綁定的 ValueSet（`medication-path-tw`）即使在批次中、前面先驗過「正確使用該 slice」的資源（primer），也一直只有 warning（`results` 外另以 primer 批次確認：v2 / v4 那 7 筆仍全部 valid）。評估端看到的 error 是批次（或 Bundle 第二筆起）的結果；v4 記錄的 `F2b-nhi-vs-as-system`「批次 error、單筆 valid」是同一機制（該批次中前面的資源綁定過 `medication-nhi-tw`）。

實作（與順序無關的版本）：驗證的資源 / Bundle 內**任何位置**檢查了綁定到該 ValueSet（或 include 它的 ValueSet，遞迴 4 層）的元素（非直接 Coding 的元素、required / extensible / preferred、有值）→ error（HL7 訊息、`…coding[i].system`）；否則維持 warning。HL7 core / THO 的 ValueSet 不變（任何情境都是 error）；直接綁定的 Coding 不變（v7 A-class-vs）。`fhirValidator.ts` `settleVsSystems`（驗證結束時決定，因為 CodeableConcept 的綁定在 coding 之後才檢查）。

## v13.2 根因

| # | 現象 | 根因 | 修正 |
|---|------|------|------|
| R1 | `laboratory-code-tw` 當 system、不是代碼的值（`WBC` …）在 author / assemble / `fhir_validate_bundle` 都 valid | `isValueSetUrl` 只承認 HL7 core / THO 的 ValueSet（v2 依單筆 CLI 結果決定），IG ValueSet 一律只有 `UNKNOWN_CODESYSTEM` warning；三個工具都經同一個 validator，pending-ref 過濾等都沒有吃掉 issue | v13.1 的規則；error 附 suggestions：在該 ValueSet 與其 CodeSystem 中正規化 code / display（`replace_coding`）、其 CodeSystem（`replace_system`） |
| R2 | `2160-0` 等真 LOINC 碼沒有被修正為 `http://loinc.org` | `laboratory-code-tw` = include `loinc-observation-code`（LOINC `CLASSTYPE` filter）+ include `laboratory-category-tw`（879 個健保支付碼）。本機展開只能列出健保碼，LOINC filter 部分記在 `unresolved`，但 `composeDeps.expandValueSet` 只回傳 `truncated: false` → composer 把 879 碼當成完整的 ValueSet，`codesInValueSet` 在「展開完整且非空」時直接回傳「不在 ValueSet 內」，根本沒走到 v12 的 filter / `codeInSystem` 路徑。grammar 與 raw 兩種寫法走同一條路，所以都失敗 | `expandValueSet` 回傳 `incomplete`，composer 視同截斷；另外 LOINC `=` / `in` 屬性 filter 可判定（`externalFilterMatches`：CLASSTYPE 數字或名稱、CLASS、STATUS、COMPONENT、PROPERTY、TIME_ASPCT、SYSTEM、SCALE_TYP、METHOD_TYP；值為 LOINC Part 碼（`SCALE_TYP = LP32888-7`）時以 part 名稱比對，component part 永不判「否」），所以 note 能區分 `membership confirmed` 與 `membership unverifiable; the code exists only in <CS> among the ValueSet's systems` |

## v13.3 回歸（本機 a20a4f7 vs 修正後，同一 DB）

既有 18 個語料（examples、bundles、mutations、user_cases、mut_dis、perf、refprobe×3、v2_probes、mut_v2、icd_v3_probes、icd_v3_mut、v4_probes、v4_mut、v6_probes、v7_probes、v8_probes，共 4,426 筆）：**verdict 改變 0 筆**；error 只有 1 筆文字差異（`M9-bad-code-type.0.coding.0`：`organization-type` 版本 2.0.1 / 3.0.0 與 pattern 錯誤的次數，單獨重跑時 a20a4f7 與修正後輸出完全相同——整批執行時既有的快取順序差異，與本輪無關）；其餘只有 information `could not be confirmed as members …` 對 LOINC 成員消失（LOINC filter 可判定，424 則）與 1 則 `UNKNOWN_CODESYSTEM` warning 去重。因此相對 CLI 快取的一致 / 誤收 / 誤拒與 v8.3 相同，沒有新的誤拒。（第一版把所有 IG ValueSet 都判 error 時，v2 / v4 的 7 筆 `E-method-vs-twcore`、`F2b-nhi-vs-as-system`、`X-*-vs` 會變成誤拒——CLI 單筆、批次、primer 批次都是 valid——因此收斂為 v13.1 的規則。）

v13 探針（18）：本機修正後與 CLI 批次 17/18 一致（L7 例外：批次中由其他檔案載入，單筆 CLI 與本機都是 warning），與 CLI 單筆在 L6 / L8 / E* / M1 / L5 / L7 一致，其餘差異全部是「第一次使用」的順序效應。
