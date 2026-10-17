/**
 * Deterministic per-fact detectors for fhir_check_completeness (MCP_GROUNDING_SPEC §2.3.3).
 * Port of mcp_proposal/reference/gap_ref.py `detect()`; deviations are listed in the header of
 * checkCompleteness.ts.
 *
 * Regex notes for the Python → JS port: Python's `\b` / `\w` are Unicode-aware (CJK counts as a
 * word character), JS's are ASCII-only, so Python `\b` is emulated with `(?<!W)` / `(?!W)` where
 * W = [\p{L}\p{N}_]. All matching runs on NFKC-normalized text, so ASCII `\d` matches what Python's
 * Unicode `\d` matched on the same text.
 */
import {
  ABBREV,
  BIRTH_LABELS,
  HIST_CUES,
  LIST_ITEM,
  VITAL_LABELS,
  PW,
  escapeRe,
  pyStrip,
  ID_LABELS,
  freqSignatureCount,
  gendersIn,
  isUnitToken,
  latTokens,
  nameSimilarity,
  nfkc,
  norm,
  numberUnits,
  parseDatePrecisions,
  routeCount,
} from "./lex.js";
import type { SourceIndex, SourceLine } from "./sourceIndex.js";
import type { CompletenessTarget, FactStatus } from "./types.js";

export type Detection = [FactStatus, string];

/** Python-style `\b` boundary helpers (Unicode word characters). */
const B_BEFORE = `(?<!${PW})`;
const B_AFTER = `(?!${PW})`;

export const VISIT_LABELS = [
  "就診", "看診", "到院", "入院", "admission", "admitted", "arrival", "date", "日期", "visit", "受檢", "訪視", "檢查日期", "門診",
];
const NAME_LABEL = /(姓名|name|病人姓名|病人|病患|個案|受檢者|孕婦|兒童|病童|pt|patient)\s*[:：]?\s*([一-鿿]{2,4}|[a-z]+\s+[a-z]+)/iu;
const DOSE_UNITS = new Set(["mg", "g", "ug", "[iu]", "{tab}", "{puff}", "ml", "mg/ml", "{bottle}"]);
const GENDER_WORD = new RegExp(`性別|sex|男|女|male|female|${B_BEFORE}m${B_AFTER}|${B_BEFORE}f${B_AFTER}`, "u");
const AGE_RE = new RegExp(`\\d+\\s*(歲|y/o|yo|y${B_AFTER})`, "u");

/** Instruction (e.g. 【轉換目標】) and site-config lines are not record text: they never join a value / context window. */
const isNonRecordLine = (l: SourceLine): boolean => l.section === "instruction" || l.section === "site_config";
const isAsciiAlpha = (ch: string): boolean => /^[A-Za-z]$/.test(ch);

export interface AliasMatch {
  start: number;
  end: number;
}

const aliasReCache = new Map<string, RegExp>();
function aliasRegex(alias: string): RegExp {
  let re = aliasReCache.get(alias);
  if (!re) {
    const a = nfkc(alias);
    let pat = escapeRe(a);
    if (isAsciiAlpha(a.slice(0, 1))) pat = "(?<![a-z])" + pat;
    if (isAsciiAlpha(a.slice(-1))) pat = pat + "(?![a-z])";
    re = new RegExp(pat, "u");
    if (aliasReCache.size > 5000) aliasReCache.clear();
    aliasReCache.set(alias, re);
  }
  return re;
}

/** First alias (in order) that occurs in the text; positions are in nfkc(text). */
export function hasAlias(text: string, aliases: readonly string[]): AliasMatch | null {
  const t = nfkc(text);
  for (const a of aliases) {
    const m = aliasRegex(a).exec(t);
    if (m) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

function absent(src: SourceIndex, concept: string, itemAliases?: readonly string[], patient = false): string | null {
  for (const st of src.statedAbsences()) {
    if (!st.concepts.includes(concept)) continue;
    if (patient || !itemAliases?.length || hasAlias(st.line, itemAliases)) return st.line;
  }
  return null;
}

const hasDay = (text: string): boolean => parseDatePrecisions(text).includes("day");

function docDates(src: SourceIndex): string[] {
  const out: string[] = [];
  for (const [i, l] of src.recordLines()) {
    const t = nfkc(l.line);
    if (!hasDay(l.line)) continue;
    if (
      BIRTH_LABELS.some((b) => t.includes(b)) &&
      !["就診", "到院", "入院", "受檢", "日期:", "visit", "date:"].some((v) => t.includes(v))
    ) continue;
    if (HIST_CUES.some((c) => t.includes(c)) || l.section === "history") continue;
    if (VISIT_LABELS.some((v) => t.includes(v)) || i < 3) out.push(pyStrip(l.line));
  }
  return out;
}

/**
 * Item aliases: given aliases (or the item) + their whitespace/bracket-separated parts + terminology
 * names for the target codes, vital-sign labels and abbreviations whose expansion starts with a token
 * of those names (e.g. LOINC 2160-0 -> Creatinine, 肌酸酐, Cr).
 */
export function targetAliases(
  target: CompletenessTarget,
  namesOf: (c: { system?: string; code?: string }) => readonly string[],
): string[] {
  const al: string[] = target.aliases?.length ? [...target.aliases] : target.item ? [target.item] : [];
  for (const a of [...al]) {
    for (const p of a.split(/[\s/（）()]+/u)) {
      if (p.length >= 2 && /[a-zA-Z\u4e00-\u9fff]/.test(p) && !isUnitToken(nfkc(p))) al.push(p);
    }
  }
  for (const c of target.codes ?? []) {
    const names = namesOf(c).filter((n) => !n.startsWith("__CODE__"));
    al.push(...names.filter((n) => [...n].length <= 30));
    al.push(...(VITAL_LABELS[String(c.code ?? "")] ?? []));
    const toks = new Set<string>();
    for (const n of names) for (const x of latTokens(n, false)) toks.add(x);
    for (const [k, v] of Object.entries(ABBREV)) {
      if (toks.has(v.split(" ")[0]) && k.length >= 2) al.push(k);
    }
  }
  const seen: string[] = [];
  for (const a of al) if (a && !seen.includes(a)) seen.push(a);
  return seen;
}

const stripLabel = (line: string): string => line.replace(/^[^\n]*?[:：]/u, "");

export function detect(src: SourceIndex, target: CompletenessTarget, fact: string, aliases: readonly string[]): Detection {
  const rt = target.resourceType;
  const item = target.item ?? rt;
  const lines = src.recordLines();
  const first8 = lines.slice(0, 8);

  if (rt === "Patient") {
    if (fact === "identifier") {
      for (const [, l] of lines) {
        const t = nfkc(l.line);
        if (/(?<![a-z0-9])[a-z][12489]\d{8}(?![0-9])/u.test(t)) return ["found", pyStrip(l.line)];
        if (
          ID_LABELS.mrn.some((lb) => t.includes(lb)) &&
          /(病歷號碼?|chart no\.?|mrn|病歷)\s*[:：]?\s*[a-z0-9][a-z0-9-]{3,}/u.test(t)
        ) return ["found", pyStrip(l.line)];
      }
      const a = absent(src, "mrn", undefined, true) ?? absent(src, "national_id", undefined, true);
      return a ? ["stated_absent", a] : ["missing", "no national ID or chart number (住院號／就診號 are encounter identifiers)"];
    }
    if (fact === "name") {
      const a = absent(src, "name", undefined, true);
      if (a) return ["stated_absent", a];
      for (const [, l] of first8) {
        const m = NAME_LABEL.exec(nfkc(l.line));
        if (m && !/^(男|女|性別|空白|欄位)/u.test(m[2])) return ["found", pyStrip(l.line)];
      }
      return ["missing", "no patient name"];
    }
    if (fact === "gender") {
      for (const [, l] of first8) {
        const t = nfkc(l.line);
        if (gendersIn(l.line).size && (NAME_LABEL.test(t) || GENDER_WORD.test(t))) return ["found", pyStrip(l.line)];
      }
      return ["missing", "no sex/gender"];
    }
    if (fact === "birthDate") {
      for (const [, l] of lines) {
        const t = nfkc(l.line);
        for (const b of [...BIRTH_LABELS, "生"]) {
          const j = t.indexOf(b);
          if (j >= 0 && hasDay(t.slice(Math.max(0, j - 16), j + 24))) return ["found", pyStrip(l.line)];
        }
      }
      const a = absent(src, "birthDate", undefined, true);
      if (a) return ["stated_absent", a];
      // identity line without a birth label: '病人：蔡文雄　男　1968/05/30　身分證號 …'
      for (const [, l] of first8) {
        const t = nfkc(l.line);
        if (NAME_LABEL.test(t) && gendersIn(l.line).size && hasDay(t) && !VISIT_LABELS.some((v) => t.includes(v))) {
          return ["found", pyStrip(l.line)];
        }
      }
      const age = first8.some(([, l]) => AGE_RE.test(nfkc(l.line)));
      return ["missing", age ? "only the age is stated" : "no birth date"];
    }
  }

  if (rt === "Encounter" && fact === "period.start") {
    const d = docDates(src);
    return d.length ? ["found", d[0]] : ["missing", "no visit/admission date"];
  }

  if (rt === "Condition" && fact === "code") {
    let dx = lines.filter(([, l]) => l.section === "diagnosis" && norm(l.header ? stripLabel(l.line) : l.line));
    if (target.category === "problem-list-item") {
      dx = dx.concat(
        lines.filter(([i, l]) => ["history", "hpi", "preamble"].includes(l.section) && (LIST_ITEM.test(l.line) || i < 3)),
      );
    }
    dx = dx.filter(([, l]) => !/^\s*(r\/o|rule out)/u.test(nfkc(l.line)));
    if (aliases.length) {
      dx = dx.filter(
        ([, l]) => hasAlias(l.line, aliases) || Math.max(...aliases.map((a) => nameSimilarity(l.line, a))) >= 0.5,
      );
    }
    if (dx.length) return ["found", pyStrip(dx[0][1].line)];
    if (!src.structured) {
      const al = aliases.length ? lines.filter(([, l]) => hasAlias(l.line, aliases)) : [];
      if (al.length) return ["found", pyStrip(al[0][1].line)];
      if (!aliases.length) {
        return ["unknown", "the record has no recognizable sections; diagnosis presence not decidable without an item name"];
      }
    }
    const a = absent(src, "diagnosis");
    if (a) return ["stated_absent", a];
    const ro = lines.some(([, l]) => l.section === "rule_out");
    return ["missing", "the record has no diagnosis/assessment" + (ro ? "; only ruled-out diagnoses" : "")];
  }

  if (rt === "Observation") {
    if (fact === "value") {
      for (const [, l] of lines) {
        const m = hasAlias(l.line, aliases);
        if (m) {
          const t = nfkc(l.line).slice(m.end, m.end + 40);
          if (/^[^0-9\n]{0,15}?\d/u.test(t) || /\((\+|-|−)\)|陽性|陰性|positive|negative/u.test(t.slice(0, 20))) {
            return ["found", pyStrip(l.line)];
          }
        }
      }
      // table / list header: alias on one line, values on the following lines of the same block. Instruction /
      // site-config lines never join a value window, even without a blank line before them (the same rule the
      // grounding engine applies to its evidence windows).
      for (const [i, l] of lines) {
        if (!hasAlias(l.line, aliases)) continue;
        const nxt: string[] = [];
        for (let j = i + 1; j < Math.min(i + 6, src.lines.length); j++) {
          if (src.blocks[j] === src.blocks[i] && !isNonRecordLine(src.lines[j])) nxt.push(src.lines[j].line);
        }
        const hit = nxt.find((x) => /\d/u.test(nfkc(x)));
        if (hit !== undefined) return ["found", pyStrip(l.line) + " / " + pyStrip(hit)];
      }
      const a = absent(src, "value", aliases);
      return a ? ["stated_absent", a] : ["missing", `no value for ${item}`];
    }
    if (fact === "effective") {
      const rule = target.date_rule ?? "document";
      if (rule === "explicit") {
        const want = target.date;
        for (const [, l] of lines) {
          if (want && norm(l.line).includes(norm(want))) return ["found", pyStrip(l.line)];
        }
        return ["missing", `the stated date ${want ?? null} is not in the record`];
      }
      if (rule === "item") {
        const a = absent(src, "date", aliases);
        if (a) return ["stated_absent", a];
        for (const [, l] of lines) {
          if (hasAlias(l.line, aliases) && parseDatePrecisions(l.line).some((p) => p === "day" || p === "md")) {
            return ["found", pyStrip(l.line)];
          }
        }
        return ["missing", `no test date for ${item}`];
      }
      const a = absent(src, "date", aliases);
      if (a) return ["stated_absent", a];
      const d = docDates(src);
      return d.length ? ["found", d[0]] : ["missing", "no visit/measurement date"];
    }
  }

  if (rt === "MedicationRequest" || rt === "MedicationStatement") {
    const drug = lines.filter(([, l]) => hasAlias(l.line, aliases));
    if (fact === "medication") {
      return drug.length ? ["found", pyStrip(drug[0][1].line)] : ["missing", `${item} not in the record`];
    }
    if (!drug.length) return ["missing", `${item} not in the record`];
    const richness = ([, l]: [number, SourceLine]): number => {
      const tt = nfkc(l.line);
      return (
        Number(freqSignatureCount(tt) > 0) +
        Number(routeCount(tt) > 0) +
        Number(numberUnits(tt).some((u) => u !== null && DOSE_UNITS.has(u))) +
        Number(l.section === "plan") +
        Number(/^\s*(rx|tx|\d+[.)])/u.test(tt))
      );
    };
    let best = drug[0];
    let bestScore = richness(best);
    for (const d of drug.slice(1)) {
      const s = richness(d);
      if (s > bestScore) {
        best = d;
        bestScore = s;
      }
    }
    const [i, l] = best;
    const line = l.line;
    const t = nfkc(line);
    if (fact === "dose") {
      const a = absent(src, "dose", aliases);
      if (a) return ["stated_absent", a];
      const m = hasAlias(line, aliases);
      const units = numberUnits(m ? t.slice(m.start) : t);
      return units.some((u) => u !== null && DOSE_UNITS.has(u)) ? ["found", pyStrip(line)] : ["missing", `no dose for ${item}`];
    }
    if (fact === "frequency") {
      const a = absent(src, "frequency", aliases);
      if (a) return ["stated_absent", a];
      return freqSignatureCount(t) > 0 ? ["found", pyStrip(line)] : ["missing", `no frequency for ${item}`];
    }
    if (fact === "route") {
      return routeCount(t) > 0 ? ["found", pyStrip(line)] : ["missing", `no route for ${item}`];
    }
    if (fact === "duration") {
      const ctx = [line];
      for (let j = Math.max(0, i - 4); j < i; j++) if (!isNonRecordLine(src.lines[j])) ctx.push(src.lines[j].line);
      for (const c of ctx) {
        if (/\d+\s*(天|日|days?|週|weeks?)/u.test(nfkc(c))) return ["found", pyStrip(c)];
      }
      return ["missing", `no days supply for ${item}`];
    }
  }

  if (rt === "Immunization") {
    if (fact === "vaccine") {
      const v = lines.filter(([, l]) => hasAlias(l.line, aliases));
      return v.length ? ["found", pyStrip(v[0][1].line)] : ["missing", `${item} not in the record`];
    }
    if (fact === "occurrence") {
      const d = docDates(src);
      return d.length ? ["found", d[0]] : ["missing", "no administration date"];
    }
  }

  if (rt === "AllergyIntolerance" && fact === "substance") {
    const v = lines.filter(([, l]) => hasAlias(l.line, aliases));
    return v.length ? ["found", pyStrip(v[0][1].line)] : ["missing", `${item} not in the record`];
  }

  if (rt === "Procedure") {
    if (fact === "code") {
      const v = lines.filter(([, l]) => hasAlias(l.line, aliases));
      return v.length ? ["found", pyStrip(v[0][1].line)] : ["missing", `${item} not in the record`];
    }
    if (fact === "performed") {
      const v = lines.filter(([, l]) => hasAlias(l.line, aliases) && parseDatePrecisions(l.line).length > 0);
      return v.length ? ["found", pyStrip(v[0][1].line)] : ["missing", `no date for ${item}`];
    }
  }

  return ["unknown", `no detector for ${rt}.${fact}`];
}
