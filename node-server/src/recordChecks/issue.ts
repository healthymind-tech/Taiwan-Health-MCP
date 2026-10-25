/** Issue constructor shared by the record-check rules. */
import type { RecordIssue, RecordRule } from "./types.js";

export function makeIssue(
  rule: RecordRule,
  severity: "error" | "warning",
  code: RecordIssue["code"],
  path: string,
  zh: string,
  en: string,
  evidence: string,
  quotes?: string[],
): RecordIssue {
  return {
    severity,
    code,
    path,
    message: `${zh} / ${en}`,
    message_zh: zh,
    message_en: en,
    rule,
    source: "record-checks",
    evidence,
    ...(quotes && quotes.length ? { located_quotes: quotes } : {}),
  };
}

