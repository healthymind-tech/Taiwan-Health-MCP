/**
 * ISSUES_v20.1 item 3 (second half): a generic class code standing in for a specific item the record does not name —
 * a "Hormone therapy" / "Chemotherapy" / "Drug therapy" procedure or medication code while the record says the drug
 * name is unknown (藥名不詳, 不知藥名, unknown medication). The code is valid and its class may even be right, but the
 * specific item (which medicine) is not in the record: the conversion should report insufficient_information instead.
 *
 * Deterministic and narrow: the coding's names (display / terminology names) must be one of the class phrases below
 * AND the record must state that the item's name is unknown. Gate: advisory (contentGates.ts — too few measured cases).
 * Severity warning. Never logs record text.
 */
import { nfkc } from "../grounding/lexicon.js";
import { makeIssue } from "./issue.js";
import { resourcesOf } from "./slots.js";
import type { RecordIssue } from "./types.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

/** Whole-name class phrases (after removing a SNOMED semantic tag): the code names a kind of treatment, not an item. */
const GENERIC = /^(?:(?:hormone|hormonal|endocrine|anti-?hormonal?)\s+(?:therapy|treatment|medication)|chemotherapy|antineoplastic chemotherapy|drug therapy|pharmacotherapy|medication|medicinal product|drug|immunotherapy|targeted therapy|biological therapy|荷爾蒙治療|荷爾蒙療法|內分泌治療|賀爾蒙治療|化學治療|化療|藥物治療|標靶治療|免疫治療)$/iu;
/** The record says the item's name is not known. */
const UNKNOWN_NAME = /藥名不詳|藥名不明|藥名不清楚|不知(?:道)?藥名|藥物名稱不詳|藥品名稱不詳|名稱不詳|品項不詳|藥名未知|(?:drug|medication|agent)\s+(?:name\s+)?(?:unknown|not known|unspecified)|unknown\s+(?:drug|medication|agent|hormone)|name\s+(?:of\s+the\s+(?:drug|medication)\s+)?(?:unknown|not known)/iu;

const ITEM_TYPES = new Set(["MedicationRequest", "MedicationStatement", "MedicationAdministration", "MedicationDispense", "Medication", "Procedure", "Immunization"]);

function codeElement(res: Json): [string, Json] | null {
  for (const k of ["medicationCodeableConcept", "code", "vaccineCode"]) if (isObj(res[k])) return [k, res[k]];
  return null;
}

export function genericCodeChecks(root: Json, recordText: string, codeNames: ReadonlyMap<string, readonly string[]> | null): RecordIssue[] {
  const t = nfkc(recordText);
  const unknown = UNKNOWN_NAME.exec(t);
  if (!unknown) return [];
  const out: RecordIssue[] = [];
  for (const r of resourcesOf(root)) {
    const res = r.resource;
    if (!ITEM_TYPES.has(String(res.resourceType))) continue;
    const ce = codeElement(res);
    if (!ce) continue;
    const [key, cc] = ce;
    const codings = Array.isArray(cc.coding) ? cc.coding.filter(isObj) : [];
    if (!codings.length) continue;
    const generic = codings.find((c) => {
      const names = [c.display, ...(codeNames?.get(`${c.system}|${c.code}`) ?? [])].filter((x): x is string => typeof x === "string");
      return names.length > 0 && names.some((n) => GENERIC.test(nfkc(n).replace(/\s*\((?:procedure|regime\/therapy|product|substance)\)\s*$/iu, "").trim()));
    });
    if (!generic) continue;
    const at = Math.max(0, unknown.index - 30);
    const quote = t.slice(at, unknown.index + unknown[0].length + 10).replace(/\s+/gu, " ").trim();
    out.push(makeIssue(
      "R7", "warning", "generic-code-for-unknown-item", `${r.base}.${key}`,
      `通用代碼代替了病歷沒有寫出的品項：${res.resourceType} 的代碼「${generic.display ?? generic.code}」只是治療類別，而病歷寫「${quote}」（品項名稱不明）。不要用類別代碼代替具體品項；若轉換目標需要具體藥名，請回報 insufficient_information`,
      `A generic code stands in for an item the record does not name: the ${res.resourceType} code '${generic.display ?? generic.code}' is only a treatment class, and the record says "${quote}" (the item's name is unknown). Do not substitute a class code for the specific item; if the target needs the specific medicine, report insufficient_information`,
      `R7 generic code (v20.1): the coding's names are a class phrase (hormone therapy / chemotherapy / drug therapy …) and the record states the item's name is unknown ('${unknown[0]}')`,
      [quote],
    ));
  }
  return out;
}
