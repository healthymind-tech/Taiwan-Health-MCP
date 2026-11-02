import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSimpleEcl, simpleEclContains } from "./fhirSimpleEcl.js";

const sub = async (code: string, anc: string): Promise<boolean | undefined> => (anc === "999999" ? undefined : code === anc || (code === "111111" && anc === "222222"));
const c = async (e: string, code: string): Promise<boolean | undefined> => simpleEclContains(parseSimpleEcl(e)!, code, sub);

test("simple ECL: terms stripped, brackets, one operator per level; everything else is not parsed", () => {
  assert.deepEqual(parseSimpleEcl("<< 222222 |Thing| OR 333333"), {
    kind: "or",
    items: [
      { kind: "concept", op: "descendantsOrSelf", id: "222222" },
      { kind: "concept", op: "self", id: "333333" },
    ],
  });
  assert.ok(parseSimpleEcl("(< 222222 |A / B| OR < 333333) AND ^ 816080008 |Set|"));
  assert.ok(parseSimpleEcl("(< 222222 MINUS << 333333) AND ^ 816080008"));
  for (const e of ["<< 222222 : 333333 = 444444", "*", "<< 222222 OR 333333 AND 444444", "(<< 222222", "<< 222222 )", "234234 << 234234"]) assert.equal(parseSimpleEcl(e), null, e);
});

test("simple ECL: membership, three-valued", async () => {
  assert.equal(await c("<< 222222", "222222"), true);
  assert.equal(await c("< 222222", "222222"), false);
  assert.equal(await c("< 222222", "111111"), true);
  assert.equal(await c("<< 222222 OR 333333", "333333"), true);
  assert.equal(await c("<< 222222 AND << 333333", "111111"), false);
  assert.equal(await c("<< 999999 OR << 222222", "111111"), true);
  assert.equal(await c("<< 999999 OR << 222222", "444444"), undefined);
  assert.equal(await c("<< 999999 AND << 222222", "444444"), false);
  assert.equal(await c("<< 999999 AND << 222222", "111111"), undefined);
});

test("simple ECL: a reference set is unknown, MINUS and AND can still answer no", async () => {
  assert.equal(await c("< 222222 AND ^ 816080008", "111111"), undefined);
  assert.equal(await c("< 222222 AND ^ 816080008", "444444"), false);
  assert.equal(await c("(< 222222 MINUS << 111111) AND ^ 816080008", "111111"), false);
  assert.equal(await c("< 222222 MINUS << 333333", "111111"), true);
  assert.equal(await c("< 222222 MINUS ^ 816080008", "111111"), undefined);
});
