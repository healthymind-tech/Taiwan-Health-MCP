# FHIR validator audit harness

這組工具把內建 FHIR validator（`src/fhirValidator.ts`，MCP tools
`fhir_validate_resource` / `fhir_validate_bundle`）的判定，與 HL7 官方
validator（經 <https://validator.dicom.tw/app/> 包裝，下稱 oracle 或 dicom oracle）逐筆比對。
第二輪（v2）另加一個「CLI oracle」：在本機 docker 內跑官方 `validator_cli.jar` 7.0.1
（`-ig tw.gov.mohw.twcore#1.0.0 -tx https://tx.fhir.org`，與外部使用者回報時的設定相同）。
兩個 oracle 在部分規則上判定不同（見 REPORT.md §v2.2），比對時兩邊都要看。
結論與數據見 [REPORT.md](REPORT.md)。

## 內容

| 路徑 | 用途 |
|------|------|
| `localValidate.ts` | 在本機 process 內跑我們的 validator（直連 DB，不經 HTTP）。輸入 corpus（`.json` / `.json.gz`），輸出 `[{key, valid, issues}]`。`ONLY=<子字串>` 只跑部分 key。 |
| `run.sh` | `localValidate.ts` + `harness/compare_local.py` 一次跑完：本機結果 vs oracle。 |
| `surveyConstraints.ts` | 列出 IG 依賴閉包內所有 `ElementDefinition.constraint`，檢查每個 FHIRPath 函式是否被支援。 |
| `harness/oracle.py` | oracle client：`POST https://validator.dicom.tw/api/validator`，以內容 hash 快取在 `$ORACLE_CACHE`，失敗會退避重試，每次呼叫後等 0.5 秒。 |
| `harness/run_oracle.py` | 只預熱 oracle 快取（循序呼叫）。 |
| `harness/compare_local.py` | 比對 `localValidate.ts` 輸出與 oracle，算 agree / false reject / false accept / precision / recall。`-v` 列出所有項目。 |
| `harness/compare.py` + `harness/ours.py` | 同上，但我們這側改走 HTTP（`$MCP_BASE/tools/<name>`，預設 staging `:8090`）。 |
| `harness/align.py` | error 層級對齊：每筆比較兩邊「error 位置集合」；`--strict` 另算嚴格版（不容許父/子路徑寬鬆比對）。 |
| `harness/gen_negatives.py` | 由 IG 範例產生 mutation 負例（固定 seed）。 |
| `harness/gen_refprobe*.py` | Bundle reference 解析探針（collection / transaction / document / message / contained / versioned）。 |
| `harness/cli_oracle.py` | （v2）CLI oracle：把未快取的資源一次寫進工作目錄，用 `docker run eclipse-temurin:21-jre`（`--memory=3500m --cpus=2`）跑 `validator_cli.jar` 批次驗證，結果以內容 hash 快取在 `$CLI_CACHE`。同時只允許一個容器（lock 檔）。 |
| `harness/gen_icd_v3.py` | （v3）ICD-10-CM：回報者的 G0–G4、兩種真實 bundle 樣式、規則探針（header 碼、大小寫、缺點號、short title、變音符號、QA0、XML-only 7th char）與 seed 固定的 mutation 家族（有效 7 碼、header、偽造碼、display 互換）。需要 CMS `icd10cm_order_2026.txt`。 |
| `harness/fetch_tx_terms.py` | （v4）以 `$expand` 從 tx.fhir.org 取回 CVX（`cvx.json`）與 WHO ICD-10（`icd10who.json`，FHIR CodeSystem，可直接當 admin 選用來源 `icd/icd10_who` 上傳）。循序呼叫、每次間隔 0.5 秒。 |
| `harness/gen_v4.py` | （v4）LOINC LA/LP/LL/LG、SNOMED inactive／版本、CVX、WHO ICD-10、Coding.version、ValueSet 當 system、PAS ICD-10-CM slice 的規則探針與 seed 固定（20261018）的 mutation 家族。需要 LOINC 2.80 zip、SNOMED RF2 zip、`fetch_tx_terms.py` 的輸出。 |
| `harness/gen_v6.py` | （v6）`|version` 探針（meta.profile / Extension.url / binding ValueSet / targetProfile / type profile，含已安裝、maj.min 版本線、萬用字元、閉包外的其他已安裝版本、不存在版本）與 slice 成員須同時符合 base element 的探針。項目可帶 `ver`（用該 IG 版本驗證；CLI 跑 `-ig <pkg>#<ver>`）與 `overlay`（額外 StructureDefinition；CLI 以 `-ig <file>` 載入，`localValidate.ts` 疊在 DB 閉包之前）。 |
| `harness/gen_v2_mutations.py` | （v2）A–F 各類 mutation（display 互換 / 中文 display / 大小寫 / 空白、LOINC LCN / short name、SNOMED 同義詞與 inactive 描述、偽造 THO / HL7 URL、巢狀 extension、UCUM、OID、ValueSet 當 system、vital-sign 替代碼）。需要 `corpus/v2_terms.json.gz`。 |
| `requiredElementsAudit.ts` | `fhir_get_profile_required_elements` 的 oracle 稽核：對每個通過驗證的範例（含 Bundle entry），檢查 (a) 回報的必要元素都存在於範例（necessity）、(b) 刪掉回報元素後 validator 必報錯（sufficiency）、(c) 逐一刪除範例中每個元素，validator 報的 required / cardinality / invariant 錯誤都有對應列（under-report）。可疑 mutant 寫到 `required_audit_cli_items.json` 供 `cli_oracle.py` 複核；`CLI_SAMPLE=n` 另抽樣通過的刪除。 |
| `requiredElementsSizes.ts` | 該 tool 在 TW Core 1.0.0 / PAS 1.2.7 全部 profile 上的輸出大小（compact vs full）。 |
| `requiredElementsFixtures.ts` | 重新產生 `mcp_proposal/fixtures/required_elements_pas`（單元測試用的 PAS 投影與範例）。`mcp_proposal/` 是私有、未納入版控的目錄；沒有它時 `src/fhirRequiredElements.test.ts` 的相關案例會自動略過。 |
| `corpus/*.json.gz` | 本次稽核實際使用的 corpus（見下表）。 |
| `results/` | 最終結果：`summary.json`、`alignment.txt`、`constraint_survey.json`。 |

| corpus | 筆數 | 來源 |
|--------|------|------|
| `examples` | 159 | TW Core 1.0.0 + PAS 1.2.7 套件內的全部範例（剔除 2 個 OperationOutcome bundle） |
| `bundles` | 30 | 由範例組成的 collection / transaction bundle（TW Core 20、PAS 10） |
| `mutations` | 1910 | `gen_negatives.py` 產生的 mutation（多數為負例，含使用者回報的 N-* / P-* 案例） |
| `user_cases` | 93 | 使用者回報的正/負例清單（vs-2、vs-3、ext-1、identifier 兩個 system、clinicalStatus、Condition 缺 category …） |
| `v2_probes` | 456 | （v2）規則探針：A display、B 未知 URL / extension、C UCUM（約 230 個單位）、D OID / UUID、E ValueSet 當 system、F1 vital-sign、F2 多重 slice |
| `mut_v2` | 945 | （v2）`gen_v2_mutations.py` 由範例產生的 A–F mutation（每類最多 60 筆） |
| `icd_v3_probes` | 29 | （v3）ICD-10-CM G0–G4、真實 bundle 樣式、規則探針 |
| `icd_v3_mut` | 145 | （v3）ICD-10-CM mutation（有效 7 碼 long / short / 無 display 70、header 15、偽造 30、display 互換 30） |
| `v4_probes` | 79 | （v4）新涵蓋術語的規則探針（L-* LOINC、S-* SNOMED、V-* Coding.version、C-* CVX、W-* WHO ICD-10、X-* ValueSet 當 system、P-* PAS slice） |
| `v6_probes` | 30 | （v6）`gen_v6.py`：M-* meta.profile 版本、E-* extension url 版本、S-* slice vs base、B-* binding、T-* targetProfile、Y-* type profile |
| `v4_mut` | 376 | （v4）mutation 家族：LA 有效／display 互換／空白／偽造、LP 有效／錯 display、SNOMED inactive 有效／互換／無 display、偽造 SCTID、active＋inactive 描述、CVX 有效／互換／偽造、ICD-10 有效／互換／偽造 |
| `mut_dis` | 31 | MedicationDispense mutation |
| `perf` | 6 | 大型 PAS bundle（效能 + 正確性） |
| `refprobe*` | 51 | Bundle reference 解析探針 |

## 重跑

前提：可連到載有 IG 套件的 DB（staging：`postgresql://mcp:<pw>@127.0.0.1:15432/taiwan_health`），
可連到 validator.dicom.tw。**對 oracle 要客氣**：harness 一律循序呼叫、每次間隔 0.5 秒，
請勿平行跑多個 `run_oracle.py`。

```bash
cd node-server/scripts/validator-audit
export DATABASE_URL=postgresql://mcp:...@127.0.0.1:15432/taiwan_health
export ORACLE_CACHE=/tmp/twh-validator-audit/oracle_cache   # 可重複使用
export OUT_DIR=/tmp/twh-validator-audit

# 1. (可選) 先預熱 oracle 快取，1910 筆 mutation 首次約 15–20 分鐘
python3 -I harness/run_oracle.py corpus/mutations.json.gz

# 2. 每個 corpus：本機 validator vs oracle
for c in examples bundles mutations user_cases mut_dis perf refprobe refprobe2 refprobe3; do
  ./run.sh corpus/$c.json.gz $c
done

# 3. error 層級對齊
python3 -I harness/align.py $OUT_DIR/cmp_*.json --strict -v > $OUT_DIR/alignment.txt

# 4. FHIRPath constraint 盤點
(cd ../.. && node --import tsx scripts/validator-audit/surveyConstraints.ts $OUT_DIR/survey.json)

# 5. 經 HTTP 對 staging 的 MCP tool 跑（驗證部署後行為）
MCP_BASE=http://<staging-host>:8090 python3 -I harness/compare.py corpus/bundles.json.gz $OUT_DIR/cmp_http.json
```

重新產生 mutation（需要 IG 的 StructureDefinition 匯出 `all_sd.json`，未隨附）：
`python3 -I harness/gen_negatives.py examples.json all_sd.json mutations.json`。
重新產生探針：`python3 -I harness/gen_refprobe.py out.json`（`gen_refprobe2.py` / `gen_refprobe3.py` 同）。

判讀：`compare_local.py` 以「有無 severity = error/fatal 的 issue」決定 valid；
oracle 的 `warning` / `information` 不計入。

### v2：CLI oracle

```bash
# 一次性準備（約 400 MB）：validator_cli.jar 與 JRE image
mkdir -p /tmp/claude-1000/cli && cd /tmp/claude-1000/cli
curl -sLo validator_cli.jar https://github.com/hapifhir/org.hl7.fhir.core/releases/download/7.0.1/validator_cli.jar
docker pull eclipse-temurin:21-jre

# 預熱 CLI 快取（每批最多 400 筆；載入套件約 1.5 分鐘 / 批）
CLI_DIR=/tmp/claude-1000/cli python3 -I harness/cli_oracle.py corpus/v2_probes.json.gz corpus/mut_v2.json.gz

# 比對時改用 CLI oracle（只讀快取，不會自行啟動容器）
ORACLE=cli python3 -I harness/compare_local.py corpus/mut_v2.json.gz $OUT_DIR/local_mut_v2.json $OUT_DIR/cmp_cli_mut_v2.json

# 重新產生 v2 mutation
python3 -I harness/gen_v2_mutations.py corpus/examples.json.gz corpus/v2_terms.json.gz mut_v2.json
```

主機記憶體注意：CLI 容器上限 3.5 GB，與 production 同主機，請勿同時開兩個。


### v3：ICD-10-CM 完整碼表

```bash
# CMS April 1, 2026 code descriptions（只當資料讀，放在獨立空目錄）
mkdir -p /tmp/claude-1000/icd/dl && cd /tmp/claude-1000/icd/dl
curl -sLO https://www.cms.gov/files/zip/april-1-2026-code-descriptions-tabular-order.zip
# 解出 Code Descriptions/icd10cm_order_2026.txt 後：
python3 -I harness/gen_icd_v3.py corpus/examples.json.gz corpus/v2_probes.json.gz \
  ".../Code Descriptions/icd10cm_order_2026.txt" icd_v3_probes.json icd_v3_mut.json
CLI_DIR=/tmp/claude-1000/cli python3 -I harness/cli_oracle.py icd_v3_probes.json icd_v3_mut.json
ORACLE=cli CLI_NO_RUN=1 ./run.sh corpus/icd_v3_probes.json.gz icd_v3_probes
```

前提：DB 已用 CMS order file 匯入 ICD-10-CM（`icd.editions` 有 `2026-04-01 / complete = true`），
否則未知碼只會是 warning，G1 / G2 / G4 會被判 valid。全語料 vs CLI 的結果在 `results/summary_v3_cli.json`。


### v4：術語補齊（LOINC LA/LP/LL/LG、SNOMED inactive、CVX、WHO ICD-10）

```bash
# 1. tx.fhir.org 的 CVX / WHO ICD-10（只當資料讀）
python3 -I harness/fetch_tx_terms.py /tmp/claude-1000/v4/tx
# 2. 探針與 mutation（LOINC 2.80 zip、SNOMED RF2 zip 只當資料讀）
python3 -I harness/gen_v4.py corpus/examples.json.gz .../Loinc_2.80.zip .../SnomedCT_InternationalRF2_PRODUCTION_20250601T120000Z.zip \
  /tmp/claude-1000/v4/tx/cvx.json /tmp/claude-1000/v4/tx/icd10who.json v4_probes.json v4_mut.json
CLI_DIR=/tmp/claude-1000/cli python3 -I harness/cli_oracle.py v4_probes.json v4_mut.json
# 3. 比對（CLI_ISO_CACHE：單筆重跑的結果優先，見下）
ORACLE=cli CLI_NO_RUN=1 CLI_ISO_CACHE=/tmp/claude-1000/v4/cache_iso ./run.sh corpus/v4_probes.json.gz v4_probes
```

前提：staging DB 已套 `db/migrations/20261018_terminology_completeness_v4.sql`，並重跑過 `loinc_import`、
`snomed_import`、`icd_import`（含選用來源 `icd/icd10_who`）。否則新規則只會給 warning／information。

**批次汙染**：validator_cli 在同一次批次執行中會沿用前面資源的術語結果，因此少數判定取決於同批還有哪些資源
（`F2b-nhi-vs-as-system` 在批次中是 error，單獨跑是 valid）。判定以「單一資源、全新 JVM」的結果為準：
`CLI_CACHE=$CLI_ISO_CACHE python3 -I harness/cli_oracle.py one_item.json`，並記錄在 `results/oracle_isolated.json`。


### v6：`|version` 與 slice 成員的 base 規則

```bash
# core Patient SD（overlay 探針的基底）
psql -At -c "select raw_json from fhir.artifacts where package_id='hl7.fhir.r4.core' and canonical_url='http://hl7.org/fhir/StructureDefinition/Patient'" > core_patient.json
python3 -I harness/gen_v6.py corpus/examples.json.gz core_patient.json v6_probes.json
CLI_DIR=/tmp/claude-1000/cli python3 -I harness/cli_oracle.py v6_probes.json      # 依 (pkg, ver, overlay) 分批
ORACLE=cli CLI_NO_RUN=1 ./run.sh corpus/v6_probes.json.gz v6_probes
```

`localValidate.ts` 輸出每列另含 `checked_fully` / `profiles_unchecked` / `valuesets_unchecked`（`completenessOf()`）。
