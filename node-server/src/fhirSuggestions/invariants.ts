/**
 * ISSUES_v16.2 R3 — what a failed profile invariant is missing. A `Constraint failed: <key>: …`
 * issue only restates the rule; this layer re-reads the invariant from the profile, splits it into
 * its parts (`guard implies (a and b …)`, top-level `and` / `or`), evaluates each part on the
 * element the issue is about and adds `invariant`: the parts that are false, each with the missing
 * path and — for an extension test — the extension url, its value type and the JSON to write.
 *
 * IG-agnostic (it only reads the expression); additive (issue set, severities, messages and
 * `valid` unchanged); fail-open (an expression it cannot split or evaluate gets no explanation).
 */

import { evaluateConstraint, fhirPathBase, type FhirPathEnv } from "../fhirPath.js";
import type { Suggestion, SuggestionDeps } from "./types.js";
import { nodeAt } from "./util.js";

const RE_CONSTRAINT = /^Constraint failed: ([^:]+): /;
const MAX_ISSUES = 50;
const TERM_LEN = 160;

export interface InvariantPart {
  /** The sub-expression that is false here. */
  term: string;
  /** Element path (relative to the element the rule is on) the term needs, when it is an exists() test. */
  missing?: string;
  /** An extension test: its url, value type and the JSON to add under `extension`. */
  extension?: { url: string; value_type: string | null };
  write?: Record<string, unknown>;
  /** The value / code the term requires (`code = 'x'`, `exists(coding.code = 'x')`), when it names one. */
  expected?: string;
  /** A nested rule (`guard implies …`) this part is: what it needs. */
  nested?: { applies_because: string; need: "all" | "one_of"; failed: InvariantPart[] };
}

export interface InvariantInfo {
  key: string;
  /** The invariant's FHIRPath expression and human text, as the profile defines them (release v1). */
  expression?: string;
  human?: string;
  /** Literal values the expression requires (systems / codes / other `= 'x'` values / `matches()` formats). */
  literals?: InvariantLiterals;
  /** `all` = every listed part must hold; `one_of` = at least one of them. */
  need: "all" | "one_of";
  /** The guard that made the rule apply (`guard implies …`), when there is one. */
  applies_because?: string;
  failed: InvariantPart[];
  hint: string;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Split `expr` at a top-level keyword (` implies `, ` and `, ` or `), outside parentheses and quotes. */
export function splitTop(expr: string, word: "implies" | "and" | "or"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  const kw = ` ${word} `;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && expr.startsWith(kw, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + kw.length;
      i += kw.length - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts.filter(Boolean);
}

/** Strip parentheses wrapping the whole expression. */
export function unwrap(s: string): string {
  let t = s.trim();
  for (;;) {
    if (!t.startsWith("(") || !t.endsWith(")")) return t;
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") depth--;
      if (depth === 0 && i < t.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) return t;
    t = t.slice(1, -1).trim();
  }
}

const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** What an exists()-style term needs: a plain path, or an extension (url + value type). */
export function describeTerm(term: string): InvariantPart {
  const part: InvariantPart = { term: clip(term, TERM_LEN) };
  const t = unwrap(term.trim());
  // path = 'literal' (value.ofType(string) = 'class1', code = 'x')
  const eq = /^([A-Za-z][\w.()]*?)\s*=\s*'([^']*)'$/.exec(t);
  if (eq) {
    part.missing = eq[1].replace(/\.ofType\((\w+)\)/gu, (_m, ty) => cap(String(ty)));
    part.expected = eq[2];
    return part;
  }
  // X.exists(<condition>): an X matching the condition (category.exists(coding.code = 'tests'))
  const ex = /^([A-Za-z][\w.]*)\.exists\((.+)\)$/.exec(t);
  if (ex && ex[2].trim()) {
    part.missing = ex[1];
    const code = /code\s*=\s*'([^']+)'/.exec(ex[2]);
    if (code) part.expected = code[1];
    return part;
  }
  const m = /^(.+?)\.exists\(\)$/.exec(t);
  const inner = m ? m[1].trim() : null;
  if (!inner) return part;
  const ext = /^(?:(.+)\.)?extension\.where\(\s*url\s*=\s*'([^']+)'\s*\)(?:\.value(?:\.ofType\((\w+)\))?)?$/.exec(inner);
  if (ext) {
    const prefix = ext[1] ?? "";
    const type = ext[3] ?? null;
    part.missing = `${prefix ? `${prefix}.` : ""}extension`;
    part.extension = { url: ext[2], value_type: type };
    part.write = { url: ext[2], [type ? `value${cap(type)}` : "value[x]"]: `<${type ?? "value"}>` };
    return part;
  }
  if (/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(inner)) part.missing = inner;
  return part;
}

function containingResource(root: Record<string, any>, path: string): Record<string, any> {
  const m = /^Bundle\.entry\[(\d+)\]\.resource/.exec(path);
  if (m && Array.isArray(root.entry) && isObj(root.entry[Number(m[1])]?.resource)) return root.entry[Number(m[1])].resource;
  return root;
}

/** Explain one failed invariant on its node; null when it cannot be split / evaluated. */
export function explainInvariant(key: string, expression: string, node: unknown, base: string, env: FhirPathEnv): InvariantInfo | null {
  const holds = (e: string): boolean | null => {
    const r = evaluateConstraint(node, base, e, env);
    return r.status === "unevaluable" ? null : r.status === "pass";
  };
  let body = unwrap(expression);
  let because: string | undefined;
  const imp = splitTop(body, "implies");
  if (imp.length === 2) {
    if (holds(imp[0]) !== true) return null; // the rule does not apply here (or cannot be told)
    because = clip(unwrap(imp[0]), TERM_LEN);
    body = unwrap(imp[1]);
  } else if (imp.length > 2) return null;
  const ands = splitTop(body, "and").map(unwrap);
  const ors = ands.length === 1 ? splitTop(body, "or").map(unwrap) : [];
  let need: InvariantInfo["need"];
  let failed: InvariantPart[];
  if (ors.length > 1) {
    // none holds (the rule failed): every alternative is listed
    if (ors.some((t) => holds(t) !== false)) return null;
    need = "one_of";
    failed = ors.map(describeTerm);
  } else {
    if (ands.length < 2 && !because) return null; // a single atomic test: the message already says it
    const bad: string[] = [];
    for (const t of ands) {
      const h = holds(t);
      if (h === null) return null;
      if (!h) bad.push(t);
    }
    if (!bad.length) return null;
    // a single false part that is itself a rule (`guard implies …`): explain that rule
    if (bad.length === 1 && !because && splitTop(bad[0], "implies").length === 2) {
      const inner = explainInvariant(key, bad[0], node, base, env);
      if (inner) return inner;
    }
    need = "all";
    failed = bad.map((t) => {
      const p = describeTerm(t);
      if (splitTop(t, "implies").length === 2) {
        const inner = explainInvariant(key, t, node, base, env);
        if (inner) p.nested = { applies_because: inner.applies_because ?? "", need: inner.need, failed: inner.failed };
      }
      return p;
    });
  }
  const say = (p: InvariantPart): string =>
    p.extension
      ? `extension ${p.extension.url}${p.extension.value_type ? ` (value${cap(p.extension.value_type)})` : ""}`
      : p.nested
        ? `when ${p.nested.applies_because}: ${p.nested.need === "one_of" ? "one of " : ""}${p.nested.failed.map((q) => (q.missing ? `${q.missing}${q.expected !== undefined ? ` = '${q.expected}'` : ""}` : q.term)).join(" | ")}`
        : p.missing
          ? `${p.missing}${p.expected !== undefined ? ` = '${p.expected}'` : ""}`
          : p.term;
  const hint =
    `${because ? `the rule applies because ${because}; ` : ""}` +
    (need === "one_of" ? `add one of: ${failed.map(say).join(" | ")}` : `missing: ${failed.map(say).join("; ")}`) +
    (failed.some((p) => p.write) ? " — `write` shows the JSON to add" : "");
  return { key, need, ...(because ? { applies_because: because } : {}), failed, hint: clip(hint, 600) };
}

export interface InvariantLiterals {
  systems?: string[];
  codes?: Array<{ code: string; system?: string; display?: string }>;
  values?: Array<{ path: string; value: string }>;
  formats?: string[];
}

const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];

/**
 * The literal values an invariant names (`system = 'S'`, `code = 'C'`, `x = 'v'`, `matches('re')`): what an instance
 * must contain to satisfy it. A code is paired with the system tested in the same where(...) group when there is one.
 */
export function literalsOf(expression: string): InvariantLiterals {
  const out: InvariantLiterals = {};
  const systems = uniq([...expression.matchAll(/\bsystem\s*=\s*'([^']+)'/gu)].map((m) => m[1]));
  if (systems.length) out.systems = systems;
  const codes: Array<{ code: string; system?: string }> = [];
  for (const m of expression.matchAll(/\bcode\s*=\s*'([^']+)'/gu)) {
    // the nearest preceding system literal in the same group (no closing `)` that leaves the group in between)
    const before = expression.slice(0, m.index);
    const sm = [...before.matchAll(/\bsystem\s*=\s*'([^']+)'/gu)].pop();
    let system: string | undefined;
    if (sm && sm.index !== undefined) {
      const between = before.slice(sm.index);
      let depth = 0;
      for (const ch of between) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
      if (depth >= 0) system = sm[1];
    }
    if (!codes.some((c) => c.code === m[1] && c.system === system)) codes.push({ code: m[1], ...(system ? { system } : {}) });
  }
  if (codes.length) out.codes = codes;
  const values = [...expression.matchAll(/([A-Za-z][\w.]*)\s*=\s*'([^']*)'/gu)]
    .filter((m) => !/(?:^|\.)(?:system|code)$/u.test(m[1]))
    .map((m) => ({ path: m[1], value: m[2] }));
  if (values.length) out.values = values.filter((v, i) => values.findIndex((w) => w.path === v.path && w.value === v.value) === i);
  const formats = uniq([...expression.matchAll(/matches\('((?:[^'\\]|\\.)*)'\)/gu)].map((m) => m[1]));
  if (formats.length) out.formats = formats;
  return out;
}

/** Codings under `node` (instance path `path`) with their paths. */
function codingsUnder(node: unknown, path: string, out: Array<{ path: string; coding: Record<string, any> }> = [], depth = 0): Array<{ path: string; coding: Record<string, any> }> {
  if (depth > 8 || out.length > 200) return out;
  if (Array.isArray(node)) node.forEach((n, i) => codingsUnder(n, `${path}[${i}]`, out, depth + 1));
  else if (isObj(node)) {
    if (typeof node.code === "string" && (typeof node.system === "string" || "display" in node)) out.push({ path, coding: node });
    for (const [k, v] of Object.entries(node)) if (k !== "extension" && typeof v === "object" && v !== null) codingsUnder(v, `${path}.${k}`, out, depth + 1);
  }
  return out;
}

/**
 * Patches from the invariant's literals: a coding of the system the rule tests whose code is not one the rule
 * accepts → replace its code by each accepted code (several: one suggestion each, the code's display saying when it
 * applies); an accepted code under another system → replace the system. Never invents a coding the instance lacks.
 */
const STOP = new Set(["the", "and", "for", "with", "where", "number", "identifier", "code", "type", "card", "table"]);
const words = (t: string | null | undefined): Set<string> => new Set(String(t ?? "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u).filter((w) => w.length > 2 && !STOP.has(w)));

/**
 * Patches from the invariant's literals: a coding of the system the rule tests whose code is not one the rule
 * accepts → replace its code by an accepted code; an accepted code under another system → replace the system. Never
 * invents a coding the instance lacks. When several codings could be changed, only those whose current code means
 * something like an accepted code (shared words of the displays — e.g. NI "National unique individual identifier" vs
 * NNxxx "National Person Identifier …") are proposed; each of their candidates says which situation it is for.
 */
export async function literalSuggestions(
  key: string,
  lits: InvariantLiterals,
  node: unknown,
  path: string,
  displayOf?: (system: string, code: string) => Promise<string | null>,
): Promise<Suggestion[]> {
  const codes = lits.codes ?? [];
  if (!codes.length) return [];
  const targets: Array<{ p: string; sys: string | undefined; cands: Array<{ c: (typeof codes)[number]; score: number }> }> = [];
  const out: Suggestion[] = [];
  for (const { path: p, coding } of codingsUnder(node, path)) {
    const sys = typeof coding.system === "string" ? coding.system : undefined;
    if (codes.some((c) => c.code === coding.code && (!c.system || c.system === sys))) continue;
    const forSystem = codes.filter((c) => c.system && c.system === sys);
    if (forSystem.length) {
      const mine = words(typeof coding.display === "string" ? coding.display : sys && displayOf ? await displayOf(sys, String(coding.code)).catch(() => null) : null);
      const cands = forSystem.map((c) => ({ c, score: [...words(c.display)].filter((w) => mine.has(w)).length }));
      targets.push({ p, sys, cands });
      continue;
    }
    const sameCode = codes.filter((c) => c.code === coding.code && c.system);
    if (sameCode.length === 1)
      out.push({ value: sameCode[0].system!, kind: "replace_system", confidence: 0.6, reason: `invariant ${key} tests code ${coding.code} with system ${sameCode[0].system}`, patch: { op: "replace", path: `${p}.system`, value: sameCode[0].system } });
  }
  const best = Math.max(0, ...targets.map((t) => Math.max(...t.cands.map((x) => x.score))));
  for (const t of targets) {
    if (best > 0 && Math.max(...t.cands.map((x) => x.score)) < best) continue; // another coding is the one the rule is about
    const ranked = [...t.cands].sort((a, b) => b.score - a.score);
    ranked.forEach(({ c }, i) =>
      out.push({
        value: c.code,
        kind: "replace_code",
        confidence: Math.round(Math.max(0.3, (best > 0 ? 0.75 : 0.55) - i * 0.1) * 100) / 100,
        reason: `invariant ${key} accepts ${t.sys}#${c.code}${c.display ? ` (${c.display})` : ""}${ranked.length > 1 ? `; alternatives: ${ranked.filter((x) => x.c !== c).map((x) => `${x.c.code}${x.c.display ? ` = ${x.c.display}` : ""}`).join("; ")} — use the one that matches the record's value` : ""}`,
        ...(t.sys ? { system: t.sys } : {}),
        ...(c.display ? { display: c.display } : {}),
        patch: { op: "replace", path: `${t.p}.code`, value: c.code },
      }),
    );
  }
  return out.slice(0, 8);
}

/** Instance path → element path of the resource (`Bundle.entry[0].resource.diagnosis[1]` → `Claim.diagnosis`). */
function elementPathOf(root: Record<string, any>, path: string): string {
  const m = /^Bundle\.entry\[(\d+)\]\.resource(.*)$/.exec(path);
  const rt = m ? String(containingResource(root, path).resourceType || "") : path.split(".")[0];
  const rest = m ? m[2] : path.slice(path.split(".")[0].length);
  return `${rt}${rest.replace(/\[\d+\]/g, "")}`;
}

/** Explain one `{path, message}` item (an issue, or a blocking error of slice_match / profile_match); null when it cannot. */
async function explainItem(
  item: Record<string, any>,
  profile: string,
  root: Record<string, any>,
  sdOf: (url: string) => Promise<Record<string, any> | null>,
  lookupDisplay?: (system: string, code: string) => Promise<string | null>,
): Promise<InvariantInfo | null> {
  const m = RE_CONSTRAINT.exec(String(item.message || ""));
  if (!m || m[1] === "ele-1") return null;
  const sd = await sdOf(profile.split("|")[0]);
  const els: Array<Record<string, any>> = (sd?.snapshot || {}).element || [];
  const path = String(item.path || "");
  const ep = elementPathOf(root, path);
  // the element the rule is on: the issue's element id, else the element of that path carrying the key
  const el =
    (typeof item.element === "string" ? els.find((e) => e.id === item.element) : undefined) ??
    els.find((e) => e.path === ep && (e.constraint || []).some((x: any) => x.key === m[1]));
  const c = (el?.constraint || []).find((x: any) => x.key === m[1]);
  if (!el || !c?.expression) return null;
  const node = nodeAt(root, path);
  if (node === undefined) return null;
  const types = (el.type || []).map((t: any) => String(t.code));
  const base = fhirPathBase(String(el.path || sd?.type || ""), types.length === 1 ? types[0] : null);
  const expression = String(c.expression);
  const info: InvariantInfo = explainInvariant(m[1], expression, node, base, { resource: containingResource(root, path), rootResource: root }) ?? { key: m[1], need: "all", failed: [], hint: "" };
  // release v1: the expression itself and the literal values it requires — the official message only restates the
  // (often non-English) human text, so the caller can see which system / code / format the rule wants
  info.expression = clip(expression, 1200);
  if (typeof c.human === "string") info.human = clip(c.human, 400);
  const lits = literalsOf(expression);
  if (lits.codes?.length && lookupDisplay) {
    for (const code of lits.codes) {
      if (!code.system) continue;
      const d = await lookupDisplay(code.system, code.code).catch(() => null);
      if (d) code.display = d;
    }
  }
  if (Object.keys(lits).length) info.literals = lits;
  const accepted = lits.codes?.length
    ? `accepted: ${lits.codes.map((x) => `${x.system ? `${x.system}#` : ""}${x.code}${x.display ? ` (${x.display})` : ""}`).join(" | ")}`
    : "";
  const fmt = lits.formats?.length ? `format: ${lits.formats.join(" | ")}` : "";
  info.hint = clip([info.hint, accepted, fmt, `rule: ${clip(expression, 300)}`].filter(Boolean).join("; "), 900);
  const sugg = await literalSuggestions(m[1], lits, node, path, lookupDisplay);
  if (sugg.length) (info as InvariantInfo & { _suggestions?: Suggestion[] })._suggestions = sugg;
  return info;
}

/**
 * Attach `invariant` to failed-invariant issues (profile constraints) and to the failed-invariant
 * blocking errors of slice_match / profile_match (an entry that matches no slice because of a
 * rule — the rule's own error is then only reported there), in place. Never throws.
 */
export async function attachInvariantExplanations(issues: Array<Record<string, any>>, root: Record<string, any>, deps: SuggestionDeps): Promise<void> {
  let n = 0;
  const sds = new Map<string, Record<string, any> | null>();
  const sdOf = async (url: string): Promise<Record<string, any> | null> => {
    if (!sds.has(url)) sds.set(url, await deps.fetchStructureDefinition(url).catch(() => null));
    return sds.get(url) ?? null;
  };
  // a code's display (when the system is held locally), naming the situation each accepted code is for
  const lookupDisplay = async (system: string, code: string): Promise<string | null> =>
    (deps.displayOf ? await deps.displayOf(system, code).catch(() => null) : null) ??
    (deps.nearCodes ? ((await deps.nearCodes(system, code, 5).catch(() => [])).find((x) => x.code === code)?.display ?? null) : null);
  const explain = async (item: Record<string, any>, profile: unknown, top: boolean): Promise<void> => {
    if (n >= MAX_ISSUES || item.invariant || typeof profile !== "string" || !RE_CONSTRAINT.test(String(item.message || ""))) return;
    n++;
    try {
      const info = await explainItem(item, profile, root, sdOf, lookupDisplay);
      if (!info) return;
      const sugg = (info as InvariantInfo & { _suggestions?: Suggestion[] })._suggestions;
      delete (info as InvariantInfo & { _suggestions?: Suggestion[] })._suggestions;
      item.invariant = info;
      if (top && sugg?.length) item.suggestions = [...(Array.isArray(item.suggestions) ? item.suggestions : []), ...sugg];
    } catch {
      // fail-open
    }
  };
  for (const issue of issues) {
    if (!isObj(issue)) continue;
    if (issue.code === "invariant" && typeof issue.element === "string") await explain(issue, issue.profile, true);
    else if (RE_CONSTRAINT.test(String(issue.message || ""))) {
      // the official validator's form: no element id, the profile named in the message (`(defined in <url>)`)
      const defined = /\(defined in (\S+?)\)\s*$/u.exec(String(issue.message))?.[1] ?? (typeof issue.profile === "string" ? issue.profile : undefined);
      await explain(issue, defined, true);
    }
    for (const f of ["slice_match", "profile_match"] as const) {
      const info = issue[f];
      if (!isObj(info) || !Array.isArray(info.blocking)) continue;
      const profile = info.closest?.profile;
      for (const b of info.blocking) if (isObj(b)) await explain(b, profile, false);
    }
  }
}
