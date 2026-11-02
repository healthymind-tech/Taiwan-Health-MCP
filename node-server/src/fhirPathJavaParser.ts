/**
 * org.hl7.fhir.r5.fhirpath FHIRLexer + FHIRPathEngine.parse (HL7 core 7.0.1): the syntax check of a FHIRPath expression
 * with Java's exception texts ("Error @line, col: …"), used where validator_cli prints them
 * (TEXT_LINK_SELECTOR_INVALID). The expression evaluator stays fhirpath.js (fhirPath.ts); this parser builds the
 * ExpressionNode shape fpe.check needs (fhirPathJavaCheck.ts).
 *
 * The operation and function tables are generated from ExpressionNode.fromCode and FHIRPathEngine.checkParameters.
 */

export class FHIRLexerError extends Error {}

export interface ExprNode {
  kind: "Name" | "Function" | "Constant" | "Group" | "Unary";
  name?: string;
  params: ExprNode[];
  inner?: ExprNode;
  group?: ExprNode;
  /** A constant's Java class: StringType, IntegerType, DecimalType, BooleanType, Quantity, FHIRConstant (null = `{}`). */
  constant?: string | null;
  /** A string constant's value / a `%` or `@` constant's source text. */
  text?: string;
  operation?: string;
  opNext?: ExprNode;
  /** Parsed at the top of an expression (ExpressionNode.proximal): the operator chain starts here. */
  proximal?: boolean;
  /** Column where the node starts (PathEngineException "(@char n)"). */
  startCol?: number;
  /** Column of `operation` (ExpressionNode.getOpStart). */
  opCol?: number;
}

const OPERATIONS = new Set(["=", "~", "!=", "!~", ">", "<", ">=", "<=", "|", "or", "and", "xor", "is", "as", "*", "/", "+", "-", "&", "implies", "div", "mod", "in", "contains", "memberOf"]);

/** name → [min, max, range form]; max null with the range form = unbounded; without it, exactly min. */
const FUNCTIONS = new Map<string, [number, number | null, boolean]>([
  ["empty", [0, null, false]],
  ["not", [0, null, false]],
  ["exists", [0, 1, true]],
  ["subsetOf", [1, null, false]],
  ["supersetOf", [1, null, false]],
  ["isDistinct", [0, null, false]],
  ["distinct", [0, null, false]],
  ["count", [0, null, false]],
  ["where", [1, null, false]],
  ["select", [1, null, false]],
  ["all", [0, 1, true]],
  ["repeat", [1, null, false]],
  ["aggregate", [1, 2, true]],
  ["item", [1, null, false]],
  ["as", [1, null, false]],
  ["is", [1, null, false]],
  ["single", [0, null, false]],
  ["first", [0, null, false]],
  ["last", [0, null, false]],
  ["tail", [0, null, false]],
  ["skip", [1, null, false]],
  ["take", [1, null, false]],
  ["union", [1, null, false]],
  ["combine", [1, null, false]],
  ["intersect", [1, null, false]],
  ["exclude", [1, null, false]],
  ["iif", [2, 3, true]],
  ["lower", [0, null, false]],
  ["upper", [0, null, false]],
  ["toChars", [0, null, false]],
  ["indexOf", [1, null, false]],
  ["substring", [1, 2, true]],
  ["startsWith", [1, null, false]],
  ["endsWith", [1, null, false]],
  ["matches", [1, null, false]],
  ["matchesFull", [1, null, false]],
  ["replaceMatches", [2, null, false]],
  ["contains", [1, null, false]],
  ["replace", [2, null, false]],
  ["length", [0, null, false]],
  ["children", [0, null, false]],
  ["descendants", [0, null, false]],
  ["memberOf", [1, null, false]],
  ["trace", [1, 2, true]],
  ["defineVariable", [1, 2, true]],
  ["check", [2, null, false]],
  ["today", [0, null, false]],
  ["now", [0, null, false]],
  ["resolve", [0, null, false]],
  ["extension", [1, null, false]],
  ["allFalse", [0, null, false]],
  ["anyFalse", [0, null, false]],
  ["allTrue", [0, null, false]],
  ["anyTrue", [0, null, false]],
  ["hasValue", [0, null, false]],
  ["htmlChecks", [0, null, false]],
  ["htmlchecks", [0, null, false]],
  ["htmlChecks2", [0, null, false]],
  ["comparable", [1, null, false]],
  ["encode", [1, null, false]],
  ["decode", [1, null, false]],
  ["escape", [1, null, false]],
  ["unescape", [1, null, false]],
  ["trim", [0, null, false]],
  ["split", [1, null, false]],
  ["join", [0, 1, true]],
  ["ofType", [1, null, false]],
  ["type", [0, null, false]],
  ["toInteger", [0, null, false]],
  ["toDecimal", [0, null, false]],
  ["toString", [0, null, false]],
  ["toQuantity", [0, null, false]],
  ["toBoolean", [0, null, false]],
  ["toDateTime", [0, null, false]],
  ["toTime", [0, null, false]],
  ["convertsToInteger", [0, null, false]],
  ["convertsToDecimal", [0, null, false]],
  ["convertsToString", [0, null, false]],
  ["convertsToQuantity", [0, null, false]],
  ["convertsToBoolean", [0, null, false]],
  ["convertsToDateTime", [0, null, false]],
  ["convertsToDate", [0, null, false]],
  ["convertsToTime", [0, null, false]],
  ["conformsTo", [1, null, false]],
  ["round", [0, 1, true]],
  ["sqrt", [0, null, false]],
  ["abs", [0, null, false]],
  ["ceiling", [0, null, false]],
  ["exp", [0, null, false]],
  ["floor", [0, null, false]],
  ["ln", [0, null, false]],
  ["log", [1, null, false]],
  ["power", [1, null, false]],
  ["truncate", [0, null, false]],
  ["sort", [0, 10, true]],
  ["coalesce", [1, null, true]],
  ["lowBoundary", [0, 1, true]],
  ["highBoundary", [0, 1, true]],
  ["precision", [0, null, false]],
  ["hasTemplateIdOf", [1, null, false]],
  ["debug", [0, 1, true]],
  ["section", [1, 1, true]],
  ["entry", [1, 1, true]],
]);

const noString = (s: string | null | undefined): boolean => s === null || s === undefined || s === "";
const isUWhitespace = (c: number): boolean =>
  c < 0x80 ? c === 0x20 || (c >= 9 && c <= 13) : [0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

class Lexer {
  current: string | null = null;
  cursor = 0;
  currentStart = 0;
  line = 1;
  col = 1;
  startLine = 1;
  startCol = 1;

  constructor(private readonly source: string) {
    this.next();
  }

  location(): string {
    return `${this.line}, ${this.col}`;
  }

  error(msg: string, location = this.location()): FHIRLexerError {
    return new FHIRLexerError(`Error @${location}: ${msg}`);
  }

  done(): boolean {
    return this.currentStart >= this.source.length;
  }

  private checkChar(ch: string, last13: boolean): boolean {
    if (ch === "\r") {
      this.line++;
      this.col = 1;
      return true;
    }
    if (ch === "\n") {
      if (!last13) {
        this.line++;
        this.col = 1;
      }
      return false;
    }
    this.col++;
    return false;
  }

  private skip(): void {
    const s = this.source;
    let last13 = false;
    let done = false;
    while (this.cursor < s.length && !done) {
      if (this.cursor < s.length - 1 && s.startsWith("//", this.cursor)) {
        while (this.cursor < s.length && !(s[this.cursor] === "\r" || s[this.cursor] === "\n")) {
          this.cursor++;
          this.col++;
        }
      } else if (this.cursor < s.length - 1 && s.startsWith("/*", this.cursor)) {
        while (this.cursor < s.length - 1 && !s.startsWith("*/", this.cursor)) {
          last13 = this.checkChar(s[this.cursor], last13);
          this.cursor++;
          this.col++;
        }
        // (sic) `error("Unfinished comment")` is built, not thrown
        if (this.cursor < s.length - 1) {
          this.cursor += 2;
          this.col += 2;
        }
      } else if (isUWhitespace(s.charCodeAt(this.cursor))) {
        last13 = this.checkChar(s[this.cursor], last13);
        this.cursor++;
      } else done = true;
    }
  }

  private isDateChar(ch: string, start: number): boolean {
    const s = this.source;
    const eot = s[start + 1] === "T" ? 10 : 20;
    return ch === "-" || ch === ":" || ch === "T" || ch === "+" || ch === "Z" || /\p{Nd}/u.test(ch) || (this.cursor - start === eot && ch === "." && this.cursor < s.length - 1 && /\p{Nd}/u.test(s[this.cursor + 1]));
  }

  private quoted(q: string): void {
    const s = this.source;
    this.cursor++;
    let escape = false;
    while (this.cursor < s.length && (escape || s[this.cursor] !== q)) {
      if (escape) escape = false;
      else escape = s[this.cursor] === "\\";
      this.cursor++;
    }
    if (this.cursor === s.length) throw this.error("Unterminated string");
    this.cursor++;
    this.current = s.slice(this.currentStart, this.cursor);
  }

  next(): void {
    this.skip();
    const s = this.source;
    this.current = null;
    this.currentStart = this.cursor;
    this.startLine = this.line;
    this.startCol = this.col;
    if (this.cursor < s.length) {
      const ch = s[this.cursor];
      const nameChar = (c: string | undefined): boolean => c !== undefined && (isAlpha(c) || isDigit(c) || c === "_");
      if (ch === "!" || ch === ">" || ch === "<" || ch === ":" || ch === "-" || ch === "=") {
        this.cursor++;
        const c = s[this.cursor];
        if ((this.cursor < s.length && (c === "=" || c === "~" || c === "-")) || (ch === "-" && c === ">")) this.cursor++;
        this.current = s.slice(this.currentStart, this.cursor);
      } else if (ch === ".") {
        this.cursor++;
        if (s[this.cursor] === ".") this.cursor++;
        this.current = s.slice(this.currentStart, this.cursor);
      } else if (isDigit(ch)) {
        this.cursor++;
        let dotted = false;
        while (this.cursor < s.length && (isDigit(s[this.cursor]) || (s[this.cursor] === "." && !dotted))) {
          if (s[this.cursor] === ".") dotted = true;
          this.cursor++;
        }
        if (s[this.cursor - 1] === ".") this.cursor--;
        this.current = s.slice(this.currentStart, this.cursor);
      } else if (isAlpha(ch)) {
        while (nameChar(s[this.cursor])) this.cursor++;
        this.current = s.slice(this.currentStart, this.cursor);
      } else if (ch === "%") {
        this.cursor++;
        if (s[this.cursor] === "`") {
          this.cursor++;
          while (this.cursor < s.length && s[this.cursor] !== "`") this.cursor++;
          this.cursor++;
        } else while (nameChar(s[this.cursor]) || s[this.cursor] === ":" || s[this.cursor] === "-") this.cursor++;
        this.current = s.slice(this.currentStart, this.cursor);
      } else if (ch === "/") {
        this.cursor++;
        if (s[this.cursor] === "/") {
          this.cursor += 2;
          this.current = s.slice(this.currentStart, this.cursor);
        } else this.current = s.slice(this.currentStart, this.cursor);
      } else if (ch === "$") {
        this.cursor++;
        while (this.cursor < s.length && s[this.cursor] >= "a" && s[this.cursor] <= "z") this.cursor++;
        this.current = s.slice(this.currentStart, this.cursor);
      } else if (ch === "{") {
        this.cursor++;
        if (s[this.cursor] === "}") this.cursor++;
        this.current = s.slice(this.currentStart, this.cursor);
      } else if (ch === "`" || ch === "'") {
        this.quoted(ch);
      } else if (ch === "@") {
        const start = this.cursor;
        this.cursor++;
        while (this.cursor < s.length && this.isDateChar(s[this.cursor], start)) this.cursor++;
        this.current = s.slice(this.currentStart, this.cursor);
      } else {
        this.cursor++;
        this.current = s.slice(this.currentStart, this.cursor);
      }
    }
    this.col += this.cursor - this.currentStart;
  }

  take(): string {
    const c = this.current as string;
    this.next();
    return c;
  }

  /** (a method: the token changes inside next(), which TS narrowing does not see) */
  cur(): string | null {
    return this.current;
  }

  setCurrent(v: string): void {
    this.current = v;
  }

  isConstant(): boolean {
    const c = this.current;
    if (noString(c)) return false;
    const f = (c as string)[0];
    return f === "'" || f === '"' || f === "@" || f === "%" || f === "-" || f === "+" || isDigit(f) || c === "true" || c === "false" || c === "{}";
  }

  isStringConstant(): boolean {
    const f = (this.current as string)[0];
    return f === "'" || f === '"' || f === "`";
  }

  isFixedName(): boolean {
    return this.current !== null && this.current[0] === "`";
  }

  isOp(): boolean {
    return this.current !== null && OPERATIONS.has(this.current);
  }

  /** (sic) isToken tests charAt(1) on every round of its loop. */
  isToken(): boolean {
    const c = this.current;
    if (noString(c)) return false;
    const t = c as string;
    if (t.startsWith("$") || t === "*" || t === "**") return true;
    if (!isAlpha(t[0])) return false;
    return t.length === 1 || isAlpha(t[1]) || isDigit(t[1]);
  }
}

const QUANTITY_WORDS = ["year", "years", "month", "months", "week", "weeks", "day", "days", "hour", "hours", "minute", "minutes", "second", "seconds", "millisecond", "milliseconds"];

function processString(lx: Lexer, s: string): void {
  let i = 1;
  while (i < s.length - 1) {
    if (s[i] === "\\") {
      i++;
      const e = s[i];
      if (e === "u") i += 4;
      else if (!"trnf'\"`\\/".includes(e)) throw lx.error(`Unknown FHIRPath character escape \\${e}`);
      i++;
    } else i++;
  }
}

function constant(lx: Lexer): string | null {
  const c = lx.current as string;
  if (lx.isStringConstant()) {
    processString(lx, lx.take());
    return "StringType";
  }
  if (/^-?\d+$/.test(c) && Math.abs(Number(c)) <= 2147483647) {
    lx.take();
    return "IntegerType";
  }
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(c) || /^-?\d+(\.\d+)?$/.test(c)) {
    lx.take();
    return "DecimalType";
  }
  if (c === "true" || c === "false") {
    lx.take();
    return "BooleanType";
  }
  if (c === "{}") {
    lx.take();
    return null;
  }
  if (c.startsWith("%") || c.startsWith("@")) {
    lx.take();
    return "FHIRConstant";
  }
  throw lx.error(`Invalid Constant ${c}`);
}

function checkParameters(lx: Lexer, location: string, node: ExprNode): void {
  const f = FUNCTIONS.get(node.name as string);
  if (!f) return;
  const [lo, hi, range] = f;
  const n = node.params.length;
  if (!range) {
    if (n !== lo) throw lx.error(`The function "${node.name}" requires ${lo} parameters`, location);
  } else if (n < lo || (hi !== null && n > hi)) {
    throw lx.error(`The function "${node.name}" requires between ${lo} and ${hi === null ? 2147483647 : hi} parameters`, location);
  }
}

function parseExpression(lx: Lexer, proximal: boolean): ExprNode {
  const result: ExprNode = { kind: "Name", params: [], startCol: lx.startCol, proximal };
  let wrapper: ExprNode | null = null;
  const start = `${lx.startLine}, ${lx.startCol}`;
  if (lx.cur() === "-" || lx.cur() === "+") {
    wrapper = { kind: "Unary", params: [], operation: lx.take(), proximal, startCol: lx.col };
  }
  if (lx.cur() === null) throw lx.error("Expression terminated unexpectedly");
  if (lx.isConstant()) {
    const isString = lx.isStringConstant();
    if (!isString && ((lx.cur() as string).startsWith("-") || (lx.cur() as string).startsWith("+"))) {
      wrapper = { kind: "Unary", params: [], operation: (lx.cur() as string).slice(0, 1), proximal, startCol: lx.col };
      lx.setCurrent((lx.cur() as string).slice(1));
    }
    const source = lx.cur() as string;
    result.constant = constant(lx);
    result.kind = "Constant";
    if (result.constant === "FHIRConstant") result.text = source;
    else if (result.constant === "StringType") result.text = source.slice(1, -1);
    if (!isString && !lx.done() && (result.constant === "IntegerType" || result.constant === "DecimalType") && (lx.isStringConstant() || QUANTITY_WORDS.includes(lx.cur() as string))) {
      if (QUANTITY_WORDS.includes(lx.cur() as string)) lx.take();
      else {
        if (!lx.isStringConstant()) throw lx.error(`Found ${lx.cur()} expecting "[units]"`);
        processString(lx, lx.take());
      }
      result.constant = "Quantity";
    }
  } else if (lx.cur() === "(") {
    lx.next();
    result.kind = "Group";
    result.group = parseExpression(lx, true);
    if (lx.cur() !== ")") throw lx.error(`Found ${lx.cur()} expecting a ")"`);
    lx.next();
  } else {
    if (!lx.isToken() && !(lx.cur() as string).startsWith("`")) throw lx.error(`Found ${lx.cur()} expecting a token name`);
    result.name = lx.isFixedName() ? lx.take().slice(1, -1) : lx.take();
    if (result.name.startsWith("$") && !["$this", "$total", "$index"].includes(result.name)) throw lx.error(`Found ${result.name} expecting a valid token name`);
    if (lx.cur() === "(") {
      if (!FUNCTIONS.has(result.name)) throw lx.error(`The name ${result.name} is not a known function name`);
      result.kind = "Function";
      lx.next();
      while (lx.cur() !== ")") {
        result.params.push(parseExpression(lx, true));
        if (lx.cur() === ",") lx.next();
        else if (lx.cur() !== ")") throw lx.error(`The token ${lx.cur()} is not expected here - either a "," or a ")" expected`);
      }
      lx.next();
      checkParameters(lx, start, result);
    }
  }
  let focus = result;
  if (lx.cur() === "[") {
    const item: ExprNode = { kind: "Function", name: "item", params: [], startCol: lx.startCol };
    lx.next();
    item.params.push(parseExpression(lx, true));
    // (sic) `!lexer.getCurrent().equals("]")`: at the end of the source that is a NullPointerException, reported as such
    if (lx.cur() === null) throw new FHIRLexerError('Cannot invoke "String.equals(Object)" because the return value of "org.hl7.fhir.services.fhirpath.FHIRLexer.getCurrent()" is null');
    if (lx.cur() !== "]") throw lx.error(`The token ${lx.cur()} is not expected here - a "]" expected`);
    lx.next();
    result.inner = item;
    focus = item;
  }
  if (lx.cur() === ".") {
    lx.next();
    focus.inner = parseExpression(lx, false);
  }
  if (proximal) {
    while (lx.isOp()) {
      focus.operation = lx.cur() as string;
      focus.opCol = lx.startCol;
      lx.next();
      focus.opNext = parseExpression(lx, false);
      focus = focus.opNext;
    }
  }
  if (wrapper) {
    wrapper.opNext = result;
    result.proximal = false;
    return wrapper;
  }
  return result;
}

/** FHIRPathEngine.parse(path). Operators stay a flat opNext chain: organisePrecedence raises no error. */
export function parseFhirPathJava(path: string): ExprNode {
  const lx = new Lexer(path.replace(/\uFEFF/g, ""));
  if (lx.done()) throw lx.error("Path cannot be empty");
  const result = parseExpression(lx, true);
  if (!lx.done()) throw lx.error(`Premature ExpressionNode termination at unexpected token "${lx.cur()}"`);
  return result;
}
