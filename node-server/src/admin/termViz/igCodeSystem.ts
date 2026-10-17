/**
 * FHIR IG CodeSystem explorer: the nested `concept.concept` tree of a
 * CodeSystem stored in `fhir.artifacts.raw_json`, with properties,
 * designations, hierarchyMeaning and a completeness verdict (content code,
 * `count`, and other installed versions of the same CodeSystem — TW Core 1.0.0
 * ships e.g. icd-10-cm-2014-tw with 5 of the 91,737 concepts 0.3.2 had).
 *
 * `fhir.concepts` only keeps top-level concepts, so the tree is built from the
 * resource JSON. Very large CodeSystems are flat in practice; above
 * RAW_JSON_LIMIT bytes they are paged straight from `fhir.concepts` instead of
 * parsing tens of megabytes per request.
 */

import { likeEscape, num, str, TermVizError, VersionedCache, type Q, type Row } from "./common.js";

const RAW_JSON_LIMIT = 3 * 1024 * 1024; // compressed (pg_column_size) bytes

export interface CsNode {
  code: string;
  display: string | null;
  definition: string | null;
  designations: { language: string | null; use: string | null; value: string }[];
  properties: { code: string; value: string }[];
  child_count: number;
  descendant_count: number;
}

export interface CsIndex {
  nodes: Map<string, CsNode>;
  children: Map<string, string[]>;
  parent: Map<string, string>;
  total: number;
  depth: number;
}

function propValue(p: Record<string, unknown>): string {
  for (const [k, v] of Object.entries(p)) {
    if (!k.startsWith("value")) continue;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return str(o.code ?? o.display ?? JSON.stringify(v));
    }
    return str(v);
  }
  return "";
}

/** Index a CodeSystem's nested concepts (pure). Duplicate codes keep their first position. */
export function buildCsIndex(resource: Record<string, unknown>): CsIndex {
  const nodes = new Map<string, CsNode>();
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  let depth = 0;
  const walk = (list: unknown, parentCode: string, level: number): number => {
    if (!Array.isArray(list)) return 0;
    let desc = 0;
    const kids: string[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      const code = str(c.code);
      if (!code || nodes.has(code)) continue;
      depth = Math.max(depth, level);
      const node: CsNode = {
        code,
        display: (c.display as string) ?? null,
        definition: (c.definition as string) ?? null,
        designations: Array.isArray(c.designation)
          ? (c.designation as Record<string, unknown>[]).map((d) => ({
              language: (d.language as string) ?? null,
              use: d.use && typeof d.use === "object" ? str((d.use as Record<string, unknown>).display ?? (d.use as Record<string, unknown>).code) : null,
              value: str(d.value),
            }))
          : [],
        properties: Array.isArray(c.property) ? (c.property as Record<string, unknown>[]).map((p) => ({ code: str(p.code), value: propValue(p) })) : [],
        child_count: 0,
        descendant_count: 0,
      };
      nodes.set(code, node);
      if (parentCode) parent.set(code, parentCode);
      kids.push(code);
      const sub = walk(c.concept, code, level + 1);
      node.child_count = (children.get(code) ?? []).length;
      node.descendant_count = sub;
      desc += 1 + sub;
    }
    children.set(parentCode, [...(children.get(parentCode) ?? []), ...kids]);
    return desc;
  };
  const total = walk(resource.concept, "", 1);
  for (const [code, list] of children) {
    const n = nodes.get(code);
    if (n) n.child_count = list.length;
  }
  return { nodes, children, parent, total, depth };
}

export interface CsMeta {
  package_id: string;
  version: string;
  artifact_key: string;
  url: string | null;
  cs_version: string | null;
  name: string | null;
  title: string | null;
  status: string | null;
  content: string | null;
  hierarchy_meaning: string | null;
  case_sensitive: boolean | null;
  declared_count: number | null;
  actual_count: number;
  top_level_count: number;
  depth: number;
  property_defs: { code: string; type: string | null; description: string | null }[];
  mode: "tree" | "flat";
  /** Completeness verdict. */
  completeness: { status: "complete" | "fragment" | "truncated" | "not-present" | "example" | "supplement" | "unknown"; reason: string | null };
  other_versions: { version: string; concept_count: number }[];
}

/** Completeness verdict from the content code, `count`, and other installed versions (pure). */
export function completeness(
  content: string | null,
  declared: number | null,
  actualTopLevel: number,
  actualTotal: number,
  others: { version: string; concept_count: number }[],
): CsMeta["completeness"] {
  if (content === "fragment") return { status: "fragment", reason: "CodeSystem.content = fragment：只收錄部分概念。" };
  if (content === "not-present") return { status: "not-present", reason: "CodeSystem.content = not-present：此套件不含概念內容，代碼由外部定義。" };
  if (content === "example") return { status: "example", reason: "CodeSystem.content = example：僅示範用的部分概念。" };
  if (content === "supplement") return { status: "supplement", reason: "CodeSystem.content = supplement：補充另一個 CodeSystem 的設計。" };
  const bigger = others.filter((o) => o.concept_count >= Math.max(10, actualTopLevel * 5));
  if (bigger.length) {
    const b = bigger.sort((x, y) => y.concept_count - x.concept_count)[0];
    return {
      status: "truncated",
      reason: `標示為 ${content ?? "complete"}，但只有 ${actualTotal.toLocaleString("en-US")} 個概念；已安裝的 ${b.version} 版有 ${b.concept_count.toLocaleString("en-US")} 個頂層概念，此版本內容可能被截斷。`,
    };
  }
  if (declared !== null && declared > actualTotal) {
    return { status: "truncated", reason: `count = ${declared.toLocaleString("en-US")}，實際只有 ${actualTotal.toLocaleString("en-US")} 個概念。` };
  }
  if (content === "complete") return { status: "complete", reason: null };
  return { status: "unknown", reason: content ? `content = ${content}` : "未宣告 content。" };
}

const indexCache = new VersionedCache<{ meta: CsMeta; index: CsIndex | null }>(10 * 60_000, 12);

interface Ref {
  packageId: string;
  artifactKey: string;
  version: string;
}

async function resolve(q: Q, packageId: string, artifactKey: string, version: string): Promise<Ref & { imported: string; size: number }> {
  if (!packageId || !artifactKey) throw new TermVizError(400, "package_id and artifact_key are required");
  const r = await q(
    `SELECT package_version, imported_at::text AS imported, pg_column_size(raw_json)::int AS size
       FROM fhir.artifacts
      WHERE package_id = $1 AND artifact_key = $2 AND resource_type = 'CodeSystem' AND ($3 = '' OR package_version = $3)
      ORDER BY imported_at DESC NULLS LAST, package_version DESC LIMIT 1`,
    [packageId, artifactKey, version],
  );
  const row = r.rows[0];
  if (!row) throw new TermVizError(404, `CodeSystem ${artifactKey} not found in ${packageId}${version ? `@${version}` : ""}`);
  return { packageId, artifactKey, version: str(row.package_version), imported: str(row.imported), size: num(row.size) };
}

async function load(q: Q, packageId: string, artifactKey: string, version: string): Promise<{ meta: CsMeta; index: CsIndex | null; ref: Ref }> {
  const ref = await resolve(q, packageId, artifactKey, version);
  const key = `${ref.packageId}|${ref.version}|${ref.artifactKey}`;
  const v = await indexCache.get(key, ref.imported, async () => {
    const others = await q(
      `SELECT package_version, concept_count FROM fhir.artifacts
        WHERE package_id = $1 AND artifact_key = $2 AND package_version <> $3 ORDER BY package_version`,
      [ref.packageId, ref.artifactKey, ref.version],
    );
    const otherVersions = others.rows.map((o) => ({ version: str(o.package_version), concept_count: num(o.concept_count) }));
    if (ref.size <= RAW_JSON_LIMIT) {
      const r = await q("SELECT raw_json FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND artifact_key = $3", [ref.packageId, ref.version, ref.artifactKey]);
      const res = (r.rows[0]?.raw_json ?? {}) as Record<string, unknown>;
      const index = buildCsIndex(res);
      return { meta: metaOf(ref, res, index.total, (index.children.get("") ?? []).length, index.depth, "tree", otherVersions), index };
    }
    // Flat mode: header fields only (jsonb -> detoasts once, then cached).
    const r = await q(
      `SELECT raw_json - 'concept' AS head,
              (SELECT COUNT(*)::int FROM fhir.concepts c WHERE c.package_id = $1 AND c.package_version = $2 AND c.cs_id = $4) AS n
         FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND artifact_key = $3`,
      [ref.packageId, ref.version, ref.artifactKey, ref.artifactKey.replace(/^CodeSystem\//, "")],
    );
    const head = (r.rows[0]?.head ?? {}) as Record<string, unknown>;
    const n = num(r.rows[0]?.n);
    return { meta: metaOf(ref, head, n, n, 1, "flat", otherVersions), index: null };
  });
  return { ...v, ref };
}

function metaOf(ref: Ref, res: Record<string, unknown>, total: number, top: number, depth: number, mode: "tree" | "flat", others: CsMeta["other_versions"]): CsMeta {
  const content = (res.content as string) ?? null;
  const declared = typeof res.count === "number" ? res.count : null;
  return {
    package_id: ref.packageId,
    version: ref.version,
    artifact_key: ref.artifactKey,
    url: (res.url as string) ?? null,
    cs_version: (res.version as string) ?? null,
    name: (res.name as string) ?? null,
    title: (res.title as string) ?? null,
    status: (res.status as string) ?? null,
    content,
    hierarchy_meaning: (res.hierarchyMeaning as string) ?? null,
    case_sensitive: typeof res.caseSensitive === "boolean" ? res.caseSensitive : null,
    declared_count: declared,
    actual_count: total,
    top_level_count: top,
    depth,
    property_defs: Array.isArray(res.property)
      ? (res.property as Record<string, unknown>[]).map((p) => ({ code: str(p.code), type: (p.type as string) ?? null, description: (p.description as string) ?? null }))
      : [],
    mode,
    completeness: completeness(content, declared, top, total, others),
    other_versions: others,
  };
}

export async function csOverview(q: Q, packageId: string, artifactKey: string, version: string, limit: number): Promise<Row> {
  const { meta } = await load(q, packageId, artifactKey, version);
  const root = await csChildren(q, packageId, artifactKey, meta.version, "", 0, limit);
  return { meta, root };
}

export async function csChildren(q: Q, packageId: string, artifactKey: string, version: string, parent: string, offset: number, limit: number): Promise<Row> {
  const { index, ref } = await load(q, packageId, artifactKey, version);
  if (index) {
    if (parent && !index.nodes.has(parent)) throw new TermVizError(404, `Concept ${parent} not found`);
    const codes = index.children.get(parent) ?? [];
    return { parent, total: codes.length, offset, items: codes.slice(offset, offset + limit).map((c) => index.nodes.get(c)!) };
  }
  if (parent) return { parent, total: 0, offset, items: [] };
  const csId = ref.artifactKey.replace(/^CodeSystem\//, "");
  const [cnt, rows] = await Promise.all([
    q("SELECT COUNT(*)::int AS n FROM fhir.concepts WHERE package_id = $1 AND package_version = $2 AND cs_id = $3", [ref.packageId, ref.version, csId]),
    q("SELECT code, display, definition FROM fhir.concepts WHERE package_id = $1 AND package_version = $2 AND cs_id = $3 ORDER BY id LIMIT $4 OFFSET $5", [
      ref.packageId,
      ref.version,
      csId,
      limit,
      offset,
    ]),
  ]);
  return {
    parent,
    total: num(cnt.rows[0]?.n),
    offset,
    items: rows.rows.map((r) => ({ code: str(r.code), display: (r.display as string) ?? null, definition: (r.definition as string) ?? null, designations: [], properties: [], child_count: 0, descendant_count: 0 })),
  };
}

/** Matches with their ancestor path (so the tree can reveal them). */
export async function csSearch(q: Q, packageId: string, artifactKey: string, version: string, text: string, limit = 30): Promise<Row> {
  const { index, ref } = await load(q, packageId, artifactKey, version);
  const t = text.trim().toLowerCase();
  if (!t) return { items: [] };
  if (index) {
    const items: Row[] = [];
    for (const n of index.nodes.values()) {
      const hay = [n.code, n.display ?? "", ...n.designations.map((d) => d.value)].join("\u0000").toLowerCase();
      if (!hay.includes(t)) continue;
      const path: string[] = [];
      for (let p = index.parent.get(n.code); p; p = index.parent.get(p)) path.unshift(p);
      items.push({ ...n, path });
      if (items.length >= limit) break;
    }
    return { items };
  }
  const csId = ref.artifactKey.replace(/^CodeSystem\//, "");
  const r = await q(
    `SELECT code, display, definition FROM fhir.concepts
      WHERE package_id = $1 AND package_version = $2 AND cs_id = $3 AND (code ILIKE $4 ESCAPE '\\' OR display ILIKE $4 ESCAPE '\\')
      ORDER BY length(code), code LIMIT $5`,
    [ref.packageId, ref.version, csId, `%${likeEscape(t)}%`, limit],
  );
  return { items: r.rows.map((x) => ({ code: str(x.code), display: x.display ?? null, definition: x.definition ?? null, designations: [], properties: [], child_count: 0, descendant_count: 0, path: [] })) };
}

/** CodeSystems of one installed package (picker). */
export async function csList(q: Q, packageId: string, version: string, text: string): Promise<Row> {
  if (!packageId) throw new TermVizError(400, "package_id is required");
  const params: unknown[] = [packageId, version];
  let extra = "";
  if (text.trim()) {
    params.push(`%${likeEscape(text.trim())}%`);
    extra = ` AND (artifact_id ILIKE $3 ESCAPE '\\' OR title ILIKE $3 ESCAPE '\\' OR name ILIKE $3 ESCAPE '\\' OR canonical_url ILIKE $3 ESCAPE '\\')`;
  }
  const r = await q(
    `SELECT DISTINCT ON (artifact_key) artifact_key, artifact_id, title, name, canonical_url, status, concept_count, package_version
       FROM fhir.artifacts
      WHERE package_id = $1 AND resource_type = 'CodeSystem' AND ($2 = '' OR package_version = $2)${extra}
      ORDER BY artifact_key, imported_at DESC NULLS LAST LIMIT 500`,
    params,
  );
  return { items: r.rows };
}
