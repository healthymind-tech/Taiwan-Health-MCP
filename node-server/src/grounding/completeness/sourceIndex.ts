/**
 * Record index for completeness detection: line segmentation with sections, block ids, the
 * structured-record flag, normalized-quote search and stated-absence clauses.
 *
 * Segmentation, blocks and quote search are the shared `RecordText` (../recordText.ts, also the base
 * of the grounding engine's `Source`); this class only adds what completeness needs. Instruction-line
 * markers are configurable so the engine is not tied to the CARVE `【轉換目標】` format.
 */
import { ABSENCE_WORDS, DEFAULT_INSTRUCTION_MARKERS, absenceConceptsIn, nfkc, pyStrip, type SourceLine } from "./lex.js";
import { RecordText, type Occurrence } from "../recordText.js";

export { DEFAULT_INSTRUCTION_MARKERS, type Occurrence, type SourceLine };

export interface AbsenceStatement {
  concepts: string[];
  line: string;
}

/** Completeness view of the record: the shared RecordText index plus record lines and stated absences. */
export class SourceIndex extends RecordText {
  private absenceCache?: AbsenceStatement[];

  constructor(text: string, siteConfig?: string | null, instructionMarkers: readonly string[] = DEFAULT_INSTRUCTION_MARKERS) {
    super(text, siteConfig, instructionMarkers);
  }

  /** Non-empty lines that belong to the record (not instructions, not site config), with original indices. */
  recordLines(): Array<[number, SourceLine]> {
    const out: Array<[number, SourceLine]> = [];
    this.lines.forEach((l, i) => {
      if (l.section !== "instruction" && l.section !== "site_config" && pyStrip(l.line)) out.push([i, l]);
    });
    return out;
  }

  /** Absence statements ('X 未記載', '姓名欄位空白', 'dose unknown' …) per clause. */
  statedAbsences(): AbsenceStatement[] {
    if (this.absenceCache) return this.absenceCache;
    const out: AbsenceStatement[] = [];
    for (const ln of this.lines) {
      if (ln.section === "instruction" || ln.section === "site_config") continue;
      const t = nfkc(ln.line);
      for (const cl of t.split(/[；;。]/)) {
        if (!ABSENCE_WORDS.some((a) => cl.includes(a))) continue;
        const concepts = absenceConceptsIn(cl); // whole-label matching (lexicon 0.3.0)
        if (!concepts.length) continue;
        out.push({ concepts, line: pyStrip(ln.line) });
      }
    }
    this.absenceCache = out;
    return out;
  }
}
