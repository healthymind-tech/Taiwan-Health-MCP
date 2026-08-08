# Testing

Backend tests use **Node's built-in test runner** (`node --test`), executing TypeScript directly through `tsx`.

> The old pytest suite (`tests/test_*.py`) was removed along with the Python backend; there are no Python tests left in the repository.

## Running the tests

```bash
cd node-server
npm install
npm test          # node --import tsx --test src/**/*.test.ts
```

Type checking (worth running before every commit):

```bash
cd node-server
npm run typecheck # tsc --noEmit

cd ../web
npm run typecheck
```

## Current test coverage

Test files sit beside the code they cover (`src/**/*.test.ts`). Currently covered:

| Test file | Scope |
|-----------|-------|
| `node-server/src/loaders/loinc.test.ts` | The LOINC loader's parsing logic |

Coverage is currently thin — most behaviour was verified during the Python → Node migration by **differential runs** (feeding the same input to both implementations and comparing the output field by field) rather than being pinned down by unit tests. Please add tests alongside new functionality.

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
```
