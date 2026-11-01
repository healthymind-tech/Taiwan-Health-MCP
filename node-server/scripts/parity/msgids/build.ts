/**
 * parity v3 — message-id coverage table.
 *
 * Lists every HL7 validator 7.0.1 message id that instance validation can emit (ids referenced from the instance
 * validator, its type validators, BaseValidator, the r5 element-model JSON parser, the terminology validation code
 * and the FHIRPath engine), where Java emits it (Class#method + the reporting call, i.e. its severity), and whether
 * the TypeScript validator emits a message with the same template (string literals / template literals of
 * node-server/src, matched against the Messages.properties template). It also estimates how often each id occurs
 * in the official fhir-test-cases expected outcomes (validator/outcomes/java/*.json, matched by text).
 *
 *   node --import tsx scripts/parity/msgids/build.ts [--ref <org.hl7.fhir.core dir>] [--cases <fhir-test-cases dir>]
 *        [--out scripts/parity/msgids/coverage.json] [--summary <file.md>]
 *
 * Output is deterministic (no timestamps), so re-running only changes the file when coverage changed.
 * Match status per id: "implemented" — a TS message has the same template (literal text identical, placeholders
 * on either side may stand for the other's text); "partial" — the template's longest literal fragment (≥ 12
 * chars) occurs in a TS message, but the whole template does not; "missing" — neither.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const nodeServer = resolve(here, "../../..");
const args = process.argv.slice(2);
const arg = (k: string, d: string): string => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const REF = arg("--ref", join(homedir(), "ref/hl7-validator-7.0.1/org.hl7.fhir.core"));
const CASES = arg("--cases", join(homedir(), "ref/fhir-test-cases"));
const OUT = arg("--out", join(here, "coverage.json"));
const SUMMARY = args.includes("--summary") ? arg("--summary", "") : null;

const J = (m: string, p: string): string => join(REF, m, "src/main/java/org/hl7/fhir", p);
const VAL = (p: string): string => J("org.hl7.fhir.validation", "validation/" + p);
const R5 = (p: string): string => J("org.hl7.fhir.r5", "r5/" + p);

/** Java sources whose message ids reach an instance-validation OperationOutcome. */
const SCOPE: string[] = [
  VAL("instance"), // InstanceValidator + type/* + utils/* (scoring / advisor excluded below)
  VAL("BaseValidator.java"),
  VAL("codesystem"),
  R5("elementmodel/JsonParser.java"),
  R5("elementmodel/ParserBase.java"),
  R5("elementmodel/ResourceParser.java"),
  R5("elementmodel/Element.java"),
  R5("elementmodel/LanguageUtils.java"),
  R5("terminologies/validation"),
  R5("terminologies/utilities/ValueSetProcessBase.java"),
  R5("terminologies/expansion/ValueSetExpander.java"),
  R5("context/BaseWorkerContext.java"),
  R5("fhirpath/FHIRPathEngine.java"),
  J("org.hl7.fhir.utilities", "utilities/xhtml/XhtmlParser.java"),
];
const EXCLUDE = [/\/instance\/scoring\//, /\/instance\/advisor\//];

function walk(p: string, out: string[]): void {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f), out);
  else if (p.endsWith(".java") && !EXCLUDE.some((r) => r.test(p))) out.push(p);
}

// ---------------------------------------------------------------- Messages.properties / I18nConstants
function loadProperties(): Map<string, string> {
  const text = readFileSync(join(REF, "org.hl7.fhir.utilities/src/main/resources/Messages.properties"), "utf8");
  const m = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*[#!]/.test(raw)) continue;
    const i = raw.indexOf("=");
    if (i < 0) continue;
    const k = raw.slice(0, i).trim();
    const v = raw
      .slice(i + 1)
      .trim()
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, "$1");
    m.set(k, v);
  }
  return m;
}
function loadConstants(): Map<string, string> {
  const text = readFileSync(join(REF, "org.hl7.fhir.utilities/src/main/java/org/hl7/fhir/utilities/i18n/I18nConstants.java"), "utf8");
  const m = new Map<string, string>();
  for (const x of text.matchAll(/public static final String (\w+)\s*=\s*"([^"]+)"/g)) m.set(x[1], x[2]);
  return m;
}

// ---------------------------------------------------------------- Java usage scan
interface Use {
  file: string;
  cls: string;
  method: string;
  call: string;
  line: number;
}
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "synchronized", "try", "else", "do", "return", "new"]);

/** Every `I18nConstants.X` use with its enclosing method and the reporting call it is an argument of. */
function scanJava(file: string): Array<{ constant: string; use: Use }> {
  const src = readFileSync(file, "utf8");
  const cls = (/\/r5\/terminologies\//.test(file) ? "tx." : "") + file.split("/").pop()!.replace(/\.java$/, "");
  const res: Array<{ constant: string; use: Use }> = [];
  // blank out comments and string / char literals, keeping offsets (so braces and parens are structural)
  let clean = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") (clean += " "), i++;
    } else if (c === "/" && src[i + 1] === "*") {
      clean += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) (clean += src[i] === "\n" ? "\n" : " "), i++;
      clean += "  ";
      i += 2;
    } else if (c === '"' || c === "'") {
      clean += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") (clean += " "), i++;
        clean += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      clean += c;
      i++;
    } else (clean += c), i++;
  }
  // method stack by brace depth
  const stack: Array<{ depth: number; name: string }> = [];
  const methodAt: Array<string> = new Array(clean.length);
  let depth = 0;
  let segStart = 0;
  let cur = "";
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "{") {
      const header = clean.slice(segStart, i).replace(/@\w+(?:\s*\([^)]*\))?/g, " ");
      const m = /(\w+)\s*\([^]*\)\s*(?:throws[\w\s.,]+)?$/.exec(header.trim());
      if (m && !KEYWORDS.has(m[1]) && !/(=|->|\bnew\b)/.test(header.slice(0, header.indexOf(m[1])))) {
        stack.push({ depth, name: m[1] });
      } else if (/\b(class|interface|enum)\s+(\w+)/.test(header)) {
        stack.push({ depth, name: "" });
      } else stack.push({ depth, name: "\0" });
      depth++;
      segStart = i + 1;
    } else if (c === "}") {
      depth--;
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      segStart = i + 1;
    } else if (c === ";") segStart = i + 1;
    if (c === "{" || c === "}") {
      const named = [...stack].reverse().find((s) => s.name && s.name !== "\0");
      cur = named?.name ?? "";
    }
    methodAt[i] = cur;
  }
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (pos: number): number => {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const x of clean.matchAll(/I18nConstants\.([A-Z0-9_]+)/g)) {
    const pos = x.index!;
    // the reporting call: walk back to the enclosing unmatched '(' (skipping formatMessage wrappers)
    let call = "";
    let level = "";
    let p = pos;
    for (let hop = 0; hop < 4; hop++) {
      let d = 0;
      let q = p - 1;
      for (; q >= 0; q--) {
        const ch = clean[q];
        if (ch === ")") d++;
        else if (ch === "(") {
          if (d === 0) break;
          d--;
        } else if ((ch === ";" || ch === "{" || ch === "}") && d === 0) {
          q = -1;
          break;
        }
      }
      if (q < 0) break;
      const id = /([\w.]+)\s*$/.exec(clean.slice(Math.max(0, q - 80), q))?.[1] ?? "";
      call = id.split(".").pop()!;
      if (/^(formatMessage|formatMessagePlural|formatMessageP|Utilities\.\w+|format|asList|of)$/i.test(call) || call === "") {
        p = q;
        continue;
      }
      // an explicit IssueSeverity argument (logError / ValidationMessage / makeIssue) gives the level
      let e = q + 1;
      for (let d = 0; e < clean.length; e++) {
        if (clean[e] === "(") d++;
        else if (clean[e] === ")") {
          if (d === 0) break;
          d--;
        }
      }
      level = /IssueSeverity\.(FATAL|ERROR|WARNING|INFORMATION)/.exec(clean.slice(q, e))?.[1]?.toLowerCase() ?? "";
      break;
    }
    if (level) call = `${call}:${level}`;
    res.push({ constant: x[1], use: { file: relative(REF, file), cls, method: methodAt[pos] || "<init>", call, line: lineOf(pos) } });
  }
  return res;
}

function severityOf(callAndLevel: string): string {
  const [call, level] = callAndLevel.split(":");
  if (level) return level;
  const c = call.toLowerCase();
  if (/^(rule|txrule|rulehtml|rulepath|rulex|rulePlural|rulewithdetails)/i.test(c) || /^(hintorerror|warningorerror)$/.test(c)) return c.includes("orerror") ? "warning|error" : "error";
  if (/^(warning|txwarning|warningplural|warninghtml|suppressedwarning)/.test(c)) return "warning";
  if (/^(hint|txhint|hintplural|signpost|txsignpost)/.test(c)) return "information";
  if (/^(ok)$/.test(c)) return "none";
  if (c === "fail") return "fatal";
  if (/exception(plural)?$|^(logerror|failwithunknownvsexception)$/.test(c)) return "exception";
  return "other";
}

// ---------------------------------------------------------------- area
function areaOf(cls: string, method: string): string {
  if (cls === "BundleValidator") return "bundle";
  if (cls === "FHIRPathEngine") return "fhirpath";
  if (/^tx\./.test(cls) || /^(BaseWorkerContext|CodeSystemChecker|SnomedCTChecker|CodingsObserver|\w*CodeSystemChecker)$/.test(cls)) return "terminology";
  if (/^(JsonParser|ParserBase|ResourceParser|Element|XhtmlParser|XhtmlValidator)$/.test(cls)) return "structure";
  if (cls === "InstanceValidator" || cls === "BaseValidator") {
    const m = method;
    if (/slic|Slic|discriminator|Discriminator/.test(m)) return "slicing";
    if (/Invariant|Constraint|FHIRPath|Fhirpath|checkSpecials|executeAssertion/.test(m)) return "fhirpath";
    if (/Bundle|Contained|getContainedById|validateContains|resolve(?!Type)|localResolve|ParentResource/.test(m)) return "bundle";
    if (/Binding|Code|Coding|ValueSet|Terminology|Lang|Display|Txs?|tx|Concept|checkSystem|UCUM|Ucum|Mime/i.test(m) && !/checkPrimitive|checkElement/.test(m))
      return "terminology";
    return "structure";
  }
  return "resource";
}

// ---------------------------------------------------------------- TS messages
interface TsMsg {
  file: string;
  fn: string;
  text: string; // skeleton: placeholders as \u0001
}
const PH = "\u0001";
function collectTs(): TsMsg[] {
  const out: TsMsg[] = [];
  const files: string[] = [];
  const w = (p: string): void => {
    for (const f of readdirSync(p).sort()) {
      const fp = join(p, f);
      if (statSync(fp).isDirectory()) w(fp);
      else if (fp.endsWith(".ts") && !fp.endsWith(".test.ts")) files.push(fp);
    }
  };
  w(join(nodeServer, "src"));
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const rel = relative(nodeServer, file);
    const skel = (n: ts.Node): string | null => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
      if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => PH + s.literal.text).join("");
      if (ts.isParenthesizedExpression(n)) return skel(n.expression);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const a = skel(n.left);
        const b = skel(n.right);
        if (a === null && b === null) return null;
        return (a ?? PH) + (b ?? PH);
      }
      return null;
    };
    const fnName = (n: ts.Node): string => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if ((ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name) return p.name.getText(sf);
        if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText(sf);
      }
      return "<module>";
    };
    const visit = (n: ts.Node): void => {
      const isTop = !(n.parent && ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken);
      if (isTop && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) || ts.isBinaryExpression(n))) {
        const s = skel(n);
        if (s && s.length <= 1000 && s.replace(new RegExp(PH, "g"), "").length >= 8 && / /.test(s)) out.push({ file: rel, fn: fnName(n), text: s });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

// ---------------------------------------------------------------- template matching
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Java MessageFormat template → skeleton with placeholders as \u0001. */
function javaSkeleton(t: string): string {
  return t.replace(/\{\d+(?:,[^}]*)?\}/g, PH).replace(/''/g, "'").trim();
}
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
function skelRegex(s: string): RegExp {
  return new RegExp("^" + norm(s).split(PH).map(esc).join("[\\s\\S]*?") + "$");
}
function fragments(s: string): string[] {
  return norm(s)
    .split(PH)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// ---------------------------------------------------------------- main
function main(): void {
  const props = loadProperties();
  const consts = loadConstants();
  const javaFiles: string[] = [];
  for (const p of SCOPE) walk(p, javaFiles);
  const uses = new Map<string, Use[]>();
  for (const f of javaFiles) {
    for (const { constant, use } of scanJava(f)) {
      const id = consts.get(constant);
      if (!id) continue;
      if (!uses.has(id)) uses.set(id, []);
      uses.get(id)!.push(use);
    }
  }
  const tsMsgs = collectTs();
  const tsNorm = tsMsgs.map((m) => ({ ...m, n: norm(m.text), re: skelRegex(m.text) }));

  // official expected outcomes: issue texts
  const outcomeTexts: Array<{ text: string; severity: string }> = [];
  const odir = join(CASES, "validator/outcomes/java");
  if (existsSync(odir)) {
    for (const f of readdirSync(odir).sort()) {
      if (!f.endsWith(".json")) continue;
      try {
        const oo = JSON.parse(readFileSync(join(odir, f), "utf8"));
        for (const i of oo.issue ?? []) if (i?.details?.text) outcomeTexts.push({ text: norm(String(i.details.text)), severity: String(i.severity) });
      } catch {
        /* skip */
      }
    }
  }

  type Row = {
    id: string;
    template: string;
    plural: boolean;
    area: string;
    java: Array<{ at: string; call: string; severity: string }>;
    status: "implemented" | "partial" | "missing";
    /** "issue" when at least one use site reports it as a validation message, "exception" when only thrown / logged */
    kind: "issue" | "exception";
    ts: string[];
    freq: number;
    freqErrors: number;
  };
  const rows: Row[] = [];
  const ids = [...uses.keys()].sort();
  const templateOf = (id: string): { t: string | undefined; plural: boolean } => {
    if (props.has(id)) return { t: props.get(id), plural: false };
    if (props.has(id + "_other")) return { t: props.get(id + "_other"), plural: true };
    if (props.has(id + "_one")) return { t: props.get(id + "_one"), plural: true };
    return { t: undefined, plural: false };
  };
  const regexes: Array<{ id: string; re: RegExp; lit: number }> = [];
  for (const id of ids) {
    const { t, plural } = templateOf(id);
    const variants = [id, id + "_one", id + "_other"].map((k) => props.get(k)).filter((x): x is string => !!x);
    const javaU = uses.get(id)!;
    const seen = new Set<string>();
    const java = javaU
      .map((u) => ({ at: `${u.cls}#${u.method}`, call: u.call, severity: severityOf(u.call) }))
      .filter((u) => (seen.has(u.at + u.call) ? false : (seen.add(u.at + u.call), true)));
    // area by majority of use sites (first wins on ties)
    const areaCount = new Map<string, number>();
    for (const u of javaU) areaCount.set(areaOf(u.cls, u.method), (areaCount.get(areaOf(u.cls, u.method)) ?? 0) + 1);
    const area = [...areaCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let status: Row["status"] = "missing";
    const tsHits = new Set<string>();
    for (const v of variants) {
      const sk = javaSkeleton(v);
      const jre = skelRegex(sk);
      const jn = norm(sk);
      const lit = jn.replace(new RegExp(PH, "g"), "").length;
      regexes.push({ id, re: jre, lit });
      if (lit < 6) continue; // pure-placeholder templates ("{0}") cannot be matched by text
      for (const m of tsNorm) {
        if (jre.test(m.n) || m.re.test(jn)) {
          status = "implemented";
          tsHits.add(`${m.file}#${m.fn}`);
        }
      }
    }
    if (status === "missing") {
      for (const v of variants) {
        const frs = fragments(javaSkeleton(v)).sort((a, b) => b.length - a.length);
        if (!frs.length || frs[0].length < 12) continue;
        for (const m of tsNorm) if (m.n.includes(frs[0])) {
          status = "partial";
          tsHits.add(`${m.file}#${m.fn}`);
        }
      }
    }
    const kind: Row["kind"] = java.some((j) => j.severity !== "exception") ? "issue" : "exception";
    rows.push({ id, template: t ?? "", plural, area, java, status, kind, ts: [...tsHits].sort(), freq: 0, freqErrors: 0 });
  }
  // frequency: each official issue text is attributed to the matching template with the most literal text
  const byId = new Map(rows.map((r) => [r.id, r]));
  regexes.sort((a, b) => b.lit - a.lit);
  for (const o of outcomeTexts) {
    const hit = regexes.find((r) => r.lit >= 6 && r.re.test(o.text));
    if (!hit) continue;
    const r = byId.get(hit.id)!;
    r.freq++;
    if (o.severity === "error" || o.severity === "fatal") r.freqErrors++;
  }

  const summarize = (rs: Row[]): { total: number; implemented: number; partial: number; missing: number } => ({
    total: rs.length,
    implemented: rs.filter((r) => r.status === "implemented").length,
    partial: rs.filter((r) => r.status === "partial").length,
    missing: rs.filter((r) => r.status === "missing").length,
  });
  const byArea: Record<string, ReturnType<typeof summarize>> = {};
  for (const a of [...new Set(rows.map((r) => r.area))].sort()) byArea[a] = summarize(rows.filter((r) => r.area === a));
  const byClass: Record<string, ReturnType<typeof summarize>> = {};
  const clsOf = (r: Row): string => r.java[0].at.split("#")[0];
  for (const c of [...new Set(rows.map(clsOf))].sort()) byClass[c] = summarize(rows.filter((r) => clsOf(r) === c));
  const errorRows = rows.filter((r) => r.java.some((j) => j.severity.includes("error") || j.severity === "fatal"));
  const issueRows = rows.filter((r) => r.kind === "issue");
  const doc = {
    description:
      "parity v3 message-id coverage (generated by scripts/parity/msgids/build.ts — do not edit). status: implemented = a TS message has the same template; partial = only the longest literal fragment occurs; missing = neither. freq / freqErrors = occurrences in fhir-test-cases validator/outcomes/java (text-matched).",
    sources: { validator: "HL7 org.hl7.fhir.core 7.0.1", javaFiles: javaFiles.map((f) => relative(REF, f)), officialOutcomeIssues: outcomeTexts.length },
    summary: { all: summarize(rows), reportable: summarize(issueRows), emittedAsError: summarize(errorRows), byArea, byClass },
    ids: rows,
  };
  writeFileSync(OUT, JSON.stringify(doc, null, 1) + "\n");
  const s = doc.summary.all;
  console.log(`ids ${s.total}: implemented ${s.implemented}, partial ${s.partial}, missing ${s.missing}`);
  for (const [a, v] of Object.entries(byArea)) console.log(`  ${a.padEnd(12)} ${v.total} / impl ${v.implemented} / partial ${v.partial} / missing ${v.missing}`);
  if (SUMMARY) {
    const lines = [
      "| group | total | implemented | partial | missing |",
      "|---|---:|---:|---:|---:|",
      `| **all** | ${s.total} | ${s.implemented} | ${s.partial} | ${s.missing} |`,
      `| reportable (not exception-only) | ${doc.summary.reportable.total} | ${doc.summary.reportable.implemented} | ${doc.summary.reportable.partial} | ${doc.summary.reportable.missing} |`,
      `| emitted as error somewhere | ${doc.summary.emittedAsError.total} | ${doc.summary.emittedAsError.implemented} | ${doc.summary.emittedAsError.partial} | ${doc.summary.emittedAsError.missing} |`,
      ...Object.entries(byArea).map(([a, v]) => `| area ${a} | ${v.total} | ${v.implemented} | ${v.partial} | ${v.missing} |`),
      ...Object.entries(byClass).map(([a, v]) => `| ${a} | ${v.total} | ${v.implemented} | ${v.partial} | ${v.missing} |`),
    ];
    writeFileSync(SUMMARY, lines.join("\n") + "\n");
  }
}

main();
