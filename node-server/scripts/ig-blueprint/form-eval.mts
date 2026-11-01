/**
 * ISSUES_v19 acceptance (b) for fhir_get_bundle_form, offline (+ v1.1: EMPD Bundle-EMPD / Bundle-DS, the self-check and
 * no prefilled example value of an identity resource / element): for each of the four Bundle
 * profiles (TW Core Bundle-twcore, TWPAS Bundle-twpas / Bundle-immunologic-agent-twpas, IPS
 * Bundle-uv-ips) build the form over a local FHIR package cache, check its structure (entries,
 * complete resources, every placeholder listed with type / what / value_source, every pointer
 * resolving to its token, no unlisted token), fill every placeholder with a type-correct FAKE value
 * (allowed[0] when listed, else the placeholder's `example` (an IG example value / a code of the binding), else a generic value of `type`; `--strict` skips the examples) and
 * validate the filled Bundle with the in-process InstanceValidator against the Bundle profile.
 * (v1.2) The fill honors the rule hints: `format` -> a matching value, `choose_one` -> only the given option,
 * `required_if` -> `when` evaluated on the filled form, `element` deleted when it does not hold.
 * Errors are split into terminology (ValueSet / CodeSystem / code / display) and the rest; the
 * acceptance gate is 0 non-terminology errors per profile.
 *
 *   FHIR_PACKAGE_CACHE=<dir with package#version/package> node --import tsx scripts/ig-blueprint/form-eval.mts [-v] [--strict] [--only empd,ips]
 *
 * Exit 0 = every profile passes, 1 = a gate fails, 2 = packages not in the cache.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InstanceValidator } from "../../src/fhirValidator.js";
import { evaluateConstraint } from "../../src/fhirPath.js";
import { bundleForm, formSelfCheck, getAt, PLACEHOLDER_TOKEN, pruneEmptyArrays, type FormPlaceholder } from "../../src/igBlueprint/form.js";
import { exampleValueAllowed } from "../../src/igBlueprint/skeleton.js";
import { CACHE, fileBlueprintDeps } from "../../src/igBlueprint/fileDeps.test.js";
import { FilePackages } from "../suggestions-eval/fileDeps.js";

type R = Record<string, any>;

const CLOSURES: Record<string, string[]> = {
  twcore: ["tw.gov.mohw.twcore#1.0.0", "hl7.fhir.uv.extensions.r4#5.2.0", "hl7.terminology.r4#7.0.0", "hl7.fhir.uv.ips#1.1.0", "hl7.fhir.r4.core#4.0.1"],
  pas: ["tw.gov.mohw.nhi.pas#1.2.7", "tw.gov.mohw.twcore#0.3.2", "hl7.fhir.us.davinci-pas#2.2.1", "hl7.fhir.uv.extensions.r4#5.3.0", "hl7.terminology.r4#7.4.0", "hl7.fhir.r4.core#4.0.1"],
  ips: ["hl7.fhir.uv.ips#1.1.0", "hl7.terminology.r4#5.0.0", "hl7.fhir.r4.core#4.0.1"],
  empd: ["tw.gov.mohw.nhi.empd#0.2.1", "tw.gov.mohw.twcore#0.3.2", "hl7.fhir.uv.extensions.r4#5.3.0", "hl7.terminology.r4#7.4.0", "hl7.fhir.r4.core#4.0.1"],
};

interface Case {
  name: string;
  ig: string;
  bundle: string;
  entries: string[];
  minEntries: number;
  /** Counted in the acceptance gate (the four ISSUES_v19 (b) profiles). */
  gate?: boolean;
}
const CASES: Case[] = [
  { name: "TW Core Bundle-twcore", ig: "twcore", bundle: "Bundle-twcore", entries: ["Patient-twcore", "Encounter-twcore", "Condition-twcore", "MedicationRequest-twcore", "Observation-laboratoryResult-twcore"], minEntries: 5 },
  { name: "TWPAS Bundle-twpas", ig: "pas", bundle: "Bundle-twpas", entries: [], minEntries: 8 },
  { name: "TWPAS Bundle-immunologic-agent-twpas", ig: "pas", bundle: "Bundle-immunologic-agent-twpas", entries: [], minEntries: 8 },
  { name: "EMPD Bundle-EMPD", ig: "empd", bundle: "Bundle-EMPD", entries: [], minEntries: 1 },
  { name: "EMPD Bundle-DS", ig: "empd", bundle: "Bundle-DS", entries: [], minEntries: 1 },
  { name: "IPS Bundle-uv-ips", ig: "ips", bundle: "Bundle-uv-ips", entries: ["Patient-uv-ips", "AllergyIntolerance-uv-ips", "Condition-uv-ips", "MedicationStatement-uv-ips", "Medication-uv-ips", "Observation-results-laboratory-uv-ips"], minEntries: 7 },
];

const verbose = process.argv.includes("-v");
// --only <ig>[,<ig>…]: just the cases of those IGs (twcore / pas / ips / empd) — one closure in memory at a time
const onlyAt = process.argv.indexOf("--only");
if (onlyAt > 0) {
  const keep = new Set(String(process.argv[onlyAt + 1] ?? "").split(","));
  for (let i = CASES.length - 1; i >= 0; i--) if (!keep.has(CASES[i].ig)) CASES.splice(i, 1);
}
// --all: also every other Bundle profile of the three IGs, without planned entries (reported, not gated)
if (process.argv.includes("--all")) {
  for (const [ig, spec] of [["twcore", CLOSURES.twcore[0]], ["pas", CLOSURES.pas[0]], ["ips", CLOSURES.ips[0]]] as const) {
    const dir = join(CACHE, spec, "package");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => /^StructureDefinition-.*\.json$/.test(n)).sort()) {
      const sd = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (sd.type !== "Bundle" || sd.derivation !== "constraint" || CASES.some((c) => c.bundle === sd.id)) continue;
      CASES.push({ name: `${ig} ${sd.id} (no planned entries)`, ig, bundle: sd.id, entries: [], minEntries: 0, gate: false });
    }
  }
}
const useExamples = !process.argv.includes("--strict");
const available = (ig: string): boolean => CLOSURES[ig].every((p) => existsSync(join(CACHE, p, "package")));

/** Terminology-class errors (code / display / ValueSet / CodeSystem membership): excluded from the gate. */
export const TERMINOLOGY = /value ?set|ValueSet|code ?system|CodeSystem|Unknown code|Wrong Display|display name|Unable to validate code/i;

const FAKE: Record<string, unknown> = {
  string: "fake text",
  markdown: "fake text",
  code: "fake-code",
  id: "fake1",
  uri: "https://fake-system.test/ns",
  url: "https://fake-system.test/ns",
  canonical: "https://fake-system.test/ns",
  oid: "urn:oid:1.2.3.4",
  uuid: "urn:uuid:9b1d1a8e-4c35-4c53-9d0f-6c7f4f1f2a11",
  date: "2024-05-01",
  dateTime: "2024-05-01T10:00:00+08:00",
  instant: "2024-05-01T10:00:00.000+08:00",
  time: "10:00:00",
  decimal: 1.5,
  integer: 1,
  integer64: "1",
  positiveInt: 1,
  unsignedInt: 1,
  boolean: true,
  base64Binary: "ZmFrZQ==",
  xhtml: '<div xmlns="http://www.w3.org/1999/xhtml">fake text</div>',
  Reference: { display: "fake" },
};

/**
 * A string matching a `format` regex: anchors, literals, [classes], \d / \w, `.`, groups with
 * alternation (the first branch), quantifiers ? * + {n} {n,m} (their minimum, at least 1 for +);
 * null when the sample does not match (a construct it does not know).
 */
export function sampleOf(re: string): string | null {
  const src = re.replace(/^\^/, "").replace(/\$$/, "");
  let i = 0;
  const seq = (): string | null => {
    let out = "";
    while (i < src.length && src[i] !== ")" && src[i] !== "|") {
      let atom: string | null;
      if (src[i] === "(") {
        i++;
        if (src.startsWith("?:", i)) i += 2;
        atom = seq();
        while (src[i] === "|") {
          i++;
          seq();
        }
        if (src[i] !== ")" || atom === null) return null;
        i++;
      } else if (src[i] === "[") {
        const j = src.indexOf("]", i + 1);
        if (j < 0) return null;
        const body = src.slice(i + 1, j);
        atom = body.startsWith("^") ? "A" : body[0] === "\\" ? (body[1] === "d" ? "1" : body[1]) : body[0];
        i = j + 1;
      } else if (src[i] === "\\") {
        const c = src[i + 1];
        atom = c === "d" ? "1" : c === "w" ? "a" : c === "s" ? " " : c;
        i += 2;
      } else if (src[i] === ".") {
        atom = "A";
        i++;
      } else if ("*+?{".includes(src[i])) return null;
      else atom = src[i++];
      let n = 1;
      const q = /^(?:\{(\d+)(?:,\d*)?\}|([?*+]))/.exec(src.slice(i));
      if (q) {
        n = q[1] !== undefined ? Number(q[1]) : q[2] === "+" ? 1 : 0;
        i += q[0].length;
      }
      out += atom.repeat(n);
    }
    return out;
  };
  const out = seq();
  if (out === null) return null;
  try {
    return new RegExp(re).test(out) ? out : null;
  } catch {
    return null;
  }
}

const NUMERIC = new Set(["decimal", "integer", "positiveInt", "unsignedInt"]);

function fakeValue(p: FormPlaceholder): unknown {
  if (p.format && !(Array.isArray(p.allowed) && p.allowed.length)) {
    const s = sampleOf(p.format);
    if (s !== null) return NUMERIC.has(p.type) && s !== "" && !Number.isNaN(Number(s)) ? Math.max(Number(s), 1) : s;
  }
  if (Array.isArray(p.allowed) && p.allowed.length) {
    const a = p.allowed[0];
    if (p.type === "Reference") return { reference: String(a) };
    if (a && typeof a === "object") return (a as R).code;
    return a;
  }
  if (useExamples && p.example !== undefined) return p.example;
  const v = FAKE[p.type] ?? (p.type[0] === p.type[0].toUpperCase() ? {} : "fake");
  // type-correct includes the element's maxLength
  return typeof v === "string" && p.max_length ? v.replace(/[^A-Za-z0-9]/g, "").slice(0, p.max_length) || "1" : v;
}

function setPtr(root: unknown, ptr: string, v: unknown): void {
  const segs = ptr.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const parent = getAt(root, segs.length > 1 ? `/${ptr.slice(1).split("/").slice(0, -1).join("/")}` : "");
  const k = segs[segs.length - 1];
  if (Array.isArray(parent)) parent[Number(k)] = v;
  else (parent as R)[k] = v;
}

function deletePtr(root: unknown, ptr: string): void {
  const segs = ptr.slice(1).split("/");
  const parent = getAt(root, segs.length > 1 ? `/${segs.slice(0, -1).join("/")}` : "");
  const k = segs[segs.length - 1].replace(/~1/g, "/").replace(/~0/g, "~");
  if (Array.isArray(parent)) parent.splice(Number(k), 1);
  else if (parent && typeof parent === "object") delete (parent as R)[k];
}

function stringLeaves(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((x) => stringLeaves(x, out));
  else if (node && typeof node === "object") Object.values(node).forEach((x) => stringLeaves(x, out));
  return out;
}

const depsCache = new Map<string, ReturnType<typeof fileBlueprintDeps>>();
const depsOf = (ig: string): NonNullable<ReturnType<typeof fileBlueprintDeps>> => {
  if (!depsCache.has(ig)) depsCache.set(ig, fileBlueprintDeps(CLOSURES[ig]));
  return depsCache.get(ig)!;
};
/** External terminologies (LOINC / SNOMED CT / ICD-10 / RxNorm) are not in the cache: their codes are accepted as-is. */
const EXTERNAL = new Set(["http://loinc.org", "http://snomed.info/sct", "http://hl7.org/fhir/sid/icd-10-cm", "http://www.nlm.nih.gov/research/umls/rxnorm", "http://hl7.org/fhir/sid/icd-10"]);
class LenientPackages extends FilePackages {
  async checkCode(system: string, code: string, display: string | null): Promise<any> {
    if (EXTERNAL.has(system)) return { status: "ok" };
    return super.checkCode(system, code, display);
  }
}
const pkCache = new Map<string, FilePackages>();
const pkOf = (ig: string): FilePackages => {
  if (!pkCache.has(ig)) pkCache.set(ig, new LenientPackages(CACHE, CLOSURES[ig]));
  return pkCache.get(ig)!;
};

let failed = false;
const rows: R[] = [];
for (const c of CASES) {
  if (!available(c.ig)) {
    console.error(`${c.name}: package closure not in ${CACHE}`);
    process.exit(2);
  }
  const deps = depsOf(c.ig);
  const { data, warnings } = await bundleForm({ bundle_profile: c.bundle, entries: c.entries.map((profile) => ({ profile })), envelope_provenance: { tool: "fhir_get_bundle_form", toolVersion: "1.0.0" } }, deps);
  const bundle = JSON.parse(JSON.stringify(data.bundle)) as R;
  const ph = data.placeholders as FormPlaceholder[];
  const entries = bundle.entry as R[];
  const complete = entries.filter((e) => e.resource && typeof e.resource === "object" && typeof e.resource.resourceType === "string" && Array.isArray(e.resource.meta?.profile) && e.resource.meta.profile.length > 0).length;
  const listed = ph.filter((p) => p.pointer && p.type && p.what && p.value_source).length;
  const resolving = ph.filter((p, i) => {
    const v = getAt(bundle, p.pointer);
    const m = typeof v === "string" ? PLACEHOLDER_TOKEN.exec(v) : null;
    return m !== null && Number(m[1]) === i;
  }).length;
  const leaves = stringLeaves(bundle);
  const tokens = leaves.filter((s) => /^<<P\d+:/.test(s)).length;
  const strayRaw = leaves.filter((s) => /^<[^<>]*>$/.test(s));
  const optionalUnmarked = ph.filter((p) => !p.required && !p.if_empty).length;
  // (v1.1) self-check of the unfilled form + prefilled values taken from IG examples for identity resources / elements
  const selfCheck = formSelfCheck(bundle);
  const prefilledList = ((data.prefilled as R[] | undefined) || []).map((pf) => {
    const m = /^\/entry\/(\d+)\/resource(\/.*)$/.exec(String(pf.pointer));
    const rt = m ? String(entries[Number(m[1])]?.resource?.resourceType) : "Bundle";
    const path = `${rt}.${(m ? m[2] : String(pf.pointer)).split("/").filter((s) => s && !/^\d+$/.test(s)).join(".")}`;
    return { ...pf, rt, path, value: getAt(bundle, String(pf.pointer)) };
  });
  const exampleIdentity = prefilledList.filter((pf) => /example/i.test(String(pf.how)) && !exampleValueAllowed(pf.rt, pf.path, true));
  for (const p of ph) {
    // a value bound to a ValueSet too large to list: its first code (type-correct = a code of the binding)
    if (p.value_set && !(Array.isArray(p.allowed) && p.allowed.length)) {
      const exp = await deps.expandValueSet({} as never, p.value_set, 1).catch(() => null);
      if (exp?.codings.length) {
        setPtr(bundle, p.pointer, String(exp.codings[0].code));
        continue;
      }
    }
    setPtr(bundle, p.pointer, fakeValue(p));
  }
  // a code picked from `allowed`: its system too (the sibling element), when the form left it open
  for (const p of ph) {
    if (!Array.isArray(p.allowed) || !p.allowed.length || typeof p.allowed[0] !== "object" || !p.pointer.endsWith("/code")) continue;
    const sys = (p.allowed[0] as R).system;
    const parent = getAt(bundle, p.pointer.slice(0, -"/code".length)) as R | undefined;
    if (sys && parent && typeof parent === "object" && (parent.system === undefined || /fake/.test(String(parent.system)))) parent.system = sys;
  }
  // (v1.2) required_if: decided by the filled condition values — an element whose rule does not apply is deleted
  const dropped: string[] = [];
  for (let round = 0; round < 3; round++) {
    const del = new Set<string>();
    for (const p of ph) {
      const ri = p.required_if;
      if (!ri || dropped.includes(ri.element)) continue;
      // compact forms list the condition once under data.conditions
      const when = (typeof ri.when === "string" ? (data.conditions as R)[ri.when] : ri.when) as { expression: string; context: string };
      const ctxNode = getAt(bundle, when.context) as R | undefined;
      if (!ctxNode || typeof ctxNode !== "object") continue;
      const r = evaluateConstraint(ctxNode, String(ctxNode.resourceType), when.expression, { resource: ctxNode, rootResource: bundle });
      if (r.status !== "pass") del.add(ri.element);
    }
    if (!del.size) break;
    for (const ptr of [...del].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      if (getAt(bundle, ptr) === undefined) continue;
      deletePtr(bundle, ptr);
      dropped.push(ptr);
    }
    pruneEmptyArrays(bundle);
  }
  const remaining = stringLeaves(bundle).filter((s) => /^<<P\d+:|^<[^<>]*>$/.test(s)).length;
  const pk = pkOf(c.ig);
  const canonical = String((data.bundle_profile as R).canonical);
  const issues = (await new InstanceValidator(pk.resolver()).validate(bundle, { profiles: [canonical] })) as R[];
  const errors = issues.filter((x) => x.severity === "error" || x.severity === "fatal");
  const term = errors.filter((x) => TERMINOLOGY.test(String(x.message)));
  const other = errors.filter((x) => !TERMINOLOGY.test(String(x.message)));
  const row = {
    profile: c.name,
    entries: entries.length,
    min_entries: c.minEntries,
    complete_resources: complete,
    placeholders: ph.length,
    listed_with_type_what_source: listed,
    pointers_resolving: resolving,
    tokens_in_bundle: tokens,
    stray_skeleton_tokens: strayRaw.length,
    unmarked_optional: optionalUnmarked,
    unfilled_after_fill: remaining,
    errors: errors.length,
    terminology_errors: term.length,
    non_terminology_errors: other.length,
    warnings_issues: issues.filter((x) => x.severity === "warning").length,
    response_chars: data.response_chars,
    form_warnings: warnings.length,
    self_check_problems: selfCheck.length,
    prefilled: prefilledList.length,
    prefilled_example_identity: exampleIdentity.length,
    choose_one: ph.filter((p) => p.choose_one).length,
    required_if: ph.filter((p) => p.required_if).length,
    required_if_dropped: dropped.length,
    format: ph.filter((p) => p.format).length,
    raw_rules: ph.filter((p) => (p.rules || []).length).length,
  };
  const pass =
    entries.length >= c.minEntries &&
    complete === entries.length &&
    listed === ph.length &&
    resolving === ph.length &&
    tokens === ph.length &&
    strayRaw.length === 0 &&
    optionalUnmarked === 0 &&
    remaining === 0 &&
    other.length === 0 &&
    selfCheck.length === 0 &&
    exampleIdentity.length === 0;
  if (!pass && c.gate !== false) failed = true;
  rows.push({ ...row, pass });
  if (verbose) {
    for (const pf of prefilledList) console.log(`  [${c.bundle}] prefilled ${pf.pointer} = ${JSON.stringify(pf.value).slice(0, 120)} (${pf.value_source}: ${pf.how})`);
    for (const s of selfCheck) console.log(`  [${c.bundle}] self-check: ${s}`);
    for (const x of other) console.log(`  [${c.bundle}] ERROR ${x.path}: ${String(x.message).slice(0, 220)}`);
    for (const x of term) console.log(`  [${c.bundle}] term  ${x.path}: ${String(x.message).slice(0, 160)}`);
    for (const w of warnings) console.log(`  [${c.bundle}] form warning: ${w}`);
    if (strayRaw.length) console.log(`  [${c.bundle}] stray: ${strayRaw.slice(0, 8).join(", ")}`);
  }
}
console.log(JSON.stringify(rows, null, 1));
process.exit(failed ? 1 : 0);
