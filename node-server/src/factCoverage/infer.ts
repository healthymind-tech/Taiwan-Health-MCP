/**
 * Which resource types a fact belongs to (from its `item` / `attribute`), and which element of such a resource a
 * missing fact should go to. Generic FHIR R4 vocabulary (zh-TW + English), never per IG: the candidate elements of a
 * concrete entry come from its profile's authoring fields (authoring/fields.ts), this table only ranks them.
 */
import { nfkc } from "../grounding/lexicon.js";
import type { FieldSpec } from "../authoring/types.js";

/** Resource families by keyword, in priority order (藥物過敏 is an allergy, not a medication). */
const TYPE_RULES: Array<[RegExp, string[]]> = [
  [/過敏|allerg|intoleran/u, ["AllergyIntolerance"]],
  [/疫苗|接種|vaccin|immuni[sz]/u, ["Immunization"]],
  [/家族史|family history/u, ["FamilyMemberHistory"]],
  [/診斷|疾病|病名|問題|diagnos|condition|problem|disease|\bdx\b|impression|assessment/u, ["Condition"]],
  [/手術|術式|處置|procedure|surgery|operation/u, ["Procedure"]],
  [/藥|處方|劑量|頻次|頻率|途徑|給藥|用法|medicat|drug|\bdose|dosage|\broute\b|frequency|prescri|\brx\b/u, ["MedicationRequest", "MedicationStatement", "MedicationAdministration", "MedicationDispense", "Medication"]],
  [/檢驗|檢查|報告|體溫|血壓|心跳|心率|脈搏|呼吸|體重|身高|血氧|血糖|判讀|參考範圍|生命徵象|\blab|\btest\b|vital|temperature|blood pressure|pulse|heart rate|respirat|weight|height|spo2|\bbmi\b|observation|interpretation|reference range/u, ["Observation", "DiagnosticReport"]],
  [/醫囑|轉診|order|referral|service request/u, ["ServiceRequest"]],
  [/保險|給付|申請|事前審查|claim|coverage|insurance|payer/u, ["Claim", "Coverage", "ExplanationOfBenefit"]],
  [/就診|就醫|門診|住院|急診|入院|出院|掛號|科別|到院|離院|arrival|disposition|\badm\b|encounter|visit|admission|discharge|department/u, ["Encounter"]],
  [/醫師|醫生|護理師|藥師|practitioner|physician|doctor|nurse/u, ["Practitioner", "PractitionerRole"]],
  [/醫院|機構|院所|診所|organization|hospital|clinic|facility/u, ["Organization"]],
  [/病人|病患|患者|個案|姓名|名字|性別|生日|出生|身分證|病歷號|病歷號碼|chart no|\bid no\b|\bdob\b|地址|電話|patient|\bname\b|gender|\bsex\b|birth|\bmrn\b|address|phone/u, ["Patient"]],
];

/** Resource types a fact belongs to; [] when the item / attribute name none (the whole Bundle is searched). */
export function impliedTypes(item: string, attribute: string, explicit?: string | null): string[] {
  if (explicit && /^[A-Z][A-Za-z]+$/u.test(explicit.trim())) return [explicit.trim()];
  for (const text of [item, attribute]) {
    const t = nfkc(text);
    for (const [rx, types] of TYPE_RULES) if (rx.test(t)) return types;
  }
  return [];
}

/** Attribute keywords → element names they denote (base FHIR R4 names; matched against the profile's fields). */
const ATTRIBUTE_ELEMENTS: Array<[RegExp, string[]]> = [
  [/途徑|route/u, ["dosageInstruction.route", "dosage.route", "route"]],
  [/頻次|頻率|frequency|timing|\bbid\b|\btid\b|\bqd\b/u, ["dosageInstruction.timing", "dosage.timing", "timing", "occurrenceTiming"]],
  [/劑量|dose|用量/u, ["dosageInstruction.doseAndRate", "dosage.dose", "doseQuantity", "dosage.doseAndRate"]],
  [/天數|期間|療程|duration|supply/u, ["dispenseRequest.expectedSupplyDuration", "dosageInstruction.timing", "effectivePeriod"]],
  [/數量|總量|quantity/u, ["dispenseRequest.quantity", "quantity"]],
  [/確診|確認|verification/u, ["verificationStatus"]],
  [/狀態|status/u, ["clinicalStatus", "status"]],
  [/類別|分類|category|類型|type/u, ["category", "type", "class"]],
  [/嚴重|severity|criticality/u, ["severity", "criticality"]],
  [/部位|site|location/u, ["bodySite", "location"]],
  [/發生|發作|起始|onset/u, ["onsetDateTime", "onset[x]", "onsetPeriod"]],
  [/判讀|異常|interpretation|flag/u, ["interpretation"]],
  [/參考範圍|參考值|reference range/u, ["referenceRange"]],
  // 單位 / unit name no element of their own: a unit fact sits in whatever Quantity holds the measurement
  [/數值|結果|value|result/u, ["value[x]", "valueQuantity", "component.value[x]"]],
  [/項目|代碼|名稱|code|name of test|檢驗名/u, ["code", "medicationCodeableConcept", "medication[x]", "vaccineCode"]],
  [/入院|admission|開始|start/u, ["period.start"]],
  [/出院|discharge|結束|end/u, ["period.end", "hospitalization.dischargeDisposition"]],
  [/日期|時間|date|time|when/u, ["effectiveDateTime", "effective[x]", "authoredOn", "recordedDate", "onsetDateTime", "performed[x]", "occurrenceDateTime", "issued", "date", "period"]],
  [/性別|gender|\bsex\b/u, ["gender"]],
  [/生日|出生|birth/u, ["birthDate"]],
  [/姓名|名字|\bname\b/u, ["name"]],
  [/身分證|病歷號|識別|編號|證號|identifier|\bid\b|\bmrn\b|number/u, ["identifier"]],
  [/電話|phone|telecom/u, ["telecom"]],
  [/地址|address/u, ["address"]],
  [/科別|department|service type/u, ["serviceType", "type"]],
  [/過敏原|藥名|藥品名|allergen|substance/u, ["code", "medicationCodeableConcept", "medication[x]"]],
  [/反應|reaction|manifestation/u, ["reaction.manifestation", "reaction"]],
  [/原因|理由|reason/u, ["reasonCode", "reasonReference"]],
];

const segs = (p: string): string[] => p.split(".").map((s) => s.replace(/\[x\]$/u, "[x]").toLowerCase());

function segMatch(want: string, have: string): boolean {
  if (want.endsWith("[x]")) return have.startsWith(want.slice(0, -3));
  return have === want || (want.length >= 4 && have.endsWith(want)); // date ↔ birthDate / recordedDate, quantity ↔ doseQuantity
}

/**
 * The element class a fact's attribute names (v20.1 item 4: a numeric / date value must sit in an element of that
 * class — a dose never matches Dosage.sequence, a reference range never stands for the value). Returns a predicate over
 * found element paths (ResourceType.a.b), or null when the attribute / item name no element (no restriction).
 * The wanted names are the attribute's and the item's (ATTRIBUTE_ELEMENTS) plus the attribute itself when it is
 * spelled as a FHIR element name (valueQuantity, period.start).
 */
export function attributeClass(attribute: string, item = ""): ((path: string) => boolean) | null {
  const wanted: string[] = [];
  const a = attribute.trim();
  // an attribute spelled as a camelCase / dotted FHIR element name (valueQuantity, period.start) is that element (and
  // what the item names), never the words inside it (serviceType is not `type`); a plain lower-case word that is also
  // an element name (start, route) joins the vocabulary's names
  const fhirName = /^[a-z]+[A-Z][A-Za-z]*(?:\[x\])?$|^[a-z][A-Za-z]*(?:\[x\])?(?:\.[a-z][A-Za-z]*(?:\[x\])?)+$/u.test(a);
  if (fhirName) wanted.push(a);
  for (const text of fhirName ? [item] : [attribute, item]) {
    const t = nfkc(text);
    for (const [rx, els] of ATTRIBUTE_ELEMENTS) if (rx.test(t)) for (const e of els) if (!wanted.includes(e)) wanted.push(e);
  }
  if (!fhirName && /^[a-z]{3,}$/u.test(a) && !wanted.includes(a)) wanted.push(a);
  if (!wanted.length) return null;
  const ws = wanted.map(segs);
  const range = ws.some((w) => w.some((x) => x === "referencerange" || x === "high" || x === "low"));
  return (path: string): boolean => {
    const have = segs(path).slice(1);
    if (!range && have.includes("referencerange")) return false;
    return ws.some((w) => {
      for (let i = 0; i + w.length <= have.length; i++) if (w.every((x, k) => segMatch(x, have[i + k]))) return true;
      return false;
    });
  };
}

/** Field kinds that can hold a value of each reading. */
export type ValueShape = "date" | "number" | "route" | "frequency" | "code" | "text";

const KIND_FOR: Record<ValueShape, ReadonlySet<string>> = {
  date: new Set(["date", "dateTime", "period"]),
  number: new Set(["quantity", "decimal", "integer", "component", "dosage"]),
  route: new Set(["codeableConcept", "coding", "dosage"]),
  frequency: new Set(["dosage", "other"]),
  code: new Set(["code", "coding", "codeableConcept"]),
  text: new Set(["string", "identifier", "humanName", "code", "codeableConcept", "coding"]),
};

const stripX = (s: string): string => s.replace(/\[x\]$/u, "").toLowerCase();

/** Element names the attribute denotes (base names), in preference order. */
export function attributeElements(attribute: string, item = ""): string[] {
  const out: string[] = [];
  for (const text of [attribute, item]) {
    const t = nfkc(text);
    for (const [rx, els] of ATTRIBUTE_ELEMENTS) if (rx.test(t)) for (const e of els) if (!out.includes(e)) out.push(e);
    if (out.length) break;
  }
  return out;
}

/**
 * Suggested element paths (ResourceType.field[.child]) for a missing fact: the profile's authoring fields ranked by
 * the attribute's element names first, then by whether the field's kind can hold the value. At most `limit`.
 */
export function suggestFromFields(resourceType: string, fields: readonly FieldSpec[], attribute: string, item: string, shape: ValueShape, limit = 5): string[] {
  const wanted = attributeElements(attribute, item).map((e) => e.toLowerCase());
  const scored: Array<{ path: string; score: number; order: number }> = [];
  let order = 0;
  const visit = (f: FieldSpec, prefix: string): void => {
    const name = f.field.split(":")[0];
    // a child's `field` is relative to the resource ("name.text"), or to its parent in older field lists ("text")
    const path = !prefix || name === prefix || name.startsWith(`${prefix}.`) ? name : `${prefix}.${name}`;
    const base = stripX(path);
    let score = 0;
    const wi = wanted.findIndex((w) => stripX(w) === base || base.startsWith(stripX(w) + ".") || (stripX(w).startsWith(base) && stripX(w).length - base.length <= 8));
    if (wi >= 0) score += 100 - wi;
    if (KIND_FOR[shape].has(f.kind)) score += 10;
    if (f.required) score += 2;
    if (f.source === "record") score += 1;
    if (f.auto || f.source === "fixed") score -= 50;
    scored.push({ path: `${resourceType}.${path}`, score, order: order++ });
    for (const c of f.children ?? []) visit(c, path);
  };
  for (const f of fields) visit(f, "");
  const top = scored.filter((s) => s.score >= 10).sort((a, b) => b.score - a.score || a.order - b.order);
  return [...new Set(top.map((s) => s.path))].slice(0, limit);
}

/** Top-level elements of the common resource types (FHIR R4) — the base fallback only names elements that exist. */
const BASE_TOP: Record<string, string[]> = {
  Patient: ["identifier", "active", "name", "telecom", "gender", "birthDate", "deceased[x]", "address", "maritalStatus", "contact", "communication", "generalPractitioner", "managingOrganization"],
  Encounter: ["identifier", "status", "class", "type", "serviceType", "priority", "subject", "participant", "period", "length", "reasonCode", "reasonReference", "diagnosis", "hospitalization", "location", "serviceProvider"],
  Condition: ["identifier", "clinicalStatus", "verificationStatus", "category", "severity", "code", "bodySite", "subject", "encounter", "onsetDateTime", "onset[x]", "abatement[x]", "recordedDate", "recorder", "asserter", "stage", "evidence"],
  Observation: ["identifier", "status", "category", "code", "subject", "encounter", "effectiveDateTime", "effective[x]", "issued", "performer", "value[x]", "valueQuantity", "dataAbsentReason", "interpretation", "bodySite", "method", "specimen", "referenceRange", "hasMember", "component", "component.value[x]"],
  DiagnosticReport: ["identifier", "status", "category", "code", "subject", "encounter", "effective[x]", "issued", "performer", "result", "conclusion", "conclusionCode"],
  MedicationRequest: ["identifier", "status", "statusReason", "intent", "category", "priority", "medicationCodeableConcept", "medication[x]", "subject", "encounter", "authoredOn", "requester", "reasonCode", "dosageInstruction", "dosageInstruction.route", "dosageInstruction.timing", "dosageInstruction.doseAndRate", "dispenseRequest", "dispenseRequest.quantity", "dispenseRequest.expectedSupplyDuration", "substitution"],
  MedicationStatement: ["identifier", "status", "category", "medication[x]", "subject", "context", "effective[x]", "dateAsserted", "reasonCode", "dosage", "dosage.route", "dosage.timing", "dosage.doseAndRate"],
  MedicationAdministration: ["identifier", "status", "category", "medication[x]", "subject", "context", "effective[x]", "performer", "reasonCode", "dosage", "dosage.route", "dosage.dose"],
  MedicationDispense: ["identifier", "status", "category", "medication[x]", "subject", "quantity", "daysSupply", "whenPrepared", "whenHandedOver", "dosageInstruction", "dosageInstruction.route", "dosageInstruction.timing"],
  Medication: ["identifier", "code", "status", "manufacturer", "form", "amount", "ingredient"],
  AllergyIntolerance: ["identifier", "clinicalStatus", "verificationStatus", "type", "category", "criticality", "code", "patient", "encounter", "onset[x]", "recordedDate", "reaction", "reaction.manifestation", "reaction.severity"],
  Procedure: ["identifier", "status", "category", "code", "subject", "encounter", "performed[x]", "performer", "location", "reasonCode", "bodySite", "outcome"],
  Immunization: ["identifier", "status", "vaccineCode", "patient", "encounter", "occurrenceDateTime", "occurrence[x]", "lotNumber", "site", "route", "doseQuantity", "performer"],
  Practitioner: ["identifier", "active", "name", "telecom", "address", "gender", "birthDate", "qualification"],
  Organization: ["identifier", "active", "type", "name", "telecom", "address"],
  ServiceRequest: ["identifier", "status", "intent", "category", "priority", "code", "subject", "encounter", "occurrence[x]", "authoredOn", "requester", "reasonCode"],
};

/** Fallback without a profile: the attribute's base element names that the resource type has (else its `code`). */
export function suggestFromBase(resourceType: string, attribute: string, item: string, limit = 3): string[] {
  const top = BASE_TOP[resourceType];
  const els = attributeElements(attribute, item).filter((e) => !top || top.includes(e));
  if (!els.length && top?.includes("code")) els.push("code");
  return els.slice(0, limit).map((e) => `${resourceType}.${e}`);
}
