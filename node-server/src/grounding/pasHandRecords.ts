/**
 * Hand-written Taiwanese clinical records for compact TW PAS Bundles assembled from the PAS package examples
 * (test support). Unlike pasTestkit.renderPasRecord these notes were written by hand in free clinical style
 * (mixed zh/en, ROC dates, abbreviations, one-line CBC), so they are the less engine-tuned false-positive check.
 */
import type { JsonObject } from "./py.js";

export interface HandRecord {
  id: string;
  /** Source PAS Bundle key and the entry indexes kept (in order). */
  from: string;
  keep: number[];
  text: string;
  site: string;
}

export const HAND_RECORDS: HandRecord[] = [
  {
    id: "H1_lung_cancer_preauth",
    from: "Bundle/bun-1",
    keep: [0, 1, 2, 3, 4, 14, 22, 23],
    text: [
      "臺北市立聯合醫院 胸腔暨重症加護 門診病歷（預約門診）",
      "病人：王大明　男　民國90年1月1日生　身分證字號 A123456789　病歷號碼 123456",
      "S: 規則回診，準備申請標靶藥物事前審查。",
      "Dx：",
      "1. 慢性右心臟衰竭（113年1月1日診斷）",
      "處置史：113/01/01 經自然開口或人工造口心包腔液態近接放射性同位素抗腫瘤藥劑輸入",
      "O: 身高 170 cm，體重 59.65 kg。",
      "CBC panel（113/01/01）：WBC 3.6 x10^3/uL (3.9-10.6)、RBC 4.7 x10^6/uL (4.5-5.9)、Hb 14 g/dL (13.5-17.5)、Hct 45% (41-53)、PLT 101 x10^3/uL (150-400)",
      "P: 計畫用藥（待核准前暫停）：",
      "  Alunbrig film-coated tablets 30mg 75 mg/m2 PO QD AC1H",
      "  Alunbrig film-coated tablets 30mg 150 mg/m2 PO Q4WD1",
      "  Herzuma Inj. 440mg 200 mg/m2 PO Q4WD1",
      "事前審查申請日期：113/05/30",
      "申請項目一：Alunbrig 52 粒，初次使用、第一線治療；給付規定：ALK陽性的晚期非小細胞肺癌第一線治療",
      "申請項目二：Herzuma 70 粒，初次使用、第一線治療；給付理由：早期乳癌-未發生腋下淋巴結轉移",
    ].join("\n"),
    site: [
      "【院所設定】（由本院資訊系統提供，非病歷內容）",
      "- 醫事機構：臺北市立聯合醫院　醫事機構代碼：0101090517",
      "- 申請醫師　證書字號：KP00017　身分證號：F123456789",
    ].join("\n"),
  },
];

/** The compact Bundle for a hand record (entries copied unchanged from the PAS example Bundle). */
export function handBundle(bundles: Array<{ key: string; bundle: JsonObject }>, h: HandRecord): JsonObject {
  const src = bundles.find((b) => b.key === h.from)!.bundle;
  const entries = src.entry as unknown[];
  return { resourceType: "Bundle", type: "collection", entry: h.keep.map((i) => structuredClone(entries[i])) };
}
