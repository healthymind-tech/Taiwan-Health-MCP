/**
 * Bundled verdicts of the reference terminology server (tx.fhir.org, which HL7 validator_cli
 * asks) for external terminologies that are not held locally, restricted to the codes the
 * installed / bundled data already carries (data/terminology/<name>-tx-check.json.gz, built by
 * scripts/supplements/build-tx-atc.mts). No names are bundled: per code only whether the server
 * knows it, and whether an IG ValueSet's display of it is the server's display.
 *
 * Today: WHO ATC (http://www.whocc.no/atc) for the codes of TW Core `medcation-atc-tw` and of the
 * NHI medication supplement's `atc` property (ISSUES_v15.2: an NHI drug outside TW Core 1.0.0's
 * 35-code excerpt is written with its ATC coding instead, which validator_cli accepts only when
 * the server's ATC edition has the code — e.g. ATC 2026 no longer has some 2022 codes).
 * A code outside a table: no verdict (null) — the validator stays silent, as before.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { logWarning } from "./logger.js";

export interface TxCodeVerdict {
  known: boolean;
  /** The server's edition of the terminology (Coding.version / message text, e.g. '2026'). */
  edition: string;
  /** An IG ValueSet's display of the code equals the server's display (case-insensitive). */
  displayVerified: boolean;
}

interface Table {
  edition: string;
  known: Set<string>;
  unknown: Set<string>;
  displayVerified: Set<string>;
}

const FILES: Record<string, string> = { "http://www.whocc.no/atc": "atc-tx-check.json.gz" };

let tables: Map<string, Table | null> | null = null;

function dataDir(): string {
  const env = process.env.BUNDLED_DATA_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  // dev: src/ → ../data; app image: /app/dist → /app/data; worker: /app/node-server/dist → …/data.
  return fileURLToPath(new URL("../data/", import.meta.url));
}

function load(file: string): Table | null {
  try {
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir(), "terminology", file))).toString("utf8"));
    if (!raw || typeof raw.edition !== "string" || !Array.isArray(raw.known) || !Array.isArray(raw.unknown)) return null;
    return {
      edition: raw.edition,
      known: new Set(raw.known.map(String)),
      unknown: new Set(raw.unknown.map(String)),
      displayVerified: new Set((Array.isArray(raw.display_verified) ? raw.display_verified : []).map(String)),
    };
  } catch (e) {
    logWarning("bundled terminology-server table not readable", { file, error: String((e as Error).message) });
    return null;
  }
}

/** Override the tables (tests): system → {edition, known, unknown, displayVerified}; null = reload from disk. */
export function setTxCodeTablesForTest(t: Record<string, { edition: string; known: string[]; unknown: string[]; displayVerified?: string[] }> | null): void {
  if (t === null) {
    tables = null;
    return;
  }
  tables = new Map(
    Object.entries(t).map(([s, v]) => [s, { edition: v.edition, known: new Set(v.known), unknown: new Set(v.unknown), displayVerified: new Set(v.displayVerified ?? []) }]),
  );
}

/** The server's verdict on a code of `system`, or null when the bundled table does not cover it. */
export function txCodeVerdict(system: string, code: string): TxCodeVerdict | null {
  if (!tables) tables = new Map();
  if (!tables.has(system)) {
    const file = FILES[system];
    tables.set(system, file ? load(file) : null);
  }
  const t = tables.get(system);
  if (!t) return null;
  if (t.known.has(code)) return { known: true, edition: t.edition, displayVerified: t.displayVerified.has(code) };
  if (t.unknown.has(code)) return { known: false, edition: t.edition, displayVerified: false };
  return null;
}

// ------------------------------------------------------------------------------------------------ displays

/**
 * ISSUES_v17.5 — the English displays the reference server accepts for codes whose names changed after the
 * locally held release (data/terminology/<name>-tx-display.json.gz, scripts/supplements/build-tx-loinc.mts): LOINC
 * 2.81+ renamed e.g. 30954-2 '… Narrative' → '… note', and the server also accepts LOINC's DisplayName. Used only
 * while the local release is older than the table's edition — an imported newer LOINC is the source again.
 */
const DISPLAY_FILES: Record<string, string> = { "http://loinc.org": "loinc-tx-display.json.gz" };
let displayTables: Map<string, { edition: string; codes: Map<string, string[]> } | null> | null = null;

function loadDisplays(file: string): { edition: string; codes: Map<string, string[]> } | null {
  try {
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir(), "terminology", file))).toString("utf8"));
    if (!raw || typeof raw.edition !== "string" || !raw.codes || typeof raw.codes !== "object") return null;
    return { edition: raw.edition, codes: new Map(Object.entries(raw.codes as Record<string, string[]>).filter(([, v]) => Array.isArray(v) && v.length)) };
  } catch (e) {
    logWarning("bundled terminology-server display table not readable", { file, error: String((e as Error).message) });
    return null;
  }
}

/** Numeric comparison of dotted versions ('2.80' < '2.83'); null when either is not dotted digits. */
function olderVersion(a: string, b: string): boolean | null {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.some((x) => !Number.isFinite(x)) || pb.some((x) => !Number.isFinite(x))) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** The server's displays of `code` (preferred first) when the local release `localEdition` is older; else null. */
export function txDisplays(system: string, code: string, localEdition: string | null): { edition: string; displays: string[] } | null {
  if (!displayTables) displayTables = new Map();
  if (!displayTables.has(system)) {
    const file = DISPLAY_FILES[system];
    displayTables.set(system, file ? loadDisplays(file) : null);
  }
  const t = displayTables.get(system);
  if (!t) return null;
  if (localEdition && olderVersion(localEdition, t.edition) !== true) return null;
  const d = t.codes.get(code);
  return d ? { edition: t.edition, displays: d } : null;
}

/** Override the display tables (tests): system → {edition, codes}; null = reload from disk. */
export function setTxDisplayTablesForTest(t: Record<string, { edition: string; codes: Record<string, string[]> }> | null): void {
  displayTables = t === null ? null : new Map(Object.entries(t).map(([s, v]) => [s, { edition: v.edition, codes: new Map(Object.entries(v.codes)) }]));
}
