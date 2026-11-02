/**
 * Code systems the HL7 validator's terminology server answers without a CodeSystem resource, checked locally:
 *
 *  - urn:ietf:bcp:47 (language tags): parsed against the IANA Language Subtag Registry bundled as
 *    data/terminology/bcp47-subtags.tsv.gz (scripts/supplements/build-bcp47.mts) the way tx.fhir.org does
 *    (HL7 terminology ecosystem tests, suite "langcodes"): language, up to 3 extlangs (with their Prefix), script,
 *    region, variants (with their Prefix), extensions, private use; grandfathered / redundant tags as a whole;
 *    case-insensitive. An invalid tag is Unknown_Code_in (error) plus the reason (information).
 *  - urn:ietf:rfc:3986 (ValueSetValidator.findSpecialCodeSystem → URICodeSystem): any absolute URI is a code.
 *  - urn:ietf:bcp:13 (MIME types): `type/subtype` with optional parameters. Only a value that is not of that shape
 *    is reported (tx.fhir.org rejects e.g. "pdf"); registration is not checked (no IANA media type table here).
 *
 * The registry is loaded lazily once per process; when it cannot be read every language tag stays undecided
 * (null), never valid.
 */
import { CVX_CODES } from "./fhirCvx.js";
import { ISO3166_DISPLAY } from "./fhirIso3166.js";
import { UCUM_SYSTEM, checkUcumCode } from "./fhirUcum.js";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { txKnowsSystem } from "./txCodeTables.js";

export const BCP47 = "urn:ietf:bcp:47";
export const BCP13 = "urn:ietf:bcp:13";
export const RFC3986 = "urn:ietf:rfc:3986";

/** Utilities.isAbsoluteUrl (validator 7.0.1) — URICodeSystem.findConcept: an absolute URI is a code of urn:ietf:rfc:3986. */
export function isAbsoluteUrl(ref: string): boolean {
  if (!ref.includes(":")) return false;
  const scheme = ref.slice(0, ref.indexOf(":"));
  const details = ref.slice(ref.indexOf(":") + 1);
  const token = /^[\p{L}][\p{L}\p{Nd}_[\]]*$/u.test(scheme);
  return (
    (["http", "https", "urn", "file:"].includes(scheme) || (token && scheme === scheme.toLowerCase()) ||
      ["urn:iso:", "urn:iso-iec:", "urn:iso-cie:", "urn:iso-astm:", "urn:iso-ieee:", "urn:iec:"].some((p) => ref.startsWith(p))) &&
    details.length > 0 &&
    !details.includes(" ")
  );
}

interface Registry {
  language: Set<string>;
  extlang: Map<string, string[]>;
  script: Set<string>;
  region: Set<string>;
  variant: Map<string, string[]>;
  /** grandfathered + redundant tags (lower case). */
  whole: Set<string>;
}

let registry: Registry | null | undefined;

function dataDir(): string {
  const env = process.env.BUNDLED_DATA_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  return fileURLToPath(new URL("../data/", import.meta.url));
}

function loadRegistry(): Registry | null {
  if (registry !== undefined) return registry;
  try {
    const text = zlib.gunzipSync(fs.readFileSync(path.join(dataDir(), "terminology", "bcp47-subtags.tsv.gz"))).toString("utf8");
    const r: Registry = { language: new Set(), extlang: new Map(), script: new Set(), region: new Set(), variant: new Map(), whole: new Set() };
    for (const line of text.split("\n")) {
      const [type, tag, prefixes] = line.split("\t");
      if (!type || !tag) continue;
      const t = tag.toLowerCase();
      const pre = prefixes ? prefixes.split(" ").filter(Boolean).map((p) => p.toLowerCase()) : [];
      if (type === "language") r.language.add(t);
      else if (type === "extlang") r.extlang.set(t, pre);
      else if (type === "script") r.script.add(t);
      else if (type === "region") r.region.add(t);
      else if (type === "variant") r.variant.set(t, pre);
      else if (type === "grandfathered" || type === "redundant") r.whole.add(t);
    }
    registry = r;
  } catch {
    registry = null;
  }
  return registry;
}

/** Verdict on a BCP-47 tag: valid, invalid (with the tx.fhir.org reason), or null when the registry is unavailable. */
export function judgeLanguageTag(code: string): { valid: true } | { valid: false; reason: string } | null {
  const reg = loadRegistry();
  if (!reg) return null;
  const lc = code.toLowerCase();
  if (reg.whole.has(lc)) return { valid: true };
  const parts = code.split("-");
  const bad = (reason: string): { valid: false; reason: string } => ({ valid: false, reason });
  if (!code || parts.some((p) => p === "")) return bad(`The code '${code}' is not a valid language tag`);
  let c = 0;
  const lang = parts[0].toLowerCase();
  if (lang === "x") {
    // private use only
    return parts.slice(1).every((p) => /^[a-z0-9]{1,8}$/i.test(p)) && parts.length > 1 ? { valid: true } : bad(`The code '${code}' is not a valid language tag`);
  }
  if (!reg.language.has(lang)) return bad(`The language '${parts[0]}' in the code '${code}' is not valid`);
  c++;
  for (let i = 0; i < 3 && c < parts.length && /^[a-z]{3}$/i.test(parts[c]); i++) {
    const pre = reg.extlang.get(parts[c].toLowerCase());
    if (!pre) return bad(`The extLanguage '${parts[c]}' in the code '${code}' is not valid`);
    if (pre.length && !pre.includes(lang)) return bad(`The extLanguage '${parts[c]}' in the code '${code}' may only be used with '${pre.join("', '")}', not with '${parts[0]}'`);
    c++;
  }
  if (c < parts.length && /^[a-z]{4}$/i.test(parts[c])) {
    if (!reg.script.has(parts[c].toLowerCase())) return bad(`The script '${parts[c]}' in the code '${code}' is not valid`);
    c++;
  }
  if (c < parts.length && /^([a-z]{2}|[0-9]{3})$/i.test(parts[c])) {
    if (!reg.region.has(parts[c].toLowerCase())) return bad(`The region '${parts[c]}' in the code '${code}' is not valid`);
    c++;
  }
  while (c < parts.length && /^([a-z0-9]{5,8}|[0-9][a-z0-9]{3})$/i.test(parts[c])) {
    const pre = reg.variant.get(parts[c].toLowerCase());
    if (!pre) return bad(`The variant '${parts[c]}' in the code '${code}' is not valid`);
    const before = parts.slice(0, c).join("-").toLowerCase();
    if (pre.length && !pre.some((p) => before === p || before.startsWith(`${p}-`))) {
      return bad(`The variant '${parts[c]}' in the code '${code}' may only be used with '${pre.join("', '")}', not with '${parts.slice(0, c).join("-")}'`);
    }
    c++;
  }
  // extensions: singleton + 2..8 alphanumerics
  while (c < parts.length && /^[0-9a-wy-z]$/i.test(parts[c])) {
    c++;
    let n = 0;
    while (c < parts.length && /^[a-z0-9]{2,8}$/i.test(parts[c])) {
      c++;
      n++;
    }
    if (!n) return bad(`Unable to recognise part ${c} ('${parts[c - 1]}') as a valid language part in the code '${code}'`);
  }
  if (c < parts.length && /^x$/i.test(parts[c])) {
    c++;
    let n = 0;
    while (c < parts.length && /^[a-z0-9]{1,8}$/i.test(parts[c])) {
      c++;
      n++;
    }
    if (!n) return bad(`Unable to recognise part ${c} ('${parts[c - 1]}') as a valid language part in the code '${code}'`);
  }
  if (c < parts.length) return bad(`Unable to recognise part ${c + 1} ('${parts[c]}') as a valid language part in the code '${code}'`);
  return { valid: true };
}

/** A MIME type value of the shape tx.fhir.org accepts (`type/subtype` with optional `;` parameters). */
export function mimeTypeShapeOk(code: string): boolean {
  return /^[^\s/;]+\/[^\s/;]+(\s*;.*)?$/.test(code.trim());
}

/**
 * Membership of a code in a whole-system include of BCP-47 / BCP-13 (no concept list, no filter): the code is a
 * member exactly when it is a valid code of the system. undefined when not decidable here (other systems, registry
 * unavailable). For BCP-13 the R4 mimetypes value set also takes "xml" / "json" / "ttl"
 * (ValueSetValidator: !isR6Plus && code in (xml, json, ttl)).
 */
export function specialSystemMember(system: string, code: string): boolean | undefined {
  if (system === BCP47) {
    const r = judgeLanguageTag(code);
    return r === null ? undefined : r.valid;
  }
  if (system === BCP13) {
    if (["xml", "json", "ttl"].includes(code)) return true;
    return mimeTypeShapeOk(code);
  }
  if (system === RFC3986) return isAbsoluteUrl(code);
  if (system === "http://hl7.org/fhir/sid/cvx") return Object.hasOwn(CVX_CODES, code);
  if (system === "urn:iso:std:iso:3166") return Object.hasOwn(ISO3166_DISPLAY, code);
  if (system === UCUM_SYSTEM) {
    const r = checkUcumCode(code);
    return r === "unchecked" ? undefined : r === "valid";
  }
  return undefined;
}

/**
 * Code systems the validator's terminology server answers: its published capability list (txCodeTables.txKnowsSystem),
 * the list validator_cli itself consults (ValueSetValidator.preferServerSide, standalone tag 7.0.1:1135). A system outside
 * it that no package holds is unknown to the server as well (REVIEW_port_2 G21). Without the bundled list: the standalone
 * ValueSetValidator SERVER_SIDE_LIST (tag 7.0.1:1131) plus the HL7 / THO / SNOMED / DICOM spaces, CPT, ATC and the
 * urn:ietf / urn:iso systems.
 */
export function terminologyServerKnows(system: string): boolean {
  const known = txKnowsSystem(system);
  if (known !== null) return known;
  const listed = [
    "http://fdasis.nlm.nih.gov",
    "http://hl7.org/fhir/sid/ndc",
    "http://loinc.org",
    "http://snomed.info/sct",
    "http://unitsofmeasure.org",
    "http://unstats.un.org/unsd/methods/m49/m49.htm",
    "http://varnomen.hgvs.org",
    "http://www.nlm.nih.gov/research/umls/rxnorm",
    "https://www.usps.com/",
    "urn:oid:1.2.36.1.2001.1005.17",
    "http://www.ama-assn.org/go/cpt",
    "http://www.whocc.no/atc",
    // official outcomes answer codes of these with no package holding them
    "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
    "https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
    "http://www.ada.org/snodent",
    "http://nucc.org/provider-taxonomy",
    "http://standardterms.edqm.eu",
    "http://fhir.de/CodeSystem/dimdi/icd-10-gm",
    "http://fhir.de/CodeSystem/bfarm/atc",
    "http://id.who.int/icd/release/11/mms",
  ];
  if (listed.includes(system)) return true;
  if (system.startsWith("urn:ietf:") || system.startsWith("urn:iso:")) return true;
  return /^https?:\/\/(terminology\.)?hl7\.org\//.test(system) || system.startsWith("http://snomed.info/") || system.startsWith("http://dicom.nema.org/");
}
