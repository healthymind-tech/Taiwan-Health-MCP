/**
 * FHIRPathEngine.check (HL7 core 7.0.1): the static type check of a parsed FHIRPath expression (executeType,
 * evaluateFunctionType, operateTypes, getChildTypesByName), with Java's exception texts: validator_cli prints them in
 * TEXT_LINK_SELECTOR_INVALID. Warnings (typeWarnings) are not ported: they never reach a validation message here.
 *
 * Deliberately not exact: `children()` / `descendants()`, `aggregate()` / `$total`, a Resource-typed element and an
 * abstract type's descendants give an open type set (`any`), which accepts every further name: Java lists every
 * structure there (analysis.allTypes / worker.getResourceNames), which PathCheckDeps cannot enumerate.
 */
import type { ExprNode } from "./fhirPathJavaParser.js";

const CORE = "http://hl7.org/fhir/StructureDefinition/";
const FP_NS = "http://hl7.org/fhirpath/";
const FP = {
  String: `${FP_NS}System.String`,
  Boolean: `${FP_NS}System.Boolean`,
  Integer: `${FP_NS}System.Integer`,
  Decimal: `${FP_NS}System.Decimal`,
  Quantity: `${FP_NS}System.Quantity`,
  DateTime: `${FP_NS}System.DateTime`,
  Time: `${FP_NS}System.Time`,
  SimpleTypeInfo: `${FP_NS}System.SimpleTypeInfo`,
  ClassInfo: `${FP_NS}System.ClassInfo`,
};
const SYSTEM_NAMES = ["boolean", "string", "integer", "decimal", "Quantity", "date", "dateTime", "time", "ClassInfo", "SimpleTypeInfo"];

type Status = "SINGLETON" | "ORDERED" | "UNORDERED" | null;

/** Absolute type url, or the FHIR type namespace. */
const ns = (n: string): string => (/^[a-z]+:/i.test(n) ? n : CORE + n);
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

class TD {
  types: string[] = [];
  /** An open type set (see the file header). */
  any = false;
  constructor(
    public status: Status,
    ...names: string[]
  ) {
    for (const n of names) this.add(n);
  }
  add(n: string): void {
    const u = ns(n);
    if (!this.types.includes(u)) this.types.push(u);
  }
  update(o: TD): void {
    for (const t of o.types) this.add(t);
    this.any ||= o.any;
    if (this.status === null || this.status === "SINGLETON") this.status = o.status;
    else if (o.status === "UNORDERED") this.status = o.status;
    else this.status = "ORDERED";
  }
  union(o: TD): TD {
    const r = new TD(o.status === "UNORDERED" || this.status === "UNORDERED" ? "UNORDERED" : "ORDERED", ...this.types, ...o.types);
    r.any = this.any || o.any;
    return r;
  }
  singleton(): TD {
    const r = new TD("SINGLETON", ...this.types);
    r.any = this.any;
    return r;
  }
  unordered(): TD {
    const r = new TD("UNORDERED", ...this.types);
    r.any = this.any;
    return r;
  }
  hasNoTypes(): boolean {
    return !this.types.length;
  }
  /** TypeDetails.hasType(String): the type or its System twin, no hierarchy. */
  has(n: string): boolean {
    return this.types.includes(ns(n)) || (SYSTEM_NAMES.includes(n) && this.types.includes(`${FP_NS}System.${capitalize(n)}`));
  }
  describe(): string {
    return `[${[...this.types].sort().join(", ")}]`;
  }
  toString(): string {
    return `${this.status ?? "SINGLETON"}[${this.types.join(", ")}]`;
  }
}

export interface PathCheckDeps {
  /** A StructureDefinition by canonical url, null when unknown. */
  fetch(url: string): Promise<Record<string, any> | null>;
  /** Names of the primitive types (analysis.primitiveTypes). */
  primitiveTypes: ReadonlySet<string>;
}

interface Ctx {
  rootResource: string;
  resource: string;
  context: TD;
  thisItem: TD;
  vars: Map<string, TD>;
}

/** PathEngineException.getMessage: the formatted text + " (@char <column of the node>)". */
export class PathEngineError extends Error {}
const fail = (exp: ExprNode, text: string): PathEngineError => new PathEngineError(`${text} (@char ${exp.startCol ?? 1})`);

/** TypeRefComponent.getWorkingCode: the structuredefinition-fhir-type extension, else the code. */
const workingCode = (t: Record<string, any>): string => {
  const x = ((t.extension ?? []) as any[]).find((e) => e?.url === "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type");
  return String(x?.valueUrl ?? x?.valueUri ?? x?.valueString ?? t.code ?? "");
};

const STRINGISH = ["string", "code", "uri", "url", "canonical", "oid", "uuid", "id"];

class Checker {
  constructor(private readonly deps: PathCheckDeps) {}

  /** TypeDetails.hasType(worker, names): direct, System twin, or through the type's base definitions. */
  private async hasW(td: TD, ...names: string[]): Promise<boolean> {
    for (const n of names) if (td.has(n)) return true;
    for (const n of names) {
      const tail = n.includes("#") ? n.slice(n.indexOf("#") + 1) : null;
      const id = n.includes("#") ? n.slice(0, n.indexOf("#")) : n;
      let sd = await this.deps.fetch(ns(id));
      if (sd && tail === null && SYSTEM_NAMES.includes(String(sd.type)) && td.has(String(sd.type))) return true;
      while (sd) {
        if (tail === null && td.types.includes(String(sd.url))) return true;
        if (tail !== null && td.types.includes(`${sd.url}#${tail}`)) return true;
        if (sd.url === `${CORE}string` && td.types.includes(FP.String)) return true;
        if (!sd.baseDefinition) break;
        sd = await this.deps.fetch(sd.type === "uri" ? `${CORE}string` : String(sd.baseDefinition));
      }
    }
    return false;
  }

  private async abstractType(code: string): Promise<boolean> {
    const sd = await this.deps.fetch(ns(code));
    return !!sd && sd.abstract === true && sd.kind !== "resource";
  }

  private elements(sd: Record<string, any>): Array<Record<string, any>> {
    return sd.snapshot?.element ?? [];
  }

  /** getElementDefinition (allowTypedName false: isAllowPolymorphicNames is off in the validator). */
  private async elementDefinition(sd: Record<string, any>, path: string, source: Record<string, any> | null = null): Promise<Array<{ ed: Record<string, any>; source: Record<string, any> | null }>> {
    for (const ed of this.elements(sd)) {
      const p = String(ed.path);
      if (p === path) {
        if (ed.contentReference) {
          const id = String(ed.contentReference).replace(/^.*#/, "");
          const t = this.elements(sd).find((e) => e.id === id);
          return t ? [{ ed: t, source: ed }] : [];
        }
        return [{ ed, source }];
      }
      if (p.endsWith("[x]") && path === p.slice(0, -3)) return [{ ed, source }];
      const types: any[] = ed.type ?? [];
      if (p.includes(".") && path.startsWith(`${p}.`) && types.length > 0 && !(types.length === 1 && (await this.abstractType(String(types[0].code))))) {
        const out: Array<{ ed: Record<string, any>; source: Record<string, any> | null }> = [];
        for (const t of types) {
          const nsd = await this.deps.fetch(ns(String(t.code)));
          if (nsd) out.push(...(await this.elementDefinition(nsd, `${nsd.id}${path.slice(p.length)}`, source)));
        }
        return out;
      }
      if (ed.contentReference && path.startsWith(`${p}.`)) {
        const id = String(ed.contentReference).replace(/^.*#/, "");
        const m = this.elements(sd).find((e) => e.id === id);
        return m ? this.elementDefinition(sd, `${m.path}${path.slice(p.length)}`, ed) : [];
      }
    }
    return [];
  }

  /** getChildTypesByName for a name (`*` / `**` are open: see the file header). */
  private async childTypes(type: string, name: string, result: TD, exp: ExprNode): Promise<void> {
    if (type === `${CORE}xhtml`) return;
    if (type === FP.SimpleTypeInfo || type === FP.ClassInfo) {
      // getSimpleTypeChildTypesByName / getClassInfoChildTypesByName
      if (name === "namespace" || name === "name") result.add(FP.String);
      return;
    }
    if (type.startsWith(`${FP_NS}System.`)) return;
    const url = type.includes("#") ? type.slice(0, type.indexOf("#")) : type;
    const sd = await this.deps.fetch(url);
    if (!sd) {
      if (url.startsWith(FP_NS)) return;
      throw fail(exp, `Error evaluating FHIRPath expression: The type '${url}' is unknown or not supported at getChildTypesByName#1`);
    }
    let tail = "";
    if (type.includes("#")) {
      const t = type.slice(type.indexOf("#") + 1);
      tail = t.includes(".") ? t.slice(t.indexOf(".")) : "";
    }
    if (sd.abstract === true) result.any = true;
    const path = `${this.elements(sd)[0]?.path}${tail}.${name}`;
    for (const { ed, source } of await this.elementDefinition(sd, path)) {
      if (source) {
        result.add(`${sd.type}#${ed.path}`);
        result.status = source.max === "*" ? "ORDERED" : (result.status ?? "SINGLETON");
        continue;
      }
      for (const t of (ed.type ?? []) as any[]) {
        const code = String(t.code ?? "");
        if (!code) break;
        if (code === "Element" || code === "BackboneElement" || (await this.abstractType(code))) result.add(`${sd.url}#${path}`);
        else if (code === "Resource") result.any = true;
        else result.add(workingCode(t));
        // addType(status, pt): an unbounded element makes the result an ordered collection
        if (ed.max === "*") result.status = "ORDERED";
        else result.status = result.status ?? "SINGLETON";
      }
    }
  }

  private checkOrdered(focus: TD, name: string, exp: ExprNode): void {
    if (focus.status === "UNORDERED") throw fail(exp, `Error evaluating FHIRPath expression: The function ${name} can only be used on ordered collections`);
  }

  private async checkParams(exp: ExprNode, params: TD[], ...want: TD[]): Promise<void> {
    for (let i = 0; i < want.length && i < params.length; i++) {
      for (const a of params[i].types) {
        if (!(await this.hasW(want[i], a))) {
          throw fail(exp, `Error evaluating FHIRPath expression: The parameter type ${a} is not legal for ${exp.name} parameter ${i + 1}. expecting ${want[i].toString()}`);
        }
      }
    }
  }

  private async contextString(focus: TD, name: string, exp: ExprNode): Promise<void> {
    if (focus.any || focus.hasNoTypes()) return;
    for (const n of ["string", "code", "uri", "url", "canonical", "id"]) if (await this.hasW(focus, n)) return;
    throw fail(exp, `Error evaluating FHIRPath expression: The function ${name} can only be used on string, uri, url, code, id but found ${focus.describe()}`);
  }

  private contextPrimitive(focus: TD, name: string, canQty: boolean, exp: ExprNode): void {
    if (focus.any || focus.hasNoTypes()) return;
    const prim = [...this.deps.primitiveTypes].some((p) => focus.has(p));
    if (!prim && !(canQty && focus.has("Quantity"))) throw fail(exp, `Error evaluating FHIRPath expression: The function ${name} can only be used on primitives`);
  }

  private async contextOne(focus: TD, names: string[], text: string, exp: ExprNode, hierarchy = true): Promise<void> {
    if (focus.any) return;
    for (const n of names) if (hierarchy ? await this.hasW(focus, n) : focus.has(n)) return;
    throw fail(exp, `Error evaluating FHIRPath expression: ${text} ${focus.describe()}`);
  }

  private async params(ctx: Ctx, focus: TD, exp: ExprNode, canBeNone: boolean, out: TD[]): Promise<void> {
    const hasExpr = ["sort", "iif", "where", "exists", "all", "select", "repeat", "aggregate", "trace", "defineVariable"].includes(String(exp.name));
    for (const p of exp.params) {
      if (hasExpr) out.push(await this.execute({ ...ctx, thisItem: focus }, focus, p, true, canBeNone));
      else out.push(await this.execute(ctx, ctx.thisItem, p, true, canBeNone));
    }
  }

  private async functionType(ctx: Ctx, focus: TD, exp: ExprNode): Promise<TD> {
    const f = String(exp.name);
    const bool = (): TD => new TD("SINGLETON", FP.Boolean);
    const int = (): TD => new TD("SINGLETON", FP.Integer);
    const str = (): TD => new TD("SINGLETON", FP.String);
    const paramTypes: TD[] = [];
    if (["is", "as", "ofType"].includes(f)) paramTypes.push(str());
    else if (f === "repeat" && exp.params.length === 1) {
      const base = new TD(null);
      let lFocus = focus;
      for (let round = 0; round < 12; round++) {
        paramTypes.length = 0;
        await this.params(ctx, lFocus, exp, true, paramTypes);
        const before = base.types.length;
        base.update(paramTypes[0]);
        if (base.types.length === before) break;
        lFocus = base;
      }
      paramTypes.length = 0;
      paramTypes.push(base);
    } else if (["where", "select", "exists", "all", "allTrue", "anyTrue", "allFalse", "anyFalse"].includes(f)) await this.params(ctx, focus.singleton(), exp, false, paramTypes);
    else await this.params(ctx, focus, exp, false, paramTypes);
    switch (f) {
      case "empty": case "not": case "isDistinct": case "anyTrue": case "allTrue": case "anyFalse": case "allFalse": case "hasValue":
      case "htmlChecks": case "htmlChecks2": case "comparable":
        return bool();
      case "exists": case "all":
        await this.checkParams(exp, paramTypes, bool());
        return bool();
      case "subsetOf":
        await this.checkParams(exp, paramTypes, focus.unordered());
        return bool();
      case "supersetOf":
        await this.checkParams(exp, paramTypes, focus);
        return bool();
      case "distinct": case "single": case "debug": case "exclude":
        return f === "single" ? focus.singleton() : focus;
      case "count":
        return int();
      case "where":
        await this.checkParams(exp, paramTypes, bool());
        return focus;
      case "select": case "repeat":
        return paramTypes[0];
      case "aggregate": {
        const a = new TD(focus.status);
        a.any = true;
        return a;
      }
      case "item":
        this.checkOrdered(focus, "item", exp);
        await this.checkParams(exp, paramTypes, int());
        return focus.singleton();
      case "as": case "ofType": {
        const p = exp.params[0];
        let tn = p.inner ? `${p.name}.${p.inner.name}` : `FHIR.${p.name}`;
        // checkType: "System." is only cut off, so ProfiledType.ns puts the name in the FHIR namespace
        if (tn.startsWith("System.")) tn = tn.slice(7);
        else if (tn.startsWith("FHIR.")) tn = `${CORE}${tn.slice(5)}`;
        else if (tn.startsWith("CDA.")) tn = `http://hl7.org/cda/stds/core/StructureDefinition/${tn.slice(4)}`;
        return new TD("SINGLETON", tn);
      }
      case "type": {
        const s = focus.types.some((t) => t.startsWith(FP_NS));
        const c = focus.types.some((t) => !t.startsWith(FP_NS));
        return s && c ? new TD("SINGLETON", FP.SimpleTypeInfo, FP.ClassInfo) : s ? new TD("SINGLETON", FP.SimpleTypeInfo) : new TD("SINGLETON", FP.ClassInfo);
      }
      case "is":
        return bool();
      case "first": case "last":
        this.checkOrdered(focus, f, exp);
        return focus.singleton();
      case "tail":
        this.checkOrdered(focus, f, exp);
        return focus;
      case "skip": case "take":
        this.checkOrdered(focus, f, exp);
        await this.checkParams(exp, paramTypes, int());
        return focus;
      case "union": case "combine":
        return focus.union(paramTypes[0]);
      case "intersect": {
        const r = new TD(focus.status === "UNORDERED" || paramTypes[0].status === "UNORDERED" ? "UNORDERED" : "ORDERED", ...focus.types.filter((t) => paramTypes[0].types.includes(t)));
        r.any = focus.any || paramTypes[0].any;
        return r;
      }
      case "iif": {
        await this.checkParams(exp, paramTypes, bool());
        const r = new TD(null);
        r.update(paramTypes[1]);
        if (paramTypes.length > 2) r.update(paramTypes[2]);
        return r;
      }
      case "lower": case "upper":
        await this.contextString(focus, f, exp);
        return str();
      case "toChars":
        await this.contextString(focus, f, exp);
        return new TD("ORDERED", FP.String);
      case "indexOf":
        await this.contextString(focus, f, exp);
        await this.checkParams(exp, paramTypes, str());
        return int();
      case "substring":
        await this.contextString(focus, "subString", exp);
        await this.checkParams(exp, paramTypes, int(), int());
        return str();
      case "startsWith": case "endsWith": case "matches": case "matchesFull": case "contains":
        await this.contextString(focus, f === "matchesFull" ? "matches" : f, exp);
        await this.checkParams(exp, paramTypes, str());
        return bool();
      case "replaceMatches": case "replace":
        await this.contextString(focus, f, exp);
        await this.checkParams(exp, paramTypes, str(), str());
        return str();
      case "length":
        this.contextPrimitive(focus, "length", false, exp);
        return int();
      case "children": case "descendants": {
        const r = new TD("UNORDERED");
        r.any = true;
        return r;
      }
      case "memberOf":
        await this.contextOne(focus, ["string", "code", "uri", "Coding", "CodeableConcept"], "The function memberOf can only be used on ordered string, code, uri, Coding, CodeableConcept but found", exp);
        await this.checkParams(exp, paramTypes, str());
        return bool();
      case "trace": case "check":
        await this.checkParams(exp, paramTypes, str());
        return focus;
      case "defineVariable": {
        await this.checkParams(exp, paramTypes, new TD("UNORDERED", FP.String));
        const p = exp.params[0];
        if (p.kind === "Constant" && p.text !== undefined) ctx.vars.set(p.text, paramTypes.length > 1 ? paramTypes[1] : focus);
        return focus;
      }
      case "today": case "now":
        return new TD("SINGLETON", FP.DateTime);
      case "resolve": {
        await this.contextOne(focus, ["string", "uri", "url", "Reference", "canonical"], "The function resolve can only be used on ordered string, uri, canonical or Reference but found", exp);
        return new TD(focus.status, "Resource");
      }
      case "extension": {
        await this.checkParams(exp, paramTypes, str());
        const p = exp.params[0];
        if (p.kind === "Constant" && p.text !== undefined && /^[a-z]+:/i.test(p.text)) {
          const sd = await this.deps.fetch(p.text);
          if (sd) return new TD("ORDERED", String(sd.url));
        }
        return new TD("SINGLETON", "Extension");
      }
      case "encode": case "decode": case "escape": case "unescape": case "join":
        await this.checkParams(exp, paramTypes, str());
        return str();
      case "trim":
        return str();
      case "split":
        await this.checkParams(exp, paramTypes, str());
        return new TD("ORDERED", FP.String);
      case "toInteger":
        this.contextPrimitive(focus, f, true, exp);
        return int();
      case "toDecimal":
        this.contextPrimitive(focus, f, true, exp);
        return new TD("SINGLETON", FP.Decimal);
      case "toString":
        this.contextPrimitive(focus, f, true, exp);
        return str();
      case "toQuantity":
        this.contextPrimitive(focus, f, true, exp);
        return new TD("SINGLETON", FP.Quantity);
      case "toBoolean":
        this.contextPrimitive(focus, f, false, exp);
        return bool();
      case "toDateTime":
        this.contextPrimitive(focus, "ToDateTime", false, exp);
        return new TD("SINGLETON", FP.DateTime);
      case "toTime":
        this.contextPrimitive(focus, "ToTime", false, exp);
        return new TD("SINGLETON", FP.Time);
      case "convertsToString": case "convertsToQuantity":
        this.contextPrimitive(focus, f, true, exp);
        return bool();
      case "convertsToInteger": case "convertsToDecimal": case "convertsToDateTime": case "convertsToDate": case "convertsToTime": case "convertsToBoolean":
        this.contextPrimitive(focus, f, false, exp);
        return bool();
      case "conformsTo": case "hasTemplateIdOf":
        await this.checkParams(exp, paramTypes, str());
        return bool();
      case "sort": {
        const r = new TD("ORDERED", ...focus.types);
        r.any = focus.any;
        return r;
      }
      case "coalesce": {
        const r = new TD(null);
        for (const t of paramTypes) r.update(t);
        return r;
      }
      case "abs": case "exp": case "ln": case "sqrt": case "log": case "power": {
        if (!focus.any && !focus.hasNoTypes() && !focus.has("integer") && !focus.has("decimal") && !focus.has("Quantity")) {
          throw fail(exp, `Error evaluating FHIRPath expression: The function ${f} can only be used on integer, decimal or Quantity but found ${focus.describe()}`);
        }
        return f === "abs" || f === "power" ? new TD("SINGLETON", ...focus.types) : new TD("SINGLETON", FP.Decimal);
      }
      case "truncate": case "floor": case "ceiling": case "round": {
        if (!focus.any && !focus.hasNoTypes() && !focus.has("decimal") && !focus.has("integer")) {
          throw fail(exp, `Error evaluating FHIRPath expression: The function ${f} can only be used on a decimal but found ${focus.describe()}`);
        }
        if (f === "round" && paramTypes.length) await this.checkParams(exp, paramTypes, int());
        return f === "round" ? new TD("SINGLETON", FP.Decimal) : int();
      }
      case "lowBoundary": case "highBoundary": case "precision": {
        const ok = focus.any || focus.hasNoTypes() || ["decimal", "date", "dateTime", "time", "Quantity"].some((n) => focus.has(n)) || (f !== "precision" && focus.has("integer"));
        if (!ok) throw fail(exp, `Error evaluating FHIRPath expression: The function ${f} can only be used on a decimal or date type but found ${focus.describe()}`);
        if (f === "precision") return int();
        return new TD("SINGLETON", FP.DateTime);
      }
      case "section":
        await this.checkParams(exp, paramTypes, str());
        return new TD("SINGLETON", "Composition.section");
      case "entry":
        await this.checkParams(exp, paramTypes, str());
        return new TD("SINGLETON", "Resource");
      default: {
        const r = new TD(focus.status);
        r.any = true;
        return r;
      }
    }
  }

  private constantType(ctx: Ctx, exp: ExprNode): TD {
    const c = exp.constant;
    if (c === "BooleanType") return new TD("SINGLETON", FP.Boolean);
    if (c === "IntegerType") return new TD("SINGLETON", FP.Integer);
    if (c === "DecimalType") return new TD("SINGLETON", FP.Decimal);
    if (c === "Quantity") return new TD("SINGLETON", FP.Quantity);
    if (c === null || c === undefined) return new TD("SINGLETON");
    if (c !== "FHIRConstant") return new TD("SINGLETON", FP.String);
    const s = String(exp.text);
    if (s.startsWith("@")) return new TD("SINGLETON", s.startsWith("@T") ? FP.Time : FP.DateTime);
    if (["%sct", "%loinc", "%ucum", "%map-codes", "%us-zip"].includes(s) || /^%`(vs|cs|ext)-/.test(s)) return new TD("SINGLETON", FP.String);
    if (s === "%resource") return new TD("SINGLETON", ctx.resource);
    if (s === "%rootResource") return new TD("SINGLETON", ctx.rootResource);
    if (s === "%context") return ctx.context;
    const v = ctx.vars.get(s.slice(1));
    if (v) return v;
    throw fail(exp, `Error evaluating FHIRPath expression: Invalid FHIRPath Constant ${s}`);
  }

  private async nameType(type: string, exp: ExprNode, atEntry: boolean, focus: TD): Promise<TD> {
    const name = String(exp.name);
    if (atEntry && /^\p{Lu}/u.test(name)) {
      const tail = type.includes("#") ? "" : type.slice(type.lastIndexOf("/") + 1);
      if (tail === name) return new TD("SINGLETON", type);
      let sd = await this.deps.fetch(ns(type));
      while (sd) {
        if (sd.type === name) return new TD("SINGLETON", type);
        sd = sd.baseDefinition ? await this.deps.fetch(String(sd.baseDefinition)) : null;
      }
    }
    const result = new TD(focus.status);
    await this.childTypes(type, name, result, exp);
    return result;
  }

  private async operate(left: TD, op: string, right: TD, holder: ExprNode): Promise<TD> {
    const bool = new TD("SINGLETON", FP.Boolean);
    const r = new TD("SINGLETON");
    const num = (t: TD): Promise<boolean> => this.hasW(t, "integer", "decimal");
    switch (op) {
      case "=": case "~": case "!=": case "!~": case "<": case ">": case "<=": case ">=": case "is": case "or": case "and": case "xor": case "implies": case "in": case "contains": case "memberOf":
        return bool;
      case "as": {
        const a = new TD("SINGLETON", ...right.types);
        a.any = right.any;
        return a;
      }
      case "|":
        return left.union(right);
      case "&":
        return new TD("SINGLETON", FP.String);
      case "*": case "div": case "mod": case "+": case "-": {
        if ((await this.hasW(left, "integer")) && (await this.hasW(right, "integer"))) r.add(FP.Integer);
        else if ((await num(left)) && (await num(right))) r.add(FP.Decimal);
        else if (op === "+" && (await this.hasW(left, ...STRINGISH.slice(0, 3), "id")) && (await this.hasW(right, ...STRINGISH.slice(0, 3), "id"))) r.add(FP.String);
        else if (op === "-" && (await this.hasW(left, "Quantity")) && (await this.hasW(right, "Quantity"))) r.add(FP.Quantity);
        else if ((op === "+" || op === "-") && (await this.hasW(left, "date", "dateTime", "instant"))) {
          if (await this.hasW(right, "Quantity")) r.add(left.types[0]);
          else throw new PathEngineError(`Error in date arithmetic: Unable to ${op === "+" ? "add" : "subtract"} type ${right.types[0]} to ${left.types[0]} (@char ${holder.opCol ?? 1})`);
        }
        r.any = left.any || right.any;
        return r;
      }
      case "/":
        if ((await num(left)) && (await num(right))) r.add(FP.Decimal);
        r.any = left.any || right.any;
        return r;
      default:
        r.any = true;
        return r;
    }
  }

  async execute(ctx: Ctx, focus: TD, exp: ExprNode, atEntry: boolean, canBeNone: boolean): Promise<TD> {
    let result = new TD(null);
    switch (exp.kind) {
      case "Name":
        if (atEntry && exp.name === "$this") result.update(ctx.thisItem);
        else if (atEntry && exp.name === "$total") result.any = true;
        else if (atEntry && exp.name === "$index") result.add(FP.Integer);
        else {
          for (const s of focus.types) result.update(await this.nameType(s, exp, atEntry, focus));
          result.any ||= focus.any;
          if (result.hasNoTypes() && !result.any && !canBeNone) {
            throw fail(exp, `Error evaluating FHIRPath expression: The name '${exp.name}' is not valid for any of the possible types: ${focus.describe()}`);
          }
        }
        break;
      case "Function":
        result.update(await this.functionType(ctx, focus, exp));
        break;
      case "Unary":
        result.add(FP.Integer);
        result.add(FP.Decimal);
        result.add(FP.Quantity);
        break;
      case "Constant":
        result.update(this.constantType(ctx, exp));
        break;
      case "Group":
        result.update(await this.execute(ctx, focus, exp.group as ExprNode, atEntry, canBeNone));
        break;
    }
    if (exp.inner) result = await this.execute(ctx, result, exp.inner, false, false);
    if (exp.proximal && exp.operation) {
      let next = exp.opNext;
      let last: ExprNode = exp;
      while (next) {
        const work = last.operation === "is" || last.operation === "as" ? new TD("SINGLETON", String(next.name)) : await this.execute(ctx, focus, next, atEntry, canBeNone);
        result = await this.operate(result, String(last.operation), work, last);
        last = next;
        next = next.opNext;
      }
    }
    return result;
  }
}

/**
 * fpe.check(null, resourceType, resourceType, context, expr) for a context that is a type name. Throws PathEngineError
 * with Java's text; an unknown context type is FHIRPATH_UNKNOWN_CONTEXT. Operators are read left to right (the type
 * outcome of organisePrecedence's grouping differs only for a mixed chain of arithmetic over operands of several types).
 */
export async function checkFhirPathJava(expr: ExprNode, resourceType: string, context: string, deps: PathCheckDeps): Promise<void> {
  const sd = await deps.fetch(ns(context));
  if (!sd) throw fail(expr, `Unknown context evaluating FHIRPath expression: ${context}`);
  const types = new TD("SINGLETON", String(sd.url));
  await new Checker(deps).execute({ rootResource: resourceType, resource: resourceType, context: types, thisItem: types, vars: new Map() }, types, expr, true, false);
}
