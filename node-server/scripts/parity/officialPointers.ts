/**
 * v19 R3 over official-validator output: every error of fhir_validate_bundle (official engine) gets a pointer into the
 * sent Bundle and, where possible, JSON Patch candidates. Measures resolvable pointers / patch coverage / applicability.
 *   OFFICIAL_VALIDATOR_URLS=… DATABASE_URL=… node --import tsx scripts/parity/officialPointers.ts <dir with *.bundle.json + .compare.json>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closePool, initPool } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import { addValidationPointers } from "../../src/fhirSuggestions/pointers.js";
import { patchApplies, resolvePointer } from "../../src/jsonPatch.js";

type Json = Record<string, any>;
const dir = process.argv[2];
async function main(): Promise<void> {
  initPool({ maxSize: 2 });
  const svc = new FHIRIGService(null);
  let errs = 0, ptr = 0, withPatch = 0, cands = 0, applies = 0, quoted = 0, wrong = 0;
  const engines = new Map<string, number>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".bundle.json")).sort()) {
    const bundle = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const cmp = JSON.parse(readFileSync(join(dir, f.replace(".bundle.json", ".compare.json")), "utf8"));
    const [pid, ver] = cmp.package ? String(cmp.package).split("#") : ["tw.gov.mohw.nhi.pas", "1.2.7"];
    const prof = cmp.bundle_profile ?? "https://nhicore.nhi.gov.tw/pas/StructureDefinition/Bundle-twpas";
    const text = addValidationPointers(await svc.validateBundle(bundle, pid, ver, false, undefined, "ids", null, prof), bundle);
    const d = JSON.parse(text).data;
    engines.set(d.engine ?? d.source, (engines.get(d.engine ?? d.source) ?? 0) + 1);
    for (const i of [...(d.issues ?? []), ...(d.entries ?? []).flatMap((e: Json) => e.issues ?? [])]) {
      if (i.severity !== "error" && i.severity !== "fatal") continue;
      errs++;
      if (typeof i.pointer === "string") {
        const at = resolvePointer(bundle, i.pointer);
        if (at.found) ptr++;
        // the entry / reference a Bundle message quotes must be the one the pointer names
        const q = /^Entry '([^']+)' isn't reachable/u.exec(i.message) ?? /^Can't find '([^']+)' in the bundle/u.exec(i.message);
        if (q) {
          quoted++;
          const v: any = at.value;
          const ok = /isn't reachable/u.test(i.message) ? v?.fullUrl === q[1] : v?.reference === q[1];
          if (!ok) {
            wrong++;
            if (process.env.SHOW_WRONG) console.log("WRONG", f, i.pointer, i.location_path ?? "-", i.path, i.message.slice(0, 140));
          }
        }
      }
      if (Array.isArray(i.patches) && i.patches.length) {
        withPatch++;
        for (const p of i.patches) {
          cands++;
          if (patchApplies(bundle, p.ops)) applies++;
        }
      }
    }
  }
  console.log(`engines ${JSON.stringify([...engines])}; errors ${errs}; pointer resolvable ${((100 * ptr) / errs).toFixed(1)}%; with patch ${((100 * withPatch) / errs).toFixed(1)}%; quoted-entry messages ${quoted}, pointer at the wrong entry ${wrong}; candidates ${cands}, applicable ${((100 * applies) / Math.max(cands, 1)).toFixed(1)}%`);
  await closePool();
}
main().catch((e) => { console.error(e); process.exit(2); });
