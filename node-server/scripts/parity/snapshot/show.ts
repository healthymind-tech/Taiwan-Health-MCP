/**
 * Print the snapshot src/fhirSnapshotGenerator.ts generates for a differential-only StructureDefinition file (debug aid).
 *   node --import tsx scripts/parity/snapshot/show.ts <sd.json> [more supporting .json ...] [--pkg id#ver ...] [--full]
 * Bases / types come from hl7.fhir.r4.core#4.0.1 (+ --pkg closures); extra files are loaded as loose resources.
 */
import { readFileSync } from "node:fs";
import { SnapshotGenerator } from "../../../src/fhirSnapshotGenerator.js";
import { ResourceStore } from "../lib/fileResolver.js";
import { packageClosure } from "../lib/packages.js";

const args = process.argv.slice(2);
const full = args.includes("--full");
const pkgs: string[] = [];
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--pkg") pkgs.push(args[++i]);
  else if (!args[i].startsWith("--")) files.push(args[i]);
}
const store = new ResourceStore();
for (const p of packageClosure(["hl7.fhir.r4.core#4.0.1", "hl7.fhir.uv.extensions.r4#5.3.0-ballot-tc1", ...pkgs]).packages) store.addPackage(p);
const sds = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
for (const sd of sds) store.addResource(sd);
const gen = new SnapshotGenerator({ fetch: (u) => store.resolve("StructureDefinition", u) });
const out = gen.ensure(sds[0]);
for (const m of gen.messages) console.log(`[${m.level}] ${m.path}: ${m.message}`);
if (!out) process.exit(1);
for (const e of out.snapshot.element) {
  if (full) {
    console.log(JSON.stringify(e));
    continue;
  }
  const t = (e.type || []).map((x: any) => x.code + (x.profile ? "{" + x.profile.join(",") + "}" : "") + (x.targetProfile ? "->" + x.targetProfile.map((u: string) => u.split("/").pop()).join(",") : "")).join("|");
  const extra = Object.keys(e)
    .filter((k) => /^(fixed|pattern|minValue|maxValue)[A-Z]/.test(k))
    .map((k) => `${k}=${JSON.stringify(e[k])}`)
    .join(" ");
  const sl = e.slicing ? ` SLICING(${(e.slicing.discriminator || []).map((d: any) => d.type + ":" + d.path).join(",")} ${e.slicing.rules})` : "";
  const b = e.binding ? ` BIND(${e.binding.strength} ${e.binding.valueSet ?? ""})` : "";
  console.log(`${e.id} [${e.min}..${e.max}] ${t}${sl}${b} ${extra}${e.mustSupport ? " MS" : ""}`);
}
