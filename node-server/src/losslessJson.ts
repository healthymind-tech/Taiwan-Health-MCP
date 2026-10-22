/**
 * Lossless JSON: a parser that keeps every number's original lexical form, and a
 * serialiser that writes those forms back verbatim.
 *
 * Why: the HTTP layer parses request bodies with JSON.parse before any tool sees them, so
 * `10.0` arrives as 10, `1e3` as 1000, `0.50` as 0.5 and an integer beyond 2^53 rounded.
 * The Bundle tools (fhir_finalize_bundle, fhir_validate_bundle normalize_ids,
 * fhir_build_bundle) hand the caller's Bundle back, and a FHIR decimal's precision is part
 * of its value, so the returned Bundle must carry each number exactly as it was written.
 *
 * Design (see requestContext.ts for where the raw text comes from):
 *  - tool logic keeps running on the ordinary JSON.parse tree — UUIDs, change lists and
 *    validation are computed exactly as before;
 *  - the raw request text is re-parsed here into a parallel tree whose numbers are
 *    RawNumber instances (frozen `{ text }`), key order and structure as in the text;
 *  - restoreNumbers() walks the finished output tree and substitutes each number by the
 *    RawNumber found at the same place in the input tree, but only when that text denotes
 *    the same value — so the result is the same JSON value as the ordinary output, with the
 *    caller's spellings;
 *  - stringifyLossless() serialises with the native JSON.stringify (byte-identical to it for
 *    plain data, key order kept) and splices the raw forms in through placeholders that
 *    RawNumber / RawJson emit from toJSON() only while this function runs. Outside it they
 *    serialise as an ordinary number / the parsed value, so a tree that leaks into a plain
 *    JSON.stringify degrades gracefully instead of printing placeholders.
 *
 * No dependency on the request layer or on FHIR; pure functions apart from the serialiser's
 * synchronous module-level emit flag.
 */

import { randomBytes } from "node:crypto";

// Per-process nonce so a placeholder can never collide with caller data by accident.
const NONCE = randomBytes(6).toString("hex");
const PH_NUMBER = `\u0000${NONCE}N:`;
const PH_JSON = `\u0000${NONCE}J:`;
// JSON.stringify escapes U+0000 as the six characters `\u0000`.
const RE_PH_NUMBER = new RegExp(`"\\\\u0000${NONCE}N:([-+0-9.eE]+)\\\\u0000"`, "g");
const RE_PH_JSON = new RegExp(`"\\\\u0000${NONCE}J:(\\d+)\\\\u0000"`, "g");

let emitting = false;
let rawJsonTexts: string[] = [];

/** A JSON number as written in the source text. Frozen; `valueOf` gives the numeric value. */
export class RawNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
    Object.freeze(this);
  }
  valueOf(): number {
    return Number(this.text);
  }
  toJSON(): unknown {
    return emitting ? `${PH_NUMBER}${this.text}\u0000` : Number(this.text);
  }
}

/** A pre-serialised JSON document to splice verbatim into a larger one (stringifyLossless). */
export class RawJson {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
    Object.freeze(this);
  }
  toJSON(): unknown {
    if (!emitting) return JSON.parse(this.text);
    rawJsonTexts.push(this.text);
    return `${PH_JSON}${rawJsonTexts.length - 1}\u0000`;
  }
}

export function isRawNumber(v: unknown): v is RawNumber {
  return v instanceof RawNumber;
}

// --------------------------------------------------------------------------- //
// Parser
// --------------------------------------------------------------------------- //

const RE_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const RE_WS = /[ \t\n\r]*/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  fail(msg: string): never {
    throw new SyntaxError(`${msg} at position ${this.i}`);
  }

  ws(): void {
    RE_WS.lastIndex = this.i;
    RE_WS.exec(this.s);
    this.i = RE_WS.lastIndex;
  }

  value(): unknown {
    const c = this.s[this.i];
    switch (c) {
      case "{":
        return this.object();
      case "[":
        return this.array();
      case '"':
        return this.string();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default: {
        if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.number();
        return this.fail(c === undefined ? "Unexpected end of JSON input" : `Unexpected token ${c}`);
      }
    }
  }

  literal<T>(word: string, v: T): T {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return v;
    }
    return this.fail(`Unexpected token ${this.s[this.i]}`);
  }

  number(): RawNumber {
    RE_NUMBER.lastIndex = this.i;
    const m = RE_NUMBER.exec(this.s);
    if (!m || m.index !== this.i || !m[0]) return this.fail("Invalid number");
    this.i += m[0].length;
    return new RawNumber(m[0]);
  }

  string(): string {
    const s = this.s;
    let i = this.i + 1;
    let out = "";
    let start = i;
    for (;;) {
      const c = s.charCodeAt(i);
      if (Number.isNaN(c)) return this.fail("Unterminated string");
      if (c === 0x22) {
        out += s.slice(start, i);
        this.i = i + 1;
        return out;
      }
      if (c < 0x20) {
        this.i = i;
        return this.fail("Bad control character in string literal");
      }
      if (c === 0x5c) {
        out += s.slice(start, i);
        const e = s[i + 1];
        if (e === "u") {
          const hex = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.i = i;
            return this.fail("Bad Unicode escape");
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (e !== undefined && e in ESCAPES) {
          out += ESCAPES[e];
          i += 2;
        } else {
          this.i = i;
          return this.fail("Bad escaped character");
        }
        start = i;
        continue;
      }
      i++;
    }
  }

  array(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    this.ws();
    if (this.s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value());
      this.ws();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "]") {
        this.i++;
        return out;
      }
      return this.fail(c === undefined ? "Unexpected end of JSON input" : `Expected ',' or ']' after array element`);
    }
  }

  object(): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') return this.fail("Expected property name");
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ":") return this.fail("Expected ':' after property name");
      this.i++;
      this.ws();
      const v = this.value();
      // JSON.parse semantics: an own data property even for "__proto__"; a repeated key keeps
      // its first position and takes the last value.
      if (key === "__proto__") Object.defineProperty(out, key, { value: v, writable: true, enumerable: true, configurable: true });
      else out[key] = v;
      this.ws();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "}") {
        this.i++;
        return out;
      }
      return this.fail(c === undefined ? "Unexpected end of JSON input" : `Expected ',' or '}' after property value`);
    }
  }
}

/**
 * Parse JSON text like JSON.parse, except that every number becomes a RawNumber holding its
 * exact source text. Throws SyntaxError on invalid input (same inputs JSON.parse rejects).
 */
export function parseLossless(text: string): unknown {
  const p = new Parser(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  p.ws();
  const v = p.value();
  p.ws();
  if (p.i !== p.s.length) p.fail(`Unexpected non-whitespace character after JSON`);
  return v;
}

// --------------------------------------------------------------------------- //
// Restore / convert
// --------------------------------------------------------------------------- //

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof RawNumber) && !(v instanceof RawJson);
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Copy of `out` in which every number that sits at the same place in `source` (a lossless
 * tree) and denotes the same value is replaced by that RawNumber. Everything else — strings,
 * key order, structure, numbers with no counterpart — comes from `out`, so the result is the
 * same JSON value as `out`. Never throws on mismatched shapes; it just keeps `out`'s value.
 */
export function restoreNumbers(out: unknown, source: unknown): unknown {
  if (typeof out === "number") {
    // `===`, not Object.is: -0.0 and 0 are the same JSON value (JSON.stringify writes both as 0).
    return source instanceof RawNumber && Number(source.text) === out ? source : out;
  }
  if (Array.isArray(out)) {
    // A single value the tool wrapped into an array (cardinality coercion): restore from the bare value.
    if (!Array.isArray(source)) return out.length === 1 && source !== undefined ? [restoreNumbers(out[0], source)] : out;
    return out.map((v, i) => restoreNumbers(v, source[i]));
  }
  if (isPlainObject(out)) {
    if (!isPlainObject(source)) return out;
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(out)) {
      const v = restoreNumbers(out[k], hasOwn(source, k) ? source[k] : undefined);
      if (k === "__proto__") Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
      else o[k] = v;
    }
    return o;
  }
  return out;
}

/** The ordinary JSON value of a lossless tree (RawNumber → number), as JSON.parse would give. */
export function toPlain(v: unknown): unknown {
  if (v instanceof RawNumber) return Number(v.text);
  if (v instanceof RawJson) return JSON.parse(v.text);
  if (Array.isArray(v)) return v.map(toPlain);
  if (isPlainObject(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const x = toPlain(v[k]);
      if (k === "__proto__") Object.defineProperty(o, k, { value: x, writable: true, enumerable: true, configurable: true });
      else o[k] = x;
    }
    return o;
  }
  return v;
}

/** Does the tree contain a RawNumber / RawJson anywhere (cheap pre-check before a lossless write)? */
export function hasRaw(v: unknown): boolean {
  if (v instanceof RawNumber || v instanceof RawJson) return true;
  if (Array.isArray(v)) return v.some(hasRaw);
  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) if (hasRaw(v[k])) return true;
  }
  return false;
}

// --------------------------------------------------------------------------- //
// Serialiser
// --------------------------------------------------------------------------- //

/**
 * JSON.stringify(value) with every RawNumber written as its source text and every RawJson
 * spliced in verbatim. Byte-identical to JSON.stringify for a value holding neither.
 */
export function stringifyLossless(value: unknown): string {
  if (emitting) throw new Error("stringifyLossless is not re-entrant");
  emitting = true;
  rawJsonTexts = [];
  let text: string;
  try {
    text = JSON.stringify(value);
  } finally {
    emitting = false;
  }
  const texts = rawJsonTexts;
  rawJsonTexts = [];
  if (text === undefined) return text;
  if (text.indexOf(NONCE) === -1) return text;
  text = text.replace(RE_PH_NUMBER, "$1");
  if (texts.length) text = text.replace(RE_PH_JSON, (_m, idx: string) => texts[Number(idx)] ?? "null");
  return text;
}
