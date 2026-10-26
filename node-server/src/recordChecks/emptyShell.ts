/**
 * Empty shells (ISSUES_v15.4 R1): a clinical resource whose PRIMARY payload is absent, with the absence explained in a
 * side field — the model did not write "未出" as the value, it created a resource without a value and wrote the reason
 * next to it.
 *
 *   Observation                  no value[x] and no component value (panels with hasMember are never shells); or only a
 *                                valueString that is itself an absence statement (「檢體溶血，未發報 (< 14)」 — the bracketed
 *                                number is a limit, not a result);
 *   MedicationRequest / -Statement  no structured dose or timing: no doseAndRate (dose / rate), no timing.repeat, no timing.code;
 *   Condition                    no real coding (none, or only placeholder codings), text only.
 *
 * Evidence (side fields): dataAbsentReason (code tiers, lexicon DAR_ABSENT / DAR_NOT_DONE, and its text), note, the
 * narrative text, valueString, dosage text / patientInstruction / additionalInstruction, statusReason, code.text —
 * read clause by clause with the dominance rule (lexicon absenceClauses: a clause dominated by an absence predicate
 * class, and no clause of that field states a result).
 *
 * Severity (ISSUES_v15.4 R3, false-positive control):
 *   - with source_text, the record's statement about THIS item says the information is absent (pending-result,
 *     rejected-specimen, machine-error, undecided, indistinguishable, conditional-on-future-result, not-obtained) →
 *     error `information-absent`, quoting the record. The item is located by its names (code.text / displays / vital-sign
 *     labels / terminology names incl. Chinese / medicine names; a Condition also by its text parts and the record's
 *     diagnosis slot) — the statement is the mention's clause and the following clauses of its sentence, up to the first
 *     clause that states a result — or by the side text itself (a record clause that the side clause copies or
 *     paraphrases, character-bigram Dice ≥ 0.5, or of the same absence class with the same / a near predicate);
 *   - the record says the item was simply not done (本次未做 X 光, 拒絕抽血, not performed) → warning (legitimate when the
 *     conversion target does not need the item);
 *   - the record does not confirm (item not located, or its statement neutral) and the side text is an absence statement
 *     → warning; a dataAbsentReason code alone → nothing;
 *   - without source_text: warning only when the side text itself is an absence statement (absent tier); not-done or a
 *     dataAbsentReason code alone → nothing. So a clean call without source_text stays byte-identical (v15 guarantee);
 *   - status entered-in-error → never; Observation cancelled / MedicationStatement not-taken → warning at most, and
 *     nothing when a not-done reason (DAR not-performed / a not-done clause) explains it.
 * A resource some other record check already reported as information-absent (or with any record-check error) is skipped.
 */
import { nfkc, norm, VITAL_LABELS } from "../grounding/lexicon.js";
import { RecordText } from "../grounding/recordText.js";
import { absenceClauses, ABSENT_TIER, CLASS_ZH, clausesOf, dataAbsentTier, RECORD_CHECKS_LEXICON_VERSION, type AbsenceClass, type ClauseHit } from "./lexicon.js";
import { diagnosisSlots } from "./diagnosisSlot.js";
import { makeIssue } from "./issue.js";
import { quantitativeBasis } from "./quantitative.js";
import { placeholderCoding, resourcesOf } from "./slots.js";
import type { RecordCheckOptions, RecordIssue } from "./types.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const SKIP_SECTIONS = new Set(["instruction", "site_config", "family_history"]);
const MED_SHELLS: Record<string, string> = { MedicationRequest: "dosageInstruction", MedicationStatement: "dosage" };
const RE_SENTENCE_END = /[。；;\n]/u;
const RE_CLAUSE_BOUNDARY = /[，,。；;！!？?\n]/u;
const RE_LABEL_START = /^\s*[^\s:：，,]{1,16}\s*[:：]/u;
/** Hedges (to be confirmed) — of a NAMED diagnosis they mean "suspected", which provisional encodes correctly. */
const RE_HEDGE = /待確認|待釐清|未確定|不確定|尚未確定|尚待確認|to\s+be\s+confirmed|not\s+(yet\s+)?confirmed|unconfirmed/gu;
const PROVISIONAL = new Set(["provisional", "differential", "unconfirmed"]);

interface SideText {
  path: string;
  field: string;
  text: string;
  hits: ClauseHit[];
}

interface Shell {
  base: string;
  resource: Json;
  kind: "observation" | "medication" | "condition";
  whatZh: string;
  whatEn: string;
  sides: SideText[];
  dar: { code: string; tier: "absent" | "not-done"; path: string } | null;
  /** cancelled / not-taken: warning at most. */
  capped: boolean;
  names: string[];
  result: boolean;
}

function stripTags(div: unknown): string {
  return typeof div === "string" ? div.replace(/<[^>]+>/gu, " ").replace(/&[a-z]+;/gu, " ").replace(/\s+/gu, " ").trim() : "";
}

function side(path: string, field: string, text: unknown, result: boolean, out: SideText[]): void {
  if (typeof text !== "string" || !text.trim()) return;
  out.push({ path, field, text: text.trim(), hits: absenceClauses(text, { result, limits: true }) });
}

function notes(r: Json, base: string, result: boolean, out: SideText[]): void {
  (Array.isArray(r.note) ? r.note : []).forEach((n: unknown, i: number) => {
    if (isObj(n)) side(`${base}.note[${i}].text`, "note", n.text, result, out);
  });
  if (isObj(r.text)) side(`${base}.text.div`, "text", stripTags(r.text.div), result, out);
}

function darOf(r: Json, base: string): Shell["dar"] {
  const holders: Array<[Json, string]> = [[r, base]];
  (Array.isArray(r.component) ? r.component : []).forEach((c: unknown, i: number) => {
    if (isObj(c)) holders.push([c, `${base}.component[${i}]`]);
  });
  for (const [h, p] of holders) {
    const d = h.dataAbsentReason;
    if (!isObj(d)) continue;
    for (const c of Array.isArray(d.coding) ? d.coding : []) {
      const tier = isObj(c) ? dataAbsentTier(c.code) : null;
      if (tier) return { code: String(c.code), tier, path: `${p}.dataAbsentReason` };
    }
  }
  return null;
}

function codeNames(cc: unknown, names: ReadonlyMap<string, readonly string[]> | null | undefined): string[] {
  const out: string[] = [];
  if (!isObj(cc)) return out;
  if (typeof cc.text === "string") out.push(cc.text);
  for (const c of Array.isArray(cc.coding) ? cc.coding : []) {
    if (!isObj(c)) continue;
    if (typeof c.display === "string") out.push(c.display.replace(/\s*\([a-z ]+\)\s*$/iu, ""));
    for (const l of (VITAL_LABELS as Record<string, string[]>)[String(c.code ?? "")] ?? []) out.push(l);
    for (const l of names?.get(`${c.system}|${c.code}`) ?? []) out.push(l);
  }
  return out;
}

const hasValue = (h: Json): boolean => Object.keys(h).some((k) => k.startsWith("value") && h[k] !== null && h[k] !== undefined);

function observationShell(r: Json, base: string, opts: RecordCheckOptions, all: Json[]): Shell | null {
  if (Array.isArray(r.hasMember) && r.hasMember.length) return null;
  const comps: Json[] = Array.isArray(r.component) ? r.component.filter(isObj) : [];
  const valueKeys = Object.keys(r).filter((k) => k.startsWith("value") && r[k] !== null && r[k] !== undefined);
  const result = quantitativeBasis(r, null, opts.codeAxes ?? null, all) !== null;
  const sides: SideText[] = [];
  if (valueKeys.length) {
    // only a valueString that is itself an absence statement makes a shell
    if (valueKeys.length !== 1 || valueKeys[0] !== "valueString" || typeof r.valueString !== "string") return null;
    side(`${base}.valueString`, "valueString", r.valueString, result, sides);
    if (!sides[0]?.hits.length) return null;
  }
  for (const [i, c] of comps.entries()) {
    if (!hasValue(c)) continue;
    if (typeof c.valueString !== "string") return null;
    const s: SideText[] = [];
    side(`${base}.component[${i}].valueString`, "component.valueString", c.valueString, true, s);
    if (!s[0]?.hits.length) return null;
    sides.push(...s);
  }
  if (isObj(r.dataAbsentReason)) side(`${base}.dataAbsentReason.text`, "dataAbsentReason.text", r.dataAbsentReason.text, result, sides);
  comps.forEach((c, i) => {
    if (isObj(c.dataAbsentReason)) side(`${base}.component[${i}].dataAbsentReason.text`, "component.dataAbsentReason.text", c.dataAbsentReason.text, true, sides);
  });
  notes(r, base, result, sides);
  const names = [...codeNames(r.code, opts.codeNames), ...comps.flatMap((c) => codeNames(c.code, opts.codeNames))];
  return {
    base, resource: r, kind: "observation", whatZh: "結果值（value[x]）", whatEn: "result (value[x])", sides, dar: darOf(r, base),
    capped: r.status === "cancelled", names, result,
  };
}

function hasStructuredDosage(d: unknown): boolean {
  if (!isObj(d)) return false;
  for (const dr of Array.isArray(d.doseAndRate) ? d.doseAndRate : []) {
    if (!isObj(dr)) continue;
    if (isObj(dr.doseQuantity) && dr.doseQuantity.value !== undefined && dr.doseQuantity.value !== null) return true;
    if (isObj(dr.doseRange) || isObj(dr.rateQuantity) || isObj(dr.rateRatio) || isObj(dr.rateRange)) return true;
  }
  if (isObj(d.dose) && d.dose.value !== undefined && d.dose.value !== null) return true;
  const t = d.timing;
  return isObj(t) && ((isObj(t.repeat) && Object.keys(t.repeat).length > 0) || isObj(t.code));
}

function medicationShell(r: Json, base: string, opts: RecordCheckOptions, meds: Map<string, Json>): Shell | null {
  const key = MED_SHELLS[r.resourceType];
  const dosages: unknown[] = Array.isArray(r[key]) ? r[key] : isObj(r[key]) ? [r[key]] : [];
  if (dosages.some(hasStructuredDosage)) return null;
  const sides: SideText[] = [];
  dosages.forEach((d, i) => {
    if (!isObj(d)) return;
    const p = `${base}.${key}[${i}]`;
    side(`${p}.text`, `${key}.text`, d.text, false, sides);
    side(`${p}.patientInstruction`, `${key}.patientInstruction`, d.patientInstruction, false, sides);
    (Array.isArray(d.additionalInstruction) ? d.additionalInstruction : []).forEach((a: unknown, j: number) => {
      if (isObj(a)) side(`${p}.additionalInstruction[${j}].text`, `${key}.additionalInstruction.text`, a.text, false, sides);
    });
  });
  if (isObj(r.statusReason)) side(`${base}.statusReason.text`, "statusReason.text", r.statusReason.text, false, sides);
  notes(r, base, false, sides);
  const names = codeNames(r.medicationCodeableConcept, opts.codeNames);
  if (isObj(r.medicationReference) && typeof r.medicationReference.reference === "string") {
    const m = meds.get(r.medicationReference.reference);
    if (m) names.push(...codeNames(m.code, opts.codeNames));
    if (typeof r.medicationReference.display === "string") names.push(r.medicationReference.display);
  }
  // the name without the strength (「某藥 200 mg」 → 「某藥」)
  for (const n of [...names]) {
    const bare = n.replace(/[\d.,]+\s*[a-zA-Zµμ%/一-鿿]{0,6}.*$/u, "").trim();
    if (bare && bare !== n) names.push(bare);
  }
  return {
    base, resource: r, kind: "medication", whatZh: "結構化劑量或頻次（doseAndRate / timing）", whatEn: "structured dose or timing (doseAndRate / timing)", sides,
    dar: null, capped: r.status === "not-taken" || r.status === "cancelled", names, result: false,
  };
}

function conditionShell(r: Json, base: string): Shell | null {
  const vs = isObj(r.verificationStatus) && Array.isArray(r.verificationStatus.coding) ? r.verificationStatus.coding.map((c: unknown) => (isObj(c) ? c.code : null)) : [];
  if (vs.includes("refuted")) return null;
  const cc = r.code;
  if (isObj(cc) && Array.isArray(cc.coding) && cc.coding.some((c: unknown) => !placeholderCoding(c))) return null;
  const sides: SideText[] = [];
  if (isObj(cc)) side(`${base}.code.text`, "code.text", cc.text, false, sides);
  notes(r, base, false, sides);
  const names: string[] = [];
  if (isObj(cc) && typeof cc.text === "string") {
    names.push(cc.text);
    // the concepts a "cannot tell A from B" text names (支氣管炎與早期肺炎尚難區分 → 支氣管炎, 早期肺炎)
    for (const part of nfkc(cc.text).split(/與|和|或|及|還是|、|\/|／|\bvs\.?\b|\bor\b|\band\b|，|,/u)) {
      const p = part.replace(/(尚難|難以|無法|不易|仍難|尚無法)?(區分|區別|鑑別|分辨)(中)?|待排除|待確認|未定/gu, "").trim();
      if (p.length >= 2) names.push(p);
    }
  }
  return { base, resource: r, kind: "condition", whatZh: "診斷代碼（Condition.code.coding）", whatEn: "diagnosis code (Condition.code.coding)", sides, dar: null, capped: false, names, result: false };
}

// ------------------------------------------------------------------------------------------- record statement

interface Statement {
  quote: string;
  hit: ClauseHit;
  how: string;
}

function bigrams(s: string): Map<string, number> {
  const t = norm(s);
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < t.length; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let n = 0;
  let tx = 0;
  let ty = 0;
  for (const v of x.values()) tx += v;
  for (const v of y.values()) ty += v;
  for (const [g, v] of x) n += Math.min(v, y.get(g) ?? 0);
  return tx + ty ? (2 * n) / (tx + ty) : 0;
}

/** The record's statement about a mention: its clause and the following clauses of the sentence, up to a clause stating a result. */
function statementAt(line: string, start: number, result: boolean): { text: string; hits: ClauseHit[] } {
  let s0 = 0;
  for (let i = start - 1; i >= 0; i--) if (RE_CLAUSE_BOUNDARY.test(line[i])) { s0 = i + 1; break; }
  let s1 = line.length;
  for (let i = start; i < line.length; i++) if (RE_SENTENCE_END.test(line[i])) { s1 = i; break; }
  const text = line.slice(s0, s1);
  const hits: ClauseHit[] = [];
  const cs = clausesOf(text, { result, limits: true });
  for (const [k, c] of cs.entries()) {
    if (c.result) break; // a value: the statement about this item ends (or the item has a value)
    if (k > 0 && RE_LABEL_START.test(c.clause)) break; // the next labelled item
    if (c.hit) hits.push(c.hit);
  }
  return { text: text.trim(), hits };
}

function locate(shell: Shell, rt: RecordText): { absent: Statement | null; notDone: Statement | null; mentioned: boolean } {
  let absent: Statement | null = null;
  let notDone: Statement | null = null;
  let mentioned = false;
  const take = (st: Statement): void => {
    if (ABSENT_TIER.has(st.hit.cls)) absent ??= st;
    else if (st.hit.cls === "not-done") notDone ??= st;
  };
  // 1. by the item's names
  const seen = new Set<string>();
  for (const n0 of shell.names) {
    const n = n0.trim();
    if (n.length < 2 || seen.has(n)) continue;
    seen.add(n);
    for (const o of rt.find(n)) {
      if (o.origin !== "record" || o.li === null || SKIP_SECTIONS.has(o.section)) continue;
      mentioned = true;
      const ln = rt.lines[o.li];
      const st = statementAt(ln.line, o.start - ln.start, shell.result);
      for (const h of st.hits) take({ quote: clip(st.text), hit: h, how: `record mention of '${clip(n, 30)}'` });
    }
    if (absent) break;
  }
  // 2. Condition: the record's diagnosis slot says it is not established / indistinguishable
  if (!absent && shell.kind === "condition") {
    for (const s of diagnosisSlots(rt)) {
      if (s.empty) continue;
      const text = s.quote;
      for (const h of absenceClauses(text.replace(/^[^:：]{1,32}[:：]/u, ""), {})) {
        if (ABSENT_TIER.has(h.cls)) {
          absent = { quote: clip(text), hit: h, how: `the record's diagnosis slot '${s.heading}'` };
          break;
        }
      }
      if (!absent && s.unestablished && s.strength === "explicit") absent = { quote: clip(text), hit: { clause: text, cls: "undecided", predicate: s.slotCue ?? s.heading }, how: `the record's diagnosis slot '${s.heading}' (unestablished)` };
      if (absent) break;
    }
  }
  // 3. by the side text: a record clause of the same tier that the side clause copies / paraphrases
  if (!absent) {
    const sideHits = shell.sides.flatMap((s) => s.hits);
    if (sideHits.length) {
      for (const ln of rt.lines) {
        if (SKIP_SECTIONS.has(ln.section) || !ln.line.trim()) continue;
        for (const c of clausesOf(ln.line, { result: shell.result, limits: true })) {
          if (!c.hit) continue;
          const score = (h: ClauseHit): number => {
            if (norm(c.clause).includes(norm(h.clause)) && norm(h.clause).length >= 4) return 1;
            // the same predicate class with the same / a near predicate (溶血 … 不予發報 vs 溶血，未發報)
            const samePred = c.hit!.cls === h.cls && ABSENT_TIER.has(h.cls) && (norm(c.hit!.predicate) === norm(h.predicate) || dice(c.hit!.predicate, h.predicate) >= 0.6);
            return Math.max(dice(c.clause, h.clause), samePred ? 0.5 : 0);
          };
          const best = Math.max(...sideHits.map(score));
          if (best >= 0.5) take({ quote: clip(ln.line.trim()), hit: c.hit, how: `record clause matching the side text (similarity ${best.toFixed(2)}; same class and predicate counts 0.50)` });
        }
        if (absent) break;
      }
    }
  }
  return { absent, notDone, mentioned };
}

// ------------------------------------------------------------------------------------------- driver

const classList = (hs: ClauseHit[]): string => [...new Set(hs.map((h) => h.cls))].join(", ");
const classZh = (cls: AbsenceClass): string => CLASS_ZH[cls];

function describeSide(shell: Shell): { zh: string; en: string; path: string; hits: ClauseHit[] } {
  const s = shell.sides.find((x) => x.hits.some((h) => ABSENT_TIER.has(h.cls))) ?? shell.sides.find((x) => x.hits.length);
  if (s) return { zh: `${s.field}「${clip(s.text, 60)}」`, en: `${s.field} "${clip(s.text, 60)}"`, path: s.path, hits: s.hits };
  if (shell.dar) return { zh: `dataAbsentReason = ${shell.dar.code}`, en: `dataAbsentReason = ${shell.dar.code}`, path: shell.dar.path, hits: [] };
  return { zh: "", en: "", path: shell.base, hits: [] };
}

export function emptyShellChecks(root: Json, opts: RecordCheckOptions, existing: readonly RecordIssue[]): RecordIssue[] {
  const recordText = typeof opts.sourceText === "string" && opts.sourceText.trim() ? opts.sourceText : null;
  const rs = resourcesOf(root);
  const all = rs.map((r) => r.resource);
  const meds = new Map<string, Json>();
  for (const r of rs) {
    if (r.resource.resourceType !== "Medication") continue;
    if (r.fullUrl) meds.set(r.fullUrl, r.resource);
    if (typeof r.resource.id === "string") meds.set(`Medication/${r.resource.id}`, r.resource);
  }
  let rt: RecordText | null = null;
  const out: RecordIssue[] = [];
  for (const r of rs) {
    const res = r.resource;
    if (res.status === "entered-in-error") continue;
    const base = r.base;
    if (existing.some((i) => (i.path === base || i.path.startsWith(`${base}.`)) && (i.severity === "error" || i.code === "information-absent"))) continue;
    let shell: Shell | null = null;
    try {
      if (res.resourceType === "Observation") shell = observationShell(res, base, opts, all);
      else if (MED_SHELLS[res.resourceType] !== undefined) shell = medicationShell(res, base, opts, meds);
      else if (res.resourceType === "Condition") shell = conditionShell(res, base);
    } catch {
      shell = null;
    }
    if (!shell) continue;
    const sideAbsent = shell.sides.flatMap((s) => s.hits).filter((h) => ABSENT_TIER.has(h.cls));
    const sideNotDone = shell.sides.flatMap((s) => s.hits).filter((h) => h.cls === "not-done");
    if (!sideAbsent.length && !sideNotDone.length && !shell.dar) continue;
    const legitNotDone = shell.dar?.tier === "not-done" || (sideNotDone.length > 0 && !sideAbsent.length);
    if (shell.kind === "condition" && sideAbsent.length && sideAbsent.every((h) => h.cls === "undecided" && new RegExp(RE_HEDGE.source, "u").test(h.predicate))) {
      // 「高血壓（待確認）」: a named diagnosis with a hedge is a suspected diagnosis — provisional is its correct encoding
      const text = isObj(res.code) && typeof res.code.text === "string" ? nfkc(res.code.text) : "";
      const named = text.replace(RE_HEDGE, "").replace(/[\s\p{P}\p{S}]/gu, "").length >= 2;
      const vs = isObj(res.verificationStatus) && Array.isArray(res.verificationStatus.coding) ? res.verificationStatus.coding.map((c: unknown) => (isObj(c) ? String(c.code) : "")) : [];
      if (named && vs.some((c: string) => PROVISIONAL.has(c))) continue;
      if (named) shell.capped = true;
    }
    const d = describeSide(shell);
    const hint = "若轉換目標需要這個值，請回報 insufficient_information，不要建立空的資源";
    const hintEn = "If the conversion target needs this value, report insufficient_information instead of creating an empty resource";
    const shellBasis = `R1 empty shell (ISSUES_v15.4): ${res.resourceType} without ${shell.whatEn}; side fields read clause by clause with the dominance rule (${RECORD_CHECKS_LEXICON_VERSION}): ` +
      `${shell.sides.length ? shell.sides.map((s) => `${s.field} → ${s.hits.length ? classList(s.hits) : "no absence clause"}`).join("; ") : "no side text"}` +
      `${shell.dar ? `; dataAbsentReason ${shell.dar.code} (${shell.dar.tier})` : ""}`;
    if (!recordText) {
      // no record: report only an explicit absence statement of the resource itself (keeps clean calls byte-identical)
      if (!sideAbsent.length || (shell.capped && legitNotDone)) continue;
      out.push(makeIssue(
        "R1", "warning", "information-absent", d.path,
        `這筆資源沒有${shell.whatZh}，而${d.zh}說明這項資訊沒有／未出／未定（${[...new Set(sideAbsent.map((h) => classZh(h.cls)))].join("、")}）；沒有提供病歷，無法確認。${hint}`,
        `This resource carries no ${shell.whatEn}, and ${d.en} says the information is absent / not out / not decided (${classList(sideAbsent)}); no record was given to confirm it. ${hintEn}`,
        `${shellBasis}; no source_text, so warning (error needs the record's statement about this item)`,
      ));
      continue;
    }
    rt ??= new RecordText(recordText, opts.siteConfig ?? null);
    const loc = locate(shell, rt);
    if (loc.absent && !(shell.capped && legitNotDone)) {
      const st = loc.absent;
      const severity = shell.capped ? "warning" : "error";
      out.push(makeIssue(
        "R1", severity, "information-absent", d.path,
        `病歷沒有提供這項資訊：這筆資源沒有提供病歷中應有的值；病歷寫的是「${st.quote}」（${classZh(st.hit.cls)}）。這筆資源沒有${shell.whatZh}${d.zh ? `，只在${d.zh}說明` : ""}。${hint}`,
        `The record does not provide this information: this resource does not carry the value the record should give; the record says "${st.quote}" (${st.hit.cls}). The resource has no ${shell.whatEn}${d.en ? `, only ${d.en}` : ""}. ${hintEn}`,
        `${shellBasis}; record statement located by ${st.how}: clause '${clip(st.hit.clause, 60)}' → ${st.hit.cls} ('${st.hit.predicate}')${shell.capped ? `; status ${res.status}, so warning` : ""}`,
        [st.quote],
      ));
      continue;
    }
    if (loc.notDone) {
      if (!sideAbsent.length && !shell.dar && !sideNotDone.length) continue;
      if (legitNotDone && shell.capped) continue;
      const st = loc.notDone;
      out.push(makeIssue(
        "R1", "warning", "information-absent", d.path,
        `這筆資源沒有${shell.whatZh}；病歷寫的是「${st.quote}」（未做）。若轉換目標不需要這個項目，可以不建立這筆資源；若需要，請回報 insufficient_information`,
        `This resource carries no ${shell.whatEn}; the record says "${st.quote}" (not done). If the conversion target does not need this item, leave the resource out; if it does, report insufficient_information`,
        `${shellBasis}; record statement located by ${st.how}: '${clip(st.hit.clause, 60)}' → not-done, so warning at most`,
        [st.quote],
      ));
      continue;
    }
    if (!sideAbsent.length || legitNotDone) continue;
    out.push(makeIssue(
      "R1", "warning", "information-absent", d.path,
      `這筆資源沒有${shell.whatZh}，而${d.zh}說明這項資訊沒有／未出／未定（${[...new Set(sideAbsent.map((h) => classZh(h.cls)))].join("、")}）；病歷中${loc.mentioned ? "關於這個項目的敘述沒有這樣寫" : "找不到這個項目"}，無法確認。${hint}`,
      `This resource carries no ${shell.whatEn}, and ${d.en} says the information is absent / not out / not decided (${classList(sideAbsent)}); the record ${loc.mentioned ? "does not say so about this item" : "does not mention this item"}, so it cannot be confirmed. ${hintEn}`,
      `${shellBasis}; the record's statement about this item ${loc.mentioned ? "is neutral / states a value" : "was not located (names and side text searched)"}, so warning`,
    ));
  }
  return out;
}
