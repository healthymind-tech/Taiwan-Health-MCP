# Testing

Backend tests use **Node's built-in test runner** (`node --test`), executing TypeScript directly through `tsx`.

> The old pytest suite (`tests/test_*.py`) was removed along with the Python backend; there are no Python tests left in the repository.

## Running the tests

```bash
cd node-server
npm install
npm test          # node --import tsx --test 'src/**/*.test.ts' (node expands the glob: any depth)
```

Type checking (worth running before every commit):

```bash
cd node-server
npm run typecheck # tsc -p tsconfig.dev.json --noEmit

cd ../web-v2
npm run typecheck # tsc -b --noEmit
```

`web-v2/` has no test suite — only `typecheck`.

!!! warning "CI does not run tests"
    The only GitHub Actions workflow is `deploy-docs.yml` (builds and publishes MkDocs when `docs/` or `mkdocs.yml` changes on `main`).
    Nothing blocks a merge on a failing `npm test` / `npm run typecheck` — run both locally in `node-server/` and `web-v2/` before committing.

## Current test coverage

Test files sit beside the code they cover (`node-server/src/**/*.test.ts`). There are currently 61 test files with 721 test cases (2026-10-17; `npm test` takes about 40 s), by area:

| Area | Test files (under `node-server/src/`) |
|------|----------------------------------------|
| FHIR validator / IG / terminology | `fhirValidator.test.ts`, `fhirValidatorV2.test.ts`, `fhirValidator.v6.test.ts`, `fhirIg.test.ts`, `fhirCodeSystem.test.ts`, `fhirExternalTerminology.test.ts`, `fhirPath.test.ts`, `fhirRequiredElements.test.ts`, `fhirTestKit.test.ts` |
| Grounding | `groundingTools.test.ts`, `grounding/*.test.ts` |
| Model providers and routing | `providers/*.test.ts`, `admin/llmRouting*.test.ts`, `admin/llmErrorCodes.test.ts`, `admin/embeddingIdentity*.test.ts`, `admin/chatgptOAuth.qa.test.ts`, `embeddingService*.test.ts`, `analysisLlmClient*.test.ts`, `drugAnalysisService*.test.ts`, `rateLimiter.qa.test.ts` |
| Loaders | `loaders/icd.test.ts`, `loaders/loinc.test.ts`, `loaders/ig.test.ts`, `loaders/igRegistry.test.ts`, `loaders/embeddings.test.ts`, `loaders/batchPool.test.ts`, `loaders/drugRecordBuilder.test.ts`, `loaders/drugImageVariant.test.ts` |
| Admin backend | `admin/adminAuth.test.ts`, `admin/adminJobs.test.ts`, `admin/adminMcp.test.ts`, `admin/mcpToolExamples.test.ts`, `admin/igDependencies.test.ts`, `admin/igOrigin.test.ts`, `admin/igRemoval.test.ts`, `admin/termViz/termViz.test.ts`, `admin/fhirServerService.test.ts`, `admin/publicToolsSecurity.test.ts`, `admin/draftTarget.test.ts`, `admin/drugAssetResponse.test.ts` |
| Other | `clinicalCalculators.test.ts`, `config.test.ts` |

`*.qa.test.ts` files are QA regression tests; `npm test` runs them with the rest.

Some parity tests (`fhirRequiredElements.test.ts`, `grounding/completeness.test.ts`, and others) read a fixture directory that is not in version control;
when it is absent those cases are reported as skipped, not failed.

The item-by-item comparison of the FHIR validator with the official HL7 validator_cli 7.0.1 is not part of `npm test`: it is a
separate harness in `node-server/scripts/validator-audit/` (it needs a database with the IG packages loaded); results are in that directory's `REPORT.md`.

The tests remain pure unit tests: no Postgres, Redis or MinIO is started, so write new tests against injected / faked collaborators.
During the Python → Node migration most behaviour was verified by **differential runs** (feeding the same input to both implementations and comparing the output field by field); please add tests alongside new functionality.

## Writing a new test

Create `<name>.test.ts` next to the module under test, using Node's built-in `node:test` and `node:assert`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("parses a LOINC row", () => {
  assert.equal(actual, expected);
});
```

## End-to-end verification

Against a running environment, you can issue requests to the tool surface directly (through the nginx front door, `:8080` by default):

```bash
# Currently registered tools (varies with each module's data-load status)
curl http://localhost:8080/openapi.json

# Invoke a single tool
curl -X POST http://localhost:8080/tools/search_medical_codes \
  -H 'Content-Type: application/json' \
  -d '{"keyword": "diabetes", "limit": 3}'

# Server version, build (git sha), per-tool versions and loaded terminology editions
curl -X POST http://localhost:8080/tools/health_check -H 'Content-Type: application/json' -d '{}'
```

The admin console's **Integrations → MCP tools** page also offers a tool catalogue and a playground, which invokes tools exactly like `POST /tools/<name>`.
