/**
 * IG concept search: free text → ranked codes of one IG CodeSystem.
 *
 * Lexical: an in-memory ConceptIndex per CodeSystem, loaded from fhir.concept_index_*
 * (built by the admin worker) and cached; when a CodeSystem has not been indexed yet it
 * is assembled on the fly from its resource (no supplements / links) with a warning.
 * Semantic: the query vector against the CodeSystem's term vectors (fhir.concept_embeddings,
 * exact scan scoped to the CodeSystem). Hybrid fusion in engine.ts; keyword-only when
 * the provider is down or the CodeSystem has no vectors yet (searchQuality signal).
 */

import { query } from "../db.js";
import { logWarning } from "../logger.js";
import type { EmbeddingService } from "../embeddingService.js";
import * as terminology from "../fhirTerminology.js";
import type { PackageRow } from "../fhirIg.js";
import { assembleCodeSystem } from "./assemble.js";
import { abbreviationWords, ConceptIndex, SENSES, fuse, nearCodes, querySegments, queryWords, type FuseOptions, type PhraseSynonyms, type QueryVariant, prepareQuery, type ConceptInput, type RankedConcept, type SemHit, type TermKind } from "./engine.js";
import { abbreviationKey, applicableExpansions } from "./abbreviations.js";
import { clinicalCore, compact, LATIN_STOP, normalizeText, tokenize, umlsNorm } from "./text.js";
import { Thesaurus, type ThesaurusEntry } from "./thesaurus.js";
import { KEYWORD_ONLY_MODE, KEYWORD_ONLY_NOTE } from "../searchQuality.js";
import { TtlMemo } from "../ttlMemo.js";

export interface CsLocation {
  packageId: string;
  packageVersion: string;
  url: string;
  csId: string | null;
  title: string | null;
  version: string | null;
  artifactKey: string;
}

export interface ConceptCandidate {
  code: string;
  display: string | null;
  matched_term: string | null;
  matched_language: string | null;
  match: "exact" | "lexical" | "semantic" | "hybrid";
  score: number;
  category?: string;
  group?: string;
  siblings?: Array<{ code: string; display: string | null }>;
  /** Codings of other systems the concept links to (Coding properties, e.g. a drug's ATC code); opt-in. */
  linked?: Array<{ system: string; code: string }>;
  linked_more?: number;
}

/** Max linked codings per candidate (search opts.links). */
const MAX_LINKED = 3;

export interface ConceptSearchResult {
  codesystem: { url: string; id: string | null; title: string | null; version: string | null; packageId: string; packageVersion: string };
  candidates: ConceptCandidate[];
  keywordOnly: boolean;
  indexed: boolean;
  warnings: string[];
  /**
   * Multi-item text ("Na/K/Cl", "CBC/DC, Hb …"): the best match of each clause, in text
   * order, when the clauses name different concepts. Lets a caller code every item instead
   * of only the overall best.
   */
  clauses?: Array<{ clause: string; code: string; display: string | null }>;
}

const CACHE_TERM_BUDGET = 800_000;
/** fullerCopy: how much larger another installed copy of a CodeSystem must be to be preferred. */
const FULLER_COPY_FACTOR = 10;
const FULLER_COPY_MIN_EXTRA = 1000;
const FIRST_CLAUSE_BOOST = 0.15;
const RECHECK_MS = 60_000;
const SEM_LIMIT = 200;

/**
 * Process-wide memos of the per-closure CodeSystem resolution (`locate`) and of the
 * fuller-copy lookup. Both are pure functions of installed package content; a package
 * version is immutable once imported, so a TTL only bounds staleness after a re-import
 * of the same version (`locate`) or a rebuild of the concept index (`fullerCopy`, which
 * reads concept_index_cs and therefore re-checks as often as `index()` does).
 */
const LOCATE_TTL_MS = 10 * 60_000;
const locateMemo = new TtlMemo<CsLocation | null>(LOCATE_TTL_MS, 2000);
const fullerCopyMemo = new TtlMemo<FullerCopy | null>(RECHECK_MS, 2000);

export interface FullerCopy {
  location: CsLocation;
  concepts: number;
  ownConcepts: number;
}

interface CacheEntry {
  index: ConceptIndex;
  signature: string;
  checkedAt: number;
  usedAt: number;
}

function cmpVersionDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return y - x;
    if ((pa[i] ?? "") !== (pb[i] ?? "")) return (pb[i] ?? "") < (pa[i] ?? "") ? -1 : 1;
  }
  return 0;
}

/** Texts to embed for a query: its clinical core and, when abbreviations were expanded, that form. */
export function semanticTexts(text: string, variants: QueryVariant[]): Array<{ text: string; penalty: number }> {
  const core = clinicalCore(normalizeText(text)) || text;
  const out = [{ text: core, penalty: 0 }];
  const seen = new Set([core]);
  const push = (t: string | undefined, penalty: number): void => {
    if (!t || seen.has(t) || out.length >= 5) return;
    seen.add(t);
    out.push({ text: t, penalty });
  };
  // At most 3 texts (each costs one embedding): the abbreviation-expanded form, and for
  // multi-clause chart text ("PLT f/u q3d (on heparin, r/o HIT)") its first clause, usually
  // the ordered item; otherwise the second abbreviation reading / the next clause.
  const segs = querySegments(core);
  push(variants.find((v) => v.label === "abbrev_0")?.text ?? variants.find((v) => v.label === "synonym")?.text, 0);
  push(segs[0], 0);
  push(variants.find((v) => v.label === "abbrev_1")?.text, 0.02);
  push(segs[1], 0.03);
  return out.slice(0, 3);
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export class IgConceptSearch {
  private cache = new Map<string, CacheEntry>();
  private thesaurus: { at: number; value: Thesaurus } | null = null;

  constructor(private readonly embeddingSvc: EmbeddingService | null) {}

  // ------------------------------------------------------------------ resolution

  /** The IG CodeSystem a canonical (or bare id) names, best package first within the closure. */
  locate(system: string, pkg: PackageRow): Promise<CsLocation | null> {
    const canonical = system.split("|")[0];
    return locateMemo.get(`${terminology.closureKey(pkg)}|${canonical}`, () => this.locateUncached(canonical, pkg));
  }

  private async locateUncached(canonical: string, pkg: PackageRow): Promise<CsLocation | null> {
    const [pids, pvers] = terminology.closureArrays(pkg);
    const sql = (where: string) =>
      "SELECT a.package_id, a.package_version, a.artifact_key, a.artifact_id, COALESCE(a.raw_json->>'url', a.canonical_url) AS url, " +
      "a.title, a.name, a.raw_json->>'version' AS version, dep.ord, p.fhir_version FROM fhir.artifacts a " +
      "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
      "JOIN fhir.ig_packages p ON p.package_id = a.package_id AND p.version = a.package_version " +
      `WHERE a.resource_type = 'CodeSystem' AND COALESCE(a.raw_json->>'content', '') NOT IN ('supplement', 'not-present') AND ${where}`;
    type Row = { package_id: string; package_version: string; artifact_key: string; artifact_id: string | null; url: string; title: string | null; name: string | null; version: string | null; ord: number; fhir_version: string | null };
    // canonical_url is the resource's own `url` (loaders/ig.ts), so the indexed predicate
    // answers alone; the raw_json form (no index: a scan of every CodeSystem in the closure,
    // ~40x slower) is kept only as the fallback for rows that lack a canonical_url.
    let rows = (await query<Row>(sql("a.canonical_url = $3"), [pids, pvers, canonical])).rows;
    if (!rows.length) rows = (await query<Row>(sql("(a.canonical_url = $3 OR a.raw_json->>'url' = $3)"), [pids, pvers, canonical])).rows;
    if (!rows.length) {
      const tail = terminology.canonicalTail(canonical);
      if (tail && (!canonical.includes("/") || canonical.includes("/CodeSystem/"))) {
        rows = (await query<Row>(sql("a.artifact_id = $3"), [pids, pvers, tail])).rows;
      }
    }
    if (!rows.length) return null;
    const ranked = terminology.rankCandidates(
      canonical,
      rows.map((r) => ({ ...r, packageId: r.package_id, packageVersion: r.package_version, fhirVersion: r.fhir_version, ord: Number(r.ord) })),
    );
    const r = ranked[0];
    return { packageId: r.package_id, packageVersion: r.package_version, url: r.url, csId: r.artifact_id, title: r.title || r.name, version: r.version, artifactKey: r.artifact_key };
  }

  /**
   * Another installed copy of the same CodeSystem canonical that is far larger than `loc`'s
   * (an IG that ships only an excerpt, e.g. TW Core 1.0.0 medication-nhi-tw with 35 of the ~45k
   * NHI drug codes, while TW Core 0.3.2 carries the full list). Larger = at least
   * FULLER_COPY_FACTOR times the concepts and FULLER_COPY_MIN_EXTRA more, both counted in the
   * concept-search index. Null when `loc` is not indexed or no such copy exists.
   */
  fullerCopy(loc: CsLocation): Promise<FullerCopy | null> {
    return fullerCopyMemo.get(`${loc.packageId}#${loc.packageVersion}|${loc.url}`, () => this.fullerCopyUncached(loc));
  }

  private async fullerCopyUncached(loc: CsLocation): Promise<FullerCopy | null> {
    type Row = { package_id: string; package_version: string; concept_count: number };
    const rows = (
      await query<Row>("SELECT package_id, package_version, concept_count FROM fhir.concept_index_cs WHERE cs_url = $1 ORDER BY concept_count DESC", [loc.url])
    ).rows;
    const own = rows.find((r) => r.package_id === loc.packageId && r.package_version === loc.packageVersion);
    if (!own) return null;
    const best = rows.find((r) => !(r.package_id === loc.packageId && r.package_version === loc.packageVersion));
    const n = Number(best?.concept_count ?? 0);
    const m = Number(own.concept_count ?? 0);
    if (!best || n < m * FULLER_COPY_FACTOR || n - m < FULLER_COPY_MIN_EXTRA) return null;
    const a = (
      await query<{ artifact_key: string; artifact_id: string | null; url: string; title: string | null; name: string | null; version: string | null }>(
        "SELECT a.artifact_key, a.artifact_id, COALESCE(a.raw_json->>'url', a.canonical_url) AS url, a.title, a.name, a.raw_json->>'version' AS version " +
          "FROM fhir.artifacts a WHERE a.package_id = $1 AND a.package_version = $2 AND a.resource_type = 'CodeSystem' " +
          "AND (a.canonical_url = $3 OR a.raw_json->>'url' = $3) LIMIT 1",
        [best.package_id, best.package_version, loc.url],
      )
    ).rows[0];
    if (!a) return null;
    return {
      location: { packageId: best.package_id, packageVersion: best.package_version, url: a.url, csId: a.artifact_id, title: a.title || a.name, version: a.version, artifactKey: a.artifact_key },
      concepts: n,
      ownConcepts: m,
    };
  }

  /**
   * Resolve a CodeSystem alias ("nhi_payment", "健保支付", "occupation") against the id /
   * name / title / description of every installed CodeSystem. Every alias token must match;
   * CodeSystems in `pkg`'s closure and manually installed IGs win ties.
   */
  async resolveAlias(alias: string, pkg: PackageRow | null): Promise<{ location: CsLocation | null; alternatives: string[] }> {
    const aliasNorm = normalizeText(alias.replace(/[_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"));
    const atoks = tokenize(aliasNorm).filter((t) => t.k !== "u");
    if (!atoks.length) return { location: null, alternatives: [] };
    type Row = { package_id: string; package_version: string; artifact_key: string; artifact_id: string | null; url: string; title: string | null; name: string | null; description: string | null; version: string | null; install_origin: string | null; is_default: boolean | null };
    const rows = (
      await query<Row>(
        "SELECT a.package_id, a.package_version, a.artifact_key, a.artifact_id, COALESCE(a.raw_json->>'url', a.canonical_url) AS url, a.title, a.name, " +
          "left(a.description, 600) AS description, a.raw_json->>'version' AS version, p.install_origin, p.is_default " +
          "FROM fhir.artifacts a JOIN fhir.ig_packages p ON p.package_id = a.package_id AND p.version = a.package_version " +
          "WHERE a.resource_type = 'CodeSystem' AND COALESCE(a.raw_json->>'content', '') NOT IN ('supplement', 'not-present')",
      )
    ).rows;
    const [cp, cv] = pkg ? terminology.closureArrays(pkg) : [[], []];
    const inClosure = new Set(cp.map((p, i) => `${p}#${cv[i]}`));
    const scored: Array<{ r: Row; s: number }> = [];
    for (const r of rows) {
      if (!r.url || terminology.routeSystem(r.url, r.artifact_id) !== "ig") continue;
      const idText = `${r.artifact_id ?? ""} ${(r.name ?? "").replace(/([a-z])([A-Z])/g, "$1 $2")} ${r.url}`;
      const hay = normalizeText(`${idText} ${r.title ?? ""} ${r.description ?? ""}`.replace(/[_./:-]+/g, " "));
      const hayToks = new Set(tokenize(hay).map((t) => `${t.k}:${t.t}`));
      const idToks = new Set(tokenize(normalizeText(idText.replace(/[_./:-]+/g, " "))).map((t) => `${t.k}:${t.t}`));
      let ok = true;
      let idHits = 0;
      for (const t of atoks) {
        const key = `${t.k}:${t.t}`;
        if (!hayToks.has(key)) {
          ok = false;
          break;
        }
        if (idToks.has(key)) idHits += 1;
      }
      if (!ok) continue;
      let s = idHits / atoks.length;
      if (compact(normalizeText(r.artifact_id ?? "")) === compact(aliasNorm)) s += 2;
      if (inClosure.has(`${r.package_id}#${r.package_version}`)) s += 0.5;
      if (r.install_origin === "manual") s += 0.2;
      if (r.is_default) s += 0.1;
      scored.push({ r, s });
    }
    scored.sort((a, b) => b.s - a.s || cmpVersionDesc(a.r.package_version, b.r.package_version));
    const distinct = [...new Set(scored.map((x) => x.r.url))];
    if (!scored.length) return { location: null, alternatives: [] };
    const top = scored[0].r;
    return {
      location: { packageId: top.package_id, packageVersion: top.package_version, url: top.url, csId: top.artifact_id, title: top.title || top.name, version: top.version, artifactKey: top.artifact_key },
      alternatives: distinct.slice(1, 6),
    };
  }

  // ------------------------------------------------------------------ index cache

  private async loadThesaurus(): Promise<Thesaurus> {
    if (this.thesaurus && Date.now() - this.thesaurus.at < 10 * 60_000) return this.thesaurus.value;
    let rows: ThesaurusEntry[] = [];
    try {
      rows = (await query<ThesaurusEntry>("SELECT abbr, expansion, source, freq FROM fhir.term_thesaurus")).rows;
    } catch {
      rows = [];
    }
    const value = new Thesaurus(rows);
    this.thesaurus = { at: Date.now(), value };
    return value;
  }

  private async indexSignature(loc: CsLocation): Promise<string | null> {
    try {
      const r = await query<{ signature: string }>(
        "SELECT signature FROM fhir.concept_index_cs WHERE package_id=$1 AND package_version=$2 AND cs_url=$3",
        [loc.packageId, loc.packageVersion, loc.url],
      );
      return r.rows[0]?.signature ?? null;
    } catch {
      return null;
    }
  }

  /** The cached in-memory index for a CodeSystem; `indexed` false = assembled from the raw resource. */
  async index(loc: CsLocation): Promise<{ index: ConceptIndex; indexed: boolean }> {
    const key = `${loc.packageId}#${loc.packageVersion}|${loc.url}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.checkedAt < RECHECK_MS) {
      hit.usedAt = now;
      return { index: hit.index, indexed: hit.signature !== "raw" };
    }
    const sig = (await this.indexSignature(loc)) ?? "raw";
    if (hit && hit.signature === sig) {
      hit.checkedAt = now;
      hit.usedAt = now;
      return { index: hit.index, indexed: sig !== "raw" };
    }
    const concepts = sig === "raw" ? await this.rawConcepts(loc) : await this.indexedConcepts(loc);
    const index = new ConceptIndex(concepts);
    this.cache.set(key, { index, signature: sig, checkedAt: now, usedAt: now });
    this.evict();
    return { index, indexed: sig !== "raw" };
  }

  private evict(): void {
    let total = 0;
    for (const e of this.cache.values()) total += e.index.termCount;
    if (total <= CACHE_TERM_BUDGET) return;
    const lru = [...this.cache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [k, e] of lru) {
      if (total <= CACHE_TERM_BUDGET || this.cache.size <= 1) break;
      this.cache.delete(k);
      total -= e.index.termCount;
    }
  }

  private async indexedConcepts(loc: CsLocation): Promise<ConceptInput[]> {
    const params = [loc.packageId, loc.packageVersion, loc.url];
    const cs = await query<{ code: string; display: string | null; info: Record<string, unknown> | null }>(
      "SELECT code, display, info FROM fhir.concept_index_concepts WHERE package_id=$1 AND package_version=$2 AND cs_url=$3",
      params,
    );
    const terms = await query<{ code: string; term: string; lang: string | null; kind: string }>(
      "SELECT code, term, lang, kind FROM fhir.concept_index_terms WHERE package_id=$1 AND package_version=$2 AND cs_url=$3",
      params,
    );
    const by = new Map<string, ConceptInput>();
    for (const r of cs.rows) by.set(r.code, { code: r.code, display: r.display, terms: [], info: r.info });
    for (const t of terms.rows) {
      const c = by.get(t.code);
      if (c) c.terms.push({ text: t.term, lang: t.lang, kind: t.kind as TermKind });
    }
    return [...by.values()];
  }

  private async rawConcepts(loc: CsLocation): Promise<ConceptInput[]> {
    const r = await query<{ raw_json: any }>(
      "SELECT raw_json FROM fhir.artifacts WHERE package_id=$1 AND package_version=$2 AND artifact_key=$3",
      [loc.packageId, loc.packageVersion, loc.artifactKey],
    );
    let cs = r.rows[0]?.raw_json;
    if (typeof cs === "string") cs = JSON.parse(cs);
    if (!cs) return [];
    return assembleCodeSystem(cs).map((c) => ({ code: c.code, display: c.display, terms: c.terms, info: c.info }));
  }

  // ------------------------------------------------------------------ search

  /**
   * Semantic hits for one or more query texts (the clinical core, plus the abbreviation-
   * expanded form when the query has abbreviations — "TKA" embeds poorly, "total knee
   * arthroplasty" well). One embedding call; per term the best similarity is kept.
   */
  private async semantic(loc: CsLocation, texts: Array<{ text: string; penalty: number }>): Promise<{ hits: SemHit[] | null; hasVectors: boolean }> {
    if (!this.embeddingSvc || !texts.length) return { hits: null, hasVectors: false };
    let vecs: (number[] | null)[] = [];
    try {
      vecs = await this.embeddingSvc.embedBatch(texts.map((t) => t.text), "query", "ig_concept");
    } catch {
      vecs = [];
    }
    const usable = vecs
      .map((v, i) => ({ v, penalty: texts[i].penalty }))
      .filter((x): x is { v: number[]; penalty: number } => Array.isArray(x.v) && x.v.length > 0);
    if (!usable.length) return { hits: null, hasVectors: true };
    try {
      // One scan of the CodeSystem's vectors for all query vectors: per term the best
      // (penalised) similarity.
      const params: unknown[] = [loc.packageId, loc.packageVersion, loc.url, SEM_LIMIT];
      const dists = usable.map(({ v }) => {
        params.push(`[${v.join(",")}]`);
        return `(e.embedding <=> $${params.length}::halfvec)`;
      });
      const scored = dists.map((d, i) => `${d} + ${usable[i].penalty}`);
      const rows = (
        await query<{ code: string; term: string; lang: string | null; d: number }>(
          `SELECT t.code, t.term, t.lang, ${scored.length > 1 ? `LEAST(${scored.join(", ")})` : scored[0]} AS d ` +
            "FROM fhir.concept_index_terms t JOIN fhir.concept_embeddings e ON e.text_hash = t.text_hash " +
            "WHERE t.package_id = $1 AND t.package_version = $2 AND t.cs_url = $3 AND t.text_hash IS NOT NULL " +
            "ORDER BY 4 LIMIT $4",
          params,
        )
      ).rows;
      const best = new Map<string, SemHit>();
      for (const r of rows) {
        const k = `${r.code}\u0000${r.term}`;
        if (!best.has(k)) best.set(k, { code: r.code, term: r.term, lang: r.lang, sim: 1 - Number(r.d) });
      }
      const any = rows.length > 0;
      return { hits: [...best.values()].sort((a, b) => b.sim - a.sim), hasVectors: any };
    } catch (err) {
      logWarning("ig concept semantic search failed", { error: String((err as Error).message) });
      return { hits: null, hasVectors: false };
    }
  }

  private umlsState: { at: number; on: boolean } | null = null;

  private async umlsAvailable(): Promise<boolean> {
    if (this.umlsState && Date.now() - this.umlsState.at < 10 * 60_000) return this.umlsState.on;
    let on = false;
    try {
      on = (await query("SELECT 1 FROM fhir.umls_release WHERE id = 1 AND terms > 0")).rows.length > 0;
    } catch {
      on = false;
    }
    this.umlsState = { at: Date.now(), on };
    return on;
  }

  /**
   * Synonyms of query phrases from the optional UMLS store: English word n-grams (longest
   * first) that are UMLS strings → other strings of the same concept (full forms first).
   * Single words only when written like an abbreviation or unknown to the CodeSystem.
   */
  private async umlsSynonyms(text: string, index: ConceptIndex): Promise<PhraseSynonyms[]> {
    if (!(await this.umlsAvailable())) return [];
    const words = umlsNorm(clinicalCore(normalizeText(text))).split(" ").filter(Boolean);
    const abbrevLike = new Set([...abbreviationWords(text)].map((w) => umlsNorm(w)));
    const spans: string[][] = [];
    let cur: string[] = [];
    for (const w of words) {
      if (/^[a-z0-9]+$/.test(w)) cur.push(w);
      else if (cur.length) {
        spans.push(cur);
        cur = [];
      }
    }
    if (cur.length) spans.push(cur);
    const phrases: string[] = [];
    for (const sp of spans) {
      for (let n = Math.min(4, sp.length); n >= 1; n -= 1) {
        for (let i = 0; i + n <= sp.length; i += 1) {
          const g = sp.slice(i, i + n);
          if (LATIN_STOP.has(g[0]) || LATIN_STOP.has(g[g.length - 1]) || !/[a-z]/.test(g.join(""))) continue;
          if (n === 1 && !(abbrevLike.has(g[0]) || (g[0].length >= 4 && !index.hasWord(g[0])))) continue;
          phrases.push(g.join(" "));
        }
      }
    }
    if (!phrases.length) return [];
    try {
      const hits = (
        await query<{ norm: string; cui: string }>("SELECT norm, cui FROM fhir.umls_terms WHERE norm = ANY($1::text[])", [[...new Set(phrases)].slice(0, 60)])
      ).rows;
      const cuisBy = new Map<string, string[]>();
      for (const h of hits) cuisBy.set(h.norm, [...(cuisBy.get(h.norm) || []), h.cui]);
      // Longest phrases first; a phrase inside an already expanded one is skipped.
      const chosen: Array<{ phrase: string; cuis: string[] }> = [];
      for (const p of phrases) {
        const cuis = cuisBy.get(p);
        if (!cuis || cuis.length > 6) continue;
        if (chosen.some((c) => ` ${c.phrase} `.includes(` ${p} `))) continue;
        chosen.push({ phrase: p, cuis: cuis.slice(0, 4) });
        if (chosen.length >= 4) break;
      }
      if (!chosen.length) return [];
      const syn = (
        await query<{ cui: string; str: string }>(
          `SELECT cui, str FROM (
             SELECT cui, str, ROW_NUMBER() OVER (PARTITION BY cui ORDER BY abbr, abs(length(str) - 24), str) AS rn
               FROM fhir.umls_terms WHERE cui = ANY($1::text[])) x WHERE rn <= 4`,
          [[...new Set(chosen.flatMap((c) => c.cuis))]],
        )
      ).rows;
      const strsBy = new Map<string, string[]>();
      for (const r of syn) strsBy.set(r.cui, [...(strsBy.get(r.cui) || []), r.str]);
      return chosen.map((c) => ({
        phrase: c.phrase,
        alternatives: [...new Set(c.cuis.flatMap((cui) => strsBy.get(cui) || []))].filter((x) => umlsNorm(x) !== c.phrase).slice(0, 6),
      }));
    } catch (err) {
      logWarning("UMLS synonym lookup failed", { error: String((err as Error).message) });
      return [];
    }
  }

  private lexiconState: { at: number; on: boolean } | null = null;

  protected async lexiconAvailable(): Promise<boolean> {
    if (this.lexiconState && Date.now() - this.lexiconState.at < 10 * 60_000) return this.lexiconState.on;
    let on = false;
    try {
      on = (await query("SELECT 1 FROM fhir.abbreviation_lexicon LIMIT 1")).rows.length > 0;
    } catch {
      on = false;
    }
    this.lexiconState = { at: Date.now(), on };
    return on;
  }

  /** Abbreviation lexicon rows for lookup keys. */
  protected async lexiconRows(keys: string[]): Promise<Array<{ key: string; abbr: string; expansion: string }>> {
    return (
      await query<{ key: string; abbr: string; expansion: string }>(
        "SELECT key, abbr, expansion FROM fhir.abbreviation_lexicon WHERE key = ANY($1::text[])",
        [keys],
      )
    ).rows;
  }

  /**
   * Candidate expansions of the query's abbreviations from the optional abbreviation lexicon
   * (fhir.abbreviation_lexicon, SPECIALIST LRABR — the bundled copy, or loaded with the UMLS store). Acronyms
   * apply to words written like abbreviations, lower-case clippings ("chole") to words the
   * CodeSystem does not know. The engine ranks the senses against the CodeSystem.
   */
  async lexiconExpansions(text: string, index: ConceptIndex): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!(await this.lexiconAvailable())) return out;
    // Only the head of the text (its first clause) — the ordered item; acronyms in the
    // indication / notes that follow are context, and a wrong general-lexicon sense there
    // would only add noise.
    const full = normalizeText(text);
    const core = clinicalCore(full) || full;
    const words = queryWords(querySegments(core)[0] ?? core).slice(0, 16);
    if (!words.length) return out;
    const abbrevLike = abbreviationWords(text);
    try {
      const rows = await this.lexiconRows([...new Set(words.map(abbreviationKey))]);
      const byKey = new Map<string, Array<{ abbr: string; expansion: string }>>();
      for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) || []), r]);
      for (const w of words) {
        const rs = byKey.get(abbreviationKey(w));
        if (!rs || w.replace(/[^a-z0-9]/g, "").length < SENSES.minLength) continue;
        const exps = applicableExpansions(rs, abbrevLike.has(w), index.hasWord(w));
        if (exps.length) out.set(w, exps);
      }
    } catch (err) {
      logWarning("abbreviation lexicon lookup failed", { error: String((err as Error).message) });
    }
    return out;
  }

  /** Free text → ranked concepts of one IG CodeSystem. */
  async search(loc: CsLocation, text: string, limit: number, opts: { siblings?: boolean; fuse?: FuseOptions; links?: boolean } = {}): Promise<ConceptSearchResult> {
    const warnings: string[] = [];
    const [{ index, indexed }, thesaurus] = await Promise.all([this.index(loc), this.loadThesaurus()]);
    if (!indexed) {
      warnings.push(
        `CodeSystem ${loc.url} is not in the concept-search index yet (run the ig_concept_index job); ` +
          "searching its own displays/designations only",
      );
    }
    const [synonyms, lexicon] = await Promise.all([this.umlsSynonyms(text, index), this.lexiconExpansions(text, index)]);
    const variants = prepareQuery(text, thesaurus, { synonyms, index, lexicon });
    const lex = index.search(variants, Math.max(60, limit * 4));
    const sem = indexed ? await this.semantic(loc, semanticTexts(text, variants)) : { hits: null, hasVectors: false };
    const keywordOnly = !sem.hits || !sem.hasVectors;
    const clauses = this.clauseMatches(index, text, thesaurus);
    let ranked = fuse(index, lex, keywordOnly ? null : sem.hits, Math.max(limit, 20), opts.fuse);
    // Multi-item text: the first clause usually names the ordered item ("PLT f/u (on heparin, r/o HIT)").
    if (clauses) {
      const first = clauses[0].code;
      ranked = ranked.map((r) => (r.code === first ? { ...r, score: r.score + FIRST_CLAUSE_BOOST } : r)).sort((a, b) => b.score - a.score);
    }
    ranked = ranked.slice(0, limit);
    return {
      codesystem: { url: loc.url, id: loc.csId, title: loc.title, version: loc.version, packageId: loc.packageId, packageVersion: loc.packageVersion },
      candidates: ranked.map((r) => this.candidate(index, r, opts.siblings !== false, opts.links === true ? loc.url : null)),
      keywordOnly,
      indexed,
      warnings,
      ...(clauses ? { clauses } : {}),
    };
  }

  /** Lexical best match per clause of a multi-item text (null unless ≥ 2 different concepts). */
  private clauseMatches(index: ConceptIndex, text: string, thesaurus: Thesaurus): ConceptSearchResult["clauses"] | undefined {
    const segs = querySegments(clinicalCore(normalizeText(text)) || normalizeText(text));
    if (segs.length < 2) return undefined;
    const out: Array<{ clause: string; code: string; display: string | null }> = [];
    for (const seg of segs) {
      const top = index.search(prepareQuery(seg, thesaurus), 1)[0];
      if (!top || top.score < 0.5) continue;
      const c = index.conceptAt(top.concept);
      if (!out.some((o) => o.code === c.code)) out.push({ clause: seg, code: c.code, display: c.display });
    }
    return out.length >= 2 ? out : undefined;
  }

  private candidate(index: ConceptIndex, r: RankedConcept, withSiblings: boolean, linksExcept: string | null = null): ConceptCandidate {
    const out: ConceptCandidate = {
      code: r.code,
      display: r.display,
      matched_term: r.matchedTerm,
      matched_language: r.matchedLang,
      match: r.exact ? "exact" : r.source,
      score: round4(r.score),
    };
    const cat = r.info?.category;
    if (typeof cat === "string" && cat) out.category = cat;
    if (linksExcept !== null && Array.isArray(r.info?.links)) {
      const links = (r.info!.links as Array<Record<string, unknown>>)
        .filter((l) => l && typeof l.system === "string" && l.system && l.system !== linksExcept && typeof l.code === "string" && l.code)
        .map((l) => ({ system: String(l.system), code: String(l.code) }));
      if (links.length) {
        out.linked = links.slice(0, MAX_LINKED);
        if (links.length > MAX_LINKED) out.linked_more = links.length - MAX_LINKED;
      }
    }
    if (withSiblings) {
      const ci = index.indexOf(r.code);
      const sib = ci === undefined ? [] : index.siblings(ci, 6);
      if (sib.length) {
        out.group = r.group;
        out.siblings = sib.map((i) => ({ code: index.conceptAt(i).code, display: index.conceptAt(i).display }));
      }
    }
    return out;
  }

  /** Near codes for a code not found in an IG CodeSystem (typos, missing suffix …). */
  async nearCodes(loc: CsLocation, code: string, max = 5): Promise<Array<{ code: string; display: string | null }>> {
    const { index } = await this.index(loc);
    return nearCodes(index.codes(), code, max).map((c) => {
      const ci = index.indexOf(c);
      return { code: c, display: ci === undefined ? null : index.conceptAt(ci).display };
    });
  }
}

export const KEYWORD_ONLY = { mode: KEYWORD_ONLY_MODE, note: KEYWORD_ONLY_NOTE };
