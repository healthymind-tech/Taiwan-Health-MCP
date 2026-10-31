/**
 * ISSUES_v17.3 — the IG known-defects list (profiles whose own examples fail validation) of installed packages,
 * computed exactly as the ig_selfcheck job does (igKnownDefects.ts), printed as JSON. Read-only unless --store.
 *
 *   DATABASE_URL=… node --import tsx scripts/ig-selfcheck/knownDefects.ts <package#version> [...] [--store] [--all]
 *
 * --all also lists defects that only some examples have (default: known_invalid ones only).
 */
import { closePool, initPool } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import { dbSelfcheckDeps, runSelfcheck, storeKnownDefects } from "../../src/igKnownDefects.js";

const args = process.argv.slice(2);
const pkgs = args.filter((a) => !a.startsWith("--")).map((a) => a.split("#") as [string, string]);

async function main(): Promise<void> {
  initPool({ maxSize: 2 });
  const svc = new FHIRIGService(null);
  svc.annotateKnownDefects = false;
  const out: unknown[] = [];
  for (const [pid, ver] of pkgs) {
    const t0 = Date.now();
    const run = await runSelfcheck(dbSelfcheckDeps(svc, pid, ver));
    if (args.includes("--store")) await storeKnownDefects(pid, ver, run.defects, run.examplesTotal, run.examplesValid);
    out.push({
      package: `${pid}#${ver}`,
      examples: run.examplesTotal,
      valid: run.examplesValid,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      defects: run.defects.filter((d) => args.includes("--all") || d.knownInvalid),
    });
  }
  console.log(JSON.stringify(out, null, 2));
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
