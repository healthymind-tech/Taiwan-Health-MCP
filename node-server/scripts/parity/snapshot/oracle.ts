/**
 * Snapshot-generator oracle: for every constraint StructureDefinition of the given packages that ships both a
 * differential and a published snapshot, regenerate the snapshot from the differential (bases / types resolved with
 * their published snapshots, as the HL7 context holds them) with src/fhirSnapshotGenerator.ts and diff it against the
 * published one on what validation reads: element ids (missing / extra / order), min, max, type codes + profiles +
 * targetProfiles, fixed[x], pattern[x], binding strength + valueSet, constraint keys, mustSupport, slicing
 * (discriminators / rules / ordered), contentReference.
 *
 * Usage (from node-server/):
 *   node --import tsx scripts/parity/snapshot/oracle.ts [pkg#ver ...] [--json out.json] [-v] [--only <url-substring>]
 * Default packages: tw.gov.mohw.twcore#1.0.0 hl7.fhir.uv.ips#1.1.0 tw.gov.mohw.nhi.pas#1.2.7 hl7.fhir.us.core#6.1.0
 */
import { writeFileSync } from "node:fs";
import { SnapshotGenerator, workingCode } from "../../../src/fhirSnapshotGenerator.js";
import { ResourceStore } from "../lib/fileResolver.js";
import { findPackage, packageClosure, type Res } from "../lib/packages.js";

const args = process.argv.slice(2);
const verbose = args.includes("-v");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
/** --simple <file.ts>: compare another generator exporting SnapshotGenerator(fetch).ensure(sd) instead (a "before"). */
const simplePath = args.includes("--simple") ? args[args.indexOf("--simple") + 1] : null;
const simple: any = simplePath ? (await import(simplePath)).SnapshotGenerator : null;
const pkgs = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "--json" && args[i - 1] !== "--only" && args[i - 1] !== "--simple");
const specs = pkgs.length ? pkgs : ["tw.gov.mohw.twcore#1.0.0", "hl7.fhir.uv.ips#1.1.0", "tw.gov.mohw.nhi.pas#1.2.7", "hl7.fhir.us.core#6.1.0"];

type ED = Record<string, any>;
/** canonical without |version (newer publishers version core canonicals; validation resolves both alike). */
const norm = (u: any): string => String(u ?? "").split("|")[0];
const CATS = ["missing-id", "extra-id", "order", "min", "max", "type", "fixed", "pattern", "binding", "constraint", "mustSupport", "slicing", "contentReference", "failed", "publisher-slicer"] as const;
/**
 * Not a generator difference: the published value is the one the differential sets on the SLICER's element (the same
 * id with the slice names removed) and the slice element itself does not set it — older IG publishers copied slicer
 * properties onto slices; validator_cli 7.0.1 does not (ProfilePathProcessor.APPLY_PROPERTIES_FROM_SLICER = false,
 * PPP:51-59, "the community decided not to apply this fix"), and neither do we. Reported apart from the real diffs.
 */
const PUBLISHER_SLICER_CATS = new Set<string>(["binding", "mustSupport", "min", "type"]);
type Cat = (typeof CATS)[number];

function typeSig(ed: ED): string {
  return JSON.stringify(
    (ed.type || []).map((t: ED) => [workingCode(t), [...(t.profile || [])].map(norm).sort(), [...(t.targetProfile || [])].map(norm).sort()]),
  );
}
function valueOf(ed: ED, pfx: string): string | undefined {
  for (const k of Object.keys(ed)) if (k.startsWith(pfx) && /[A-Z]/.test(k[pfx.length] || "")) return k + "=" + JSON.stringify(ed[k]);
  return undefined;
}
function bindingSig(ed: ED): string {
  return ed.binding ? `${ed.binding.strength}|${norm(ed.binding.valueSet)}` : "";
}
function constraintSig(ed: ED): string {
  return [...new Set((ed.constraint || []).map((c: ED) => c.key))].sort().join(",");
}
function slicingSig(ed: ED): string {
  const s = ed.slicing;
  if (!s) return "";
  const disc = (s.discriminator || []).map((d: ED) => d.type + ":" + d.path);
  // type slicing is always closed in current cores (older publishers left the differential's rule): not compared
  const typeSlicing = disc.length === 1 && disc[0] === "type:$this";
  return JSON.stringify([disc, typeSlicing ? "-" : (s.rules ?? null), s.ordered ?? false]);
}

const EXT_IMPLIED = "http://hl7.org/fhir/tools/StructureDefinition/implied-type-slice";
/**
 * Representation-only differences between generator generations, folded before comparing:
 *  - implied type slices (current cores add one per uncovered type of a closed type slicing) are dropped;
 *  - a type slicing whose slicer allows exactly one type, with that one slice ("valueQuantity" in a differential),
 *    is the same constraint as the unsliced element restricted to that type (older publishers' form): the slice's
 *    content is folded onto the slicer and its children renamed X.value[x]:valueQuantity.y → X.value[x].y.
 */
function fold(list: ED[]): ED[] {
  const out = list.filter((e) => !(e.extension || []).some((x: ED) => x.url === EXT_IMPLIED)).map((e) => ({ ...e }));
  const byId = new Map(out.map((e) => [String(e.id), e]));
  const renames: Array<[string, string]> = [];
  for (const e of out) {
    const s = e.slicing;
    if (!s || (e.type || []).length !== 1) continue;
    const d = s.discriminator || [];
    if (!(d.length === 1 && d[0].type === "type" && d[0].path === "$this")) continue;
    const kids = out.filter((x) => x.path === e.path && x.sliceName && String(x.id) === `${e.id}:${x.sliceName}`);
    if (kids.length !== 1) continue;
    const slice = kids[0];
    renames.push([String(slice.id), String(e.id)]);
    delete e.slicing;
    for (const k of Object.keys(slice)) if (!["id", "sliceName", "slicing"].includes(k)) e[k] = slice[k];
  }
  const res: ED[] = [];
  for (const e of out) {
    let id = String(e.id);
    if (renames.some(([from]) => id === from)) continue;
    for (const [from, to] of renames) if (id.startsWith(from + ".")) id = to + id.slice(from.length);
    res.push({ ...e, id });
  }
  void byId;
  return res;
}
const crSig = (ed: ED): string => (ed.contentReference ? "#" + String(ed.contentReference).split("#")[1] : "");

const unsliced = (id: string): string => id.split(".").map((seg) => seg.split(":")[0]).join(".");
function sigOf(cat: string, ed: ED): any {
  if (cat === "binding") return bindingSig(ed);
  if (cat === "mustSupport") return !!ed.mustSupport;
  if (cat === "min") return ed.min ?? 0;
  return typeSig(ed);
}
const PROP: Record<string, string> = { binding: "binding", mustSupport: "mustSupport", min: "min", type: "type" };
function fromSlicer(cat: string, id: string, pubValue: any, diff: ED[]): boolean {
  if (!PUBLISHER_SLICER_CATS.has(cat) || !id.includes(":")) return false;
  const own = diff.find((e) => e.id === id);
  if (own && own[PROP[cat]] !== undefined) return false;
  const slicerId = unsliced(id);
  if (slicerId === id) return false;
  const slicer = diff.find((e) => e.id === slicerId);
  return !!slicer && slicer[PROP[cat]] !== undefined && JSON.stringify(sigOf(cat, slicer)) === JSON.stringify(pubValue);
}

function compare(pub0: ED[], gen0: ED[], diff: ED[] = []): Array<{ cat: Cat; id: string; pub?: any; gen?: any }> {
  const pub = fold(pub0);
  const gen = fold(gen0);
  const out: Array<{ cat: Cat; id: string; pub?: any; gen?: any }> = [];
  const gi = new Map(gen.map((e) => [String(e.id), e]));
  const pi = new Map(pub.map((e) => [String(e.id), e]));
  for (const p of pub) {
    const id = String(p.id);
    const g = gi.get(id);
    if (!g) {
      out.push({ cat: "missing-id", id });
      continue;
    }
    const chk = (cat: Cat, a: any, b: any): void => {
      if (a !== b) out.push({ cat: fromSlicer(cat, id, a, diff) ? "publisher-slicer" : cat, id, pub: a, gen: b });
    };
    chk("min", p.min ?? 0, g.min ?? 0);
    chk("max", p.max ?? "", g.max ?? "");
    chk("type", typeSig(p), typeSig(g));
    chk("fixed", valueOf(p, "fixed"), valueOf(g, "fixed"));
    chk("pattern", valueOf(p, "pattern"), valueOf(g, "pattern"));
    chk("binding", bindingSig(p), bindingSig(g));
    chk("constraint", constraintSig(p), constraintSig(g));
    chk("mustSupport", !!p.mustSupport, !!g.mustSupport);
    chk("slicing", slicingSig(p), slicingSig(g));
    chk("contentReference", crSig(p), crSig(g));
  }
  for (const g of gen) if (!pi.has(String(g.id))) out.push({ cat: "extra-id", id: String(g.id) });
  // order: the common ids in the same relative order
  const common = pub.map((e) => String(e.id)).filter((id) => gi.has(id));
  const genOrder = gen.map((e) => String(e.id)).filter((id) => pi.has(id));
  if (JSON.stringify(common) !== JSON.stringify(genOrder)) {
    const k = common.findIndex((id, i) => genOrder[i] !== id);
    out.push({ cat: "order", id: common[k] ?? "?", pub: common[k], gen: genOrder[k] });
  }
  return out;
}

const store = new ResourceStore();
const closure = packageClosure(["hl7.fhir.r4.core#4.0.1", ...specs]);
for (const p of closure.packages) store.addPackage(p);
if (closure.missing.length) console.error("missing packages:", closure.missing.join(", "));

const totals: Record<string, number> = Object.fromEntries(CATS.map((c) => [c, 0]));
let profiles = 0;
let exact = 0;
const perProfile: Array<{ url: string; diffs: number; byCat: Record<string, number>; sample: any[]; messages?: any[] }> = [];
for (const spec of specs) {
  const ref = findPackage(spec);
  if (!ref) {
    console.error("not cached:", spec);
    continue;
  }
  const { packageResources } = await import("../lib/packages.js");
  for (const sd of packageResources(ref)) {
    if (sd.resourceType !== "StructureDefinition" || sd.derivation !== "constraint") continue;
    if (!sd.snapshot?.element?.length || !sd.differential?.element?.length) continue;
    if (only && !String(sd.url).includes(only)) continue;
    profiles++;
    // the published snapshots come from the IG publisher, which runs with newSlicingProcessing = true
    const gen = new SnapshotGenerator({ fetch: (u: string) => store.resolve("StructureDefinition", u), newSlicingProcessing: !args.includes("--validator-mode") });
    const input: Res = { ...sd };
    delete input.snapshot;
    let res: Res | null = null;
    try {
      if (simple) res = new simple((u: string) => store.resolve("StructureDefinition", u)).ensure(input);
      else res = gen.generate(input);
    } catch (e) {
      res = null;
      gen.messages.push({ level: "error", path: String(sd.url), message: (e as Error).message });
    }
    const byCat: Record<string, number> = {};
    let diffs: Array<{ cat: Cat; id: string; pub?: any; gen?: any }>;
    if (!res) diffs = [{ cat: "failed", id: String(sd.url), gen: gen.messages.map((m) => m.message).join(" / ") }];
    else diffs = compare(sd.snapshot.element, res.snapshot.element, sd.differential.element);
    for (const d of diffs) {
      byCat[d.cat] = (byCat[d.cat] ?? 0) + 1;
      totals[d.cat]++;
    }
    if (!diffs.some((d) => d.cat !== "publisher-slicer")) exact++;
    perProfile.push({ url: String(sd.url), diffs: diffs.length, byCat, sample: diffs.slice(0, 12), messages: gen.messages.length ? gen.messages.slice(0, 5) : undefined });
    if (verbose && diffs.length) {
      console.log(`\n${sd.url}  (${diffs.length})`);
      for (const d of diffs.slice(0, 15)) console.log(`  ${d.cat.padEnd(12)} ${d.id}${d.pub !== undefined || d.gen !== undefined ? `  pub=${JSON.stringify(d.pub)} gen=${JSON.stringify(d.gen)}` : ""}`);
    }
  }
}
const total = Object.entries(totals).reduce((a, [c, n]) => (c === "publisher-slicer" ? a : a + n), 0);
console.log(`\nprofiles ${profiles}, identical ${exact} (${((100 * exact) / Math.max(1, profiles)).toFixed(1)}%), differences ${total} (+ ${totals["publisher-slicer"]} publisher-slicer, not generator differences)`);
for (const c of CATS) if (totals[c]) console.log(`  ${c.padEnd(16)} ${totals[c]}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ specs, profiles, exact, totals, perProfile }, null, 1));
