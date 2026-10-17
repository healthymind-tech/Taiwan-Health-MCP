/**
 * fhirIg: SemVer ordering, closure + missing dependencies, version-aware canonical
 * lookup, reverse lookup and target-resolution precedence — over a faked DB.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as ig from "./fhirIg.js";

// --- fake DB ---------------------------------------------------------------- //

interface Pkg {
  package_id: string;
  version: string;
  is_default?: boolean;
  install_origin?: "manual" | "dependency";
  dependencies?: Record<string, string>;
  fhir_version?: string;
}
interface Art {
  package_id: string;
  package_version: string;
  resource_type: string;
  artifact_id: string;
  canonical_url: string;
  version?: string;
}

function fakeDb(pkgs: Pkg[], arts: Art[], opts: { noInstallOrigin?: boolean } = {}) {
  const pkgRow = (p: Pkg) => {
    const row: Record<string, unknown> = {
      package_id: p.package_id,
      version: p.version,
      canonical: null,
      fhir_version: p.fhir_version ?? "4.0.1",
      title: null,
      status: null,
      is_default: Boolean(p.is_default),
      dependencies: p.dependencies ?? {},
      imported_at: null,
    };
    if (!opts.noInstallOrigin) row.install_origin = p.install_origin ?? "dependency";
    return row;
  };
  const artRow = (a: Art) => ({
    ...a,
    raw_json: { resourceType: a.resource_type, id: a.artifact_id, url: a.canonical_url, ...(a.version ? { version: a.version } : {}) },
    artifact_version: a.version ?? null,
  });
  return async (text: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
    if (text.includes("FROM fhir.ig_packages ORDER BY")) {
      if (text.includes("install_origin") && opts.noInstallOrigin) {
        throw Object.assign(new Error('column "install_origin" does not exist'), { code: "42703" });
      }
      return { rows: pkgs.map(pkgRow) };
    }
    if (text.includes("WITH ORDINALITY AS dep(pid, pver, ord)")) {
      const [pids, pvers, url, rt] = params as [string[], string[], string, string | undefined];
      const rows: any[] = [];
      pids.forEach((pid, i) => {
        for (const a of arts) {
          if (a.package_id === pid && a.package_version === pvers[i] && a.canonical_url === url && (!rt || a.resource_type === rt)) {
            const p = pkgs.find((x) => x.package_id === pid && x.version === pvers[i]);
            rows.push({ ...artRow(a), ord: i + 1, package_fhir_version: p?.fhir_version ?? "4.0.1" });
          }
        }
      });
      return { rows };
    }
    if (text.includes("WHERE a.canonical_url = ANY")) {
      const urls = params[0] as string[];
      return { rows: arts.filter((a) => urls.includes(a.canonical_url)).map(artRow) };
    }
    if (text.includes("WHERE a.artifact_id = ANY")) {
      const ids = params[0] as string[];
      let hits = arts.filter((a) => ids.includes(a.artifact_id));
      if (text.includes("unnest")) {
        const pids = params[1] as string[];
        const pvers = params[2] as string[];
        hits = hits.filter((a) => pids.some((p, i) => p === a.package_id && pvers[i] === a.package_version));
      }
      return { rows: hits.map(artRow) };
    }
    if (text.startsWith("SELECT * FROM fhir.artifacts WHERE package_id = $1")) {
      const [pid, pver, url] = params as string[];
      return { rows: arts.filter((a) => a.package_id === pid && a.package_version === pver && a.canonical_url === url).map(artRow) };
    }
    throw new Error(`unexpected query: ${text}`);
  };
}

afterEach(() => ig.setIgQueryForTests(null));

// --- fixtures ----------------------------------------------------------------- //

const CORE = { package_id: "hl7.fhir.r4.core", version: "4.0.1" };
const TWC = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Patient-twcore";
const PAS_CLAIM = "https://nhicore.nhi.gov.tw/pas/StructureDefinition/Claim-twpas";

function world(opts: { defaultIg?: boolean; pasManual?: boolean } = {}): { pkgs: Pkg[]; arts: Art[] } {
  const pkgs: Pkg[] = [
    CORE,
    { package_id: "tw.gov.mohw.twcore", version: "1.0.0", is_default: opts.defaultIg ?? true, install_origin: "manual", dependencies: { "hl7.fhir.r4.core": "4.0.1" } },
    { package_id: "tw.gov.mohw.twcore", version: "0.3.2", install_origin: "dependency", dependencies: { "hl7.fhir.r4.core": "4.0.0" } },
    {
      package_id: "tw.gov.mohw.nhi.pas",
      version: "1.2.7",
      install_origin: opts.pasManual === false ? "dependency" : "manual",
      dependencies: { "tw.gov.mohw.twcore": "0.3.2", "hl7.fhir.r4.core": "4.0.1" },
    },
  ];
  const arts: Art[] = [
    { package_id: "hl7.fhir.r4.core", package_version: "4.0.1", resource_type: "StructureDefinition", artifact_id: "Patient", canonical_url: "http://hl7.org/fhir/StructureDefinition/Patient", version: "4.0.1" },
    { package_id: "tw.gov.mohw.twcore", package_version: "1.0.0", resource_type: "StructureDefinition", artifact_id: "Patient-twcore", canonical_url: TWC, version: "1.0.0" },
    { package_id: "tw.gov.mohw.twcore", package_version: "0.3.2", resource_type: "StructureDefinition", artifact_id: "Patient-twcore", canonical_url: TWC, version: "0.3.2" },
    { package_id: "tw.gov.mohw.nhi.pas", package_version: "1.2.7", resource_type: "StructureDefinition", artifact_id: "Claim-twpas", canonical_url: PAS_CLAIM, version: "1.2.7" },
  ];
  return { pkgs, arts };
}

// --- SemVer ------------------------------------------------------------------- //

test("compareVersions: release above its pre-releases, numeric parts numerically", () => {
  const sorted = ["5.3.0", "5.3.0-ballot-tc1", "5.10.0", "5.2.0", "1.0.0-cibuild", "1.0.0", "5.1.0-snapshot1", "5.1.0"].sort(ig.compareVersions);
  assert.deepEqual(sorted, ["1.0.0-cibuild", "1.0.0", "5.1.0-snapshot1", "5.1.0", "5.2.0", "5.3.0-ballot-tc1", "5.3.0", "5.10.0"]);
});

test("compareVersions: SemVer 2.0 §11 example order + build metadata ignored", () => {
  const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i + 1 < chain.length; i++) assert.ok(ig.compareVersions(chain[i], chain[i + 1]) < 0, `${chain[i]} < ${chain[i + 1]}`);
  assert.equal(ig.compareVersions("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(ig.compareVersions("4.0", "4.0.0"), 0);
  assert.ok(ig.compareVersions("3.0.0-ballot2", "3.0.0-ballot10") < 0, "natural order inside an identifier");
  assert.ok(ig.compareVersions("current", "0.0.1") < 0, "non-numeric versions sort lowest");
});

test("latestVersion: highest release; pre-release only when no release exists or asked for", () => {
  assert.equal(ig.latestVersion(["5.1.0", "5.3.0-ballot-tc1", "5.3.0", "5.2.0", "1.0.0"]), "5.3.0");
  assert.equal(ig.latestVersion(["5.1.0", "6.0.0-ballot"]), "5.1.0");
  assert.equal(ig.latestVersion(["5.1.0", "6.0.0-ballot"], { includePrerelease: true }), "6.0.0-ballot");
  assert.equal(ig.latestVersion(["3.0.0-ballot", "2.0.0-snapshot1"]), "3.0.0-ballot");
  assert.equal(ig.latestVersion([]), null);
  assert.ok(ig.isPrerelease("5.1.0-snapshot1") && !ig.isPrerelease("2022.4.20221006"));
});

test("versionMatches / splitCanonical", () => {
  assert.ok(ig.versionMatches("1.0.0", "1.0.0"));
  assert.ok(ig.versionMatches("1.0", "1.0.2"));
  assert.ok(ig.versionMatches("1.0.x", "1.0.7"));
  assert.ok(!ig.versionMatches("1.0", "1.1.0"));
  assert.ok(!ig.versionMatches("1.0", "1.0.0-ballot"));
  assert.ok(!ig.versionMatches("9.9.9", "1.0.0"));
  assert.deepEqual(ig.splitCanonical(`${TWC}|0.3.2`), { url: TWC, version: "0.3.2" });
  assert.deepEqual(ig.splitCanonical(TWC), { url: TWC, version: null });
  assert.deepEqual(ig.splitCanonical(`${TWC}|`), { url: TWC, version: null });
});

test("resolvePackage(package_id) without version picks the highest release, not a pre-release", async () => {
  const pkgs: Pkg[] = ["1.0.0", "5.1.0", "5.2.0", "5.3.0", "5.3.0-ballot-tc1"].map((v) => ({ package_id: "hl7.fhir.uv.extensions.r4", version: v }));
  ig.setIgQueryForTests(fakeDb(pkgs, []));
  assert.deepEqual(await ig.resolvePackage({ packageId: "hl7.fhir.uv.extensions.r4" }), ["hl7.fhir.uv.extensions.r4", "5.3.0"]);
  assert.deepEqual(await ig.resolvePackage({ packageId: "hl7.fhir.uv.extensions.r4", version: "5.3.0-ballot-tc1" }), ["hl7.fhir.uv.extensions.r4", "5.3.0-ballot-tc1"]);
  await assert.rejects(ig.resolvePackage({ packageId: "hl7.fhir.uv.extensions.r4", version: "9.9.9" }), (e: any) => e.code === "IG_NOT_FOUND");
});

// --- no default IG -------------------------------------------------------------- //

test("no default IG: the only manual IG is used, otherwise NO_DEFAULT_IG (never an arbitrary package)", async () => {
  const w = world({ defaultIg: false });
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  await assert.rejects(ig.resolvePackage(null), (e: any) => e instanceof ig.NoDefaultIGError && e.code === "NO_DEFAULT_IG" && /package_id/.test(e.message));
  await assert.rejects(ig.resolveTarget({}), (e: any) => e.code === "NO_DEFAULT_IG");

  const single = world({ defaultIg: false, pasManual: false });
  ig.setIgQueryForTests(fakeDb(single.pkgs, single.arts));
  assert.deepEqual(await ig.resolvePackage(null), ["tw.gov.mohw.twcore", "1.0.0"]);
  assert.equal((await ig.resolveTarget({})).resolvedBy, "sole_manual_ig");

  // install_origin column absent (migration not applied): no guessing either.
  const one = world({ defaultIg: false, pasManual: false });
  ig.setIgQueryForTests(fakeDb(one.pkgs, one.arts, { noInstallOrigin: true }));
  await assert.rejects(ig.resolvePackage(null), (e: any) => e.code === "NO_DEFAULT_IG");
  assert.equal(await ig.resolveDefaultPackage(), null);
});

test("no default IG: a meta.profile owner still resolves", async () => {
  const w = world({ defaultIg: false });
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const t = await ig.resolveTarget({ metaProfiles: [PAS_CLAIM] });
  assert.equal(t.pkg.package_id, "tw.gov.mohw.nhi.pas");
  assert.equal(t.resolvedBy, "meta_profile");
});

// --- closure ----------------------------------------------------------------------- //

test("packageClosureInfo: BFS order, r4.core 4.0.0 alias, missing dependencies reported", async () => {
  const pkgs: Pkg[] = [
    CORE,
    { package_id: "a", version: "1.0.0", dependencies: { b: "2.0.0", "hl7.fhir.r4.core": "4.0.0", gone: "1.0.0" } },
    { package_id: "b", version: "2.0.0", dependencies: { gone: "1.0.0", "hl7.fhir.r4.core": "4.0.1" } },
  ];
  ig.setIgQueryForTests(fakeDb(pkgs, []));
  const info = await ig.packageClosureInfo("a", "1.0.0");
  assert.deepEqual(info.closure, [["a", "1.0.0"], ["b", "2.0.0"], ["hl7.fhir.r4.core", "4.0.1"], ["gone", "1.0.0"]]);
  assert.deepEqual(info.depsMissing, [{ package_id: "gone", version: "1.0.0", required_by: "a#1.0.0" }]);
  assert.deepEqual(await ig.packageClosure("a", "1.0.0"), info.closure);
});

test("closureVersions: several versions of one package, which one lookups prefer", () => {
  const cv = ig.closureVersions([
    ["pas", "1"],
    ["hl7.fhir.uv.extensions.r4", "5.3.0"],
    ["hl7.terminology.r4", "6.1.0"],
    ["hl7.fhir.uv.extensions.r4", "5.1.0"],
    ["hl7.terminology.r4", "7.4.0"],
  ]);
  assert.deepEqual(cv, {
    "hl7.fhir.uv.extensions.r4": { used: "5.3.0", versions: ["5.3.0", "5.1.0"], rule: "closure_order" },
    "hl7.terminology.r4": { used: "7.4.0", versions: ["6.1.0", "7.4.0"], rule: "newest_terminology" },
  });
  assert.equal(ig.closureVersions([["a", "1"], ["b", "1"]]), null);
});

// --- canonical lookup ---------------------------------------------------------------- //

test("resolveCanonicalVersioned honours |version (artifact version), null when that version is absent", async () => {
  const w = world();
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const pasClosure = (await ig.packageClosureInfo("tw.gov.mohw.nhi.pas", "1.2.7")).closure;
  const both: Array<[string, string]> = [["tw.gov.mohw.twcore", "1.0.0"], ...pasClosure];

  const unpinned = await ig.resolveCanonicalVersioned(TWC, both);
  assert.equal(unpinned?.package_version, "1.0.0", "closure order without a version");
  const pinned = await ig.resolveCanonicalVersioned(`${TWC}|0.3.2`, both);
  assert.equal(pinned?.package_version, "0.3.2");
  const viaOpt = await ig.resolveCanonicalVersioned(TWC, both, { version: "0.3.2" });
  assert.equal(viaOpt?.package_version, "0.3.2");
  assert.equal(await ig.resolveCanonicalVersioned(`${TWC}|9.9.9`, both), null);
  assert.equal(await ig.resolveCanonicalVersioned(`${TWC}|1.0.0`, pasClosure), null, "1.0.0 is not in the PAS closure");
  // PackageRow form (uses _closure)
  const row = await ig.resolveCanonicalVersioned(`${TWC}|0.3.2`, { package_id: "tw.gov.mohw.nhi.pas", version: "1.2.7", _closure: pasClosure });
  assert.equal(row?.package_id, "tw.gov.mohw.twcore");
  // legacy signature still works
  assert.equal((await ig.resolveCanonical(TWC, "tw.gov.mohw.nhi.pas", "1.2.7"))?.package_version, "0.3.2");
});

test("resolveCanonicalVersioned: artifact without its own version matches on the package version", async () => {
  const pkgs: Pkg[] = [{ package_id: "x", version: "2.1.0" }];
  const arts: Art[] = [{ package_id: "x", package_version: "2.1.0", resource_type: "ValueSet", artifact_id: "vs", canonical_url: "http://x/vs" }];
  ig.setIgQueryForTests(fakeDb(pkgs, arts));
  assert.equal((await ig.resolveCanonicalVersioned("http://x/vs|2.1.0", [["x", "2.1.0"]]))?.artifact_id, "vs");
  assert.equal(await ig.resolveCanonicalVersioned("http://x/vs|2.0.0", [["x", "2.1.0"]]), null);
});

test("resolveCanonicalVersioned follows the HL7 same-major.minor rule (matches the validator)", async () => {
  const pkgs: Pkg[] = [{ package_id: "x", version: "2.1.0" }];
  const arts: Art[] = [{ package_id: "x", package_version: "2.1.0", resource_type: "ValueSet", artifact_id: "vs", canonical_url: "http://x/vs" }];
  ig.setIgQueryForTests(fakeDb(pkgs, arts));
  // An uninstalled patch of an installed major.minor resolves to it, as in CanonicalResourceManager.getByPackage.
  assert.equal((await ig.resolveCanonicalVersioned("http://x/vs|2.1.9", [["x", "2.1.0"]]))?.artifact_id, "vs");
  assert.equal((await ig.resolveCanonicalVersioned("http://x/vs|2.1", [["x", "2.1.0"]]))?.artifact_id, "vs");
  assert.equal(await ig.resolveCanonicalVersioned("http://x/vs|2.2.0", [["x", "2.1.0"]]), null);
});

test("findPackagesForCanonical: manual > default > release > higher version > package_id", async () => {
  const pkgs: Pkg[] = [
    { package_id: "dep.b", version: "2.0.0" },
    { package_id: "dep.a", version: "2.0.0" },
    { package_id: "dep.a", version: "3.0.0-ballot" },
    { package_id: "dep.a", version: "1.0.0" },
    { package_id: "root", version: "1.0.0", install_origin: "manual" },
  ];
  const url = "http://x/StructureDefinition/p";
  const arts: Art[] = pkgs.map((p) => ({ package_id: p.package_id, package_version: p.version, resource_type: "StructureDefinition", artifact_id: "p", canonical_url: url }));
  ig.setIgQueryForTests(fakeDb(pkgs, arts));
  const owners = await ig.findPackagesForCanonical(url);
  assert.deepEqual(
    owners.map((o) => `${o.package_id}#${o.package_version}`),
    ["root#1.0.0", "dep.a#2.0.0", "dep.b#2.0.0", "dep.a#1.0.0", "dep.a#3.0.0-ballot"],
  );
  assert.deepEqual((await ig.findPackagesForCanonical(`${url}|1.0.0`)).map((o) => o.package_id), ["root", "dep.a"]);
  assert.deepEqual(await ig.findPackagesForCanonical(`${url}|9.9.9`), []);
});

// --- resolution precedence -------------------------------------------------------------- //

test("resolveTarget: package_id wins over meta.profile; no version → highest release ('latest')", async () => {
  const w = world();
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const a = await ig.resolveTarget({ packageId: "tw.gov.mohw.twcore", version: "1.0.0", metaProfiles: [PAS_CLAIM] });
  assert.equal(a.pkg.package_id, "tw.gov.mohw.twcore");
  assert.equal(a.resolvedBy, "package_arg");
  const b = await ig.resolveTarget({ packageId: "tw.gov.mohw.twcore" });
  assert.equal(b.pkg.version, "1.0.0");
  assert.equal(b.resolvedBy, "package_arg", "the default IG's version");
  w.pkgs[1].is_default = false;
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const c = await ig.resolveTarget({ packageId: "tw.gov.mohw.twcore" });
  assert.equal(c.pkg.version, "1.0.0");
  assert.equal(c.resolvedBy, "latest");
});

test("resolveTarget: meta.profile owner when the default IG lacks it; default when it covers", async () => {
  const w = world();
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const pas = await ig.resolveTarget({ metaProfiles: [PAS_CLAIM] });
  assert.equal(`${pas.pkg.package_id}#${pas.pkg.version}`, "tw.gov.mohw.nhi.pas#1.2.7");
  assert.equal(pas.resolvedBy, "meta_profile");
  assert.ok(pas.closure.some(([p, v]) => p === "tw.gov.mohw.twcore" && v === "0.3.2"));
  assert.deepEqual(pas.pkg._closure, pas.closure);

  const tw = await ig.resolveTarget({ metaProfiles: [TWC] });
  assert.equal(tw.pkg.package_id, "tw.gov.mohw.twcore");
  assert.equal(tw.pkg.version, "1.0.0");
  assert.equal(tw.resolvedBy, "default_ig");

  const none = await ig.resolveTarget({ metaProfiles: ["http://nowhere/StructureDefinition/x"] });
  assert.equal(none.resolvedBy, "default_ig");
});

test("resolveTarget: explicit |version picks a package holding that version (manual root preferred)", async () => {
  const w = world();
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const t = await ig.resolveTarget({ metaProfiles: [`${TWC}|0.3.2`] });
  assert.equal(t.resolvedBy, "explicit_version");
  assert.equal(t.pkg.package_id, "tw.gov.mohw.nhi.pas", "manual root whose closure holds twcore 0.3.2");

  // Without a manual root, the owner itself.
  const w2 = world({ pasManual: false });
  ig.setIgQueryForTests(fakeDb(w2.pkgs, w2.arts));
  const t2 = await ig.resolveTarget({ metaProfiles: [`${TWC}|0.3.2`] });
  assert.equal(t2.resolvedBy, "explicit_version");
  assert.equal(`${t2.pkg.package_id}#${t2.pkg.version}`, "tw.gov.mohw.twcore#0.3.2", "the owning package itself");

  const pinnedDefault = await ig.resolveTarget({ metaProfiles: [`${TWC}|1.0.0`] });
  assert.equal(pinnedDefault.resolvedBy, "default_ig");

  const missing = await ig.resolveTarget({ metaProfiles: [`${TWC}|9.9.9`] });
  assert.equal(missing.resolvedBy, "default_ig");
  assert.ok(missing.notes.some((n) => /9\.9\.9/.test(n)));
});

test("resolveTarget: explicit |version on a tool argument overrides package_id lacking it", async () => {
  const w = world();
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const t = await ig.resolveTarget({ packageId: "tw.gov.mohw.twcore", version: "1.0.0", canonicals: [`${TWC}|0.3.2`] });
  assert.equal(t.resolvedBy, "explicit_version");
  assert.notEqual(t.pkg.version, "1.0.0");
  assert.ok(t.notes.length === 1);
  // meta.profile versions never override an explicit package_id (validation verdicts stay put)
  const v = await ig.resolveTarget({ packageId: "tw.gov.mohw.twcore", version: "1.0.0", metaProfiles: [`${TWC}|0.3.2`] });
  assert.equal(v.resolvedBy, "package_arg");
  assert.equal(v.pkg.version, "1.0.0");
});

test("resolveTarget: bare id tool argument resolves to its owner (canonical_owner)", async () => {
  const w = world();
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const t = await ig.resolveTarget({ canonicals: ["Claim-twpas"] });
  assert.equal(t.pkg.package_id, "tw.gov.mohw.nhi.pas");
  assert.equal(t.resolvedBy, "canonical_owner");
  const d = await ig.resolveTarget({ canonicals: ["Patient-twcore"] });
  assert.equal(d.resolvedBy, "default_ig");
});

test("resolveTarget: tie-break on equal coverage is deterministic (manual, then version, then id)", async () => {
  const url = "http://x/StructureDefinition/shared";
  const pkgs: Pkg[] = [
    { package_id: "z.ig", version: "1.0.0", install_origin: "manual" },
    { package_id: "a.ig", version: "1.0.0", install_origin: "manual" },
    { package_id: "a.ig", version: "2.0.0-ballot", install_origin: "manual" },
    { package_id: "m.ig", version: "9.0.0", install_origin: "dependency" },
  ];
  const arts: Art[] = pkgs.map((p) => ({ package_id: p.package_id, package_version: p.version, resource_type: "StructureDefinition", artifact_id: "shared", canonical_url: url }));
  ig.setIgQueryForTests(fakeDb(pkgs, arts));
  for (let i = 0; i < 3; i++) {
    const t = await ig.resolveTarget({ metaProfiles: [url] });
    assert.equal(`${t.pkg.package_id}#${t.pkg.version}`, "a.ig#1.0.0");
  }
});

test("resolveTarget surfaces missing dependencies of the chosen closure", async () => {
  const w = world();
  w.pkgs[3].dependencies = { ...w.pkgs[3].dependencies, "hl7.fhir.us.davinci-pas": "2.2.1" };
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const t = await ig.resolveTarget({ metaProfiles: [PAS_CLAIM] });
  assert.deepEqual(t.depsMissing, [{ package_id: "hl7.fhir.us.davinci-pas", version: "2.2.1", required_by: "tw.gov.mohw.nhi.pas#1.2.7" }]);
});

test("resolveTarget: a pinned meta.profile missing from package_id's closure is only noted", async () => {
  const w = world();
  ig.setIgQueryForTests(fakeDb(w.pkgs, w.arts));
  const t = await ig.resolveTarget({ packageId: "tw.gov.mohw.twcore", version: "1.0.0", metaProfiles: [`${TWC}|9.9.9`] });
  assert.equal(t.resolvedBy, "package_arg");
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0], /9\.9\.9/);
});

test("metaProfilesOf: own meta.profile plus Bundle entries (nested), de-duplicated", async () => {
  const { metaProfilesOf } = await import("./fhirIgService.js");
  const bundle = {
    resourceType: "Bundle",
    meta: { profile: ["B"] },
    entry: [
      { resource: { resourceType: "Claim", meta: { profile: ["C", "B"] } } },
      { resource: { resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", meta: { profile: ["P|1.0.0"] } } }] } },
      {},
    ],
  };
  assert.deepEqual(metaProfilesOf(bundle), ["B", "C", "P|1.0.0"]);
  assert.deepEqual(metaProfilesOf({ resourceType: "Patient" }), []);
});
