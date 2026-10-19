import { test } from "node:test";
import assert from "node:assert/strict";
import { axisAgreement, axisKey, axisWords, buildAxisNames, buildAxisVocab, parseAxisConstraints, LATER_SPECIMEN_SHARE } from "./loincAxisNames.js";

test("axisKey / axisWords: case, hyphens, plurals and % folded", () => {
  assert.equal(axisKey("24-Hours"), "24 hour");
  assert.equal(axisKey("Blood - venous"), "blood venous");
  assert.equal(axisKey("Ketones"), "ketone");
  assert.equal(axisKey("Plas"), "plas");
  assert.deepEqual(axisWords("neutrophils %"), ["neutrophil", "percent"]);
});

/** A synthetic Loinc.csv: two analytes in several specimens. */
function rows(): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const add = (comp: string, sys: string, time: string, method: string, prop: string, related: string): void => {
    out.push({
      LOINC_NUM: `${out.length + 1}-0`, COMPONENT: comp, PROPERTY: prop, TIME_ASPCT: time, SYSTEM: sys, SCALE_TYP: "Qn",
      METHOD_TYP: method, STATUS: "ACTIVE", CLASSTYPE: "1", RELATEDNAMES2: related,
    });
  };
  for (const comp of ["Lactate", "Glucose", "Sodium", "Potassium"]) {
    add(comp, "BldV", "Pt", "", "SCnc", "Venous; Bld ven; Point in time; Random; QNT");
    add(comp, "Ser/Plas", "Pt", "", "SCnc", "Serum; Plasma; SerPl; Point in time; Random; QNT");
    add(comp, "Urine", "24H", "", "SRat", "UA; 24 hours; 24HR; QNT");
    add(comp, "Urine", "Pt", "Test strip", "SCnc", "UA; Dipstick; Point in time; Random; QNT");
  }
  // Leukocyte counts in Blood list "White blood cells" (an analyte word); a few terms have
  // the WBC system itself.
  for (let i = 0; i < 10; i += 1) add(`Leukocytes${i}`, "Bld", "Pt", "Automated count", "NCnc", "White blood cells; WBC; Whole blood; Point in time; Random; Count");
  for (let i = 0; i < 20; i += 1) add(`Hemoglobin${i}`, "Bld", "Pt", "", "MCnc", "Whole blood; Point in time; Random");
  add("Leukocyte antigen", "WBC", "Pt", "", "Prid", "White blood cells; Point in time; Random");
  return out;
}

const PARTS = [
  { partType: "SYSTEM", partName: "BldV", displayName: "Venous blood" },
  { partType: "SYSTEM", partName: "BldC", displayName: "Capillary blood" },
  { partType: "SYSTEM", partName: "Saliva", displayName: "Saliva (oral fluid)" },
  { partType: "SYSTEM", partName: "WBC", displayName: "White blood cells" },
  { partType: "TIME", partName: "24H", displayName: "24 hours" },
  { partType: "METHOD", partName: "Test strip", displayName: "Test strip" },
];

test("buildAxisNames: part / display names and RELATEDNAMES2 synonyms of each axis value", () => {
  const r = rows();
  // BldC / Saliva need terms to be known values.
  r.push({ LOINC_NUM: "90-0", COMPONENT: "Glucose", SYSTEM: "BldC", TIME_ASPCT: "Pt", PROPERTY: "MCnc", SCALE_TYP: "Qn", STATUS: "ACTIVE", CLASSTYPE: "1", RELATEDNAMES2: "" });
  r.push({ LOINC_NUM: "91-0", COMPONENT: "Cortisol", SYSTEM: "Saliva", TIME_ASPCT: "Pt", PROPERTY: "MCnc", SCALE_TYP: "Qn", STATUS: "ACTIVE", CLASSTYPE: "1", RELATEDNAMES2: "" });
  const out = buildAxisNames({ rows: r, parts: PARTS });
  const has = (axis: string, value: string, key: string): boolean => out.some((x) => x[0] === axis && x[1] === value && x[3] === key);
  assert.ok(has("system", "BldV", "venous blood"), "display name");
  assert.ok(has("system", "BldV", "venous"), "related name");
  assert.ok(has("system", "BldV", "bldv"), "part name");
  assert.ok(has("time", "24H", "24 hour") && has("time", "24H", "24hr"));
  assert.ok(has("time", "Pt", "random"), "Random belongs to TIME Pt, not to the properties of Pt terms");
  assert.ok(!out.some((x) => x[0] === "property" && x[3] === "random"));
  assert.ok(has("method", "Test strip", "dipstick"));
  assert.ok(has("system", "BldC", "capillary") && out.some((x) => x[3] === "capillary" && x[4] === "word"), "single word of a specimen display name");
  // "White blood cells" is listed on more Blood terms than there are WBC-system terms: an analyte word.
  assert.ok(!has("system", "WBC", "white blood cell"));
});

test("parseAxisConstraints: longest span, word forms, single specimen words", () => {
  const vocab = buildAxisVocab(
    [
      ["system", "BldV", "venous blood", "display"],
      ["system", "BldV", "venous", "related"],
      ["system", "Bld", "blood", "display"],
      ["system", "Urine", "urine", "part"],
      ["system", "Saliva", "saliva", "part"],
      ["system", "BldC", "capillary", "word"],
      ["time", "24H", "24 hour", "display"],
      ["time", "Pt", "random", "related"],
      ["property", "NFr", "percent", "related"],
      ["method", "Test strip", "dipstick", "related"],
    ].map(([axis, value, name_key, source]) => ({ axis, value, name_key, source })),
  );
  const show = (q: string): string[] => parseAxisConstraints(q, vocab).map((c) => `${c.axis}:${[...c.values].join(",")}`);
  assert.deepEqual(show("venous blood pH"), ["system:BldV"]);
  assert.deepEqual(show("24-hour urine protein"), ["time:24H", "system:Urine"]);
  assert.deepEqual(show("salivary cortisol"), ["system:Saliva"]);
  assert.deepEqual(show("capillary glucose"), ["system:BldC"]);
  assert.deepEqual(show("neutrophils %"), ["property:NFr"]);
  assert.deepEqual(show("random urine sodium"), ["time:Pt", "system:Urine"]);
  assert.deepEqual(show("hemoglobin"), []);
  assert.deepEqual(show("空腹血糖"), []);
  // Two specimens that exclude each other: the later one is most likely the analyte's name.
  const c = parseAxisConstraints("urine blood dipstick", vocab);
  assert.equal(c.find((x) => x.words[0] === "urine")!.weight, 1);
  assert.equal(c.find((x) => x.words[0] === "blood")!.weight, LATER_SPECIMEN_SHARE);
  assert.deepEqual(parseAxisConstraints("venous lactate", null), []);
});

test("axisAgreement: axis value or the term's own words satisfy a constraint", () => {
  const vocab = buildAxisVocab([
    { axis: "system", value: "CSF", name_key: "csf", source: "part" },
    { axis: "system", value: "Bld", name_key: "blood", source: "display" },
  ]);
  const c = parseAxisConstraints("CSF white blood cell count", vocab);
  const csfWbc = axisAgreement(c, { system: "CSF" }, ["Leukocytes [#/volume] in Cerebral spinal fluid", "White blood cell"]);
  const bldWbc = axisAgreement(c, { system: "Bld" }, ["Leukocytes [#/volume] in Blood by Automated count", "White blood cell"]);
  const csfOther = axisAgreement(c, { system: "CSF" }, ["Glucose [Mass/volume] in Cerebral spinal fluid"]);
  assert.ok(csfWbc > bldWbc, `${csfWbc} > ${bldWbc}`);
  assert.ok(csfWbc > csfOther);
  assert.equal(axisAgreement([], { system: "Bld" }, []), 0);
});
