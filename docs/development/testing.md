# 測試指南

後端測試以 **Node 內建的測試執行器**（`node --test`）進行，透過 `tsx` 直接執行 TypeScript。

> 舊版的 pytest 測試套件（`tests/test_*.py`）已隨 Python 後端一併移除，倉庫內已無 Python 測試。

## 執行測試

```bash
cd node-server
npm install
npm test          # node --import tsx --test src/**/*.test.ts
```

型別檢查（提交前建議都跑）：

```bash
cd node-server
npm run typecheck # tsc --noEmit

cd ../web
npm run typecheck
```

## 目前的測試範疇

測試檔與被測程式放在一起（`src/**/*.test.ts`）。目前涵蓋：

| 測試檔 | 範疇 |
|--------|------|
| `node-server/src/loaders/loinc.test.ts` | LOINC loader 的解析邏輯 |

測試覆蓋率目前偏低——多數行為是在 Python → Node 遷移期間以**對照執行**的方式驗證的
（同一份輸入分別餵給新舊實作，逐欄位比對輸出），而不是以單元測試固定下來。
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
# 服務與各模組狀態
curl http://localhost:8080/status.json

# 目前已註冊的工具（依模組資料載入狀態動態變動）
curl http://localhost:8080/openapi.json

# 呼叫單一工具
curl -X POST http://localhost:8080/tools/search_medical_codes \
  -H 'Content-Type: application/json' \
  -d '{"query": "diabetes", "limit": 3}'
```
