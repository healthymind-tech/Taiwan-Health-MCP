/**
 * ISSUES_v17.4 — an unestablished fact written as text into a diagnosis / required element (rule R4, code
 * `unconfirmed-as-confirmed`, error). A Bundle can be valid while its required primary diagnosis is
 * "左肺上葉肺腫塊，疑原發性肺癌…主診斷尚未確立" — the request is then not a valid one.
 *
 * Elements checked: diagnosis slots (Claim.diagnosis.diagnosisCodeableConcept, Condition.code,
 * ExplanationOfBenefit.diagnosis.diagnosisCodeableConcept, Encounter.reasonCode, ServiceRequest.reasonCode …) and every
 * CodeableConcept the declared profile requires (min >= 1, profileElements.required).
 *   strong  "not established" words (尚未確立, 待病理, 待確認, pending, to be determined, 不明 …) in the text → error,
 *           coded or not;
 *   weak    hedges (疑, r/o, suspected, provisional, probable) → error only when the value has no real coding and the
 *           resource cannot say it is provisional itself (a Condition with verificationStatus provisional /
 *           differential / unconfirmed is the correct way and stays silent).
 * Diagnosis names that contain such words (不明原因發燒, unknown primary, of undetermined significance) are not cues, nor
 * are words inside a bracketed aside when the text outside the brackets names the finding ("PSA 升高（未確立惡性腫瘤）").
 */

import { makeIssue } from "./issue.js";
import { placeholderCoding, resourcesOf } from "./slots.js";
import type { RecordIssue } from "./types.js";

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

const STRONG =
  /尚未確立|未確立|尚未確定|未確定|未定|待病理|待確認|待確定|待報告|待檢查結果|待排除|尚待|診斷不明|原因不明待查|pending|to be (?:determined|confirmed)|\bTBD\b|not (?:yet )?(?:established|confirmed|determined)|undetermined(?! significance)|unconfirmed|unknown(?! (?:origin|primary|etiology|cause|significance))/iu;
const WEAK = /疑似|疑|\br\/o\b|rule out|\bR\/O\b|suspected|suspicious for|provisional|probable|possible|presumed|presumptive|可能為|可能是|考慮為/iu;
/** Names of real diagnoses that carry those words. */
const NAME_EXCEPTIONS = /不明原因|原因不明的?(?:發燒|貧血|疼痛|腹痛|肝炎)|unknown (?:origin|primary)|undetermined significance|of uncertain behavio(?:u)?r|未明示|unspecified/iu;

const DIAGNOSIS_PATHS: Record<string, string[]> = {
  Claim: ["diagnosis.diagnosisCodeableConcept"],
  ExplanationOfBenefit: ["diagnosis.diagnosisCodeableConcept"],
  Condition: ["code"],
  Encounter: ["reasonCode"],
  ServiceRequest: ["reasonCode"],
  MedicationRequest: ["reasonCode"],
  Procedure: ["reasonCode"],
};

const TENTATIVE_STATUS = new Set(["provisional", "differential", "unconfirmed", "refuted", "entered-in-error"]);

function hasRealCode(cc: Json): boolean {
  return Array.isArray(cc.coding) && cc.coding.some((c: unknown) => !placeholderCoding(c));
}

/** Values (with instance paths) at a dotted element path below a resource. */
function valuesAt(res: Json, base: string, rel: string): Array<{ path: string; value: unknown }> {
  let cur: Array<{ path: string; value: unknown }> = [{ path: base, value: res }];
  for (const seg of rel.split(".")) {
    const next: Array<{ path: string; value: unknown }> = [];
    for (const c of cur) {
      if (!isObj(c.value) || !(seg in c.value)) continue;
      const v = c.value[seg];
      if (Array.isArray(v)) v.forEach((x, i) => next.push({ path: `${c.path}.${seg}[${i}]`, value: x }));
      else next.push({ path: `${c.path}.${seg}`, value: v });
    }
    cur = next;
  }
  return cur;
}

function textOf(cc: Json): string {
  const parts = [typeof cc.text === "string" ? cc.text : ""];
  if (!parts[0]) for (const c of Array.isArray(cc.coding) ? cc.coding : []) if (isObj(c) && typeof c.display === "string") parts.push(c.display);
  return parts.filter(Boolean).join(" ");
}

export function unconfirmedTextChecks(
  root: Json,
  profileElements: ReadonlyMap<string, { required: ReadonlySet<string> }> | null,
): RecordIssue[] {
  const out: RecordIssue[] = [];
  const seen = new Set<string>();
  for (const { resource, base } of resourcesOf(root)) {
    const rt = String(resource.resourceType);
    const rels = new Set(DIAGNOSIS_PATHS[rt] ?? []);
    for (const u of Array.isArray(resource.meta?.profile) ? resource.meta.profile : []) {
      const pe = profileElements?.get(String(u).split("|")[0]);
      for (const p of pe?.required ?? []) if (p.startsWith(`${rt}.`)) rels.add(p.slice(rt.length + 1));
    }
    const tentative = rt === "Condition" && Array.isArray(resource.verificationStatus?.coding) && resource.verificationStatus.coding.some((c: Json) => TENTATIVE_STATUS.has(String(c?.code)));
    for (const rel of rels) {
      for (const { path, value } of valuesAt(resource, base, rel)) {
        if (!isObj(value) || seen.has(path)) continue;
        if (!("text" in value) && !("coding" in value)) continue; // CodeableConcept-shaped only
        const text = textOf(value);
        if (!text) continue;
        // a bracketed aside qualifies something else ("PSA 升高（未確立惡性腫瘤）": the finding is established) — judge
        // the text outside brackets, unless everything is bracketed
        const outside = text.replace(/[（(【\[][^）)】\]]*[）)】\]]/gu, " ").trim();
        const cleaned = (outside || text).replace(NAME_EXCEPTIONS, " ");
        const strong = STRONG.exec(cleaned);
        const weak = !strong && !hasRealCode(value) && !tentative ? WEAK.exec(cleaned) : null;
        const cue = strong?.[0] ?? weak?.[0];
        if (!cue || (strong && tentative)) continue;
        seen.add(path);
        out.push(
          makeIssue(
            "R4", "error", "unconfirmed-as-confirmed", path,
            `病歷中這項資訊尚未確立：這個必要欄位寫成「${text.length > 80 ? `${text.slice(0, 80)}…` : text}」（含「${cue}」）。不要用文字把未確立的狀態填進必要欄位；若轉換目標需要的資訊（例如主診斷）病歷尚未確立，請回報 insufficient_information`,
            `This information is not established: the required element says "${text.length > 80 ? `${text.slice(0, 80)}…` : text}" (contains "${cue}"). Do not fill a required element with text that says it is not established; if the record does not establish what the conversion target needs (e.g. the primary diagnosis), report insufficient_information`,
            `R4 unconfirmed text (v17.4): ${strong ? "a not-established statement" : "a hedge in a text-only value that cannot carry a verification status"} ('${cue}') in ${path.replace(/^Bundle\.entry\[\d+\]\.resource\./u, `${rt}.`)}`,
          ),
        );
      }
    }
  }
  return out;
}
