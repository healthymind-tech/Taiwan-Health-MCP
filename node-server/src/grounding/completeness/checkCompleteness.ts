/**
 * fhir_check_completeness engine (MCP_GROUNDING_SPEC §2.3): deterministic gap report.
 *
 * Input: structured conversion targets (what the conversion target asks for) + the record text
 * (+ optional model-extracted facts, which are verified, never trusted). Output: per required fact
 * found (with quote) / missing (with reason) / stated_absent (with the record line) / unknown, an
 * overall status, `missing` labels, a template zh-TW follow-up question and a ready abstention
 * object. No LLM, no network (terminology names come from an injected provider), no randomness.
 * Never logs source_text.
 *
 * Port of mcp_proposal/reference/gap_ref.py. Deviations from the reference (all outside the 30
 * parity fixtures):
 *  - instruction-line markers are configurable (`instruction_markers`, default ['【轉換目標】']);
 *  - required_by for Procedure.code reads "target-implied (Procedure.code)" (reference reused the
 *    Condition string), and labels/required_by come from one table (factTable.ts) keyed by
 *    resourceType+fact so they can be wired to fhir_get_profile_required_elements;
 *  - a fact with no detector reports `unknown` (reference: `found` with quote "(not checked)") so
 *    an unchecked fact is never presented as grounded;
 *  - reasons for item-less targets name the resourceType instead of Python's "None".
 */
import { LEXICON_VERSION } from "./lex.js";
import { defaultFacts, labelZhOf, questionFor, requiredByOf } from "./factTable.js";
import { detect, targetAliases } from "./detectors.js";
import { DEFAULT_INSTRUCTION_MARKERS, SourceIndex } from "./sourceIndex.js";
import { emptyTerminologyNames, termKey, type TerminologyNames } from "../terminologyNames.js";
import type {
  CompletenessData,
  CompletenessInput,
  CompletenessResult,
  ExtractedFact,
  FactRow,
  TargetReport,
} from "./types.js";

export const COMPLETENESS_TOOL_VERSION = "completeness 1.0.0";

export interface CompletenessDeps {
  /** Shared grounding terminology provider (DB-backed in production, static cache in tests). */
  terminology?: TerminologyNames;
  /** Clock for elapsed_ms (injected for deterministic tests); omit to skip elapsed_ms. */
  now?: () => number;
}

export async function checkCompleteness(input: CompletenessInput, deps: CompletenessDeps = {}): Promise<CompletenessResult> {
  const t0 = deps.now?.();
  const terminology = deps.terminology ?? emptyTerminologyNames;
  // Resolve terminology names up-front in one batch (the only async step) so detection stays synchronous.
  const keys = [...new Set(input.targets.flatMap((t) => (t.codes ?? []).filter((c) => c.code).map(codingKey)))];
  const records = keys.length ? await terminology.lookup(keys) : new Map();
  const data = computeCompleteness(input, (c) => {
    const r = records.get(codingKey(c));
    return r?.found ? r.names : [];
  });
  const result: CompletenessResult = {
    ok: true,
    data,
    warnings: [],
    provenance: {
      tool: "fhir_check_completeness",
      toolVersion: COMPLETENESS_TOOL_VERSION,
      lexiconVersion: LEXICON_VERSION,
      packageId: input.package_id ?? null,
      version: input.version ?? null,
    },
  };
  if (keys.length) result.provenance.terminologyVersion = await terminology.version();
  if (t0 !== undefined && deps.now) result.provenance.elapsed_ms = deps.now() - t0;
  return result;
}

const codingKey = (c: { system?: string; code?: string }): string => termKey(c.system, c.code);

/** Synchronous core; `namesOf` returns pre-resolved terminology names for one coding. */
export function computeCompleteness(
  input: CompletenessInput,
  namesOf: (c: { system?: string; code?: string }) => readonly string[] = () => [],
): CompletenessData {
  const src = new SourceIndex(
    input.source_text,
    input.site_config,
    input.instruction_markers?.length ? input.instruction_markers : DEFAULT_INSTRUCTION_MARKERS,
  );
  const ef = new Map<string, ExtractedFact>();
  for (const x of input.extracted_facts ?? []) ef.set(`${x.target}\u0000${x.fact}`, x);

  const outTargets: TargetReport[] = [];
  const missing: string[] = [];
  const questions: string[] = [];

  input.targets.forEach((t) => {
    const rt = t.resourceType;
    const optional = new Set(t.optional ?? []);
    const req = [...(t.require ?? defaultFacts(rt)), ...(t.also_require ?? [])].filter((r) => !optional.has(r));
    const aliases = targetAliases(t, namesOf);
    const rows: FactRow[] = [];
    for (const fact of req) {
      let [st, q] = detect(src, t, fact, aliases);
      const row: FactRow = { fact, required_by: requiredByOf(rt, fact), status: st };
      const mf = t.key !== undefined ? ef.get(`${t.key}\u0000${fact}`) : undefined;
      if (mf) {
        // Model-extracted fact: verified like a grounding evidence entry, not trusted.
        const occ = mf.quote ? src.find(mf.quote) : [];
        if (mf.status === "not_stated") {
          row.model = "not_stated";
          if (st === "found") row.note = "the model says not stated, but the record contains it";
          else if (st !== "stated_absent") st = row.status = "missing";
        } else if (occ.length && st !== "stated_absent") {
          st = row.status = "found";
          q = mf.quote as string;
          row.model = "stated (quote verified)";
        } else if (mf.quote) {
          row.model = "stated (quote NOT found in the record)";
        }
      }
      if (st === "found") {
        row.quote = q;
      } else if (st === "unknown") {
        row.reason = q;
      } else {
        row.reason = q;
        missing.push(`${t.item || rt} ${labelZhOf(rt, fact)}`.trim());
        questions.push(questionFor(rt, fact, t.item ?? "", q));
      }
      rows.push(row);
    }
    outTargets.push({ key: t.key ?? null, resourceType: rt, item: t.item ?? null, facts: rows });
  });

  const qs = [...new Set(questions)];
  const question = qs.length ? qs.join("；") + "。" : null;
  const data: CompletenessData = {
    status: missing.length ? "insufficient_information" : "complete",
    targets: outTargets,
    missing,
    question,
  };
  if (missing.length) data.abstention = { status: "insufficient_information", missing: [...missing], question };
  return data;
}
