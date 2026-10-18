import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { catalogEntry, validateArchiveMembers, validateCsvColumns, zipMemberNames } from "./adminSources.js";

const zip = (files: Record<string, string>): Buffer =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

test("zipMemberNames lists entries; non-zip input gives null", () => {
  assert.deepEqual(zipMemberNames(zip({ "LoincTable/Loinc.csv": "a", "readme.txt": "b" }))?.sort(), ["LoincTable/Loinc.csv", "readme.txt"]);
  assert.equal(zipMemberNames(Buffer.from([0x1f, 0x8b, 0, 0])), null);
});

test("a release zip without the loader's member is refused at upload", () => {
  assert.throws(() => validateArchiveMembers(zip({ "readme.txt": "x" }), catalogEntry("loinc", "loinc")), /does not contain the expected file \(LoincTable\/Loinc\.csv\)\. Found: readme\.txt/);
  validateArchiveMembers(zip({ "Loinc_2.80/LoincTable/Loinc.csv": "x" }), catalogEntry("loinc", "loinc"));
  validateArchiveMembers(zip({ "SnomedCT/Snapshot/Terminology/sct2_Concept_Snapshot_INT_20250601.txt": "x" }), catalogEntry("snomed", "snomed_ct"));
  assert.throws(() => validateArchiveMembers(zip({ "foo.txt": "x" }), catalogEntry("rxnorm", "rxnorm_full")), /RXNCONSO/);
});

test("CSV sources with expected columns are checked at upload", () => {
  const e = catalogEntry("loinc", "loinc_taiwan_mapping");
  assert.throws(() => validateCsvColumns(Buffer.from("foo,bar\n1,2\n"), e), /missing required column\(s\): loinc_code, name_zh/);
  validateCsvColumns(Buffer.from("﻿loinc_code,name_zh,unit\n2345-7,血糖,mg/dL\n"), e);
});
