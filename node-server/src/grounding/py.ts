/**
 * Small Python-semantics helpers used by the grounding port.
 *
 * The grounding engine is a port of a Python reference implementation whose fixtures are the regression
 * contract. Where Python and JavaScript differ in ways that change results (truthiness of empty containers,
 * Unicode-aware `\w` / `\b` / `str.isalpha`, whitespace sets, half-even rounding, `repr`, `json.dumps`
 * separators, floor division) the engine goes through these helpers instead of the JS built-ins.
 */

/** Python truthiness: None/False/0/""/[]/{} are falsy. */
export function truthy(x: unknown): boolean {
  if (x === null || x === undefined || x === false) return false;
  if (typeof x === "number") return x !== 0 && !Number.isNaN(x);
  if (typeof x === "string") return x.length > 0;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === "object") return Object.keys(x as object).length > 0;
  return true;
}

/** Python `a or b`. */
export function or<T, U>(a: T, b: U): T | U {
  return truthy(a) ? a : b;
}

export type JsonObject = Record<string, unknown>;

/** `isinstance(x, dict)` for parsed JSON. */
export function isDict(x: unknown): x is JsonObject {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Python `==` for JSON scalars (True == 1, False == 0). */
export function pyEq(a: unknown, b: unknown): boolean {
  const num = (v: unknown): number | null => (typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : null);
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return na === nb;
  return a === b;
}

/** Python `float(x)`; NaN where Python would raise. */
export function pyFloat(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x !== "string") return NaN;
  const s = pyStrip(x).replace(/_/g, "");
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  return NaN;
}

// --------------------------------------------------------------------------------------------- characters
/** Python `\w` for str patterns: letters, numbers (all Unicode categories L*, N*) and underscore. */
export const PW = "[\\p{L}\\p{N}_]";
/** Python `\b` (Unicode word boundary) for use inside a `u`-flag RegExp source. */
export const PB = `(?:(?<=${PW})(?!${PW})|(?<!${PW})(?=${PW}))`;

const RE_ALPHA = /^\p{L}+$/u;
const RE_ALNUM = /^[\p{L}\p{N}]+$/u;

/** Python `str.isalpha()` (non-empty, every code point in a letter category). */
export function isAlpha(s: string): boolean {
  return s.length > 0 && RE_ALPHA.test(s);
}

/** Python `str.isalnum()`. */
export function isAlnum(s: string): boolean {
  return s.length > 0 && RE_ALNUM.test(s);
}

/** Python `str.isascii()`. */
export function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(s);
}

/** Python `str.isdigit()` restricted to what can occur here (ASCII + superscripts are not produced by our tokenizers). */
export function isDigitStr(s: string): boolean {
  return s.length > 0 && /^\p{Nd}+$/u.test(s);
}

const PY_SPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python `str.isspace()` for a single code point. */
export function isSpaceCp(cp: number): boolean {
  return PY_SPACE.has(cp);
}

/** Python `str.strip()` (Python's whitespace set, which differs from JS `trim()` on U+FEFF / U+001C-1F / U+0085). */
export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && PY_SPACE.has(s.charCodeAt(a))) a++;
  while (b > a && PY_SPACE.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

export function pyLstrip(s: string): string {
  let a = 0;
  while (a < s.length && PY_SPACE.has(s.charCodeAt(a))) a++;
  return s.slice(a);
}

/** Code-point slice `s[a:b]` (Python indexes code points, JS strings are UTF-16). */
export function cpSlice(s: string, a: number, b?: number): string {
  // Fast path: no surrogates.
  if (!/[\ud800-\udfff]/.test(s)) return s.slice(a, b);
  return Array.from(s).slice(a, b).join("");
}

/** Code-point length `len(s)`. */
export function cpLen(s: string): number {
  if (!/[\ud800-\udfff]/.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** `re.escape` equivalent that is valid inside a `u`-flag RegExp. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// --------------------------------------------------------------------------------------------- arithmetic
/** Python `a // b` for numbers. */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Python `a % b` (result has the sign of b). */
export function pyMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Exact decimal expansion of a finite double, as [sign, integer digits, fraction digits]. */
function exactDecimal(x: number): [string, string, string] {
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const ax = Math.abs(x);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, ax);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (exp === 0) {
    e2 = -1074;
  } else {
    mant |= 1n << 52n;
    e2 = exp - 1075;
  }
  if (e2 >= 0) return [sign, (mant << BigInt(e2)).toString(), ""];
  // value = mant / 2^-e2 = mant * 5^-e2 / 10^-e2
  const k = -e2;
  const digits = (mant * 5n ** BigInt(k)).toString().padStart(k + 1, "0");
  const intPart = digits.slice(0, digits.length - k).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(digits.length - k).replace(/0+$/, "");
  return [sign, intPart, frac];
}

/** Round to n decimals with Python semantics (exact value of the double, ties to even) -> decimal string. */
export function pyFixed(x: number, n: number): string {
  if (!Number.isFinite(x)) return String(x);
  const [sign, ip, fracRaw] = exactDecimal(x);
  const frac = fracRaw.padEnd(n + 1, "0");
  const keep = frac.slice(0, n);
  const rest = fracRaw.slice(n);
  let digits = ip + keep; // integer string scaled by 10^n
  const first = rest.length ? rest.charCodeAt(0) - 48 : 0;
  const tail = rest.slice(1).replace(/0+$/, "");
  let up = false;
  if (first > 5 || (first === 5 && tail.length > 0)) up = true;
  else if (first === 5 && tail.length === 0) up = (digits.charCodeAt(digits.length - 1) - 48) % 2 === 1;
  if (up) digits = (BigInt(digits) + 1n).toString();
  digits = digits.padStart(n + 1, "0");
  const intStr = digits.slice(0, digits.length - n).replace(/^0+(?=\d)/, "");
  const out = n > 0 ? `${intStr}.${digits.slice(digits.length - n)}` : intStr;
  return sign + out;
}

/** Python `round(x, n)` -> number. */
export function pyRound(x: number, n: number): number {
  return Number(pyFixed(x, n));
}

// --------------------------------------------------------------------------------------------- string conversion
/** Python `repr(float)` for a JS number (integers print as ints: JSON loses the int/float distinction). */
export function pyNum(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return String(x);
  const ax = Math.abs(x);
  if (ax >= 1e16 || ax < 1e-4) {
    const [m, e] = x.toExponential().split("e");
    const ei = Number(e);
    return `${m}e${ei < 0 ? "-" : "+"}${String(Math.abs(ei)).padStart(2, "0")}`;
  }
  return String(x);
}

/** Python `str(x)` for JSON values (dict/list via `repr`). */
export function pyStr(x: unknown): string {
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (typeof x === "number") return pyNum(x);
  if (typeof x === "string") return x;
  return pyReprValue(x);
}

/** Python `repr(str)`. */
export function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (!isPrintable(cp)) {
      out += cp <= 0xff ? "\\x" + cp.toString(16).padStart(2, "0") : cp <= 0xffff ? "\\u" + cp.toString(16).padStart(4, "0") : "\\U" + cp.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + q;
}

function isPrintable(cp: number): boolean {
  if (cp === 0x20) return true;
  const ch = String.fromCodePoint(cp);
  // Python: not printable = categories Cc, Cf, Cs, Co, Cn, Zl, Zp, Zs (except space).
  return !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u.test(ch);
}

/** Python `repr()` of a parsed JSON value (dict/list/str/number/bool/None). */
export function pyReprValue(x: unknown): string {
  if (x === null || x === undefined) return "None";
  if (typeof x === "string") return pyRepr(x);
  if (typeof x === "number" || typeof x === "boolean") return pyStr(x);
  if (Array.isArray(x)) return "[" + x.map(pyReprValue).join(", ") + "]";
  if (isDict(x)) return "{" + Object.entries(x).map(([k, v]) => `${pyRepr(k)}: ${pyReprValue(v)}`).join(", ") + "}";
  return String(x);
}

/** Python `json.dumps(x, ensure_ascii=False)` (default separators ", " and ": "). */
export function pyJsonDumps(x: unknown): string {
  if (x === null || x === undefined) return "null";
  if (x === true) return "true";
  if (x === false) return "false";
  if (typeof x === "number") {
    if (Number.isNaN(x)) return "NaN";
    if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
    return pyNum(x);
  }
  if (typeof x === "string") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(pyJsonDumps).join(", ") + "]";
  if (isDict(x)) return "{" + Object.entries(x).map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`).join(", ") + "}";
  return "null";
}

// --------------------------------------------------------------------------------------------- dates
/** Days since 1970-01-01 for a proleptic Gregorian civil date (any year, no Date.UTC 0-99 quirk). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [m <= 2 ? y + 1 : y, m, d];
}

/** `datetime.date(y, m, d)` validity (years 1..9999). */
export function validDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}
