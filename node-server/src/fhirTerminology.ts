/**
 * FHIR terminology resolver — DB layer. ValueSet expansion / membership and
 * code lookup over the IG packages held in `fhir.*` plus the SNOMED / LOINC /
 * ICD tables. The rule logic (nested CodeSystem hierarchies, filters,
 * membership) lives in the pure `fhirCodeSystem.ts`; this module only supplies
 * DB-backed `TerminologyDeps`. Honesty contract: when a system cannot be
 * resolved from data we hold, say so (`unresolved` / `found:null` /
 * membership `undefined`) — never fabricate a display or a verdict.
 */

import { query } from "./db.js";
import type { PackageRow } from "./fhirIg.js";
import {
  type CodeSystemIndex,
  type ExpandResult,
  type TerminologyDeps,
  expandComposeWith,
  findConcept,
  indexCodeSystem,
  valueSetContains,
} from "./fhirCodeSystem.js";

export type { Coding, ExpandResult } from "./fhirCodeSystem.js";
import type { Icd10WhoRow, LoincOtherRow, SnomedConceptRow, SnomedDescriptionRow, SnomedEditionInfo } from "./fhirExternalTerminology.js";
import { CVX_CODES } from "./fhirCvx.js";

export const SNOMED_SYSTEM = "http://snomed.info/sct";
export const LOINC_SYSTEM = "http://loinc.org";
export const RXNORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
export const SNOMED_IS_A = 116680003;

export const DEFAULT_EXPAND_LIMIT = 500;

export function canonicalTail(url: string | null | undefined): string {
  if (!url) return "";
  return url.replace(/\/+$/, "").split("/").pop()!.split("|")[0];
}

/** Parallel `(package_ids, package_versions)` arrays for the dependency closure. */
export function closureArrays(pkg: PackageRow): [string[], string[]] {
  const closure = pkg._closure || [[pkg.package_id, pkg.version]];
  const pids = closure.map((c) => c[0]);
  const pvers = closure.map((c) => c[1]);
  return [pids, pvers];
}

export type SystemKind = "ig" | "snomed" | "loinc" | "icd_dx" | "icd_pcs" | "external";

/** Map a code system (and/or CodeSystem id) to a local backing store. */
export function routeSystem(system: string | null | undefined, csId: string | null = null): SystemKind {
  if (system === SNOMED_SYSTEM) return "snomed";
  if (system === LOINC_SYSTEM) return "loinc";
  const tail = csId || canonicalTail(system);
  if (tail.startsWith("icd-10-pcs") || tail.startsWith("icd-9-pcs")) return "icd_pcs";
  if (tail.startsWith("icd-10-cm") || tail.startsWith("icd-9-cm")) return "icd_dx";
  if (csId || (system && system.includes("/CodeSystem/"))) return "ig";
  return "external";
}

export interface LookupResult {
  display: string | null;
  definition: string | null;
}

function isDigits(s: any): boolean {
  return /^\d+$/.test(String(s));
}

// --------------------------------------------------------------------------- //
// Process-wide caches (IG package versions are immutable once imported; a TTL
// still bounds staleness after a re-import of the same version).
// --------------------------------------------------------------------------- //

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 400;

class TtlCache<V> {
  private map = new Map<string, { at: number; value: V }>();
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: V): void {
    if (this.map.size >= CACHE_MAX) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { at: Date.now(), value });
  }
}

const csCache = new TtlCache<CodeSystemIndex | null>();
const vsCache = new TtlCache<Record<string, any> | null>();
const heldCache = new TtlCache<boolean>();

export function closureKey(pkg: PackageRow): string {
  const [pids, pvers] = closureArrays(pkg);
  return pids.map((p, i) => `${p}#${pvers[i]}`).join(",");
}

function jsonOf(raw: any): Record<string, any> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function cmpVersion(a: string | null | undefined, b: string | null | undefined): number {
  const pa = String(a || "").split(/[.\-]/);
  const pb = String(b || "").split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export interface ArtifactCandidate {
  packageId: string;
  packageVersion: string;
  fhirVersion: string | null;
  /** 1-based position in the dependency closure (target package first). */
  ord: number;
}

/**
 * Order candidate packages holding the same canonical, best first:
 *  1. packages for another FHIR major release (R5 cores / R5 terminology pulled
 *     in transitively) go last — this validator validates R4 content;
 *  2. `http://terminology.hl7.org/...` canonicals prefer the newest
 *     `hl7.terminology.*` package (THO supersedes the copies frozen in core);
 *  3. otherwise the dependency-closure order (the IG itself, then its deps).
 */
export function rankCandidates<T extends ArtifactCandidate>(canonical: string, rows: T[]): T[] {
  const foreign = (r: T): number => {
    const fv = r.fhirVersion || "";
    const r5 = /\.r5(\.|$)/.test(r.packageId) || (fv !== "" && !fv.startsWith("4"));
    return r5 ? 1 : 0;
  };
  const tho = canonical.startsWith("http://terminology.hl7.org/");
  return [...rows].sort((a, b) => {
    const fa = foreign(a) - foreign(b);
    if (fa !== 0) return fa;
    if (tho) {
      const ta = a.packageId.startsWith("hl7.terminology") ? 0 : 1;
      const tb = b.packageId.startsWith("hl7.terminology") ? 0 : 1;
      if (ta !== tb) return ta - tb;
      if (ta === 0) {
        const c = cmpVersion(b.packageVersion, a.packageVersion);
        if (c !== 0) return c;
      }
    }
    return a.ord - b.ord;
  });
}

/** HL7 VersionUtilities.getMajMin-like key of a resource version (null when not semver-shaped). */
function majMinParts(v: string | null | undefined): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(String(v ?? ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Port of CanonicalResourceManager's "current" resource for an unversioned
 * canonical (org.hl7.fhir.r5 context, validator_cli 7.0.1): every loaded copy of
 * a canonical is kept sorted by MetadataResourceVersionComparator (major.minor of
 * the resource's own `version`; a resource without a version sorts first; equal
 * keys keep load order) and the last one answers `fetchResource(url)`. So an
 * extension that both R4 core (version 4.0.1) and hl7.fhir.uv.extensions.r4
 * (5.2.0) define resolves to the extensions-pack copy — the one carrying e.g.
 * var-1 and the current contexts (confirmed with validator_cli: v5.x messages).
 * Applied after rankCandidates' rules (other FHIR major releases last, THO
 * packages first for terminology.hl7.org canonicals); ties keep closure order.
 */
export function rankHl7Current<T extends ArtifactCandidate & { version?: string | null }>(canonical: string, rows: T[]): T[] {
  const ranked = rankCandidates(canonical, rows);
  if (canonical.startsWith("http://terminology.hl7.org/")) return ranked;
  const foreign = (r: T): boolean => {
    const fv = r.fhirVersion || "";
    return /\.r5(\.|$)/.test(r.packageId) || (fv !== "" && !fv.startsWith("4"));
  };
  const pos = new Map(ranked.map((r, i) => [r, i]));
  const cmp = (a: T, b: T): number => {
    const fa = Number(foreign(a)) - Number(foreign(b));
    if (fa !== 0) return fa;
    const va = a.version ?? null;
    const vb = b.version ?? null;
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      const ma = majMinParts(va);
      const mb = majMinParts(vb);
      if (ma && mb) {
        if (ma[0] !== mb[0]) return mb[0] - ma[0];
        if (ma[1] !== mb[1]) return mb[1] - ma[1];
      } else if (!ma && !mb && va !== vb) {
        return va < vb ? 1 : -1;
      }
    }
    return pos.get(a)! - pos.get(b)!;
  };
  return [...ranked].sort(cmp);
}

/** Load a conformance/terminology resource by canonical across the package closure (best candidate). */
export async function loadArtifactByCanonical(
  resourceType: string,
  url: string,
  pkg: PackageRow,
  opts: { hl7Current?: boolean } = {},
): Promise<Record<string, any> | null> {
  const [pids, pvers] = closureArrays(pkg);
  const canonical = url.split("|")[0];
  const rows = (
    await query<{ raw_json: any; ord: number; package_id: string; package_version: string; fhir_version: string | null }>(
      "SELECT a.raw_json, dep.ord, a.package_id, a.package_version, p.fhir_version FROM fhir.artifacts a " +
        "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) " +
        "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "JOIN fhir.ig_packages p ON p.package_id = a.package_id AND p.version = a.package_version " +
        "WHERE a.resource_type = $3 AND a.canonical_url = $4",
      [pids, pvers, resourceType, canonical],
    )
  ).rows;
  const cands = rows.map((r) => ({ ...r, packageId: r.package_id, packageVersion: r.package_version, fhirVersion: r.fhir_version, ord: Number(r.ord) }));
  if (opts.hl7Current) {
    const parsed = cands
      .map((r) => ({ ...r, json: jsonOf(r.raw_json) }))
      .filter((r) => r.json)
      .map((r) => ({ ...r, version: typeof r.json!.version === "string" ? (r.json!.version as string) : null }));
    return rankHl7Current(canonical, parsed)[0]?.json ?? null;
  }
  const ranked = rankCandidates(canonical, cands);
  for (const r of ranked) {
    const json = jsonOf(r.raw_json);
    if (json) return json;
  }
  return null;
}

async function loadByCanonical(
  resourceType: "CodeSystem" | "ValueSet",
  url: string,
  pkg: PackageRow,
  exact = false,
): Promise<Record<string, any> | null> {
  const hit = await loadArtifactByCanonical(resourceType, url, pkg);
  if (hit || exact) return hit;
  // Fallback by resource id = canonical tail. Covers bare ids passed by tool
  // callers, and packages that published a resource under a wrong `url`
  // (e.g. TW Core 0.3.2 CodeSystem/icd-10-cm-2023-tw declares the ValueSet URL).
  const [pids, pvers] = closureArrays(pkg);
  const row = (
    await query<{ raw_json: any }>(
      "SELECT a.raw_json FROM fhir.artifacts a " +
        "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) " +
        "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "WHERE a.resource_type = $3 AND a.artifact_id = $4 ORDER BY dep.ord LIMIT 1",
      [pids, pvers, resourceType, canonicalTail(url)],
    )
  ).rows[0];
  if (!row) return null;
  const json = jsonOf(row.raw_json);
  if (!json) return null;
  if (resourceType === "CodeSystem" && url.includes("/")) {
    // Only accept the id match when the path differs at most in the resource-type segment.
    const want = url.split("|")[0].replace(/\/(CodeSystem|ValueSet)\//, "/");
    const got = String(json.url || "").replace(/\/(CodeSystem|ValueSet)\//, "/");
    if (want !== got) return null;
  }
  return json;
}

/**
 * CodeSystem index by canonical across the package closure. `exact` (the
 * validator) disables the id fallback: the HL7 validator resolves a
 * Coding.system / include.system by its exact canonical only.
 */
export async function loadCodeSystemIndex(url: string, pkg: PackageRow, exact = false): Promise<CodeSystemIndex | null> {
  const key = closureKey(pkg) + "|" + url.split("|")[0] + (exact ? "|exact" : "");
  const cached = csCache.get(key);
  if (cached !== undefined) return cached;
  const cs = await loadByCanonical("CodeSystem", url, pkg, exact);
  // `not-present` stubs (e.g. SNOMED / LOINC in core) carry no concepts: treat as not held.
  const idx = cs && cs.content !== "supplement" && cs.content !== "not-present" ? indexCodeSystem(cs) : null;
  csCache.set(key, idx);
  return idx;
}

export async function loadValueSet(url: string, pkg: PackageRow): Promise<Record<string, any> | null> {
  const key = closureKey(pkg) + "|" + url.split("|")[0];
  const cached = vsCache.get(key);
  if (cached !== undefined) return cached;
  const vs = await loadByCanonical("ValueSet", url, pkg);
  vsCache.set(key, vs);
  return vs;
}

async function tableHasRows(table: string): Promise<boolean> {
  const cached = heldCache.get(table);
  if (cached !== undefined) return cached;
  let held = false;
  try {
    held = (await query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length > 0;
  } catch (e) {
    // A missing table (42P01) is permanent; any other (transient) DB error is not
    // cached, so it cannot turn a terminology "not held" (checks silently skipped)
    // for the cache lifetime.
    if ((e as { code?: string } | null)?.code === "42P01") heldCache.set(table, false);
    return false;
  }
  heldCache.set(table, held);
  return held;
}

/** Whether an external (non-IG) system is backed by populated local tables. */
const BCP13 = "urn:ietf:bcp:13";
const BCP47 = "urn:ietf:bcp:47";
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(\s*;\s*[a-z0-9!#$&^_.+-]+=("[^"]*"|[^;\s]+))*$/i;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Z]{2}|\d{3}))?(-[A-Za-z0-9]{5,8})*$/;

/** Grammar-backed systems: membership of a well-formed code can be asserted without tables. */
function grammarLookup(system: string, code: string): LookupResult | null | undefined {
  if (system === BCP13) return MIME_RE.test(code) ? { display: null, definition: null } : null;
  if (system === BCP47) return LANG_RE.test(code) ? { display: null, definition: null } : null;
  return undefined;
}

export async function externalSystemHeld(system: string): Promise<boolean> {
  if (system === BCP13 || system === BCP47) return true;
  const kind = routeSystem(system);
  if (kind === "snomed") return tableHasRows("snomed.concepts");
  if (kind === "loinc") return tableHasRows("loinc.concepts");
  return false;
}

async function lookupExternalTables(system: string | null | undefined, code: string): Promise<LookupResult | null> {
  if (system) {
    const g = grammarLookup(system, code);
    if (g !== undefined) return g;
  }
  const kind = routeSystem(system);
  if (kind === "snomed") {
    if (!isDigits(code)) return null;
    const row = (
      await query<{ term: string }>(
        "SELECT term FROM snomed.descriptions WHERE concept_id = $1 AND active = TRUE " +
          "ORDER BY us_preferred DESC NULLS LAST LIMIT 1",
        [code],
      )
    ).rows[0];
    return row ? { display: row.term, definition: null } : null;
  }
  if (kind === "loinc") {
    const row = (
      await query<{ long_common_name: string; shortname: string }>(
        "SELECT long_common_name, shortname FROM loinc.concepts WHERE loinc_num = $1",
        [code],
      )
    ).rows[0];
    if (row) return { display: row.long_common_name, definition: row.shortname };
    // LA / LP / LL codes (not LG: tx.fhir.org does not serve LOINC groups).
    if (/^L[APL]\d+-\d$/.test(code)) {
      const other = await loincOtherCode(code);
      if (other && other.display) return { display: other.display, definition: other.altDisplay };
    }
    return null;
  }
  if (system === "http://hl7.org/fhir/sid/cvx") {
    const row = CVX_CODES[code];
    return row ? { display: row[0], definition: row[1] } : null;
  }
  if (system === "http://hl7.org/fhir/sid/icd-10") {
    const row = await icd10WhoRow(code);
    return row ? { display: row.display, definition: row.altDisplays[0] ?? null } : null;
  }
  if (kind === "icd_dx" && system === "http://hl7.org/fhir/sid/icd-10-cm") {
    const row = await icd10cmRow(code);
    return row ? { display: row.name_en, definition: row.name_zh } : null;
  }
  if (kind === "icd_dx" || kind === "icd_pcs") {
    const table = kind === "icd_dx" ? "icd.diagnoses" : "icd.procedures";
    const row = (
      await query<{ name_en: string; name_zh: string }>(`SELECT name_en, name_zh FROM ${table} WHERE code = $1`, [code])
    ).rows[0];
    return row ? { display: row.name_en, definition: row.name_zh } : null;
  }
  return null;
}

/**
 * Display strings a code may legitimately carry in an external system, as the
 * HL7 terminology server (tx.fhir.org) accepts them for Coding.display:
 *  - LOINC: LONG_COMMON_NAME and SHORTNAME (not the consumer / display name,
 *    not linguistic variants) — confirmed against validator_cli 7.0.1;
 *  - SNOMED CT: every *active* English FSN / synonym of the concept. tx.fhir.org
 *    (as used by validator_cli 7.0.1) rejects inactive descriptions ("is no
 *    longer considered a correct display ... (status = inactive)");
 *  - ICD-10-CM: the single tabular description.
 * null = code not held locally.
 */
export async function externalDisplays(
  system: string,
  code: string,
): Promise<{ displays: string[] } | null> {
  const kind = routeSystem(system);
  if (kind === "snomed") {
    if (!isDigits(code)) return null;
    const rows = (
      await query<{ term: string }>("SELECT term FROM snomed.descriptions WHERE concept_id = $1 AND active = TRUE", [code])
    ).rows;
    if (!rows.length) return null;
    return { displays: rows.map((r) => r.term) };
  }
  if (kind === "loinc") {
    const row = (
      await query<{ long_common_name: string | null; shortname: string | null }>(
        "SELECT long_common_name, shortname FROM loinc.concepts WHERE loinc_num = $1",
        [code],
      )
    ).rows[0];
    if (!row) return null;
    const out: string[] = [];
    for (const v of [row.long_common_name, row.shortname]) if (typeof v === "string" && v) out.push(v);
    return { displays: out };
  }
  if (kind === "icd_dx" && system === "http://hl7.org/fhir/sid/icd-10-cm") {
    const row = await icd10cmRow(code);
    if (!row) return null;
    // tx.fhir.org: display = CMS long title; the CMS short title is an English
    // synonym designation and also accepted as Coding.display.
    const displays: string[] = [];
    for (const v of [row.name_en, row.short_name_en]) if (typeof v === "string" && v) displays.push(v);
    return { displays };
  }
  return null;
}

/** Whether the local ICD-10-CM diagnosis table is populated. */
export async function icd10cmHeld(): Promise<boolean> {
  return tableHasRows("icd.diagnoses");
}

/**
 * ICD-10-CM row by code. tx.fhir.org matches ICD-10-CM codes case-insensitively
 * (`s93.411a` validates as S93.411A), so an exact miss retries upper-cased.
 * `short_name_en` is absent on databases without the 20261017 migration.
 */
async function icd10cmRow(
  code: string,
): Promise<{ code: string; name_en: string | null; name_zh: string | null; short_name_en: string | null } | null> {
  const run = async (sql: string): Promise<any | null> => {
    const exact = (await query(sql, [code])).rows[0];
    if (exact || code.toUpperCase() === code) return exact ?? null;
    return (await query(sql, [code.toUpperCase()])).rows[0] ?? null;
  };
  try {
    return await run("SELECT code, name_en, name_zh, short_name_en FROM icd.diagnoses WHERE code = $1");
  } catch {
    const row = await run("SELECT code, name_en, name_zh FROM icd.diagnoses WHERE code = $1");
    return row ? { ...row, short_name_en: null } : null;
  }
}

/** Loaded ICD-10-CM edition (icd.editions), or null when not recorded. */
export interface Icd10cmEditionInfo {
  edition: string;
  sourceFormat: string;
  complete: boolean;
  codeCount: number;
}

const editionCache = new TtlCache<Icd10cmEditionInfo | null>();

export async function icd10cmEdition(): Promise<Icd10cmEditionInfo | null> {
  const hit = editionCache.get("icd-10-cm");
  if (hit !== undefined) return hit;
  let info: Icd10cmEditionInfo | null = null;
  try {
    const row = (
      await query<{ edition: string; source_format: string; complete: boolean; code_count: number }>(
        "SELECT edition, source_format, complete, code_count FROM icd.editions WHERE code_system = 'icd-10-cm'",
      )
    ).rows[0];
    if (row) {
      info = { edition: row.edition, sourceFormat: row.source_format, complete: row.complete === true, codeCount: Number(row.code_count) };
    }
  } catch {
    info = null; // table missing (migration 20261017 not applied) → treated as incomplete
  }
  editionCache.set("icd-10-cm", info);
  return info;
}

// --------------------------------------------------------------------------- //
// Validator lookups for LOINC non-term codes, SNOMED CT inactive content and
// WHO ICD-10 (tables from db/migrations/20261018_terminology_completeness_v4.sql).
// Every function degrades to "not held" when those tables / columns are absent.
// --------------------------------------------------------------------------- //

const loincEditionCache = new TtlCache<{ version: string } | null>();
const snomedEditionCache = new TtlCache<SnomedEditionInfo | null>();
const whoEditionCache = new TtlCache<{ edition: string; complete: boolean } | null>();

/** LA / LP / LL / LG row from loinc.other_codes, or null. */
export async function loincOtherCode(code: string): Promise<LoincOtherRow | null> {
  try {
    const row = (
      await query<{ kind: string; display: string | null; alt_display: string | null; status: string | null }>(
        "SELECT kind, display, alt_display, status FROM loinc.other_codes WHERE code = $1",
        [code],
      )
    ).rows[0];
    return row ? { kind: row.kind, display: row.display, altDisplay: row.alt_display, status: row.status } : null;
  } catch {
    return null;
  }
}

/** Whether loinc.other_codes is populated (the answer / part files were imported). */
export async function loincOtherCodesHeld(): Promise<boolean> {
  return tableHasRows("loinc.other_codes");
}

/** Loaded LOINC version (loinc.editions), or null. */
export async function loincEdition(): Promise<{ version: string } | null> {
  const hit = loincEditionCache.get("loinc");
  if (hit !== undefined) return hit;
  let info: { version: string } | null = null;
  try {
    const row = (await query<{ version: string }>("SELECT version FROM loinc.editions WHERE code_system = 'loinc'")).rows[0];
    info = row ? { version: row.version } : null;
  } catch {
    info = null;
  }
  loincEditionCache.set("loinc", info);
  return info;
}

/** Loaded SNOMED CT edition (snomed.editions), or null. */
export async function snomedEdition(): Promise<SnomedEditionInfo | null> {
  const hit = snomedEditionCache.get("snomed");
  if (hit !== undefined) return hit;
  let info: SnomedEditionInfo | null = null;
  try {
    const row = (
      await query<{ module_id: string; version_date: string; includes_inactive: boolean }>(
        "SELECT module_id, to_char(version_date, 'YYYY-MM-DD') AS version_date, includes_inactive FROM snomed.editions WHERE code_system = 'snomed'",
      )
    ).rows[0];
    info = row ? { moduleId: String(row.module_id), versionDate: row.version_date, includesInactive: row.includes_inactive === true } : null;
  } catch {
    info = null;
  }
  snomedEditionCache.set("snomed", info);
  return info;
}

const DATE = (col: string): string => `to_char(${col}, 'YYYY-MM-DD')`;

/** SNOMED CT concept (active table first, then snomed.inactive_concepts), or null. */
export async function snomedConcept(code: string): Promise<SnomedConceptRow | null> {
  if (!isDigits(code)) return null;
  try {
    const a = (
      await query<{ first_released: string | null }>(
        `SELECT ${DATE("first_released")} AS first_released FROM snomed.concepts WHERE concept_id = $1`,
        [code],
      )
    ).rows[0];
    if (a) return { active: true, effectiveTime: null, firstReleased: a.first_released };
    const i = (
      await query<{ effective_time: string | null; first_released: string | null }>(
        `SELECT ${DATE("effective_time")} AS effective_time, ${DATE("first_released")} AS first_released FROM snomed.inactive_concepts WHERE concept_id = $1`,
        [code],
      )
    ).rows[0];
    return i ? { active: false, effectiveTime: i.effective_time, firstReleased: i.first_released } : null;
  } catch {
    // Pre-20261018 database: active concepts only, no release dates.
    try {
      const a = (await query("SELECT 1 FROM snomed.concepts WHERE concept_id = $1", [code])).rows[0];
      return a ? { active: true, effectiveTime: null, firstReleased: null } : null;
    } catch {
      return null;
    }
  }
}

/** Every English FSN / synonym of a concept: snomed.descriptions + snomed.inactive_descriptions. */
export async function snomedConceptDescriptions(code: string): Promise<SnomedDescriptionRow[]> {
  if (!isDigits(code)) return [];
  try {
    return (
      await query<{ term: string; active: boolean; effective_time: string | null; first_released: string | null }>(
        `SELECT term, active, NULL::text AS effective_time, ${DATE("first_released")} AS first_released
           FROM snomed.descriptions WHERE concept_id = $1 AND active = TRUE
         UNION ALL
         SELECT term, active, ${DATE("effective_time")}, ${DATE("first_released")}
           FROM snomed.inactive_descriptions WHERE concept_id = $1`,
        [code],
      )
    ).rows.map((r) => ({ term: r.term, active: r.active === true, effectiveTime: r.effective_time, firstReleased: r.first_released }));
  } catch {
    try {
      return (
        await query<{ term: string }>("SELECT term FROM snomed.descriptions WHERE concept_id = $1 AND active = TRUE", [code])
      ).rows.map((r) => ({ term: r.term, active: true, effectiveTime: null, firstReleased: null }));
    } catch {
      return [];
    }
  }
}

/** WHO ICD-10 row (case-sensitive, as tx.fhir.org), or null. */
export async function icd10WhoRow(code: string): Promise<Icd10WhoRow | null> {
  try {
    const row = (
      await query<{ display: string; alt_displays: string[] | null }>("SELECT display, alt_displays FROM icd.icd10_who WHERE code = $1", [code])
    ).rows[0];
    return row ? { display: row.display, altDisplays: row.alt_displays ?? [] } : null;
  } catch {
    return null;
  }
}

/** Whether a WHO ICD-10 table is loaded. */
export async function icd10WhoHeld(): Promise<boolean> {
  return tableHasRows("icd.icd10_who");
}

export async function icd10WhoEdition(): Promise<{ edition: string; complete: boolean } | null> {
  const hit = whoEditionCache.get("icd-10");
  if (hit !== undefined) return hit;
  let info: { edition: string; complete: boolean } | null = null;
  try {
    const row = (
      await query<{ edition: string; complete: boolean }>("SELECT edition, complete FROM icd.editions WHERE code_system = 'icd-10'")
    ).rows[0];
    info = row ? { edition: row.edition, complete: row.complete === true } : null;
  } catch {
    info = null;
  }
  whoEditionCache.set("icd-10", info);
  return info;
}

// --------------------------------------------------------------------------- //
// RxNorm (rxnorm.concepts: one row per RXCUI, SAB=RXNORM; alt_names = the other
// RXNORM atom strings, filled by the RxNorm import since migration 20261030).
// --------------------------------------------------------------------------- //

export interface RxnormRow {
  name: string;
  /** Other SAB=RXNORM atom strings of the RXCUI; null on a database imported before 20261030. */
  altNames: string[] | null;
  tty: string | null;
  suppress: string | null;
}

/** RxNorm concept by RXCUI, or null (also when the table / column is missing). */
export async function rxnormConcept(code: string): Promise<RxnormRow | null> {
  if (!isDigits(code)) return null;
  try {
    const row = (
      await query<{ name: string; alt_names: string[] | null; tty: string | null; suppress: string | null }>(
        "SELECT name, alt_names, tty, suppress FROM rxnorm.concepts WHERE rxcui = $1",
        [code],
      )
    ).rows[0];
    return row ? { name: row.name, altNames: row.alt_names ?? null, tty: row.tty, suppress: row.suppress } : null;
  } catch {
    try {
      const row = (await query<{ name: string; tty: string | null; suppress: string | null }>("SELECT name, tty, suppress FROM rxnorm.concepts WHERE rxcui = $1", [code])).rows[0];
      return row ? { name: row.name, altNames: null, tty: row.tty, suppress: row.suppress } : null;
    } catch {
      return null;
    }
  }
}

/** Whether rxnorm.concepts is populated. */
export async function rxnormHeld(): Promise<boolean> {
  return tableHasRows("rxnorm.concepts");
}

const rxnormEditionCache = new TtlCache<{ version: string; releaseDate: string | null } | null>();

/** Loaded RxNorm release (rxnorm.editions, migration 20261030), or null. */
export async function rxnormEdition(): Promise<{ version: string; releaseDate: string | null } | null> {
  const hit = rxnormEditionCache.get("rxnorm");
  if (hit !== undefined) return hit;
  let info: { version: string; releaseDate: string | null } | null = null;
  try {
    const row = (
      await query<{ version: string; release_date: string | null }>(
        "SELECT version, to_char(release_date, 'YYYY-MM-DD') AS release_date FROM rxnorm.editions WHERE code_system = 'rxnorm'",
      )
    ).rows[0];
    info = row ? { version: row.version, releaseDate: row.release_date } : null;
  } catch {
    info = null;
  }
  rxnormEditionCache.set("rxnorm", info);
  return info;
}

/** Resolve a `(system, code)` to `{display, definition}` from local data, or null. */
export async function lookup(
  system: string | null | undefined,
  code: string,
  pkg: PackageRow,
  csId: string | null = null,
): Promise<LookupResult | null> {
  const kind = routeSystem(system, csId);
  if (kind === "snomed" || kind === "loinc") return lookupExternalTables(system, code);
  if (system === "http://hl7.org/fhir/sid/cvx" || system === "http://hl7.org/fhir/sid/icd-10") return lookupExternalTables(system, code);
  if (system === RXNORM_SYSTEM) {
    // RxNorm (concept-only reference table): preferred name of the RXCUI.
    const row = await rxnormConcept(code);
    return row ? { display: row.name, definition: null } : null;
  }
  if (system) {
    // Prefer the IG-held CodeSystem (full nested hierarchy).
    const idx = await loadCodeSystemIndex(system, pkg);
    if (idx) {
      const c = findConcept(idx, code);
      if (c) return { display: c.display, definition: null };
      if (idx.content === "complete") return null;
    }
  }
  if (kind === "icd_dx" || kind === "icd_pcs") {
    const hit = await lookupExternalTables(system, code);
    if (hit) return hit;
  }
  const tail = csId || canonicalTail(system);
  if (!tail) return null;
  const [pids, pvers] = closureArrays(pkg);
  const row = (
    await query<{ display: string; definition: string }>(
      "SELECT c.display, c.definition FROM fhir.concepts c " +
        "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) " +
        "  ON c.package_id = dep.pid AND c.package_version = dep.pver " +
        "WHERE c.cs_id = $3 AND c.code = $4 LIMIT 1",
      [pids, pvers, tail, code],
    )
  ).rows[0];
  return row ? { display: row.display, definition: row.definition } : null;
}

/** Concept ids that are `is-a` descendants of `code` (inclusive), capped. */
export async function snomedDescendants(code: string, limit: number): Promise<number[]> {
  if (!isDigits(code)) return [];
  const rows = (
    await query<{ concept_id: number }>(
      `
      WITH RECURSIVE descendants AS (
          SELECT concept_id FROM snomed.concepts WHERE concept_id = $1
          UNION
          SELECT r.source_id
          FROM snomed.relationships r
          JOIN descendants d ON r.destination_id = d.concept_id
          WHERE r.type_id = $2 AND r.active = TRUE
      )
      SELECT concept_id FROM descendants LIMIT $3
      `,
      [code, SNOMED_IS_A, limit],
    )
  ).rows;
  return rows.map((r) => r.concept_id);
}

/** Is SNOMED `code` equal to or an is-a descendant of `ancestor`? (walks upward — cheap). */
export async function snomedSubsumedBy(code: string, ancestor: string): Promise<boolean | undefined> {
  if (!isDigits(code) || !isDigits(ancestor)) return undefined;
  if (code === ancestor) return true;
  if (!(await tableHasRows("snomed.relationships"))) return undefined;
  const rows = (
    await query<{ hit: number }>(
      `
      WITH RECURSIVE ancestors AS (
          SELECT destination_id AS id FROM snomed.relationships
          WHERE source_id = $1 AND type_id = $3 AND active = TRUE
          UNION
          SELECT r.destination_id FROM snomed.relationships r
          JOIN ancestors a ON r.source_id = a.id
          WHERE r.type_id = $3 AND r.active = TRUE
      )
      SELECT 1 AS hit FROM ancestors WHERE id = $2 LIMIT 1
      `,
      [code, ancestor, SNOMED_IS_A],
    )
  ).rows;
  if (rows.length) return true;
  const known = await lookupExternalTables(SNOMED_SYSTEM, code);
  return known ? false : undefined;
}

export async function snomedDisplays(ids: Array<number | string>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const rows = (
    await query<{ concept_id: number; term: string }>(
      `
      SELECT DISTINCT ON (concept_id) concept_id, term
      FROM snomed.descriptions
      WHERE concept_id = ANY($1::bigint[]) AND active = TRUE
      ORDER BY concept_id, us_preferred DESC NULLS LAST
      `,
      [ids],
    )
  ).rows;
  for (const r of rows) out.set(Number(r.concept_id), r.term);
  return out;
}

/**
 * DB-backed dependencies for the pure terminology core, scoped to a package
 * closure. `exactCodeSystems` (FHIR validation) resolves CodeSystems by exact
 * canonical only, like the HL7 validator.
 */
export function dbTerminologyDeps(pkg: PackageRow, exactCodeSystems = false): TerminologyDeps {
  return {
    loadValueSet: (url) => loadValueSet(url, pkg),
    loadCodeSystem: (url) => loadCodeSystemIndex(url, pkg, exactCodeSystems),
    lookupExternal: (system, code) => lookupExternalTables(system, code),
    externalSystemHeld: (system) => externalSystemHeld(system),
    snomedSubsumedBy: (code, ancestor) => snomedSubsumedBy(code, ancestor),
    snomedDescendants: async (code, limit) => (await snomedDescendants(code, limit)).map(String),
    snomedDisplays: async (codes) => {
      const m = await snomedDisplays(codes);
      const out = new Map<string, string>();
      for (const [k, v] of m) out.set(String(k), v);
      return out;
    },
  };
}

/** Tiered expansion of a ValueSet `compose` block (nested hierarchies included). */
export async function expandCompose(
  compose: Record<string, any>,
  pkg: PackageRow,
  limit: number = DEFAULT_EXPAND_LIMIT,
): Promise<ExpandResult> {
  return expandComposeWith(compose || {}, dbTerminologyDeps(pkg), limit);
}

/** Rule-based membership (no expansion cap). undefined = cannot be decided locally. */
export async function valueSetMembership(
  vsUrl: string,
  system: string | null,
  code: string,
  pkg: PackageRow,
  exactCodeSystems = false,
): Promise<boolean | undefined> {
  return valueSetContains(vsUrl, system, code, dbTerminologyDeps(pkg, exactCodeSystems));
}

/** Does the package closure hold a CodeSystem with exactly this canonical (any content mode)? */
export async function codeSystemInClosure(url: string, pkg: PackageRow): Promise<boolean> {
  return (await loadArtifactByCanonical("CodeSystem", url, pkg)) !== null;
}
