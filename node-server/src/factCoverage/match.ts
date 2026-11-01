/**
 * fhir_check_fact_coverage step 3: does a fact value appear in a STRUCTURED element of the Bundle?
 *
 * Structured = every element except narrative and free text: Resource.text (Narrative), the text of an uncoded
 * CodeableConcept, Dosage.text, Annotation (`note`), Reference.display, `comment`, `patientInstruction`, `div`.
 * Coding.display is never a match on its own — it identifies the Coding (which has a code) the value names.
 * HumanName.text and Address.text are structured (the element itself is the name / address, also without parts), and
 * so is the text of a coded CodeableConcept (the record wording of that code, v20.1). Phrase elements
 * (DiagnosticReport.conclusion, valueString …) cover a value they contain; phone ContactPoints compare by digits.
 *
 * Equivalences are by FHIR datatype and terminology only (never per IG):
 *   - dates: ROC (民國 114/06/02, 114年6月2日) and Gregorian spellings ↔ FHIR date / dateTime / Period bounds, at the
 *     fact's precision (grounding/lexicon parseDates);
 *   - routes: PO / 口服 / oral ↔ a Coding whose code, display or terminology name names the route (SNOMED 26643006,
 *     an IG route code) — grounding/lexicon routesIn;
 *   - frequency: BID / 一天兩次 / Q12H ↔ Timing.repeat {frequency, period, periodUnit} with the same administrations
 *     per day, or a Timing.code naming it (grounding/lexicon freqSignatures);
 *   - numbers + units: the same number with a unit compatible with the UCUM code or the human unit, or converted
 *     (lexicon CONVERT: g ↔ mg, cm ↔ m …); a unit-only value matches a Quantity unit; plain numbers never match a
 *     count / order element (COUNT_KEYS: Dosage.sequence, Timing.repeat.frequency …);
 *     every spelling (12.50 = 12.5, 兩 = 2);
 *   - codes: Coding.code, or the Coding's display / terminology names (synonyms, Chinese designations);
 *   - administrative gender (男 / M ↔ male), booleans (是 / yes ↔ true);
 *   - other strings: equal after normalisation; HumanName also as family + given.
 */
import { CONVERT, ENC_CLASS, aliasIn, canonUnit, departmentKeysOf, freqSignatures, gendersIn, nfkc, norm, numbersWithUnits, parseDates, parseFhirDatetime, routesIn, sameNumber, unitsCompatible } from "../grounding/lexicon.js";
import type { PerDay } from "../grounding/lexicon.js";
import { cnToArabic } from "../recordChecks/recordValues.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

/** One element of an entry resource: an object or a primitive. */
export interface Node {
  entry: number;
  resourceType: string;
  /** RFC 6901 pointer into the Bundle. */
  pointer: string;
  /** Generic element path (ResourceType.a.b, no indices). */
  path: string;
  key: string;
  value: unknown;
  parent: Json | null;
}

export interface FoundAt {
  pointer: string;
  path: string;
  value: unknown;
  /** How the value was matched (equal, ROC date, route code, timing, unit conversion, coding name …). */
  how: string;
}

const SKIP_KEYS = new Set(["div", "note", "comment", "patientInstruction", "meta", "id", "fullUrl", "resourceType", "reference", "narrative"]);
const NAME_KEYS = ["family", "given", "prefix", "suffix"];
const ADDRESS_KEYS = ["line", "city", "district", "state", "postalCode", "country"];

function esc(token: string): string {
  return token.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

/** `text` is structured only on HumanName / Address (by their parts, or by the element holding them: `name`, `address`). */
function textIsStructured(parent: Json, key: string): boolean {
  return key === "name" || key === "address" || NAME_KEYS.some((k) => k in parent) || ADDRESS_KEYS.some((k) => k in parent);
}

/** CodeableConcept.text of a coded concept: the record's wording of the concept a Coding (with a code) identifies. */
function isCodedText(parent: Json): boolean {
  return Array.isArray(parent.coding) && parent.coding.some((c: unknown) => isObj(c) && typeof c.code === "string" && c.code !== "");
}

/** Every structured node of the Bundle's entry resources (narrative / free text left out). */
export function structuredNodes(bundle: Json): Node[] {
  const out: Node[] = [];
  const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
  entries.forEach((e: unknown, i: number) => {
    if (!isObj(e) || !isObj(e.resource) || typeof e.resource.resourceType !== "string") return;
    const rt = e.resource.resourceType as string;
    const walk = (node: unknown, ptr: string, path: string, key: string, parent: Json | null): void => {
      out.push({ entry: i, resourceType: rt, pointer: ptr, path, key, value: node, parent });
      if (Array.isArray(node)) {
        node.forEach((x, k) => walk(x, `${ptr}/${k}`, path, key, parent));
        return;
      }
      if (!isObj(node)) return;
      for (const [k, v] of Object.entries(node)) {
        if (SKIP_KEYS.has(k)) continue;
        if (k === "text" && !textIsStructured(node, key) && !isCodedText(node)) continue;
        if (k === "display" && !("code" in node)) continue; // Reference.display; Coding.display stays with its Coding
        walk(v, `${ptr}/${esc(k)}`, `${path}.${k}`, k, node);
      }
    };
    const res = e.resource as Json;
    for (const [k, v] of Object.entries(res)) {
      if (SKIP_KEYS.has(k) || k === "text") continue;
      walk(v, `/entry/${i}/resource/${esc(k)}`, `${rt}.${k}`, k, res);
    }
  });
  // Array containers are not elements themselves.
  return out.filter((n) => !Array.isArray(n.value));
}

// ------------------------------------------------------------------------------------------ value readings

export interface ValueReading {
  raw: string;
  /** Dates the value states (precision + y/m/d). */
  dates: Array<{ p: "day" | "month" | "year"; y: number; m: number | null; d: number | null }>;
  routes: Set<string>;
  freq: Set<PerDay>;
  numbers: Array<{ value: number; unit: string | null; raw: string }>;
  genders: Set<string>;
  bool: boolean | null;
  /** norm() of the value (comparison key for codes / strings). */
  key: string;
}

const RE_ISO = /^\d{4}(?:-\d{2}(?:-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?)?)?$/u;

export function readValue(value: unknown): ValueReading {
  const raw = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const t = raw.trim();
  const dates: ValueReading["dates"] = [];
  if (RE_ISO.test(t)) {
    const f = parseFhirDatetime(t);
    if (f) dates.push({ p: f.d !== null ? "day" : f.m !== null ? "month" : "year", y: f.y, m: f.m, d: f.d });
  } else {
    for (const [p, [y, m, d]] of parseDates(t)) if (p !== "md" && y !== null) dates.push({ p, y, m, d });
  }
  const arabic = cnToArabic(t);
  const numbers = dates.length ? [] : numbersWithUnits(arabic).map(([, v, u, r]) => ({ value: v, unit: u, raw: r }));
  const short = t.length <= 40;
  const genders = short && t.length <= 8 ? gendersIn(t) : new Set<string>();
  const b = /^(?:是|有|yes|true|y)$/iu.test(t) ? true : /^(?:否|無|no|false|n)$/iu.test(t) ? false : null;
  return {
    raw: t,
    dates,
    routes: short ? routesIn(t) : new Set(),
    freq: short ? freqSignatures(t) : new Set(),
    numbers,
    genders,
    bool: b,
    key: norm(t),
  };
}

// ------------------------------------------------------------------------------------------ matchers

const PER_DAY_OF_UNIT: Record<string, number> = { s: 86400, min: 1440, h: 24, d: 1, wk: 1 / 7, mo: 1 / 30, a: 1 / 365 };

/** Administrations per day of a Timing.repeat (null when not a plain frequency / period). */
function perDay(repeat: Json): number | null {
  const f = Number(repeat.frequency ?? 1);
  const p = Number(repeat.period);
  const k = PER_DAY_OF_UNIT[String(repeat.periodUnit)];
  if (!Number.isFinite(f) || !Number.isFinite(p) || p <= 0 || k === undefined) return null;
  return (f / p) * k;
}

function isCodingObj(v: unknown): v is Json {
  return isObj(v) && typeof v.code === "string" && ("system" in v || "display" in v) && !("value" in v);
}

function isCoding(n: Node): boolean {
  return isObj(n.value) && typeof n.value.code === "string" && !("value" in n.value) && (n.key === "coding" || isCodingObj(n.value));
}

/** Parts of a Coding / Quantity — compared through the whole datatype, never one by one. */
const PART_KEYS = new Set(["code", "display", "system", "version", "unit", "userSelected", "comparator"]);

/** A Quantity: a numeric value (a numeric string only with a unit / code — Identifier / ContactPoint values are strings). */
function isQuantity(v: unknown): v is Json {
  if (!isObj(v) || "coding" in v) return false;
  if (typeof v.value === "number") return true;
  return typeof v.value === "string" && /^-?\d+(?:\.\d+)?$/u.test(v.value) && ("unit" in v || ("code" in v && !("use" in v)));
}

/** Plain numbers that count, order or identify (Dosage.sequence 1, Timing.repeat.frequency 2, rank …): never a clinical value. */
const COUNT_KEYS = new Set(["sequence", "rank", "priority", "count", "countMax", "frequency", "frequencyMax", "period", "periodMax", "duration", "durationMax", "numberOfRepeatsAllowed", "multipleBirthInteger", "linkId", "position", "line", "offset", "dayOfWeek", "numberOfSeries", "doseNumberPositiveInt", "seriesDosesPositiveInt", "factor"]);

/** Elements whose string value is a phrase of the record (a contained fact value counts when it is substantial). */
const PHRASE_KEYS = new Set(["conclusion", "valueString", "text", "line", "description", "summary", "title"]);

/** A unit-only value (°C, mg/dL, 次/分): its canonical unit, else null. */
export function unitOnly(raw: string): string | null {
  const t = nfkc(raw).trim();
  if (!t || t.length > 24 || /^\d/u.test(t)) return null;
  const parsed = numbersWithUnits(`1 ${t}`);
  if (parsed.length < 1) return null;
  const u = parsed[0][2];
  return u !== null && u === canonUnit(t) ? u : null;
}

const digits = (s: string): string => nfkc(s).replace(/\D+/gu, "").replace(/^886/u, "0");

/** Compact value shown in found_at. */
function shown(v: unknown): unknown {
  if (!isObj(v)) return v;
  const out: Json = {};
  for (const k of ["system", "code", "display", "value", "unit", "frequency", "period", "periodUnit", "start", "end", "family", "given", "text", "use"]) if (k in v) out[k] = v[k];
  return Object.keys(out).length ? out : v;
}

function convertible(n: number, from: string | null, to: string | null, target: number): boolean {
  if (from === null || to === null) return false;
  const k = CONVERT.get(`${from}|${to}`);
  if (k === undefined) return false;
  const c = n * k;
  return Math.abs(c - target) <= Math.max(1e-9, Math.abs(target) * 1e-6);
}

function nameMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  // a containment only when the shorter one is most of the longer one (高血壓 ⊂ 原發性高血壓; never a 1-character overlap)
  return s.length >= 2 && l.includes(s) && s.length * 2 >= l.length;
}

export interface MatchContext {
  /** Terminology names by `system|code` (TermRecord names): synonyms / Chinese designations of codings. */
  codeNames: ReadonlyMap<string, readonly string[]>;
}

/**
 * Where a fact value appears among the nodes (each structured node at most once). Multi-number values (120/80 mmHg)
 * need every number.
 */
export function findValue(nodes: readonly Node[], value: unknown, ctx: MatchContext): FoundAt[] {
  const r = readValue(value);
  if (!r.raw) return [];
  const out: FoundAt[] = [];
  const push = (n: Node, how: string): void => {
    if (!out.some((f) => f.pointer === n.pointer)) out.push({ pointer: n.pointer, path: n.path, value: shown(n.value), how });
  };
  const numberHits: Array<FoundAt[]> = r.numbers.map(() => []);
  const unit = r.numbers.length || r.dates.length ? null : unitOnly(r.raw);
  for (const n of nodes) {
    const v = n.value;
    // dates
    if (r.dates.length && typeof v === "string" && RE_ISO.test(v)) {
      const f = parseFhirDatetime(v);
      if (f) {
        for (const d of r.dates) {
          if (f.y !== d.y) continue;
          if (d.p !== "year" && f.m !== d.m) continue;
          if (d.p === "day" && f.d !== d.d) continue;
          push(n, /^\d{4}-/u.test(r.raw) ? "date" : "date (ROC / Gregorian spelling)");
        }
      }
    }
    if (isCoding(n)) {
      const c = v as Json;
      const names = [String(c.display ?? ""), ...(ctx.codeNames.get(`${c.system ?? "None"}|${c.code}`) ?? [])].filter(Boolean);
      if (r.routes.size) {
        const rs = new Set([...routesIn(String(c.code)), ...names.flatMap((x) => [...routesIn(x)])]);
        if ([...r.routes].some((x) => rs.has(x))) push(n, "route code");
      }
      if (r.freq.size && /timing/iu.test(n.path)) {
        const fs = new Set([...freqSignatures(String(c.code)), ...names.flatMap((x) => [...freqSignatures(x)])]);
        if ([...r.freq].some((x) => fs.has(x))) push(n, "timing code");
      }
      if (nfkc(c.code).trim() === nfkc(r.raw) || norm(String(c.code)) === r.key) push(n, "code");
      else if (names.some((x) => nameMatch(norm(x), r.key))) push(n, "coding display / terminology name");
      else if (n.key === "class" && (ENC_CLASS[String(c.code).toLowerCase()] ?? []).some((a) => aliasIn(r.raw, a))) push(n, "encounter class");
      else if (/serviceType|specialty/u.test(n.path) && r.raw.length <= 24) {
        const want = departmentKeysOf(r.raw);
        if (want.length && names.some((x) => departmentKeysOf(x).some((k) => want.includes(k)))) push(n, "department");
      }
      continue;
    }
    if (r.freq.size && isObj(v) && isObj(v.repeat)) {
      const pd = perDay(v.repeat);
      if (pd !== null && [...r.freq].some((x) => typeof x === "number" && Math.abs(x - pd) < 1e-6)) push(n, "timing repeat");
    }
    if (isQuantity(v)) {
      // value and unit compared separately; the record unit against the UCUM code AND the human unit (次/分 ↔ /min)
      const qv = Number(v.value);
      const units = [...new Set([canonUnit(v.code ?? null), canonUnit(v.unit ?? null)].filter((u): u is string => u !== null))];
      r.numbers.forEach((x, i) => {
        const hit = sameNumber(x.value, qv) && (x.unit === null || !units.length || units.some((u) => unitsCompatible(x.unit, u)));
        const conv = hit ? undefined : units.find((u) => convertible(x.value, x.unit, u, qv));
        if (hit || conv) numberHits[i].push({ pointer: n.pointer, path: n.path, value: shown(v), how: hit ? "quantity" : `unit conversion (${x.unit} → ${conv})` });
      });
      if (unit && units.some((u) => unitsCompatible(unit, u))) push(n, "quantity unit");
      continue;
    }
    if (typeof v === "number" && n.key !== "value" && !COUNT_KEYS.has(n.key)) {
      r.numbers.forEach((x, i) => {
        if (x.unit === null && sameNumber(x.value, v)) numberHits[i].push({ pointer: n.pointer, path: n.path, value: v, how: "number" });
      });
    }
    if (isObj(v) && (Array.isArray(v.given) || typeof v.family === "string")) {
      const given = Array.isArray(v.given) ? v.given.join("") : "";
      const fam = typeof v.family === "string" ? v.family : "";
      if ([fam + given, given + fam].some((s) => s && norm(s) === r.key)) push(n, "name (family + given)");
    }
    if (typeof v === "boolean" && r.bool !== null && v === r.bool && n.key !== "active") push(n, "boolean");
    // parts of a Coding / Quantity are matched through the whole datatype above
    if (typeof v === "string" && n.parent && (isCodingObj(n.parent) || isQuantity(n.parent)) && PART_KEYS.has(n.key)) continue;
    if (typeof v === "string") {
      const parent = n.parent ?? {};
      if (n.key === "gender" && r.genders.size === 1 && r.genders.has(v)) push(n, "administrative gender");
      else if (!RE_ISO.test(v) && norm(v) === r.key && r.key) push(n, n.key === "value" ? "identifier / value" : n.key === "text" && "coding" in parent ? "coded concept text" : "equal");
      else if (n.key === "value" && /^(?:phone|fax|sms|pager)$/u.test(String(parent.system ?? "")) && digits(v).length >= 6 && digits(v) === digits(r.raw)) push(n, "telecom (digits)");
      else if (PHRASE_KEYS.has(n.key) && !RE_ISO.test(v) && r.key.length >= 4 && !r.numbers.length && !r.dates.length && norm(v).includes(r.key)) push(n, "phrase element contains the value");
      else if ((n.key === "valueString" || n.key === "conclusion") && r.numbers.length) {
        // a measurement written as a string (valueString "82 /min"): every number with a compatible unit
        const got = numbersWithUnits(v);
        r.numbers.forEach((x, i) => {
          if (got.some(([, gv, gu]) => sameNumber(x.value, gv) && (x.unit === null || gu === null || unitsCompatible(x.unit, gu)))) numberHits[i].push({ pointer: n.pointer, path: n.path, value: v, how: "number in a string element" });
        });
      }
    }
  }
  if (r.numbers.length && numberHits.every((h) => h.length)) {
    for (const h of numberHits) for (const f of h) if (!out.some((o) => o.pointer === f.pointer)) out.push(f);
  }
  return out;
}
