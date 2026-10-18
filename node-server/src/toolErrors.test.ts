import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolArgumentError,
  ToolExecutionError,
  classifyFetchError,
  classifyToolException,
  closestName,
  describeArgumentIssues,
  describeParam,
  toolErrorFields,
  toolUnavailableInfo,
} from "./toolErrors.js";
import { captureToolRegistrations, catalogRefs, drugSearchEmptyHint, withToolErrorBoundary, type RegisteredTool } from "./mcp.js";
import { icdNotFoundHint, normalizeIcdCode } from "./icdService.js";
import { loincNotFoundHint } from "./labService.js";
import { crudValidationHint, fhirHttpStatusHint } from "./fhirServerService.js";
import { IG_ERROR_HINTS } from "./fhirIgService.js";

const SHAPE = {
  keyword: z.string(),
  type: z.enum(["diagnosis", "procedure", "all"]).default("all"),
  limit: z.number().int().min(1).max(50).default(3),
  identifier: z.string().nullish().default(null),
};

function issuesFor(args: unknown): z.ZodIssue[] {
  const r = z.object(SHAPE).safeParse(args);
  assert.equal(r.success, false);
  return (r as { error: z.ZodError }).error.issues;
}

test("describeParam: types, enums, bounds, defaults and examples", () => {
  assert.deepEqual(
    { ...describeParam("limit", SHAPE.limit) },
    { name: "limit", type: "integer", required: false, default: 3, min: 1, max: 50, example: 3 },
  );
  const t = describeParam("type", SHAPE.type);
  assert.deepEqual(t.allowed, ["diagnosis", "procedure", "all"]);
  assert.equal(t.example, "all");
  assert.equal(describeParam("keyword", SHAPE.keyword).required, true);
  assert.equal(describeParam("identifier", SHAPE.identifier).required, false);
  const bounded = describeParam("age", z.number().int().min(18).max(120));
  assert.equal(bounded.example, 69);
});

test("describeArgumentIssues: names the parameter, rule and example (numeric string, enum, required, bounds)", () => {
  const info = describeArgumentIssues("search_medical_codes", SHAPE, issuesFor({ keyword: "x", limit: "5", type: "foo" }), {
    keyword: "x",
    limit: "5",
    type: "foo",
  });
  assert.equal(info.code, "INVALID_ARGUMENTS");
  assert.match(info.message, /`limit` must be a JSON number, not a string \(got "5"; send 5 without quotes\)/);
  assert.match(info.message, /`type` must be one of "diagnosis", "procedure", "all" \(got "foo"\)/);
  assert.match(info.hint, /keyword \(string, required\)/);
  assert.match(info.hint, /limit \(integer, default 3\)/);
  assert.deepEqual(info.example_arguments.keyword, "<keyword>");

  const missing = describeArgumentIssues("search_medical_codes", SHAPE, issuesFor({}), {});
  assert.match(missing.message, /`keyword` is required but was not provided/);

  const big = describeArgumentIssues("search_medical_codes", SHAPE, issuesFor({ keyword: "x", limit: 999 }), { keyword: "x", limit: 999 });
  assert.match(big.message, /`limit` must be <= 50 \(got 999\)/);
  assert.equal(big.problems[0].expected, "integer between 1 and 50");
});

test("describeArgumentIssues: arguments the tool does not take are listed with a did-you-mean", () => {
  const args = { url: "http://x", identifer: "y", limit: "abc" };
  const info = describeArgumentIssues("t", SHAPE, issuesFor(args), args);
  assert.deepEqual(info.unknown_parameters, ["url", "identifer"]);
  assert.match(info.message, /identifer \(did you mean identifier\?\)/);
  assert.match(info.message, /`limit` must be number \(got string "abc"\)/);
});

test("closestName: tolerant but not random", () => {
  assert.equal(closestName("serach_drug", ["search_drug", "get_drug_details"]), "search_drug");
  assert.equal(closestName("zzz", ["search_drug", "get_drug_details"]), null);
});

test("toolUnavailableInfo: unknown tool vs module without data", () => {
  const catalog = catalogRefs();
  const unknown = toolUnavailableInfo("serch_drug", catalog);
  assert.equal(unknown.code, "UNKNOWN_TOOL");
  assert.match(unknown.message, /Did you mean 'search_drug'/);
  const food = toolUnavailableInfo("query_food_nutrition", catalog);
  assert.equal(food.code, "TOOL_NOT_AVAILABLE");
  assert.equal(food.retryable, false);
  assert.match(food.message, /food nutrition database/);
  assert.match(food.hint, /administrator must import/);
  // Derived groups point at the module whose data they read.
  assert.match(toolUnavailableInfo("query_fhir_condition", catalog).message, /ICD-10-CM/);
});

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: "ERROR", routine: "x" });
}

test("classifyToolException: SQL errors never leak; each class gets a code and a next step", () => {
  const leak = classifyToolException("query_loinc", pgError("42601", 'syntax error at or near "desc"'));
  assert.equal(leak.code, "INTERNAL_QUERY_FAILED");
  assert.equal(leak.internal, true);
  assert.doesNotMatch(leak.message, /syntax error|desc/);
  assert.equal(classifyToolException("t", pgError("42P01", 'relation "loinc.x" does not exist')).code, "DATA_NOT_LOADED");
  assert.equal(classifyToolException("t", pgError("42703", 'column "y" does not exist')).code, "SERVER_SCHEMA_OUTDATED");
  assert.equal(classifyToolException("t", pgError("57014", "canceling statement")).code, "QUERY_TIMEOUT");
  assert.equal(classifyToolException("t", pgError("22P02", 'invalid input syntax for type integer: "abc"')).code, "INVALID_ARGUMENT_VALUE");
  const down = classifyToolException("t", pgError("08006", "connection failure"));
  assert.equal(down.code, "DATABASE_UNAVAILABLE");
  assert.equal(down.retryable, true);
  assert.equal(classifyToolException("t", Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" })).code, "SERVICE_UNAVAILABLE");
  const app = classifyToolException("t", new Error("bad things\n    at stack frame"));
  assert.equal(app.code, "TOOL_EXECUTION_FAILED");
  assert.equal(app.message, "t failed: bad things");
});

test("classifyFetchError: timeout / DNS / refused / TLS / reset", () => {
  const where = "FHIR server 'x' (https://x.test)";
  assert.equal(classifyFetchError(Object.assign(new Error("aborted"), { name: "AbortError" }), where, 30).code, "UPSTREAM_TIMEOUT");
  const dns = classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }), where);
  assert.equal(dns.code, "UPSTREAM_DNS_FAILED");
  assert.equal(dns.retryable, false);
  assert.match(dns.hint, /FHIR 伺服器/);
  assert.equal(classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), where).code, "UPSTREAM_UNREACHABLE");
  assert.equal(
    classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }), where).code,
    "UPSTREAM_TLS_ERROR",
  );
  assert.equal(classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), where).code, "UPSTREAM_CONNECTION_RESET");
  assert.equal(classifyFetchError(new TypeError("fetch failed"), where).code, "UPSTREAM_REQUEST_FAILED");
});

test("toolErrorFields: REST bridge additive fields for argument, execution, unknown-tool and other errors", () => {
  const issues = issuesFor({});
  const argErr = new ToolArgumentError(issues, describeArgumentIssues("t", SHAPE, issues, {}));
  assert.ok(argErr instanceof z.ZodError, "still a ZodError for existing callers");
  const f = toolErrorFields("t", argErr);
  assert.equal(f.code, "INVALID_ARGUMENTS");
  assert.ok(Array.isArray(f.expected_parameters));
  const exec = toolErrorFields("t", new ToolExecutionError({ code: "DATA_NOT_LOADED", message: "m", hint: "h", retryable: false }));
  assert.deepEqual(exec, { code: "DATA_NOT_LOADED", message: "m", hint: "h", retryable: false });
  const unknown = toolErrorFields("x", Object.assign(new Error("unknown_tool: x"), { toolError: { code: "UNKNOWN_TOOL", message: "m", hint: "h", retryable: false } }));
  assert.equal(unknown.code, "UNKNOWN_TOOL");
  assert.equal(toolErrorFields("t", pgError("42601", "syntax")).code, "INTERNAL_QUERY_FAILED");
});

test("withToolErrorBoundary: sanitizes thrown errors, logs without arguments, passes results through", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const log = (_m: string, f: Record<string, unknown>): void => void logs.push(f);
  const ok = withToolErrorBoundary("t", async (x: number) => x + 1, log);
  assert.equal(await ok(1), 2);
  const bad = withToolErrorBoundary("query_loinc", async (_a: { secret: string }) => {
    throw pgError("42601", 'syntax error at or near "desc"');
  }, log);
  await assert.rejects(bad({ secret: "patient-text" }), (e: unknown) => {
    assert.ok(e instanceof ToolExecutionError);
    assert.match((e as Error).message, /^\[INTERNAL_QUERY_FAILED\] .* Hint: /);
    assert.doesNotMatch((e as Error).message, /syntax error/);
    return true;
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].sqlstate, "42601");
  assert.doesNotMatch(JSON.stringify(logs), /patient-text/);
  const sensitive = withToolErrorBoundary("fhir_check_grounding", async () => {
    throw new Error("boom with clinical text");
  }, log);
  await assert.rejects(sensitive());
  assert.equal(logs[1].message, undefined, "no message logged for clinical-text tools");
});

test("MCP transport: validation errors, unknown / not-loaded tools and handler failures are actionable", async () => {
  const server = new McpServer({ name: "t", version: "0" });
  const into = new Map<string, RegisteredTool>();
  captureToolRegistrations(server, into);
  server.registerTool("qa_limit_tool", { description: "x", inputSchema: { keyword: z.string(), limit: z.number().int().default(3) } }, async () => ({
    content: [{ type: "text" as const, text: "{}" }],
  }));
  server.registerTool("qa_failing_tool", { description: "x", inputSchema: {} }, async () => {
    throw pgError("42P01", 'relation "food_nutrition.items" does not exist');
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const bad = (await client.callTool({ name: "qa_limit_tool", arguments: { limit: "7" } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(bad.isError, true);
    const text = bad.content[0].text;
    assert.match(text, /Input validation error: Invalid arguments for tool qa_limit_tool: /, "SDK prefix kept");
    assert.match(text, /`keyword` is required/);
    assert.match(text, /`limit` must be a JSON number/);
    assert.match(text, /Minimal example arguments: \{"keyword":"<keyword>"/);

    const missing = (await client.callTool({ name: "query_food_nutrition", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Tool query_food_nutrition not found\. \[TOOL_NOT_AVAILABLE\]/);
    assert.match(missing.content[0].text, /administrator must import the Taiwan FDA food nutrition database/);

    const failing = (await client.callTool({ name: "qa_failing_tool", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(failing.isError, true);
    assert.match(failing.content[0].text, /^\[DATA_NOT_LOADED\]/);
    assert.doesNotMatch(failing.content[0].text, /relation/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("domain hints: ICD / LOINC / FHIR server / drug / IG", () => {
  assert.equal(normalizeIcdCode(" e119 "), "E11.9");
  assert.equal(normalizeIcdCode("E11.9"), "E11.9");
  assert.equal(normalizeIcdCode("E11"), "E11");
  assert.match(icdNotFoundHint("e119"), /dotted form E11\.9/);
  assert.match(icdNotFoundHint("E11.999"), /search_medical_codes/);
  assert.match(loincNotFoundHint("2345"), /look like 2345-7/);
  assert.doesNotMatch(loincNotFoundHint("99999-9"), /look like/);
  assert.equal(fhirHttpStatusHint(200, "read"), null);
  assert.match(fhirHttpStatusHint(404, "read") ?? "", /operation=search/);
  assert.match(fhirHttpStatusHint(401, "search") ?? "", /token_strategy=fresh/);
  assert.match(fhirHttpStatusHint(503, "search") ?? "", /retry later/);
  assert.match(crudValidationHint("resource_json is required for create"), /resource_json=/);
  assert.match(crudValidationHint("resource_type must be a valid FHIR ResourceType"), /Patient/);
  assert.match(drugSearchEmptyHint("drug_name", false, { results: [], search_mode: "keyword_only" }), /literal name matches/);
  assert.match(drugSearchEmptyHint("atc_code", true, { results: [] }), /N02BE01/);
  for (const code of ["IG_NOT_FOUND", "NO_DEFAULT_IG", "ARTIFACT_NOT_FOUND", "VALUESET_NOT_FOUND"]) assert.ok(IG_ERROR_HINTS[code]);
});
