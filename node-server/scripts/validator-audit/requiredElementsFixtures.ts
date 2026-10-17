/**
 * Regenerates mcp_proposal/fixtures/required_elements_pas (PAS 1.2.7 projections + example
 * instances) used by src/fhirRequiredElements.test.ts.
 *
 *   DATABASE_URL=postgresql://... node --import tsx scripts/validator-audit/requiredElementsFixtures.ts
 */
import { writeFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initPool, closePool, query } from "../../src/db.js";
import { projectForRequired } from "../../src/fhirRequiredElements.js";
import { projectElement } from "../../src/fhirSnapshot.js";
initPool({ maxSize: 2 });
const OUT = "/home/brian/Taiwan-Health-MCP/mcp_proposal/fixtures/required_elements_pas";
const ex = JSON.parse(gunzipSync(readFileSync("scripts/validator-audit/corpus/examples.json.gz")).toString());
for (const id of ["Claim-twpas", "Bundle-twpas", "ClaimResponse-self-assessment-twpas", "extension-claimResponse-requestor", "Observation-cancer-stage-twpas"]) {
  const r = await query<any>("SELECT raw_json FROM fhir.artifacts WHERE package_id='tw.gov.mohw.nhi.pas' AND package_version='1.2.7' AND resource_type='StructureDefinition' AND artifact_id=$1", [id]);
  const sd = r.rows[0].raw_json;
  const els = projectForRequired(sd.snapshot.element, projectElement);
  // drop fields the tool does not read to keep the fixture small
  for (const e of els as any[]) { delete e.short; if (!e.slicing) delete e.slicing; if (!e.constraints.length) delete e.constraints; }
  writeFileSync(`${OUT}/${id}.elements.json`, JSON.stringify({ profile: id, package: "tw.gov.mohw.nhi.pas#1.2.7", elements: els }));
}
const pick: Record<string, string> = { "Claim/cla-1": "Claim-cla-1", "Bundle/bun-1": "Bundle-bun-1", "ClaimResponse/self-assessment-example": "ClaimResponse-self-assessment-example", "Observation/obs-cancer-tnm": "Observation-obs-cancer-tnm" };
for (const c of ex) if (pick[c.key]) writeFileSync(`${OUT}/${pick[c.key]}.instance.json`, JSON.stringify(c.res));
await closePool();
