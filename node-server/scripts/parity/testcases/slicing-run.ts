/**
 * Offline fhir-test-cases runner limited to the slicing / profile-match area (parity v3).
 *
 * Picks the R4 (version 4.0 / 4.0.1) cases of ~/ref/fhir-test-cases/validator/manifest.json whose
 * official Java outcome (outcomes/java/*.json) carries a slicing / profile-match message, runs the
 * in-process validator over them (packages from the local FHIR caches, supporting files from the
 * test-case dir, XML read by ./fhirXml.ts, differential-only profiles completed by ./snapshotGen.ts)
 * and compares the slicing-class messages (severity + class + subject) with the official ones.
 *
 *   node --import tsx scripts/parity/testcases/slicing-run.ts [--case name] [-v] [--json out.json]
 *
 * No DB, no network. A general manifest runner is built separately; this one stays small.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InstanceValidator, type CodeCheck, type ValidatorResolver } from "../../../src/fhirValidator.js";
import { composeContains, findConcept, indexCodeSystem, type CodeSystemIndex, type TerminologyDeps } from "../../../src/fhirCodeSystem.js";
import { parseXml, XmlToJson } from "./fhirXmlSlicing.js";
import { SnapshotGenerator } from "./snapshotGen.js";

type Json = Record<string, any>;
const TC = process.env.FHIR_TEST_CASES || join(homedir(), "ref", "fhir-test-cases", "validator");
const CACHES = [join(homedir(), "tools", "validator-cli", "fhircache", "packages"), join(homedir(), ".fhir", "packages")];
const BASE_PACKAGES = ["hl7.fhir.r4.core#4.0.1", "hl7.terminology.r4#7.0.0", "hl7.fhir.uv.extensions.r4#5.2.0"];

const args = process.argv.slice(2);
const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
const verbose = args.includes("-v");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

// ----------------------------------------------------------------------------- packages

function pkgDir(spec: string): string | null {
  for (const c of CACHES) {
    const d = join(c, spec, "package");
    if (existsSync(join(d, "package.json"))) return d;
  }
  return null;
}

class Store {
  byUrl = new Map<string, Json>();
  add(r: Json, override = false): void {
    if (!r || typeof r.resourceType !== "string") return;
    if (typeof r.url === "string" && (override || !this.byUrl.has(r.url))) this.byUrl.set(r.url, r);
  }
  loadPackage(spec: string): boolean {
    const d = pkgDir(spec);
    if (!d) return false;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json") || f === "package.json" || f.startsWith(".")) continue;
      try {
        const r = JSON.parse(readFileSync(join(d, f), "utf8"));
        if (["StructureDefinition", "ValueSet", "CodeSystem"].includes(r.resourceType)) this.add(r);
      } catch {
        /* skip */
      }
    }
    return true;
  }
  child(): Store {
    const s = new Store();
    s.byUrl = new Map(this.byUrl);
    return s;
  }
}

const core = new Store();
for (const p of BASE_PACKAGES) if (!core.loadPackage(p)) console.error(`missing package ${p}`);

function readResource(file: string, store: Store): Json | null {
  const p = join(TC, file);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  if (file.endsWith(".json")) return JSON.parse(text.replace(/^﻿/, ""));
  if (file.endsWith(".xml")) {
    const conv = new XmlToJson((type) => store.byUrl.get(`http://hl7.org/fhir/StructureDefinition/${type}`) ?? null);
    return conv.resource(parseXml(text));
  }
  return null;
}

// ----------------------------------------------------------------------------- resolver

class FileResolver implements ValidatorResolver {
  private gen: SnapshotGenerator;
  private csIdx = new Map<string, CodeSystemIndex | null>();
  private deps: TerminologyDeps;
  constructor(private readonly store: Store) {
    this.gen = new SnapshotGenerator((url) => this.store.byUrl.get(url.split("|")[0]) ?? null);
    this.deps = {
      loadValueSet: async (url) => {
        const r = this.store.byUrl.get(url.split("|")[0]);
        return r?.resourceType === "ValueSet" ? r : null;
      },
      loadCodeSystem: async (url) => this.cs(url),
      lookupExternal: async () => null,
      externalSystemHeld: async () => false,
    };
  }
  private cs(url: string): CodeSystemIndex | null {
    const key = url.split("|")[0];
    if (!this.csIdx.has(key)) {
      const r = this.store.byUrl.get(key);
      this.csIdx.set(key, r?.resourceType === "CodeSystem" && r.content !== "not-present" ? indexCodeSystem(r) : null);
    }
    return this.csIdx.get(key) ?? null;
  }
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    const r = this.store.byUrl.get(url.split("|")[0]);
    if (!r || r.resourceType !== "StructureDefinition") return null;
    return this.gen.ensure(r);
  }
  async fetchValueSet(url: string): Promise<Json | null> {
    const r = this.store.byUrl.get(url.split("|")[0]);
    return r?.resourceType === "ValueSet" ? r : null;
  }
  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    const vs = await this.fetchValueSet(url);
    if (!vs) return undefined;
    return composeContains(vs.compose || {}, system, code, this.deps, 0, new Set(), vs.expansion);
  }
  async checkCode(system: string, code: string): Promise<CodeCheck> {
    const idx = this.cs(system);
    if (!idx) return { status: "silent" };
    return findConcept(idx, code) ? { status: "ok" } : { status: "silent" };
  }
  async definitionExists(url: string): Promise<boolean> {
    return this.store.byUrl.has(url.split("|")[0]);
  }
}

// ----------------------------------------------------------------------------- classification

const SLICE_RX = /slice|slicing|discriminator|profile match|matching profiles|match for the specified profile/i;

/** Slicing-area message class + subject (slice name / reference) for comparison. */
export function sliceClass(msg: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = msg.match(/^Slice '([^']+)'(?: for extension '[^']*')?: (?:a matching slice is required|minimum required)/))) return `MIN_SLICE ${m[1]}`;
  if ((m = msg.match(/^([^ ]+:[^ ]+): max allowed = \d+, but found \d+/))) return `MAX_SLICE ${m[1]}`;
  if (/does not match any known slice.*slicing is CLOSED/s.test(msg)) return "NOT_SLICE_CLOSED";
  if (/does not match any known slice/.test(msg)) return "NOT_SLICE";
  if ((m = msg.match(/Element matches more than one slice - (.*)$/))) return `MATCH_MULTIPLE ${m[1].trim()}`;
  if (/Unable to find a match for the specified profile among choices/.test(msg)) return "PROFILE_NOMATCH";
  if (/Found multiple matching profiles among/.test(msg)) return "PROFILE_MULTIPLE";
  if ((m = msg.match(/Unable to find a profile match for (\S+)/))) return `REF_CANTMATCH ${m[1]}`;
  if ((m = msg.match(/Found multiple matching profiles for (\S+)/))) return `REF_MULTIPLE ${m[1]}`;
  if (/out of order in ordered slice/.test(msg)) return "SLICE_ORDER";
  if (SLICE_RX.test(msg)) return "OTHER_SLICING";
  return null;
}

interface Row {
  run: string;
  official: string[];
  ours: string[];
  officialInfo: string[];
  oursInfo: string[];
  officialErrors: number;
  ourErrors: number;
  ok: boolean;
  infoOk: boolean;
  skipped?: string;
}

function keyed(issues: Array<{ severity: string; message: string }>, info: boolean): string[] {
  const out: string[] = [];
  for (const i of issues) {
    const sev = i.severity === "fatal" ? "error" : i.severity;
    if (info ? sev !== "information" : sev !== "error" && sev !== "warning") continue;
    const c = sliceClass(i.message);
    if (c) out.push(`${sev} ${c}`);
  }
  return out.sort();
}

const eq = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// ----------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(TC, "manifest.json"), "utf8"));
  const rows: Row[] = [];
  for (const c of manifest["test-cases"] as Json[]) {
    if (c.version !== "4.0" && c.version !== "4.0.1") continue;
    if (only && c.name !== only) continue;
    const runs: Array<[string, string, string | null, string[]]> = [];
    if (typeof c.java === "string") runs.push(["base", c.java, null, []]);
    if (c.profile && typeof c.profile.java === "string") runs.push(["profile", c.profile.java, c.profile.source, c.profile.supporting || []]);
    for (const [kind, java, profileSrc, profSupporting] of runs) {
      const p = join(TC, "outcomes", java);
      if (!existsSync(p)) continue;
      const oo = JSON.parse(readFileSync(p, "utf8"));
      const officialIssues = (oo.issue || []).map((i: Json) => ({ severity: i.severity, message: i.details?.text ?? "" }));
      if (!officialIssues.some((i: Json) => SLICE_RX.test(i.message))) continue;
      const name = `${c.name}:${kind}`;
      const row: Row = {
        run: name,
        official: keyed(officialIssues, false),
        officialInfo: keyed(officialIssues, true),
        ours: [],
        oursInfo: [],
        officialErrors: officialIssues.filter((i: Json) => i.severity === "error" || i.severity === "fatal").length,
        ourErrors: 0,
        ok: false,
        infoOk: false,
      };
      rows.push(row);
      try {
        if (c.module === "sd") throw new Error("SKIP StructureDefinition validation (not instance slicing)");
        const store = core.child();
        for (const pk of c.packages || []) if (!store.loadPackage(pk)) throw new Error(`SKIP package ${pk} not cached`);
        const files: string[] = [...(c.supporting || []), ...(c.profiles || []), ...profSupporting, ...(profileSrc && !profileSrc.startsWith("http") ? [profileSrc] : [])];
        for (const f of files) {
          const r = readResource(f, store);
          if (r) store.add(r, true);
        }
        const res = readResource(c.file, store);
        if (!res) throw new Error(`SKIP instance format ${c.file}`);
        let profileUrl: string | null = null;
        if (profileSrc) {
          profileUrl = profileSrc.startsWith("http") ? profileSrc : (readResource(profileSrc, store)?.url ?? null);
          if (!profileUrl) throw new Error("SKIP profile unreadable");
        }
        const v = new InstanceValidator(new FileResolver(store));
        const issues = await v.validate(res, profileUrl ? { profiles: [profileUrl] } : {});
        row.ours = keyed(issues, false);
        row.oursInfo = keyed(issues, true);
        row.ourErrors = issues.filter((i) => i.severity === "error" || i.severity === "fatal").length;
        row.ok = eq(row.ours, row.official);
        row.infoOk = eq(row.oursInfo, row.officialInfo);
        if (verbose) {
          console.log(`== ${name} ${row.ok ? "OK" : "DIFF"}`);
          for (const i of issues) if (i.severity !== "information" || sliceClass(i.message)) console.log(`   ours ${i.severity} ${i.path} ${i.message.slice(0, 220)}`);
          for (const i of officialIssues) console.log(`   java ${i.severity} ${i.message.slice(0, 220)}`);
        }
      } catch (e) {
        const msg = (e as Error).message;
        row.skipped = msg.startsWith("SKIP") ? msg.slice(5) : `ERROR ${msg}`;
        if (verbose) console.log(`== ${name} ${row.skipped}`);
      }
    }
  }
  const ran = rows.filter((r) => !r.skipped);
  for (const r of rows) {
    const tag = r.skipped ? "skip" : r.ok ? "ok  " : "DIFF";
    console.log(`${tag} ${r.run}${r.skipped ? ` (${r.skipped})` : ""}${!r.skipped && !r.ok ? `\n       java: ${r.official.join(" | ")}\n       ours: ${r.ours.join(" | ")}` : ""}`);
  }
  const ok = ran.filter((r) => r.ok).length;
  const info = ran.filter((r) => r.infoOk).length;
  const allErr = ran.filter((r) => r.ok && r.ourErrors === r.officialErrors).length;
  console.log(`\nruns with slicing messages: ${rows.length}; runnable: ${ran.length}; slicing error/warning set reproduced: ${ok}/${ran.length}; information set reproduced: ${info}/${ran.length}; also same total error count: ${allErr}/${ran.length}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
