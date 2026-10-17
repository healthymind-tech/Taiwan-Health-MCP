/**
 * Dev script: build the TW PAS grounding test inputs.
 *   - __fixtures__/pas_bundles.json.gz     the PAS example Bundles (tw.gov.mohw.nhi.pas 1.2.7 package examples and the
 *                                           generated collection/transaction Bundles of the validator-audit corpus)
 *   - __fixtures__/pas_terminology.json    authoritative names for every coding in them, read (read-only) from a
 *                                           terminology DB through the production DB provider
 *
 *   cd node-server && GROUNDING_DB_URL=postgresql://...staging... node --import tsx src/grounding/scripts/buildPasFixtures.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import pg from "pg";

import { collectCodingKeys } from "../checkGrounding.js";
import { createDbTerminologyNames } from "../terminologyDb.js";
import { fixturePath } from "../testkit.js";

const corpus = (f: string): any[] => JSON.parse(gunzipSync(readFileSync(new URL(`../../../scripts/validator-audit/corpus/${f}`, import.meta.url))).toString());
const items = [...corpus("examples.json.gz"), ...corpus("bundles.json.gz")].filter((x) => x.pkg === "tw.gov.mohw.nhi.pas" && x.res?.resourceType === "Bundle");
const bundles = items
  .filter((x) => !String(x.key).includes("bun-response")) // a ClaimResponse-only Bundle: nothing comes from a record
  .map((x) => ({ key: x.key, bundle: x.res }));
writeFileSync(fixturePath("pas_bundles.json.gz"), gzipSync(JSON.stringify({ package: "tw.gov.mohw.nhi.pas#1.2.7", bundles })));

const url = process.env.GROUNDING_DB_URL;
if (!url) throw new Error("GROUNDING_DB_URL is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET default_transaction_read_only = on");
const db = createDbTerminologyNames({ query: (sql, params) => client.query(sql, params as unknown[]) as any });
const bundleKeys = [...new Set(bundles.flatMap((b) => collectCodingKeys(b.bundle)))];
// codes the negative variants substitute (pasTestkit ALT_CODE) must be known too, or a wrong code is only "unverifiable"
const altKeys = [
  "http://hl7.org/fhir/sid/icd-10-cm|J45.909",
  "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-pcs-2023-tw|0DTJ4ZZ",
  "http://snomed.info/sct|47625008",
];
const keys = [...new Set([...bundleKeys, ...altKeys])].sort();
const m = await db.lookup(keys);
const codes: Record<string, unknown> = {};
for (const k of keys) codes[k] = m.get(k);
writeFileSync(fixturePath("pas_terminology.json"), JSON.stringify({ built: new Date().toISOString().slice(0, 10), source: await db.version(), n: keys.length, codes }, null, 0));
console.log(`bundles ${bundles.length}, codes ${keys.length}, found ${[...m.values()].filter((r) => r.found).length}`);
await client.end();
