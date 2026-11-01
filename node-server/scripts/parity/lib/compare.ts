/**
 * Issue comparison for the parity harnesses: official validator_cli OperationOutcome issues vs InstanceValidator
 * issues. Only error-level issues (error + fatal) decide a verdict; warnings are carried for reports.
 *
 * Levels (per run):
 *  - strict: same error count AND the same multiset of (normalised location, normalised message);
 *  - lenient: same error count AND the same multiset of (normalised location, lenient message) — the message without
 *             the definition-version suffix "(from <url>|<version>)", the "(defined in …)" invariant source and the
 *             " Note that …" tail: wording differences that are not verdict differences;
 *  - class:  same error count AND the same multiset of (normalised location, classify.errorClass(message));
 *  - count:  same error count only.
 */
import { errorClass } from "../classify.js";
import type { Res } from "./packages.js";

export interface SimpleIssue {
  severity: string;
  path: string;
  message: string;
  code?: string;
}

/** validator_cli expression → instance path: drops the `/*Type/id*\/` comments and a leading `$`/`Bundle` noise. */
export function normPath(p: string): string {
  return String(p ?? "")
    .replace(/\/\*.*?\*\//g, "")
    .replace(/\s+/g, "")
    // FHIRPath choice form (validator_cli) → JSON property form: value.ofType(Quantity) → valueQuantity
    .replace(/\.([A-Za-z]+)\.ofType\(([A-Za-z])([A-Za-z0-9]*)\)/g, (_m, p: string, a: string, b: string) => `.${p}${a.toUpperCase()}${b}`)
    .trim();
}

/** Message normal form: whitespace collapsed, trailing period dropped. */
export function normMessage(m: string): string {
  return String(m ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

/** normMessage without definition-version / invariant-source suffixes and the " Note that" tail. */
export function lenientMessage(m: string): string {
  return normMessage(
    normMessage(m)
      .split(" Note that ")[0]
      .replace(/ \(defined in [^)]*\)/g, "")
      .replace(/(\(from \S+?)\|[^)\s]+\)/g, "$1)")
      .replace(/(https?:\/\/\S+?)\|\d[\w.-]*/g, "$1"),
  );
}

export function isError(i: { severity: string }): boolean {
  return i.severity === "error" || i.severity === "fatal";
}

/** OperationOutcome → issues (expression[0], else location[0]). */
export function issuesOfOutcome(oo: Res | null | undefined): SimpleIssue[] {
  const out: SimpleIssue[] = [];
  for (const i of (oo && Array.isArray(oo.issue) ? oo.issue : []) as Res[]) {
    out.push({
      severity: String(i.severity ?? ""),
      code: i.code,
      path: String((Array.isArray(i.expression) && i.expression[0]) || (Array.isArray(i.location) && i.location[0]) || ""),
      message: String(i.details?.text ?? i.diagnostics ?? ""),
    });
  }
  return out;
}

/** The old inline expectation format: "SEVERITY: path: message" lines. */
export function issuesOfOutputLines(lines: string[]): SimpleIssue[] {
  return lines.map((l) => {
    const m = /^(FATAL|ERROR|WARNING|INFORMATION|HINT):\s*([^:]*?):\s(.*)$/s.exec(l);
    return m ? { severity: m[1].toLowerCase(), path: m[2], message: m[3] } : { severity: "error", path: "", message: l };
  });
}

function multiset(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

function diff(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of a) for (let i = 0; i < n - (b.get(k) ?? 0); i++) out.push(k);
  return out;
}

export interface Comparison {
  expectedErrors: number;
  actualErrors: number;
  count: boolean;
  class: boolean;
  lenient: boolean;
  strict: boolean;
  /** Official errors without a lenient counterpart (verdict differences, not wording). */
  lenientMissing: string[];
  lenientExtra: string[];
  /** Official errors without a strict counterpart ("path | message"). */
  missing: string[];
  /** Our errors without a strict counterpart. */
  extra: string[];
  /** errorClass of missing / extra (for failure-class tallies). */
  missingClasses: string[];
  extraClasses: string[];
}

export function compareIssues(expected: SimpleIssue[], actual: SimpleIssue[]): Comparison {
  const ee = expected.filter(isError);
  const ae = actual.filter(isError);
  const sk = (i: SimpleIssue): string => `${normPath(i.path)} | ${normMessage(i.message)}`;
  const ck = (i: SimpleIssue): string => `${normPath(i.path)} | ${errorClass(normMessage(i.message))}`;
  const se = multiset(ee.map(sk));
  const sa = multiset(ae.map(sk));
  const missing = diff(se, sa);
  const extra = diff(sa, se);
  const ce = multiset(ee.map(ck));
  const ca = multiset(ae.map(ck));
  const classOk = diff(ce, ca).length === 0 && diff(ca, ce).length === 0;
  const lk = (i: SimpleIssue): string => `${normPath(i.path)} | ${lenientMessage(i.message)}`;
  const le = multiset(ee.map(lk));
  const la = multiset(ae.map(lk));
  const lenientMissing = diff(le, la);
  const lenientExtra = diff(la, le);
  const cls = (k: string): string => errorClass(k.split(" | ").slice(1).join(" | "));
  return {
    expectedErrors: ee.length,
    actualErrors: ae.length,
    count: ee.length === ae.length,
    class: ee.length === ae.length && classOk,
    lenient: ee.length === ae.length && lenientMissing.length === 0 && lenientExtra.length === 0,
    lenientMissing,
    lenientExtra,
    strict: ee.length === ae.length && missing.length === 0 && extra.length === 0,
    missing,
    extra,
    missingClasses: missing.map(cls),
    extraClasses: extra.map(cls),
  };
}
