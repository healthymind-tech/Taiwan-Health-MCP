/**
 * Output-size survey for fhir_get_profile_required_elements: every StructureDefinition
 * (resource / complex-type constraint) of TW Core 1.0.0 and PAS 1.2.7, compact vs full.
 *
 *   DATABASE_URL=postgresql://... node --import tsx scripts/validator-audit/requiredElementsSizes.ts out.json
 */
import { writeFileSync } from "node:fs";
import { initPool, closePool, query } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";

const PKGS: Array<[string, string]> = [
  ["tw.gov.mohw.twcore", "1.0.0"],
  ["tw.gov.mohw.nhi.pas", "1.2.7"],
];

async function main(): Promise<void> {
  initPool({ maxSize: 4 });
  const svc = new FHIRIGService(null);
  const out: any[] = [];
  for (const [pid, ver] of PKGS) {
    const r = await query<any>(
      `SELECT artifact_id, kind, raw_json->>'type' AS type FROM fhir.artifacts
       WHERE package_id=$1 AND package_version=$2 AND resource_type='StructureDefinition'
         AND derivation='constraint' ORDER BY artifact_id`,
      [pid, ver],
    );
    for (const a of r.rows) {
      const c = await svc.getProfileRequiredElements(a.artifact_id, pid, ver, null, true, false, "compact");
      const f = await svc.getProfileRequiredElements(a.artifact_id, pid, ver, null, true, false, "full");
      const ce = JSON.parse(c);
      out.push({
        pkg: pid,
        profile: a.artifact_id,
        kind: a.kind,
        type: a.type,
        ok: ce.ok,
        error: ce.error?.message,
        rows: ce.data?.count,
        compactRows: ce.data?.elements?.length,
        invariants: ce.data?.invariants?.length ?? 0,
        compact: c.length,
        full: f.length,
      });
    }
  }
  writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
