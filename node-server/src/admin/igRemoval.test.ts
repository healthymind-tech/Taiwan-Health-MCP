import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dependentsOf,
  orphanedBy,
  planRemoval,
  removeIgPackages,
  unusedDependencies,
  IG_REMOVAL_CODES,
  type InstalledIg,
  type TxClient,
} from "./igRemoval.js";

const pkg = (
  package_id: string,
  version: string,
  dependencies: Record<string, string> = {},
  extra: Partial<InstalledIg> = {},
): InstalledIg => ({ package_id, version, title: null, is_default: false, install_origin: "manual", dependencies, ...extra });

// twcore declares core 4.0.0 (never published → resolved to 4.0.1).
const CORE = pkg("hl7.fhir.r4.core", "4.0.1", {}, { install_origin: "dependency" });
const TERMINOLOGY = pkg("hl7.terminology.r4", "6.2.0", { "hl7.fhir.r4.core": "4.0.1" }, { install_origin: "dependency" });
const EXT = pkg("hl7.fhir.uv.extensions.r4", "5.1.0", { "hl7.fhir.r4.core": "4.0.1" }, { install_origin: "dependency" });
const TWCORE = pkg(
  "tw.gov.mohw.twcore",
  "1.0.0",
  { "hl7.fhir.r4.core": "4.0.0", "hl7.terminology.r4": "6.2.0", "hl7.fhir.uv.extensions.r4": "5.1.0" },
  { is_default: true },
);
const PAS = pkg("tw.gov.mohw.nhi.pas", "1.0.0", { "tw.gov.mohw.twcore": "1.0.0" });
const ALL = [CORE, TERMINOLOGY, EXT, TWCORE, PAS];

test("dependents: direct + transitive, honouring the core 4.0.0 → 4.0.1 alias", () => {
  const deps = dependentsOf(ALL, [CORE]);
  const labels = deps.map((d) => `${d.package_id}@${d.version}:${d.direct ? "direct" : "via " + d.via.package_id}`);
  assert.deepEqual(labels, [
    "hl7.fhir.uv.extensions.r4@5.1.0:direct",
    "hl7.terminology.r4@6.2.0:direct",
    "tw.gov.mohw.twcore@1.0.0:direct", // declared 4.0.0
    "tw.gov.mohw.nhi.pas@1.0.0:via tw.gov.mohw.twcore",
  ]);
  assert.equal(deps.find((d) => d.package_id === "tw.gov.mohw.twcore")?.is_default, true);
});

test("dependents: none for a leaf, and members of the removal set are not their own dependents", () => {
  assert.deepEqual(dependentsOf(ALL, [PAS]), []);
  assert.deepEqual(dependentsOf(ALL, [TWCORE, PAS]).map((d) => d.package_id), []);
});

test("dependents: cycles terminate", () => {
  const a = pkg("a", "1", { b: "1" });
  const b = pkg("b", "1", { a: "1" });
  assert.deepEqual(dependentsOf([a, b], [a]).map((d) => d.package_id), ["b"]);
});

test("plan: refuses removing a package with dependents (IG_HAS_DEPENDENTS) unless forced", () => {
  const refused = planRemoval(ALL, [TERMINOLOGY]);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.status, 409);
  assert.equal(refused.code, IG_REMOVAL_CODES.hasDependents);
  assert.deepEqual(refused.dependents.map((d) => d.package_id), ["tw.gov.mohw.twcore", "tw.gov.mohw.nhi.pas"]);

  const forced = planRemoval(ALL, [TERMINOLOGY], { force: true });
  assert.equal(forced.ok, true);
  if (!forced.ok) return;
  assert.equal(forced.forced, true);
  assert.equal(forced.broken.length, 2);
});

test("plan: refuses the default IG (IG_IS_DEFAULT) unless a new default is chosen or forced", () => {
  const set = [CORE, TERMINOLOGY, EXT, TWCORE, pkg("other.ig", "2.0.0")];
  const refused = planRemoval(set, [TWCORE]);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.code, IG_REMOVAL_CODES.isDefault);
  assert.equal(refused.removes_default, true);
  // manual installs first among the candidates
  assert.equal(refused.default_candidates[0].package_id, "other.ig");

  const withNew = planRemoval(set, [TWCORE], { newDefault: { package_id: "other.ig", version: "2.0.0" } });
  assert.equal(withNew.ok, true);
  if (withNew.ok) {
    assert.deepEqual(withNew.new_default, { package_id: "other.ig", version: "2.0.0" });
    assert.equal(withNew.forced, false);
  }

  const forced = planRemoval(set, [TWCORE], { force: true });
  assert.equal(forced.ok && forced.forced, true);
});

test("plan: both blockers are reported, dependents first", () => {
  const refused = planRemoval(ALL, [TWCORE]);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.deepEqual(refused.blockers, [IG_REMOVAL_CODES.hasDependents, IG_REMOVAL_CODES.isDefault]);
});

test("plan: the last remaining IG may be removed even though it is the default", () => {
  const only = pkg("solo", "1.0.0", {}, { is_default: true });
  assert.equal(planRemoval([only], [only]).ok, true);
});

test("plan: invalid new_default and unknown targets", () => {
  const set = [TWCORE, pkg("other.ig", "2.0.0")];
  const bad = planRemoval(set, [TWCORE], { newDefault: { package_id: "tw.gov.mohw.twcore", version: "1.0.0" } });
  assert.equal(!bad.ok && bad.code, IG_REMOVAL_CODES.invalidNewDefault);
  const missing = planRemoval(set, [{ package_id: "nope", version: "1" }]);
  assert.equal(!missing.ok && missing.code, IG_REMOVAL_CODES.notFound);
  assert.equal(!missing.ok && missing.status, 404);
  const none = planRemoval(set, []);
  assert.equal(!none.ok && none.code, IG_REMOVAL_CODES.noTargets);
});

test("unused: dependency installs nothing reachable from a root needs", () => {
  assert.deepEqual(unusedDependencies(ALL), []);
  // Drop twcore + pas: core/terminology/extensions are only dependency installs now.
  const left = [CORE, TERMINOLOGY, EXT];
  const unused = unusedDependencies(left);
  assert.deepEqual(unused.map((u) => u.package_id), ["hl7.fhir.r4.core", "hl7.fhir.uv.extensions.r4", "hl7.terminology.r4"]);
  assert.deepEqual(unused[0].needed_only_by.map((x) => x.package_id).sort(), ["hl7.fhir.uv.extensions.r4", "hl7.terminology.r4"]);
});

test("unused: manual, unknown-origin and default packages are roots, never unused", () => {
  const unknown = pkg("legacy", "1", { "hl7.fhir.r4.core": "4.0.0" }, { install_origin: null });
  assert.deepEqual(unusedDependencies([CORE, unknown]), []);
  const defDep = pkg("dep.default", "1", {}, { install_origin: "dependency", is_default: true });
  assert.deepEqual(unusedDependencies([defDep]), []);
});

test("orphanedBy: dependencies only kept alive by the removed set", () => {
  const set = [CORE, TERMINOLOGY, EXT, TWCORE];
  assert.deepEqual(orphanedBy(set, [TWCORE]).map((o) => o.package_id), [
    "hl7.fhir.r4.core",
    "hl7.fhir.uv.extensions.r4",
    "hl7.terminology.r4",
  ]);
  assert.deepEqual(orphanedBy(ALL, [PAS]), []);
});

test("plan: requireUnused rejects packages still in use (IG_DEPENDENCY_IN_USE)", () => {
  const refused = planRemoval(ALL, [CORE], { requireUnused: true });
  assert.equal(!refused.ok && refused.code, IG_REMOVAL_CODES.inUse);
  const left = [CORE, TERMINOLOGY, EXT];
  const ok = planRemoval(left, left, { requireUnused: true });
  assert.equal(ok.ok, true);
});

// ── Executor against a fake transaction ─────────────────────────────────────

function fakeDb(rows: InstalledIg[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let committed = 0;
  const client: TxClient = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("FOR UPDATE")) {
        return {
          rows: rows.map((r) => ({ ...r, dependencies: JSON.stringify(r.dependencies) })) as unknown as Record<string, unknown>[],
        };
      }
      return { rows: [] };
    },
  };
  return {
    calls,
    get committed() {
      return committed;
    },
    deps: {
      transaction: async <T,>(fn: (c: TxClient) => Promise<T>): Promise<T> => {
        const out = await fn(client);
        committed++;
        return out;
      },
      archives: [] as string[],
    },
  };
}

test("executor: a refused removal issues no DELETE and no audit row", async () => {
  const db = fakeDb(ALL);
  const out = await removeIgPackages(db.deps, { targets: [TERMINOLOGY], removedBy: "alice" });
  assert.equal(out.removed, false);
  assert.equal(!out.ok && out.code, IG_REMOVAL_CODES.hasDependents);
  assert.equal(db.calls.some((c) => /^(DELETE|INSERT|UPDATE)/.test(c.sql.trim())), false);
});

test("executor: forced removal deletes, audits who forced it and reports broken dependents", async () => {
  const db = fakeDb(ALL);
  const archives: string[] = [];
  const forcedEvents: unknown[] = [];
  const out = await removeIgPackages(
    {
      ...db.deps,
      removeArchive: async (t) => {
        archives.push(`${t.package_id}@${t.version}`);
        throw new Error("tarball missing"); // best-effort: must not fail the removal
      },
      onForced: (info) => forcedEvents.push(info),
    },
    { targets: [TERMINOLOGY], removedBy: "alice", force: true },
  );
  assert.equal(out.removed, true);
  if (!out.removed) return;
  assert.equal(out.forced, true);
  assert.deepEqual(out.dependents.map((d) => d.package_id), ["tw.gov.mohw.twcore", "tw.gov.mohw.nhi.pas"]);
  const del = db.calls.find((c) => c.sql.startsWith("DELETE FROM fhir.ig_packages"));
  assert.deepEqual(del?.params, ["hl7.terminology.r4", "6.2.0"]);
  const audit = db.calls.find((c) => c.sql.includes("admin.admin_audit_log"));
  assert.ok(audit);
  assert.equal(audit.params[0], "alice");
  assert.equal(audit.params[1], "remove_ig_forced");
  const payload = JSON.parse(String(audit.params[3]));
  assert.equal(payload.forced, true);
  assert.equal(payload.forced_by, "alice");
  assert.equal(payload.dependents.length, 2);
  assert.deepEqual(archives, ["hl7.terminology.r4@6.2.0"]);
  assert.equal(forcedEvents.length, 1);
});

test("executor: removing the default with new_default moves the default in the same transaction", async () => {
  const set = [TWCORE, pkg("other.ig", "2.0.0")];
  const db = fakeDb(set);
  const out = await removeIgPackages(db.deps, {
    targets: [TWCORE],
    removedBy: "bob",
    newDefault: { package_id: "other.ig", version: "2.0.0" },
  });
  assert.equal(out.removed, true);
  if (!out.removed) return;
  assert.equal(out.was_default, true);
  assert.equal(out.forced, false);
  const setNew = db.calls.find((c) => c.sql.includes("SET is_default = TRUE"));
  assert.deepEqual(setNew?.params, ["other.ig", "2.0.0"]);
  const audit = db.calls.find((c) => c.sql.includes("admin.admin_audit_log"));
  assert.equal(audit?.params[1], "remove_ig");
  assert.equal(JSON.parse(String(audit?.params[3])).new_default, "other.ig@2.0.0");
});

test("executor: bulk unused cleanup removes the whole set and audits each package", async () => {
  const left = [CORE, TERMINOLOGY, EXT, pkg("other.ig", "2.0.0")];
  const db = fakeDb(left);
  const out = await removeIgPackages(db.deps, {
    targets: [CORE, TERMINOLOGY, EXT],
    removedBy: "carol",
    requireUnused: true,
    reason: "unused_dependency_cleanup",
  });
  assert.equal(out.removed, true);
  assert.equal(db.calls.filter((c) => c.sql.startsWith("DELETE FROM fhir.ig_packages")).length, 3);
  const audits = db.calls.filter((c) => c.sql.includes("admin.admin_audit_log"));
  assert.equal(audits.length, 3);
  assert.equal(JSON.parse(String(audits[0].params[3])).reason, "unused_dependency_cleanup");
});
