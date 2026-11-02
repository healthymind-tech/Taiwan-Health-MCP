/**
 * FHIRPath evaluation for StructureDefinition invariants (ElementDefinition.constraint).
 *
 * Wraps the `fhirpath` (npm) engine with the R4 model so that the engine is
 * type-aware: `value` resolves to `value[x]` (valueQuantity, valueString, ...),
 * `ofType()` / `is` / `as` work, and `%resource` / `%rootResource` are typed
 * nodes. Functions the engine cannot run offline are supplied here:
 *
 *  - `resolve()`   — resolves references against the validation context
 *                    (contained resources, Bundle entries) — never the network.
 *  - `memberOf()`  — answered from ValueSet expansions the caller pre-computed;
 *                    an unknown ValueSet makes the invariant "unevaluable".
 *  - `htmlChecks()` / `htmlChecks2()` — FHIRPathEngine.funcHtmlChecks1 / 2.
 *  - `as()` / `ofType()`, `startsWith` / `endsWith` / `contains` / `matches` /
 *    `matchesFull` / `length`, %sct / %loinc / %`vs-…` / %`ext-…` — ported
 *    from the HL7 Java FHIRPathEngine (7.0.1) where fhirpath.js differs.
 *  - fixInvariantExpression — FHIRPathExpressionFixer.fixExpr, applied by the
 *    validator before evaluating an invariant (invariantExpression()).
 *
 * Evaluation is synchronous; per-call context is held in a module-level slot
 * for the duration of one evaluation (JS is single-threaded, so this is safe).
 */

import { readFileSync } from "node:fs";
import { htmlChecks1, htmlChecks2 } from "./fhirXhtml.js";
import { convertUcum } from "./fhirUcum.js";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const r4Model: any = require("fhirpath/fhir-context/r4");
const fpUtil: any = require("fhirpath/src/utilities");

const fpTypes: any = require("fhirpath/src/types");

/**
 * A private instance of fhirpath.js whose internal `engine` object (operator table) is reachable: the library only
 * lets callers replace FUNCTIONS (userInvocationTable), while the Java operator semantics (short-circuit `and` /
 * `or` / `implies`, comparisons of collections → empty …) live in its operator table. The module source is compiled
 * once more under its own filename, so its relative requires resolve to the SAME cached sub-modules (types,
 * utilities …) as everywhere else; other users of require("fhirpath") keep the stock behaviour. When the export
 * cannot be added (a changed library layout), the stock module is used without the operator ports.
 */
function loadFhirpath(): { api: any; engine: any | null } {
  try {
    const NodeModule: any = require("node:module");
    const file = require.resolve("fhirpath");
    const m = new NodeModule(file, null);
    m.filename = file;
    m.paths = NodeModule._nodeModulePaths(dirname(file));
    m._compile(`${readFileSync(file, "utf8")}\n;module.exports.__engine = engine;\n`, file);
    if (m.exports?.__engine?.invocationTable && typeof m.exports.compile === "function") return { api: m.exports, engine: m.exports.__engine };
  } catch {
    // fall through
  }
  return { api: require("fhirpath"), engine: null };
}
const loaded = loadFhirpath();
const fhirpath: any = loaded.api;

/**
 * An exception the HL7 Java FHIRPathEngine (7.0.1) also raises for the same input. InstanceValidator.checkInvariant
 * catches every evaluation exception and reports the invariant as FAILED with the exception message
 * (l. 8896-8898: invOK = false; msg = ex.getMessage()).
 */
export class JavaFhirPathError extends Error {}

/** A parse-time error (FHIRPathEngine.parse): checkInvariant reports PROBLEM_PROCESSING_EXPRESSION__IN_PROFILE__PATH__. */
export class JavaFhirPathParseError extends Error {}

// ---------------------------------------------------------------------------
// HL7 Java FHIRPathEngine (org.hl7.fhir.r5 7.0.1) semantics, ported where they
// differ from fhirpath.js and matter for invariant evaluation.
// ---------------------------------------------------------------------------

/** FHIRPathEngine.FHIR_TYPES_STRING */
const FHIR_TYPES_STRING = new Set(["string", "uri", "code", "oid", "id", "uuid", "sid", "markdown", "base64Binary", "canonical", "url", "xhtml"]);
const SYSTEM_TO_FHIR: Record<string, string> = {
  string: "string", integer: "integer", decimal: "decimal", boolean: "boolean", date: "date", datetime: "dateTime",
  time: "time", quantity: "Quantity", long: "integer64",
};

/** The Java `Base.fhirType()` of an item: the FHIR type for model nodes, the primitive name for literals. */
function javaFhirType(item: any): { type: string; literal: boolean } {
  let ti: any;
  try {
    ti = fpTypes.TypeInfo.fromValue(item);
  } catch {
    return { type: "", literal: true };
  }
  if (ti.namespace === "System" && ti.name === "Object") return { type: "", literal: false }; // an untyped node
  if (ti.namespace === "System" || !ti.namespace) {
    const n = String(ti.name);
    return { type: SYSTEM_TO_FHIR[n.toLowerCase()] ?? n, literal: true };
  }
  return { type: String(ti.name), literal: false };
}

/** convertToString(Base) for one primitive item, or null. */
function itemString(item: any): string | null {
  const v = fpUtil.valData(item);
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !(v instanceof fpTypes.FP_Type)) return null;
  return String(v);
}

function isStringTyped(item: any): boolean {
  return FHIR_TYPES_STRING.has(javaFhirType(item).type);
}

/** The string a String-typed parameter evaluated to; `undefined` when the parameter collection was empty. */
function paramString(p: any): string | undefined {
  if (p === undefined || p === null) return undefined;
  if (Array.isArray(p)) {
    if (p.length === 0) return undefined;
    return p.map((x) => itemString(x) ?? "").join(","); // FHIRPathEngine.convertToString(List<Base>)
  }
  return itemString(p) ?? undefined;
}

/** FHIRPathEngine.funcStartsWith */
function javaStartsWith(coll: any[], prefix: any): any[] {
  const sw = paramString(prefix);
  if (!coll || coll.length === 0 || sw === undefined) return [];
  if (sw === "") return [true];
  if (!isStringTyped(coll[0])) return [];
  const s = itemString(coll[0]);
  return [s === null ? false : s.startsWith(sw)];
}

/** FHIRPathEngine.funcEndsWith */
function javaEndsWith(coll: any[], suffix: any): any[] {
  const sw = paramString(suffix);
  if (!coll || coll.length === 0 || sw === undefined) return [];
  if (sw === "") return [true];
  if (!isStringTyped(coll[0])) return [];
  const s = itemString(coll[0]);
  return [coll.length === 1 && s !== null ? s.endsWith(sw) : false];
}

/** FHIRPathEngine.funcContains (the string function) */
function javaContains(coll: any[], sub: any): any[] {
  if (!coll || coll.length !== 1) return [];
  if (Array.isArray(sub) && sub.length !== 1) return [];
  const sw = paramString(sub);
  if (sw === undefined) return [];
  if (sw === "") return [true];
  if (!isStringTyped(coll[0])) return [];
  const st = itemString(coll[0]);
  return [st ? st.includes(sw) : false];
}

/** FHIRPathEngine.funcMatches (`find` with (?s)) / funcMatchesFull (`matches` with (?s)). */
function javaMatches(full: boolean): (coll: any[], regex: any) => any[] {
  return function (coll: any[], regex: any): any[] {
    const sw = paramString(regex);
    if (!full && (!coll || coll.length === 0 || sw === undefined)) return [];
    if (coll && coll.length === 1 && sw) {
      if (!isStringTyped(coll[0])) return [];
      const st = itemString(coll[0]);
      if (!st) return [false];
      return [new RegExp(full ? `^(?:${sw})$` : sw, "s").test(st)];
    }
    return [false];
  };
}

/** FHIRPathEngine.funcLength */
function javaLength(coll: any[]): any[] {
  if (!coll || coll.length !== 1 || !isStringTyped(coll[0])) return [];
  const s = itemString(coll[0]);
  return s === null ? [] : [s.length];
}

/**
 * FHIRPathEngine.funcOfType / funcAs on one item: the exact type or, for complex types and resources, one of
 * its base types; a primitive never matches its supertype (`code` is not `string` here); `System.X` only
 * matches literals.
 */
function javaTypeMatch(item: any, typeInfo: any): boolean {
  const ns: string | null = typeInfo?.namespace ?? null;
  const name = String(typeInfo?.name ?? "");
  const { type, literal } = javaFhirType(item);
  if (ns === "System") return literal && type.toLowerCase() === (SYSTEM_TO_FHIR[name.toLowerCase()] ?? name).toLowerCase();
  if (type === name) return true;
  if (/^[a-z]/.test(type)) return false; // StructureDefinitionKind.PRIMITIVETYPE: no base walk
  let t: string | undefined = type;
  while ((t = r4Model.type2Parent?.[t])) if (t === name) return true;
  return false;
}

// ------------------------------------------------- boolean logic and operators

/** FHIRPathEngine.convertToString(List<Base>) — for exception messages. */
function javaListString(items: any[]): string {
  return items
    .map((i) => {
      const s = itemString(i);
      if (s !== null) return s;
      const v = fpUtil.valData(i);
      return v && typeof v === "object" ? JSON.stringify(v) : String(v);
    })
    .join(",");
}

/** FHIRPathEngine.asBool(List<Base>, …): empty → null; one boolean → it; one other item → true; more → exception. */
function javaAsBool(items: any[]): boolean | null {
  if (!items || items.length === 0) return null;
  if (items.length > 1) throw new JavaFhirPathError(`Unable to evaluate as a boolean: ${javaListString(items)}`);
  const v = fpUtil.valData(items[0]);
  return typeof v === "boolean" ? v : true;
}

/** FHIRPathEngine.isBoolean(list, b): a computed BooleanType (not a boolean element of the instance). */
function isBooleanLiteral(items: any[], b: boolean): boolean {
  return items.length === 1 && items[0] === b;
}

const B = (b: boolean | null): any[] => (b === null ? [] : [b]);

/** Evaluates an operand of an infix operator lazily, in the operator's own context (as fhirpath.js does for plain params). */
function operand(ctx: any, p: (data: any) => any[]): any[] {
  return fpUtil.arraify(p(ctx.$this ?? ctx.dataRoot));
}

/**
 * FHIRPathEngine.execute → preOperate + opAnd / opOr / opXor / opImplies: `false and X` / `true or X` / `false
 * implies X` do not evaluate X (preOperate l. 1661-1676; isBoolean only matches a computed boolean, a boolean
 * element of the instance does not short-circuit); otherwise both operands go through asBool, which raises
 * FHIRPATH_UNABLE_BOOLEAN on a collection of more than one item.
 */
const JAVA_OPERATORS: Record<string, any> = {
  and: {
    arity: { 2: ["ExprAtCurrent", "ExprAtCurrent"] },
    fn: function (this: any, a: any, b: any): any[] {
      const left = operand(this, a);
      if (left.length > 0 && isBooleanLiteral(left, false)) return [false];
      const right = operand(this, b);
      const l = javaAsBool(left);
      const r = javaAsBool(right);
      if (l === false || r === false) return [false];
      if (l === null || r === null) return [];
      return [true];
    },
  },
  or: {
    arity: { 2: ["ExprAtCurrent", "ExprAtCurrent"] },
    fn: function (this: any, a: any, b: any): any[] {
      const left = operand(this, a);
      if (left.length > 0 && isBooleanLiteral(left, true)) return [true];
      const right = operand(this, b);
      const l = javaAsBool(left);
      const r = javaAsBool(right);
      if (l === true || r === true) return [true];
      if (l === null || r === null) return [];
      return [false];
    },
  },
  xor: {
    arity: { 2: ["ExprAtCurrent", "ExprAtCurrent"] },
    fn: function (this: any, a: any, b: any): any[] {
      const l = javaAsBool(operand(this, a));
      const r = javaAsBool(operand(this, b));
      if (l === null || r === null) return [];
      return [l !== r];
    },
  },
  implies: {
    arity: { 2: ["ExprAtCurrent", "ExprAtCurrent"] },
    fn: function (this: any, a: any, b: any): any[] {
      const left = operand(this, a);
      if (left.length > 0 && javaAsBool(left) === false) return [true];
      const right = operand(this, b);
      const eq = javaAsBool(left);
      if (eq === false) return [true];
      if (right.length === 0) return [];
      const r = javaAsBool(right);
      if (r === false) return B(eq === null ? null : false);
      if (r === null) return [];
      return [true];
    },
  },
};

/** Wraps a stock operator: comparisons of collections (more than one item) are empty in Java (opLessThan … l. 2590ff). */
function javaComparison(orig: any): any {
  return {
    ...orig,
    fn: function (this: any, a: any[], b: any[]): any {
      if (a.length > 1 || b.length > 1) return [];
      if (a.length === 1 && b.length === 1 && quantityCodeDiffers(a[0], b[0])) {
        // one side has only the unit text: comparable when the text is the same unit
        if (quantityUnitText(a[0]) === null || quantityUnitText(a[0]) !== quantityUnitText(b[0])) return [];
        return orig.fn.call(this, [quantityNumber(a[0])], [quantityNumber(b[0])]);
      }
      return orig.fn.call(this, a, b);
    },
  };
}

// ------------------------------------------------------------ lowBoundary / highBoundary

/** Utilities.applyPrecision (l. 1709-1738): cuts or pads the digits of `v` to `p` decimal places. */
function boundaryApplyPrecision(v: string, p: number, down: boolean): string {
  let nv = v;
  let dp = -1;
  if (nv.includes(".")) {
    dp = nv.indexOf(".");
    nv = nv.slice(0, dp) + nv.slice(dp + 1);
  }
  const places = v.includes(".") ? v.length - v.indexOf(".") - 1 : 0;
  const d = p - places;
  let out: string;
  if (d === 0) out = nv;
  else if (d > 0) out = nv + "0".repeat(d);
  else {
    let ld = v.length + d;
    if (dp > -1) ld--;
    out = nv.slice(0, ld);
    if (nv[ld] >= "5" && !down) {
      // Java adds one to the last char only (`9` becomes `:`); the suite's carry tests want a real carry
      const c = [...out];
      let i = c.length - 1;
      for (; i >= 0; i--) {
        if (c[i] === "9") c[i] = "0";
        else {
          c[i] = String.fromCharCode(c[i].charCodeAt(0) + 1);
          break;
        }
      }
      out = c.join("");
      if (i < 0) {
        out = `1${out}`;
        if (dp > -1) dp++;
      }
    }
  }
  if (out.endsWith(".")) out = out.slice(0, -1);
  const r = dp === -1 || dp >= out.length ? out : `${out.slice(0, dp)}.${out.slice(dp)}`;
  return r.replace(/^(-?)0+(?=\d)/, "$1"); // minusOne of 10 is 09
}

function boundaryMinusOne(value: string): string {
  const c = [...value];
  for (let i = c.length - 1; i >= 0; i--) {
    if (c[i] === "0") c[i] = "9";
    else if (c[i] !== ".") {
      c[i] = String.fromCharCode(c[i].charCodeAt(0) - 1);
      break;
    }
  }
  return c.join("");
}

/** Utilities.lowBoundaryForDecimal / highBoundaryForDecimal (l. 1688-1773), without the exponent text. */
function decimalBoundary(value: string, precision: number, high: boolean): string {
  const zero = value.replace(/[.-]/g, "").replace(/0/g, "") === "";
  const abs = value.startsWith("-") ? value.slice(1) : value;
  const frac = abs.includes(".") ? "50000000000000000000000000000" : ".50000000000000000000000000000";
  if (high) {
    if (zero) return boundaryApplyPrecision("0.50000000000000000000000000000", precision, false);
    if (value.startsWith("-")) return `-${decimalBoundary(abs, precision, false)}`;
    return boundaryApplyPrecision(abs + frac, precision, false);
  }
  if (zero) return boundaryApplyPrecision("-0.5000000000000000000000000", precision, true);
  if (value.startsWith("-")) return `-${decimalBoundary(abs, precision, true)}`;
  return boundaryApplyPrecision(boundaryMinusOne(abs) + frac, precision, true);
}

/** DateTimeUtil.splitTimezone. */
function splitTimezone(value: string): [string, string] {
  const plus = value.indexOf("+");
  if (plus >= 0) return [value.slice(0, plus), value.slice(plus)];
  const t = value.indexOf("T");
  const minus = value.lastIndexOf("-");
  if (t >= 0 && minus > t) return [value.slice(0, minus), value.slice(minus)];
  const z = value.indexOf("Z");
  return z >= 0 ? [value.slice(0, z), value.slice(z)] : [value, ""];
}

/** DateTimeUtil.lowBoundaryForDate / highBoundaryForDate (l. 65-89, 156-180); a precision it does not know throws. */
function dateBoundary(value: string, precision: number, high: boolean): string {
  const [body, tz0] = splitTimezone(value);
  let b = body;
  if (b.length === 13) b += ":00"; // BaseDateTimeType writes an hour-precision value with its minutes
  if (b.length === 4) b += high ? "-12" : "-01";
  if (b.length === 7) b += high ? `-${new Date(Date.UTC(+b.slice(0, 4), +b.slice(5, 7), 0)).getUTCDate()}` : "-01";
  if (b.length === 10) b += high ? "T23:59" : "T00:00";
  if (b.length === 16) b += high ? ":59" : ":00";
  if (b.length === 19) b += high ? ".999" : ".000";
  const tz = precision <= 10 ? "" : tz0 || (high ? "-12:00" : "+14:00");
  const cut: Record<number, number> = { 4: 4, 6: 7, 7: 7, 8: 10, 10: 10, 14: 17, 17: b.length };
  if (cut[precision] === undefined) throw new JavaFhirPathError(`Unsupported Date precision for boundary operation: ${precision}`);
  return b.slice(0, cut[precision]) + tz;
}

/** DateTimeUtil.lowBoundaryForTime / highBoundaryForTime (l. 100-127). */
function timeBoundary(value: string, precision: number, high: boolean): string {
  const [body, tz] = splitTimezone(value);
  let b = body;
  if (b.length === 2) b += high ? ":59" : ":00";
  if (b.length === 5) b += high ? ":59" : ":00";
  if (b.length === 8) b += high ? ".999" : ".000";
  const cut: Record<number, number> = { 2: 3, 4: 6, 6: 9, 9: b.length };
  if (cut[precision] === undefined) throw new JavaFhirPathError(`Unsupported Time precision for boundary operation: ${precision}`);
  return b.slice(0, cut[precision]) + tz;
}

/** FHIRPathEngine.funcLowBoundary / funcHighBoundary (l. 4618-4705). */
function javaBoundary(high: boolean): (this: any, coll: any[], precision?: any) => any[] {
  return function (this: any, coll: any[], precision?: any): any[] {
    if (!coll || coll.length === 0) return [];
    const name = high ? "highBoundary" : "lowBoundary";
    if (coll.length > 1) throw new JavaFhirPathError(`Error evaluating FHIRPath expression: focus for ${name} can only have one value, but has ${coll.length} values`);
    const v = fpUtil.valDataConverted ? fpUtil.valDataConverted(coll[0]) : fpUtil.valData(coll[0]);
    const p: number | undefined = precision === undefined || precision === null ? undefined : Number(Array.isArray(precision) ? fpUtil.valData(precision[0]) : fpUtil.valData(precision));
    const Dec = this.getDecimal(0).constructor;
    if (v instanceof fpTypes.FP_Quantity) {
      const text = decimalBoundary(String(v.value), p ?? 8, high);
      return [new fpTypes.FP_Quantity(this, new Dec(text), v.unit)];
    }
    if (v instanceof fpTypes.FP_Time) {
      const s = timeBoundary(String(v.asStr ?? v.toString()).replace(/^@?T?/, ""), p ?? 9, high);
      return [new fpTypes.FP_Time(this, s)];
    }
    if (v instanceof fpTypes.FP_DateTime) {
      const asStr = String(v.asStr ?? v.toString()).replace(/^@/, "");
      const isDate = v instanceof fpTypes.FP_Date;
      const s = dateBoundary(asStr, p ?? (isDate ? 10 : 17), high);
      return [s.includes("T") ? new fpTypes.FP_DateTime(this, s) : new fpTypes.FP_Date(this, s)];
    }
    if (typeof v === "number" || typeof v === "bigint" || v instanceof Dec || (v && typeof v.toFixed === "function")) {
      if (p !== undefined && (p < 0 || p >= 17)) return [];
      return [new Dec(decimalBoundary(String(v), p ?? 8, high))];
    }
    throw new JavaFhirPathError(`Error evaluating FHIRPath expression: The parameter type for function sqrt is not valid for ${name}`);
  };
}

/** A Quantity operand's `code` (stock fhirpath.js leaves a Quantity without system + code a plain object); undefined: not a Quantity. */
function quantityCode(item: any): string | null | undefined {
  const v = fpUtil.valData(item);
  if (v instanceof fpTypes.FP_Quantity) return String(v.unit ?? "");
  if (v !== null && typeof v === "object" && javaFhirType(item).type === "Quantity") return typeof v.code === "string" ? v.code : null;
  return undefined;
}

function quantityUnitText(item: any): string | null {
  const v = fpUtil.valData(item);
  if (v instanceof fpTypes.FP_Quantity) return String(v.unit ?? "").replace(/^'|'$/g, "");
  return v !== null && typeof v === "object" ? (typeof v.unit === "string" ? v.unit : typeof v.code === "string" ? v.code : null) : null;
}

function quantityNumber(item: any): number {
  const v = fpUtil.valData(item);
  return Number(v instanceof fpTypes.FP_Quantity ? String(v.value) : v?.value);
}

/** Two Quantities of which only one has a code: qtyEqual is null (FHIRPathEngine l. 2446-2449), and they are not comparable. */
function quantityCodeDiffers(a: any, b: any): boolean {
  const l = quantityCode(a);
  const r = quantityCode(b);
  return l !== undefined && r !== undefined && (l === null) !== (r === null);
}

// ------------------------------------------------------------ dates and times

const DT_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?)?)?)?(Z|[+-]\d{2}:\d{2})?$/;

interface DtParts {
  /** 0 year … 2 day, 3 hour, 4 minute, 5 second, 6 millisecond (TemporalPrecisionEnum). */
  precision: number;
  /** Wall-clock time as a UTC epoch (the literal's own fields, no zone applied). */
  wall: number;
  tz: string | null;
  fraction: boolean;
}

/** A date / dateTime / instant operand (not a time), as the Java engine reads its primitive value. */
function dateTimeParts(item: any): DtParts | null {
  const v = fpUtil.valDataConverted ? fpUtil.valDataConverted(item) : fpUtil.valData(item);
  if (!(v instanceof fpTypes.FP_DateTime)) return null; // FP_Date / FP_Instant extend FP_DateTime; FP_Time does not
  const m = DT_RE.exec(String(v.asStr ?? v.toString()).replace(/^@/, ""));
  if (!m) return null;
  const precision = m[7] !== undefined ? 6 : m[6] !== undefined ? 5 : m[5] !== undefined ? 4 : m[4] !== undefined ? 3 : m[3] !== undefined ? 2 : m[2] !== undefined ? 1 : 0;
  const d = new Date(0);
  d.setUTCFullYear(+m[1], m[2] ? +m[2] - 1 : 0, m[3] ? +m[3] : 1);
  d.setUTCHours(+(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000 + 1e-9) : 0);
  return { precision, wall: d.getTime(), tz: m[8] ?? null, fraction: m[7] !== undefined };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Prints a wall-clock time at the original precision / zone (BaseDateTimeType.getValueAsString). */
function formatParts(p: DtParts, wall: number): string {
  const d = new Date(wall);
  let s = pad(d.getUTCFullYear(), 4);
  if (p.precision >= 1) s += `-${pad(d.getUTCMonth() + 1)}`;
  if (p.precision >= 2) s += `-${pad(d.getUTCDate())}`;
  if (p.precision >= 3) s += `T${pad(d.getUTCHours())}`;
  if (p.precision >= 4) s += `:${pad(d.getUTCMinutes())}`;
  if (p.precision >= 5) s += `:${pad(d.getUTCSeconds())}`;
  if (p.precision >= 6) s += `.${pad(d.getUTCMilliseconds(), 3)}`;
  if (p.precision >= 3 && p.tz) s += p.tz;
  return s;
}

/** Calendar.add(MONTH, n): the day of month is clamped to the target month's length. */
function addMonths(wall: number, n: number): number {
  const d = new Date(wall);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const max = new Date(Date.UTC(2000, 0, 1));
  max.setUTCFullYear(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  d.setUTCDate(Math.min(day, max.getUTCDate()));
  return d.getTime();
}

const CALENDAR_CODES: Record<string, string> = {
  week: "wk", weeks: "wk", day: "d", days: "d", hour: "h", hours: "h", minute: "min", minutes: "min",
  second: "s", seconds: "s", millisecond: "ms", milliseconds: "ms",
};

/**
 * FHIRPathEngine.dateAdd (l. 2929-2986): calendar arithmetic in the value's OWN zone, the result at the value's
 * precision (fhirpath.js re-zones the result to the host's zone). The quantity's integer part is used, seconds add
 * their fraction as milliseconds; 'a' / 'mo' (definite UCUM durations) and other units are errors.
 */
function javaDateAdd(left: any, q: any, negate: boolean): any {
  const p = dateTimeParts(left)!;
  const raw = String(q.unit ?? "");
  const key = /^'.*'$/.test(raw) ? raw.slice(1, -1) : CALENDAR_CODES[raw] ?? raw;
  const num = Number(typeof q.value?.toNumber === "function" ? q.value.toNumber() : q.value);
  const value = negate ? -Math.trunc(num) : Math.trunc(num);
  let wall = p.wall;
  switch (key) {
    case "years":
    case "year":
      wall = addMonths(wall, value * 12);
      break;
    case "months":
    case "month":
      wall = addMonths(wall, value);
      break;
    case "a":
    case "mo":
      throw new JavaFhirPathError(`Error in date arithmetic: attempt to add a definite quantity duration time unit ${key}`);
    case "weeks":
    case "week":
    case "wk":
      wall += value * 7 * 86400000;
      break;
    case "days":
    case "day":
    case "d":
      wall += value * 86400000;
      break;
    case "hours":
    case "hour":
    case "h":
      wall += value * 3600000;
      break;
    case "minutes":
    case "minute":
    case "min":
      wall += value * 60000;
      break;
    case "seconds":
    case "second":
    case "s": {
      wall += value * 1000;
      const dec = (negate ? -num : num) - value;
      wall += Math.trunc(dec * 1000);
      break;
    }
    case "milliseconds":
    case "millisecond":
    case "ms":
      wall += value;
      break;
    default:
      throw new JavaFhirPathError(`Error in date arithmetic: unrecognized time unit ${key}`);
  }
  const out = formatParts(p, wall);
  const v = fpUtil.valDataConverted ? fpUtil.valDataConverted(left) : fpUtil.valData(left);
  return new (v.constructor as any)(v.ctx, out);
}

/** The instant a value starts at / ends before (BaseDateTimeType.getValue / getHighEdge); no zone → UTC. */
function edges(p: DtParts): [number, number] {
  let low = p.wall;
  if (p.tz && p.tz !== "Z") {
    const sign = p.tz[0] === "-" ? -1 : 1;
    low -= sign * (+p.tz.slice(1, 3) * 60 + +p.tz.slice(4, 6)) * 60000;
  }
  const high =
    p.precision === 0 ? addMonths(low, 12) : p.precision === 1 ? addMonths(low, 1) : p.precision === 2 ? low + 86400000
      : p.precision === 4 ? low + 60000 : p.precision === 5 ? low + 1000 : low;
  return [low, high];
}

/**
 * BaseDateTimeType.equalsUsingFhirPathRules (l. 1102-1143) when exactly one side has a zone: false when the two
 * cannot be the same instant (a zone-less value spans ±14 h), otherwise unknown (empty). Else null = not handled.
 */
function javaDateEqualsMixedZone(a: any, b: any): boolean | null | undefined {
  const l = dateTimeParts(a);
  const r = dateTimeParts(b);
  if (!l || !r || !!l.tz === !!r.tz) return undefined;
  let [lowL, highL] = edges(l);
  let [lowR, highR] = edges(r);
  const H14 = 14 * 3600000;
  if (!l.tz) [lowL, highL] = [lowL - H14, highL + H14];
  if (!r.tz) [lowR, highR] = [lowR - H14, highR + H14];
  if (highR < lowL || highL < lowR) return false;
  return null;
}

if (loaded.engine) {
  const table = loaded.engine.invocationTable;
  for (const [op, negate] of [["+", false], ["-", true]] as Array<[string, boolean]>) {
    const orig = table[op];
    table[op] = {
      ...orig,
      fn: function (this: any, a: any[], b: any[]): any {
        if (a.length === 1 && b.length === 1 && dateTimeParts(a[0])) {
          const q = fpUtil.valData(b[0]);
          if (q instanceof fpTypes.FP_Quantity) return [javaDateAdd(a[0], q, negate)];
        }
        return orig.fn.call(this, a, b);
      },
    };
  }
  // opEquivalent / opNotEquivalent (l. 2544-2588): same size, and every left item has an equivalent right item
  // (order-insensitive); item equivalence stays fhirpath.js'
  const item = table["~"];
  for (const [op, not] of [["~", false], ["!~", true]] as Array<[string, boolean]>) {
    const orig = table[op];
    table[op] = {
      ...orig,
      fn: function (this: any, a: any[], b: any[]): any {
        if (a.length <= 1 && b.length <= 1) return orig.fn.call(this, a, b);
        if (a.length !== b.length) return [not];
        const all = a.every((l) => b.some((r) => fpUtil.arraify(item.fn.call(this, [l], [r]))[0] === true));
        return [not ? !all : all];
      },
    };
  }
  for (const [op, not] of [["=", false], ["!=", true]] as Array<[string, boolean]>) {
    const orig = table[op];
    table[op] = {
      ...orig,
      fn: function (this: any, a: any[], b: any[]): any {
        if (a.length === 1 && b.length === 1) {
          if (quantityCodeDiffers(a[0], b[0])) return [];
          // qtyEqual l. 2449-2453 (suite testQuantityUnitComparison): no codes: the unit texts must be the same
          if (quantityCode(a[0]) === null && quantityCode(b[0]) === null) {
            const lu = quantityUnitText(a[0]);
            const ru = quantityUnitText(b[0]);
            if ((lu === null) !== (ru === null) || lu !== ru) return [];
          }
          const eq = javaDateEqualsMixedZone(a[0], b[0]);
          if (eq === null) return [];
          if (eq !== undefined) return [not ? !eq : eq];
        }
        return orig.fn.call(this, a, b);
      },
    };
  }
  Object.assign(table, JAVA_OPERATORS);
  for (const op of ["<", ">", "<=", ">="]) table[op] = javaComparison(table[op]);
  // opEquivalent on Quantities (qtyEquivalent l. 2501-2530): the canonical values, equivalentNumber (the coarser scale)
  const equiv = table["~"];
  table["~"] = {
    ...equiv,
    fn: function (this: any, a: any[], b: any[]): any {
      if (a.length === 1 && b.length === 1) {
        const l = fpUtil.valData(a[0]);
        const r = fpUtil.valData(b[0]);
        if (l instanceof fpTypes.FP_Quantity && r instanceof fpTypes.FP_Quantity && l.unit !== r.unit) {
          const lu = String(l.unit).replace(/^'|'$/g, "");
          const ru = String(r.unit).replace(/^'|'$/g, "");
          const n = convertUcum(Number(String(r.value)), ru, lu);
          if (n !== null) {
            const ls = String(l.value);
            const rs = String(Number(n.toFixed(12)));
            const scale = Math.min(ls.includes(".") ? ls.length - ls.indexOf(".") - 1 : 0, rs.includes(".") ? rs.length - rs.indexOf(".") - 1 : 0);
            return [Number(ls).toFixed(scale) === Number(rs).toFixed(scale)];
          }
        }
      }
      return equiv.fn.call(this, a, b);
    },
  };
  // a negated decimal keeps its text (-120.50); fhirpath.js goes through a number
  const polarity = loaded.engine.PolarityExpression;
  loaded.engine.PolarityExpression = function (ctx: any, parentData: any, node: any): any {
    if (node.text === "-") {
      const r = loaded.engine.doEval(ctx, parentData, node.children[0]);
      if (r.length === 1 && r[0] instanceof fpTypes.FP_Decimal) {
        const t = String(r[0]);
        const zero = /^-?[0.]+$/.test(t);
        return [new (r[0].constructor as any)(t.startsWith("-") ? t.slice(1) : zero ? t : `-${t}`)];
      }
    }
    return polarity.call(loaded.engine, ctx, parentData, node);
  };
  // funcIs: a type name that does not exist in the System namespace is simply not the item's type (no exception)
  const typeSpecifier = loaded.engine.TypeSpecifier;
  loaded.engine.TypeSpecifier = function (ctx: any, parentData: any, node: any): any {
    try {
      return typeSpecifier.call(loaded.engine, ctx, parentData, node);
    } catch (e) {
      const m = /^System\.(.+)$/.exec(String(node.text));
      if (!m) throw e;
      return { namespace: "System", name: m[1], is: () => false, toString: () => node.text, isValid: () => false };
    }
  };
  // opAs (l. 2021-2048): compareTypeNames ignores case while doNotEnforceAsCaseSensitive (R4), and takes the type as written
  const asOp = table.asOp;
  if (asOp) {
    table.asOp = {
      ...asOp,
      fn: function (this: any, left: any[], typeInfo: any): any {
        const name = String(typeInfo?.name ?? "").toLowerCase();
        return (left || []).filter((v) => javaFhirType(v).type.toLowerCase() === name);
      },
    };
  }
  // opContains: every right item must be in left (no singleton rule); opIn: the left operand must be single
  const contains = table.containsOp;
  table.containsOp = {
    ...contains,
    fn: function (this: any, a: any[], b: any[]): any {
      if (b.length <= 1) return contains.fn.call(this, a, b);
      if (a.length === 0) return false;
      return b.every((r) => fpUtil.arraify(contains.fn.call(this, a, [r]))[0] === true);
    },
  };
  const inOp = table.inOp;
  table.inOp = {
    ...inOp,
    fn: function (this: any, a: any[], b: any[]): any {
      if (a.length > 1 && b.length > 0) {
        throw new JavaFhirPathError(`Error evaluating FHIRPath expression: left operand to in can only have 1 value, but has ${a.length} values (${javaListString(a)})`);
      }
      return inOp.fn.call(this, a, b);
    },
  };
}

/** FHIRPathEngine.funcWhere / funcExists / funcAll: the criterion goes through asBool (a collection → exception). */
function javaWhere(this: any, coll: any[], expr: (d: any) => any[]): any[] {
  const out: any[] = [];
  (coll || []).forEach((x, i) => {
    this.$index = i;
    if (javaAsBool(fpUtil.arraify(expr(x))) === true) out.push(x);
  });
  return out;
}

// ----------------------------------------------------------------- htmlChecks

// (parity v3) the xhtml tree checks live in fhirXhtml.ts (XhtmlParser + checkHtmlNames / checkForContent)

// ------------------------------------------------------------- expression fixer

/**
 * org.hl7.fhir.validation.instance.utils.FHIRPathExpressionFixer.fixExpr (7.0.1). InstanceValidator.checkInvariant
 * (and the constraint cache key) uses the FIXED expression of every invariant — work-arounds for wrongly
 * published core expressions, e.g. ref-1 / bld-8 guarded by `exists() implies`, txt-2 → htmlChecks2().
 */
export function fixInvariantExpression(expr: string, key: string | null | undefined, fhirVersion = "4.0.1"): string {
  const r5 = /^5\./.test(fhirVersion);
  const r4 = /^4\.(0|3)(\.|$)/.test(fhirVersion);
  if (r5 && key === "opd-3") return "targetProfile.exists() implies (type = 'Reference' or type = 'canonical' or type.memberOf('http://hl7.org/fhir/ValueSet/all-resource-types'))";
  if (r4 && key === "opd-3") return "targetProfile.exists() implies (type = 'Reference' or type = 'canonical' or type.memberOf('http://hl7.org/fhir/ValueSet/resource-types'))";
  const fixed = FIXED_EXPRESSIONS.get(expr);
  if (expr === "probability is decimal implies (probability as decimal) <= 100") return fixed!;
  if (expr === "enableWhen.count() > 2 implies enableBehavior.exists()") return fixed!;
  if (key === "txt-2") return "htmlChecks2()";
  if (key === "que-7") return "operator = 'exists' implies (answer is boolean)";
  if (key === "dom-6") return "(%rootResource != $this) or text.`div`.exists()";
  if (r4 && expr === "offset.empty() or (when.exists() and ((when in ('C' | 'CM' | 'CD' | 'CV')).not()))") {
    return "offset.empty() or (when.exists() and when.select($this in ('C' | 'CM' | 'CD' | 'CV')).allFalse())";
  }
  if (!r5 && key === "eld-19") {
    return String.raw`path.matches('^[^\\s\\.,:;\\\'"\\/|?!@#$%&*()\\[\\]{}]{1,64}(\\.[^\\s\\.,:;\\\'"\\/|?!@#$%&*()\\[\\]{}]{1,64}(\\[x\\])?(\\:[^\\s\\.]+)?)*$')`;
  }
  if (!r5 && key === "eld-20") return String.raw`path.matches('^[A-Za-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*(\\[x])?)*$')`;
  if (expr === "probability is decimal implies probability.as(decimal) <= 100") {
    return key === "ras-2" ? "probability.empty() or (probability is decimal implies probability.as(decimal) <= 100)" : expr;
  }
  return fixed ?? expr;
}

/**
 * The expression the validator evaluates for an invariant: fixInvariantExpression, except dom-3. InstanceValidator
 * .checkInvariant never runs dom-3 (it enforces the rule in code, checkContainedReferences); we still evaluate it,
 * with `as(T)` read as `ofType(T)` (equivalent for R4, where as() does not enforce the singleton rule).
 */
export function invariantExpression(expr: string, key: string | null | undefined, fhirVersion = "4.0.1"): string {
  if (key === "dom-3") return expr.replace(/\.as\(/g, ".ofType(");
  return fixInvariantExpression(expr, key, fhirVersion);
}

const REF1_R5 ="reference.startsWith('#').not() or (reference.substring(1).trace('url') in %rootResource.contained.id.trace('ids')) or (reference='#' and %rootResource!=%resource)";
const REF1_R4 = "reference.startsWith('#').not() or (reference.substring(1).trace('url') in %rootResource.contained.id.trace('ids'))";
const REF1_R3 = "reference.startsWith('#').not() or (reference.substring(1).trace('url') in %resource.contained.id.trace('ids'))";
const SD_PATH_EXPR = String.raw`(%resource.kind = 'logical' or element.first().path.startsWith(%resource.type)) and (element.tail().not() or  element.tail().all(path.startsWith(%resource.differential.element.first().path.replaceMatches('\\..*','')&'.')))`;

/** Expression-keyed rewrites of FHIRPathExpressionFixer.fixExpr (first match wins there; the keys are distinct). */
const FIXED_EXPRESSIONS = new Map<string, string>([
  ["probability is decimal implies (probability as decimal) <= 100", "(probability.exists() and (probability is decimal)) implies ((probability as decimal) <= 100)"],
  ["enableWhen.count() > 2 implies enableBehavior.exists()", "enableWhen.count() >= 2 implies enableBehavior.exists()"],
  ["generated='generated' implies source.empty()", "generation='generated' implies source.empty()"],
  [
    "binding.empty() or type.code.empty() or type.code.contains(\":\") or type.select((code = 'code') or (code = 'Coding') or (code='CodeableConcept') or (code = 'Quantity') or (code = 'string') or (code = 'uri') or (code = 'Duration')).exists()",
    "binding.empty() or type.code.empty() or type.code.contains(':') or type.select((code = 'code') or (code = 'Coding') or (code='CodeableConcept') or (code = 'Quantity') or (code = 'string') or (code = 'uri') or (code = 'Duration')).exists()",
  ],
  [REF1_R5, `reference.exists() implies (${REF1_R5})`],
  [REF1_R4, `reference.exists() implies (reference = '#' or (${REF1_R4}))`],
  [REF1_R3, `reference.exists() implies (reference = '#' or (${REF1_R4}))`],
  ["fullUrl.contains('/_history/').not()", "fullUrl.exists() implies fullUrl.contains('/_history/').not()"],
  ["name.matches('[A-Z]([A-Za-z0-9_]){0,254}')", "name.exists() implies name.matches('^[A-Z]([A-Za-z0-9_]){0,254}$')"],
  [
    "clinicalStatus.exists() or verificationStatus.coding.where(system='http://terminology.hl7.org/CodeSystem/condition-ver-status' and code = 'entered-in-error').exists() or category.select($this='problem-list-item').empty()",
    "(verificationStatus.coding.where(system='http://terminology.hl7.org/CodeSystem/condition-ver-status' and code = 'entered-in-error').exists() and category.coding.exists(system='http://terminology.hl7.org/CodeSystem/condition-category' and code ='problem-list-item').empty()) implies (clinicalStatus.exists())",
  ],
  ["url.matches('([^|#])*')", "$this.matches('([^|#])*')"],
  [
    "((kind in 'resource' | 'complex-type') and (specialization = 'derivation')) implies differential.element.where((min != 0 and min != 1) or (max != '1' and max != '*')).empty()",
    "((kind in 'resource' | 'complex-type') and (derivation = 'specialization')) implies differential.element.where((min.exists() and min != 0 and min != 1) or (max.exists() and max != '1' and max != '*')).empty()",
  ],
  ["(component.empty() and hasMember.empty()) implies (dataAbsentReason or value)", "(component.empty() and hasMember.empty()) implies (dataAbsentReason.exists() or value.exists())"],
  ["isModifier implies isModifierReason.exists()", "(isModifier.exists() and isModifier) implies isModifierReason.exists()"],
  [SD_PATH_EXPR, SD_PATH_EXPR.replace("element.tail().not()", "element.tail().empty()")],
  ["differential.element.all(id) and differential.element.id.trace('ids').isDistinct()", "differential.element.all(id.exists()) and differential.element.id.trace('ids').isDistinct()"],
  ["snapshot.element.all(id) and snapshot.element.id.trace('ids').isDistinct()", "snapshot.element.all(id.exists()) and snapshot.element.id.trace('ids').isDistinct()"],
  ["(code or value.empty()) and (system.empty() or system = 'urn:iso:std:iso:4217')", "(code.exists() or value.empty()) and (system.empty() or system = 'urn:iso:std:iso:4217')"],
  ["value.empty() or code!=component.code", "value.empty() or (code in component.code).not()"],
  [
    "(code or value.empty()) and (system.empty() or system = %ucum) and (value.empty() or value > 0)",
    "(code.exists() or value.empty()) and (system.empty() or system = %ucum) and (value.empty() or value > 0)",
  ],
  ["element.all(definition and min and max)", "element.all(definition.exists() and min.exists() and max.exists())"],
  ["telecom or endpoint", "telecom.exists() or endpoint.exists()"],
  ["searchType implies type = 'string'", "searchType.exists() implies type = 'string'"],
  [
    "abatement.empty() or (abatement as boolean).not()  or clinicalStatus='resolved' or clinicalStatus='remission' or clinicalStatus='inactive'",
    "abatement.empty() or (abatement is boolean).not() or (abatement as boolean).not() or (clinicalStatus = 'resolved') or (clinicalStatus = 'remission') or (clinicalStatus = 'inactive')",
  ],
  ["(component.empty() and related.empty()) implies (dataAbsentReason or value)", "(component.empty() and related.empty()) implies (dataAbsentReason.exists() or value.exists())"],
]);

/**
 * FHIRPathEngine.resolveConstant: %sct / %loinc / %ucum / %us-zip and the %`vs-…` / %`cs-…` / %`ext-…` shorthands
 * (%resource / %rootResource / %context come from the evaluation context).
 */
function javaConstants(expression: string): Record<string, string> {
  const out: Record<string, string> = {
    sct: "http://snomed.info/sct",
    loinc: "http://loinc.org",
    ucum: "http://unitsofmeasure.org",
    "us-zip": "[0-9]{5}(-[0-9]{4}){0,1}",
  };
  for (const m of expression.matchAll(/%`((vs|cs|ext)-([^`]*))`/g)) {
    out[m[1]] = m[2] === "vs" ? `http://hl7.org/fhir/ValueSet/${m[3]}` : m[2] === "cs" ? `http://hl7.org/fhir/${m[3]}` : `http://hl7.org/fhir/StructureDefinition/${m[3]}`;
  }
  return out;
}

/**
 * Any other %name: the validator's host services answer an unknown constant with an EMPTY collection
 * (InstanceValidator.ValidatorHostServices.resolveConstant l. 213-226, %profile aside), never an exception;
 * fhirpath.js throws. Names the expression defines itself (defineVariable) are left alone.
 */
function emptyConstants(expression: string): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const m of expression.replace(/'(?:[^'\\]|\\.)*'/g, "''").matchAll(/%(?:([A-Za-z_][A-Za-z0-9_]*)|`([^`]*)`)/g)) {
    const name = m[1] ?? m[2];
    if (["context", "ucum", "factory", "terminologies", "resource", "rootResource"].includes(name)) continue;
    if (!/defineVariable\s*\(/.test(expression) || !expression.includes(`'${name}'`)) out[name] = [];
  }
  return out;
}

export interface FhirPathEnv {
  /** The resource that contains the node (for contained resources: the contained one). */
  resource: Record<string, any>;
  /** The top-level resource (the container / the Bundle being validated). */
  rootResource: Record<string, any>;
  /** Resolve a Reference.reference string seen from `fromResource`; null when not resolvable. */
  resolveReference?: (reference: string, fromResource: Record<string, any>) => Record<string, any> | null;
  /** Membership of a code / Coding / CodeableConcept in a ValueSet; undefined = unknown. */
  memberOf?: (value: any, valueSetUrl: string) => boolean | undefined;
}

export type ConstraintOutcome =
  | { status: "pass" }
  /** `error`: the evaluation raised an exception the Java engine raises too (the invariant fails with that message);
   *  `parse`: the expression itself is rejected (FHIRPathEngine.parse). */
  | { status: "fail"; error?: string; parse?: boolean }
  | { status: "unevaluable"; reason: string };

class Unevaluable extends Error {}

let current: FhirPathEnv | null = null;

const typedNodes = new WeakMap<object, any[]>();

/** The resource as a typed fhirpath ResourceNode (cached per resource object). */
function typedNode(resource: any): any[] {
  if (!resource || typeof resource !== "object") return [];
  let nodes = typedNodes.get(resource);
  if (!nodes) {
    nodes = fhirpath.evaluate(resource, "$this", null, r4Model, { resolveInternalTypes: false }) as any[];
    typedNodes.set(resource, nodes);
  }
  return nodes;
}

/** Narrative check of the R4 txt-1 invariant: `htmlChecks()` = FHIRPathEngine.funcHtmlChecks1 (checkHtmlNames). */
export function narrativeHtmlOk(div: unknown): boolean {
  if (typeof div !== "string") return false;
  // (parity v3) the element model's xhtml node: XhtmlParser (xml mode); unparseable -> no node -> false
  return htmlChecks1(div);
}

/** txt-2 after FHIRPathExpressionFixer: `htmlChecks2()` = FHIRPathEngine.funcHtmlChecks2 (checkForContent). */
export function narrativeHasContent(div: unknown): boolean {
  if (typeof div !== "string") return false;
  return htmlChecks2(div);
}

/** The xhtml of a focus item: an xhtml node as is; a string wrapped in a div (funcHtmlChecks1). */
function xhtmlOf(item: any): string | null {
  const v = fpUtil.valData(item);
  if (typeof v !== "string") return null;
  return javaFhirType(item).type === "xhtml" || /^\s*<div[\s>]/.test(v) ? v : `<div xmlns="http://www.w3.org/1999/xhtml">${v}</div>`;
}

const USER_FUNCTIONS: Record<string, any> = {
  resolve: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      const env = current;
      if (!env || !env.resolveReference) throw new Unevaluable("resolve() unavailable");
      const out: any[] = [];
      for (const item of coll || []) {
        const v = fpUtil.valData(item);
        let ref: string | null = null;
        if (typeof v === "string") ref = v;
        else if (v && typeof v === "object" && typeof v.reference === "string") ref = v.reference;
        if (!ref) continue;
        const target = env.resolveReference(ref, env.resource);
        if (target) for (const n of typedNode(target)) out.push(n);
      }
      return out;
    },
  },
  memberOf: {
    internalStructures: true,
    arity: { 1: ["String"] },
    fn: function (coll: any[], vsUrl: any): any[] {
      const env = current;
      const url = Array.isArray(vsUrl) ? fpUtil.valData(vsUrl[0]) : vsUrl;
      if (!coll || coll.length !== 1 || typeof url !== "string") return [];
      // FHIRPathEngine.funcMemberOf: only code / string / uri / Coding / CodeableConcept are tested
      const t = javaFhirType(coll[0]).type;
      if (t && !["code", "string", "uri", "Coding", "CodeableConcept"].includes(t)) return [];
      const answer = env?.memberOf ? env.memberOf(fpUtil.valData(coll[0]), url) : undefined;
      if (answer === undefined) throw new Unevaluable(`memberOf('${url}') not resolvable locally`);
      return [answer];
    },
  },
  htmlChecks: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      if (!coll || coll.length !== 1) return [];
      const x = xhtmlOf(coll[0]);
      return x === null ? [] : [narrativeHtmlOk(x)];
    },
  },
  // FHIRPathEngine.funcHasValue (l. 6201): one item, primitive, !Utilities.noString(value) — a "" has no value, a
  // complex item never has one (per-1 on a Period whose end is "" short-circuits on end.hasValue().not())
  hasValue: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      if (!coll || coll.length !== 1) return [false];
      const v = fpUtil.valData(coll[0]);
      return [v !== null && v !== undefined && typeof v !== "object" && String(v) !== ""];
    },
  },
  htmlChecks2: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      if (!coll || coll.length !== 1) return [false];
      const v = fpUtil.valData(coll[0]);
      return [typeof v === "string" && narrativeHasContent(v)];
    },
  },
  // FHIRPathEngine.funcAs: the singleton rule is NOT enforced for R4 — InstanceValidator (IV:602) sets
  // fpe.setDoNotEnforceAsSingletonRule(!VersionUtilities.isR5Plus(…)), so as() filters like ofType() (REVIEW_port_1 F22)
  as: {
    internalStructures: true,
    arity: { 1: ["TypeSpecifier"] },
    fn: function (coll: any[], typeInfo: any): any[] {
      return (coll || []).filter((v) => javaTypeMatch(v, typeInfo));
    },
  },
  ofType: {
    internalStructures: true,
    arity: { 1: ["TypeSpecifier"] },
    fn: function (coll: any[], typeInfo: any): any[] {
      return (coll || []).filter((v) => javaTypeMatch(v, typeInfo));
    },
  },
  where: { internalStructures: true, arity: { 1: ["Expr"] }, fn: javaWhere },
  exists: {
    internalStructures: true,
    arity: { 0: [], 1: ["Expr"] },
    fn: function (this: any, coll: any[], expr?: (d: any) => any[]): any[] {
      // funcExists l. 5813: an element with nothing in it (Base.isEmpty) does not count
      if (!expr) {
        return [(coll || []).some((x) => {
          const v = fpUtil.valData(x);
          return !(v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length === 0);
        })];
      }
      return [javaWhere.call(this, coll, expr).length > 0];
    },
  },
  all: {
    internalStructures: true,
    arity: { 1: ["Expr"] },
    fn: function (this: any, coll: any[], expr: (d: any) => any[]): any[] {
      for (let i = 0; i < (coll || []).length; i++) {
        this.$index = i;
        if (javaAsBool(fpUtil.arraify(expr(coll[i]))) !== true) return [false];
      }
      return [true];
    },
  },
  // FHIRPathEngine.funcNot: asBool (a collection → exception)
  not: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      const v = javaAsBool(coll || []);
      return v === null ? [] : [!v];
    },
  },
  // FHIRPathEngine.funcIif: a collection focus is an error; the criterion through asBool
  iif: {
    internalStructures: true,
    arity: { 2: ["Expr", "ExprAtCurrent"], 3: ["Expr", "ExprAtCurrent", "ExprAtCurrent"] },
    fn: function (this: any, coll: any[], cond: (d: any) => any[], ok: (d: any) => any[], fail?: (d: any) => any[]): any[] {
      const focus = coll || [];
      if (focus.length > 1) {
        throw new JavaFhirPathError(`Error evaluating FHIRPath expression: The function iif can only be used on a singleton value but found ${focus.length}`);
      }
      const v = javaAsBool(fpUtil.arraify(cond(focus)));
      if (v === true) return fpUtil.arraify(ok(focus));
      return fail ? fpUtil.arraify(fail(focus)) : [];
    },
  },
  // FHIRPathEngine.funcPrecision (l. 4717-4736): decimal places / digits of a date, dateTime or time (fhirpath.js has
  // no precision()); a decimal's trailing zeros are not kept by the JS number, so its count is a lower bound
  precision: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      if (!coll || coll.length === 0) return [];
      if (coll.length > 1) {
        throw new JavaFhirPathError(`Error evaluating FHIRPath expression: focus for highBoundary can only have one value, but has ${coll.length} values`);
      }
      const v = fpUtil.valDataConverted ? fpUtil.valDataConverted(coll[0]) : fpUtil.valData(coll[0]);
      if (v instanceof fpTypes.FP_DateTime || v instanceof fpTypes.FP_Time) {
        return [String(v.asStr ?? v.toString()).replace(/(Z|[+-]\d{2}:\d{2})$/, "").replace(/\D/g, "").length];
      }
      const t = javaFhirType(coll[0]).type;
      if (t === "decimal" || v instanceof fpTypes.FP_Decimal || (t === "" && typeof v === "number")) {
        const s = String(typeof v?.toString === "function" ? v.toString() : v);
        return [s.includes(".") ? s.length - s.indexOf(".") - 1 : 0];
      }
      return [];
    },
  },
  lowBoundary: { internalStructures: true, arity: { 0: [], 1: ["Integer"] }, fn: javaBoundary(false) },
  highBoundary: { internalStructures: true, arity: { 0: [], 1: ["Integer"] }, fn: javaBoundary(true) },
  // FHIRPathEngine.funcReplaceMatches (l. 5252-5277): an empty regex returns the input unchanged
  replaceMatches: {
    internalStructures: true,
    arity: { 2: ["Any", "Any"] },
    fn: function (coll: any[], regex: any, repl: any): any[] {
      const re = paramString(regex);
      const rp = paramString(repl);
      if (!coll || coll.length === 0 || re === undefined || rp === undefined) return [];
      if (coll.length === 1 && re !== "") {
        const f = itemString(coll[0]);
        return isStringTyped(coll[0]) && f !== null ? [f.replace(new RegExp(re, "g"), rp)] : [];
      }
      return [itemString(coll[0]) ?? ""];
    },
  },
  startsWith: { internalStructures: true, fn: javaStartsWith, arity: { 1: ["Any"] } },
  endsWith: { internalStructures: true, fn: javaEndsWith, arity: { 1: ["Any"] } },
  contains: { internalStructures: true, fn: javaContains, arity: { 1: ["Any"] } },
  matches: { internalStructures: true, fn: javaMatches(false), arity: { 1: ["Any"] } },
  matchesFull: { internalStructures: true, fn: javaMatches(true), arity: { 1: ["Any"] } },
  length: { internalStructures: true, fn: javaLength },
  conformsTo: {
    internalStructures: true,
    arity: { 1: ["String"] },
    fn: function (): any[] {
      throw new Unevaluable("conformsTo() not supported");
    },
  },
};

const OPTIONS = { userInvocationTable: USER_FUNCTIONS, traceFn: () => undefined };

const compiled = new Map<string, (data: any, env: any) => any[]>();
const COMPILE_CACHE_MAX = 5000;

/**
 * Pick the base path FHIRPath should use for a node. Resources use their type;
 * complex datatypes use the type name (so choice elements such as
 * `Extension.value` resolve); backbone elements use their element path.
 */
let typeToPath: Map<string, string> | null = null;

/** A model path whose declared type is `typeCode` (so the base node is typed). */
function representativePath(typeCode: string): string | null {
  if (!typeToPath) {
    typeToPath = new Map();
    for (const [p, t] of Object.entries(r4Model.path2Type as Record<string, string>)) {
      if (!typeToPath.has(t) || p.length < typeToPath.get(t)!.length) typeToPath.set(t, p);
    }
  }
  return typeToPath.get(typeCode) ?? null;
}

export function fhirPathBase(elementPath: string, typeCode: string | null): string {
  if (typeCode && typeCode !== "BackboneElement" && typeCode !== "Element" && /^[A-Z]/.test(typeCode)) {
    // Resources: their type name. Datatypes: a path the R4 model types as
    // `typeCode`, so `ofType()` / `is` work on the node itself.
    if (r4Model.type2Parent?.[typeCode] === "DomainResource" || r4Model.type2Parent?.[typeCode] === "Resource") return typeCode;
    const own = elementPath.endsWith("[x]") ? elementPath.slice(0, -3) + typeCode : elementPath;
    if ((r4Model.path2Type as Record<string, string>)[own] === typeCode) return own;
    return representativePath(typeCode) ?? typeCode;
  }
  if (typeCode && elementPath.endsWith("[x]")) {
    // Primitive choice value: `Observation.effective[x]` as dateTime → Observation.effectiveDateTime
    return elementPath.slice(0, -3) + typeCode[0].toUpperCase() + typeCode.slice(1);
  }
  return elementPath.replace(/\[x\]/g, "");
}

/**
 * On a primitive node the HL7 engine lets `value` denote the primitive's own
 * value (invariants such as `value.matches('…')` on string elements rely on it);
 * a FHIR primitive has no JSON child called `value`, so rewriting a bare
 * leading `value` to `$this` is exact.
 */
export function primitiveValueAlias(expression: string): string {
  return expression.replace(/(^|[^.\w$%'"])value\b(?!\s*\()/g, "$1$this");
}

/** ExpressionNode.Function.fromCode (7.0.1) + the validator host functions (ValidatorHostServices.resolveFunction). */
const JAVA_FUNCTIONS = new Set(
  (
    "empty not exists subsetOf supersetOf isDistinct distinct count where select all repeat aggregate item as is single " +
    "first last tail skip take union combine intersect exclude iif lower upper toChars indexOf substring startsWith " +
    "endsWith matches matchesFull replaceMatches contains replace length children descendants memberOf trace " +
    "defineVariable check today now resolve extension allFalse anyFalse allTrue anyTrue hasValue htmlChecks htmlchecks " +
    "htmlChecks2 comparable encode decode escape unescape trim split join ofType type toInteger toDecimal toString " +
    "toQuantity toBoolean toDateTime toTime convertsToInteger convertsToDecimal convertsToString convertsToQuantity " +
    "convertsToBoolean convertsToDateTime convertsToDate convertsToTime conformsTo round sqrt abs ceiling exp floor ln " +
    "log power truncate sort coalesce lowBoundary highBoundary precision hasTemplateIdOf debug section entry " +
    "slice getResourceKey getReferenceKey"
  ).split(" "),
);

/** FHIRPathEngine.parse rejects an unknown function name ("The name X is not a known function name", l. 1256-1265). */
function checkFunctionNames(node: any): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "Functn") {
    const id = (node.children || []).find((c: any) => c.type === "Identifier");
    const name = String(id?.text ?? "").replace(/^`(.*)`$/s, "$1");
    if (name && !JAVA_FUNCTIONS.has(name)) throw new JavaFhirPathParseError(`The name ${name} is not a known function name`);
  }
  for (const c of node.children || []) checkFunctionNames(c);
}

function compile(base: string, expression: string): (data: any, env: any) => any[] {
  const key = base + "\u0000" + expression;
  let fn = compiled.get(key);
  if (!fn) {
    try {
      checkFunctionNames(fhirpath.parse(expression));
    } catch (e) {
      if (e instanceof JavaFhirPathParseError) throw e;
      throw new JavaFhirPathParseError(e instanceof Error ? e.message : String(e));
    }
    fn = fhirpath.compile({ base, expression }, r4Model, OPTIONS) as (data: any, env: any) => any[];
    if (compiled.size >= COMPILE_CACHE_MAX) compiled.clear();
    compiled.set(key, fn);
  }
  return fn;
}

/**
 * A numeric root node, pre-built: fhirpath.js (4.11) wraps a typed root in a ResourceNode BEFORE its context has
 * `getDecimal` (applyParsedPath), so any invariant on an integer / decimal element threw "ctx.getDecimal is not a
 * function". The node is built here with the same path / type the compiled base gives it.
 */
function numericRoot(value: number | bigint, base: string): any {
  const type: string | undefined = (r4Model.path2Type as Record<string, string>)[base];
  const ctx = { model: r4Model, getDecimal: fpTypes.FP_Decimal_Native.getDecimal };
  return fpTypes.ResourceNode.makeResNode(ctx, value, null, base, null, type ?? null);
}

/**
 * Evaluate an expression against one node with the invariant engine (same
 * model, options, user functions and variables as evaluateConstraint) and
 * return the raw result collection. Throws on syntax / evaluation errors and
 * on `Unevaluable` host functions. `internal: true` keeps fhirpath.js typed
 * nodes (for `fhirpath.types()`), otherwise plain JS values.
 */
export function evaluateExpression(
  node: any,
  base: string,
  expression: string,
  env: FhirPathEnv,
  extraVars: Record<string, any> = {},
  opts: { internal?: boolean } = {},
): any[] {
  const prev = current;
  current = env;
  try {
    const fn = compile(base, expression) as (data: any, env: any, o?: any) => any[];
    const vars = { ...emptyConstants(expression), ...javaConstants(expression), ...extraVars, resource: typedNode(env.resource)[0], rootResource: typedNode(env.rootResource)[0] };
    const data = typeof node === "number" || typeof node === "bigint" ? numericRoot(node, base) : node;
    return opts.internal ? fn(data, vars, { resolveInternalTypes: false }) : fn(data, vars);
  } finally {
    current = prev;
  }
}

/** Exposes fhirpath.js `types()` for results of evaluateExpression(…, { internal: true }). */
export function resultTypes(result: any[]): string[] {
  return fhirpath.types(result) as string[];
}

/** Evaluate an invariant expression against one node. */
export function evaluateConstraint(
  node: any,
  base: string,
  expression: string,
  env: FhirPathEnv,
  extraVars: Record<string, any> = {},
): ConstraintOutcome {
  try {
    const result = evaluateExpression(node, base, expression, env, extraVars);
    if (!Array.isArray(result) || result.length === 0) {
      // Same as the HL7 Java engine (convertToBoolean): an empty result is false.
      return { status: "fail" };
    }
    if (result.length === 1 && typeof result[0] === "boolean") {
      return result[0] ? { status: "pass" } : { status: "fail" };
    }
    // FHIRPathEngine.convertToBoolean: any other non-empty collection is true (even [false, false])
    return { status: "pass" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof JavaFhirPathParseError) return { status: "fail", error: msg, parse: true };
    if (e instanceof JavaFhirPathError || JAVA_EQUIVALENT_ERRORS.some((re) => re.test(msg))) return { status: "fail", error: msg };
    return { status: "unevaluable", reason: msg };
  }
}

/**
 * fhirpath.js exceptions the Java engine raises for the same input (checked against FHIRPathEngine 7.0.1); every
 * other library exception stays "unevaluable" (the library is stricter there — e.g. a collection passed to a
 * String / Integer parameter — and Java would evaluate).
 */
const JAVA_EQUIVALENT_ERRORS: RegExp[] = [
  /^Expected single$/, // funcSingle: FHIRPATH_NO_COLLECTION
  /did not match type of/, // opLessThan …: FHIRPATH_CANT_COMPARE
  /^Cannot .* [-+*/] /, // opPlus / opMinus / opTimes / opDivideBy: FHIRPATH_LEFT_VALUE / OP_INCOMPATIBLE
];

/** Test seam: number of compiled expressions held. */
export function compiledCount(): number {
  return compiled.size;
}
