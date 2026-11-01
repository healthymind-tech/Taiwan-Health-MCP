/**
 * Acceptance metrics + failure buckets over corpus/run.ts result files (one or more shards).
 *
 * Per IG, over the compared items (validator_cli did not crash, and the instance reached the TS validator):
 *  - verdict differences: items whose error presence differs (official invalid ⇄ ours valid, and the reverse);
 *  - missing: official error keys (normalised path + classify.errorClass of the official text) without a counterpart in
 *    ours (multiset), and the items that have one;
 *  - extra rate: our error keys without an official counterpart / all official error keys (acceptance target < 0.1%);
 *  - strict (path + message multiset) and lenient message-level agreement per item.
 * Items validator_cli crashed on and raw files no MCP client can send (corpus/loaders.ts `evaluator`) are counted apart.
 *
 * Buckets: missing / extra grouped by (error class, Java message_id of the official issue — "-" for extras, which have
 * none —, mutation family), with counts and example ids. --plan writes the top-N buckets' first examples as a
 * corpus/run.ts --repro-plan (class-level targets).
 *
 *   node --import tsx scripts/parity/corpus/report.ts <results.json>... [--md out.md] [--plan plan.json] [--top 30] [--cmd "<re-run command>"]
 */
import { readFileSync, writeFileSync } from "node:fs";

type Res = Record<string, any>;
interface ErrKey {
  path: string;
  cls: string;
  msg: string;
  msgid?: string | null;
}

const args = process.argv.slice(2);
const opt = (k: string): string | null => (args.includes(k) ? args[args.indexOf(k) + 1] ?? null : null);
const valued = new Set(["--md", "--plan", "--top", "--cmd"]);
const files = args.filter((a, i) => !a.startsWith("-") && !valued.has(args[i - 1] ?? ""));
const top = Number(opt("--top") ?? 30);

const items: Res[] = files.flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as Res).results as Res[]);
const k = (e: ErrKey): string => `${e.path} | ${e.cls}`;

function multisetDiff(a: ErrKey[], b: ErrKey[]): ErrKey[] {
  const m = new Map<string, number>();
  for (const e of b) m.set(k(e), (m.get(k(e)) ?? 0) + 1);
  const out: ErrKey[] = [];
  for (const e of a) {
    const n = m.get(k(e)) ?? 0;
    if (n > 0) m.set(k(e), n - 1);
    else out.push(e);
  }
  return out;
}

/** The TS area a bucket most likely belongs to (for dispatch; a heuristic over the class / Java id). */
export function area(cls: string, msgid: string | null | undefined, msg: string): string {
  const id = String(msgid ?? "");
  if (/^slice-|SLICE|Slice|_NotSlice|Profile_Minimum_SLICE/u.test(cls + " " + id) || /does not match any known slice|matching slice/u.test(msg)) return "slicing";
  if (/^constraint:/u.test(cls) || /^Constraint failed/u.test(msg)) return "fhirpath";
  if (/^Bundle_|BUNDLE|^reachable$|^first-composition$/u.test(id + " " + cls) || /in the bundle|fullUrl|Bundle\.entry/u.test(msg) && /Can't find|fullUrl|entry/u.test(msg)) return "bundle";
  if (/^Terminology_|TX_|^valueset$|^display$|^unknown-code$|^system-uri$|CodeSystem|ValueSet|UCUM|_DISPLAY_|DISPLAY/u.test(cls + " " + id) || /value set|code system|CodeSystem|Wrong Display/u.test(msg)) return "terminology";
  if (/^Reference_REF_|target-type|^profile-match$/u.test(id + " " + cls) || /Unable to find a profile match|conform to|Profile reference/u.test(msg)) return "snapshot";
  if (/^type$|^array$|^unrecognized$|^min-card$|^max-card$|^fixed$|^not-allowed$|XHTML|Xhtml|JSON|Error parsing|primitive|Primitive/u.test(cls + " " + id + " " + msg)) return "structure";
  return "other";
}

interface IgStats {
  ig: string;
  items: number;
  compared: number;
  officialCrash: number;
  rawUnparseable: number;
  rawUnparseableOfficialInvalid: number;
  crash: number;
  offInvalidOursValid: number;
  offValidOursInvalid: number;
  officialKeys: number;
  missing: number;
  missingItems: number;
  extra: number;
  extraItems: number;
  strict: number;
  lenient: number;
  classAgree: number;
}

interface Bucket {
  kind: "missing" | "extra";
  ig: string;
  cls: string;
  msgid: string;
  family: string;
  count: number;
  items: Set<string>;
  examples: Array<{ id: string; path: string; msg: string }>;
}

const stats = new Map<string, IgStats>();
const buckets = new Map<string, Bucket>();
const st = (ig: string): IgStats => {
  let s = stats.get(ig);
  if (!s) {
    s = { ig, items: 0, compared: 0, officialCrash: 0, rawUnparseable: 0, rawUnparseableOfficialInvalid: 0, crash: 0, offInvalidOursValid: 0, offValidOursInvalid: 0, officialKeys: 0, missing: 0, missingItems: 0, extra: 0, extraItems: 0, strict: 0, lenient: 0, classAgree: 0 };
    stats.set(ig, s);
  }
  return s;
};
const addBucket = (kind: "missing" | "extra", ig: string, it: Res, e: ErrKey): void => {
  const msgid = kind === "missing" ? String(e.msgid ?? "(none)") : "-";
  const family = String(it.family ?? "-");
  const key = [kind, ig, e.cls, msgid, family].join("\u0000");
  let b = buckets.get(key);
  if (!b) {
    b = { kind, ig, cls: e.cls, msgid, family, count: 0, items: new Set(), examples: [] };
    buckets.set(key, b);
  }
  b.count++;
  b.items.add(it.id);
  if (b.examples.length < 2 && !b.examples.some((x) => x.id === it.id)) b.examples.push({ id: it.id, path: e.path, msg: e.msg });
};

for (const it of items) {
  const ig = String(it.ig ?? "?");
  const s = st(ig);
  s.items++;
  if (it.skip === "official-crash") {
    s.officialCrash++;
    continue;
  }
  if (it.skip === "raw-unparseable") {
    s.rawUnparseable++;
    if ((it.officialErrors ?? []).length) s.rawUnparseableOfficialInvalid++;
    continue;
  }
  if (it.status === "crash" || !it.comparison) {
    s.crash++;
    continue;
  }
  s.compared++;
  const off: ErrKey[] = it.officialErrors ?? [];
  const ours: ErrKey[] = it.ourErrors ?? [];
  if (off.length && !ours.length) s.offInvalidOursValid++;
  if (!off.length && ours.length) s.offValidOursInvalid++;
  s.officialKeys += off.length;
  const miss = multisetDiff(off, ours);
  const extra = multisetDiff(ours, off);
  s.missing += miss.length;
  s.extra += extra.length;
  if (miss.length) s.missingItems++;
  if (extra.length) s.extraItems++;
  if (it.comparison.strict) s.strict++;
  if (it.comparison.lenient) s.lenient++;
  if (it.comparison.class) s.classAgree++;
  for (const e of miss) addBucket("missing", ig, it, e);
  for (const e of extra) addBucket("extra", ig, it, e);
}

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(2)}%` : "-");
const lines: string[] = [];
const cmd = opt("--cmd");
lines.push("# Differential corpus — TS validator vs validator_cli 7.0.1 (evaluator corpus)", "");
if (cmd) lines.push("Re-run:", "", "```bash", cmd, "```", "");
lines.push(`Generated ${new Date().toISOString()} from ${files.length} result file(s), ${items.length} items.`, "");
lines.push("## Per-IG acceptance metrics", "");
lines.push("| IG | items | compared | official crash | raw unparseable (official invalid) | harness crash | verdict: official invalid, ours valid | verdict: official valid, ours invalid | official error keys | missing keys (items) | extra keys (items) | extra rate | strict agree | lenient agree | class agree |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const all = [...stats.values()].sort((a, b) => a.ig.localeCompare(b.ig));
const sum = (f: (s: IgStats) => number): number => all.reduce((a, s) => a + f(s), 0);
const row = (s: IgStats): string =>
  `| ${s.ig} | ${s.items} | ${s.compared} | ${s.officialCrash} | ${s.rawUnparseable} (${s.rawUnparseableOfficialInvalid}) | ${s.crash} | ${s.offInvalidOursValid} | ${s.offValidOursInvalid} | ${s.officialKeys} | ${s.missing} (${s.missingItems}) | ${s.extra} (${s.extraItems}) | ${pct(s.extra, s.officialKeys)} | ${s.strict}/${s.compared} (${pct(s.strict, s.compared)}) | ${s.lenient}/${s.compared} (${pct(s.lenient, s.compared)}) | ${s.classAgree}/${s.compared} (${pct(s.classAgree, s.compared)}) |`;
for (const s of all) lines.push(row(s));
if (all.length > 1) {
  const t = Object.fromEntries(Object.keys(all[0]).map((key) => [key, key === "ig" ? "**all**" : sum((s) => (s as any)[key])])) as unknown as IgStats;
  lines.push(row(t));
}
lines.push(
  "",
  "Keys are (normalised path, classify.errorClass) multisets of error/fatal issues; MCP content checks dropped. Acceptance: verdict differences 0, missing 0, extra rate < 0.1%.",
  "",
);

const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
const tableOf = (bs: Bucket[], title: string): void => {
  lines.push(`## ${title}`, "");
  lines.push("| # | kind | IG | area | error class | Java message_id | family | keys | items | examples (id @ path: message) |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  bs.forEach((b, i) => {
    const ex = b.examples.map((x) => `\`${x.id}\` @ \`${x.path}\`: ${x.msg.replace(/\|/g, "\\|").slice(0, 160)}`).join("<br>");
    lines.push(`| ${i + 1} | ${b.kind} | ${b.ig} | ${area(b.cls, b.msgid === "-" ? null : b.msgid, b.examples[0]?.msg ?? "")} | ${b.cls.replace(/\|/g, "\\|").slice(0, 80)} | ${b.msgid} | ${b.family} | ${b.count} | ${b.items.size} | ${ex} |`);
  });
  lines.push("");
};
tableOf(sorted.slice(0, Math.max(top, 60)), `Top buckets (missing + extra, by key count)`);
const byArea = new Map<string, { missing: number; extra: number }>();
for (const b of sorted) {
  const a = area(b.cls, b.msgid === "-" ? null : b.msgid, b.examples[0]?.msg ?? "");
  const v = byArea.get(a) ?? { missing: 0, extra: 0 };
  v[b.kind] += b.count;
  byArea.set(a, v);
}
lines.push("## By TS area (heuristic)", "", "| area | missing keys | extra keys |", "|---|---|---|");
for (const [a, v] of [...byArea].sort((x, y) => y[1].missing + y[1].extra - (x[1].missing + x[1].extra))) lines.push(`| ${a} | ${v.missing} | ${v.extra} |`);
lines.push("");
// class-only roll-up (family-independent) — what one fix closes across mutation families
const byClass = new Map<string, { kind: string; cls: string; msgid: string; count: number; items: number; families: Set<string> }>();
for (const b of sorted) {
  const key = `${b.kind}\u0000${b.cls}\u0000${b.msgid}`;
  const v = byClass.get(key) ?? { kind: b.kind, cls: b.cls, msgid: b.msgid, count: 0, items: 0, families: new Set<string>() };
  v.count += b.count;
  v.items += b.items.size;
  v.families.add(b.family);
  byClass.set(key, v);
}
lines.push("## Roll-up by (kind, error class, Java message_id) across families", "", "| kind | error class | Java message_id | keys | items | families |", "|---|---|---|---|---|---|");
for (const v of [...byClass.values()].sort((a, b) => b.count - a.count).slice(0, 50)) lines.push(`| ${v.kind} | ${v.cls.replace(/\|/g, "\\|").slice(0, 80)} | ${v.msgid} | ${v.count} | ${v.items} | ${[...v.families].join(", ")} |`);
lines.push("");

const md = lines.join("\n");
const mdFile = opt("--md");
if (mdFile) writeFileSync(mdFile, md);
else console.log(md);
const planFile = opt("--plan");
if (planFile) {
  const plan = sorted.slice(0, top).map((b, i) => {
    const ex = b.examples[0];
    return { id: ex.id, kind: b.kind, path: ex.path, message: ex.msg, match: "class", bucket: `${String(i + 1).padStart(2, "0")}-${b.kind}-${b.cls}-${b.msgid}-${b.family}` };
  });
  writeFileSync(planFile, JSON.stringify(plan, null, 1));
}
for (const s of all) console.error(row(s));
