/**
 * Parity regression (parity v1): every repro Bundle (<dir>/<name>.bundle.json + .compare.json with the official
 * validator_cli errors) is validated with fhir_validate_bundle (in process, DB from DATABASE_URL, read-only); per
 * Bundle the SET of error classes must equal the official one. The repro set is private evaluator data
 * (mcp_proposal/, untracked) — never commit it.
 *
 *   DATABASE_URL=… node --import tsx scripts/parity/run.ts <repro dir> [--json out.json] [-v]
 * Exit 1 when any Bundle misses an official class.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closePool, initPool } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import { errorClass, isContentCheck } from "./classify.js";

type Json = Record<string, any>;
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("-"))!;
const out = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const verbose = args.includes("-v");
const pkgFor = (name: string, b: Json): [string, string] => {
  const p = JSON.stringify(b.meta?.profile ?? []);
  if (name.startsWith("ipsx") || p.includes("/uv/ips/")) return ["hl7.fhir.uv.ips", "1.1.0"];
  if (name.startsWith("pasx") || p.includes("nhicore.nhi.gov.tw/pas")) return ["tw.gov.mohw.nhi.pas", "1.2.7"];
  return ["tw.gov.mohw.twcore", "1.0.0"];
};

async function main(): Promise<void> {
  initPool({ maxSize: 2 });
  const svc = new FHIRIGService(null);
  const names = readdirSync(dir).filter((f) => f.endsWith(".bundle.json")).map((f) => f.replace(/\.bundle\.json$/u, "")).sort();
  const rows: Json[] = [];
  const missTally = new Map<string, number>();
  const extraTally = new Map<string, number>();
  for (const n of names) {
    const bundle = JSON.parse(readFileSync(join(dir, `${n}.bundle.json`), "utf8"));
    const cmp = JSON.parse(readFileSync(join(dir, `${n}.compare.json`), "utf8"));
    const official = new Set<string>((cmp.official_errors as Json[]).filter((i) => i.severity === "error" || i.severity === "fatal").map((i) => errorClass(i.message)));
    const [pid, ver] = pkgFor(n, bundle);
    // the evaluator runs validator_cli with -profile <the conversion target's Bundle profile>: the one its errors name
    const named = (cmp.official_errors as Json[]).map((i) => /(https?:\/\/\S+\/StructureDefinition\/Bundle-[A-Za-z0-9-]+)/u.exec(i.message)?.[1]).find(Boolean);
    const bundleProfile = named ?? (pid === "hl7.fhir.uv.ips" ? "http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips" : pid === "tw.gov.mohw.nhi.pas" ? "https://nhicore.nhi.gov.tw/pas/StructureDefinition/Bundle-twpas" : null);
    const env = JSON.parse(await svc.validateBundle(bundle, pid, ver, false, undefined, "ids", null, bundleProfile));
    const issues: Json[] = [...(env.data?.issues ?? []), ...((env.data?.entries ?? []) as Json[]).flatMap((e) => e.issues ?? [])];
    const ours = new Set<string>(issues.filter((i) => (i.severity === "error" || i.severity === "fatal") && !isContentCheck(i)).map((i) => errorClass(i.message)));
    const missing = [...official].filter((c) => !ours.has(c));
    const extra = [...ours].filter((c) => !official.has(c));
    for (const c of missing) missTally.set(c, (missTally.get(c) ?? 0) + 1);
    for (const c of extra) extraTally.set(c, (extraTally.get(c) ?? 0) + 1);
    rows.push({ name: n, missing, extra, ok: !missing.length && !extra.length });
    if (verbose && (missing.length || extra.length)) console.log(`${n}: missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`);
  }
  const ok = rows.filter((r) => r.ok).length;
  const miss = rows.filter((r) => r.missing.length).length;
  const ext = rows.filter((r) => r.extra.length).length;
  console.log(`parity: ${ok}/${rows.length} Bundles agree (${((100 * ok) / rows.length).toFixed(1)}%); missing classes in ${miss}, extra classes in ${ext}`);
  console.log("missing:", JSON.stringify([...missTally].sort((a, b) => b[1] - a[1])));
  console.log("extra:", JSON.stringify([...extraTally].sort((a, b) => b[1] - a[1])));
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
  await closePool();
  process.exit(miss ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
