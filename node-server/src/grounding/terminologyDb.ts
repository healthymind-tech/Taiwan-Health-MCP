/**
 * Postgres-backed `TerminologyNames` provider for production grounding.
 *
 * Sources (all local tables — never an external terminology server, spec §2.2.9):
 *   ICD-10-CM  icd.diagnoses     CMS long title + short title + Chinese name (+ IG CodeSystem displays for TW Core URLs)
 *   ICD-10-PCS icd.procedures    English + Chinese (+ IG CodeSystem displays)
 *   LOINC      loinc.concepts    long_common_name, shortname, name_zh, common_name_zh, consumer_name, component
 *   SNOMED CT  snomed.descriptions (active): preferred term, FSN, synonyms
 *   RxNorm     rxnorm.concepts   name
 *   CVX        fhirCvx.ts        display + long description (static table)
 *   other      fhir.concepts     IG CodeSystem display, matched by canonical tail (NHI / TW Core codes)
 * HL7 terminology / UCUM / urn:iso systems are skipped (as in the reference): their displays are not clinical names.
 *
 * Batched: one query per source table per call, `= ANY($1)`. Results (including "not found") are kept in an
 * in-memory LRU. Any query failure degrades to "not found" for the affected keys (codes become unverifiable —
 * never an error) and is not cached. DB access is injected (`query`), so this module has no pool dependency.
 */
import { CVX_CODES } from "../fhirCvx.js";
import type { TermRecord, TerminologyNames } from "./terminologyNames.js";
import { createSnomedChineseNames, type ZhName } from "./snomedChinese.js";

export type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface DbTerminologyOptions {
  query: QueryFn;
  /** Max cached system|code records (default 20000). */
  cacheSize?: number;
  /** Systems to skip (prefix match); default: HL7 terminology, UCUM, urn:iso. */
  skipPrefixes?: readonly string[];
  logger?: { warn?(msg: string, meta?: Record<string, unknown>): void };
}

export interface DbTerminologyNames extends TerminologyNames {
  /**
   * Chinese names of SNOMED CT concepts (snomedChinese.ts: IG designations, SNOMED → ICD-10 map → ICD-10-CM Chinese
   * names, the mined bilingual thesaurus over the English names). Only the record checks' code-grounding comparison
   * uses them (recordChecks/codeGrounding.ts); `lookup` (what grounding compares) never includes them.
   */
  snomedChineseNames(conceptId: string): Promise<ZhName[]>;
  snomedChineseNamesBatch(conceptIds: readonly string[]): Promise<ReadonlyMap<string, ZhName[]>>;
  clear(): void;
  stats(): { cached: number; hits: number; misses: number; queries: number };
}

const ICD_CM_STANDARD = new Set(["http://hl7.org/fhir/sid/icd-10-cm"]);
const CMS_ICD10 = "http://www.cms.gov/Medicare/Coding/ICD10";
const DEFAULT_SKIP = ["http://terminology.hl7.org/CodeSystem/", "http://unitsofmeasure.org", "urn:iso:"];
const SNOMED_FSN = "900000000000003001";

type Route = "icd_cm" | "icd_pcs" | "icd_any" | "loinc" | "snomed" | "cvx" | "rxnorm" | "ig" | "skip";

export function routeSystem(system: string, skipPrefixes: readonly string[] = DEFAULT_SKIP): Route {
  if (!system || system === "None" || skipPrefixes.some((p) => system.startsWith(p))) return "skip";
  if (ICD_CM_STANDARD.has(system) || system.includes("icd-10-cm")) return "icd_cm";
  if (system === CMS_ICD10) return "icd_any";
  if (system.includes("icd-10-pcs")) return "icd_pcs";
  if (system === "http://loinc.org") return "loinc";
  if (system === "http://snomed.info/sct") return "snomed";
  if (system === "http://hl7.org/fhir/sid/cvx") return "cvx";
  if (system === "http://www.nlm.nih.gov/research/umls/rxnorm") return "rxnorm";
  return "ig";
}

/** Canonical tail used as fhir.concepts.cs_id (same convention as fhirTerminology.canonicalTail). */
function canonicalTail(system: string): string {
  const s = system.replace(/\|.*$/, "").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** ICD code variants: as given, upper-cased, and with the dot inserted after the category (M5450 -> M54.50). */
function icdVariants(code: string): string[] {
  const out = new Set<string>([code, code.toUpperCase()]);
  const u = code.toUpperCase();
  if (!u.includes(".") && u.length > 3) out.add(`${u.slice(0, 3)}.${u.slice(3)}`);
  return [...out];
}

function splitKey(k: string): [string, string] {
  const i = k.lastIndexOf("|");
  return i < 0 ? [k, ""] : [k.slice(0, i), k.slice(i + 1)];
}

function uniq(xs: Array<unknown>): string[] {
  const out: string[] = [];
  for (const x of xs) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function createDbTerminologyNames(opts: DbTerminologyOptions): DbTerminologyNames {
  const { query } = opts;
  const cap = opts.cacheSize ?? 20000;
  const skip = opts.skipPrefixes ?? DEFAULT_SKIP;
  const cache = new Map<string, TermRecord>();
  let hits = 0;
  let misses = 0;
  let queries = 0;
  let versionStr: string | null = null;

  const remember = (k: string, r: TermRecord): void => {
    if (cache.has(k)) cache.delete(k);
    cache.set(k, r);
    while (cache.size > cap) cache.delete(cache.keys().next().value as string);
  };

  const run = async (sql: string, params: unknown[]): Promise<Array<Record<string, unknown>> | null> => {
    queries++;
    try {
      return (await query(sql, params)).rows;
    } catch (e) {
      opts.logger?.warn?.("grounding terminology query failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  async function fetchIcd(table: "icd.diagnoses" | "icd.procedures", codes: string[]): Promise<Map<string, string[]> | null> {
    const variants = [...new Set(codes.flatMap(icdVariants))];
    let rows: Array<Record<string, unknown>> | null;
    if (table === "icd.diagnoses") {
      rows = await run("SELECT code, short_name_en, name_en, name_zh FROM icd.diagnoses WHERE code = ANY($1::text[])", [variants]);
      if (rows === null) rows = await run("SELECT code, name_en, name_zh FROM icd.diagnoses WHERE code = ANY($1::text[])", [variants]);
    } else {
      rows = await run("SELECT code, name_en, name_zh FROM icd.procedures WHERE code = ANY($1::text[])", [variants]);
    }
    if (rows === null) return null;
    const byCode = new Map<string, string[]>();
    for (const r of rows) byCode.set(String(r.code), uniq([r.short_name_en, r.name_en, r.name_zh]));
    const out = new Map<string, string[]>();
    for (const c of codes) {
      const hit = icdVariants(c).map((v) => byCode.get(v)).find((x) => x);
      if (hit) out.set(c, hit);
    }
    return out;
  }

  async function fetchIg(pairs: Array<[string, string]>): Promise<Map<string, string[]> | null> {
    if (!pairs.length) return new Map();
    const tails = [...new Set(pairs.map(([cs]) => cs))];
    const codes = [...new Set(pairs.map(([, c]) => c))];
    const rows = await run(
      "SELECT c.cs_id, c.code, c.display FROM fhir.concepts c " +
        "LEFT JOIN fhir.ig_packages p ON p.package_id = c.package_id AND p.version = c.package_version " +
        "WHERE c.cs_id = ANY($1::text[]) AND c.code = ANY($2::text[]) " +
        "ORDER BY COALESCE(p.is_default, FALSE) DESC, c.package_id, c.package_version DESC, c.id",
      [tails, codes],
    );
    if (rows === null) return null;
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const k = `${r.cs_id}|${r.code}`;
      out.set(k, uniq([...(out.get(k) ?? []), r.display])); // definitions are billing notes / prose, not names
    }
    return out;
  }

  async function lookupUncached(keys: string[]): Promise<Map<string, TermRecord>> {
    const result = new Map<string, TermRecord>();
    const failed = new Set<string>();
    const groups = new Map<Route, Array<[string, string, string]>>(); // route -> [key, system, code]
    for (const k of keys) {
      const [system, code] = splitKey(k);
      const r = code && code !== "None" ? routeSystem(system, skip) : "skip";
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push([k, system, code]);
    }
    const put = (k: string, names: string[], source: string): void => {
      const prev = result.get(k);
      const merged = uniq([...(prev?.names ?? []), ...names]);
      result.set(k, { found: merged.length > 0 || !!prev?.found, names: merged, source: [...(prev?.source ?? []), ...(names.length ? [source] : [])] });
    };
    const igPairs: Array<[string, string, string]> = []; // [key, cs_id, code]

    for (const [route, items] of groups) {
      if (route === "skip") continue;
      if (route === "icd_cm" || route === "icd_pcs" || route === "icd_any") {
        const tables: Array<"icd.diagnoses" | "icd.procedures"> =
          route === "icd_cm" ? ["icd.diagnoses"] : route === "icd_pcs" ? ["icd.procedures"] : ["icd.diagnoses", "icd.procedures"];
        for (const t of tables) {
          const m = await fetchIcd(t, [...new Set(items.map(([, , c]) => c))]);
          if (m === null) items.forEach(([k]) => failed.add(k));
          else for (const [k, , c] of items) if (m.get(c)) put(k, m.get(c)!, t);
        }
        for (const [k, s, c] of items) if (!ICD_CM_STANDARD.has(s) && s !== CMS_ICD10) igPairs.push([k, canonicalTail(s), c]);
      } else if (route === "loinc") {
        const codes = [...new Set(items.map(([, , c]) => c))];
        const rows = await run(
          // property / scale_type: LOINC axes for the record checks (TermRecord.axes); the names are unchanged
          "SELECT loinc_num, long_common_name, shortname, name_zh, common_name_zh, consumer_name, component, property, scale_type FROM loinc.concepts WHERE loinc_num = ANY($1::text[])",
          [codes],
        );
        if (rows === null) items.forEach(([k]) => failed.add(k));
        else {
          const by = new Map(rows.map((r) => [String(r.loinc_num), r]));
          for (const [k, , c] of items) {
            const r = by.get(c);
            if (!r) continue;
            const display = r.consumer_name || r.common_name_zh || r.shortname || r.long_common_name;
            put(k, uniq([r.long_common_name, r.shortname, r.name_zh, r.common_name_zh, r.consumer_name, r.component, display]), "loinc.concepts");
            const prop = typeof r.property === "string" && r.property.trim() ? r.property.trim() : null;
            const scale = typeof r.scale_type === "string" && r.scale_type.trim() ? r.scale_type.trim() : null;
            if ((prop || scale) && result.has(k)) result.set(k, { ...result.get(k)!, axes: { property: prop, scale } });
          }
        }
      } else if (route === "snomed") {
        const ids = [...new Set(items.map(([, , c]) => c).filter((c) => /^\d{6,18}$/.test(c)))];
        if (ids.length) {
          const rows = await run(
            "SELECT concept_id::text AS code, term, type_id::text AS type_id, us_preferred FROM snomed.descriptions " +
              "WHERE concept_id = ANY($1::bigint[]) AND active = TRUE " +
              "ORDER BY concept_id, us_preferred DESC, (type_id = " + SNOMED_FSN + ") DESC, length(term), description_id",
            [ids],
          );
          if (rows === null) items.forEach(([k]) => failed.add(k));
          else {
            const by = new Map<string, string[]>();
            for (const r of rows) {
              const c = String(r.code);
              if (!by.has(c)) by.set(c, []);
              by.get(c)!.push(String(r.term));
            }
            for (const [k, , c] of items) if (by.get(c)?.length) put(k, uniq(by.get(c)!.slice(0, 30)), "snomed.descriptions");
          }
        }
      } else if (route === "rxnorm") {
        const ids = [...new Set(items.map(([, , c]) => c).filter((c) => /^\d{1,12}$/.test(c)))];
        if (ids.length) {
          const rows = await run("SELECT rxcui::text AS code, name FROM rxnorm.concepts WHERE rxcui = ANY($1::bigint[])", [ids]);
          if (rows === null) items.forEach(([k]) => failed.add(k));
          else {
            const by = new Map(rows.map((r) => [String(r.code), String(r.name)]));
            for (const [k, , c] of items) if (by.get(c)) put(k, [by.get(c)!], "rxnorm.concepts");
          }
        }
      } else if (route === "cvx") {
        for (const [k, , c] of items) {
          const r = Object.prototype.hasOwnProperty.call(CVX_CODES, c) ? CVX_CODES[c] : undefined;
          if (r) put(k, uniq([r[0], r[1]]), "cvx");
        }
      } else {
        for (const [k, s, c] of items) igPairs.push([k, canonicalTail(s), c]);
      }
    }
    if (igPairs.length) {
      const m = await fetchIg(igPairs.map(([, cs, c]) => [cs, c]));
      if (m === null) igPairs.forEach(([k]) => failed.add(k));
      else for (const [k, cs, c] of igPairs) if (m.get(`${cs}|${c}`)) put(k, m.get(`${cs}|${c}`)!, "fhir.concepts");
    }
    for (const k of keys) {
      if (!result.has(k)) result.set(k, { found: false, names: [], source: [] });
      if (!failed.has(k)) remember(k, result.get(k)!);
    }
    return result;
  }

  const lookupNames = async (keys: readonly string[]): Promise<Map<string, TermRecord>> => {
    const out = new Map<string, TermRecord>();
    const todo: string[] = [];
    for (const k of new Set(keys)) {
      const r = cache.get(k);
      if (r) {
        hits++;
        cache.delete(k);
        cache.set(k, r);
        out.set(k, r);
      } else {
        misses++;
        todo.push(k);
      }
    }
    if (todo.length) for (const [k, r] of await lookupUncached(todo)) out.set(k, r);
    return out;
  };

  const zh = createSnomedChineseNames({
    query,
    logger: opts.logger,
    // English names for the thesaurus: the same (LRU-cached) SNOMED descriptions grounding compares
    englishNames: async (ids) => {
      const m = await lookupNames(ids.map((id) => `http://snomed.info/sct|${id}`));
      return new Map(ids.map((id) => [id, m.get(`http://snomed.info/sct|${id}`)?.names ?? []]));
    },
  });

  return {
    async version() {
      if (versionStr) return versionStr;
      const parts: string[] = [];
      const one = async (sql: string, fmt: (r: Record<string, unknown>) => string): Promise<void> => {
        const rows = await run(sql, []);
        if (rows && rows[0]) parts.push(fmt(rows[0]));
      };
      await one("SELECT edition FROM icd.editions WHERE code_system = 'icd-10-cm'", (r) => `icd10cm ${r.edition}`);
      await one("SELECT version FROM loinc.editions WHERE code_system = 'loinc'", (r) => `loinc ${r.version}`);
      await one("SELECT version_date::text AS v FROM snomed.editions WHERE code_system = 'snomed'", (r) => `snomed ${r.v}`);
      await one("SELECT package_id || '#' || version AS v FROM fhir.ig_packages WHERE is_default", (r) => `ig ${r.v}`);
      versionStr = parts.length ? `db: ${parts.join("; ")}` : "db";
      return versionStr;
    },
    lookup: lookupNames,
    snomedChineseNames: (id) => zh.snomedChineseNames(id),
    snomedChineseNamesBatch: (ids) => zh.lookup(ids),
    clear() {
      cache.clear();
      zh.clear();
      versionStr = null;
    },
    stats: () => ({ cached: cache.size, hits, misses, queries }),
  };
}
