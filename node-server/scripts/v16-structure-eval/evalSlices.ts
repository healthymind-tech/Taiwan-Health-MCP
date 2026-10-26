/**
 * R3 evaluation: corrupt one entry of each IG example Bundle (drop a required top-level element;
 * also without meta.profile / with a misspelled meta.profile), validate, attach suggestions, and
 * check the slice / profile-match explanations of the issues about that entry:
 *   explained — the issue has slice_match / profile_match,
 *   closest   — the closest slice / profile is the entry's original profile,
 *   blocking  — the blocking errors name the dropped element.
 *
 *   node --import tsx scripts/v16-structure-eval/evalSlices.ts [pas|twcore] [-v]
 */
import { performance } from "node:perf_hooks";
import { InstanceValidator } from "../../src/fhirValidator.js";
import { attachSuggestions } from "../../src/fhirSuggestions/index.js";
import { available, exampleBundles, packages } from "./packages.js";

const ig = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "pas";
if (!available(ig)) {
  console.error(`package closure for ${ig} not in the cache`);
  process.exit(2);
}
const verbose = process.argv.includes("-v");
const pk = packages(ig);
const deps = pk.suggestionDeps();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const RE = /does not match any known slice|a matching slice is required|Unable to find a profile match/;

function requiredTop(sd: any, res: any): string | null {
  for (const e of sd?.snapshot?.element ?? []) {
    const segs = String(e.path).split(".");
    if (segs.length !== 2 || String(e.id).includes(":") || (e.min ?? 0) < 1) continue;
    const k = segs[1].replace("[x]", "");
    const key = Object.keys(res).find((x) => x === k || (segs[1].endsWith("[x]") && x.startsWith(k)));
    if (key && key !== "meta") return key;
  }
  return null;
}

const tot = { cases: 0, issues: 0, explained: 0, about: 0, closest: 0, blocking: 0, set_profile: 0 };
const ms: number[] = [];
for (const [f, b0] of exampleBundles(ig, 5)) {
  for (const mode of ["drop-required", "drop-required+no-profile", "misspell-profile+drop-required"]) {
    for (let i = 0; i < b0.entry.length; i += 3) {
      const b = clone(b0);
      const res = b.entry[i].resource;
      const P = res?.meta?.profile?.[0];
      if (!P) continue;
      const key = requiredTop(await deps.fetchStructureDefinition(P), res);
      if (!key) continue;
      delete res[key];
      if (mode.includes("no-profile")) delete res.meta;
      if (mode.startsWith("misspell")) res.meta.profile = [`${P}x`];
      const issues = (await new InstanceValidator(pk.resolver()).validate(b, {})) as any[];
      const t0 = performance.now();
      await attachSuggestions(issues, b, deps);
      ms.push(performance.now() - t0);
      tot.cases++;
      for (const x of issues.filter((y) => y.severity === "error" && RE.test(y.message))) {
        tot.issues++;
        const info = x.slice_match ?? x.profile_match;
        if (info) tot.explained++;
        const own = `Bundle.entry[${i}]`;
        const about = x.path === own || x.path === `${own}.resource` ? !/^Slice '/.test(x.message) || x.path === own : info?.closest?.item === own || info?.target?.path === `${own}.resource` || (x.path === own);
        if (!about || (x.slice_match && x.slice_match.sliced !== "Bundle.entry")) continue;
        tot.about++;
        if (String(info?.closest?.profile ?? "").split("|")[0] === P) tot.closest++;
        else if (verbose) console.log("MISS", f, mode, i, key, x.path, x.message.slice(0, 90), JSON.stringify(info?.closest), JSON.stringify(info?.others));
        if ((info?.blocking ?? []).some((bl: any) => `${bl.path} ${bl.message}`.includes(key))) tot.blocking++;
        if ((x.suggestions ?? []).some((s: any) => s.kind === "set_profile")) tot.set_profile++;
      }
    }
  }
}
ms.sort((a, b) => a - b);
console.log(JSON.stringify({ ig, ...tot, suggest_ms_p50: Math.round(ms[Math.floor(ms.length / 2)] ?? 0), suggest_ms_max: Math.round(ms[ms.length - 1] ?? 0) }));
