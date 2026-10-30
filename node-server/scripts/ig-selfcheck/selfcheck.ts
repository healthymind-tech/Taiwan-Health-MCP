/**
 * ISSUES_v17 R1 — self-check of installed IGs against their own content, through the same code
 * paths as the MCP tools (no server needed; DATABASE_URL = the database the IGs are installed in):
 *
 *   examples   every example instance of the package: a Bundle → fhir_validate_bundle, any other
 *              resource → fhir_validate_resource (by its meta.profile); valid or not, first errors
 *   profiles   every resource constraint profile: fhir_get_minimal_skeleton and fhir_get_authoring_fields
 *              must return data (ok); Bundle profiles also fhir_get_bundle_blueprint
 *
 *   DATABASE_URL=… node --import tsx scripts/ig-selfcheck/selfcheck.ts <package#version> [...] [--out=<dir>]
 *
 * --out writes <package>#<version>.selfcheck.json (per-item results) and .corpus.json (the examples in
 * the validator-audit corpus shape, for the validator_cli comparison: harness/cli_oracle.py + compare.ts).
 * Run it inside scripts/dev/run-limited.sh on a shared host. Never writes to the database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closePool, initPool, query } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import { authoringFields } from "../../src/authoring/fields.js";
import { dbFieldsDeps } from "../../src/authoring/fieldsTool.js";
import { bundleBlueprint } from "../../src/igBlueprint/blueprint.js";
import { minimalSkeleton } from "../../src/igBlueprint/skeleton.js";
import { dbBlueprintDeps } from "../../src/igBlueprint/tools.js";

type Json = Record<string, any>;
const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith("--out="))?.slice(6);
const pkgs = args.filter((a) => !a.startsWith("--")).map((a) => a.split("#") as [string, string]);
const jsonValue = (raw: unknown): Json => (typeof raw === "string" ? JSON.parse(raw) : (raw as Json)) ?? {};
const firstErrors = (issues: Json[], n = 3): string[] =>
  issues.filter((i) => i.severity === "error" || i.severity === "fatal").slice(0, n).map((i) => `${i.path} | ${String(i.message).slice(0, 180)}`);

async function main(): Promise<void> {
  initPool({ maxSize: 2 });
  const svc = new FHIRIGService(null);
  const bdeps = dbBlueprintDeps();
  const fdeps = dbFieldsDeps();
  if (out) mkdirSync(out, { recursive: true });
  const summary: Json[] = [];
  for (const [pid, ver] of pkgs) {
    const t0 = Date.now();
    const rows = (
      await query<{ artifact_id: string; resource_type: string; grouping_id: string | null; raw_json: unknown }>(
        "SELECT artifact_id, resource_type, grouping_id, raw_json FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2",
        [pid, ver],
      )
    ).rows;
    if (!rows.length) {
      summary.push({ package: `${pid}#${ver}`, error: "not installed" });
      continue;
    }
    const items: Json[] = [];
    const corpus: Json[] = [];
    // 1. examples
    for (const r of rows.filter((x) => x.grouping_id === "examples")) {
      const res = jsonValue(r.raw_json);
      if (typeof res.resourceType !== "string") continue;
      const bundle = res.resourceType === "Bundle";
      const t = Date.now();
      let env: Json;
      try {
        env = JSON.parse(bundle ? await svc.validateBundle(res, pid, ver) : await svc.validateResource(res, null, pid, ver));
      } catch (e) {
        env = { ok: false, error: { code: "EXCEPTION", message: String((e as Error).message).slice(0, 200) } };
      }
      const d = env.data || {};
      const issues: Json[] = [...(d.issues || [])];
      for (const e of d.entries || []) for (const i of e.issues || []) issues.push(i);
      items.push({ kind: "example", id: `${res.resourceType}/${r.artifact_id}`, tool: bundle ? "fhir_validate_bundle" : "fhir_validate_resource", ok: env.ok !== false, valid: d.valid === true, ms: Date.now() - t, errors: firstErrors(issues), error: env.error ?? null });
      corpus.push({ key: `${pid}#${ver}/${r.artifact_id}`, pkg: pid, ver, tool: bundle ? "bundle" : "resource", res });
    }
    // 2. profiles
    const profiles = rows
      .filter((x) => x.resource_type === "StructureDefinition")
      .map((x) => jsonValue(x.raw_json))
      .filter((sd) => sd.kind === "resource" && sd.derivation === "constraint" && sd.url);
    for (const sd of profiles) {
      const call = async (tool: string, fn: () => Promise<unknown>): Promise<void> => {
        const t = Date.now();
        try {
          const r = (await fn()) as Json;
          const data = r?.data ?? r;
          items.push({ kind: "profile", id: sd.id, tool, ok: !!data, ms: Date.now() - t, ...(data?.omitted ? { omitted: data.omitted } : {}), ...(data?.skeleton_omitted ? { skeleton_omitted: true } : {}) });
        } catch (e) {
          items.push({ kind: "profile", id: sd.id, tool, ok: false, ms: Date.now() - t, error: `${(e as Json).code ?? "EXCEPTION"}: ${String((e as Error).message).slice(0, 200)}` });
        }
      };
      await call("fhir_get_minimal_skeleton", () => minimalSkeleton({ profile: sd.url, package_id: pid, version: ver }, bdeps));
      await call("fhir_get_authoring_fields", () => authoringFields({ profile: sd.url, package_id: pid, version: ver }, fdeps));
      if (sd.type === "Bundle") await call("fhir_get_bundle_blueprint", () => bundleBlueprint({ bundle_profile: sd.url, package_id: pid, version: ver }, bdeps));
    }
    const ex = items.filter((i) => i.kind === "example");
    const pr = items.filter((i) => i.kind === "profile");
    const s = {
      package: `${pid}#${ver}`,
      seconds: Math.round((Date.now() - t0) / 1000),
      examples: ex.length,
      examples_valid: ex.filter((i) => i.valid).length,
      examples_tool_failed: ex.filter((i) => !i.ok).length,
      profiles: profiles.length,
      bundle_profiles: profiles.filter((p) => p.type === "Bundle").length,
      profile_calls: pr.length,
      profile_calls_failed: pr.filter((i) => !i.ok).length,
      failures: [...ex.filter((i) => !i.ok || !i.valid).map((i) => `${i.tool} ${i.id}: ${i.error ? JSON.stringify(i.error).slice(0, 160) : i.errors[0] ?? "invalid"}`), ...pr.filter((i) => !i.ok).map((i) => `${i.tool} ${i.id}: ${i.error}`)].slice(0, 40),
    };
    summary.push(s);
    console.log(JSON.stringify(s));
    if (out) {
      writeFileSync(join(out, `${pid}#${ver}.selfcheck.json`), JSON.stringify(items, null, 1));
      writeFileSync(join(out, `${pid}#${ver}.corpus.json`), JSON.stringify(corpus));
    }
  }
  if (out) writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1));
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
