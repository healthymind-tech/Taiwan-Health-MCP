/**
 * requestContext: a tool finds its lossless argument for each entry point (OpenAPI bridge,
 * admin playground, MCP JSON-RPC incl. a batch), and gets undefined outside a request.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRawNumber } from "./losslessJson.js";
import { losslessToolArgument, runWithRawRequest } from "./requestContext.js";

const BUNDLE = '{"resourceType":"Bundle","entry":[{"resource":{"valueQuantity":{"value":10.0}}}]}';

const valueText = (tree: unknown): string | null => {
  const v = (tree as any)?.entry?.[0]?.resource?.valueQuantity?.value;
  return isRawNumber(v) ? v.text : null;
};

test("POST /tools/<name>: the body is the argument object", async () => {
  const body = `{"bundle":${BUNDLE},"package_id":null}`;
  await runWithRawRequest("tools", Buffer.from(body, "utf8"), async () => {
    await Promise.resolve();
    assert.equal(valueText(losslessToolArgument("fhir_finalize_bundle", "bundle")), "10.0");
    assert.equal(losslessToolArgument("fhir_finalize_bundle", "missing"), undefined);
    assert.equal(losslessToolArgument("fhir_finalize_bundle", "package_id"), null, "a present null argument is returned as null");
  });
});

test("admin playground: arguments live under `arguments`", () => {
  runWithRawRequest("admin", `{"arguments":{"bundle":${BUNDLE}}}`, () => {
    assert.equal(valueText(losslessToolArgument("fhir_finalize_bundle", "bundle")), "10.0");
  });
  runWithRawRequest("admin", `{"bundle":${BUNDLE}}`, () => {
    assert.equal(losslessToolArgument("fhir_finalize_bundle", "bundle"), undefined);
  });
});

test("MCP JSON-RPC: the tools/call message's arguments; a batch is matched by request id, the tool name must match", async () => {
  const call = (id: unknown, name: string, value: string): string => `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"${name}","arguments":{"bundle":${BUNDLE.replace("10.0", value)}}}}`;
  await runWithRawRequest("mcp", Buffer.from(call(7, "fhir_finalize_bundle", "10.0")), async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(valueText(losslessToolArgument("fhir_finalize_bundle", "bundle", 7)), "10.0");
    assert.equal(valueText(losslessToolArgument("fhir_finalize_bundle", "bundle")), "10.0", "a single call needs no id");
    assert.equal(losslessToolArgument("fhir_validate_bundle", "bundle", 7), undefined, "another tool's call");
  });
  const batch = `[${call(1, "fhir_finalize_bundle", "1.0")},${call("two", "fhir_finalize_bundle", "2.0")},{"jsonrpc":"2.0","method":"notifications/initialized"}]`;
  runWithRawRequest("mcp", batch, () => {
    assert.equal(valueText(losslessToolArgument("fhir_finalize_bundle", "bundle", 1)), "1.0");
    assert.equal(valueText(losslessToolArgument("fhir_finalize_bundle", "bundle", "two")), "2.0");
    assert.equal(valueText(losslessToolArgument("fhir_finalize_bundle", "bundle", "1")), "1.0", "ids compare by their text");
    assert.equal(losslessToolArgument("fhir_finalize_bundle", "bundle"), undefined, "ambiguous without an id");
    assert.equal(losslessToolArgument("fhir_finalize_bundle", "bundle", 9), undefined);
  });
});

test("no context, no body, or an unparsable body → undefined (never throws)", () => {
  assert.equal(losslessToolArgument("fhir_finalize_bundle", "bundle"), undefined);
  runWithRawRequest("tools", undefined, () => assert.equal(losslessToolArgument("x", "bundle"), undefined));
  runWithRawRequest("tools", null, () => assert.equal(losslessToolArgument("x", "bundle"), undefined));
  runWithRawRequest("tools", "{not json", () => {
    assert.equal(losslessToolArgument("x", "bundle"), undefined);
    assert.equal(losslessToolArgument("x", "bundle"), undefined, "parse failure remembered");
  });
  runWithRawRequest("tools", "[1,2]", () => assert.equal(losslessToolArgument("x", "bundle"), undefined));
});

test("the context does not leak between concurrent requests", async () => {
  const results = await Promise.all(
    ["1.0", "2.0", "3.0"].map((v) =>
      runWithRawRequest("tools", `{"bundle":${BUNDLE.replace("10.0", v)}}`, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return valueText(losslessToolArgument("t", "bundle"));
      }),
    ),
  );
  assert.deepEqual(results, ["1.0", "2.0", "3.0"]);
});
