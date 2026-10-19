/**
 * Admin FHIR profile viewer API — read-only, behind the admin session gate
 * (dispatched from adminApp.ts before the generic `/admin/api/igs/{id}/{version}` routes).
 *
 *   GET /admin/api/igs/profile?package_id=&version=&artifact_id=
 *        identity (fhir_get_profile) + element rows (snapshot, differential flags) +
 *        base-definition chain + derived profiles + resolved links + extension info + examples
 *   GET /admin/api/igs/profile/required?…&verbosity=compact|full&include_mustsupport=
 *        the exact fhir_get_profile_required_elements envelope
 *   GET /admin/api/igs/profile/skeleton?…   the exact fhir_get_resource_skeleton envelope
 *   GET /admin/api/igs/profile/valueset?package_id=&version=&url=&limit=
 *        fhir_expand_valueset envelope (binding preview)
 *   GET /admin/api/igs/profile/example?package_id=&version=&artifact_id=&resource_type=
 *        one example resource (raw JSON) of the package
 *
 * Every LLM-facing answer is produced by the same FHIRIGService methods the MCP tools
 * call, so the console shows exactly what a model gets. Only presentation (element
 * tree rows, chain, links) is computed here, by the pure helpers below.
 */

import * as snapshot from "../fhirSnapshot.js";

type Json = Record<string, any>;

/** Minimal query runner (matches db.query). */
export type ProfileQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Json[] }>;

/** The FHIRIGService methods this API reuses (each returns the tool's JSON envelope string). */
export interface ProfileToolService {
  getProfile(identifier: string, packageId: string | null, version: string | null): Promise<string>;
  getProfileElements(
    profile: string,
    packageId: string | null,
    version: string | null,
    view?: string,
    path?: string | null,
    sliceName?: string | null,
    limit?: number,
  ): Promise<string>;
  getProfileRequiredElements(
    profile: string,
    packageId: string | null,
    version: string | null,
    instance?: Json | null,
    includeTargetImplied?: boolean,
    includeMustSupport?: boolean | "defaults",
    verbosity?: "compact" | "full",
  ): Promise<string>;
  getResourceSkeleton(profile: string, packageId: string | null, version: string | null, candidateLimit?: number, includeExamples?: boolean): Promise<string>;
  expandValueset(identifier: string, packageId: string | null, version: string | null, limit?: number): Promise<string>;
}

export interface ProfileApiDeps {
  query: ProfileQuery;
  service: () => Promise<ProfileToolService>;
  /** Package closure (target first, then dependencies breadth-first). */
  closure: (packageId: string, version: string) => Promise<Array<[string, string]>>;
}

export interface ProfileApiResult {
  status: number;
  body: unknown;
}

// --------------------------------------------------------------------------- //
// Pure presentation helpers (unit-tested)
// --------------------------------------------------------------------------- //

export interface ElementType {
  code: string;
  profile?: string[];
  targetProfile?: string[];
}

export interface ElementConstraint {
  key: string;
  severity: string | null;
  human: string | null;
  expression: string | null;
  source: string | null;
}

export interface ElementRow {
  id: string;
  path: string;
  parent: string | null;
  depth: number;
  /** Last path segment without the slice name (e.g. "identifier"). */
  name: string;
  sliceName: string | null;
  min: number | null;
  max: string | null;
  baseMin: number | null;
  baseMax: string | null;
  /** Cardinality differs from the base definition. */
  cardChanged: boolean;
  mustSupport: boolean;
  isModifier: boolean;
  isModifierReason: string | null;
  isSummary: boolean;
  types: ElementType[];
  binding: { strength: string | null; valueSet: string | null; description: string | null } | null;
  fixed: snapshot.FixedPattern | null;
  pattern: snapshot.FixedPattern | null;
  constraints: ElementConstraint[];
  /** Constraints other than the universal ele-1. */
  constraintCount: number;
  short: string | null;
  definition: string | null;
  comment: string | null;
  requirements: string | null;
  meaningWhenMissing: string | null;
  alias: string[];
  condition: string[];
  maxLength: number | null;
  contentReference: string | null;
  mappings: Array<{ identity: string; map: string }>;
  slicing: { discriminator: Array<{ type: string; path: string }>; rules: string | null; ordered: boolean | null; description: string | null } | null;
  /** Present in the differential (constrained by this profile). */
  inDiff: boolean;
  /** Element properties set in the differential (besides id/path). */
  diffKeys: string[];
  hasChildren: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Split an element id into dot segments; slice names (after ':') may not contain '.', so this is safe for FHIR ids. */
export function idSegments(id: string): string[] {
  return id.split(".");
}

/**
 * Display parent of an element id (IG-Publisher layout): a slice hangs under its sliced
 * element, a re-slice (`a:b/c`) under its slice, everything else under the previous segment.
 */
export function immediateParent(id: string): string | null {
  const segs = idSegments(id);
  const last = segs[segs.length - 1];
  const colon = last.indexOf(":");
  if (colon >= 0) {
    const slash = last.lastIndexOf("/");
    const head = slash > colon ? last.slice(0, slash) : last.slice(0, colon);
    return [...segs.slice(0, -1), head].join(".");
  }
  if (segs.length === 1) return null;
  return segs.slice(0, -1).join(".");
}

/** Nearest ancestor present in `known` (differentials may skip levels). */
export function nearestParent(id: string, known: Set<string>): string | null {
  let cur: string | null = id;
  for (let guard = 0; guard < 64; guard++) {
    cur = immediateParent(cur!);
    if (cur === null) return null;
    if (known.has(cur)) return cur;
  }
  return null;
}

function elementId(el: Json): string {
  if (typeof el.id === "string" && el.id) return el.id;
  const p = String(el.path ?? "");
  return el.sliceName ? `${p}:${el.sliceName}` : p;
}

function nameOf(id: string): string {
  const segs = idSegments(id);
  const last = segs[segs.length - 1];
  const colon = last.indexOf(":");
  return colon >= 0 ? last.slice(0, colon) : last;
}

const DIFF_IGNORED = new Set(["id", "path", "extension"]);

/** Turn snapshot (or, when absent, differential) elements into tree rows. */
export function buildElementRows(sd: Json): { rows: ElementRow[]; source: "snapshot" | "differential" | "none"; differentialCount: number } {
  const snap: Json[] = Array.isArray(sd?.snapshot?.element) ? sd.snapshot.element : [];
  const diff: Json[] = Array.isArray(sd?.differential?.element) ? sd.differential.element : [];
  const source = snap.length ? "snapshot" : diff.length ? "differential" : "none";
  const els = snap.length ? snap : diff;
  const diffById = new Map<string, Json>();
  for (const d of diff) diffById.set(elementId(d), d);
  const ids = els.map(elementId);
  const known = new Set(ids);
  const depthOf = new Map<string, number>();
  const rows: ElementRow[] = [];
  const hasKids = new Set<string>();
  els.forEach((el, i) => {
    const id = ids[i];
    const parent = nearestParent(id, known);
    if (parent) hasKids.add(parent);
    const depth = parent === null ? 0 : (depthOf.get(parent) ?? 0) + 1;
    depthOf.set(id, depth);
    const [fixed, pattern] = snapshot.fixedPattern(el);
    const d = diffById.get(id);
    const base = el.base && typeof el.base === "object" ? el.base : null;
    const min = typeof el.min === "number" ? el.min : null;
    const max = str(el.max);
    const baseMin = base && typeof base.min === "number" ? base.min : null;
    const baseMax = base ? str(base.max) : null;
    const constraints: ElementConstraint[] = (Array.isArray(el.constraint) ? el.constraint : []).map((c: Json) => ({
      key: String(c.key ?? ""),
      severity: str(c.severity),
      human: str(c.human),
      expression: str(c.expression),
      source: str(c.source),
    }));
    const b = el.binding && typeof el.binding === "object" ? el.binding : null;
    const sl = el.slicing && typeof el.slicing === "object" ? el.slicing : null;
    rows.push({
      id,
      path: String(el.path ?? id),
      parent,
      depth,
      name: nameOf(id),
      sliceName: str(el.sliceName),
      min,
      max,
      baseMin,
      baseMax,
      cardChanged: base !== null && ((baseMin !== null && min !== null && baseMin !== min) || (baseMax !== null && max !== null && baseMax !== max)),
      mustSupport: Boolean(el.mustSupport),
      isModifier: Boolean(el.isModifier),
      isModifierReason: str(el.isModifierReason),
      isSummary: Boolean(el.isSummary),
      types: (Array.isArray(el.type) ? el.type : []).map((t: Json) => {
        const out: ElementType = { code: String(t.code ?? "") };
        if (Array.isArray(t.profile) && t.profile.length) out.profile = t.profile.map(String);
        if (Array.isArray(t.targetProfile) && t.targetProfile.length) out.targetProfile = t.targetProfile.map(String);
        return out;
      }),
      binding: b ? { strength: str(b.strength), valueSet: str(b.valueSet), description: str(b.description) } : null,
      fixed,
      pattern,
      constraints,
      constraintCount: constraints.filter((c) => c.key !== "ele-1").length,
      short: str(el.short),
      definition: str(el.definition),
      comment: str(el.comment),
      requirements: str(el.requirements),
      meaningWhenMissing: str(el.meaningWhenMissing),
      alias: Array.isArray(el.alias) ? el.alias.map(String) : [],
      condition: Array.isArray(el.condition) ? el.condition.map(String) : [],
      maxLength: typeof el.maxLength === "number" ? el.maxLength : null,
      contentReference: str(el.contentReference),
      mappings: (Array.isArray(el.mapping) ? el.mapping : []).map((m: Json) => ({ identity: String(m.identity ?? ""), map: String(m.map ?? "") })),
      slicing: sl
        ? {
            discriminator: (Array.isArray(sl.discriminator) ? sl.discriminator : []).map((x: Json) => ({ type: String(x.type ?? ""), path: String(x.path ?? "") })),
            rules: str(sl.rules),
            ordered: typeof sl.ordered === "boolean" ? sl.ordered : null,
            description: str(sl.description),
          }
        : null,
      inDiff: source === "differential" || d !== undefined,
      diffKeys: d ? Object.keys(d).filter((k) => !DIFF_IGNORED.has(k)) : [],
      hasChildren: false,
    });
  });
  for (const r of rows) r.hasChildren = hasKids.has(r.id);
  return { rows, source, differentialCount: diff.length };
}

/** Canonical without its `|version` suffix. */
export function bareCanonical(url: string): string {
  const i = url.indexOf("|");
  return i >= 0 ? url.slice(0, i) : url;
}

const FHIR_SD = "http://hl7.org/fhir/StructureDefinition/";

/** Every canonical the page may want to link: type profiles, target profiles, bindings, core type definitions. */
export function collectCanonicals(rows: ElementRow[], extra: Array<string | null | undefined> = []): string[] {
  const out = new Set<string>();
  const add = (u: string | null | undefined) => {
    if (u) out.add(bareCanonical(u));
  };
  for (const r of rows) {
    for (const t of r.types) {
      t.profile?.forEach(add);
      t.targetProfile?.forEach(add);
      // Complex types / resources have a core StructureDefinition (primitives start lower-case).
      if (/^[A-Z]/.test(t.code)) add(FHIR_SD + t.code);
    }
    add(r.binding?.valueSet);
  }
  extra.forEach(add);
  return [...out].sort();
}

export interface LinkTarget {
  package_id: string;
  version: string;
  artifact_id: string;
  resource_type: string;
  title: string | null;
  kind: string | null;
}

/** Pick, per canonical, the owner earliest in the closure (else any installed owner). */
export function pickLinks(rows: Json[], closure: Array<[string, string]>): Record<string, LinkTarget> {
  const rank = new Map(closure.map(([p, v], i) => [`${p} ${v}`, i]));
  const best = new Map<string, { r: number; row: Json }>();
  for (const row of rows) {
    const url = String(row.canonical_url ?? "");
    if (!url) continue;
    const r = rank.get(`${row.package_id} ${row.package_version}`) ?? Number.MAX_SAFE_INTEGER;
    const cur = best.get(url);
    if (!cur || r < cur.r) best.set(url, { r, row });
  }
  const out: Record<string, LinkTarget> = {};
  for (const [url, { row }] of best) {
    out[url] = {
      package_id: String(row.package_id),
      version: String(row.package_version),
      artifact_id: String(row.artifact_id ?? ""),
      resource_type: String(row.resource_type ?? ""),
      title: str(row.title) ?? str(row.name),
      kind: str(row.kind),
    };
  }
  return out;
}

export interface ChainEntry {
  canonical: string;
  artifact_id: string | null;
  package_id: string | null;
  version: string | null;
  title: string | null;
  derivation: string | null;
  kind: string | null;
  installed: boolean;
}

/**
 * Base-definition chain, root-most first and ending with the profile itself. `resolve`
 * returns the StructureDefinition row for a canonical (null when not installed); the walk
 * stops at a missing definition, a cycle, or `maxDepth`.
 */
export async function walkBaseChain(
  self: { canonical: string; artifact_id: string | null; package_id: string; version: string; title: string | null; derivation: string | null; kind: string | null; baseDefinition: string | null },
  resolve: (canonical: string) => Promise<Json | null>,
  maxDepth = 12,
): Promise<ChainEntry[]> {
  const chain: ChainEntry[] = [
    { canonical: self.canonical, artifact_id: self.artifact_id, package_id: self.package_id, version: self.version, title: self.title, derivation: self.derivation, kind: self.kind, installed: true },
  ];
  const seen = new Set([bareCanonical(self.canonical)]);
  let next = self.baseDefinition;
  while (next && chain.length <= maxDepth) {
    const url = bareCanonical(next);
    if (seen.has(url)) break;
    seen.add(url);
    const row = await resolve(url);
    if (!row) {
      chain.push({ canonical: url, artifact_id: null, package_id: null, version: null, title: url.split("/").pop() ?? url, derivation: null, kind: null, installed: false });
      break;
    }
    const raw = jsonValue(row.raw_json);
    chain.push({
      canonical: url,
      artifact_id: str(row.artifact_id),
      package_id: str(row.package_id),
      version: str(row.package_version),
      title: str(row.title) ?? str(row.name) ?? str(raw.name),
      derivation: str(row.derivation) ?? str(raw.derivation),
      kind: str(row.kind) ?? str(raw.kind),
      installed: true,
    });
    next = str(raw.baseDefinition);
  }
  return chain.reverse();
}

export interface ExtensionInfo {
  context: Array<{ type: string; expression: string }>;
  contextInvariant: string[];
  /** Allowed value[x] types (empty for a complex extension). */
  valueTypes: ElementType[];
  complex: boolean;
  subExtensions: Array<{ sliceName: string; url: string | null; min: number | null; max: string | null; short: string | null; valueTypes: string[] }>;
}

/** Extension-specific facts: context of use, value[x] types, sub-extensions (complex extensions). */
export function extensionInfo(sd: Json, rows: ElementRow[]): ExtensionInfo | null {
  if (sd?.type !== "Extension") return null;
  const value = rows.find((r) => r.id === "Extension.value[x]");
  const valueTypes = value && value.max !== "0" ? value.types : [];
  const subs = rows.filter((r) => r.parent === "Extension.extension" && r.sliceName && r.max !== "0");
  const subExtensions = subs.map((s) => {
    const urlRow = rows.find((r) => r.id === `${s.id}.url`);
    const val = rows.find((r) => r.id === `${s.id}.value[x]`);
    const fixedUrl = urlRow?.fixed?.value;
    return {
      sliceName: s.sliceName!,
      url: typeof fixedUrl === "string" ? fixedUrl : (s.types[0]?.profile?.[0] ?? null),
      min: s.min,
      max: s.max,
      short: s.short,
      valueTypes: val && val.max !== "0" ? val.types.map((t) => t.code) : [],
    };
  });
  return {
    context: (Array.isArray(sd.context) ? sd.context : []).map((c: Json) => ({ type: String(c.type ?? ""), expression: String(c.expression ?? "") })),
    contextInvariant: Array.isArray(sd.contextInvariant) ? sd.contextInvariant.map(String) : [],
    valueTypes,
    complex: valueTypes.length === 0 && subExtensions.length > 0,
    subExtensions,
  };
}

/** Header metadata of a StructureDefinition (beyond what fhir_get_profile returns). */
export function sdMeta(sd: Json): Json {
  return {
    url: str(sd.url),
    version: str(sd.version),
    name: str(sd.name),
    title: str(sd.title),
    status: str(sd.status),
    experimental: typeof sd.experimental === "boolean" ? sd.experimental : null,
    abstract: typeof sd.abstract === "boolean" ? sd.abstract : null,
    type: str(sd.type),
    kind: str(sd.kind),
    derivation: str(sd.derivation),
    fhirVersion: str(sd.fhirVersion),
    publisher: str(sd.publisher),
    date: str(sd.date),
    description: str(sd.description),
    purpose: str(sd.purpose),
    copyright: str(sd.copyright),
    mappings: (Array.isArray(sd.mapping) ? sd.mapping : []).map((m: Json) => ({ identity: String(m.identity ?? ""), name: str(m.name), uri: str(m.uri) })),
  };
}

/** Parse a tool envelope string; a non-JSON answer becomes an INTERNAL envelope. */
export function parseEnvelope(text: string): Json {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : { ok: false, error: { code: "INTERNAL", message: "tool returned a non-object" } };
  } catch {
    return { ok: false, error: { code: "INTERNAL", message: text.slice(0, 300) } };
  }
}

/** zh-TW explanation for a tool error envelope, in the adminErrorCodes body shape. */
export function envelopeError(env: Json): ProfileApiResult {
  const e = (env?.error ?? {}) as Json;
  const code = String(e.code ?? "INTERNAL");
  const message = String(e.message ?? "profile request failed");
  const table: Record<string, [number, string, string]> = {
    ARTIFACT_NOT_FOUND: [404, "找不到這個 Profile（StructureDefinition）。", "它可能不在這個 IG 版本內，或 IG 已被移除；請回到 IG 套件庫重新選擇。"],
    IG_NOT_FOUND: [404, "找不到這個 IG 套件版本（可能已被移除）。", "請回到 IG 套件庫重新整理後再選擇。"],
    NO_DEFAULT_IG: [404, "未指定 IG 套件且沒有預設 IG。", "請從 IG 套件庫開啟 Profile。"],
    VALUESET_NOT_FOUND: [404, "這個 ValueSet 不在此 IG 的套件範圍內。", "可能屬於尚未安裝的相依套件；請到 IG 套件庫補齊缺少的相依套件。"],
    INVALID_ARGUMENT: [422, "這個 StructureDefinition 無法產生必填欄位或骨架（多半是缺少 snapshot）。", "請確認套件內的 StructureDefinition 含有 snapshot；IG Publisher 發布的 package.tgz 都會附上。可改看「元素」分頁的 differential。"],
  };
  const [status, zh, hint] = table[code] ?? [500, "讀取 Profile 時發生錯誤。", "請稍後再試；若持續發生，請查看 app 容器日誌。"];
  return { status, body: { error: message, code: code === "INVALID_ARGUMENT" ? "PROFILE_NO_SNAPSHOT" : `PROFILE_${code}`, message_zh: zh, hint_zh: hint, tool_error: e } };
}

function jsonValue(raw: unknown): Json {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return (raw as Json) || {};
}

// --------------------------------------------------------------------------- //
// Cache (identity + rows of an installed package version change only on reinstall)
// --------------------------------------------------------------------------- //

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 40;
const viewCache = new Map<string, { at: number; body: unknown }>();

function cacheGet(key: string): unknown | undefined {
  const hit = viewCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    viewCache.delete(key);
    return undefined;
  }
  viewCache.delete(key);
  viewCache.set(key, hit); // LRU touch
  return hit.body;
}

function cacheSet(key: string, body: unknown): void {
  viewCache.set(key, { at: Date.now(), body });
  while (viewCache.size > CACHE_MAX) viewCache.delete(viewCache.keys().next().value as string);
}

/** Test hook. */
export function clearProfileCache(): void {
  viewCache.clear();
}

// --------------------------------------------------------------------------- //
// Handlers
// --------------------------------------------------------------------------- //

type Params = Record<string, unknown>;

function param(p: Params, key: string, max = 500): string {
  const v = p[key];
  const s = Array.isArray(v) ? v[v.length - 1] : v;
  return (typeof s === "string" ? s : s === undefined || s === null ? "" : String(s)).trim().slice(0, max);
}

function bad(message: string, zh: string): ProfileApiResult {
  return { status: 400, body: { error: message, code: "INVALID_REQUEST", message_zh: zh, hint_zh: "請從 IG 套件庫開啟 Profile 頁面。" } };
}

interface Target {
  packageId: string;
  version: string;
  artifactId: string;
}

function target(p: Params): Target | ProfileApiResult {
  const t = { packageId: param(p, "package_id", 200), version: param(p, "version", 100), artifactId: param(p, "artifact_id", 300) };
  if (!t.packageId || !t.version || !t.artifactId) return bad("package_id, version and artifact_id are required", "缺少 package_id、version 或 artifact_id。");
  return t;
}

const SD_COLS = "package_id, package_version, artifact_id, canonical_url, title, name, kind, derivation, base_type, resource_type";

async function loadSd(q: ProfileQuery, t: Target): Promise<Json | null> {
  const r = await q(
    `SELECT ${SD_COLS}, raw_json FROM fhir.artifacts
      WHERE package_id = $1 AND package_version = $2 AND resource_type = 'StructureDefinition'
        AND (artifact_id = $3 OR canonical_url = $3)
      ORDER BY (artifact_id = $3) DESC LIMIT 1`,
    [t.packageId, t.version, t.artifactId],
  );
  return r.rows[0] ?? null;
}

const NOT_FOUND: ProfileApiResult = {
  status: 404,
  body: {
    error: "profile not found",
    code: "PROFILE_ARTIFACT_NOT_FOUND",
    message_zh: "這個 IG 版本內找不到這個 Profile（StructureDefinition）。",
    hint_zh: "連結可能已過期，或 IG 已被移除／更換版本；請回到 IG 套件庫重新選擇。",
  },
};

async function profileView(deps: ProfileApiDeps, t: Target): Promise<ProfileApiResult> {
  const key = `${t.packageId} ${t.version} ${t.artifactId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return { status: 200, body: cached };

  const row = await loadSd(deps.query, t);
  if (!row) return NOT_FOUND;
  const sd = jsonValue(row.raw_json);
  const canonical = str(row.canonical_url) ?? str(sd.url) ?? t.artifactId;
  const svc = await deps.service();

  // Identity + deps_missing exactly as fhir_get_profile reports them.
  const idEnv = parseEnvelope(await svc.getProfile(canonical, t.packageId, t.version));
  if (!idEnv.ok) return envelopeError(idEnv);

  const { rows, source, differentialCount } = buildElementRows(sd);
  const closure = await deps.closure(t.packageId, t.version);

  const resolveSd = async (url: string): Promise<Json | null> => {
    const r = await deps.query(
      `SELECT ${SD_COLS}, raw_json FROM fhir.artifacts WHERE canonical_url = $1 AND resource_type = 'StructureDefinition'`,
      [url],
    );
    const picked = pickLinks(r.rows, closure)[url];
    return picked ? (r.rows.find((x) => x.package_id === picked.package_id && x.package_version === picked.version) ?? null) : null;
  };
  const chain = await walkBaseChain(
    {
      canonical,
      artifact_id: str(row.artifact_id),
      package_id: t.packageId,
      version: t.version,
      title: str(row.title) ?? str(row.name),
      derivation: str(row.derivation) ?? str(sd.derivation),
      kind: str(row.kind) ?? str(sd.kind),
      baseDefinition: str(sd.baseDefinition),
    },
    resolveSd,
  );

  const canonicals = collectCanonicals(rows);
  const linkRows = canonicals.length
    ? (
        await deps.query(
          `SELECT package_id, package_version, artifact_id, canonical_url, title, name, kind, resource_type
             FROM fhir.artifacts WHERE canonical_url = ANY($1::text[])`,
          [canonicals],
        )
      ).rows
    : [];
  const links = pickLinks(linkRows, closure);

  // Profiles in any installed IG that name this one as their baseDefinition.
  const baseType = str(row.base_type) ?? str(sd.type);
  const derivedRows = baseType
    ? (
        await deps.query(
          `SELECT package_id, package_version, artifact_id, title, name, kind, derivation
             FROM fhir.artifacts
            WHERE resource_type = 'StructureDefinition' AND base_type = $1
              AND (raw_json->>'baseDefinition' = $2 OR raw_json->>'baseDefinition' LIKE $3)
            ORDER BY package_id, package_version DESC, artifact_id
            LIMIT 201`,
          [baseType, canonical, `${canonical.replace(/[\\%_]/g, (c) => `\\${c}`)}|%`],
        )
      ).rows
    : [];

  const exEnv = parseEnvelope(await svc.getProfileElements(canonical, t.packageId, t.version, "examples"));
  const examples = exEnv.ok ? (exEnv.data ?? { count: 0, examples: [] }) : { count: 0, examples: [] };

  const body = {
    target: { package_id: t.packageId, version: t.version, artifact_id: str(row.artifact_id) ?? t.artifactId },
    profile: idEnv.data,
    provenance: idEnv.provenance ?? null,
    warnings: idEnv.warnings ?? [],
    meta: sdMeta(sd),
    element_source: source,
    differential_count: differentialCount,
    elements: rows,
    base_chain: chain,
    derived: {
      truncated: derivedRows.length > 200,
      items: derivedRows.slice(0, 200).map((d) => ({
        package_id: String(d.package_id),
        version: String(d.package_version),
        artifact_id: String(d.artifact_id ?? ""),
        title: str(d.title) ?? str(d.name),
        kind: str(d.kind),
      })),
    },
    links,
    extension: extensionInfo(sd, rows),
    examples,
  };
  cacheSet(key, body);
  return { status: 200, body };
}

async function toolPassThrough(deps: ProfileApiDeps, t: Target, call: (svc: ProfileToolService, canonical: string) => Promise<string>): Promise<ProfileApiResult> {
  const row = await loadSd(deps.query, t);
  if (!row) return NOT_FOUND;
  const canonical = str(row.canonical_url) ?? t.artifactId;
  const env = parseEnvelope(await call(await deps.service(), canonical));
  if (!env.ok) return envelopeError(env);
  return { status: 200, body: env };
}

const PREFIX = "/admin/api/igs/profile";

/** Dispatch one request; null when the path is not ours. */
export async function handleIgProfileApi(deps: ProfileApiDeps, method: string, path: string, params: Params): Promise<ProfileApiResult | null> {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;
  const route = path.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
  if (!["", "required", "skeleton", "valueset", "example"].includes(route)) {
    return { status: 404, body: { error: `Unknown profile endpoint '${route}'` } };
  }
  if (method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
  try {
    if (route === "valueset") {
      const pid = param(params, "package_id", 200);
      const ver = param(params, "version", 100);
      const url = param(params, "url", 1000);
      if (!pid || !ver || !url) return bad("package_id, version and url are required", "缺少 package_id、version 或 url。");
      const limit = Math.max(1, Math.min(200, Number.parseInt(param(params, "limit"), 10) || 12));
      const env = parseEnvelope(await (await deps.service()).expandValueset(url, pid, ver, limit));
      return env.ok ? { status: 200, body: env } : envelopeError(env);
    }
    const t = target(params);
    if ("status" in t) return t;
    if (route === "") return await profileView(deps, t);
    if (route === "required") {
      const verbosity = param(params, "verbosity") === "full" ? "full" : "compact";
      const msRaw = param(params, "include_mustsupport");
      const ms = msRaw === "defaults" ? "defaults" : msRaw === "true";
      return await toolPassThrough(deps, t, (svc, c) => svc.getProfileRequiredElements(c, t.packageId, t.version, null, true, ms, verbosity));
    }
    if (route === "skeleton") {
      return await toolPassThrough(deps, t, (svc, c) => svc.getResourceSkeleton(c, t.packageId, t.version, 20, true));
    }
    // example
    const rt = param(params, "resource_type", 100);
    const r = await deps.query(
      `SELECT artifact_id, resource_type, raw_json FROM fhir.artifacts
        WHERE package_id = $1 AND package_version = $2 AND artifact_id = $3 AND ($4 = '' OR resource_type = $4)
        ORDER BY (grouping_id = 'examples') DESC LIMIT 1`,
      [t.packageId, t.version, t.artifactId, rt],
    );
    if (!r.rows[0]) return { ...NOT_FOUND, body: { ...(NOT_FOUND.body as Json), message_zh: "找不到這個範例資源。" } };
    return { status: 200, body: { artifact_id: r.rows[0].artifact_id, resource_type: r.rows[0].resource_type, resource: jsonValue(r.rows[0].raw_json) } };
  } catch (exc) {
    return { status: 500, body: { error: "Failed to read profile", detail: String((exc as Error).message) } };
  }
}

// --------------------------------------------------------------------------- //
// Production wiring
// --------------------------------------------------------------------------- //

let defaultDeps: ProfileApiDeps | null = null;

/**
 * Production collaborators: db.query, a FHIRIGService (no embedding service — none of the
 * reused methods searches semantically) and fhirIg's package closure. Lazily imported so
 * the pure helpers above load without a database.
 */
export async function defaultProfileApiDeps(): Promise<ProfileApiDeps> {
  if (defaultDeps) return defaultDeps;
  const [{ query }, { FHIRIGService }, fhirIg] = await Promise.all([import("../db.js"), import("../fhirIgService.js"), import("../fhirIg.js")]);
  let svc: ProfileToolService | null = null;
  defaultDeps = {
    query: (sql, params) => query(sql, params ?? []),
    service: async () => (svc ??= new FHIRIGService(null)),
    closure: (pid, ver) => fhirIg.packageClosure(pid, ver),
  };
  return defaultDeps;
}
