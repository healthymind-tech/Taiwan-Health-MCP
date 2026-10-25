/**
 * FHIR IG Service — discovery + StructureDefinition reading + terminology +
 * validation + schema-guided authoring. Faithful port of `src/fhir_ig_service.py`.
 *
 * Generic, IG-scoped read layer over the multi-IG `fhir.*` store. Every public
 * method resolves a target package (default IG when none given) and returns the
 * toolset's common envelope `{ok, data, warnings, provenance, error?}` as a JSON
 * string. No new data and no external service beyond the optional embedding
 * service for semantic normalize_code.
 */

import { performance } from "node:perf_hooks";
import { query, queryCount, trackQueryFailures } from "./db.js";
import { TtlMemo } from "./ttlMemo.js";
import { logError, logInfo } from "./logger.js";
import type { EmbeddingService, QueryTask } from "./embeddingService.js";
import { vecLiteral } from "./embeddingService.js";
import type { RankedCandidate } from "./hybridRank.js";
import { rankIcdDiagnoses, rankLoinc, rankSnomed } from "./terminologyRanking.js";
import * as fhirIg from "./fhirIg.js";
import type { PackageRow } from "./fhirIg.js";
import * as snapshot from "./fhirSnapshot.js";
import * as terminology from "./fhirTerminology.js";
import * as validator from "./fhirValidator.js";
import { DbValidatorResolver, icd10cmStrict } from "./fhirValidationResolver.js";
import { composeContains } from "./fhirCodeSystem.js";
import * as reference from "./fhirReference.js";
import * as authoring from "./fhirAuthoring.js";
import { pushAll } from "./arrayUtils.js";
import {
  compactRow,
  compactView,
  derivationRuleFor,
  derivedCodeMeanings,
  effectiveRequiredPaths,
  instanceExtensionSites,
  nodesAt,
  OPTIONAL_ROWS_NOTE,
  projectForRequired,
  READING_GUIDE,
  READING_GUIDE_COMPACT,
  requiredElements,
  type MustSupportMode,
  type ProjectedElement,
  type RequiredElementRow,
  type RequiredElementsResult,
} from "./fhirRequiredElements.js";
import { toolVersion } from "./toolVersions.js";
import { IgConceptSearch, type CsLocation } from "./conceptSearch/service.js";
import { KEYWORD_ONLY_MODE, KEYWORD_ONLY_NOTE } from "./searchQuality.js";
import { attachSuggestions } from "./fhirSuggestions/index.js";
import { dbSuggestionDeps, type ServiceHooks } from "./fhirSuggestions/dbDeps.js";
import { attachIdSuggestions, isIdClassIssue, normalizationIssues } from "./fhirSuggestions/ids.js";
import { BUNDLE_TYPES, bundleRules, finalizeBundle as runBundleFinalize, losslessFinalizedBundle, type FinalizeDeps, type FinalizeResult } from "./fhirBundleFinalize.js";
import { restoreNumbers, stringifyLossless, toPlain } from "./losslessJson.js";
import { cloneTree, countByRule, DEFAULT_FINALIZE_REPAIR, repairBundle, repairResource, type RepairIssue, type RepairMode, type RepairResult } from "./fhirRepair/index.js";
import { repairDepsFor } from "./fhirRepair/dbDeps.js";

/** fhir_get_profile_required_elements compact view: profile invariants listed in full before the rest are named only. */
const COMPACT_INVARIANTS = 8;
/** fhir_get_profile_required_elements: allowedCodes cap for a required binding / for a derived row's binding. */
const REQUIRED_CODES_CAP = 12;
const DERIVED_CODES_CAP = 20;
/** FHIR_VALIDATE_PROFILE=1 logs per-phase timings + DB round-trips of every validation (stderr). */
const VALIDATE_PROFILE = process.env.FHIR_VALIDATE_PROFILE === "1";
/** loadArtifact memo: (closure, identifier) → artifact row; package content is immutable per version. */
const artifactMemo = new TtlMemo<Record<string, any> | null>(10 * 60_000, 400);
/** The parsed ConceptMaps of a closure (fhir_normalize_code reads every one of them per call). */
const conceptMapsMemo = new TtlMemo<Array<Record<string, any>>>(10 * 60_000, 8);

const SKELETON_SKIP = new Set(["id", "meta", "text", "implicitRules", "language", "contained"]);

const ARTIFACT_SUMMARY_COLS = `artifact_key, resource_type, artifact_id, canonical_url,
    name, title, status, kind, base_type, derivation, grouping_id, grouping_name,
    child_count, concept_count`;

const VALID_VIEWS = new Set(["elements", "element", "slices", "choices", "binding", "examples"]);
const PATH_REQUIRED_VIEWS = new Set(["element", "slices", "choices", "binding"]);

function jsonValue(raw: any): Record<string, any> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw || {};
}

/** Extract `(system, code)` pairs from a coded value node, by element type. */
function codingsOf(node: any, typeCode: string | null | undefined): Array<[string | null, string | null]> {
  if (typeof node === "string") return [[null, node]];
  if (!(node && typeof node === "object" && !Array.isArray(node))) return [];
  if (typeCode === "Coding" || ("system" in node && "code" in node)) {
    return [[node.system ?? null, node.code ?? null]];
  }
  const codings = node.coding;
  if (Array.isArray(codings)) {
    return codings
      .filter((c) => c && typeof c === "object")
      .map((c) => [c.system ?? null, c.code ?? null] as [string | null, string | null]);
  }
  return [];
}

/** Next step for each FHIR IG tool error code (added as error.hint; the code and message are unchanged). */
export const IG_ERROR_HINTS: Readonly<Record<string, string>> = {
  IG_NOT_FOUND:
    "That IG package/version is not installed. Pick one from error.installed_igs (or call fhir_list_igs) and pass it as " +
    "package_id (+ version), or omit package_id to use the default IG.",
  NO_DEFAULT_IG:
    "Pass package_id (one of error.installed_igs) on every FHIR IG call, or ask an administrator to set a default IG " +
    "in the admin console (IG 套件庫).",
  ARTIFACT_NOT_FOUND:
    "Find the profile's canonical URL or id with fhir_list_resource_profiles (by base_type, e.g. Condition) or " +
    "fhir_search_artifacts (keyword), then call again with that value; if it belongs to another installed IG, pass its package_id.",
  VALUESET_NOT_FOUND:
    "Find the ValueSet canonical with fhir_search_artifacts (keyword, resource_type=ValueSet) or read the element binding " +
    "with fhir_get_profile_elements(view=binding); if it belongs to another installed IG, pass its package_id.",
  INVALID_ARGUMENT: "Check the arguments against this tool's description and input schema, then call again.",
};

export class FHIRIGService {
  private embeddingSvc: EmbeddingService | null;
  /** Free-text search over IG CodeSystems (fhir_normalize_code, search_medical_codes system=…). */
  readonly conceptSearch: IgConceptSearch;

  constructor(embeddingSvc: EmbeddingService | null = null) {
    this.embeddingSvc = embeddingSvc;
    this.conceptSearch = new IgConceptSearch(embeddingSvc);
  }

  async initialize(): Promise<void> {
    const r = await query<{ count: string }>("SELECT COUNT(*) AS count FROM fhir.ig_packages");
    const count = Number(r.rows[0]?.count ?? 0);
    if (count) {
      logInfo(`FHIR IG Service ready (${count} IG package(s) registered)`);
    } else {
      logError("FHIR IG registry empty — import an IG package first");
    }
  }

  // --- Envelope + resolution helpers --------------------------------------- //

  private provenance(pkg: PackageRow): Record<string, any> {
    const prov: Record<string, any> = {
      packageId: pkg.package_id,
      version: pkg.version,
      fhirVersion: pkg.fhir_version,
      source: "ig",
    };
    // How the package was chosen (fhirIg.ResolvedBy) and, when the closure holds several
    // versions of a package, which one canonical lookups use.
    if (pkg._resolvedBy) prov.resolved_by = pkg._resolvedBy;
    if (pkg._closureVersions) prov.closure_versions = pkg._closureVersions;
    return prov;
  }

  private ok(data: any, pkg: PackageRow | null, warnings: any[] | null = null): string {
    const notes = (pkg?._notes as string[] | undefined) || [];
    const env = {
      ok: true,
      data,
      warnings: notes.length ? [...notes, ...(warnings || [])] : warnings || [],
      provenance: pkg ? this.provenance(pkg) : null,
    };
    // stringifyLossless ≡ JSON.stringify unless the data holds RawNumbers (a Bundle / resource
    // returned with the caller's number spellings, losslessJson.ts).
    return stringifyLossless(env);
  }

  /** Add `deps_missing` (declared dependencies not installed) to a data object when the closure is incomplete. */
  private withDeps<T extends Record<string, any>>(data: T, pkg: PackageRow): T {
    const missing = (pkg._depsMissing as fhirIg.DepMissing[] | undefined) || [];
    if (missing.length && data && typeof data === "object") (data as Record<string, any>).deps_missing = missing;
    return data;
  }

  /**
   * Envelope provenance ({packageId, version, fhirVersion, source}) of the IG package a request
   * names (default IG when packageId is null), or null when it is not installed. Never throws.
   */
  async packageProvenance(packageId: string | null, version: string | null): Promise<Record<string, any> | null> {
    try {
      const [pid, ver] = await fhirIg.resolvePackage(packageId ? { packageId, version } : null);
      const pkg = await fhirIg.getPackage(pid, ver);
      return pkg ? this.provenance(pkg) : null;
    } catch {
      return null;
    }
  }

  private err(code: string, message: string, extra: Record<string, unknown> = {}): string {
    const hint = IG_ERROR_HINTS[code];
    return JSON.stringify({ ok: false, data: null, warnings: [], error: { code, message, ...(hint ? { hint } : {}), ...extra } });
  }

  /** IG_NOT_FOUND / NO_DEFAULT_IG envelope, listing the installed packages so the caller can pick a package_id. */
  private async igErr(e: fhirIg.IGNotFoundError): Promise<string> {
    let installed: string[] = [];
    try {
      installed = (await fhirIg.listPackages()).map((p) => `${p.package_id}#${p.version}${p.is_default ? " (default)" : ""}`);
    } catch {
      installed = [];
    }
    return this.err(e.code, e.message, { installed_igs: installed.slice(0, 50), installed_ig_count: installed.length });
  }

  /**
   * Resolve the target package (fhirIg.resolveTarget precedence: explicit |version on a canonical →
   * package_id/version → owner of the meta.profile / canonical arguments → default IG → sole manual IG).
   * The row carries `_closure` plus `_resolvedBy`, `_closureVersions`, `_depsMissing`, `_notes`.
   */
  private async resolve(
    packageId: string | null | undefined,
    version: string | null | undefined,
    hints: { canonicals?: Array<string | null | undefined>; metaProfiles?: string[] } = {},
  ): Promise<PackageRow> {
    const t = await fhirIg.resolveTarget({
      packageId: packageId || null,
      version: packageId ? version ?? null : null,
      canonicals: hints.canonicals,
      metaProfiles: hints.metaProfiles,
    });
    return {
      ...t.pkg,
      _closure: t.closure,
      _resolvedBy: t.resolvedBy,
      _closureVersions: t.closureVersions,
      _depsMissing: t.depsMissing,
      _notes: t.notes,
    };
  }

  /**
   * Artifact row by id / canonical / key within a package (closure fallback), memoised: the
   * same (package version, identifier) is asked on every validation (meta.profile) and by every
   * binding suggestion (the bound ValueSet), and a package version's content is immutable.
   */
  private loadArtifact(pkg: PackageRow, identifier: string): Promise<Record<string, any> | null> {
    const key = `${terminology.closureKey(pkg)}|${identifier}`;
    return artifactMemo.get(key, () => this.loadArtifactUncached(pkg, identifier));
  }

  private async loadArtifactUncached(pkg: PackageRow, identifier: string): Promise<Record<string, any> | null> {
    const pid = pkg.package_id;
    const ver = pkg.version;
    if (identifier.includes("|")) {
      // Versioned canonical: only that version (artifact version, else package version) in the closure.
      return (await fhirIg.resolveCanonicalVersioned(identifier, pkg)) as Record<string, any> | null;
    }
    const row = (
      await query<Record<string, any>>(
        `SELECT ${ARTIFACT_SUMMARY_COLS}, raw_json
         FROM fhir.artifacts
         WHERE package_id = $1 AND package_version = $2
           AND (artifact_id = $3 OR canonical_url = $3 OR artifact_key = $3)
         ORDER BY (artifact_id = $3) DESC
         LIMIT 1`,
        [pid, ver, identifier],
      )
    ).rows[0];
    if (row) return row;
    return fhirIg.resolveCanonical(identifier, pid, ver);
  }

  /** ARTIFACT_NOT_FOUND message; for a versioned canonical, list the versions that are installed. */
  private async notFound(kind: string, identifier: string): Promise<string> {
    const { url, version } = fhirIg.splitCanonical(identifier);
    if (!version) return `${kind} not found: ${identifier}`;
    let have: string[] = [];
    try {
      have = [...new Set((await fhirIg.findPackagesForCanonical(url)).map((o) => `${o.artifact_version} (${o.package_id}#${o.package_version})`))];
    } catch {
      have = [];
    }
    return (
      `${kind} not found: ${url} version ${version} is not in the resolved package closure` +
      (have.length ? `; installed versions: ${have.join(", ")}` : "; no installed package holds this canonical")
    );
  }

  private isIGNotFound(e: unknown): e is fhirIg.IGNotFoundError {
    return e instanceof fhirIg.IGNotFoundError;
  }

  // --- A. IG discovery ----------------------------------------------------- //

  async listIgs(compact = false): Promise<string> {
    const packages = await fhirIg.listPackages();
    if (compact) return this.ok(compactIgList(packages), null);
    const data = {
      count: packages.length,
      igs: packages.map((p) => ({
        packageId: p.package_id,
        version: p.version,
        title: p.title ?? null,
        canonical: p.canonical ?? null,
        fhirVersion: p.fhir_version ?? null,
        status: p.status ?? null,
        isDefault: Boolean(p.is_default),
        installOrigin: p.install_origin ?? null,
        dependencies: p.dependencies || {},
      })),
    };
    return this.ok(data, null);
  }

  async getIg(packageId: string | null = null, version: string | null = null): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const rows = (
      await query<{ resource_type: string; n: string }>(
        "SELECT resource_type, COUNT(*) AS n FROM fhir.artifacts " +
          "WHERE package_id = $1 AND package_version = $2 " +
          "GROUP BY resource_type ORDER BY resource_type",
        [pkg.package_id, pkg.version],
      )
    ).rows;
    const artifactCounts: Record<string, number> = {};
    for (const r of rows) artifactCounts[r.resource_type] = Number(r.n);
    const data = {
      packageId: pkg.package_id,
      version: pkg.version,
      title: pkg.title ?? null,
      canonical: pkg.canonical ?? null,
      fhirVersion: pkg.fhir_version ?? null,
      status: pkg.status ?? null,
      isDefault: Boolean(pkg.is_default),
      installOrigin: pkg.install_origin ?? null,
      dependencies: pkg.dependencies || {},
      artifactCounts,
    };
    return this.ok(this.withDeps(data, pkg), pkg);
  }

  /**
   * Zero hits in the target package: which other installed packages match the same filters
   * (so a caller searching the default IG for e.g. "Claim" learns that the PAS package has it).
   */
  private async zeroHitHint(filters: (q: SqlParams) => string[], pkg: PackageRow | null): Promise<Record<string, any> | null> {
    const q = new SqlParams();
    const where = filters(q);
    const origin = new Map((await fhirIg.loadRegistry()).map((r) => [`${r.package_id} ${r.version}`, r.install_origin ?? null]));
    const rows = (
      await query<{ package_id: string; package_version: string; n: string }>(
        "SELECT package_id, package_version, COUNT(*) AS n FROM fhir.artifacts" +
          (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
          " GROUP BY package_id, package_version",
        q.params,
      )
    ).rows
      .filter((r) => !pkg || r.package_id !== pkg.package_id || r.package_version !== pkg.version)
      .map((r) => ({
        packageId: r.package_id,
        version: r.package_version,
        installOrigin: origin.get(`${r.package_id} ${r.package_version}`) ?? null,
        matches: Number(r.n),
      }))
      // Manually-installed IGs first (what the caller most likely means), then by match count.
      .sort(
        (x, y) =>
          (y.installOrigin === "manual" ? 1 : 0) - (x.installOrigin === "manual" ? 1 : 0) ||
          y.matches - x.matches ||
          (x.packageId < y.packageId ? -1 : x.packageId > y.packageId ? 1 : 0) ||
          fhirIg.compareVersions(y.version, x.version),
      );
    if (!rows.length) return null;
    return {
      message:
        `0 results in ${pkg ? `${pkg.package_id}#${pkg.version}` : "the target package"}, but ${rows.length} other installed ` +
        "package(s) match: pass package_id (and version) to search one of them, or all_packages=true to search every installed package.",
      packages: rows.slice(0, 10),
    };
  }

  async listArtifacts(
    packageId: string | null = null,
    version: string | null = null,
    resourceType: string | null = null,
    groupingId: string | null = null,
    limit = 50,
    allPackages = false,
    compact = false,
  ): Promise<string> {
    limit = Math.min(Math.max(1, limit), 200);
    const filters = (q: SqlParams): string[] => {
      const out: string[] = [];
      if (resourceType) out.push(`resource_type = ${q.add(resourceType)}`);
      if (groupingId) out.push(`grouping_id = ${q.add(groupingId)}`);
      return out;
    };
    return this.artifactQuery(packageId, version, allPackages, filters, limit, "ORDER BY resource_type, name", compact);
  }

  async searchArtifacts(
    keyword: string,
    packageId: string | null = null,
    version: string | null = null,
    resourceType: string | null = null,
    limit = 20,
    allPackages = false,
    compact = false,
  ): Promise<string> {
    limit = Math.min(Math.max(1, limit), 100);
    const filters = (q: SqlParams): string[] => {
      const out: string[] = [];
      if (resourceType) out.push(`resource_type = ${q.add(resourceType)}`);
      const kw = q.add(keyword);
      const like = q.add(`%${keyword}%`);
      out.push(
        "(to_tsvector('simple', COALESCE(artifact_id,'') || ' ' || " +
          "COALESCE(canonical_url,'') || ' ' || COALESCE(name,'') || ' ' || " +
          "COALESCE(title,'') || ' ' || COALESCE(description,'')) " +
          `@@ plainto_tsquery('simple', ${kw}) OR artifact_id ILIKE ${like})`,
      );
      return out;
    };
    return this.artifactQuery(packageId, version, allPackages, filters, limit, "ORDER BY resource_type, name", compact);
  }

  /** Shared body of list/search: one package (default resolution) or every installed package. */
  private async artifactQuery(
    packageId: string | null,
    version: string | null,
    allPackages: boolean,
    filters: (q: SqlParams) => string[],
    limit: number,
    orderBy: string,
    compact = false,
  ): Promise<string> {
    if (allPackages) {
      const q = new SqlParams();
      const where = filters(q);
      const lim = q.add(limit);
      const rows = (
        await query<Record<string, any>>(
          `SELECT package_id, package_version, ${ARTIFACT_SUMMARY_COLS} FROM fhir.artifacts ` +
            (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
            `${orderBy}, package_id, package_version LIMIT ${lim}`,
          q.params,
        )
      ).rows;
      if (compact) return this.ok({ scope: "all_packages", count: rows.length, ...compactByPackage(rows, ARTIFACTS_COMPACT) }, null);
      return this.ok({ scope: "all_packages", count: rows.length, artifacts: rows }, null);
    }
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const q = new SqlParams();
    const clauses = [`package_id = ${q.add(pkg.package_id)}`, `package_version = ${q.add(pkg.version)}`, ...filters(q)];
    const lim = q.add(limit);
    const rows = (
      await query<Record<string, any>>(
        `SELECT ${ARTIFACT_SUMMARY_COLS} FROM fhir.artifacts WHERE ${clauses.join(" AND ")} ${orderBy} LIMIT ${lim}`,
        q.params,
      )
    ).rows;
    const data: Record<string, any> = compact
      ? { count: rows.length, ...compactArtifactGroup(rows, ARTIFACTS_COMPACT) }
      : { count: rows.length, artifacts: rows };
    if (!rows.length) {
      const hint = await this.zeroHitHint(filters, pkg);
      if (hint) data.hint = hint;
    }
    return this.ok(data, pkg);
  }

  // --- B. Profile selection ------------------------------------------------ //

  async listResourceProfiles(
    packageId: string | null = null,
    version: string | null = null,
    baseType: string | null = null,
    allPackages = false,
    compact = false,
  ): Promise<string> {
    const filters = (q: SqlParams): string[] => {
      const out = ["resource_type = 'StructureDefinition'", "derivation = 'constraint'", "kind = 'resource'"];
      if (baseType) out.push(`base_type = ${q.add(baseType)}`);
      return out;
    };
    let pkg: PackageRow | null = null;
    if (!allPackages) {
      try {
        pkg = await this.resolve(packageId, version);
      } catch (e) {
        if (this.isIGNotFound(e)) return await this.igErr(e);
        throw e;
      }
    }
    const q = new SqlParams();
    const clauses = pkg ? [`package_id = ${q.add(pkg.package_id)}`, `package_version = ${q.add(pkg.version)}`] : [];
    clauses.push(...filters(q));
    const rows = (
      await query<Record<string, any>>(
        `SELECT ${pkg ? "" : "package_id, package_version, "}artifact_id, canonical_url, name, title, base_type, status
         FROM fhir.artifacts
         WHERE ${clauses.join(" AND ")}
         ORDER BY base_type, COALESCE(NULLIF(title,''), name, artifact_id)${pkg ? "" : ", package_id, package_version"}`,
        q.params,
      )
    ).rows;
    if (compact) {
      const sdRows = rows.map((r) => ({ ...r, resource_type: "StructureDefinition" }));
      if (!pkg) return this.ok({ scope: "all_packages", count: rows.length, ...compactByPackage(sdRows, PROFILES_COMPACT) }, null);
      const data: Record<string, any> = { count: rows.length, ...compactArtifactGroup(sdRows, PROFILES_COMPACT) };
      if (!rows.length) {
        const hint = await this.zeroHitHint(filters, pkg);
        if (hint) data.hint = hint;
      }
      return this.ok(data, pkg);
    }
    const byType: Record<string, any[]> = {};
    for (const r of rows) {
      const key = r.base_type || "";
      if (!byType[key]) byType[key] = [];
      const item: Record<string, any> = {
        profile: r.artifact_id,
        canonical: r.canonical_url,
        title: r.title || r.name || r.artifact_id,
        status: r.status,
      };
      if (!pkg) {
        item.packageId = r.package_id;
        item.version = r.package_version;
      }
      byType[key].push(item);
    }
    if (!pkg) return this.ok({ scope: "all_packages", count: rows.length, byResourceType: byType }, null);
    const data: Record<string, any> = { count: rows.length, byResourceType: byType };
    if (!rows.length) {
      const hint = await this.zeroHitHint(filters, pkg);
      if (hint) data.hint = hint;
    }
    return this.ok(data, pkg);
  }

  async rankResourceProfiles(
    keys: string[],
    packageId: string | null = null,
    version: string | null = null,
    baseType: string | null = null,
    limit = 5,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    limit = Math.min(Math.max(1, limit), 20);
    const params: any[] = [pkg.package_id, pkg.version];
    const clauses = [
      "package_id = $1",
      "package_version = $2",
      "resource_type = 'StructureDefinition'",
      "derivation = 'constraint'",
      "kind = 'resource'",
    ];
    if (baseType) {
      params.push(baseType);
      clauses.push(`base_type = $${params.length}`);
    }
    const rows = (
      await query<Record<string, any>>(
        `SELECT artifact_id, canonical_url, title, name, base_type, raw_json
         FROM fhir.artifacts WHERE ${clauses.join(" AND ")}`,
        params,
      )
    ).rows;
    const want = (keys || []).filter((k) => k && k.trim()).map((k) => k.trim().toLowerCase());
    const scored: any[] = [];
    for (const r of rows) {
      const sd = jsonValue(r.raw_json);
      const paths = snapshot.elementPaths(sd);
      const tails = new Set<string>();
      for (const p of paths) {
        if (p) tails.add(p.split(".").pop()!.toLowerCase().replace(/\[x\]$/, ""));
      }
      const matched = [...new Set(want.filter((k) => tails.has(k)))].sort();
      scored.push({
        profile: r.artifact_id,
        canonical: r.canonical_url,
        title: r.title || r.name || r.artifact_id,
        baseType: r.base_type,
        score: matched.length,
        matchedKeys: matched,
      });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0));
    const data: Record<string, any> = { selectionRequired: true, inputKeys: want, candidates: scored.slice(0, limit) };
    if (!rows.length) {
      const hint = await this.zeroHitHint((q) => {
        const out = ["resource_type = 'StructureDefinition'", "derivation = 'constraint'", "kind = 'resource'"];
        if (baseType) out.push(`base_type = ${q.add(baseType)}`);
        return out;
      }, pkg);
      if (hint) data.hint = hint;
    }
    return this.ok(data, pkg);
  }

  async getProfile(
    identifier: string,
    packageId: string | null = null,
    version: string | null = null,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [identifier] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const row = await this.loadArtifact(pkg, identifier);
    if (row === null) return this.err("ARTIFACT_NOT_FOUND", await this.notFound("profile", identifier));
    const sd = jsonValue(row.raw_json);
    const data = {
      artifactId: row.artifact_id ?? null,
      canonical: row.canonical_url ?? null,
      name: row.name ?? null,
      title: row.title ?? null,
      status: row.status ?? null,
      kind: row.kind ?? null,
      baseType: row.base_type ?? sd.type,
      derivation: row.derivation ?? null,
      baseDefinition: sd.baseDefinition,
      description: sd.description,
      elementCount: ((sd.snapshot || {}).element || []).length,
    };
    return this.ok(this.withDeps(data, pkg), pkg);
  }

  // --- C. Snapshot reader -------------------------------------------------- //

  async getProfileElements(
    profile: string,
    packageId: string | null = null,
    version: string | null = null,
    view = "elements",
    path: string | null = null,
    sliceName: string | null = null,
    limit = 200,
  ): Promise<string> {
    if (!VALID_VIEWS.has(view)) {
      return this.err("INVALID_ARGUMENT", `view must be one of ${pySortedSet(VALID_VIEWS)}`);
    }
    if (PATH_REQUIRED_VIEWS.has(view) && !path) {
      return this.err("INVALID_ARGUMENT", `path is required for view=${view}`);
    }
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [profile] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const row = await this.loadArtifact(pkg, profile);
    if (row === null) return this.err("ARTIFACT_NOT_FOUND", await this.notFound("profile", profile));
    const sd = jsonValue(row.raw_json);

    if (view === "examples") {
      const data = await this.profileExamples(pkg, row.canonical_url);
      return this.ok(this.withDeps(data, pkg), pkg);
    }

    let result: any;
    if (view === "elements") {
      const els = snapshot.projectElements(sd);
      result = { profile: row.artifact_id, total: els.length, elements: els.slice(0, Math.min(Math.max(1, limit), 1000)) };
    } else if (view === "element") {
      result = snapshot.getElement(sd, path!, sliceName);
    } else if (view === "slices") {
      result = snapshot.getSlices(sd, path!);
    } else if (view === "choices") {
      result = snapshot.getChoices(sd, path!);
    } else if (view === "binding") {
      result = snapshot.getBinding(sd, path!);
    } else {
      result = null;
    }

    const warnings: string[] = [];
    if (result === null) warnings.push(`no ${view} found at path '${path}'`);
    return this.ok(this.withDeps({ view, result }, pkg), pkg, warnings);
  }

  /**
   * fhir_get_profile_required_elements: every element the profile effectively
   * requires (required ancestor chain, required slices, value-or-dataAbsentReason
   * invariants, target-implied primary content), classified by where its value
   * comes from. Reads the same snapshot projection as getProfileElements.
   */
  async getProfileRequiredElements(
    profile: string,
    packageId: string | null = null,
    version: string | null = null,
    instance: Record<string, any> | null = null,
    includeTargetImplied = true,
    includeMustSupport: MustSupportMode = false,
    verbosity: "compact" | "full" = "compact",
  ): Promise<string> {
    if (!profile || !String(profile).trim()) return this.err("INVALID_ARGUMENT", "profile is required");
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [String(profile).trim()] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const ident = String(profile).trim();
    // A "|version" is honoured: a version that is not installed is ARTIFACT_NOT_FOUND (no silent fallback).
    const row = await this.loadArtifact(pkg, ident);
    if (row === null) return this.err("ARTIFACT_NOT_FOUND", await this.notFound("profile", profile));
    const sd = jsonValue(row.raw_json);
    if (sd.resourceType !== "StructureDefinition" || !((sd.snapshot || {}).element || []).length) {
      return this.err("INVALID_ARGUMENT", `${profile} is not a StructureDefinition with a snapshot`);
    }
    const warnings: string[] = [];
    if (instance && instance.resourceType && sd.type && instance.resourceType !== sd.type) {
      warnings.push(`instance.resourceType '${instance.resourceType}' does not match profile type '${sd.type}'`);
    }
    const els = projectForRequired(sd.snapshot.element, snapshot.projectElement);
    const E = new Map(els.map((e) => [e.id, e]));
    const result = requiredElements(row.artifact_id ?? ident, els, {
      instance: instance ?? null,
      includeTargetImplied,
      includeMustSupport,
    });
    await this.expandExtensionRows(pkg, result, E, instance ?? null, 0);
    if (instance) await this.expandInstanceExtensions(pkg, result, els, E, instance);

    // Small required bindings: list the allowed codes so the caller need not expand the ValueSet.
    // Derived rows (Condition.category, ...) also for extensible / preferred bindings, with a
    // larger cap and — when no curated derivation rule applies — the codes' meanings.
    type VsEntry = { codes: string[]; system: string | null; codings: Array<{ system: string | null; code: string; display: string | null }> };
    const vsCache = new Map<string, VsEntry | null>();
    for (const r of result.elements) {
      const b = r.binding;
      if (!b?.valueSet || r.fixed || r.pattern) continue;
      const derived = r.grounding_class === "derived";
      if (b.strength !== "required" && !(derived && (b.strength === "extensible" || b.strength === "preferred"))) continue;
      const types = r.types.map((t) => t.split(".").pop());
      if (!types.some((t) => t === "code" || t === "Coding" || t === "CodeableConcept")) continue;
      const vsUrl = String(b.valueSet).split("|")[0];
      const cap = derived ? DERIVED_CODES_CAP : REQUIRED_CODES_CAP;
      const key = `${cap}\u0000${vsUrl}`;
      if (!vsCache.has(key)) {
        let entry: VsEntry | null = null;
        try {
          const vs = await this.loadValueset(pkg, vsUrl);
          if (vs !== null) {
            const exp = await terminology.expandCompose(vs.compose || {}, pkg, cap + 1);
            if (!exp.truncated && exp.codings.length > 0 && exp.codings.length <= cap) {
              const systems = new Set(exp.codings.map((c: any) => c.system ?? null));
              const single = systems.size === 1 ? ([...systems][0] as string | null) : null;
              entry = {
                codes: exp.codings.map((c: any) => (single === null && c.system ? `${c.system}|${c.code}` : String(c.code))),
                system: single,
                codings: exp.codings.map((c: any) => ({ system: c.system ?? null, code: String(c.code), display: c.display ?? null })),
              };
            }
          }
        } catch {
          entry = null;
        }
        vsCache.set(key, entry);
      }
      const entry = vsCache.get(key);
      if (entry && entry.codes.length) {
        r.allowedCodes = entry.codes;
        if (entry.system && !types.includes("code")) {
          r.hint = [r.hint, `coding.system ${entry.system}`].filter(Boolean).join("; ");
        }
        if (derived && !derivationRuleFor(r.path, r.binding)) {
          const defs = await this.conceptDefinitions(pkg, entry.codings).catch(() => new Map<string, string>());
          const meanings = derivedCodeMeanings(entry.codings.map((c) => ({ code: c.code, display: c.display, definition: defs.get(`${c.system}|${c.code}`) ?? null })));
          if (meanings) r.hint = [r.hint, meanings].filter(Boolean).join("; ");
        }
      }
    }

    const full = verbosity === "full";
    const data: Record<string, unknown> = {
      profile: result.profile,
      canonical: row.canonical_url ?? sd.url ?? null,
      resourceType: result.resourceType,
      verbosity: full ? "full" : "compact",
      count: result.count,
      summary: result.summary,
      guide: (full ? READING_GUIDE : READING_GUIDE_COMPACT) + (result.elements.some((r) => r.optional) ? ` ${OPTIONAL_ROWS_NOTE}` : ""),
      elements: full ? result.elements.map(compactRow) : compactView(result.elements, E),
    };
    // R4 (1.4.0): a Bundle profile also gets the Bundle-level core rules (fullUrl format, references =
    // target fullUrl, fixed Bundle.type, document order) generated from the core spec + this StructureDefinition.
    if (sd.type === "Bundle") data.bundle_rules = bundleRules(sd);
    if (result.invariants.length) {
      if (full) data.invariants = result.invariants;
      else {
        // Compact: first COMPACT_INVARIANTS rules (FHIRPath when short, else the human text, clipped);
        // the remaining keys are named so the caller knows to ask for verbosity='full'.
        const clip = (t: string): string => (t.length > 200 ? `${t.slice(0, 199)}…` : t);
        data.invariants = result.invariants.slice(0, COMPACT_INVARIANTS).map((i) => ({
          key: i.key,
          on: i.on.length === 1 ? i.on[0] : i.on,
          rule: clip(i.expression && i.expression.length <= 200 ? i.expression : i.human || i.expression),
        }));
        if (result.invariants.length > COMPACT_INVARIANTS) {
          data.moreInvariants = result.invariants.slice(COMPACT_INVARIANTS).map((i) => i.key);
        }
      }
    }
    this.withDeps(data, pkg);
    const notes = (pkg._notes as string[] | undefined) || [];
    const env = {
      ok: true,
      data,
      warnings: notes.length ? [...notes, ...warnings] : warnings,
      provenance: { ...this.provenance(pkg), tool: "fhir_get_profile_required_elements", toolVersion: toolVersion("fhir_get_profile_required_elements") },
    };
    return JSON.stringify(env);
  }

  /** CodeSystem definitions of `codings` (closure order: the first package that defines a code wins). */
  private async conceptDefinitions(pkg: PackageRow, codings: Array<{ system: string | null; code: string }>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const bySystem = new Map<string, string[]>();
    for (const c of codings) {
      if (!c.system) continue;
      if (!bySystem.has(c.system)) bySystem.set(c.system, []);
      bySystem.get(c.system)!.push(c.code);
    }
    const [pids, pvers] = terminology.closureArrays(pkg);
    for (const [system, codes] of bySystem) {
      const tail = terminology.canonicalTail(system);
      if (!tail) continue;
      const rows = (
        await query<{ code: string; definition: string | null }>(
          "SELECT c.code, c.definition FROM fhir.concepts c " +
            "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) ON c.package_id = dep.pid AND c.package_version = dep.pver " +
            "WHERE c.cs_id = $3 AND c.code = ANY($4::text[]) AND c.definition IS NOT NULL AND c.definition <> '' ORDER BY dep.ord",
          [pids, pvers, tail, codes],
        )
      ).rows;
      for (const r of rows) {
        const k = `${system}|${r.code}`;
        if (!out.has(k) && r.definition) out.set(k, r.definition);
      }
    }
    return out;
  }

  /**
   * Required extension rows whose type is a profiled Extension the snapshot does not
   * expand: splice in the extension definition's own required elements (url, value[x]
   * via ext-1, required sub-extensions), re-rooted under the row id. Recurses into nested
   * extension definitions (depth-limited).
   */
  private async expandExtensionRows(
    pkg: PackageRow,
    result: RequiredElementsResult,
    E: Map<string, ProjectedElement>,
    instance: Record<string, any> | null,
    depth: number,
  ): Promise<void> {
    if (depth > 2) return;
    const ids = new Set(result.elements.map((r) => r.id));
    // Targets: listed extension rows, plus (given a draft) optional profiled extensions it populates.
    type Target = { id: string; path: string; populatedOnly: boolean };
    const targets: Target[] = result.elements.map((r) => ({ id: r.id, path: r.path, populatedOnly: false }));
    if (instance) {
      for (const e of E.values()) {
        if (ids.has(e.id) || !e.types?.[0]?.profile?.length || e.types.length !== 1 || e.types[0].code !== "Extension") continue;
        if (nodesAt(instance, e.id, E).length) targets.push({ id: e.id, path: e.path, populatedOnly: true });
      }
    }
    const inserts = new Map<string, RequiredElementRow[]>();
    const appended: RequiredElementRow[] = [];
    for (const tg of targets) {
      const el = E.get(tg.id);
      const url = el?.types?.length === 1 && el.types[0].code === "Extension" ? el.types[0].profile?.[0] : undefined;
      if (!url) continue;
      if ([...E.keys()].some((k) => k.startsWith(`${tg.id}.value`) || k.startsWith(`${tg.id}.extension:`))) continue; // expanded in place
      const canon = String(url).split("|")[0];
      const via = tg.populatedOnly ? `; parent ${tg.id} populated` : "";
      let extSd: Record<string, any> | null = null;
      try {
        const art = await fhirIg.resolveCanonical(canon, pkg.package_id, pkg.version);
        extSd = art ? jsonValue((art as any).raw_json) : null;
      } catch {
        extSd = null;
      }
      const add: RequiredElementRow[] = [];
      if (!extSd || extSd.type !== "Extension" || !((extSd.snapshot || {}).element || []).length) {
        // Definition not installed: the url is still known and mandatory.
        const id = `${tg.id}.url`;
        if (!ids.has(id)) {
          ids.add(id);
          add.push({
            id, path: `${tg.path}.url`, min: 1, max: "1", types: ["uri"], binding: null,
            fixed: { field: "fixedUri", value: canon }, pattern: null, mustSupport: false,
            required_by: `extension:${canon.split("/").pop()} (definition not installed${via})`, grounding_class: "auto",
            hint: "extension definition not installed: give exactly one value[x] or nested extensions as it defines",
          });
        }
      } else {
        const xEls = projectForRequired(extSd.snapshot.element, snapshot.projectElement);
        const xE = new Map(xEls.map((e) => [e.id, e]));
        const item = instance ? ((nodesAt(instance, tg.id, E)[0] as Record<string, any> | undefined) ?? null) : null;
        const sub = requiredElements(extSd.id ?? canon, xEls, { instance: item ? { resourceType: "Extension", ...item } : null, includeTargetImplied: false });
        await this.expandExtensionRows(pkg, sub, xE, item ? { resourceType: "Extension", ...item } : null, depth + 1);
        const tag = `extension:${extSd.id ?? canon.split("/").pop()}`;
        for (const x of sub.elements) {
          const id = `${tg.id}${x.id.slice("Extension".length)}`;
          if (ids.has(id)) continue;
          ids.add(id);
          const path = `${tg.path}${x.path.slice("Extension".length)}`;
          add.push({ ...x, id, path, required_by: `${tag} (${x.required_by}${via})` });
          const xe = xE.get(x.id);
          if (xe) E.set(id, { ...xe, id, path });
        }
        for (const inv of sub.invariants) {
          if (!result.invariants.some((i) => i.key === inv.key && i.expression === inv.expression)) {
            result.invariants.push({ ...inv, on: inv.on.map((o) => `${tg.id}${o.slice("Extension".length)}`) });
          }
        }
      }
      if (!add.length) continue;
      if (tg.populatedOnly) appended.push(...add);
      else inserts.set(tg.id, add);
    }
    if (!inserts.size && !appended.length) return;
    const out: RequiredElementRow[] = [];
    for (const r of result.elements) {
      out.push(r);
      const add = inserts.get(r.id);
      if (add) out.push(...add);
    }
    out.push(...appended);
    result.elements = out;
    result.count = out.length;
    for (const k of Object.keys(result.summary) as Array<keyof typeof result.summary>) result.summary[k] = out.filter((x) => x.grounding_class === k).length;
  }

  /**
   * Extensions the draft carries outside any declared slice (unknown extensions, or inside
   * datatypes the profile does not expand): when the definition is installed, add its
   * required elements under a pseudo-slice id `<path>:<definition id>` (e.g. a core HL7
   * extension such as ordinalValue needs value[x]).
   */
  private async expandInstanceExtensions(
    pkg: PackageRow,
    result: RequiredElementsResult,
    els: ProjectedElement[],
    E: Map<string, ProjectedElement>,
    instance: Record<string, any>,
  ): Promise<void> {
    const sites = instanceExtensionSites(instance, els);
    if (!sites.length) return;
    const ids = new Set(result.elements.map((r) => r.id));
    const resolvedAt = new Map<string, boolean>(); // path -> every site resolved
    const added: RequiredElementRow[] = [];
    const seen = new Set<string>();
    for (const site of sites) {
      if (!site.url) {
        resolvedAt.set(site.path, false);
        continue;
      }
      let extSd: Record<string, any> | null = null;
      try {
        const art = await fhirIg.resolveCanonical(site.url, pkg.package_id, pkg.version);
        extSd = art ? jsonValue((art as any).raw_json) : null;
      } catch {
        extSd = null;
      }
      if (!extSd || extSd.type !== "Extension" || !((extSd.snapshot || {}).element || []).length) {
        resolvedAt.set(site.path, false);
        continue;
      }
      if (!resolvedAt.has(site.path)) resolvedAt.set(site.path, true);
      const tail = String(extSd.id ?? site.url.split("/").pop());
      const base = `${site.path}:${tail}`;
      if (seen.has(base)) continue;
      seen.add(base);
      const xEls = projectForRequired(extSd.snapshot.element, snapshot.projectElement);
      const xE = new Map(xEls.map((e) => [e.id, e]));
      const item = { resourceType: "Extension", ...site.item };
      const sub = requiredElements(tail, xEls, { instance: item, includeTargetImplied: false });
      await this.expandExtensionRows(pkg, sub, xE, item, 1);
      for (const x of sub.elements) {
        const id = `${base}${x.id.slice("Extension".length)}`;
        if (ids.has(id)) continue;
        ids.add(id);
        const path = `${site.path}${x.path.slice("Extension".length)}`;
        added.push({ ...x, id, path, required_by: `extension:${tail} (${x.required_by}; parent ${site.path} populated)` });
        const xe = xE.get(x.id);
        if (xe) E.set(id, { ...xe, id, path });
      }
    }
    if (!added.length) return;
    const out = result.elements.filter((r) => !(r.required_by.startsWith("datatype:Extension") && resolvedAt.get(r.id.replace(/\.url$/, "")) === true));
    out.push(...added);
    result.elements = out;
    result.count = out.length;
    for (const k of Object.keys(result.summary) as Array<keyof typeof result.summary>) result.summary[k] = out.filter((x) => x.grounding_class === k).length;
  }

  private async profileExamples(pkg: PackageRow, canonical: string | null | undefined): Promise<Record<string, any>> {
    if (!canonical) return { count: 0, examples: [] };
    const rows = (
      await query<Record<string, any>>(
        `SELECT artifact_id, resource_type, canonical_url, title, name
         FROM fhir.artifacts
         WHERE package_id = $1 AND package_version = $2
           AND grouping_id = 'examples'
           AND raw_json -> 'meta' -> 'profile' ? $3
         ORDER BY resource_type, artifact_id`,
        [pkg.package_id, pkg.version, canonical],
      )
    ).rows;
    return {
      count: rows.length,
      examples: rows.map((r) => ({
        artifactId: r.artifact_id,
        resourceType: r.resource_type,
        title: r.title || r.name || r.artifact_id,
      })),
    };
  }

  // --- D. Terminology ------------------------------------------------------ //

  private async loadValueset(pkg: PackageRow, identifier: string): Promise<Record<string, any> | null> {
    const row = await this.loadArtifact(pkg, identifier);
    if (row === null) return null;
    if (
      (row.resource_type || "").toLowerCase() !== "valueset" &&
      jsonValue(row.raw_json).resourceType !== "ValueSet"
    ) {
      return null;
    }
    return jsonValue(row.raw_json);
  }

  async getValueset(
    identifier: string,
    packageId: string | null = null,
    version: string | null = null,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [identifier] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const vs = await this.loadValueset(pkg, identifier);
    if (vs === null) return this.err("VALUESET_NOT_FOUND", await this.notFound("ValueSet", identifier));
    const data = {
      valueSetId: vs.id,
      canonical: vs.url,
      name: vs.name,
      title: vs.title,
      status: vs.status,
      description: vs.description,
      compose: vs.compose || {},
    };
    return this.ok(data, pkg);
  }

  async expandValueset(
    identifier: string,
    packageId: string | null = null,
    version: string | null = null,
    limit: number = terminology.DEFAULT_EXPAND_LIMIT,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [identifier] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const vs = await this.loadValueset(pkg, identifier);
    if (vs === null) return this.err("VALUESET_NOT_FOUND", await this.notFound("ValueSet", identifier));
    limit = Math.min(Math.max(1, limit), 2000);
    const exp = await terminology.expandCompose(vs.compose || {}, pkg, limit);
    const data = {
      valueSetId: vs.id,
      canonical: vs.url,
      total: exp.total,
      truncated: exp.truncated,
      unresolved: exp.unresolved,
      codings: exp.codings,
    };
    return this.ok(data, pkg, exp.warnings);
  }

  async lookupCode(
    system: string,
    code: string,
    packageId: string | null = null,
    version: string | null = null,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [system] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const found = await terminology.lookup(system, code, pkg);
    const warnings: string[] = [];
    if (found === null) {
      const edition = system === "http://hl7.org/fhir/sid/icd-10-cm" ? await terminology.icd10cmEdition() : null;
      if (icd10cmStrict(edition)) {
        // Complete current local edition: the code does not exist (tx.fhir.org agrees).
        warnings.push(`Unknown code '${code}' in the CodeSystem '${system}' version '${edition!.edition}'`);
      } else {
        warnings.push(
          "code not found in locally held terminology — it may belong to an " +
            "external system (TERMINOLOGY_SERVER_REQUIRED)",
        );
      }
    }
    const data: Record<string, unknown> = {
      system,
      code,
      found: found !== null,
      display: found ? found.display : null,
      definition: found ? found.definition : null,
    };
    if (found === null) {
      const loc = terminology.routeSystem(system) === "ig" || !system.includes("/") ? await this.locateIgCodeSystem(system, pkg) : null;
      if (loc) {
        const near = await this.conceptSearch.nearCodes(loc, code, 5).catch(() => []);
        if (near.length) data.near_codes = near;
      }
      data.hint =
        "To find the code for a name or free text (Chinese or English), call fhir_normalize_code with " +
        `text=<the name> and system=${loc ? loc.url : system}` +
        (loc ? "" : " (an IG CodeSystem canonical or id)") +
        (data.near_codes ? "; near_codes lists existing codes that look like this one." : ".");
    }
    return this.ok(data, pkg, warnings);
  }

  /** The IG CodeSystem a canonical / id / alias names (closure first, then any installed IG). */
  async locateIgCodeSystem(system: string, pkg: PackageRow): Promise<CsLocation | null> {
    try {
      const loc = await this.conceptSearch.locate(system, pkg);
      if (loc) return loc;
      if (/^[a-z][a-z0-9+.-]*:/i.test(system)) return null; // a URI that is not an IG CodeSystem
      return (await this.conceptSearch.resolveAlias(system, pkg)).location;
    } catch (e) {
      logError("IG CodeSystem resolution failed", { error: String((e as Error).message) });
      return null;
    }
  }

  async validateCode(
    system: string,
    code: string,
    valueSet: string,
    packageId: string | null = null,
    version: string | null = null,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [valueSet] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const vs = await this.loadValueset(pkg, valueSet);
    if (vs === null) return this.err("VALUESET_NOT_FOUND", await this.notFound("ValueSet", valueSet));
    // Rule-based membership: nested CodeSystem hierarchies and filters, no expansion cap.
    const membership = vs.url
      ? await terminology.valueSetMembership(vs.url, system, code, pkg)
      : await composeMembership(vs, system, code, pkg);
    const warnings: string[] = [];
    let result: string;
    if (membership === true) {
      result = "valid";
    } else if (membership === undefined) {
      result = "unverifiable";
      warnings.push(
        "membership could not be confirmed locally (system not held or filter " +
          "not evaluable); confirm against a terminology server",
      );
    } else {
      result = "invalid";
    }
    const member = membership === true;
    const data = { system, code, valueSet: vs.url || valueSet, result, valid: member };
    return this.ok(data, pkg, warnings);
  }

  async normalizeCode(
    text: string,
    valueSet: string | null = null,
    system: string | null = null,
    packageId: string | null = null,
    version: string | null = null,
    limit = 10,
  ): Promise<string> {
    if (!(valueSet || system)) {
      return this.err("INVALID_ARGUMENT", "provide a value_set or a target system");
    }
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [valueSet, system] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    return this.normalizeCodeIn(pkg, packageId !== null || version !== null, text, valueSet, system, limit);
  }

  /**
   * fhir_normalize_code within an already resolved package. `pinned`: the caller named the
   * package (package_id / version), so an excerpt CodeSystem is searched as is and the fuller
   * copy only mentioned. The suggestion layer calls this directly with the validation's
   * package (pinned) instead of resolving the same package again per suggestion.
   */
  private async normalizeCodeIn(
    pkg: PackageRow,
    pinned: boolean,
    text: string,
    valueSet: string | null,
    system: string | null,
    limit: number,
  ): Promise<string> {
    limit = Math.min(Math.max(1, limit), 50);

    const { targets, scopeIds, warnings, locations } = await this.normalizeTargets(pkg, valueSet, system);
    if (!targets.length) {
      return this.err(
        valueSet ? "VALUESET_NOT_FOUND" : "INVALID_ARGUMENT",
        "could not determine a target system to normalize against",
      );
    }

    const candidates: any[] = [];
    const seen = new Set<string>();
    const add = (sys_: string | null, code: string, display: any, source: string, score: number) => {
      const key = `${sys_} ${code}`;
      if (seen.has(key) || !code) return;
      seen.add(key);
      candidates.push({ system: sys_, code, display, source, score: round4(score) });
    };

    for (const [sys_, code, display] of await this.normalizeConceptmap(pkg, text, targets)) {
      add(sys_, code, display, "conceptmap", 1.0);
    }
    // IG CodeSystems: the concept-search engine (designations in any language, supplements,
    // linked names, abbreviations, hybrid lexical + semantic). Its order is kept as ranked.
    const engine: any[] = [];
    const clauses: Array<Record<string, unknown>> = [];
    let keywordOnly = false;
    const engineSystems = new Set<string>();
    const fullerCopies: Array<Record<string, unknown>> = [];
    for (const tgt of targets) {
      if (tgt.kind !== "ig") continue;
      let loc = locations.get(tgt.system) ?? (await this.locateIgCodeSystem(tgt.system, pkg));
      if (!loc) continue;
      // The resolved IG ships only an excerpt of this CodeSystem (e.g. TW Core 1.0.0 medication-nhi-tw:
      // 35 codes) while another installed package holds the full list: search the full copy unless
      // the caller pinned package_id / version.
      const fuller = await this.conceptSearch.fullerCopy(loc).catch(() => null);
      if (fuller && pinned) {
        warnings.push(
          `${tgt.system}: ${loc.packageId}@${loc.packageVersion} holds only ${fuller.ownConcepts} codes of this CodeSystem (an excerpt); ` +
            `a fuller copy (${fuller.concepts} codes) is installed in ${fuller.location.packageId}@${fuller.location.packageVersion} — ` +
            "pass that package_id / version, or omit both, to search it.",
        );
      } else if (fuller) {
        warnings.push(
          `${tgt.system}: ${loc.packageId}@${loc.packageVersion} holds only ${fuller.ownConcepts} codes of this CodeSystem (an excerpt); ` +
            `searched the fuller copy in ${fuller.location.packageId}@${fuller.location.packageVersion} (${fuller.concepts} codes). ` +
            `Validation against ${loc.packageId}@${loc.packageVersion} may not recognise codes outside its excerpt.`,
        );
        fullerCopies.push({ system: tgt.system, packageId: fuller.location.packageId, version: fuller.location.packageVersion, concepts: fuller.concepts, excerpt: { packageId: loc.packageId, version: loc.packageVersion, concepts: fuller.ownConcepts } });
        loc = fuller.location;
      }
      engineSystems.add(tgt.system);
      const res = await this.conceptSearch.search(loc, text, limit, { links: true });
      if (res.keywordOnly) keywordOnly = true;
      if (res.clauses) clauses.push(...res.clauses.map((c) => ({ ...c, system: tgt.system })));
      for (const w of res.warnings) warnings.push(w);
      for (const c of res.candidates) {
        const key = `${tgt.system} ${c.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        engine.push({
          system: tgt.system,
          code: c.code,
          display: c.display,
          source: c.match === "exact" ? "lexical" : c.match,
          score: c.score,
          matched_term: c.matched_term,
          matched_language: c.matched_language,
          ...(c.match === "exact" ? { exact: true } : {}),
          ...(c.category ? { category: c.category } : {}),
          ...(c.siblings ? { group: c.group, siblings: c.siblings } : {}),
          ...(c.linked ? { linked: c.linked } : {}),
          ...(c.linked_more ? { linked_more: c.linked_more } : {}),
        });
      }
    }
    // SNOMED CT / LOINC / ICD-10-CM: the same hybrid ranking as the module search tools
    // (terminologyRanking.ts), kept in its own order.
    const hybrid: any[] = [];
    for (const tgt of targets) {
      if (engineSystems.has(tgt.system) || !HYBRID_KINDS.has(tgt.kind)) continue;
      for (const c of await this.normalizeHybrid(tgt, text, scopeIds[tgt.system], limit)) {
        const key = `${c.system} ${c.code}`;
        if (seen.has(key) || !c.code) continue;
        seen.add(key);
        hybrid.push(c);
      }
    }
    for (const tgt of targets) {
      if (engineSystems.has(tgt.system) || HYBRID_KINDS.has(tgt.kind)) continue;
      for (const [sys_, code, display] of await this.normalizeLexical(pkg, tgt, text, scopeIds[tgt.system], limit)) {
        add(sys_, code, display, "lexical", 0.6);
      }
    }

    const order: Record<string, number> = { conceptmap: 0, lexical: 1, semantic: 2 };
    candidates.sort((a, b) => ((order[a.source] ?? 9) - (order[b.source] ?? 9)) || (b.score - a.score));
    const conceptmapHits = candidates.filter((c) => c.source === "conceptmap");
    const rest = candidates.filter((c) => c.source !== "conceptmap");
    const merged = [...conceptmapHits, ...engine, ...hybrid, ...rest];
    if (this.embeddingSvc === null) warnings.push("semantic search unavailable (no embedding service)");
    const data: Record<string, unknown> = {
      text,
      targets: targets.map((t) => t.system),
      candidates: merged.slice(0, limit),
      note: "candidates are suggestions — confirm with fhir_validate_code",
    };
    if (clauses.length) data.clauses = clauses;
    if (fullerCopies.length) data.codesystem_copies = fullerCopies;
    if (engineSystems.size && keywordOnly) {
      data.search_mode = KEYWORD_ONLY_MODE;
      data.search_note = KEYWORD_ONLY_NOTE;
    }
    return this.ok(data, pkg, warnings);
  }

  /**
   * search_medical_codes(system=<IG CodeSystem canonical | id | alias>): free text → codes of
   * one IG CodeSystem, resolved across every installed IG (default IG's closure first).
   */
  async searchIgCodeSystem(keyword: string, system: string, limit: number): Promise<Record<string, unknown>> {
    let pkg: PackageRow | null = null;
    try {
      pkg = await this.resolve(null, null, { canonicals: [system.includes("/") ? system : null] });
    } catch {
      pkg = null;
    }
    let loc: CsLocation | null = pkg ? await this.locateIgCodeSystem(system, pkg) : null;
    let alternatives: string[] = [];
    if (!loc) {
      const alias = await this.conceptSearch.resolveAlias(system, pkg);
      loc = alias.location;
      alternatives = alias.alternatives;
    }
    if (!loc) {
      return {
        keyword,
        system,
        error: "UNKNOWN_SYSTEM",
        message:
          "system is not icd10cm / icd10pcs nor a CodeSystem of an installed IG (give its canonical URL, id, or words of its " +
          "name such as nhi_payment)",
        results: [],
      };
    }
    const res = await this.conceptSearch.search(loc, keyword, Math.min(Math.max(1, limit), 50));
    const out: Record<string, unknown> = {
      keyword,
      system: loc.url,
      codesystem: { id: res.codesystem.id, title: res.codesystem.title, version: res.codesystem.version, package: `${loc.packageId}@${loc.packageVersion}` },
      results: res.candidates,
    };
    if (res.clauses) out.clauses = res.clauses;
    if (alternatives.length) out.other_matching_systems = alternatives;
    if (res.warnings.length) out.warnings = res.warnings;
    if (res.keywordOnly) {
      out.search_mode = KEYWORD_ONLY_MODE;
      out.search_note = KEYWORD_ONLY_NOTE;
    }
    return out;
  }

  private async normalizeTargets(
    pkg: PackageRow,
    valueSet: string | null,
    system: string | null,
  ): Promise<{ targets: Array<{ system: string; kind: string }>; scopeIds: Record<string, number[]>; warnings: string[]; locations: Map<string, CsLocation> }> {
    const warnings: string[] = [];
    const targets: Array<{ system: string; kind: string }> = [];
    const scopeIds: Record<string, number[]> = {};
    // IG CodeSystems resolved from an id / alias (possibly outside pkg's closure, e.g. a PAS
    // CodeSystem named while TW Core is the default IG): searched where they were found.
    const locations = new Map<string, CsLocation>();
    const seen = new Set<string>();
    const addTarget = (sys_: string | null | undefined) => {
      if (!sys_ || seen.has(sys_)) return;
      seen.add(sys_);
      targets.push({ system: sys_, kind: terminology.routeSystem(sys_) });
    };
    if (system) {
      let sys_ = system;
      if (terminology.routeSystem(system) === "external" && !/^[a-z][a-z0-9+.-]*:/i.test(system)) {
        const loc = await this.locateIgCodeSystem(system, pkg);
        if (loc) {
          sys_ = loc.url;
          locations.set(loc.url, loc);
          if (loc.url !== system) warnings.push(`system '${system}' resolved to the IG CodeSystem ${loc.url}`);
        }
      }
      addTarget(sys_);
    }
    if (valueSet) {
      const vs = await this.loadValueset(pkg, valueSet);
      if (vs === null) {
        warnings.push(`ValueSet not found: ${valueSet}`);
      } else {
        for (const inc of (vs.compose || {}).include || []) {
          const sys_ = inc.system;
          addTarget(sys_);
          for (const f of inc.filter || []) {
            if (sys_ === terminology.SNOMED_SYSTEM && ["is-a", "descendent-of"].includes(f.op)) {
              const ids = await terminology.snomedDescendants(f.value, 5000);
              if (!scopeIds[sys_]) scopeIds[sys_] = [];
              pushAll(scopeIds[sys_], ids);
            }
          }
        }
      }
    }
    return { targets, scopeIds, warnings, locations };
  }

  private async normalizeConceptmap(
    pkg: PackageRow,
    text: string,
    targets: Array<{ system: string; kind: string }>,
  ): Promise<Array<[string, string, any]>> {
    const targetSystems = new Set(targets.map((t) => t.system));
    const maps = await conceptMapsMemo.get(terminology.closureKey(pkg), async () => {
      const [pids, pvers] = terminology.closureArrays(pkg);
      const rows = (
        await query<{ raw_json: any }>(
          "SELECT a.raw_json FROM fhir.artifacts a " +
            "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) " +
            "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
            "WHERE a.resource_type = 'ConceptMap'",
          [pids, pvers],
        )
      ).rows;
      return rows.map((r) => jsonValue(r.raw_json));
    });
    const needle = (text || "").trim().toLowerCase();
    const out: Array<[string, string, any]> = [];
    for (const cm of maps) {
      for (const group of cm.group || []) {
        if (!targetSystems.has(group.target)) continue;
        for (const el of group.element || []) {
          const srcDisp = (el.display || "").trim().toLowerCase();
          const srcCode = (el.code || "").trim().toLowerCase();
          if (needle && (needle === srcDisp || needle === srcCode || srcDisp.includes(needle))) {
            for (const tgt of el.target || []) {
              out.push([group.target, tgt.code, tgt.display]);
            }
          }
        }
      }
    }
    return out;
  }

  private async normalizeLexical(
    pkg: PackageRow,
    target: { system: string; kind: string },
    text: string,
    scopeIds: number[] | undefined,
    limit: number,
  ): Promise<Array<[string, string, any]>> {
    const kind = target.kind;
    const sys_ = target.system;
    const like = `%${(text || "").trim()}%`;
    // (SNOMED CT / LOINC / ICD-10-CM targets go through normalizeHybrid.)
    if (kind === "icd_pcs") {
      const table = "icd.procedures";
      const rows = (
        await query<{ code: string; name_en: string; name_zh: string }>(
          `SELECT code, name_en, name_zh FROM ${table} WHERE name_en ILIKE $1 OR name_zh ILIKE $1 LIMIT $2`,
          [like, limit],
        )
      ).rows;
      return rows.map((r) => [sys_, r.code, r.name_en || r.name_zh] as [string, string, any]);
    }
    const [pids, pvers] = terminology.closureArrays(pkg);
    const rows = (
      await query<{ code: string; display: string }>(
        "SELECT c.code, c.display FROM fhir.concepts c " +
          "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) " +
          "  ON c.package_id = dep.pid AND c.package_version = dep.pver " +
          "WHERE c.cs_id = $3 AND (c.display ILIKE $4 OR c.code ILIKE $4) " +
          "LIMIT $5",
        [pids, pvers, terminology.canonicalTail(sys_), like, limit],
      )
    ).rows;
    return rows.map((r) => [sys_, r.code, r.display] as [string, string, any]);
  }

  /** Hybrid candidates for a SNOMED CT / LOINC / ICD-10-CM target (see terminologyRanking.ts). */
  private async normalizeHybrid(
    target: { system: string; kind: string },
    text: string,
    scopeIds: number[] | undefined,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const kind = target.kind;
    const task: QueryTask = kind === "snomed" ? "snomed" : kind === "loinc" ? "loinc" : "icd";
    let vecStr: string | null = null;
    if (this.embeddingSvc) {
      try {
        vecStr = vecLiteral(await this.embeddingSvc.embed(text, task));
      } catch {
        vecStr = null;
      }
    }
    const cand = (code: string, display: unknown, r: RankedCandidate): Record<string, unknown> => ({
      system: target.system,
      code,
      display,
      source: r.exact ? "lexical" : r.source,
      score: round4(r.score),
      ...(r.exact ? { exact: true } : {}),
    });
    if (kind === "snomed") {
      const rows = await rankSnomed(text, vecStr, limit, { scope: scopeIds && scopeIds.length ? scopeIds : null });
      return rows.map((r) => cand(r.concept_id, r.preferred, r.ranked));
    }
    if (kind === "loinc") {
      const { rows, ranked } = await rankLoinc(text, vecStr, limit);
      return rows.map((r, i) => cand(String(r.loinc_num), r.long_common_name, ranked[i]));
    }
    const { rows, ranked } = await rankIcdDiagnoses(text, vecStr, limit);
    return rows.map((r, i) => cand(r.code, r.name_en || r.name_zh, ranked[i]));
  }

  // --- G. Validation ------------------------------------------------------- //

  /** Resolve a profile identifier (id / canonical / key) to its canonical URL and id. */
  private async resolveProfileCanonical(pkg: PackageRow, identifier: string): Promise<[string | null, string]> {
    // "url|version" must resolve to that version; the returned canonical keeps the version so the
    // validator can pin it.
    const { url, version } = fhirIg.splitCanonical(identifier);
    const row = await this.loadArtifact(pkg, version ? identifier : url);
    if (row === null) return [null, identifier];
    const sd = jsonValue(row.raw_json);
    const canonical: string | null = sd.url || row.canonical_url || null;
    return [canonical && version ? `${canonical}|${version}` : canonical, row.artifact_id || identifier];
  }

  /**
   * Validate one resource (a Bundle validates its entries too) with the
   * in-process instance validator: base definition + meta.profile + `profile`.
   */
  private async validateCore(pkg: PackageRow, resource: Record<string, any>, profile: string | null): Promise<Record<string, any>> {
    const profiles: string[] = [];
    let profileId: string | null = null;
    const issues: Record<string, any>[] = [];
    // FHIR_VALIDATE_PROFILE=1: per-phase wall time + DB round-trips of every validation (stderr).
    const prof = VALIDATE_PROFILE ? { t0: performance.now(), q0: queryCount(), marks: [] as Array<[string, number, number]> } : null;
    const mark = (phase: string): void => {
      if (prof) prof.marks.push([phase, performance.now(), queryCount()]);
    };
    if (profile) {
      const [canonical, id] = await this.resolveProfileCanonical(pkg, profile);
      profileId = id;
      if (canonical) profiles.push(canonical);
      else {
        issues.push(
          validator.issue("error", "", "not-found", `profile not found in ${pkg.package_id}#${pkg.version}: ${profile}`),
        );
      }
    } else {
      const metas = (resource.meta || {}).profile || [];
      if (metas.length) {
        // Display id only: an uninstalled "|version" still names the profile it pins.
        let [canon, id] = await this.resolveProfileCanonical(pkg, String(metas[0]));
        if (canon === null && String(metas[0]).includes("|")) {
          const [c2, id2] = await this.resolveProfileCanonical(pkg, String(metas[0]).split("|")[0]);
          if (c2 !== null) id = id2;
        }
        profileId = id;
      }
    }
    mark("resolve_profile");
    const resolver = new DbValidatorResolver(pkg);
    const engine = new validator.InstanceValidator(resolver);
    // v8: the resolver degrades gracefully on database trouble (a definition that
    // cannot be fetched counts as absent, a code system as unknown …), which must
    // not read as a clean pass: every failed lookup is tracked and reported as an
    // error issue (`exception`) that makes the verdict invalid and incomplete.
    const tracked = await trackQueryFailures(() => engine.validate(resource, { profiles }));
    pushAll(issues, tracked.result as Record<string, any>[]);
    if (tracked.total > 0) {
      logError("fhir validation: definition / terminology lookups failed", { failed: tracked.total, first: tracked.failures[0]?.message });
      issues.push(validator.lookupFailureIssue(tracked.total, tracked.failures));
    }
    mark("validate");
    // Additive `suggestions` / `caused_by` on issues (fhirSuggestions/); never changes the verdict.
    try {
      await attachSuggestions(issues, resource, dbSuggestionDeps(pkg, resolver, this.suggestionHooks(pkg)), { profiles });
    } catch (e) {
      // Suggestions are decoration: a failure here must not lose the validation result.
      logError("fhir validation: suggestions failed", { error: String((e as Error).message) });
    }
    mark("suggest");
    if (prof) {
      const phases: Record<string, { ms: number; queries: number }> = {};
      let t = prof.t0;
      let q = prof.q0;
      for (const [phase, at, qc] of prof.marks) {
        phases[phase] = { ms: Math.round((at - t) * 100) / 100, queries: qc - q };
        t = at;
        q = qc;
      }
      logInfo("fhir validation profile", {
        resourceType: String(resource.resourceType),
        total_ms: Math.round((performance.now() - prof.t0) * 100) / 100,
        queries: queryCount() - prof.q0,
        issues: issues.length,
        phases,
      });
    }
    return {
      valid: validator.isValid(issues),
      profile: profileId,
      source: validator.SOURCE,
      issues,
      // checked_fully / profiles_unchecked / valuesets_unchecked: `valid` keeps HL7
      // semantics (an unresolvable profile is only a warning), so incompleteness is explicit.
      ...validator.completenessOf(issues, (pkg._depsMissing as unknown[] | undefined) || []),
    };
  }

  /** fhir_normalize_code / near codes for the suggestion layer, bound to one package. */
  private suggestionHooks(pkg: PackageRow): ServiceHooks {
    return {
      // The validation's package, pinned (as normalizeCode(text, …, pkg.package_id, pkg.version) resolves it).
      normalize: (text, valueSet, system, limit) => this.normalizeCodeIn(pkg, true, text, valueSet, system, limit),
      nearCodes: async (system, code, limit) => {
        const loc = await this.locateIgCodeSystem(system, pkg);
        return loc ? this.conceptSearch.nearCodes(loc, code, limit) : [];
      },
      // Semantic ranking of a small ValueSet's codes (binding suggestions); absent = lexical only.
      ...(this.embeddingSvc ? { embedBatch: (texts: string[]) => this.embeddingSvc!.embedBatch(texts, "document") } : {}),
    };
  }

  async validateResource(
    resource: Record<string, any>,
    profile: string | null = null,
    packageId: string | null = null,
    version: string | null = null,
  ): Promise<string> {
    if (!(resource && typeof resource === "object" && !Array.isArray(resource)) || !resource.resourceType) {
      return this.err("INVALID_ARGUMENT", "resource must include a resourceType");
    }
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [profile], metaProfiles: metaProfilesOf(resource) });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      // Database trouble before validation even started (v8): a well-formed
      // invalid result with a fatal issue, never a failed call.
      return this.ok(this.validationCrash(e, "fhir_validate_resource"), null);
    }
    let data: Record<string, any>;
    try {
      data = await this.validateCore(pkg, resource, profile);
    } catch (e) {
      data = this.validationCrash(e, "fhir_validate_resource");
    }
    return this.ok(this.withDeps(data, pkg), pkg);
  }

  /**
   * v8: an unexpected exception inside the validator is reported the way HL7
   * validator_cli reports one — as a fatal `exception` issue on an otherwise
   * well-formed result (`valid: false`, `checked_fully: false`) — instead of a
   * failed tool call that a caller acting only on issues would read as "no
   * errors found". The error is logged with its stack for diagnosis.
   */
  private validationCrash(e: unknown, tool: string): Record<string, any> {
    const err = e as Error;
    logError(`${tool}: validator crashed`, { error: String(err?.message ?? e), stack: String(err?.stack ?? "").split("\n").slice(0, 6).join(" | ") });
    const issues = [
      validator.issue(
        "fatal",
        "",
        validator.LOOKUP_FAILURE_CODE,
        `Validation failed with an internal error (${String(err?.message ?? e).slice(0, 300)}); the resource was not fully checked — retry the call, and report the error if it persists`,
      ),
    ];
    return { valid: false, profile: null, source: validator.SOURCE, issues, checked_fully: false, profiles_unchecked: [], valuesets_unchecked: [] };
  }

  /**
   * Content repair (ISSUES_v14, fhirRepair) of a Bundle for the finalize / validate tools: runs on
   * a clone of the lossless request tree when there is one (numbers keep their spelling), returns
   * the repaired plain Bundle, the repaired lossless tree (or undefined) and the result.
   */
  private async contentRepairBundle(
    pkg: PackageRow | null,
    bundle: Record<string, any>,
    lossless: unknown,
    timezone: string | null,
  ): Promise<{ bundle: Record<string, any>; lossless: unknown; result: RepairResult } | null> {
    if (!pkg) return null;
    const tree = cloneTree(lossless !== undefined && lossless !== null && typeof lossless === "object" ? lossless : bundle) as Record<string, any>;
    try {
      const deps = repairDepsFor(pkg, (text, valueSet, system, limit) => this.normalizeCodeIn(pkg, true, text, valueSet, system, limit), new DbValidatorResolver(pkg));
      const result = await repairBundle(tree, deps, { timezone });
      return { bundle: toPlain(tree) as Record<string, any>, lossless: lossless !== undefined ? tree : undefined, result };
    } catch (e) {
      logError("content repair failed; the Bundle is finalized as given", { error: String((e as Error).message) });
      return null;
    }
  }

  async validateBundle(
    bundle: Record<string, any>,
    packageId: string | null = null,
    version: string | null = null,
    normalizeIds = false,
    /** The `bundle` argument as the request wrote it (losslessJson.parseLossless), so normalized_bundle keeps every number's spelling. */
    losslessBundle: unknown = undefined,
    /** With normalize_ids: "ids" (default, 1.7.0 behaviour) or "content" (ids + the v14 content repairs, fhirRepair). */
    repair: RepairMode = "ids",
    timezone: string | null = null,
  ): Promise<string> {
    if (!(bundle && typeof bundle === "object" && !Array.isArray(bundle)) || bundle.resourceType !== "Bundle") {
      return this.err("INVALID_ARGUMENT", "bundle must be a FHIR Bundle resource");
    }
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { metaProfiles: metaProfilesOf(bundle) });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      const crash = this.validationCrash(e, "fhir_validate_bundle");
      return this.ok({ ...crash, entries: [], referenceIssues: [] }, null);
    }
    // normalize_ids (1.7.0): finalize first (fullUrl / reference / id, fhirBundleFinalize.ts), validate the
    // normalised Bundle, and report what was fixed as information issues + normalized_bundle / id_changes.
    let fin: FinalizeResult | null = null;
    let target = bundle;
    let content: Awaited<ReturnType<FHIRIGService["contentRepairBundle"]>> = null;
    if (normalizeIds) {
      try {
        if (repair === "content") content = await this.contentRepairBundle(pkg, bundle, losslessBundle, timezone);
        fin = await runBundleFinalize(content ? content.bundle : bundle, new DbValidatorResolver(pkg), {});
        target = fin.bundle;
      } catch (e) {
        logError("fhir_validate_bundle: normalize_ids failed; validating the Bundle as given", { error: String((e as Error).message) });
        fin = null;
      }
    }
    let core: Record<string, any>;
    try {
      core = await this.validateCore(pkg, target, null);
    } catch (e) {
      core = this.validationCrash(e, "fhir_validate_bundle");
    }
    const idBlock: Record<string, any> = {};
    if (fin) {
      pushAll(core.issues as Record<string, any>[], normalizationIssues(fin.changes));
      idBlock.normalized_bundle = losslessFinalizedBundle(fin.bundle, fin.changes, content ? content.lossless : losslessBundle) ?? fin.bundle;
      idBlock.id_changes = fin.changes;
      if (content) {
        idBlock.repair = "content";
        idBlock.content_changes = content.result.changes;
        idBlock.repair_issues = content.result.issues;
        attachRepairIssues(core.issues as Record<string, any>[], content.result.issues);
      }
      idBlock.id_map = fin.id_map;
      idBlock.id_unresolved = fin.unresolved;
      idBlock.id_notes = fin.notes;
    } else if (!normalizeIds && (core.issues as Record<string, any>[]).some(isIdClassIssue)) {
      // Default mode (1.7.0): ID-class issues carry the finalizer's replacement as suggestions, and the
      // Bundle-level id_map / id_changes list every value that must change together. Valid Bundles
      // (no ID-class issue) are untouched, so their output is byte-identical to 1.6.1.
      try {
        const f = await runBundleFinalize(bundle, new DbValidatorResolver(pkg), {});
        if (f.changes.length || f.unresolved.length) {
          attachIdSuggestions(core.issues as Record<string, any>[], f);
          idBlock.id_map = f.id_map;
          idBlock.id_changes = f.changes;
          idBlock.id_unresolved = f.unresolved;
          if (f.notes.length) idBlock.id_notes = f.notes;
          idBlock.id_hint =
            "Apply every id_changes entry together (fullUrl and all references to it), or call fhir_validate_bundle again with " +
            "normalize_ids=true / fhir_finalize_bundle to have them applied deterministically.";
        }
      } catch (e) {
        logError("fhir_validate_bundle: id suggestions failed", { error: String((e as Error).message) });
      }
    }
    const bundleEntries: any[] = Array.isArray(target.entry) ? target.entry : [];
    // Split the issues: Bundle-level vs per entry (by instance path prefix).
    const perEntry: Record<string, any>[][] = bundleEntries.map(() => []);
    const bundleIssues: Record<string, any>[] = [];
    for (const i of core.issues as Record<string, any>[]) {
      const m = /^Bundle\.entry\[(\d+)\]/.exec(String(i.path || ""));
      if (m && perEntry[Number(m[1])]) perEntry[Number(m[1])].push(i);
      else bundleIssues.push(i);
    }
    const fullUrls = new Set(bundleEntries.filter((e: any) => e && e.fullUrl).map((e: any) => e.fullUrl));
    const entryResults: any[] = [];
    const referenceIssues: any[] = [];
    bundleEntries.forEach((be: any, idx: number) => {
      const resource = (be && be.resource) || {};
      if (!resource.resourceType) {
        // v8: an entry without a usable resource (missing, not an object, no
        // resourceType) gets no `entries` row, but its issues — e.g. "must be an
        // Object, not an Array", a missing fullUrl — must still be reported: they
        // are surfaced at Bundle level instead of being dropped (the verdict was
        // already invalid, but a reader of the issue lists saw nothing).
        pushAll(bundleIssues, perEntry[idx]);
        return;
      }
      const metas = (resource.meta || {}).profile || [];
      entryResults.push({
        fullUrl: be.fullUrl ?? null,
        resourceType: resource.resourceType,
        valid: validator.isValid(perEntry[idx]),
        profile: metas.length ? String(metas[0]).split("|")[0].split("/").pop() : null,
        issues: perEntry[idx],
      });
      const refs: string[] = [];
      reference.collectReferences(resource, refs);
      const containedIds = new Set(
        (resource.contained || []).filter((c: any) => c && c.id).map((c: any) => "#" + c.id),
      );
      for (const ref of refs) {
        if (ref.startsWith("urn:uuid:")) {
          if (!fullUrls.has(ref)) referenceIssues.push({ resourceType: resource.resourceType, reference: ref });
        } else if (ref.startsWith("#") && ref !== "#") {
          if (!containedIds.has(ref)) referenceIssues.push({ resourceType: resource.resourceType, reference: ref });
        }
      }
    });
    const data = {
      // Unresolved bundle-internal references are reported (referenceIssues +
      // warning) but, like the HL7 validator, do not by themselves make a
      // collection/transaction Bundle invalid.
      valid: core.valid,
      source: validator.SOURCE,
      profile: core.profile,
      issues: bundleIssues,
      entries: entryResults,
      referenceIssues,
      checked_fully: core.checked_fully,
      profiles_unchecked: core.profiles_unchecked,
      valuesets_unchecked: core.valuesets_unchecked,
      ...idBlock,
    };
    const warnings: string[] = [];
    if (referenceIssues.length) {
      warnings.push(`${referenceIssues.length} internal reference(s) did not resolve within the bundle`);
    }
    if (fin && fin.changes.length) warnings.push(`normalize_ids applied ${fin.changes.length} change(s) to fullUrl / reference / id (see id_changes); the verdict is for normalized_bundle`);
    if (content && content.result.changes.length) warnings.push(`repair=content applied ${content.result.changes.length} content correction(s) (see content_changes); the verdict is for normalized_bundle`);
    if (fin && fin.unresolved.length) warnings.push(`${fin.unresolved.length} reference(s) could not be resolved to an entry (see id_unresolved)`);
    return this.ok(this.withDeps(data, pkg), pkg, warnings);
  }

  /**
   * StructureDefinition lookup for the Bundle finalizer / fhir_build_bundle: the package the
   * Bundle resolves to (meta.profile → default IG), else hl7.fhir.r4.core, else null
   * (property-name fallback). Never throws.
   */
  async bundleFinalizeDeps(bundle: Record<string, any> | null = null, bundleProfile: string | null = null): Promise<{ deps: FinalizeDeps | null; pkg: PackageRow | null; note: string | null }> {
    try {
      const pkg = await this.resolve(null, null, { canonicals: [bundleProfile], metaProfiles: bundle ? metaProfilesOf(bundle) : [] });
      return { deps: new DbValidatorResolver(pkg), pkg, note: null };
    } catch (e) {
      if (!this.isIGNotFound(e)) throw e;
    }
    try {
      const pkg = await this.resolve("hl7.fhir.r4.core", null, {});
      return { deps: new DbValidatorResolver(pkg), pkg, note: "no IG resolved for this Bundle; FHIR R4 core definitions used" };
    } catch (e) {
      if (!this.isIGNotFound(e)) throw e;
      return { deps: null, pkg: null, note: "no IG package installed; references located by property name only" };
    }
  }

  /**
   * fhir_finalize_bundle (ISSUES_v9 R1): deterministic fullUrl / reference / id normalisation of a
   * finished Bundle (fhirBundleFinalize.ts). Clinical content is never changed.
   */
  async finalizeBundle(
    bundle: Record<string, any>,
    packageId: string | null = null,
    version: string | null = null,
    bundleProfile: string | null = null,
    opts: {
      /** Bundle.type to set (R4 value set); a profile-fixed type wins and the conflict is noted (1.1.0). */
      bundleType?: string | null;
      /** The `bundle` argument as the request wrote it (losslessJson.parseLossless): the returned Bundle keeps every number's spelling. */
      lossless?: unknown;
      /** "ids" (v9: fullUrl / reference / id only) or "content" (ids + the v14 content repairs); default DEFAULT_FINALIZE_REPAIR. */
      repair?: RepairMode | null;
      /** UTC offset completing ROC (民國) times written without one (R3); never guessed. */
      timezone?: string | null;
    } = {},
  ): Promise<string> {
    if (!(bundle && typeof bundle === "object" && !Array.isArray(bundle)) || bundle.resourceType !== "Bundle") {
      return this.err("INVALID_ARGUMENT", "bundle must be a FHIR Bundle resource");
    }
    const repair: RepairMode = opts.repair === "ids" || opts.repair === "content" ? opts.repair : DEFAULT_FINALIZE_REPAIR;
    const bundleType = typeof opts.bundleType === "string" && opts.bundleType.trim() ? opts.bundleType.trim() : null;
    if (bundleType !== null && !(BUNDLE_TYPES as readonly string[]).includes(bundleType)) {
      return this.err("INVALID_ARGUMENT", `bundle_type must be one of ${BUNDLE_TYPES.join(" | ")}`, { parameter: "bundle_type", allowed: [...BUNDLE_TYPES] });
    }
    const profile = bundleProfile && String(bundleProfile).trim() ? String(bundleProfile).trim() : null;
    let pkg: PackageRow | null = null;
    let deps: FinalizeDeps | null = null;
    const notes: string[] = [];
    if (packageId) {
      try {
        pkg = await this.resolve(packageId, version, { canonicals: [profile], metaProfiles: metaProfilesOf(bundle) });
        deps = new DbValidatorResolver(pkg);
      } catch (e) {
        if (this.isIGNotFound(e)) return await this.igErr(e);
        throw e;
      }
    } else {
      const r = await this.bundleFinalizeDeps(bundle, profile);
      pkg = r.pkg;
      deps = r.deps;
      if (r.note) notes.push(r.note);
    }
    let profileCanonical: string | null = profile;
    if (profile && pkg && !profile.includes("/") && !profile.includes(":")) {
      // A profile id (Bundle-twcore) → its canonical, so the finalizer can fetch it.
      const row = await this.loadArtifact(pkg, profile);
      if (row && row.canonical_url) profileCanonical = String(row.canonical_url);
    }
    // v14: content repairs first (fhirRepair; on the lossless tree), then the v9 id normalisation.
    const content = repair === "content" ? await this.contentRepairBundle(pkg, bundle, opts.lossless, opts.timezone ?? null) : null;
    const fin = await runBundleFinalize(content ? content.bundle : bundle, deps, { bundleProfile: profileCanonical, bundleType });
    const count = (rule: string): number => fin.changes.filter((c) => c.rule === rule).length;
    const contentChanges = content ? content.result.changes : [];
    const data: Record<string, any> = {
      bundle: losslessFinalizedBundle(fin.bundle, fin.changes, content ? content.lossless : opts.lossless) ?? fin.bundle,
      changes: [...contentChanges, ...fin.changes],
      unresolved: fin.unresolved,
      notes: [...notes, ...fin.notes],
      id_map: fin.id_map,
      summary: {
        entries: Array.isArray(fin.bundle.entry) ? fin.bundle.entry.length : 0,
        fullUrl: count("fullUrl-uuid"),
        references: count("reference-rewire"),
        ids: count("resource-id"),
        bundle_type: count("bundle-type"),
        document_order: count("document-order"),
        unresolved: fin.unresolved.length,
        ...(repair === "content" ? { content: countByRule(contentChanges), repair_issues: content ? content.result.issues.length : 0 } : {}),
      },
    };
    if (repair === "content") {
      data.repair = "content";
      data.repair_issues = content ? content.result.issues : [];
      if (!content) data.notes.push(pkg ? "content repair was not available for this call; only fullUrl / reference / id were normalised" : "no IG package resolved: content repair skipped (only fullUrl / reference / id were normalised)");
    }
    const warnings: string[] = [];
    if (fin.unresolved.length) warnings.push(`${fin.unresolved.length} reference(s) could not be resolved to exactly one entry; see data.unresolved (candidates) — not guessed`);
    if (fin.notes.some((n) => n.startsWith("bdl-7"))) warnings.push("duplicate fullUrl(s) (bdl-7) reported in data.notes; not merged");
    if (content && content.result.issues.some((i) => i.severity === "error")) {
      warnings.push(`${content.result.issues.filter((i) => i.severity === "error").length} value(s) could not be corrected uniquely (see data.repair_issues, with candidates) — not guessed`);
    }
    if (pkg) this.withDeps(data, pkg);
    const env = {
      ok: true,
      data,
      warnings: [...(((pkg?._notes as string[] | undefined) || [])), ...warnings],
      provenance: { ...(pkg ? this.provenance(pkg) : { source: "fhir-r4-core" }), tool: "fhir_finalize_bundle", toolVersion: toolVersion("fhir_finalize_bundle") },
    };
    return stringifyLossless(env);
  }

  // --- E. Schema-guided fill (authoring) ----------------------------------- //

  private skeletonKeep(el: Record<string, any>, rel: string): boolean {
    const top = rel.split(".")[0];
    if (SKELETON_SKIP.has(top)) return false;
    const [fixed, pattern] = snapshot.fixedPattern(el);
    const hasPin = fixed !== null || pattern !== null;
    const required = typeof el.min === "number" && el.min >= 1;
    const bound = Boolean(el.binding);
    const must = Boolean(el.mustSupport);
    const direct = !rel.includes(".") && !["extension", "modifierExtension"].includes(top);
    return required || must || bound || hasPin || direct;
  }

  private sliceOptions(sd: Record<string, any>, path: string): any[] {
    if (path.endsWith(".extension") || path.endsWith(".modifierExtension")) return [];
    const els = (sd.snapshot || {}).element || [];
    const head = els.find(
      (e: any) => e.path === path && e.slicing && !snapshot.isSliceMember(e),
    );
    if (!head) return [];
    const disc = head.slicing.discriminator || [];
    if (!disc.length || disc.some((d: any) => !["value", "pattern"].includes(d.type))) return [];
    const out: any[] = [];
    for (const sl of els) {
      if (sl.path !== path || !sl.sliceName) continue;
      const name = sl.sliceName;
      const childPrefix = `${path}:${name}.`;
      const pinned: any[] = [];
      for (const e of els) {
        if (!(e.id || "").startsWith(childPrefix)) continue;
        const [fixed, pattern] = snapshot.fixedPattern(e);
        if (fixed === null && pattern === null) continue;
        const pin = fixed || pattern;
        pinned.push({ subPath: (e.id || "").slice(childPrefix.length), field: pin!.field, value: pin!.value });
      }
      out.push({ sliceName: name, min: sl.min, max: sl.max, short: sl.short, autoPinned: pinned });
    }
    return out;
  }

  async getResourceSkeleton(
    profile: string,
    packageId: string | null = null,
    version: string | null = null,
    candidateLimit = 20,
    includeExamples = true,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [profile] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const row = await this.loadArtifact(pkg, profile);
    if (row === null) return this.err("ARTIFACT_NOT_FOUND", await this.notFound("profile", profile));
    const sd = jsonValue(row.raw_json);
    const root = sd.type || "";
    const prefix = root + ".";
    candidateLimit = Math.min(Math.max(1, candidateLimit), 100);

    const fields: any[] = [];
    const warnings: string[] = [];
    // Additive: `required` keeps its historical meaning (own min>=1); `effectiveRequired`
    // additionally needs every ancestor to be required (Patient.telecom.system is
    // required:true but effectiveRequired:false because Patient.telecom is optional).
    const effRequired = effectiveRequiredPaths((sd.snapshot || {}).element || []);
    for (const el of (sd.snapshot || {}).element || []) {
      if (snapshot.isSliceMember(el)) continue;
      const path = el.path || "";
      if (!path.startsWith(prefix)) continue;
      const rel = path.slice(prefix.length);
      if (!this.skeletonKeep(el, rel)) continue;
      const proj = snapshot.projectElement(el);
      const maxCard = el.max;
      const field: Record<string, any> = {
        path,
        jsonPath: rel,
        required: typeof el.min === "number" && el.min >= 1,
        effectiveRequired: effRequired.has(path),
        array: maxCard === "*" || (/^\d+$/.test(String(maxCard)) && parseInt(String(maxCard), 10) > 1),
        types: proj.types,
        mustSupport: proj.mustSupport,
        short: proj.short,
      };
      if (rel.endsWith("[x]")) {
        field.choices = (el.type || []).map((t: any) => snapshot.choiceProperty(path, t.code || ""));
      }
      if (proj.fixed || proj.pattern) {
        const pin = proj.fixed || proj.pattern;
        field.autoPinned = { field: pin.field, value: pin.value, note: "system fills this on finalize — do not set" };
      }
      if (proj.binding && proj.binding.valueSet) {
        const vsUrl = String(proj.binding.valueSet).split("|")[0];
        const bindingInfo: Record<string, any> = { strength: proj.binding.strength, valueSet: vsUrl, candidateCodes: null };
        const vs = await this.loadValueset(pkg, vsUrl);
        if (vs !== null) {
          const exp = await terminology.expandCompose(vs.compose || {}, pkg, candidateLimit);
          bindingInfo.candidateCodes = exp.codings.slice(0, candidateLimit);
          bindingInfo.candidatesTruncated = exp.truncated;
        } else {
          bindingInfo.note = "binding ValueSet not held locally";
        }
        field.binding = bindingInfo;
      }
      const sliceOpts = this.sliceOptions(sd, path);
      if (sliceOpts.length) {
        field.slices = sliceOpts;
        field.sliceHint =
          'This element is sliced. On each entry set "_slice" to one of ' +
          "the listed sliceName values (a semantic choice, e.g. which kind " +
          "of identifier); fhir_finalize_resource then pins that slice's " +
          "fixed system/type and removes the tag. Do not set those " +
          "autoPinned fields yourself.";
      }
      fields.push(field);
    }

    const examples = includeExamples ? (await this.profileExamples(pkg, row.canonical_url)).examples : [];
    const data = {
      profile: row.artifact_id,
      canonical: row.canonical_url,
      resourceType: root,
      instructions:
        "Fill the semantic blanks below. Fields with effectiveRequired:true must be present; " +
        "fhir_get_profile_required_elements lists the full required set (slices, invariants). " +
        "Leave 'autoPinned' fields and " +
        "meta.profile to fhir_finalize_resource. Use the candidateCodes for " +
        "bound elements (confirm with fhir_validate_code). Then call " +
        "fhir_finalize_resource with your draft.",
      fields,
      examples,
    };
    return this.ok(this.withDeps(data, pkg), pkg, warnings);
  }

  private async inferSystems(pkg: PackageRow, sd: Record<string, any>, resource: Record<string, any>): Promise<string[]> {
    const root = sd.type || resource.resourceType || "";
    const warnings: string[] = [];
    for (const el of (sd.snapshot || {}).element || []) {
      if (snapshot.isSliceMember(el)) continue;
      const binding = el.binding || {};
      if (!["required", "extensible"].includes(binding.strength)) continue;
      if (!binding.valueSet) continue;
      const path = el.path || "";
      const rel = validator.relPath(path, root);
      if (!rel) continue;
      const nodes = validator.getAtPath(resource, rel);
      const targetCodings: any[] = [];
      for (const node of nodes) {
        if (node && typeof node === "object" && Array.isArray(node.coding)) {
          pushAll(targetCodings, node.coding);
        } else if (node && typeof node === "object" && "code" in node) {
          targetCodings.push(node);
        }
      }
      const need = targetCodings.filter((c) => c.code && !c.system);
      if (!need.length) continue;
      const vs = await this.loadValueset(pkg, String(binding.valueSet).split("|")[0]);
      if (vs === null) continue;
      const exp = await terminology.expandCompose(vs.compose || {}, pkg);
      const systems = new Set(exp.codings.filter((c) => c.system).map((c) => c.system));
      if (systems.size === 1) {
        const only = [...systems][0];
        for (const c of need) c.system = only;
      } else {
        warnings.push(
          `${path}: could not infer a single system for the coding ` +
            `(binding spans ${systems.size} systems) — set it explicitly`,
        );
      }
    }
    return warnings;
  }

  async finalizeResource(
    profile: string,
    draft: Record<string, any>,
    contextId: string | null = null,
    key: string | null = null,
    packageId: string | null = null,
    version: string | null = null,
    generateNarrative = true,
    /** The `draft` argument as the request wrote it (losslessJson.parseLossless): the returned resource keeps every number's spelling. */
    losslessDraft: unknown = undefined,
    /** "ids" (1.5.0 behaviour) or "content" (+ the v14 content repairs, fhirRepair); default DEFAULT_FINALIZE_REPAIR. */
    repairMode: RepairMode | null = null,
    timezone: string | null = null,
  ): Promise<string> {
    if (!(draft && typeof draft === "object" && !Array.isArray(draft))) {
      return this.err("INVALID_ARGUMENT", "draft must be a resource object");
    }
    const repair: RepairMode = repairMode === "ids" || repairMode === "content" ? repairMode : DEFAULT_FINALIZE_REPAIR;
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version, { canonicals: [profile] });
    } catch (e) {
      if (this.isIGNotFound(e)) return await this.igErr(e);
      throw e;
    }
    const row = await this.loadArtifact(pkg, profile);
    if (row === null) return this.err("ARTIFACT_NOT_FOUND", await this.notFound("profile", profile));
    const sd = jsonValue(row.raw_json);
    const canonical = sd.url || row.canonical_url;

    // v14: content repairs run on the lossless draft (numbers keep their spelling) before pinning.
    const tree = cloneTree(losslessDraft !== undefined && losslessDraft !== null && typeof losslessDraft === "object" ? losslessDraft : draft) as Record<string, any>;
    if (!("resourceType" in tree)) tree.resourceType = sd.type;
    let repaired: RepairResult | null = null;
    if (repair === "content") {
      try {
        const deps = repairDepsFor(pkg, (text, valueSet, system, limit) => this.normalizeCodeIn(pkg, true, text, valueSet, system, limit), new DbValidatorResolver(pkg));
        repaired = await repairResource(tree, deps, { profiles: [canonical], timezone });
      } catch (e) {
        logError("fhir_finalize_resource: content repair failed; the draft is finalized as given", { error: String((e as Error).message) });
        repaired = null;
      }
    }
    if (repaired) losslessDraft = tree;
    const resource = repaired ? (toPlain(tree) as Record<string, any>) : JSON.parse(JSON.stringify(draft));
    if (!("resourceType" in resource)) resource.resourceType = sd.type;
    const warnings: string[] = [];

    const coerced = authoring.coerceArrayCardinality(sd, resource);
    if (coerced.length) {
      warnings.push("auto-wrapped repeating element(s) into arrays: " + coerced.map((c: any) => c.path).join(", "));
    }
    authoring.ensureMetaProfile(resource, canonical);
    // Explicit `_slice` tags first (any depth), then members the discriminators identify, then
    // the unsliced fixed / pattern values (1.4.0: slice members were never pinned before).
    const pinnedSlices = authoring.pinSlices(sd, resource);
    const pinned = [...authoring.pinSliceMembers(sd, resource), ...authoring.pinFixedPattern(sd, resource)];
    warnings.push(...(await this.inferSystems(pkg, sd, resource)));
    let referenceUrn: string | null = null;
    if (key) {
      [contextId, referenceUrn] = reference.mint(contextId, String(key));
    }
    if (contextId) {
      reference.rewriteReferences(resource, reference.getMap(contextId));
    }
    const narrated = generateNarrative && authoring.ensureNarrative(resource);
    const core = await this.validateCore(pkg, resource, row.artifact_id || profile);
    if (repaired) attachRepairIssues(core.issues as Record<string, any>[], repaired.issues);

    const data = {
      resource: losslessDraft !== undefined ? restoreNumbers(resource, losslessDraft) : resource,
      validation: core,
      ...(repair === "content" ? { repair: "content", changes: repaired ? repaired.changes : [], repair_issues: repaired ? repaired.issues : [] } : {}),
      coerced,
      narrated,
      pinned,
      pinnedSlices,
      contextId,
      reference: referenceUrn,
    };
    this.withDeps(data, pkg);
    if (!core.valid) {
      warnings.push("validation found errors — fix the draft and call finalize again");
    }
    return this.ok(data, pkg, warnings);
  }
}

/**
 * A value the repair layer declined to change (ISSUES_v14: not uniquely decidable, e.g. a display
 * that names a different concept) explains the validator's issue at the same place: the issue gets
 * `repair: {message, candidates}` (additive; severity / message / verdict unchanged).
 */
export function attachRepairIssues(issues: Array<Record<string, any>>, repairIssues: RepairIssue[]): void {
  if (!repairIssues.length) return;
  for (const ri of repairIssues) {
    const holder = ri.path.replace(/\.(system|code|display)$/, "");
    const hit = issues.find((i) => i && (i.severity === "error" || i.severity === "fatal" || i.severity === "warning") && (i.path === ri.path || i.path === holder));
    if (hit && !hit.repair) hit.repair = { rule: ri.rule, message: ri.message, ...(ri.candidates && ri.candidates.length ? { candidates: ri.candidates } : {}) };
  }
}

/** meta.profile values of a resource, plus those of Bundle entries (nested Bundles included). */
export function metaProfilesOf(resource: Record<string, any> | null | undefined, depth = 0): string[] {
  if (!resource || typeof resource !== "object" || depth > 4) return [];
  const out: string[] = [];
  for (const p of (resource.meta || {}).profile || []) if (typeof p === "string") out.push(p);
  if (resource.resourceType === "Bundle" && Array.isArray(resource.entry)) {
    for (const e of resource.entry) for (const p of metaProfilesOf(e && e.resource, depth + 1)) out.push(p);
  }
  return [...new Set(out)];
}

/** Positional-parameter builder: add(v) returns the "$n" placeholder. */
// --- Compact list rendering (opt-in `compact: true`) ----------------------- //
//
// The default list outputs repeat every artifact's full canonical URL and summary columns, which
// runs past a small tool-output budget (fhir_list_resource_profiles on TW Core: 12.9k chars). The
// compact form keeps what choosing an artifact needs: per group a map id → title, the canonical
// base once (canonical = base/<ResourceType>/<id>), and only the canonicals that break that rule.

export interface CompactSpec {
  /** Group key of a row (base FHIR type for profiles, resource type for artifacts). */
  group: (r: Record<string, any>) => string;
  /** Key of a row in the `canonicals` / `status` exception maps. */
  key: (r: Record<string, any>) => string;
  /** Report non-active statuses (`status` map). */
  status: boolean;
  /** One-line reading guide placed in the output. */
  legend: string;
}

export const PROFILES_COMPACT: CompactSpec = {
  group: (r) => r.base_type || "",
  key: (r) => r.artifact_id,
  status: true,
  legend:
    "byResourceType maps base type → {profile id: title}. canonical = canonical_base + '/StructureDefinition/' + id, " +
    "except the ids listed in canonicals. Profiles not listed in status are active. compact=false adds per-profile rows.",
};

export const ARTIFACTS_COMPACT: CompactSpec = {
  group: (r) => r.resource_type || "",
  key: (r) => `${r.resource_type}/${r.artifact_id}`,
  status: false,
  legend:
    "byResourceType maps resource type → {id: title}. Conformance resources (StructureDefinition, ValueSet, CodeSystem, …) " +
    "have canonical = canonical_base + '/' + resourceType + '/' + id, except the ResourceType/id keys listed in canonicals; " +
    "instance examples have none. compact=false adds the summary columns.",
};

/** The canonical base most rows follow (canonical = base/<ResourceType>/<id>), or null. */
export function canonicalBaseOf(rows: Record<string, any>[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const url = String(r.canonical_url || "");
    const suffix = `/${r.resource_type}/${r.artifact_id}`;
    if (url.length > suffix.length && url.endsWith(suffix)) {
      const base = url.slice(0, -suffix.length);
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let n = 0;
  for (const [base, c] of counts) if (c > n || (c === n && best !== null && base < best)) [best, n] = [base, c];
  return best;
}

/** Compact rendering of one package's rows (see CompactSpec). */
export function compactArtifactGroup(rows: Record<string, any>[], spec: CompactSpec): Record<string, any> {
  const base = canonicalBaseOf(rows);
  const byResourceType: Record<string, Record<string, string>> = {};
  const canonicals: Record<string, string> = {};
  const status: Record<string, string> = {};
  for (const r of rows) {
    const g = spec.group(r);
    // An instance without an id (e.g. a Bundle example) is keyed by its artifact_key.
    (byResourceType[g] ??= {})[r.artifact_id || r.artifact_key || ""] = r.title || r.name || "";
    const url = String(r.canonical_url || "");
    if (url && url !== `${base}/${r.resource_type}/${r.artifact_id}`) canonicals[spec.key(r)] = url;
    if (spec.status && r.status && r.status !== "active") status[spec.key(r)] = r.status;
  }
  const out: Record<string, any> = { compact: spec.legend, canonical_base: base, byResourceType };
  if (Object.keys(canonicals).length) out.canonicals = canonicals;
  if (Object.keys(status).length) out.status = status;
  return out;
}

/** all_packages compact rendering: one compact group per "packageId#version". */
export function compactByPackage(rows: Record<string, any>[], spec: CompactSpec): Record<string, any> {
  const groups = new Map<string, Record<string, any>[]>();
  for (const r of rows) {
    const k = `${r.package_id}#${r.package_version}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const packages: Record<string, any> = {};
  for (const [k, g] of groups) {
    const { compact: _legend, ...rest } = compactArtifactGroup(g, spec);
    packages[k] = rest;
  }
  return { compact: `packages maps packageId#version → its group. ${spec.legend}`, packages };
}

/** fhir_list_igs compact rendering: "packageId#version" → title, split by install origin. */
export function compactIgList(packages: Array<Record<string, any>>): Record<string, any> {
  const byOrigin: Record<string, Record<string, string>> = {};
  let def: string | null = null;
  for (const p of packages) {
    const k = `${p.package_id}#${p.version}`;
    if (p.is_default) def = k;
    const title = p.title && p.title !== p.package_id ? String(p.title) : "";
    (byOrigin[p.install_origin || "unknown"] ??= {})[k] = title;
  }
  return {
    compact:
      "manual / dependency map packageId#version → title (\"\" when the title is the package id); manual = installed by an " +
      "operator, dependency = pulled in by another IG. compact=false adds canonical, fhirVersion, status and dependencies.",
    count: packages.length,
    default: def,
    ...byOrigin,
  };
}

class SqlParams {
  params: unknown[] = [];
  add(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
}

/** Target kinds ranked by terminologyRanking.ts (the module search tools' hybrid). */
const HYBRID_KINDS = new Set(["snomed", "loinc", "icd_dx"]);

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function pySortedSet(s: Set<string>): string {
  return "[" + [...s].sort().map((x) => `'${x}'`).join(", ") + "]";
}

async function composeMembership(
  vs: Record<string, any>,
  system: string,
  code: string,
  pkg: PackageRow,
): Promise<boolean | undefined> {
  return composeContains(vs.compose || {}, system, code, terminology.dbTerminologyDeps(pkg), 0, new Set(), vs.expansion);
}
