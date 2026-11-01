/**
 * Deterministic record renderer for the content-check false-positive harness (ISSUES_v20 R6).
 *
 * Turns a FHIR Bundle into a synthetic clinical record that states EVERY fact the grounding engine checks (its
 * source-fact and coded units, grounding enumerateUnits): one block per resource with Chinese / English labels, dates
 * in three spellings (ROC 114/06/02, 民國114年6月2日, ISO), period ranges written as one ROC range (114/06/02–115/08/31),
 * Observation code + value + unit + time on one line, medication name + dose + timing + route on one line, and every
 * fourth LOINC test named by its short-name abbreviation. A content-check ERROR on such a pair is a false positive by
 * construction. Names come from the terminology names the checks themselves compare (official names first), so the
 * renderer never writes something the record would not.
 */
import { enumerateUnits, type Unit } from "../../src/grounding/checkGrounding.js";
import type { TermRecord } from "../../src/grounding/terminologyNames.js";
import { slotsOf } from "../../src/recordChecks/slots.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

const RT_LABEL: Record<string, string> = {
  Patient: "病人基本資料",
  Practitioner: "醫師",
  PractitionerRole: "醫師職務",
  Organization: "醫療機構",
  Encounter: "就診紀錄",
  Condition: "診斷",
  Observation: "檢驗檢查",
  MedicationRequest: "處方",
  MedicationStatement: "用藥紀錄",
  MedicationDispense: "調劑",
  MedicationAdministration: "給藥",
  Medication: "藥品",
  AllergyIntolerance: "過敏史",
  Procedure: "處置",
  Immunization: "疫苗接種",
  DiagnosticReport: "檢查報告",
  ServiceRequest: "醫囑",
  Claim: "申報",
  Coverage: "保險",
  Location: "地點",
  Specimen: "檢體",
  ImagingStudy: "影像檢查",
  DocumentReference: "文件",
  Composition: "病歷摘要",
  CarePlan: "照護計畫",
  Goal: "目標",
  FamilyMemberHistory: "家族史",
  Device: "醫材",
};

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * A FHIR date / dateTime in one of three spellings (style 0 ROC slashes, 1 民國年月日, 2 ISO). Times are written as a
 * Taiwanese record writes them: local time (+08:00), seconds only when not zero.
 */
export function renderDate(v: string, style: number): string {
  let m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?)?)?)?/u.exec(v);
  if (!m) return v;
  if (m[4] && m[7]) {
    // to local time +08:00
    const t = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7]}`);
    if (!Number.isNaN(t.getTime())) {
      const l = new Date(t.getTime() + 8 * 3600 * 1000);
      const iso = l.toISOString();
      m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(iso) ?? m;
    }
  }
  const [y, mo, d, hh, mi, ss] = [Number(m[1]), m[2] ? Number(m[2]) : null, m[3] ? Number(m[3]) : null, m[4], m[5], m[6]];
  const time = hh ? ` ${hh}:${mi}${ss && ss !== "00" ? `:${ss}` : ""}` : "";
  if (mo === null) return style === 2 ? `${y}` : `${y}年`;
  if (d === null) return style === 1 ? `民國${y - 1911}年${mo}月` : `${y}-${pad(mo)}`;
  if (style === 0) return `${y - 1911}/${pad(mo)}/${pad(d)}${time}`;
  if (style === 1) return `民國${y - 1911}年${mo}月${d}日${time}`;
  return `${y}-${pad(mo)}-${pad(d)}${time}`;
}

const codings = (n: unknown): Json[] => (isObj(n) ? (Array.isArray(n.coding) ? n.coding.filter(isObj) : typeof n.code === "string" ? [n] : []) : []);

/** The name a record would write for a coded value: official name, else display, else text, else code. */
function codedName(node: unknown, terms: ReadonlyMap<string, TermRecord>, abbreviate: boolean): string {
  for (const c of codings(node)) {
    const rec = terms.get(`${c.system ?? "None"}|${c.code ?? "None"}`);
    if (rec?.found && rec.names.length) {
      if (abbreviate && c.system === "http://loinc.org" && rec.names[1]) {
        const tok = rec.names[1].split(/\s+/u)[0];
        if (/^[A-Za-z][A-Za-z0-9]{1,6}$/u.test(tok)) return `${tok} (${rec.names[0]})`;
      }
      return rec.names[0];
    }
  }
  for (const c of codings(node)) if (typeof c.display === "string" && c.display.trim()) return c.display;
  if (isObj(node) && typeof node.text === "string") return node.text;
  const c = codings(node)[0];
  return c ? String(c.code) : "";
}

const AGE_UNITS: Record<string, string> = { a: "歲", mo: "個月", wk: "週", d: "天", h: "小時", min: "分鐘" };

function quantity(q: unknown): string {
  if (!isObj(q)) return "";
  const u0 = typeof q.unit === "string" ? q.unit : typeof q.code === "string" ? q.code : "";
  const u = AGE_UNITS[u0] ?? u0;
  return `${q.comparator ?? ""}${q.value ?? ""}${u ? ` ${u}` : ""}`.trim();
}

function timing(t: unknown): string {
  if (!isObj(t)) return "";
  const r = isObj(t.repeat) ? t.repeat : null;
  const bp = r && isObj(r.boundsPeriod) ? r.boundsPeriod : null;
  const bounds = bp && (bp.start || bp.end) ? `（${bp.start ? renderDate(String(bp.start), 0) : ""}${bp.end ? ` 至 ${renderDate(String(bp.end), 0)}` : ""}）` : "";
  if (isObj(t.code)) {
    const c = codings(t.code)[0];
    return `${(t.code.text as string) ?? (c?.display as string) ?? (c?.code as string) ?? ""}${bounds}`;
  }
  if (!r) return "";
  const unit: Record<string, string> = { d: "每日", h: "每小時", wk: "每週", mo: "每月" };
  const per = r.period && r.period !== 1 ? `每${r.period}${r.periodUnit === "h" ? "小時" : r.periodUnit === "d" ? "天" : String(r.periodUnit ?? "")}` : unit[String(r.periodUnit ?? "d")] ?? "每日";
  return `${r.frequency ? `${per} ${r.frequency} 次` : ""}${bounds}`;
}

function nameText(n: unknown): string {
  if (!isObj(n)) return "";
  const given = Array.isArray(n.given) ? n.given.join(" ") : "";
  const fam = typeof n.family === "string" ? n.family : "";
  const parts = /[㐀-鿿]/u.test(fam + given) ? `${fam}${given}` : `${given} ${fam}`.trim();
  if (typeof n.text !== "string") return parts;
  return parts && parts !== n.text ? `${n.text}（${parts}）` : n.text;
}

function unitText(u: Unit, terms: ReadonlyMap<string, TermRecord>, style: number, abbreviate: boolean): string {
  const v = u.node;
  if (u.cls === "coding") return codedName(v, terms, abbreviate);
  switch (u.kind) {
    case "datetime":
      return typeof v === "string" ? renderDate(v, style) : "";
    case "quantity":
    case "obs_quantity":
    case "si_quantity":
    case "dose":
    case "duration":
      return isObj(v) && "value" in v ? quantity(v) : typeof v === "number" ? String(v) : "";
    case "identifier":
      return isObj(v) && v.value !== undefined ? `${(isObj(v.type) && (v.type.text || codings(v.type)[0]?.display)) || "識別碼"}：${v.value}` : "";
    case "name":
      return nameText(v);
    case "gender":
      return v === "male" ? "性別：男" : v === "female" ? "性別：女" : `gender: ${String(v)}`;
    case "telecom":
      return isObj(v) && v.value ? `聯絡：${v.value}` : "";
    case "timing":
      return timing(v);
    case "prn":
      return v === true ? "需要時使用 (PRN)" : "";
    default:
      if (isObj(v) && "value" in v) return quantity(v);
      return typeof v === "string" || typeof v === "number" ? String(v) : "";
  }
}

/** The medicine named by a Claim item's requestedService (PAS extension) → MedicationRequest / Medication. */
function requestedDrug(bundle: Json, item: unknown, terms: ReadonlyMap<string, TermRecord>): string {
  if (!isObj(item)) return "";
  const ref = (Array.isArray(item.extension) ? item.extension : []).map((x: Json) => x?.valueReference?.reference).find((x: unknown) => typeof x === "string");
  if (!ref) return "";
  const entries: Json[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  const find = (rf: string): Json | null => entries.find((e) => e?.fullUrl === rf || (e?.resource && `${e.resource.resourceType}/${e.resource.id}` === rf))?.resource ?? null;
  const mr = find(ref);
  if (!mr) return "";
  if (isObj(mr.medicationCodeableConcept)) return codedName(mr.medicationCodeableConcept, terms, false);
  const med = typeof mr.medicationReference?.reference === "string" ? find(mr.medicationReference.reference) : null;
  return med && isObj(med.code) ? codedName(med.code, terms, false) : isObj(mr.code) ? codedName(mr.code, terms, false) : "";
}

/** Field labels a record writes for a few elements whose context the checks read (visit dates). */
const FIELD_LABEL: Record<string, string> = { "Encounter.period": "就診期間", "Encounter.period.start": "就診日期", "Encounter.period.end": "離院日期" };
const label = (gpath: string): string => FIELD_LABEL[gpath] ?? gpath.split(".").slice(1).join(".");

/** Render a Bundle into a record text (see the module comment). */
export function renderRecord(bundle: Json, terms: ReadonlyMap<string, TermRecord>): { text: string; facts: number } {
  const lines: string[] = [];
  let facts = 0;
  const entries: Json[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  entries.forEach((e, ei) => {
    const r = isObj(e) ? e.resource : null;
    if (!isObj(r) || typeof r.resourceType !== "string") return;
    const units = enumerateUnits(r, ei).filter((u) => u.cls === "source_fact" || u.cls === "coding" || (u.cls === "unclassified" && u.kind !== "boolean" && !u.gpath.endsWith(".reference")));
    // values the record checks examine that grounding exempts (root extensions …): dates, quantities, identifiers
    const base0 = `Bundle.entry[${ei}].resource`;
    for (const sl of slotsOf({ resourceType: "Bundle", entry: entries.map((x, k) => (k === ei ? x : {})) })) {
      if (!sl.path.startsWith(base0) || units.some((u) => sl.path.startsWith(u.path))) continue;
      if (sl.kind === "date" && typeof sl.value === "string") units.push({ path: sl.path, gpath: sl.gpath, cls: "source_fact", kind: "datetime", node: sl.value, ei });
      else if (sl.kind === "quantity" && sl.holder) units.push({ path: sl.path.replace(/\.value$/u, ""), gpath: sl.gpath.replace(/\.value$/u, ""), cls: "source_fact", kind: "quantity", node: sl.holder, ei });
      else if (sl.kind === "identifier" && sl.holder) units.push({ path: sl.path.replace(/\.value$/u, ""), gpath: sl.gpath.replace(/\.value$/u, ""), cls: "source_fact", kind: "identifier", node: sl.holder, ei });
    }
    if (!units.length) return;
    facts += units.length;
    const style = ei % 3;
    const abbreviate = ei % 4 === 1;
    lines.push(`【${RT_LABEL[r.resourceType] ?? r.resourceType}】`);
    const used = new Set<string>();
    const text = (u: Unit): string => {
      used.add(u.path);
      return unitText(u, terms, style, abbreviate);
    };
    const base = `Bundle.entry[${ei}].resource`;
    // Observation: code + value + time on one line (each component likewise)
    if (r.resourceType === "Observation") {
      const parts = (pre: string): Unit[] => units.filter((u) => u.path === `${pre}.code` || u.path.startsWith(`${pre}.value`));
      const when = units.filter((u) => /^Bundle\.entry\[\d+\]\.resource\.(effective|issued)/u.test(u.path));
      const main = parts(base);
      if (main.length) lines.push(`檢驗：${main.map(text).filter(Boolean).join(" ")}${when.length ? `（${when.map(text).join("，")}）` : ""}`);
      (Array.isArray(r.component) ? r.component : []).forEach((_: unknown, i: number) => {
        const p = parts(`${base}.component[${i}]`);
        if (p.length) lines.push(`  ${p.map(text).filter(Boolean).join(" ")}`);
      });
    }
    // medication resources: medicine + dosage on one line per dosage
    if (/^Medication(Request|Statement|Administration|Dispense)$/u.test(r.resourceType)) {
      const med = units.filter((u) => u.path.startsWith(`${base}.medication`));
      const dosages = [...new Set(units.map((u) => /^(Bundle\.entry\[\d+\]\.resource\.(?:dosageInstruction|dosage)(?:\[\d+\])?)/u.exec(u.path)?.[1]).filter((x): x is string => !!x))];
      const medText = med.map(text).filter(Boolean).join(" ");
      if (dosages.length) for (const d of dosages) lines.push(`藥品：${medText} ${units.filter((u) => u.path.startsWith(d)).map(text).filter(Boolean).join(" ")}`);
      else if (medText) lines.push(`藥品：${medText}`);
    }
    // medication resources: the medicine with every other fact of the resource (dispense quantity, validity …)
    if (/^Medication(Request|Statement|Administration|Dispense)$/u.test(r.resourceType)) {
      const med = units.filter((u) => u.path.startsWith(`${base}.medication`));
      const medText = med.map((u) => unitText(u, terms, style, abbreviate)).filter(Boolean).join(" ");
      const rest = units.filter((u) => !used.has(u.path) && !u.path.startsWith(`${base}.medication`) && !/\.start$|\.end$/u.test(u.path));
      if (rest.length) lines.push(`${medText || "藥品"}：${rest.map(text).filter(Boolean).join("，")}`);
    }
    // Claim items: each item's facts on one line with the drug of its requested service
    if (r.resourceType === "Claim" && Array.isArray(r.item)) {
      r.item.forEach((it: unknown, i: number) => {
        const own = units.filter((u) => !used.has(u.path) && u.path.startsWith(`${base}.item[${i}]`));
        if (!own.length) return;
        const drug = requestedDrug(bundle, it, terms);
        lines.push(`申請項目 ${i + 1}${drug ? `（${drug}）` : ""}：${own.map(text).filter(Boolean).join("，")}`);
      });
    }
    // periods: start and end as one range
    for (const u of units) {
      if (used.has(u.path) || !u.path.endsWith(".start")) continue;
      const end = units.find((x) => x.path === u.path.replace(/\.start$/u, ".end"));
      if (!end) continue;
      lines.push(`${FIELD_LABEL[u.gpath.replace(/\.start$/u, "")] ?? label(u.gpath).replace(/\.start$/u, "")}：${text(u)}–${text(end)}`);
    }
    for (const u of units) {
      if (used.has(u.path)) continue;
      const t = text(u);
      if (t) lines.push(`${label(u.gpath)}：${t}`);
    }
  });
  return { text: lines.join("\n"), facts };
}
