/**
 * Identifier format registry (ISSUES_v15 R2), keyed by Identifier.system — data-driven.
 *
 * Built-in systems are the ones TW Core IG v1.0.0 fixes on its identifier slices
 * (StructureDefinition Patient-twcore / Practitioner-twcore):
 *   - idCardNumber   system http://www.moi.gov.tw           → ROC national ID (國民身分證統一編號)
 *   - residentNumber system http://www.immigration.gov.tw   → resident certificate / UI number (統一證號)
 * TW Core v1.0.0 defines no system URL (slice or NamingSystem) for the NHI card number (健保卡號), so
 * it has no built-in key; a site enables it through `site_config` (below) with the built-in format
 * `tw-nhi-card`. No URL is guessed.
 *
 * Formats and check digits:
 *   - tw-national-id: 1 letter (region) + 1 or 2 (sex) + 8 digits; check digit: the letter maps to a
 *     two-digit number (A=10 … Z=33, I=34, O=35: the order ABCDEFGHJKLMNPQRSTUVXYWZIO), weights
 *     1,9 on its digits, then 8,7,…,1 on digits 2–9, plus the check digit; total ≡ 0 (mod 10).
 *     (內政部 國民身分證統一編號編碼原則.)
 *   - tw-resident-certificate: new format (移民署, issued from 2021-01-02): 1 letter + 8 (male) / 9
 *     (female) + 8 digits, the national-ID check-digit rule; old format (valid until 2030-12-31):
 *     2 letters (second A–D) + 8 digits, the second letter contributes the units digit of its
 *     letter value (A→0, B→1, C→2, D→3) in the second position, same weights.
 *   - tw-nhi-card: 12 digits (全民健康保險憑證 card number; spaces / hyphens between groups allowed).
 *   - tw-passport: 9 digits (中華民國護照號碼).
 *
 * site_config syntax (one rule per line, anywhere in the facility settings text):
 *     identifier-format <system-url> <format>
 * where <format> is a built-in name (tw-national-id | tw-resident-certificate | tw-nhi-card |
 * tw-passport) or a JavaScript regular expression matched against the WHOLE value (implicitly
 * anchored), e.g. `identifier-format https://hospital.example.tw/mrn [0-9]{7,8}`. A site rule for a
 * built-in system replaces the built-in one; an invalid regular expression is ignored and reported
 * in record_checks.notes.
 */

const LETTERS = "ABCDEFGHJKLMNPQRSTUVXYWZIO";

function letterValue(ch: string): number | null {
  const i = LETTERS.indexOf(ch);
  return i < 0 ? null : 10 + i;
}

function weightedOk(letter: string, second: number, digits: string): boolean {
  const n = letterValue(letter);
  if (n === null) return false;
  let s = Math.floor(n / 10) + (n % 10) * 9 + second * 8;
  for (let i = 0; i < 7; i++) s += Number(digits[i]) * (7 - i);
  s += Number(digits[7]);
  return s % 10 === 0;
}

export interface FormatVerdict {
  ok: boolean;
  /** Why it failed (English) and the expected shape. */
  reason?: string;
  reason_zh?: string;
  /** The shape is right and only the check digit fails. */
  checksum?: boolean;
}

export interface IdentifierFormat {
  name: string;
  label: string;
  label_zh: string;
  check(value: string): FormatVerdict;
}

const NATIONAL_ID: IdentifierFormat = {
  name: "tw-national-id",
  label: "ROC national ID",
  label_zh: "中華民國身分證字號",
  check(v0) {
    const v = v0.trim().toUpperCase();
    if (/^[A-Z][89]\d{8}$/u.test(v)) {
      return { ok: false, reason: "second character 8/9 is a (new) resident certificate number — its system is http://www.immigration.gov.tw", reason_zh: "第二碼 8／9 是（新式）居留證統一證號，system 應為 http://www.immigration.gov.tw" };
    }
    if (!/^[A-Z][12]\d{8}$/u.test(v)) return { ok: false, reason: "expected 1 letter + 1 or 2 + 8 digits (e.g. A123456789)", reason_zh: "應為 1 個英文字母 + 1 或 2 + 8 位數字（如 A123456789）" };
    if (!weightedOk(v[0], Number(v[1]), v.slice(2))) return { ok: false, reason: "the check digit does not match", reason_zh: "檢查碼不符", checksum: true };
    return { ok: true };
  },
};

const RESIDENT: IdentifierFormat = {
  name: "tw-resident-certificate",
  label: "resident certificate (UI) number",
  label_zh: "居留證統一證號",
  check(v0) {
    const v = v0.trim().toUpperCase();
    if (/^[A-Z][89]\d{8}$/u.test(v)) {
      return weightedOk(v[0], Number(v[1]), v.slice(2)) ? { ok: true } : { ok: false, reason: "the check digit does not match (new format)", reason_zh: "檢查碼不符（新式統一證號）", checksum: true };
    }
    if (/^[A-Z][A-D]\d{8}$/u.test(v)) {
      const second = (letterValue(v[1]) ?? 0) % 10;
      return weightedOk(v[0], second, v.slice(2)) ? { ok: true } : { ok: false, reason: "the check digit does not match (old format)", reason_zh: "檢查碼不符（舊式統一證號）", checksum: true };
    }
    if (/^[A-Z][12]\d{8}$/u.test(v)) {
      return { ok: false, reason: "this is a national ID shape (second digit 1/2) — its system is http://www.moi.gov.tw", reason_zh: "這是身分證字號的格式（第二碼 1／2），system 應為 http://www.moi.gov.tw" };
    }
    return { ok: false, reason: "expected 1 letter + 8/9 + 8 digits (new) or 2 letters (second A–D) + 8 digits (old)", reason_zh: "應為 1 個英文字母 + 8 或 9 + 8 位數字（新式），或 2 個英文字母（第二碼 A–D）+ 8 位數字（舊式）" };
  },
};

const NHI_CARD: IdentifierFormat = {
  name: "tw-nhi-card",
  label: "NHI card number",
  label_zh: "健保卡號",
  check(v0) {
    return /^\d{12}$/u.test(v0.trim().replace(/[\s-]/gu, "")) ? { ok: true } : { ok: false, reason: "expected 12 digits", reason_zh: "應為 12 位數字" };
  },
};

const PASSPORT: IdentifierFormat = {
  name: "tw-passport",
  label: "ROC passport number",
  label_zh: "中華民國護照號碼",
  check(v0) {
    return /^\d{9}$/u.test(v0.trim()) ? { ok: true } : { ok: false, reason: "expected 9 digits", reason_zh: "應為 9 位數字" };
  },
};

export const BUILTIN_FORMATS: Readonly<Record<string, IdentifierFormat>> = {
  [NATIONAL_ID.name]: NATIONAL_ID,
  [RESIDENT.name]: RESIDENT,
  [NHI_CARD.name]: NHI_CARD,
  [PASSPORT.name]: PASSPORT,
};

/** Built-in registry: system URL → format (TW Core v1.0.0 identifier slices). */
export const BUILTIN_IDENTIFIER_SYSTEMS: Readonly<Record<string, string>> = {
  "http://www.moi.gov.tw": NATIONAL_ID.name,
  "http://www.immigration.gov.tw": RESIDENT.name,
};

function regexFormat(system: string, src: string): IdentifierFormat {
  const re = new RegExp(`^(?:${src})$`, "u");
  return {
    name: `site:${src}`,
    label: `the site_config format for ${system}`,
    label_zh: `site_config 為 ${system} 設定的格式`,
    check(v) {
      return re.test(v.trim()) ? { ok: true } : { ok: false, reason: `does not match the site format /${src}/`, reason_zh: `不符合院所設定的格式 /${src}/` };
    },
  };
}

const RE_SITE_RULE = /^\s*(?:[-*•]\s*)?identifier-format\s+(\S+)\s+(.+?)\s*$/iu;

export interface IdentifierRegistry {
  formatFor(system: string | null | undefined): IdentifierFormat | null;
  notes: string[];
}

export function identifierRegistry(siteConfig: string | null | undefined): IdentifierRegistry {
  const site = new Map<string, IdentifierFormat>();
  const notes: string[] = [];
  for (const line of String(siteConfig ?? "").split(/\r?\n/u)) {
    const m = RE_SITE_RULE.exec(line);
    if (!m) continue;
    const [, system, fmt] = m;
    const builtin = BUILTIN_FORMATS[fmt.toLowerCase()];
    if (builtin) {
      site.set(system, builtin);
      continue;
    }
    try {
      site.set(system, regexFormat(system, fmt));
    } catch {
      notes.push(`site_config identifier-format for ${system}: invalid regular expression ignored`);
    }
  }
  return {
    formatFor(system) {
      if (!system) return null;
      const s = site.get(system);
      if (s) return s;
      const b = BUILTIN_IDENTIFIER_SYSTEMS[system];
      return b ? BUILTIN_FORMATS[b] : null;
    },
    notes,
  };
}

const RE_CJK = /\p{Script=Han}/gu;

/**
 * A value that reads as a sentence rather than an identifier: four or more Chinese characters without
 * a run of three digits (醫字第012345號 is an identifier; 請見門診病歷 is not), or four or more Latin
 * words without any digit.
 */
export function sentenceLike(value: string): boolean {
  const v = value.trim();
  const cjk = (v.match(RE_CJK) ?? []).length;
  if (cjk >= 4 && !/\d{3,}/u.test(v)) return true;
  const words = v.split(/\s+/u).filter((w) => /[a-z]/iu.test(w));
  return words.length >= 4 && !/\d/u.test(v);
}
