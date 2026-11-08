/**
 * ISSUES_v17.3 (v17 R1.3) — IG known defects: profiles whose OWN example instances fail validation.
 *
 * Self-check (job `ig_selfcheck`, after every ig_import): every example instance of a package (standalone
 * examples and the entry resources of its example Bundles) is validated against each profile of the same
 * package it declares. An error at the same element with the same rule in EVERY example of a profile is a
 * known defect of that profile (`known_invalid`): no instance written like the IG's own examples can pass.
 * Errors that depend on this installation
 * (terminology tables, external references, lookups) are left out. IG-agnostic: nothing is named here.
 *
 * Read side: `knownDefects(package)` (memoised), used by fhir_get_bundle_blueprint / fhir_get_minimal_skeleton /
 * fhir_get_authoring_fields (`known_defects` notes) and by validation (`annotateKnownDefects`: the matching
 * issues get `ig_known_defect` + a message note naming the optional entry and where the information goes).
 */

import { envBudgetBytes } from "./memSize.js";
import { query, withTransaction } from "./db.js";
import { TtlMemo } from "./ttlMemo.js";

type Json = Record<string, any>;

export const SELFCHECK_VERSION = "1.0.0";

export interface ExampleResult {
  /** Example label: artifact id, `<bundle id>#<entry index>` for Bundle entries. */
  source: string;
  /** Unversioned canonical of the profile the example was validated against. */
  profile: string;
  issues: Array<{ severity: string; path?: string | null; code?: string | null; message: string }>;
}

export interface KnownDefect {
  profile: string;
  /** Element path without indices (Condition.code.coding). */
  element: string;
  /** Message with instance values replaced — the rule the examples break. */
  rule: string;
  /** The first example's message. */
  reason: string;
  examples: string[];
  failing: number;
  total: number;
  /** Every example of the profile fails this way. */
  knownInvalid: boolean;
}

/**
 * Structural rules — errors no value written like the examples can avoid, because the PROFILE causes them (slicing,
 * cardinality, unknown elements, fixed / pattern): only these make a known defect. Errors about the examples' own
 * values (example.org identifiers, formats, invariants over dates) would pass with real data and are not counted.
 */
const STRUCTURAL_RE =
  /does not match any known slice|matching slice is required|minimum required = |max allowed = |unrecognized property|does not match the fixed value|does not have the (?:fixed|pattern) value|does not match the pattern|profile .* does not match/iu;

/** Errors that depend on this installation, not on the IG: terminology tables, lookups, references to other resources. */
const ENVIRONMENT_RE =
  /unknown code|is not known|not in the value ?set|codesystem|code system|value ?set|display|terminology|tx\.fhir|could not (?:be )?resolv|unable to|cannot (?:be )?(?:checked|resolved|found)|not found|was not checked|not supported|lookup|reference|resolve|internal error|in the future|current date/iu;

/** `Bundle.entry[3].resource.code.coding[0]` → `Condition.code.coding` (with the resource type). */
export function elementOf(path: string, resourceType: string): string {
  let p = String(path || "").replace(/^Bundle\.entry\[\d+\]\.resource\.?/u, "");
  p = p.replace(/\[\d+\]/gu, "").replace(/\.$/u, "");
  if (!p) return resourceType;
  return p.startsWith(`${resourceType}.`) || p === resourceType ? p : `${resourceType}.${p}`;
}

/** The rule of a message: quoted values, canonicals and numbers replaced (stable across examples). */
export function ruleOf(message: string): string {
  return String(message)
    .replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/'[^']*'|"[^"]*"/gu, "<v>")
    .replace(/\d+(?:\.\d+)?/gu, "<n>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

/** Known defects from the self-check results (pure). */
export function deriveKnownDefects(results: readonly ExampleResult[], resourceTypeOf: (profile: string) => string): KnownDefect[] {
  const totals = new Map<string, number>();
  for (const r of results) totals.set(r.profile, (totals.get(r.profile) ?? 0) + 1);
  const groups = new Map<string, KnownDefect>();
  for (const r of results) {
    const rt = resourceTypeOf(r.profile);
    const seen = new Set<string>();
    for (const i of r.issues) {
      if (i.severity !== "error" && i.severity !== "fatal") continue;
      if (i.code === "exception" || ENVIRONMENT_RE.test(i.message) || !STRUCTURAL_RE.test(i.message)) continue;
      // a Bundle example's entries are validated on their own (by their profiles): count only the Bundle's own elements here
      if (rt === "Bundle" && /^Bundle\.entry\[\d+\]\.resource/u.test(String(i.path ?? ""))) continue;
      // a whole entry matching no entry slice depends on which entries the example holds (or on that entry's own
      // problems in the Bundle context), never on the Bundle profile alone
      if (rt === "Bundle" && /^Bundle\.entry\[\d+\]$/u.test(String(i.path ?? ""))) continue;
      const element = elementOf(String(i.path ?? ""), rt);
      const rule = ruleOf(i.message);
      const key = `${r.profile}\u0000${element}\u0000${rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const g = groups.get(key) ?? { profile: r.profile, element, rule, reason: i.message.slice(0, 400), examples: [], failing: 0, total: totals.get(r.profile) ?? 1, knownInvalid: false };
      g.failing++;
      if (g.examples.length < 10) g.examples.push(r.source);
      groups.set(key, g);
    }
  }
  const out = [...groups.values()];
  for (const g of out) g.knownInvalid = g.failing === g.total;
  return out.sort((a, b) => a.profile.localeCompare(b.profile) || a.element.localeCompare(b.element) || a.rule.localeCompare(b.rule));
}

// ------------------------------------------------------------------------------------------------- storage

// Safety net: the same DDL lives in db/schema.sql and db/migrations/20261101_ig_known_defects.sql — keep the three in step.
let ensured = false;
export async function ensureKnownDefectsSchema(): Promise<void> {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS fhir.ig_selfcheck_runs (
    package_id TEXT NOT NULL,
    package_version TEXT NOT NULL,
    selfcheck_version TEXT NOT NULL,
    examples_total INTEGER NOT NULL,
    examples_valid INTEGER NOT NULL,
    defects INTEGER NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (package_id, package_version)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS fhir.ig_known_defects (
    package_id TEXT NOT NULL,
    package_version TEXT NOT NULL,
    profile TEXT NOT NULL,
    element TEXT NOT NULL,
    rule TEXT NOT NULL,
    reason TEXT NOT NULL,
    examples JSONB NOT NULL DEFAULT '[]'::jsonb,
    failing INTEGER NOT NULL,
    total INTEGER NOT NULL,
    known_invalid BOOLEAN NOT NULL,
    PRIMARY KEY (package_id, package_version, profile, element, rule)
  )`);
  ensured = true;
}

/** Replace a package's self-check result (one transaction). */
export async function storeKnownDefects(packageId: string, version: string, defects: readonly KnownDefect[], examplesTotal: number, examplesValid: number): Promise<void> {
  await ensureKnownDefectsSchema();
  await withTransaction(async (c) => {
    await c.query("DELETE FROM fhir.ig_known_defects WHERE package_id = $1 AND package_version = $2", [packageId, version]);
    for (const d of defects) {
      await c.query(
        `INSERT INTO fhir.ig_known_defects (package_id, package_version, profile, element, rule, reason, examples, failing, total, known_invalid)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [packageId, version, d.profile, d.element, d.rule, d.reason, JSON.stringify(d.examples), d.failing, d.total, d.knownInvalid],
      );
    }
    await c.query(
      `INSERT INTO fhir.ig_selfcheck_runs (package_id, package_version, selfcheck_version, examples_total, examples_valid, defects, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (package_id, package_version) DO UPDATE SET selfcheck_version = EXCLUDED.selfcheck_version,
         examples_total = EXCLUDED.examples_total, examples_valid = EXCLUDED.examples_valid, defects = EXCLUDED.defects, computed_at = NOW()`,
      [packageId, version, SELFCHECK_VERSION, examplesTotal, examplesValid, defects.length],
    );
  });
  memo.clear();
}

/** Installed packages without a current self-check (the worker queues ig_selfcheck for them). */
export async function packagesWithoutSelfcheck(): Promise<Array<{ package_id: string; version: string }>> {
  await ensureKnownDefectsSchema();
  const r = await query<{ package_id: string; version: string }>(
    `SELECT p.package_id, p.version FROM fhir.ig_packages p
      WHERE NOT EXISTS (SELECT 1 FROM fhir.ig_selfcheck_runs s WHERE s.package_id = p.package_id AND s.package_version = p.version AND s.selfcheck_version = $1)
      ORDER BY p.package_id, p.version`,
    [SELFCHECK_VERSION],
  );
  return r.rows;
}

const memo = new TtlMemo<KnownDefect[]>(5 * 60_000, 64, envBudgetBytes("KNOWN_DEFECTS_CACHE_MB", 32));

/** Hold a computed result for packages without storing it (tests, read-only scripts). */
export function primeKnownDefects(packages: ReadonlyArray<{ package_id: string; version: string }>, defects: KnownDefect[]): void {
  memo.set(packages.map((p) => `${p.package_id}#${p.version}`).sort().join(","), defects);
}

/** Known defects of the profiles of packages (memoised 5 min; fail-open: [] on any DB trouble, which is not memoised). */
export function knownDefects(packages: ReadonlyArray<{ package_id: string; version: string }>): Promise<KnownDefect[]> {
  const key = packages.map((p) => `${p.package_id}#${p.version}`).sort().join(",");
  return memo
    .get(key, async () => {
      await ensureKnownDefectsSchema();
      const out: KnownDefect[] = [];
      for (const p of packages) {
        const r = await query<Json>(
          "SELECT profile, element, rule, reason, examples, failing, total, known_invalid FROM fhir.ig_known_defects WHERE package_id = $1 AND package_version = $2",
          [p.package_id, p.version],
        );
        for (const x of r.rows) {
          out.push({
            profile: String(x.profile),
            element: String(x.element),
            rule: String(x.rule),
            reason: String(x.reason),
            examples: (typeof x.examples === "string" ? JSON.parse(x.examples) : x.examples) ?? [],
            failing: Number(x.failing),
            total: Number(x.total),
            knownInvalid: Boolean(x.known_invalid),
          });
        }
      }
      return out;
    })
    .catch(() => []);
}

// ------------------------------------------------------------------------------------------------- self-check run

export interface SelfcheckDeps {
  /** Example resources of the package (standalone + example Bundles). */
  examples(): Promise<Array<{ source: string; resource: Json }>>;
  /** Unversioned canonicals of the package's resource profiles → their type. */
  profiles(): Promise<Map<string, string>>;
  /** Validate one resource against one profile; the issue list. */
  validate(resource: Json, profile: string): Promise<ExampleResult["issues"]>;
  shouldStop?(): Promise<boolean>;
  onProgress?(done: number, total: number): Promise<void>;
}

export interface SelfcheckRun {
  results: ExampleResult[];
  defects: KnownDefect[];
  examplesTotal: number;
  examplesValid: number;
  stopped: boolean;
}

const stripVersion = (u: string): string => String(u).split("|")[0];

/** Run the self-check over a package's examples (pure over deps). */
export async function runSelfcheck(deps: SelfcheckDeps): Promise<SelfcheckRun> {
  const profiles = await deps.profiles();
  const instances: Array<{ source: string; resource: Json; profile: string }> = [];
  for (const ex of await deps.examples()) {
    const add = (source: string, r: Json): void => {
      for (const u of Array.isArray(r?.meta?.profile) ? r.meta.profile : []) {
        const p = stripVersion(String(u));
        if (profiles.has(p) && profiles.get(p) === r.resourceType) instances.push({ source, resource: r, profile: p });
      }
    };
    add(ex.source, ex.resource);
    if (ex.resource.resourceType === "Bundle" && Array.isArray(ex.resource.entry)) {
      ex.resource.entry.forEach((e: Json, i: number) => {
        if (e && typeof e.resource === "object" && e.resource) add(`${ex.source}#${i}`, e.resource);
      });
    }
  }
  const results: ExampleResult[] = [];
  let valid = 0;
  let stopped = false;
  for (let k = 0; k < instances.length; k++) {
    if (deps.shouldStop && (await deps.shouldStop())) {
      stopped = true;
      break;
    }
    const x = instances[k];
    let issues: ExampleResult["issues"];
    try {
      issues = await deps.validate(x.resource, x.profile);
    } catch (e) {
      issues = [{ severity: "fatal", code: "exception", message: String((e as Error).message) }];
    }
    if (!issues.some((i) => i.severity === "error" || i.severity === "fatal")) valid++;
    results.push({ source: x.source, profile: x.profile, issues });
    if (deps.onProgress) await deps.onProgress(k + 1, instances.length);
  }
  const defects = deriveKnownDefects(results, (p) => profiles.get(p) ?? "Resource");
  return { results, defects, examplesTotal: results.length, examplesValid: valid, stopped };
}

// ------------------------------------------------------------------------------------------------- notes

/** The note tools attach to a profile with known_invalid defects. */
export function knownDefectNote(d: KnownDefect, zh = false): string {
  const ex = d.examples.slice(0, 2).join(", ");
  return zh
    ? `此 profile 的 IG 範例本身也無法通過驗證（${d.failing}/${d.total}，例如 ${ex}）：${d.element} — ${d.reason.slice(0, 200)}。除非轉換目標要求，否則不要建立這個 resource；若為可選 entry 可直接省略，資訊放在引用它的必要 resource 中。`
    : `the IG's own examples of this profile fail validation too (${d.failing}/${d.total}, e.g. ${ex}): ${d.element} — ${d.reason.slice(0, 200)}. Do not create this resource unless the conversion target requires it; an optional entry can be left out, the information then goes into the required resource that references it.`;
}

/** known_invalid defects of one profile (unversioned canonical). */
export function invalidDefectsOf(defects: readonly KnownDefect[], profile: string): KnownDefect[] {
  const p = stripVersion(profile);
  return defects.filter((d) => d.knownInvalid && d.profile === p);
}

// ------------------------------------------------------------------------------------------------- DB deps

/** What the self-check needs of the IG service: validate one resource (envelope text, as the tool returns it). */
export interface SelfcheckValidator {
  validateResource(resource: Json, profile: string | null, packageId: string | null, version: string | null): Promise<string>;
}

/** Self-check deps over the live `fhir.*` store for one package. */
export function dbSelfcheckDeps(svc: SelfcheckValidator, packageId: string, version: string): SelfcheckDeps {
  const parse = (raw: unknown): Json => (typeof raw === "string" ? JSON.parse(raw) : (raw as Json)) ?? {};
  return {
    async examples() {
      const r = await query<{ artifact_id: string | null; raw_json: unknown }>(
        "SELECT artifact_id, raw_json FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND grouping_id = 'examples' ORDER BY artifact_id",
        [packageId, version],
      );
      return r.rows.map((x) => {
        const res = parse(x.raw_json);
        return { source: String(x.artifact_id ?? res.id ?? ""), resource: res };
      });
    },
    async profiles() {
      const r = await query<{ url: string | null; type: string | null }>(
        `SELECT raw_json->>'url' AS url, raw_json->>'type' AS type FROM fhir.artifacts
          WHERE package_id = $1 AND package_version = $2 AND resource_type = 'StructureDefinition'
            AND raw_json->>'kind' = 'resource' AND raw_json->>'derivation' = 'constraint'`,
        [packageId, version],
      );
      return new Map(r.rows.filter((x) => x.url && x.type).map((x) => [String(x.url), String(x.type)]));
    },
    async validate(resource, profile) {
      const env = JSON.parse(await svc.validateResource(resource, profile, packageId, version)) as Json;
      return ((env.data?.issues as Json[]) ?? []).map((i) => ({ severity: String(i.severity), path: i.path ?? null, code: i.code ?? null, message: String(i.message ?? "") }));
    },
  };
}

// ------------------------------------------------------------------------------------------------- alternatives

/**
 * Where the information of a defective resource can go instead: the CodeableConcept elements of other profiles
 * (`others`: label + StructureDefinition) bound to a ValueSet the defective element (or its parent) is bound to —
 * Condition.code ↔ Claim.diagnosis.diagnosisCodeableConcept. Labels are `<label>: <path without the type>`.
 */
export function boundAlternatives(element: string, defectSd: Json | null, others: ReadonlyArray<{ label: string; sd: Json | null }>): string[] {
  const root = element.split(".").slice(0, 2).join(".");
  const vsOf = (e: Json): string | null => (typeof e?.binding?.valueSet === "string" ? stripVersion(e.binding.valueSet) : null);
  const sets = new Set(((defectSd?.snapshot?.element ?? []) as Json[]).filter((e) => String(e.path ?? "").startsWith(root)).map(vsOf).filter((x): x is string => !!x));
  const out = new Set<string>();
  if (!sets.size) return [];
  for (const o of others) {
    for (const e of (o.sd?.snapshot?.element ?? []) as Json[]) {
      const v = vsOf(e);
      if (!v || !sets.has(v) || e.max === "0" || !((e.type ?? []) as Json[]).some((t) => t.code === "CodeableConcept")) continue;
      out.add(`${o.label}: ${String(e.path).replace(/^[A-Za-z]+\./u, "").replace(/\[x\]$/u, "CodeableConcept")}`);
    }
  }
  return [...out];
}

// ------------------------------------------------------------------------------------------------- validation notes

/** Paths (generic, with the resource type) where other resources of the Bundle reference `target`. */
function referencingPaths(root: Json, targetIndex: number): string[] {
  const entries: Json[] = Array.isArray(root?.entry) ? root.entry : [];
  const t = entries[targetIndex];
  const res = t?.resource ?? {};
  const keys = new Set([t?.fullUrl, res.resourceType && res.id ? `${res.resourceType}/${res.id}` : null].filter(Boolean));
  const out = new Set<string>();
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 14 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, path, depth + 1);
      return;
    }
    const o = node as Json;
    if (typeof o.reference === "string" && keys.has(o.reference)) out.add(path);
    for (const [k, v] of Object.entries(o)) if (k !== "reference" && v && typeof v === "object") walk(v, `${path}.${k}`, depth + 1);
  };
  entries.forEach((e, i) => {
    if (i !== targetIndex && e?.resource?.resourceType) walk(e.resource, String(e.resource.resourceType), 0);
  });
  return [...out];
}

/** Fallback placement: `Claim.diagnosis.diagnosisReference` → `Claim.diagnosis.diagnosisCodeableConcept`. */
function alternativePlacement(paths: string[]): string | null {
  for (const p of paths) {
    const m = /^(.*\.)?(\w+)Reference$/u.exec(p);
    if (m) return `${m[1] ?? ""}${m[2]}CodeableConcept (instead of ${p})`;
  }
  return paths[0] ? `the element that references it (${paths[0]})` : null;
}

/**
 * Mark validation issues that are known defects of the IG (every example of the profile fails the same way): an
 * `ig_known_defect` block and a message note. Never changes severity, the issue set or `valid`.
 */
export function annotateKnownDefects(
  issues: Json[],
  root: Json,
  explicitProfile: string | null,
  defects: readonly KnownDefect[],
  /** Bound CodeableConcept alternatives of a defect within this Bundle (boundAlternatives over its entries' profiles). */
  alternatives: Map<string, string[]> = new Map(),
): void {
  const invalid = defects.filter((d) => d.knownInvalid);
  if (!invalid.length) return;
  for (const i of issues) {
    if (i.severity !== "error" && i.severity !== "fatal") continue;
    if (i.ig_known_defect) continue;
    const path = String(i.path ?? "");
    const m = /^Bundle\.entry\[(\d+)\]\.resource/u.exec(path);
    const idx = m ? Number(m[1]) : null;
    const res: Json = idx !== null ? root?.entry?.[idx]?.resource ?? {} : root;
    const rt = String(res.resourceType ?? "");
    const declared = (Array.isArray(res?.meta?.profile) ? res.meta.profile : []).map((u: unknown) => stripVersion(String(u)));
    const profiles = idx === null && explicitProfile ? [stripVersion(explicitProfile), ...declared] : declared;
    const element = elementOf(path, rt);
    const rule = ruleOf(String(i.message ?? ""));
    const d = invalid.find((x) => profiles.includes(x.profile) && x.element === element && x.rule === rule);
    if (!d) continue;
    const bound = alternatives.get(`${d.profile}\u0000${d.element}`) ?? [];
    const refsTo = idx !== null ? referencingPaths(root, idx) : [];
    const alt = bound.length ? bound.slice(0, 2).join(" / ") : alternativePlacement(refsTo);
    const advice =
      `This ${rt} entry is likely optional: leave it out unless the conversion target requires it` +
      (alt ? `; put the information in ${alt}` : "") +
      (bound.length && refsTo.length ? `; remove the references to it too (${refsTo.slice(0, 3).join(", ")})` : "");
    i.ig_known_defect = { profile: d.profile, element: d.element, examples: d.examples.slice(0, 3), failing: d.failing, total: d.total, advice };
    i.message = `${i.message} — IG known defect: the IG's own examples of this profile fail this check too (${d.failing}/${d.total}, e.g. ${d.examples[0]}). ${advice}.`;
  }
}
