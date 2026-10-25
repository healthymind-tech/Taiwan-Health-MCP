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
