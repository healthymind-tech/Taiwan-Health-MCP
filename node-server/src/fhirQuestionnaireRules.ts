/**
 * Port of instance/type/QuestionnaireValidator.java and instance/utils/EnableWhenEvaluator.java (validator_cli 7.0.1)
 * for R4: a Questionnaire's enableWhen links, and a QuestionnaireResponse against its Questionnaire. Message text is
 * Messages.properties verbatim. Pure over ValidatorDeps, with paths in the JSON form the validator uses
 * (`valueCoding`, where the jar prints `value.ofType(Coding)`).
 *
 * R4 item types arrive in the Java model converted: choice -> coding, open-choice -> coding + optionsOrString.
 *
 * Not ported:
 *  - Questionnaire.derivedFrom (checkDerivations, validateQuestionnaireElementDerivation) and the answerValueSet
 *    parameters of validateQuestionnaireElement.
 *  - checkAuthoringDate (warnings only).
 *  - launch contexts and x-fhir-query variables of an enableWhenExpression (collectVariables): an expression naming a
 *    variable is left enabled, as Java does for a variable it cannot supply; the Uncheckable warning is not raised.
 *  - {3} of Questionnaire_QR_Item_BadOption is the terminology server's text; here it is the local "not found" wording.
 */

type Json = Record<string, any>;

export interface QuestionnaireIssue {
  severity: "error" | "warning" | "information";
  path: string;
  code: string;
  message: string;
}

export interface QuestionnaireDeps {
  fetchQuestionnaire(url: string): Promise<Json | null>;
  valueSetKnown(url: string): Promise<boolean>;
  /** undefined: not decidable here (no error is raised). */
  member(valueSet: string, system: string | null, code: string): Promise<boolean | undefined>;
  /** evaluateToBoolean on the QuestionnaireResponse; undefined when the expression cannot be evaluated. */
  evaluate(expression: string, response: Json): boolean | undefined;
  ucumCanonical(value: string, code: string): { value: string; code: string } | null;
  assumeValidRestReferences: boolean;
  isResourceName(name: string): boolean;
}

const EXT = "http://hl7.org/fhir/StructureDefinition/";
const EXT_MINVALUE = `${EXT}minValue`;
const EXT_MAXVALUE = `${EXT}maxValue`;
const EXT_MAX_DECIMALS = `${EXT}maxDecimalPlaces`;
const EXT_MIN_LENGTH = `${EXT}minLength`;
const EXT_REGEX = `${EXT}regex`;
const EXT_ENTRY_FORMAT = `${EXT}entryFormat`;
const EXT_MIMETYPE = `${EXT}mimeType`;
const EXT_MAX_SIZE = `${EXT}maxSize`;
const EXT_MAXOCCURS = `${EXT}questionnaire-maxOccurs`;
const EXT_MINOCCURS = `${EXT}questionnaire-minOccurs`;
const EXT_EXCLUSIVE = `${EXT}questionnaire-optionExclusive`;
const EXT_ALLOWEDRESOURCE = `${EXT}questionnaire-referenceResource`;
const EXT_UNIT_OPTION = `${EXT}questionnaire-unitOption`;
const EXT_UNIT_VALUESET = `${EXT}questionnaire-unitValueSet`;
const EXT_MIN_QUANTITY = "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-minQuantity";
const EXT_MAX_QUANTITY = "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-maxQuantity";
const EXT_ENABLE_WHEN_EXPRESSION = "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-enableWhenExpression";
const EXT_ENABLE_WHEN_FI = "http://phr.kanta.fi/StructureDefinition/fiphr-ext-questionnaire-enablewhen";
const UCUM = "http://unitsofmeasure.org";
const SNOMED = "http://snomed.info/sct";

const PRIMITIVES = new Set(["boolean", "decimal", "integer", "date", "dateTime", "time", "string", "uri", "url", "canonical", "code", "id", "markdown", "instant", "oid", "uuid", "positiveInt", "unsignedInt", "base64Binary"]);

const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (x: unknown): any[] => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
const noString = (s: unknown): boolean => typeof s !== "string" || s === "";
const extensionsOf = (e: Json, url: string): Json[] => list(e.extension).filter((x) => isObject(x) && x.url === url);
const firstExtension = (e: Json, url: string): Json | null => extensionsOf(e, url)[0] ?? null;
/** MessageFormat's rendering of an int argument. */
const grouped = (n: number): string => n.toLocaleString("en-US");
/** The answer value types of QuestionnaireResponse.item.answer: anything else was dropped by the parser. */
const ANSWER_KEYS = new Set(["valueBoolean", "valueDecimal", "valueInteger", "valueDate", "valueDateTime", "valueTime", "valueString", "valueUri", "valueAttachment", "valueCoding", "valueQuantity", "valueReference"]);
/** R4 item.type in the Java model: `question` converts to group (it has no answers of its own). */
const itemType = (q: Json): unknown => (q.type === "question" ? "group" : q.type);
const CONSTRAINT = "http://hl7.org/fhir/5.0/StructureDefinition/extension-Questionnaire.item.answerConstraint";
/** QuestionnaireValidator.constraintOf + the R4 conversion: the extension, else open-choice -> optionsOrString. */
const constraintOf = (q: Json): string => (extensionPrimitive(firstExtension(q, CONSTRAINT)) ?? (q.type === "open-choice" ? "optionsOrString" : "optionsOnly"));

/** The value[x] of an element: JSON name, and fhirType. */
function valueOf(e: Json): { key: string; value: any; type: string } | null {
  for (const k of Object.keys(e)) {
    if (!/^value[A-Z]/.test(k)) continue;
    const t = k.slice(5);
    const lower = t.charAt(0).toLowerCase() + t.slice(1);
    return { key: k, value: e[k], type: PRIMITIVES.has(lower) ? lower : t };
  }
  return null;
}
const primitiveOf = (x: { value: any } | null): string | null => (x === null || x.value === null || typeof x.value === "object" ? null : String(x.value));
const extensionPrimitive = (e: Json | null): string | null => (e ? primitiveOf(valueOf(e)) : null);
const integerExtension = (item: Json, url: string): number => {
  const v = Number(extensionPrimitive(firstExtension(item, url)));
  return Number.isInteger(v) ? v : -1;
};

/** BaseDateTimeType value, for before / after. */
function instantOf(v: string): number {
  const m = /^(-?\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(T.*)?$/.exec(v);
  if (!m) return NaN;
  const time = m[4] ? (/(Z|[+-]\d{2}:\d{2})$/.test(m[4]) ? m[4] : `${m[4]}Z`) : "T00:00:00Z";
  return Date.parse(`${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}${time}`);
}

function precision(v: string): number {
  return v.includes(".") ? v.length - v.lastIndexOf(".") - 1 : 0;
}

/** Questionnaire.getCommonGroup: the innermost item holding both. */
function contains(item: Json, q: Json): boolean {
  return item === q || list(item.item).some((i) => isObject(i) && contains(i, q));
}
function commonGroup(item: Json, q1: Json, q2: Json): Json | null {
  for (const i of list(item.item)) {
    if (!isObject(i)) continue;
    const t = commonGroup(i, q1, q2);
    if (t) return t;
  }
  return contains(item, q1) && contains(item, q2) ? item : null;
}
function findItem(items: unknown, linkId: string): Json | null {
  for (const i of list(items)) {
    if (!isObject(i)) continue;
    if (i.linkId === linkId) return i;
    const t = findItem(i.item, linkId);
    if (t) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- Questionnaire

/** QuestionnaireValidator.validateQuestionnaireElement l. 226-254: the enableWhen links. */
export function validateQuestionnaire(q: Json, path: string): QuestionnaireIssue[] {
  const out: QuestionnaireIssue[] = [];
  const isBefore = (item: Json, tgt: Json, parents: Json[]): boolean => {
    if (parents.includes(tgt)) return true;
    const indexIn = (p: Json, d: Json): number => {
      // getChildList: the items are in document order among the parent's children
      const kids = list(p.item).filter(isObject);
      return kids.findIndex((k) => contains(k, d));
    };
    for (const p of parents) {
      const i = indexIn(p, item);
      const t = indexIn(p, tgt);
      if (i > -1 && t > -1) return i > t;
    }
    return false;
  };
  const walk = (element: Json, at: string, parents: Json[]): void => {
    list(element.item).forEach((item, n) => {
      if (!isObject(item)) return;
      const ns = `${at}.item[${n}]`;
      const rule = (message: string): void => {
        out.push({ severity: "error", path: ns, code: "business-rule", message });
      };
      for (const ew of list(item.enableWhen)) {
        const ql = isObject(ew) && typeof ew.question === "string" ? ew.question : null;
        if (ql === null) {
          rule("Questions with an enableWhen must have a value for the question link");
          continue;
        }
        if (findItem(item.item, ql)) {
          rule("Questions with an enableWhen cannot refer to an inner question for its enableWhen condition");
          continue;
        }
        const tgt = findItem(q.item, ql);
        if (!tgt) rule(`Unable to find an item with the linkId '${ql}' which is referenced in the enableWhen for '${item.linkId}'`);
        else if (tgt === item) rule("Target for this question enableWhen can't reference itself");
        else if (!isBefore(item, tgt, parents)) out.push({ severity: "warning", path: ns, code: "business-rule", message: `The target of this enableWhen rule (${ql}) comes after the question itself` });
      }
      walk(item, ns, [item, ...parents]);
    });
  };
  walk(q, path, [q]);
  return out;
}

// ---------------------------------------------------------------------------------------------- response

interface StackEntry {
  q: Json;
  a: Json;
}

class ResponseValidator {
  readonly out: QuestionnaireIssue[] = [];

  constructor(
    private readonly q: Json,
    private readonly response: Json,
    private readonly notCompleted: boolean,
    private readonly deps: QuestionnaireDeps,
  ) {}

  private rule(ok: boolean, path: string, message: string, code = "invalid"): boolean {
    if (!ok) this.out.push({ severity: "error", path, code, message });
    return ok;
  }
  private warning(ok: boolean, path: string, message: string): void {
    if (!ok) this.out.push({ severity: "warning", path, code: "invalid", message });
  }
  private hint(path: string, message: string): void {
    this.out.push({ severity: "information", path, code: "invalid", message });
  }

  // ------------------------------------------------------------------------- EnableWhenEvaluator

  private answersOf(item: Json): any[] {
    // extractAnswer: every child of each answer (value[x], item, extension)
    return list(item.answer).filter(isObject).flatMap((a) => Object.entries(a).filter(([k]) => /^value[A-Z]/.test(k)).map(([key, value]) => ({ key, value })));
  }

  private findOnItem(focus: Json, question: string): Array<{ key: string; value: any }> {
    const out: Array<{ key: string; value: any }> = [];
    for (const item of list(focus.item).filter(isObject)) {
      if (item.linkId === question) out.push(...this.answersOf(item));
      out.push(...this.findOnItem(item, question));
    }
    for (const answer of list(focus.answer).filter(isObject)) out.push(...this.findOnItem(answer, question));
    if (focus.linkId === question) out.push(...this.answersOf(focus));
    return out;
  }

  private compare(result: number, operator: string): boolean {
    switch (operator) {
      case "=":
        return result === 0;
      case "!=":
        return result !== 0;
      case ">=":
        return result >= 0;
      case "<=":
        return result <= 0;
      case "<":
        return result < 0;
      case ">":
        return result > 0;
      default:
        return false;
    }
  }

  private evaluateAnswer(answer: { key: string; value: any }, expected: { key: string; value: any }, operator: string): boolean {
    if (answer.key !== expected.key) return false; // Java raises UnprocessableEntityException: "incompatible types"
    const a = answer.value;
    const e = expected.value;
    if (answer.key === "valueCoding") {
      if (!isObject(a) || !isObject(e)) return false;
      const systems = e.system === undefined || (a.system !== undefined && a.system === e.system);
      const codes = (e.code !== undefined) === (a.code !== undefined) && (e.code === undefined || e.code === a.code);
      const same = systems && codes;
      return operator === "=" ? same : operator === "!=" ? !same : false;
    }
    if (answer.key === "valueQuantity") {
      if (!isObject(a) || !isObject(e)) return false;
      return this.compare(Math.sign(Number(a.value) - Number(e.value)), operator);
    }
    if (typeof a === "number" && typeof e === "number") return this.compare(Math.sign(a - e), operator);
    if (typeof a === "boolean" && typeof e === "boolean") return this.compare(Number(a) - Number(e), operator);
    if (answer.key === "valueDate" || answer.key === "valueDateTime") return this.compare(Math.sign(instantOf(String(a)) - instantOf(String(e))), operator);
    return this.compare(String(a) < String(e) ? -1 : String(a) > String(e) ? 1 : 0, operator);
  }

  private questionAnswers(qitem: Json, question: string, qstack: StackEntry[]): Array<{ key: string; value: any }> {
    const target = findItem(this.q.item, question);
    if (!target) return [];
    let group: Json | null = null;
    for (const i of list(this.q.item).filter(isObject)) {
      group = commonGroup(i, qitem, target);
      if (group) break;
    }
    if (!group) return this.findOnItem(this.response, question);
    for (let i = qstack.length - 1; i >= 0; i--) if (qstack[i].q === group) return this.findOnItem(qstack[i].a, question);
    return [];
  }

  /** EnableWhenEvaluator.checkQuestionEnabled l. 234-262 (without collectVariables, see the module comment). */
  private isEnabled(qitem: Json, qstack: StackEntry[]): boolean {
    const fi = extensionPrimitive(firstExtension(qitem, EXT_ENABLE_WHEN_FI));
    const expr = firstExtension(qitem, EXT_ENABLE_WHEN_EXPRESSION);
    const expression = fi ?? (expr && isObject(expr.valueExpression) && expr.valueExpression.language === "text/fhirpath" ? expr.valueExpression.expression : null);
    if (typeof expression === "string") {
      if (/%(?!resource\b|rootResource\b|context\b|sct\b|loinc\b|ucum\b|`)/.test(expression)) return true;
      return this.deps.evaluate(expression, this.response) ?? true;
    }
    const conditions = list(qitem.enableWhen).filter(isObject);
    if (!conditions.length) return true;
    const results = conditions.map((c) => {
      const found = this.questionAnswers(qitem, String(c.question), qstack);
      // enableWhen.answer[x], in the value[x] form of the answers it is compared with
      const answerKey = Object.keys(c).find((k) => /^answer[A-Z]/.test(k));
      const expected = answerKey ? { key: `value${answerKey.slice(6)}`, value: c[answerKey] } : null;
      if (c.operator === "exists") return expected?.value === (found.length > 0);
      if (!expected) return false;
      return found.some((a) => this.evaluateAnswer(a, expected, String(c.operator)));
    });
    // checkConditionResults
    if (qitem.enableBehavior === "any" || results.length === 1) return results.some(Boolean);
    if (qitem.enableBehavior === "all") return results.every(Boolean);
    return true;
  }

  // ------------------------------------------------------------------------- items

  /** validateQuestionannaireResponseItems l. 862-901. */
  async items(qItems: Json[], element: Json, stack: string, qstack: StackEntry[]): Promise<void> {
    const byLink = new Map<string, Array<{ element: Json; index: number }>>();
    let lastIndex = -1;
    let counter = 0;
    for (const item of list(element.item)) {
      if (!isObject(item)) {
        counter++;
        continue;
      }
      const linkId = item.linkId;
      if (this.rule(!noString(linkId), stack, "No LinkId, so can't be validated", "required")) {
        const index = qItems.findIndex((q) => q.linkId === linkId);
        if (index === -1) {
          const qItem = findItem(this.q.item, linkId);
          if (qItem) {
            this.rule(false, stack, typeof qItem.linkId === "string" ? `Structural Error: item with linkid ${qItem.linkId} is in the wrong place` : "Structural Error: item is in the wrong place", "structure");
            await this.item(qItem, item, `${stack}.item[${counter}]`, [...qstack, { q: qItem, a: item }]);
          } else {
            this.rule(false, stack, `LinkId '${linkId}' not found in questionnaire`, "not-found");
          }
        } else {
          this.rule(index >= lastIndex, stack, "Structural Error: items are out of order", "structure");
          lastIndex = index;
          byLink.set(linkId, [...(byLink.get(linkId) ?? []), { element: item, index: counter }]);
        }
      }
      counter++;
    }
    for (const qItem of qItems) await this.itemGroup(qItem, byLink.get(qItem.linkId) ?? null, element, stack, qstack);
  }

  /** validateQuestionnaireResponseItem l. 903-949. */
  private async itemGroup(qItem: Json, mapItem: Array<{ element: Json; index: number }> | null, element: Json, stack: string, qstack: StackEntry[]): Promise<void> {
    const enabled = this.isEnabled(qItem, qstack);
    if (mapItem) {
      if (!enabled) {
        for (const e of mapItem) {
          if (list(e.element.answer).length || list(e.element.item).length) {
            this.rule(false, `${stack}.item[${e.index}]`, `Item has answer, even though it is not enabled (item id = '${qItem.linkId}')`);
          }
        }
      }
      if (mapItem.length > 1) this.rule(qItem.repeats === true, stack, `Only one response item with the linkId ${qItem.linkId} allowed - found ${mapItem.length} items`);
      for (const e of mapItem) await this.item(qItem, e.element, `${stack}.item[${e.index}]`, [...qstack, { q: qItem, a: e.element }]);
    } else if (enabled && qItem.required === true) {
      const message = `No response answer found for required item '${qItem.linkId}'`;
      if (this.notCompleted) this.warning(false, stack, message);
      else this.rule(false, stack, message, "required");
    }
  }

  /** validateQuestionnaireResponseItem l. 587-733. */
  private async item(qItem: Json, element: Json, stack: string, qstack: StackEntry[]): Promise<void> {
    const text = element.text;
    this.rule(noString(text) || text === qItem.text, stack, `If text exists, it must match the questionnaire definition for linkId ${qItem.linkId}`);
    const answers = list(element.answer).filter(isObject);
    const fulfilled = answers.length > 0 || qItem.required !== true || itemType(qItem) === "group";
    const missing = `No response answer found for required item '${qItem.linkId}'`;
    if (this.notCompleted) this.warning(fulfilled, stack, missing);
    else if (this.isEnabled(qItem, qstack)) this.rule(fulfilled, stack, missing, "required");
    if (answers.length > 1) this.rule(qItem.repeats === true, stack, "Only one response answer item with this linkId allowed");
    if (firstExtension(qItem, EXT_MAXOCCURS)) {
      const mo = integerExtension(qItem, EXT_MAXOCCURS);
      this.rule(mo < 0 || answers.length <= mo, stack, `The maximum number of answers is ${grouped(mo)} but this has ${grouped(answers.length)} answers`);
    }
    if (firstExtension(qItem, EXT_MINOCCURS)) {
      const mo = integerExtension(qItem, EXT_MINOCCURS);
      this.rule(mo < 0 || answers.length >= mo, stack, `The minimum number of answers is ${grouped(mo)} but this has ${grouped(answers.length)} answers`);
    }
    const type = itemType(qItem);
    for (let i = 0; i < answers.length; i++) {
      await this.answer(qItem, answers[i], `${stack}.answer[${i}]`, stack, answers.length);
      // the items of an answer are reported on the item's stack (l. 703)
      if (type !== "group") await this.items(list(qItem.item).filter(isObject), answers[i], stack, qstack);
    }
    const subItems = list(element.item);
    if (typeof type !== "string") {
      this.rule(false, stack, `Definition for item ${qItem.linkId} does not contain a type`, "required");
    } else if (type === "display") {
      this.rule(!subItems.length, stack, `Items not of type DISPLAY should not have items - linkId ${qItem.linkId}`, "structure");
    } else if (type !== "group") {
      this.rule(!subItems.length, stack, "Items not of type group should not have items outside answers (use answer.item not .item)", "structure");
    } else {
      this.rule(qItem.required !== true || subItems.length > 0, stack, "No sub-items found for required group", "invariant");
      await this.items(list(qItem.item).filter(isObject), element, stack, qstack);
    }
  }

  private checkType(answer: Json, ns: string, ...types: string[]): string | null {
    const v = valueOf(answer);
    if (!v || !ANSWER_KEYS.has(v.key)) return null;
    const wanted = types.map((t) => (t === "text" ? "string" : t));
    if (wanted.some((t) => v.key === `value${t.charAt(0).toUpperCase()}${t.slice(1)}`)) return wanted.find((t) => v.key === `value${t.charAt(0).toUpperCase()}${t.slice(1)}`)!;
    const shown = wanted.join(", ");
    const message = wanted.length === 1 ? `Answer value must be of the type ${shown} not ${v.type}` : `Answer value must be one of the ${wanted.length} types ${shown} not ${v.type}`;
    this.rule(false, `${ns}.${v.key}`, message, "invariant");
    return null;
  }

  private async answer(qItem: Json, answer: Json, ns: string, stack: string, answerCount: number): Promise<void> {
    switch (itemType(qItem)) {
      case "group":
        this.rule(false, stack, "Items of type question should not have answers", "structure");
        break;
      case "display":
        this.rule(false, stack, "Items of type 'display' cannot have answers", "structure");
        break;
      case "boolean":
        this.checkType(answer, ns, "boolean");
        break;
      case "decimal":
        this.checkType(answer, ns, "decimal");
        this.decimal(answer, ns, qItem);
        break;
      case "integer":
        this.checkType(answer, ns, "integer");
        this.integer(answer, ns, qItem);
        break;
      case "date":
        this.checkType(answer, ns, "date");
        this.dateLike(answer, ns, qItem, "date");
        break;
      case "dateTime":
        this.checkType(answer, ns, "dateTime");
        this.dateLike(answer, ns, qItem, "dateTime");
        break;
      case "time":
        this.checkType(answer, ns, "time");
        this.time(answer, ns, qItem);
        break;
      case "string":
        this.checkType(answer, ns, "string");
        await this.stringAnswer(answer, ns, qItem);
        break;
      case "text":
        this.checkType(answer, ns, "text");
        break;
      case "url":
        this.checkType(answer, ns, "uri");
        break;
      case "attachment":
        this.checkType(answer, ns, "Attachment");
        this.attachment(answer, ns, qItem);
        break;
      case "reference":
        this.checkType(answer, ns, "Reference");
        this.reference(answer, ns, qItem);
        break;
      case "quantity":
        this.checkType(answer, ns, "Quantity");
        await this.quantity(answer, ns, qItem);
        break;
      case "choice":
      case "open-choice": {
        const t = this.checkType(answer, ns, "Coding", "date", "time", "integer", "string");
        const constraint = constraintOf(qItem);
        if (t === "Coding") await this.codingAnswer(answer, ns, qItem, constraint, answerCount);
        else if (t) this.option(answer, ns, qItem, t, constraint);
        break;
      }
      default:
        break;
    }
  }

  private options(qItem: Json): Json[] {
    return list(qItem.answerOption).filter(isObject);
  }

  /** The answerOption list check shared by the typed validators: values of `type`, compared as text. */
  private typedOptions(v: string, at: string, qItem: Json, key: string, noOptions: string, notIn: string): void {
    const opts = this.options(qItem);
    if (!opts.length) return;
    const values = opts.map((o) => primitiveOf(valueOf(o)) !== null && key in o ? String(o[key]) : null).filter((x): x is string => x !== null);
    if (!values.length) this.rule(false, at, noOptions, "invariant");
    else this.rule(values.includes(v), at, notIn, "invariant");
  }

  private decimal(answer: Json, ns: string, qItem: Json): void {
    const v = valueOf(answer);
    if (!v || v.type !== "decimal") return;
    const at = `${ns}.${v.key}`;
    const s = String(v.value);
    const min = extensionPrimitive(firstExtension(qItem, EXT_MINVALUE));
    const max = extensionPrimitive(firstExtension(qItem, EXT_MAXVALUE));
    if (min !== null) this.rule(Number(min) <= Number(s), at, ` The value ${s} is less than the allowed minimum of ${min}`, "invariant");
    if (max !== null) this.rule(Number(max) >= Number(s), at, `The value ${s} is greater than the allowed maximum of ${max}`, "invariant");
    const places = extensionPrimitive(firstExtension(qItem, EXT_MAX_DECIMALS));
    if (places !== null) this.rule(precision(s) <= Number(places), at, `The value ${s} has too many decimal places (limit = ${places})`, "invariant");
    const opts = this.options(qItem);
    if (opts.length) {
      const values = opts.map((o) => primitiveOf(valueOf(o))).filter((x): x is string => x !== null && !Number.isNaN(Number(x)));
      if (!values.length) this.rule(false, at, "Cannot validate decimal answer option because no option list is provided", "invariant");
      else this.rule(values.includes(s), at, `The value ${s} is not in the set of permitted values`, "invariant");
    }
  }

  private integer(answer: Json, ns: string, qItem: Json): void {
    const v = valueOf(answer);
    if (!v || v.type !== "integer") return;
    const at = `${ns}.${v.key}`;
    const n = Number(v.value);
    const min = extensionPrimitive(firstExtension(qItem, EXT_MINVALUE));
    const max = extensionPrimitive(firstExtension(qItem, EXT_MAXVALUE));
    if (min !== null) this.rule(n >= Number(min), at, `The value ${grouped(n)} is less than the allowed minimum of ${grouped(Number(min))}`, "invariant");
    if (max !== null) this.rule(n <= Number(max), at, `The value ${grouped(n)} is greater than the allowed maximum of ${grouped(Number(max))}`, "invariant");
    const opts = this.options(qItem);
    if (opts.length) {
      const values = opts.map((o) => primitiveOf(valueOf(o))).filter((x): x is string => x !== null && /^-?\d+$/.test(x));
      if (!values.length) this.rule(false, at, "Option list has no option values of type integer", "invariant");
      else this.rule(values.includes(String(v.value)), at, `The integer ${v.value} is not in the set of permitted values`, "invariant");
    }
  }

  private dateLike(answer: Json, ns: string, qItem: Json, type: "date" | "dateTime"): void {
    const v = valueOf(answer);
    if (!v || v.value === null || typeof v.value === "object") return;
    const at = `${ns}.${v.key}`;
    const s = String(v.value);
    const at0 = instantOf(s);
    const min = extensionPrimitive(firstExtension(qItem, EXT_MINVALUE));
    const max = extensionPrimitive(firstExtension(qItem, EXT_MAXVALUE));
    if (min !== null) this.rule(!(instantOf(min) > at0), at, ` The value ${s} is less than the allowed minimum of ${min}`, "invariant");
    if (max !== null) this.rule(!(instantOf(max) < at0), at, `The value ${s} is greater than the allowed maximum of ${max}`, "invariant");
    if (type === "date") this.typedOptions(s, at, qItem, "valueDate", "Option list has no option values of type date", `The date ${s} is not in the set of permitted values`);
  }

  private time(answer: Json, ns: string, qItem: Json): void {
    const v = valueOf(answer);
    if (!v || v.value === null || typeof v.value === "object") return;
    const at = `${ns}.${v.key}`;
    const s = String(v.value);
    const min = extensionPrimitive(firstExtension(qItem, EXT_MINVALUE));
    const max = extensionPrimitive(firstExtension(qItem, EXT_MAXVALUE));
    if (min !== null) this.rule(s >= min, at, ` The value ${s} is less than the allowed minimum of ${min}`, "invariant");
    if (max !== null) this.rule(s <= max, at, `The value ${s} is greater than the allowed maximum of ${max}`, "invariant");
    this.typedOptions(s, at, qItem, "valueTime", "Option list has no option values of type time", `The time ${s} is not in the set of permitted values`);
  }

  private async stringAnswer(answer: Json, ns: string, qItem: Json): Promise<void> {
    const v = valueOf(answer);
    const s = primitiveOf(v);
    if (!v || s === null) return;
    const at = `${ns}.${v.key}`;
    if (firstExtension(qItem, EXT_MIN_LENGTH)) {
      const ml = integerExtension(qItem, EXT_MIN_LENGTH);
      this.rule(ml < 0 || s.length >= ml, at, `The answer '${s}' is shorter then the required minimum length of ${grouped(ml)}`, "invariant");
    }
    if (typeof qItem.maxLength === "number") this.rule(qItem.maxLength < 0 || s.length <= qItem.maxLength, at, `The answer '${s}' is longer then the allowed maximum length of ${grouped(qItem.maxLength)}`, "invariant");
    const regex = extensionPrimitive(firstExtension(qItem, EXT_REGEX));
    if (regex !== null) {
      const format = extensionPrimitive(firstExtension(qItem, EXT_ENTRY_FORMAT));
      let matches = true;
      try {
        matches = new RegExp(`^(?:${regex})$`).test(s);
      } catch {
        matches = true; // a pattern JS cannot compile is not judged
      }
      this.rule(matches, at, format === null ? `The answer '${s}' does not conform to the required regex '${regex}'` : `The answer '${s}' does not conform to the expected format '${format}' (regex '${regex}')`, "invariant");
    }
    this.warning(!(s.includes("\r") || s.includes("\n")), at, "The answer should not contain new line characters");
    if (typeof qItem.answerValueSet === "string") {
      if (!(await this.deps.valueSetKnown(qItem.answerValueSet))) this.warning(false, at, `The value set '${qItem.answerValueSet}' could not be found`);
      else if ((await this.deps.member(qItem.answerValueSet, null, s)) === false) this.rule(false, at, `The value '${s}' is not in the list of allowed values (value set '${qItem.answerValueSet}')`, "invariant");
    }
    this.typedOptions(s, at, qItem, "valueString", "Option list has no option values of type string", `The string ${s} is not in the set of permitted values`);
  }

  private attachment(answer: Json, ns: string, qItem: Json): void {
    const v = answer.valueAttachment;
    if (!isObject(v)) return;
    const types = extensionsOf(qItem, EXT_MIMETYPE);
    if (types.length) {
      const mime = v.contentType;
      if (typeof mime !== "string") this.rule(false, ns, "A mime type is required for this answer", "required");
      else {
        const allowed = types.map((x) => extensionPrimitive(x)).filter((x): x is string => x !== null);
        this.rule(allowed.some((p) => mime.startsWith(p)), ns, `The mime type ${mime} is not valid for this answer (allowed = ${allowed.join(", ")})`, "required");
      }
    }
    if (firstExtension(qItem, EXT_MAX_SIZE) && typeof v.data === "string") {
      const max = integerExtension(qItem, EXT_MAX_SIZE);
      if (max > 0) {
        const size = Buffer.from(v.data, "base64").length;
        this.rule(size < max, ns, `The attachment is too large (allowed = ${grouped(max)}, found = ${grouped(size)})`, "required");
      }
    }
  }

  private reference(answer: Json, ns: string, qItem: Json): void {
    const v = answer.valueReference;
    if (!isObject(v) || !this.deps.assumeValidRestReferences) return;
    const ref = v.reference;
    if (typeof ref !== "string" || ref.startsWith("#")) return;
    const at = `${ns}.valueReference`;
    // BaseValidator.extractResourceType: the type segment of a `Type/id` tail
    const parts = ref.split("/");
    const historyAt = parts.indexOf("_history");
    const rt = parts.length >= 2 ? (historyAt > 1 ? parts[historyAt - 2] : parts[parts.length - 2]) : null;
    const allowed = extensionsOf(qItem, EXT_ALLOWEDRESOURCE);
    if (allowed.length) {
      if (rt === null) this.rule(false, at, "Unable to determine the resource type, so the resource type can't be checked", "invariant");
      else {
        const names = allowed.map((x) => String(x.valueCode));
        this.rule(names.includes(rt), at, `The resource type '${rt}' in the reference ${ref} is not allowed (allowed = ${names.join(",")})`, "invariant");
      }
    } else {
      this.rule(rt === null || this.deps.isResourceName(rt), at, `The resource type ${rt} in the reference ${ref} is not valid`, "invariant");
    }
  }

  private systemName(system: unknown): string {
    if (noString(system)) return "";
    return system === UCUM ? "UCUM" : system === SNOMED ? "SNOMED CT" : String(system);
  }
  private displayQuantity(q: Json): string {
    return `${q.comparator ?? ""}${q.value}${q.unit !== undefined ? ` ${q.unit}` : ""}${q.system !== undefined || q.code !== undefined ? ` (${this.systemName(q.system)}#${q.code ?? "null"})` : ""}`;
  }
  private displayCoding(c: Json): string {
    return `${c.display ?? ""}${c.system !== undefined || c.code !== undefined ? ` (${this.systemName(c.system)}#${c.code ?? "null"})` : ""}`;
  }

  private boundQuantity(at: string, v: Json, bound: Json, isMin: boolean): void {
    const label = isMin ? "minimum" : "maximum";
    const [dv, db] = [this.displayQuantity(v), this.displayQuantity(bound)];
    const outOfRange = isMin ? `The quantity ${dv} is less than the allowed minimum of ${db}` : `The quantity ${dv} is greater than the allowed maximum of ${db}`;
    if (bound.system === undefined || bound.code === undefined || v.system === undefined || v.code === undefined) {
      this.rule(false, at, `The quantity ${db} cannot be compared to the allowed ${label} of ${dv} because no formal units are specified`, "invariant");
    } else if (bound.system === v.system && bound.code === v.code) {
      this.rule(isMin ? Number(v.value) >= Number(bound.value) : Number(bound.value) >= Number(v.value), at, outOfRange, "invariant");
    } else if (bound.system === UCUM && v.system === UCUM) {
      const a = this.deps.ucumCanonical(String(v.value), String(v.code));
      const b = this.deps.ucumCanonical(String(bound.value), String(bound.code));
      if (a && b && a.code === b.code) this.rule(isMin ? Number(a.value) >= Number(b.value) : Number(a.value) <= Number(b.value), at, outOfRange, "invariant");
      else this.rule(false, at, `The quantity ${db} cannot be compared to the allowed ${label} of ${dv}`, "invariant");
    } else {
      this.rule(false, at, `The quantity ${db} cannot be compared to the allowed ${label} of ${dv}`, "invariant");
    }
  }

  private async quantity(answer: Json, ns: string, qItem: Json): Promise<void> {
    const v = answer.valueQuantity;
    if (!isObject(v)) return;
    const at = `${ns}.valueQuantity`;
    const min = firstExtension(qItem, EXT_MIN_QUANTITY)?.valueQuantity;
    const max = firstExtension(qItem, EXT_MAX_QUANTITY)?.valueQuantity;
    if (isObject(min)) this.boundQuantity(at, v, min, true);
    if (isObject(max)) this.boundQuantity(at, v, max, false);
    const places = extensionPrimitive(firstExtension(qItem, EXT_MAX_DECIMALS));
    if (places !== null) this.rule(precision(String(v.value)) <= Number(places), at, `The value ${v.value} has too many decimal places (limit = ${places})`, "invariant");
    const units = extensionsOf(qItem, EXT_UNIT_OPTION).map((x) => x.valueCoding).filter(isObject);
    if (extensionsOf(qItem, EXT_UNIT_OPTION).length) {
      const matched = units.some((c) => (c.system === undefined || c.system === v.system) && (c.code === undefined || c.code === v.code) && (c.display === undefined || c.display === v.unit));
      this.rule(matched, at, `The value ${this.displayQuantity(v)} has a unit that is not valid (allowed = ${units.map((c) => this.displayCoding(c)).join(",")})`, "invariant");
    }
    const unitSet = extensionPrimitive(firstExtension(qItem, EXT_UNIT_VALUESET));
    if (unitSet !== null) {
      if (!(await this.deps.valueSetKnown(unitSet))) this.warning(false, at, `The unit value set '${unitSet}' could not be found`);
      else if ((await this.deps.member(unitSet, typeof v.system === "string" ? v.system : null, String(v.code))) === false) {
        this.rule(false, at, `The value ${this.displayQuantity(v)} has a unit that is not in the unit value set '${unitSet}'`, "invariant");
      }
    }
  }

  private async codingAnswer(answer: Json, ns: string, qItem: Json, constraint: string, answerCount: number): Promise<void> {
    const c = answer.valueCoding;
    if (!isObject(c)) return;
    const open = constraint === "optionsOrString";
    if (this.options(qItem).length) {
      this.codingOption(c, ns, qItem, open, answerCount);
    } else if (typeof qItem.answerValueSet === "string") {
      const vs = qItem.answerValueSet;
      if (!(await this.deps.valueSetKnown(vs))) {
        this.warning(false, ns, `The valueSet reference ${vs} could not be resolved`);
        return;
      }
      if (noString(c.code) && noString(c.system) && !noString(c.display) && open) return;
      // optionsOrType: any Coding is an answer, the value set is not the list (validateAnswerCode l. 1544)
      if (constraint !== "optionsOrType" && typeof c.code === "string" && (await this.deps.member(vs, typeof c.system === "string" ? c.system : null, c.code)) === false) {
        this.rule(false, ns, `The code '${c.code}' in the system '${c.system}' is not in the options value set (${vs}) specified by the questionnaire. Terminology Error: The provided code '${c.system}#${c.code}' was not found in the value set '${vs}'`, "code-invalid");
      }
    } else {
      this.hint(ns, "Cannot validate options because no option or options are provided");
    }
  }

  private codingOption(c: Json, ns: string, qItem: Json, open: boolean, answerCount: number): void {
    const opts = this.options(qItem).filter((o) => isObject(o.valueCoding));
    if (!opts.length && !open) {
      this.rule(false, ns, "Option list has no option values of type coding", "invariant");
      return;
    }
    const hit = opts.find((o) => o.valueCoding.system === c.system && o.valueCoding.code === c.code);
    if (!hit) {
      this.rule(false, ns, `The code ${c.system}::${c.code} is not in the set of permitted values`, "invariant");
      return;
    }
    if (firstExtension(hit, EXT_EXCLUSIVE)?.valueBoolean === true) {
      this.rule(answerCount === 1, ns, `Selected answer ${hit.valueCoding.system}#${hit.valueCoding.code} is an exclusive option - can't select anything else at the same time`, "invariant");
    }
  }

  /** checkOption l. 1616-1630 for date / time / integer / string answers of a coding item. */
  private option(answer: Json, ns: string, qItem: Json, type: string, constraint: string): void {
    const open = constraint === "optionsOrString";
    const v = valueOf(answer);
    const s = primitiveOf(v);
    if (s === null) return;
    const opts = this.options(qItem);
    if (type === "string") {
      if (opts.length) {
        const strings = opts.filter((o) => typeof o.valueString === "string").map((o) => o.valueString as string);
        if (!open) {
          if (!strings.length) this.rule(false, ns, "Option list has no option values of type string", "invariant");
          else this.rule(strings.includes(s), ns, `The string ${s} is not in the set of permitted values`, "invariant");
        } else {
          const lower = s.toLowerCase();
          const same = opts.some((o) => isObject(o.valueCoding) && (String(o.valueCoding.display ?? "").toLowerCase() === lower || String(o.valueCoding.code ?? "").toLowerCase() === lower));
          this.warning(!same, ns, `The string value '${s}' matches an entry in the list of valid Codings, so this is probably an error`);
        }
      } else if (typeof qItem.answerValueSet !== "string") {
        this.hint(ns, "Cannot validate string answer option because no option list is provided");
      } else if (!open) {
        this.rule(false, ns, `The answer to the item ${qItem.linkId} is a string, but answerConstraint is '${constraint}', so the answer has to be one of the options the questionnaire specifies`, "invariant");
      }
      return;
    }
    const label = type;
    const key = `value${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    if (!opts.length) {
      this.hint(ns, `Cannot validate ${label} answer option because no option list is provided`);
      return;
    }
    const values = opts.filter((o) => o[key] !== undefined).map((o) => String(o[key]));
    if (!values.length && !open) this.rule(false, ns, `Option list has no option values of type ${label}`, "invariant");
    else this.rule(values.includes(s), ns, `The ${label} ${s} is not in the set of permitted values`, "invariant");
  }
}

/** QuestionnaireValidator.validateQuestionannaireResponse l. 514-567, QuestionnaireMode.CHECK. */
export async function validateQuestionnaireResponse(qr: Json, path: string, deps: QuestionnaireDeps): Promise<QuestionnaireIssue[]> {
  const q = typeof qr.questionnaire === "string" && qr.questionnaire ? qr.questionnaire : null;
  if (q === null) return [{ severity: "information", path, code: "required", message: "No questionnaire is identified, so no validation can be performed against the base questionnaire" }];
  const contained = q.startsWith("#") ? list(qr.contained).find((c) => isObject(c) && c.resourceType === "Questionnaire" && c.id === q.slice(1)) ?? null : null;
  const questionnaire: Json | null = q.startsWith("#") ? contained : await deps.fetchQuestionnaire(q);
  if (!questionnaire) {
    const example = q.startsWith("http://example.org") || q.startsWith("https://example.org");
    return [{ severity: example ? "information" : "warning", path, code: "required", message: `The questionnaire '${q}' could not be resolved, so no validation can be performed against the base questionnaire` }];
  }
  const v = new ResponseValidator(questionnaire, qr, !["completed", "amended"].includes(String(qr.status)), deps);
  await v.items(list(questionnaire.item).filter(isObject), qr, path, []);
  return v.out;
}
