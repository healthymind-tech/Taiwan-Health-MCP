/**
 * Does an Observation's code need a QUANTITATIVE result? (ISSUES_v15.3 R1) — decides whether a
 * valueString / note is read as a result slot ("檢體溶血，重抽中" is then "no result", see
 * lexicon.ts AbsenceOptions.result). Data-driven, first match wins:
 *
 *   1. LOINC axes of the code (RecordCheckOptions.codeAxes, filled by the tools from loinc.concepts
 *      through the grounding terminology provider): SCALE_TYP Qn → yes; Ord / Nom / Nar / Doc / Set →
 *      no (definitive); else PROPERTY of a quantity kind (MCnc, SCnc, NCnc, CCnc, ACnc, … Num) → yes;
 *   2. the LOINC long common name / short name the Coding carries: a quantity property in brackets
 *      ("Glucose [Mass/volume] in Blood", "[#/volume]", "[Enzymatic activity/volume]") or a
 *      quantity property suffix ("Glucose Bld-mCnc", "-sCnc", "-nCnc", "-cCnc");
 *   3. a vital-sign LOINC code (the grounding lexicon's vital-sign table: 8310-5, 8867-4, 29463-7 …);
 *   4. the resource itself expects a Quantity: a vital-signs profile (meta.profile) or category,
 *      a referenceRange with low / high, or another Observation with the same LOINC code in the
 *      instance that has a valueQuantity.
 *
 * Returns the basis (for the issue's evidence) or null when nothing says the code is quantitative.
 */
import { VITAL_LABELS } from "../grounding/lexicon.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

const LOINC = "http://loinc.org";

/** LOINC axes of one code (loinc.concepts.property / scale_type). */
export interface CodeAxes {
  property?: string | null;
  scale?: string | null;
}

/** `http://loinc.org|<code>` → axes. */
export type CodeAxesMap = ReadonlyMap<string, CodeAxes>;

/** LOINC PROPERTY values that are quantities (LOINC Users' Guide, property table). */
const QUANTITY_PROPERTIES = new Set([
  "mcnc", "scnc", "ncnc", "ccnc", "acnc", "lscnc", "lacnc", "lncnc", "mscnc", "sscnc", "vcnc", "titr", "mfr", "nfr", "vfr", "sfr", "cfr", "afr",
  "mrat", "srat", "crat", "arat", "vrat", "nrat", "mcrto", "scrto", "ncrto", "ccrto", "acrto", "vrto", "mrto", "srto", "nrto", "relmcnc",
  "relscnc", "relccnc", "relacnc", "relvol", "relmrat", "relsrat", "relrto", "mass", "vol", "len", "area", "temp", "pres", "time", "num",
  "naric", "mcnt", "scnt", "ccnt", "acnt", "ncnt", "vel", "freq", "rate", "eng", "arvol", "entmass", "entvol", "entlen", "entsub", "entnum",
  "mrto", "ratio", "angle", "osmol", "pp", "ph", "elpot", "elres", "visc", "rden", "rdnc",
]);
const QUALITATIVE_SCALES = new Set(["ord", "ordqn", "nom", "nar", "doc", "set", "multi"]);
/** Long common name brackets that name a quantity property (LOINC LCN convention). */
const RE_LCN_QUANTITY =
  /\[(?:mass|moles|#|enzymatic activity|units|arbitrary units|international units|volume|number|pressure|temperature|length|ratio|velocity|time|mass fraction|volume fraction|number fraction|mass ratio|moles ratio|osmolality|ph|entitic|titer)(?=[\s/\]])[^\]]*\]/iu;
/** LOINC short name property suffixes (Glucose Bld-mCnc, Na SerPl-sCnc, WBC # Bld Auto). */
const RE_SHORTNAME_QUANTITY = /-(?:m|s|n|c|a|v|ls|ms)?(?:cnc|fr|rat|rto|cnt)\b/iu;
const VITAL_CODES = new Set(Object.keys(VITAL_LABELS).filter((c) => c !== "85354-9"));
const RE_VITAL_PROFILE = /(vitalsigns|vital-signs|bodytemp|bodyweight|bodyheight|heartrate|resprate|oxygensat|headcircum|bmi|bodytemperature|bloodpressure|\/bp$|-bp$)/iu;

function loincCodings(cc: unknown): Json[] {
  return isObj(cc) && Array.isArray(cc.coding) ? cc.coding.filter((c: unknown): c is Json => isObj(c) && c.system === LOINC && typeof c.code === "string") : [];
}

/**
 * Why the Observation (or its component `component`) needs a quantitative result, or null. `siblings` are the
 * instance's other resources (rule 4, same LOINC code with a valueQuantity).
 */
export function quantitativeBasis(obs: Json, component: number | null, axes: CodeAxesMap | null | undefined, siblings: readonly Json[] = []): string | null {
  if (!isObj(obs) || obs.resourceType !== "Observation") return null;
  const holder: Json | null = component === null ? obs : Array.isArray(obs.component) && isObj(obs.component[component]) ? obs.component[component] : null;
  if (!holder) return null;
  const codings = loincCodings(holder.code);
  // 1. the LOINC axes from the terminology tables
  for (const c of codings) {
    const a = axes?.get(`${LOINC}|${c.code}`);
    if (!a) continue;
    const scale = typeof a.scale === "string" ? a.scale.trim().toLowerCase() : "";
    const prop = typeof a.property === "string" ? a.property.trim().toLowerCase() : "";
    if (scale === "qn") return `LOINC ${c.code} SCALE_TYP Qn${prop ? ` (PROPERTY ${a.property})` : ""}`;
    if (QUALITATIVE_SCALES.has(scale)) return null;
    if (prop && QUANTITY_PROPERTIES.has(prop)) return `LOINC ${c.code} PROPERTY ${a.property}`;
  }
  // 2. the LOINC name the Coding carries
  for (const c of codings) {
    const d = typeof c.display === "string" ? c.display : "";
    const m = RE_LCN_QUANTITY.exec(d) ?? RE_SHORTNAME_QUANTITY.exec(d);
    if (m) return `LOINC ${c.code} display names a quantity property ('${m[0]}')`;
  }
  // 3. vital signs
  for (const c of codings) if (VITAL_CODES.has(c.code)) return `LOINC ${c.code} is a vital sign (Quantity result)`;
  if (component !== null) return null;
  // 4. the resource expects a Quantity
  const profiles = isObj(obs.meta) && Array.isArray(obs.meta.profile) ? obs.meta.profile.filter((p: unknown): p is string => typeof p === "string") : [];
  const vp = profiles.find((p: string) => RE_VITAL_PROFILE.test(p.replace(/\|.*$/u, "")));
  if (vp) return `profile ${vp} is a vital-signs profile (Quantity result)`;
  if (JSON.stringify(obs.category ?? []).includes('"vital-signs"')) return "category vital-signs (Quantity result)";
  const rr = Array.isArray(obs.referenceRange) ? obs.referenceRange : [];
  if (rr.some((r: unknown) => isObj(r) && (isObj(r.low) || isObj(r.high)))) return "referenceRange with low / high (Quantity result)";
  const codes = new Set(codings.map((c) => c.code));
  if (codes.size) {
    for (const s of siblings) {
      if (s === obs || !isObj(s) || s.resourceType !== "Observation" || !isObj(s.valueQuantity)) continue;
      const hit = loincCodings(s.code).find((c) => codes.has(c.code));
      if (hit) return `another Observation with LOINC ${hit.code} has a valueQuantity`;
    }
  }
  return null;
}

/** LOINC codes of the instance's Observations (and components) whose result is text or missing — the codes worth an axes lookup. */
export function loincCodesNeedingAxes(root: Json): string[] {
  const out = new Set<string>();
  const visit = (r: unknown): void => {
    if (!isObj(r) || r.resourceType !== "Observation") return;
    const holders: Json[] = [r, ...(Array.isArray(r.component) ? r.component.filter(isObj) : [])];
    for (const h of holders) {
      const textual = typeof h.valueString === "string" || !Object.keys(h).some((k) => k.startsWith("value"));
      if (textual) for (const c of loincCodings(h.code)) out.add(`${LOINC}|${c.code}`);
    }
  };
  if (isObj(root) && root.resourceType === "Bundle") for (const e of Array.isArray(root.entry) ? root.entry : []) visit(isObj(e) ? e.resource : null);
  else visit(root);
  return [...out];
}

