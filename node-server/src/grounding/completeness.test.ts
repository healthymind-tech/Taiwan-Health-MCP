/**
 * Tests for the fhir_check_completeness engine (src/grounding/completeness/).
 *
 * Lives one level above completeness/ because `npm test` globs `src/**\/*.test.ts` through sh
 * (no globstar), which only reaches one directory deep.
 *
 * T4 parity: the 30 fixtures in mcp_proposal/fixtures/completeness (expected = Python reference
 * gap_ref.py output). Gate T4 compares status + missing; we additionally require the full `data`
 * block (per-fact status, quote/reason, question, abstention) to match.
 * Derived targets: gold Bundles available in mcp_proposal/fixtures/grounding → targets derived
 * mechanically (derived_targets.py) → must be complete; golden generated from the reference.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCompleteness, computeCompleteness } from "./completeness/checkCompleteness.js";
import { FACT_TABLE, defaultFacts, primaryContentGaps } from "./completeness/factTable.js";
import { staticTerminologyNames } from "./terminologyNames.js";
import { completenessInputSchema, type CompletenessInput } from "./completeness/types.js";
import { PRIMARY_CONTENT, groundingClassOfPath } from "../fhirRequiredElements.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "../../../mcp_proposal/fixtures/completeness");
const GOLDEN = join(HERE, "completeness/testdata/derivedTargets.golden.json");

interface Fixture {
  name: string;
  input: CompletenessInput;
  expected: Record<string, unknown>;
}

function loadFixtures(): Fixture[] {
  if (!existsSync(FX)) return [];
  return readdirSync(FX)
    .filter((f) => f.endsWith(".input.json"))
    .sort()
    .map((f) => ({
      name: f.replace(".input.json", ""),
      input: JSON.parse(readFileSync(join(FX, f), "utf8")).input,
      expected: JSON.parse(readFileSync(join(FX, f.replace(".input.", ".expected.")), "utf8")).output.data,
    }));
}

const fixtures = loadFixtures();

test("T4: 30 completeness fixtures — status and missing identical", { skip: fixtures.length === 0 && "fixtures absent" }, async () => {
  assert.equal(fixtures.length, 30);
  const failures: string[] = [];
  for (const fx of fixtures) {
    const input = completenessInputSchema.parse(fx.input);
    const out = await checkCompleteness(input);
    const exp = fx.expected as { status: string; missing: string[] };
    if (out.data.status !== exp.status || JSON.stringify(out.data.missing) !== JSON.stringify(exp.missing)) {
      failures.push(`${fx.name}: got ${out.data.status} ${JSON.stringify(out.data.missing)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("T4+: full data block (facts, quotes, reasons, question, abstention) matches the reference", { skip: fixtures.length === 0 && "fixtures absent" }, async () => {
  for (const fx of fixtures) {
    const out = await checkCompleteness(completenessInputSchema.parse(fx.input));
    assert.deepEqual(JSON.parse(JSON.stringify(out.data)), fx.expected, fx.name);
  }
});

test("derived targets from gold Bundles → complete, identical to reference", async () => {
  const g = JSON.parse(readFileSync(GOLDEN, "utf8")) as {
    terminology: Record<string, string[]>;
    cases: Array<{ case: string; targets: unknown; source_text: string; site_config: string | null; expected: unknown }>;
  };
  const terminology = staticTerminologyNames({
    codes: Object.fromEntries(Object.entries(g.terminology).map(([k, names]) => [k, { found: names.length > 0, names }])),
  });
  assert.ok(g.cases.length >= 4);
  for (const c of g.cases) {
    const input = completenessInputSchema.parse({ targets: c.targets, source_text: c.source_text, site_config: c.site_config });
    const out = await checkCompleteness(input, { terminology });
    assert.equal(out.data.status, "complete", `${c.case}: ${JSON.stringify(out.data.missing)}`);
    assert.deepEqual(JSON.parse(JSON.stringify(out.data)), c.expected, c.case);
  }
});

test("differential: 180 target/record variants identical to the reference", { skip: fixtures.length === 0 && "fixtures absent" }, () => {
  const g = JSON.parse(readFileSync(join(HERE, "completeness/testdata/variants.golden.json"), "utf8")) as {
    cases: Array<{
      fixture: string;
      variant: string;
      strip_instruction: boolean;
      targets: unknown;
      extracted_facts: unknown;
      expected: { status: string; missing: string[]; question: string | null; facts: unknown[][] };
    }>;
  };
  const byName = new Map(fixtures.map((f) => [f.name.slice(0, 12), f.input]));
  assert.equal(g.cases.length, 180);
  for (const c of g.cases) {
    const fx = byName.get(c.fixture)!;
    const source_text = c.strip_instruction ? fx.source_text.split("【轉換目標】")[0] : fx.source_text;
    const data = computeCompleteness(
      completenessInputSchema.parse({ targets: c.targets, source_text, site_config: fx.site_config, extracted_facts: c.extracted_facts }),
    );
    const facts = data.targets.flatMap((t) => t.facts.map((r) => [t.key, r.fact, r.status, r.quote ?? r.reason ?? null, r.model ?? null]));
    const name = `${c.fixture}/${c.variant}/${c.strip_instruction}`;
    assert.deepEqual(
      { status: data.status, missing: data.missing, question: data.question, facts },
      { ...c.expected, facts: c.expected.facts.map((r) => r.map((x) => x ?? null)) },
      name,
    );
  }
});

const RECORD = [
  "台安醫院 門診紀錄",
  "就診日期：115/03/02",
  "病人：王小明　男　生日：1980/01/02　病歷號：A1234567",
  "S: 咳嗽三天",
  "O: BT 38.2°C, HR 96",
  "A: 急性支氣管炎",
  "P: Acetaminophen 500 mg 1 tab PO QID × 3 天",
].join("\n");

test("generic record: complete without CARVE instruction line", () => {
  const data = computeCompleteness({
    targets: [
      { key: "p", resourceType: "Patient" },
      { key: "e", resourceType: "Encounter" },
      { key: "dx", resourceType: "Condition", item: "急性支氣管炎" },
      { key: "bt", resourceType: "Observation", item: "體溫", aliases: ["BT", "體溫"] },
      { key: "mr", resourceType: "MedicationRequest", item: "Acetaminophen", also_require: ["route", "duration"] },
    ],
    source_text: RECORD,
  });
  assert.equal(data.status, "complete", JSON.stringify(data.missing));
  assert.equal(data.abstention, undefined);
  assert.equal(data.question, null);
});

test("missing facts produce labels, a deduplicated zh-TW question and an abstention", () => {
  const data = computeCompleteness({
    targets: [
      { key: "glu", resourceType: "Observation", item: "HbA1c", aliases: ["HbA1c"] },
      { key: "met", resourceType: "MedicationRequest", item: "Metformin", also_require: ["route"] },
    ],
    source_text: RECORD,
  });
  assert.equal(data.status, "insufficient_information");
  assert.deepEqual(data.missing, ["HbA1c 數值", "Metformin 藥品", "Metformin 劑量", "Metformin 頻次", "Metformin 給藥途徑"]);
  assert.equal(
    data.question,
    "請提供HbA1c的數值與單位；請提供Metformin的藥品；請提供Metformin的劑量；請提供Metformin的頻次；請提供Metformin的給藥途徑。",
  );
  assert.deepEqual(data.abstention, { status: "insufficient_information", missing: data.missing, question: data.question });
});

test("instruction markers are configurable and excluded from the record", () => {
  const text = "病人：王小明 男 生日：1980/01/02 病歷號：A1234567\n就診日期：115/03/02\n#轉換指示# 請轉換 HbA1c 7.2% 的檢驗結果";
  const tg = [{ key: "a1c", resourceType: "Observation", item: "HbA1c" }];
  // Without the custom marker the instruction line counts as record text (value found there).
  assert.equal(computeCompleteness({ targets: tg, source_text: text }).status, "complete");
  const data = computeCompleteness({ targets: tg, source_text: text, instruction_markers: ["#轉換指示#"] });
  assert.deepEqual(data.missing, ["HbA1c 數值"]);
});

test("extracted_facts are verified, not trusted", () => {
  const base = { targets: [{ key: "a1c", resourceType: "Observation", item: "HbA1c", require: ["value"] }], source_text: RECORD };
  const fake = computeCompleteness({ ...base, extracted_facts: [{ target: "a1c", fact: "value", status: "stated", quote: "HbA1c 7.2%" }] });
  assert.equal(fake.status, "insufficient_information");
  assert.equal(fake.targets[0].facts[0].model, "stated (quote NOT found in the record)");
  const notStated = computeCompleteness({
    targets: [{ key: "bt", resourceType: "Observation", item: "體溫", aliases: ["BT"], require: ["value"] }],
    source_text: RECORD,
    extracted_facts: [{ target: "bt", fact: "value", status: "not_stated" }],
  });
  assert.equal(notStated.status, "complete");
  assert.equal(notStated.targets[0].facts[0].note, "the model says not stated, but the record contains it");
});

test("terminology codes expand to aliases (LOINC name → abbreviation)", async () => {
  const input = completenessInputSchema.parse({
    targets: [{ key: "cr", resourceType: "Observation", item: "Creatinine [Mass/volume] in Serum or Plasma", require: ["value"],
      codes: [{ system: "http://loinc.org", code: "2160-0" }] }],
    source_text: "Lab: Cr 1.2 mg/dL",
  });
  const none = await checkCompleteness(input);
  assert.equal(none.data.status, "insufficient_information");
  const terminology = staticTerminologyNames({
    codes: { "http://loinc.org|2160-0": { found: true, names: ["Creatinine [Mass/volume] in Serum or Plasma", "肌酸酐"] } },
  });
  const out = await checkCompleteness(input, { terminology });
  assert.equal(out.data.status, "complete", JSON.stringify(out.data.missing));
});

test("unstructured record without an item name → Condition.code unknown (not missing)", () => {
  const data = computeCompleteness({ targets: [{ key: "dx", resourceType: "Condition" }], source_text: "王小明 頭痛兩天，休息後改善。" });
  assert.equal(data.status, "complete");
  assert.equal(data.targets[0].facts[0].status, "unknown");
});

test("fact table: target-implied elements of fhir_get_profile_required_elements are default facts", () => {
  for (const [rt, rows] of Object.entries(PRIMARY_CONTENT)) {
    for (const [element] of rows) {
      const spec = FACT_TABLE[rt]?.find((r) => r.element === element);
      assert.ok(spec, `${rt}: ${element} has no fact row`);
      assert.ok(defaultFacts(rt).includes(spec.fact), `${element} is not a default fact`);
      assert.equal(spec.groundingClass, element.endsWith("code") ? "coding" : "source_fact", element);
    }
  }
  assert.deepEqual(primaryContentGaps(), []);
});

test("fact table: grounding classes come from the required-elements classifier (single source of truth)", () => {
  for (const rows of Object.values(FACT_TABLE)) {
    for (const r of rows) assert.equal(r.groundingClass, groundingClassOfPath(r.element), r.element);
  }
  // The spec table (§2.3.2): identifiers/dates/values are source facts, codes are codings.
  assert.equal(FACT_TABLE.MedicationRequest.find((r) => r.fact === "medication")?.groundingClass, "coding");
  assert.equal(FACT_TABLE.MedicationRequest.find((r) => r.fact === "duration")?.groundingClass, "source_fact");
  assert.equal(FACT_TABLE.Immunization.find((r) => r.fact === "vaccine")?.groundingClass, "coding");
});

test("deterministic and fast (< 200 ms per call)", async () => {
  for (const fx of fixtures) {
    const t0 = performance.now();
    const a = await checkCompleteness(completenessInputSchema.parse(fx.input));
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `${fx.name}: ${ms.toFixed(1)} ms`);
    const b = await checkCompleteness(completenessInputSchema.parse(fx.input));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  }
});
