import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";
import { allowedSabs, bufferSource, fileSource, lrabrFile, openUmls, parseMrconsoLine, writeSubset, zipEntries, type UmlsRow } from "./umls.js";

// MRSAB: VCUI|RCUI|VSAB|RSAB|SON|SF|SVER|VSTART|VEND|IMETA|RMETA|SLC|SCC|SRL|TFR|CFR|CXTY|TTYL|ATNL|LAT|CENC|CURVER|SABIN|SSN|SCIT|
const sab = (rsab: string, srl: number, curver = "Y"): string =>
  `C1|C2|${rsab}2024|${rsab}|${rsab} name|${rsab}|2024|||2024AA|2024AA|||${srl}|1|1||||ENG|UTF-8|${curver}|Y|${rsab}||`;
// MRCONSO: CUI|LAT|TS|LUI|STT|SUI|ISPREF|AUI|SAUI|SCUI|SDUI|SAB|TTY|CODE|STR|SRL|SUPPRESS|CVF|
const conso = (cui: string, lat: string, sabName: string, tty: string, str: string, suppress = "N"): string =>
  `${cui}|${lat}|P|L1|PF|S1|Y|A1||||${sabName}|${tty}|X|${str}|0|${suppress}||`;

const MRSAB = [sab("MSH", 0), sab("SNOMEDCT_US", 9), sab("MDR", 3), sab("HGNC", 0), sab("NCI", 0, "N")].join("\n") + "\n";
const MRCONSO = [
  conso("C0001", "ENG", "MSH", "MH", "Echocardiography, Transthoracic"),
  conso("C0001", "ENG", "SNOMEDCT_US", "SY", "TTE - Transthoracic echocardiography"),
  conso("C0001", "ENG", "MSH", "AB", "TTE"),
  conso("C0001", "FRE", "MSH", "MH", "Échocardiographie"),
  conso("C0001", "ENG", "MDR", "PT", "Transthoracic echo (MedDRA, SRL 3)"),
  conso("C0002", "ENG", "HGNC", "ACR", "TTE gene"),
  conso("C0003", "ENG", "MSH", "MH", "Suppressed term", "O"),
].join("\n") + "\n";

test("MRSAB filter: SRL 0 + SNOMEDCT_US, current versions, non-clinical sources excluded", () => {
  const a = allowedSabs(MRSAB.trim().split("\n"));
  assert.deepEqual([...a.keys()].sort(), ["MSH", "SNOMEDCT_US"]);
});

test("MRCONSO filter: ENG, allowed SAB, not suppressed", () => {
  const a = allowedSabs(MRSAB.trim().split("\n"));
  const rows = MRCONSO.trim().split("\n").map((l) => parseMrconsoLine(l, a)).filter(Boolean) as UmlsRow[];
  assert.deepEqual(rows.map((r) => r.str), ["Echocardiography, Transthoracic", "TTE - Transthoracic echocardiography", "TTE"]);
});

test("streams members out of a zip and round-trips through the subset format", async () => {
  const zip = Buffer.from(zipSync({ "2024AA/META/MRSAB.RRF": strToU8(MRSAB), "2024AA/META/MRCONSO.RRF": strToU8(MRCONSO) }));
  const entries = await zipEntries(bufferSource(zip));
  assert.deepEqual(entries.map((e) => e.name).sort(), ["2024AA/META/MRCONSO.RRF", "2024AA/META/MRSAB.RRF"]);
  const src = await openUmls(bufferSource(zip));
  assert.equal(src.release, "2024AA");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "umls-test-"));
  try {
    const out = path.join(dir, "subset.rrf.gz");
    assert.equal(await writeSubset(src, out), 3);
    const again = await openUmls(fileSource(out));
    assert.equal(again.release, "2024AA");
    const rows: UmlsRow[] = [];
    for await (const r of again.rows) rows.push(r);
    assert.deepEqual(rows.map((r) => [r.cui, r.sab, r.tty]), [["C0001", "MSH", "MH"], ["C0001", "SNOMEDCT_US", "SY"], ["C0001", "MSH", "AB"]]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

const LRABR = [
  "E0000001|PLEX|acronym|E0000002|plasma exchange|",
  "E0000001|PLEX|acronym|E0000003|plasma-exchange|",
  "E0000004|chole|abbreviation|E0000005|cholecystectomy|",
  "E0000006|X|acronym|E0000007|single letter|",
].join("\n") + "\n";

test("abbreviation lexicon (LRABR): read from a zip member and carried through the subset", async () => {
  const zip = Buffer.from(zipSync({ "META/MRSAB.RRF": strToU8(MRSAB), "META/MRCONSO.RRF": strToU8(MRCONSO), "LEX/LRABR": strToU8(LRABR) }));
  const src = await openUmls(bufferSource(zip));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "umls-test-"));
  try {
    const out = path.join(dir, "subset.rrf.gz");
    await writeSubset(src, out);
    const again = await openUmls(fileSource(out));
    for await (const _ of again.rows) void _;
    const abbr = [];
    for await (const a of again.abbreviations()) abbr.push([a.key, a.abbr, a.expansion, a.kind]);
    // Spelling variants collapse, one-letter abbreviations are dropped.
    assert.deepEqual(abbr, [["plex", "PLEX", "plasma exchange", "acronym"], ["chole", "chole", "cholecystectomy", "abbreviation"]]);
    // A plain LRABR file can be added when writing the subset.
    const lr = path.join(dir, "LRABR");
    await fsp.writeFile(lr, "E1|TAH|acronym|E2|total abdominal hysterectomy|\n");
    const plain = await openUmls(bufferSource(Buffer.from(zipSync({ "META/MRSAB.RRF": strToU8(MRSAB), "META/MRCONSO.RRF": strToU8(MRCONSO) }))));
    const out2 = path.join(dir, "subset2.rrf.gz");
    await writeSubset(plain, out2, lrabrFile(lr));
    const third = await openUmls(fileSource(out2));
    for await (const _ of third.rows) void _;
    const keys = [];
    for await (const a of third.abbreviations()) keys.push(a.key);
    assert.deepEqual(keys, ["tah"]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
