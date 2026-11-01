/**
 * Content gates (ISSUES_v20.1 item 2): every content finding — a grounding G-* issue or a record-check code, produced
 * with source_text — carries `gate: "blocking" | "advisory"`.
 *
 *   - blocking: may stop fhir_release_check (counts as a content error there).
 *   - advisory: returned to the model exactly as before (same severity, same message — the validating tools keep it,
 *     and an advisory ERROR still makes `valid` / `groundingValid` false), but fhir_release_check does not stop on it.
 *
 * Rule: lexical / heuristic rules are advisory by default; a rule is blocking only with a MEASURED precision ≥ 95 % over
 * n ≥ 20 findings on realistic Chinese records (scripts/content-fp/gold.ts: gold Bundles with their records — every
 * error there is a false positive — and negative cases with known findings — fabricated / mutated values; precision =
 * TP / (TP + FP)). Fewer measured findings → advisory. Warnings are never blocking (only an error can stop a release).
 * One rule is blocking by decision rather than measurement: unconfirmed-as-confirmed (ISSUES_v20.1 item 3 — a diagnosis
 * the record leaves r/o / 疑似 / 尚未確立 written as established must never be released); it has 0 false positives on
 * the gold Bundles.
 *
 * The registry below is the single table of rule → gate. Each comment gives the measurement (2026-11-01, gold.ts over
 * 17 gold Bundles with their records — TW Core gold cases, flattened-record variants, the issues-v1 repro cases and the
 * 2 PAS hand records — and 97 negative cases: fabricated / wrong-value fixtures + the recorded value mutations of the
 * gold Bundles). FP = errors on gold Bundles, TP = expected findings on negatives.
 */

type Json = Record<string, unknown>;

export type ContentGate = "blocking" | "advisory";

interface GateRow {
  gate: ContentGate;
  /** Optional refinement: blocking only when this holds for the issue (else advisory). */
  when?: (issue: Json) => boolean;
}

/** Grounding rules (grounding/checkGrounding.ts, `rule`). */
export const GROUNDING_GATES: Readonly<Record<string, GateRow>> = {
  // a value (date, number, quantity, identifier) the record does not state: 100 %, n = 50 (TP 50 / FP 0) → blocking;
  // on a CODED element it is a lexical name match (100 %, n = 12 — too few) → advisory (isValuePath)
  "G-UNGROUNDED": { gate: "blocking", when: (i) => isValuePath(String(i.path ?? "")) },
  // value in the record but different: n = 0 in the corpus → advisory
  "G-VALUE-MISMATCH": { gate: "advisory" },
  // the rest are lexical / heuristic context rules (section, negation, history, label, category): advisory
  "G-CONTEXT-LABEL": { gate: "advisory" }, // 100 %, n = 9; evaluator: PEFR / name-sex label false positives
  "G-CONTEXT-SECTION": { gate: "advisory" }, // 100 %, n = 4
  "G-CONTEXT-NEGATED": { gate: "advisory" },
  "G-CONTEXT-HISTORICAL": { gate: "advisory" },
  "G-CONTEXT-INSTRUCTION": { gate: "advisory" },
  "G-CONTEXT-SITE": { gate: "advisory" },
  "G-CONTEXT": { gate: "advisory" },
  "G-CATEGORY": { gate: "advisory" },
  "G-CATEGORY-SOFT": { gate: "advisory" },
  "G-CODING-UNRELATED": { gate: "advisory" },
  "G-CODING-WEAK": { gate: "advisory" },
  "G-CODING-UNVERIFIABLE": { gate: "advisory" },
  "G-VALUE-PRECISION": { gate: "advisory" },
  "G-VALUE-WEAK": { gate: "advisory" },
  "G-UNIT-NOT-STATED": { gate: "advisory" },
  "G-DATA-ABSENT": { gate: "advisory" },
  "G-STATED-ABSENT": { gate: "advisory" }, // 100 %, n = 6
  "G-DERIVED": { gate: "advisory" },
  "G-UNCLASSIFIED": { gate: "advisory" },
  "G-EVIDENCE-PATH": { gate: "advisory" },
  "G-QUOTE-NOT-FOUND": { gate: "advisory" },
  "G-QUOTE-AMBIGUOUS": { gate: "advisory" },
  "G-NO-STRUCTURE": { gate: "advisory" },
  "G-NARRATIVE": { gate: "advisory" },
  "G-TZ": { gate: "advisory" },
  "G-SYSTEM-NOT-SITE": { gate: "advisory" },
  "G-DEFAULT-ASSUMED": { gate: "advisory" },
  "G-AUTO-LOCATED": { gate: "advisory" },
};

/** Record-check codes (recordChecks/, `code`). */
export const RECORD_GATES: Readonly<Record<string, GateRow>> = {
  // R4 a diagnosis the record leaves r/o / 待排除 / 尚未確立 / 疑似 / 待確認 written as established (error form only;
  // 可能 / possible is a warning): blocking by decision (item 3); FP 0 on 17 gold Bundles, no case among the negatives
  // (synthetic: contentV201.test.ts, 8 / 8)
  "unconfirmed-as-confirmed": { gate: "blocking" },
  // R2 identifier format + check digit: 100 %, n = 5 (too few) → advisory
  "identifier-format": { gate: "advisory" },
  // all other record checks are heuristic over free text: advisory until measured on n ≥ 20
  "ungrounded-value": { gate: "advisory" }, // 91.8 %, n = 61 (TP 56 / FP 5, all 5 in one PAS hand record) — below 95 %
  "information-absent": { gate: "advisory" }, // 100 %, n = 4
  "value-from-other-event": { gate: "advisory" }, // 100 %, n = 3
  "insufficient-precision": { gate: "advisory" },
  "incomplete-value": { gate: "advisory" },
  "symptom-for-unconfirmed-diagnosis": { gate: "advisory" },
  "stale-value": { gate: "advisory" },
  "negated-item-present": { gate: "advisory" },
  "duplicate-entry": { gate: "advisory" },
  "text-only-fact": { gate: "advisory" },
  "record-fact-missing": { gate: "advisory" },
  "identifier-truncated": { gate: "advisory" },
  // ISSUES_v20.1 item 5: code meaning is advisory (100 %, n = 8 here; evaluator: 1 hit / 8 FP)
  "code-meaning-mismatch": { gate: "advisory" },
  // ISSUES_v20.1 item 3: a generic code standing for an unknown specific item (Hormone therapy for an unnamed drug)
  "generic-code-for-unknown-item": { gate: "advisory" },
};

/** Paths of value-bearing elements (not a coded concept): dates, quantities, identifiers, numbers, strings. */
export function isValuePath(p: string): boolean {
  const last = p.replace(/\[\d+\]/gu, "").split(".").pop() ?? "";
  if (/^(code|coding|category|type|class|route|method|site|bodySite|vaccineCode|medicationCodeableConcept|valueCodeableConcept|interpretation|status|intent|clinicalStatus|verificationStatus|severity|reaction|manifestation|substance|form|ingredient|itemCodeableConcept|productOrService|specialty|qualification|communication|maritalStatus|language|gender|relationship|display|system)$/u.test(last)) return false;
  return true;
}

/** The gate of one content issue (grounding or record-check); null for a validator issue. */
export function contentGateOf(issue: Json): ContentGate | null {
  const isRecord = issue.source === "record-checks";
  const isGrounding = issue.source === "grounding" || (typeof issue.rule === "string" && /^G-/u.test(issue.rule));
  if (!isRecord && !isGrounding) return null;
  if (issue.severity !== "error" && issue.severity !== "fatal") return "advisory";
  const row = isRecord ? RECORD_GATES[String(issue.code)] : GROUNDING_GATES[String(issue.rule)];
  if (!row || row.gate === "advisory") return "advisory";
  return !row.when || row.when(issue) ? "blocking" : "advisory";
}

/** Stamp `gate` on every content issue of a list (in place). Validator issues are left alone. */
export function stampGates(list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const i of list) {
    if (!i || typeof i !== "object" || Array.isArray(i)) continue;
    const g = contentGateOf(i as Json);
    if (g) (i as Json).gate = g;
  }
}

/** Stamp every content issue of a validation data block (Bundle-level + entries). */
export function stampValidationGates(data: Json): void {
  stampGates(data.issues);
  for (const e of Array.isArray(data.entries) ? data.entries : []) if (e && typeof e === "object") stampGates((e as Json).issues);
}
