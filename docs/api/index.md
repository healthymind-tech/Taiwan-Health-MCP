# API 參考

系統對外有三個介面，全部經由 nginx 前門（預設 `:8080`）提供。

## HTTP 端點總覽

| 端點 | 方法 | 認證 | 說明 |
|------|------|------|------|
| `/mcp` | `POST` / `GET` / `DELETE` | 可設定 Bearer | MCP streamable-http 端點（路徑由 `MCP_PATH` 設定）。 |
| `/openapi.json` | `GET` | 可設定 Bearer | 依**目前已註冊的工具**動態產生的 OpenAPI 3.1 規格。 |
| `/tools/<工具名>` | `POST` | 可設定 Bearer | OpenAPI bridge：以 JSON body 當參數呼叫單一工具。 |
| `/admin/api/*` | 各異 | session cookie | 管理後台 REST API（`ADMIN_ENABLED=true` 時才存在）。 |
| `/admin/ws` | WebSocket | session cookie | 工作即時日誌與進度推送。 |
| `/fhir-client/<id>/jwks.json` | `GET` | 無 | 外部 FHIR OAuth 客戶端的公開 JWKS。 |
| `/fhir-oauth/callback` | `GET` | — | OAuth2 Authorization Code 回呼端點。 |

`PUBLIC_TOOLS_AUTH_MODE=bearer` 會同時保護 `/mcp`、`/openapi.json` 與
`/tools/*`。Token 由 `PUBLIC_TOOLS_BEARER_TOKEN` 設定；瀏覽器跨來源呼叫另需在
`PUBLIC_TOOLS_CORS_ORIGINS` 明列 origin。`none` 僅適合受信任的本機或私有網路。

> 後端另有一個 `/health` 端點，但 nginx 不會轉送它（從前門存取會得到 404）。要從前門確認 `app`
> 是否存活，請改打 `/openapi.json`。各模組的資料筆數請看管理後台儀表板；`health_check`（`POST /tools/health_check`）
> 也會回報模組狀態、伺服器版本、build sha 與已載入的術語版本。

## OpenAPI bridge

給不支援原生 MCP、只能接 OpenAPI 工具伺服器的客戶端使用（例如 Open WebUI 的 External Tools）。

```bash
# 取得目前工具清單
curl -H 'Authorization: Bearer <token>' http://localhost:8080/openapi.json

# 呼叫工具
curl -X POST http://localhost:8080/tools/search_medical_codes \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"keyword": "diabetes", "limit": 3}'
```

工具清單會隨各模組的資料載入狀態動態增減（門檻為 `moduleStatus.ts` 的 `REQUIREMENTS`，以 `MODULE_REQUIREMENTS` 匯出），
因此 `/openapi.json` 的內容會依部署的資料狀態而不同。`mcp.ts` 共定義 **68 個工具**、12 個群組；其中 FHIR Servers、
Clinical Calculators 與 System 三組（15 個工具）永遠註冊。管理後台的 **MCP 工具**頁（`/admin/mcp`）會列出完整目錄、
每個未註冊工具缺少的條件，並提供可直接呼叫已註冊工具的 playground。

工具已註冊只代表必要的來源資料存在，**不代表 semantic embedding 已完整回填**。
向量不完整時，相關搜尋會退回或混用 keyword/BM25。請在管理後台各模組頁面查看嵌入計數，
並執行或排程對應的 `*_embed` 工作。

## 維護模式 {#maintenance}

管理後台可把 `icd`、`loinc`、`drug`、`snomed`、`ig`、`rxnorm` 模組切到維護模式（`POST /admin/api/module-maintenance`）。
維護中的模組，其工具呼叫（`/mcp`、`POST /tools/<name>` 與後台 playground 都一樣）會在執行前立即回傳 `isError` 結果：

```json
{"ok": false, "data": null, "warnings": [],
 "error": {"code": "MODULE_MAINTENANCE", "module": "loinc", "tool": "query_loinc", "retryable": true,
           "message": "Module 'loinc' is under maintenance (data is being updated); query_loinc is temporarily unavailable. Retry later.",
           "message_zh": "模組「loinc」維護中（資料更新中），query_loinc 暫時無法使用，請稍後再試。"}}
```

`POST /tools/<name>` 以 HTTP 200 回傳上述 JSON（與其他工具錯誤一致）。對應關係：ICD-10 與 FHIR Condition → `icd`；
Drug / TFDA 與 FHIR Medication → `drug`；Lab / LOINC → `loinc`；SNOMED CT → `snomed`；FHIR IG（含 grounding / completeness）→ `ig`。
`rxnorm` 沒有自己的工具群組，維護旗標不影響任何工具；健康食品、食品營養、FHIR Servers、Clinical Calculators 與 System
不受維護模式影響。為了避免用戶端工具清單反覆變動，維護中的工具**仍留在 `tools/list` / `/openapi.json`**。狀態有 5 秒快取，
切換後最多約 5 秒生效；讀取狀態失敗時放行（fail-open）。

## 工具錯誤格式 {#tool-errors}

工具呼叫失敗時（`/mcp`、`POST /tools/<name>`、後台 playground 都一樣），回應會告訴呼叫端的 LLM **代碼、原因與下一步**
（`node-server/src/toolErrors.ts`）。`POST /tools/<name>` 仍以 HTTP 400 回傳原本的 `error: "tool_call_failed"`、`tool`、`detail`，並多出：

| 欄位 | 說明 |
|------|------|
| `code` | 例如 `INVALID_ARGUMENTS`、`UNKNOWN_TOOL`、`TOOL_NOT_AVAILABLE`、`DATA_NOT_LOADED`、`SERVER_SCHEMA_OUTDATED`、`DATABASE_UNAVAILABLE`、`QUERY_TIMEOUT`、`INTERNAL_QUERY_FAILED` |
| `message` / `hint` | 英文說明與下一步（給 LLM 讀） |
| `retryable` | 原樣重試是否可能成功 |
| `problems`、`unknown_parameters`、`expected_parameters`、`example_arguments` | 參數錯誤時：逐項問題（參數、規則、範例值）、傳了但不存在的參數（含近似名稱建議）、完整參數清單與範例參數 |

SQL / 連線錯誤不再把原始訊息傳給用戶端（原始內容只寫入伺服器日誌）。外部 FHIR 伺服器的連線失敗會分類成
`UPSTREAM_TIMEOUT`、`UPSTREAM_DNS_FAILED`、`UPSTREAM_UNREACHABLE`、`UPSTREAM_TLS_ERROR`、`UPSTREAM_CONNECTION_RESET`、`UPSTREAM_AUTH_FAILED`。
查無資料的工具結果則多了 `hint` / `suggestions`（例如 ICD 近似代碼、`concept_found: false`、IG 找不到時列出 `installed_igs`），
原有欄位不變。

## `health_check`（System 群組）

永遠註冊、不需參數。建議在任何工作流程開始前先呼叫，確認需要的模組已上線。回傳 JSON：

| 欄位 | 說明 |
|------|------|
| `status` | 資料庫可用時為 `ok`，否則 `degraded` |
| `database` / `cache` | `ok` / `error`（Postgres 查詢、Redis ping） |
| `db_health` | 資料庫健康監視器快照（`state`、`healthy`、`since`、`last_ok_at`、`last_error` …） |
| `services` | 各模組是否達到註冊門檻：`icd`、`drug`、`health_supplements`、`food_nutrition`、`fhir_condition`、`fhir_medication`、`lab`、`ig`、`snomed` |
| `version` | 伺服器版本（`toolVersions.ts` 的 `SERVER_VERSION`，目前 `1.1.0`），與 MCP `initialize` 的 `serverInfo.version` 相同 |
| `build` | 映像建置時的 git sha（`BUILD_SHA` build arg），未設定時為 `dev` |
| `tools_version` | 有獨立版本的工具及其版本（見 [FHIR IG 工具 → 工具版本](../tools/fhir-ig-tools.md#tool-versions)） |
| `lexicon_version` / `lexicon_sha256` | grounding 使用的台灣病歷詞彙表版本與雜湊 |
| `terminology` | 已載入的術語版本，例如 `icd10cm`（`2026-04-01`）、`icd10`（WHO ICD-10，選用）、`loinc`（`2.80`）、`snomed`（`<module>/<YYYYMMDD>`）；來自 `icd.editions`、`loinc.editions`、`snomed.editions` |
| `ig_packages` | 已安裝的 IG 套件（`package_id#version`），預設 IG 排第一 |
| `default_ig` | 預設 IG（`package_id#version`），未設定時為 `null` |

## 管理後台 REST API

所有路徑以 `/admin/api/` 開頭，需帶 session cookie（預設名稱 `tw_health_admin_session`，可由 `ADMIN_SESSION_COOKIE` 改名）。主要端點：

| 群組 | 端點 |
|------|------|
| 認證 | `POST /admin/api/login`、`POST /admin/api/logout`、`GET /admin/api/me`、`/admin/api/passkeys/*`（含 `login/options`、`login/verify`、`register/options`、`register/verify`）、`POST /admin/api/privacy/password` |
| 總覽與健康 | `GET /admin/api/overview`、`GET /admin/api/health`、`GET /admin/api/services`、`POST /admin/api/services/probe`、`GET /admin/api/workers` |
| 模組與來源 | `GET /admin/api/modules`、`GET|POST /admin/api/modules/{key}/clear`、`GET /admin/api/modules/{key}/versions`、`GET /admin/api/modules/{key}/preview`、`POST /admin/api/modules/{key}/schedule/trigger`、`POST /admin/api/uploads`、`POST /admin/api/module-sources/{activate,deactivate,delete}`、`POST /admin/api/module-maintenance` |
| 工作 | `GET|POST /admin/api/jobs`、`GET /admin/api/jobs/{id}`、`GET /admin/api/jobs/{id}/{steps,logs}`、`POST /admin/api/jobs/{id}/{pause,resume,stop,restart}` |
| 設定 | `GET /admin/api/settings`、`POST /admin/api/settings/{group}[/{action}]`、`GET /admin/api/settings/export`、`POST /admin/api/settings/import`（匯出格式 v3；v1 / v2 檔案仍可匯入） |
| 模型端點 | `GET /admin/api/llm-providers`（provider adapter 目錄）；`/admin/api/llm/accounts[/{id}][/models]`、`POST /admin/api/llm/accounts/test`、`POST /admin/api/llm/models/test`、`/admin/api/llm/routes[/{id}][/test]`、`PUT /admin/api/llm/roles`、`POST /admin/api/llm/oauth/chatgpt/{start,complete}` |
| MCP 工具 | `GET /admin/api/mcp/overview`、`GET /admin/api/mcp/tools`、`POST /admin/api/mcp/tools/{name}/invoke` |
| 術語瀏覽（唯讀） | `GET /admin/api/terminology/icd/{cm,who}/{children,path,search}`、`GET /admin/api/terminology/icd/pcs/{browse,table,codes,code,search}`、`GET /admin/api/terminology/snomed/{concept,children,search}`、`GET /admin/api/terminology/loinc/{facets,facet-values,term,code}`、`GET /admin/api/terminology/rxnorm/{summary,search,concept}`、`GET /admin/api/terminology/ig/{codesystems,codesystem,codesystem/children,codesystem/search}` |
| 備份 | `GET /admin/api/backups`、`GET /admin/api/backups/{job_id}/download`；以 `POST /admin/api/jobs` 建立 `system_backup` 工作 |
| 藥品管線 | `GET /admin/api/drug/pipeline-status`、`/admin/api/drug/{status,details,assets,asset-content,events}` |
| 藥品瀏覽器 | `GET /admin/api/drug/explorer`、`GET /admin/api/drug/explorer-detail`、`GET /admin/api/drug/llm-calls`、`GET /admin/api/drug/llm-call` |
| OCR | `GET /admin/api/ocr/samples[/{id}]`、`POST /admin/api/ocr/test` |
| FHIR 伺服器 | `GET|POST /admin/api/fhir-servers`、`/admin/api/fhir-servers/{discover,test,test-request,generate-key,export}`、`POST /admin/api/fhir-servers/{id}/{probe,set-default}`、`POST /admin/api/fhir-servers/{id}/oauth/{authorize,refresh,clear-cache}` |
| IG | `GET /admin/api/igs`、`GET|DELETE /admin/api/igs/{package_id}/{version}`、`GET /admin/api/igs/{package_id}/{version}/removal-impact`、`POST /admin/api/igs/{package_id}/{version}/{default,fill-dependencies}`、`POST /admin/api/igs/import`、`POST /admin/api/igs/inspect-upload`、`GET /admin/api/igs/dependencies`、`POST /admin/api/igs/dependencies/{download,download-all}`、`GET /admin/api/igs/unused-dependencies`、`POST /admin/api/igs/unused-dependencies/remove`、`GET /admin/api/registry/search` |
| 嵌入 | `GET /admin/api/embedding/status` |

## 服務層（TypeScript）

各領域服務位於 `node-server/src/`，皆提供 `async initialize()`。資料庫存取經由 `db.ts` 的共用 `pg` 連線池（不是建構子參數），
需要搜尋的服務在建構子接收共用的 `EmbeddingService`。`mcp.ts` 以延遲建立的單例使用它們；某個服務初始化失敗只會讓它自己的工具消失。

| 類別 | 檔案 | 資料 |
|------|------|------|
| `IcdService` | `icdService.ts` | `icd.*` |
| `DrugService` | `drugService.ts` | `drug.*` |
| `DrugAnalysisService` | `drugAnalysisService.ts` | `drug.insert_analysis`（含 OCR（MinerU / Indra，`ocrProviders.ts`）與分析 LLM 呼叫） |
| `HealthSupplementsService` | `supplementsService.ts` | `health_supplements.*` |
| `FoodNutritionService` | `foodService.ts` | `food_nutrition.*` |
| `LabService` | `labService.ts` | `loinc.*` |
| `FHIRConditionService` | `fhirConditionService.ts` | 讀取 `icd.*` |
| `FHIRMedicationService` | `fhirMedicationService.ts` | 讀取 `drug.*` |
| `FHIRIGService` | `fhirIgService.ts` | `fhir.*`（多 IG） |
| `FHIRServerService` | `fhirServerService.ts` | `admin.fhir_servers` |
| `SnomedService` | `snomedService.ts` | `snomed.*` |
| `EmbeddingService` | `embeddingService.ts` | 外部嵌入端點——指派給 `embedding` 角色的路由（`admin.llm_routes` / `admin.llm_role_routes`，底層帳號在 `admin.llm_providers`） |
| MinIO helper | `minioService.ts` | MinIO bucket（藥品資產） |

## 相關文件

- [FHIR Services API](fhir-services.md)
- [模組總覽](../modules/icd-service.md)
- 服務的對外 MCP 工具見[工具參考](../tools/icd-tools.md)。
