import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import {
  dottedIcd10cm,
  expandTabular,
  icd10cmEdition,
  parseCmsOrderTxt,
  parseIcd10cmRelease,
} from "./icd.js";
import { icd10cmStrict } from "../fhirValidationResolver.js";

// Lines copied from the CMS April 1, 2026 icd10cm_order_2026.txt layout.
const pad = (s: string, n: number): string => s.padEnd(n, " ");
const orderLine = (n: number, raw: string, flag: string, short: string, long: string): string =>
  `${String(n).padStart(5, "0")} ${pad(raw, 7)} ${flag} ${pad(short, 60)} ${long}`;
const ORDER = [
  orderLine(1, "S93", "0", "Disloc & sprain of joints & ligaments at ankl, ft & toe lev", "Dislocation and sprain of joints and ligaments at ankle, foot and toe level"),
  orderLine(2, "S93411", "0", "Sprain of calcaneofibular ligament of right ankle", "Sprain of calcaneofibular ligament of right ankle"),
  orderLine(3, "S93411A", "1", "Sprain of calcaneofibular ligament of right ankle, init", "Sprain of calcaneofibular ligament of right ankle, initial encounter"),
  orderLine(4, "QA0", "0", "Genetic disorders, NEC", "Neurodevelopmental disorders related to specific genetic pathogenic variants"),
  orderLine(5, "A09", "1", "Infectious gastroenteritis and colitis, unspecified", "Infectious gastroenteritis and colitis, unspecified"),
].join("\r\n");

test("dottedIcd10cm inserts the dot after the category", () => {
  assert.equal(dottedIcd10cm("S93411A"), "S93.411A");
  assert.equal(dottedIcd10cm("A09"), "A09");
  assert.equal(dottedIcd10cm("QA00101"), "QA0.0101");
  assert.equal(dottedIcd10cm("S93.411A"), "S93.411A");
});

test("parseCmsOrderTxt keeps headers and billable codes with short + long titles", () => {
  const rows = parseCmsOrderTxt(ORDER);
  assert.deepEqual(rows.map((r) => r.code), ["S93", "S93.411", "S93.411A", "QA0", "A09"]);
  const s = rows.find((r) => r.code === "S93.411A")!;
  assert.equal(s.isHeader, false);
  assert.equal(s.nameEn, "Sprain of calcaneofibular ligament of right ankle, initial encounter");
  assert.equal(s.shortNameEn, "Sprain of calcaneofibular ligament of right ankle, init");
  assert.equal(rows.find((r) => r.code === "S93.411")!.isHeader, true);
});

const XML = `<?xml version="1.0" encoding="utf-8"?>
<ICD10CM.tabular><version>2026</version>
<chapter><name>19</name><section id="S00-S09">
<diag><name>S06</name><desc>Intracranial injury</desc>
  <sevenChrDef><extension char="A">initial encounter</extension><extension char="D">subsequent encounter</extension></sevenChrDef>
  <diag><name>S06.0X</name><desc>Concussion</desc>
    <diag><name>S06.0X0</name><desc>Concussion without loss of consciousness</desc></diag>
  </diag>
  <diag><name>S06.1</name><desc>Traumatic cerebral edema</desc></diag>
</diag>
<diag><name>C84.1</name><desc>S&#233;zary disease</desc></diag>
</section></chapter></ICD10CM.tabular>`;

test("expandTabular expands 7th characters with the placeholder X and folds diacritics", () => {
  const t = expandTabular(XML);
  const codes = new Map(t.codes.map((c) => [c.code, c]));
  assert.equal(t.version, "2026");
  assert.equal(codes.get("S06.0X0A")!.nameEn, "Concussion without loss of consciousness, initial encounter");
  assert.equal(codes.get("S06.0X0")!.isHeader, true);
  assert.ok(codes.has("S06.1XXD"));
  assert.ok(!codes.has("S06.0XA"));
  assert.equal(codes.get("C84.1")!.nameEn, "Sézary disease");
  assert.equal(codes.get("C84.1")!.shortNameEn, "Sezary disease");
});

test("icd10cmEdition reads interim-update dates and fiscal years", () => {
  assert.equal(icd10cmEdition("/tmp/x/icd10cm-april-1-2026-code-descriptions-tabular-order.zip", []), "2026-04-01");
  assert.equal(icd10cmEdition("upload.zip", ["Code Descriptions/icd10cm_order_2026.txt"]), "FY2026");
  assert.equal(icd10cmEdition("icd10cm-table-index-2025.zip", ["icd-10-cm-tabular-2025.xml"]), "FY2025");
});

test("parseIcd10cmRelease prefers the order file; small tables are never complete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icd-test-"));
  try {
    const zip = path.join(dir, "icd10cm-april-1-2026-code-descriptions-tabular-order.zip");
    fs.writeFileSync(
      zip,
      zipSync({
        "Code Descriptions/icd10cm_order_2026.txt": strToU8(ORDER),
        "Code Descriptions/icd10cm_order_addenda_2026.txt": strToU8("x"),
        "Table and Index/icd10cm_tabular_2026.xml": strToU8(XML),
      }),
    );
    const r = parseIcd10cmRelease(zip, new Map([["S93.411A", "右側踝部跟腓韌帶扭傷，初次照護"]]));
    assert.equal(r.sourceFormat, "cms-order");
    assert.equal(r.edition, "2026-04-01");
    assert.equal(r.complete, false); // 5 rows < threshold
    const row = r.records.find((x) => x[0] === "S93.411A")!;
    assert.deepEqual(row, [
      "S93.411A",
      "Sprain of calcaneofibular ligament of right ankle, initial encounter",
      "右側踝部跟腓韌帶扭傷，初次照護",
      "S93",
      "Sprain of calcaneofibular ligament of right ankle, init",
      "false",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("icd10cmStrict: only a complete, current edition reports unknown codes as errors", () => {
  assert.equal(icd10cmStrict(null), false);
  assert.equal(icd10cmStrict({ edition: "2026-04-01", complete: true }), true);
  assert.equal(icd10cmStrict({ edition: "FY2027", complete: true }), true);
  assert.equal(icd10cmStrict({ edition: "2026-04-01", complete: false }), false);
  assert.equal(icd10cmStrict({ edition: "FY2026", complete: true }), false); // Oct 2025 release
  assert.equal(icd10cmStrict({ edition: "unknown", complete: true }), false);
});
