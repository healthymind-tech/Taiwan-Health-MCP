# 測試資料檔清單

這份文件記錄「**從零重建整套系統**」時實際用到的來源檔：每個檔案從哪裡來、放在哪裡、
餵給哪個模組。2026-07-14 的全清重建（`docker compose down -v` → `up -d --build` →
重新匯入所有模組）就是照這份清單做的。

`fhir-code/` **不在版控裡**（檔案大、部分有授權限制、且全部可重新取得），只有兩個手工
維護的 LOINC 對照表例外。所以這份清單就是那個資料夾唯一的紀錄——換機器時照著它把檔案
補齊即可。

## 檔案清單

放在 repo 根目錄的 `fhir-code/` 底下。`sha256` 只列前 16 碼，用來確認拿到的是同一份檔案。

| 檔案 | 大小 | sha256 (前16碼) | 模組 / source_role |
|---|---|---|---|
| `icd/10/icd10cm/icd10cm-table-index-2025.zip` | 20 MB | `7e0fa0cae6348fb6` | icd / `icd10cm` |
| `icd/10/icd10pcs/icd10pcs_tables_2025.zip` | 648 KB | `728d9b8f5c315548` | icd / `icd10pcs` |
| `icd/10/1.2023年中文版ICD-10-CM_PCS_1131118V3(…).xlsx` | 7 MB | `1bf34d1f92930f29` | icd / `icd_zh_tw` |
| `loinc/2.80/Loinc_2.80.zip` | 74 MB | `5a6b10dd6ed29704` | loinc / `loinc` |
| `loinc/taiwan_mapping.csv` | 1.5 KB | `659898b4763e20d2` | loinc / `loinc_taiwan_mapping` |
| `loinc/lab_reference_ranges.csv` | 3.5 KB | `bd99653487243637` | loinc / `loinc_reference_ranges` |
| `snomed/SnomedCT_InternationalRF2_PRODUCTION_20250601T120000Z.zip` | 540 MB | `3d6c189288e375d4` | snomed / `snomed_ct` |
| `rxnorm/RxNorm_full_06032024.zip` | 241 MB | `fc612ca0abee8955` | rxnorm / `rxnorm_full` |
| `twcoreig/v1.0.0/package.tgz` | 2.8 MB | `2fa1419fa48d1545` | ig / `ig` |
| （下載後才有）`36_2.csv` | 44 MB | — | drug / `drug_index_csv` |

`umls/umls-2024AA-metathesaurus-full.zip`（4 GB）也在資料夾裡，但目前**沒有任何匯入流程
用到它**，重建時可以略過。

### 兩個必須留在版控的檔案

`loinc/taiwan_mapping.csv` 和 `loinc/lab_reference_ranges.csv` 是專案自己整理的（台灣檢驗
代碼對應、各醫學中心參考值彙整），**網路上下載不到**。`.gitignore` 特地把它們從 fhir-code
的忽略規則裡排除——不要把這個例外拿掉。

## 各檔案從哪裡來

**ICD-10-CM / PCS 2025**：CMS 官方年度釋出（<https://www.cms.gov/medicare/coding-billing/icd-10-codes>）。
中文名稱 XLSX 來自衛福部的中文版 ICD-10-CM/PCS 對照檔。

**LOINC 2.80**：Regenstrief Institute（<https://loinc.org/downloads/>），需註冊帳號後下載。

**SNOMED CT International RF2**：需有效授權（可經 NLM / UMLS 帳號取得）；
<https://www.nlm.nih.gov/healthit/snomedct/>。不可再散佈。

**RxNorm Full Release**：NLM，需 UMLS 帳號；<https://www.nlm.nih.gov/research/umls/rxnorm/>。
本專案只當作 concept-only 的參考術語（供 IG ValueSet 展開），不是獨立的藥品工具。

**TW Core IG `package.tgz`**：從 <https://packages.fhir.org> 取得 `tw.gov.mohw.twcore`。
匯入時會**自動遞迴抓取相依套件**（hl7.terminology、hl7.fhir.r4.core、
hl7.fhir.r4.examples…），最後 DB 裡會有 9 個 package、約 21,000 個 artifact——所以只需要
準備這一個 tgz。

**TFDA 藥品許可證 `36_2.csv`**：repo 裡沒有，也不必手動放進 `fhir-code/`，直接下載：

```bash
curl -L "https://data.fda.gov.tw/data/opendata/export/36/csv" -o drug36.zip
# 是一個 zip，裡面就是 36_2.csv（約 44 MB、71,921 列、UTF-8-BOM）
```

其他兩個看起來合理的網址（`cacheData/36_2.csv`、`codedata/datadownload/36`）都是 404。

保健食品與食品營養**不需要來源檔**：`health_supplements_sync` / `food_nutrition_sync` 直接
打 TFDA Open Data API。臨床指引則由 `guideline_seed` 從 repo 內建資料播種。

## 重建步驟

設定（OCR / TFDA / registry 位址、LLM profiles、passkey）用 Settings 匯出檔還原：

```bash
curl -X POST localhost:8080/admin/api/settings/import \
     -H 'Content-Type: application/json' \
     --data-binary @tw-health-settings-YYYY-MM-DD.json
```

> 該匯出檔含 API key 與 passkey，**不要進版控**。自己留一份備份。

來源檔透過 Admin → Sources 上傳（或用 API；注意要帶 `Content-Type: application/octet-stream`，
否則 body 會被 express 的 4 MB parser 攔下）：

```bash
curl -X POST "localhost:8080/admin/api/uploads?module_key=icd&source_role=icd10cm&filename=icd10cm-table-index-2025.zip&auto_activate=true" \
     -H 'Content-Type: application/octet-stream' \
     --data-binary @fhir-code/icd/10/icd10cm/icd10cm-table-index-2025.zip
```

接著依序排入 job：`icd_import`、`loinc_import`、`snomed_import`、`rxnorm_import`、
`ig_import`（要帶 `job_options.object_key`，值是該來源檔的 MinIO object key）、
`guideline_seed`、`health_supplements_sync`、`food_nutrition_sync`、`drug_index_import`。

!!! warning "藥品 pipeline 會自動接續"
    `drug_index_import` 成功後會 auto-chain 出 `drug_enrichment`，再接 `drug_analysis`。
    Enrichment 會去爬 TFDA 官方網站、Analysis 會呼叫 OCR + LLM，兩者都要花錢/花時間，
    而且待處理的許可證有兩萬多筆。auto-chain 現在每批上限 200 筆
    （`DRUG_AUTOCHAIN_BATCH_LIMIT`），會分批慢慢推進；不想跑就在 Jobs 頁面停掉它。
    只想小規模驗證的話，自己排一個帶 `{"limit": 30}` 的 `drug_enrichment` 即可。

## 這份清單對應的資料量

2026-07-14 全清重建後的實際結果，可以拿來核對匯入是否完整：

| 模組 | 筆數 |
|---|---|
| ICD | 46,498 診斷 + 78,948 處置 |
| LOINC | 104,672 concepts |
| SNOMED CT | 373,972 concepts |
| RxNorm | 222,199 concepts |
| FHIR IG | 9 packages / 20,996 artifacts |
| 藥品 | 66,395 張許可證 |
| 保健食品 | 565 |
| 食品營養 | 1,702 |
| 臨床指引 | 4 |

語意搜尋要另外跑 `*_embed` job（需要可連線的 Ollama）。**沒有 embedding 時，中文關鍵字
搜尋幾乎搜不到東西**——因為 Postgres 的 `simple` tokenizer 會把整串中文品名當成一個 token，
子字串比對不到。這不是 bug，是設計上就靠向量搜尋來補。
