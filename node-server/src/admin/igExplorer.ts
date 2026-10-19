/**
 * IG explorer API for the admin IG detail page — read-only, behind the admin
 * session gate (mounted in adminApp.ts after the auth check).
 *
 *   GET /admin/api/ig-explorer/overview?package_id=&version=
 *       ImplementationGuide metadata, artifact composition by category,
 *       dependency tree, dependents, external code systems.
 *   GET /admin/api/ig-explorer/artifacts?package_id=&version=&category=&group=&q=&offset=&limit=
 *       One category's artifacts (or every category with `q`) with a per-type
 *       digest (profile element counts, extension context / value type,
 *       ValueSet compose summary, SearchParameter expression, example meta.profile…).
 *   GET /admin/api/ig-explorer/artifact?package_id=&version=&artifact_key=
 *       One artifact: digest, raw JSON (size-capped) and resolved canonical references.
 *   GET /admin/api/ig-explorer/codesystems?package_id=&version=
 *       CodeSystems with content mode, nested concept count / depth, designation
 *       languages, the ValueSets that use them and the supplements that target them.
 *   GET /admin/api/ig-explorer/codesystem/concepts?package_id=&version=&artifact_key=&q=&offset=&limit=
 *       Flat (pre-order) concept list with depth / parent, designations and
 *       supplement-provided names.
 *
 * Everything is scoped to one package *version* (several versions of an IG can
 * be installed side by side). Data functions take a `Q` so they can be tested
 * against a fake without Postgres. Search terms are never logged.
 */

import { canonicalDependencyVersion } from "../loaders/igRegistry.js";
import { buildCsIndex } from "./termViz/igCodeSystem.js";
import { intParam, likeEscape, num, str, TermVizError, VersionedCache, type Q, type Row } from "./termViz/common.js";

export type Params = Record<string, unknown>;

// ── Categories ───────────────────────────────────────────────────────────────

/** Display order of artifact categories. */
export const CATEGORIES = ["profile", "extension", "datatype", "logical", "terminology", "search", "capability", "example", "base"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Conformance resource types that are not shown as instances/examples. */
export const CAPABILITY_TYPES = [
  "CapabilityStatement",
  "OperationDefinition",
  "CompartmentDefinition",
  "MessageDefinition",
  "GraphDefinition",
  "ImplementationGuide",
  "StructureMap",
  "TerminologyCapabilities",
  "ExampleScenario",
] as const;
export const TERMINOLOGY_TYPES = ["ValueSet", "CodeSystem", "ConceptMap", "NamingSystem"] as const;

const sqlList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(", ");

/** Category of a `fhir.artifacts` row (alias `a`). Mirrors `categoryOf`. */
export const CATEGORY_SQL = `CASE
  WHEN a.resource_type = 'StructureDefinition' THEN
    CASE WHEN a.kind = 'logical' THEN 'logical'
         WHEN COALESCE(a.derivation, '') <> 'constraint' THEN 'base'
         WHEN COALESCE(NULLIF(a.raw_json->>'type', ''), a.base_type) = 'Extension' THEN 'extension'
         WHEN a.kind IN ('complex-type', 'primitive-type') THEN 'datatype'
         ELSE 'profile' END
  WHEN a.resource_type IN (${sqlList(TERMINOLOGY_TYPES)}) THEN 'terminology'
  WHEN a.resource_type = 'SearchParameter' THEN 'search'
  WHEN a.resource_type IN (${sqlList(CAPABILITY_TYPES)}) THEN 'capability'
  ELSE 'example' END`;

/** Pure mirror of CATEGORY_SQL (used by tests and for rows shaped in Node). */
export function categoryOf(r: { resource_type: string; kind?: string | null; derivation?: string | null; type?: string | null; base_type?: string | null }): Category {
  if (r.resource_type === "StructureDefinition") {
    if (r.kind === "logical") return "logical";
    if ((r.derivation ?? "") !== "constraint") return "base";
    if ((r.type || r.base_type) === "Extension") return "extension";
    if (r.kind === "complex-type" || r.kind === "primitive-type") return "datatype";
    return "profile";
  }
  if ((TERMINOLOGY_TYPES as readonly string[]).includes(r.resource_type)) return "terminology";
  if (r.resource_type === "SearchParameter") return "search";
  if ((CAPABILITY_TYPES as readonly string[]).includes(r.resource_type)) return "capability";
  return "example";
}

/** Group key inside a category (alias `x`, which carries `category`). */
const GROUP_SQL = `CASE x.category
  WHEN 'profile' THEN COALESCE(NULLIF(x.raw_json->>'type', ''), x.base_type, '')
  WHEN 'datatype' THEN COALESCE(NULLIF(x.raw_json->>'type', ''), x.base_type, '')
  WHEN 'extension' THEN CASE
      WHEN x.raw_json#>>'{context,0,type}' = 'extension' THEN 'Extension'
      ELSE regexp_replace(COALESCE(x.raw_json#>>'{context,0,expression}', ''), '[.:\\[].*$', '') END
  WHEN 'logical' THEN ''
  WHEN 'base' THEN COALESCE(x.kind, '')
  WHEN 'search' THEN COALESCE(x.raw_json#>>'{base,0}', '')
  ELSE x.resource_type END`;

/** `jsonb_array_elements` input guard: non-arrays become `[]` instead of raising. */
const arr = (expr: string): string => `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END`;
const pathCount = (expr: string, path: string): string => `jsonb_array_length(jsonb_path_query_array(${expr}, '${path}'))`;

/** Per-type summary of `y.raw_json` (computed only for the rows of one page). */
const DIGEST_SQL = `CASE
  WHEN y.resource_type = 'StructureDefinition' THEN jsonb_build_object(
    'type', y.raw_json->'type',
    'abstract', y.raw_json->'abstract',
    'base_definition', y.raw_json->'baseDefinition',
    'version', y.raw_json->'version',
    'context', y.raw_json->'context',
    'differential', ${pathCount("y.raw_json", "$.differential.element[*]")},
    'must_support', ${pathCount("y.raw_json", "$.differential.element[*] ? (@.mustSupport == true)")},
    'required', ${pathCount("y.raw_json", "$.differential.element[*] ? (@.min >= 1)")},
    'value_types_snapshot', jsonb_path_query_array(y.raw_json, '$.snapshot.element[*] ? (@.path == "Extension.value[x]" && @.max != "0").type[*].code'),
    'value_types_differential', jsonb_path_query_array(y.raw_json, '$.differential.element[*] ? (@.path == "Extension.value[x]" && @.max != "0").type[*].code'),
    'value_prohibited', jsonb_path_exists(y.raw_json, '$.differential.element[*] ? (@.path == "Extension.value[x]" && @.max == "0")'),
    'sub_extensions', jsonb_path_query_array(y.raw_json, '$.differential.element[*] ? (@.path == "Extension.extension" && exists(@.sliceName)).sliceName'))
  WHEN y.resource_type = 'ValueSet' THEN jsonb_build_object(
    'include', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'system', i->'system', 'version', i->'version',
        'concepts', ${pathCount("i", "$.concept[*]")},
        'filters', jsonb_path_query_array(i, '$.filter[*]'),
        'value_sets', i->'valueSet')), '[]'::jsonb)
      FROM jsonb_array_elements(${arr("y.raw_json#>'{compose,include}'")}) i),
    'exclude', ${pathCount("y.raw_json", "$.compose.exclude[*]")},
    'expansion_total', y.raw_json#>'{expansion,total}',
    'expansion_contains', ${pathCount("y.raw_json", "$.expansion.contains[*]")})
  WHEN y.resource_type = 'CodeSystem' THEN jsonb_build_object(
    'content', y.raw_json->'content', 'count', y.raw_json->'count',
    'hierarchy_meaning', y.raw_json->'hierarchyMeaning', 'supplements', y.raw_json->'supplements',
    'case_sensitive', y.raw_json->'caseSensitive', 'value_set', y.raw_json->'valueSet')
  WHEN y.resource_type = 'ConceptMap' THEN jsonb_build_object(
    'source', COALESCE(y.raw_json->'sourceUri', y.raw_json->'sourceCanonical'),
    'target', COALESCE(y.raw_json->'targetUri', y.raw_json->'targetCanonical'),
    'groups', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'source', g->'source', 'target', g->'target',
        'elements', ${pathCount("g", "$.element[*]")},
        'targets', ${pathCount("g", "$.element[*].target[*]")})), '[]'::jsonb)
      FROM jsonb_array_elements(${arr("y.raw_json->'group'")}) g))
  WHEN y.resource_type = 'SearchParameter' THEN jsonb_build_object(
    'code', y.raw_json->'code', 'type', y.raw_json->'type', 'base', y.raw_json->'base',
    'expression', to_jsonb(left(y.raw_json->>'expression', 600)),
    'target', y.raw_json->'target', 'derived_from', y.raw_json->'derivedFrom')
  WHEN y.resource_type = 'CapabilityStatement' THEN jsonb_build_object(
    'kind', y.raw_json->'kind', 'fhir_version', y.raw_json->'fhirVersion',
    'rest', (SELECT COALESCE(jsonb_agg(jsonb_build_object('mode', r->'mode', 'resources', ${pathCount("r", "$.resource[*]")})), '[]'::jsonb)
      FROM jsonb_array_elements(${arr("y.raw_json->'rest'")}) r))
  WHEN y.resource_type = 'OperationDefinition' THEN jsonb_build_object(
    'code', y.raw_json->'code', 'kind', y.raw_json->'kind', 'resource', y.raw_json->'resource',
    'system', y.raw_json->'system', 'type', y.raw_json->'type', 'instance', y.raw_json->'instance',
    'parameters', ${pathCount("y.raw_json", "$.parameter[*]")})
  WHEN y.resource_type = 'ImplementationGuide' THEN jsonb_build_object('package_id', y.raw_json->'packageId', 'fhir_version', y.raw_json->'fhirVersion')
  WHEN y.resource_type IN (${sqlList(TERMINOLOGY_TYPES)}) THEN '{}'::jsonb
  ELSE jsonb_build_object(
    'profiles', y.raw_json#>'{meta,profile}',
    'status', y.raw_json->'status',
    'coding', COALESCE(y.raw_json#>'{code,coding,0}', y.raw_json#>'{type,coding,0}', y.raw_json#>'{category,0,coding,0}'),
    'bundle_type', CASE WHEN y.resource_type = 'Bundle' THEN y.raw_json->'type' END,
    'entries', CASE WHEN y.resource_type = 'Bundle' THEN to_jsonb(${pathCount("y.raw_json", "$.entry[*]")}) END)
  END`;

/** Shared CTEs: x = package rows + category, y = x + group, claims = example meta.profile counts. */
const BASE_CTE = `WITH x AS (
    SELECT a.*, ${CATEGORY_SQL} AS category FROM fhir.artifacts a WHERE a.package_id = $1 AND a.package_version = $2
  ), y AS (
    SELECT x.*, ${GROUP_SQL} AS grp FROM x
  ), claims AS (
    SELECT split_part(p, '|', 1) AS url, COUNT(*)::int AS n
      FROM x, jsonb_array_elements_text(${arr("x.raw_json#>'{meta,profile}'")}) p
     WHERE x.category = 'example' GROUP BY 1
  )`;

const SEARCH_SQL = (n: number): string =>
  `(y.artifact_id ILIKE $${n} ESCAPE '\\' OR y.title ILIKE $${n} ESCAPE '\\' OR y.name ILIKE $${n} ESCAPE '\\' OR y.canonical_url ILIKE $${n} ESCAPE '\\' OR y.description ILIKE $${n} ESCAPE '\\' OR y.artifact_key ILIKE $${n} ESCAPE '\\')`;

// ── Pure shaping ─────────────────────────────────────────────────────────────

/** Last path segment of a canonical (`…/StructureDefinition/TWPatient` → `TWPatient`); keeps `|version` off. */
export function canonicalTail(url: string): string {
  const u = url.split("|")[0].replace(/\/+$/, "");
  const i = u.lastIndexOf("/");
  return i >= 0 ? u.slice(i + 1) : u;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === "string" && v ? [v] : []);
const nullableStr = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : str(v));
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const uniq = (xs: string[]): string[] => [...new Set(xs)];

export interface ArtifactItem {
  artifact_key: string;
  resource_type: string;
  artifact_id: string;
  canonical_url: string | null;
  title: string;
  name: string | null;
  status: string | null;
  description: string | null;
  category: Category;
  group: string;
  /** Examples in this package whose meta.profile claims this artifact (StructureDefinitions). */
  example_count: number;
  digest: Row;
}

/** Shape a raw SQL digest into the per-type summary the UI renders (pure). */
export function shapeDigest(resourceType: string, category: string, raw: unknown): Row {
  const d = obj(raw);
  if (resourceType === "StructureDefinition") {
    const type = str(d.type);
    const valueTypes = uniq(strs(d.value_types_snapshot).length ? strs(d.value_types_snapshot) : strs(d.value_types_differential));
    const contexts = (Array.isArray(d.context) ? d.context : []).map((c) => {
      const o = obj(c);
      return { type: str(o.type) || "element", expression: str(o.expression) };
    });
    const out: Row = {
      type: /^https?:\/\//.test(type) ? canonicalTail(type) : type,
      abstract: d.abstract === true,
      base_definition: nullableStr(d.base_definition),
      base_name: d.base_definition ? canonicalTail(str(d.base_definition)) : null,
      version: nullableStr(d.version),
      differential: num(d.differential),
      must_support: num(d.must_support),
      required: num(d.required),
    };
    if (category === "extension") {
      const subs = uniq(strs(d.sub_extensions));
      out.contexts = contexts;
      out.sub_extensions = subs;
      out.complex = subs.length > 0 || d.value_prohibited === true;
      out.value_types = out.complex ? [] : valueTypes;
    }
    return out;
  }
  if (resourceType === "ValueSet") {
    const include = (Array.isArray(d.include) ? d.include : []).map((i) => {
      const o = obj(i);
      return {
        system: nullableStr(o.system),
        version: nullableStr(o.version),
        concepts: num(o.concepts),
        filters: (Array.isArray(o.filters) ? o.filters : []).map((f) => {
          const fo = obj(f);
          return `${str(fo.property)} ${str(fo.op)} ${str(fo.value)}`.trim();
        }),
        value_sets: strs(o.value_sets),
      };
    });
    return {
      include,
      systems: uniq(include.map((i) => i.system).filter((s): s is string => Boolean(s))),
      enumerated: include.reduce((n, i) => n + i.concepts, 0),
      exclude: num(d.exclude),
      expansion_total: d.expansion_total === null || d.expansion_total === undefined ? null : num(d.expansion_total),
      expansion_contains: num(d.expansion_contains),
    };
  }
  if (resourceType === "CodeSystem") {
    return {
      content: nullableStr(d.content),
      count: d.count === null || d.count === undefined ? null : num(d.count),
      hierarchy_meaning: nullableStr(d.hierarchy_meaning),
      supplements: nullableStr(d.supplements),
      case_sensitive: typeof d.case_sensitive === "boolean" ? d.case_sensitive : null,
      value_set: nullableStr(d.value_set),
    };
  }
  if (resourceType === "ConceptMap") {
    const groups = (Array.isArray(d.groups) ? d.groups : []).map((g) => {
      const o = obj(g);
      return { source: nullableStr(o.source), target: nullableStr(o.target), elements: num(o.elements), targets: num(o.targets) };
    });
    return {
      source: nullableStr(d.source),
      target: nullableStr(d.target),
      groups,
      elements: groups.reduce((n, g) => n + g.elements, 0),
    };
  }
  if (resourceType === "SearchParameter") {
    return {
      code: nullableStr(d.code),
      type: nullableStr(d.type),
      base: strs(d.base),
      expression: nullableStr(d.expression),
      target: strs(d.target),
      derived_from: nullableStr(d.derived_from),
    };
  }
  if (resourceType === "CapabilityStatement") {
    return {
      kind: nullableStr(d.kind),
      fhir_version: nullableStr(d.fhir_version),
      rest: (Array.isArray(d.rest) ? d.rest : []).map((r) => ({ mode: str(obj(r).mode), resources: num(obj(r).resources) })),
    };
  }
  if (resourceType === "OperationDefinition") {
    return {
      code: nullableStr(d.code),
      kind: nullableStr(d.kind),
      resource: strs(d.resource),
      system: d.system === true,
      type: d.type === true,
      instance: d.instance === true,
      parameters: num(d.parameters),
    };
  }
  if (category === "example") {
    const coding = obj(d.coding);
    return {
      profiles: strs(d.profiles),
      status: nullableStr(d.status),
      coding: coding.code || coding.display ? { system: nullableStr(coding.system), code: nullableStr(coding.code), display: nullableStr(coding.display) } : null,
      bundle_type: nullableStr(d.bundle_type),
      entries: d.entries === null || d.entries === undefined ? null : num(d.entries),
    };
  }
  return d;
}

/**
 * The importer copies `name` / `title` of every resource into the columns, so an
 * example Patient's `name` is its HumanName list (Python repr). Only plain
 * strings are titles.
 */
function exampleSafe(category: string, v: unknown): string {
  const t = str(v);
  if (category !== "example") return t;
  return typeof v === "string" && !/^[[{]/.test(t.trim()) ? t : "";
}

/** One SQL row → API item (pure). */
export function shapeItem(r: Row): ArtifactItem {
  const category = (CATEGORIES as readonly string[]).includes(str(r.category)) ? (str(r.category) as Category) : "example";
  const rt = str(r.resource_type);
  return {
    artifact_key: str(r.artifact_key),
    resource_type: rt,
    artifact_id: str(r.artifact_id) || canonicalTail(str(r.artifact_key)),
    canonical_url: nullableStr(r.canonical_url),
    title: exampleSafe(category, r.title) || exampleSafe(category, r.name) || str(r.artifact_id) || str(r.artifact_key),
    name: category === "example" ? null : nullableStr(r.name),
    status: nullableStr(r.status),
    description: r.description ? str(r.description).slice(0, 400) : null,
    category,
    group: str(r.grp),
    example_count: num(r.example_count),
    digest: shapeDigest(rt, category, r.digest),
  };
}

export interface CategoryCount {
  key: Category;
  count: number;
  groups: { key: string; count: number }[];
}

/** `(category, group, n)` rows → ordered category list with groups by count (pure). */
export function shapeCategories(rows: Row[]): CategoryCount[] {
  const by = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const c = str(r.category);
    const m = by.get(c) ?? new Map<string, number>();
    m.set(str(r.grp), (m.get(str(r.grp)) ?? 0) + num(r.n));
    by.set(c, m);
  }
  return CATEGORIES.filter((c) => by.has(c)).map((c) => {
    const m = by.get(c)!;
    const groups = [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    return { key: c, count: groups.reduce((n, g) => n + g.count, 0), groups };
  });
}

/** Terminology modules / built-in tables that validate codes of an external system. */
export interface SystemSupport {
  /** Admin module key whose row count decides whether it is loaded (icd / loinc / snomed / rxnorm), or null. */
  module: string | null;
  /** Validated in-process without any import (UCUM, BCP-47, ISO 3166, CVX…). */
  builtin: boolean;
  label: string;
}

const SYSTEM_SUPPORT: [RegExp, SystemSupport][] = [
  [/^http:\/\/snomed\.info\/sct/, { module: "snomed", builtin: false, label: "SNOMED CT" }],
  [/^http:\/\/loinc\.org/, { module: "loinc", builtin: false, label: "LOINC" }],
  [/^http:\/\/hl7\.org\/fhir\/sid\/icd-10-cm$/, { module: "icd", builtin: false, label: "ICD-10-CM" }],
  [/^http:\/\/www\.cms\.gov\/Medicare\/Coding\/ICD10$/, { module: "icd", builtin: false, label: "ICD-10-PCS" }],
  [/^http:\/\/hl7\.org\/fhir\/sid\/icd-10$/, { module: "icd", builtin: false, label: "ICD-10 (WHO)" }],
  [/^http:\/\/www\.nlm\.nih\.gov\/research\/umls\/rxnorm$/, { module: "rxnorm", builtin: false, label: "RxNorm" }],
  [/^http:\/\/unitsofmeasure\.org$/, { module: null, builtin: true, label: "UCUM" }],
  [/^urn:ietf:bcp:47$/, { module: null, builtin: true, label: "BCP-47 語言" }],
  [/^urn:iso:std:iso:3166/, { module: null, builtin: true, label: "ISO 3166 國家" }],
  [/^http:\/\/hl7\.org\/fhir\/sid\/cvx$/, { module: null, builtin: true, label: "CVX 疫苗" }],
  [/^urn:ietf:bcp:13$/, { module: null, builtin: true, label: "MIME types" }],
];

/** Which module (if any) can validate codes of an external code system (pure). */
export function systemSupport(url: string): SystemSupport | null {
  for (const [re, s] of SYSTEM_SUPPORT) if (re.test(url)) return s;
  return null;
}

export interface PackageNode {
  package_id: string;
  version: string;
  /** Declared version when it was aliased (core 4.0.0 → 4.0.1). */
  declared_version?: string;
  title: string | null;
  installed: boolean;
  /** Already shown higher up (or a cycle): children are omitted. */
  repeated: boolean;
  children: PackageNode[];
}

export interface InstalledPackage {
  package_id: string;
  version: string;
  title: string | null;
  dependencies: Record<string, string>;
}

/** Parse `fhir.ig_packages.dependencies` (jsonb object or JSON text) (pure). */
export function parseDeps(v: unknown): Record<string, string> {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  if (x && typeof x === "object" && !Array.isArray(x)) for (const [k, val] of Object.entries(x as Row)) out[k] = str(val);
  return out;
}

/**
 * Declared dependency tree of one package (pure). A package reached a second
 * time is marked `repeated` and not expanded again, so the tree stays finite
 * and small even for hub packages (hl7.terminology / core everywhere).
 */
export function buildDependencyTree(packages: InstalledPackage[], rootId: string, rootVersion: string, maxDepth = 6): PackageNode {
  const by = new Map(packages.map((p) => [`${p.package_id}@${p.version}`, p]));
  const make = (pid: string, ver: string, declared: string | undefined, repeated: boolean): PackageNode => ({
    package_id: pid,
    version: ver,
    ...(declared && declared !== ver ? { declared_version: declared } : {}),
    title: by.get(`${pid}@${ver}`)?.title ?? null,
    installed: by.has(`${pid}@${ver}`),
    repeated,
    children: [],
  });
  // Breadth-first, so a package is expanded at its shallowest position (a direct
  // dependency is never shown as "repeated" because a sibling also needs it).
  const root = make(rootId, rootVersion, undefined, false);
  const seen = new Set<string>([`${rootId}@${rootVersion}`]);
  const queue: [PackageNode, number][] = [[root, 0]];
  while (queue.length) {
    const [node, depth] = queue.shift()!;
    const p = by.get(`${node.package_id}@${node.version}`);
    if (!p || node.repeated || depth >= maxDepth) continue;
    node.children = Object.entries(p.dependencies)
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([depId, depVer]) => {
        const ver = canonicalDependencyVersion(depId, depVer);
        const k = `${depId}@${ver}`;
        const child = make(depId, ver, depVer, seen.has(k));
        seen.add(k);
        return child;
      });
    for (const c of node.children) queue.push([c, depth + 1]);
  }
  return root;
}

/** Flatten a dependency tree to its unique packages (excluding the root) (pure). */
export function closureOf(tree: PackageNode): { package_id: string; version: string; installed: boolean; depth: number }[] {
  const out = new Map<string, { package_id: string; version: string; installed: boolean; depth: number }>();
  const walk = (n: PackageNode, depth: number): void => {
    for (const c of n.children) {
      const k = `${c.package_id}@${c.version}`;
      const prev = out.get(k);
      if (!prev || prev.depth > depth + 1) out.set(k, { package_id: c.package_id, version: c.version, installed: c.installed, depth: depth + 1 });
      walk(c, depth + 1);
    }
  };
  walk(tree, 0);
  return [...out.values()].sort((a, b) => a.depth - b.depth || a.package_id.localeCompare(b.package_id));
}

/** Installed packages that declare `pid@ver` directly (aliases applied) (pure). */
export function directDependentsOf(packages: InstalledPackage[], pid: string, ver: string): { package_id: string; version: string; title: string | null }[] {
  return packages
    .filter((p) => !(p.package_id === pid && p.version === ver))
    .filter((p) => Object.entries(p.dependencies).some(([d, v]) => d === pid && canonicalDependencyVersion(d, v) === ver))
    .map((p) => ({ package_id: p.package_id, version: p.version, title: p.title }))
    .sort((a, b) => a.package_id.localeCompare(b.package_id) || a.version.localeCompare(b.version));
}

/**
 * Best defining package per CodeSystem canonical (pure): a package in the IG's
 * dependency closure first, then content = complete, then the most concepts.
 */
export function pickDefinitions(rows: Row[], closure: Set<string>): Map<string, Row> {
  const rank = (r: Row): number[] => [
    closure.has(`${str(r.package_id)}@${str(r.package_version)}`) ? 0 : 1,
    str(r.content) === "complete" ? 0 : 1,
    -num(r.concept_count),
  ];
  const better = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  const best = new Map<string, { row: Row; rank: number[] }>();
  for (const r of rows) {
    const url = str(r.canonical_url);
    const k = rank(r);
    const cur = best.get(url);
    if (!cur || better(k, cur.rank)) best.set(url, { row: r, rank: k });
  }
  return new Map(
    [...best.entries()].map(([url, { row, rank: k }]) => [
      url,
      { package_id: str(row.package_id), version: str(row.package_version), content: nullableStr(row.content), concept_count: num(row.concept_count), in_closure: k[0] === 0 },
    ]),
  );
}

// ── Flat concept list ────────────────────────────────────────────────────────

export interface FlatConcept {
  code: string;
  display: string | null;
  definition: string | null;
  depth: number;
  parent: string | null;
  child_count: number;
  designations: { language: string | null; use: string | null; value: string }[];
  properties: { code: string; value: string }[];
}

/** Pre-order flattening of a CodeSystem's nested concepts (pure). */
export function flattenConcepts(resource: Row): FlatConcept[] {
  const idx = buildCsIndex(resource);
  const out: FlatConcept[] = [];
  const walk = (parent: string, depth: number): void => {
    for (const code of idx.children.get(parent) ?? []) {
      const n = idx.nodes.get(code);
      if (!n) continue;
      out.push({
        code: n.code,
        display: n.display,
        definition: n.definition,
        depth,
        parent: parent || null,
        child_count: n.child_count,
        designations: n.designations,
        properties: n.properties,
      });
      walk(code, depth + 1);
    }
  };
  walk("", 1);
  return out;
}

/** Case-insensitive match on code, display and designation values (pure). */
export function conceptMatches(c: FlatConcept, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [c.code, c.display ?? "", ...c.designations.map((d) => d.value)].some((s) => s.toLowerCase().includes(t));
}

// ── Data functions ───────────────────────────────────────────────────────────

interface Pkg {
  package_id: string;
  version: string;
}

async function requirePackage(q: Q, p: Params): Promise<Pkg & { imported_at: string }> {
  const package_id = param(p, "package_id");
  const version = param(p, "version");
  if (!package_id || !version) throw new TermVizError(400, "package_id and version are required");
  const r = await q("SELECT package_id, version, imported_at::text AS imported_at FROM fhir.ig_packages WHERE package_id = $1 AND version = $2", [package_id, version]);
  if (!r.rows[0]) throw new TermVizError(404, `IG ${package_id}@${version} is not installed`);
  return { package_id, version, imported_at: str(r.rows[0].imported_at) };
}

function param(p: Params, key: string): string {
  const v = p[key];
  return (Array.isArray(v) ? str(v[v.length - 1]) : str(v)).slice(0, 300);
}

// Keyed by imported_at, so a re-import invalidates it; the first VSAC overview takes seconds.
const overviewCache = new VersionedCache<Row>(60 * 60_000, 24);

export async function overview(q: Q, p: Params): Promise<Row> {
  const pkg = await requirePackage(q, p);
  return overviewCache.get(`${pkg.package_id}@${pkg.version}`, pkg.imported_at, async () => {
    const args = [pkg.package_id, pkg.version];
    const [igRes, catRes, profRes, sysRes, localCs, pkgRes] = await Promise.all([
      q(
        `SELECT jsonb_build_object(
            'url', raw_json->'url', 'version', raw_json->'version', 'name', raw_json->'name', 'title', raw_json->'title',
            'status', raw_json->'status', 'date', raw_json->'date', 'publisher', raw_json->'publisher',
            'license', raw_json->'license', 'copyright', to_jsonb(left(raw_json->>'copyright', 2000)),
            'description', to_jsonb(left(raw_json->>'description', 4000)), 'fhir_version', raw_json->'fhirVersion',
            'package_id', raw_json->'packageId',
            'jurisdiction', jsonb_path_query_array(raw_json, '$.jurisdiction[*].coding[*]'),
            'contact', jsonb_path_query_array(raw_json, '$.contact[*].name'),
            'pages', jsonb_path_query_array(raw_json, '$.definition.page.page[*].title')) AS ig
           FROM fhir.artifacts
          WHERE package_id = $1 AND package_version = $2 AND resource_type = 'ImplementationGuide'
          ORDER BY (raw_json->>'packageId' = $1) DESC NULLS LAST, artifact_key LIMIT 1`,
        args,
      ),
      q(`${BASE_CTE} SELECT category, grp, COUNT(*)::int AS n FROM y GROUP BY 1, 2`, args),
      q(
        `${BASE_CTE} SELECT COUNT(*) FILTER (WHERE y.category IN ('profile', 'datatype', 'extension'))::int AS total,
                COUNT(*) FILTER (WHERE y.category IN ('profile', 'datatype', 'extension') AND c.n > 0)::int AS with_examples,
                (SELECT COUNT(*)::int FROM y WHERE y.category = 'example'
                   AND jsonb_typeof(y.raw_json#>'{meta,profile}') = 'array') AS examples_claiming
           FROM y LEFT JOIN claims c ON c.url = y.canonical_url`,
        args,
      ),
      q(
        `SELECT s AS system, COUNT(DISTINCT a.artifact_key)::int AS n
           FROM fhir.artifacts a, jsonb_array_elements_text(jsonb_path_query_array(a.raw_json, '$.compose.include[*].system')) s
          WHERE a.package_id = $1 AND a.package_version = $2 AND a.resource_type = 'ValueSet'
          GROUP BY 1 ORDER BY 2 DESC, 1`,
        args,
      ),
      q(`SELECT canonical_url FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND resource_type = 'CodeSystem'`, args),
      q(`SELECT package_id, version, title, dependencies FROM fhir.ig_packages`),
    ]);
    const local = new Set(localCs.rows.map((r) => str(r.canonical_url)).filter(Boolean));
    const external = sysRes.rows.map((r) => ({ system: str(r.system), valuesets: num(r.n) })).filter((s) => s.system && !local.has(s.system));
    const packages: InstalledPackage[] = pkgRes.rows.map((r) => ({ package_id: str(r.package_id), version: str(r.version), title: nullableStr(r.title), dependencies: parseDeps(r.dependencies) }));
    const tree = buildDependencyTree(packages, pkg.package_id, pkg.version);
    const closure = closureOf(tree);
    // Where (which installed package) an external system is defined as a CodeSystem; the IG's own closure wins.
    const definedIn = new Map<string, Row>();
    if (external.length) {
      const d = await q(
        `SELECT canonical_url, package_id, package_version, raw_json->>'content' AS content, concept_count
           FROM fhir.artifacts WHERE resource_type = 'CodeSystem' AND canonical_url = ANY($1::text[])`,
        [external.map((e) => e.system)],
      );
      for (const [url, best] of pickDefinitions(d.rows, new Set(closure.map((c) => `${c.package_id}@${c.version}`)))) definedIn.set(url, best);
    }
    const categories = shapeCategories(catRes.rows);
    const prof = profRes.rows[0] ?? {};
    return {
      package_id: pkg.package_id,
      version: pkg.version,
      ig: igRes.rows[0]?.ig ?? null,
      total: categories.reduce((n, c) => n + c.count, 0),
      categories,
      example_coverage: { definitions: num(prof.total), with_examples: num(prof.with_examples), examples_claiming: num(prof.examples_claiming) },
      external_systems: external.map((e) => ({ ...e, support: systemSupport(e.system), defined_in: definedIn.get(e.system) ?? null })),
      dependency_tree: tree,
      closure,
      dependents: directDependentsOf(packages, pkg.package_id, pkg.version),
    };
  });
}

export async function artifacts(q: Q, p: Params): Promise<Row> {
  const pkg = await requirePackage(q, p);
  const category = param(p, "category");
  if (category && !(CATEGORIES as readonly string[]).includes(category)) throw new TermVizError(400, `Unknown category '${category}'`);
  const hasGroup = p.group !== undefined && p.group !== null;
  const group = param(p, "group");
  const text = param(p, "q").trim();
  const offset = intParam(p.offset, 0, 0, 1_000_000);
  const limit = intParam(p.limit, 200, 1, 1000);
  const args: unknown[] = [pkg.package_id, pkg.version];
  let where = "TRUE";
  if (text) {
    args.push(`%${likeEscape(text)}%`);
    where = SEARCH_SQL(args.length);
  }
  const facetRes = await q(`${BASE_CTE} SELECT category, grp, COUNT(*)::int AS n FROM y WHERE ${where} GROUP BY 1, 2`, args);
  const facets = shapeCategories(facetRes.rows);
  let filter = where;
  if (category) {
    args.push(category);
    filter += ` AND y.category = $${args.length}`;
  }
  if (hasGroup && category) {
    args.push(group);
    filter += ` AND y.grp = $${args.length}`;
  }
  const cat = category ? facets.find((c) => c.key === category) : null;
  const total = !category ? facets.reduce((n, c) => n + c.count, 0) : hasGroup ? (cat?.groups.find((g) => g.key === group)?.count ?? 0) : (cat?.count ?? 0);
  args.push(limit, offset);
  const rows = await q(
    `${BASE_CTE}
     SELECT y.artifact_key, y.resource_type, y.artifact_id, y.canonical_url, y.title, y.name, y.status, left(y.description, 400) AS description,
            y.category, y.grp, COALESCE(c.n, 0) AS example_count, ${DIGEST_SQL} AS digest
       FROM y LEFT JOIN claims c ON c.url = y.canonical_url AND y.resource_type = 'StructureDefinition'
      WHERE ${filter}
      ORDER BY array_position(ARRAY[${sqlList(CATEGORIES)}]::text[], y.category),
               array_position(ARRAY['ValueSet', 'CodeSystem', 'ConceptMap']::text[], y.grp) NULLS LAST, y.grp,
               lower(COALESCE(NULLIF(y.title, ''), NULLIF(y.name, ''), y.artifact_id, y.artifact_key))
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );
  const items = rows.rows.map(shapeItem);
  // Profiles claimed by examples (meta.profile), so the list can link them.
  const claimed = uniq(items.flatMap((i) => (i.category === "example" ? strs(i.digest.profiles).map((u) => u.split("|")[0]) : [])));
  const resolved = await resolveCanonicals(q, claimed, pkg);
  return { total, offset, limit, facets, groups: cat?.groups ?? [], items, resolved };
}

/** Installed artifacts for canonical URLs, preferring this package version, then this package. */
async function resolveCanonicals(q: Q, urls: string[], pkg: Pkg): Promise<Record<string, Row>> {
  const resolved: Record<string, Row> = {};
  if (!urls.length) return resolved;
  const rr = await q(
    `SELECT DISTINCT ON (canonical_url) canonical_url, package_id, package_version, artifact_key, artifact_id, resource_type,
            COALESCE(NULLIF(title, ''), NULLIF(name, ''), artifact_id) AS title
       FROM fhir.artifacts WHERE canonical_url = ANY($1::text[])
      ORDER BY canonical_url, (package_id = $2 AND package_version = $3) DESC, (package_id = $2) DESC, package_id, package_version DESC`,
    [urls, pkg.package_id, pkg.version],
  );
  for (const x of rr.rows) {
    resolved[str(x.canonical_url)] = {
      package_id: str(x.package_id),
      version: str(x.package_version),
      artifact_key: str(x.artifact_key),
      artifact_id: str(x.artifact_id),
      resource_type: str(x.resource_type),
      title: str(x.title),
      same_package: str(x.package_id) === pkg.package_id && str(x.package_version) === pkg.version,
    };
  }
  return resolved;
}

const RAW_LIMIT = 1_500_000; // pg_column_size bytes; bigger resources are not shipped to the browser

export async function artifact(q: Q, p: Params): Promise<Row> {
  const pkg = await requirePackage(q, p);
  const key = param(p, "artifact_key");
  if (!key) throw new TermVizError(400, "artifact_key is required");
  const r = await q(
    `${BASE_CTE}
     SELECT y.artifact_key, y.resource_type, y.artifact_id, y.canonical_url, y.title, y.name, y.status, y.description, y.package_path,
            y.category, y.grp, COALESCE(c.n, 0) AS example_count, ${DIGEST_SQL} AS digest,
            pg_column_size(y.raw_json)::int AS size,
            CASE WHEN pg_column_size(y.raw_json) <= ${RAW_LIMIT} THEN y.raw_json END AS raw_json
       FROM y LEFT JOIN claims c ON c.url = y.canonical_url AND y.resource_type = 'StructureDefinition'
      WHERE y.artifact_key = $3`,
    [pkg.package_id, pkg.version, key],
  );
  const row = r.rows[0];
  if (!row) throw new TermVizError(404, `Artifact ${key} not found in ${pkg.package_id}@${pkg.version}`);
  const item = shapeItem(row);
  const d = item.digest;
  const refs = uniq(
    [
      ...strs(d.profiles),
      str(d.base_definition),
      str(d.supplements),
      str(d.value_set),
      str(d.source),
      str(d.target),
      ...(Array.isArray(d.include) ? (d.include as Row[]).flatMap((i) => [str(i.system), ...strs(i.value_sets)]) : []),
      ...(Array.isArray(d.groups) ? (d.groups as Row[]).flatMap((g) => [str(g.source), str(g.target)]) : []),
    ]
      .map((u) => u.split("|")[0])
      .filter(Boolean),
  );
  const resolved = await resolveCanonicals(q, refs, pkg);
  return {
    ...item,
    package_path: nullableStr(row.package_path),
    description: nullableStr(row.description),
    size: num(row.size),
    raw_json: row.raw_json ?? null,
    raw_truncated: row.raw_json === null || row.raw_json === undefined,
    resolved,
  };
}

/** Concept count and nesting depth from per-level code counts (levels 1..6) (pure). */
export function levelStats(levels: number[]): { total: number; depth: number; deeper: boolean } {
  let depth = 0;
  levels.forEach((n, i) => {
    if (n > 0) depth = i + 1;
  });
  return { total: levels.reduce((a, b) => a + b, 0), depth, deeper: levels.length > 0 && levels[levels.length - 1] > 0 };
}

const LEVELS = 6;
const levelSql = (n: number): string => `jsonb_array_length(jsonb_path_query_array(x.raw_json, '$${".concept[*]".repeat(n)}.code'))`;

/** CodeSystem supplements shipped inside installed packages (`content = supplement`). */
export interface ShippedSupplement {
  package_id: string;
  version: string;
  artifact_key: string;
  target: string;
  url: string;
  cs_version: string | null;
  title: string;
  concept_count: number;
  source: string;
}

const shippedCache = new VersionedCache<ShippedSupplement[]>(10 * 60_000, 1);

/** Scans every installed CodeSystem once (~0.7 s on production), so it is cached per package-set signature. */
async function packageSupplements(q: Q): Promise<ShippedSupplement[]> {
  const sig = await q("SELECT COUNT(*)::text || '|' || COALESCE(MAX(imported_at)::text, '') AS sig FROM fhir.ig_packages");
  return shippedCache.get("all", str(sig.rows[0]?.sig), async () => {
    const r = await q(
      `SELECT package_id, package_version, artifact_key, split_part(raw_json->>'supplements', '|', 1) AS target, canonical_url,
              raw_json->>'version' AS cs_version, COALESCE(NULLIF(title, ''), name, canonical_url) AS title,
              ${pathCount("raw_json", "$.concept[*]")} AS n
         FROM fhir.artifacts WHERE resource_type = 'CodeSystem' AND raw_json->>'content' = 'supplement'`,
    );
    return r.rows.map((x) => ({
      package_id: str(x.package_id),
      version: str(x.package_version),
      artifact_key: str(x.artifact_key),
      target: str(x.target),
      url: str(x.canonical_url),
      cs_version: nullableStr(x.cs_version),
      title: str(x.title),
      concept_count: num(x.n),
      source: `package:${str(x.package_id)}@${str(x.package_version)}`,
    }));
  });
}

export async function codesystems(q: Q, p: Params): Promise<Row> {
  const pkg = await requirePackage(q, p);
  const args = [pkg.package_id, pkg.version];
  const [cs, usedBy, uploaded, shipped] = await Promise.all([
    q(
      `SELECT x.artifact_key, x.artifact_id, x.canonical_url, x.title, x.name, x.status, x.concept_count,
              x.raw_json->>'content' AS content, x.raw_json->'count' AS declared, x.raw_json->>'hierarchyMeaning' AS hierarchy_meaning,
              x.raw_json->>'supplements' AS supplements, x.raw_json->>'version' AS cs_version, x.raw_json->>'language' AS language,
              x.raw_json->>'caseSensitive' AS case_sensitive, pg_column_size(x.raw_json)::int AS size,
              ${Array.from({ length: LEVELS }, (_, i) => `${levelSql(i + 1)} AS l${i + 1}`).join(", ")},
              CASE WHEN pg_column_size(x.raw_json) <= 3000000 THEN
                (SELECT COALESCE(jsonb_agg(DISTINCT l), '[]'::jsonb) FROM jsonb_array_elements_text(
                   jsonb_path_query_array(x.raw_json, '$.concept.**.designation.language')) l)
              END AS languages,
              ${pathCount("x.raw_json", "$.property[*]")} AS properties
         FROM fhir.artifacts x
        WHERE x.package_id = $1 AND x.package_version = $2 AND x.resource_type = 'CodeSystem'
        ORDER BY lower(COALESCE(NULLIF(x.title, ''), NULLIF(x.name, ''), x.artifact_id))`,
      args,
    ),
    q(
      `SELECT s AS system, jsonb_agg(jsonb_build_object('artifact_key', v.artifact_key, 'title', COALESCE(NULLIF(v.title, ''), NULLIF(v.name, ''), v.artifact_id)) ORDER BY v.artifact_key) AS vs
         FROM fhir.artifacts v, jsonb_array_elements_text(jsonb_path_query_array(v.raw_json, '$.compose.include[*].system')) s
        WHERE v.package_id = $1 AND v.package_version = $2 AND v.resource_type = 'ValueSet'
        GROUP BY 1`,
      args,
    ),
    q(
      `SELECT split_part(supplements, '|', 1) AS target, url, version, COALESCE(title, name, url) AS title, concept_count,
              CASE WHEN uploaded_by = 'system:bundled' THEN 'bundled' ELSE 'uploaded' END AS source
         FROM fhir.codesystem_supplements`,
    ),
    packageSupplements(q),
  ]);
  const used = new Map(usedBy.rows.map((r) => [str(r.system), (Array.isArray(r.vs) ? r.vs : []) as Row[]]));
  const supByTarget = new Map<string, Row[]>();
  for (const s of [...uploaded.rows, ...(shipped as unknown as Row[])]) {
    const t = str(s.target);
    if (!t) continue;
    const list = supByTarget.get(t) ?? [];
    list.push({ url: str(s.url), version: nullableStr(s.version ?? s.cs_version), title: str(s.title), concept_count: num(s.concept_count), source: str(s.source) });
    supByTarget.set(t, list);
  }
  return {
    items: cs.rows.map((r) => {
      const stats = levelStats(Array.from({ length: LEVELS }, (_, i) => num(r[`l${i + 1}`])));
      const url = str(r.canonical_url);
      return {
        artifact_key: str(r.artifact_key),
        cs_id: str(r.artifact_id),
        url: url || null,
        title: str(r.title) || str(r.name) || str(r.artifact_id),
        name: nullableStr(r.name),
        status: nullableStr(r.status),
        cs_version: nullableStr(r.cs_version),
        content: nullableStr(r.content),
        declared_count: r.declared === null || r.declared === undefined ? null : num(r.declared),
        // Nested count from the resource; fhir.concepts keeps top-level rows only.
        concept_count: Math.max(stats.total, num(r.concept_count)),
        depth: stats.depth,
        depth_more: stats.deeper,
        hierarchy_meaning: nullableStr(r.hierarchy_meaning),
        case_sensitive: r.case_sensitive === null || r.case_sensitive === undefined ? null : str(r.case_sensitive) === "true",
        language: nullableStr(r.language),
        languages: Array.isArray(r.languages) ? (r.languages as unknown[]).map(str) : [],
        property_count: num(r.properties),
        supplements: nullableStr(r.supplements),
        used_by: url ? (used.get(url) ?? []) : [],
        supplemented_by: url ? (supByTarget.get(url) ?? []) : [],
        size: num(r.size),
      };
    }),
  };
}

const flatCache = new VersionedCache<{ url: string; concepts: FlatConcept[]; flatMode: boolean }>(10 * 60_000, 12);
const FLAT_RAW_LIMIT = 3 * 1024 * 1024;

export async function codesystemConcepts(q: Q, p: Params): Promise<Row> {
  const pkg = await requirePackage(q, p);
  const key = param(p, "artifact_key");
  if (!key) throw new TermVizError(400, "artifact_key is required");
  const text = param(p, "q");
  const offset = intParam(p.offset, 0, 0, 10_000_000);
  const limit = intParam(p.limit, 100, 1, 500);
  const head = await q(
    `SELECT canonical_url, artifact_id, imported_at::text AS imported, pg_column_size(raw_json)::int AS size
       FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND artifact_key = $3 AND resource_type = 'CodeSystem'`,
    [pkg.package_id, pkg.version, key],
  );
  const h = head.rows[0];
  if (!h) throw new TermVizError(404, `CodeSystem ${key} not found in ${pkg.package_id}@${pkg.version}`);
  const data = await flatCache.get(`${pkg.package_id}@${pkg.version}|${key}`, str(h.imported), async () => {
    if (num(h.size) <= FLAT_RAW_LIMIT) {
      const r = await q("SELECT raw_json FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND artifact_key = $3", [pkg.package_id, pkg.version, key]);
      return { url: str(h.canonical_url), concepts: flattenConcepts(obj(r.rows[0]?.raw_json)), flatMode: false };
    }
    // Very large (flat in practice): top-level rows from fhir.concepts.
    const r = await q("SELECT code, display, definition FROM fhir.concepts WHERE package_id = $1 AND package_version = $2 AND cs_id = $3 ORDER BY id", [
      pkg.package_id,
      pkg.version,
      str(h.artifact_id) || key.replace(/^CodeSystem\//, ""),
    ]);
    return {
      url: str(h.canonical_url),
      flatMode: true,
      concepts: r.rows.map((x) => ({ code: str(x.code), display: nullableStr(x.display), definition: nullableStr(x.definition), depth: 1, parent: null, child_count: 0, designations: [], properties: [] })),
    };
  });
  const matched = text.trim() ? data.concepts.filter((c) => conceptMatches(c, text)) : data.concepts;
  const page = matched.slice(offset, offset + limit);
  // Names / properties other CodeSystems add to these codes (`content = supplement`).
  const supplementByCode = new Map<string, Row[]>();
  if (data.url && page.length) {
    const shipped = (await packageSupplements(q)).filter((x) => x.target === data.url);
    const args: unknown[] = [data.url, page.map((c) => c.code)];
    let shippedSql = "";
    if (shipped.length) {
      args.push(shipped.map((x) => `${x.package_id}\t${x.version}\t${x.artifact_key}`));
      shippedSql = `UNION ALL
               SELECT COALESCE(NULLIF(title, ''), name, canonical_url), 'package:' || package_id || '@' || package_version, raw_json FROM fhir.artifacts
                WHERE package_id || E'\\t' || package_version || E'\\t' || artifact_key = ANY($3::text[])`;
    }
    const s = await q(
      `SELECT src.title, src.source, c->>'code' AS code, c->'designation' AS designation, c->'property' AS property
         FROM (SELECT COALESCE(title, name, url) AS title, CASE WHEN uploaded_by = 'system:bundled' THEN 'bundled' ELSE 'uploaded' END AS source, raw_json
                 FROM fhir.codesystem_supplements WHERE split_part(supplements, '|', 1) = $1
               ${shippedSql}) src,
              jsonb_array_elements(${arr("src.raw_json->'concept'")}) c
        WHERE c->>'code' = ANY($2::text[])`,
      args,
    );
    for (const r of s.rows) {
      const designations = (Array.isArray(r.designation) ? (r.designation as Row[]) : []).map((d) => ({
        language: nullableStr(d.language),
        use: d.use ? str(obj(d.use).display ?? obj(d.use).code) : null,
        value: str(d.value),
      }));
      const properties = (Array.isArray(r.property) ? (r.property as Row[]) : []).map((pr) => {
        const v = Object.entries(pr).find(([k]) => k.startsWith("value"))?.[1];
        const vo = obj(v);
        return { code: str(pr.code), value: v && typeof v === "object" ? str(vo.display ?? vo.code ?? JSON.stringify(v)) : str(v) };
      });
      if (!designations.length && !properties.length) continue;
      const list = supplementByCode.get(str(r.code)) ?? [];
      list.push({ title: str(r.title), source: str(r.source), designations, properties });
      supplementByCode.set(str(r.code), list);
    }
  }
  return {
    total: matched.length,
    all: data.concepts.length,
    offset,
    limit,
    flat_mode: data.flatMode,
    items: page.map((c) => ({ ...c, supplements: supplementByCode.get(c.code) ?? [] })),
  };
}

// ── Router ───────────────────────────────────────────────────────────────────

type Handler = (q: Q, p: Params) => Promise<unknown>;

export const ROUTES: Record<string, Handler> = {
  overview,
  artifacts,
  artifact,
  codesystems,
  "codesystem/concepts": codesystemConcepts,
};

const PREFIX = "/admin/api/ig-explorer/";

/** Dispatch one request; null when the path is not ours. Errors map to 4xx/5xx without echoing params. */
export async function handleIgExplorerApi(q: Q, method: string, path: string, params: Params): Promise<{ status: number; body: unknown } | null> {
  if (!path.startsWith(PREFIX)) return null;
  const route = path.slice(PREFIX.length).replace(/\/+$/, "");
  const handler = ROUTES[route];
  if (!handler) return { status: 404, body: { error: `Unknown IG explorer endpoint '${route}'` } };
  if (method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
  try {
    return { status: 200, body: await handler(q, params) };
  } catch (exc) {
    if (exc instanceof TermVizError) return { status: exc.status, body: { error: exc.message } };
    return { status: 500, body: { error: "ig_explorer_query_failed", detail: String((exc as Error).message) } };
  }
}
