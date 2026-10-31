/** ISSUES_v17.5 — the bundled reference-server LOINC displays apply only while the local release is older. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTxDisplayTablesForTest, txDisplays } from "./txCodeTables.js";

test("txDisplays: used while the local LOINC is older than the table's edition", () => {
  setTxDisplayTablesForTest({ "http://loinc.org": { edition: "2.83", codes: { "30954-2": ["Relevant diagnostic tests/laboratory data note", "Relevant dx tests/lab data note"] } } });
  assert.deepEqual(txDisplays("http://loinc.org", "30954-2", "2.80")?.displays[0], "Relevant diagnostic tests/laboratory data note");
  assert.equal(txDisplays("http://loinc.org", "30954-2", "2.83"), null, "same edition imported: local data");
  assert.equal(txDisplays("http://loinc.org", "30954-2", "2.84"), null);
  assert.equal(txDisplays("http://loinc.org", "4548-4", "2.80"), null, "code not in the table");
  assert.equal(txDisplays("http://snomed.info/sct", "1", "x"), null);
  setTxDisplayTablesForTest(null);
});

test("the bundled table is readable and covers the IPS section codes", () => {
  setTxDisplayTablesForTest(null);
  const t = txDisplays("http://loinc.org", "11369-6", "2.80");
  assert.ok(t, "loinc-tx-display.json.gz present");
  assert.equal(t!.displays[0], "History of Immunization note");
});
