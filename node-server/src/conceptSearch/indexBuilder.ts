/**
 * Builds the IG concept-search index (fhir.concept_index_*) and the mined thesaurus
 * (fhir.term_thesaurus). Run by the admin worker: inline at the end of ig_import (for
 * the packages it installed) and by the ig_concept_index backfill job (all packages).
 *
 * Idempotent: each CodeSystem's row carries a signature over (builder version, the
 * artifact's import time, the supplements applied, the ConceptMaps linked); an
 * unchanged CodeSystem is skipped, a changed one is replaced in one transaction.
 * CodeSystems served by dedicated tables (ICD / LOINC / SNOMED) are not indexed.
 */

import crypto from "crypto";
import type pg from "pg";
import { logInfo, logWarning } from "../logger.js";
import { routeSystem, LOINC_SYSTEM, SNOMED_SYSTEM } from "../fhirTerminology.js";
import { assembleCodeSystem, conceptMapLinks, supplementApplies, type AssembledConcept, type LinkCoding, type SupplementRef } from "./assemble.js";
import { buildEntries, mineBilingual, mineInlineAcronyms, mineLoincAcronyms, mineSnomedAcronyms } from "./thesaurus.js";
import { compact, normalizeText, umlsNorm } from "./text.js";

/** Bump when the term derivation changes: every CodeSystem is rebuilt on the next run. */
export const INDEX_BUILDER_VERSION = "1";

/** CodeSystems above this many concepts are indexed lexically but not embedded. */
export const DEFAULT_EMBED_MAX_CONCEPTS = 20000;

const EMBED_KINDS = new Set(["display", "designation", "linked"]);
const LINKS_PER_CONCEPT = 6;

export interface BuildOptions {
  /** Restrict to these packages (default: every installed package). */
  packages?: Array<{ package_id: string; version: string }>;
  /** Rebuild even when the signature is unchanged. */
  force?: boolean;
  embedMaxConcepts?: number;
  log?: (message: string) => void | Promise<void>;
  shouldStop?: () => boolean | Promise<boolean>;
}

export interface BuildStats {
  packages: number;
  codesystems: number;
  rebuilt: number;
  skipped: number;
  concepts: number;
  terms: number;
  embeddable_terms: number;
  supplements_applied: number;
  stopped: boolean;
}

function sha(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function jsonOf(raw: unknown): Record<string, any> | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw as Record<string, any>;
}

interface SupplementRow {
  url: string;
  version: string | null;
  supplements: string;
  stamp: string;
  load: () => Promise<Record<string, any> | null>;
}

/** Every known supplement: inside installed IG packages, and uploaded ones. */
async function listSupplements(pool: pg.Pool): Promise<SupplementRow[]> {
  const out: SupplementRow[] = [];
  const pkg = await pool.query<{ package_id: string; package_version: string; artifact_key: string; url: string; version: string | null; supplements: string; imported_at: Date }>(
    `SELECT package_id, package_version, artifact_key, raw_json->>'url' AS url, raw_json->>'version' AS version,
            raw_json->>'supplements' AS supplements, imported_at
       FROM fhir.artifacts
      WHERE resource_type = 'CodeSystem' AND raw_json->>'content' = 'supplement' AND raw_json->>'supplements' IS NOT NULL`,
  );
  for (const r of pkg.rows) {
    out.push({
      url: r.url,
      version: r.version,
      supplements: r.supplements,
      stamp: `pkg:${r.package_id}#${r.package_version}:${new Date(r.imported_at).toISOString()}`,
      load: async () =>
        jsonOf(
          (
            await pool.query("SELECT raw_json FROM fhir.artifacts WHERE package_id=$1 AND package_version=$2 AND artifact_key=$3", [
              r.package_id,
              r.package_version,
              r.artifact_key,
            ])
          ).rows[0]?.raw_json,
        ),
    });
  }
  try {
    const up = await pool.query<{ url: string; version: string; supplements: string; uploaded_at: Date }>(
      "SELECT url, version, supplements, uploaded_at FROM fhir.codesystem_supplements",
    );
    for (const r of up.rows) {
      out.push({
        url: r.url,
        version: r.version || null,
        supplements: r.supplements,
        stamp: `upload:${new Date(r.uploaded_at).toISOString()}`,
        load: async () =>
          jsonOf((await pool.query("SELECT raw_json FROM fhir.codesystem_supplements WHERE url=$1 AND version=$2", [r.url, r.version])).rows[0]?.raw_json),
      });
    }
  } catch {
    /* table not migrated yet */
  }
  return out;
}

interface ConceptMapSummary {
  key: string;
  stamp: string;
  sources: Set<string>;
  load: () => Promise<Record<string, any> | null>;
}

/** ConceptMaps of all installed packages, with the source systems their groups map from. */
async function listConceptMaps(pool: pg.Pool): Promise<ConceptMapSummary[]> {
  const rows = await pool.query<{ package_id: string; package_version: string; artifact_key: string; sources: string[] | null; imported_at: Date }>(
    `SELECT package_id, package_version, artifact_key, imported_at,
            ARRAY(SELECT DISTINCT split_part(g->>'source', '|', 1) FROM jsonb_array_elements(COALESCE(raw_json->'group', '[]'::jsonb)) g
                   WHERE g->>'source' IS NOT NULL) AS sources
       FROM fhir.artifacts WHERE resource_type = 'ConceptMap'`,
  );
  return rows.rows.map((r) => ({
    key: `${r.package_id}#${r.package_version}/${r.artifact_key}`,
    stamp: new Date(r.imported_at).toISOString(),
    sources: new Set(r.sources || []),
    load: async () =>
      jsonOf(
        (
          await pool.query("SELECT raw_json FROM fhir.artifacts WHERE package_id=$1 AND package_version=$2 AND artifact_key=$3", [
            r.package_id,
            r.package_version,
            r.artifact_key,
          ])
        ).rows[0]?.raw_json,
      ),
  }));
}

/** Names for linked codings: LOINC component, SNOMED preferred term, else the coding's display. */
async function resolveLinkNames(pool: pg.Pool, links: LinkCoding[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const loinc = [...new Set(links.filter((l) => l.system === LOINC_SYSTEM).map((l) => l.code))];
  const snomed = [...new Set(links.filter((l) => l.system === SNOMED_SYSTEM && /^\d+$/.test(l.code)).map((l) => l.code))];
  if (loinc.length) {
    try {
      const r = await pool.query<{ loinc_num: string; component: string | null; long_common_name: string | null }>(
        "SELECT loinc_num, component, long_common_name FROM loinc.concepts WHERE loinc_num = ANY($1::text[])",
        [loinc],
      );
      // The shared COMPONENT (analyte) rather than each long name: one payment code maps
      // to many LOINC codes that differ only by specimen / method / scale.
      for (const row of r.rows) {
        const comp = String(row.component || "").split(/\^/)[0].trim();
        out.set(`${LOINC_SYSTEM}|${row.loinc_num}`, comp ? [comp] : row.long_common_name ? [row.long_common_name] : []);
      }
    } catch {
      /* LOINC module not loaded */
    }
  }
  if (snomed.length) {
    try {
      const r = await pool.query<{ concept_id: string; term: string }>(
        `SELECT DISTINCT ON (concept_id) concept_id::text AS concept_id, term FROM snomed.descriptions
          WHERE concept_id = ANY($1::bigint[]) AND active = TRUE
          ORDER BY concept_id, us_preferred DESC, (type_id = 900000000000003001) ASC`,
        [snomed],
      );
      for (const row of r.rows) out.set(`${SNOMED_SYSTEM}|${row.concept_id}`, [row.term]);
    } catch {
      /* SNOMED module not loaded */
    }
  }
  for (const l of links) {
    const k = `${l.system}|${l.code}`;
    if (!out.has(k) && l.display) out.set(k, [l.display]);
  }
  return out;
}

/**
 * Batched INSERT … SELECT FROM unnest(...): `fixed` are scalar params ($1..$k) repeated on
 * every batch; `columns` are parallel arrays unnested as $k+1.. with the given element types.
 */
async function insertUnnest(
  client: pg.PoolClient,
  sql: (unnest: string) => string,
  fixed: unknown[],
  columns: unknown[][],
  types: string[],
  batch = 5000,
): Promise<void> {
  const n = columns[0]?.length ?? 0;
  const unnest = `unnest(${types.map((t, j) => `$${fixed.length + j + 1}::${t}[]`).join(", ")})`;
  const text = sql(unnest);
  for (let i = 0; i < n; i += batch) {
    await client.query(text, [...fixed, ...columns.map((col) => col.slice(i, i + batch))]);
  }
}

/** "release@loaded_at" of the loaded UMLS store, or null when none. */
export async function umlsReleaseStamp(pool: pg.Pool): Promise<string | null> {
  try {
    const r = await pool.query<{ release: string; loaded_at: Date }>("SELECT release, loaded_at FROM fhir.umls_release WHERE id = 1");
    const row = r.rows[0];
    return row ? `${row.release}@${new Date(row.loaded_at).toISOString()}` : null;
  } catch {
    return null;
  }
}

const UMLS_MAX_CUIS_PER_NAME = 3;
const UMLS_SYNONYMS_PER_CUI = 10;
const UMLS_TERMS_PER_CONCEPT = 12;

/**
 * Add UMLS synonyms of the CUIs an IG concept's English name maps to (exact normalised
 * string match; ambiguous names — more than UMLS_MAX_CUIS_PER_NAME CUIs — are skipped).
 */
async function addUmlsSynonyms(pool: pg.Pool, concepts: AssembledConcept[]): Promise<void> {
  const byNorm = new Map<string, AssembledConcept[]>();
  for (const c of concepts) {
    for (const t of c.terms) {
      if (t.kind !== "display" && t.kind !== "designation") continue;
      if (!String(t.lang || "").toLowerCase().startsWith("en")) continue;
      const n = umlsNorm(t.text);
      if (n.length < 2) continue;
      const list = byNorm.get(n) || [];
      list.push(c);
      byNorm.set(n, list);
    }
  }
  if (!byNorm.size) return;
  const keys = [...byNorm.keys()];
  const cuisByNorm = new Map<string, string[]>();
  for (let i = 0; i < keys.length; i += 5000) {
    const r = await pool.query<{ norm: string; cui: string }>("SELECT norm, cui FROM fhir.umls_terms WHERE norm = ANY($1::text[])", [keys.slice(i, i + 5000)]);
    for (const row of r.rows) cuisByNorm.set(row.norm, [...(cuisByNorm.get(row.norm) || []), row.cui]);
  }
  const cuis = new Set<string>();
  for (const [n, cs] of cuisByNorm) if (cs.length <= UMLS_MAX_CUIS_PER_NAME) for (const c of cs) cuis.add(c);
  if (!cuis.size) return;
  const syn = new Map<string, Array<{ str: string; sab: string }>>();
  const all = [...cuis];
  for (let i = 0; i < all.length; i += 5000) {
    const r = await pool.query<{ cui: string; str: string; sab: string }>(
      `SELECT cui, str, sab FROM (
         SELECT cui, str, sab, ROW_NUMBER() OVER (PARTITION BY cui ORDER BY length(str), (sab = 'SNOMEDCT_US') DESC, str) AS rn
           FROM fhir.umls_terms WHERE cui = ANY($1::text[])) x
        WHERE rn <= $2`,
      [all.slice(i, i + 5000), UMLS_SYNONYMS_PER_CUI],
    );
    for (const row of r.rows) syn.set(row.cui, [...(syn.get(row.cui) || []), { str: row.str, sab: row.sab }]);
  }
  for (const [n, cs] of cuisByNorm) {
    if (cs.length > UMLS_MAX_CUIS_PER_NAME) continue;
    for (const concept of byNorm.get(n) || []) {
      const have = new Set(concept.terms.map((t) => umlsNorm(t.text)));
      let added = concept.terms.filter((t) => t.kind === "umls").length;
      for (const cui of cs) {
        for (const s of syn.get(cui) || []) {
          if (added >= UMLS_TERMS_PER_CONCEPT) break;
          const k = umlsNorm(s.str);
          if (!k || have.has(k)) continue;
          have.add(k);
          concept.terms.push({ text: s.str, lang: "en", kind: "umls", source: `umls:${s.sab}:${cui}` });
          added += 1;
        }
      }
    }
  }
}

/** Build / refresh the concept index for installed IG packages. */
export async function buildConceptIndex(pool: pg.Pool, opts: BuildOptions = {}): Promise<BuildStats> {
  const log = async (m: string): Promise<void> => {
    logInfo(m);
    if (opts.log) await opts.log(m);
  };
  const embedMax = opts.embedMaxConcepts ?? DEFAULT_EMBED_MAX_CONCEPTS;
  const stats: BuildStats = {
    packages: 0, codesystems: 0, rebuilt: 0, skipped: 0, concepts: 0, terms: 0, embeddable_terms: 0, supplements_applied: 0, stopped: false,
  };

  const pkgRows = (
    await pool.query<{ package_id: string; version: string }>("SELECT package_id, version FROM fhir.ig_packages ORDER BY package_id, version")
  ).rows.filter((p) => !opts.packages || opts.packages.some((q) => q.package_id === p.package_id && q.version === p.version));
  const supplements = await listSupplements(pool);
  const conceptMaps = await listConceptMaps(pool);
  const umlsStamp = await umlsReleaseStamp(pool);

  for (const p of pkgRows) {
    if (opts.shouldStop && (await opts.shouldStop())) {
      stats.stopped = true;
      break;
    }
    stats.packages += 1;
    const arts = (
      await pool.query<{ artifact_key: string; artifact_id: string | null; url: string | null; version: string | null; content: string | null; imported_at: Date; title: string | null; name: string | null; language: string | null }>(
        `SELECT artifact_key, artifact_id, COALESCE(raw_json->>'url', canonical_url) AS url, raw_json->>'version' AS version,
                raw_json->>'content' AS content, imported_at, title, name, raw_json->>'language' AS language
           FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND resource_type = 'CodeSystem'`,
        [p.package_id, p.version],
      )
    ).rows;
    const keep = new Set<string>();
    let pkgRebuilt = 0;
    for (const a of arts) {
      if (!a.url) continue;
      if (a.content === "supplement" || a.content === "not-present") continue;
      if (routeSystem(a.url, a.artifact_id) !== "ig") continue;
      if (keep.has(a.url)) continue;
      keep.add(a.url);
      stats.codesystems += 1;
      const sups = supplements.filter((s) => supplementApplies(s.supplements, a.url!, a.version));
      const maps = conceptMaps.filter((m) => m.sources.has(a.url!));
      const signature = sha(
        JSON.stringify([
          INDEX_BUILDER_VERSION,
          embedMax,
          a.artifact_key,
          new Date(a.imported_at).toISOString(),
          sups.map((s) => `${s.url}|${s.version}|${s.stamp}`).sort(),
          maps.map((m) => `${m.key}|${m.stamp}`).sort(),
          umlsStamp,
        ]),
      );
      if (!opts.force) {
        const cur = await pool.query<{ signature: string }>(
          "SELECT signature FROM fhir.concept_index_cs WHERE package_id=$1 AND package_version=$2 AND cs_url=$3",
          [p.package_id, p.version, a.url],
        );
        if (cur.rows[0]?.signature === signature) {
          stats.skipped += 1;
          continue;
        }
      }
      const cs = jsonOf(
        (
          await pool.query("SELECT raw_json FROM fhir.artifacts WHERE package_id=$1 AND package_version=$2 AND artifact_key=$3", [
            p.package_id,
            p.version,
            a.artifact_key,
          ])
        ).rows[0]?.raw_json,
      );
      if (!cs) continue;
      const supRefs: SupplementRef[] = [];
      for (const s of sups) {
        const res = await s.load();
        if (res) supRefs.push({ url: s.url, version: s.version, resource: res });
      }
      const concepts = assembleCodeSystem(cs, supRefs);
      // ConceptMap links (any IG ConceptMap whose group source is this CodeSystem).
      for (const m of maps) {
        const cm = await m.load();
        if (!cm) continue;
        const links = conceptMapLinks([cm], a.url);
        for (const c of concepts) {
          const extra = links.get(c.code);
          if (extra) c.links.push(...extra);
        }
      }
      const allLinks = concepts.flatMap((c) => c.links);
      const names = allLinks.length ? await resolveLinkNames(pool, allLinks) : new Map<string, string[]>();
      const embed = concepts.length <= embedMax;
      // UMLS CUI linking (optional store): English names → CUI → that concept's other strings,
      // as low-weight `umls` match terms (never shown, never embedded).
      if (umlsStamp && embed) await addUmlsSynonyms(pool, concepts);

      const cCodes: string[] = [];
      const cDisp: (string | null)[] = [];
      const cInfo: string[] = [];
      const tCode: string[] = [];
      const tTerm: string[] = [];
      const tLang: (string | null)[] = [];
      const tKind: string[] = [];
      const tSrc: (string | null)[] = [];
      const tHash: (string | null)[] = [];
      for (const c of concepts) {
        const linkInfo: Array<{ system: string | null; code: string }> = [];
        const linkNames = new Set<string>();
        for (const l of c.links) {
          if (linkInfo.length < 10) linkInfo.push({ system: l.system, code: l.code });
          for (const n of names.get(`${l.system}|${l.code}`) || []) {
            if (linkNames.size >= LINKS_PER_CONCEPT) break;
            if (!linkNames.has(n)) {
              linkNames.add(n);
              c.terms.push({ text: n, lang: null, kind: "linked", source: `${l.via}:${l.system ?? ""}|${l.code}` });
            }
          }
        }
        if (linkInfo.length) c.info.links = linkInfo;
        cCodes.push(c.code);
        cDisp.push(c.display);
        cInfo.push(JSON.stringify(c.info));
        const seen = new Set<string>();
        for (const t of c.terms) {
          const key = `${t.kind}|${compact(normalizeText(t.text))}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tCode.push(c.code);
          tTerm.push(t.text);
          tLang.push(t.lang ?? null);
          tKind.push(t.kind);
          tSrc.push(t.source ?? null);
          const embeddable =
            embed && EMBED_KINDS.has(t.kind) && t.text.length <= 300 && /[\p{L}]/u.test(t.text) && t.text.trim() !== c.code;
          tHash.push(embeddable ? sha(t.text) : null);
          if (embeddable) stats.embeddable_terms += 1;
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM fhir.concept_index_cs WHERE package_id=$1 AND package_version=$2 AND cs_url=$3", [
          p.package_id,
          p.version,
          a.url,
        ]);
        await client.query(
          `INSERT INTO fhir.concept_index_cs
             (package_id, package_version, cs_url, cs_id, cs_version, title, language, concept_count, term_count, embed, supplements, signature, built_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,NOW())`,
          [
            p.package_id, p.version, a.url, a.artifact_id, a.version, a.title || a.name, a.language,
            concepts.length, tTerm.length, embed,
            JSON.stringify(supRefs.map((s) => ({ url: s.url, version: s.version }))), signature,
          ],
        );
        const fixed = [p.package_id, p.version, a.url];
        await insertUnnest(
          client,
          (u) =>
            "INSERT INTO fhir.concept_index_concepts (package_id, package_version, cs_url, code, display, info) " +
            `SELECT $1, $2, $3, c, d, i::jsonb FROM ${u} AS u(c, d, i)`,
          fixed,
          [cCodes, cDisp, cInfo],
          ["text", "text", "text"],
        );
        await insertUnnest(
          client,
          (u) =>
            "INSERT INTO fhir.concept_index_terms (package_id, package_version, cs_url, code, term, lang, kind, source, text_hash) " +
            `SELECT $1, $2, $3, c, t, l, k, s, h FROM ${u} AS u(c, t, l, k, s, h)`,
          fixed,
          [tCode, tTerm, tLang, tKind, tSrc, tHash],
          ["text", "text", "text", "text", "text", "text"],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      stats.rebuilt += 1;
      pkgRebuilt += 1;
      stats.concepts += concepts.length;
      stats.terms += tTerm.length;
      stats.supplements_applied += supRefs.length;
      if (supRefs.length) await log(`  ${a.url}: merged ${supRefs.length} supplement(s): ${supRefs.map((s) => s.url).join(", ")}`);
    }
    // CodeSystems no longer in the package.
    await pool.query("DELETE FROM fhir.concept_index_cs WHERE package_id=$1 AND package_version=$2 AND NOT (cs_url = ANY($3::text[]))", [
      p.package_id,
      p.version,
      [...keep],
    ]);
    if (pkgRebuilt) await log(`Concept index ${p.package_id}#${p.version}: ${pkgRebuilt} CodeSystem(s) rebuilt`);
  }
  return stats;
}

/**
 * Rebuild fhir.term_thesaurus from the loaded SNOMED CT / LOINC tables (whichever are
 * present). Returns the number of entries written.
 */
export async function buildThesaurus(pool: pg.Pool, log?: (m: string) => void | Promise<void>): Promise<number> {
  const entries = [];
  try {
    const sn = await pool.query<{ term: string }>(
      `SELECT term FROM snomed.descriptions
        WHERE active = TRUE
          AND (term ~ '^[A-Za-z][A-Za-z0-9]{1,7} - ' OR term ~ '^[A-Z][A-Za-z0-9]{1,7} ?\\(' OR term ~ '\\([A-Z][A-Z0-9]{1,7}\\)$')`,
    );
    entries.push(...buildEntries(mineSnomedAcronyms(sn.rows.map((r) => r.term)), "snomed"));
  } catch (err) {
    logWarning("thesaurus: SNOMED CT not available", { error: String((err as Error).message) });
  }
  try {
    const lo = await pool.query<{ shortname: string | null; component: string | null }>(
      "SELECT shortname, component FROM loinc.concepts WHERE shortname IS NOT NULL AND shortname <> ''",
    );
    entries.push(...buildEntries(mineLoincAcronyms(lo.rows), "loinc"));
  } catch (err) {
    logWarning("thesaurus: LOINC not available", { error: String((err as Error).message) });
  }
  try {
    // In-domain abbreviations defined inside the installed IG CodeSystems' own names.
    const ig = await pool.query<{ term: string }>(
      "SELECT DISTINCT term FROM fhir.concept_index_terms WHERE kind IN ('display', 'designation') AND term ~ '[A-Za-z]{2}' AND term LIKE '%(%'",
    );
    entries.push(...buildEntries(mineInlineAcronyms(ig.rows.map((r) => r.term)), "ig"));
  } catch (err) {
    logWarning("thesaurus: IG concept index not available", { error: String((err as Error).message) });
  }
  try {
    // Bilingual word pairs (English word → Chinese word) from names held in both languages.
    const pairs: Array<[string, string]> = [];
    for (const t of ["icd.diagnoses", "icd.procedures"]) {
      try {
        const r = await pool.query<{ zh: string; en: string }>(
          `SELECT name_zh AS zh, name_en AS en FROM ${t} WHERE COALESCE(name_zh, '') <> '' AND COALESCE(name_en, '') <> ''`,
        );
        for (const x of r.rows) pairs.push([x.zh, x.en]);
      } catch {
        /* module not loaded */
      }
    }
    const ig = await pool.query<{ k: string; lang: string | null; term: string }>(
      `SELECT t.package_id || '|' || t.package_version || '|' || t.cs_url || '|' || t.code AS k, t.lang, t.term
         FROM fhir.concept_index_terms t JOIN fhir.concept_index_cs c USING (package_id, package_version, cs_url)
        WHERE c.embed AND t.kind IN ('display', 'designation') AND (t.lang LIKE 'zh%' OR t.lang LIKE 'en%')
        ORDER BY 1`,
    );
    let cur = "";
    let zh: string[] = [];
    let en: string[] = [];
    const flush = (): void => {
      for (const z of zh) for (const e of en) pairs.push([z, e]);
      zh = [];
      en = [];
    };
    for (const r of ig.rows) {
      if (r.k !== cur) {
        flush();
        cur = r.k;
      }
      (String(r.lang).startsWith("zh") ? zh : en).push(r.term);
    }
    flush();
    const bi = mineBilingual(pairs);
    for (const [w, g, d] of bi) entries.push({ abbr: w, expansion: g, source: "bilingual", freq: Math.round(d * 1000) });
    if (log) await log(`Bilingual word pairs mined: ${bi.length} (from ${pairs.length} zh/en names)`);
  } catch (err) {
    logWarning("thesaurus: bilingual mining failed", { error: String((err as Error).message) });
  }
  // Same (abbr, expansion) from several sources: keep the more frequent.
  const byKey = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    const k = `${e.abbr}\u0000${e.expansion}`;
    const prev = byKey.get(k);
    if (!prev || e.freq > prev.freq) byKey.set(k, e);
  }
  const rows = [...byKey.values()];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM fhir.term_thesaurus");
    await insertUnnest(
      client,
      (u) => `INSERT INTO fhir.term_thesaurus (abbr, expansion, source, freq) SELECT a, e, s, f FROM ${u} AS u(a, e, s, f)`,
      [],
      [rows.map((r) => r.abbr), rows.map((r) => r.expansion), rows.map((r) => r.source), rows.map((r) => r.freq)],
      ["text", "text", "text", "int"],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const msg = `Thesaurus rebuilt: ${rows.length} acronym expansions (SNOMED CT / LOINC / IG names)`;
  logInfo(msg);
  if (log) await log(msg);
  return rows.length;
}
