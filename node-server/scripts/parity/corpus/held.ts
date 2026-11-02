/**
 * What terminology this install holds, for report.ts --held: the installed CodeSystems with concepts (fhir.codesystems)
 * and the row counts of the terminology tables. Read-only.
 *
 *   DATABASE_URL=… node --import tsx scripts/parity/corpus/held.ts out.json
 */
import { writeFileSync } from "node:fs";
import pg from "pg";

const TABLES: Array<[string, string]> = [
  ["http://snomed.info/sct", "snomed.concepts"],
  ["http://loinc.org", "loinc.concepts"],
  ["http://www.nlm.nih.gov/research/umls/rxnorm", "rxnorm.concepts"],
  ["http://hl7.org/fhir/sid/icd-10-cm", "icd.diagnoses"],
  ["http://www.cms.gov/Medicare/Coding/ICD10", "icd.procedures"],
  ["http://hl7.org/fhir/sid/icd-10", "icd.icd10_who"],
];

async function main(): Promise<void> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const systems: Record<string, number> = {};
  for (const [url, table] of TABLES) systems[url] = Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const cs = await db.query("SELECT cs_id, max(concept_count) AS n FROM fhir.codesystems GROUP BY cs_id");
  for (const r of cs.rows) systems[String(r.cs_id)] = Math.max(systems[String(r.cs_id)] ?? 0, Number(r.n ?? 0));
  await db.end();
  writeFileSync(process.argv[2], JSON.stringify({ generated: new Date().toISOString(), systems }, null, 0));
  console.log(`${Object.keys(systems).length} systems; sample: ${Object.keys(systems).slice(6, 12).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
