/**
 * SNOMED CT International RF2 (Snapshot) loader — Node port of
 * `loader/loaders/snomed_loader.py`.
 *
 * Parses the RF2 Snapshot TSV members of `SnomedCT_InternationalRF2_*.zip` and
 * writes `snomed.concepts / descriptions / relationships / icd10_map /
 * historical_associations`. Field mapping mirrors the Python loader so the
 * loader golden-output diff matches.
 *
 * Notes on fidelity:
 *   - SNOMED component ids are 18-digit and exceed Number.MAX_SAFE_INTEGER, so
 *     every id is carried as a *string* end-to-end (Postgres BIGINT accepts a
 *     numeric string). parseInt would silently corrupt them.
 *   - Python reads via `csv.DictReader(delimiter="\t")` over a TextIOWrapper
 *     (utf-8-sig + universal newlines). We reproduce that exactly: a faithful
 *     csv state machine where `"` only opens a quoted field at field start,
 *     doubled `""` is a literal quote, embedded newlines collapse to `\n`, and a
 *     leading BOM is stripped.
 *
 * Run standalone (bump heap — the Language refset is ~380 MB decompressed):
 *   NODE_OPTIONS=--max-old-space-size=6144 node dist/loaders/snomed.js
 */

import fs from "fs";
import path from "path";
import pg from "pg";
import { unzipSync } from "fflate";
import { config } from "../config.js";
import { logInfo, logError, configureLogLevel } from "../logger.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const FHIR_CODE_DIR = process.env.FHIR_CODE_DIR || path.join(REPO_ROOT, "fhir-code");
const SNOMED_DIR = path.join(FHIR_CODE_DIR, "snomed");

// SNOMED type/refset ids (kept as strings for comparison).
const FSN_TYPE = "900000000000003001";
const SYNONYM_TYPE = "900000000000013009";
const STATED_CHAR = "900000000000010007";
const INFERRED_CHAR = "900000000000011006";
const US_EN_REFSET = "900000000000509007";
const PREFERRED = "900000000000548007";

const BATCH = 5000;
const PARAM_LIMIT = 60000;

// ── Faithful Python-csv TSV row iterator ────────────────────────────────────

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Yield records (arrays of fields) from RF2 TSV text, replicating Python's
 * `csv.reader(delimiter="\t")` over universal-newline text.
 */
function* parseTsvRows(s: string): Generator<string[]> {
  const n = s.length;
  let i = 0;
  let field = "";
  let row: string[] = [];
  // 0=START_FIELD, 1=IN_FIELD, 2=IN_QUOTED, 3=QUOTE_IN_QUOTED
  let state = 0;
  const endRecord = () => {
    row.push(field);
    field = "";
    const r = row;
    row = [];
    state = 0;
    return r;
  };
  while (i < n) {
    const c = s[i];
    if (state === 0) {
      if (c === '"') {
        state = 2;
        i += 1;
      } else if (c === "\t") {
        row.push(field);
        field = "";
        i += 1;
      } else if (c === "\n") {
        yield endRecord();
        i += 1;
      } else if (c === "\r") {
        yield endRecord();
        i += 1;
        if (s[i] === "\n") i += 1;
      } else {
        field += c;
        state = 1;
        i += 1;
      }
    } else if (state === 1) {
      if (c === "\t") {
        row.push(field);
        field = "";
        state = 0;
        i += 1;
      } else if (c === "\n") {
        yield endRecord();
        i += 1;
      } else if (c === "\r") {
        yield endRecord();
        i += 1;
        if (s[i] === "\n") i += 1;
      } else {
        field += c;
        i += 1;
      }
    } else if (state === 2) {
      if (c === '"') {
        state = 3;
        i += 1;
      } else if (c === "\r") {
        // Universal-newline: embedded CR(LF) inside a quoted field → LF.
        field += "\n";
        i += 1;
        if (s[i] === "\n") i += 1;
      } else {
        field += c;
        i += 1;
      }
    } else {
      // QUOTE_IN_QUOTED
      if (c === '"') {
        field += '"';
        state = 2;
        i += 1;
      } else if (c === "\t") {
        row.push(field);
        field = "";
        state = 0;
        i += 1;
      } else if (c === "\n") {
        yield endRecord();
        i += 1;
      } else if (c === "\r") {
        yield endRecord();
        i += 1;
        if (s[i] === "\n") i += 1;
      } else {
        // non-strict (CPython): a closing quote followed by data drops the quote
        // and keeps only the char — `"Linked to" x` → `Linked to x`.
        field += c;
        state = 1;
        i += 1;
      }
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    yield row;
  }
}

/**
 * Rows between event-loop yields. The RF2 parse walks ~5M records; run as one
 * synchronous burst it starves the event loop for over a minute, which stalls
 * the admin worker's heartbeat (`ADMIN_WORKER_STALE_AFTER_SECONDS`, 45s by
 * default) and lets the running job be reclaimed as orphaned. Yielding keeps the
 * worker responsive; at 50k rows that is ~100 pauses — immaterial next to the
 * parse itself.
 */
const YIELD_EVERY_ROWS = 50_000;

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** DictReader: first record is the header; yield header-keyed objects. */
async function* dictRows(text: string): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  let seen = 0;
  for (const rec of parseTsvRows(text)) {
    if (header === null) {
      header = rec;
      continue;
    }
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) obj[header[c]] = rec[c] ?? "";
    seen += 1;
    if (seen % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
    yield obj;
  }
}

// ── zip member resolution ───────────────────────────────────────────────────

type Entries = Record<string, Uint8Array>;

function findMember(entries: Entries, pattern: RegExp): string | null {
  for (const name of Object.keys(entries)) if (pattern.test(name)) return name;
  return null;
}

/** Name of the first member matching any pattern (before it is taken). */
function memberName(entries: Entries, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const name = findMember(entries, p);
    if (name) return name;
  }
  return null;
}

/**
 * Decode the first member matching any pattern, then drop its decompressed bytes
 * from `entries` so the (up to ~380 MB) buffer can be GC'd before the next file.
 */
function takeMember(entries: Entries, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const name = findMember(entries, p);
    if (name) {
      const text = stripBom(Buffer.from(entries[name]).toString("utf-8"));
      delete entries[name];
      return text;
    }
  }
  return null;
}

// ── effectiveTime "YYYYMMDD" → "YYYY-MM-DD" ─────────────────────────────────

// RF2 has only a few dozen distinct effectiveTimes: intern the converted
// strings so millions of rows share them (keeps the worker heap bounded).
const isoDateCache = new Map<string, string>();
function isoDate(yyyymmdd: string): string {
  let v = isoDateCache.get(yyyymmdd);
  if (v === undefined) {
    v = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
    if (isoDateCache.size < 10_000) isoDateCache.set(yyyymmdd, v);
  }
  return v;
}

// ── first release dates from the RF2 Full files ─────────────────────────────

/**
 * Visit (id, effectiveTime) of every data row of an RF2 file (columns: id,
 * effectiveTime, …) by scanning bytes line by line — no decode of the (up to
 * ~380 MB) file into one string.
 */
function scanIdTimes(bytes: Uint8Array, visit: (id: string, yyyymmdd: string) => void): void {
  const n = bytes.length;
  let i = 0;
  // skip the header line
  while (i < n && bytes[i] !== 0x0a) i += 1;
  i += 1;
  while (i < n) {
    const start = i;
    while (i < n && bytes[i] !== 0x09 && bytes[i] !== 0x0a) i += 1;
    if (i >= n || bytes[i] !== 0x09) {
      while (i < n && bytes[i] !== 0x0a) i += 1;
      i += 1;
      continue;
    }
    let id = "";
    for (let k = start; k < i; k += 1) id += String.fromCharCode(bytes[k]);
    const t = i + 1;
    let et = "";
    if (t + 8 <= n) for (let k = t; k < t + 8; k += 1) et += String.fromCharCode(bytes[k]);
    if (/^\d{8}$/.test(et) && /^\d+$/.test(id)) visit(id, et);
    while (i < n && bytes[i] !== 0x0a) i += 1;
    i += 1;
  }
}

/** Ids whose Snapshot row is dated on/after `horizon` (YYYYMMDD): the only ones that can be "recent". */
export function recentIdsFromSnapshot(bytes: Uint8Array, horizon: string): Set<string> {
  const out = new Set<string>();
  scanIdTimes(bytes, (id, et) => {
    if (et >= horizon) out.add(id);
  });
  return out;
}

/**
 * id → earliest effectiveTime ('YYYY-MM-DD') over every row of an RF2 Full
 * file, optionally only for `only` ids. Used to answer for an older edition: a
 * component first released after it did not exist there.
 */
export function firstReleasedFromFull(bytes: Uint8Array, only: Set<string> | null = null): Map<string, string> {
  const out = new Map<string, string>();
  scanIdTimes(bytes, (id, et) => {
    if (only && !only.has(id)) return;
    const iso = isoDate(et);
    const prev = out.get(id);
    if (prev === undefined || iso < prev) out.set(id, iso);
  });
  return out;
}

/**
 * first_released is recorded for components whose Snapshot row is younger than
 * this many years before the release; older ones (NULL) were released before
 * that horizon — long before any edition tx.fhir.org still serves.
 */
export const FIRST_RELEASED_HORIZON_YEARS = 3;

// ── per-file parsers (mirror the Python *_from_zip helpers) ─────────────────
//
// The Python helpers build a "latest effectiveTime per id" map before applying
// the active/type filters. For an RF2 **Snapshot** release (which this loader
// targets) there is exactly one row per id, so that map is a no-op — we stream
// the filters directly into the final row arrays. This keeps memory bounded
// (the Language refset alone is ~380 MB) and yields output identical to Python.

type Cell = string | number | boolean | null;

async function parseConcepts(
  text: string,
  firstReleased: Map<string, string> | null = null,
): Promise<{ rows: Cell[][]; loaded: Set<string>; inactiveRows: Cell[][]; inactive: Set<string> }> {
  const rows: Cell[][] = [];
  const loaded = new Set<string>();
  const inactiveRows: Cell[][] = [];
  const inactive = new Set<string>();
  for await (const row of dictRows(text)) {
    if (row["active"] !== "1") {
      // Inactive concepts go to snomed.inactive_concepts (validator only:
      // tx.fhir.org reports them as INACTIVE_CONCEPT_FOUND, not unknown).
      inactive.add(row["id"]);
      inactiveRows.push([row["id"], isoDate(row["effectiveTime"]), row["moduleId"], firstReleased?.get(row["id"]) ?? null]);
      continue;
    }
    loaded.add(row["id"]);
    rows.push([
      row["id"],
      isoDate(row["effectiveTime"]),
      true,
      row["moduleId"],
      row["definitionStatusId"],
      firstReleased?.get(row["id"]) ?? null,
    ]);
  }
  return { rows, loaded, inactiveRows, inactive };
}

async function parseUsPreferred(text: string): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const row of dictRows(text)) {
    if (row["active"] === "1" && row["refsetId"] === US_EN_REFSET && row["acceptabilityId"] === PREFERRED) {
      out.add(row["referencedComponentId"]);
    }
  }
  return out;
}

async function parseDescriptions(
  text: string,
  loaded: Set<string>,
  usPreferred: Set<string>,
  inactiveConcepts: Set<string> = new Set(),
  firstReleased: Map<string, string> | null = null,
): Promise<{ rows: Cell[][]; otherRows: Cell[][] }> {
  const rows: Cell[][] = [];
  // English FSN / synonyms not kept in snomed.descriptions: inactive
  // descriptions of active concepts and every description of an inactive
  // concept (description_id, concept_id, type_id, term, active, effective_time, first_released).
  const otherRows: Cell[][] = [];
  for await (const row of dictRows(text)) {
    if (row["languageCode"] !== "en") continue;
    const ttype = row["typeId"];
    if (ttype !== FSN_TYPE && ttype !== SYNONYM_TYPE) continue;
    const cid = row["conceptId"];
    const active = row["active"] === "1";
    if (active && loaded.has(cid)) {
      const did = row["id"];
      rows.push([did, cid, ttype, row["term"], true, "en", usPreferred.has(did), firstReleased?.get(did) ?? null]);
    } else if (loaded.has(cid) || inactiveConcepts.has(cid)) {
      otherRows.push([
        row["id"],
        cid,
        ttype,
        row["term"],
        active,
        isoDate(row["effectiveTime"]),
        firstReleased?.get(row["id"]) ?? null,
      ]);
    }
  }
  return { rows, otherRows };
}

/** RF2 release date ('2025-06-01') from a member name like `sct2_Concept_Snapshot_INT_20250601.txt`. */
export function snomedReleaseDate(memberName: string | null): string | null {
  const m = memberName ? /_(\d{8})\.txt$/i.exec(memberName) : null;
  return m ? isoDate(m[1]) : null;
}

/**
 * SQL recording the loaded SNOMED CT edition (params: module_id, version_date,
 * concept_count, inactive_concept_count). includes_inactive = TRUE: this loader
 * keeps inactive concepts / descriptions (snomed.inactive_*).
 */
export const SNOMED_EDITION_UPSERT_SQL = `
  INSERT INTO snomed.editions (code_system, module_id, version_date, includes_inactive, concept_count, inactive_concept_count, loaded_at)
  VALUES ('snomed', $1, $2::date, TRUE, $3::integer, $4::integer, NOW())
  ON CONFLICT (code_system) DO UPDATE SET
    module_id = EXCLUDED.module_id, version_date = EXCLUDED.version_date,
    includes_inactive = EXCLUDED.includes_inactive, concept_count = EXCLUDED.concept_count,
    inactive_concept_count = EXCLUDED.inactive_concept_count, loaded_at = NOW()`;

/** International edition module (the only edition this loader imports). */
export const SNOMED_INT_MODULE = "900000000000207008";

/**
 * Rebuild snomed.concept_ancestors (migration 20261028) — the transitive closure of the active
 * is-a relationships, one row per concept with its proper ancestors — from snomed.concepts /
 * snomed.relationships as they stand. Simple-query multi-statement (no parameters), meant to run
 * inside the import transaction right after the relationships are written: ~30 s and ~80 MB for
 * the International edition (7.4 M ancestor links). The table is created when the migration has
 * not been applied, so an import also brings an older database up to date.
 *
 * The relationships were just bulk-inserted (no statistics, secondary indexes possibly dropped),
 * so the table is analyzed and nested loops are disabled for the recursion: both sides of its
 * join are CTE scans, and a nested loop over them would be quadratic.
 *
 * Used by search_snomed_concept's hierarchy_filter (terminologyRanking.rankSnomed).
 */
export const SNOMED_ANCESTORS_REBUILD_SQL = `
  CREATE TABLE IF NOT EXISTS snomed.concept_ancestors (
    concept_id   BIGINT PRIMARY KEY,
    ancestor_ids BIGINT[] NOT NULL
  );
  TRUNCATE snomed.concept_ancestors;
  ANALYZE snomed.relationships;
  SET LOCAL work_mem = '256MB';
  SET LOCAL enable_nestloop = off;
  INSERT INTO snomed.concept_ancestors (concept_id, ancestor_ids)
  WITH RECURSIVE isa AS MATERIALIZED (
    SELECT source_id AS s, destination_id AS d FROM snomed.relationships
     WHERE type_id = 116680003 AND active = TRUE AND source_id <> destination_id
  ),
  closure (s, d) AS (
    SELECT s, d FROM isa
    UNION
    SELECT c.s, i.d FROM closure c JOIN isa i ON i.s = c.d
  )
  SELECT k.concept_id, COALESCE(array_agg(c.d ORDER BY c.d) FILTER (WHERE c.d IS NOT NULL), '{}'::bigint[])
    FROM snomed.concepts k LEFT JOIN closure c ON c.s = k.concept_id
   GROUP BY k.concept_id;
  RESET enable_nestloop;
  RESET work_mem;
  ANALYZE snomed.concept_ancestors;`;

async function parseRelationships(text: string, loaded: Set<string>): Promise<Cell[][]> {
  const rows: Cell[][] = [];
  for await (const row of dictRows(text)) {
    const charType = row["characteristicTypeId"];
    if (charType !== STATED_CHAR && charType !== INFERRED_CHAR) continue;
    if (row["active"] !== "1") continue;
    const src = row["sourceId"];
    const dst = row["destinationId"];
    if (!loaded.has(src) || !loaded.has(dst)) continue;
    rows.push([row["id"], src, dst, row["typeId"], true, charType]);
  }
  return rows;
}

async function parseAssociations(text: string, loaded: Set<string>): Promise<Cell[][]> {
  const rows: Cell[][] = [];
  const seen = new Set<string>();
  for await (const row of dictRows(text)) {
    if (row["active"] !== "1") continue;
    const target = row["targetComponentId"];
    if (!loaded.has(target)) continue; // successor must be loaded & active
    const ref = row["referencedComponentId"];
    const refset = row["refsetId"];
    const key = `${ref}\t${target}\t${refset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([ref, target, refset]);
  }
  return rows;
}

async function parseIcd10Map(text: string, loaded: Set<string>): Promise<Cell[][]> {
  const rows: Cell[][] = [];
  for await (const row of dictRows(text)) {
    if (row["active"] !== "1") continue;
    const target = row["mapTarget"] ?? "";
    if (!target) continue;
    const ref = row["referencedComponentId"];
    if (!loaded.has(ref)) continue;
    const prio = parseInt(row["mapPriority"] ?? "", 10);
    const grp = parseInt(row["mapGroup"] ?? "", 10);
    rows.push([
      ref,
      target,
      row["mapRule"] ?? "",
      row["mapAdvice"] ?? "",
      Number.isNaN(prio) ? 1 : prio,
      Number.isNaN(grp) ? 1 : grp,
      true,
    ]);
  }
  return rows;
}

// ── DB write helper ─────────────────────────────────────────────────────────

async function batchInsert(
  client: pg.PoolClient,
  head: string,
  tail: string,
  ncols: number,
  rows: Cell[][],
): Promise<void> {
  const batchRows = Math.min(BATCH, Math.floor(PARAM_LIMIT / ncols));
  for (let i = 0; i < rows.length; i += batchRows) {
    const slice = rows.slice(i, i + batchRows);
    const values: string[] = [];
    const params: Cell[] = [];
    slice.forEach((rec, ri) => {
      values.push(`(${rec.map((_, ci) => `$${ri * ncols + ci + 1}`).join(",")})`);
      params.push(...rec);
    });
    await client.query(`${head} VALUES ${values.join(",")} ${tail}`, params);
  }
}

// ── Staged-import payload (Node port of admin_jobs._build_snomed_stage_payload) ─
// Parse-only extraction of loadSnomed: returns the five row-tuple lists (rather
// than writing tables) so the admin worker can stage → promote them. Memory is
// bounded the same way (only the six Snapshot members are decompressed, each
// freed via takeMember after parsing).

export interface SnomedStagePayload {
  conceptRows: Cell[][];
  descriptionRows: Cell[][];
  relationshipRows: Cell[][];
  icd10MapRows: Cell[][];
  associationRows: Cell[][];
  /** (concept_id, effective_time, module_id) of inactive concepts. */
  inactiveConceptRows: Cell[][];
  /** (description_id, concept_id, type_id, term, active, effective_time) — see parseDescriptions. */
  inactiveDescriptionRows: Cell[][];
  /** Release date of the snapshot ('2025-06-01'), or null when not derivable. */
  releaseDate: string | null;
}

/** Faithful port of `_build_snomed_stage_payload`. */
export async function buildSnomedStagePayload(zipPath: string): Promise<SnomedStagePayload> {
  const needed =
    /(sct2_Concept_Snapshot_INT|sct2_Description_Snapshot-en_INT|sct2_Relationship_Snapshot_INT|der2_cRefset_LanguageSnapshot-en_INT|der2_cRefset_AssociationSnapshot_INT|der2_iisssccRefset_ExtendedMapSnapshot_INT|sct2_Concept_Full_INT|sct2_Description_Full-en_INT)/i;
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)), {
    filter: (f) => needed.test(f.name),
  });

  // First release dates (Full files) for recently changed components only,
  // taken first so the Full buffers are freed before the Snapshot members are
  // decoded. Without Full files the dates stay NULL.
  const snapConcept = findMember(entries, /Snapshot\/Terminology\/sct2_Concept_Snapshot_INT/i);
  const snapDesc = findMember(entries, /Snapshot\/Terminology\/sct2_Description_Snapshot-en_INT/i);
  const rel = snomedReleaseDate(snapConcept);
  const horizon = rel ? `${Number(rel.slice(0, 4)) - FIRST_RELEASED_HORIZON_YEARS}${rel.slice(5, 7)}${rel.slice(8, 10)}` : "00000000";
  const recent = new Set<string>();
  for (const name of [snapConcept, snapDesc]) {
    if (name) for (const id of recentIdsFromSnapshot(entries[name], horizon)) recent.add(id);
  }
  const firstReleased = new Map<string, string>();
  for (const re of [/Full\/Terminology\/sct2_Concept_Full_INT/i, /Full\/Terminology\/sct2_Description_Full-en_INT/i]) {
    const name = findMember(entries, re);
    if (!name) continue;
    for (const [k, v] of firstReleasedFromFull(entries[name], recent)) firstReleased.set(k, v);
    delete entries[name];
    await yieldToEventLoop();
  }
  recent.clear();
  const fr = firstReleased.size ? firstReleased : null;

  const conceptPatterns = [/Snapshot\/Terminology\/sct2_Concept_Snapshot_INT/i, /Full\/Terminology\/sct2_Concept_Full_INT/i];
  const releaseDate = snomedReleaseDate(memberName(entries, conceptPatterns));
  const conceptText = takeMember(entries, conceptPatterns);
  if (!conceptText) throw new Error("Concept file not found in SNOMED zip");
  const { rows: conceptRows, loaded, inactiveRows: inactiveConceptRows, inactive } = await parseConcepts(conceptText, fr);

  const langText = takeMember(entries, [
    /Snapshot\/Refset\/Language\/der2_cRefset_LanguageSnapshot-en_INT/i,
    /Full\/Refset\/Language\/der2_cRefset_LanguageFull-en_INT/i,
  ]);
  const usPreferred = langText ? await parseUsPreferred(langText) : new Set<string>();

  const descText = takeMember(entries, [
    /Snapshot\/Terminology\/sct2_Description_Snapshot-en_INT/i,
    /Full\/Terminology\/sct2_Description_Full-en_INT/i,
  ]);
  if (!descText) throw new Error("Description file not found in SNOMED zip");
  const { rows: descriptionRows, otherRows: inactiveDescriptionRows } = await parseDescriptions(
    descText,
    loaded,
    usPreferred,
    inactive,
    fr,
  );

  const relText = takeMember(entries, [
    /Snapshot\/Terminology\/sct2_Relationship_Snapshot_INT/i,
    /Full\/Terminology\/sct2_Relationship_Full_INT/i,
  ]);
  if (!relText) throw new Error("Relationship file not found in SNOMED zip");
  const relationshipRows = await parseRelationships(relText, loaded);

  const mapText = takeMember(entries, [
    /Snapshot\/Refset\/Map\/der2_iisssccRefset_ExtendedMapSnapshot_INT/i,
    /Full\/Refset\/Map\/der2_iisssccRefset_ExtendedMapFull_INT/i,
  ]);
  const icd10MapRows = mapText ? await parseIcd10Map(mapText, loaded) : [];

  const assocText = takeMember(entries, [
    /Snapshot\/Refset\/Content\/der2_cRefset_AssociationSnapshot_INT/i,
    /Full\/Refset\/Content\/der2_cRefset_AssociationFull_INT/i,
  ]);
  const associationRows = assocText ? await parseAssociations(assocText, loaded) : [];

  return {
    conceptRows,
    descriptionRows,
    relationshipRows,
    icd10MapRows,
    associationRows,
    inactiveConceptRows,
    inactiveDescriptionRows,
    releaseDate,
  };
}

// ── main loader ─────────────────────────────────────────────────────────────

export async function loadSnomed(pool: pg.Pool, zipPath: string): Promise<void> {
  logInfo(`Parsing ${zipPath} ...`);
  logInfo("  (This may take several minutes for the International edition)");

  // Decompress only the Snapshot members we use (the full release is >1 GB).
  const needed =
    /(sct2_Concept_Snapshot_INT|sct2_Description_Snapshot-en_INT|sct2_Relationship_Snapshot_INT|der2_cRefset_LanguageSnapshot-en_INT|der2_cRefset_AssociationSnapshot_INT|der2_iisssccRefset_ExtendedMapSnapshot_INT)/i;
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)), {
    filter: (f) => needed.test(f.name),
  });

  // Parse each member then free its bytes (takeMember deletes the entry) so the
  // big refset buffers don't accumulate. Concepts first — their id set gates the
  // FK-style filters on every other table.
  logInfo("  Loading concepts ...");
  const conceptText = takeMember(entries, [
    /Snapshot\/Terminology\/sct2_Concept_Snapshot_INT/i,
    /Full\/Terminology\/sct2_Concept_Full_INT/i,
  ]);
  if (!conceptText) throw new Error("Concept file not found in SNOMED zip");
  const { rows: conceptRows, loaded } = await parseConcepts(conceptText);
  logInfo(`  ${conceptRows.length} active concepts (inactive content is kept by the staged admin import only)`);

  logInfo("  Loading preferred terms (Language refset) ...");
  const langText = takeMember(entries, [
    /Snapshot\/Refset\/Language\/der2_cRefset_LanguageSnapshot-en_INT/i,
    /Full\/Refset\/Language\/der2_cRefset_LanguageFull-en_INT/i,
  ]);
  if (!langText) logError("  WARNING: Language refset not found — preferred terms unavailable.");
  const usPreferred = langText ? await parseUsPreferred(langText) : new Set<string>();
  logInfo(`  ${usPreferred.size} US-preferred descriptions`);

  logInfo("  Loading descriptions ...");
  const descText = takeMember(entries, [
    /Snapshot\/Terminology\/sct2_Description_Snapshot-en_INT/i,
    /Full\/Terminology\/sct2_Description_Full-en_INT/i,
  ]);
  if (!descText) throw new Error("Description file not found in SNOMED zip");
  const { rows: descRows } = await parseDescriptions(descText, loaded, usPreferred);
  logInfo(`  ${descRows.length} active English descriptions`);

  logInfo("  Loading relationships ...");
  const relText = takeMember(entries, [
    /Snapshot\/Terminology\/sct2_Relationship_Snapshot_INT/i,
    /Full\/Terminology\/sct2_Relationship_Full_INT/i,
  ]);
  if (!relText) throw new Error("Relationship file not found in SNOMED zip");
  const relRows = await parseRelationships(relText, loaded);
  logInfo(`  ${relRows.length} active relationships`);

  logInfo("  Loading ICD-10 extended map ...");
  const mapText = takeMember(entries, [
    /Snapshot\/Refset\/Map\/der2_iisssccRefset_ExtendedMapSnapshot_INT/i,
    /Full\/Refset\/Map\/der2_iisssccRefset_ExtendedMapFull_INT/i,
  ]);
  if (!mapText) logError("  WARNING: ICD-10 extended map file not found — skipping map load.");
  const mapRows = mapText ? await parseIcd10Map(mapText, loaded) : [];
  logInfo(`  ${mapRows.length} ICD-10 map entries`);

  logInfo("  Loading historical associations ...");
  const assocText = takeMember(entries, [
    /Snapshot\/Refset\/Content\/der2_cRefset_AssociationSnapshot_INT/i,
    /Full\/Refset\/Content\/der2_cRefset_AssociationFull_INT/i,
  ]);
  if (!assocText) logError("  WARNING: Association refset not found — skipping historical map.");
  const assocRows = assocText ? await parseAssociations(assocText, loaded) : [];
  logInfo(`  ${assocRows.length} active historical associations`);

  logInfo("  Writing to database ...");
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS snomed.historical_associations (
        referenced_component_id BIGINT NOT NULL,
        target_component_id     BIGINT NOT NULL,
        refset_id               BIGINT NOT NULL,
        PRIMARY KEY (referenced_component_id, target_component_id, refset_id)
      );
      CREATE INDEX IF NOT EXISTS idx_snomed_hist_assoc_ref
        ON snomed.historical_associations (referenced_component_id);
      ALTER TABLE snomed.descriptions
        ADD COLUMN IF NOT EXISTS us_preferred BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await client.query("BEGIN");
    await client.query(
      "TRUNCATE snomed.historical_associations, snomed.icd10_map, " +
        "snomed.relationships, snomed.descriptions, snomed.concepts CASCADE",
    );

    logInfo("  Inserting concepts ...");
    await batchInsert(
      client,
      "INSERT INTO snomed.concepts (concept_id, effective_time, active, module_id, definition_status_id, first_released)",
      "ON CONFLICT (concept_id) DO UPDATE SET effective_time=EXCLUDED.effective_time, active=EXCLUDED.active, module_id=EXCLUDED.module_id, definition_status_id=EXCLUDED.definition_status_id",
      6,
      conceptRows,
    );

    logInfo("  Inserting descriptions ...");
    await batchInsert(
      client,
      "INSERT INTO snomed.descriptions (description_id, concept_id, type_id, term, active, language_code, us_preferred, first_released)",
      "ON CONFLICT (description_id) DO UPDATE SET concept_id=EXCLUDED.concept_id, type_id=EXCLUDED.type_id, term=EXCLUDED.term, active=EXCLUDED.active, us_preferred=EXCLUDED.us_preferred",
      8,
      descRows,
    );

    logInfo("  Inserting relationships ...");
    await batchInsert(
      client,
      "INSERT INTO snomed.relationships (relationship_id, source_id, destination_id, type_id, active, characteristic_type_id)",
      "ON CONFLICT (relationship_id) DO UPDATE SET source_id=EXCLUDED.source_id, destination_id=EXCLUDED.destination_id, type_id=EXCLUDED.type_id, active=EXCLUDED.active",
      6,
      relRows,
    );

    if (mapRows.length) {
      logInfo("  Inserting ICD-10 map ...");
      await batchInsert(
        client,
        "INSERT INTO snomed.icd10_map (referenced_component_id, map_target, map_rule, map_advice, map_priority, map_group, active)",
        "",
        7,
        mapRows,
      );
    }

    if (assocRows.length) {
      logInfo("  Inserting historical associations ...");
      await batchInsert(
        client,
        "INSERT INTO snomed.historical_associations (referenced_component_id, target_component_id, refset_id)",
        "ON CONFLICT DO NOTHING",
        3,
        assocRows,
      );
    }

    logInfo("  Building is-a ancestor closure ...");
    await client.query(SNOMED_ANCESTORS_REBUILD_SQL);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  logInfo(
    `  SNOMED CT loaded: ${conceptRows.length} concepts, ${descRows.length} descriptions, ` +
      `${relRows.length} relationships, ${mapRows.length} ICD-10 map entries, ` +
      `${assocRows.length} historical associations.`,
  );

  await pool.query(
    `INSERT INTO admin.module_load_log (module_key, last_loaded_at, row_count)
     VALUES ('snomed', NOW(), $1)
     ON CONFLICT (module_key) DO UPDATE SET last_loaded_at=NOW(), row_count=$1`,
    [conceptRows.length],
  );
}

function firstGlob(dir: string, test: (n: string) => boolean): string | null {
  if (!fs.existsSync(dir)) return null;
  const matches = fs.readdirSync(dir).filter(test).sort();
  return matches.length ? path.join(dir, matches[0]) : null;
}

async function main(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  const zipPath =
    process.env.SNOMED_ZIP ||
    firstGlob(SNOMED_DIR, (n) => /SnomedCT_InternationalRF2.*\.zip$/i.test(n));
  if (!zipPath || !fs.existsSync(zipPath)) {
    logError(`SNOMED zip not found in ${SNOMED_DIR}`);
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  try {
    await loadSnomed(pool, zipPath);
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("snomed.js");
if (invokedDirectly) {
  main().catch((err) => {
    logError("SNOMED loader failed", { error: String((err as Error).message) });
    process.exit(1);
  });
}
