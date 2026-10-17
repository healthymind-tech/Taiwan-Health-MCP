/**
 * Run the builtin validator locally (no HTTP) against a database, for the
 * validator audit harness. Reads a JSON array of {pkg, key, res, tool?} from
 * argv[2] (`.json` or `.json.gz`), writes [{key, ok, valid, issues}] to argv[3].
 * Set ONLY=<substring> to run a subset by key.
 *
 * (v6) Optional corpus fields: `ver` (IG version instead of the default below),
 * `overlay` (extra StructureDefinitions served on top of the DB closure — the CLI
 * oracle loads them with `-ig <file>`). Each output row also carries the
 * completeness fields (`checked_fully`, `profiles_unchecked`, `valuesets_unchecked`).
 *
 *   DATABASE_URL=postgresql://... node --import tsx scripts/validator-audit/localValidate.ts corpus.json out.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initPool, closePool } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import * as fhirIg from "../../src/fhirIg.js";
import { DbValidatorResolver } from "../../src/fhirValidationResolver.js";
import { InstanceValidator, completenessOf, isValid, type ValidatorResolver } from "../../src/fhirValidator.js";

/** Serve `overlay` StructureDefinitions (by url, or url|version) before the DB closure. */
function overlayResolver(base: ValidatorResolver, sds: Array<Record<string, any>>): ValidatorResolver {
  const byUrl = new Map<string, Record<string, any>>();
  for (const sd of sds) {
    byUrl.set(sd.url, sd);
    if (sd.version) byUrl.set(`${sd.url}|${sd.version}`, sd);
  }
  return {
    fetchStructureDefinition: async (url) => byUrl.get(url) ?? base.fetchStructureDefinition(url),
    fetchValueSet: (url) => base.fetchValueSet(url),
    valueSetContains: (u, s, c) => base.valueSetContains(u, s, c),
    checkCode: (s, c, d, v) => base.checkCode(s, c, d, v),
    codeSystemResolvable: base.codeSystemResolvable?.bind(base),
    codeSystemLocal: base.codeSystemLocal?.bind(base),
    definitionExists: async (url) => byUrl.has(url.split("|")[0]) || (base.definitionExists ? base.definitionExists(url) : true),
  };
}

const VERSIONS: Record<string, string> = { "tw.gov.mohw.twcore": "1.0.0", "tw.gov.mohw.nhi.pas": "1.2.7" };

async function main(): Promise<void> {
  const raw = readFileSync(process.argv[2]);
  const corpus = JSON.parse((process.argv[2].endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
  const only = process.env.ONLY;
  initPool({ maxSize: 4 });
  const svc = new FHIRIGService(null);
  const out: any[] = [];
  for (const c of corpus) {
    if (only && !String(c.key).includes(only)) continue;
    const t0 = Date.now();
    const ver = c.ver ?? VERSIONS[c.pkg];
    if (Array.isArray(c.overlay) && c.overlay.length) {
      const pkg = (await fhirIg.getPackage(c.pkg, ver))!;
      pkg._closure = await fhirIg.packageClosure(pkg.package_id, pkg.version);
      const engine = new InstanceValidator(overlayResolver(new DbValidatorResolver(pkg), c.overlay));
      const issues: any[] = await engine.validate(c.res, { profiles: c.profile ? [c.profile] : [] });
      out.push({ key: c.key, pkg: c.pkg, ok: true, valid: isValid(issues), ms: Date.now() - t0, issues, ...completenessOf(issues) });
      continue;
    }
    const raw =
      c.tool === "bundle"
        ? await svc.validateBundle(c.res, c.pkg, ver)
        : await svc.validateResource(c.res, c.profile ?? null, c.pkg, ver);
    const env = JSON.parse(raw);
    const data = env.data || {};
    const issues: any[] = [...(data.issues || [])];
    for (const e of data.entries || []) for (const i of e.issues || []) issues.push(i);
    for (const r of data.referenceIssues || []) issues.push({ severity: "warning", path: "", code: "reference", message: `unresolved bundle-internal reference ${JSON.stringify(r)}` });
    out.push({ key: c.key, pkg: c.pkg, ok: env.ok, valid: data.valid, ms: Date.now() - t0, issues, error: env.error, ...completenessOf(issues, data.deps_missing || []) });
  }
  writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
