/**
 * Identifiers verbatim (ISSUES_v20 R3) — needs source_text.
 *
 * An identifier the record states must be kept whole: 「醫字第035190號」 must not become `035190`. Value grounding (R5)
 * and fhir_check_grounding accept a value that occurs anywhere in the record, so a fragment of a longer identifier
 * passes there. This rule reads the record token around every occurrence of Identifier.value:
 *
 *  - the token is the maximal run containing the value delimited by whitespace / punctuation / CJK label punctuation
 *    (：:，,、；;。()（）[]【】「」…);
 *  - a field label at its start is not part of the identifier (病歷號 / 身分證字號 / 證號 / 編號 / ID / No. / MRN / # …,
 *    and a lone 號 after the value);
 *  - what is left must look like an identifier for the value to count as a fragment of it: Latin letters / digits /
 *    hyphens around the value (A035190, 035190-1), or the official license form 「…字第<value>號」. Any other text next
 *    to the value (a CJK word: 「A123456789男」) is not decidable — no finding.
 *
 * The value is a complete identifier when any occurrence is the whole token (no finding). Otherwise —
 * `identifier-truncated` (error), the full record fragment as a replace_value suggestion — unless
 *  - the profile constrains the identifier value to digits only (a regex / pattern / `matches('^[0-9]+$')`-like invariant
 *    on the value element of the identifier slice; RecordCheckOptions.identifierRules) and the value is the digit part
 *    of the fragment, or
 *  - the identifier registry's format for the system (identifiers.ts) accepts the value and rejects the fragment.
 * Deterministic; the record text is never logged.
 */
import { nfkc } from "../grounding/lexicon.js";
import { makeIssue } from "./issue.js";
import type { identifierRegistry } from "./identifiers.js";
import type { Slot } from "./slots.js";
import type { IdentifierRule, RecordIssue } from "./types.js";

type Json = Record<string, any>;

const DELIM = new Set(Array.from(" \t\r\n　，,、：:；;。()（）[]【】「」『』<>《》〈〉|｜/\\\"'=＝！!？?～~"));
/** A field label at the start of the token (the identifier follows it). */
const RE_LABEL_HEAD = /^(?:.*?(?:病歷(?:號碼|號)?|病歷|身分證(?:統一編號|字號|號碼|號)?|身份證(?:字號|號碼|號)?|統一證號|居留證(?:號碼|號)?|護照(?:號碼|號)?|健保卡?(?:號碼|號)?|卡號|證號|字號|編號|號碼|代碼|代號|序號|單號|批號|批次|就診號|住院號|門診號|掛號|帳號|執照(?:號碼|號)?|證書(?:號碼|號)?))|^(?:mrn|mr|id|no\.?|nr\.?|#|chart|acc(?:ession)?)/iu;
const RE_ALNUM_EDGE = /^[0-9A-Za-z-]*$/u;
const RE_LICENSE_FORM = /字第$/u;
/** An identifier-looking label on the line (needed when only digits extend the value). */
const RE_ID_WORD = /號|碼|證|編號|\bid\b|\bno\b|mrn|#/iu;

export interface Fragment {
  /** The full identifier token in the record (NFKC). */
  fragment: string;
  /** The record line, clipped. */
  line: string;
}

/** Lines of the record (and site settings) in NFKC, case kept. */
function linesOf(text: string): string[] {
  return text.normalize("NFKC").split(/\r?\n/u);
}

/**
 * Whether `value` stands complete in the record (null: it does not occur), or the fragment it was cut from. Only
 * decidable occurrences count (see the module comment); an undecidable one makes the value count as complete.
 */
export function identifierInRecord(value: string, text: string): { complete: boolean; truncatedFrom: Fragment | null } | null {
  const v = value.normalize("NFKC").trim();
  if (v.length < 3) return null;
  const vl = v.toLowerCase();
  let seen = false;
  let first: Fragment | null = null;
  for (const line of linesOf(text)) {
    const ll = line.toLowerCase();
    for (let i = ll.indexOf(vl); i >= 0; i = ll.indexOf(vl, i + 1)) {
      seen = true;
      let l = i;
      while (l > 0 && !DELIM.has(line[l - 1])) l--;
      let r = i + v.length;
      while (r < line.length && !DELIM.has(line[r])) r++;
      let pre = line.slice(l, i);
      let suf = line.slice(i + v.length, r);
      const lab = RE_LABEL_HEAD.exec(pre);
      if (lab) pre = pre.slice(lab[0].length);
      // a lone 號 / 号 closing a labelled value (床號 12號) is no part of it, unless the license form opened it
      if (!RE_LICENSE_FORM.test(pre) && /^[號号]$/u.test(suf)) suf = "";
      suf = suf.replace(/[.。]+$/u, "");
      if (!pre && !suf) return { complete: true, truncatedFrom: null };
      const license = RE_LICENSE_FORM.test(pre) && /^[號号]/u.test(suf) && RE_ALNUM_EDGE.test(suf.slice(1));
      const alnum = RE_ALNUM_EDGE.test(pre) && RE_ALNUM_EDGE.test(suf);
      if (!license && !alnum) return { complete: true, truncatedFrom: null }; // undecidable: never a finding
      // digits only around a digit value: only on an identifier line (a fragment of a date / phone number is no id)
      if (alnum && /^[0-9-]*$/u.test(pre + suf) && !RE_ID_WORD.test(line)) return { complete: true, truncatedFrom: null };
      const fragment = (license ? line.slice(l + (lab ? lab[0].length : 0), r) : pre + line.slice(i, i + v.length) + suf).replace(/[.。]+$/u, "");
      first ??= { fragment, line: line.trim().slice(0, 120) };
    }
  }
  if (!seen) return null;
  return { complete: false, truncatedFrom: first };
}

/** The profile says this identifier's value is digits only. */
function digitsOnly(rules: readonly IdentifierRule[] | null | undefined, resource: Json, system: string | null): boolean {
  if (!rules?.length) return false;
  const profiles = Array.isArray(resource?.meta?.profile) ? resource.meta.profile.map((p: unknown) => String(p).split("|")[0]) : [];
  return rules.some((r) => r.digitsOnly && (r.profile === null || profiles.includes(r.profile)) && (r.resourceType === null || r.resourceType === resource?.resourceType) && (r.system === null || r.system === system));
}

export function identifierVerbatimChecks(
  slots: readonly Slot[],
  sourceText: string,
  siteConfig: string | null,
  registry: ReturnType<typeof identifierRegistry>,
  rules: readonly IdentifierRule[] | null | undefined,
  skip: ReadonlySet<string>,
): RecordIssue[] {
  const text = `${sourceText}\n${siteConfig ?? ""}`;
  const out: RecordIssue[] = [];
  for (const s of slots) {
    if (s.kind !== "identifier" || typeof s.value !== "string" || skip.has(s.path)) continue;
    if (/\.system$/u.test(s.path) || /^urn:|^https?:/iu.test(s.value.trim())) continue;
    try {
      const hit = identifierInRecord(s.value, text);
      if (!hit || hit.complete || !hit.truncatedFrom) continue;
      const system = s.holder && typeof s.holder.system === "string" ? s.holder.system : null;
      const frag = hit.truncatedFrom.fragment;
      const v = s.value.normalize("NFKC").trim();
      if (/^\d+$/u.test(v) && digitsOnly(rules, s.resource, system) && (frag.match(/\d+/gu) ?? ([] as string[])).includes(v)) continue;
      const fmt = registry.formatFor(system);
      if (fmt && fmt.check(v).ok && !fmt.check(frag).ok) continue;
      if (nfkc(frag) === nfkc(v)) continue;
      out.push({
        ...makeIssue(
          "R5", "error", "identifier-truncated", s.path,
          `識別碼不完整：病歷寫的是「${frag}」，這裡只寫了「${v}」。病歷明寫的識別碼要逐字保留（IG 未限定只取數字）`,
          `Truncated identifier: the record states "${frag}", the value here is only "${v}". An identifier the record states must be kept verbatim (the profile does not restrict it to digits)`,
          `R5 identifier verbatim (ISSUES_v20 R3): every occurrence of the value in the record is part of a longer identifier token (delimited by whitespace / punctuation; field labels stripped; Latin / digit / hyphen extensions or the 字第…號 license form); no digits-only rule in the profile${system ? `, no registry format for ${system} that accepts only the value` : ""}`,
          [hit.truncatedFrom.line],
        ),
        suggestions: [{ value: frag, kind: "replace_value", confidence: 0.8, reason: "the complete identifier as the record writes it" }],
      });
    } catch {
      // fail-open per slot
    }
  }
  return out;
}
