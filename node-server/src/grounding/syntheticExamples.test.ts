/**
 * Public coverage of the grounding / completeness engines, on hand-written fictional records only.
 *
 * The reference-parity goldens (checkGrounding / lexicon / completeness / merge tests) are private CARVE-TW data and
 * skip when absent, so this file is what `npm test` always exercises: the admin MCP playground examples
 * (admin/mcpToolExampleFixtures.ts — the same inputs the playground sends, verified against staging), single-value
 * mutations of the valid example, product features (verbosity, policy, instruction markers, evidence-path syntaxes,
 * provenance, privacy, merge into fhir_validate_bundle) and a few lexicon primitives. Pure: static terminology, no DB.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMPLETENESS_COMPLETE_INPUT,
  COMPLETENESS_INSUFFICIENT_INPUT,
  GROUNDING_FABRICATED_INPUT,
  GROUNDING_VALID_INPUT,
  GROUNDING_WRONG_DATE_INPUT,
} from "../admin/mcpToolExampleFixtures.js";
import {
  checkGrounding,
  checkGroundingSync,
  collectCodingKeys,
  groundingProvenance,
  normalizeEvidencePath,
  sourceSha256Prefix,
  type GroundingInput,
  type GroundingResult,
} from "./checkGrounding.js";
import { checkCompleteness, computeCompleteness } from "./completeness/checkCompleteness.js";
import { completenessInputSchema } from "./completeness/types.js";
import { gendersIn, nameSimilarity, parseDates, parseFhirDatetime, parseTimes, routesIn, twIdChecksumOk, unitsCompatible } from "./lexicon.js";
import { mergeGroundingIntoValidation, type ConformanceData } from "./merge.js";
import { groundingInputSchema } from "./schema.js";
import { comparable, errorSet, firstDiff, syntheticTerminology } from "./testkit.js";

const terminology = syntheticTerminology();
const VALID = GROUNDING_VALID_INPUT as unknown as GroundingInput;
const WRONG_DATE = GROUNDING_WRONG_DATE_INPUT as unknown as GroundingInput;
const FABRICATED = GROUNDING_FABRICATED_INPUT as unknown as GroundingInput;

async function run(input: GroundingInput, extra: Partial<GroundingInput> = {}): Promise<GroundingResult> {
  return checkGrounding({ ...input, verbosity: "all", ...extra }, { terminology });
}

/** The valid example without its evidence map (auto mode: the engine locates every value itself). */
const autoOf = (input: GroundingInput): GroundingInput => ({ ...input, evidence_map: undefined, mode: "auto" });

// ------------------------------------------------------------------------------------------------ playground examples

test("playground: valid strict example -> valid, no errors, every unit checked", async () => {
  const out = await run(VALID);
  assert.equal(out.mode, "strict");
  assert.equal(out.valid, true);
  assert.deepStrictEqual(errorSet(out), []);
  assert.equal(out.entries.length, 4);
  assert.ok(out.grounding.units_checked > 10);
});

test("playground: the same Bundle grounds in auto mode too (no evidence map)", async () => {
  const out = await run(autoOf(VALID));
  assert.equal(out.mode, "auto");
  assert.deepStrictEqual(errorSet(out), []);
});

test("playground: wrong-date example -> G-VALUE-MISMATCH on Encounter.period.start only", async () => {
  const out = await run(WRONG_DATE);
  assert.equal(out.valid, false);
  assert.deepStrictEqual(errorSet(out), ["G-VALUE-MISMATCH@Bundle.entry[1].resource.period.start"]);
  const e = out.entries[1].issues.find((i) => i.severity === "error")!;
  assert.match(e.message, /^\[grounding:G-VALUE-MISMATCH\] .*does not match the date\(s\) in the evidence \(2026-9-16; ROC years converted\)/);
});

test("playground: fabricated-diagnosis example -> G-UNGROUNDED on the invented Condition only", async () => {
  const out = await run(FABRICATED);
  assert.equal(out.mode, "auto");
  assert.equal(out.valid, false);
  assert.deepStrictEqual(errorSet(out), ["G-UNGROUNDED@Bundle.entry[3].resource.code"]);
  // the real diagnosis (J20.9) is located in the record
  assert.ok(out.entries[2].issues.every((i) => i.severity !== "error"));
});

test("playground: completeness examples -> complete / insufficient_information with a question", async () => {
  const full = await checkCompleteness(completenessInputSchema.parse(COMPLETENESS_COMPLETE_INPUT));
  assert.equal(full.data.status, "complete", JSON.stringify(full.data.missing));
  assert.deepEqual(full.data.missing, []);
  assert.equal(full.data.question, null);
  const part = await checkCompleteness(completenessInputSchema.parse(COMPLETENESS_INSUFFICIENT_INPUT));
  assert.equal(part.data.status, "insufficient_information");
  assert.deepEqual(part.data.missing, ["HbA1c 數值", "Metformin 劑量", "Metformin 頻次"]);
  assert.equal(part.data.question, "請提供HbA1c的數值與單位；請提供Metformin的劑量；請提供Metformin的頻次。");
  assert.deepEqual(part.data.abstention, { status: "insufficient_information", missing: part.data.missing, question: part.data.question });
});

test("playground: the examples parse against the zod input schemas", () => {
  for (const x of [VALID, WRONG_DATE, FABRICATED]) assert.ok(groundingInputSchema.safeParse(x).success);
  assert.ok(!groundingInputSchema.safeParse({ ...VALID, mode: "loose" }).success);
  assert.ok(!groundingInputSchema.safeParse({ bundle: {}, source_text: 5 }).success);
});

// ------------------------------------------------------------------------------------------------ mutations (mini T8)

/** Single-value mutations of the valid example: each must be caught at its own entry, in auto mode. */
const MUTATIONS: Array<[string, number, (r: any) => void]> = [
  ["Patient.birthDate", 0, (r) => (r.birthDate = "1981-11-13")],
  ["Patient.gender", 0, (r) => (r.gender = "female")],
  ["Patient.identifier[0].value", 0, (r) => (r.identifier[0].value = "E123456789")],
  ["Patient.name", 0, (r) => (r.name[0].text = "黃志明")],
  ["Encounter.period.start", 1, (r) => (r.period.start = "2026-09-16T16:10:00+08:00")],
  ["Condition.code", 2, (r) => (r.code = { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9" }] })],
  ["Observation.valueQuantity.value", 3, (r) => (r.valueQuantity.value = 98)],
  ["Observation.effectiveDateTime", 3, (r) => (r.effectiveDateTime = "2026-09-17T14:10:00+08:00")],
];

for (const [name, ei, mutate] of MUTATIONS) {
  test(`mutation of the valid example is detected at its entry: ${name}`, async () => {
    const input = autoOf(VALID);
    const bundle = structuredClone(input.bundle) as any;
    mutate(bundle.entry[ei].resource);
    const out = await run({ ...input, bundle });
    assert.equal(out.valid, false, name);
    assert.ok(out.entries[ei].issues.some((i) => i.severity === "error"), `${name}: no error at entry ${ei}`);
    for (const [k, e] of out.entries.entries()) if (k !== ei) assert.ok(!e.issues.some((i) => i.severity === "error"), `${name}: error leaked to entry ${k}`);
  });
}

// ------------------------------------------------------------------------------------------------ product features

test("verbosity: warnings (default) drops information, errors drops warnings; summary counts are unaffected", async () => {
  const all = await checkGrounding({ ...FABRICATED, verbosity: "all" }, { terminology });
  const def = await checkGrounding({ ...FABRICATED, verbosity: undefined }, { terminology });
  const err = await checkGrounding({ ...FABRICATED, verbosity: "errors" }, { terminology });
  const sev = (r: GroundingResult): Set<string> => new Set([...r.issues, ...r.entries.flatMap((e) => e.issues)].map((i) => i.severity));
  assert.ok(sev(all).has("information"));
  assert.ok(!sev(def).has("information"));
  assert.ok(!sev(err).has("warning") && !sev(err).has("information") && sev(err).has("error"));
  assert.deepStrictEqual(def.grounding, all.grounding);
  assert.deepStrictEqual(err.grounding, all.grounding);
  assert.equal(def.valid, all.valid);
});

test("policy: a rule can be downgraded to warning or switched off", async () => {
  const soft = await run(FABRICATED, { policy: { "G-UNGROUNDED": "warning" } });
  assert.equal(soft.valid, true);
  const off = await run(FABRICATED, { policy: { "G-UNGROUNDED": "off" } });
  assert.ok(!off.entries.flatMap((e) => e.issues).some((i) => i.rule === "G-UNGROUNDED"));
});

test("instruction markers: a configured instruction line is never evidence", async () => {
  // the fabricated diagnosis is named only on an instruction line
  const text = `${FABRICATED.source_text}\n[TASK] 請一併轉換第二型糖尿病（Type 2 diabetes mellitus）`;
  const plain = await run({ ...FABRICATED, source_text: text });
  assert.ok(!errorSet(plain).includes("G-UNGROUNDED@Bundle.entry[3].resource.code"), "without the marker the line is record text");
  const marked = await run({ ...FABRICATED, source_text: text, instruction_markers: ["[TASK]"] });
  assert.ok(errorSet(marked).some((e) => e.startsWith("G-CONTEXT-INSTRUCTION@Bundle.entry[3]")), JSON.stringify(errorSet(marked)));
  // the default marker 【轉換目標】 behaves the same way
  const dflt = await run({ ...FABRICATED, source_text: text.replace("[TASK] ", "【轉換目標】") });
  assert.ok(errorSet(dflt).some((e) => e.startsWith("G-CONTEXT-INSTRUCTION@Bundle.entry[3]")), JSON.stringify(errorSet(dflt)));
});

test("evidence path syntaxes resolve to the same entry/tokens", () => {
  const bundle = VALID.bundle as any;
  const fu = bundle.entry[2].fullUrl;
  const want = normalizeEvidencePath("Bundle.entry[2].resource.code.coding[0].code", bundle);
  for (const p of ["entry[2].code.coding[0].code", `${fu}|code.coding[0].code`, `${fu}#code.coding[0].code`, "entry[2].Condition.code.coding[0].code"]) {
    assert.deepStrictEqual(normalizeEvidencePath(p, bundle), want, p);
  }
  assert.deepStrictEqual(normalizeEvidencePath("entry[99].code", bundle), [null, null]);
  assert.deepStrictEqual(normalizeEvidencePath("nonsense", bundle), [null, null]);
});

test("a quote that is not in the record fails strict mode", async () => {
  const em = structuredClone(VALID.evidence_map) as Array<{ path: string; quote: string }>;
  em.find((e) => e.path.endsWith("valueQuantity"))!.quote = "HR 98/min";
  const out = await run({ ...VALID, evidence_map: em });
  assert.equal(out.valid, false);
  assert.ok(errorSet(out).some((e) => e.includes("Bundle.entry[3]")), JSON.stringify(errorSet(out)));
});

test("terminology is fetched in one batch; unknown code systems never produce coding errors", async () => {
  const calls: string[][] = [];
  const spy = { version: () => "spy", lookup: async (keys: readonly string[]) => (calls.push([...keys]), terminology.lookup(keys)) };
  const out = await checkGrounding({ ...VALID, verbosity: "all" }, { terminology: spy });
  assert.equal(calls.length, 1);
  assert.deepStrictEqual(calls[0], collectCodingKeys(VALID.bundle));
  assert.equal(out.valid, true);
  const none = { version: () => "none", lookup: async () => new Map() };
  const blind = await checkGrounding({ ...VALID, verbosity: "all" }, { terminology: none });
  assert.ok(!errorSet(blind).some((e) => e.startsWith("G-CODING-UNRELATED")));
});

test("determinism and sync core equal the async wrapper", async () => {
  const a = await run(FABRICATED);
  const b = await run(structuredClone(FABRICATED));
  assert.equal(firstDiff(comparable(a), comparable(b)), null);
  const terms = await terminology.lookup(collectCodingKeys(FABRICATED.bundle));
  const s = checkGroundingSync({ ...FABRICATED, verbosity: "all" }, terms);
  assert.equal(firstDiff(comparable(s), comparable(a)), null);
});

test("privacy: provenance carries only a sha256 prefix; the logger never sees the record text", async () => {
  const logged: string[] = [];
  const logger = { debug: (m: string, meta?: Record<string, unknown>) => void logged.push(m + JSON.stringify(meta ?? {})), info: (m: string) => void logged.push(m) };
  await checkGrounding(FABRICATED, { terminology, logger });
  const prov = await groundingProvenance(FABRICATED, { terminology });
  assert.equal(prov.sourceSha256, sourceSha256Prefix(FABRICATED.source_text));
  assert.match(prov.lexiconSha256, /^[0-9a-f]{64}$/);
  assert.ok(logged.length > 0);
  const recordLines = FABRICATED.source_text.split("\n").map((x) => x.trim()).filter((x) => x.length >= 6);
  for (const l of logged) {
    for (const r of recordLines) assert.ok(!l.includes(r), "record text leaked into logs");
    assert.ok(l.includes(prov.sourceSha256));
  }
});

test("merge into fhir_validate_bundle: valid = conformanceValid ∧ groundingValid, entries merged by index", async () => {
  const bundle = WRONG_DATE.bundle as any;
  const conf: ConformanceData = {
    valid: true,
    issues: [],
    entries: bundle.entry.map((e: any) => ({ fullUrl: e.fullUrl, valid: true, issues: [] })),
  };
  const before = JSON.stringify(conf);
  const g = await checkGrounding({ ...WRONG_DATE, verbosity: "warnings" }, { terminology });
  const merged = mergeGroundingIntoValidation(conf, g);
  assert.equal(JSON.stringify(conf), before, "input mutated");
  assert.equal(merged.conformanceValid, true);
  assert.equal(merged.groundingValid, false);
  assert.equal(merged.valid, false);
  assert.equal(merged.entries.length, 4);
  assert.equal(merged.entries[1].valid, false);
  assert.ok(merged.entries[1].issues.some((i: any) => i.source === "grounding" && i.rule === "G-VALUE-MISMATCH"));
  assert.ok(merged.entries[0].valid && merged.entries[2].valid && merged.entries[3].valid);
});

// ------------------------------------------------------------------------------------------------ completeness

test("completeness: the instruction line is excluded from the record", () => {
  const input = completenessInputSchema.parse(COMPLETENESS_INSUFFICIENT_INPUT);
  const withLine = computeCompleteness({ ...input, source_text: `${input.source_text}\n【轉換目標】HbA1c 7.4 %，Metformin 500 mg BID` });
  assert.deepEqual(withLine.missing, ["HbA1c 數值", "Metformin 劑量", "Metformin 頻次"]);
});

test("completeness: dropping the identity line makes every Patient fact missing", () => {
  const input = completenessInputSchema.parse(COMPLETENESS_COMPLETE_INPUT);
  const text = input.source_text.split("\n").filter((l) => !l.startsWith("病人：")).join("\n");
  const data = computeCompleteness({ ...input, source_text: text });
  assert.equal(data.status, "insufficient_information");
  assert.deepEqual(
    data.missing.filter((m) => m.startsWith("Patient")).sort(),
    ["Patient 出生日期", "Patient 姓名", "Patient 性別", "Patient 身分證字號或病歷號"].sort(),
  );
});

// ------------------------------------------------------------------------------------------------ lexicon primitives

test("lexicon: ROC / western dates, times, genders, routes, IDs, units and name similarity", () => {
  assert.deepStrictEqual(parseDates("就診日期：115/09/16 14:10"), [["day", [2026, 9, 16]]]);
  assert.deepStrictEqual(parseTimes("就診日期：115/09/16 14:10"), [[14, 10]]);
  assert.deepStrictEqual(parseDates("出生日期：民國70年11月3日（44歲）"), [["day", [1981, 11, 3]]]);
  assert.deepStrictEqual(parseDates("病人：許雅琳　　女　　生日：1992/02/14"), [["day", [1992, 2, 14]]]);
  assert.deepStrictEqual([...gendersIn("病人：許雅琳　　女　　生日：1992/02/14")], ["female"]);
  assert.deepStrictEqual([...gendersIn("性別：男")], ["male"]);
  assert.deepStrictEqual([...routesIn("Metformin 500 mg 1# BID 口服")], ["oral"]);
  assert.equal(twIdChecksumOk("E103572464"), true);
  assert.equal(twIdChecksumOk("E103572465"), false);
  assert.deepStrictEqual(parseFhirDatetime("2026-09-16T14:10:00+08:00"), { y: 2026, m: 9, d: 16, hh: 14, mi: 10, tz: "+08:00" });
  assert.equal(unitsCompatible("°C", "Cel"), true);
  assert.equal(unitsCompatible("mg", "mL"), false);
  assert.equal(nameSimilarity("Acute sinusitis　急性鼻竇炎（右側上頷竇）", "Acute sinusitis, unspecified"), 1);
  assert.equal(nameSimilarity("診斷：Acute bronchitis　急性支氣管炎", "Type 2 diabetes mellitus without complications"), 0);
});
