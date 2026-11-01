/**
 * UCUM unit-code validation (system `http://unitsofmeasure.org`) for the in-process FHIR validator.
 *
 * The HL7 validator sends UCUM codes to its terminology server; an unparseable code is an error: "Unknown code
 * '<c>' in the CodeSystem 'http://unitsofmeasure.org' version '2.2'". That server parses with the ucum-java grammar
 * (org.fhir.ucum.Lexer + ExpressionParser, the library validator_cli 7.0.1 bundles with ucum-essence 2.2), which
 * differs from the NLM ucum-lhc parser this module used before (review G8: `k[in_i]` / `{` / `()` / `m{中}` accepted,
 * `m{a}{b}` / `{a}{b}` / `m//s` / `{a b}` / `M` rejected). This is a port of that grammar:
 *
 *  - Lexer.consume: `/` SOLIDUS, `.` PERIOD, `(` OPEN, `)` CLOSE, `{…}` ANNOTATION (printable ASCII only, must be
 *    terminated; spaces allowed), `+n` / `-n` NUMBER (a sign needs a digit), else a run of symbol characters
 *    [A-Za-z0-9[]%*^'"_] (digits only before the first non-digit or inside `[…]`; no nested `[`, no `]` without `[`)
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

import { UCUM_PREFIXES, UCUM_UNITS, UCUM_ESSENCE_VERSION } from "./fhirUcumEssence.js";

export const UCUM_SYSTEM = "http://unitsofmeasure.org";
export const UCUM_VERSION = UCUM_ESSENCE_VERSION;

export type UcumVerdict = "valid" | "invalid" | "unchecked";

interface UnitDef {
  code: string;
  metric: boolean;
  base: boolean;
  name: string;
}

const UNITS = new Map<string, UnitDef>(UCUM_UNITS.map(([code, metric, base, name]) => [code, { code, metric: metric === 1, base: base === 1, name }]));
const PREFIXES = UCUM_PREFIXES.map(([code, name]) => ({ code, name }));

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

  private static symbolChar(ch: string, allowDigits: boolean): boolean {
    return (allowDigits && ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || "[]%*^'\"_".includes(ch) && ch !== "";
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
    if (!Lexer.symbolChar(ch, true)) return false;
    let t = ch;
    let isSymbol = !(ch >= "0" && ch <= "9");
    let inBrackets = this.brackets(ch, false);
    let c = this.peekChar();
    inBrackets = this.brackets(c, inBrackets);
    while (c !== "\0" && Lexer.symbolChar(c, !isSymbol || inBrackets)) {
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

  /** Lexer.finished: the source is used up (the current token may still be unread, e.g. a trailing `)`). */
  /** The current token type (a method: consume() changes it). */
  cur(): Tok {
    return this.type;
  }

  finished(): boolean {
    return this.index >= this.source.length;
  }
}

type Component = { kind: "factor"; value: number } | { kind: "symbol"; prefix: { code: string; name: string } | null; unit: UnitDef | null; exponent: number } | { kind: "term"; term: Term };
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
  let prefix: { code: string; name: string } | null = null;
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

/** FormalStructureComposer: `(milligram)`, `(meter ^ 2)`, `(milligram) / (deciliter)`; null when not composable. */
function formal(t: Term): string | null {
  let out = "";
  if (t.comp) {
    const c = t.comp;
    if (c.kind === "factor") out += String(c.value);
    else if (c.kind === "term") {
      const inner = formal(c.term);
      if (inner === null) return null;
      out += `(${inner})`;
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
  // annotations and empty terms compose to `1` factors / doubled spaces — not something to judge a display by
  if (code.includes("{") || code.includes("//")) return null;
  const valid = ucumDisplays(code);
  if (!valid) return null;
  const norm = (s: string): string => s.replace(/[()]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const want = display.toLowerCase();
  if (valid.some((v) => v.toLowerCase() === want || norm(v) === norm(display))) return null;
  const choices = valid.length === 1 ? `'${valid[0]}'` : `one of ${valid.length} choices: ${valid.map((v) => `'${v}'`).join(", ")}`;
  return `Wrong Display Name '${display}' for ${UCUM_SYSTEM}#${code}. Valid display is ${choices}`;
}

/**
 * UcumService.convert (InstanceValidator.convertUcumValue): `value` in unit `from` expressed in unit `to`, or null
 * when the units cannot be converted (either invalid, or not commensurable).
 */
export function convertUcum(value: number, from: string, to: string): number | null {
  const u = ucum() as (UcumUtils & { convertUnitTo?(f: string, v: number, t: string): { status: string; toVal?: number } }) | null;
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
