import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCause, classifyMessage, describeAdminError, enrichErrorBody, workerOfflineWarning } from "./adminErrorCodes.js";

test("known validation messages map to codes with zh text and a next step", () => {
  const cases: Array<[string, string]> = [
    ["Missing uploaded source(s) for icd: icd10cm_order", "SOURCE_MISSING"],
    ["File type not allowed for loinc_zip. Accepted: .zip", "SOURCE_FILE_TYPE"],
    [
      "File content type rejected: Magika detected 'txt' but loinc_zip requires one of [zip]. Upload a valid file.",
      "SOURCE_CONTENT_MISMATCH",
    ],
    ["Cannot delete while a loinc_import job is running. Stop it in Jobs first.", "SOURCE_IN_USE"],
    ["Action 'resume' is not allowed for job status=succeeded control_state=none", "JOB_ACTION_NOT_ALLOWED"],
    ["Unsupported settings export version: 9", "SETTINGS_IMPORT_VERSION"],
    ["Malformed export: 'groups' must be an object", "SETTINGS_IMPORT_MALFORMED"],
    ["ocr.base_url: 'nope' is not a valid http(s) URL", "SETTING_URL_INVALID"],
    ["worker.max_jobs: 99 is out of range (1..16)", "SETTING_OUT_OF_RANGE"],
    ["base_url must be an absolute HTTP(S) URL", "FHIR_BASE_URL_INVALID"],
    ["Current password is incorrect.", "PASSWORD_CURRENT_WRONG"],
    ["Backup not found", "BACKUP_NOT_FOUND"],
    ["A snomed_import job is running. Stop it in Jobs before clearing this module.", "MODULE_BUSY"],
    ["Supplement not found", "SUPPLEMENT_NOT_FOUND"],
    ["Bundled supplement not found", "BUNDLED_SUPPLEMENT_NOT_FOUND"],
    ["content must be 'supplement' (FHIR R4 CodeSystem supplement)", "SUPPLEMENT_INVALID"],
  ];
  for (const [msg, code] of cases) {
    const d = classifyMessage(msg);
    assert.ok(d, msg);
    assert.equal(d.code, code, msg);
    assert.match(d.message_zh, /[一-鿿]/, `zh text for ${msg}`);
  }
  assert.ok(classifyMessage("Missing uploaded source(s) for icd: x")?.hint_zh?.includes("來源檔案"));
});

test("raw technical causes are classified (SQL, network, storage, upstream HTTP)", () => {
  const cases: Array<[string, string]> = [
    ['relation "fhir.concept_index" does not exist', "DB_SCHEMA_OUTDATED"],
    ['column "install_origin" of relation "ig_packages" does not exist', "DB_SCHEMA_OUTDATED"],
    ['duplicate key value violates unique constraint "fhir_servers_pkey"', "DB_DUPLICATE"],
    ['insert or update on table "x" violates foreign key constraint "y"', "DB_REFERENCE"],
    ['invalid input syntax for type uuid: "abc"', "DB_INVALID_INPUT"],
    ["connect ECONNREFUSED 127.0.0.1:9", "UPSTREAM_UNREACHABLE"],
    ["getaddrinfo ENOTFOUND nowhere.invalid", "UPSTREAM_DNS"],
    ["fetch failed", "UPSTREAM_UNREACHABLE"],
    ["The operation was aborted due to timeout", "UPSTREAM_TIMEOUT"],
    ['HTTP 404 from http://h/v1/embeddings: {"error":"x"}', "UPSTREAM_NOT_FOUND"],
    ["HTTP 503 from http://h/file_parse", "UPSTREAM_ERROR"],
    ["S3Error: NoSuchBucket", "STORAGE_UNAVAILABLE"],
  ];
  for (const [text, code] of cases) assert.equal(classifyCause(text)?.code, code, text);
  assert.equal(classifyCause("all good"), null);
});

test("a 500 with a raw detail names the operation and the cause, never only the raw text", () => {
  const d = describeAdminError(500, "Failed to create admin job", 'relation "admin.import_jobs" does not exist');
  assert.equal(d.code, "DB_SCHEMA_OUTDATED");
  assert.match(d.message_zh, /^建立背景工作失敗：/);
  assert.match(d.hint_zh ?? "", /migration/);
  const s = describeAdminError(500, "Settings operation failed", "HTTP 404 from http://x/v1/embeddings: {}");
  assert.equal(s.code, "UPSTREAM_NOT_FOUND");
  assert.match(s.message_zh, /^處理系統設定失敗/);
});

test("unknown errors still get a generic zh message with a next step", () => {
  const d = describeAdminError(500, "Failed to frobnicate", "boom");
  assert.equal(d.code, "INTERNAL_ERROR");
  assert.ok(d.hint_zh);
  assert.equal(describeAdminError(404, "whatever").code, "NOT_FOUND");
  assert.equal(describeAdminError(409, "whatever").code, "CONFLICT");
  assert.equal(describeAdminError(400, "weird input").code, "INVALID_REQUEST");
});

test("enrichErrorBody is additive and leaves coded / success / DB-lock bodies alone", () => {
  const out = enrichErrorBody(400, { error: "Backup not found", extra: 1 }) as Record<string, unknown>;
  assert.equal(out.error, "Backup not found");
  assert.equal(out.extra, 1);
  assert.equal(out.code, "BACKUP_NOT_FOUND");
  assert.ok(out.message_zh);
  const coded = { error: "x", code: "IG_HAS_DEPENDENTS" };
  assert.equal(enrichErrorBody(409, coded), coded);
  const ok = { error: "not really" };
  assert.equal(enrichErrorBody(200, ok), ok);
  const db = { error: "database_unavailable" };
  assert.equal(enrichErrorBody(503, db), db);
  assert.equal(enrichErrorBody(500, "text"), "text");
});

test("OAuth token failures distinguish a refusal from an unreachable server", () => {
  assert.equal(classifyMessage("Token request failed: HTTP 401 from https://as/token")?.code, "FHIR_OAUTH_TOKEN_REJECTED");
  assert.equal(classifyMessage('Token request failed: HTTP 400 {"error":"invalid_client"}')?.code, "FHIR_OAUTH_TOKEN_REJECTED");
  const d = classifyMessage("Token request failed: connect ECONNREFUSED 1.2.3.4:443");
  assert.equal(d?.code, "FHIR_OAUTH_TOKEN_FAILED");
  assert.match(d?.message_zh ?? "", /無法連線/);
});

test("workerOfflineWarning only when no live worker", () => {
  assert.equal(workerOfflineWarning([{ stale: false }, { stale: true }]), null);
  assert.equal(workerOfflineWarning([{ stale: true }])?.code, "WORKER_OFFLINE");
  assert.match(workerOfflineWarning([])?.hint_zh ?? "", /admin-worker/);
});

test("service tests and probes get zh explanations; LLM-coded results are untouched", async () => {
  const { explainServiceTest, explainProbe, explainJobError } = await import("./adminErrorCodes.js");
  const t = explainServiceTest("ocr", { ok: false, message: "OCR test failed: connect ECONNREFUSED 10.0.0.1:8000" });
  assert.equal(t.code, "UPSTREAM_UNREACHABLE");
  assert.match(t.message_zh ?? "", /^OCR（MinerU）連線測試失敗/);
  assert.match(t.hint_zh ?? "", /MinerU/);
  assert.equal(explainServiceTest("ocr", { ok: true, message: "MinerU 2.1 reachable at http://m:8000." }).message_zh, "已連線到 MinerU 2.1（http://m:8000）。");
  const coded = { ok: false, message: "x", code: "embedding_dims_mismatch" };
  assert.equal(explainServiceTest("embedding", coded), coded);
  const p = explainProbe({ service_key: "ocr_server", status: "error", message: "OCR server probe failed: getaddrinfo ENOTFOUND mineru" });
  assert.equal(p.message_zh, "無法解析外部服務的主機名稱。");
  assert.match(p.hint_zh ?? "", /外部服務 → OCR/);
  const llm = { service_key: "embedding_model", status: "error", message: "HTTP 404 from x" };
  assert.equal(explainProbe(llm), llm);
  assert.equal(
    explainJobError("Required service(s) not healthy: minio, ocr_server. Run an active service probe from the Services tab, then retry.")?.message_zh,
    "必要的服務目前無法使用：物件儲存（MinIO）、OCR 伺服器。",
  );
  assert.equal(explainJobError("some loader message nobody knows"), null);
});

test("FHIR connection results and stored probe errors are explained per step", async () => {
  const { explainFhirConnection, withFhirProbeErrorExplanation, explainInfrastructure } = await import("./adminErrorCodes.js");
  const r = explainFhirConnection({
    ok: false,
    probe: {
      status: "error",
      message: "connect ECONNREFUSED 127.0.0.1:9",
      details: { steps: [{ name: "fhir_metadata", status: "error", message: "FHIR metadata HTTP 404" }] },
    },
  }) as { probe: { message_zh?: string; details: { steps: Array<{ message_zh?: string; hint_zh?: string }> } } };
  assert.equal(r.probe.message_zh, "無法連線到外部服務。");
  assert.equal(r.probe.details.steps[0].message_zh, "伺服器找不到 /metadata（HTTP 404）。");
  assert.match(r.probe.details.steps[0].hint_zh ?? "", /FHIR 根路徑/);
  const s = withFhirProbeErrorExplanation({ last_probe_error: "getaddrinfo ENOTFOUND nowhere.invalid" }) as Record<string, unknown>;
  assert.equal(s.last_probe_error_zh, "無法解析外部服務的主機名稱。");
  const plain = { last_probe_error: "" };
  assert.equal(withFhirProbeErrorExplanation(plain), plain);
  const infra = explainInfrastructure({ minio: { status: "degraded", detail: "MinIO disabled by configuration" }, database: { status: "ok", detail: "PostgreSQL reachable" } });
  assert.match(infra.minio.detail_zh ?? "", /已停用/);
  assert.equal(infra.database.detail_zh, "資料庫連線正常");
});

test("QA-found messages: OCR 504, bad port, missing IG package, non-numeric setting, short password, playground codes", () => {
  assert.equal(classifyMessage("HTTP 504 from https://mineru.example/file_parse: <html>…")?.code, "OCR_HTTP_ERROR");
  assert.equal(classifyCause("fetch failed: bad port")?.code, "UPSTREAM_PORT_BLOCKED");
  assert.equal(classifyMessage("IG package qa.nonexistent.pkg@9.9.9 is not available from the registry: HTTP 404 from x")?.code, "IG_PACKAGE_NOT_FOUND");
  assert.equal(classifyMessage("ocr.timeout_seconds: 'abc' is not an integer")?.code, "SETTING_NOT_NUMBER");
  assert.equal(classifyMessage("New password must be at least 12 characters.")?.code, "PASSWORD_TOO_SHORT");
  assert.equal(classifyMessage("unknown_tool")?.code, "UNKNOWN_TOOL");
  assert.equal(classifyMessage("Not a readable FHIR package (.tgz with package/package.json)")?.code, "IG_PACKAGE_INVALID");
  assert.equal(
    classifyMessage("Archive for loinc does not contain the expected file (LoincTable/Loinc.csv). Found: readme.txt")?.code,
    "SOURCE_ARCHIVE_WRONG",
  );
});
