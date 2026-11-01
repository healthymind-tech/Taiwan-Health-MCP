/**
 * Raw-text FHIR JSON reader with validator_cli's syntax diagnostics (parity v3, area json-xhtml).
 *
 * Port of the HL7 Java JSON stack validator_cli 7.0.1 uses for a JSON instance:
 *  - org.hl7.fhir.utilities.json.parser.JsonLexer / JsonParser in "JSON5" mode (parseObject(source, true, true)):
 *    accepts `//` comments, unquoted names / values, missing commas and trailing commas, duplicate names, and marks
 *    each deviation on the object model; anything else is a fatal IOException
 *    "Error parsing JSON source: … at Line n (path=[…])";
 *  - the syntax checks of org.hl7.fhir.r5.elementmodel.JsonParser that read those marks: JSON_COMMENTS_NOT_ALLOWED
 *    (checkComments), JSON_PROPERTY_NO_QUOTES / JSON_COMMA_MISSING (processChildren), JSON_COMMA_EXTRA (parseChildren
 *    / parseChildComplex / parseChildPrimitive), JSON_PROPERTY_VALUE_NO_QUOTES (parseChildPrimitive),
 *    DUPLICATE_JSON_PROPERTY_KEY (checkNotProcessed), and ERROR_PARSING_JSON_ for a fatal lexer / parser error.
 *
 * The element model walk of the Java parser is driven by the StructureDefinition; this module walks the JSON alone,
 * so it reports each mark at the path the Java walk would use and tags the marks Java only reports for a property it
 * recognises (value / comment marks) with that property, so the caller can drop them for properties the structural
 * pass reported as unrecognised (Java never walks those). The structural checks themselves (unknown properties, JSON
 * types, empty arrays / objects) stay in InstanceValidator, which runs on toPlain()'s value — the JSON value Java's
 * element model holds: the first of duplicated names, numbers as numbers, unquoted tokens as strings.
 */

import { setNumberText } from "./fhirJsonLiterals.js";

export interface JsonLoc {
  line: number;
  col: number;
}

interface Base {
  start: JsonLoc;
  end: JsonLoc | null;
  comments: JsonLoc[];
}
export interface JObject extends Base {
  kind: "object";
  props: JProp[];
  extraComma: boolean;
}
export interface JArray extends Base {
  kind: "array";
  items: JNode[];
  noCommas: boolean[];
  unquoted: boolean[];
  extraComma: boolean;
}
export interface JPrim extends Base {
  kind: "string" | "number" | "boolean" | "null";
  value: string;
}
export type JNode = JObject | JArray | JPrim;
export interface JProp {
  name: string;
  value: JNode;
  noComma: boolean;
  unquotedName: boolean;
  unquotedValue: boolean;
}

/** JsonLocationData. */
class Location {
  lastCol: number;
  constructor(
    public line: number,
    public col: number,
  ) {
    this.lastCol = col;
  }
  newLine(): void {
    this.line++;
    this.lastCol = this.col;
    this.col = 1;
  }
  incCol(): void {
    this.col++;
  }
  copy(): Location {
    return new Location(this.line, this.col);
  }
  prev(): Location {
    return this.col === 1 ? new Location(this.line - 1, this.lastCol) : new Location(this.line, this.col - 1);
  }
  back(): void {
    if (this.col === 1) {
      this.line--;
      this.col = this.lastCol;
    } else this.col--;
  }
}

type Tok = "Open" | "Close" | "String" | "Number" | "Colon" | "Comma" | "OpenArray" | "CloseArray" | "Eof" | "Null" | "Boolean";
const isValueType = (t: Tok): boolean => t === "Open" || t === "String" || t === "Number" || t === "OpenArray" || t === "Boolean" || t === "Null";
const isAlpha = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

export class JsonSyntaxError extends Error {}

interface State {
  name: string;
  isProp: boolean;
}

/** org.hl7.fhir.utilities.json.parser.JsonLexer (allowComments = allowUnquotedStrings = true). */
class Lexer {
  private cursor = -1;
  private peek: string[] = [];
  value: string | null = null;
  type: Tok | null = null;
  readonly states: State[] = [];
  lastLocationAWS: Location = new Location(1, 1);
  location: Location;
  private comments: JsonLoc[] = [];
  unquoted = false;
  private readonly parenthesis: string[] = [];

  constructor(
    private readonly source: string,
    private readonly allowComments: boolean,
    private readonly allowUnquotedStrings: boolean,
  ) {
    this.location = new Location(1, 1);
    this.next();
  }

  private more(): boolean {
    return this.peek.length > 0 || this.cursor < this.source.length;
  }

  private getNext(length: number): string {
    let result = "";
    while (result.length < length && this.peek.length > 0) result += this.peek.pop();
    if (result.length < length) {
      const len = length - result.length;
      if (this.cursor > this.source.length - len) throw this.error("Attempt to read past end of source");
      result += this.source.substring(this.cursor + 1, this.cursor + len + 1);
      this.cursor += len;
    }
    for (const c of result) {
      if (c === "\n") this.location.newLine();
      else this.location.incCol();
    }
    return result;
  }

  private getNextChar(): string {
    let ch: string;
    if (this.peek.length > 0) ch = this.peek.pop()!;
    else {
      this.cursor++;
      ch = this.cursor >= this.source.length ? "\0" : this.source.charAt(this.cursor);
    }
    if (ch === "\n") this.location.newLine();
    else this.location.incCol();
    return ch;
  }

  private push(ch: string): void {
    this.peek.push(ch);
    this.location.back();
  }

  error(msg: string): JsonSyntaxError {
    return new JsonSyntaxError(`Error parsing JSON source: ${msg} at Line ${this.location.line} (path=[${this.path()}])`);
  }

  private path(): string {
    if (!this.states.length) return String(this.value);
    let r = "";
    for (const s of this.states) r += "/" + s.name;
    return r + String(this.value);
  }

  next(): void {
    let ch: string;
    do {
      ch = this.getNextChar();
      if (this.allowComments && ch === "/") {
        const start = this.location.prev();
        const ch1 = this.getNextChar();
        if (ch1 === "/") {
          while (this.more() && ch !== "\r" && ch !== "\n") ch = this.getNextChar();
          this.comments.push({ line: start.line, col: start.col });
        } else this.push(ch1);
      }
    } while (this.more() && (ch === " " || ch === "\r" || ch === "\n" || ch === "\t"));
    this.lastLocationAWS = this.location.copy().prev();
    this.unquoted = false;
    if (!this.more()) {
      this.type = "Eof";
      if (this.parenthesis.length) throw this.error(`One or more parenthesis were not closed: [${this.parenthesis.join(", ")}]`);
      return;
    }
    switch (ch) {
      case "{":
        this.type = "Open";
        this.parenthesis.push("{");
        break;
      case "}": {
        if (!this.parenthesis.length) throw this.error("Unexpected close marker '}' at end of JSON");
        if (this.parenthesis.pop() !== "{") throw this.error("Unexpected close marker '}'. Expected ']'");
        this.type = "Close";
        break;
      }
      case '"': {
        this.type = "String";
        let b = "";
        do {
          ch = this.getNextChar();
          if (ch === "\\") {
            ch = this.getNextChar();
            switch (ch) {
              case '"':
                b += '"';
                break;
              case "'":
                b += "'";
                break;
              case "\\":
                b += "\\";
                break;
              case "/":
                b += "/";
                break;
              case "n":
                b += "\n";
                break;
              case "r":
                b += "\r";
                break;
              case "t":
                b += "\t";
                break;
              case "u": {
                const hex = this.getNext(4);
                const code = /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : NaN;
                // Java Integer.parseInt throws NumberFormatException (not an IOException): the elementmodel catch logs
                // its message as the parse error
                if (Number.isNaN(code)) throw new JsonSyntaxError(`For input string: "${hex}"`);
                b += String.fromCharCode(code);
                break;
              }
              default:
                throw this.error(`unknown escape sequence: \\${ch}`);
            }
            ch = " ";
          } else if (ch !== '"') b += ch;
        } while (this.more() && ch !== '"');
        if (!this.more()) throw this.error("Unclosed string");
        this.value = b;
        break;
      }
      case ":":
        this.type = "Colon";
        break;
      case ",":
        this.type = "Comma";
        break;
      case "[":
        this.parenthesis.push("[");
        this.type = "OpenArray";
        break;
      case "]": {
        if (!this.parenthesis.length) throw this.error("Unexpected close marker ']' at end of JSON");
        if (this.parenthesis.pop() !== "[") throw this.error("Unexpected close marker ']'. Expected '}'");
        this.type = "CloseArray";
        break;
      }
      default:
        if (isDigit(ch) || ch === "-") {
          this.type = "Number";
          let b = "";
          // (sic) Java: `while (more() && (digit || '-' || '.') || ch == '+' || ch == 'e' || ch == 'E')`
          while ((this.more() && (isDigit(ch) || ch === "-" || ch === ".")) || ch === "+" || ch === "e" || ch === "E") {
            b += ch;
            ch = this.getNextChar();
          }
          this.value = b;
          this.push(ch);
        } else if (isAlpha(ch) || ch === "_") {
          this.type = "String";
          this.unquoted = true;
          let b = "";
          while (this.more() && (isAlpha(ch) || isDigit(ch) || ch === "_" || ch === "." || ch === "-")) {
            b += ch;
            ch = this.getNextChar();
          }
          this.value = b;
          this.push(ch);
          if (b === "true" || b === "false") {
            this.type = "Boolean";
            this.unquoted = false;
          } else if (b === "null") {
            this.type = "Null";
            this.unquoted = false;
          } else if (!this.allowUnquotedStrings) throw this.error(`Unexpected content '${b}' in json format`);
        } else throw this.error(`Unexpected content '${ch}' in json format`);
    }
  }

  tok(): Tok | null {
    return this.type;
  }

  consume(type: Tok): string | null {
    if (this.type !== type) throw this.error(`JSON syntax error - found ${this.type} expecting ${type}`);
    const r = this.value;
    this.next();
    return r;
  }

  takeComments(child: Base): void {
    if (this.comments.length) {
      child.comments.push(...this.comments);
      this.comments = [];
    }
  }
}

type ItemType = "Object" | "String" | "Number" | "Boolean" | "Array" | "End" | "Eof" | "Null";
const MAX_JSON_DEPTH = 500;

const loc = (l: Location): JsonLoc => ({ line: l.line, col: l.col });

/** org.hl7.fhir.utilities.json.parser.JsonParser.parseJsonObject(source, isJson5 = true, allowDuplicates = true). */
class Parser {
  private lexer!: Lexer;
  private itemType: ItemType = "Object";
  private itemName: string | null = null;
  private itemValue: string | null = null;
  private startProperty: Location | null = null;
  private endProperty: Location | null = null;
  private itemNoComma = false;
  private itemUnquoted = false;
  private valueUnquoted = false;
  private depth = 0;
  /** (not narrowed by TS: lexer / parser state changes inside called methods) */
  private item(): ItemType {
    return this.itemType;
  }
  private readonly allowNoComma = true;

  parseSource(source: string): JObject {
    this.lexer = new Lexer(source.replace(/﻿/g, ""), true, true);
    const result: JObject = { kind: "object", props: [], extraComma: false, start: { line: 1, col: 1 }, end: null, comments: [] };
    this.lexer.takeComments(result);
    result.start = loc(this.lexer.lastLocationAWS);
    if (this.lexer.tok() === "Open") {
      this.lexer.next();
      this.lexer.states.push({ name: "", isProp: true });
    } else if (this.lexer.tok() !== null) throw this.lexer.error(`Unexpected content at start of JSON: ${this.lexer.tok()}`);
    else throw this.lexer.error("Unexpected content at start of JSON");
    if (this.lexer.tok() !== "Close") {
      this.parseProperty();
      this.readObject("$", result, true);
      result.end = loc(this.endProperty ?? this.lexer.location);
    } else {
      result.end = loc(this.endProperty ?? this.lexer.location);
      this.lexer.next();
    }
    if (this.lexer.tok() !== "Eof") throw this.lexer.error(`Unexpected content at end of JSON: ${this.lexer.tok()}`);
    return result;
  }

  private prim(kind: JPrim["kind"]): JPrim {
    return { kind, value: String(this.itemValue), start: loc(this.startProperty!), end: null, comments: [] };
  }

  private readObject(path: string, obj: JObject, root: boolean): void {
    this.depth++;
    try {
      if (this.depth > MAX_JSON_DEPTH) throw this.lexer.error(`Exceeded maximum JSON nesting depth of ${MAX_JSON_DEPTH}`);
      while (!(this.item() === "End") || (root && this.item() === "Eof")) {
        obj.extraComma = false;
        const add = (v: JNode): void => {
          obj.props.push({ name: String(this.itemName), value: v, noComma: this.itemNoComma, unquotedName: this.itemUnquoted, unquotedValue: this.valueUnquoted });
        };
        switch (this.item()) {
          case "Object": {
            const child: JObject = { kind: "object", props: [], extraComma: false, start: loc(this.startProperty!), end: null, comments: [] };
            this.lexer.takeComments(child);
            add(child);
            this.next();
            this.readObject(`${path}.${this.itemName}`, child, false);
            child.end = loc(this.endProperty!);
            break;
          }
          case "Boolean":
          case "String":
          case "Number":
          case "Null": {
            const c = this.prim(this.item() === "Boolean" ? "boolean" : this.item() === "String" ? "string" : this.item() === "Number" ? "number" : "null");
            this.lexer.takeComments(c);
            add(c);
            c.end = loc(this.endProperty!);
            break;
          }
          case "Array": {
            const childA: JArray = { kind: "array", items: [], noCommas: [], unquoted: [], extraComma: false, start: loc(this.startProperty!), end: null, comments: [] };
            this.lexer.takeComments(childA);
            add(childA);
            this.next();
            if (!this.readArray(`${path}.${this.itemName}`, childA, false)) this.next(true);
            if (!childA.end) childA.end = loc(this.endProperty!);
            break;
          }
          case "Eof":
            throw this.lexer.error("Unexpected End of File");
          case "End":
            throw this.lexer.error("Unexpected End");
        }
        this.itemNoComma = false;
        this.endProperty = this.lexer.location.copy();
        obj.extraComma = this.lexer.tok() === "Comma";
        this.next();
      }
    } finally {
      this.depth--;
    }
  }

  private readArray(path: string, arr: JArray, root: boolean): boolean {
    this.depth++;
    try {
      if (this.depth > MAX_JSON_DEPTH) throw this.lexer.error(`Exceeded maximum JSON nesting depth of ${MAX_JSON_DEPTH}`);
      let res = false;
      while (!(this.item() === "End" || (root && this.item() === "Eof"))) {
        res = true;
        arr.extraComma = false;
        const add = (v: JNode): void => {
          arr.items.push(v);
          arr.noCommas.push(this.itemNoComma);
          arr.unquoted.push(this.valueUnquoted);
        };
        switch (this.item()) {
          case "Object": {
            const o: JObject = { kind: "object", props: [], extraComma: false, start: loc(this.startProperty!), end: null, comments: [] };
            this.lexer.takeComments(o);
            add(o);
            this.next();
            this.readObject(`${path}[${arr.items.length - 1}]`, o, false);
            o.end = loc(this.endProperty!);
            break;
          }
          case "String":
          case "Number":
          case "Boolean":
          case "Null": {
            const c = this.prim(this.item() === "Boolean" ? "boolean" : this.item() === "String" ? "string" : this.item() === "Number" ? "number" : "null");
            this.lexer.takeComments(c);
            add(c);
            c.end = loc(this.endProperty!);
            break;
          }
          case "Array": {
            const child: JArray = { kind: "array", items: [], noCommas: [], unquoted: [], extraComma: false, start: loc(this.startProperty!), end: null, comments: [] };
            this.lexer.takeComments(child);
            add(child);
            this.next();
            this.readArray(`${path}[${arr.items.length - 1}]`, child, false);
            child.end = loc(this.endProperty!);
            break;
          }
          case "Eof":
            throw this.lexer.error("Unexpected End of File");
          case "End":
            throw this.lexer.error("Can't get here");
        }
        this.itemNoComma = false;
        arr.end = loc(this.lexer.location);
        arr.extraComma = this.lexer.tok() === "Comma";
        this.next();
      }
      return res;
    } finally {
      this.depth--;
    }
  }

  private next(noPop = false): void {
    const lx = this.lexer;
    switch (this.item()) {
      case "Object":
        lx.consume("Open");
        lx.states.push({ name: String(this.itemName), isProp: true });
        if (lx.tok() === "Close") {
          this.itemType = "End";
          lx.next();
        } else this.parseProperty();
        break;
      case "Null":
      case "String":
      case "Number":
      case "End":
      case "Boolean":
        if (this.item() === "End" && !noPop) lx.states.pop();
        if (lx.tok() === "Comma") {
          lx.next();
          if (this.allowNoComma && (lx.tok() === "CloseArray" || lx.tok() === "Close")) {
            this.itemType = "End";
            lx.next();
          } else this.parseProperty();
        } else if (lx.tok() === "Close" || lx.tok() === "CloseArray") {
          this.itemType = "End";
          lx.next();
        } else if (lx.tok() === "Eof") {
          this.itemType = "Eof";
        } else if (this.allowNoComma && (lx.tok() === "String" || (!lx.states[lx.states.length - 1]?.isProp && isValueType(lx.tok()!)))) {
          this.itemNoComma = true;
          this.parseProperty();
        } else throw lx.error("Unexpected JSON syntax");
        break;
      case "Array":
        lx.next();
        lx.states.push({ name: `${this.itemName}[]`, isProp: false });
        this.parseProperty();
        break;
      case "Eof":
        throw lx.error("JSON Syntax Error - attempt to read past end of json stream");
      default:
        throw lx.error(`not done yet (a): ${this.itemType}`);
    }
  }

  private parseProperty(): void {
    const lx = this.lexer;
    if (lx.states[lx.states.length - 1]?.isProp) {
      this.itemUnquoted = lx.unquoted;
      this.itemName = lx.consume("String");
      this.itemValue = null;
      lx.consume("Colon");
    }
    this.startProperty = lx.lastLocationAWS.copy();
    this.endProperty = lx.location.copy();
    this.valueUnquoted = lx.unquoted;
    switch (lx.tok()) {
      case "Null":
        this.itemType = "Null";
        this.itemValue = lx.value;
        lx.next();
        break;
      case "String":
        this.itemType = "String";
        this.itemValue = lx.value;
        lx.next();
        break;
      case "Boolean":
        this.itemType = "Boolean";
        this.itemValue = lx.value;
        lx.next();
        break;
      case "Number":
        this.itemType = "Number";
        this.itemValue = lx.value;
        lx.next();
        break;
      case "Open":
        this.itemType = "Object";
        break;
      case "OpenArray":
        this.itemType = "Array";
        break;
      case "CloseArray":
        this.itemType = "End";
        break;
      default:
        throw lx.error(`not done yet (b): ${lx.tok()}`);
    }
  }
}

/** Parses JSON text the way validator_cli does; throws JsonSyntaxError with Java's message on a fatal error. */
export function parseFhirJsonText(source: string): JObject {
  return new Parser().parseSource(source);
}

/** The JSON value the Java element model holds: first of duplicated names, numbers as JS numbers. */
export function toPlain(n: JNode): unknown {
  switch (n.kind) {
    case "object": {
      const o: Record<string, unknown> = {};
      for (const p of n.props) {
        if (Object.prototype.hasOwnProperty.call(o, p.name)) continue;
        o[p.name] = toPlain(p.value);
        if (p.value.kind === "number" && typeof o[p.name] === "number") setNumberText(o, p.name, p.value.value, o[p.name] as number);
      }
      return o;
    }
    case "array": {
      const a = n.items.map(toPlain);
      n.items.forEach((x, i) => {
        if (x.kind === "number" && typeof a[i] === "number") setNumberText(a, i, x.value, a[i] as number);
      });
      return a;
    }
    case "string":
      return n.value;
    case "boolean":
      return n.value === "true";
    case "null":
      return null;
    case "number": {
      const v = Number(n.value);
      return Number.isNaN(v) ? n.value : v;
    }
  }
}

export interface JsonSyntaxIssue {
  severity: "error" | "fatal";
  path: string;
  code: "invalid";
  message: string;
  line?: number;
  col?: number;
  messageId: string;
  /**
   * The object path + property name this mark belongs to when Java only reports it for a property its element model
   * recognises (value / comment marks); null for marks reported for every property (names, commas, object marks).
   */
  owner: { path: string; name: string } | null;
}

const msg = {
  comments: "Comments are not allowed in JSON",
  noQuotes: (n: string): string => `The JSON property '${n}' has no quotes around the name of the property`,
  valueNoQuotes: (n: string, v: string): string => `The JSON property '${n}' has no quotes around the value of the property '${v}'`,
  commaMissing: "A Comma is missing in the JSON",
  commaExtra: (what: "Object" | "Array"): string => `There is an extra comma at the end of the ${what} in the JSON`,
  duplicate: (n: string): string => `The JSON property '${n}' is a duplicate and will be ignored`,
};

/**
 * The elementmodel JsonParser's syntax issues for a parsed instance, without structure: `rootPath` is the resource
 * type (sd.getTypeTail()). Contained / nested resources (an object with a string resourceType inside a property) are
 * walked as resources: their resourceType property is skipped like Java's checkNotProcessed(hasResourceType).
 */
export function jsonSyntaxIssues(root: JObject, rootPath: string, allowComments = false): JsonSyntaxIssue[] {
  const out: JsonSyntaxIssue[] = [];
  const add = (path: string, message: string, messageId: string, at: JsonLoc | null, owner: JsonSyntaxIssue["owner"]): void => {
    out.push({ severity: "error", path, code: "invalid", message, messageId, line: at?.line, col: at?.col, owner });
  };
  const comments = (n: JNode | null, path: string, owner: JsonSyntaxIssue["owner"]): void => {
    if (allowComments) return;
    for (const c of n?.comments ?? []) add(path, msg.comments, "JSON_COMMENTS_NOT_ALLOWED", c, owner);
  };
  const isResource = (o: JObject): boolean => o.props.some((p) => p.name === "resourceType" && p.value.kind === "string");

  // parseChildren(path, object) after checkObject(object, path)
  const walkObject = (obj: JObject, path: string, hasResourceType: boolean): void => {
    // processChildren
    for (const p of obj.props) {
      if (p.unquotedName) add(path, msg.noQuotes(p.name), "JSON_PROPERTY_NO_QUOTES", p.value.start, null);
      if (p.noComma) add(path, msg.commaMissing, "JSON_COMMA_MISSING", p.value.start, null);
    }
    const seen = new Set<string>();
    const props = obj.props.filter((p) => {
      if (hasResourceType && (p.name === "resourceType" || p.name === "resourceDefinition")) return false;
      if (seen.has(p.name)) {
        // checkNotProcessed: a second property of a processed name
        add(path, msg.duplicate(p.name), "DUPLICATE_JSON_PROPERTY_KEY", p.value.start, { path, name: p.name });
        return false;
      }
      seen.add(p.name);
      return true;
    });
    const byName = new Map(props.map((p) => [p.name, p]));
    for (const p of props) {
      if (p.name.startsWith("_") && byName.has(p.name.slice(1))) continue; // handled with its main property
      const name = p.name.startsWith("_") ? p.name.slice(1) : p.name;
      const main = p.name.startsWith("_") ? null : p;
      const fork = byName.get(`_${name}`) ?? (p.name.startsWith("_") ? p : null);
      const owner = { path, name };
      const npath = `${path}.${name}`;
      const v = (main ?? fork)!.value;
      const primitiveLike = (x: JNode | undefined): boolean => !x || x.kind !== "object";
      const isPrimitiveProperty =
        !!fork ||
        (main!.value.kind !== "object" && (main!.value.kind !== "array" || (main!.value as JArray).items.every((i) => i.kind !== "object" && i.kind !== "array")));
      if (isPrimitiveProperty && (main === null || main.value.kind !== "object") && (!fork || fork.value.kind !== "string")) {
        // parseChildPrimitive
        if (main && main.value.kind === "string" && main.unquotedValue) add(path, msg.valueNoQuotes(main.name, main.value.value), "JSON_PROPERTY_VALUE_NO_QUOTES", main.value.start, owner);
        const m = main?.value ?? null;
        const f = fork?.value ?? null;
        if ((m && m.kind === "array") || (f && f.kind === "array")) {
          if (!(m === null || m.kind === "array") || !(f === null || f.kind === "array")) continue;
          const a1 = m as JArray | null;
          const a2 = f as JArray | null;
          if (a1?.extraComma) add(npath, msg.commaExtra("Array"), "JSON_COMMA_EXTRA", a1.end, owner);
          if (a2?.extraComma) add(npath, msg.commaExtra("Array"), "JSON_COMMA_EXTRA", a2.end, owner);
          const len = Math.max(a1?.items.length ?? 0, a2?.items.length ?? 0);
          for (let i = 0; i < len; i++) {
            const mi = a1 && i < a1.items.length && a1.items[i].kind !== "null" ? a1.items[i] : null;
            const fi = a2 && i < a2.items.length && a2.items[i].kind !== "null" ? a2.items[i] : null;
            if (mi && mi.kind === "string" && a1!.unquoted[i]) add(`${path}.${name}[${i}]`, msg.valueNoQuotes("item", mi.value), "JSON_PROPERTY_VALUE_NO_QUOTES", mi.start, owner);
            else if (mi || fi) primitiveInstance(mi, fi, npath, owner);
          }
        } else if (m || f) primitiveInstance(m, f, npath, owner);
        continue;
      }
      if (!main) continue;
      // parseChildComplex
      if (v.kind === "array") {
        if (v.extraComma) add(npath, msg.commaExtra("Array"), "JSON_COMMA_EXTRA", v.end, owner);
        v.items.forEach((item, c) => {
          if (c === 0) comments(v, path, owner); // commentContext = arr, commentPath = path (first item only)
          if (item.kind === "object") {
            comments(item, `${npath}[${c}]`, owner);
            walkObject(item, `${npath}[${c}]`, isResource(item));
          }
        });
      } else if (v.kind === "object") {
        comments(v, npath, owner);
        walkObject(v, npath, isResource(v));
      } else if (v.kind === "null") comments(v, npath, owner);
      void primitiveLike;
    }
    if (obj.extraComma) add(path, msg.commaExtra("Object"), "JSON_COMMA_EXTRA", obj.end, null);
  };

  // parseChildPrimitiveInstance
  const primitiveInstance = (m: JNode | null, f: JNode | null, npath: string, owner: JsonSyntaxIssue["owner"]): void => {
    if (m && !(m.kind === "string" || m.kind === "number" || m.kind === "boolean")) return; // structural pass reports it
    if (f && f.kind !== "object") return;
    if (m) comments(m, npath, owner);
    if (f) {
      comments(f, npath, owner);
      comments(f, npath, owner); // checkObject(child, n, npath) reads the same comments again
      walkObject(f as JObject, npath, false);
    }
  };

  comments(root, rootPath, null);
  walkObject(root, rootPath, true);
  return out;
}

/**
 * Drops the marks Java would not report because its element model never processed the property: the owner was
 * reported "Unrecognized property" by the structural pass (Java's checkNotProcessed), so its value, comments and
 * everything inside it are never walked.
 */
export function dropUnprocessed(syntax: JsonSyntaxIssue[], unrecognised: Array<{ path: string; name: string }>): JsonSyntaxIssue[] {
  if (!unrecognised.length) return syntax;
  const keys = new Set(unrecognised.map((u) => `${u.path}\u0000${u.name}`));
  const prefixes = unrecognised.map((u) => `${u.path}.${u.name}`);
  return syntax.filter((s) => {
    if (s.owner && keys.has(`${s.owner.path}\u0000${s.owner.name}`)) return false;
    return !prefixes.some((p) => s.path === p || s.path.startsWith(p + ".") || s.path.startsWith(p + "["));
  });
}
