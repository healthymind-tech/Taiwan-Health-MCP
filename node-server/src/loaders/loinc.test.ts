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
import {
  buildLoincStagePayload,
  forEachCsvRow,
  parseLoincAnswerListItems,
  parseLoincAnswerListLinks,
  parseLoincMapTo,
  parseLoincPartLinks,
  parsePanelItems,
} from "./loinc.js";

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

test("forEachCsvRow handles quotes, escaped quotes, embedded newlines, CRLF and BOM", () => {
  const rows: string[][] = [];
  forEachCsvRow('\ufeff"a","b,c"\r\n"x ""y""","line1\nline2"\n plain ,\n', (cells) => rows.push(cells));
  assert.deepEqual(rows, [
    ["a", "b,c"],
    ['x "y"', "line1\nline2"],
    [" plain ", ""],
  ]);
});

test("parseLoincPartLinks keeps primary links and dedupes on the PK", () => {
  const csv = [
    '"LoincNumber","LongCommonName","PartNumber","PartName","PartCodeSystem","PartTypeName","LinkTypeName","Property"',
    '"2345-7","Glucose [Mass/volume] in Serum or Plasma","LP14635-4","Glucose","http://loinc.org","COMPONENT","Primary",""',
    '"2345-7","Glucose [Mass/volume] in Serum or Plasma","LP6827-2","MCnc","http://loinc.org","PROPERTY","Primary",""',
    '"2345-7","dup","LP6827-2","MCnc","http://loinc.org","PROPERTY","Primary",""',
    '"2345-7","x","LP999-9","Other","http://loinc.org","SYSTEM","Supplementary",""',
  ].join("\n");
  assert.deepEqual(parseLoincPartLinks(csv), [
    ["2345-7", "COMPONENT", "LP14635-4", "Glucose"],
    ["2345-7", "PROPERTY", "LP6827-2", "MCnc"],
  ]);
});

test("parseLoincAnswerListItems skips externally defined lists", () => {
  const csv = [
    '"AnswerListId","AnswerListName","AnswerStringId","SequenceNumber","DisplayText","Score"',
    '"LL1-1","Yes/No","LA33-6","1","Yes","1"',
    '"LL1-1","Yes/No","LA32-8","2","No",""',
    '"LL1-1","Yes/No","LA32-8","3","No again",""',
    '"LL2-2","External","","","",""',
  ].join("\n");
  assert.deepEqual(parseLoincAnswerListItems(csv), [
    ["LL1-1", 1, "LA33-6", "Yes", "1"],
    ["LL1-1", 2, "LA32-8", "No", null],
  ]);
});

test("parseLoincAnswerListLinks keeps context in the key", () => {
  const csv = [
    '"LoincNumber","LongCommonName","AnswerListId","AnswerListName","AnswerListLinkType","ApplicableContext"',
    '"100-1","x","LL1-1","n","NORMATIVE",""',
    '"100-1","x","LL1-1","n","EXAMPLE","200-2"',
    '"100-1","x","LL1-1","n","NORMATIVE",""',
  ].join("\n");
  assert.deepEqual(parseLoincAnswerListLinks(csv), [
    ["100-1", "LL1-1", "NORMATIVE", ""],
    ["100-1", "LL1-1", "EXAMPLE", "200-2"],
  ]);
});

test("parsePanelItems uses the immediate parent, skips self rows, keeps the lowest seq", () => {
  const csv = [
    '"ParentId","ParentLoinc","ParentName","ID","SEQUENCE","Loinc","LoincName","DisplayNameForForm","ObservationRequiredInPanel"',
    '"1","24323-8","CMP","1","1","24323-8","CMP","",""',
    '"1","24323-8","CMP","2","2","2345-7","Glucose","","R"',
    '"1","24323-8","CMP","3","3","24326-1","Lytes Pnl","Electrolytes",""',
    '"3","24326-1","Lytes Pnl","4","5","2951-2","Sodium","","R"',
    '"9","24326-1","Lytes Pnl","10","2","2951-2","Sodium","","R"',
  ].join("\n");
  assert.deepEqual(parsePanelItems(csv), [
    ["24323-8", 2, "2345-7", "Glucose", "R"],
    ["24323-8", 3, "24326-1", "Electrolytes", null],
    ["24326-1", 2, "2951-2", "Sodium", "R"],
  ]);
});

test("parseLoincMapTo", () => {
  assert.deepEqual(parseLoincMapTo('"LOINC","MAP_TO","COMMENT"\n"1009-0","1007-4",""\n"1-1","2-2","see"\n'), [
    ["1009-0", "1007-4", null],
    ["1-1", "2-2", "see"],
  ]);
});

test("structure rows are empty when the zip lacks the accessory members", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loinc-struct-"));
  try {
    const zipPath = path.join(tmp, "Loinc.zip");
    fs.writeFileSync(
      zipPath,
      zipSync({
        "LoincTable/Loinc.csv": strToU8("LOINC_NUM,COMPONENT,CLASSTYPE\n1234-5,Glucose,1\n"),
        "LoincTable/MapTo.csv": strToU8('"LOINC","MAP_TO","COMMENT"\n"1234-5","9999-9",""\n'),
      }),
    );
    const { structure } = buildLoincStagePayload(zipPath, null, null);
    assert.deepEqual(structure.partLinkRows, []);
    assert.deepEqual(structure.answerListItemRows, []);
    assert.deepEqual(structure.answerListLinkRows, []);
    assert.deepEqual(structure.panelItemRows, []);
    assert.deepEqual(structure.mapToRows, [["1234-5", "9999-9", null]]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("COMMON_TEST_RANK / COMMON_ORDER_RANK become columns 17/18 (0 or blank → null)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loinc-rank-"));
  try {
    const csv = "LOINC_NUM,COMPONENT,CLASSTYPE,COMMON_TEST_RANK,COMMON_ORDER_RANK\n718-7,Hemoglobin,1,17,66\n1234-5,Glucose,1,0,\n";
    const zipPath = path.join(tmp, "Loinc_2.80.zip");
    fs.writeFileSync(zipPath, zipSync({ "LoincTable/Loinc.csv": strToU8(csv) }));
    const rows = buildLoincStagePayload(zipPath, null, null).conceptRows;
    assert.equal(rows[0].length, 19);
    assert.deepEqual(rows[0].slice(17), [17, 66]);
    assert.deepEqual(rows[1].slice(17), [null, null]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
