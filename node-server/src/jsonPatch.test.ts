/** RFC 6901 / RFC 6902 helpers (jsonPatch.ts), incl. the RFC 6902 appendix A cases. */
import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch, formatPointer, jsonEqual, JsonPatchError, parsePointer, patchApplies, resolvePointer, type JsonPatchOp } from "./jsonPatch.js";

test("pointer parse / format round-trip with escapes (RFC 6901)", () => {
  assert.deepEqual(parsePointer(""), []);
  assert.deepEqual(parsePointer("/a~1b/m~0n/0"), ["a/b", "m~n", "0"]);
  assert.equal(formatPointer(["a/b", "m~n", 0]), "/a~1b/m~0n/0");
  assert.throws(() => parsePointer("a/b"), JsonPatchError);
  const doc = { foo: ["bar", "baz"], "": 0, "a/b": 1, "m~n": 8 };
  assert.deepEqual(resolvePointer(doc, "/foo/0"), { found: true, value: "bar" });
  assert.deepEqual(resolvePointer(doc, "/"), { found: true, value: 0 });
  assert.deepEqual(resolvePointer(doc, "/a~1b"), { found: true, value: 1 });
  assert.equal(resolvePointer(doc, "/foo/2").found, false);
  assert.equal(resolvePointer(doc, "/foo/01").found, false);
  assert.equal(resolvePointer(doc, "/foo/-").found, false);
});

const apply = (doc: unknown, ops: JsonPatchOp[]): unknown => applyPatch(structuredClone(doc), ops);

test("add: object member, array insert, append with '-'", () => {
  assert.deepEqual(apply({ foo: "bar" }, [{ op: "add", path: "/baz", value: "qux" }]), { foo: "bar", baz: "qux" });
  assert.deepEqual(apply({ foo: ["bar", "baz"] }, [{ op: "add", path: "/foo/1", value: "qux" }]), { foo: ["bar", "qux", "baz"] });
  assert.deepEqual(apply({ foo: ["bar"] }, [{ op: "add", path: "/foo/-", value: "x" }]), { foo: ["bar", "x"] });
  assert.deepEqual(apply({ foo: ["bar"] }, [{ op: "add", path: "/foo/1", value: "x" }]), { foo: ["bar", "x"] });
  assert.throws(() => apply({ foo: ["bar"] }, [{ op: "add", path: "/foo/2", value: "x" }]), JsonPatchError);
  assert.throws(() => apply({ foo: "bar" }, [{ op: "add", path: "/baz/bat", value: "qux" }]), JsonPatchError);
  assert.deepEqual(apply({ a: 1 }, [{ op: "add", path: "", value: { b: 2 } }]), { b: 2 });
});

test("remove / replace need an existing target", () => {
  assert.deepEqual(apply({ foo: ["bar", "qux", "baz"] }, [{ op: "remove", path: "/foo/1" }]), { foo: ["bar", "baz"] });
  assert.deepEqual(apply({ baz: "qux", foo: "bar" }, [{ op: "replace", path: "/baz", value: "boo" }]), { baz: "boo", foo: "bar" });
  assert.throws(() => apply({ foo: "bar" }, [{ op: "remove", path: "/nope" }]), JsonPatchError);
  assert.throws(() => apply({ foo: "bar" }, [{ op: "replace", path: "/nope", value: 1 }]), JsonPatchError);
  assert.throws(() => apply({ foo: [1] }, [{ op: "replace", path: "/foo/1", value: 1 }]), JsonPatchError);
});

test("move / copy / test", () => {
  assert.deepEqual(apply({ foo: { bar: "baz", waldo: "fred" }, qux: { corge: "grault" } }, [{ op: "move", from: "/foo/waldo", path: "/qux/thud" }]), {
    foo: { bar: "baz" },
    qux: { corge: "grault", thud: "fred" },
  });
  assert.deepEqual(apply({ foo: ["all", "grass", "cows", "eat"] }, [{ op: "move", from: "/foo/1", path: "/foo/3" }]), { foo: ["all", "cows", "eat", "grass"] });
  // move entry[2] to the front (document order)
  assert.deepEqual(apply({ entry: ["a", "b", "c"] }, [{ op: "move", from: "/entry/2", path: "/entry/0" }]), { entry: ["c", "a", "b"] });
  assert.throws(() => apply({ a: { b: 1 } }, [{ op: "move", from: "/a", path: "/a/b/c" }]), JsonPatchError);
  assert.deepEqual(apply({ a: { b: [1] } }, [{ op: "copy", from: "/a/b", path: "/c" }]), { a: { b: [1] }, c: [1] });
  assert.deepEqual(apply({ baz: "qux", foo: ["a", 2, "c"] }, [{ op: "test", path: "/foo", value: ["a", 2, "c"] }]), { baz: "qux", foo: ["a", 2, "c"] });
  assert.throws(() => apply({ baz: "qux" }, [{ op: "test", path: "/baz", value: "bar" }]), JsonPatchError);
});

test("patchApplies never modifies the document; jsonEqual ignores key order", () => {
  const doc = { a: [1, 2], b: { c: "d" } };
  const before = structuredClone(doc);
  assert.equal(patchApplies(doc, [{ op: "remove", path: "/a/0" }, { op: "add", path: "/b/e", value: 1 }]), true);
  assert.equal(patchApplies(doc, [{ op: "remove", path: "/a/5" }]), false);
  assert.deepEqual(doc, before);
  assert.ok(jsonEqual({ x: 1, y: [1, { z: 2 }] }, { y: [1, { z: 2 }], x: 1 }));
  assert.ok(!jsonEqual({ x: 1 }, { x: "1" }));
});

test("the patched value is a copy (later edits do not leak into the op)", () => {
  const value = { k: 1 };
  const out = apply({}, [{ op: "add", path: "/v", value }]) as Record<string, { k: number }>;
  out.v.k = 2;
  assert.equal(value.k, 1);
});
