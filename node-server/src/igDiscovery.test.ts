import { test } from "node:test";
import assert from "node:assert/strict";
import { matchIgs, type IgText } from "./igDiscovery.js";

const ig = (packageId: string, title: string, extra: Partial<IgText> = {}): IgText => ({ packageId, version: "1.0.0", title, installOrigin: "manual", isDefault: false, ...extra });
const IGS: IgText[] = [
  ig("tw.gov.mohw.twcore", "臺灣核心實作指引(TW Core IG)", { isDefault: true, igName: "TWCoreIG" }),
  ig("tw.gov.mohw.nhi.pas", "臺灣健保事前審查實作指引(Taiwan NHI Prior Authorization Support Implementation Guide)", { igName: "TWPAS" }),
  ig("tw.gov.mohw.nhi.empd", "臺灣電子處方箋與調劑單張實作指引"),
  ig("tw.gov.mohw.nhi.ngs", "臺灣次世代基因定序檢測實作指引(TWNGS IG)"),
  ig("tw.gov.mohw.emr", "電子病歷交換單張實作指引 EMR IG", { igDescription: "門診病歷、出院病摘、檢驗報告、醫療影像報告與轉診病歷等電子病歷交換單張" }),
  ig("tw.gov.mohw.nricm.twcm", "臺灣中醫實作指引", { igName: "TWCMIG", igTitle: "Taiwan Chinese Medicine IG", igDescription: "依據衛生福利部中醫門診病歷單張，定義中醫門診紀錄的 FHIR 交換格式" }),
  ig("hl7.fhir.uv.ips", "International Patient Summary Implementation Guide"),
  ig("hl7.fhir.uv.ips", "International Patient Summary Implementation Guide", { version: "1.1.0", installOrigin: "dependency" }),
];
const top = (q: string): string => `${matchIgs(q, IGS)[0]?.packageId ?? "-"}`;

test("IG discovery: Chinese names, short names and English names point to the right IG", () => {
  assert.equal(top("請轉為健保事前審查 Bundle"), "tw.gov.mohw.nhi.pas");
  assert.equal(top("TWPAS"), "tw.gov.mohw.nhi.pas");
  assert.equal(top("PAS bundle"), "tw.gov.mohw.nhi.pas");
  assert.equal(top("轉換為電子處方箋"), "tw.gov.mohw.nhi.empd");
  assert.equal(top("次世代基因定序"), "tw.gov.mohw.nhi.ngs");
  assert.equal(top("NGS"), "tw.gov.mohw.nhi.ngs");
  assert.equal(top("中醫門診病歷"), "tw.gov.mohw.nricm.twcm");
  assert.equal(top("TWCM"), "tw.gov.mohw.nricm.twcm");
  assert.equal(top("電子病歷交換單張"), "tw.gov.mohw.emr");
  assert.equal(top("轉為 TW Core Bundle"), "tw.gov.mohw.twcore");
  assert.equal(top("International Patient Summary"), "hl7.fhir.uv.ips");
  const ips = matchIgs("IPS", IGS);
  assert.equal(ips[0].version, "1.0.0", "the manually installed IPS first");
  assert.deepEqual(matchIgs("轉為 Bundle", IGS), [], "generic words alone match nothing");
});
