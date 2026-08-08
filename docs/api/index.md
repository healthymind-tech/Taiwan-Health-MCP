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
> 是否存活，請改打 `/openapi.json`。各模組的資料筆數請看管理後台 Overview 分頁。

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

工具清單會隨各模組的資料載入狀態動態增減（見 `moduleStatus.ts` 的 `SERVICE_MODULES` 門檻），
因此 `/openapi.json` 的內容會依部署的資料狀態而不同。

工具已註冊只代表必要的來源資料存在，**不代表 semantic embedding 已完整回填**。
向量不完整時，相關搜尋會退回或混用 keyword/BM25。請在 Admin → Modules 查看每個模組的
Embeddings 計數，並執行或排程對應的 `*_embed` 工作。

## 管理後台 REST API

所有路徑以 `/admin/api/` 開頭，需帶 `tw_health_admin_session` cookie。主要端點：

| 群組 | 端點 |
|------|------|
| 認證 | `POST /admin/api/login`、`POST /admin/api/logout`、`/admin/api/passkeys/*`、`POST /admin/api/privacy/password` |
| 總覽與健康 | `GET /admin/api/overview`、`GET /admin/api/health`、`GET /admin/api/services`、`POST /admin/api/services/probe`、`GET /admin/api/workers` |
| 模組與來源 | `GET /admin/api/modules`、`POST /admin/api/uploads`、`/admin/api/module-sources/{activate,deactivate,delete}`、`POST /admin/api/module-maintenance` |
| 工作 | `GET|POST /admin/api/jobs`（建立、查詢、暫停 / 取消） |
| 設定 | `GET|POST /admin/api/settings`、`GET /admin/api/settings/export`、`POST /admin/api/settings/import`、`/admin/api/llm-profiles/*` |
| 備份 | `GET /admin/api/backups`、`GET /admin/api/backups/{job_id}/download`；以 `POST /admin/api/jobs` 建立 `system_backup` 工作 |
| 藥品管線 | `GET /admin/api/drug/pipeline-status`、`/admin/api/drug/{status,details,assets,asset-content,events}` |
| 藥品瀏覽器 | `GET /admin/api/drug/explorer`、`GET /admin/api/drug/explorer-detail`、`GET /admin/api/drug/llm-calls`、`GET /admin/api/drug/llm-call` |
| OCR | `GET /admin/api/ocr/samples`、`POST /admin/api/ocr/test` |
| FHIR 伺服器 | `GET|POST /admin/api/fhir-servers`、`/admin/api/fhir-servers/{discover,test,test-request,generate-key,export}` |
| IG | `GET /admin/api/igs`、`POST /admin/api/igs/import`、`GET /admin/api/registry/search` |
| 嵌入 | `GET /admin/api/embedding/status` |

## 服務層（TypeScript）

各領域服務位於 `node-server/src/`，建構子接收 `pg.Pool`，並提供 `async initialize()`：

| 類別 | 檔案 | 資料 |
|------|------|------|
| `ICDService` | `icdService.ts` | `icd.*` |
| `DrugService` | `drugService.ts` | `drug.*` |
| `DrugAnalysisService` | `drugAnalysisService.ts` | `drug.insert_analysis`（含 MinerU OCR 與分析 LLM 呼叫） |
| `SupplementsService` | `supplementsService.ts` | `health_supplements.*` |
| `FoodService` | `foodService.ts` | `food_nutrition.*` |
| `LabService` | `labService.ts` | `loinc.*` |
| `FhirConditionService` | `fhirConditionService.ts` | 讀取 `icd.*` |
| `FhirMedicationService` | `fhirMedicationService.ts` | 讀取 drug 服務 |
| `FhirIgService` | `fhirIgService.ts` | `fhir.*`（多 IG） |
| `FhirServerService` | `fhirServerService.ts` | `admin.fhir_servers` |
| `SnomedService` | `snomedService.ts` | `snomed.*` |
| `EmbeddingService` | `embeddingService.ts` | 外部嵌入端點（設定存於 `admin.llm_profiles`） |
| MinIO helper | `minioService.ts` | MinIO bucket（藥品資產） |

## 相關文件

- [FHIR Services API](fhir-services.md)
- [模組總覽](../modules/icd-service.md)
- 服務的對外 MCP 工具見[工具參考](../tools/icd-tools.md)。
