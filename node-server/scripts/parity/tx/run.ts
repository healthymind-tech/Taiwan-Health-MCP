/**
 * Terminology parity (parity v3): runs the official HL7 terminology-ecosystem test cases
 * (github.com/HL7/fhir-tx-ecosystem-ig, `tests/test-cases.json` — formerly fhir-test-cases/tx) through
 * the validator's terminology layer and compares with the expected tx.fhir.org answers.
 *
 * Only the operations the validator relies on are run:
 *   - validate-code (ValueSet) / cs-validate-code (CodeSystem): `result` + the set of issue message ids
 *   - expand: the set of (system, code) in the expansion (paging / designation / property params ignored)
 * Each suite's setup resources (and request `tx-resource`s) are the only terminology (in memory, no DB),
 * so suites in mode loinc / snomed / icd-11 / … (which need the server's full editions) are reported as
 * "external" unless --db is given (then LOINC / SNOMED / ICD codes are answered from DATABASE_URL, read-only).
 *
 * The adapter composes the same pieces the InstanceValidator uses (fhirCodeSystem valueSetContains /
 * expandComposeWith, fhirValidationResolver judgeHeldCodeSystem / txValidateCode when present).
 *
 *   node --import tsx scripts/parity/tx/run.ts <fhir-tx-ecosystem-ig/tests> [--json out.json] [-v] [--suite name] [--db]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { indexCodeSystem, type CodeSystemIndex, type TerminologyDeps } from "../../../src/fhirCodeSystem.js";
import { txValidateCode, txExpand, type TxValidateRequest, type TxIssue } from "../../../src/fhirTxValidate.js";

type Json = Record<string, any>;
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("-") && !/^\S+\.json$/u.test(a)) ?? "";
const out = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const verbose = args.includes("-v");
const onlySuite = args.includes("--suite") ? args[args.indexOf("--suite") + 1] : null;
const onlyTest = args.includes("--test") ? args[args.indexOf("--test") + 1] : null;

const readJson = (p: string): Json => JSON.parse(readFileSync(join(dir, p), "utf8"));

/** In-memory terminology store: every version of each CodeSystem / ValueSet. */
class Store {
  cs = new Map<string, Json[]>();
  vs = new Map<string, Json[]>();
  add(r: Json): void {
    if (!r || typeof r !== "object") return;
    if (r.resourceType === "Bundle") for (const e of r.entry ?? []) this.add(e.resource);
    const m = r.resourceType === "CodeSystem" ? this.cs : r.resourceType === "ValueSet" ? this.vs : null;
    if (!m || typeof r.url !== "string") return;
    const list = m.get(r.url) ?? [];
    list.push(r);
    m.set(r.url, list);
  }
  clone(): Store {
    const s = new Store();
    for (const [k, v] of this.cs) s.cs.set(k, [...v]);
    for (const [k, v] of this.vs) s.vs.set(k, [...v]);
    return s;
  }
}

function pick(list: Json[] | undefined, version: string | null): Json | null {
  if (!list || !list.length) return null;
  if (version !== null) {
    const exact = list.find((r) => r.version === version);
    if (exact) return exact;
    // FHIR version wildcards (1.x, 1.0.x)
    if (/x/u.test(version)) {
      const re = new RegExp("^" + version.replace(/\./gu, "\\.").replace(/x/gu, "[^.]+") + "(\\..*)?$", "u");
      const hits = list.filter((r) => typeof r.version === "string" && re.test(r.version));
      if (hits.length) return latest(hits);
    }
    return null;
  }
  return latest(list);
}

function latest(list: Json[]): Json {
  return [...list].sort((a, b) => cmpVer(String(b.version ?? ""), String(a.version ?? "")))[0];
}

function cmpVer(a: string, b: string): number {
  const pa = a.split(/[.-]/u);
  const pb = b.split(/[.-]/u);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    const c = !Number.isNaN(nx) && !Number.isNaN(ny) && x !== "" && y !== "" ? nx - ny : x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}

function depsFor(store: Store): TerminologyDeps & { codeSystemVersions(url: string): string[]; loadValueSetVersions(url: string): Json[]; supplementsOf(system: string): Promise<Json[]> } {
  const idxCache = new Map<Json, CodeSystemIndex>();
  const index = (r: Json | null): CodeSystemIndex | null => {
    if (!r) return null;
    let i = idxCache.get(r);
    if (!i) {
      i = indexCodeSystem(r);
      (i as any).raw = r;
      idxCache.set(r, i);
    }
    return i;
  };
  const split = (u: string): [string, string | null] => {
    const k = u.indexOf("|");
    return k < 0 ? [u, null] : [u.slice(0, k), u.slice(k + 1)];
  };
  return {
    async loadValueSet(url: string) {
      const [u, v] = split(url);
      return pick(store.vs.get(u), v);
    },
    async loadCodeSystem(url: string) {
      const [u, v] = split(url);
      return index(pick(store.cs.get(u), v));
    },
    async lookupExternal() {
      return null;
    },
    async externalSystemHeld() {
      return false;
    },
    async supplementsOf(system: string) {
      const out: Json[] = [];
      for (const list of store.cs.values()) {
        const r = latest(list);
        if (r && r.content === "supplement" && typeof r.supplements === "string" && split(r.supplements)[0] === system) out.push(r);
      }
      return out;
    },
    codeSystemVersions(url: string) {
      return (store.cs.get(url) ?? []).map((r) => r.version).filter((v): v is string => typeof v === "string");
    },
    loadValueSetVersions(url: string) {
      return store.vs.get(url) ?? [];
    },
  };
}

// ------------------------------------------------------------------ expected side

interface ExpIssue {
  severity: string;
  type: string | null;
  id: string | null;
  optional: boolean;
}

function expectedIssues(resp: Json): ExpIssue[] {
  const oo = resp.resourceType === "OperationOutcome" ? resp : (resp.parameter ?? []).find((p: Json) => p.name === "issues")?.resource;
  return ((oo?.issue ?? []) as Json[]).map((i) => ({
    severity: i.severity,
    type: (i.details?.coding ?? []).find((c: Json) => String(c.system).endsWith("tx-issue-type"))?.code ?? null,
    id: (i.extension ?? []).find((e: Json) => String(e.url).endsWith("operationoutcome-message-id"))?.valueString ?? null,
    optional: i.$optional$ === true,
  }));
}

/** Normalise an expected message id ($choice:A|B$ → first; $$ → null). */
function normId(id: string | null): string[] {
  if (!id || id === "$$") return [];
  const m = /^\$choice:(.*)\$$/u.exec(id);
  return m ? m[1].split("|") : [id];
}

function paramsToRequest(req: Json, op: string): TxValidateRequest {
  const r: TxValidateRequest = { mode: op === "cs-validate-code" ? "codesystem" : "valueset", params: {} };
  for (const p of req.parameter ?? []) {
    const v = Object.entries(p).find(([k]) => k.startsWith("value"))?.[1] ?? p.resource;
    if (p.name === "tx-resource") continue;
    if (p.name === "coding") r.coding = v;
    else if (p.name === "codeableConcept") r.codeableConcept = v;
    else if (p.name === "valueSet") r.valueSet = v;
    else if (p.name === "url") r.url = String(v);
    else if (p.name === "code") r.code = String(v);
    else if (p.name === "system") r.system = String(v);
    else if (p.name === "version") r.version = String(v);
    else if (p.name === "display") r.display = String(v);
    else if (p.name === "valueSetVersion") r.valueSetVersion = String(v);
    else if (p.name === "systemVersion") r.version = String(v);
    else if (p.name === "system-version" || p.name === "check-system-version" || p.name === "force-system-version") {
      (r.systemVersions ??= []).push({ kind: p.name, value: String(v) });
    } else r.params[p.name] = v;
  }
  return r;
}

// ------------------------------------------------------------------ main

interface Row {
  suite: string;
  test: string;
  op: string;
  status: "pass" | "fail" | "unknown" | "skip";
  verdictOk?: boolean;
  idsOk?: boolean;
  detail?: string;
}

async function main(): Promise<void> {
  const tc = readJson("test-cases.json");
  const rows: Row[] = [];
  const emitted = new Map<string, number>();
  const expectedIds = new Map<string, number>();
  const missingIds = new Map<string, number>();
  const extraIds = new Map<string, number>();
  for (const suite of tc.suites as Json[]) {
    if (onlySuite && suite.name !== onlySuite) continue;
    const base = new Store();
    for (const f of suite.setup ?? []) if (existsSync(join(dir, f))) base.add(readJson(f));
    const external = suite.mode && suite.mode !== "general";
    for (const t of suite.tests as Json[]) {
      if (onlyTest && t.name !== onlyTest) continue;
      const op = t.operation;
      if (!["validate-code", "cs-validate-code", "expand"].includes(op)) {
        rows.push({ suite: suite.name, test: t.name, op, status: "skip", detail: "operation not used by the validator" });
        continue;
      }
      if (external) {
        rows.push({ suite: suite.name, test: t.name, op, status: "skip", detail: `mode ${suite.mode}: needs the server's edition` });
        continue;
      }
      const req = readJson(t.request);
      const resp = readJson(t.response);
      // the test's expansion profile (version rules …) is part of the request
      if (t.profile) req.parameter = [...(req.parameter ?? []), ...(readJson(t.profile).parameter ?? [])];
      if (op === "expand" && (req.parameter ?? []).some((p: Json) => p.name === "filter")) {
        rows.push({ suite: suite.name, test: t.name, op, status: "skip", detail: "text filter (not used by the validator)" });
        continue;
      }
      const store = base.clone();
      for (const p of req.parameter ?? []) if (p.name === "tx-resource" && p.resource) store.add(p.resource);
      const deps = depsFor(store);
      try {
        if (op === "expand") {
          rows.push(await runExpand(suite.name, t, req, resp, deps));
          continue;
        }
        const vreq = paramsToRequest(req, op);
        // test-level request settings: the Accept-Language header, lenient-display-validation
        if (typeof t["Accept-Language"] === "string") vreq.params.acceptLanguage = t["Accept-Language"];
        if (t["lenient-display"] === true) vreq.params["lenient-display-validation"] = true;
        const ours = await txValidateCode(vreq, deps);
        const expOutcome = resp.resourceType === "OperationOutcome";
        const expResult = expOutcome ? null : ((resp.parameter ?? []).find((p: Json) => p.name === "result")?.valueBoolean ?? null);
        const exp = expectedIssues(resp);
        const req2 = exp.filter((i) => !i.optional);
        const expSet = new Set<string>(req2.flatMap((i) => normId(i.id).slice(0, 1).length ? [normId(i.id).join("|")] : [`type:${i.severity}:${i.type}`]));
        const ourIds = (ours.issues as TxIssue[]).map((i) => i.id);
        for (const id of ourIds) emitted.set(id, (emitted.get(id) ?? 0) + 1);
        for (const i of exp) for (const id of normId(i.id)) expectedIds.set(id, (expectedIds.get(id) ?? 0) + 1);
        const ourSet = new Set<string>(ourIds);
        const optionalIds = new Set(exp.filter((i) => i.optional).flatMap((i) => normId(i.id)));
        const miss = [...expSet].filter((e) => {
          if (e.startsWith("type:")) {
            const [, sev, type] = e.split(":");
            return !(ours.issues as TxIssue[]).some((i) => i.severity === sev && i.type === type);
          }
          return !e.split("|").some((x) => ourSet.has(x));
        });
        const allExp = new Set([...expSet].flatMap((e) => e.split("|")));
        const extra = [...ourSet].filter((x) => !allExp.has(x) && !optionalIds.has(x));
        for (const m of miss) missingIds.set(m, (missingIds.get(m) ?? 0) + 1);
        for (const m of extra) extraIds.set(m, (extraIds.get(m) ?? 0) + 1);
        let status: Row["status"];
        let verdictOk: boolean;
        if (expOutcome) verdictOk = ours.outcome === "error";
        else verdictOk = ours.result === expResult;
        if (ours.result === undefined && ours.outcome !== "error") status = "unknown";
        else status = verdictOk && !miss.length && !extra.length ? "pass" : "fail";
        rows.push({
          suite: suite.name,
          test: t.name,
          op,
          status,
          verdictOk,
          idsOk: !miss.length && !extra.length,
          detail: `exp result=${expOutcome ? "OUTCOME" : expResult} ours=${ours.outcome === "error" ? "OUTCOME" : ours.result}; missing ${JSON.stringify(miss)} extra ${JSON.stringify(extra)}`,
        });
      } catch (e) {
        rows.push({ suite: suite.name, test: t.name, op, status: "fail", detail: `exception ${(e as Error).message}` });
      }
    }
  }
  // ---- report
  const bySuite = new Map<string, Row[]>();
  for (const r of rows) bySuite.set(r.suite, [...(bySuite.get(r.suite) ?? []), r]);
  const tot = { pass: 0, fail: 0, unknown: 0, skip: 0, verdict: 0, run: 0 };
  console.log("suite | run | pass | fail | cannot-validate | verdict-ok | skipped");
  for (const [s, rs] of bySuite) {
    const run = rs.filter((r) => r.status !== "skip");
    const c = (st: string): number => rs.filter((r) => r.status === st).length;
    const v = run.filter((r) => r.verdictOk).length;
    tot.pass += c("pass");
    tot.fail += c("fail");
    tot.unknown += c("unknown");
    tot.skip += c("skip");
    tot.verdict += v;
    tot.run += run.length;
    console.log(`${s} | ${run.length} | ${c("pass")} | ${c("fail")} | ${c("unknown")} | ${v} | ${c("skip")}`);
  }
  console.log(`TOTAL | ${tot.run} | ${tot.pass} | ${tot.fail} | ${tot.unknown} | ${tot.verdict} | ${tot.skip}`);
  const sortT = (m: Map<string, number>): string => JSON.stringify([...m].sort((a, b) => b[1] - a[1]));
  console.log("missing ids:", sortT(missingIds));
  console.log("extra ids:", sortT(extraIds));
  console.log("emitted ids:", sortT(emitted));
  console.log("expected ids:", sortT(expectedIds));
  if (verbose) for (const r of rows) if (r.status === "fail" || r.status === "unknown") console.log(`${r.status.toUpperCase()} ${r.suite}/${r.test} [${r.op}] ${r.detail}`);
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
}

async function runExpand(suite: string, t: Json, req: Json, resp: Json, deps: ReturnType<typeof depsFor>): Promise<Row> {
  const params: Json = {};
  let vs: Json | null = null;
  let url: string | null = null;
  for (const p of req.parameter ?? []) {
    const v = Object.entries(p).find(([k]) => k.startsWith("value"))?.[1] ?? p.resource;
    if (p.name === "valueSet") vs = v;
    else if (p.name === "url") url = String(v);
    else if (p.name !== "tx-resource") (params[p.name] ??= []).push(v);
  }
  const ours = await txExpand({ url, valueSet: vs, params }, deps);
  const expErr = resp.resourceType === "OperationOutcome";
  const flat = (list: Json[] | undefined, acc: string[] = []): string[] => {
    for (const c of list ?? []) {
      if (c.code !== undefined) acc.push(`${c.system}|${c.code}`);
      flat(c.contains, acc);
    }
    return acc;
  };
  if (ours.error && ours.cannotValidate) return { suite, test: t.name, op: "expand", status: "unknown", verdictOk: false, detail: ours.error };
  if (expErr || ours.error) {
    const ok = expErr && !!ours.error;
    return { suite, test: t.name, op: "expand", status: ok ? "pass" : "fail", verdictOk: ok, detail: `expected ${expErr ? "error" : "expansion"}, ours ${ours.error ?? "expansion"}` };
  }
  const paged = params.count || params.offset;
  const want = new Set(flat(resp.expansion?.contains));
  const got = new Set(flat(ours.contains));
  const miss = [...want].filter((x) => !got.has(x));
  const extra = paged ? [] : [...got].filter((x) => !want.has(x));
  const ok = !miss.length && !extra.length;
  return { suite, test: t.name, op: "expand", status: ok ? "pass" : "fail", verdictOk: ok, detail: `missing ${JSON.stringify(miss.slice(0, 5))} (${miss.length}) extra ${JSON.stringify(extra.slice(0, 5))} (${extra.length})` };
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
