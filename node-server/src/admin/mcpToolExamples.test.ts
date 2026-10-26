import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toolCatalog, catalogToolInputSchema, TOOL_GROUPS, WRITE_CAPABLE_TOOLS } from "../mcp.js";
import { MCP_TOOL_EXAMPLES, toolExamples } from "./mcpToolExamples.js";

test("catalog lists every tool once, in a known group", () => {
  const catalog = toolCatalog();
  const names = catalog.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
  assert.equal(catalog.length, 70);
  const groupKeys = new Set(TOOL_GROUPS.map((g) => g.key));
  for (const t of catalog) assert.ok(groupKeys.has(t.group), `${t.name}: unknown group ${t.group}`);
  for (const g of TOOL_GROUPS) assert.ok(catalog.some((t) => t.group === g.key), `group ${g.key} is empty`);
  assert.ok(WRITE_CAPABLE_TOOLS.has("crud_fhir_server"));
  for (const w of WRITE_CAPABLE_TOOLS) assert.ok(names.includes(w), `write-capable ${w} not in catalog`);
});

test("catalog is computed without touching any service", () => {
  // toolCatalog() runs the register* functions against a placeholder service that throws on use;
  // reaching here (and the call above) means no registration path dereferences its service.
  assert.ok(toolCatalog().length > 0);
  assert.equal(toolCatalog(), toolCatalog(), "catalog is memoised");
});

test("catalog JSON Schema matches the OpenAPI bridge conversion", () => {
  for (const t of toolCatalog()) {
    const schema = catalogToolInputSchema(t);
    assert.equal(schema.type, "object", t.name);
    assert.equal(schema.$schema, undefined, `${t.name}: $schema must be stripped like the bridge`);
    assert.equal(schema.additionalProperties, false, t.name);
    const props = Object.keys((schema.properties ?? {}) as object);
    assert.deepEqual(props.sort(), Object.keys(t.shape).sort(), `${t.name}: property set`);
  }
  const search = catalogToolInputSchema(toolCatalog().find((t) => t.name === "search_medical_codes")!);
  assert.deepEqual(search.required, ["keyword"]);
  assert.deepEqual((search.properties as Record<string, unknown>).type, {
    type: "string",
    enum: ["diagnosis", "procedure", "all"],
    default: "all",
  });
});

test("every catalog tool has at least one curated example", () => {
  const missing = toolCatalog().filter((t) => !toolExamples(t.name)?.examples.length).map((t) => t.name);
  assert.deepEqual(missing, [], `tools without examples: ${missing.join(", ")}`);
});

test("no example targets a tool that does not exist", () => {
  const names = new Set(toolCatalog().map((t) => t.name));
  const stale = Object.keys(MCP_TOOL_EXAMPLES).filter((n) => !names.has(n));
  assert.deepEqual(stale, []);
});

test("every example parses against its tool's zod schema (strict: no unknown keys)", () => {
  for (const t of toolCatalog()) {
    const set = toolExamples(t.name)!;
    assert.ok(set.title.trim(), `${t.name}: title`);
    const ids = set.examples.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `${t.name}: duplicate example ids`);
    for (const ex of set.examples) {
      const parsed = z.object(t.shape).strict().safeParse(ex.args);
      assert.ok(parsed.success, `${t.name}/${ex.id}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
      assert.ok(ex.label.trim(), `${t.name}/${ex.id}: label`);
    }
  }
});

test("the default crud_fhir_server example is read-only", () => {
  const first = toolExamples("crud_fhir_server")!.examples[0];
  assert.equal(first.args.confirm_write, false);
  assert.ok(["metadata", "read", "search"].includes(String(first.args.operation)));
  for (const ex of toolExamples("crud_fhir_server")!.examples) assert.notEqual(ex.args.confirm_write, true, ex.id);
});

test("JSON-string arguments in examples are valid JSON", () => {
  const jsonKeys = ["condition_json", "medication_json", "results_json", "query_json", "resource_json", "patch_json"];
  for (const [name, set] of Object.entries(MCP_TOOL_EXAMPLES)) {
    for (const ex of set.examples) {
      for (const k of jsonKeys) {
        const v = ex.args[k];
        if (typeof v === "string" && v !== "") assert.doesNotThrow(() => JSON.parse(v), `${name}/${ex.id}.${k}`);
      }
    }
  }
});
