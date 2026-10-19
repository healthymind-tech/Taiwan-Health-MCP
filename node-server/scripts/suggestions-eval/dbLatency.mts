/**
 * Suggestion-layer latency against a real database (DB-backed collaborators, as in production):
 * validator time vs attachSuggestions time, warm, for a few synthetic resources and a bundle.
 * Read-only by construction — pass a connection that forces read-only transactions:
 *
 *   DATABASE_URL='postgresql://mcp:<pw>@<host>:5432/taiwan_health?options=-c%20default_transaction_read_only%3Don' \
 *     node --import tsx scripts/suggestions-eval/dbLatency.mts
 *
 * Embeddings are off (FHIRIGService(null)): normalize-backed suggestions are lexical here; with an
 * embedding route each such suggestion adds one query embedding.
 */
import { performance } from "node:perf_hooks";
import { closePool, initPool, query } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import { DbValidatorResolver } from "../../src/fhirValidationResolver.js";
import { InstanceValidator } from "../../src/fhirValidator.js";
import { attachSuggestions } from "../../src/fhirSuggestions/index.js";
import { dbSuggestionDeps } from "../../src/fhirSuggestions/dbDeps.js";

const UCUM = "http://unitsofmeasure.org";
const THO = "http://terminology.hl7.org/CodeSystem/";
const TW = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/";
const PAT = "urn:uuid:22222222-2222-4222-8222-222222222222";

const CASES: Array<Record<string, any>> = [
  { resourceType: "Observation", status: "Final", code: { coding: [{ system: "http://loinc.org", code: "8867-4", display: "Pulse" }] }, subject: { reference: PAT }, valueQuantity: { value: 1, system: UCUM, code: "[UI]/mL" } },
  { resourceType: "Encounter", status: "finished", class: { system: THO + "v3-ActEncounterCode", code: "AMB" } },
  { resourceType: "MedicationRequest", status: "active", intent: "order", medicationCodeableConcept: { text: "x" }, subject: { reference: PAT }, dosageInstruction: [{ timing: { periodUnit: "d", repeat: { periodUnits: "d" } } }] },
  { resourceType: "Condition", meta: { profile: [TW + "Condition-twcore"] }, subject: { reference: PAT }, code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E119", display: "Type 2 diabetes mellitus without complications" }] } },
];

const BUNDLE = {
  resourceType: "Bundle",
  type: "collection",
  entry: [{ fullUrl: PAT, resource: { resourceType: "Patient", gender: "M", birthdate: "1990-01-01" } }, ...CASES.map((r, i) => ({ fullUrl: `urn:uuid:00000000-0000-4000-8000-00000000000${i}`, resource: r }))],
};

async function main(): Promise<void> {
  initPool({ maxSize: 4 });
  console.log("read-only:", (await query("SHOW default_transaction_read_only")).rows[0]);
  const svc = new FHIRIGService(null);
  const pkg: any = await (svc as any).resolve("tw.gov.mohw.twcore", "1.0.0", {});
  const hooks = (svc as any).suggestionHooks(pkg);
  for (const [name, res] of [...CASES.map((c) => [c.resourceType, c] as const), ["Bundle (5 entries)", BUNDLE] as const]) {
    const v: number[] = [];
    const s: number[] = [];
    let issues: any[] = [];
    for (let k = 0; k < 5; k++) {
      const resolver = new DbValidatorResolver(pkg);
      const t0 = performance.now();
      issues = (await new InstanceValidator(resolver).validate(res, {})) as any[];
      const t1 = performance.now();
      await attachSuggestions(issues, res, dbSuggestionDeps(pkg, resolver, hooks));
      v.push(t1 - t0);
      s.push(performance.now() - t1);
    }
    const warm = (xs: number[]): string => xs.slice(1).map((x) => x.toFixed(0)).join("/");
    console.log(`${name}: ${issues.length} issues, ${issues.filter((i) => i.suggestions || i.caused_by).length} with suggestions; validate ${warm(v)} ms, suggestions ${warm(s)} ms (warm runs; cold: ${v[0].toFixed(0)} / ${s[0].toFixed(0)} ms)`);
  }
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
