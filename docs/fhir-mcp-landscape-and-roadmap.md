# FHIR MCP 工具生態盤點與本專案路線圖

**狀態：** 策略文件（調研 + 規劃，尚未變更程式碼）
**日期：** 2026-10-10
**用途：** (1) 記錄國際上 FHIR MCP 工具做了什麼、我們站在哪裡；(2) 列出有優先順序的優化路線圖；
(3) 作為向衛生福利部與開源基金會提案的底稿。

!!! warning "資料時效與驗證程度"
    調研以 2026-10-10 的 GitHub README、官方文件與媒體報導為準。星數、版本與政府計畫時程都會變動，
    引用前請再點開來源確認。文中標示 **[未能驗證]** 的項目，是搜尋不到一手來源、需要人工再查的。

---

## 0. 結論摘要（TL;DR）

- **國際上的 FHIR MCP 伺服器，九成是「對一台 FHIR 伺服器做 read / search / create / update 的薄代理」。**
  差異只在 OAuth 接線與 token 省錢技巧。真正做 profile 驗證的只有 4 個，做 ValueSet 展開的 4 個，
  能瀏覽多個 IG 的剖面並依剖面產生資源骨架的，**只有本專案**。
- **我們的弱點剛好是別人的強項：** 對外部 FHIR 伺服器的操作面太薄（沒有 `$everything`、history、
  transaction bundle 送出、分頁、FHIRPath 過濾），也沒有 SMART App Launch 的使用者情境。
- **衛福部的政策缺口和我們的強項重疊：** 2026-08 成立的國家認證實驗室明言**不認證 FHIR Server
  與 Converter**，只認證 SMART on FHIR App 與 CQL 模組；TW Core IG 的驗證教學仍指向 HL7 Java
  validator；全台醫學中心 2026 年底、區域醫院 2027 年底要完成 FHIR 互通。台灣目前**沒有 TW Core
  專屬的開源 test kit**，而澳洲（Inferno AU Core）、美國（ONC Inferno）、德國（gematik
  Referenzvalidator）都有，且都是 Apache-2.0。
- **路線圖的核心命題：** 用三個月補齊「薄代理」的 table stakes，再把 `fhir_validate_*` 擴成
  **TW Core 聯測自檢套件**，並包成 **SMART on FHIR App** 走進官方認證與 THAS 市集。
- **基金會：** 首選 Linux Foundation 旗下 2026-07 新成立的 **Open Health Stack Software Foundation**
  與 **LF AI & Data Sandbox**；在地先加入 **HL7 Taiwan** 團體會員，並透過 **開放文化基金會（OCF）**
  做財務託管。任何基金會都先看治理文件、CI 跑測試、OpenSSF 徽章與第二個貢獻組織。

---

## 1. 別人的 FHIR 工具做了什麼

### 1.1 分類

| 類型 | 代表專案 | 做什麼 |
|---|---|---|
| **A. 即時伺服器代理** | WSO2 `fhir-mcp-server`（Python，137★）、LangCare（Go，67★）、Momentum（102★，2025-10 起停更）、Medplum 內建 `fhir-request`、Aidbox（alpha）、Google MCP Toolbox（唯讀）、AWS HealthLake（官方，含 bulk import/export）、Azure 社群版 | 把 `read / search / create / update / delete` 包成 MCP 工具，重點在 OAuth2 / SMART Backend Services / IAM 的接線 |
| **B. 驗證與術語** | CSIRO `aehrc/mcp-fhir-tools`（包 HL7 validator + Ontoserver）、`fhir-mcp-suite`（HAPI 驗證 + tx.fhir.org 術語 + OpenFDA 交互作用，0★）、`rlinlen/fhir-validator-agent`（**預設 TW Core**，包 Java validator，0★）、多個 tx.fhir.org 包裝器 | 把官方驗證器或外部術語伺服器轉成 MCP 工具；自己不持有資料 |
| **C. 授權 / 工具箱** | HealthChain（Python SDK，229★，`build_resource` / `validate_resource` / `lookup_code`）、`medvertical/records-agent-tools`（FSH / IG Publisher 診斷 skills）、`fhir-augury`（索引 HL7 Jira / Zulip / FSH 供搜尋） | 以 SDK 或 skills 形式協助寫資源，驗證多為子集 |
| **D. 守門 / 安全代理** | `HealthClawGuardrails`（27 個工具、Safe-Harbor 去識別、propose/commit 兩段式寫入）、`fhirHydrant`（SMART Backend Services、batch/transaction、`$validate`、dry-run 寫入） | 在任意 FHIR 伺服器前加一層權限、去識別與稽核 |

### 1.2 能力矩陣（✓ 已在 README / 文件驗證；~ 部分；空白 = 無或未能驗證）

| 能力 | WSO2 | LangCare | fhir-mcp-suite | Medplum | Aidbox | AWS | fhirHydrant | aehrc | HealthChain | HealthClaw | **本專案** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 即時伺服器 read / search | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | ~（`crud_fhir_server`） |
| 寫入（C/U/D） | ✓ | C/U | | ✓ | ✓ | ✓ | 選用 | | | 兩段式 | 允許清單 + `confirm_write` |
| `$everything` / 擴充操作 | ✓ | | | ✓ | | ✓ | ✓ | | | | |
| batch / transaction 送出 | | | | 原生 | | | ✓ | | | | 只能組裝 |
| SMART / OAuth 到 EHR | 授權碼 | Backend Services | | OAuth2 | 政策 | SigV4 | Backend Services | | | | 授權碼 + client credentials + `private_key_jwt` |
| 剖面驗證 | | | HAPI | | ✓ | | 轉 `$validate` | HL7 validator | 子集 | 子集 | **行程內**（結構 + slicing + FHIRPath 不變式） |
| ValueSet 展開 / 碼查詢 | | | ✓ | | | | 僅查詢 | 僅查詢 | 查詢 | | ✓ |
| 多 IG 剖面 / element 瀏覽 | | | | | | | | | | | **✓（唯一）** |
| 依剖面產生骨架 + 定稿 | | | | | | | | | build | | **✓（唯一）** |
| 藥物交互作用 | | | ✓ | | | | | | | | |
| bulk import / export | | | | 伺服器端 | | ✓ | | | | | |
| CDS Hooks / Subscriptions | | | | | | | | | | 主題列表 | |
| SQL-on-FHIR（ViewDefinition） | | | | | | | | | | | |
| 去識別 / PHI 遮罩 | | 僅日誌 | | | | | | | | ✓ | |
| 自然語言 → 搜尋參數規劃 | | | | | | | | | | | |
| 語意 / 向量搜尋 | | | | | | | | | | | ✓（ICD / 藥品 / 術語） |
| FHIRPath 回應過濾 | ✓ | | | | | | ✓ | | | | |
| 臨床計算器 | | | | | | | | | | | ✓ |

### 1.3 誰有真正的聲量，為什麼

| 專案 | 聲量來源 |
|---|---|
| AWS HealthLake MCP | 官方出品、Bedrock AgentCore 整合、PyPI 持續發版；有 CVE 代表真的有人用 |
| Medplum | 內建於廣泛使用的開源 EHR 平台，提供託管端點 |
| Google MCP Toolbox | 搭便車在通用的 `genai-toolbox` 裡發行 |
| WSO2 | 專用 FHIR MCP 中星數最高，有品牌、Epic sandbox 示範、100+ 測試 |
| HealthChain | 以 SDK 身分進入 LangChain 生態，MCP 只是其中一個輸出面 |

其餘專案幾乎都 < 35★、單人維護，一半以上超過 9 個月沒更新或已封存。
**本專案以 165★ 排在大型廠商之後，是專用 FHIR MCP 中第二高**，也是唯一同時具備術語、多 IG 授權 / 驗證、
受控 CRUD 的專案。

### 1.4 沒有人做好的事（機會清單）

1. **IG 授權的端到端**：沒有任何 MCP 包 SUSHI / IG Publisher，沒有工具能產生 StructureDefinition 或 ValueSet。
2. **SQL-on-FHIR / ViewDefinition**：零實作。
3. **自然語言 → FHIR 搜尋參數規劃**：所有伺服器都假設 LLM 自己知道搜尋參數。
4. **術語 + 即時資料 + 驗證三合一**：只有 0★ 的 `fhir-mcp-suite` 嘗試過。
5. **Subscriptions / CDS Hooks**：幾乎沒有。
6. **寫入安全**：只有 HealthClaw、last-ehr 和本專案有兩段式確認。
7. **非美國在地化**：只有澳洲（aehrc）與台灣（本專案、rlinlen）；歐盟、日、韓的 core IG 都沒有。
8. **R5 / R6**：幾乎都寫死 R4。

---

## 2. 本專案目前的位置

### 2.1 已經有、而且少見的

- 19 個 `fhir_*` IG 工具：多 IG 套件註冊表（可直接從 `packages.fhir.org` 拉取）、剖面 / element / slicing /
  choice / binding 檢視、ValueSet 展開（內嵌 + 本地 SNOMED / LOINC / ICD + 相依套件）、
  `fhir_normalize_code`（自由文字 → 標準碼）、骨架填值（`fhir_get_resource_skeleton` →
  `fhir_finalize_resource`）、參照解析、Bundle 組裝、行程內驗證器。
- 外部伺服器：三種 OAuth 模式（授權碼含加密 grant 與自動 refresh、client credentials、`private_key_jwt`
  含公開 JWKS）、每台伺服器的資源型別與操作允許清單、寫入需 `confirm_write`、token 絕不經過 MCP 呼叫端。
- 本地持有完整 ICD-10-CM/PCS、LOINC、SNOMED CT、RxNorm、TFDA 藥品，與 TW Core v1.0.0（與衛福部現行正式版同步）。
- 60 個工具中 FHIR 以外的臨床工具（檢驗判讀、藥丸辨識、仿單 OCR + LLM、臨床計算器）是其他 FHIR MCP 都沒有的脈絡。

### 2.2 相對於同行的弱點

| 弱點 | 影響 |
|---|---|
| `crud_fhir_server` 只有 `metadata / read / search / create / update / patch / delete` | 沒有 `$everything`、`history`、`vread`、transaction bundle 送出、遠端 `$validate`、分頁 `next` 跟隨 |
| 沒有 SMART App Launch（EHR launch / 使用者情境） | 進不了 THAS 市集與認證實驗室的 SMART App 賽道 |
| 驗證器對外部 ValueSet 與 `memberOf` 只能回警告 | 與官方 HL7 validator 結果不一致時難以說服醫院 |
| `audit.query_log` 表存在但後端未寫入 | 稽核是每個基金會與衛福部 GenAI 指引都會問的第一題 |
| 無 PHI 遮罩選項 | 透過 LLM 讀取真實病歷時缺少最後一道防線 |
| 無 CI 跑測試、無 GOVERNANCE / SECURITY / CoC 獨立檔、無 SBOM | 基金會入門門檻與衛福部 2026-05 SBOM 方針 |

---

## 3. 優化路線圖

原則：先補別人都有的，再放大別人都沒有的；每一項都對應到一個可交付的工具或檔案，
並且沿用既有設計規則（同一份資料的多種視圖收斂到 `view` / `operation` 參數，不增加工具數）。

### Phase A — 補齊 table stakes（約 4–6 週）

| # | 項目 | 做法 | 主要檔案 |
|---|---|---|---|
| A1 | `crud_fhir_server` 新增 `operation`：`everything`、`history`、`vread`、`transaction`（送出 batch / transaction Bundle）、`validate`（遠端 `$validate`）、`page`（跟隨 `next` link） | 擴充 `operationToRequest()`，寫入類仍受 `confirm_write` 與允許清單約束；`transaction` 視為寫入 | `fhirServerService.ts`、`mcp.ts`、`docs/tools/fhir-server-tools.md` |
| A2 | `fhirpath_filter` 參數：對回應套 FHIRPath 投影，省 token | 已有 `fhirpath` 相依 | `fhirServerService.ts` |
| A3 | `fhir_describe_server_search`：依 CapabilityStatement 列出某資源型別可用的搜尋參數與操作（對應 WSO2 `get_capabilities`） | `capability_summary` 已存，加解析 | `fhirServerService.ts` |
| A4 | 落實 `audit.query_log` 寫入（SHA-256 參數、工具名、耗時、狀態） | 在 MCP 工具呼叫的共用包裝層寫入；表已在 `db/schema.sql` | `mcp.ts`、新 `auditService.ts` |
| A5 | CI：GitHub Actions 跑 `npm run typecheck` 與 `npm test`（`node-server/` 與 `web/`） | 現在只有 `deploy-docs.yml` | `.github/workflows/ci.yml` |

### Phase B — 放大國家級缺口：TW Core 聯測自檢套件（約 8–10 週）

| # | 項目 | 做法 |
|---|---|---|
| B1 | **`fhir_run_conformance_suite`**：對一台已登錄的外部伺服器，依指定 IG 逐 profile 抽樣（`search` → `validate`），產出 must-support 覆蓋率、binding 違規、slicing 錯誤的報告（OperationOutcome + 摘要） | 組合 A1 與既有 `fhir_validate_resource`；參考 ONC Inferno 與 HL7 AU 的 AU Core Test Kit 的測試分組 |
| B2 | 以 TW Core 官方 98 個 example 建立**回歸測試**，確保驗證器對官方範例全數通過，並對刻意破壞的變體全數攔截 | 放在 `node-server/src/fhirValidator.test.ts`；這也是向衛福部展示可信度的最便宜證據 |
| B3 | **官方 validator 對照模式（選用）**：`validator: builtin \| hl7` 設定開關，`hl7` 走一個可選的 Java sidecar 容器，回傳結果並標示 `source` | 衛福部驗證教學指向 `validator_cli.jar`；提供對照模式可消除「你們的驗證器和官方不一樣」的質疑。預設仍為行程內，不改變 compose 預設 |
| B4 | 術語委派：`TERMINOLOGY_SERVER_REQUIRED` 時可委派給設定的外部術語伺服器（tx.fhir.org、Ontoserver、未來的衛福部術語服務），並新增 `fhir_translate_code`（ConceptMap `$translate`，TW Core 已含 6 個 ConceptMap + 本地 SNOMED↔ICD 對應）與 `fhir_subsumes`（SNOMED 子孫查詢已存在） | `fhirTerminology.ts`，設定存 `admin.app_settings` |
| B5 | 匯入健保署 IG 系列（TWNHIBASE、PAS 事前審查）為額外套件，示範「癌藥事前審查 Bundle」從 ICD / 藥品 → 骨架 → 驗證 → 送出的完整流程 | 多 IG 架構已支援；需處理 PAS 相依 TW Core 舊版的版本分歧 |
| B6 | `fhir_normalize_code` 批次版與 provenance 強化，對準衛福部「病歷 → SNOMED / LOINC」LLM 轉換器路線 | 回傳候選、信心、來源 ConceptMap / embedding 距離，供人工覆核 |

### Phase C — 沒有人做的差異化（約 8 週，可與 B 並行）

| # | 項目 | 為什麼 |
|---|---|---|
| C1 | **SMART on FHIR App 包裝**：以 EHR launch 取得病人情境，透過本專案工具提供「編碼 / 驗證 / 用藥查詢」側欄 | 這是認證實驗室唯一認證的軟體型態，也是 THAS 市集入口；第一屆 50 件入選已有 ICD-10 自動編碼類 |
| C2 | **`fhir_plan_search`**：給資源型別與自然語言意圖，依 IG 內 SearchParameter artifacts 與伺服器 CapabilityStatement 回傳排序過、附理由的搜尋參數組合 | 全球零實作；我們已把 SearchParameter 存為 artifact |
| C3 | **`fhir_run_view_definition`**：在 Bundle 或搜尋結果上執行 SQL-on-FHIR ViewDefinition，輸出表格 | 全球零實作；純 FHIRPath，行程內可做；對接健康台灣深耕計畫的指標統計需求 |
| C4 | `crud_fhir_server` 的 `redact: safe_harbor` 選項：回傳前遮罩 18 類識別欄位 | 對應衛福部 2026-05 醫療機構生成式 AI 指引的風險項 |
| C5 | SBOM（CycloneDX）隨 release 產出；`publiccode.yml` | 衛福部 2026-05 醫療 AI SBOM 方針；數發部公共程式平台格式 |

### Phase D — 開源治理（與 A 同步開始，持續）

- `GOVERNANCE.md`、`CODE_OF_CONDUCT.md`（從 `CONTRIBUTING.md` 抽出）、`SECURITY.md`（含漏洞回報信箱與 SLA）、DCO。
- OpenSSF Best Practices Passing 徽章（LF AI & Data Sandbox 的硬性要求）。
- 版本：打 `v0.2.0` tag 與 GitHub Release，CHANGELOG 補上 49 → 60 工具的差異。
- 公開託管的唯讀示範端點 + MCP registry `server.json`，讓「一個網址就能試」。
- 找到**第二個貢獻組織**（醫院資訊室、醫資所、HL7 Taiwan 會員），這是所有基金會 Incubation 的門檻。

---

## 4. 政策對接：衛福部的入口

| 入口 | 現況（2026-10） | 我們怎麼進 |
|---|---|---|
| 臺灣醫療資訊標準大平台 TWCDI / IG 提案 | 2025-11 有提案說明會；2026 年版時程 **[未能驗證]** | 提交「TW Core 開源驗證工具鏈」為 IG 配套工具；順帶建議 TW Core IG 原始碼加上開源授權（目前公開但無 LICENSE） |
| 台灣聯測松（MISAT 主辦） | 2026 場 6 月已結束 | 以 B1 聯測自檢套件報名 2027 場，提供「聯測前自檢」服務給參測醫院 |
| 國家數位健康互通性與效能認證實驗室 | 2026-08-18 成立；只認證 SMART on FHIR App / CQL 模組 / TSP | 以 C1 的 SMART App 送認證；FHIR server 本體不在賽道內，不要用那個身分去提 |
| THAS 國家級 SMART App 市集 | 第一屆 2026-04 頒獎（115 選 50）；第二屆時程 **[未能驗證]** | C1 完成後報名 |
| 健康台灣深耕計畫範疇三（114–118 年） | 評比指標含「使用 SMART on FHIR 模式之 AI 數量」 | 開源專案不直接受補助；與申請醫院合作，成為其方案中的工具 |
| 國科會智慧醫療關鍵技術專案 | 每年 2 月截止 | 與學研單位共提 |
| 數發部《公部門開源軟體應用參考手冊》（2026-04） | CC0 發布 | 提案時引用，作為機關採用 MIT 專案的政策依據 |

**提案敘事（一句話）：** 「TW Core v1.0.0 相容、可自架、MIT 授權的 FHIR 驗證與術語工具鏈，
讓醫院在 2026–2027 互通期限前能用 AI 助理自檢並修正資料品質，並以 SMART on FHIR App 形式進入
國家認證與市集。」

**提案時要主動說清楚的邊界：**

- 本專案是**工具層**，不是自主代理；每個工具唯讀，唯一能寫的 `crud_fhir_server` 需雙重確認。
  這與 2026-05 生成式 AI 指引「AI Agent 系統暫不納入」的分界一致。
- 驗證器是**預檢**，不取代官方 HL7 validator；B3 的對照模式就是為了讓這句話可被驗證。
- 不做診斷宣稱，避免落入醫療器材軟體定義。

---

## 5. 開源基金會路徑

| 組織 | 契合度 | 入門門檻 | 建議 |
|---|---|---|---|
| **Open Health Stack Software Foundation**（LF，2026-07 成立，Google.org 與 WHO 支持） | 高 | 剛成立，細則待公布；有 Implementer Program | **首選**，先以 FHIR 工具貢獻者身分接觸 |
| **LF AI & Data（Sandbox）** | 中 | OSI 授權、既有會員 sponsor、技術章程、OpenSSF Passing、DCO；Incubation 需 ≥ 3 個組織貢獻、≥ 500★ | 完成 Phase D 後提 Sandbox |
| **HL7 Taiwan** | 高 | 團體會員，理事會通過 | 立即加入，取得 IG 提案與聯測的正當性 |
| **開放文化基金會 OCF** | 高（在地） | 財務託管、商標與法律保護 | 若要接政府委託或捐款又不設法人，走 OCF |
| OpenJS Foundation | 中低 | 2 位 CPC sponsor | 備案 |
| Apache Incubator | 低 | 需改 Apache-2.0、Champion、多元 committer | 不建議 |
| Twinkle AI 社群 | 高 | 無 | 合作上架 Twinkle Hub，互相引用 |

授權：MIT 可直接進 LF 系統；只有 Apache 需要改授權。若日後考慮專利保護，可評估改為 Apache-2.0，
但這會影響既有 fork，不急。

---

## 6. 可比對象（提案時的佐證）

| 國家 | 工具 | 授權 | 主辦 |
|---|---|---|---|
| 美國 | ONC Inferno（(g)(10) 認證測試站） | Apache-2.0 | MITRE / ONC |
| 澳洲 | AU Core Inferno Test Kit、Sparked | Apache-2.0 | CSIRO / HL7 AU |
| 德國 | gematik Referenzvalidator | Apache-2.0 | gematik |
| 國際 | HL7 FHIR Validator（`org.hl7.fhir.core`） | Apache-2.0 | HL7 |
| 台灣 | TW Core IG 原始碼 | **無授權檔** | 衛福部資訊處委外（工研院為主）**[部分驗證]** |

台灣 2020 年口罩地圖的「政府供資料、社群供工具」模式，與本專案對 TFDA、健保開放資料的用法同構，
是對衛福部最容易理解的在地先例。

---

## 7. 需要人工再查的項目

- 2026 年 TWCDI / IG 提案說明會與 THAS 第二屆徵案時程。
- 認證實驗室的申請流程與費用。
- FHIR Box 與衛福部 LLM 標準轉換器是否開源釋出。
- 負責任 AI 執行中心 2026 第二期徵案。
- HL7 Taiwan 現行會費與入會表單。
- 數發部 code.gov.tw 是否收錄民間專案。
- Open Health Stack Software Foundation 的正式入會細則。

---

## 8. 來源

國際專案：
[wso2/fhir-mcp-server](https://github.com/wso2/fhir-mcp-server) ·
[langcare/langcare-mcp-fhir](https://github.com/langcare/langcare-mcp-fhir) ·
[pcmedsinge/fhir-mcp-suite](https://github.com/pcmedsinge/fhir-mcp-suite) ·
[the-momentum/fhir-mcp-server](https://github.com/the-momentum/fhir-mcp-server) ·
[Medplum MCP](https://www.medplum.com/docs/ai/mcp) ·
[Aidbox MCP](https://www.health-samurai.io/docs/aidbox/modules/other-modules/mcp) ·
[Google Cloud Healthcare API × MCP Toolbox](https://docs.cloud.google.com/healthcare-api/docs/tutorials/pre-built-tools-with-mcp-toolbox) ·
[awslabs/mcp healthlake-mcp-server](https://github.com/awslabs/mcp/tree/main/src/healthlake-mcp-server) ·
[aehrc/mcp-fhir-tools](https://github.com/aehrc/mcp-fhir-tools) ·
[rlinlen/fhir-validator-agent](https://github.com/rlinlen/fhir-validator-agent) ·
[healthchainai/HealthChain](https://github.com/healthchainai/HealthChain) ·
[faulkj/fhirHydrant](https://github.com/faulkj/fhirHydrant) ·
[aks129/HealthClawGuardrails](https://github.com/aks129/HealthClawGuardrails) ·
[medvertical/records-agent-tools](https://github.com/medvertical/records-agent-tools) ·
[awesome-healthcare-mcp-servers](https://github.com/rdmgator12/awesome-healthcare-mcp-servers)

台灣政策：
[TW Core IG v1.0.0](https://twcore.mohw.gov.tw/ig/twcore/index.html) ·
[TW Core 驗證教學](https://twcore.mohw.gov.tw/ig/twcore/validates.html) ·
[MOHW_TWCoreIG_Build 原始碼](https://github.com/cctwFHIRterm/MOHW_TWCoreIG_Build) ·
[健保署 FHIR IG（TWNHIFHIR）](https://github.com/TWNHIFHIR) ·
[臺灣醫療資訊標準大平台](https://medstandard.mohw.gov.tw/) ·
[國家數位健康互通性與效能認證實驗室](https://medstandard.mohw.gov.tw/digital-health-cert-lab-2026) ·
[FHIR 介紹及提案說明會（2025-11）](https://dep.mohw.gov.tw/DOIM/cp-936-84314-114.html) ·
[2026 台灣聯測松](https://dep.mohw.gov.tw/DOIM/cp-936-86750-114.html) ·
[臺灣 50 優良 SMART 應用程式](https://blog.mohw.gov.tw/2058/) ·
[FHIR Box（國科會第 21 次委員會議）](https://www.mohw.gov.tw/cp-7399-86614-1.html) ·
[醫學中心 2026 年底互通時程（中央社）](https://www.cna.com.tw/news/ahel/202604130151.aspx) ·
[醫療機構應用生成式人工智慧指引（理律摘要）](https://www.leeandli.com/TW/Newsletters/7656.htm) ·
[醫療 AI SBOM 方針（iThome）](https://www.ithome.com.tw/news/175594) ·
[健康台灣深耕計畫](https://htsprout.nhri.org.tw/UploadFile/DHPlan_1140227.pdf) ·
[數發部公部門開源軟體應用參考手冊](https://moda.gov.tw/digital-affairs/democracy-network/services/19352)

基金會與可比對象：
[Open Health Stack Software Foundation](https://blog.google/innovation-and-ai/technology/health/open-health-stack-software-foundation/) ·
[LF AI & Data 專案生命週期](https://github.com/lfai/proposing-projects/blob/master/ProjectLifecycle.md) ·
[OpenJS 專案進程](https://github.com/openjs-foundation/cross-project-council/blob/main/PROJECT_PROGRESSION.md) ·
[HL7 Taiwan](http://www.hl7.org.tw/) ·
[開放文化基金會](https://ocf.tw/p/ocf) ·
[ONC Inferno](https://github.com/inferno-framework/inferno-core) ·
[Inferno AU Core](https://inferno.hl7.org.au/) ·
[gematik Referenzvalidator](https://github.com/gematik/app-referencevalidator)
