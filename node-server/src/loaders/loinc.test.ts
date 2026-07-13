/**
 * Regression coverage for the LOINC Taiwan mapping merge in loinc.ts.
 *
 * Mirrors the intent of PR #25 (which fixed the equivalent Python `KeyError`
 * crash): an uploaded Taiwan mapping CSV that omits the optional
 * `specimen_type` / `unit` columns, and/or has padded (whitespace) headers,
 * must still merge the Chinese names and must never stage `undefined` for the
 * missing optional columns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { buildLoincStagePayload } from "./loinc.js";

test("LOINC mapping tolerates missing optional columns and padded headers", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loinc-map-"));
  try {
    // Minimal main LOINC table (one concept), zipped like Loinc_2.80.zip.
    const loincCsv = "LOINC_NUM,COMPONENT,CLASSTYPE\n1234-5,Glucose,1\n";
    const zipPath = path.join(tmp, "Loinc_2.80.zip");
    fs.writeFileSync(zipPath, zipSync({ "LoincTable/Loinc.csv": strToU8(loincCsv) }));

    // Taiwan mapping with padded headers and NO specimen_type / unit columns.
    const mappingCsv = " loinc_code , name_zh ,common_name_zh \n1234-5,葡萄糖,血糖\n";
    const mappingPath = path.join(tmp, "taiwan_mapping.csv");
    fs.writeFileSync(mappingPath, mappingCsv);

    const payload = buildLoincStagePayload(zipPath, mappingPath, null);

    // Padded headers still matched loinc_code -> the row is counted and merged.
    assert.equal(payload.stats.mapping_row_count, 1);
    assert.equal(payload.stats.mapping_match_count, 1);

    const concept = payload.conceptRows[0];
    assert.equal(concept[13], "葡萄糖"); // name_zh applied despite padded header
    assert.equal(concept[14], "血糖"); // common_name_zh applied
    // Missing optional columns default to "" — never `undefined`.
    assert.equal(concept[15], ""); // specimen_type
    assert.equal(concept[16], ""); // unit
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
