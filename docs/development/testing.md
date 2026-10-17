# 測試指南

後端測試以 **Node 內建的測試執行器**（`node --test`）進行，透過 `tsx` 直接執行 TypeScript。

> 舊版的 pytest 測試套件（`tests/test_*.py`）已隨 Python 後端一併移除，倉庫內已無 Python 測試。

## 執行測試

```bash
cd node-server
npm install
npm test          # node --import tsx --test 'src/**/*.test.ts'（由 node 展開 glob，任意深度）
```

型別檢查（提交前建議都跑）：

```bash
cd node-server
npm run typecheck # tsc -p tsconfig.dev.json --noEmit

cd ../web-v2
npm run typecheck # tsc -b --noEmit
```

`web-v2/` 沒有測試套件，只有 `typecheck`。

!!! warning "CI 不跑測試"
    唯一的 GitHub Actions workflow 是 `deploy-docs.yml`（`main` 上的 `docs/` 或 `mkdocs.yml` 有變更時建置並發佈 MkDocs）。
    沒有任何檢查會擋下 `npm test` / `npm run typecheck` 失敗的合併——提交前請在 `node-server/` 與 `web-v2/` 本機都跑過。

## 目前的測試範疇

測試檔與被測程式放在一起（`node-server/src/**/*.test.ts`）。目前共 61 個測試檔、721 個測試案例（2026-10-17，`npm test` 約 40 秒），依領域分布：

| 領域 | 測試檔（`node-server/src/` 底下） |
|------|------------------------------------|
| FHIR validator / IG / 術語 | `fhirValidator.test.ts`、`fhirValidatorV2.test.ts`、`fhirValidator.v6.test.ts`、`fhirIg.test.ts`、`fhirCodeSystem.test.ts`、`fhirExternalTerminology.test.ts`、`fhirPath.test.ts`、`fhirRequiredElements.test.ts`、`fhirTestKit.test.ts` |
| Grounding | `groundingTools.test.ts`、`grounding/*.test.ts` |
| 模型 provider 與路由 | `providers/*.test.ts`、`admin/llmRouting*.test.ts`、`admin/llmErrorCodes.test.ts`、`admin/embeddingIdentity*.test.ts`、`admin/chatgptOAuth.qa.test.ts`、`embeddingService*.test.ts`、`analysisLlmClient*.test.ts`、`drugAnalysisService*.test.ts`、`rateLimiter.qa.test.ts` |
| 載入器 | `loaders/icd.test.ts`、`loaders/loinc.test.ts`、`loaders/ig.test.ts`、`loaders/igRegistry.test.ts`、`loaders/embeddings.test.ts`、`loaders/batchPool.test.ts`、`loaders/drugRecordBuilder.test.ts`、`loaders/drugImageVariant.test.ts` |
| 管理後台後端 | `admin/adminAuth.test.ts`、`admin/adminJobs.test.ts`、`admin/adminMcp.test.ts`、`admin/mcpToolExamples.test.ts`、`admin/igDependencies.test.ts`、`admin/igOrigin.test.ts`、`admin/igRemoval.test.ts`、`admin/termViz/termViz.test.ts`、`admin/fhirServerService.test.ts`、`admin/publicToolsSecurity.test.ts`、`admin/draftTarget.test.ts`、`admin/drugAssetResponse.test.ts` |
| 其他 | `clinicalCalculators.test.ts`、`config.test.ts` |

`*.qa.test.ts` 是 QA 回歸測試，與一般測試一起由 `npm test` 執行。

部分對照測試（`fhirRequiredElements.test.ts`、`grounding/completeness.test.ts` 等）讀取不在版控中的 fixture 目錄；
該目錄不存在時，這些案例會標記為 skipped 而不是失敗。

FHIR validator 與 HL7 官方 validator_cli 7.0.1 的逐筆比對不在 `npm test` 內，而是 `node-server/scripts/validator-audit/`
的獨立 harness（需要連得到載有 IG 套件的 DB），結果見該目錄的 `REPORT.md`。

測試仍是純單元測試：不啟動 Postgres、Redis 或 MinIO，新測試請以注入 / 假的協作者撰寫。
Python → Node 遷移期間，多數行為是以**對照執行**的方式驗證的（同一份輸入分別餵給新舊實作，逐欄位比對輸出），
新增功能時請補上對應測試。

## 撰寫新測試

在被測模組旁建立 `<name>.test.ts`，使用 Node 內建的 `node:test` 與 `node:assert`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("parses a LOINC row", () => {
  assert.equal(actual, expected);
});
```

## 端對端驗證

在跑起來的環境上，可直接對工具面發請求（經由 nginx 前門，預設 `:8080`）：

```bash
# 目前已註冊的工具（依模組資料載入狀態動態變動）
curl http://localhost:8080/openapi.json

# 呼叫單一工具
curl -X POST http://localhost:8080/tools/search_medical_codes \
  -H 'Content-Type: application/json' \
  -d '{"keyword": "diabetes", "limit": 3}'

# 伺服器版本、build（git sha）、各工具版本與已載入的術語版本
curl -X POST http://localhost:8080/tools/health_check -H 'Content-Type: application/json' -d '{}'
```

管理後台 **整合 → MCP 工具** 也提供工具目錄與線上測試（playground），呼叫方式與 `POST /tools/<name>` 相同。
