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

import { query } from "./db.js";
import { logError, logInfo } from "./logger.js";
import type { EmbeddingService } from "./embeddingService.js";
import * as fhirIg from "./fhirIg.js";
import type { PackageRow } from "./fhirIg.js";
import * as snapshot from "./fhirSnapshot.js";
import * as terminology from "./fhirTerminology.js";
import * as validator from "./fhirValidator.js";
import * as reference from "./fhirReference.js";
import * as authoring from "./fhirAuthoring.js";

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

export class FHIRIGService {
  private embeddingSvc: EmbeddingService | null;

  constructor(embeddingSvc: EmbeddingService | null = null) {
    this.embeddingSvc = embeddingSvc;
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
    return {
      packageId: pkg.package_id,
      version: pkg.version,
      fhirVersion: pkg.fhir_version,
      source: "ig",
    };
  }

  private ok(data: any, pkg: PackageRow | null, warnings: any[] | null = null): string {
    const env = {
      ok: true,
      data,
      warnings: warnings || [],
      provenance: pkg ? this.provenance(pkg) : null,
    };
    return JSON.stringify(env);
  }

  private err(code: string, message: string): string {
    return JSON.stringify({ ok: false, data: null, warnings: [], error: { code, message } });
  }

  private async resolve(packageId: string | null | undefined, version: string | null | undefined): Promise<PackageRow> {
    const ig = packageId ? { packageId, version } : null;
    const [pid, ver] = await fhirIg.resolvePackage(ig);
    const pkg = await fhirIg.getPackage(pid, ver);
    if (pkg === null) throw new fhirIg.IGNotFoundError(`IG package not found: ${pid}#${ver}`);
    pkg._closure = await fhirIg.packageClosure(pkg.package_id, pkg.version);
    return pkg;
  }

  private async loadArtifact(pid: string, ver: string, identifier: string): Promise<Record<string, any> | null> {
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

  private isIGNotFound(e: unknown): e is fhirIg.IGNotFoundError {
    return e instanceof fhirIg.IGNotFoundError;
  }

  // --- A. IG discovery ----------------------------------------------------- //

  async listIgs(): Promise<string> {
    const packages = await fhirIg.listPackages();
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
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
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
      dependencies: pkg.dependencies || {},
      artifactCounts,
    };
    return this.ok(data, pkg);
  }

  async listArtifacts(
    packageId: string | null = null,
    version: string | null = null,
    resourceType: string | null = null,
    groupingId: string | null = null,
    limit = 50,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    limit = Math.min(Math.max(1, limit), 200);
    const params: any[] = [pkg.package_id, pkg.version];
    const clauses = ["package_id = $1", "package_version = $2"];
    if (resourceType) {
      params.push(resourceType);
      clauses.push(`resource_type = $${params.length}`);
    }
    if (groupingId) {
      params.push(groupingId);
      clauses.push(`grouping_id = $${params.length}`);
    }
    params.push(limit);
    const rows = (
      await query<Record<string, any>>(
        `SELECT ${ARTIFACT_SUMMARY_COLS} FROM fhir.artifacts ` +
          `WHERE ${clauses.join(" AND ")} ` +
          `ORDER BY resource_type, name LIMIT $${params.length}`,
        params,
      )
    ).rows;
    return this.ok({ count: rows.length, artifacts: rows }, pkg);
  }

  async searchArtifacts(
    keyword: string,
    packageId: string | null = null,
    version: string | null = null,
    resourceType: string | null = null,
    limit = 20,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    limit = Math.min(Math.max(1, limit), 100);
    const params: any[] = [pkg.package_id, pkg.version];
    const clauses = ["package_id = $1", "package_version = $2"];
    if (resourceType) {
      params.push(resourceType);
      clauses.push(`resource_type = $${params.length}`);
    }
    params.push(keyword);
    const kwIdx = params.length;
    params.push(`%${keyword}%`);
    const likeIdx = params.length;
    clauses.push(
      "(to_tsvector('simple', COALESCE(artifact_id,'') || ' ' || " +
        "COALESCE(canonical_url,'') || ' ' || COALESCE(name,'') || ' ' || " +
        "COALESCE(title,'') || ' ' || COALESCE(description,'')) " +
        `@@ plainto_tsquery('simple', $${kwIdx}) OR artifact_id ILIKE $${likeIdx})`,
    );
    params.push(limit);
    const rows = (
      await query<Record<string, any>>(
        `SELECT ${ARTIFACT_SUMMARY_COLS} FROM fhir.artifacts ` +
          `WHERE ${clauses.join(" AND ")} ` +
          `ORDER BY resource_type, name LIMIT $${params.length}`,
        params,
      )
    ).rows;
    return this.ok({ count: rows.length, artifacts: rows }, pkg);
  }

  // --- B. Profile selection ------------------------------------------------ //

  async listResourceProfiles(
    packageId: string | null = null,
    version: string | null = null,
    baseType: string | null = null,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
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
        `SELECT artifact_id, canonical_url, name, title, base_type, status
         FROM fhir.artifacts
         WHERE ${clauses.join(" AND ")}
         ORDER BY base_type, COALESCE(NULLIF(title,''), name, artifact_id)`,
        params,
      )
    ).rows;
    const byType: Record<string, any[]> = {};
    for (const r of rows) {
      const key = r.base_type || "";
      if (!byType[key]) byType[key] = [];
      byType[key].push({
        profile: r.artifact_id,
        canonical: r.canonical_url,
        title: r.title || r.name || r.artifact_id,
        status: r.status,
      });
    }
    return this.ok({ count: rows.length, byResourceType: byType }, pkg);
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
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
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
    return this.ok({ selectionRequired: true, inputKeys: want, candidates: scored.slice(0, limit) }, pkg);
  }

  async getProfile(
    identifier: string,
    packageId: string | null = null,
    version: string | null = null,
  ): Promise<string> {
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const row = await this.loadArtifact(pkg.package_id, pkg.version, identifier);
    if (row === null) return this.err("ARTIFACT_NOT_FOUND", `profile not found: ${identifier}`);
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
    return this.ok(data, pkg);
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
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const row = await this.loadArtifact(pkg.package_id, pkg.version, profile);
    if (row === null) return this.err("ARTIFACT_NOT_FOUND", `profile not found: ${profile}`);
    const sd = jsonValue(row.raw_json);

    if (view === "examples") {
      const data = await this.profileExamples(pkg, row.canonical_url);
      return this.ok(data, pkg);
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
    return this.ok({ view, result }, pkg, warnings);
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
    const row = await this.loadArtifact(pkg.package_id, pkg.version, identifier);
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
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const vs = await this.loadValueset(pkg, identifier);
    if (vs === null) return this.err("VALUESET_NOT_FOUND", `ValueSet not found: ${identifier}`);
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
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const vs = await this.loadValueset(pkg, identifier);
    if (vs === null) return this.err("VALUESET_NOT_FOUND", `ValueSet not found: ${identifier}`);
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
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const found = await terminology.lookup(system, code, pkg);
    const warnings: string[] = [];
    if (found === null) {
      warnings.push(
        "code not found in locally held terminology — it may belong to an " +
          "external system (TERMINOLOGY_SERVER_REQUIRED)",
      );
    }
    const data = {
      system,
      code,
      found: found !== null,
      display: found ? found.display : null,
      definition: found ? found.definition : null,
    };
    return this.ok(data, pkg, warnings);
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
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const vs = await this.loadValueset(pkg, valueSet);
    if (vs === null) return this.err("VALUESET_NOT_FOUND", `ValueSet not found: ${valueSet}`);
    const exp = await terminology.expandCompose(vs.compose || {}, pkg);
    const member = exp.codings.some((c) => c.system === system && c.code === code);
    const sysUnresolved = exp.unresolved.some((u: any) => u.system === system);
    const warnings = [...exp.warnings];
    let result: string;
    if (member) {
      result = "valid";
    } else if (exp.truncated || sysUnresolved) {
      result = "unverifiable";
      warnings.push(
        "membership could not be confirmed locally (expansion truncated or " +
          "system not held); confirm against a terminology server",
      );
    } else {
      result = "invalid";
    }
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
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    limit = Math.min(Math.max(1, limit), 50);

    const { targets, scopeIds, warnings } = await this.normalizeTargets(pkg, valueSet, system);
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
    for (const tgt of targets) {
      for (const [sys_, code, display] of await this.normalizeLexical(pkg, tgt, text, scopeIds[tgt.system], limit)) {
        add(sys_, code, display, "lexical", 0.6);
      }
      for (const [sys_, code, display, dist] of await this.normalizeSemantic(tgt, text, scopeIds[tgt.system], limit)) {
        add(sys_, code, display, "semantic", Math.max(0.0, 1.0 - dist));
      }
    }

    const order: Record<string, number> = { conceptmap: 0, lexical: 1, semantic: 2 };
    candidates.sort((a, b) => ((order[a.source] ?? 9) - (order[b.source] ?? 9)) || (b.score - a.score));
    if (this.embeddingSvc === null) warnings.push("semantic search unavailable (no embedding service)");
    const data = {
      text,
      targets: targets.map((t) => t.system),
      candidates: candidates.slice(0, limit),
      note: "candidates are suggestions — confirm with fhir_validate_code",
    };
    return this.ok(data, pkg, warnings);
  }

  private async normalizeTargets(
    pkg: PackageRow,
    valueSet: string | null,
    system: string | null,
  ): Promise<{ targets: Array<{ system: string; kind: string }>; scopeIds: Record<string, number[]>; warnings: string[] }> {
    const warnings: string[] = [];
    const targets: Array<{ system: string; kind: string }> = [];
    const scopeIds: Record<string, number[]> = {};
    const seen = new Set<string>();
    const addTarget = (sys_: string | null | undefined) => {
      if (!sys_ || seen.has(sys_)) return;
      seen.add(sys_);
      targets.push({ system: sys_, kind: terminology.routeSystem(sys_) });
    };
    if (system) addTarget(system);
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
              scopeIds[sys_].push(...ids);
            }
          }
        }
      }
    }
    return { targets, scopeIds, warnings };
  }

  private async normalizeConceptmap(
    pkg: PackageRow,
    text: string,
    targets: Array<{ system: string; kind: string }>,
  ): Promise<Array<[string, string, any]>> {
    const targetSystems = new Set(targets.map((t) => t.system));
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
    const needle = (text || "").trim().toLowerCase();
    const out: Array<[string, string, any]> = [];
    for (const r of rows) {
      const cm = jsonValue(r.raw_json);
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
    if (kind === "snomed") {
      let rows;
      if (scopeIds && scopeIds.length) {
        rows = (
          await query<{ concept_id: number; term: string }>(
            "SELECT DISTINCT ON (concept_id) concept_id, term FROM snomed.descriptions " +
              "WHERE active = TRUE AND term ILIKE $1 AND concept_id = ANY($2::bigint[]) " +
              "ORDER BY concept_id LIMIT $3",
            [like, scopeIds, limit],
          )
        ).rows;
      } else {
        rows = (
          await query<{ concept_id: number; term: string }>(
            "SELECT DISTINCT ON (concept_id) concept_id, term FROM snomed.descriptions " +
              "WHERE active = TRUE AND term ILIKE $1 ORDER BY concept_id LIMIT $2",
            [like, limit],
          )
        ).rows;
      }
      return rows.map((r) => [sys_, String(r.concept_id), r.term] as [string, string, any]);
    }
    if (kind === "loinc") {
      const rows = (
        await query<{ loinc_num: string; long_common_name: string }>(
          "SELECT loinc_num, long_common_name FROM loinc.concepts WHERE long_common_name ILIKE $1 LIMIT $2",
          [like, limit],
        )
      ).rows;
      return rows.map((r) => [sys_, r.loinc_num, r.long_common_name] as [string, string, any]);
    }
    if (kind === "icd_dx" || kind === "icd_pcs") {
      const table = kind === "icd_dx" ? "icd.diagnoses" : "icd.procedures";
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

  private async normalizeSemantic(
    target: { system: string; kind: string },
    text: string,
    scopeIds: number[] | undefined,
    limit: number,
  ): Promise<Array<[string, string, any, number]>> {
    if (this.embeddingSvc === null) return [];
    const kind = target.kind;
    const sys_ = target.system;
    let vec: number[] | null = null;
    try {
      vec = await this.embeddingSvc.embed(text);
    } catch {
      vec = null;
    }
    if (!vec) return [];
    const vecStr = `[${vec.join(",")}]`;
    if (kind === "snomed") {
      let rows;
      if (scopeIds && scopeIds.length) {
        rows = (
          await query<{ concept_id: number; term: string; dist: number }>(
            "SELECT e.concept_id, " +
              "(SELECT term FROM snomed.descriptions d WHERE d.concept_id = e.concept_id " +
              " AND d.active = TRUE ORDER BY d.us_preferred DESC NULLS LAST LIMIT 1) AS term, " +
              "e.embedding <=> $1::halfvec AS dist FROM snomed.concept_embeddings e " +
              "WHERE e.concept_id = ANY($2::bigint[]) ORDER BY dist LIMIT $3",
            [vecStr, scopeIds, limit],
          )
        ).rows;
      } else {
        rows = (
          await query<{ concept_id: number; term: string; dist: number }>(
            "SELECT e.concept_id, " +
              "(SELECT term FROM snomed.descriptions d WHERE d.concept_id = e.concept_id " +
              " AND d.active = TRUE ORDER BY d.us_preferred DESC NULLS LAST LIMIT 1) AS term, " +
              "e.embedding <=> $1::halfvec AS dist FROM snomed.concept_embeddings e " +
              "ORDER BY dist LIMIT $2",
            [vecStr, limit],
          )
        ).rows;
      }
      return rows.map((r) => [sys_, String(r.concept_id), r.term, Number(r.dist)] as [string, string, any, number]);
    }
    if (kind === "loinc") {
      const rows = (
        await query<{ loinc_num: string; long_common_name: string; dist: number }>(
          "SELECT e.loinc_num, c.long_common_name, e.embedding <=> $1::halfvec AS dist " +
            "FROM loinc.concept_embeddings e JOIN loinc.concepts c ON c.loinc_num = e.loinc_num " +
            "ORDER BY dist LIMIT $2",
          [vecStr, limit],
        )
      ).rows;
      return rows.map((r) => [sys_, r.loinc_num, r.long_common_name, Number(r.dist)] as [string, string, any, number]);
    }
    if (kind === "icd_dx") {
      const rows = (
        await query<{ code: string; name_en: string; dist: number }>(
          "SELECT e.code, c.name_en, e.embedding <=> $1::halfvec AS dist " +
            "FROM icd.diagnosis_embeddings e JOIN icd.diagnoses c ON c.code = e.code " +
            "ORDER BY dist LIMIT $2",
          [vecStr, limit],
        )
      ).rows;
      return rows.map((r) => [sys_, r.code, r.name_en, Number(r.dist)] as [string, string, any, number]);
    }
    return [];
  }

  // --- G. Validation ------------------------------------------------------- //

  private async resolveProfileSd(
    pkg: PackageRow,
    resource: Record<string, any>,
    profile: string | null,
  ): Promise<[Record<string, any> | null, string | null]> {
    let identifier = profile;
    if (!identifier) {
      const metas = (resource.meta || {}).profile || [];
      if (metas.length) identifier = String(metas[0]).split("|")[0];
    }
    if (!identifier) return [null, null];
    const row = await this.loadArtifact(pkg.package_id, pkg.version, identifier);
    if (row === null) return [null, identifier];
    return [jsonValue(row.raw_json), row.artifact_id || identifier];
  }

  private async bindingIssues(pkg: PackageRow, sd: Record<string, any>, resource: Record<string, any>): Promise<any[]> {
    const root = sd.type || resource.resourceType || "";
    const issues: any[] = [];
    for (const el of (sd.snapshot || {}).element || []) {
      if (snapshot.isSliceMember(el)) continue;
      const binding = el.binding || {};
      if (binding.strength !== "required" || !binding.valueSet) continue;
      const path = el.path || "";
      const rel = validator.relPath(path, root);
      if (!rel) continue;
      const nodes = validator.getAtPath(resource, rel);
      if (!nodes.length) continue;
      const typeCode = (el.type || [{}])[0].code;
      const vs = await this.loadValueset(pkg, String(binding.valueSet).split("|")[0]);
      if (vs === null) {
        issues.push(
          validator.issue("warning", path, "binding-unresolved", `required binding ValueSet not held locally: ${binding.valueSet}`),
        );
        continue;
      }
      const exp = await terminology.expandCompose(vs.compose || {}, pkg);
      const members = new Set(exp.codings.map((c) => `${c.system} ${c.code}`));
      const codesOnly = new Set(exp.codings.map((c) => c.code));
      const unverifiable = exp.truncated || exp.unresolved.length > 0;
      for (const node of nodes) {
        for (const [system, code] of codingsOf(node, typeCode)) {
          if (code === null) continue;
          const okMember = members.has(`${system} ${code}`) || (system === null && codesOnly.has(code));
          if (okMember) continue;
          if (unverifiable) {
            issues.push(
              validator.issue(
                "warning",
                path,
                "binding-unverifiable",
                `${path}: code ${system}|${code} could not be confirmed ` +
                  `(binding ValueSet not fully expandable locally)`,
              ),
            );
          } else {
            issues.push(
              validator.issue("error", path, "binding", `${path}: code ${system}|${code} is not in the required binding`),
            );
          }
        }
      }
    }
    return issues;
  }

  private async validateCore(pkg: PackageRow, resource: Record<string, any>, profile: string | null): Promise<Record<string, any>> {
    const [sd, profileId] = await this.resolveProfileSd(pkg, resource, profile);
    if (sd === null) {
      return {
        valid: true,
        profile: profileId,
        source: validator.SOURCE,
        issues: [
          validator.issue(
            "warning",
            "",
            "no-profile",
            "no resolvable profile (meta.profile absent and base " +
              "StructureDefinition not held) — structure not validated",
          ),
        ],
      };
    }
    const issues = [
      ...validator.validateStructure(sd, resource),
      ...validator.validateSlicing(sd, resource),
      ...validator.evaluateInvariants(sd, resource),
      ...(await this.bindingIssues(pkg, sd, resource)),
    ];
    return { valid: validator.isValid(issues), profile: profileId, source: validator.SOURCE, issues };
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
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const data = await this.validateCore(pkg, resource, profile);
    return this.ok(data, pkg);
  }

  async validateBundle(
    bundle: Record<string, any>,
    packageId: string | null = null,
    version: string | null = null,
  ): Promise<string> {
    if (!(bundle && typeof bundle === "object" && !Array.isArray(bundle)) || bundle.resourceType !== "Bundle") {
      return this.err("INVALID_ARGUMENT", "bundle must be a FHIR Bundle resource");
    }
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const bundleEntries = bundle.entry || [];
    const fullUrls = new Set(bundleEntries.filter((e: any) => e.fullUrl).map((e: any) => e.fullUrl));
    const entryResults: any[] = [];
    const referenceIssues: any[] = [];
    let allValid = true;
    for (const be of bundleEntries) {
      const resource = be.resource || {};
      if (!resource.resourceType) continue;
      const core = await this.validateCore(pkg, resource, null);
      allValid = allValid && core.valid;
      entryResults.push({
        fullUrl: be.fullUrl ?? null,
        resourceType: resource.resourceType,
        valid: core.valid,
        profile: core.profile,
        issues: core.issues,
      });
      const refs: string[] = [];
      reference.collectReferences(resource, refs);
      const containedIds = new Set(
        (resource.contained || []).filter((c: any) => c.id).map((c: any) => "#" + c.id),
      );
      for (const ref of refs) {
        if (ref.startsWith("urn:uuid:")) {
          if (!fullUrls.has(ref)) referenceIssues.push({ resourceType: resource.resourceType, reference: ref });
        } else if (ref.startsWith("#")) {
          if (!containedIds.has(ref)) referenceIssues.push({ resourceType: resource.resourceType, reference: ref });
        }
      }
    }
    const data = {
      valid: allValid && referenceIssues.length === 0,
      source: validator.SOURCE,
      entries: entryResults,
      referenceIssues,
    };
    const warnings: string[] = [];
    if (referenceIssues.length) {
      warnings.push(`${referenceIssues.length} internal reference(s) did not resolve within the bundle`);
    }
    return this.ok(data, pkg, warnings);
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
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const row = await this.loadArtifact(pkg.package_id, pkg.version, profile);
    if (row === null) return this.err("ARTIFACT_NOT_FOUND", `profile not found: ${profile}`);
    const sd = jsonValue(row.raw_json);
    const root = sd.type || "";
    const prefix = root + ".";
    candidateLimit = Math.min(Math.max(1, candidateLimit), 100);

    const fields: any[] = [];
    const warnings: string[] = [];
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
        "Fill the semantic blanks below. Leave 'autoPinned' fields and " +
        "meta.profile to fhir_finalize_resource. Use the candidateCodes for " +
        "bound elements (confirm with fhir_validate_code). Then call " +
        "fhir_finalize_resource with your draft.",
      fields,
      examples,
    };
    return this.ok(data, pkg, warnings);
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
          targetCodings.push(...node.coding);
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
  ): Promise<string> {
    if (!(draft && typeof draft === "object" && !Array.isArray(draft))) {
      return this.err("INVALID_ARGUMENT", "draft must be a resource object");
    }
    let pkg: PackageRow;
    try {
      pkg = await this.resolve(packageId, version);
    } catch (e) {
      if (this.isIGNotFound(e)) return this.err("IG_NOT_FOUND", e.message);
      throw e;
    }
    const row = await this.loadArtifact(pkg.package_id, pkg.version, profile);
    if (row === null) return this.err("ARTIFACT_NOT_FOUND", `profile not found: ${profile}`);
    const sd = jsonValue(row.raw_json);
    const canonical = sd.url || row.canonical_url;

    const resource = JSON.parse(JSON.stringify(draft));
    if (!("resourceType" in resource)) resource.resourceType = sd.type;
    const warnings: string[] = [];

    const coerced = authoring.coerceArrayCardinality(sd, resource);
    if (coerced.length) {
      warnings.push("auto-wrapped repeating element(s) into arrays: " + coerced.map((c: any) => c.path).join(", "));
    }
    authoring.ensureMetaProfile(resource, canonical);
    const pinned = authoring.pinFixedPattern(sd, resource);
    const pinnedSlices = authoring.pinSlices(sd, resource);
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

    const data = {
      resource,
      validation: core,
      coerced,
      narrated,
      pinned,
      pinnedSlices,
      contextId,
      reference: referenceUrn,
    };
    if (!core.valid) {
      warnings.push("validation found errors — fix the draft and call finalize again");
    }
    return this.ok(data, pkg, warnings);
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function pySortedSet(s: Set<string>): string {
  return "[" + [...s].sort().map((x) => `'${x}'`).join(", ") + "]";
}
