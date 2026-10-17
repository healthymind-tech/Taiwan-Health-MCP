/**
 * Parity tests: lexicon.ts vs the Python reference tw_lexicon.py.
 * Golden outputs were generated once by scripts/gen_golden.py (python3 -I, reference unmodified) into
 * __fixtures__/private/lexicon_golden.json, so this test is pure (no Python, no DB).
 *
 * The golden contains CARVE-TW record lines and is private (git-ignored); the parity tests skip when it is absent.
 * Public lexicon coverage on hand-written strings: syntheticExamples.test.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  LEXICON_SHA256,
  LEXICON_VERSION,
  canonUnit,
  cjkBigrams,
  freqSignatures,
  gendersIn,
  hasStructure,
  headerOf,
  isShortCjkPartial,
  latTokens,
  lcsCjk,
  nameSimilarity,
  nfkc,
  norm,
  normWithMap,
  numbersWithUnits,
  parseDates,
  parseFhirDatetime,
  parseTimes,
  relativeOffsets,
  routesIn,
  segment,
  twIdChecksumOk,
  unitsCompatible,
} from "./lexicon.js";
import { isAlnum, isAlpha, isSpaceCp, pyFixed, pyRepr, pyRound } from "./py.js";
import { loadPrivateFixture, privateSkip } from "./testkit.js";

const skip = privateSkip("lexicon_golden.json");
const G = loadPrivateFixture<any>("lexicon_golden.json", {});

const LOINC_AXIS = new Set(["acnc", "auto", "automated", "bld", "ccnc", "mcnc", "ncnc", "ord", "plas", "pnl", "pt", "ql", "qn", "scnc", "ser", "serpl", "vfr"]);
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
const reversed = (s: string): string => Array.from(s).reverse().join("");

/**
 * Lexicon 0.3.0 (issues v1) zh->en bridges and abbreviations the reference does not have. Strings that contain one
 * of them expand to extra Latin tokens, so their token / similarity parity with the reference is a documented
 * deviation.
 */
const BRIDGES_030 = ["葡萄糖", "血糖", "餐後", "飯後", "空腹", "飯前", "肌酸酐", "尿素氮", "尿酸", "全套血液檢查"];
const ABBREV_030 = new Set(["pc", "cbc"]);
const has030 = (s: string): boolean => {
  const t = nfkc(s);
  return BRIDGES_030.some((b) => t.includes(b)) || [...latTokens(s, false)].some((w) => ABBREV_030.has(w));
};

test("lexicon version and sha are exposed", () => {
  // the data module started as a port of the reference lexicon and has since gained PAS tables (0.2.0) and the
  // issues-v1 fixes (0.3.0)
  if (!skip) assert.equal(G.version, "tw-lexicon 0.1.0");
  assert.equal(LEXICON_VERSION, "tw-lexicon 0.3.0");
  assert.match(LEXICON_SHA256, /^[0-9a-f]{64}$/);
});

test("per-string lexicon functions match the reference", { skip }, () => {
  const fails: string[] = [];
  const cmp = (name: string, s: string, got: unknown, exp: unknown): void => {
    try {
      assert.deepStrictEqual(got, exp);
    } catch {
      fails.push(`${name}(${JSON.stringify(s)}): got ${JSON.stringify(got)} exp ${JSON.stringify(exp)}`);
    }
  };
  for (const r of G.rows) {
    const s: string = r.s;
    const [n, mp] = normWithMap(s);
    cmp("norm", s, n, r.norm);
    cmp("map", s, mp, r.map);
    cmp("nfkc", s, nfkc(s), r.nfkc);
    cmp("header", s, headerOf(s), r.header);
    cmp("genders", s, sorted(gendersIn(s)), r.genders);
    cmp("dates", s, parseDates(s), r.dates);
    cmp("times", s, parseTimes(s), r.times);
    cmp("rel", s, relativeOffsets(s), r.rel);
    cmp("nums", s, numbersWithUnits(s), r.nums);
    if (r.freq !== null) {
      const f = [...freqSignatures(s)];
      const key = (x: unknown): string => (typeof x === "number" ? `0:${x.toFixed(12)}` : `1:${x}`);
      cmp("freq", s, f.map(key).sort(), (r.freq as unknown[]).map(key).sort());
    }
    cmp("routes", s, sorted(routesIn(s)), r.routes);
    if (!has030(s)) cmp("lat", s, sorted(latTokens(s)), r.lat);
    cmp("lat0", s, sorted(latTokens(s, false)), r.lat0);
    cmp("cjk", s, sorted(cjkBigrams(s)), r.cjk);
    cmp("lcs", s, lcsCjk(s, reversed(s)), r.lcs_self);
  }
  assert.equal(fails.length, 0, `${fails.length} mismatches:\n${fails.slice(0, 30).join("\n")}`);
  assert.ok(G.rows.length > 300);
});

test("segmentation and structure detection match the reference", { skip }, () => {
  for (const sg of G.segments) {
    assert.deepStrictEqual(segment(sg.text), sg.lines);
    assert.equal(hasStructure(segment(sg.text)), sg.structured);
  }
});

test("FHIR dateTime parsing (with time-zone conversion to +08:00)", { skip }, () => {
  for (const [s, exp] of G.fhir_dt) assert.deepStrictEqual(parseFhirDatetime(s), exp, s);
});

test("units, national-ID checksum", { skip }, () => {
  for (const [u, exp] of G.canon) assert.equal(canonUnit(u), exp, String(u));
  for (const [a, b, exp] of G.compat) assert.equal(unitsCompatible(a, b), exp, `${a} ~ ${b}`);
  for (const [v, exp] of G.ids) assert.equal(twIdChecksumOk(v), exp, v);
});

test("name similarity matches the reference on record-line x authoritative-name pairs", { skip }, () => {
  const fails: string[] = [];
  let deviated = 0;
  for (const [q, n, exp] of G.similarity) {
    const got = nameSimilarity(q, n);
    if (Math.abs(got - exp) <= 1e-9) continue;
    // documented deviation (0.3.0): new zh->en bridges / abbreviations
    if (has030(q) || has030(n)) {
      deviated++;
      continue;
    }
    // documented deviation: short Chinese names must match contiguously (WBC 白血球計數 vs RBC 紅血球計數)
    // documented deviation: LOINC axis tokens (Bld, Auto, SerPl, mCnc …) are generic (0.2) in lexicon 0.2.0
    if ([...latTokens(n, true)].some((t) => LOINC_AXIS.has(t))) {
      deviated++;
      continue;
    }
    if (isShortCjkPartial(n, q) && got === 0.49 && exp >= 0.5) {
      deviated++;
      continue;
    }
    fails.push(`${JSON.stringify(q)} ~ ${JSON.stringify(n)}: ${got} vs ${exp}`);
  }
  assert.equal(fails.length, 0, fails.slice(0, 20).join("\n"));
  assert.ok(deviated < G.similarity.length * 0.05, `deviated ${deviated}`);
  console.log(`similarity pairs ${G.similarity.length}, documented deviations ${deviated}`);
  assert.ok(G.similarity.length > 1000);
});

/**
 * Code points assigned in Unicode 16 (Node's ICU) but unassigned in Unicode 15.1 (the Python that generated the
 * fixtures). Python treats them as unassigned (not alphanumeric, dropped by `norm`); none can occur in clinical text.
 */
const UNICODE16_NEW = new Set([0x88f, 0xc5c, 0xcdc, 0x1c89, 0x1c8a, 0xa7cb, 0xa7cc, 0xa7cd, 0xa7ce, 0xa7cf, 0xa7d2, 0xa7d4, 0xa7da, 0xa7db, 0xa7dc, 0xa7f1]);

function bmpHash(fn: (c: string) => string, unassigned: (c: string) => string): string {
  const h = createHash("sha256");
  for (let cp = 0; cp < 0x10000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    h.update((UNICODE16_NEW.has(cp) ? unassigned(c) : fn(c)) + "\u0000", "utf8");
  }
  return h.digest("hex");
}

test("character classes over the whole BMP match Python (norm / NFKC / isalpha / isalnum / isspace / lower)", { skip }, () => {
  const same = (c: string): string => c;
  const zero = (): string => "0";
  const got = {
    isspace: bmpHash((c) => (isSpaceCp(c.codePointAt(0)!) ? "1" : "0"), zero) === G.bmp.isspace,
    norm: bmpHash(norm, () => "") === G.bmp.norm,
    nfkc: bmpHash(nfkc, same) === G.bmp.nfkc,
    isalpha: bmpHash((c) => (isAlpha(c) ? "1" : "0"), zero) === G.bmp.isalpha,
    isalnum: bmpHash((c) => (isAlnum(c) ? "1" : "0"), zero) === G.bmp.isalnum,
    lower: bmpHash((c) => c.toLowerCase(), same) === G.bmp.lower,
  };
  assert.deepStrictEqual(got, { isspace: true, norm: true, nfkc: true, isalpha: true, isalnum: true, lower: true }, `unicode data ${G.bmp.unidata}`);
});

test("python formatting helpers", () => {
  assert.equal(pyFixed(0.125, 2), "0.12");
  assert.equal(pyFixed(0.375, 2), "0.38");
  assert.equal(pyFixed(2.675, 2), "2.67");
  assert.equal(pyFixed(0.5, 0), "0");
  assert.equal(pyFixed(1.5, 0), "2");
  assert.equal(pyFixed(99.95, 1), "100.0");
  assert.equal(pyRound(0.0005, 3), 0.001);
  assert.equal(pyRound(2 / 3, 3), 0.667);
  assert.equal(pyRepr("a'b"), `"a'b"`);
  assert.equal(pyRepr("下背痛"), "'下背痛'");
  assert.equal(pyRepr("a\nb"), "'a\\nb'");
});
