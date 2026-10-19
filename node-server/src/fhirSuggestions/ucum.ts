/**
 * UCUM repair candidates for "Unknown code '<c>' in the CodeSystem 'http://unitsofmeasure.org'".
 *
 * The expression is split into atoms (operators `/` `.` and parentheses kept), every atom
 * that is not valid UCUM on its own gets ranked variants — case folding (UCUM is case
 * sensitive: `ML` / `mL` / `Ml`), square-bracket variants (`[U]` → `U`, `[UI]` → `[iU]`),
 * near atoms of the UCUM table (prefix + metric unit, edit distance 1–2), common clinical
 * spellings (mcg → ug, hr → h, mmHg → mm[Hg]) and, for words that are not units at all
 * (tab, puff), a UCUM annotation (`{tablet}`) — and the recombined expressions are
 * validated with the same UCUM parser the validator uses (ucum-lhc). Only valid
 * expressions are returned, cheapest edit first.
 */

import { createRequire } from "node:module";
import { checkUcumCode } from "../fhirUcum.js";
import { levenshtein } from "./util.js";

export interface UcumCandidate {
  value: string;
  /** Edit cost (0 = unchanged); lower is better. */
  cost: number;
  reason: string;
}

// --------------------------------------------------------------------------- //
// UCUM atom table (lazy, from ucum-lhc)
// --------------------------------------------------------------------------- //

const PREFIXES = ["Y", "Z", "E", "P", "T", "G", "M", "k", "h", "da", "d", "c", "m", "u", "n", "p", "f", "a", "z", "y", "Ki", "Mi", "Gi", "Ti"];

/** Units clinicians actually write; a small tie-breaker between equally cheap repairs. */
const COMMON = new Set([
  "g", "mg", "ug", "ng", "kg", "L", "mL", "dL", "uL", "mol", "mmol", "umol", "nmol", "meq", "eq", "U", "[iU]", "[IU]",
  "h", "min", "s", "d", "wk", "mo", "a", "%", "Cel", "[degF]", "mm[Hg]", "cm[H2O]", "m", "cm", "mm", "[drp]", "kcal", "cal",
]);

/** Common non-UCUM clinical spellings → UCUM atom ("" = a pure count word, dropped). */
const SPELLINGS: Record<string, string> = {
  mcg: "ug", "µg": "ug", "μg": "ug", mcl: "uL", "µl": "uL", mcmol: "umol",
  cc: "mL", ml: "mL", dl: "dL", ul: "uL",
  hr: "h", hrs: "h", hour: "h", hours: "h", sec: "s", secs: "s", second: "s", seconds: "s",
  mins: "min", minute: "min", minutes: "min", day: "d", days: "d", week: "wk", weeks: "wk", wks: "wk",
  month: "mo", months: "mo", year: "a", years: "a", yr: "a", yrs: "a",
  iu: "[iU]", unit: "U", units: "U", percent: "%",
  degc: "Cel", "°c": "Cel", celsius: "Cel", degf: "[degF]", "°f": "[degF]", fahrenheit: "[degF]",
  mmhg: "mm[Hg]", cmh2o: "cm[H2O]", bpm: "/min",
  gtt: "[drp]", gtts: "[drp]", drop: "[drp]", drops: "[drp]",
  times: "", time: "", x: "", count: "", beats: "", beat: "", breaths: "", breath: "", events: "", event: "",
};

/** Dose-form / packaging words that are not units: UCUM annotation of the singular form. */
const NON_UNITS: Record<string, string> = {
  tab: "tablet", tabs: "tablet", tablet: "tablet", tablets: "tablet", cap: "capsule", caps: "capsule", capsule: "capsule",
  capsules: "capsule", puff: "puff", puffs: "puff", spray: "spray", sprays: "spray", patch: "patch", patches: "patch",
  supp: "suppository", suppository: "suppository", suppositories: "suppository", amp: "ampule", ampoule: "ampule",
  ampule: "ampule", ampules: "ampule", vial: "vial", vials: "vial", sachet: "sachet", sachets: "sachet", pack: "pack",
  packet: "packet", piece: "piece", pieces: "piece", pc: "piece", pcs: "piece", dose: "dose", doses: "dose",
  application: "application", applications: "application", bottle: "bottle", inhalation: "inhalation",
  lozenge: "lozenge", pill: "pill", pills: "pill", bag: "bag", tube: "tube", ea: "each", each: "each",
};

interface AtomEntry {
  code: string;
  lower: string;
  /** Lower-cased code without brackets, letters sorted (anagram key, e.g. [iU] / [UI]). */
  sorted: string;
  stripped: string;
  /** Prefix + metric unit generated here (not a table entry): slightly more expensive. */
  composed: boolean;
}

let atomTable: AtomEntry[] | null | undefined;

function atoms(): AtomEntry[] | null {
  if (atomTable !== undefined) return atomTable;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@lhncbc/ucum-lhc");
    pkg.UcumLhcUtils.getInstance();
    const ut = pkg.UnitTables.getInstance();
    const codes: string[] = ut.getAllUnitCodes();
    // Atoms only: table entries that are expressions (/[IU], 10*3/uL) are not atoms.
    const base = new Set<string>();
    const all = new Set<string>();
    for (const c of codes) {
      if (typeof c !== "string" || !c || /[/.()]/.test(c) || /^\d/.test(c)) continue;
      base.add(c);
      all.add(c);
      const u = ut.getUnitByCode(c);
      if (u && u.isMetric_) for (const p of PREFIXES) all.add(p + c);
    }
    atomTable = [...all].sort().map((code) => {
      const lower = code.toLowerCase();
      const stripped = lower.replace(/^\[(.*)\]$/, "$1");
      return { code, lower, stripped, sorted: [...stripped].sort().join(""), composed: !base.has(code) && !COMMON.has(code) };
    });
  } catch {
    atomTable = null;
  }
  return atomTable;
}

function valid(expr: string): boolean {
  return expr !== "" && checkUcumCode(expr) === "valid";
}

// --------------------------------------------------------------------------- //
// Atom variants
// --------------------------------------------------------------------------- //

interface Variant {
  text: string;
  cost: number;
  why: string;
}

const atomCache = new Map<string, Variant[]>();

function atomVariants(atom: string): Variant[] {
  const hit = atomCache.get(atom);
  if (hit) return hit;
  const out: Variant[] = [];
  const add = (text: string, cost: number, why: string): void => {
    if (text !== "" && !valid(text)) return;
    const cur = out.find((v) => v.text === text);
    if (cur) {
      if (cost < cur.cost) Object.assign(cur, { cost, why });
      return;
    }
    out.push({ text, cost: cost - (COMMON.has(text) ? 0.05 : 0), why });
  };
  const lower = atom.toLowerCase();
  const bare = lower.replace(/^\[(.*)\]$/, "$1").replace(/^\{(.*)\}$/, "$1");
  // Exponent: m2, cm-2 (base + integer exponent).
  const exp = /^([^\d[\]{}+-][^[\]{}]*?)([+-]?\d+)$/.exec(atom);
  if (exp && !/\d$/.test(exp[1])) {
    for (const v of atomVariants(exp[1])) if (v.text) add(v.text + exp[2], v.cost, v.why);
  }
  // m^2 / m**2 → m2 (UCUM exponents are plain integers).
  const caret = /^(.+?)(?:\^|\*\*)([+-]?\d+)$/.exec(atom);
  if (caret && !/^10$/.test(caret[1])) {
    const plain = caret[1] + caret[2];
    if (valid(plain)) add(plain, 0.2, `UCUM exponents are written without '^': '${plain}'`);
    else for (const v of atomVariants(plain)) add(v.text, v.cost + 0.2, `UCUM exponents are written without '^': ${v.why || v.text}`);
  }
  if (lower in SPELLINGS) add(SPELLINGS[lower], 0.25, `'${atom}' is not UCUM; the UCUM code is '${SPELLINGS[lower] || "(a count: omit it)"}'`);
  else if (bare in SPELLINGS && SPELLINGS[bare]) add(SPELLINGS[bare], 0.4, `'${atom}' is not UCUM; the UCUM code is '${SPELLINGS[bare]}'`);
  const table = atoms();
  if (table) {
    const sortedKey = [...bare].sort().join("");
    for (const e of table) {
      if (e.code === atom) continue;
      const k = e.composed ? 0.3 : 0;
      if (e.lower === lower) add(e.code, 0.3 + k, `UCUM is case-sensitive: '${e.code}'`);
      else if (e.stripped === bare && bare.length) {
        add(e.code, 0.5 + k, e.code.startsWith("[") ? `the UCUM code is written in square brackets: '${e.code}'` : `the UCUM code has no square brackets: '${e.code}'`);
      } else if (bare.length >= 2 && e.sorted === sortedKey && e.code.startsWith("[") === atom.startsWith("[")) {
        add(e.code, 0.8 + k, `closest UCUM atom: '${e.code}'`);
      } else if (bare.length >= 2 && Math.abs(e.lower.length - lower.length) <= 2) {
        const d = levenshtein(lower, e.lower, 2);
        if (d === 1) add(e.code, 1.0 + k, `closest UCUM atom (1 edit): '${e.code}'`);
        else if (d === 2 && lower.length >= 4) add(e.code, 1.6 + k, `closest UCUM atom (2 edits): '${e.code}'`);
      }
    }
  }
  if (/^[a-z][a-z-]*$/i.test(atom)) {
    const word = NON_UNITS[lower];
    if (word) add(`{${word}}`, 0.45, `'${atom}' is not a unit; UCUM writes a counted thing as an annotation '{${word}}' (a dimensionless count)`);
    else if (atom.length >= 3) add(`{${lower}}`, 2.0, `'${atom}' is not a UCUM unit; as a count it can be written as the annotation '{${lower}}'`);
  }
  out.sort((a, b) => a.cost - b.cost || (a.text < b.text ? -1 : 1));
  const top = out.slice(0, 5);
  if (atomCache.size > 5000) atomCache.clear();
  atomCache.set(atom, top);
  return top;
}

/** Split a UCUM expression into atoms and operators (`/`, `.`, `(`, `)`), brackets kept intact. */
function split(expr: string): Array<{ op: boolean; text: string }> {
  const out: Array<{ op: boolean; text: string }> = [];
  let buf = "";
  let sq = 0;
  let cu = 0;
  for (const ch of expr) {
    if (ch === "[") sq++;
    if (ch === "]") sq = Math.max(0, sq - 1);
    if (ch === "{") cu++;
    if (ch === "}") cu = Math.max(0, cu - 1);
    if (!sq && !cu && (ch === "/" || ch === "." || ch === "(" || ch === ")")) {
      if (buf) out.push({ op: false, text: buf });
      out.push({ op: true, text: ch });
      buf = "";
    } else buf += ch;
  }
  if (buf) out.push({ op: false, text: buf });
  return out;
}

/** Ranked valid UCUM expressions close to `code` (empty when none is found). */
export function suggestUcum(code: string, unitText: string | null = null, max = 5): UcumCandidate[] {
  const found = new Map<string, UcumCandidate>();
  const push = (value: string, cost: number, reason: string): void => {
    if (!value || value === code || !valid(value)) return;
    const cur = found.get(value);
    if (!cur || cost < cur.cost) found.set(value, { value, cost, reason });
  };
  const src = String(code ?? "");
  const compact = src.replace(/\s+/g, "");
  if (compact !== src) push(compact, 0.1, "UCUM codes contain no whitespace");
  const parts = split(compact);
  const slots = parts.map((p) => {
    if (p.op || valid(p.text) || /^\d+$/.test(p.text) || /^10[*^][+-]?\d+$/.test(p.text)) return [{ text: p.text, cost: 0, why: "" }];
    return atomVariants(p.text);
  });
  if (slots.every((s) => s.length)) {
    // Cheapest combinations first (bounded beam).
    let combos: Array<{ text: string; cost: number; why: string[] }> = [{ text: "", cost: 0, why: [] }];
    for (const s of slots) {
      const next: typeof combos = [];
      for (const c of combos) for (const v of s) next.push({ text: c.text + v.text, cost: c.cost + v.cost, why: v.why ? [...c.why, v.why] : c.why });
      next.sort((a, b) => a.cost - b.cost || (a.text < b.text ? -1 : 1));
      combos = next.slice(0, 24);
    }
    for (const c of combos) {
      // A dropped leading count word leaves "/d" — valid; a dangling operator is not.
      push(c.text, c.cost, c.why.join("; ") || "valid UCUM expression");
    }
  }
  if (unitText && unitText !== code) {
    const u = unitText.trim();
    if (valid(u)) push(u, 0.6, `Quantity.unit '${u}' is itself a valid UCUM code`);
    else for (const c of suggestUcum(u, null, 2)) push(c.value, c.cost + 0.5, `from Quantity.unit '${u}': ${c.reason}`);
  }
  return [...found.values()].sort((a, b) => a.cost - b.cost || (a.value < b.value ? -1 : 1)).slice(0, max);
}
