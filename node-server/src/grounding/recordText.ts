/**
 * Shared record index for the grounding and completeness engines.
 *
 * Both `fhir_check_grounding` (checkGrounding.ts `Source`) and `fhir_check_completeness`
 * (completeness/sourceIndex.ts `SourceIndex`) locate quotes in the clinical record the same way:
 * line segmentation with sections (instruction lines such as 【轉換目標】 are tagged and never
 * count as evidence), blank-line blocks, the "record has section structure" flag, and normalized
 * quote search over the record and the site configuration. That logic lives here once; each
 * engine extends the class with what only it needs.
 *
 * Port of grounding_ref.Source (reference). Never logs anything.
 */
import { DEFAULT_INSTRUCTION_MARKERS, hasStructure, norm, normWithMap, segment, type SourceLine } from "./lexicon.js";
import { pyStrip } from "./py.js";

export interface Occurrence {
  origin: "record" | "site_config";
  /** Code-unit offsets into the record (or the site configuration). */
  start: number;
  end: number;
  /** Line index in the record; null for site-configuration hits. */
  li: number | null;
  section: string;
  line: string;
  text: string;
  /** Set by grounding's auto-locate (window quotes / lines / score). */
  quotes?: string[];
  wlines?: number[];
  _score?: number;
}

/** '…' / '...' separate ordered fragments of one quote. */
const RE_FRAG_SPLIT = /…|\.\.\./u;
/** Max normalized gap between two consecutive fragments of a quote. */
const MAX_FRAGMENT_GAP = 400;

export class RecordText {
  readonly text: string;
  readonly site: string;
  readonly lines: SourceLine[];
  readonly structured: boolean;
  /** First line index of the contiguous non-empty block containing each line. */
  readonly blocks: number[];
  private normCache?: { record: [string, number[]]; site: [string, number[]] };

  constructor(text: string | null | undefined, siteConfig: string | null | undefined, instructionMarkers: readonly string[] = DEFAULT_INSTRUCTION_MARKERS) {
    this.text = text || "";
    this.site = siteConfig || "";
    this.lines = segment(this.text, instructionMarkers);
    this.structured = hasStructure(this.lines);
    this.blocks = [];
    let bs = 0;
    this.lines.forEach((l, i) => {
      if (!pyStrip(l.line)) bs = i + 1;
      this.blocks.push(bs);
    });
  }

  /** Normalized record / site text with the normalized-index -> original-offset maps (computed once). */
  protected normalized(): { record: [string, number[]]; site: [string, number[]] } {
    this.normCache ??= { record: normWithMap(this.text), site: normWithMap(this.site) };
    return this.normCache;
  }

  lineOf(pos: number): number {
    for (let i = 0; i < this.lines.length; i++) if (this.lines[i].start <= pos && pos <= this.lines[i].end) return i;
    return this.lines.length - 1;
  }

  /** Occurrences of the (normalized) quote in the record and the site configuration; '…' / '...' separate ordered fragments. */
  find(quote: string): Occurrence[] {
    const frags = quote.split(RE_FRAG_SPLIT).filter((f) => norm(f));
    if (!frags.length) return [];
    const { record, site } = this.normalized();
    const occ: Occurrence[] = [];
    const sources: Array<["record" | "site_config", string, number[], string]> = [
      ["record", record[0], record[1], this.text],
      ["site_config", site[0], site[1], this.site],
    ];
    for (const [origin, n, mp, text] of sources) {
      const q0 = norm(frags[0]);
      let start = 0;
      for (;;) {
        const j = n.indexOf(q0, start);
        if (j < 0) break;
        let endn = j + q0.length;
        let ok = true;
        for (const f of frags.slice(1)) {
          const nf = norm(f);
          const k = n.indexOf(nf, endn);
          if (k < 0 || k - endn > MAX_FRAGMENT_GAP) {
            ok = false;
            break;
          }
          endn = k + nf.length;
        }
        if (ok) {
          const s = mp[j];
          const lastStart = mp[endn - 1];
          // End after the last matched character (a surrogate pair counts as one character).
          const e = lastStart + (text.codePointAt(lastStart)! > 0xffff ? 2 : 1);
          if (origin === "record") {
            const li = this.lineOf(s);
            const ln = this.lines[li];
            occ.push({ origin, start: s, end: e, li, section: ln.section, line: ln.line, text: text.slice(s, e) });
          } else {
            occ.push({ origin, start: s, end: e, li: null, section: "site_config", line: text.slice(s, e), text: text.slice(s, e) });
          }
        }
        start = j + 1;
      }
    }
    return occ;
  }
}
