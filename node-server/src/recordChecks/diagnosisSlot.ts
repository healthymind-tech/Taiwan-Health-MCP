/**
 * Primary diagnosis slot (ISSUES_v15.1 R3; v15 R4 made mandatory) — needs source_text.
 *
 * The record's diagnosis slot is the text after a diagnosis heading (lexicon DX_SLOT: Dx / Diagnosis /
 * Impression / Assessment / A: / 診斷 / 主診斷 / 臆斷 …; 鑑別診斷 / DDx / r/o headings make a
 * differential-only slot; 次診斷 / comorbidities are never primary), plus its continuation lines. The
 * slot is read as a list of items (top-level separators 、 ； , ／ vs 或 …, numbered items), each with the
 * uncertainty cues that SCOPE over it:
 *
 *   - a cue inside a bracket that holds another noun phrase qualifies THAT phrase only:
 *     「Elevated PSA（未確立惡性腫瘤）」 — 未確立 modifies 惡性腫瘤, the item Elevated PSA stays plain;
 *     a bracket holding only a cue (「肺炎（待排除）」, "(r/o)", "(?)") qualifies its item;
 *   - a prefix cue opening the list (鑑別 A／B／C, 待排除 A、B, r/o A vs B) governs every item after it;
 *     an item made only of a postfix cue (…，尚未確立) governs every item before it;
 *   - slot-level cues (未下診斷, 診斷未定, no definitive diagnosis, 快篩結果出來前不下診斷 …) say the slot
 *     as a whole is not established.
 *
 * A slot is UNESTABLISHED when it is differential-only, carries a slot-level cue, or every item is
 * under a cue. Then a Condition that is not verificationStatus provisional / differential / unconfirmed
 * (refuted / entered-in-error never count) is an `unconfirmed-as-confirmed` error when it is:
 * one of the slot's items; a Condition.code.text that copies the list; a symptom code (ICD-10 R00–R99,
 * a SNOMED finding by its semantic tag, or a concept the record names only in the complaint / history
 * of present illness / examination) standing in for the main diagnosis; or any other diagnosis the
 * record does not establish — unless the record establishes it elsewhere (a plain item of another
 * primary slot, a past-history / secondary-diagnosis line: a comorbidity). Hedged slots (疑似 /
 * possible only) give a warning. An established item of any primary slot always wins.
 *
 * ISSUES_v15.3 R2 — provisional / differential is no stand-in for an established PRIMARY diagnosis. When
 * no primary slot of the record is established and the record says so explicitly (a differential-only
 * slot, a slot-level cue such as 未下診斷 / 暫不下診斷 / diagnosis pending, every item under an explicit
 * cue such as 待排除 / r/o, or an empty 「診斷：」), the Bundle's primary Condition (primaryCondition())
 * written as provisional / differential / unconfirmed, or with a text-only code, is an
 * `information-absent` error: 「病歷沒有確立的主診斷」. Hedged slots (疑似 / possible) are not reported
 * (provisional is the right encoding of a suspected diagnosis). Only the primary Condition is examined:
 * a secondary Condition marked differential for an explicit "r/o X" of the record is correct and never
 * reported, and when the record has an established primary item the rule does not apply at all.
 */
import { nameSimilarity, nfkc, norm } from "../grounding/lexicon.js";
import { RecordText } from "../grounding/recordText.js";
import { confirmsIn, cuesIn, DX_SLOT } from "./lexicon.js";
import { makeIssue } from "./issue.js";
import { placeholderCoding, resourcesOf } from "./slots.js";
import type { RecordIssue } from "./types.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (s: string, n = 100): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export const NOT_CONFIRMED = new Set(["provisional", "differential", "unconfirmed", "refuted", "entered-in-error"]);

type Strength = "explicit" | "uncertain";

interface SlotItem {
  text: string;
  core: string;
  strength: Strength | null;
  confirmed: boolean;
  /** The item was considered and excluded (已排除, ruled out): neither established nor open. */
  refuted: boolean;
  cue: string | null;
}

export interface DxSlot {
  kind: "primary" | "differential";
  heading: string;
  lines: number[];
  quote: string;
  items: SlotItem[];
  slotCue: string | null;
  unestablished: boolean;
  strength: Strength;
  /** The heading is there but the slot is empty (「診斷：」). */
  empty?: boolean;
  /** Concepts a bracket qualifies with a cue (「Elevated PSA（未確立惡性腫瘤）」 → 惡性腫瘤, explicit). */
  qualifiers: SlotItem[];
}

const SKIP = new Set(["instruction", "site_config", "family_history"]);
const RE_PREFIX = /^\s*(?:[#*•●・\-]+|\(?\d{1,2}[.)、]|[(（]\d{1,2}[)）]|【|\[)?\s*/u;
const RE_LIST_LINE = /^\s*(?:[#*•●・\-]+|\(?\d{1,2}[.)、]|[(（]\d{1,2}[)）])\s*/u;
const RE_LABEL = /^([^:：]{1,32}?)\s*[】\]]?\s*[:：]\s*/u;
const RE_NEXT_HEADING = /(?:^|[\s；;。|])(p|plan|處置|計畫|計劃|治療計畫|治療|tx|rx|處方|醫囑|s|o|主訴|cc|檢查|lab)\s*[:：]/u;
const OPEN = "(（[【";
const CLOSE = ")）]】";

function headingKind(label0: string): "primary" | "differential" | "secondary" | null {
  const label = nfkc(label0).replace(/[(（][^)）]*[)）]/gu, "").replace(/[【】[\]]/gu, "").trim();
  if (!label) return null;
  const parts = [label, ...label.split(/\s*[/／、,]\s*/u).filter(Boolean)];
  for (const p of parts) if (DX_SLOT.secondary.has(p)) return "secondary";
  for (const p of parts) if (DX_SLOT.differential.has(p)) return "differential";
  for (const p of parts) if (DX_SLOT.primary.has(p)) return "primary";
  return null;
}

/** Split at top-level separators (outside brackets); keeps r/o, a/p, s/p and digit/digit together. */
function splitItems(c: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  const seps = DX_SLOT.separators;
  for (let i = 0; i < c.length; ) {
    const ch = c[i];
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const num = /^\s+\(?\d{1,2}[.)、]\s*/u.exec(c.slice(i));
      if (num && cur.trim()) {
        out.push(cur);
        cur = "";
        i += num[0].length;
        continue;
      }
      const sep = seps.find((s) => c.startsWith(s, i));
      if (sep) {
        const prev = c[i - 1] ?? "";
        const next = c[i + sep.length] ?? "";
        const slashPair = (sep === "/" || sep === "／") && ((/[a-z]/u.test(prev) && !/[a-z]/u.test(c[i - 2] ?? "") && /[a-z]/u.test(next) && !/[a-z]/u.test(c[i + 2] ?? "")) || (/\d/u.test(prev) && /\d/u.test(next)));
        if (!slashPair) {
          out.push(cur);
          cur = "";
          i += sep.length;
          continue;
        }
      }
    }
    cur += ch;
    i++;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Bracket groups of an item at depth 1, and the item without them. */
function groupsOf(item: string): { core: string; groups: string[] } {
  const groups: string[] = [];
  let core = "";
  let depth = 0;
  let g = "";
  for (const ch of item) {
    if (OPEN.includes(ch)) {
      if (depth === 0) g = "";
      else g += ch;
      depth++;
      continue;
    }
    if (CLOSE.includes(ch) && depth > 0) {
      depth--;
      if (depth === 0) groups.push(g);
      else g += ch;
      continue;
    }
    if (depth === 0) core += ch;
    else g += ch;
  }
  if (depth > 0) groups.push(g);
  return { core: core.trim(), groups };
}

const RE_RESIDUE = /[\s\p{P}\p{S}]|^(待|中|的|之|仍|尚|目前|still|yet)$/gu;
/** Text minus its cues and fillers: what the cue could qualify. */
function residue(t: string): string {
  let r = t;
  // one removal per span (a cue such as 待排除 is reported as both a prefix and a postfix reading)
  const spans = [...new Map(cuesIn(t).map((c) => [`${c.start}:${c.end}`, c])).values()].sort((a, b) => b.start - a.start);
  for (const c of spans) r = r.slice(0, c.start) + " ".repeat(c.end - c.start) + r.slice(c.end);
  for (const sc of DX_SLOT.slotCues) r = r.split(sc).join(" ");
  return r.replace(RE_RESIDUE, "").replace(/\b(dx|diagnosis|診斷)\b/gu, "").trim();
}

function slotLevelCue(t: string): string | null {
  for (const sc of DX_SLOT.slotCues) {
    const i = t.indexOf(sc);
    if (i < 0) continue;
    const j = i + sc.length;
    if (/[a-z]/u.test(sc[0]) && i > 0 && /[a-z]/u.test(t[i - 1])) continue;
    if (/[a-z]/u.test(sc[sc.length - 1]) && j < t.length && /[a-z]/u.test(t[j])) continue;
    return sc;
  }
  for (const rx of DX_SLOT.slotCuePatterns) {
    const m = rx.exec(t);
    if (m) return m[0];
  }
  return null;
}

function readItem(text: string): SlotItem {
  const { core, groups } = groupsOf(text);
  let strength: Strength | null = null;
  let cue: string | null = null;
  const take = (s: Strength, c: string): void => {
    if (strength !== "explicit") {
      strength = s;
      cue = c;
    }
  };
  const coreCues = cuesIn(core);
  for (const c of coreCues) take(c.strength, c.cue);
  // a bracket with only a cue qualifies the item; a bracket with a cue AND a noun phrase qualifies that phrase (R5)
  for (const g of groups) {
    const gc = cuesIn(g);
    if (gc.length && residue(g).length <= 1) for (const c of gc) take(c.strength, c.cue);
  }
  const confirmed = confirmsIn(core, coreCues).length > 0;
  return { text, core: residue(core) ? core : text, strength: confirmed ? null : strength, confirmed, refuted: false, cue };
}

/** The concepts brackets of an item qualify with a cue: 「（未確立惡性腫瘤）」 → 惡性腫瘤 (explicit). */
function qualifiersOf(text: string): SlotItem[] {
  const out: SlotItem[] = [];
  for (const g of groupsOf(text).groups) {
    const gc = cuesIn(g);
    if (!gc.length || residue(g).length <= 1) continue;
    let core = g;
    for (const c of [...new Map(gc.map((x) => [`${x.start}:${x.end}`, x])).values()].sort((a, b) => b.start - a.start)) core = core.slice(0, c.start) + " " + core.slice(c.end);
    const strength: Strength = gc.some((c) => c.strength === "explicit") ? "explicit" : "uncertain";
    out.push({ text: g, core: core.replace(/\s+/gu, " ").trim(), strength, confirmed: false, refuted: false, cue: gc[0].cue });
  }
  return out;
}

/** Find the diagnosis slots of a record. */
export function diagnosisSlots(rt: RecordText): DxSlot[] {
  const out: DxSlot[] = [];
  const used = new Set<number>();
  rt.lines.forEach((ln, li) => {
    if (SKIP.has(ln.section) || used.has(li) || !ln.line.trim()) return;
    const t = nfkc(ln.line);
    // a heading may also open a later clause of the line (…，Dx: X / 三項皆超標 → Dx: X)
    const segs = [t, ...t.split(/[；;。|，,]\s*|\s*(?:→|->|=>)\s*/u).slice(1)];
    for (const seg of segs) {
      const s0 = seg.replace(RE_PREFIX, "");
      const m = RE_LABEL.exec(s0);
      if (!m) continue;
      const kind = headingKind(m[1]);
      if (kind === null || kind === "secondary") continue;
      let content = s0.slice(m[0].length);
      const nx = RE_NEXT_HEADING.exec(content);
      if (nx && nx.index > 0) content = content.slice(0, nx.index);
      const lines = [li];
      const parts: string[] = content.trim() ? [content] : [];
      for (let j = li + 1; j < rt.lines.length && j <= li + 8; j++) {
        const nl = rt.lines[j];
        if (!nl.line.trim() || nl.header || SKIP.has(nl.section)) break;
        const nt = nfkc(nl.line);
        const lm = RE_LABEL.exec(nt.replace(RE_PREFIX, ""));
        if (lm && !RE_LIST_LINE.test(nt)) break;
        if (!RE_LIST_LINE.test(nt) && nl.section !== "diagnosis" && nl.section !== "rule_out") break;
        parts.push(nt.replace(RE_LIST_LINE, ""));
        lines.push(j);
        used.add(j);
      }
      if (!parts.length) {
        // 「診斷：」 with nothing after it: the record's diagnosis slot is empty
        out.push({ kind, heading: m[1].trim(), lines, quote: clip(ln.line.trim()), items: [], slotCue: null, unestablished: false, strength: "explicit", empty: true, qualifiers: [] });
        break;
      }
      const whole = parts.join("；");
      const slotCue = slotLevelCue(whole);
      // items line by line: list-level cues (a leading prefix cue, a trailing cue-only item) govern their own line only
      let items: SlotItem[] = [];
      for (const part of parts) {
        let its = splitItems(part).map(readItem);
        its = its.filter((it) => !(slotLevelCue(it.text) && residue(it.text).length <= 1));
        // ISSUES_v15.4: an item that itself carries a slot-level cue (「A 與 B 尚難區分」) is not established
        for (const it of its) {
          const sc = it.strength === null && !it.confirmed ? slotLevelCue(nfkc(it.text)) : null;
          if (sc) Object.assign(it, { strength: "explicit", cue: sc });
        }
        if (DX_SLOT.refuted.some((c) => part.includes(c))) {
          // 「r/o ACS → … 已排除」: considered and excluded — not open, not established
          for (const it of its) Object.assign(it, { strength: null, refuted: true });
          items.push(...its);
          continue;
        }
        if (its.length > 1) {
          const first = cuesIn(its[0].text).find((c) => c.position === "prefix" && c.start <= 2);
          if (first) for (const it of its.slice(1)) if (it.strength === null && !it.confirmed) Object.assign(it, { strength: first.strength, cue: first.cue });
          const last = its[its.length - 1];
          if (last.strength && residue(last.text).length <= 1) {
            its.pop();
            for (const it of its) if (it.strength === null && !it.confirmed) Object.assign(it, { strength: last.strength, cue: last.cue });
          }
        }
        items.push(...its);
      }
      items = items.filter((it) => residue(it.text).length > 1);
      // every item of a differential-only slot (鑑別診斷：A、B) is a differential
      if (kind === "differential") for (const it of items) if (it.strength === null && !it.confirmed && !it.refuted) Object.assign(it, { strength: "explicit", cue: m[1].trim() });
      const open = items.filter((it) => !it.refuted);
      const cued = open.filter((it) => it.strength !== null);
      const unestablished = kind === "differential" || slotCue !== null || (open.length > 0 && cued.length === open.length);
      const strength: Strength = slotCue !== null || kind === "differential" || cued.some((it) => it.strength === "explicit") ? "explicit" : "uncertain";
      const qualifiers = parts.flatMap((p) => splitItems(p)).flatMap(qualifiersOf);
      out.push({ kind, heading: m[1].trim(), lines, quote: clip(rt.lines.filter((_, k) => lines.includes(k)).map((l) => l.line.trim()).join(" / ")), items, slotCue, unestablished, strength, qualifiers });
      break;
    }
  });
  return out;
}

function conditionNames(res: Json): string[] {
  const out: string[] = [];
  const cc = res.code;
  if (isObj(cc)) {
    if (typeof cc.text === "string") out.push(cc.text);
    for (const c of Array.isArray(cc.coding) ? cc.coding : []) {
      if (!isObj(c)) continue;
      if (typeof c.display === "string") out.push(c.display.replace(/\s*\((disorder|finding|symptom|situation|observable entity|morphologic abnormality)\)\s*$/iu, ""));
      if (typeof c.code === "string" && /^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?$/u.test(c.code)) out.push(c.code);
    }
  }
  return [...new Set(out.map((x) => x.trim()).filter((x) => x.length >= 2))];
}

function verificationOf(res: Json): string | null {
  const vs = res.verificationStatus;
  if (!isObj(vs)) return null;
  for (const c of Array.isArray(vs.coding) ? vs.coding : []) if (isObj(c) && typeof c.code === "string") return c.code;
  return null;
}

function itemMatches(item: SlotItem, names: string[]): boolean {
  const ic = norm(item.core);
  const it = norm(item.text);
  for (const n0 of names) {
    const n = norm(n0);
    if (n.length < 2) continue;
    if (/^[a-z]\d{2}/u.test(n) && (it.includes(n) || it.includes(n.replace(".", "")))) return true;
    if (ic.length >= 2 && (ic.includes(n) || n.includes(ic))) return true;
    if (nameSimilarity(item.core, n0) >= 0.6) return true;
  }
  return false;
}

function symptomCoded(res: Json): string | null {
  const cc = res.code;
  for (const c of isObj(cc) && Array.isArray(cc.coding) ? cc.coding : []) {
    if (!isObj(c)) continue;
    const sys = String(c.system ?? "");
    const code = String(c.code ?? "");
    if (/icd-?10/iu.test(sys) && DX_SLOT.symptomIcd.test(code)) return `ICD-10 ${code} (R00–R99 symptoms and signs)`;
    if (/snomed/iu.test(sys) && typeof c.display === "string" && DX_SLOT.symptomSnomedTags.some((t) => nfkc(c.display).includes(t))) return `SNOMED CT ${code} ${c.display}`;
  }
  return null;
}

const SYMPTOM_SECTIONS = new Set(["chief_complaint", "hpi", "exam", "preamble"]);
const RE_LIST_ITEM = /^\s*(?:[#*•●・-]|\(?\d{1,2}[.)、]|[(（]\d{1,2}[)）])/u;
const RE_ASSERTS = /(確診|診斷為|診斷是|患有|罹患|病史|已知|known|history of|hx of|h\/o|s\/p|diagnosed|dx of|followed for|追蹤中|控制中|規則服藥)/iu;

/**
 * Whether a record line establishes a disease (when the record has no diagnosis slot): a plan / lab
 * line; a past-history line (unless the Condition is this encounter's diagnosis — a past episode is not
 * today's diagnosis); a numbered problem list item; a line asserting the disease (確診, known, history of …).
 */
function establishesDisease(section: string, line: string, encounterDx: boolean): boolean {
  const t = nfkc(line);
  if (RE_LIST_ITEM.test(t) || RE_ASSERTS.test(t)) return true;
  if (section === "plan" || section === "lab" || section === "diagnosis") return true;
  if (section === "history") return !encounterDx;
  return false;
}

/**
 * The record has no diagnosis (no diagnosis heading in a structured record, or an empty 「診斷：」): a
 * Condition the record names only as a complaint / finding, or not at all, does not come from the record —
 * `information-absent`. Conditions the record establishes elsewhere (past history, plan, a lab conclusion)
 * and Conditions marked provisional / differential / unconfirmed are left alone.
 */
function noDiagnosisChecks(root: Json, rt: RecordText, empty: DxSlot | null, issues: RecordIssue[], covered: Set<string>): void {
  for (const r of resourcesOf(root)) {
    const res = r.resource;
    if (res.resourceType !== "Condition") continue;
    const vs = verificationOf(res);
    if (vs !== null && NOT_CONFIRMED.has(vs)) continue;
    if (JSON.stringify(res.category ?? []).includes("problem-list-item")) continue;
    const names = conditionNames(res);
    if (!names.length) continue;
    const occ = names.flatMap((n) => (n.length >= 2 ? rt.find(n) : [])).filter((o) => o.origin === "record" && o.li !== null && o.section !== "instruction");
    const encounterDx = JSON.stringify(res.category ?? []).includes("encounter-diagnosis");
    if (occ.some((o) => establishesDisease(o.section, o.line, encounterDx))) continue;
    const name = clip(names[0], 30);
    const where = occ.length ? "只出現在主訴／現病史／檢查（是症狀，不是診斷）" : "在病歷中找不到";
    const whereEn = occ.length ? "is named only in the complaint / history of present illness / examination (a symptom, not a diagnosis)" : "is not in the record";
    covered.add(r.base);
    issues.push(makeIssue(
      "R4", "error", "information-absent", `${r.base}.code`,
      `病歷沒有提供這項資訊：病歷${empty ? `的診斷欄是空的（「${empty.quote}」）` : "沒有診斷欄"}，而 Condition「${name}」${where}。不要自行下診斷；若任務需要診斷，請回報 insufficient_information`,
      `The record does not provide this information: ${empty ? `its diagnosis slot is empty ("${empty.quote}")` : "it has no diagnosis slot"}, and the Condition '${name}' ${whereEn}. Do not make up a diagnosis; if the task needs one, report insufficient_information`,
      `R4 no diagnosis in the record: ${empty ? `heading '${empty.heading}' with no content` : "a structured record with no diagnosis / impression / assessment heading and no diagnosis-section line"}; the Condition's names (${names.slice(0, 3).map((n) => `'${clip(n, 30)}'`).join(", ")}) occur ${occ.length ? `only in ${[...new Set(occ.map((o) => o.section))].join(" / ")} lines` : "nowhere in the record"}`,
      empty ? [empty.quote] : undefined,
    ));
  }
}
const COMORBIDITY_SECTIONS = new Set(["history", "plan", "lab"]);

/** The Bundle's primary Condition and how it was decided (ISSUES_v15.3 R2). */
export interface PrimaryCondition {
  base: string;
  resource: Json;
  why: string;
}

const RE_UUID_REF = /^(urn:uuid:|urn:oid:)/u;

function categoryText(res: Json): string {
  return JSON.stringify(res.category ?? []);
}

/**
 * The encounter's PRIMARY diagnosis among the instance's Conditions (refuted / entered-in-error never count):
 *
 *   1. Encounter.diagnosis: the entries that reference a Condition of the instance, without the comorbidity
 *      role (use CM): the one with the lowest `rank` (rank 1 = primary), else the first listed. Entries that
 *      are all comorbidities → no primary.
 *   2. Otherwise the Conditions with category encounter-diagnosis (never problem-list-item): one → it;
 *      several → the first that names an item of the record's diagnosis slot, else the first listed.
 *   3. Otherwise the only Condition that is not a problem-list item and not a comorbidity the record states
 *      outside its diagnosis slot (past history / plan / lab lines).
 *   4. Otherwise none (the rule does not apply).
 */
export function primaryCondition(root: Json, rt: RecordText, slots: readonly DxSlot[]): PrimaryCondition | null {
  const all = resourcesOf(root);
  const conds = all.filter((r) => r.resource.resourceType === "Condition" && !["refuted", "entered-in-error"].includes(verificationOf(r.resource) ?? ""));
  if (!conds.length) return null;
  const byRef = new Map<string, (typeof conds)[number]>();
  for (const c of conds) {
    if (c.fullUrl) byRef.set(c.fullUrl, c);
    if (typeof c.resource.id === "string") byRef.set(`Condition/${c.resource.id}`, c);
  }
  const resolve = (ref: unknown): (typeof conds)[number] | undefined => {
    if (typeof ref !== "string") return undefined;
    return byRef.get(ref) ?? (RE_UUID_REF.test(ref) ? undefined : byRef.get(ref.replace(/^.*\/(Condition\/[^/]+)$/u, "$1")));
  };
  // 1. Encounter.diagnosis
  const dx: Array<{ c: (typeof conds)[number]; rank: number | null; uses: string[]; enc: string }> = [];
  for (const e of all) {
    if (e.resource.resourceType !== "Encounter" || !Array.isArray(e.resource.diagnosis)) continue;
    for (const d of e.resource.diagnosis) {
      if (!isObj(d) || !isObj(d.condition)) continue;
      const c = resolve(d.condition.reference);
      if (!c) continue;
      const uses = (isObj(d.use) && Array.isArray(d.use.coding) ? d.use.coding : []).map((u: unknown) => (isObj(u) ? String(u.code ?? "") : "")).filter(Boolean);
      dx.push({ c, rank: typeof d.rank === "number" ? d.rank : null, uses, enc: e.base });
    }
  }
  if (dx.length) {
    const pool = dx.filter((d) => !d.uses.includes("CM"));
    if (!pool.length) return null;
    const ranked = pool.filter((d) => d.rank !== null).sort((a, b) => a.rank! - b.rank!);
    const pick = ranked[0] ?? pool[0];
    return { base: pick.c.base, resource: pick.c.resource, why: `${pick.enc}.diagnosis references it${pick.rank !== null ? ` with rank ${pick.rank}` : " (first listed)"}${pick.uses.length ? ` (use ${pick.uses.join(", ")})` : ""}` };
  }
  // 2. category encounter-diagnosis
  const encDx = conds.filter((c) => categoryText(c.resource).includes("encounter-diagnosis") && !categoryText(c.resource).includes("problem-list-item"));
  if (encDx.length === 1) return { base: encDx[0].base, resource: encDx[0].resource, why: "the only Condition with category encounter-diagnosis" };
  if (encDx.length > 1) {
    const items = slots.flatMap((s) => s.items);
    const named = encDx.find((c) => items.some((it) => itemMatches(it, conditionNames(c.resource))));
    const pick = named ?? encDx[0];
    return { base: pick.base, resource: pick.resource, why: `${encDx.length} Conditions with category encounter-diagnosis; ${named ? "the first that names an item of the record's diagnosis slot" : "the first listed"}` };
  }
  // 3. the only Condition that is not a problem-list item / a comorbidity stated outside the diagnosis slot
  const slotLines = new Set(slots.flatMap((s) => s.lines));
  const cand = conds.filter((c) => {
    if (categoryText(c.resource).includes("problem-list-item")) return false;
    const names = conditionNames(c.resource);
    const occ = names.flatMap((n) => (n.length >= 2 ? rt.find(n) : [])).filter((o) => o.origin === "record" && o.li !== null && !slotLines.has(o.li));
    return !occ.some((o) => COMORBIDITY_SECTIONS.has(o.section));
  });
  if (cand.length === 1) return { base: cand[0].base, resource: cand[0].resource, why: conds.length === 1 ? "the only Condition" : "the only Condition that is not a problem-list item or a comorbidity the record states outside its diagnosis slot" };
  return null;
}

/** Whether a CodeableConcept carries a real code (not only text / placeholder codings). */
function hasRealCode(cc: unknown): boolean {
  return isObj(cc) && Array.isArray(cc.coding) && cc.coding.some((c: unknown) => !placeholderCoding(c));
}

/**
 * ISSUES_v15.3 R2: the record has no established primary diagnosis (explicitly), and the primary Condition stands in for
 * one as provisional / differential / unconfirmed or as text only → information-absent.
 */
function primaryStandIn(root: Json, rt: RecordText, all: readonly DxSlot[], covered: Set<string>, skip: ReadonlySet<string>): RecordIssue | null {
  const slots = all.filter((s) => !s.empty);
  if (slots.some((s) => s.kind === "primary" && !s.unestablished)) return null;
  const basis = slots.find((s) => s.unestablished && s.strength === "explicit") ?? all.find((s) => s.empty && s.kind === "primary");
  if (!basis) return null;
  const p = primaryCondition(root, rt, slots);
  if (!p || covered.has(p.base) || skip.has(p.base)) return null;
  const vs = verificationOf(p.resource);
  const textOnly = !hasRealCode(p.resource.code);
  const standIn = vs !== null && ["provisional", "differential", "unconfirmed"].includes(vs);
  if (!standIn && !textOnly) return null;
  const names = conditionNames(p.resource);
  const name = clip(names[0] ?? "", 40);
  const how = standIn ? `verificationStatus 是 ${vs}` : "code 只有文字、沒有代碼";
  const howEn = standIn ? `has verificationStatus ${vs}` : "has a text-only code (no coding)";
  const state = basis.empty
    ? "診斷欄是空的"
    : basis.slotCue
      ? `診斷欄寫「${basis.slotCue}」`
      : basis.kind === "differential"
        ? "只有鑑別診斷"
        : "每一項都是待排除／鑑別";
  const stateEn = basis.empty ? "the diagnosis slot is empty" : basis.slotCue ? `the slot says '${basis.slotCue}'` : basis.kind === "differential" ? "it lists differentials only" : "every item is to be ruled out / a differential";
  covered.add(p.base);
  return makeIssue(
    "R4", "error", "information-absent", isObj(p.resource.verificationStatus) && standIn ? `${p.base}.verificationStatus` : `${p.base}.code`,
    `病歷沒有確立的主診斷：病歷的診斷欄是「${basis.quote}」（${state}），而本次的主診斷 Condition「${name}」${how}。provisional / differential 或只有文字的 Condition 不能代替確立的主診斷；若任務需要主診斷，請回報 insufficient_information`,
    `The record has no established primary diagnosis: its diagnosis slot is "${basis.quote}" (${stateEn}), and the encounter's primary Condition '${name}' ${howEn}. A provisional / differential or text-only Condition cannot stand in for an established primary diagnosis; if the task needs one, report insufficient_information`,
    `R4 primary diagnosis (ISSUES_v15.3 R2): no primary slot of the record is established; slot '${basis.heading}' (${basis.kind}) — ${basis.empty ? "empty" : basis.slotCue ? `slot-level cue '${basis.slotCue}'` : basis.kind === "differential" ? "differential-only heading" : "every item under an explicit cue"}; ` +
      `primary Condition decided by: ${p.why} (order: Encounter.diagnosis rank / first non-comorbidity entry → category encounter-diagnosis → the only non-comorbidity Condition); secondary Conditions are not examined`,
    [basis.quote],
  );
}

/**
 * R3 primary diagnosis slot checks. Returns the issues and the Conditions (by base path) they cover,
 * so the mention-level R4 checks do not report them twice.
 */
export function diagnosisSlotChecks(
  root: Json,
  rt: RecordText,
  absentPaths: ReadonlySet<string> = new Set(),
): { issues: RecordIssue[]; covered: Set<string>; established: Set<string> } {
  const issues: RecordIssue[] = [];
  const covered = new Set<string>();
  const established = new Set<string>();
  const all = diagnosisSlots(rt);
  const slots = all.filter((s) => !s.empty);
  // a Condition whose code.text R1 already reports as an absence statement (暫不下診斷) is not reported again
  const skip = new Set<string>();
  // (ISSUES_v15.4: also a text-only Condition the empty-shell check reports through its note)
  const shellNote = (base: string): boolean => [...absentPaths].some((p) => p.startsWith(`${base}.note[`));
  for (const r of resourcesOf(root)) if (r.resource.resourceType === "Condition" && (absentPaths.has(`${r.base}.code.text`) || shellNote(r.base))) skip.add(r.base);
  for (const b of skip) covered.add(b);
  const standIn = (): void => {
    try {
      const i = primaryStandIn(root, rt, all, covered, skip);
      if (i) issues.push(i);
    } catch {
      // fail-open
    }
  };
  if (!slots.length) {
    // ISSUES_v15.1 R3: the record states no diagnosis at all (no diagnosis slot, or an empty one) — only with a structured record
    if (all.length || (rt.structured && !rt.lines.some((l) => l.section === "diagnosis" && !l.header && l.line.trim())))
      noDiagnosisChecks(root, rt, all[0] ?? null, issues, covered);
    if (all.length) standIn();
    return { issues, covered, established };
  }
  const slotLines = new Set(slots.flatMap((s) => s.lines));
  const unest = slots.filter((s) => s.unestablished);
  const primaryEstablished = slots.some((s) => s.kind === "primary" && !s.unestablished);
  for (const r of resourcesOf(root)) {
    const res = r.resource;
    if (res.resourceType !== "Condition" || skip.has(r.base)) continue;
    const vs = verificationOf(res);
    if (vs !== null && NOT_CONFIRMED.has(vs)) continue;
    const names = conditionNames(res);
    if (!names.length) continue;
    // an established (plain / confirmed) item of any slot establishes the Condition
    if (slots.some((s) => s.items.some((it) => it.strength === null && !it.refuted && itemMatches(it, names)))) {
      established.add(r.base);
      continue;
    }
    let reason: string | null = null;
    let slot: DxSlot | null = null;
    let strength: Strength = "explicit";
    // a concept the record qualifies inside a bracket (「…（未確立惡性腫瘤）」) — whatever the slot's status
    for (const s of slots) {
      const q = s.qualifiers.find((x) => itemMatches(x, names));
      if (q) {
        slot = s;
        strength = q.strength!;
        reason = `the record qualifies this concept as not established ('${q.cue}' in 「${clip(q.text, 40)}」)`;
        break;
      }
    }
    if (!reason && !unest.length) continue;
    const ccText = isObj(res.code) && typeof res.code.text === "string" ? nfkc(res.code.text) : "";
    if (!reason && ccText) {
      for (const s of unest) {
        const hits = s.items.filter((it) => norm(it.core).length >= 2 && norm(ccText).includes(norm(it.core)));
        if (hits.length >= 2 || (hits.length >= 1 && cuesIn(ccText).some((c) => c.strength === "explicit")) || (s.slotCue && ccText.includes(s.slotCue))) {
          slot = s;
          strength = s.strength;
          reason = `Condition.code.text copies the record's ${s.kind === "differential" ? "differential" : "diagnosis"} list`;
          break;
        }
      }
    }
    if (!reason) {
      for (const s of slots) {
        const it = s.items.find((x) => x.strength !== null && itemMatches(x, names));
        if (it) {
          slot = s;
          strength = it.strength!;
          reason = `it is an item of the record's ${s.kind === "differential" ? "differential" : "diagnosis"} slot under the cue '${it.cue}'`;
          break;
        }
      }
    }
    if (!reason && unest.length && !primaryEstablished) {
      const s = unest[0];
      // a comorbidity the record establishes elsewhere (past history, another section) is not the main diagnosis
      const occ = names.flatMap((n) => (n.length >= 2 ? rt.find(n) : [])).filter((o) => o.origin === "record" && o.li !== null && !slotLines.has(o.li));
      const symptom = symptomCoded(res);
      const establishedElsewhere = occ.some((o) => COMORBIDITY_SECTIONS.has(o.section) || o.section === "diagnosis");
      const category = JSON.stringify(res.category ?? []);
      if (!symptom && (establishedElsewhere || (category.includes("problem-list-item") && occ.length))) continue;
      slot = s;
      strength = s.strength;
      if (symptom) reason = `a symptom code (${symptom}) stands in for the main diagnosis`;
      else if (occ.length && occ.every((o) => SYMPTOM_SECTIONS.has(o.section))) reason = "the record names this concept only as a complaint / finding, not as a diagnosis";
      else reason = "the record establishes no diagnosis, and this Condition is not one the record states elsewhere";
    }
    if (!reason || !slot) continue;
    const name = clip(names[0], 30);
    const written = vs === null ? "沒有標示 verificationStatus（讀作已確立）" : `verificationStatus 是 ${vs}`;
    const writtenEn = vs === null ? "has no verificationStatus (read as established)" : `has verificationStatus ${vs}`;
    const path = isObj(res.verificationStatus) ? `${r.base}.verificationStatus` : `${r.base}.code`;
    const evidence =
      `R4 primary diagnosis slot: heading '${slot.heading}' (${slot.kind}) — ${slot.slotCue ? `slot-level cue '${slot.slotCue}'` : slot.kind === "differential" ? "differential-only heading" : slot.unestablished ? "every item under a cue" : "established items, this concept qualified in a bracket"}; ` +
      `${slot.items.length} item(s) read with bracket-scoped cues (a cue inside a bracket that names another concept qualifies only that concept); ${reason}; no item matching this Condition is established`;
    covered.add(r.base);
    if (strength === "explicit") {
      issues.push(makeIssue(
        "R4", "error", "unconfirmed-as-confirmed", path,
        `病歷的主診斷尚未確立，卻寫成確立的診斷：病歷的診斷欄是「${slot.quote}」，但 Condition「${name}」${written}（${reason.startsWith("a symptom") ? "以症狀碼代替主診斷" : reason.startsWith("Condition.code.text") ? "code.text 抄錄了鑑別診斷清單" : reason.startsWith("it is an item") ? "它是鑑別／待排除的項目之一" : reason.startsWith("the record qualifies") ? "病歷在括號中註明它未確立" : "病歷沒有確立這個診斷"}）。請標成 provisional 或 differential；若任務需要確立的診斷而病歷沒有，請回報 insufficient_information`,
        `The record's main diagnosis is not established, yet a Condition is written as established: the record's diagnosis slot is "${slot.quote}", but the Condition '${name}' ${writtenEn} (${reason}). Mark it provisional or differential; if the task needs an established diagnosis and the record has none, report insufficient_information`,
        evidence, [slot.quote],
      ));
    } else {
      issues.push(makeIssue(
        "R4", "warning", "unconfirmed-as-confirmed", path,
        `診斷可能尚未確立：病歷的診斷欄是「${slot.quote}」（疑似／可能），Condition「${name}」${written}。若病歷沒有確立，請標成 provisional`,
        `The diagnosis may not be established: the record's diagnosis slot is "${slot.quote}" (hedged), and the Condition '${name}' ${writtenEn}. If the record does not establish it, mark it provisional`,
        evidence, [slot.quote],
      ));
    }
  }
  standIn();
  return { issues, covered, established };
}
