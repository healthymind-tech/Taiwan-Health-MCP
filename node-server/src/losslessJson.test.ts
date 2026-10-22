/**
 * losslessJson: number spellings survive parse → restore → stringify; the serialiser is
 * byte-identical to JSON.stringify for plain data.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RawJson, RawNumber, hasRaw, isRawNumber, parseLossless, restoreNumbers, stringifyLossless, toPlain } from "./losslessJson.js";

const SAMPLE = '{"a":10.0,"b":1e3,"c":0.50,"d":-0.0,"e":12345678901234567890,"f":[1.10,{"g":2.000}],"h":"x\\u0000y\\"\\n","i":null,"j":true,"k":-1.5E+2,"l":0}';

test("parseLossless keeps every number's text and otherwise equals JSON.parse", () => {
  const t = parseLossless(SAMPLE) as Record<string, any>;
  assert.ok(isRawNumber(t.a));
  assert.equal(t.a.text, "10.0");
  assert.equal(t.b.text, "1e3");
  assert.equal(t.c.text, "0.50");
  assert.equal(t.d.text, "-0.0");
  assert.equal(t.e.text, "12345678901234567890");
  assert.equal(t.f[0].text, "1.10");
  assert.equal(t.f[1].g.text, "2.000");
  assert.equal(t.k.text, "-1.5E+2");
  assert.equal(t.l.text, "0");
  assert.deepEqual(toPlain(t), JSON.parse(SAMPLE));
  assert.deepEqual(Object.keys(t), Object.keys(JSON.parse(SAMPLE)), "key order");
  // Whitespace, nesting, escapes, BOM, surrogate pairs and lone surrogates behave like JSON.parse.
  for (const s of [' \n{ "a" : [ 1 , 2.0 , { } , [ ] ] , "b" : "\\ud83d\\ude00 \\ud800 \\/\\b\\f\\r\\t" } \t', "[]", "{}", '"s"', "3.25", "true", "null", '﻿{"a":1}']) {
    assert.deepEqual(toPlain(parseLossless(s)), JSON.parse(s.replace(/^﻿/, "")), s);
  }
  // Duplicate keys: first position, last value; "__proto__" is an own property.
  const dup = parseLossless('{"x":1,"y":2,"x":3.0}') as Record<string, any>;
  assert.deepEqual(Object.keys(dup), ["x", "y"]);
  assert.equal(dup.x.text, "3.0");
  const proto = parseLossless('{"__proto__":{"polluted":1.0},"z":1}') as Record<string, any>;
  assert.ok(Object.prototype.hasOwnProperty.call(proto, "__proto__"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});

test("parseLossless rejects what JSON.parse rejects", () => {
  for (const bad of ["", "{", "[1,]", '{"a":1,}', "01", "1.", ".5", "+1", "1e", "NaN", '"\n"', '"\\x"', '"\\u12"', "{a:1}", "[1] x", "tru", "nul", "--1", "1 2"]) {
    assert.throws(() => parseLossless(bad), SyntaxError, bad);
    assert.throws(() => JSON.parse(bad), SyntaxError, bad);
  }
});

test("stringifyLossless writes RawNumber texts verbatim and is byte-identical to JSON.stringify otherwise", () => {
  const t = parseLossless(SAMPLE);
  assert.equal(stringifyLossless(t), SAMPLE);
  const plain = [
    { a: 1, b: "x\u0000 \ud800", c: [null, undefined, () => 1, Symbol("s")], d: undefined, e: { f: new Date(0), g: -0, h: 1e21, i: 1.5e-7 } },
    [1, "2", true, null, { k: [] }],
    "str",
    42,
    null,
    { toJSON: () => ({ replaced: true }) },
    { nested: { deep: { deeper: [[[[0.1 + 0.2]]]] } } },
  ];
  for (const v of plain) assert.equal(stringifyLossless(v), JSON.stringify(v));
  assert.equal(stringifyLossless(undefined), JSON.stringify(undefined));
  // A RawNumber outside stringifyLossless serialises as a plain number (graceful degradation).
  assert.equal(JSON.stringify({ v: new RawNumber("10.0") }), '{"v":10}');
  assert.equal(JSON.stringify({ v: new RawJson('{"x":1.0}') }), '{"v":{"x":1}}');
  assert.equal(stringifyLossless({ v: new RawJson('{"x":1.0,"y":[1e3]}'), w: new RawNumber("0.50") }), '{"v":{"x":1.0,"y":[1e3]},"w":0.50}');
  // Caller data that merely looks like a placeholder is untouched.
  const tricky = { s: "\u0000abcN:10.0\u0000", t: '"\\u0000' };
  assert.equal(stringifyLossless(tricky), JSON.stringify(tricky));
  assert.equal(Number(new RawNumber("1e3")), 1000);
  assert.ok(hasRaw({ a: [{ b: new RawNumber("1") }] }));
  assert.ok(!hasRaw({ a: [{ b: 1 }] }));
});

test("restoreNumbers takes a number's spelling from the source only where the value is the same, keeping the output's structure", () => {
  const src = parseLossless('{"a":10.0,"b":[1.0,2.0],"c":{"d":3.00},"e":5,"f":1e3,"g":7,"wrapped":4.0}');
  const out = { a: 10, b: [1, 2, 3], c: { d: 3, extra: "x" }, e: 6, f: 1000, g: "7", h: 8, wrapped: [4] };
  const r = restoreNumbers(out, src) as Record<string, any>;
  assert.equal(r.a.text, "10.0");
  assert.equal(r.b[0].text, "1.0");
  assert.equal(r.b[1].text, "2.0");
  assert.equal(r.b[2], 3, "no counterpart: plain");
  assert.equal(r.c.d.text, "3.00");
  assert.equal(r.c.extra, "x");
  assert.equal(r.e, 6, "different value: the output's number wins");
  assert.equal(r.f.text, "1e3");
  assert.equal(r.g, "7");
  assert.equal(r.h, 8);
  assert.equal(r.wrapped[0].text, "4.0", "a value the tool wrapped into a single-element array");
  assert.deepEqual(Object.keys(r), Object.keys(out));
  assert.equal(stringifyLossless(r), '{"a":10.0,"b":[1.0,2.0,3],"c":{"d":3.00,"extra":"x"},"e":6,"f":1e3,"g":"7","h":8,"wrapped":[4.0]}');
  assert.deepEqual(toPlain(r), out, "same JSON value");
  // Shape mismatches never throw.
  assert.deepEqual(restoreNumbers({ a: 1 }, [1]), { a: 1 });
  assert.deepEqual(restoreNumbers([1], { a: 1 }), [1]);
  assert.equal(restoreNumbers(1, "1"), 1);
  assert.equal(restoreNumbers("s", new RawNumber("1")), "s");
  const big = restoreNumbers({ n: 12345678901234567890 }, parseLossless('{"n":12345678901234567890}')) as Record<string, any>;
  assert.equal(big.n.text, "12345678901234567890");
  const neg = restoreNumbers({ n: -0 }, parseLossless('{"n":-0.0}')) as Record<string, any>;
  assert.equal(neg.n.text, "-0.0");
  assert.equal((restoreNumbers({ n: 0 }, parseLossless('{"n":-0.0}')) as Record<string, any>).n.text, "-0.0", "-0.0 and 0 are the same JSON value, so the spelling is kept");
});

test("parse / restore / stringify overhead on a 30-entry Bundle is a few milliseconds", () => {
  const entry = (i: number): Record<string, unknown> => ({
    fullUrl: `urn:uuid:obs-${i}`,
    resource: {
      resourceType: "Observation",
      id: `o${i}`,
      status: "final",
      code: { coding: [{ system: "http://loinc.org", code: "2345-7", display: "Glucose" }], text: "血糖" },
      subject: { reference: "Patient/p1" },
      valueQuantity: { value: 10.0, unit: "mg/dL", system: "http://unitsofmeasure.org", code: "mg/dL" },
      referenceRange: [{ low: { value: 0.50 }, high: { value: 1e3 } }],
      extension: Array.from({ length: 5 }, (_, k) => ({ url: `http://example.tw/ext-${k}`, valueDecimal: k + 0.25 })),
      note: Array.from({ length: 4 }, (_, k) => ({ text: `note ${k} 備註 ".repeat".repeat(10)` })),
    },
  });
  const text = JSON.stringify({ resourceType: "Bundle", type: "collection", entry: Array.from({ length: 30 }, (_, i) => entry(i)) }).replace(/"value":10,/g, '"value":10.0,');
  const out = JSON.parse(text);
  const started = process.hrtime.bigint();
  let last = "";
  for (let i = 0; i < 20; i++) last = stringifyLossless(restoreNumbers(out, parseLossless(text)));
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / 20;
  assert.equal(last, text);
  assert.ok(ms < 50, `${ms.toFixed(2)} ms per round (${text.length} bytes)`);
  process.stderr.write(`losslessJson round-trip: ${ms.toFixed(2)} ms for ${text.length} bytes\n`);
});
