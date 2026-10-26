/**
 * Response sizes of fhir_get_bundle_blueprint / fhir_get_minimal_skeleton over a local FHIR
 * package cache (no DB): `node --import tsx scripts/ig-blueprint/sizes.mts <bp|sk> <pas|twcore> [profile ...]`.
 * Without profiles: every Bundle (bp) / resource (sk) constraint profile of the IG's own package.
 * OUT_DIR=<dir> also writes each tool `data` as <profile>.json there.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { availableClosure, fileBlueprintDeps, pkgDir, TWCORE_CLOSURE, TWPAS_CLOSURE } from "../../src/igBlueprint/fileDeps.test.ts";
import { bundleBlueprint } from "../../src/igBlueprint/blueprint.ts";
import { minimalSkeleton } from "../../src/igBlueprint/skeleton.ts";

const [mode, ig, ...given] = process.argv.slice(2);
const closure = availableClosure(ig === "pas" ? TWPAS_CLOSURE : TWCORE_CLOSURE);
if (!closure) {
  console.error("IG packages not in the local FHIR package cache");
  process.exit(2);
}
const deps = fileBlueprintDeps(closure)!;
let profiles = given;
if (!profiles.length) {
  const dir = pkgDir(closure[0])!;
  profiles = readdirSync(dir)
    .filter((f) => f.startsWith("StructureDefinition-") && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((sd) => sd.kind === "resource" && sd.derivation === "constraint" && (mode === "bp") === (sd.type === "Bundle"))
    .map((sd) => String(sd.id))
    .sort();
}
const out = process.env.OUT_DIR;
if (out) mkdirSync(out, { recursive: true });
const env = { tool: mode === "bp" ? "fhir_get_bundle_blueprint" : "fhir_get_minimal_skeleton", toolVersion: "1.0.0" };
for (const p of profiles) {
  const r =
    mode === "bp"
      ? await bundleBlueprint({ bundle_profile: p, view: (process.env.VIEW as "summary" | "references" | undefined) ?? "summary", envelope_provenance: env }, deps)
      : await minimalSkeleton({ profile: p, envelope_provenance: env }, deps);
  if (out) writeFileSync(join(out, `${p}.json`), JSON.stringify(r.data, null, 1));
  console.log(`${p}\t${r.data.response_chars}\tomitted=${JSON.stringify(r.data.omitted)}`);
}
