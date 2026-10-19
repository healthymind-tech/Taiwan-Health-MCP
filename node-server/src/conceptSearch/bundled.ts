/**
 * Reference data bundled with the code (node-server/data/, see data/README.md) and applied
 * automatically by the admin worker, so a fresh install gets them through the normal admin
 * flow (import an IG → done) without uploads or manual DB writes:
 *
 * - CodeSystem supplements (data/supplements/*.json.gz): every one whose `supplements`
 *   canonical names a CodeSystem of an installed package is written to
 *   fhir.codesystem_supplements (uploaded_by = 'system:bundled') right before the concept
 *   index is built — by ig_import and by ig_concept_index. Idempotent: a supplement whose
 *   url+version is already stored (whoever stored it) is left alone; a stored *different*
 *   version uploaded by an operator is never overwritten (an older bundled version is
 *   upgraded); an operator who deleted a bundled supplement has opted out (admin.app_settings
 *   group 'bundled_supplements', key = url) and it does not come back until restored.
 * - The abbreviation lexicon (data/abbreviations/*.tsv.gz, SPECIALIST Lexicon LRABR rows
 *   already filtered like the UMLS loader keeps them): loaded into fhir.abbreviation_lexicon
 *   only while that table is empty. A UMLS file carrying LRABR (umls_import) still replaces it.
 *
 * Neither changes the concept-index signature of a CodeSystem that already has the same
 * rows, so an install that already holds them (uploaded by hand) sees no rebuild and no
 * re-embedding.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type pg from "pg";
import { logWarning } from "../logger.js";
import { parseLrabrLine, type AbbreviationRow } from "./abbreviations.js";
import { checkSupplement, packagesHoldingCodeSystems, writeSupplementRow, type Db } from "./supplements.js";

const gunzip = promisify(zlib.gunzip);

/** uploaded_by of a bundled supplement row. */
export const BUNDLED_ORIGIN = "system:bundled";
/** admin.app_settings group of the operator's opt-outs (key = supplement url). */
export const OPT_OUT_GROUP = "bundled_supplements";
/** fhir.abbreviation_lexicon.source prefix of rows loaded from the bundled file. */
export const BUNDLED_LEXICON_SOURCE_PREFIX = "bundled:";

/**
 * node-server/data — resolved from this module so it works in every layout: dev
 * (src/conceptSearch → ../../data), the app image (/app/dist/conceptSearch → /app/data) and
 * the worker image (/app/node-server/dist/conceptSearch → /app/node-server/data).
 * BUNDLED_DATA_DIR overrides it.
 */
export function bundledDataDir(): string {
  const env = process.env.BUNDLED_DATA_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  return fileURLToPath(new URL("../../data/", import.meta.url));
}

async function readMaybeGz(file: string): Promise<Buffer> {
  const buf = await fsp.readFile(file);
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzip(buf) : buf;
}

// ──────────────────────────────────────────────────────────────── supplements

export interface BundledSupplement {
  file: string;
  url: string;
  version: string;
  supplements: string;
  name: string | null;
  title: string | null;
  conceptCount: number;
  load: () => Promise<Record<string, unknown>>;
}

const supplementCache = new Map<string, Promise<BundledSupplement[]>>();

/** Bundled supplements in `dir`/supplements (metadata cached per process; resources loaded on demand). */
export function listBundledSupplements(dir: string = bundledDataDir()): Promise<BundledSupplement[]> {
  let p = supplementCache.get(dir);
  if (!p) {
    p = scanSupplements(path.join(dir, "supplements"));
    supplementCache.set(dir, p);
    p.catch(() => supplementCache.delete(dir));
  }
  return p;
}

async function scanSupplements(sdir: string): Promise<BundledSupplement[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(sdir)).filter((n) => /\.json(\.gz)?$/i.test(n)).sort();
  } catch {
    return [];
  }
  const out: BundledSupplement[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const file = path.join(sdir, n);
    let res: unknown;
    try {
      res = JSON.parse((await readMaybeGz(file)).toString("utf8").replace(/^﻿/, ""));
    } catch (err) {
      logWarning("bundled supplement unreadable — skipped", { file: n, error: String((err as Error).message) });
      continue;
    }
    const chk = checkSupplement(res);
    if (!chk.ok) {
      logWarning("bundled supplement invalid — skipped", { file: n, error: chk.error });
      continue;
    }
    const key = `${chk.url}|${chk.version ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      file: n,
      url: chk.url!,
      version: chk.version ?? "",
      supplements: chk.supplements!,
      name: chk.name ?? null,
      title: chk.title ?? null,
      conceptCount: chk.conceptCount ?? 0,
      load: async () => JSON.parse((await readMaybeGz(file)).toString("utf8").replace(/^﻿/, "")) as Record<string, unknown>,
    });
  }
  return out;
}

export type BundledAction = "insert" | "upgrade" | "present" | "opted_out" | "conflict" | "target_missing";

export interface StoredSupplementRow {
  url: string;
  version: string;
  uploaded_by: string;
}

export interface BundledPlanEntry {
  url: string;
  version: string;
  supplements: string;
  action: BundledAction;
  /** Stored row(s) behind the decision: the conflicting operator version(s) / the bundled versions upgraded. */
  versions?: string[];
  /** The row present with the same url+version was not stored by the bundled apply. */
  storedBy?: string;
}

/** Does an installed CodeSystem (url, version) satisfy a `supplements` canonical "url[|version]"? */
function targetInstalled(canonical: string, installed: Array<{ url: string; version: string | null }>): boolean {
  const [url, ver] = canonical.split("|");
  return installed.some((c) => c.url === url && (!ver || c.version === ver));
}

/**
 * What to do with each bundled supplement (pure). Order of the rules: operator opt-out →
 * already stored (same url+version, anyone's) → another version stored by an operator
 * (never overwritten) → target CodeSystem not installed → older bundled version (upgrade) →
 * insert.
 */
export function planBundledSupplements(input: {
  bundled: Array<Pick<BundledSupplement, "url" | "version" | "supplements">>;
  stored: StoredSupplementRow[];
  optedOut: ReadonlySet<string>;
  installed: Array<{ url: string; version: string | null }>;
}): BundledPlanEntry[] {
  return input.bundled.map((b) => {
    const base = { url: b.url, version: b.version, supplements: b.supplements };
    if (input.optedOut.has(b.url)) return { ...base, action: "opted_out" };
    const same = input.stored.find((s) => s.url === b.url && (s.version ?? "") === b.version);
    if (same) return { ...base, action: "present", ...(same.uploaded_by !== BUNDLED_ORIGIN ? { storedBy: same.uploaded_by } : {}) };
    const others = input.stored.filter((s) => s.url === b.url);
    const foreign = others.filter((s) => s.uploaded_by !== BUNDLED_ORIGIN);
    if (foreign.length) return { ...base, action: "conflict", versions: foreign.map((s) => s.version) };
    if (!targetInstalled(b.supplements, input.installed)) return { ...base, action: "target_missing" };
    if (others.length) return { ...base, action: "upgrade", versions: others.map((s) => s.version) };
    return { ...base, action: "insert" };
  });
}

/** The operator's opt-outs (supplement urls). Missing table → none. */
export async function readOptOuts(db: Db): Promise<Set<string>> {
  try {
    const r = await db.query<{ key: string }>("SELECT key FROM admin.app_settings WHERE group_key = $1", [OPT_OUT_GROUP]);
    return new Set(r.rows.map((x) => x.key));
  } catch {
    return new Set();
  }
}

/** Remember that the operator removed a bundled supplement (it is not re-applied). */
export async function recordOptOut(db: Db, url: string, version: string, user: string): Promise<void> {
  await db.query(
    `INSERT INTO admin.app_settings (group_key, key, value, updated_by, updated_at) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (group_key, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [OPT_OUT_GROUP, url, JSON.stringify({ version, deleted_at: new Date().toISOString() }), user],
  );
}

/** Drop opt-outs (one url, or all). Returns the urls restored. */
export async function clearOptOuts(db: Db, url?: string): Promise<string[]> {
  const r = url
    ? await db.query<{ key: string }>("DELETE FROM admin.app_settings WHERE group_key = $1 AND key = $2 RETURNING key", [OPT_OUT_GROUP, url])
    : await db.query<{ key: string }>("DELETE FROM admin.app_settings WHERE group_key = $1 RETURNING key", [OPT_OUT_GROUP]);
  return r.rows.map((x) => x.key);
}

/** Current plan against the database (no writes). Null when the supplements table is missing. */
export async function bundledSupplementPlan(db: Db, bundled?: BundledSupplement[]): Promise<BundledPlanEntry[] | null> {
  const list = bundled ?? (await listBundledSupplements());
  if (!list.length) return [];
  let stored: StoredSupplementRow[];
  try {
    stored = (
      await db.query<StoredSupplementRow>(
        "SELECT url, version, uploaded_by FROM fhir.codesystem_supplements WHERE url = ANY($1::text[])",
        [list.map((b) => b.url)],
      )
    ).rows;
  } catch {
    return null; // migration 20261022 not applied
  }
  const targets = [...new Set(list.map((b) => b.supplements.split("|")[0]))];
  const installed = (
    await db.query<{ url: string; version: string | null }>(
      `SELECT DISTINCT COALESCE(raw_json->>'url', canonical_url) AS url, raw_json->>'version' AS version
         FROM fhir.artifacts
        WHERE resource_type = 'CodeSystem' AND COALESCE(raw_json->>'content', '') <> 'supplement'
          AND COALESCE(raw_json->>'url', canonical_url) = ANY($1::text[])`,
      [targets],
    )
  ).rows;
  return planBundledSupplements({ bundled: list, stored, optedOut: await readOptOuts(db), installed });
}

export interface BundledApplyResult {
  applied: Array<{ url: string; version: string; supplements: string }>;
  plan: BundledPlanEntry[];
  /** Installed packages whose concept index the applied supplements touch. */
  packages: Array<{ package_id: string; version: string }>;
}

/**
 * Write every applicable bundled supplement (see planBundledSupplements). Run by the worker
 * before it builds the concept index. Never throws for a single bad file (logged, skipped).
 */
export async function applyBundledSupplements(
  db: Db,
  opts: { bundled?: BundledSupplement[]; log?: (m: string) => void | Promise<void> } = {},
): Promise<BundledApplyResult> {
  const log = async (m: string): Promise<void> => {
    if (opts.log) await opts.log(m);
  };
  const list = opts.bundled ?? (await listBundledSupplements());
  const plan = (await bundledSupplementPlan(db, list)) ?? [];
  const applied: BundledApplyResult["applied"] = [];
  for (const e of plan) {
    if (e.action !== "insert" && e.action !== "upgrade") continue;
    const b = list.find((x) => x.url === e.url && x.version === e.version)!;
    let res: Record<string, unknown>;
    try {
      res = await b.load();
    } catch (err) {
      await log(`Bundled supplement ${b.file} unreadable: ${(err as Error).message} — skipped`);
      continue;
    }
    const chk = checkSupplement(res);
    if (!chk.ok || chk.url !== e.url || (chk.version ?? "") !== e.version) {
      await log(`Bundled supplement ${b.file} changed on disk or is invalid (${chk.error ?? "url/version mismatch"}) — skipped`);
      continue;
    }
    if (e.action === "upgrade") {
      await db.query("DELETE FROM fhir.codesystem_supplements WHERE url = $1 AND uploaded_by = $2 AND version <> $3", [e.url, BUNDLED_ORIGIN, e.version]);
    }
    if (await writeSupplementRow(db, chk, res, BUNDLED_ORIGIN, "keep")) {
      applied.push({ url: e.url, version: e.version, supplements: e.supplements });
      await log(
        `Bundled CodeSystem supplement applied: ${e.url}|${e.version} → ${e.supplements} (${chk.conceptCount} concepts)` +
          (e.action === "upgrade" ? ` (replaces bundled version ${(e.versions ?? []).join(", ")})` : ""),
      );
    }
  }
  const skipped = plan.filter((e) => e.action === "opted_out" || e.action === "conflict");
  for (const e of skipped) {
    await log(
      e.action === "opted_out"
        ? `Bundled supplement ${e.url} not applied: removed by an administrator (restore it on the IG page → 術語搜尋索引)`
        : `Bundled supplement ${e.url}|${e.version} not applied: an uploaded version (${(e.versions ?? []).join(", ")}) is kept`,
    );
  }
  const packages = applied.length ? await packagesHoldingCodeSystems(db, applied.map((a) => a.supplements)) : [];
  return { applied, plan, packages };
}

// ──────────────────────────────────────────────────────────── abbreviation lexicon

export interface BundledLexicon {
  file: string;
  /** Release label from the file header ("#LRABR\t<release>"). */
  release: string;
  rows: AbbreviationRow[];
}

/**
 * Parse a bundled lexicon file: header "#LRABR<TAB><release>", then "abbr<TAB>kind<TAB>expansion"
 * rows. Every row goes through the same LRABR filter as the UMLS loader; duplicates collapse.
 */
export function parseBundledLexicon(text: string, file = ""): BundledLexicon {
  const lines = text.split(/\r?\n/);
  let release = "unknown";
  const rows: AbbreviationRow[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = /^#LRABR\t(.+)$/.exec(line);
      if (m) release = m[1].trim();
      continue;
    }
    const [abbr, kind, expansion] = line.split("\t");
    if (!abbr || !kind || !expansion) continue;
    const r = parseLrabrLine(`|${abbr}|${kind}||${expansion}|`);
    if (!r) continue;
    const k = `${r.key}\u0000${r.abbr}\u0000${r.expansion}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(r);
  }
  return { file, release, rows };
}

/** The bundled lexicon file (the last *.tsv.gz in data/abbreviations by name), or null. */
export async function readBundledLexicon(dir: string = bundledDataDir()): Promise<BundledLexicon | null> {
  const adir = path.join(dir, "abbreviations");
  let names: string[] = [];
  try {
    names = (await fsp.readdir(adir)).filter((n) => /\.tsv(\.gz)?$/i.test(n)).sort();
  } catch {
    return null;
  }
  const n = names.at(-1);
  if (!n) return null;
  return parseBundledLexicon((await readMaybeGz(path.join(adir, n))).toString("utf8"), n);
}

/** Release label of the bundled lexicon without loading it into the DB (for the status API). */
export async function bundledLexiconInfo(dir: string = bundledDataDir()): Promise<{ file: string; release: string } | null> {
  const adir = path.join(dir, "abbreviations");
  try {
    const n = (await fsp.readdir(adir)).filter((x) => /\.tsv(\.gz)?$/i.test(x)).sort().at(-1);
    if (!n) return null;
    const head = (await readMaybeGz(path.join(adir, n))).subarray(0, 200).toString("utf8").split("\n")[0];
    const m = /^#LRABR\t(.+)$/.exec(head);
    return { file: n, release: m ? m[1].trim() : "unknown" };
  } catch {
    return null;
  }
}

export interface LexiconEnsureResult {
  loaded: boolean;
  reason: "loaded" | "present" | "no_table" | "no_file";
  rows?: number;
  release?: string;
}

/**
 * Load the bundled abbreviation lexicon when fhir.abbreviation_lexicon is empty (sync
 * correctness: the file is parsed fully first, then written in one transaction that re-checks
 * the table is still empty).
 */
export async function ensureBundledAbbreviationLexicon(
  pool: Pick<pg.Pool, "query" | "connect">,
  opts: { dir?: string; log?: (m: string) => void | Promise<void> } = {},
): Promise<LexiconEnsureResult> {
  const log = async (m: string): Promise<void> => {
    if (opts.log) await opts.log(m);
  };
  const t = await pool.query<{ t: string | null }>("SELECT to_regclass('fhir.abbreviation_lexicon')::text AS t");
  if (!t.rows[0]?.t) {
    await log("Abbreviation lexicon: table fhir.abbreviation_lexicon missing (apply migration 20261027) — bundled lexicon not loaded");
    return { loaded: false, reason: "no_table" };
  }
  if ((await pool.query("SELECT 1 FROM fhir.abbreviation_lexicon LIMIT 1")).rows.length) return { loaded: false, reason: "present" };
  const lex = await readBundledLexicon(opts.dir);
  if (!lex || !lex.rows.length) return { loaded: false, reason: "no_file" };
  const source = `${BUNDLED_LEXICON_SOURCE_PREFIX}LRABR-${lex.release}`;
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE fhir.abbreviation_lexicon IN SHARE ROW EXCLUSIVE MODE");
    if ((await client.query("SELECT 1 FROM fhir.abbreviation_lexicon LIMIT 1")).rows.length) {
      await client.query("ROLLBACK");
      return { loaded: false, reason: "present" };
    }
    for (let i = 0; i < lex.rows.length; i += 10000) {
      const part = lex.rows.slice(i, i + 10000);
      const r = await client.query(
        `INSERT INTO fhir.abbreviation_lexicon (key, abbr, expansion, kind, source)
         SELECT k, a, e, t, $5 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS u(k, a, e, t) ON CONFLICT DO NOTHING`,
        [part.map((x) => x.key), part.map((x) => x.abbr), part.map((x) => x.expansion), part.map((x) => x.kind), source],
      );
      written += r.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await log(`Abbreviation lexicon: loaded ${written.toLocaleString("en-US")} bundled SPECIALIST LRABR rows (${lex.release}, ${lex.file})`);
  return { loaded: true, reason: "loaded", rows: written, release: lex.release };
}

