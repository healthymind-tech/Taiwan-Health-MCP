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
import type { SuggestionDeps } from "./types.js";
import { nodeAt } from "./util.js";

const RE_CONSTRAINT = /^Constraint failed: ([^:]+): /;
const MAX_ISSUES = 20;
const TERM_LEN = 160;

export interface InvariantPart {
  /** The sub-expression that is false here. */
  term: string;
  /** Element path (relative to the element the rule is on) the term needs, when it is an exists() test. */
  missing?: string;
  /** An extension test: its url, value type and the JSON to add under `extension`. */
  extension?: { url: string; value_type: string | null };
  write?: Record<string, unknown>;
}

export interface InvariantInfo {
  key: string;
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
  const m = /^(.+?)\.exists\(\)$/.exec(term.trim());
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
    need = "all";
    failed = bad.map(describeTerm);
  }
  const say = (p: InvariantPart): string => (p.extension ? `extension ${p.extension.url}${p.extension.value_type ? ` (value${cap(p.extension.value_type)})` : ""}` : p.missing ?? p.term);
  const hint =
    `${because ? `the rule applies because ${because}; ` : ""}` +
    (need === "one_of" ? `add one of: ${failed.map(say).join(" | ")}` : `missing: ${failed.map(say).join("; ")}`) +
    (failed.some((p) => p.write) ? " — `write` shows the JSON to add" : "");
  return { key, need, ...(because ? { applies_because: because } : {}), failed, hint: clip(hint, 600) };
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
  return explainInvariant(m[1], String(c.expression), node, base, { resource: containingResource(root, path), rootResource: root });
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
  const explain = async (item: Record<string, any>, profile: unknown): Promise<void> => {
    if (n >= MAX_ISSUES || item.invariant || typeof profile !== "string" || !RE_CONSTRAINT.test(String(item.message || ""))) return;
    n++;
    try {
      const info = await explainItem(item, profile, root, sdOf);
      if (info) item.invariant = info;
    } catch {
      // fail-open
    }
  };
  for (const issue of issues) {
    if (!isObj(issue)) continue;
    if (issue.code === "invariant" && typeof issue.element === "string") await explain(issue, issue.profile);
    for (const f of ["slice_match", "profile_match"] as const) {
      const info = issue[f];
      if (!isObj(info) || !Array.isArray(info.blocking)) continue;
      const profile = info.closest?.profile;
      for (const b of info.blocking) if (isObj(b)) await explain(b, profile);
    }
  }
}
