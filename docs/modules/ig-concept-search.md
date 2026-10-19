# IG 術語搜尋（IG Concept Search）

把中英文自由文字、縮寫或病歷寫法對應到**任何已安裝 IG 的 CodeSystem** 代碼——例如 TW Core
`medical-service-payment-tw`（健保醫療服務給付項目代碼）、職業分類、就醫科別、藥品使用頻率，或 PAS 的 CodeSystem。
程式在 `node-server/src/conceptSearch/`，由 `fhir_normalize_code`（目標為 IG CodeSystem 時）與
`search_medical_codes(system=…)` 使用；SNOMED CT / LOINC / ICD-10 仍走各自的資料表。

## 會被搜尋的名稱

每個 IG CodeSystem 由 `ig_import`（安裝 IG 後自動）或 `ig_concept_index`（補建 / 重建）建立索引：

| 來源 | 說明 |
|------|------|
| CodeSystem 原始 JSON | display、**所有語言的 designation**（例如 TW Core 已附的英文名稱）、巢狀 `concept.concept`、字串型 property（例如成分）、短的 definition（≤ 120 字，低權重） |
| CodeSystem supplement | FHIR R4 `content = supplement`，依 `supplements`（可含 `|version`）合併 designation 與 property；IG 套件內附的與管理後台上傳的都會套用。數值型的使用量 property（code 或描述含 `claim-volume` / `usage` / `popularity` / `申報量` / `使用量`，例如健保署「診療項目醫令申報量(年)」做成的 `claim-volume`）不當成名稱，而成為排序用的**使用量先驗**（見下方「融合」） |
| 連結名稱 | Coding 型 property（例如 supplement 的 `loinc`）與 IG 內 ConceptMap（`group.source` 為該 CodeSystem）的目標：LOINC 取共同的 COMPONENT、SNOMED 取描述，其他取 coding 的 display |
| UMLS（選用） | 概念的英文名稱若剛好是某個 UMLS 概念（CUI）的字串，該 CUI 的其他同義字 / 縮寫成為**只用於比對**的詞（每概念最多 12 個） |

由 ICD / LOINC / SNOMED 資料表提供的 CodeSystem（`icd-10-cm-*-tw` 等）不建索引。索引以簽章判斷是否需要重建，
未變動的 CodeSystem 會略過。

## 查詢處理

- **正規化**：NFKC（全形 → 半形）、大小寫、各種破折號、異體字（臺/台、脢/酶…）、量詞前的中文數字（小於五公分 → 小於5公分）、
  `cm` → 公分、`<` → 小於、點號縮寫（C.R.P → crp）、`w/o`。
- **去除病歷雜訊**：左右側、`x1`、`5針`、縫線規格（4-0 Nylon）、`r/o`、`f/u`、`s/p`、給藥 / 採檢頻率（`q6h`、`q3m`、`bid`、`prn`）、
  帶單位的數值與劑量（`7.8%`、`0.5mg`、`25 cmH2O`、`28Fr`、`2.4 ATA`）與小數檢驗值（`Hb 9.1`）。大小（公分）、時間長度與年齡保留。
- **速記詞**：以 `&` / `/` 連接的短速記（`I&D`、`U/A`、`B/C`）視為一個詞，其中各段仍各自是詞（`Na/K` → na、k）。
- **斷詞**：英文詞（字尾 -s / -ing / -ed 簡化）、中文雙字詞加低權重單字；查詢中不存在於索引的英文截詞會以字首比對
  （abd → abdominal、vanco → vancomycin）；7 個字母以上的英文詞，名稱裡沒有它時也以前 6 個字母相同的其他詞形打折比對
  （recurrent ↔ recurrence、laparoscopic ↔ laparoscopy）。
- **查詢變體**（各自評分取最佳，多個變體一致時再加分）：原文、去雜訊、去括號、縮寫展開、中 ↔ 英橋接、UMLS 同義字。
  縮寫與橋接全部來自資料：SNOMED CT「ACR - 展開」描述、LOINC shortname ↔ component、IG 名稱內定義的縮寫
  （「… lithotripsy (ESWL)」，Schwartz–Hearst 驗證）、ICD-10 / IG 中英對照名稱挖出的英 ↔ 中詞對（Dice + 雙向最佳配對）、
  `grounding/twLexiconData.ts` 的 abbrev / zhEn 表，以及（選用）UMLS。全部存在 `fhir.term_thesaurus` / `fhir.umls_terms`。
- **一般縮寫表補缺**（選用，`fhir.abbreviation_lexicon`，SPECIALIST Lexicon 的 LRABR，隨 UMLS 檔載入）：查詢**第一個子句**中的縮寫，
  若 CodeSystem 本身沒有這個字（例如「Procalcitonin (PCT)」已含 PCT）、上述縮寫表的展開也都不被 CodeSystem 支持
  （支持度 < 0.45），才從縮寫表取候選意義。一般縮寫表一個縮寫常有數十個意義（LP → lipoprotein、lumbar puncture …），
  每個意義以「CodeSystem 自己的名稱能多好地命名它」評分：該意義單獨查詢的最佳字詞分數（上限 1）+ 0.3 × 該概念的使用量，
  支持度 ≥ 0.45 才採用、同一概念只留一個讀法，依分數排序成為查詢變體（第一名也送去 embedding）。
  大寫縮寫（PLEX、BMA）只套用在寫成縮寫樣子的詞；小寫截詞（chole、trach）只套用在 CodeSystem 不認得的詞；
  少於 3 個字母 / 數字的縮寫太歧義不展開；單字展開必須是截詞（trach → tracheostomy），ABO → antibody 這類只是字母剛好出現的不採用。
  後面子句（適應症、備註）裡的縮寫不展開，以免錯誤意義帶進雜訊。
- **評分**：類 BM25 加查詢 / 名稱涵蓋率；**原文**與某個名稱完全相同才算 `exact`，一定排第一（官方中文名稱直接查詢的 top-1 ≥ 98%）。
- **語意**：與 ICD 相同的 embedding 模型與身分（`ig_embed` 工作，向量以 `sha256(名稱)` 定址，同名只嵌一次）；
  查詢時把核心句、縮寫展開句與第一個子句一次送去 embedding，對該 CodeSystem 的向量做精確掃描（不建 HNSW）。
  概念數超過 20,000 的 CodeSystem 只建字詞索引。embedding 不可用或該 CodeSystem 尚無向量時回 `search_mode: "keyword_only"`。
- **融合**：0.55 × 字詞分數 + 0.45 × 語意分數（語意相似度在該查詢自己的相似度分布內重新縮放：最佳 = 1、第 40 名 = 0，再乘上信心值＝最佳與第 40 名差距 ÷ 0.12；不再用絕對下限 0.7——絕對相似度因模型而異，Qwen3-Embedding-4B 加查詢指令後最佳匹配約 0.6–0.75。查詢向量帶 `ig_concept` 任務指令）。
- **使用量**（CodeSystem 有使用量 property 時才生效，沒有時排序與以前相同）：
  - 先驗：+ 0.3 × 使用量（以對數換成 0–1，相對於該 CodeSystem 最常用的碼）；
  - **同族排序**：`group` 相同的近似碼（同一名稱主幹，只差方法 / 場合 / 大小等限定詞，例如「白蛋白」與「白蛋白(免疫比濁法)」、
    「血液透析(一次)-住院 / -門診」）中，查詢**分不出來**的成員——涵蓋的查詢字詞與最佳成員相同（差距 ≤ 0.05）、精確比對狀態相同；
    查詢沒有任何字詞命中時則是語意相似度差距 ≤ 0.02——改依使用量排序，而不是由向量雜訊決定。整族在候選中的位置不變，只換由誰代表；
    查詢寫出限定詞（「住院 洗腎」、「復發性」）時，該成員涵蓋較多字詞，不會被使用量蓋過。
- **多項目句子**（「Na/K/Cl」、「CBC/DC, Hb …」）：回應附 `clauses`（每個子句各自最佳的代碼，依原文順序），
  排序對第一個子句的概念略加分。

## 回應欄位

`fhir_normalize_code` 的 IG 候選：`code`、`display`、`source`（`lexical` / `semantic` / `hybrid`）、`score`、
`matched_term` / `matched_language`（命中的 IG 名稱，**永遠是 IG 自己的 display 或 designation，不會是 UMLS 字串**）、
`exact`、`category`（CodeSystem 有分類 property 或階層時）、`group` + `siblings`（名稱主幹相同的近似碼，例如同一檢驗的不同方法）。
`system` 可給 canonical、CodeSystem id 或別名字詞（例如 `nhi_payment`）。`fhir_lookup_code` 查不到時附 `hint` 與 `near_codes`。

## 管理後台（IG 套件庫 → 術語搜尋索引）

- 索引 / 向量 / 縮寫表狀態；「補建索引」（未變動者略過）與「全部重建」。
- **上傳 CodeSystem supplement JSON**（`application/fhir+json`，上限 64 MB），列表顯示已套用的套件版本；上傳或刪除會自動重建受影響的索引。
  API：`GET/POST/DELETE /admin/api/igs/supplements`、`GET /admin/api/igs/concept-index`、`POST /admin/api/igs/concept-index/rebuild`。

## UMLS（選用，需 UMLS 授權）

沒有 UMLS 時引擎照常運作（只是少了 UMLS 同義字）。啟用方式：

1. 產生精簡檔（由同一個解析器寫出，約 36 MB）：
   `node dist/loaders/umls.js --subset umls-2024AA-metathesaurus-full.zip umls-subset-2024AA.rrf.gz`
   （也可直接上傳 Metathesaurus zip 或只含 `META/MRCONSO.RRF` + `META/MRSAB.RRF` 的 zip；解析器逐成員串流讀取，
   但完整 4 GB zip 經由網頁上傳不實際，建議上傳精簡檔。）
2. 管理後台上傳來源 `ig / umls_metathesaurus`，執行 `umls_import` 工作；完成後自動重建索引。

**使用的來源詞彙（SAB）**：MRSAB 中 `CURVER = Y` 且 `SRL = 0` 者，加上 `SNOMEDCT_US`（本系統持有 SNOMED CT 授權）；
排除非臨床術語來源：HGNC、OMIM、GO、NCBI、LCH、LCH_NW、SRC、MTHMST*、UWDA、FMA、MTHSPL、USP、USPMG、HL7V2.5、HL7V3.0、
CDCREC、MVX、CVX、TKMT、SPN、MCM、QMR、RAM、CCS、CCSR_*、DXP、ICPC。只取 `LAT = ENG`、`SUPPRESS = N`、長度 ≤ 80 的字串，
且只保留至少有 2 個不同字串的概念（2024AA：約 253 萬字串 / 76 萬概念，`fhir.umls_terms` 約 610 MB）。
來源 SAB 只記在內部（`fhir.concept_index_terms.source`），**UMLS 字串不會出現在任何工具輸出**。

**縮寫表（選用）**：SPECIALIST Lexicon（NLM Lexical Systems Group）的 `LRABR`（`LEX.tgz` 內 `LEX/LRABR`，約 20 MB；開源、免費取得，不需 UMLS 授權），
只取 acronym / abbreviation、縮寫 2–10 字元、展開 3–80 個 ASCII 字元，拼法變體（plasma exchange / plasma-exchange）合併
（2024 版約 11.5 萬筆 / 3.4 萬個縮寫）。產生精簡檔時加上第三個參數即可一併帶入：
`node dist/loaders/umls.js --subset <umls.zip> umls-subset-2024AA-lrabr.rrf.gz LEX/LRABR`；
若上傳的 UMLS zip 本身含 `LRABR` 成員也會讀取。`umls_import` 只有在檔案帶有縮寫表時才取代 `fhir.abbreviation_lexicon`
（需先套用 migration `20261027_abbreviation_lexicon.sql`；沒有該表時記錄警告並略過）。縮寫表字串同樣**只用於比對，不會出現在工具輸出**。

## 工作與資料表

| 工作 | 說明 |
|------|------|
| `ig_import` | 安裝後即建立該批套件的索引，再排入 `ig_embed` |
| `ig_concept_index` | 補建 / 重建索引（選項：`packages`、`force`、`embed_max_concepts`、`thesaurus`、`queue_embed`），之後重建縮寫表並視需要排入 `ig_embed` |
| `ig_embed` | 為可嵌入的名稱補齊向量（增量、內容定址） |
| `umls_import` | 載入 UMLS（選用；檔案帶 LRABR 時一併載入縮寫表），之後排入 `ig_concept_index` |

資料表：`fhir.concept_index_cs` / `_concepts` / `_terms`、`fhir.concept_embeddings`、`fhir.term_thesaurus`、
`fhir.codesystem_supplements`（migration `20261022_ig_concept_search.sql`），`fhir.umls_terms` / `fhir.umls_release`
（`20261023_umls_terms.sql`），`fhir.abbreviation_lexicon`（`20261027_abbreviation_lexicon.sql`）。

## 限制

- 台灣病歷特有縮寫（NSD、Foley、OB、echo 指超音波…）多數不在 SNOMED / LOINC / UMLS / LRABR 中，仍可能找不到；
  只有 2 個字母的縮寫（PD、LP、VF）不從一般縮寫表展開，靠 CodeSystem 自身、縮寫表與 embedding 判斷。
- 只有中文名稱、沒有英文 designation 的 CodeSystem（例如職業分類）對英文查詢只能靠 embedding。
- 概念數很大的 CodeSystem（數萬筆）第一次查詢需數秒載入索引，之後快取於記憶體。
