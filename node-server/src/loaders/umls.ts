/**
 * UMLS Metathesaurus → synonym / abbreviation store (fhir.umls_terms) for the IG concept
 * search engine (query expansion + index-time CUI linking). Optional: requires a UMLS
 * licence; without it the engine runs on IG data, SNOMED / LOINC and the lexicon only.
 *
 * Input (uploaded in the admin console, source role ig/umls_metathesaurus):
 *  - the UMLS Metathesaurus release zip (…-metathesaurus-full.zip, ~4 GB) or any zip that
 *    holds META/MRCONSO.RRF + META/MRSAB.RRF — members are streamed straight out of the zip
 *    (ZIP64 aware, no extraction, constant memory);
 *  - or the compact subset this parser writes (`--subset`, gzip text, ~1/5 of MRCONSO):
 *      UMLS-SUBSET|<release>
 *      S|<RSAB>|<SRL>
 *      C|<CUI>|<SAB>|<TTY>|<STR>
 *      A|<abbreviation>|<acronym|abbreviation>|<expansion>     (optional, see below)
 *
 * Optional abbreviation lexicon (fhir.abbreviation_lexicon): the SPECIALIST Lexicon's LRABR
 * table (NLM; LEX/LRABR of a lexicon release, also inside a full UMLS release zip). Read from
 * a LRABR member of the zip, or from the A lines of a subset written with an LRABR file
 * (`--subset <umls.zip> <out.rrf.gz> <LRABR>`). Replaced only when the file carries it.
 *
 * Filter (documented in docs): MRSAB current versions (CURVER=Y) with SRL=0 (no additional
 * licence restrictions) plus SNOMEDCT_US (SNOMED CT licence held), minus vocabularies that
 * are not clinical terminology (gene / protein / taxonomy / anatomy-atlas / spl / code-set
 * sources, see EXCLUDED_SABS); MRCONSO rows LAT=ENG, SUPPRESS=N, STR ≤ 80 chars. Only
 * concepts with ≥ 2 distinct strings are kept (synonymy is the point).
 *
 * UMLS strings are never returned by a tool: they only steer matching (see conceptSearch).
 *
 * Run standalone:
 *   node dist/loaders/umls.js --subset <umls.zip> <out.rrf.gz> [LRABR]   # write the compact subset
 *   node dist/loaders/umls.js <umls.zip | subset.rrf.gz>          # load into DATABASE_URL
 */

import fs from "fs";
import fsp from "fs/promises";
import { StringDecoder } from "string_decoder";
import zlib from "zlib";
import { Readable } from "stream";
import pg from "pg";
import { config } from "../config.js";
import { logInfo, logError, configureLogLevel } from "../logger.js";
import { umlsNorm } from "../conceptSearch/text.js";
import { parseLrabrLine, type AbbreviationRow } from "../conceptSearch/abbreviations.js";

/** Non-clinical SRL-0 vocabularies left out (genes, proteins, taxonomy, atlases, product labels, code sets). */
export const EXCLUDED_SABS = new Set([
  "HGNC", "OMIM", "GO", "NCBI", "LCH", "LCH_NW", "SRC", "MTHMST", "MTHMSTFRE", "MTHMSTITA", "UWDA", "FMA", "MTHSPL",
  "USP", "USPMG", "HL7V2.5", "HL7V3.0", "CDCREC", "MVX", "CVX", "TKMT", "SPN", "MCM", "QMR", "RAM", "CCS",
  "CCSR_ICD10CM", "CCSR_ICD10PCS", "DXP", "ICPC",
]);
/** Licensed beyond SRL 0 but covered by the deployment's SNOMED CT licence. */
export const EXTRA_ALLOWED_SABS = new Set(["SNOMEDCT_US"]);
const MAX_STR = 80;

/** Term types that are abbreviations / acronyms (MRDOC TTY descriptions). */
export const ABBREVIATION_TTYS = new Set(["AB", "ACR", "AA", "AM", "MTH_ACR", "MTH_AB", "AUN", "OA", "OAM", "OAF"]);

export interface UmlsRow {
  cui: string;
  sab: string;
  tty: string;
  str: string;
}

// ---------------------------------------------------------------------------- zip (streaming, ZIP64)

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

/** Random-access byte source (a local file; tests pass a Buffer). */
export interface ByteSource {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Buffer>;
  stream(offset: number, length: number): Readable;
}

export function fileSource(path: string): ByteSource {
  return {
    size: async () => (await fsp.stat(path)).size,
    read: async (offset, length) => {
      const fh = await fsp.open(path, "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
    stream: (offset, length) => fs.createReadStream(path, { start: offset, end: offset + length - 1, highWaterMark: 1 << 20 }),
  };
}

export function bufferSource(buf: Buffer): ByteSource {
  return {
    size: async () => buf.length,
    read: async (offset, length) => buf.subarray(offset, offset + length),
    stream: (offset, length) => Readable.from([buf.subarray(offset, offset + length)]),
  };
}

/** Central directory of a (ZIP64-capable) zip. */
export async function zipEntries(src: ByteSource): Promise<ZipEntry[]> {
  const size = await src.size();
  const tailLen = Math.min(size, 65557 + 20 + 56);
  const tail = await src.read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error("ZIP64 locator missing");
    const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
    const z64 = await src.read(z64Offset, 56);
    if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error("ZIP64 end record missing");
    count = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }
  const cd = await src.read(cdOffset, cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n += 1) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    // ZIP64 extended information (header id 0x0001): only the fields that overflowed, in order.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    out.push({ name, method, compressedSize, size: usize, localHeaderOffset });
    p = eEnd + commentLen;
  }
  return out;
}

/** Decompressed stream of one zip member. */
export async function zipEntryStream(src: ByteSource, entry: ZipEntry): Promise<Readable> {
  const lh = await src.read(entry.localHeaderOffset, 30);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const dataStart = entry.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = src.stream(dataStart, entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
  return raw.pipe(zlib.createInflateRaw({ chunkSize: 1 << 20 }));
}

// ---------------------------------------------------------------------------- RRF parsing (pure)

/**
 * Allowed SABs from MRSAB.RRF lines: current versions with SRL 0, plus EXTRA_ALLOWED_SABS,
 * minus EXCLUDED_SABS. MRSAB columns: 3 RSAB, 13 SRL, 21 CURVER.
 */
export function allowedSabs(mrsabLines: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of mrsabLines) {
    const p = line.split("|");
    if (p.length < 22 || p[21] !== "Y") continue;
    const rsab = p[3];
    const srl = Number(p[13]);
    if (EXCLUDED_SABS.has(rsab)) continue;
    if (srl === 0 || EXTRA_ALLOWED_SABS.has(rsab)) out.set(rsab, srl);
  }
  return out;
}

/**
 * One MRCONSO.RRF line → row, or null when filtered out.
 * Columns: 0 CUI, 1 LAT, 11 SAB, 12 TTY, 14 STR, 16 SUPPRESS.
 */
export function parseMrconsoLine(line: string, allowed: ReadonlyMap<string, number> | ReadonlySet<string>): UmlsRow | null {
  const p = line.split("|");
  if (p.length < 17 || p[1] !== "ENG") return null;
  if (!allowed.has(p[11])) return null;
  if (p[16] !== "N" && p[16] !== "") return null;
  const str = p[14].trim();
  if (!str || str.length > MAX_STR) return null;
  return { cui: p[0], sab: p[11], tty: p[12], str };
}

// ---------------------------------------------------------------------------- readers

export interface UmlsSource {
  release: string;
  sabs: Map<string, number>;
  rows: AsyncIterable<UmlsRow>;
  /** Abbreviation lexicon rows carried by the file (read after `rows`; empty when none). */
  abbreviations: () => AsyncIterable<AbbreviationRow>;
}

/** Deduplicated abbreviation rows of LRABR lines (same rule as conceptSearch/abbreviations lrabrRows). */
export async function* lrabrRowsAsync(lines: AsyncIterable<string>): AsyncGenerator<AbbreviationRow> {
  const seen = new Set<string>();
  for await (const line of lines) {
    const r = parseLrabrLine(line);
    if (!r) continue;
    const k = `${r.abbr}\u0000${umlsNorm(r.expansion)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    yield r;
  }
}

/** One subset A line → row. */
function parseSubsetAbbreviation(p: string[]): AbbreviationRow | null {
  if (p[0] !== "A" || p.length < 4) return null;
  return parseLrabrLine(`|${p[1]}|${p[2]}||${p.slice(3).join("|")}|`);
}

/** Lines of a byte stream (UTF-8, \n or \r\n). Not readline: its async iterator can throw
 * ERR_USE_AFTER_CLOSE when the consumer awaits between lines and the input ends. */
async function* linesOf(stream: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  for await (const chunk of stream) {
    const text = rest + decoder.write(chunk as Buffer);
    const parts = text.split("\n");
    rest = parts.pop() ?? "";
    for (const l of parts) yield l.endsWith("\r") ? l.slice(0, -1) : l;
  }
  rest += decoder.end();
  if (rest) yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
}

async function isGzip(src: ByteSource): Promise<boolean> {
  const head = await src.read(0, 2);
  return head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/** Open a UMLS zip or a subset file (auto-detected). */
export async function openUmls(src: ByteSource, fallbackRelease = "unknown"): Promise<UmlsSource> {
  if (await isGzip(src)) {
    const total = await src.size();
    const lines = linesOf(src.stream(0, total).pipe(zlib.createGunzip()));
    const it = lines[Symbol.asyncIterator]();
    const first = await it.next();
    const header = first.done ? "" : first.value;
    if (!header.startsWith("UMLS-SUBSET|")) throw new Error("gzip file is not a UMLS subset written by this loader");
    const release = header.split("|")[1] || fallbackRelease;
    const sabs = new Map<string, number>();
    const abbreviations: AbbreviationRow[] = [];
    let pending: UmlsRow | null = null;
    // S lines come first; read until the first C line.
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      const p = n.value.split("|");
      if (p[0] === "S") sabs.set(p[1], Number(p[2]));
      else if (p[0] === "A") {
        const a = parseSubsetAbbreviation(p);
        if (a) abbreviations.push(a);
      } else if (p[0] === "C" && p.length >= 5) {
        pending = { cui: p[1], sab: p[2], tty: p[3], str: p.slice(4).join("|") };
        break;
      }
    }
    async function* rows(): AsyncGenerator<UmlsRow> {
      if (pending) yield pending;
      for (;;) {
        const n = await it.next();
        if (n.done) return;
        const p = n.value.split("|");
        if (p[0] === "C" && p.length >= 5 && sabs.has(p[2])) yield { cui: p[1], sab: p[2], tty: p[3], str: p.slice(4).join("|") };
        else if (p[0] === "A") {
          const a = parseSubsetAbbreviation(p);
          if (a) abbreviations.push(a);
        }
      }
    }
    async function* abbrevs(): AsyncGenerator<AbbreviationRow> {
      yield* abbreviations;
    }
    return { release, sabs, rows: rows(), abbreviations: abbrevs };
  }
  const entries = await zipEntries(src);
  const find = (file: string): ZipEntry | undefined => entries.find((e) => e.name.split("/").pop()?.toUpperCase() === file);
  const mrsab = find("MRSAB.RRF");
  const mrconso = find("MRCONSO.RRF");
  const lrabr = find("LRABR");
  if (!mrsab || !mrconso) throw new Error("MRSAB.RRF / MRCONSO.RRF not found in the zip");
  const conso: ZipEntry = mrconso;
  const release = (mrconso.name.match(/(\d{4}A[AB])/) || [])[1] || fallbackRelease;
  const sabLines: string[] = [];
  for await (const l of linesOf(await zipEntryStream(src, mrsab))) sabLines.push(l);
  const sabs = allowedSabs(sabLines);
  async function* rows(): AsyncGenerator<UmlsRow> {
    for await (const line of linesOf(await zipEntryStream(src, conso))) {
      const r = parseMrconsoLine(line, sabs);
      if (r) yield r;
    }
  }
  async function* abbrevs(): AsyncGenerator<AbbreviationRow> {
    if (lrabr) yield* lrabrRowsAsync(linesOf(await zipEntryStream(src, lrabr)));
  }
  return { release, sabs, rows: rows(), abbreviations: abbrevs };
}

/** Abbreviation rows of a plain LRABR file. */
export function lrabrFile(path: string): AsyncIterable<AbbreviationRow> {
  return lrabrRowsAsync(linesOf(fs.createReadStream(path, { highWaterMark: 1 << 20 })));
}

/** Write the compact subset (same filter) — small enough to upload through the admin console. */
export async function writeSubset(src: UmlsSource, outPath: string, extraAbbreviations?: AsyncIterable<AbbreviationRow>): Promise<number> {
  const gz = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(outPath);
  gz.pipe(out);
  const write = (s: string): Promise<void> =>
    new Promise((resolve) => (gz.write(s) ? resolve() : gz.once("drain", () => resolve())));
  await write(`UMLS-SUBSET|${src.release}\n`);
  for (const [sab, srl] of src.sabs) await write(`S|${sab}|${srl}\n`);
  let n = 0;
  for await (const r of src.rows) {
    await write(`C|${r.cui}|${r.sab}|${r.tty}|${r.str}\n`);
    n += 1;
  }
  const seen = new Set<string>();
  for (const it of [src.abbreviations(), extraAbbreviations]) {
    if (!it) continue;
    for await (const a of it) {
      const k = `${a.abbr}\u0000${umlsNorm(a.expansion)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await write(`A|${a.abbr}|${a.kind}|${a.expansion}\n`);
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", reject);
    gz.end();
  });
  return n;
}

// ---------------------------------------------------------------------------- DB load

export interface UmlsLoadStats {
  release: string;
  sabs: string[];
  rows_read: number;
  terms: number;
  concepts: number;
  /** Abbreviation lexicon rows written (null = the file carries none; the table was left as is). */
  abbreviations?: number | null;
  stopped: boolean;
}

/**
 * Stream rows into an UNLOGGED stage table, then replace fhir.umls_terms in one
 * transaction (dedup per (cui, norm), concepts with ≥ 2 distinct strings only).
 */
export async function loadUmls(
  pool: pg.Pool,
  src: UmlsSource,
  opts: { sourceFile?: string; log?: (m: string) => void | Promise<void>; shouldStop?: () => boolean | Promise<boolean> } = {},
): Promise<UmlsLoadStats> {
  const log = async (m: string): Promise<void> => {
    logInfo(m);
    if (opts.log) await opts.log(m);
  };
  await pool.query("DROP TABLE IF EXISTS admin.stage_umls_terms");
  await pool.query("CREATE UNLOGGED TABLE admin.stage_umls_terms (cui TEXT, norm TEXT, str TEXT, sab TEXT, tty TEXT)");
  const BATCH = 10000;
  let cols: string[][] = [[], [], [], [], []];
  let read = 0;
  const flush = async (): Promise<void> => {
    if (!cols[0].length) return;
    await pool.query(
      "INSERT INTO admin.stage_umls_terms (cui, norm, str, sab, tty) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])",
      cols,
    );
    cols = [[], [], [], [], []];
  };
  for await (const r of src.rows) {
    const norm = umlsNorm(r.str);
    if (!norm) continue;
    cols[0].push(r.cui);
    cols[1].push(norm);
    cols[2].push(r.str);
    cols[3].push(r.sab);
    cols[4].push(r.tty);
    read += 1;
    if (cols[0].length >= BATCH) {
      await flush();
      if (read % 500000 < BATCH) {
        await log(`UMLS: ${read.toLocaleString("en-US")} rows staged`);
        if (opts.shouldStop && (await opts.shouldStop())) {
          await pool.query("DROP TABLE IF EXISTS admin.stage_umls_terms");
          return { release: src.release, sabs: [...src.sabs.keys()], rows_read: read, terms: 0, concepts: 0, stopped: true };
        }
      }
    }
  }
  await flush();
  if (read === 0) throw new Error("no UMLS rows passed the filter (wrong file?)");
  // The abbreviation lexicon is small (~10^5 rows): read it whole before the transaction.
  const abbr: string[][] = [[], [], [], []];
  const abbrSeen = new Set<string>();
  for await (const a of src.abbreviations()) {
    const k = `${a.key}\u0000${a.abbr}\u0000${a.expansion}`;
    if (abbrSeen.has(k)) continue;
    abbrSeen.add(k);
    abbr[0].push(a.key);
    abbr[1].push(a.abbr);
    abbr[2].push(a.expansion);
    abbr[3].push(a.kind);
  }
  const lexiconTable = abbr[0].length
    ? Boolean((await pool.query<{ t: string | null }>("SELECT to_regclass('fhir.abbreviation_lexicon')::text AS t")).rows[0]?.t)
    : false;
  if (abbr[0].length && !lexiconTable) await log("UMLS: the file carries an abbreviation lexicon but fhir.abbreviation_lexicon does not exist (apply migration 20261027) — skipped");
  await log(`UMLS: ${read.toLocaleString("en-US")} rows staged; promoting`);
  const client = await pool.connect();
  let terms = 0;
  let concepts = 0;
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE fhir.umls_terms");
    const ins = await client.query(
      `INSERT INTO fhir.umls_terms (cui, norm, str, sab, tty, abbr)
       SELECT DISTINCT ON (s.cui, s.norm) s.cui, s.norm, s.str, s.sab, s.tty, s.tty = ANY($1::text[])
         FROM admin.stage_umls_terms s
         JOIN (SELECT cui FROM admin.stage_umls_terms GROUP BY cui HAVING COUNT(DISTINCT norm) >= 2) m USING (cui)
        ORDER BY s.cui, s.norm, (s.sab = 'SNOMEDCT_US') DESC, (s.sab IN ('MSH', 'MTH', 'NCI', 'LNC')) DESC, s.sab`,
      [[...ABBREVIATION_TTYS]],
    );
    terms = ins.rowCount ?? 0;
    concepts = Number((await client.query("SELECT COUNT(DISTINCT cui) AS n FROM fhir.umls_terms")).rows[0]?.n ?? 0);
    if (lexiconTable) {
      await client.query("TRUNCATE fhir.abbreviation_lexicon");
      for (let i = 0; i < abbr[0].length; i += 10000) {
        await client.query(
          "INSERT INTO fhir.abbreviation_lexicon (key, abbr, expansion, kind, source) SELECT k, a, e, t, 'LRABR' FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS u(k, a, e, t) ON CONFLICT DO NOTHING",
          abbr.map((c) => c.slice(i, i + 10000)),
        );
      }
    }
    await client.query(
      `INSERT INTO fhir.umls_release (id, release, sabs, terms, concepts, source_file, loaded_at)
       VALUES (1, $1, $2::jsonb, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET release = EXCLUDED.release, sabs = EXCLUDED.sabs, terms = EXCLUDED.terms,
         concepts = EXCLUDED.concepts, source_file = EXCLUDED.source_file, loaded_at = NOW()`,
      [src.release, JSON.stringify([...src.sabs.keys()].sort()), terms, concepts, opts.sourceFile ?? null],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.query("DROP TABLE IF EXISTS admin.stage_umls_terms").catch(() => undefined);
  }
  await pool.query("ANALYZE fhir.umls_terms").catch(() => undefined);
  const abbreviations = lexiconTable ? abbr[0].length : null;
  await log(
    `UMLS ${src.release}: ${terms.toLocaleString("en-US")} terms / ${concepts.toLocaleString("en-US")} concepts from ${src.sabs.size} SABs` +
      (abbreviations !== null ? `; abbreviation lexicon: ${abbreviations.toLocaleString("en-US")} rows` : ""),
  );
  return { release: src.release, sabs: [...src.sabs.keys()].sort(), rows_read: read, terms, concepts, abbreviations, stopped: false };
}

async function main(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  const argv = process.argv.slice(2);
  if (argv[0] === "--subset" && (argv.length === 3 || argv.length === 4)) {
    const src = await openUmls(fileSource(argv[1]));
    const n = await writeSubset(src, argv[2], argv[3] ? lrabrFile(argv[3]) : undefined);
    logInfo(`UMLS subset written: ${n} rows → ${argv[2]}`);
    return;
  }
  if (argv.length !== 1) {
    logError("usage: umls.js --subset <umls.zip> <out.rrf.gz> [LRABR] | umls.js <umls.zip | subset.rrf.gz>");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
  try {
    await loadUmls(pool, await openUmls(fileSource(argv[0])), { sourceFile: argv[0] });
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("umls.js")) {
  main().catch((err) => {
    logError("UMLS loader failed", { error: String((err as Error).message) });
    process.exit(1);
  });
}
