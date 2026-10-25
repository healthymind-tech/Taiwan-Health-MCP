/**
 * Value grammar (values.ts): pure parsers, at least three examples per kind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RawNumber } from "../losslessJson.js";
import {
  chineseNumber,
  classifyReference,
  fitDate,
  parseBoolean,
  parseDateValue,
  parseFrequency,
  parseHumanNameValue,
  parseInteger,
  parseNumber,
  parsePeriodValue,
  parseQuantityValue,
  parseTimeValue,
  resolveUnit,
  shapeType,
  syntheticDatatypeSd,
  timeUnitCode,
} from "./values.js";

const UCUM = "http://unitsofmeasure.org";

test("numbers: JSON numbers pass, numeric strings keep a non-canonical spelling, integers are checked", () => {
  assert.deepEqual(parseNumber(95), { ok: true, value: 95 });
  assert.deepEqual(parseNumber("95"), { ok: true, value: 95 });
  const r = parseNumber("95.0");
  assert.ok(r.ok && r.value instanceof RawNumber && r.value.text === "95.0");
  assert.equal(parseNumber("1,250").ok && Number((parseNumber("1,250") as any).value), 1250);
  assert.ok(!parseNumber("abc").ok);
  assert.ok(!parseNumber(Infinity).ok);
  assert.deepEqual(parseInteger("7"), { ok: true, value: 7 });
  assert.ok(!parseInteger(7.5).ok);
  assert.ok(!parseInteger(0, "positiveInt").ok);
  assert.ok(!parseInteger(-1, "unsignedInt").ok);
  assert.deepEqual(parseBoolean("yes"), { ok: true, value: true });
  assert.deepEqual(parseBoolean("否"), { ok: true, value: false });
  assert.ok(!parseBoolean("maybe").ok);
});

test("dates: ISO precisions and offsets", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["2026", "2026", "year", false],
    ["2026-06", "2026-06", "month", false],
    ["2026-6-5", "2026-06-05", "day", false],
    ["2026-06-15T06:00", "2026-06-15T06:00:00", "time", false],
    ["2026-06-15 06:00:30", "2026-06-15T06:00:30", "time", false],
    ["2026-06-15T06:00:30.250+0800", "2026-06-15T06:00:30.250+08:00", "time", true],
    ["2026-06-15T06:00Z", "2026-06-15T06:00:00Z", "time", true],
  ];
  for (const [given, value, precision, hasOffset] of cases) {
    const r = parseDateValue(given);
    assert.ok(r.ok, given);
    assert.equal(r.value.value, value, given);
    assert.equal(r.value.precision, precision, given);
    assert.equal(r.value.hasOffset, hasOffset, given);
    assert.equal(r.value.roc, false, given);
  }
});

test("dates: ROC forms convert with +1911 and keep their precision", () => {
  const cases: Array<[string, string, string]> = [
    ["115/06/15", "2026-06-15", "day"],
    ["115/6/5", "2026-06-05", "day"],
    ["民國115年6月15日", "2026-06-15", "day"],
    ["ROC 115/06/15 06:00", "2026-06-15T06:00:00", "time"],
    ["115-06-15 14:05:09", "2026-06-15T14:05:09", "time"],
    ["115.06.15", "2026-06-15", "day"],
    ["115年6月", "2026-06", "month"],
    ["民國79年", "1990", "year"],
    ["1/1/1", "1912-01-01", "day"],
  ];
  for (const [given, value, precision] of cases) {
    const r = parseDateValue(given);
    assert.ok(r.ok, `${given}: ${(r as any).message}`);
    assert.equal(r.value.value, value, given);
    assert.equal(r.value.precision, precision, given);
    assert.equal(r.value.roc, true, given);
  }
  assert.equal(parseDateValue("2026/06/15").ok && (parseDateValue("2026/06/15") as any).value.roc, false, "a 4-digit slash year is Gregorian");
});

test("dates: impossible calendar dates and times are rejected", () => {
  for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "115/13/01", "115/02/30", "2026-06-15T24:00", "2026-06-15T23:61", "2026-06-15T06:00+15:00", "0/06/15", "0000-01-01", "June 15", "20260615", "2026-06-15T06", ""]) {
    assert.ok(!parseDateValue(bad).ok, bad);
  }
  assert.ok(parseDateValue("2024-02-29").ok, "leap day");
  assert.ok(!parseDateValue(20260615 as unknown as string).ok, "not a string");
});

test("fitDate: date vs dateTime vs instant, offset completion from the context timezone only", () => {
  const day = parseDateValue("2026-06-15");
  const time = parseDateValue("2026-06-15T06:00");
  const midnight = parseDateValue("2026-06-15T00:00");
  const offset = parseDateValue("2026-06-15T06:00+08:00");
  assert.ok(day.ok && time.ok && midnight.ok && offset.ok);
  assert.deepEqual(fitDate(day.value, "date"), { ok: true, value: "2026-06-15" });
  assert.deepEqual(fitDate(midnight.value, "date"), { ok: true, value: "2026-06-15" });
  assert.ok(!fitDate(time.value, "date").ok);
  assert.deepEqual(fitDate(day.value, "dateTime"), { ok: true, value: "2026-06-15" });
  assert.ok(!fitDate(time.value, "dateTime").ok, "no offset, no timezone → error");
  assert.deepEqual(fitDate(time.value, "dateTime", "+08:00"), { ok: true, value: "2026-06-15T06:00:00+08:00" });
  assert.deepEqual(fitDate(time.value, "dateTime", "Z"), { ok: true, value: "2026-06-15T06:00:00Z" });
  assert.deepEqual(fitDate(offset.value, "dateTime", "+01:00"), { ok: true, value: "2026-06-15T06:00:00+08:00" }, "a given offset is never replaced");
  assert.ok(!fitDate(day.value, "instant").ok);
  assert.ok(!fitDate(time.value, "instant").ok);
  assert.deepEqual(fitDate(offset.value, "instant"), { ok: true, value: "2026-06-15T06:00:00+08:00" });
  assert.deepEqual(parseTimeValue("6:05"), { ok: true, value: "06:05:00" });
  assert.deepEqual(parseTimeValue("23:59:59.5"), { ok: true, value: "23:59:59.5" });
  assert.ok(!parseTimeValue("25:00").ok);
});

test("units: UCUM expressions, UCUM names / synonyms / print symbols, spelling repairs, unknown words", () => {
  const cases: Array<[string, string | null, string | null]> = [
    ["mg/dL", "mg/dL", "ucum"],
    ["mmol/L", "mmol/L", "ucum"],
    ["%", "%", "ucum"],
    ["mm[Hg]", "mm[Hg]", "ucum"],
    ["mmHg", "mm[Hg]", "name"],
    ["millimeter of mercury", "mm[Hg]", "name"],
    ["°C", "Cel", "name"],
    ["kilogram", "kg", "name"],
    ["bpm", "/min", "spelling"],
    ["beats/min", "/min", "rate"],
    ["mcg", "ug", "name"],
    ["tablet", "{tablet}", "spelling"],
    ["次/分", "/min", "rate"],
    ["次/分鐘", "/min", "rate"],
    ["mg/天", "mg/d", "rate"],
    ["顆粒/分", null, null],
    ["", null, null],
  ];
  for (const [text, code, source] of cases) {
    const r = resolveUnit(text);
    assert.equal(r?.code ?? null, code, text);
    assert.equal(r?.source ?? null, source, text);
  }
});

test("quantity: text, number and object forms; comparator; unit text kept with its UCUM code", () => {
  const ok: Array<[unknown, Record<string, unknown>]> = [
    ["95 mg/dL", { value: 95, unit: "mg/dL", system: UCUM, code: "mg/dL", codeResolved: true }],
    ["95mg/dL", { value: 95, unit: "mg/dL", system: UCUM, code: "mg/dL", codeResolved: true }],
    [" <= 0.5 ng/mL ", { value: 0.5, comparator: "<=", unit: "ng/mL", system: UCUM, code: "ng/mL", codeResolved: true }],
    ["72", { value: 72 }],
    [72.5, { value: 72.5 }],
    [{ value: 120, unit: "mmHg" }, { value: 120, unit: "mmHg", system: UCUM, code: "mm[Hg]", codeResolved: true }],
    [{ value: "60", unit: "kg", comparator: ">" }, { value: 60, comparator: ">", unit: "kg", system: UCUM, code: "kg", codeResolved: true }],
    [{ value: 2, unit: "tab", code: "{tablet}" }, { value: 2, unit: "tab", code: "{tablet}", system: UCUM }],
    [{ value: 1, unit: "包" }, { value: 1, unit: "包" }],
    [{ value: 3, code: "mg", system: "http://x.example/units" }, { value: 3, code: "mg", system: "http://x.example/units" }],
  ];
  for (const [given, want] of ok) {
    const r = parseQuantityValue(given);
    assert.ok(r.ok, JSON.stringify(given));
    assert.deepEqual(r.value, want, JSON.stringify(given));
  }
  for (const bad of ["mg/dL", "about 95", { unit: "mg" }, { value: "x" }, { value: 1, comparator: "~" }, true, null]) {
    assert.ok(!parseQuantityValue(bad).ok, JSON.stringify(bad));
  }
});

test("frequency grammar: HL7 abbreviations", () => {
  const cases: Array<[string, Record<string, unknown>, string | undefined, boolean | undefined]> = [
    ["BID", { frequency: 2, period: 1, periodUnit: "d" }, "BID", undefined],
    ["tid", { frequency: 3, period: 1, periodUnit: "d" }, "TID", undefined],
    ["QID", { frequency: 4, period: 1, periodUnit: "d" }, "QID", undefined],
    ["QD", { frequency: 1, period: 1, periodUnit: "d" }, "QD", undefined],
    ["qod", { frequency: 1, period: 2, periodUnit: "d" }, "QOD", undefined],
    ["q8h", { frequency: 1, period: 8, periodUnit: "h" }, "Q8H", undefined],
    ["Q12H", { frequency: 1, period: 12, periodUnit: "h" }, "Q12H", undefined],
    ["q6°", { frequency: 1, period: 6, periodUnit: "h" }, "Q6H", undefined],
    ["q2d", { frequency: 1, period: 2, periodUnit: "d" }, "QOD", undefined],
    ["qw", { frequency: 1, period: 1, periodUnit: "wk" }, "QW", undefined],
    ["HS", { frequency: 1, period: 1, periodUnit: "d", when: ["HS"] }, "QHS", undefined],
    ["QHS", { frequency: 1, period: 1, periodUnit: "d", when: ["HS"] }, "QHS", undefined],
    ["TID AC", { frequency: 3, period: 1, periodUnit: "d", when: ["AC"] }, "TID", undefined],
    ["BID PC", { frequency: 2, period: 1, periodUnit: "d", when: ["PC"] }, "BID", undefined],
    ["q4h prn", { frequency: 1, period: 4, periodUnit: "h" }, "Q4H", true],
    ["PRN", {}, undefined, true],
    ["STAT", { count: 1 }, undefined, undefined],
  ];
  for (const [text, repeat, abbr, prn] of cases) {
    const r = parseFrequency(text);
    assert.ok(r, text);
    assert.deepEqual(r.repeat, repeat, text);
    assert.equal(r.abbreviation, abbr, text);
    assert.equal(r.asNeeded, prn, text);
  }
});

test("frequency grammar: English phrases", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["3 times a day", { frequency: 3, period: 1, periodUnit: "d" }],
    ["three times daily", { frequency: 3, period: 1, periodUnit: "d" }],
    ["twice daily", { frequency: 2, period: 1, periodUnit: "d" }],
    ["once a day", { frequency: 1, period: 1, periodUnit: "d" }],
    ["daily", { frequency: 1, period: 1, periodUnit: "d" }],
    ["every 8 hours", { frequency: 1, period: 8, periodUnit: "h" }],
    ["every 2 weeks", { frequency: 1, period: 2, periodUnit: "wk" }],
    ["every other day", { frequency: 1, period: 2, periodUnit: "d" }],
    ["2x/day", { frequency: 2, period: 1, periodUnit: "d" }],
    ["4 times per week", { frequency: 4, period: 1, periodUnit: "wk" }],
    ["weekly", { frequency: 1, period: 1, periodUnit: "wk" }],
    ["at bedtime", { when: ["HS"], frequency: 1, period: 1, periodUnit: "d" }],
    ["twice daily after meals", { frequency: 2, period: 1, periodUnit: "d", when: ["PC"] }],
    ["once daily in the morning", { frequency: 1, period: 1, periodUnit: "d", when: ["MORN"] }],
    ["before breakfast", { when: ["ACM"] }],
    ["single dose", { count: 1 }],
  ];
  for (const [text, repeat] of cases) {
    const r = parseFrequency(text);
    assert.ok(r, text);
    assert.deepEqual(r.repeat, repeat, text);
  }
  const prn = parseFrequency("every 6 hours as needed");
  assert.ok(prn && prn.asNeeded === true);
  assert.deepEqual(prn!.repeat, { frequency: 1, period: 6, periodUnit: "h" });
});

test("frequency grammar: Chinese phrases", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["每天三次", { frequency: 3, period: 1, periodUnit: "d" }],
    ["一天3次", { frequency: 3, period: 1, periodUnit: "d" }],
    ["每日兩次", { frequency: 2, period: 1, periodUnit: "d" }],
    ["每日一次", { frequency: 1, period: 1, periodUnit: "d" }],
    ["每8小時一次", { frequency: 1, period: 8, periodUnit: "h" }],
    ["每八小時", { frequency: 1, period: 8, periodUnit: "h" }],
    ["每2天一次", { frequency: 1, period: 2, periodUnit: "d" }],
    ["隔日", { frequency: 1, period: 2, periodUnit: "d" }],
    ["每週二次", { frequency: 2, period: 1, periodUnit: "wk" }],
    ["每週一次", { frequency: 1, period: 1, periodUnit: "wk" }],
    ["每月一次", { frequency: 1, period: 1, periodUnit: "mo" }],
    ["睡前", { when: ["HS"], frequency: 1, period: 1, periodUnit: "d" }],
    ["每天三次飯後", { frequency: 3, period: 1, periodUnit: "d", when: ["PC"] }],
    ["一天兩次，早餐前及晚餐前", { frequency: 2, period: 1, periodUnit: "d", when: ["ACM", "ACV"] }],
    ["每日一次 早上", { frequency: 1, period: 1, periodUnit: "d", when: ["MORN"] }],
    ["一次", { count: 1 }],
  ];
  for (const [text, repeat] of cases) {
    const r = parseFrequency(text);
    assert.ok(r, text);
    assert.deepEqual(r.repeat, repeat, text);
  }
  const prn = parseFrequency("每6小時 需要時");
  assert.ok(prn && prn.asNeeded === true);
  assert.deepEqual(prn!.repeat, { frequency: 1, period: 6, periodUnit: "h" });
  assert.equal(chineseNumber("十二"), 12);
  assert.equal(chineseNumber("二十"), 20);
  assert.equal(chineseNumber("兩"), 2);
  assert.equal(chineseNumber("半"), 0.5);
});

test("frequency grammar: objects pass through with unit words normalised; nonsense is null", () => {
  assert.deepEqual(parseFrequency({ frequency: 2, period: 1, periodUnit: "day" })!.repeat, { frequency: 2, period: 1, periodUnit: "d" });
  assert.deepEqual(parseFrequency({ frequency: 1, period: 12, periodUnit: "hours", when: "HS" })!.repeat, { frequency: 1, period: 12, periodUnit: "h", when: ["HS"] });
  assert.deepEqual(parseFrequency({ count: 3, duration: 30, durationUnit: "min" })!.repeat, { count: 3, duration: 30, durationUnit: "min" });
  assert.equal(parseFrequency({ frequency: 2, periodUnit: "fortnight" }), null);
  assert.equal(parseFrequency({}), null);
  for (const bad of ["whenever", "3 times a fortnight", "q8", "BID TID", "", "   ", 42]) assert.equal(parseFrequency(bad), null, String(bad));
  assert.equal(timeUnitCode("小時"), "h");
  assert.equal(timeUnitCode("weeks"), "wk");
  assert.equal(timeUnitCode("年"), "a");
  assert.equal(timeUnitCode("fortnight"), null);
});

test("references: context keys vs external references", () => {
  assert.deepEqual(classifyReference({ ref: "pat1" }), { kind: "key", key: "pat1" });
  assert.deepEqual(classifyReference({ ref: "pat1", display: "王小明" }), { kind: "key", key: "pat1", display: "王小明" });
  assert.deepEqual(classifyReference("enc-1"), { kind: "key", key: "enc-1" });
  assert.deepEqual(classifyReference({ reference: "Patient/123", display: "x" }), { kind: "external", reference: { reference: "Patient/123", display: "x" } });
  assert.deepEqual(classifyReference("Patient/123"), { kind: "external", reference: { reference: "Patient/123" } });
  assert.deepEqual(classifyReference("urn:uuid:3e1c5f6a-7b2d-4c8e-9a0f-1d2b3c4d5e6f"), { kind: "external", reference: { reference: "urn:uuid:3e1c5f6a-7b2d-4c8e-9a0f-1d2b3c4d5e6f" } });
  assert.deepEqual(classifyReference("https://fhir.example/Patient/1"), { kind: "external", reference: { reference: "https://fhir.example/Patient/1" } });
  assert.deepEqual(classifyReference({ identifier: { system: "http://x", value: "1" } }), { kind: "external", reference: { identifier: { system: "http://x", value: "1" } } });
  assert.equal(classifyReference({ display: "nobody" }).kind, "error");
  assert.equal(classifyReference(42).kind, "error");
  assert.equal(classifyReference("").kind, "error");
});

test("human names and periods", () => {
  assert.deepEqual(parseHumanNameValue("王小明"), { ok: true, value: { text: "王小明" } });
  assert.deepEqual(parseHumanNameValue({ family: "王", given: "小明" }), { ok: true, value: { family: "王", given: ["小明"] } });
  assert.deepEqual(parseHumanNameValue({ family: "Doe", given: ["John", "Q"], prefix: "Dr", use: "official" }), { ok: true, value: { use: "official", family: "Doe", given: ["John", "Q"], prefix: ["Dr"] } });
  assert.ok(!parseHumanNameValue({}).ok);
  assert.ok(!parseHumanNameValue({ given: 1 }).ok);
  const p = parsePeriodValue({ start: "115/06/15", end: "2026-06-16T08:00+08:00" });
  assert.ok(p.ok && p.value.start!.value === "2026-06-15" && p.value.end!.value === "2026-06-16T08:00:00+08:00");
  const t = parsePeriodValue("2026-06-15 至 2026-06-20");
  assert.ok(t.ok && t.value.start!.value === "2026-06-15" && t.value.end!.value === "2026-06-20");
  const s = parsePeriodValue("2026-06-15");
  assert.ok(s.ok && s.value.start!.value === "2026-06-15" && s.value.end === undefined);
  assert.ok(!parsePeriodValue({}).ok);
  assert.ok(!parsePeriodValue({ start: "nope" }).ok);
});

test("choice shapes: the value's shape selects the type among the allowed ones", () => {
  const obs = ["Quantity", "CodeableConcept", "string", "boolean", "integer", "Range", "Ratio", "SampledData", "time", "dateTime", "Period"];
  assert.equal(shapeType("95 mg/dL", obs), "Quantity");
  assert.equal(shapeType({ value: 95, unit: "mg/dL" }, obs), "Quantity");
  assert.equal(shapeType(95, obs), "integer");
  assert.equal(shapeType(95.5, obs), "Quantity", "a non-integer number with no decimal type allowed is a Quantity value");
  assert.equal(shapeType("95", obs), "integer");
  assert.equal(shapeType(true, obs), "boolean");
  assert.equal(shapeType("positive", obs), "string");
  assert.equal(shapeType({ system: "s", code: "c" }, obs), "CodeableConcept");
  assert.equal(shapeType({ text: "trace" }, obs), "CodeableConcept");
  assert.equal(shapeType([{ system: "s", code: "c" }], obs), "CodeableConcept");
  assert.equal(shapeType({ low: "1 mg", high: "2 mg" }, obs), "Range");
  assert.equal(shapeType({ numerator: "1 mg", denominator: "1 mL" }, obs), "Ratio");
  assert.equal(shapeType("2026-06-15", obs), "dateTime");
  assert.equal(shapeType("115/06/15", obs), "dateTime");
  assert.equal(shapeType({ start: "2026-06-15" }, obs), "Period");
  assert.equal(shapeType("08:30", obs), "time");
  assert.equal(shapeType("2026-06-15", ["date", "Period"]), "date");
  assert.equal(shapeType("2026-06-15T06:00+08:00", ["instant", "date"]), "instant");
  assert.equal(shapeType({ ref: "pat1" }, ["CodeableConcept", "Reference"]), "Reference");
  assert.equal(shapeType("Medication/1", ["CodeableConcept", "Reference"]), "CodeableConcept", "a string on a code-or-reference choice is read as a label");
  assert.equal(shapeType("45 a", ["dateTime", "Age", "Period", "string"]), "Age");
  assert.equal(shapeType("childhood", ["dateTime", "Age", "Period", "string"]), "string");
  assert.equal(shapeType({ family: "x" }, ["HumanName", "string"]), "HumanName");
  assert.equal(shapeType(null, obs), null);
  assert.equal(shapeType({ foo: 1 }, obs), null);
  assert.equal(shapeType("x", ["Quantity"]), "Quantity", "a single allowed type is always taken");
});

test("built-in R4 datatype snapshots", () => {
  const d = syntheticDatatypeSd("Dosage")!;
  const ids = d.snapshot.element.map((e: any) => e.id);
  assert.ok(ids.includes("Dosage.doseAndRate.dose[x]") && ids.includes("Dosage.timing") && ids.includes("Dosage.route"));
  const t = syntheticDatatypeSd("Timing")!;
  const pu = t.snapshot.element.find((e: any) => e.id === "Timing.repeat.periodUnit");
  assert.equal(pu.binding.strength, "required");
  assert.equal(pu.base.max, "1");
  assert.equal(syntheticDatatypeSd("HumanName")!.snapshot.element.find((e: any) => e.id === "HumanName.given").max, "*");
  assert.equal(syntheticDatatypeSd("Nope"), null);
});
