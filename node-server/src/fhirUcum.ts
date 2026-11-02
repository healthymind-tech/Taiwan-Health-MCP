/**
 * UCUM unit-code validation (system `http://unitsofmeasure.org`) for the in-process FHIR validator.
 *
 * The HL7 validator sends UCUM codes to its terminology server; an unparseable code is an error: "Unknown code
 * '<c>' in the CodeSystem 'http://unitsofmeasure.org' version '2.2'". That server parses with the ucum-java grammar
 * (org.fhir.ucum.Lexer + ExpressionParser of ucum-java 1.0.10 — the version hl7-core 7.0.1's pom pins — with
 * ucum-essence 2.2; ported from the 1.0.10 sources), which
 * differs from the NLM ucum-lhc parser this module used before (review G8: `k[in_i]` / `{` / `()` / `m{中}` accepted,
 * `m{a}{b}` / `{a}{b}` / `m//s` / `{a b}` / `M` rejected). This is a port of that grammar:
 *
 *  - Lexer.consume: `/` SOLIDUS, `.` PERIOD, `(` OPEN, `)` CLOSE, `{…}` ANNOTATION (printable ASCII only, must be
 *    terminated; spaces allowed), `+n` / `-n` NUMBER (a sign needs a digit), else a run of symbol characters
 *    [A-Za-z0-9[]%*^'"_] (digits only before the first non-digit or inside `[…]`, `.` only inside `[…]`; no nested `[`,
 *    no `]` without `[`)
 *    — a run of digits is a NUMBER, anything else a SYMBOL; any other character is an error;
 *  - ExpressionParser.parseTerm: `/` term | (ANNOTATION | comp) [(`/` | `.` | ANNOTATION (implicit `.`)) term];
 *    parseComp: NUMBER | SYMBOL [NUMBER exponent] | `(` term `)`; the whole input must be consumed;
 *  - parseSymbol: the first prefix (essence order) that leaves a base unit or a metric unit; else the whole symbol
 *    as a unit; else `1`; else unknown.
 *  - tx.fhir.org quirk (review G8, observed): a symbol that is only a prefix code (`M`) is accepted.
 *
 * Display (review G9): tx.fhir.org's valid displays of a UCUM code are the code itself and its formal structure
 * (FormalStructureComposer: `(milligram)`, `(milligram) / (deciliter)`); `milligram` is accepted too.
 */

import { createRequire } from "node:module";
import { UCUM_PREFIXES, UCUM_UNITS, UCUM_ESSENCE_VERSION } from "./fhirUcumEssence.js";
import { UcumDecimal, UcumException } from "./fhirUcumDecimal.js";

export const UCUM_SYSTEM = "http://unitsofmeasure.org";
export const UCUM_VERSION = UCUM_ESSENCE_VERSION;

export type UcumVerdict = "valid" | "invalid" | "unchecked";

interface UnitDef {
  code: string;
  metric: boolean;
  base: boolean;
  name: string;
  special: boolean;
  valueUnit: string;
  value: string;
}

const UNITS = new Map<string, UnitDef>(
  UCUM_UNITS.map(([code, metric, base, name, special, valueUnit, value]) => [code, { code, metric: metric === 1, base: base === 1, name, special: special === 1, valueUnit, value }]),
);
const PREFIXES = UCUM_PREFIXES.map(([code, name, value]) => ({ code, name, value }));

class UcumError extends Error {}

type Tok = "NONE" | "NUMBER" | "SYMBOL" | "SOLIDUS" | "PERIOD" | "OPEN" | "CLOSE" | "ANNOTATION";

/** Port of org.fhir.ucum.Lexer. */
class Lexer {
  private index = 0;
  token: string | null = null;
  type: Tok = "NONE";

  constructor(private readonly source: string) {
    this.consume();
  }

  private nextChar(): string {
    const ch = this.index < this.source.length ? this.source[this.index] : "\0";
    this.index++;
    return ch;
  }

  private peekChar(): string {
    return this.index < this.source.length ? this.source[this.index] : "\0";
  }

  consume(): void {
    this.token = null;
    this.type = "NONE";
    if (this.index < this.source.length) {
      const ch = this.nextChar();
      if (!(this.single(ch, "/", "SOLIDUS") || this.single(ch, ".", "PERIOD") || this.single(ch, "(", "OPEN") || this.single(ch, ")", "CLOSE") || this.annotation(ch) || this.number(ch) || this.numberOrSymbol(ch))) {
        throw new UcumError(`Error processing unit '${this.source}': unexpected character '${ch}'`);
      }
    }
  }

  private single(ch: string, test: string, type: Tok): boolean {
    if (ch !== test) return false;
    this.token = ch;
    this.type = type;
    return true;
  }

  private annotation(ch: string): boolean {
    if (ch !== "{") return false;
    let b = "";
    while (ch !== "}") {
      ch = this.nextChar();
      const c = ch.charCodeAt(0);
      if (ch === "\0") throw new UcumError(`Error processing unit '${this.source}': unterminated annotation`);
      if (c < 0x20 || c > 0x7e) throw new UcumError(`Error processing unit '${this.source}': Annotation contains non-ascii characters`);
      if (ch !== "}") b += ch;
    }
    this.token = b;
    this.type = "ANNOTATION";
    return true;
  }

  private number(ch: string): boolean {
    if (ch !== "+" && ch !== "-") return false;
    let t = ch;
    let c = this.peekChar();
    while (c >= "0" && c <= "9") {
      t += c;
      this.index++;
      c = this.peekChar();
    }
    if (t.length === 1) throw new UcumError(`Error processing unit '${this.source}': a + or - must be followed by at least one digit`);
    this.token = t;
    this.type = "NUMBER";
    return true;
  }

  /** Lexer.isValidSymbolChar (ucum-java 1.0.10): `.` only inside `[…]`. */
  private static symbolChar(ch: string, allowDigits: boolean, inBrackets: boolean): boolean {
    return (allowDigits && ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch !== "" && "[]%*^'\"_".includes(ch)) || (inBrackets && ch === ".");
  }

  private brackets(ch: string, inBrackets: boolean): boolean {
    if (ch === "[") {
      if (inBrackets) throw new UcumError(`Error processing unit '${this.source}': Nested [`);
      return true;
    }
    if (ch === "]") {
      if (!inBrackets) throw new UcumError(`Error processing unit '${this.source}': ] without [`);
      return false;
    }
    return inBrackets;
  }

  private numberOrSymbol(ch: string): boolean {
    if (!Lexer.symbolChar(ch, true, false)) return false;
    let t = ch;
    let isSymbol = !(ch >= "0" && ch <= "9");
    let inBrackets = this.brackets(ch, false);
    let c = this.peekChar();
    inBrackets = this.brackets(c, inBrackets);
    while (c !== "\0" && Lexer.symbolChar(c, !isSymbol || inBrackets, inBrackets)) {
      t += c;
      isSymbol = isSymbol || !(c >= "0" && c <= "9");
      this.index++;
      c = this.peekChar();
      inBrackets = this.brackets(c, inBrackets);
    }
    this.token = t;
    this.type = isSymbol ? "SYMBOL" : "NUMBER";
    return true;
  }

  tokenAsInt(): number {
    const t = String(this.token);
    const n = Number(t.startsWith("+") ? t.slice(1) : t);
    // Integer.parseInt: a value outside int range throws
    if (!Number.isInteger(n) || n > 2147483647 || n < -2147483648) throw new UcumError(`Error processing unit '${this.source}': number out of range`);
    return n;
  }

  /** The current token type (a method: consume() changes it). */
  cur(): Tok {
    return this.type;
  }

  /** Lexer.finished: `index == source.length()` — the current token may still be unread (e.g. a trailing `)`). */
  finished(): boolean {
    return this.index === this.source.length;
  }
}

type Component = { kind: "factor"; value: number } | { kind: "symbol"; prefix: { code: string; name: string; value: string } | null; unit: UnitDef | null; exponent: number } | { kind: "term"; term: Term };
interface Term {
  comp: Component | null;
  op: "/" | "." | null;
  term: Term | null;
}

/** Port of org.fhir.ucum.ExpressionParser. */
function parseTerm(lexer: Lexer, first: boolean): Term {
  const res: Term = { comp: null, op: null, term: null };
  if (first && lexer.cur() === "NONE") {
    res.comp = { kind: "factor", value: 1 };
  } else if (lexer.cur() === "SOLIDUS") {
    res.op = "/";
    lexer.consume();
    res.term = parseTerm(lexer, false);
  } else {
    if (lexer.cur() === "ANNOTATION") {
      res.comp = { kind: "factor", value: 1 }; // the annotation is lost
      lexer.consume();
    } else res.comp = parseComp(lexer);
    if (lexer.cur() !== "NONE" && lexer.cur() !== "CLOSE") {
      if (lexer.cur() === "SOLIDUS") {
        res.op = "/";
        lexer.consume();
      } else if (lexer.cur() === "PERIOD") {
        res.op = ".";
        lexer.consume();
      } else if (lexer.cur() === "ANNOTATION") res.op = "."; // implicit
      else throw new UcumError("Expected '/' or '.'");
      res.term = parseTerm(lexer, false);
    }
  }
  return res;
}

function parseComp(lexer: Lexer): Component {
  if (lexer.cur() === "NUMBER") {
    const value = lexer.tokenAsInt();
    lexer.consume();
    return { kind: "factor", value };
  }
  if (lexer.cur() === "SYMBOL") return parseSymbol(lexer);
  if (lexer.cur() === "NONE") throw new UcumError("unexpected end of expression looking for a symbol or a number");
  if (lexer.cur() === "OPEN") {
    lexer.consume();
    const term = parseTerm(lexer, true);
    if (lexer.cur() !== "CLOSE") throw new UcumError(`Unexpected Token Type '${lexer.cur()}' looking for a close bracket`);
    lexer.consume();
    return { kind: "term", term };
  }
  throw new UcumError("unexpected token looking for a symbol or a number");
}

function parseSymbol(lexer: Lexer): Component {
  const sym = String(lexer.token);
  let prefix: { code: string; name: string; value: string } | null = null;
  let unit: UnitDef | null = null;
  for (const p of PREFIXES) {
    if (!sym.startsWith(p.code)) continue;
    const u = UNITS.get(sym.slice(p.code.length));
    if (u && (u.base || u.metric)) {
      prefix = p;
      unit = u;
      break;
    }
  }
  if (!prefix) {
    unit = UNITS.get(sym) ?? null;
    // tx.fhir.org accepts a bare prefix code (`M`, review G8) — no unit, no formal structure
    if (!unit && sym !== "1" && !PREFIXES.some((p) => p.code === sym)) throw new UcumError(`The unit '${sym}' is unknown`);
  }
  lexer.consume();
  let exponent = 1;
  if (lexer.cur() === "NUMBER") {
    exponent = lexer.tokenAsInt();
    lexer.consume();
  }
  return { kind: "symbol", prefix, unit, exponent };
}

/** UcumEssenceService.validate → ExpressionParser.parse: the parsed term, or null when the code is not valid UCUM. */
function parse(code: string): Term | null {
  try {
    const lexer = new Lexer(code);
    const t = parseTerm(lexer, true);
    if (!lexer.finished()) return null; // "Expression was not parsed completely. Syntax Error?"
    return t;
  } catch {
    return null;
  }
}

const cache = new Map<string, Term | null>();
const CACHE_MAX = 5000;

function parsed(code: string): Term | null {
  if (cache.has(code)) return cache.get(code)!;
  const t = parse(code);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(code, t);
  return t;
}

/** Is `code` a valid UCUM expression (ucum-java grammar over ucum-essence 2.2)? */
export function checkUcumCode(code: string): UcumVerdict {
  if (typeof code !== "string" || code === "") return "invalid";
  return parsed(code) ? "valid" : "invalid";
}

/**
 * FormalStructureComposer (ucum-java 1.0.10): `(milligram)`, `(meter ^ 2)`, `(milligram) / (deciliter)`, an annotation
 * as the factor `1` (`{a}/d` → `1 / (day)`), a bracketed sub-term unbracketed; null only for the bare-prefix quirk.
 */
function formal(t: Term): string | null {
  let out = "";
  if (t.comp) {
    const c = t.comp;
    if (c.kind === "factor") out += String(c.value);
    else if (c.kind === "term") {
      // composeComp → composeTerm: a bracketed sub-term is written without brackets
      const inner = formal(c.term);
      if (inner === null) return null;
      out += inner;
    } else {
      if (!c.unit) return null; // bare-prefix quirk: no unit name
      out += `(${c.prefix ? c.prefix.name : ""}${c.unit.name}${c.exponent !== 1 ? ` ^ ${c.exponent}` : ""})`;
    }
  }
  if (t.op) out += t.op === "/" ? " / " : " * ";
  if (t.term) {
    const rest = formal(t.term);
    if (rest === null) return null;
    out += rest;
  }
  return out;
}

/** The displays tx.fhir.org accepts for a UCUM code: the code and its formal structure (null: invalid / unknown). */
export function ucumDisplays(code: string): string[] | null {
  const t = checkUcumCode(code) === "valid" ? parsed(code) : null;
  if (!t) return null;
  const f = formal(t);
  return f === null ? null : f === code ? [code] : [code, f];
}

/**
 * The Coding display check for UCUM (review G9): null when `display` is acceptable or cannot be judged, else the
 * tx.fhir.org Display_Name_for__should_be_one_of__instead_of message. Case-insensitive; the formal structure is
 * also accepted without its parentheses (`milligram`).
 */
export function ucumDisplayIssue(code: string, display: string): string | null {
  const valid = ucumDisplays(code);
  if (!valid) return null;
  const norm = (s: string): string => s.replace(/[()]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const want = display.toLowerCase();
  if (valid.some((v) => v.toLowerCase() === want || norm(v) === norm(display))) return null;
  const choices = valid.length === 1 ? `'${valid[0]}'` : `one of ${valid.length} choices: ${valid.map((v) => `'${v}'`).join(", ")}`;
  return `Wrong Display Name '${display}' for ${UCUM_SYSTEM}#${code}. Valid display is ${choices}`;
}

// ------------------------------------------------------------ canonical form (ucum-java 1.0.10)

interface CanonicalUnit {
  base: string;
  exponent: number;
}
interface Canonical {
  value: UcumDecimal;
  units: CanonicalUnit[];
}

/** org.fhir.ucum.special.Registry.init: unit → [units, value, hasOffset]. */
const SPECIAL_HANDLERS: Record<string, [string, () => UcumDecimal, boolean]> = {
  Cel: ["K", () => new UcumDecimal("1"), true],
  "[degF]": ["K", () => new UcumDecimal(5).divide(new UcumDecimal(9)), true],
  "[p'diop]": ["deg", () => new UcumDecimal("1"), false],
  "%[slope]": ["deg", () => new UcumDecimal("1"), false],
  "[hp_X]": ["1", () => new UcumDecimal("1"), false],
  "[hp_C]": ["1", () => new UcumDecimal("1"), false],
  "[pH]": ["mol/l", () => new UcumDecimal("1"), false],
  Np: ["1", () => new UcumDecimal("1"), false],
  B: ["1", () => new UcumDecimal("1"), false],
  "B[SPL]": ["10*-5.Pa", () => new UcumDecimal(2), false],
  "B[V]": ["V", () => new UcumDecimal("1"), false],
  "B[mV]": ["mV", () => new UcumDecimal("1"), false],
  "B[uV]": ["uV", () => new UcumDecimal("1"), false],
  "B[W]": ["W", () => new UcumDecimal("1"), false],
  "B[kW]": ["kW", () => new UcumDecimal("1"), false],
  bit_s: ["1", () => new UcumDecimal("1"), false],
};

const oneCanonical = (): UcumDecimal => new UcumDecimal("1.000000000000000000000000000000");

/** XmlDefinitionsParser.parseValue: a value with a `.` has precision 24. */
function unitValue(v: string): UcumDecimal {
  return v.includes(".") ? new UcumDecimal(v, 24) : new UcumDecimal(v);
}

/** Converter.expandDefinedUnit. */
function expandDefinedUnit(unit: UnitDef): Canonical {
  let u = unit.valueUnit;
  let v: UcumDecimal;
  if (unit.special) {
    const h = SPECIAL_HANDLERS[unit.code];
    if (!h) throw new UcumException("Not handled yet (special unit)");
    u = h[0];
    v = h[1]();
    if (h[2]) throw new UcumException("Not handled yet (special unit with offset from 0 at intersect)");
  } else v = unitValue(unit.value);
  const lexer = new Lexer(u);
  const t = parseTerm(lexer, true);
  if (!lexer.finished()) throw new UcumException("Expression was not parsed completely. Syntax Error?");
  const result = normaliseTerm(t);
  result.value = result.value.multiply(v);
  return result;
}

/** Converter.normalise(Symbol). */
function normaliseSymbol(sym: Extract<Component, { kind: "symbol" }>): Canonical {
  if (!sym.unit) throw new UcumException("no unit"); // the bare prefix is a tx.fhir.org quirk: ucum-java reports it unknown
  const result: Canonical = { value: oneCanonical(), units: [] };
  if (sym.unit.base) result.units.push({ base: sym.unit.code, exponent: sym.exponent });
  else {
    const can = expandDefinedUnit(sym.unit);
    for (const c of can.units) c.exponent = c.exponent * sym.exponent;
    result.units.push(...can.units);
    if (sym.exponent > 0) for (let i = 0; i < sym.exponent; i++) result.value = result.value.multiply(can.value);
    else for (let i = 0; i > sym.exponent; i--) result.value = result.value.divide(can.value);
  }
  if (sym.prefix) {
    const pv = new UcumDecimal(sym.prefix.value, 24);
    if (sym.exponent > 0) for (let i = 0; i < sym.exponent; i++) result.value = result.value.multiply(pv);
    else for (let i = 0; i > sym.exponent; i--) result.value = result.value.divide(pv);
  }
  return result;
}

/** Converter.normalise(Term). */
function normaliseTerm(term: Term): Canonical {
  const result: Canonical = { value: oneCanonical(), units: [] };
  let div = false;
  let t: Term | null = term;
  while (t) {
    const c: Component | null = t.comp;
    if (c?.kind === "factor") {
      const f = new UcumDecimal(c.value);
      result.value = div ? result.value.divide(f) : result.value.multiply(f);
    } else if (c) {
      const temp: Canonical = c.kind === "term" ? normaliseTerm(c.term) : normaliseSymbol(c);
      if (div) {
        result.value = result.value.divide(temp.value);
        for (const u of temp.units) u.exponent = 0 - u.exponent;
      } else result.value = result.value.multiply(temp.value);
      result.units.push(...temp.units);
    }
    div = t.op === "/";
    t = t.term;
  }
  for (let i = result.units.length - 1; i >= 0; i--) {
    const sf = result.units[i];
    for (let j = i - 1; j >= 0; j--) {
      const st = result.units[j];
      if (st.base === sf.base) {
        st.exponent = sf.exponent + st.exponent;
        result.units.splice(i, 1);
        break;
      }
    }
  }
  for (let i = result.units.length - 1; i >= 0; i--) if (result.units[i].exponent === 0) result.units.splice(i, 1);
  result.units.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
  return result;
}

/**
 * UcumEssenceService.getCanonicalForm (l. 268-285) of `value code`: the value (Decimal.asDecimal) and the canonical
 * units (ExpressionComposer.compose(can, false)); null where FHIRPathEngine catches a UcumException (invalid unit, a
 * special unit it cannot convert).
 */
export function ucumCanonicalForm(value: string, code: string): { value: string; code: string } | null {
  try {
    const v = new UcumDecimal(value);
    const lexer = new Lexer(code);
    const term = parseTerm(lexer, true);
    if (!lexer.finished()) return null;
    const c = normaliseTerm(term);
    const p = v.multiply(c.value);
    if (v.isWholeNumber()) p.checkForCouldBeWholeNumber();
    return { value: p.asDecimal(), code: c.units.map((u) => u.base + (u.exponent !== 1 ? String(u.exponent) : "")).join(".") };
  } catch (e) {
    if (e instanceof UcumException || e instanceof UcumError) return null;
    throw e;
  }
}

interface UcumUtils {
  convertUnitTo?(f: string, v: number, t: string): { status: string; toVal?: number };
}

let utils: UcumUtils | null | undefined;

/** NLM ucum-lhc, used for unit conversion only (validation is the ucum-java port above). */
function ucum(): UcumUtils | null {
  if (utils !== undefined) return utils;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@lhncbc/ucum-lhc");
    utils = pkg.UcumLhcUtils.getInstance() as UcumUtils;
  } catch {
    utils = null;
  }
  return utils;
}

/**
 * UcumService.convert (InstanceValidator.convertUcumValue): `value` in unit `from` expressed in unit `to`, or null
 * when the units cannot be converted (either invalid, or not commensurable).
 */
export function convertUcum(value: number, from: string, to: string): number | null {
  const u = ucum();
  if (!u || typeof u.convertUnitTo !== "function") return null;
  try {
    const r = u.convertUnitTo(from, value, to);
    return r && r.status === "succeeded" && typeof r.toVal === "number" && Number.isFinite(r.toVal) ? r.toVal : null;
  } catch {
    return null;
  }
}

export function ucumUnknownCodeMessage(code: string): string {
  return `Unknown code '${code}' in the CodeSystem '${UCUM_SYSTEM}' version '${UCUM_VERSION}'`;
}
