import { test } from "node:test";
import assert from "node:assert/strict";
import { lexicalMatch, rankHybrid, type RankCandidate } from "./hybridRank.js";
import { icdDepthPrior, loincPrior, snomedPrior, stripSemanticTag } from "./terminologyRanking.js";

test("lexicalMatch: the query that IS the name beats names that merely contain it", () => {
  const is = lexicalMatch("heart failure", "Heart failure");
  const contains = lexicalMatch("heart failure", "Heart failure with reduced ejection fraction");
  assert.equal(is.exact, true);
  assert.equal(is.score, 1);
  assert.ok(contains.score > 0 && contains.score < 0.9, String(contains.score));
  // Generic qualifiers do not count against a name.
  assert.equal(lexicalMatch("heart failure", "Heart failure, unspecified").exact, true);
  assert.equal(lexicalMatch("肺炎", "肺炎，未明示病原體").score > lexicalMatch("肺炎", "吸入性肺炎及其他肺炎").score, true);
  assert.equal(lexicalMatch("asthma", "Diabetes").score, 0);
});

test("rankHybrid: a strong semantic match is not pushed out by weak lexical hits (RRF failure mode)", () => {
  const weak = (i: number): RankCandidate => ({ key: `lex${i}`, texts: [{ text: `Heart failure due to cause number ${i} of something` }], sim: 0.55 - i * 0.001 });
  const cands: RankCandidate[] = [
    ...Array.from({ length: 20 }, (_, i) => weak(i)),
    { key: "target", texts: [{ text: "Cardiac insufficiency" }], sim: 0.9 },
    ...Array.from({ length: 20 }, (_, i) => ({ key: `vec${i}`, texts: [{ text: `unrelated ${i}` }], sim: 0.6 - i * 0.002 })),
  ];
  const out = rankHybrid("heart failure", cands, 5);
  assert.ok(out.some((c) => c.key === "target"), JSON.stringify(out.map((c) => c.key)));
});

test("rankHybrid: exact name match plus top similarity ranks first; priors break near-ties", () => {
  const out = rankHybrid(
    "hemoglobin",
    [
      { key: "special", texts: [{ text: "Hemoglobin [Mass/volume] in Blood by calculation" }, { text: "Hemoglobin", weight: 0.85 }], sim: 0.8, prior: loincPrior(244, "ACTIVE") },
      { key: "common", texts: [{ text: "Hemoglobin [Mass/volume] in Blood" }, { text: "Hemoglobin", weight: 0.85 }], sim: 0.79, prior: loincPrior(17, "ACTIVE") },
      { key: "far", texts: [{ text: "Glucose" }], sim: 0.5 },
    ],
    3,
  );
  assert.equal(out[0].key, "common");
});

test("rankHybrid: the semantic guard keeps the vector channel's best two in the top-k", () => {
  const cands: RankCandidate[] = Array.from({ length: 10 }, (_, i) => ({ key: `exactish${i}`, texts: [{ text: `asthma attack ${i}` }], sim: 0.3, prior: 0.1 }));
  cands.push({ key: "sem1", texts: [{ text: "Bronchial hyperreactivity" }], sim: 0.95 });
  cands.push({ key: "sem2", texts: [{ text: "Reactive airway disease" }], sim: 0.94 });
  const out = rankHybrid("asthma attack", cands, 5, { lexWeight: 0.9, semWeight: 0.1 });
  assert.ok(out.some((c) => c.key === "sem1") && out.some((c) => c.key === "sem2"));
  assert.equal(out.length, 5);
});

test("rankHybrid without vectors is lexical (keyword-only mode)", () => {
  const out = rankHybrid("asthma", [{ key: "a", texts: [{ text: "Asthma" }], sim: null }, { key: "b", texts: [{ text: "Allergic asthma" }], sim: null }], 2);
  assert.deepEqual(out.map((c) => c.key), ["a", "b"]);
  assert.equal(out[0].source, "lexical");
});

test("priors", () => {
  assert.equal(icdDepthPrior("I50"), 0);
  assert.ok(icdDepthPrior("I50.9") > icdDepthPrior("S93.401A"));
  assert.ok(loincPrior(1, "ACTIVE") > loincPrior(5000, "ACTIVE"));
  assert.ok(loincPrior(null, "DEPRECATED") < 0);
  assert.equal(loincPrior(null, "ACTIVE"), 0);
  assert.ok(snomedPrior(false, "Asthma") < snomedPrior(true, "Asthma"));
  assert.equal(stripSemanticTag("Myocardial infarction (disorder)"), "Myocardial infarction");
});

test("lexicalMatch: a query that is a whole delimited part of the name scores high", () => {
  assert.ok(lexicalMatch("高血壓", "本態性(原發性)高血壓").score >= 0.85);
  assert.ok(lexicalMatch("hypertension", "Essential (primary) hypertension").score >= 0.85);
  assert.ok(lexicalMatch("高血壓", "高血壓性腦病變").score < 0.85);
});

test("rankHybrid families: members the query cannot tell apart are ordered by defaultness, not vector noise", () => {
  const fam = (key: string, name: string, sim: number, defaultness: number): RankCandidate => ({
    key,
    texts: [{ text: name }, { text: "Hemoglobin", weight: 0.85 }],
    sim,
    family: "loinc:hemoglobin",
    defaultness,
  });
  const cands = [
    fam("molar", "Hemoglobin [Moles/volume] in Blood", 0.69, 0.3),
    fam("arterial", "Hemoglobin [Moles/volume] in Arterial blood", 0.68, 0),
    fam("common", "Hemoglobin [Mass/volume] in Blood", 0.59, 0.75),
    { key: "other", texts: [{ text: "Glucose [Mass/volume] in Blood" }], sim: 0.6 },
  ];
  const out = rankHybrid("hemoglobin", cands, 4);
  assert.equal(out[0].key, "common");
  // Without the family information the vector order wins (the failure mode this fixes).
  const plain = rankHybrid("hemoglobin", cands.map(({ family: _f, defaultness: _d, ...c }) => c), 4);
  assert.equal(plain[0].key, "molar");
});

test("rankHybrid families: a qualifier the query names still picks its member", () => {
  const fam = (key: string, name: string, sim: number, defaultness: number): RankCandidate => ({ key, texts: [{ text: name }], sim, family: "loinc:lactate", defaultness });
  const out = rankHybrid(
    "arterial lactate",
    [fam("serum", "Lactate [Moles/volume] in Serum or Plasma", 0.7, 0.5), fam("arterial", "Lactate [Moles/volume] in Arterial blood", 0.68, 0.4)],
    2,
  );
  assert.equal(out[0].key, "arterial");
  assert.ok(out[0].coverage > out[1].coverage);
});

test("rankHybrid families: members honouring the query's stated qualifiers come before the default", () => {
  // "salivary cortisol": every Cortisol term covers "cortisol"; only the saliva term agrees
  // with the stated specimen, and it wins although the serum term is far more common.
  const fam = (key: string, sim: number, defaultness: number, qualifier: number): RankCandidate => ({
    key,
    texts: [{ text: "Cortisol" }],
    sim,
    family: "loinc:cortisol",
    defaultness,
    qualifier,
  });
  const out = rankHybrid("salivary cortisol", [fam("serum", 0.8, 0.9, -1), fam("saliva", 0.7, 0.3, 1), fam("urine", 0.75, 0.5, -1)], 3);
  assert.equal(out[0].key, "saliva");
  // No qualifier stated: the default reading wins as before.
  const plain = rankHybrid("cortisol", [fam("serum", 0.7, 0.9, 0), fam("saliva", 0.8, 0.3, 0)], 2);
  assert.equal(plain[0].key, "serum");
});

test("rankHybrid: the semantic guard never pushes out the top candidates", () => {
  // Everything below the best candidate is an exact name match (an analyte synonym on the
  // challenge variants): the guard must not replace the best one to make room.
  const cands: RankCandidate[] = [
    { key: "best", texts: [{ text: "Renin [Enzymatic activity/volume] in Plasma" }], sim: 0.6, prior: 0.3 },
    ...Array.from({ length: 4 }, (_, i) => ({ key: `exact${i}`, texts: [{ text: "Plasma renin activity" }], sim: 0.55 - i * 0.01 })),
    { key: "vec", texts: [{ text: "Aldosterone and renin panel" }], sim: 0.9 },
  ];
  const out = rankHybrid("plasma renin activity", cands, 5);
  assert.ok(out.some((c) => c.key === "best"), JSON.stringify(out.map((c) => c.key)));
});
