/**
 * R4 evaluation: apply typical structural corruptions generically to every entry resource of the
 * IG example Bundles (rules read from the core StructureDefinitions: max 1 vs repeating), run the
 * shared content repair (repairBundle, as fhir_finalize_bundle repair="content"), and count the
 * validator's errors: as published (base), corrupted (broken), repaired (fixed); `differ` = repaired Bundles whose
 * errors (path + message) are not exactly those of the published one.
 *
 *   node --import tsx scripts/v16-structure-eval/evalRepairs.ts [pas|twcore] [--only=<corruption>] [-v] [--out=<dir>]
 *
 * --out writes each corrupted and repaired Bundle (for an external validator run).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandComposeWith } from "../../src/fhirCodeSystem.js";
import { repairBundle } from "../../src/fhirRepair/index.js";
import type { RepairDeps } from "../../src/fhirRepair/types.js";
import { InstanceValidator } from "../../src/fhirValidator.js";
import { available, exampleBundles, packages } from "./packages.js";

const ig = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "pas";
if (!available(ig)) {
  console.error(`package closure for ${ig} not in the cache`);
  process.exit(2);
}
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
const verbose = process.argv.includes("-v");
const pk = packages(ig);
const r = pk.resolver();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const errors = async (b: unknown): Promise<any[]> => ((await new InstanceValidator(r).validate(clone(b) as any, {})) as any[]).filter((i) => i.severity === "error" || i.severity === "fatal");
const deps: RepairDeps = {
  fetchStructureDefinition: (u) => r.fetchStructureDefinition(u),
  valueSetContains: (u, s, c) => r.valueSetContains(u, s, c),
  expandValueSet: async (u, limit) => {
    const vs = pk.get(u, "ValueSet");
    if (!vs) return null;
    const e = await expandComposeWith(vs.compose || {}, pk.termDeps(), limit);
    return { codings: e.codings, total: e.total, truncated: e.truncated };
  },
  validate: async (res, profiles) => (await new InstanceValidator(r).validate(clone(res), { profiles })) as any[],
};
function maxOf(type: string, key: string): string | null {
  const sd = pk.get(`http://hl7.org/fhir/StructureDefinition/${type}`, "StructureDefinition");
  const e = sd?.snapshot?.element?.find((x: any) => x.path === `${type}.${key}`);
  return e ? String(e.base?.max ?? e.max) : null;
}
const firstCoded = (res: any): any => {
  for (const v of Object.values(res)) {
    const o = Array.isArray(v) ? (v.length === 1 ? v[0] : null) : v;
    if (o && typeof o === "object" && Array.isArray((o as any).coding) && (o as any).coding.length === 1) return o;
  }
  return null;
};
type Corruption = (res: any, entry: any) => boolean;
const CORRUPTIONS: Record<string, Corruption> = {
  "meta.profile-string": (res) => (Array.isArray(res.meta?.profile) ? ((res.meta.profile = res.meta.profile[0]), true) : false),
  "array-as-single": (res) => {
    for (const k of Object.keys(res)) if (Array.isArray(res[k]) && res[k].length === 1 && k !== "contained" && maxOf(res.resourceType, k) === "*") return (res[k] = res[k][0]), true;
    return false;
  },
  "single-as-array": (res) => {
    for (const k of Object.keys(res)) if (!["resourceType", "id", "meta"].includes(k) && !Array.isArray(res[k]) && maxOf(res.resourceType, k) === "1") return (res[k] = [res[k]]), true;
    return false;
  },
  "nested-array-as-single": (res) => {
    const o = firstCoded(res);
    return o ? ((o.coding = o.coding[0]), true) : false;
  },
  "nested-single-as-array": (res) => {
    for (const v of Object.values(res)) {
      const o: any = Array.isArray(v) ? v[0] : v;
      if (!o || typeof o !== "object" || Array.isArray(o)) continue;
      for (const kk of ["text", "system", "value", "display", "start", "reference"]) if (typeof o[kk] === "string") return (o[kk] = [o[kk]]), true;
    }
    return false;
  },
  "no-resourceType": (res) => (Array.isArray(res.meta?.profile) ? (delete res.resourceType, true) : false),
  "no-resourceType+profile-string": (res) => (Array.isArray(res.meta?.profile) ? (delete res.resourceType, (res.meta.profile = res.meta.profile[0]), true) : false),
  "empty-elements": (res) => {
    if (!res.extension) res.extension = [];
    res.modifierExtension = [];
    res.implicitRules = "";
    return true;
  },
  "misplaced-meta": (res, entry) => (res.meta ? ((entry.meta = res.meta), delete res.meta, true) : false),
  "misplaced-system-up": (res) => {
    const o = firstCoded(res);
    if (!o || !o.coding[0].system || o.system) return false;
    o.system = o.coding[0].system;
    delete o.coding[0].system;
    return true;
  },
};
const rows: Record<string, { corrupted: number; base: number; broken: number; fixed: number; differ: number }> = {};
// errors compared as a multiset of (path, message), not only by count
const sig = (es: any[]): string => es.map((x) => `${x.path}\u0000${x.message}`).sort().join("\n");
if (out) mkdirSync(out, { recursive: true });
for (const [f, b0] of exampleBundles(ig)) {
  const baseErrs = await errors(b0);
  const base = baseErrs.length;
  for (const [name, fn] of Object.entries(CORRUPTIONS)) {
    if (only && name !== only) continue;
    const b = clone(b0);
    let n = 0;
    for (const e of b.entry) if (e.resource && fn(e.resource, e)) n++;
    if (!n) continue;
    const broken = (await errors(b)).length;
    if (out) writeFileSync(join(out, `${f.replace(/\.json$/, "")}.${name}.broken.json`), JSON.stringify(b, null, 1));
    const rep = await repairBundle(b, deps, {});
    const after = await errors(b);
    if (out) writeFileSync(join(out, `${f.replace(/\.json$/, "")}.${name}.fixed.json`), JSON.stringify(b, null, 1));
    const row = (rows[name] ??= { corrupted: 0, base: 0, broken: 0, fixed: 0, differ: 0 });
    row.corrupted += n;
    row.base += base;
    row.broken += broken;
    row.fixed += after.length;
    if (sig(after) !== sig(baseErrs)) row.differ++;
    if (verbose && after.length > base) {
      const pre = new Set((await errors(b0)).map((x) => x.message));
      console.log(f, name, base, broken, after.length, after.filter((x) => !pre.has(x.message)).slice(0, 5).map((x) => `${x.path} | ${String(x.message).slice(0, 160)}`), rep.issues.slice(0, 3).map((x) => x.message.slice(0, 160)));
    }
  }
}
console.table(rows);
