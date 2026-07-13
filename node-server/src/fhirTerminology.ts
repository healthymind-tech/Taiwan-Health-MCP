/**
 * FHIR terminology resolver — tiered ValueSet expansion + code lookup.
 * Faithful port of `src/fhir_terminology.py`. DB helpers (use the pg pool) with
 * no envelope logic. Honesty contract: when a system cannot be resolved from
 * data we hold, say so (`unresolved` / `found:null`) — never fabricate a display.
 */

import { query } from "./db.js";
import type { PackageRow } from "./fhirIg.js";

export const SNOMED_SYSTEM = "http://snomed.info/sct";
export const LOINC_SYSTEM = "http://loinc.org";
export const SNOMED_IS_A = 116680003;

export const DEFAULT_EXPAND_LIMIT = 500;
const MAX_IMPORT_DEPTH = 5;

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

/** Resolve a `(system, code)` to `{display, definition}` from local data, or null. */
export async function lookup(
  system: string | null | undefined,
  code: string,
  pkg: PackageRow,
  csId: string | null = null,
): Promise<LookupResult | null> {
  const kind = routeSystem(system, csId);
  if (kind === "snomed") {
    if (!isDigits(code)) return null;
    const row = (
      await query<{ term: string }>(
        "SELECT term FROM snomed.descriptions WHERE concept_id = $1 AND active = TRUE " +
          "ORDER BY us_preferred DESC NULLS LAST LIMIT 1",
        [parseInt(code, 10)],
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
    return row ? { display: row.long_common_name, definition: row.shortname } : null;
  }
  if (kind === "icd_dx" || kind === "icd_pcs") {
    const table = kind === "icd_dx" ? "icd.diagnoses" : "icd.procedures";
    const row = (
      await query<{ name_en: string; name_zh: string }>(
        `SELECT name_en, name_zh FROM ${table} WHERE code = $1`,
        [code],
      )
    ).rows[0];
    return row ? { display: row.name_en, definition: row.name_zh } : null;
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
      [parseInt(code, 10), SNOMED_IS_A, limit],
    )
  ).rows;
  return rows.map((r) => r.concept_id);
}

export async function snomedDisplays(ids: number[]): Promise<Map<number, string>> {
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
  for (const r of rows) out.set(r.concept_id, r.term);
  return out;
}

async function loadValuesetByCanonical(url: string, pkg: PackageRow): Promise<Record<string, any> | null> {
  const [pids, pvers] = closureArrays(pkg);
  const row = (
    await query<{ raw_json: any }>(
      "SELECT a.raw_json FROM fhir.artifacts a " +
        "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) " +
        "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "WHERE a.resource_type = 'ValueSet' " +
        "AND (a.canonical_url = $3 OR a.artifact_id = $4) LIMIT 1",
      [pids, pvers, url.split("|")[0], canonicalTail(url)],
    )
  ).rows[0];
  if (!row) return null;
  const raw = row.raw_json;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

export interface Coding {
  system: string | null;
  code: string;
  display: string | null;
}

export interface ExpandResult {
  codings: Coding[];
  total: number;
  truncated: boolean;
  warnings: string[];
  unresolved: any[];
}

/** Tiered expansion of a ValueSet `compose` block. */
export async function expandCompose(
  compose: Record<string, any>,
  pkg: PackageRow,
  limit: number = DEFAULT_EXPAND_LIMIT,
  depth = 0,
  seenVs: Set<string> = new Set(),
): Promise<ExpandResult> {
  const codings: Coding[] = [];
  const warnings: string[] = [];
  const unresolved: any[] = [];
  const seen = new Set<string>();
  const state = { truncated: false };

  const add = (system: string | null, code: string, display: string | null): boolean => {
    const key = `${system} ${code}`;
    if (seen.has(key)) return true;
    if (codings.length >= limit) {
      state.truncated = true;
      return false;
    }
    seen.add(key);
    codings.push({ system, code, display });
    return true;
  };

  for (const inc of (compose || {}).include || []) {
    const system = inc.system;

    // (3) imported ValueSets
    for (const vsUrl of inc.valueSet || []) {
      if (depth >= MAX_IMPORT_DEPTH || seenVs.has(vsUrl)) {
        warnings.push(`valueSet import not expanded (depth/cycle): ${vsUrl}`);
        continue;
      }
      const subVs = await loadValuesetByCanonical(vsUrl, pkg);
      if (subVs === null) {
        unresolved.push({ valueSet: vsUrl, reason: "VALUESET_NOT_FOUND" });
        continue;
      }
      const sub = await expandCompose(
        subVs.compose || {},
        pkg,
        limit,
        depth + 1,
        new Set([...seenVs, vsUrl]),
      );
      warnings.push(...sub.warnings);
      unresolved.push(...sub.unresolved);
      state.truncated = state.truncated || sub.truncated;
      let broke = false;
      for (const c of sub.codings) {
        if (!add(c.system, c.code, c.display ?? null)) {
          broke = true;
          break;
        }
      }
      if (broke) break;
    }

    // (1) inline concepts
    if (inc.concept) {
      for (const c of inc.concept) {
        let display = c.display ?? null;
        if (display === null && system) {
          const look = await lookup(system, c.code, pkg);
          display = look ? look.display : null;
        }
        if (!add(system, c.code, display)) break;
      }
      continue;
    }

    // (2) filters
    if (inc.filter) {
      for (const f of inc.filter) {
        const op = f.op;
        const val = f.value;
        if (system === SNOMED_SYSTEM && (op === "is-a" || op === "descendent-of")) {
          const ids = await snomedDescendants(val, limit + 1);
          const disp = await snomedDisplays(ids);
          for (const cid of ids) {
            if (!add(SNOMED_SYSTEM, String(cid), disp.get(cid) ?? null)) break;
          }
        } else if (op === "=") {
          const look = await lookup(system, val, pkg);
          if (look) {
            add(system, val, look.display);
          } else {
            unresolved.push({ system, reason: "FILTER_EQ_UNRESOLVED" });
          }
        } else {
          warnings.push(`unsupported filter op '${op}' on ${system}`);
          unresolved.push({ system, reason: `filter:${op}` });
        }
      }
      continue;
    }

    // (4) whole-system include — enumerate held concepts in the closure
    if (system) {
      let rows: Array<{ code: string; display: string }> = [];
      if (!["snomed", "loinc", "icd_dx", "icd_pcs"].includes(routeSystem(system))) {
        const [pids, pvers] = closureArrays(pkg);
        rows = (
          await query<{ code: string; display: string }>(
            "SELECT c.code, c.display FROM fhir.concepts c " +
              "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) " +
              "  ON c.package_id = dep.pid AND c.package_version = dep.pver " +
              "WHERE c.cs_id = $3 LIMIT $4",
            [pids, pvers, canonicalTail(system), limit + 1],
          )
        ).rows;
      }
      if (rows.length) {
        for (const r of rows) {
          if (!add(system, r.code, r.display)) break;
        }
      } else {
        warnings.push(`TOO_BROAD: whole-system not enumerated: ${system}`);
        unresolved.push({ system, reason: "TOO_BROAD" });
      }
    }
  }

  // excludes
  const excl = new Set<string>();
  for (const exc of (compose || {}).exclude || []) {
    const esys = exc.system;
    for (const c of exc.concept || []) {
      excl.add(`${esys} ${c.code}`);
    }
  }
  let finalCodings = codings;
  if (excl.size) {
    finalCodings = codings.filter((c) => !excl.has(`${c.system} ${c.code}`));
  }

  return {
    codings: finalCodings,
    total: finalCodings.length,
    truncated: state.truncated,
    warnings,
    unresolved,
  };
}
