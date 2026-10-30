/**
 * ISSUES_v17 R2 dev set — content coverage (recordChecks/coverage.ts) on the complete gold Bundles
 * with their records (private fixtures; skipped when absent) and their mutations:
 *
 *   control          the Bundle as given                         → no R6 error (false positives)
 *   duplicate        one item entry copied with a new id / fullUrl → duplicate-entry at the copy
 *   text-only        a MedicationRequest's structured dose / frequency / route / supply duration moved
 *                    into Dosage.text                            → text-only-fact per field
 *   negated-<class>  an item added with an active / completed status that the record (one appended
 *                    sentence) says was not prescribed / stopped / cancelled / denied / is to be scheduled
 *                                                                → negated-item-present at it
 *   excluded         an item added that the conversion target (an appended 【轉換目標】 clause) excludes
 *                                                                → negated-item-present at it
 *
 *   node --import tsx scripts/record-checks-eval/coverage17.ts [-v]
 *
 * Record text is never printed — only case ids, mutation kinds and counts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRecordChecks } from "../../src/recordChecks/index.js";

type Json = Record<string, any>;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const MP = join(REPO, "mcp_proposal");
const PRIV = join(REPO, "node-server", "src", "grounding", "__fixtures__", "private");
const verbose = process.argv.includes("-v");
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const asObj = (x: unknown): any => (typeof x === "string" ? JSON.parse(x) : x);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

interface Case { id: string; bundle: Json; source_text: string; site_config: string | null }

function goldCases(): Case[] {
  const out: Case[] = [];
  const seen = new Set<string>();
  const push = (c: Case): void => {
    if (!c.bundle || !c.source_text) return;
    const k = JSON.stringify([c.bundle, c.source_text]);
    if (!seen.has(k)) (seen.add(k), out.push(c));
  };
  const golden = join(PRIV, "grounding_golden.json");
  if (existsSync(golden)) {
    for (const c of readJson(golden).cases as Json[]) {
      if (!/(^G0[1-4]_|^G19_|^V_TWB-\d+_gold_)/u.test(String(c.id))) continue;
      const i = asObj(c.input);
      push({ id: String(c.id), bundle: i.bundle, source_text: i.source_text, site_config: i.site_config ?? null });
    }
  }
  const repro = join(MP, "issues_v1", "repro");
  if (existsSync(repro)) {
    for (const f of readdirSync(repro).filter((x) => x.endsWith(".grounding_input.json")).sort()) {
      const j = readJson(join(repro, f));
      const i = j.input ?? j;
      push({ id: `v1-${j.case_id ?? f}`, bundle: i.bundle, source_text: i.source_text, site_config: i.site_config ?? null });
    }
  }
  const vbc = join(MP, "fixtures", "validate_bundle_combined");
  if (existsSync(vbc)) {
    for (const f of readdirSync(vbc).filter((x) => /^TWB-.*\.input\.json$/u.test(x))) {
      const i = readJson(join(vbc, f)).input;
      push({ id: `vbc-${f}`, bundle: i.bundle, source_text: i.source_text, site_config: i.site_config ?? null });
    }
  }
  return out;
}

const ENTITY = new Set(["Patient", "Practitioner", "Organization", "Composition", "Encounter", "Location", "PractitionerRole"]);
const r6 = (b: Json, text: string, site: string | null, sev?: "error"): Json[] =>
  (runRecordChecks(b, { sourceText: text, siteConfig: site, coverageSeverity: sev ?? null }).issues as Json[]).filter((i) => i.rule === "R6");
const subjectRef = (b: Json): Json => {
  const p = (b.entry || []).find((e: Json) => e?.resource?.resourceType === "Patient");
  return p?.fullUrl ? { reference: p.fullUrl } : { reference: "Patient/p" };
};
const newUrl = (n: number): string => `urn:uuid:7e170000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const tally: Record<string, { n: number; hit: number }> = {};
const count = (k: string, ok: boolean, id: string): void => {
  const t = (tally[k] ??= { n: 0, hit: 0 });
  t.n++;
  if (ok) t.hit++;
  else if (verbose) console.log(`  miss ${k}: ${id}`);
};

const NEG: Array<{ cls: string; make: (subject: Json, name: string) => Json; sentence: (name: string) => string; names: string[] }> = [
  { cls: "not-ordered", names: ["Rosuvastatin", "Amlodipine", "Pantoprazole"], sentence: (n) => `${n} 5mg 1# QD，病人表示家中尚有藥，本次不開立。`, make: (s, n) => ({ resourceType: "MedicationRequest", status: "active", intent: "order", subject: s, medicationCodeableConcept: { text: `${n} 5 mg` } }) },
  { cls: "stopped", names: ["Warfarin", "Allopurinol", "Glimepiride"], sentence: (n) => `${n} 已停用。`, make: (s, n) => ({ resourceType: "MedicationStatement", status: "active", subject: s, medicationCodeableConcept: { text: n } }) },
  { cls: "not-done", names: ["胃鏡檢查", "腹部超音波", "心電圖檢查"], sentence: (n) => `原排定之${n}因病人拒絕而取消。`, make: (s, n) => ({ resourceType: "Procedure", status: "completed", subject: s, code: { text: n } }) },
  { cls: "denied", names: ["Sulfa", "Aspirin", "海鮮"], sentence: (n) => `否認${n}過敏。`, make: (s, n) => ({ resourceType: "AllergyIntolerance", patient: s, code: { text: n }, clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", code: "active" }] } }) },
  { cls: "pending", names: ["大腸鏡檢查", "電腦斷層", "骨密度檢查"], sentence: (n) => `${n}待排程。`, make: (s, n) => ({ resourceType: "Procedure", status: "completed", subject: s, code: { text: n } }) },
];

function insertSentence(record: string, sentence: string): string {
  const k = record.indexOf("【轉換目標】");
  return k > 0 ? `${record.slice(0, k).replace(/\s*$/u, "")}\n${sentence}\n\n${record.slice(k)}` : `${record}\n${sentence}`;
}

let urlN = 1;
const cases = goldCases();
let fpBundles = 0;
let fpErrors = 0;
let warnBundles = 0;
for (const c of cases) {
  // control
  const base = r6(c.bundle, c.source_text, c.site_config);
  const errs = base.filter((i) => i.severity === "error");
  if (errs.length) {
    fpBundles++;
    fpErrors += errs.length;
    if (verbose) for (const e of errs) console.log(`  FP ${c.id}: ${e.code} @ ${e.path}`);
  }
  if (base.length > errs.length) warnBundles++;
  const entries: Json[] = c.bundle.entry || [];
  // duplicate: the first item entry copied
  const ei = entries.findIndex((e) => e?.resource && !ENTITY.has(e.resource.resourceType));
  if (ei >= 0) {
    const b = clone(c.bundle);
    const copy = clone(b.entry[ei]);
    copy.fullUrl = newUrl(urlN++);
    if (copy.resource.id) copy.resource.id = `${copy.resource.id}-dup`;
    b.entry.push(copy);
    const at = `Bundle.entry[${b.entry.length - 1}].resource`;
    count("duplicate", r6(b, c.source_text, c.site_config).some((i) => i.code === "duplicate-entry" && i.path === at), c.id);
  }
  // text-only: every MedicationRequest with structured dosage parts
  entries.forEach((e, i) => {
    const r = e?.resource;
    if (r?.resourceType !== "MedicationRequest" || !Array.isArray(r.dosageInstruction) || !r.dosageInstruction.length) return;
    const b = clone(c.bundle);
    const mr = b.entry[i].resource;
    const d = mr.dosageInstruction[0];
    const parts: Array<[string, string]> = [];
    const dq = d.doseAndRate?.[0]?.doseQuantity;
    if (dq?.value !== undefined) parts.push(["dose", `${dq.value} ${dq.code ?? dq.unit ?? "mg"}`]);
    const tc = d.timing?.code?.coding?.[0]?.code ?? d.timing?.code?.text;
    if (tc && /^(QD|BID|TID|QID|QOD|HS|Q\d+H)$/iu.test(tc)) parts.push(["timing", tc]);
    const rc = d.route?.text ?? d.route?.coding?.[0]?.display;
    if (rc && /\b(PO|IV|IM|SC|SL)\b|口服|靜脈|皮下|肌肉/iu.test(rc)) parts.push(["route", /口服|oral/iu.test(rc) ? "PO" : rc]);
    const sd = mr.dispenseRequest?.expectedSupplyDuration?.value;
    if (sd) parts.push(["duration", `共 ${sd} 天`]);
    if (!parts.length) return;
    d.text = parts.map((p) => p[1]).join(" ");
    delete d.doseAndRate;
    delete d.timing;
    delete d.route;
    if (mr.dispenseRequest) delete mr.dispenseRequest.expectedSupplyDuration;
    const found = r6(b, c.source_text, c.site_config, "error").filter((x) => x.code === "text-only-fact" && x.path.startsWith(`Bundle.entry[${i}].resource`));
    for (const [k] of parts) {
      const field = { dose: /doseQuantity$/u, timing: /timing\.code$/u, route: /\.route$/u, duration: /expectedSupplyDuration$/u }[k as "dose"]!;
      count(`text-only:${k}`, found.some((x) => field.test(x.path) && x.severity === "error"), c.id);
    }
  });
  // negated items: one appended record sentence + one added entry per class (names rotate by case)
  const ci = cases.indexOf(c);
  for (const n of NEG) {
    const name = n.names[ci % n.names.length];
    if (c.source_text.includes(name)) continue;
    const b = clone(c.bundle);
    b.entry.push({ fullUrl: newUrl(urlN++), resource: n.make(subjectRef(b), name) });
    // the sentence goes into the record body (before a trailing 【轉換目標】 block, which is instruction text)
    const text = insertSentence(c.source_text, n.sentence(name));
    const at = `Bundle.entry[${b.entry.length - 1}].resource`;
    count(`negated:${n.cls}`, r6(b, text, c.site_config).some((i) => i.code === "negated-item-present" && i.path.startsWith(at) && i.severity === "error"), c.id);
  }
  // excluded by the conversion target
  if (/【轉換目標】/u.test(c.source_text)) {
    const name = ["Vitamin B complex", "Calcium carbonate", "Magnesium oxide"][ci % 3];
    const b = clone(c.bundle);
    b.entry.push({ fullUrl: newUrl(urlN++), resource: NEG[0].make(subjectRef(b), name) });
    const text = insertSentence(c.source_text.replace(/(【轉換目標】[^\n]*)/u, `$1；${name}不需轉換。`), `P: ${name} 1# QD。`);
    const at = `Bundle.entry[${b.entry.length - 1}].resource`;
    count("excluded", r6(b, text, c.site_config).some((i) => i.code === "negated-item-present" && i.path.startsWith(at)), c.id);
  }
}
console.log(`complete gold Bundles: ${cases.length}; with an R6 error (false positive): ${fpBundles} (${cases.length ? ((100 * fpBundles) / cases.length).toFixed(1) : "0"} %, ${fpErrors} errors); with R6 warnings: ${warnBundles}`);
let n = 0;
let hit = 0;
for (const [k, t] of Object.entries(tally).sort()) {
  console.log(`  ${k}: ${t.hit}/${t.n} (${((100 * t.hit) / t.n).toFixed(1)} %)`);
  n += t.n;
  hit += t.hit;
}
console.log(`detection overall: ${hit}/${n} (${n ? ((100 * hit) / n).toFixed(1) : "0"} %)`);
