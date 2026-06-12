# Python → Node.js 遷移評估與執行計畫

評估日期：2026-06-10

## 結論

對外 MCP 線上 runtime 已可由 Node.js 接替 Python。Node 版目前：

- 與 Python 暴露相同的資料感知工具清單；本機資料狀態下雙方皆為 40 個工具。
- 目前可用的 40 個工具中，37 個案例逐值一致，3 個搜尋案例僅候選排序不同，0 個失敗。
- 53 個工具皆有 Node 實作；其中 13 個因本機對應資料表未載入而自動停用，匯入資料後會自動註冊。
- FHIR IG、FHIR Condition、FHIR Medication、臨床指引不再使用假資料或固定回傳。

本次完成的是 **MCP API/runtime 遷移**。`admin-worker` 與 `loader/` 仍使用
Python，負責資料匯入、OCR/LLM enrichment 與批次工作。若目標是完全移除
Python，需另立 ETL/worker 遷移專案，不應與線上 MCP 切換綁在同一次發布。

## 目前資料狀態

| 模組 | 資料量 | 工具狀態 |
|---|---:|---|
| ICD diagnoses | 46,498 | 啟用 |
| LOINC concepts | 104,672 | 啟用 |
| SNOMED concepts | 373,972 | 啟用 |
| FHIR IG packages | 9 | 啟用 |
| Drug licenses | 0 | 停用，待匯入 |
| Food measurements | 0 | 停用，待匯入 |
| Health supplements | 0 | 停用，待匯入 |
| Clinical guidelines | 0 | 停用，待匯入 |

FHIR Medication 依賴藥品資料，因此目前也停用。

## API 與架構差異

| 項目 | Python | Node.js | 遷移處理 |
|---|---|---|---|
| MCP SDK | FastMCP / Python `mcp` | TypeScript MCP SDK | 工具名稱、參數與回傳契約對齊 |
| HTTP transport | Streamable HTTP | Streamable HTTP | 同為 `/mcp`，客戶端 URL 不變 |
| DB driver | `asyncpg` | `pg` | SQL 改為實際 schema，處理 `BIGINT` |
| Cache | Redis decorator/cache | Redis cache helper | Node cache key加版本，避免舊錯誤結果 |
| 模組啟用 | 依資料量動態註冊 | 原先無條件註冊 | 已改為依 DB 資料量動態註冊 |
| Embedding | Ollama，失敗退回 lexical | 原先 timeout 單位錯誤且 app 未帶 env | 已補 env、秒轉毫秒與 semantic 查詢 |
| Health | DB monitor、cache、service 狀態 | 原先欄位較少 | 已補 `db_health` 與資料模組狀態 |
| FHIR IG | package/version aware | 原先查不存在欄位/資料表 | 已依 `fhir.artifacts/codesystems/concepts` 重寫 |
| FHIR authoring | skeleton、finalize、validator | 原先功能不完整 | 已補 slicing、binding、invariant、fixed/pattern |
| FHIR server registry | 安全摘要與 OAuth 狀態 | 原先讀錯 probe/capability 欄位 | 已改讀實際 registry/token/probe 欄位 |
| Error JSON | 部分服務受 cache 影響會雙重編碼 | 結構化 JSON | parity runner 會解開 Python 舊格式 |
| 搜尋排序 | BM25/semantic/RRF | 同策略 | 契約一致；候選順序允許小幅差異 |

JSON Schema 的 nullable 表示法仍有外觀差異：Python 常用 `anyOf`，
Node/Zod 常用 `type: ["string", "null"]`。參數名稱與 required 集合已一致，
不影響 MCP 呼叫。

## 已發現並修正的問題

1. Node 原先固定暴露 53 個工具，即使資料表為空；現在與 Python 一樣依資料量啟用。
2. FHIR Condition、FHIR Medication 與 Guideline 原先含 mock/fake 回傳；已改為 DB 查詢。
3. 11 個 FHIR IG 工具查詢不存在的 `id/url/type/compose_json` 欄位與
   `fhir.snapshot_elements` 資料表；已依現有 schema 重寫全部 19 個工具。
4. `fhir_apply_mapping_template` 的 Node 規則格式與 Python 不同；已統一為
   `source/target/transform/map/skip_if_empty`。
5. FHIR IG 工具原先缺少 `version` 參數；已補齊 package/version scope。
6. FHIR validator 原先只檢查部分 cardinality；已補 choice、maxLength、
   slicing、required binding 與 invariant 資訊。
7. FHIR skeleton 原先把 `candidate_limit` 當成欄位數上限；現在只限制候選碼數。
8. LOINC hybrid SQL 有 `loinc_num` 欄位歧義；已限定 table alias。
9. LOINC `display_name` 對空字串未正確 fallback；已修正。
10. SNOMED metadata ID 超過 JavaScript safe integer，造成 FSN join 失敗；
    SQL 參數改以字串傳遞，回傳 concept ID 維持 MCP integer 契約。
11. SNOMED relationship count 原先計算群組數；已改為 target 總數。
12. FHIR Server status 原先讀不存在的 capability/probe 欄位；已改讀
    `capability_summary_json`、`last_probe_*` 與 OAuth token state。
13. Ollama timeout 原先把 `30` 當 30ms；現在按秒處理，並允許
    `OLLAMA_EMBED_TIMEOUT_MS` 明確覆寫。

## 逐工具狀態

狀態說明：

- **Verified**：已對 Python/Node 實際 API 呼叫比對。
- **Implemented**：Node 已有 DB 實作，但本機資料未載入，工具目前雙邊停用。
- **Search parity**：schema/回傳契約一致，候選排序可能因 embedding/RRF 不同。

| 工具 | 原 Node 差異 | 現況 |
|---|---|---|
| `health_check` | 缺 `db_health`，模組狀態不準 | Verified |
| `list_fhir_servers` | capability/probe/auth 摘要不完整 | Verified |
| `get_fhir_server_status` | 回傳內部欄位，錯誤格式不同 | Verified |
| `crud_fhir_server` | registry 解析與 Python 不一致 | Verified |
| `fhir_resolve_terminology_batch` | 輸出格式與 fallback 不一致 | Search parity |
| `fhir_apply_mapping_template` | mapping 規則不相容 | Verified |
| `search_medical_codes` | metadata/排序差異 | Verified |
| `infer_complications` | 小幅 envelope 差異 | Verified |
| `get_nearby_codes` | 小幅 envelope 差異 | Verified |
| `check_medical_conflict` | schema constraint 差異 | Verified |
| `browse_icd_category` | nullable/category schema 差異 | Verified |
| `search_drug` | DB 實作已有，無資料 | Implemented |
| `identify_unknown_pill` | DB 實作已有，無資料 | Implemented |
| `get_drug_details` | DB 實作已有，無資料 | Implemented |
| `get_drug_asset_links` | DB 實作已有，無資料 | Implemented |
| `search_health_supplements` | DB 實作已有，無資料 | Implemented |
| `query_food_nutrition` | DB 實作已有，無資料 | Implemented |
| `query_food_ingredient` | DB 實作已有，無資料 | Implemented |
| `search_foods_by_nutrient` | DB 實作已有，無資料 | Implemented |
| `analyze_meal_nutrition` | DB 實作已有，無資料 | Implemented |
| `search_loinc` | hybrid SQL 欄位歧義 | Search parity |
| `query_loinc` | default 與 `display_name` 差異 | Verified |
| `interpret_lab_result` | schema/default 細節差異 | Verified |
| `batch_interpret_lab_results` | schema/default 細節差異 | Verified |
| `search_clinical_guideline` | 全部為 mock | Implemented，待資料 |
| `query_guideline` | mock 且缺 `medication_class` | Implemented，待資料 |
| `search_snomed_concept` | `BIGINT`/FSN join 與排序問題 | Search parity |
| `query_snomed_concept` | ID 字串、FSN null、map 欄位不同 | Verified |
| `get_snomed_relationships` | label/target null、count 錯誤 | Verified |
| `query_snomed_mapping` | keyword/default 與輸出格式差異 | Verified |
| `query_fhir_condition` | 假資料，不查 ICD | Verified |
| `validate_fhir_condition` | 永遠回 valid | Verified |
| `query_fhir_medication` | 假資料，不查 TFDA | Implemented，待資料 |
| `validate_fhir_medication` | 永遠回 valid | Implemented，待資料 |
| `fhir_list_igs` | envelope 欄位不同 | Verified |
| `fhir_get_ig` | envelope/package scope 不完整 | Verified |
| `fhir_list_artifacts` | 查不存在欄位 | Verified |
| `fhir_search_artifacts` | 查不存在欄位 | Verified |
| `fhir_list_resource_profiles` | 查不存在欄位 | Verified |
| `fhir_rank_resource_profiles` | 查不存在欄位 | Verified |
| `fhir_get_profile` | 查不存在欄位 | Verified |
| `fhir_get_profile_elements` | 依賴不存在 snapshot table | Verified |
| `fhir_get_valueset` | 查不存在 `compose_json` | Verified |
| `fhir_expand_valueset` | terminology expansion 失效 | Verified |
| `fhir_lookup_code` | CodeSystem schema 錯誤 | Verified |
| `fhir_validate_code` | ValueSet membership 失效 | Verified |
| `fhir_normalize_code` | 無 ConceptMap/semantic | Verified |
| `fhir_resolve_reference` | context/reference 契約差異 | Verified |
| `fhir_build_bundle` | reference rewrite 契約差異 | Verified |
| `fhir_validate_resource` | validator 覆蓋不足 | Verified |
| `fhir_validate_bundle` | profile/reference 驗證差異 | Verified |
| `fhir_get_resource_skeleton` | candidate limit 語意錯誤 | Verified |
| `fhir_finalize_resource` | pin/narrative/validation 不完整 | Verified |

## 驗證方式

先在另一個 port 啟動 Python baseline：

```bash
cd src
MCP_TRANSPORT=streamable-http MCP_PORT=8011 python server.py
```

Node 使用 compose 的 port 8000：

```bash
docker compose up -d app
python scripts/api_parity_test.py \
  --python-url http://127.0.0.1:8011 \
  --node-url http://127.0.0.1:8000 \
  --report parity-report.json
```

目前結果：

```text
37 passed, 3 warned, 13 skipped, 0 failed
```

3 個 warning 是 embedding 搜尋候選排序不同；13 個 skip 是雙邊皆因資料未載入而停用。

## 建議轉移計畫

### Phase 0：凍結基準

1. 固定 Python reference image、環境變數與資料庫 snapshot。
2. 將 `scripts/api_parity_test.py` 放入 CI。
3. 對寫入型 FHIR API 僅測試拒絕/validation，不對外部正式 server 寫資料。

通過條件：工具清單、property/required schema 與所有啟用工具無 failure。

### Phase 1：補齊資料

1. 從 Admin Modules 匯入 Drug、Food、Supplements、Guideline。
2. 重建各模組 embeddings。
3. 再跑 parity，要求 53 個工具全部執行，不再有 module inactive skip。

通過條件：資料量超過 `moduleStatus.ts` 門檻，53 工具雙邊同時出現。

### Phase 2：Shadow traffic

1. 正式流量仍送 Python。
2. 將 read-only MCP calls 複製到 Node，保存 latency、error、shape diff。
3. 搜尋型工具比較 top-N code overlap，不要求排序完全相同。

建議門檻：錯誤率差 < 0.5%，P95 latency 不高於 Python 20%，核心碼值 top-3 overlap ≥ 80%。

### Phase 3：Canary

依 5% → 25% → 50% → 100% 將 MCP 流量切到 Node。每階段至少觀察一個完整業務高峰，
監控 `/health`、`/metrics`、PostgreSQL pool、Redis、Ollama timeout 與外部 FHIR OAuth。

回滾條件：錯誤率、資料錯誤、OAuth 失敗或 DB pool saturation 超過既定門檻。

### Phase 4：正式切換

1. 對外僅保留 Node `/mcp`。
2. Python MCP server 停止接收流量，但保留 image 一個 release window。
3. `admin-worker`/loader 繼續運作，不受 MCP runtime 切換影響。
4. 更新 runbook、告警、SLO 與災難復原文件。

### Phase 5：移除 Python MCP

連續兩個 release 無回滾後，移除 Python MCP 部署設定。不要刪除
`src/`、`loader/` 或 `Dockerfile.python`，直到 ETL/worker 已有獨立替代方案。

## 回滾策略

- 保持同一 PostgreSQL/Redis schema，Node 未引入破壞性 migration。
- 反向代理只需把 `/mcp` upstream 從 Node 切回 Python。
- 回滾前停止 Node 新流量；不需回復資料庫。
- 若是搜尋品質問題，可先停用 Ollama semantic，退回 lexical，而不必回滾整個 runtime。
