import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  applyBundledSupplements,
  BUNDLED_ORIGIN,
  bundledDataDir,
  ensureBundledAbbreviationLexicon,
  listBundledSupplements,
  OPT_OUT_GROUP,
  parseBundledLexicon,
  planBundledSupplements,
  readBundledLexicon,
} from "./bundled.js";
import { buildConceptIndex, selectIndexableCodeSystems } from "./indexBuilder.js";

const PAYMENT = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medical-service-payment-tw";
const SUP_URL = "https://example.org/fhir/CodeSystem/demo-en";

// ───────────────────────────────────────────────────────────── in-memory fake database

interface Art {
  package_id: string;
  package_version: string;
  artifact_key: string;
  resource_type: string;
  artifact_id: string | null;
  raw_json: Record<string, any>;
  imported_at: Date;
}
interface SupRow {
  url: string;
  version: string;
  supplements: string;
  raw_json: Record<string, any>;
  uploaded_by: string;
  uploaded_at: Date;
}

/**
 * Just enough of Postgres for the bundled apply, the lexicon load, the status helper and
 * buildConceptIndex: each statement those modules send is matched by a pattern.
 */
class FakeDb {
  packages: Array<{ package_id: string; version: string }> = [];
  artifacts: Art[] = [];
  supplements: SupRow[] = [];
  settings = new Map<string, string>(); // `${group}\u0000${key}` → value
  indexCs: Array<{ package_id: string; package_version: string; cs_url: string; signature: string; supplements: string }> = [];
  terms: Array<{ cs_url: string; code: string; term: string; kind: string }> = [];
  lexicon: string[][] = [];
  lexiconTable = true;
  writes = 0;
  private clock = 0;

  now(): Date {
    this.clock += 1000;
    return new Date(Date.UTC(2026, 9, 19) + this.clock);
  }

  installPackage(id: string, version: string, codeSystems: Array<Record<string, any>>): void {
    this.packages.push({ package_id: id, version });
    for (const cs of codeSystems) {
      this.artifacts.push({
        package_id: id, package_version: version, artifact_key: `CodeSystem/${cs.id}`, resource_type: "CodeSystem",
        artifact_id: cs.id, raw_json: cs, imported_at: this.now(),
      });
    }
  }

  connect = async () => ({ query: this.query, release: () => undefined });

  query = async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
    const s = sql.replace(/\s+/g, " ").trim();
    const ok = (rows: any[] = [], rowCount = rows.length) => ({ rows, rowCount });
    const csArts = () => this.artifacts.filter((a) => a.resource_type === "CodeSystem");
    const urlOf = (a: Art) => a.raw_json.url as string;
    if (/^(BEGIN|COMMIT|ROLLBACK|LOCK TABLE)/.test(s)) return ok();
    // admin.app_settings (opt-outs)
    if (s.startsWith("SELECT key FROM admin.app_settings")) {
      return ok([...this.settings.keys()].filter((k) => k.startsWith(`${params[0]}\u0000`)).map((k) => ({ key: k.split("\u0000")[1] })));
    }
    if (s.startsWith("INSERT INTO admin.app_settings")) {
      this.settings.set(`${params[0]}\u0000${params[1]}`, params[2]);
      return ok([], 1);
    }
    if (s.startsWith("DELETE FROM admin.app_settings")) {
      const gone = [...this.settings.keys()].filter((k) => k.startsWith(`${params[0]}\u0000`) && (params.length < 2 || k.endsWith(`\u0000${params[1]}`)));
      for (const k of gone) this.settings.delete(k);
      return ok(gone.map((k) => ({ key: k.split("\u0000")[1] })));
    }
    // fhir.codesystem_supplements
    if (s.startsWith("SELECT url, version, uploaded_by FROM fhir.codesystem_supplements")) {
      return ok(this.supplements.filter((r) => params[0].includes(r.url)).map(({ url, version, uploaded_by }) => ({ url, version, uploaded_by })));
    }
    if (s.startsWith("SELECT url, version, supplements, uploaded_at FROM fhir.codesystem_supplements")) {
      return ok(this.supplements.map(({ url, version, supplements, uploaded_at }) => ({ url, version, supplements, uploaded_at })));
    }
    if (s.startsWith("SELECT raw_json FROM fhir.codesystem_supplements")) {
      return ok(this.supplements.filter((r) => r.url === params[0] && r.version === params[1]).map((r) => ({ raw_json: r.raw_json })));
    }
    if (s.startsWith("DELETE FROM fhir.codesystem_supplements WHERE url = $1 AND uploaded_by = $2")) {
      const before = this.supplements.length;
      this.supplements = this.supplements.filter((r) => !(r.url === params[0] && r.uploaded_by === params[1] && r.version !== params[2]));
      this.writes += 1;
      return ok([], before - this.supplements.length);
    }
    if (s.startsWith("INSERT INTO fhir.codesystem_supplements")) {
      const [url, version, supplements, , , , raw, by] = params;
      if (this.supplements.some((r) => r.url === url && r.version === version)) {
        assert.ok(s.includes("DO NOTHING"), "bundled apply must never overwrite a stored row");
        return ok([], 0);
      }
      this.supplements.push({ url, version, supplements, raw_json: JSON.parse(raw), uploaded_by: by, uploaded_at: this.now() });
      this.writes += 1;
      return ok([], 1);
    }
    // fhir.artifacts
    if (s.startsWith("SELECT DISTINCT COALESCE(raw_json->>'url', canonical_url) AS url")) {
      return ok(csArts().filter((a) => a.raw_json.content !== "supplement" && params[0].includes(urlOf(a))).map((a) => ({ url: urlOf(a), version: a.raw_json.version ?? null })));
    }
    if (s.startsWith("SELECT DISTINCT package_id, package_version AS version FROM fhir.artifacts")) {
      const seen = new Map<string, { package_id: string; version: string }>();
      for (const a of csArts()) if (a.raw_json.content !== "supplement" && params[0].includes(urlOf(a))) seen.set(`${a.package_id}#${a.package_version}`, { package_id: a.package_id, version: a.package_version });
      return ok([...seen.values()]);
    }
    if (s.includes("FROM fhir.artifacts WHERE resource_type = 'CodeSystem' AND raw_json->>'content' = 'supplement'")) return ok([]);
    if (s.includes("FROM fhir.artifacts WHERE resource_type = 'ConceptMap'")) return ok([]);
    if (s.startsWith("SELECT artifact_key, artifact_id, COALESCE(raw_json->>'url', canonical_url) AS url")) {
      return ok(
        csArts()
          .filter((a) => a.package_id === params[0] && a.package_version === params[1])
          .map((a) => ({
            artifact_key: a.artifact_key, artifact_id: a.artifact_id, url: urlOf(a), version: a.raw_json.version ?? null, content: a.raw_json.content ?? null,
            imported_at: a.imported_at, title: a.raw_json.title ?? null, name: a.raw_json.name ?? null, language: a.raw_json.language ?? null,
          })),
      );
    }
    if (s.startsWith("SELECT package_id, package_version, artifact_id, COALESCE(raw_json->>'url', canonical_url) AS url, raw_json->>'content'")) {
      return ok(
        csArts()
          .filter((a) => params[0].includes(`${a.package_id}#${a.package_version}`))
          .map((a) => ({ package_id: a.package_id, package_version: a.package_version, artifact_id: a.artifact_id, url: urlOf(a), content: a.raw_json.content ?? null })),
      );
    }
    if (s.startsWith("SELECT raw_json FROM fhir.artifacts")) {
      return ok(this.artifacts.filter((a) => a.package_id === params[0] && a.package_version === params[1] && a.artifact_key === params[2]).map((a) => ({ raw_json: a.raw_json })));
    }
    // fhir.ig_packages / concept index
    if (s.startsWith("SELECT package_id, version FROM fhir.ig_packages")) return ok([...this.packages]);
    if (s.startsWith("SELECT p.package_id, p.version FROM fhir.ig_packages p WHERE NOT EXISTS")) {
      return ok(this.packages.filter((p) => !this.indexCs.some((c) => c.package_id === p.package_id && c.package_version === p.version)));
    }
    if (s.startsWith("SELECT release, loaded_at FROM fhir.umls_release")) throw new Error('relation "fhir.umls_release" does not exist');
    if (s.startsWith("SELECT signature FROM fhir.concept_index_cs")) {
      return ok(this.indexCs.filter((c) => c.package_id === params[0] && c.package_version === params[1] && c.cs_url === params[2]));
    }
    if (s.startsWith("DELETE FROM fhir.concept_index_cs WHERE package_id=$1 AND package_version=$2 AND cs_url=$3")) {
      this.indexCs = this.indexCs.filter((c) => !(c.package_id === params[0] && c.package_version === params[1] && c.cs_url === params[2]));
      this.terms = this.terms.filter((t) => t.cs_url !== params[2]);
      return ok();
    }
    if (s.startsWith("DELETE FROM fhir.concept_index_cs WHERE package_id=$1 AND package_version=$2 AND NOT")) return ok();
    if (s.startsWith("INSERT INTO fhir.concept_index_cs")) {
      this.indexCs.push({ package_id: params[0], package_version: params[1], cs_url: params[2], supplements: params[10], signature: params[11] });
      return ok([], 1);
    }
    if (s.startsWith("INSERT INTO fhir.concept_index_concepts")) return ok();
    if (s.startsWith("INSERT INTO fhir.concept_index_terms")) {
      const [, , csUrl, codes, terms, , kinds] = params;
      codes.forEach((c: string, i: number) => this.terms.push({ cs_url: csUrl, code: c, term: terms[i], kind: kinds[i] }));
      return ok();
    }
    // abbreviation lexicon
    if (s.startsWith("SELECT to_regclass('fhir.abbreviation_lexicon')")) return ok([{ t: this.lexiconTable ? "fhir.abbreviation_lexicon" : null }]);
    if (s.startsWith("SELECT 1 FROM fhir.abbreviation_lexicon")) return ok(this.lexicon.length ? [{ "?column?": 1 }] : []);
    if (s.startsWith("INSERT INTO fhir.abbreviation_lexicon")) {
      const [k, a, e, t, src] = params;
      k.forEach((_: string, i: number) => this.lexicon.push([k[i], a[i], e[i], t[i], src]));
      return ok([], k.length);
    }
    throw new Error(`FakeDb: unexpected SQL: ${s.slice(0, 160)}`);
  };
}

const paymentCs = (version = "1.0.0"): Record<string, any> => ({
  resourceType: "CodeSystem", id: "medical-service-payment-tw", url: PAYMENT, version, content: "complete", language: "zh-TW",
  concept: [
    { code: "09001C", display: "總膽固醇" },
    { code: "09002C", display: "血中尿素氮" },
  ],
});

const demoSupplement = (version: string, target = PAYMENT): Record<string, any> => ({
  resourceType: "CodeSystem", id: "demo-en", url: SUP_URL, version, name: "DemoEn", title: "Demo English names", status: "active",
  content: "supplement", supplements: target,
  concept: [
    { code: "09001C", designation: [{ language: "en", value: "Total cholesterol" }] },
    { code: "09002C", designation: [{ language: "en", value: "Blood urea nitrogen" }] },
  ],
});

/** A temporary bundled-data dir holding the given supplements (and optionally a lexicon). */
function dataDir(sups: Array<Record<string, any>>, lexicon?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-test-"));
  fs.mkdirSync(path.join(dir, "supplements"));
  for (const s of sups) fs.writeFileSync(path.join(dir, "supplements", `CodeSystem-${s.id}-${s.version}.json.gz`), zlib.gzipSync(JSON.stringify(s)));
  if (lexicon !== undefined) {
    fs.mkdirSync(path.join(dir, "abbreviations"));
    fs.writeFileSync(path.join(dir, "abbreviations", "lrabr-test.tsv.gz"), zlib.gzipSync(lexicon));
  }
  return dir;
}

// ───────────────────────────────────────────────────────────────────────── plan (pure)

test("planBundledSupplements: insert / present / opt-out / conflict / target missing / upgrade", () => {
  const b = [{ url: SUP_URL, version: "2", supplements: PAYMENT }];
  const installed = [{ url: PAYMENT, version: "1.0.0" }];
  const plan = (stored: Array<{ url: string; version: string; uploaded_by: string }>, optedOut: string[] = [], inst = installed) =>
    planBundledSupplements({ bundled: b, stored, optedOut: new Set(optedOut), installed: inst })[0];
  assert.equal(plan([]).action, "insert");
  // Same url+version stored by an operator (production: uploaded by hand) → left alone.
  assert.deepEqual(plan([{ url: SUP_URL, version: "2", uploaded_by: "admin" }]), { url: SUP_URL, version: "2", supplements: PAYMENT, action: "present", storedBy: "admin" });
  assert.equal(plan([{ url: SUP_URL, version: "2", uploaded_by: BUNDLED_ORIGIN }]).action, "present");
  assert.equal(plan([], [SUP_URL]).action, "opted_out");
  assert.deepEqual(plan([{ url: SUP_URL, version: "1", uploaded_by: "alice" }]).versions, ["1"]);
  assert.equal(plan([{ url: SUP_URL, version: "1", uploaded_by: "alice" }]).action, "conflict");
  assert.equal(plan([], [], []).action, "target_missing");
  assert.equal(plan([{ url: SUP_URL, version: "1", uploaded_by: BUNDLED_ORIGIN }]).action, "upgrade");
  // A version-pinned target needs that CodeSystem version installed.
  const pinned = planBundledSupplements({ bundled: [{ url: SUP_URL, version: "2", supplements: `${PAYMENT}|0.3.2` }], stored: [], optedOut: new Set(), installed })[0];
  assert.equal(pinned.action, "target_missing");
});

// ───────────────────────────────────────────────────────────────── apply (fake DB)

test("applyBundledSupplements is idempotent and returns the packages to re-index", async () => {
  const db = new FakeDb();
  db.installPackage("tw.gov.mohw.twcore", "1.0.0", [paymentCs()]);
  const bundled = await listBundledSupplements(dataDir([demoSupplement("2")]));
  const first = await applyBundledSupplements(db, { bundled });
  assert.deepEqual(first.applied, [{ url: SUP_URL, version: "2", supplements: PAYMENT }]);
  assert.deepEqual(first.packages, [{ package_id: "tw.gov.mohw.twcore", version: "1.0.0" }]);
  assert.equal(db.supplements[0].uploaded_by, BUNDLED_ORIGIN);
  const writes = db.writes;
  const second = await applyBundledSupplements(db, { bundled });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.packages, []);
  assert.equal(db.writes, writes, "second run writes nothing");
  assert.equal(db.supplements.length, 1);
});

test("applyBundledSupplements skips a target CodeSystem that is not installed, applies it once installed", async () => {
  const db = new FakeDb();
  db.installPackage("hl7.fhir.r4.core", "4.0.1", [{ resourceType: "CodeSystem", id: "x", url: "http://hl7.org/fhir/x", content: "complete", concept: [{ code: "a" }] }]);
  const bundled = await listBundledSupplements(dataDir([demoSupplement("2")]));
  const r = await applyBundledSupplements(db, { bundled });
  assert.equal(r.applied.length, 0);
  assert.equal(r.plan[0].action, "target_missing");
  assert.equal(db.supplements.length, 0);
  db.installPackage("tw.gov.mohw.twcore", "1.0.0", [paymentCs()]);
  assert.equal((await applyBundledSupplements(db, { bundled })).applied.length, 1);
});

test("applyBundledSupplements never overwrites an operator's version and respects opt-outs", async () => {
  const db = new FakeDb();
  db.installPackage("tw.gov.mohw.twcore", "1.0.0", [paymentCs()]);
  const bundled = await listBundledSupplements(dataDir([demoSupplement("2")]));
  // Operator uploaded their own version 1 of the same url.
  db.supplements.push({ url: SUP_URL, version: "1", supplements: PAYMENT, raw_json: demoSupplement("1"), uploaded_by: "alice", uploaded_at: db.now() });
  const r = await applyBundledSupplements(db, { bundled });
  assert.equal(r.plan[0].action, "conflict");
  assert.deepEqual(db.supplements.map((s) => `${s.version}:${s.uploaded_by}`), ["1:alice"]);
  // Opt-out: nothing comes back while it is set.
  db.supplements = [];
  db.settings.set(`${OPT_OUT_GROUP}\u0000${SUP_URL}`, "{}");
  assert.equal((await applyBundledSupplements(db, { bundled })).plan[0].action, "opted_out");
  assert.equal(db.supplements.length, 0);
});

test("applyBundledSupplements upgrades an older bundled version only", async () => {
  const db = new FakeDb();
  db.installPackage("tw.gov.mohw.twcore", "1.0.0", [paymentCs()]);
  db.supplements.push({ url: SUP_URL, version: "1", supplements: PAYMENT, raw_json: demoSupplement("1"), uploaded_by: BUNDLED_ORIGIN, uploaded_at: db.now() });
  const r = await applyBundledSupplements(db, { bundled: await listBundledSupplements(dataDir([demoSupplement("2")])) });
  assert.equal(r.applied.length, 1);
  assert.deepEqual(db.supplements.map((s) => s.version), ["2"]);
});

test("deleting a bundled supplement records an opt-out; restore clears it (admin helpers)", async () => {
  const { recordOptOut, clearOptOuts, readOptOuts } = await import("./bundled.js");
  const db = new FakeDb();
  await recordOptOut(db, SUP_URL, "2", "admin");
  assert.deepEqual([...(await readOptOuts(db))], [SUP_URL]);
  assert.deepEqual(await clearOptOuts(db, SUP_URL), [SUP_URL]);
  assert.equal((await readOptOuts(db)).size, 0);
});

// ──────────────────────────────────────────── fresh install: import → apply → index sees it

test("fresh install: bundled supplement applied before the build is merged into the concept index; re-run is a no-op", async () => {
  const db = new FakeDb();
  db.installPackage("tw.gov.mohw.twcore", "1.0.0", [paymentCs()]);
  const bundled = await listBundledSupplements(dataDir([demoSupplement("2")]));
  // What ig_import / ig_concept_index do: apply bundled data, then build (incl. touched packages).
  const applied = await applyBundledSupplements(db, { bundled });
  const stats = await buildConceptIndex(db as never, { packages: applied.packages });
  assert.equal(stats.rebuilt, 1);
  assert.equal(stats.supplements_applied, 1);
  assert.deepEqual(JSON.parse(db.indexCs[0].supplements), [{ url: SUP_URL, version: "2" }]);
  assert.ok(db.terms.some((t) => t.code === "09001C" && t.term === "Total cholesterol"), "supplement designation indexed");
  // Second job: nothing applied, signature unchanged → nothing rebuilt (no re-embedding).
  const again = await applyBundledSupplements(db, { bundled });
  const stats2 = await buildConceptIndex(db as never, {});
  assert.equal(again.applied.length, 0);
  assert.equal(stats2.rebuilt, 0);
  assert.equal(stats2.skipped, 1);
});

test("production upgrade path: same url+version already uploaded by an operator → no write, no rebuild", async () => {
  const db = new FakeDb();
  db.installPackage("tw.gov.mohw.twcore", "1.0.0", [paymentCs()]);
  db.supplements.push({ url: SUP_URL, version: "2", supplements: PAYMENT, raw_json: demoSupplement("2"), uploaded_by: "admin", uploaded_at: db.now() });
  await buildConceptIndex(db as never, {});
  const writes = db.writes;
  const r = await applyBundledSupplements(db, { bundled: await listBundledSupplements(dataDir([demoSupplement("2")])) });
  assert.equal(r.plan[0].action, "present");
  assert.equal(db.writes, writes);
  assert.equal(db.supplements[0].uploaded_by, "admin");
  assert.equal((await buildConceptIndex(db as never, {})).rebuilt, 0);
});

// ────────────────────────────────────────────────────────────── abbreviation lexicon

test("parseBundledLexicon applies the LRABR filter and de-duplicates", () => {
  const lex = parseBundledLexicon("#LRABR\t2024AA\nLP\tacronym\tlumbar puncture\nLP\tacronym\tlumbar puncture\nX\tacronym\tx-ray\nCBC\tbogus\tcomplete blood count\n");
  assert.equal(lex.release, "2024AA");
  assert.deepEqual(lex.rows, [{ key: "lp", abbr: "LP", expansion: "lumbar puncture", kind: "acronym" }]);
});

test("ensureBundledAbbreviationLexicon loads only into an empty table", async () => {
  const dir = dataDir([], "#LRABR\ttest\nLP\tacronym\tlumbar puncture\nCBC\tacronym\tcomplete blood count\n");
  const db = new FakeDb();
  const r = await ensureBundledAbbreviationLexicon(db as never, { dir });
  assert.deepEqual(r, { loaded: true, reason: "loaded", rows: 2, release: "test" });
  assert.equal(db.lexicon[0][4], "bundled:LRABR-test");
  // A lexicon is present (bundled, or loaded from a UMLS file): untouched.
  db.lexicon = [["lp", "LP", "lumbar puncture", "acronym", "LRABR"]];
  assert.equal((await ensureBundledAbbreviationLexicon(db as never, { dir })).reason, "present");
  assert.equal(db.lexicon.length, 1);
  db.lexiconTable = false;
  assert.equal((await ensureBundledAbbreviationLexicon(db as never, { dir })).reason, "no_table");
});

// ─────────────────────────────────────────────────────────────── the committed data

test("committed bundled data: four NHI supplements targeting TW Core, 115,233 LRABR rows", async () => {
  const dir = bundledDataDir();
  const list = await listBundledSupplements(dir);
  assert.deepEqual(
    list.map((b) => [b.url.split("/").pop(), b.version, b.supplements.split("/").pop()]).sort(),
    [
      ["nhi-medication-supplement", "2026-09-28", "medication-nhi-tw"],
      ["nhi-payment-en-supplement", "2026-10-18", "medical-service-payment-tw"],
      ["nhi-payment-loinc-supplement", "2026-10-01", "medical-service-payment-tw"],
      ["nhi-payment-usage-supplement", "2025", "medical-service-payment-tw"],
    ],
  );
  const lex = await readBundledLexicon(dir);
  assert.equal(lex?.release, "2024AA");
  assert.equal(lex?.rows.length, 115233);
});

// ──────────────────────────────────────────────── status: packages with nothing to index

test("selectIndexableCodeSystems mirrors the builder's selection", () => {
  const rows = [
    { url: PAYMENT, artifact_id: "medical-service-payment-tw", content: "complete" },
    { url: PAYMENT, artifact_id: "dup", content: "complete" },
    { url: "http://loinc.org", artifact_id: "loinc", content: "not-present" },
    { url: "http://snomed.info/sct", artifact_id: "sct", content: "complete" },
    { url: SUP_URL, artifact_id: "demo-en", content: "supplement" },
    { url: null, artifact_id: "nourl", content: "complete" },
  ];
  assert.deepEqual(selectIndexableCodeSystems(rows).map((r) => r.artifact_id), ["medical-service-payment-tw"]);
});

test("unindexedPackages: a package without indexable CodeSystems is not reported as unindexed", async () => {
  const { unindexedPackages } = await import("../admin/igSupplements.js");
  const db = new FakeDb();
  db.installPackage("tw.gov.mohw.twcore", "1.0.0", [paymentCs()]);
  db.installPackage("hl7.fhir.us.core.v311", "3.1.1", []); // profiles only
  db.installPackage("us.nlm.vsac", "0.7.0", [{ resourceType: "CodeSystem", id: "loinc", url: "http://loinc.org", content: "not-present" }]);
  const r = await unindexedPackages(db);
  assert.deepEqual(r.unindexed, [{ package_id: "tw.gov.mohw.twcore", version: "1.0.0", codesystems: 1 }]);
  assert.deepEqual(r.nothingToIndex.map((p) => p.package_id).sort(), ["hl7.fhir.us.core.v311", "us.nlm.vsac"]);
  await buildConceptIndex(db as never, {});
  assert.deepEqual((await unindexedPackages(db)).unindexed, []);
});
