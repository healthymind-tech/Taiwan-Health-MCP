/**
 * Grounding engine tests: parity with the Python reference (fixtures generated once by scripts/gen_golden.py),
 * spec gates that can run offline (T1, T2/T3/T8 on the gold Bundles shipped with the fixtures, determinism,
 * performance) and the product features layered on top (verbosity, policy, instruction markers, provenance,
 * privacy). Pure: static terminology provider, no DB.
 *
 * The goldens are private CARVE-TW data (src/grounding/__fixtures__/private/, git-ignored): every test here that
 * needs them skips when they are absent. Public coverage of the engine: syntheticExamples.test.ts, issuesV1.test.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

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
import { groundingInputSchema } from "./schema.js";
import { emptyTerminologyNames, staticTerminologyNames } from "./terminologyNames.js";
import { comparable, errorSet, firstDiff, loadPrivateFixture, privateSkip, referenceTerminology, withoutExtendedEntries } from "./testkit.js";

const skip = privateSkip("grounding_golden.json", "mutation_golden.json", "terminology_cache.json");
const GOLDEN = loadPrivateFixture("grounding_golden.json", { cases: [], gold_cases: [] });
const MUT = loadPrivateFixture("mutation_golden.json", { mutations: [] });
const terminology = referenceTerminology();

type Case = { id: string; group: string; input: GroundingInput; expected: { data: any; sourceSha256: string } };
const CASES: Case[] = GOLDEN.cases;
const byId = (id: string): Case => CASES.find((c) => c.id === id)!;
/** Fixture case by its neutral index ("G05" -> the case whose id starts with "G05_"); ids themselves stay private. */
const fixture = (idx: string): Case => CASES.find((c) => c.id.startsWith(`${idx}_`))!;
/** Id of a gold-Bundle variant by the gold Bundle's position in GOLDEN.gold_cases ("gold#k"). */
const goldVariantId = (k: number, kind: string): string => `V_${GOLDEN.gold_cases[k]}_${kind}`;
/** Id of the flip-mode variant of a fixture case. */
const flipVariantId = (idx: string): string => `V_${fixture(idx)?.id}_flipmode`;

async function run(input: GroundingInput): Promise<GroundingResult> {
  return checkGrounding({ ...input, verbosity: input.verbosity ?? "all" }, { terminology });
}

/**
 * Golden cases whose information/warning-level output deviates from the reference since lexicon 0.3.0 (issues v1).
 * For these, parity is checked on `valid` + the error set only (errors are unchanged); every other case must match
 * the reference output exactly.
 *  - enc_class "expected one of" lists: the class aliases are now whole-token ('ED' / 'ER', not 'ed ' / 'er ');
 *  - '空腹' / '血糖' now bridge to 'fasting' / 'glucose': a fasting-glucose line grounds the LOINC code on its own
 *    line (located quote without the header line) and the former G-CODING-WEAK warning disappears.
 */
const LEXICON_030_DEVIATIONS: ReadonlySet<string> = skip
  ? new Set()
  : new Set([
      fixture("G20").id,
      flipVariantId("G20"),
      ...[0, 1, 2, 4, 6].map((k) => goldVariantId(k, "shifted_quotes")),
      ...["gold_strict", "gold_auto", "altpaths", "flattened_auto"].map((kind) => goldVariantId(4, kind)),
    ]);

test("full-output parity with the reference on every golden case (fixtures, gold Bundles, variants, synthetic)", { skip }, async () => {
  const diffs: string[] = [];
  for (const c of CASES) {
    const out = await run(c.input);
    if (LEXICON_030_DEVIATIONS.has(c.id)) {
      if (out.valid !== c.expected.data.valid || JSON.stringify(errorSet(out)) !== JSON.stringify(errorSet(c.expected.data)))
        diffs.push(`${c.id}: valid/error set differs from the reference`);
      if (!firstDiff(withoutExtendedEntries(comparable(out)), withoutExtendedEntries(c.expected.data)))
        diffs.push(`${c.id}: listed as a lexicon 0.3.0 deviation but now matches the reference exactly (remove it from the list)`);
      continue;
    }
    // entries of resource types extended for PAS (Claim) are compared in pas.test.ts instead
    const d = firstDiff(withoutExtendedEntries(comparable(out)), withoutExtendedEntries(c.expected.data));
    if (d) diffs.push(`${c.id}: ${d}`);
  }
  assert.equal(diffs.length, 0, diffs.slice(0, 10).join("\n"));
  assert.ok(CASES.length >= 80);
});

test("T1: 21 grounding fixtures — same valid flag and identical error (rule, path) set", { skip }, async () => {
  const fx = CASES.filter((c) => c.group === "fixture");
  assert.equal(fx.length, 21);
  for (const c of fx) {
    const out = await run(c.input);
    assert.equal(out.valid, c.expected.data.valid, c.id);
    assert.deepStrictEqual(errorSet(out), errorSet(c.expected.data), c.id);
  }
});

test("T2/T3 (subset available offline): gold Bundles are error-free with gold evidence (strict) and without (auto)", { skip }, async () => {
  const gold: string[] = GOLDEN.gold_cases;
  assert.ok(gold.length >= 7);
  for (const cid of gold) {
    for (const mode of ["strict", "auto"]) {
      const c = byId(`V_${cid}_gold_${mode}`);
      const out = await run(c.input);
      assert.deepStrictEqual(errorSet(out), [], `${cid} ${mode}`);
      assert.equal(out.mode, mode);
    }
  }
});

test("T8 (subset): every single-value mutation of the available gold Bundles is detected at its entry, as in the reference", { skip }, async () => {
  const goldInput = (cid: string): GroundingInput => byId(`V_${cid}_gold_auto`).input;
  let det = 0;
  for (const m of MUT.mutations) {
    const base = goldInput(m.case_id);
    const bundle = structuredClone(base.bundle) as any;
    bundle.entry[m.ei].resource = m.resource;
    const out = await run({ ...base, bundle, mode: undefined });
    const errs = out.entries[m.ei].issues.filter((i) => i.severity === "error").map((i) => [i.rule, i.path]);
    const uniq = [...new Map(errs.map((e) => [e.join("@"), e])).values()].sort((a, b) => (a.join("@") < b.join("@") ? -1 : 1));
    assert.deepStrictEqual(uniq, m.entry_errors, `${m.case_id} ${m.kind} ${m.path}`);
    if (errs.length) det++;
  }
  assert.equal(det, MUT.mutations.length);
  assert.ok(det / MUT.mutations.length >= 0.95);
});

test("spec §4 worked examples (selected messages)", { skip }, async () => {
  const g05 = await run(fixture("G05").input);
  const e = g05.entries[2].issues.find((i) => i.severity === "error")!;
  // expected values come from the (private) reference output, so no record text is written into this file
  const g05exp = fixture("G05").expected.data;
  assert.equal(e.rule, "G-CONTEXT-SECTION");
  assert.equal(e.located_quote, g05exp.entries[2].issues.find((i: { severity: string }) => i.severity === "error").located_quote);
  assert.equal(g05.grounding.coverage, g05exp.grounding.coverage);
  const g10 = await run(fixture("G10").input);
  assert.match(g10.entries[1].issues[0].message, /does not match the date\(s\) in the evidence \(\d{4}-\d{1,2}-\d{1,2}; ROC years converted\)/);
  const g12in = fixture("G12").input;
  const g12 = await run(g12in);
  assert.ok(g12.valid);
  assert.ok(
    g12.entries[0].issues.some(
      (i) => i.rule === "G-AUTO-LOCATED" && i.path.endsWith("birthDate") && !!i.located_quote && g12in.source_text.includes(i.located_quote),
    ),
  );
});

test("determinism: same input -> same output hash (excluding elapsed_ms)", { skip }, async () => {
  const h = async (c: Case): Promise<string> => {
    const out = await run(structuredClone(c.input));
    const o: Partial<GroundingResult> = { ...out };
    delete o.elapsed_ms;
    return createHash("sha256").update(JSON.stringify(o)).digest("hex");
  };
  for (const c of CASES.slice(0, 30)) assert.equal(await h(c), await h(c), c.id);
});

test("performance: p95 < 500 ms per Bundle (warm), every call < 2000 ms", { skip }, async () => {
  for (const c of CASES.slice(0, 5)) await run(c.input); // warm-up (regex compilation, JIT)
  const times: number[] = [];
  for (let rep = 0; rep < 2; rep++) {
    for (const c of CASES) {
      const t0 = performance.now();
      await run(c.input);
      times.push(performance.now() - t0);
    }
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(0.95 * (times.length - 1))];
  assert.ok(p95 < 500, `p95 ${p95.toFixed(1)} ms`);
  assert.ok(times[times.length - 1] < 2000, `max ${times[times.length - 1].toFixed(1)} ms`);
});

test("verbosity: warnings (default) drops information, errors drops warnings; summary counts are unaffected", { skip }, async () => {
  const input = fixture("G02").input;
  const all = await checkGrounding({ ...input, verbosity: "all" }, { terminology });
  const def = await checkGrounding({ ...input, verbosity: undefined }, { terminology });
  const err = await checkGrounding({ ...input, verbosity: "errors" }, { terminology });
  const sev = (r: GroundingResult): Set<string> => new Set([...r.issues, ...r.entries.flatMap((e) => e.issues)].map((i) => i.severity));
  assert.ok(sev(all).has("warning"));
  assert.ok(!sev(def).has("information") && sev(def).has("warning"));
  assert.ok(!sev(err).has("warning") && !sev(err).has("information"));
  assert.deepStrictEqual(def.grounding, all.grounding);
  assert.deepStrictEqual(err.grounding, all.grounding);
  assert.equal(def.valid, all.valid);
});

test("policy: data_absent -> warning; per-rule override and 'off'", { skip }, async () => {
  const input = fixture("G13").input;
  const strictDa = await run(input);
  assert.equal(strictDa.valid, false);
  const soft = await run({ ...input, policy: { data_absent: "warning" } });
  assert.equal(soft.valid, true);
  const g19 = fixture("G19").input;
  const hard = await run({ ...g19, policy: { "G-CATEGORY": "error" } });
  assert.equal(hard.valid, false);
  const off = await run({ ...g19, policy: { "G-CATEGORY": "off" } });
  assert.ok(!off.entries.flatMap((e) => e.issues).some((i) => i.rule === "G-CATEGORY"));
});

test("instruction markers are configurable (generic records, not only CARVE 【轉換目標】)", { skip }, async () => {
  const base = fixture("G18").input;
  const text = base.source_text.replace("【轉換目標】", "[TASK] ");
  const plain = await run({ ...base, source_text: text });
  // without the marker the instruction line is ordinary record text, so the analyte name there grounds the code
  assert.ok(!errorSet(plain).some((e) => e.startsWith("G-CONTEXT-INSTRUCTION")));
  const marked = await run({ ...base, source_text: text, instruction_markers: ["[TASK]"] });
  assert.ok(errorSet(marked).some((e) => e.startsWith("G-CONTEXT-INSTRUCTION")));
});

test("evidence path syntaxes resolve to the same entry/tokens", { skip }, () => {
  const bundle = fixture("G01").input.bundle as any;
  const fu = bundle.entry[2].fullUrl;
  const want = normalizeEvidencePath("Bundle.entry[2].resource.code.coding[0].code", bundle);
  for (const p of ["entry[2].code.coding[0].code", `${fu}|code.coding[0].code`, `${fu}#code.coding[0].code`, "entry[2].Condition.code.coding[0].code"]) {
    assert.deepStrictEqual(normalizeEvidencePath(p, bundle), want, p);
  }
  assert.deepStrictEqual(normalizeEvidencePath("entry[99].code", bundle), [null, null]);
  assert.deepStrictEqual(normalizeEvidencePath("nonsense", bundle), [null, null]);
});

test("unknown code systems never produce errors (unverifiable warnings only)", { skip }, async () => {
  const input = fixture("G04").input;
  const out = await checkGrounding({ ...input, verbosity: "all" }, { terminology: emptyTerminologyNames });
  assert.ok(!errorSet(out).some((e) => e.startsWith("G-CODING-UNRELATED")));
});

test("terminology is fetched in one batch for all codings of the Bundle", { skip }, async () => {
  const input = fixture("G02").input;
  const calls: string[][] = [];
  const spy = {
    version: () => "spy",
    lookup: async (keys: readonly string[]) => {
      calls.push([...keys]);
      return terminology.lookup(keys);
    },
  };
  const out = await checkGrounding({ ...input, verbosity: "all" }, { terminology: spy });
  assert.equal(calls.length, 1);
  assert.deepStrictEqual(calls[0], collectCodingKeys(input.bundle));
  assert.ok(calls[0].includes("http://loinc.org|4548-4") || calls[0].length > 3);
  assert.equal(out.valid, true);
});

test("privacy: provenance carries only a sha256 prefix; the logger never sees the record text", { skip }, async () => {
  const input = fixture("G05").input;
  const logged: string[] = [];
  const logger = { debug: (m: string, meta?: Record<string, unknown>) => void logged.push(m + JSON.stringify(meta ?? {})), info: (m: string) => void logged.push(m) };
  await checkGrounding(input, { terminology, logger });
  const prov = await groundingProvenance(input, { terminology });
  assert.equal(prov.sourceSha256, fixture("G05").expected.sourceSha256);
  assert.equal(prov.sourceSha256, sourceSha256Prefix(input.source_text));
  assert.match(prov.lexiconSha256, /^[0-9a-f]{64}$/);
  assert.ok(logged.length > 0);
  const recordLines = input.source_text.split("\n").map((x) => x.trim()).filter((x) => x.length >= 6);
  for (const l of logged) {
    for (const r of recordLines) assert.ok(!l.includes(r), "record text leaked into logs");
    assert.ok(l.includes(prov.sourceSha256));
  }
});

test("zod input schema accepts both evidence-map forms and rejects bad modes", { skip }, () => {
  const input = byId("S03_synthetic_er_dict_map").input;
  assert.ok(groundingInputSchema.safeParse(input).success);
  assert.ok(groundingInputSchema.safeParse(fixture("G01").input).success);
  assert.ok(!groundingInputSchema.safeParse({ ...input, mode: "loose" }).success);
  assert.ok(!groundingInputSchema.safeParse({ bundle: {}, source_text: 5 }).success);
});

test("sync core equals async wrapper", { skip }, async () => {
  const input = byId("S01_synthetic_er_auto").input;
  const keys = collectCodingKeys(input.bundle);
  const terms = await terminology.lookup(keys);
  const a = checkGroundingSync({ ...input, verbosity: "all" }, terms);
  const b = await run(input);
  assert.equal(firstDiff(comparable(a), comparable(b)), null);
});

test("static provider: exact system|code keys", async () => {
  const p = staticTerminologyNames({ codes: { "http://loinc.org|2160-0": { found: true, names: ["Creatinine", "肌酸酐"] } } });
  const m = await p.lookup(["http://loinc.org|2160-0", "http://loinc.org|x"]);
  assert.deepStrictEqual(m.get("http://loinc.org|2160-0")?.names, ["Creatinine", "肌酸酐"]);
  assert.equal(m.has("http://loinc.org|x"), false);
});
