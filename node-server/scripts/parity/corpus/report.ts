/**
 * Acceptance metrics + failure buckets over corpus/run.ts result files (one or more shards).
 *
 * Evaluator comparison rules (2026-11-02): errors only (warnings never compared); an official error WITH a Java
 * message_id is matched by (normalised path, classify.errorClass) — our proxy for the id, since TS issues carry none —,
 * one WITHOUT an id (parse-layer messages) by (normalised path, normalised text = compare.lenientMessage); items
 * validator_cli crashed on form the "official-crash" bucket (PASS iff TS reported >= 1 error without throwing / timing
 * out); family profile-typo (validator_cli fetched the typo'd profile online — unstable) forms the "network-dependent"
 * bucket, listed but outside the gate; mutation meta-profile-scalar (batch vs standalone may differ, the corpus has
 * only one run) is flagged. Several result files may name the same id: the last one wins.
 *
 * Per IG, over the gate items (compared, not official-crash, not network-dependent):
 *  - verdict differences: items whose error presence differs (official invalid ⇄ ours valid, and the reverse); the
 *    miss is also reported restricted to items our tool marked checked_fully=true (REVIEW_port_1 §6: only those are
 *    true misses — checked_fully=false is "could not be verified", not a pass);
 *  - missing: official error keys (normalised path + classify.errorClass of the official text) without a counterpart in
 *    ours (multiset), and the items that have one;
 *  - extra rate: our error keys without an official counterpart / all official error keys (acceptance target < 0.1%);
 *  - strict (path + message multiset) and lenient message-level agreement per item.
 * Items validator_cli crashed on and raw files no MCP client can send (corpus/loaders.ts `evaluator`) are counted apart.
 *
 * Buckets: missing / extra grouped by (error class, Java message_id of the official issue — "-" for extras, which have
 * none —, mutation family), with counts and example ids. --plan writes the top-N buckets' first examples as a
 * corpus/run.ts --repro-plan (class-level targets).
 *
 * Release simulation (a Bundle converts automatically only with 0 errors and checked_fully=true): see the section text.
 * Also: why items are not fully checked (`unchecked`, see classifyUnchecked; --held held.json from corpus/held.ts says
 * what terminology this install holds), the all-corpus figures with the network bucket, and the items no tool call can
 * carry (flag tool-boundary: outside the gate, measured through validateText, with what rejects them in the service).
 *
 * --corrections file (JSONL, assumed format of the evaluator's list: {ig, id, issues}, `issues` in the shape of a
 * <id>.official.json, one validator_cli JVM per item): the batch run of validator_cli reuses cached code validations,
 * so listed items are scored against that standalone result instead; the official files are not touched.
 *
 *   node --import tsx scripts/parity/corpus/report.ts <results.json>... [--md out.md] [--plan plan.json] [--top 30] [--cmd "<re-run command>"] [--held held.json] [--commit <hash>] [--corrections list.jsonl]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { errorClass, isContentCheck } from "../classify.js";
import { compareIssues, isError, lenientMessage, normMessage, normPath, type SimpleIssue } from "../lib/compare.js";
import { readResults } from "./results.js";

type Res = Record<string, any>;
interface ErrKey {
  path: string;
  cls: string;
  msg: string;
  msgid?: string | null;
}

const args = process.argv.slice(2);
const opt = (k: string): string | null => (args.includes(k) ? args[args.indexOf(k) + 1] ?? null : null);
const valued = new Set(["--md", "--plan", "--top", "--cmd", "--held", "--commit", "--corrections"]);
const files = args.filter((a, i) => !a.startsWith("-") && !valued.has(args[i - 1] ?? ""));
const top = Number(opt("--top") ?? 30);

const byId = new Map<string, Res>();
// the same id can exist in several IGs (corpus ids are per IG): key by ig + id
for (const f of files) readResults(f, (r) => byId.set(`${r.ig ?? ""}/${r.id}`, r));
const items: Res[] = [...byId.values()];
const correctionsFile = opt("--corrections");
let corrected = 0;
const correctionsUnmatched: string[] = [];
if (correctionsFile) {
  for (const line of readFileSync(correctionsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as Res;
    const it = byId.get(`${c.ig}/${c.id}`);
    if (!it) {
      correctionsUnmatched.push(`${c.ig}/${c.id}`);
      continue;
    }
    const official: SimpleIssue[] = (c.issues as Res[])
      .map((i) => ({ severity: String(i.severity ?? "").toLowerCase(), path: String((Array.isArray(i.expression) && i.expression[0]) || (Array.isArray(i.location) && i.location[0]) || ""), message: String(i.text ?? ""), code: i.code, messageId: i.message_id ?? null }))
      .filter((i) => !isContentCheck(i));
    it.officialErrors = official.filter(isError).map((i): ErrKey => ({ path: normPath(i.path), cls: errorClass(normMessage(i.message)), msg: normMessage(i.message), msgid: i.messageId }));
    if (it.comparison) {
      // our side as the run stored it; the comparison flags follow the corrected official side
      it.comparison = compareIssues(official, ((it.ourErrors ?? []) as ErrKey[]).map((e) => ({ severity: "error", path: e.path, message: e.msg })));
      it.status = it.comparison.strict ? "pass" : "fail";
    }
    delete it.officialCrash;
    if (it.skip === "official-crash") delete it.skip;
    corrected++;
  }
}
/** profile-typo, also inside a combo mutation ("profile-typo/…+…"): validator_cli fetched the typo'd profile online */
const isNetwork = (it: Res): boolean => it.family === "profile-typo" || /(?:^|\+)profile-typo\//u.test(String(it.mutation ?? ""));
const isScalar = (it: Res): boolean => /meta-profile-scalar/u.test(String(it.mutation ?? ""));
const isOfficialCrash = (it: Res): boolean => !!it.officialCrash || it.skip === "official-crash";
const isToolBoundary = (it: Res): boolean => (it.flags ?? []).includes("tool-boundary") || (it.flags ?? []).includes("tool-rejected");

type UncheckedClass = "other" | "dependency" | "tx" | "local";
/** Worst first: an item with several reasons counts under the first of these it has. */
const UNCHECKED_ORDER: UncheckedClass[] = ["other", "dependency", "tx", "local"];
const heldFile = opt("--held");
const heldSystems: Record<string, number> = heldFile ? (JSON.parse(readFileSync(heldFile, "utf8")) as Res).systems : {};
/** Code systems answered by code here, not by a table. */
const LOCAL_ENGINES = new Set(["http://unitsofmeasure.org", "urn:ietf:bcp:47", "urn:ietf:bcp:13", "urn:ietf:rfc:3986", "urn:iso:std:iso:3166", "http://hl7.org/fhir/sid/cvx"]);
const TERMINOLOGY_TABLES = new Set(["http://snomed.info/sct", "http://loinc.org", "http://www.nlm.nih.gov/research/umls/rxnorm", "http://hl7.org/fhir/sid/icd-10-cm", "http://www.cms.gov/Medicare/Coding/ICD10", "http://hl7.org/fhir/sid/icd-10"]);
/** Installed CodeSystems are keyed by resource id: `<base>/CodeSystem/<id>`. */
const holdsConcepts = (system: string): boolean => (heldSystems[system] ?? 0) > 0 || (heldSystems[system.split("/").pop() ?? ""] ?? 0) > 0;
const systemIsLocal = (system: string): boolean => system === "" || LOCAL_ENGINES.has(system) || TERMINOLOGY_TABLES.has(system) || holdsConcepts(system);

/** Each reason an item is not fully checked: (class, what). */
export function classifyUnchecked(it: Res): Array<[UncheckedClass, string]> {
  const u: Res = it.unchecked ?? {};
  const out: Array<[UncheckedClass, string]> = [];
  for (const d of u.deps_missing ?? []) out.push(["dependency", `package ${typeof d === "string" ? d : `${d.package_id ?? d.id ?? d.name ?? JSON.stringify(d)}`}`]);
  if (u.lookups_failed) out.push(["other", "database lookups failed"]);
  if (u.fallback_reason) out.push(["other", "official validator fallback"]);
  for (const x of u.unverified ?? []) out.push(["other", `unverified ${String(x?.message ?? x).slice(0, 80)}`]);
  for (const c of u.invariants_unchecked ?? []) out.push(["local", `invariant ${c}`]);
  // a profile the instance itself names wrongly (typo, malformed canonical) is not a missing IG dependency
  for (const c of u.profiles_unchecked ?? []) out.push(isNetwork(it) || !/^https?:\/\/[^\s]+$/u.test(String(c)) ? ["other", "instance names an unknown profile (mutation)"] : ["dependency", `profile ${c}`]);
  for (const c of u.valuesets_unchecked ?? []) out.push(/terminology\.hl7\.org|hl7\.org\/fhir\/ValueSet/u.test(String(c)) ? ["tx", `ValueSet ${c}`] : ["dependency", `ValueSet ${c}`]);
  const causes: string[] = u.undecided_causes ?? [];
  const causedVs = new Set<string>();
  for (const c of causes) {
    const i = c.indexOf("|");
    const system = c.slice(0, i);
    const vs = c.slice(i + 1);
    causedVs.add(vs);
    out.push([systemIsLocal(system) ? "local" : "tx", `${system || "(bare code)"} in ${vs}`]);
  }
  for (const c of u.codes_unchecked ?? []) {
    const url = String(c);
    if (causedVs.has(url)) continue;
    if (/\/ValueSet\//u.test(url)) out.push(["local", `ValueSet ${url}`]);
    // a system named directly: the code check said undecided — only the tables / engines here can answer without tx
    else out.push([LOCAL_ENGINES.has(url) || TERMINOLOGY_TABLES.has(url) ? "local" : "tx", `CodeSystem ${url}`]);
  }
  if (!causes.length) for (const c of u.slices_unchecked ?? []) out.push(["local", `slice without a terminology cause ${c}`]);
  if (!out.length) out.push(["other", "checked_fully=false without a recorded reason"]);
  return out;
}
const k = (e: ErrKey): string => `${e.path} | ${e.cls}`;

/** normalised text for id-less (parse-layer) messages. */
const textKey = (e: ErrKey): string => `${e.path} | ${lenientMessage(e.msg)}`;
/** Official <-> ours one-to-one: an official error with a Java id by (path, class), one without by (path, text). */
export function matchErrors(off: ErrKey[], ours: ErrKey[]): { miss: ErrKey[]; extra: ErrKey[] } {
  const used = new Array<boolean>(ours.length).fill(false);
  const miss: ErrKey[] = [];
  // id-less first: they need the stricter text match, so they must not lose their counterpart to a class match
  const order = [...off].sort((a, b) => Number(!!a.msgid) - Number(!!b.msgid));
  for (const e of order) {
    const want = e.msgid ? k(e) : textKey(e);
    const j = ours.findIndex((o, x) => !used[x] && (e.msgid ? k(o) : textKey(o)) === want);
    if (j >= 0) used[j] = true;
    else miss.push(e);
  }
  return { miss, extra: ours.filter((_, x) => !used[x]) };
}

/**
 * The owner of a failure key (for dispatch): a Java class / rule family, from the class, the Java id and the message.
 * Order matters: the specific families first; `other` is what none of them names.
 */
export function area(cls: string, msgid: string | null | undefined, msg: string): string {
  const id = String(msgid ?? "");
  if (/^tool error /u.test(msg)) return "harness/tool-boundary";
  // elementmodel.JsonParser: the parse layer has no message ids
  if (
    /^(?:array|unrecognized)$/u.test(cls) ||
    /^(?:The property \S+ (?:must be (?:an?|a JSON) |cannot be null)|This property must be (?:a simple value|an? object)|Array entries cannot be null|Array cannot be empty|Object must have some content|The JSON (?:property|array|element)|Error parsing JSON|The property '[^']*' is invalid|Extensions are not allowed on Resource\.id|Unrecognized property)/u.test(msg) ||
    /^(?:ILLEGAL_PROPERTY|FHIR_RESOURCE_ID_CANT_BE_EXTENDED)$/u.test(id)
  )
    return "json-parser";
  if (/XHTML|Xhtml/u.test(id) || /^(?:Hyperlink |Wrong (?:name|namespace) on the XHTML|Error parsing XHTML|Illegal element|Illegal attribute)/u.test(msg) || /^constraint:txt-/u.test(cls)) return "xhtml";
  if (/^Extension_|_EXT_|EXTP_/u.test(id) || /^(?:The Extension |The extension |Sub-extension url |Extension\.url )/u.test(msg) || /^constraint:ext-/u.test(cls)) return "extensions";
  if (/^slice-/u.test(cls) || /SLICE|_NotSlice|SLICING/u.test(id) || /does not match any known slice|matching slice|^Slicing cannot be evaluated/u.test(msg)) return "slicing";
  if (/^constraint:/u.test(cls) || /^Constraint failed/u.test(msg)) return "fhirpath";
  if (
    /^Bundle_|BUNDLE/u.test(id) ||
    /^(?:reachable|first-composition|cant-find)$/u.test(cls) ||
    /^(?:Bundle entry missing fullUrl|Relative Reference appears inside Bundle|Except for transactions and batches|Relative URLs must be of the format|Found \d+ matches for|Multiple matches in bundle)/u.test(msg)
  )
    return "bundle";
  if (/^Validation_VAL_Profile_WrongType$/u.test(id) || /^(?:Specified profile type was|Unknown resource type|Resource has no resourceType|This content cannot be parsed|Unable to find resourceType|Contained resource does not appear)/u.test(msg)) return "resource-root";
  if (/^Terminology_|TX_|_DISPLAY_|UCUM|Unknown_Code|Display_Name/u.test(id) || /^(?:valueset|display|unknown-code|system-uri)$/u.test(cls) || /value set|code system|CodeSystem|Wrong Display|^Coding has no code for system/u.test(msg)) return "terminology";
  if (/^Reference_REF_/u.test(id) || /^(?:target-type|profile-match)$/u.test(cls) || /Unable to find a profile match|Profile reference/u.test(msg)) return "references-profiles";
  if (/_URL_|_DT_URL|URI_|OID_|UUID_|CANONICAL/u.test(id) || /^(?:Example URLs are not allowed|Coding\.system must be|Canonical URLs|URI values|No definition could be found for URL)/u.test(msg)) return "uri";
  if (/^(?:type|min-card|max-card|fixed|not-allowed)$/u.test(cls) || /CONTAINED|RES_ID|DUPLICATE|Validation_VAL_Profile_|TYPE_SPECIFIC|Type_Specific|_DT_/u.test(id) || /resource ?type|contained resource|Duplicate ID|requires an id|primitive|must be an absolute URL/iu.test(msg)) return "structure";
  return "other";
}

interface IgStats {
  ig: string;
  items: number;
  compared: number;
  officialCrash: number;
  rawUnparseable: number;
  rawUnparseableOfficialInvalid: number;
  crash: number;
  offInvalidOursValid: number;
  /** REVIEW_port_1 §6: a true miss = official error AND ours valid AND checked_fully (not "could not be checked"). */
  offInvalidOursValidCheckedFully: number;
  offValidOursInvalid: number;
  /** items our tool reported checked_fully=false (whatever the verdict). */
  notCheckedFully: number;
  /** network-dependent (profile-typo): items, of which verdict differs */
  network: number;
  networkVerdictDiff: number;
  /** official-crash bucket: items, PASS (>= 1 TS error, no throw), FAIL valid, FAIL throw / timeout, not receivable (raw) */
  ocTotal: number;
  ocPass: number;
  ocFailValid: number;
  ocFailThrow: number;
  ocNotReceivable: number;
  /** gate + network: the whole corpus without crash / tool-boundary items */
  allItems: number;
  allVerdictMiss: number;
  allVerdictExtra: number;
  allOfficialKeys: number;
  allMissing: number;
  allExtra: number;
  /** items no tool call can carry (validateText measured the validator, flag tool-boundary) */
  toolBoundary: number;
  /** meta-profile-scalar items in the gate (flagged: batch vs standalone) and their verdict differences */
  scalar: number;
  scalarVerdictDiff: number;
  officialKeys: number;
  missing: number;
  missingItems: number;
  extra: number;
  extraItems: number;
  strict: number;
  lenient: number;
  classAgree: number;
}

interface Bucket {
  kind: "missing" | "extra";
  ig: string;
  cls: string;
  msgid: string;
  family: string;
  count: number;
  items: Set<string>;
  examples: Array<{ id: string; path: string; msg: string }>;
}

const stats = new Map<string, IgStats>();
const buckets = new Map<string, Bucket>();
const st = (ig: string): IgStats => {
  let s = stats.get(ig);
  if (!s) {
    s = { ig, items: 0, compared: 0, officialCrash: 0, rawUnparseable: 0, rawUnparseableOfficialInvalid: 0, crash: 0, offInvalidOursValid: 0, offInvalidOursValidCheckedFully: 0, offValidOursInvalid: 0, notCheckedFully: 0, network: 0, networkVerdictDiff: 0, ocTotal: 0, ocPass: 0, ocFailValid: 0, ocFailThrow: 0, ocNotReceivable: 0, allItems: 0, allVerdictMiss: 0, allVerdictExtra: 0, allOfficialKeys: 0, allMissing: 0, allExtra: 0, toolBoundary: 0, scalar: 0, scalarVerdictDiff: 0, officialKeys: 0, missing: 0, missingItems: 0, extra: 0, extraItems: 0, strict: 0, lenient: 0, classAgree: 0 };
    stats.set(ig, s);
  }
  return s;
};
const addBucket = (kind: "missing" | "extra", ig: string, it: Res, e: ErrKey): void => {
  const msgid = kind === "missing" ? String(e.msgid ?? "(none)") : "-";
  const family = String(it.family ?? "-");
  const key = [kind, ig, e.cls, msgid, family].join("\u0000");
  let b = buckets.get(key);
  if (!b) {
    b = { kind, ig, cls: e.cls, msgid, family, count: 0, items: new Set(), examples: [] };
    buckets.set(key, b);
  }
  b.count++;
  b.items.add(it.id);
  if (b.examples.length < 2 && !b.examples.some((x) => x.id === it.id)) b.examples.push({ id: it.id, path: e.path, msg: e.msg });
};

const networkList: Res[] = [];
const crashFails: Res[] = [];
interface UncheckedRow {
  items: number;
  bundles: number;
  by: Record<UncheckedClass, number>;
  onlyLocal: number;
  anyTx: number;
  gateBlockedBundles: number;
}
const uncheckedRows = new Map<string, UncheckedRow>();
const uncheckedDetail = new Map<string, { n: number; ex: string }>();
/** What rejects an item in the service, and how the validator does on it through validateText. */
interface BoundaryRow {
  items: number;
  verdictDiff: number;
  miss: number;
  extra: number;
  officialKeys: number;
  ex: string;
}
const boundary = new Map<string, BoundaryRow>();
const rejecter = (it: Res): string => {
  if (it.raw === "unparseable" && /array-root/u.test(String(it.mutation))) return "tool argument schema (z.record: the root is not an object)";
  if (it.raw === "unparseable" && /empty-file/u.test(String(it.mutation))) return "no request can be formed (empty file)";
  if (it.raw === "unparseable") return "HTTP body parser (express.json: 400, strict JSON) — the tool is never called";
  return "the tool (INVALID_ARGUMENT: resource must include a resourceType)";
};
interface ReleaseRow {
  valid: number;
  releasable: number;
  releasableWithTx: number;
  blockedTsErrors: number;
  blockedToolBoundary: number;
  /** TS 0 errors, fully checked, stopped by extended_findings (errors, or an incomplete extended pass). */
  blockedExtended: number;
  blocked: Record<UncheckedClass, number>;
  unsafe: number;
}
const releaseRows = new Map<string, ReleaseRow>();
const unsafeReleases: Res[] = [];
for (const it of items) {
  const ig = String(it.ig ?? "?");
  const s = st(ig);
  s.items++;
  const off: ErrKey[] = it.officialErrors ?? [];
  const ours: ErrKey[] = it.ourErrors ?? [];
  {
    const row = releaseRows.get(ig) ?? { valid: 0, releasable: 0, releasableWithTx: 0, blockedTsErrors: 0, blockedToolBoundary: 0, blockedExtended: 0, blocked: { other: 0, dependency: 0, tx: 0, local: 0 }, unsafe: 0 };
    releaseRows.set(ig, row);
    const ran = !!it.comparison && it.status !== "crash";
    const boundaryItem = isToolBoundary(it);
    const incomplete = (it.flags ?? []).includes("not-checked-fully");
    const parityClean = ran && !boundaryItem && !ours.length && !incomplete;
    // ROUND 9: release = parity 0 errors + checked_fully + extended 0 errors (`unverifiable` never blocks). The extended
    // layer is not compared with the jar: results keep it in `extended`, outside the issues the comparison reads
    const extendedBlocks = (it.extended?.errors ?? 0) > 0 || !!it.extended?.incomplete;
    const wouldRelease = parityClean && !extendedBlocks;
    if (wouldRelease && (off.length || isOfficialCrash(it))) {
      row.unsafe++;
      unsafeReleases.push(it);
    }
    if (!isOfficialCrash(it) && !off.length) {
      row.valid++;
      if (wouldRelease) {
        row.releasable++;
        row.releasableWithTx++;
      } else if (boundaryItem || !ran) row.blockedToolBoundary++;
      else if (ours.length) row.blockedTsErrors++;
      else if (parityClean) row.blockedExtended++;
      else {
        const cls = new Set(classifyUnchecked(it).map(([c]) => c));
        row.blocked[UNCHECKED_ORDER.find((c) => cls.has(c))!]++;
        if (cls.size === 1 && cls.has("tx")) row.releasableWithTx++;
      }
    }
  }
  if ((it.flags ?? []).includes("not-checked-fully")) {
    const row = uncheckedRows.get(ig) ?? { items: 0, bundles: 0, by: { other: 0, dependency: 0, tx: 0, local: 0 }, onlyLocal: 0, anyTx: 0, gateBlockedBundles: 0 };
    const reasons = classifyUnchecked(it);
    const cls = new Set(reasons.map(([c]) => c));
    const worst = UNCHECKED_ORDER.find((c) => cls.has(c))!;
    row.items++;
    if (it.kind === "bundle") row.bundles++;
    row.by[worst]++;
    if (worst === "local") row.onlyLocal++;
    if (cls.has("tx")) row.anyTx++;
    uncheckedRows.set(ig, row);
    for (const [c, what] of new Map(reasons.map(([c0, w]) => [`${c0}\u0000${w}`, [c0, w] as const])).values()) {
      const key = `${ig}\u0000${c}\u0000${what}`;
      const v = uncheckedDetail.get(key) ?? { n: 0, ex: String(it.id) };
      v.n++;
      uncheckedDetail.set(key, v);
    }
  }
  if (isToolBoundary(it) && !isOfficialCrash(it)) {
    s.toolBoundary++;
    const key = `${ig}\u0000${rejecter(it)}`;
    const b = boundary.get(key) ?? { items: 0, verdictDiff: 0, miss: 0, extra: 0, officialKeys: 0, ex: String(it.id) };
    b.items++;
    if (!off.length !== !ours.length) b.verdictDiff++;
    const r = matchErrors(off, ours);
    b.miss += r.miss.length;
    b.extra += r.extra.length;
    b.officialKeys += off.length;
    boundary.set(key, b);
    continue;
  }
  if (isOfficialCrash(it)) {
    s.ocTotal++;
    if (it.skip === "raw-unparseable") s.ocNotReceivable++;
    else if (it.status === "crash" || !it.comparison) {
      s.ocFailThrow++;
      crashFails.push(it);
    } else if (ours.length) s.ocPass++;
    else {
      s.ocFailValid++;
      crashFails.push(it);
    }
    continue;
  }
  if (it.skip === "raw-unparseable") {
    s.rawUnparseable++;
    if (off.length) s.rawUnparseableOfficialInvalid++;
    continue;
  }
  if (it.status === "crash" || !it.comparison) {
    s.crash++;
    continue;
  }
  {
    const r = matchErrors(off, ours);
    s.allItems++;
    if (off.length && !ours.length) s.allVerdictMiss++;
    if (!off.length && ours.length) s.allVerdictExtra++;
    s.allOfficialKeys += off.length;
    s.allMissing += r.miss.length;
    s.allExtra += r.extra.length;
  }
  if (isNetwork(it)) {
    s.network++;
    if (!off.length !== !ours.length) {
      s.networkVerdictDiff++;
      networkList.push(it);
    }
    continue;
  }
  s.compared++;
  if (isScalar(it)) {
    s.scalar++;
    if (!off.length !== !ours.length) s.scalarVerdictDiff++;
  }
  const checkedFully = !(it.flags ?? []).includes("not-checked-fully");
  if (!checkedFully) s.notCheckedFully++;
  if (off.length && !ours.length) s.offInvalidOursValid++;
  if (off.length && !ours.length && checkedFully) s.offInvalidOursValidCheckedFully++;
  if (!off.length && ours.length) s.offValidOursInvalid++;
  s.officialKeys += off.length;
  const { miss, extra } = matchErrors(off, ours);
  s.missing += miss.length;
  s.extra += extra.length;
  if (miss.length) s.missingItems++;
  if (extra.length) s.extraItems++;
  if (it.comparison.strict) s.strict++;
  if (it.comparison.lenient) s.lenient++;
  if (it.comparison.class) s.classAgree++;
  for (const e of miss) addBucket("missing", ig, it, e);
  for (const e of extra) addBucket("extra", ig, it, e);
}

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(2)}%` : "-");
const lines: string[] = [];
const cmd = opt("--cmd");
lines.push("# Differential corpus — TS validator vs validator_cli 7.0.1 (evaluator corpus)", "");
if (cmd) lines.push("Re-run:", "", "```bash", cmd, "```", "");
const commit = opt("--commit");
lines.push(`Generated ${new Date().toISOString()} from ${files.length} result file(s), ${items.length} items${commit ? `, code ${commit}` : ""}.`, "");
if (correctionsFile) lines.push(`Official side: ${corrected} item(s) scored against the standalone validator_cli result (${correctionsFile})${correctionsUnmatched.length ? `; ${correctionsUnmatched.length} listed item(s) not in these results` : ""}.`, "");
lines.push("## Per-IG acceptance metrics", "");
lines.push("| IG | items | gate items | verdict diff (miss + extra) | verdict miss: official invalid, ours valid | true miss (… and checked_fully) | verdict extra: official valid, ours invalid | official error keys | missing keys (items) | extra keys (items) | extra rate | official-crash bucket: PASS / total (FAIL valid, FAIL throw, not receivable) | network-dependent: items (verdict diff) | meta-profile-scalar flagged (verdict diff) | raw unparseable (official invalid) | harness crash | tool-boundary | ours checked_fully=false | strict agree | lenient agree | class agree |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const all = [...stats.values()].sort((a, b) => a.ig.localeCompare(b.ig));
const sum = (f: (s: IgStats) => number): number => all.reduce((a, s) => a + f(s), 0);
const row = (s: IgStats): string =>
  `| ${s.ig} | ${s.items} | ${s.compared} | ${s.offInvalidOursValid + s.offValidOursInvalid} | ${s.offInvalidOursValid} | ${s.offInvalidOursValidCheckedFully} | ${s.offValidOursInvalid} | ${s.officialKeys} | ${s.missing} (${s.missingItems}) | ${s.extra} (${s.extraItems}) | ${pct(s.extra, s.officialKeys)} | ${s.ocPass} / ${s.ocTotal} (${s.ocFailValid}, ${s.ocFailThrow}, ${s.ocNotReceivable}) | ${s.network} (${s.networkVerdictDiff}) | ${s.scalar} (${s.scalarVerdictDiff}) | ${s.rawUnparseable} (${s.rawUnparseableOfficialInvalid}) | ${s.crash} | ${s.toolBoundary} | ${s.notCheckedFully} | ${s.strict}/${s.compared} (${pct(s.strict, s.compared)}) | ${s.lenient}/${s.compared} (${pct(s.lenient, s.compared)}) | ${s.classAgree}/${s.compared} (${pct(s.classAgree, s.compared)}) |`;
for (const s of all) lines.push(row(s));
if (all.length > 1) {
  const t = Object.fromEntries(Object.keys(all[0]).map((key) => [key, key === "ig" ? "**all**" : sum((s) => (s as any)[key])])) as unknown as IgStats;
  lines.push(row(t));
}
lines.push(
  "",
  "Errors only (error + fatal; MCP content checks dropped). An official error with a Java message_id matches ours by (normalised path, classify.errorClass); one without (parse layer) by (normalised path, normalised text). Gate items exclude official-crash, network-dependent (profile-typo) and raw-unparseable items. Acceptance: verdict differences 0, missing 0, extra rate < 0.1%.",
  "",
);
lines.push("## Release simulation", "");
lines.push(
  "Items are the whole corpus, network bucket included. A release needs TS 0 errors and checked_fully=true through the service path; tool-boundary items cannot reach the service, so they never release.",
  "- **jar valid**: 0 official errors; official-crash items are excluded.",
  "- **releasable without outbound (measured)**: of those, TS 0 errors and checked_fully=true. The corpus TS run has no live tx, so this is a direct measurement.",
  "- **releasable with outbound (ESTIMATE, not run)**: the measured column plus items with TS 0 errors whose only undecided reasons are class tx. It assumes tx decides each of them and finds no error.",
  "- **blocked by extended**: parity clean (TS 0 errors, checked_fully=true) but extended_findings has errors or is incomplete. Extended findings are never compared with the jar; `unverifiable` does not block. Result files without `extended` (before ROUND 9) show 0.",
  "- **blocked columns** split the jar-valid items that do not release without outbound; an item counts under its worst reason (other > dependency > tx > local).",
  "- **unsafe release**: TS 0 errors and checked_fully=true, but the jar judged the item invalid or crashed on it. Must be 0.",
  "",
);
lines.push("| IG | jar valid | releasable, no outbound (measured) | % | releasable, outbound (estimate) | % | blocked: TS errors | blocked: other | blocked: dependency | blocked: tx | blocked: local | blocked: tool-boundary | blocked by extended | unsafe release |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const rr = [...releaseRows].sort((a, b) => a[0].localeCompare(b[0]));
const rrLine = (ig: string, r: ReleaseRow): string => `| ${ig} | ${r.valid} | ${r.releasable} | ${pct(r.releasable, r.valid)} | ${r.releasableWithTx} | ${pct(r.releasableWithTx, r.valid)} | ${r.blockedTsErrors} | ${r.blocked.other} | ${r.blocked.dependency} | ${r.blocked.tx} | ${r.blocked.local} | ${r.blockedToolBoundary} | ${r.blockedExtended} | ${r.unsafe} |`;
for (const [ig, r] of rr) lines.push(rrLine(ig, r));
const rrSum = (f: (r: ReleaseRow) => number): number => rr.reduce((a, [, r]) => a + f(r), 0);
lines.push(rrLine("**all**", { valid: rrSum((r) => r.valid), releasable: rrSum((r) => r.releasable), releasableWithTx: rrSum((r) => r.releasableWithTx), blockedTsErrors: rrSum((r) => r.blockedTsErrors), blockedToolBoundary: rrSum((r) => r.blockedToolBoundary), blockedExtended: rrSum((r) => r.blockedExtended), blocked: { other: rrSum((r) => r.blocked.other), dependency: rrSum((r) => r.blocked.dependency), tx: rrSum((r) => r.blocked.tx), local: rrSum((r) => r.blocked.local) }, unsafe: rrSum((r) => r.unsafe) }));
lines.push("", `Unsafe releases (${unsafeReleases.length}):`, "");
for (const it of unsafeReleases) lines.push(`- \`${it.ig}/${it.id}\` (${it.family}, ${String(it.mutation).slice(0, 60)})${isOfficialCrash(it) ? ": jar crashed" : `: jar ${(it.officialErrors ?? []).length} errors, first: ${String(it.officialErrors?.[0]?.msg ?? "").slice(0, 110)}`}`);
lines.push("");
lines.push("## All corpus, network bucket included (gate + network; official-crash and tool-boundary items apart)", "");
lines.push("| IG | items | verdict miss | verdict extra | official keys | missing keys | extra keys | extra rate | gate extra rate |", "|---|---|---|---|---|---|---|---|---|");
const allRow = (s: IgStats): string => `| ${s.ig} | ${s.allItems} | ${s.allVerdictMiss} | ${s.allVerdictExtra} | ${s.allOfficialKeys} | ${s.allMissing} | ${s.allExtra} | ${pct(s.allExtra, s.allOfficialKeys)} | ${pct(s.extra, s.officialKeys)} |`;
for (const s of all) lines.push(allRow(s));
if (all.length > 1) lines.push(allRow(Object.fromEntries(Object.keys(all[0]).map((key) => [key, key === "ig" ? "**all**" : sum((s) => (s as any)[key])])) as unknown as IgStats));
lines.push("");
lines.push("## Items no tool call can carry (tool-boundary): what rejects them, and the validator on them through validateText", "");
lines.push("Outside the gate. The rejection is the service's answer; the columns measure InstanceValidator.validateText over the same database resolver.", "");
lines.push("| IG | rejected by | items | verdict diff | official keys | missing keys | extra keys | example |", "|---|---|---|---|---|---|---|---|");
for (const [key, b] of [...boundary].sort((x, y) => x[0].localeCompare(y[0]))) {
  const [ig, by] = key.split("\u0000");
  lines.push(`| ${ig} | ${by} | ${b.items} | ${b.verdictDiff} | ${b.officialKeys} | ${b.miss} | ${b.extra} | \`${b.ex}\` |`);
}
lines.push("");
lines.push("## Why items are not fully checked (checked_fully=false blocks the release gate)", "");
lines.push("Each item counts under its worst reason: other > IG dependency missing > needs tx > locally decidable. `only local` = fixing local decisions frees the item (goal: 0 locally decidable). `any tx` = stays undecided in an intranet deployment for that reason; `undecided offline` = every item that is not only-local.", "");
lines.push("| IG | not fully checked | of which Bundles | other | IG dependency missing | needs tx, not cached | locally decidable (only local) | any tx reason | undecided offline |", "|---|---|---|---|---|---|---|---|---|");
const ur = [...uncheckedRows].sort((a, b) => a[0].localeCompare(b[0]));
const urSum = (f: (r: UncheckedRow) => number): number => ur.reduce((a, [, r]) => a + f(r), 0);
for (const [ig, r] of ur) lines.push(`| ${ig} | ${r.items} | ${r.bundles} | ${r.by.other} | ${r.by.dependency} | ${r.by.tx} | ${r.onlyLocal} | ${r.anyTx} | ${r.items - r.onlyLocal} |`);
lines.push(`| **all** | ${urSum((r) => r.items)} | ${urSum((r) => r.bundles)} | ${urSum((r) => r.by.other)} | ${urSum((r) => r.by.dependency)} | ${urSum((r) => r.by.tx)} | ${urSum((r) => r.onlyLocal)} | ${urSum((r) => r.anyTx)} | ${urSum((r) => r.items - r.onlyLocal)} |`);
lines.push("", "Top reasons (an item counts once per reason; example = a representative case):", "", "| IG | class | reason | items | example |", "|---|---|---|---|---|");
for (const [key, v] of [...uncheckedDetail].sort((a, b) => b[1].n - a[1].n).slice(0, 80)) {
  const [ig, c, what] = key.split("\u0000");
  lines.push(`| ${ig} | ${c} | ${what.replace(/\|/g, "\\|").slice(0, 150)} | ${v.n} | \`${v.ex}\` |`);
}
lines.push("");
lines.push("## Official-crash bucket: FAIL items (TS said valid, threw or timed out)", "");
for (const it of crashFails.slice(0, 40)) lines.push(`- \`${it.id}\` (${it.ig}, ${it.family}/${it.mutation}): ${it.status === "crash" || !it.comparison ? `TS ${String(it.error ?? "not run").split("\n")[0].slice(0, 120)}` : "TS valid"}`);
if (crashFails.length > 40) lines.push(`- ... ${crashFails.length - 40} more`);
lines.push("", "## Network-dependent bucket (profile-typo): verdict differences, outside the gate", "");
for (const it of networkList.slice(0, 40)) lines.push(`- \`${it.id}\` (${it.ig}, ${it.mutation}): official ${(it.officialErrors ?? []).length} errors, ours ${(it.ourErrors ?? []).length}`);
if (networkList.length > 40) lines.push(`- ... ${networkList.length - 40} more`);
lines.push("");

// verdict differences: which official classes the "official invalid, ours valid" items carry (and the reverse)
const vd = new Map<string, { n: number; ex: string; trueMiss: number }>();
const vr = new Map<string, { n: number; ex: string }>();
for (const it of items) {
  if (it.skip || !it.comparison || isOfficialCrash(it) || isNetwork(it)) continue;
  const off: ErrKey[] = it.officialErrors ?? [];
  const ours: ErrKey[] = it.ourErrors ?? [];
  const cf = !(it.flags ?? []).includes("not-checked-fully");
  if (off.length && !ours.length)
    for (const c of new Set(off.map((e) => `${it.ig} | ${e.cls.slice(0, 70)} | ${e.msgid ?? "(none)"} | ${it.family}`))) {
      const v = vd.get(c) ?? { n: 0, ex: it.id, trueMiss: 0 };
      v.n++;
      if (cf) v.trueMiss++;
      vd.set(c, v);
    }
  if (!off.length && ours.length)
    for (const c of new Set(ours.map((e) => `${it.ig} | ${e.cls.slice(0, 70)} | ${it.family}`))) {
      const v = vr.get(c) ?? { n: 0, ex: it.id };
      v.n++;
      vr.set(c, v);
    }
}
lines.push("## Verdict differences: official invalid, ours valid — official classes carried (an item counts once per class)", "", "| IG | class | Java message_id | family | items | of which checked_fully | example |", "|---|---|---|---|---|---|---|");
for (const [k2, v] of [...vd].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) lines.push(`| ${k2} | ${v.n} | ${v.trueMiss} | \`${v.ex}\` |`);
lines.push("", "## Verdict differences: official valid, ours invalid — our classes", "", "| IG | class | family | items | example |", "|---|---|---|---|---|");
for (const [k2, v] of [...vr].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) lines.push(`| ${k2} | ${v.n} | \`${v.ex}\` |`);
lines.push("");

const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
const tableOf = (bs: Bucket[], title: string): void => {
  lines.push(`## ${title}`, "");
  lines.push("| # | kind | IG | area | error class | Java message_id | family | keys | items | examples (id @ path: message) |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  bs.forEach((b, i) => {
    const ex = b.examples.map((x) => `\`${x.id}\` @ \`${x.path}\`: ${x.msg.replace(/\|/g, "\\|").slice(0, 160)}`).join("<br>");
    lines.push(`| ${i + 1} | ${b.kind} | ${b.ig} | ${area(b.cls, b.msgid === "-" ? null : b.msgid, b.examples[0]?.msg ?? "")} | ${b.cls.replace(/\|/g, "\\|").slice(0, 80)} | ${b.msgid} | ${b.family} | ${b.count} | ${b.items.size} | ${ex} |`);
  });
  lines.push("");
};
tableOf(sorted.slice(0, Math.max(top, 60)), `Top buckets (missing + extra, by key count)`);
const byArea = new Map<string, { missing: number; extra: number }>();
for (const b of sorted) {
  const a = area(b.cls, b.msgid === "-" ? null : b.msgid, b.examples[0]?.msg ?? "");
  const v = byArea.get(a) ?? { missing: 0, extra: 0 };
  v[b.kind] += b.count;
  byArea.set(a, v);
}
lines.push("## By TS area (heuristic)", "", "| area | missing keys | extra keys |", "|---|---|---|");
for (const [a, v] of [...byArea].sort((x, y) => y[1].missing + y[1].extra - (x[1].missing + x[1].extra))) lines.push(`| ${a} | ${v.missing} | ${v.extra} |`);
lines.push("");
// class-only roll-up (family-independent) — what one fix closes across mutation families
const byClass = new Map<string, { kind: string; cls: string; msgid: string; count: number; items: number; families: Set<string> }>();
for (const b of sorted) {
  const key = `${b.kind}\u0000${b.cls}\u0000${b.msgid}`;
  const v = byClass.get(key) ?? { kind: b.kind, cls: b.cls, msgid: b.msgid, count: 0, items: 0, families: new Set<string>() };
  v.count += b.count;
  v.items += b.items.size;
  v.families.add(b.family);
  byClass.set(key, v);
}
lines.push("## Roll-up by (kind, error class, Java message_id) across families", "", "| kind | error class | Java message_id | keys | items | families |", "|---|---|---|---|---|---|");
for (const v of [...byClass.values()].sort((a, b) => b.count - a.count).slice(0, 50)) lines.push(`| ${v.kind} | ${v.cls.replace(/\|/g, "\\|").slice(0, 80)} | ${v.msgid} | ${v.count} | ${v.items} | ${[...v.families].join(", ")} |`);
lines.push("");

const md = lines.join("\n");
const mdFile = opt("--md");
if (mdFile) writeFileSync(mdFile, md);
else console.log(md);
const planFile = opt("--plan");
if (planFile) {
  const plan = sorted.slice(0, top).map((b, i) => {
    const ex = b.examples[0];
    return { id: ex.id, kind: b.kind, path: ex.path, message: ex.msg, match: "class", bucket: `${String(i + 1).padStart(2, "0")}-${b.kind}-${b.cls}-${b.msgid}-${b.family}` };
  });
  writeFileSync(planFile, JSON.stringify(plan, null, 1));
}
for (const s of all) console.error(row(s));
