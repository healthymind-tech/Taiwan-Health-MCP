/**
 * TW PAS grounding test kit (test support only, not used by the tool at runtime).
 *
 * `renderPasRecord` writes a synthetic Taiwanese clinical record (zh/en mixed, ROC dates, 檢驗 table-like lines,
 * 用藥 lines in `藥名 劑量 途徑 頻次` form, site configuration for 醫事機構 / 醫師證號) that states every
 * source fact of a PAS Bundle, so the grounding engine should find 0 errors. `variants` derives the faithful-record
 * negatives: Bundle values altered (record unchanged), supporting line removed, negated, or turned into history.
 *
 * The renderer only uses the Bundle and authoritative code names (never engine internals), and phrases facts the
 * way Taiwanese notes do; it is still a template, so its false-positive rate is optimistic — the hand-written
 * records in pas.test.ts are the less tuned check.
 */
import { enumerateUnits, type Unit } from "./checkGrounding.js";
import { parseFhirDatetime, routesIn, WORKFLOW_DEFAULTS, FIXED_CODE_PROFILES } from "./lexicon.js";
import { isDict, pyEq, type JsonObject } from "./py.js";
import { termKey, type TermRecord } from "./terminologyNames.js";

type Terms = ReadonlyMap<string, TermRecord>;

const pad = (n: number): string => String(n).padStart(2, "0");
const HAS_CJK = /[一-鿿]/u;

export function rocDate(v: unknown): string | null {
  const d = parseFhirDatetime(v);
  if (!d) return null;
  if (d.m === null) return `${d.y}年`;
  if (d.d === null) return `${d.y}年${d.m}月`;
  const base = `${d.y - 1911}/${pad(d.m)}/${pad(d.d)}`;
  return d.hh !== null ? `${base} ${pad(d.hh)}:${pad(d.mi ?? 0)}` : base;
}

function codings(node: unknown): JsonObject[] {
  if (!isDict(node)) return [];
  if (Array.isArray(node.coding)) return node.coding.filter(isDict);
  if ("code" in node && "system" in node) return [node];
  return [];
}

/** Human name of a coded concept: authoritative Chinese name, else authoritative name, else display / text / code. */
export function conceptName(node: unknown, terms: Terms): string {
  const cs = codings(node);
  const auth = cs.flatMap((c) => {
    const r = terms.get(termKey(c.system, c.code));
    return r?.found ? r.names : [];
  });
  const zh = auth.find((n) => HAS_CJK.test(n) && n.length <= 40);
  if (zh) return zh;
  if (auth.length) return auth.reduce((a, b) => (b.length < a.length && b.length >= 3 ? b : a));
  const disp = cs.map((c) => c.display).find((x) => typeof x === "string" && x);
  if (typeof disp === "string") return disp;
  if (isDict(node) && typeof node.text === "string") return node.text;
  return cs.length ? String(cs[0].code) : "";
}

function qty(q: unknown): string {
  if (!isDict(q)) return "";
  const u = (q.unit ?? q.code ?? "") as string;
  const unit = u === "{tbl}" || u === "{tablets}" ? "粒" : u;
  if (q.value === undefined) return unit;
  return `${q.comparator ?? ""}${q.value}${unit ? " " + unit : ""}`;
}

const ROUTE_WORD: Record<string, string> = { oral: "PO", sc: "SC", iv: "IV", im: "IM", sl: "SL", inh: "INHL", top: "外用", rectal: "肛門塞劑" };
const CLASS_WORD: Record<string, string> = { AMB: "門診", EMER: "急診", IMP: "住院", HH: "居家" };

function routeWord(route: unknown): string {
  const words = new Set<string>();
  for (const c of codings(route)) for (const r of [...routesIn(String(c.code ?? "")), ...routesIn(String(c.display ?? ""))]) words.add(r);
  if (isDict(route) && typeof route.text === "string") for (const r of routesIn(route.text)) words.add(r);
  const r = [...words][0];
  return r ? ROUTE_WORD[r] ?? r : "";
}

function timingWord(t: unknown): string {
  if (!isDict(t)) return "";
  const code = isDict(t.code) ? t.code : null;
  const c = codings(code)[0];
  if (c?.code) return String(c.code);
  if (code && typeof code.text === "string") return code.text;
  const rp = isDict(t.repeat) ? t.repeat : null;
  if (rp && rp.frequency && rp.period && rp.periodUnit) {
    const perDay = Number(rp.frequency) / (Number(rp.period) * ({ h: 1 / 24, d: 1, wk: 7, mo: 30 } as Record<string, number>)[String(rp.periodUnit)]);
    const m: Record<number, string> = { 1: "QD", 2: "BID", 3: "TID", 4: "QID", 6: "Q4H", 8: "Q3H", 12: "Q2H" };
    if (m[Math.round(perDay)] && Math.abs(perDay - Math.round(perDay)) < 0.01) return m[Math.round(perDay)];
    if (rp.periodUnit === "h") return `每${Number(rp.period) / Number(rp.frequency)}小時`;
    if (rp.periodUnit === "wk") return `每週${rp.frequency}次`;
  }
  return "";
}

const STATUS_WORD: Record<string, string> = {
  completed: "已完成",
  "on-hold": "暫停",
  stopped: "已停藥",
  plan: "計畫",
  resolved: "已改善",
  "in-progress": "住院中",
  provisional: "疑似",
};

function statusWords(res: JsonObject): string {
  const out: string[] = [];
  for (const k of ["status", "intent"]) {
    const v = res[k];
    const gp = `${res.resourceType}.${k}`;
    if (typeof v === "string" && !(WORKFLOW_DEFAULTS[gp] ?? []).some((d) => pyEq(d, v)) && STATUS_WORD[v]) out.push(STATUS_WORD[v]);
  }
  return out.length ? `（${out.join("、")}）` : "";
}

function dateLabel(gp: string): string {
  const L: Record<string, string> = {
    "Encounter.period.start": "就診日期",
    "Encounter.period.end": "離院日期",
    "Condition.onsetDateTime": "發病日期",
    "Condition.recordedDate": "記錄日期",
    "Claim.diagnosis.extension.valueDate": "診斷日期",
    "Claim.procedure.date": "處置日期",
    "Claim.created": "申請日期",
    "Claim.item.servicedDate": "預計用藥日期",
    "DiagnosticReport.effectiveDateTime": "檢查日期",
    "DiagnosticReport.issued": "報告日期",
    "Specimen.receivedTime": "檢體收件時間",
    "Specimen.collection.collectedDateTime": "採檢時間",
    "Procedure.performedDateTime": "處置日期",
    "Procedure.performedPeriod.start": "處置開始",
    "Procedure.performedPeriod.end": "處置結束",
    "MedicationRequest.authoredOn": "開立日期",
    "ImagingStudy.started": "檢查日期",
    "Media.createdDateTime": "攝影日期",
    "Composition.date": "文件日期",
    "DocumentReference.date": "文件日期",
    "CarePlan.period.start": "治療計畫開始",
    "CarePlan.period.end": "治療計畫結束",
    "ClinicalImpression.effectiveDateTime": "評估日期",
  };
  if (L[gp]) return L[gp];
  if (gp.startsWith("Observation.effective")) return "檢驗日期";
  if (gp.endsWith("birthDate")) return "出生日期";
  return "日期";
}

function idLabel(res: JsonObject, id: JsonObject): string {
  const tc = codings(id.type).map((c) => String(c.code));
  if (tc.includes("NNxxx") || id.system === "http://www.moi.gov.tw") return "身分證字號";
  if (tc.includes("MR")) return "病歷號";
  if (res.resourceType === "Practitioner") return "醫師證書字號";
  if (res.resourceType === "Organization") return "醫事機構代碼";
  return "編號";
}

export interface RenderedRecord {
  text: string;
  site: string;
}

/** Synthetic Taiwanese clinical record + site configuration supporting every source fact of the Bundle. */
export function renderPasRecord(bundle: JsonObject, terms: Terms): RenderedRecord {
  const entries = (Array.isArray(bundle.entry) ? bundle.entry : []).map((e: unknown) => (isDict(e) && isDict(e.resource) ? e.resource : {})) as JsonObject[];
  const byId = new Map<string, JsonObject>();
  for (const r of entries) if (r.resourceType && r.id) byId.set(`${r.resourceType}/${r.id}`, r);
  for (const e of (Array.isArray(bundle.entry) ? bundle.entry : []) as unknown[])
    if (isDict(e) && typeof e.fullUrl === "string" && isDict(e.resource)) byId.set(e.fullUrl, e.resource);
  const pre: string[] = [];
  const dx: string[] = [];
  const lab: string[] = [];
  const meds: string[] = [];
  const proc: string[] = [];
  const claim: string[] = [];
  const docs: string[] = [];
  const site: string[] = ["【院所設定】（由本院資訊系統提供，非病歷內容）"];
  const covered = new Set<string>();
  const of = (r: JsonObject, ei: number): Unit[] => enumerateUnits(r, ei);
  const dateLine = (into: string[], gp: string, v: unknown): void => {
    const d = rocDate(v);
    if (d) into.push(`${dateLabel(gp)}：${d}`);
  };

  entries.forEach((r, ei) => {
    const rt = String(r.resourceType ?? "");
    const units = of(r, ei);
    const mark = (u: Unit): void => void covered.add(u.path);
    if (rt === "Patient") {
      const parts: string[] = [];
      const nm = Array.isArray(r.name) && isDict(r.name[0]) ? (r.name[0].text ?? `${r.name[0].family ?? ""}${(r.name[0].given as string[] | undefined)?.join("") ?? ""}`) : null;
      if (nm) parts.push(`姓名：${nm}`);
      if (r.gender) parts.push(`性別：${r.gender === "male" ? "男" : r.gender === "female" ? "女" : String(r.gender)}`);
      if (r.birthDate) parts.push(`出生日期：${rocDate(r.birthDate)}`);
      pre.push(parts.join("　"));
      for (const id of (Array.isArray(r.identifier) ? r.identifier : []).filter(isDict)) pre.push(`${idLabel(r, id)}：${id.value}`);
      units.forEach(mark);
    } else if (rt === "Practitioner" || rt === "Organization") {
      const nm = rt === "Organization" ? r.name : Array.isArray(r.name) && isDict(r.name[0]) ? r.name[0].text : null;
      const ids = (Array.isArray(r.identifier) ? r.identifier : []).filter(isDict).map((id) => `${idLabel(r, id)}：${id.value}`);
      if (rt === "Practitioner" && nm) pre.push(`主治醫師：${nm}`);
      site.push(`- ${rt === "Organization" ? `醫事機構：${nm ?? ""}　` : "申請醫師　"}${ids.join("　")}`);
      units.forEach(mark);
    } else if (rt === "Encounter") {
      const cls = isDict(r.class) ? CLASS_WORD[String(r.class.code)] ?? "" : "";
      const svc = Array.isArray(r.serviceType) ? r.serviceType : r.serviceType ? [r.serviceType] : [];
      const st = svc.map((s: unknown) => conceptName(s, terms)).join("、");
      const per = isDict(r.period) ? r.period : {};
      pre.push(
        [`${cls ? cls + "就診" : "就診"}日期：${rocDate(per.start) ?? ""}`, per.end ? `離院日期：${rocDate(per.end)}` : "", st ? `科別：${st}${cls ? `（${cls}）` : ""}` : cls ? `（${cls}）` : ""]
          .filter(Boolean)
          .join("　") + statusWords(r),
      );
      units.forEach(mark);
    } else if (rt === "Condition") {
      dx.push(`${dx.length + 1}. ${conceptName(r.code, terms)}${statusWords(r)}`);
      for (const k of ["onsetDateTime", "recordedDate"]) if (r[k]) dateLine(dx, `Condition.${k}`, r[k]);
      units.forEach(mark);
    } else if (rt === "Observation") {
      const name = conceptName(r.code, terms);
      const eff = r.effectiveDateTime ?? (isDict(r.effectivePeriod) ? r.effectivePeriod.start : null);
      const range = (rr: unknown): string => {
        const x = Array.isArray(rr) && isDict(rr[0]) ? rr[0] : null;
        if (!x) return "";
        const lo = isDict(x.low) ? x.low.value : null;
        const hi = isDict(x.high) ? x.high.value : null;
        return lo !== null || hi !== null ? `（參考值 ${lo ?? ""}-${hi ?? ""}）` : "";
      };
      const head = `${name}${eff ? `（${rocDate(eff)}）` : ""}`;
      const val = (v: JsonObject, n: string): string | null => {
        if (isDict(v.valueQuantity)) return `${n} ${qty(v.valueQuantity)}${range(v.referenceRange)}`;
        if (typeof v.valueString === "string") return `${n}：${v.valueString}`;
        if (isDict(v.valueCodeableConcept)) return `${n}：${conceptName(v.valueCodeableConcept, terms)}`;
        if (typeof v.valueInteger === "number") return `${n}：${v.valueInteger}`;
        if (typeof v.valueBoolean === "boolean") return `${n}：${v.valueBoolean ? "是" : "否"}`;
        return null;
      };
      const fixed = ((isDict(r.meta) && Array.isArray(r.meta.profile) ? r.meta.profile : []) as string[]).some((p) => FIXED_CODE_PROFILES.has(String(p).split("/").pop()!));
      const main = val(r, fixed ? name : name);
      lab.push(main ? `${main}${eff ? `　檢驗日期：${rocDate(eff)}` : ""}` : head);
      if (r.method) lab.push(`檢驗方法：${conceptName(r.method, terms)}`);
      if (r.bodySite) lab.push(`部位：${conceptName(r.bodySite, terms)}`);
      for (const c of (Array.isArray(r.component) ? r.component : []).filter(isDict)) {
        const line = val(c, conceptName(c.code, terms));
        lab.push(line ?? conceptName(c.code, terms));
      }
      units.forEach(mark);
    } else if (rt === "DiagnosticReport") {
      const titles = (Array.isArray(r.presentedForm) ? r.presentedForm : []).filter(isDict).map((p) => p.title).filter(Boolean);
      lab.push(`${conceptName(r.code, terms)}報告　檢查日期：${rocDate(r.effectiveDateTime) ?? ""}${r.conclusion ? `：${r.conclusion}` : ""}${titles.length ? `（${titles.join("、")}）` : ""}`);
      if (r.issued) dateLine(lab, "DiagnosticReport.issued", r.issued);
      units.forEach(mark);
    } else if (rt === "Specimen") {
      const col = isDict(r.collection) ? r.collection : {};
      lab.push(
        `檢體：${conceptName(r.type, terms)}${r.receivedTime ? `　檢體收件時間：${rocDate(r.receivedTime)}` : ""}${col.collectedDateTime ? `　採檢時間：${rocDate(col.collectedDateTime)}` : ""}`,
      );
      units.forEach(mark);
    } else if (rt === "ImagingStudy" || rt === "Media") {
      const sites = rt === "Media" ? [r.bodySite] : (Array.isArray(r.series) ? r.series : []).filter(isDict).map((s) => s.bodySite);
      const when = rt === "Media" ? r.createdDateTime : r.started;
      lab.push(`${rt === "Media" ? "影像" : "影像檢查"}部位：${sites.map((s) => conceptName(isDict(s) && !("coding" in s) && "code" in s ? { coding: [s] } : s, terms)).join("、")}${when ? `　檢查日期：${rocDate(when)}` : ""}`);
      units.forEach(mark);
    } else if (rt === "MedicationRequest" || rt === "MedicationStatement") {
      const name = conceptName(r.medicationCodeableConcept, terms);
      const dz = (Array.isArray(r.dosageInstruction) ? r.dosageInstruction : Array.isArray(r.dosage) ? r.dosage : []).filter(isDict);
      const extra: string[] = [];
      if (isDict(r.dispenseRequest)) {
        if (isDict(r.dispenseRequest.quantity)) extra.push(`總量 ${qty(r.dispenseRequest.quantity)}`);
        if (isDict(r.dispenseRequest.expectedSupplyDuration)) extra.push(`${r.dispenseRequest.expectedSupplyDuration.value} 天`);
      }
      if (r.statusReason) extra.push(conceptName(r.statusReason, terms));
      const st = statusWords(r);
      if (!dz.length) meds.push(`${name} ${extra.join(" ")}${st}`);
      for (const d of dz) {
        const dr = Array.isArray(d.doseAndRate) && isDict(d.doseAndRate[0]) ? d.doseAndRate[0] : {};
        const dose = isDict(dr.doseQuantity) ? qty(dr.doseQuantity) : "";
        const prn = d.asNeededBoolean === true ? " PRN" : "";
        meds.push(`${name} ${dose} ${routeWord(d.route)} ${timingWord(d.timing)}${prn} ${extra.join(" ")}${st}`.replace(/\s+/g, " ").trim());
      }
      if (r.authoredOn) dateLine(meds, "MedicationRequest.authoredOn", r.authoredOn);
      units.forEach(mark);
    } else if (rt === "Procedure") {
      const per = isDict(r.performedPeriod) ? r.performedPeriod : null;
      const when = r.performedDateTime ? rocDate(r.performedDateTime) : per ? `${rocDate(per.start) ?? ""}~${rocDate(per.end) ?? ""}` : "";
      proc.push(`${conceptName(r.code, terms)}　處置日期：${when}${statusWords(r)}`);
      units.forEach(mark);
    } else if (rt === "Substance") {
      const ing = (Array.isArray(r.ingredient) ? r.ingredient : []).filter(isDict);
      meds.push(
        `${conceptName(r.code, terms)}：${ing.map((i) => `${conceptName(i.substanceCodeableConcept, terms)} ${isDict(i.quantity) ? qty(i.quantity.numerator) : ""}`).join("，")}`,
      );
      units.forEach(mark);
    } else if (rt === "Claim") {
      if (r.created) claim.push(`申請日期：${rocDate(r.created)}`);
      for (const si of (Array.isArray(r.supportingInfo) ? r.supportingInfo : []).filter(isDict)) {
        const cat = conceptName(si.category, terms);
        if (isDict(si.valueQuantity)) claim.push(`${cat} ${qty(si.valueQuantity)}`);
        if (typeof si.valueString === "string") claim.push(`${cat}：${si.valueString}`);
        if (isDict(si.code)) claim.push(`${cat}：${conceptName(si.code, terms)}`);
        if (isDict(si.valueCodeableConcept)) claim.push(`${cat}：${conceptName(si.valueCodeableConcept, terms)}`);
        if (si.timingDate) claim.push(`${cat}日期：${rocDate(si.timingDate)}`);
      }
      for (const d of (Array.isArray(r.diagnosis) ? r.diagnosis : []).filter(isDict)) {
        if (isDict(d.diagnosisCodeableConcept)) dx.push(`${dx.length + 1}. ${conceptName(d.diagnosisCodeableConcept, terms)}`);
        for (const ext of (Array.isArray(d.extension) ? d.extension : []).filter(isDict))
          if (ext.valueDate || ext.valueDateTime) dx.push(`診斷日期：${rocDate(ext.valueDate ?? ext.valueDateTime)}`);
      }
      for (const p of (Array.isArray(r.procedure) ? r.procedure : []).filter(isDict))
        proc.push(`${conceptName(p.procedureCodeableConcept, terms)}　處置日期：${rocDate(p.date) ?? ""}`);
      for (const it of (Array.isArray(r.item) ? r.item : []).filter(isDict)) {
        const ref = (Array.isArray(it.extension) ? it.extension : []).filter(isDict).map((e) => (isDict(e.valueReference) ? String(e.valueReference.reference) : "")).find(Boolean);
        const target = ref ? byId.get(ref) ?? byId.get(ref.split("/").slice(-2).join("/")) : undefined;
        const drug = target ? conceptName(target.medicationCodeableConcept, terms) : "";
        const mods = (Array.isArray(it.modifier) ? it.modifier : []).map((m: unknown) => conceptName(m, terms));
        const prog = (Array.isArray(it.programCode) ? it.programCode : []).map((p: unknown) => conceptName(p, terms));
        claim.push(
          `申請項目${it.sequence ?? ""}：${drug}${isDict(it.quantity) ? ` 申請數量 ${qty(it.quantity)}` : ""}${mods.length ? `，${mods.join("，")}` : ""}${prog.length ? `，給付規定：${prog.join("，")}` : ""}${it.servicedDate ? `，預計用藥日期：${rocDate(it.servicedDate)}` : ""}`,
        );
      }
      units.forEach(mark);
    } else {
      // documents / plans: dates and narrative titles
      for (const u of units) {
        if (u.kind === "datetime") dateLine(docs, u.gpath, u.node);
        else if (u.cls === "narrative" && typeof u.node === "string") docs.push(`${u.node}`);
        else if (u.cls === "narrative" && isDict(u.node) && typeof u.node.text === "string") docs.push(u.node.text);
        mark(u);
      }
    }
  });
  const text = [
    "癌藥事前審查 病歷摘要",
    ...pre,
    "診斷：",
    ...dx,
    "檢驗及檢查：",
    ...lab,
    "用藥：",
    ...meds,
    "處置：",
    ...proc,
    "事前審查申請資料",
    ...claim,
    ...(docs.length ? ["附件：", ...docs] : []),
  ].join("\n");
  return { text, site: site.join("\n") };
}

// ============================================================================================= variants
export type VariantKind = "bundle_value" | "record_removed" | "record_negated" | "record_historical";

export interface Variant {
  kind: VariantKind;
  unitPath: string;
  unitKind: string;
  bundle: JsonObject;
  text: string;
  /** Rules accepted as a correct detection (any error at the unit path also counts for bundle_value / record_removed). */
  expectRules?: string[];
  /** Record-keeping timestamp: by policy only a warning when ungrounded (reported separately). */
  admin?: boolean;
}

function shiftDate(v: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(v);
  if (!m) return v;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}${m[4]}`;
}

function setAt(root: JsonObject, path: string, value: unknown): void {
  const toks = path.replace(/^Bundle\./, "").match(/[^.[\]]+|\[\d+\]/g)!;
  let node: any = root;
  for (let i = 0; i < toks.length - 1; i++) node = toks[i].startsWith("[") ? node[Number(toks[i].slice(1, -1))] : node[toks[i]];
  const last = toks[toks.length - 1];
  if (last.startsWith("[")) node[Number(last.slice(1, -1))] = value;
  else node[last] = value;
}

/** Substitute codes (a clearly different concept, known to the terminology snapshot). */
const ALT_CODE: Record<string, [string, string, string]> = {
  diagnosis: ["http://hl7.org/fhir/sid/icd-10-cm", "J45.909", "Unspecified asthma, uncomplicated"],
  procedure: ["https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-pcs-2023-tw", "0DTJ4ZZ", "Resection of Appendix, Percutaneous Endoscopic Approach"],
};

/** Altered copy of a unit's value, or null when this kind is not mutated. */
function alteredValue(u: Unit, bundle: JsonObject): unknown {
  const n = u.node;
  if (u.kind === "datetime" && typeof n === "string" && n.length >= 10) return shiftDate(n, 1);
  if (["quantity", "obs_quantity", "si_quantity", "dose"].includes(u.kind) && isDict(n) && typeof n.value === "number") return { ...n, value: Math.round((n.value * 1.5 + 1) * 100) / 100 };
  if (u.kind === "identifier" && isDict(n) && typeof n.value === "string" && /\d$/.test(n.value)) return { ...n, value: n.value.slice(0, -1) + String((Number(n.value.slice(-1)) + 3) % 10) };
  if (u.kind === "name" && isDict(n) && typeof n.text === "string") return { text: n.text.slice(0, -1) + (n.text.endsWith("明") ? "華" : "明") };
  if (u.kind === "gender" && (n === "male" || n === "female")) return n === "male" ? "female" : "male";
  if (u.kind === "string" && typeof n === "string" && n.length > 1) return n + "（加重）";
  if ((u.kind === "diagnosis" || u.kind === "procedure") && isDict(n)) {
    const c = codings(n)[0];
    if (!c) return null;
    const [system, code, display] = ALT_CODE[u.kind];
    if (c.code === code) return null;
    return { coding: [{ system, code, display }] };
  }
  if (u.kind === "timing" && isDict(n)) {
    const tc = isDict(n.code) ? n.code : {};
    if (JSON.stringify(tc).includes('"TID"')) return null;
    return { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "TID" }], text: "TID" }, repeat: { frequency: 3, period: 1, periodUnit: "d" } };
  }
  if (u.kind === "route" && isDict(n) && routeWord(n) === "PO") return { coding: [{ system: "http://snomed.info/sct", code: "47625008", display: "Intravenous route" }] };
  void bundle;
  return null;
}

const NEGATABLE = new Set(["diagnosis", "procedure", "substance"]);
const EVENT_DATES = new Set([
  "Observation.effectiveDateTime",
  "Encounter.period.start",
  "DiagnosticReport.effectiveDateTime",
  "Procedure.performedDateTime",
  "Specimen.collection.collectedDateTime",
  "ImagingStudy.started",
]);
/** Record-keeping timestamps: ungrounded values are warnings by policy (spec §2.2.5), not detections. */
export const ADMIN_TIMESTAMP_PATHS = new Set([
  "MedicationRequest.authoredOn",
  "Condition.recordedDate",
  "AllergyIntolerance.recordedDate",
  "MedicationStatement.dateAsserted",
  "Observation.issued",
  "Claim.created",
  "DiagnosticReport.issued",
  "Composition.date",
  "DocumentReference.date",
]);

/** The text the renderer used for a unit's value (what a record would have to say), or null. */
export function factToken(u: Unit, terms: Terms): string | null {
  const n = u.node;
  switch (u.kind) {
    case "datetime":
      return rocDate(n);
    case "identifier":
      return isDict(n) && typeof n.value === "string" ? n.value : null;
    case "name":
      return isDict(n) ? (typeof n.text === "string" ? n.text : null) : null;
    case "gender":
      return n === "male" ? "性別：男" : n === "female" ? "性別：女" : null;
    case "quantity":
    case "obs_quantity":
    case "si_quantity":
    case "dose":
      return u.gpath.includes("referenceRange") || !isDict(n) || n.value === undefined ? null : qty(n);
    case "timing":
      return timingWord(n) || null;
    case "route":
      return routeWord(n) || null;
    case "string":
      return typeof n === "string" ? n : null;
    case "enc_class":
      return isDict(n) ? CLASS_WORD[String(n.code)] ?? null : null;
    case "status": {
      const v = isDict(n) ? codings(n)[0]?.code : n;
      return STATUS_WORD[String(v)] ?? null;
    }
    default:
      return u.cls === "coding" ? conceptName(n, terms) || null : null;
  }
}

const replaceAll = (t: string, a: string, b: string): string => t.split(a).join(b);

/**
 * Negative variants for one supported (bundle, record) pair:
 *   bundle_value       the Bundle value is altered, the record is unchanged            -> error at the unit
 *   record_removed     every occurrence of the fact is deleted from the record          -> error at the unit
 *   record_negated     every mention of the coded concept is negated (否認 …)            -> G-CONTEXT-NEGATED
 *   record_historical  every mention of the event date is marked as a past event (上次)  -> G-CONTEXT-HISTORICAL
 */
export function variants(bundle: JsonObject, text: string, units: Unit[], terms: Terms): Variant[] {
  const out: Variant[] = [];
  for (const u of units) {
    const admin = ADMIN_TIMESTAMP_PATHS.has(u.gpath);
    const alt = alteredValue(u, bundle);
    if (alt !== null) {
      const b = structuredClone(bundle);
      setAt(b, u.path, alt);
      out.push({ kind: "bundle_value", unitPath: u.path, unitKind: u.kind, bundle: b, text, admin });
    }
    const tok = factToken(u, terms);
    if (!tok || tok.length < 2 || !text.includes(tok)) continue;
    const removed = u.kind === "gender" ? replaceAll(text, tok, "性別：") : replaceAll(text, tok, "");
    out.push({ kind: "record_removed", unitPath: u.path, unitKind: u.kind, bundle, text: removed, admin });
    if (NEGATABLE.has(u.kind))
      out.push({ kind: "record_negated", unitPath: u.path, unitKind: u.kind, bundle, text: replaceAll(text, tok, "否認" + tok), expectRules: ["G-CONTEXT-NEGATED"] });
    if (u.kind === "datetime" && EVENT_DATES.has(u.gpath))
      out.push({ kind: "record_historical", unitPath: u.path, unitKind: u.kind, bundle, text: replaceAll(text, tok, "上次 " + tok), expectRules: ["G-CONTEXT-HISTORICAL"] });
  }
  return out;
}
