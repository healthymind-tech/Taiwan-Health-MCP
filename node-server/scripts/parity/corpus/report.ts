/**
 * Acceptance metrics + failure buckets over corpus/run.ts result files (one or more shards).
 *
 * Evaluator comparison rules (2026-11-02): errors only (warnings never compared); an official error WITH a Java
 * message_id is matched by (normalised path, classify.errorClass) — our proxy for the id, since TS issues carry none —,
 * one WITHOUT an id (parse-layer messages) by (normalised path, normalised text = compare.lenientMessage); items
 * validator_cli crashed on form the "official-crash" bucket (PASS iff TS reported >= 1 error without throwing / timing
 * out); family profile-typo (validator_cli fetched the typo'd profile online — unstable) forms the "network-dependent"
 * bucket, listed but outside the gate; mutation meta-profile-scalar (batch vs standalone may differ, the corpus has
 * only one run) is flagged. Several result files may name the same id: the last one wins.
 *
 * Per IG, over the gate items (compared, not official-crash, not network-dependent):
 *  - verdict differences: items whose error presence differs (official invalid ⇄ ours valid, and the reverse); the
 *    miss is also reported restricted to items our tool marked checked_fully=true (REVIEW_port_1 §6: only those are
 *    true misses — checked_fully=false is "could not be verified", not a pass);
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
import { lenientMessage } from "../lib/compare.js";

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

const byId = new Map<string, Res>();
for (const f of files) for (const r of (JSON.parse(readFileSync(f, "utf8")) as Res).results as Res[]) byId.set(String(r.id), r);
const items: Res[] = [...byId.values()];
/** profile-typo, also inside a combo mutation ("profile-typo/…+…"): validator_cli fetched the typo'd profile online */
const isNetwork = (it: Res): boolean => it.family === "profile-typo" || /(?:^|\+)profile-typo\//u.test(String(it.mutation ?? ""));
const isScalar = (it: Res): boolean => /meta-profile-scalar/u.test(String(it.mutation ?? ""));
const isOfficialCrash = (it: Res): boolean => !!it.officialCrash || it.skip === "official-crash";
const k = (e: ErrKey): string => `${e.path} | ${e.cls}`;

/** normalised text for id-less (parse-layer) messages. */
const textKey = (e: ErrKey): string => `${e.path} | ${lenientMessage(e.msg)}`;
/** Official <-> ours one-to-one: an official error with a Java id by (path, class), one without by (path, text). */
function matchErrors(off: ErrKey[], ours: ErrKey[]): { miss: ErrKey[]; extra: ErrKey[] } {
  const used = new Array<boolean>(ours.length).fill(false);
  const miss: ErrKey[] = [];
  // id-less first: they need the stricter text match, so they must not lose their counterpart to a class match
  const order = [...off].sort((a, b) => Number(!!a.msgid) - Number(!!b.msgid));
  for (const e of order) {
    const want = e.msgid ? k(e) : textKey(e);
    const j = ours.findIndex((o, x) => !used[x] && (e.msgid ? k(o) : textKey(o)) === want);
    if (j >= 0) used[j] = true;
    else miss.push(e);
  }
  return { miss, extra: ours.filter((_, x) => !used[x]) };
}

/** The TS area a bucket most likely belongs to (for dispatch; a heuristic over the class / Java id). */
export function area(cls: string, msgid: string | null | undefined, msg: string): string {
  const id = String(msgid ?? "");
  if (/^tool error /u.test(msg)) return "harness/tool-boundary";
  if (/^slice-/u.test(cls) || /SLICE|_NotSlice/u.test(id) || /does not match any known slice|matching slice/u.test(msg)) return "slicing";
  if (/^constraint:/u.test(cls) || /^Constraint failed/u.test(msg)) return "fhirpath";
  if (/^Bundle_|BUNDLE/u.test(id) || /^(?:reachable|first-composition|cant-find)$/u.test(cls)) return "bundle";
  if (/^Terminology_|TX_|_DISPLAY_|UCUM/u.test(id) || /^(?:valueset|display|unknown-code|system-uri)$/u.test(cls) || /value set|code system|CodeSystem|Wrong Display/u.test(msg)) return "terminology";
  if (/^Reference_REF_/u.test(id) || /^(?:target-type|profile-match)$/u.test(cls) || /Unable to find a profile match|Profile reference/u.test(msg)) return "snapshot";
  if (
    /^(?:type|array|unrecognized|min-card|max-card|fixed|not-allowed)$/u.test(cls) ||
    /CONTAINED|RES_ID|DUPLICATE|Validation_VAL_Profile_M|TYPE_SPECIFIC|_DT_|XHTML|JSON/u.test(id) ||
    /JSON|Array entries|Object must have some content|resource ?type|resourceType|cannot be parsed|does not appear to be a FHIR resource|contained resource|Duplicate ID|requires an id|XHTML|primitive|Extension\.url|must be an absolute URL/iu.test(msg)
  )
    return "structure";
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
  /** REVIEW_port_1 §6: a true miss = official error AND ours valid AND checked_fully (not "could not be checked"). */
  offInvalidOursValidCheckedFully: number;
  offValidOursInvalid: number;
  /** items our tool reported checked_fully=false (whatever the verdict). */
  notCheckedFully: number;
  /** network-dependent (profile-typo): items, of which verdict differs */
  network: number;
  networkVerdictDiff: number;
  /** official-crash bucket: items, PASS (>= 1 TS error, no throw), FAIL valid, FAIL throw / timeout, not receivable (raw) */
  ocTotal: number;
  ocPass: number;
  ocFailValid: number;
  ocFailThrow: number;
  ocNotReceivable: number;
  /** meta-profile-scalar items in the gate (flagged: batch vs standalone) and their verdict differences */
  scalar: number;
  scalarVerdictDiff: number;
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
    s = { ig, items: 0, compared: 0, officialCrash: 0, rawUnparseable: 0, rawUnparseableOfficialInvalid: 0, crash: 0, offInvalidOursValid: 0, offInvalidOursValidCheckedFully: 0, offValidOursInvalid: 0, notCheckedFully: 0, network: 0, networkVerdictDiff: 0, ocTotal: 0, ocPass: 0, ocFailValid: 0, ocFailThrow: 0, ocNotReceivable: 0, scalar: 0, scalarVerdictDiff: 0, officialKeys: 0, missing: 0, missingItems: 0, extra: 0, extraItems: 0, strict: 0, lenient: 0, classAgree: 0 };
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

const networkList: Res[] = [];
const crashFails: Res[] = [];
for (const it of items) {
  const ig = String(it.ig ?? "?");
  const s = st(ig);
  s.items++;
  const off: ErrKey[] = it.officialErrors ?? [];
  const ours: ErrKey[] = it.ourErrors ?? [];
  if (isOfficialCrash(it)) {
    s.ocTotal++;
    if (it.skip === "raw-unparseable") s.ocNotReceivable++;
    else if (it.status === "crash" || !it.comparison) {
      s.ocFailThrow++;
      crashFails.push(it);
    } else if (ours.length) s.ocPass++;
    else {
      s.ocFailValid++;
      crashFails.push(it);
    }
    continue;
  }
  if (it.skip === "raw-unparseable") {
    s.rawUnparseable++;
    if (off.length) s.rawUnparseableOfficialInvalid++;
    continue;
  }
  if (it.status === "crash" || !it.comparison) {
    s.crash++;
    continue;
  }
  if (isNetwork(it)) {
    s.network++;
    if (!off.length !== !ours.length) {
      s.networkVerdictDiff++;
      networkList.push(it);
    }
    continue;
  }
  s.compared++;
  if (isScalar(it)) {
    s.scalar++;
    if (!off.length !== !ours.length) s.scalarVerdictDiff++;
  }
  const checkedFully = !(it.flags ?? []).includes("not-checked-fully");
  if (!checkedFully) s.notCheckedFully++;
  if (off.length && !ours.length) s.offInvalidOursValid++;
  if (off.length && !ours.length && checkedFully) s.offInvalidOursValidCheckedFully++;
  if (!off.length && ours.length) s.offValidOursInvalid++;
  s.officialKeys += off.length;
  const { miss, extra } = matchErrors(off, ours);
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
lines.push("| IG | items | gate items | verdict diff (miss + extra) | verdict miss: official invalid, ours valid | true miss (… and checked_fully) | verdict extra: official valid, ours invalid | official error keys | missing keys (items) | extra keys (items) | extra rate | official-crash bucket: PASS / total (FAIL valid, FAIL throw, not receivable) | network-dependent: items (verdict diff) | meta-profile-scalar flagged (verdict diff) | raw unparseable (official invalid) | harness crash | ours checked_fully=false | strict agree | lenient agree | class agree |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const all = [...stats.values()].sort((a, b) => a.ig.localeCompare(b.ig));
const sum = (f: (s: IgStats) => number): number => all.reduce((a, s) => a + f(s), 0);
const row = (s: IgStats): string =>
  `| ${s.ig} | ${s.items} | ${s.compared} | ${s.offInvalidOursValid + s.offValidOursInvalid} | ${s.offInvalidOursValid} | ${s.offInvalidOursValidCheckedFully} | ${s.offValidOursInvalid} | ${s.officialKeys} | ${s.missing} (${s.missingItems}) | ${s.extra} (${s.extraItems}) | ${pct(s.extra, s.officialKeys)} | ${s.ocPass} / ${s.ocTotal} (${s.ocFailValid}, ${s.ocFailThrow}, ${s.ocNotReceivable}) | ${s.network} (${s.networkVerdictDiff}) | ${s.scalar} (${s.scalarVerdictDiff}) | ${s.rawUnparseable} (${s.rawUnparseableOfficialInvalid}) | ${s.crash} | ${s.notCheckedFully} | ${s.strict}/${s.compared} (${pct(s.strict, s.compared)}) | ${s.lenient}/${s.compared} (${pct(s.lenient, s.compared)}) | ${s.classAgree}/${s.compared} (${pct(s.classAgree, s.compared)}) |`;
for (const s of all) lines.push(row(s));
if (all.length > 1) {
  const t = Object.fromEntries(Object.keys(all[0]).map((key) => [key, key === "ig" ? "**all**" : sum((s) => (s as any)[key])])) as unknown as IgStats;
  lines.push(row(t));
}
lines.push(
  "",
  "Errors only (error + fatal; MCP content checks dropped). An official error with a Java message_id matches ours by (normalised path, classify.errorClass); one without (parse layer) by (normalised path, normalised text). Gate items exclude official-crash, network-dependent (profile-typo) and raw-unparseable items. Acceptance: verdict differences 0, missing 0, extra rate < 0.1%.",
  "",
);
lines.push("## Official-crash bucket: FAIL items (TS said valid, threw or timed out)", "");
for (const it of crashFails.slice(0, 40)) lines.push(`- \`${it.id}\` (${it.ig}, ${it.family}/${it.mutation}): ${it.status === "crash" || !it.comparison ? `TS ${String(it.error ?? "not run").split("\n")[0].slice(0, 120)}` : "TS valid"}`);
if (crashFails.length > 40) lines.push(`- ... ${crashFails.length - 40} more`);
lines.push("", "## Network-dependent bucket (profile-typo): verdict differences, outside the gate", "");
for (const it of networkList.slice(0, 40)) lines.push(`- \`${it.id}\` (${it.ig}, ${it.mutation}): official ${(it.officialErrors ?? []).length} errors, ours ${(it.ourErrors ?? []).length}`);
if (networkList.length > 40) lines.push(`- ... ${networkList.length - 40} more`);
lines.push("");

// verdict differences: which official classes the "official invalid, ours valid" items carry (and the reverse)
const vd = new Map<string, { n: number; ex: string; trueMiss: number }>();
const vr = new Map<string, { n: number; ex: string }>();
for (const it of items) {
  if (it.skip || !it.comparison || isOfficialCrash(it) || isNetwork(it)) continue;
  const off: ErrKey[] = it.officialErrors ?? [];
  const ours: ErrKey[] = it.ourErrors ?? [];
  const cf = !(it.flags ?? []).includes("not-checked-fully");
  if (off.length && !ours.length)
    for (const c of new Set(off.map((e) => `${it.ig} | ${e.cls.slice(0, 70)} | ${e.msgid ?? "(none)"} | ${it.family}`))) {
      const v = vd.get(c) ?? { n: 0, ex: it.id, trueMiss: 0 };
      v.n++;
      if (cf) v.trueMiss++;
      vd.set(c, v);
    }
  if (!off.length && ours.length)
    for (const c of new Set(ours.map((e) => `${it.ig} | ${e.cls.slice(0, 70)} | ${it.family}`))) {
      const v = vr.get(c) ?? { n: 0, ex: it.id };
      v.n++;
      vr.set(c, v);
    }
}
lines.push("## Verdict differences: official invalid, ours valid — official classes carried (an item counts once per class)", "", "| IG | class | Java message_id | family | items | of which checked_fully | example |", "|---|---|---|---|---|---|---|");
for (const [k2, v] of [...vd].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) lines.push(`| ${k2} | ${v.n} | ${v.trueMiss} | \`${v.ex}\` |`);
lines.push("", "## Verdict differences: official valid, ours invalid — our classes", "", "| IG | class | family | items | example |", "|---|---|---|---|---|");
for (const [k2, v] of [...vr].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) lines.push(`| ${k2} | ${v.n} | \`${v.ex}\` |`);
lines.push("");

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
