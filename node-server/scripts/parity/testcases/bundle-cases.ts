/**
 * Offline parity runner, area "bundle" (parity v3): the R4 cases of the official fhir-test-cases validator manifest
 * whose input is a Bundle, or whose expected validator_cli output carries Bundle / Reference messages, validated with
 * the builtin InstanceValidator over a local package cache (no DB, no network). Reports
 *   - per case: does our ERROR message multiset equal the official one (path-insensitive), and
 *   - per message: recall / precision of the Bundle- and Reference-class issues (BUNDLE_* / Reference_REF_* ids of
 *     Messages.properties) at error and warning level, matched on (severity, message, normalised path).
 *
 *   node --import tsx scripts/parity/testcases/bundle-cases.ts [--cases ~/ref/fhir-test-cases/validator]
 *     [--cache /home/brian/tools/validator-cli/fhircache/packages] [--only name-substring] [-v] [--json out.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FilePackages } from "../../suggestions-eval/fileDeps.js";
import { InstanceValidator, type CodeCheck, type ValidatorResolver } from "../../../src/fhirValidator.js";
import { xmlToFhirJson } from "./fhirXml.js";

type Json = Record<string, any>;
const args = process.argv.slice(2);
const opt = (k: string, d: string): string => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const CASES = opt("--cases", join(homedir(), "ref/fhir-test-cases/validator"));
const CACHE = opt("--cache", "/home/brian/tools/validator-cli/fhircache/packages");
const ONLY = args.includes("--only") ? opt("--only", "") : null;
const VERBOSE = args.includes("-v");
const OUT = args.includes("--json") ? opt("--json", "") : null;
const PACKAGES = ["hl7.fhir.r4.core#4.0.1", "hl7.fhir.uv.extensions.r4#5.2.0", "hl7.terminology.r4#7.0.0"];

/** Bundle / reference message templates (Messages.properties, 7.0.1) as regexes — the "bundle" area's classes. */
const BUNDLE_TEMPLATES: Record<string, string> = {
  BUNDLE_ENTRY_URL_ABSOLUTE: "The fullUrl must be an absolute URL (not '{0}')",
  BUNDLE_ENTRY_URL_MATCHES_NO_ID: "The fullUrl '{0}' looks like a RESTful server URL, but the resource has no id",
  BUNDLE_ENTRY_URL_MATCHES_TYPE_ID: "The fullUrl '{0}' looks like a RESTful server URL, so it must end with the correct type and id (/{1}/{2})",
  Bundle_BUNDLE_Entry_Canonical: "The canonical URL ({0}) cannot match the fullUrl ({1}) unless on the canonical server itself",
  Bundle_BUNDLE_Entry_MismatchIdUrl: "The canonical URL ({0}) cannot match the fullUrl ({1}) unless the resource id ({2}) also matches",
  Bundle_BUNDLE_Entry_Document: "The first entry in a document must be a composition",
  VALIDATION_BUNDLE_MESSAGE: "The first entry in a message must be a MessageHeader",
  BUNDLE_BUNDLE_ENTRY_FOUND_MULTIPLE: "Found {0} matches for '{1}' in the bundle ({2})",
  BUNDLE_BUNDLE_ENTRY_FULLURL_REQUIRED: "Except for transactions and batches, each entry in a Bundle must have a fullUrl which is the identity of the resource in the entry",
  Bundle_BUNDLE_Entry_NoFirst: "Documents or Messages must contain at least one entry",
  Bundle_BUNDLE_Entry_NoFirstResource: "No resource on first entry",
  Bundle_BUNDLE_Entry_NoFullUrl: "Bundle entry missing fullUrl",
  Bundle_BUNDLE_Entry_NotFound: "Can't find '{0}' in the bundle ({1}){*}",
  Bundle_BUNDLE_Entry_Orphan: "Entry {0} isn't reachable by traversing links (forward or backward) from the {1}",
  BUNDLE_BUNDLE_ENTRY_REVERSE: "Entry {0} isn't reachable by traversing forwards from the {1}",
  Bundle_BUNDLE_FullUrl_Missing: "Relative Reference appears inside Bundle whose entry is missing a fullUrl",
  Bundle_BUNDLE_FullUrl_NeedVersion: "Entries matching fullURL {0} should declare meta/versionId because there are version-specific references",
  Bundle_BUNDLE_MultipleMatches: "Multiple matches in bundle for reference {0}",
  Bundle_BUNDLE_Not_Local: "URN reference is not locally contained within the bundle {0}",
  BUNDLE_BUNDLE_POSSIBLE_MATCH: "Entry {0} matches the reference {1} by type and id but {*}",
  BUNDLE_POSSSIBLE_MATCHES: "The bundle contains no match for {1} by the rules of Bundle reference resolution, but it has multiple resources that match {0} by resource type and id",
  BUNDLE_LINK: "The link relationship type '{0}' {*}",
  BUNDLE_LINK_STYELSHEET: "{*}stylesheet{*}",
  BUNDLE_LINK_STYELSHEET_EXTERNAL: "External Stylesheets{*}",
  BUNDLE_SEARCH_NO_MODE: "SearchSet bundles should have search modes on the entries",
  BUNDLE_SEARCH_NOSELF: "SearchSet Bundles should have a self link that specifies what the search was",
  BUNDLE_SEARCH_ENTRY_NO_RESOURCE: "SearchSet Bundle Entries must have resources",
  BUNDLE_SEARCH_ENTRY_NO_RESOURCE_ID: "Search results must have ids",
  BUNDLE_SEARCH_ENTRY_WRONG_RESOURCE_TYPE: "This is not a matching resource type for the specified search {*}",
  BUNDLE_SEARCH_ENTRY_WRONG_RESOURCE_TYPE_OUTCOME: "This is not an OperationOutcome ({0})",
  Reference_REF_Aggregation: "Reference is {0} which isn't supported by the specified aggregation mode(s) for the reference ({1})",
  Reference_REF_BadTargetType: "Invalid Resource target type. Found {0}, but expected one of ({1})",
  Reference_REF_BadTargetType2: "The type '{0}' implied by the reference URL {1} is not a valid Target for this element (must be one of {2})",
  Reference_REF_CantMatchChoice: "Unable to find a profile match for {0} among choices: {1}",
  Reference_REF_CantMatchType: "Unable to find a profile match for {0} (by type) among choices: {1}",
  Reference_REF_CantResolve: "Unable to resolve resource with reference '{0}'",
  Reference_REF_CantResolveProfile: "Unable to resolve the profile reference '{0}'",
  Reference_REF_Format: "Relative URLs must be of the format [ResourceName]/[id]{*}",
  Reference_REF_MultipleMatches: "Found multiple matching profiles for {0} among choices: {1}",
  Reference_REF_NoDisplay: "A Reference without an actual reference or identifier should have a display",
  Reference_REF_NotFound_Bundle: "Bundled or contained reference not found within the bundle/resource {0}",
  Reference_REF_NoType: "Unable to determine type of target resource",
  REFERENCE_REF_QUERY: "{*}conditional reference{*}",
  REFERENCE_REF_REL_UNSOLVEABLE: "The URL '{0}' cannot be resolved unless the fullURL is a RESTFul base URL{*}",
  Reference_REF_ResourceType: "Matching reference for reference {0} has resourceType {1}",
  REFERENCE_REF_SUSPICIOUS: "The syntax of the reference '{0}' looks incorrect, and it should be checked",
  Reference_REF_WrongTarget: "The type '{0}' is not a valid Target for this element (must be one of {1})",
  REFERENCE_REF_INVALID_REF: "The reference '{0}' is not a valid reference",
};
const CLASS_RES: Array<[string, RegExp]> = Object.entries(BUNDLE_TEMPLATES).map(([id, t]) => {
  const re = t
    .split(/(\{\d\}|\{\*\})/u)
    .map((p) => (/^\{\d\}$/u.test(p) ? "(.*?)" : p === "{*}" ? ".*" : p.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
    .join("");
  return [id, new RegExp(`^${re}\\s*$`, "su")];
});
export function bundleClass(msg: string): string | null {
  for (const [id, re] of CLASS_RES) if (re.test(msg)) return id;
  return null;
}

/** official expression → our path style: drop /*Type/id*\/ comments, `.x.ofType(T)` → `.xT`. */
function normPath(p: string): string {
  return p
    .replace(/\/\*[^*]*\*\//gu, "")
    .replace(/\.([a-z][A-Za-z]*)\.ofType\(([A-Za-z]+)\)/gu, (_m, a: string, t: string) => `.${a}${t[0].toUpperCase()}${t.slice(1)}`)
    .replace(/\[x\]/gu, "");
}

const EXTERNAL_SYSTEMS = new Set(["http://loinc.org", "http://snomed.info/sct", "http://www.nlm.nih.gov/research/umls/rxnorm", "http://hl7.org/fhir/sid/icd-10", "http://hl7.org/fhir/sid/icd-10-cm", "http://hl7.org/fhir/sid/cvx", "http://unitsofmeasure.org", "urn:ietf:bcp:47", "urn:iso:std:iso:3166", "http://hl7.org/fhir/sid/ndc"]);

function resolverFor(pk: FilePackages, overlay: Json[]): ValidatorResolver {
  const base = pk.resolver();
  const byUrl = new Map<string, Json>();
  for (const r of overlay) if (typeof r.url === "string") byUrl.set(r.url, r);
  const get = (url: string, type: string): Json | null => {
    const r = byUrl.get(url.split("|")[0]);
    return r && r.resourceType === type ? r : null;
  };
  return {
    ...base,
    fetchStructureDefinition: async (u) => get(u, "StructureDefinition") ?? base.fetchStructureDefinition(u),
    fetchValueSet: async (u) => get(u, "ValueSet") ?? base.fetchValueSet(u),
    // external terminologies are not held offline: fail open (the terminology area owns these verdicts)
    checkCode: async (s, c, d, v): Promise<CodeCheck> => (EXTERNAL_SYSTEMS.has(s) ? { status: "ok" } : base.checkCode(s, c, d, v)),
    valueSetContains: async (u, s, c) => (s && EXTERNAL_SYSTEMS.has(s) ? undefined : base.valueSetContains(u, s, c)),
    codeSystemResolvable: async (s) => EXTERNAL_SYSTEMS.has(s) || !!get(s, "CodeSystem") || (base.codeSystemResolvable ? base.codeSystemResolvable(s) : true),
    definitionExists: async (u) => byUrl.has(u.split("|")[0]) || (base.definitionExists ? base.definitionExists(u) : true),
  };
}

interface Iss {
  severity: string;
  message: string;
  path: string;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(CASES, "manifest.json"), "utf8"));
  const pk = new FilePackages(CACHE, PACKAGES);
  const sdSource = { sd: (t: string) => pk.get(`http://hl7.org/fhir/StructureDefinition/${t}`, "StructureDefinition") };
  const rows: Json[] = [];
  const tally = { expErr: 0, hitErr: 0, oursErr: 0, okErr: 0, expWarn: 0, hitWarn: 0, oursWarn: 0, okWarn: 0 };
  const missById = new Map<string, number>();
  const extraById = new Map<string, number>();
  for (const t of manifest["test-cases"] as Json[]) {
    if (!String(t.version ?? "5.0").startsWith("4.0")) continue;
    if (ONLY && !String(t.name).includes(ONLY)) continue;
    const file = join(CASES, t.file);
    const outcomeFile = typeof t.java === "string" ? join(CASES, "outcomes", t.java) : null;
    if (!existsSync(file) || !outcomeFile || !existsSync(outcomeFile)) continue;
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/u, "");
    const isXml = t.file.endsWith(".xml");
    if (!isXml && !t.file.endsWith(".json")) continue;
    const expected: Iss[] = (JSON.parse(readFileSync(outcomeFile, "utf8")).issue ?? []).map((i: Json) => ({
      severity: i.severity,
      message: String(i.details?.text ?? "").trim(),
      path: normPath(String(i.expression?.[0] ?? "")),
    }));
    const isBundle = isXml ? /<Bundle[\s>]/u.test(text.slice(0, 2000)) : /"resourceType"\s*:\s*"Bundle"/u.test(text.slice(0, 4000));
    const hasBundleMsgs = expected.some((i) => bundleClass(i.message) !== null);
    if (!isBundle && !hasBundleMsgs) continue;
    let res: Json;
    try {
      res = isXml ? xmlToFhirJson(text, sdSource) : JSON.parse(text);
    } catch (e) {
      rows.push({ name: t.name, skipped: `parse: ${(e as Error).message}` });
      continue;
    }
    const overlay: Json[] = [];
    for (const s of [...(t.supporting ?? [])] as string[]) {
      const p = join(CASES, s);
      if (!existsSync(p)) continue;
      try {
        const st = readFileSync(p, "utf8");
        overlay.push(s.endsWith(".xml") ? xmlToFhirJson(st, sdSource) : JSON.parse(st));
      } catch {
        /* unsupported supporting file */
      }
    }
    let ours: Iss[];
    try {
      const v = new InstanceValidator(resolverFor(pk, overlay));
      ours = ((await v.validate(res, {})) as Json[]).map((i) => ({ severity: String(i.severity), message: String(i.message).trim(), path: normPath(String(i.path ?? "")) }));
    } catch (e) {
      rows.push({ name: t.name, skipped: `validate: ${(e as Error).message}` });
      continue;
    }
    const isErr = (i: Iss): boolean => i.severity === "error" || i.severity === "fatal";
    const ms = (l: Iss[]): string[] => l.filter(isErr).map((i) => i.message).sort();
    const errEqual = JSON.stringify(ms(expected)) === JSON.stringify(ms(ours));
    // bundle-class matching (severity + message + path)
    const key = (i: Iss): string => `${isErr(i) ? "E" : i.severity[0]}|${i.message}|${i.path}`;
    const expB = expected.filter((i) => (isErr(i) || i.severity === "warning") && bundleClass(i.message));
    const ourB = ours.filter((i) => (isErr(i) || i.severity === "warning") && bundleClass(i.message));
    const pool = new Map<string, number>();
    for (const i of ourB) pool.set(key(i), (pool.get(key(i)) ?? 0) + 1);
    const missing: Iss[] = [];
    for (const i of expB) {
      const k = key(i);
      const n = pool.get(k) ?? 0;
      if (n > 0) {
        pool.set(k, n - 1);
        if (isErr(i)) tally.hitErr++;
        else tally.hitWarn++;
      } else missing.push(i);
      if (isErr(i)) tally.expErr++;
      else tally.expWarn++;
    }
    const expPool = new Map<string, number>();
    for (const i of expB) expPool.set(key(i), (expPool.get(key(i)) ?? 0) + 1);
    const extra: Iss[] = [];
    for (const i of ourB) {
      const k = key(i);
      const n = expPool.get(k) ?? 0;
      if (n > 0) {
        expPool.set(k, n - 1);
        if (isErr(i)) tally.okErr++;
        else tally.okWarn++;
      } else extra.push(i);
      if (isErr(i)) tally.oursErr++;
      else tally.oursWarn++;
    }
    for (const i of missing) missById.set(`${isErr(i) ? "E" : "W"} ${bundleClass(i.message)}`, (missById.get(`${isErr(i) ? "E" : "W"} ${bundleClass(i.message)}`) ?? 0) + 1);
    for (const i of extra) extraById.set(`${isErr(i) ? "E" : "W"} ${bundleClass(i.message)}`, (extraById.get(`${isErr(i) ? "E" : "W"} ${bundleClass(i.message)}`) ?? 0) + 1);
    rows.push({ name: t.name, file: t.file, errEqual, bundleOk: !missing.length && !extra.length, missing, extra, expErrors: ms(expected), ourErrors: ms(ours) });
    if (VERBOSE && (missing.length || extra.length || !errEqual)) {
      console.log(`## ${t.name} (${t.file}) errEqual=${errEqual}`);
      for (const i of missing) console.log(`  - MISSING ${i.severity} ${i.path} | ${i.message}`);
      for (const i of extra) console.log(`  + EXTRA   ${i.severity} ${i.path} | ${i.message}`);
      if (!errEqual) {
        const e = ms(expected);
        const o = ms(ours);
        for (const m of e.filter((x) => !o.includes(x))) console.log(`  e- ${m.slice(0, 220)}`);
        for (const m of o.filter((x) => !e.includes(x))) console.log(`  e+ ${m.slice(0, 220)}`);
      }
    }
  }
  const run = rows.filter((r) => !r.skipped);
  console.log(`cases: ${rows.length} selected, ${run.length} run, ${rows.length - run.length} skipped`);
  console.log(`error multiset equal (all classes): ${run.filter((r) => r.errEqual).length}/${run.length}`);
  console.log(`bundle/reference issues exact (both directions): ${run.filter((r) => r.bundleOk).length}/${run.length}`);
  console.log(`bundle-class errors:   recall ${tally.hitErr}/${tally.expErr}, precision ${tally.okErr}/${tally.oursErr}`);
  console.log(`bundle-class warnings: recall ${tally.hitWarn}/${tally.expWarn}, precision ${tally.okWarn}/${tally.oursWarn}`);
  console.log("missing:", JSON.stringify([...missById].sort((a, b) => b[1] - a[1])));
  console.log("extra:", JSON.stringify([...extraById].sort((a, b) => b[1] - a[1])));
  for (const r of rows.filter((x) => x.skipped)) console.log(`skipped ${r.name}: ${r.skipped}`);
  if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
