/**
 * Minimal-repro extraction for a parity mismatch: greedily drops JSON members / array items of an instance while the
 * mismatch still reproduces with the TS validator, so the other agents get a small case to port against.
 *
 * Target kinds:
 *  - `extra`:   an error we report that validator_cli does not → keep reducing while our issues still contain it;
 *  - `missing`: an official error we do not report → keep reducing while the element at its location still exists
 *               and our issues still lack it (validator_cli is not re-run here, so the reduced case is a candidate:
 *               it keeps the official location and everything not needed for our non-report — confirm upstream).
 * Members on the target location and `resourceType` / `url` / `meta.profile` / `fullUrl` are never dropped.
 */
import { normMessage, normPath, type SimpleIssue } from "./compare.js";
import type { Res } from "./packages.js";

export interface Target {
  kind: "extra" | "missing";
  path: string;
  message: string;
}

const KEEP = new Set(["resourceType", "url", "fullUrl"]);

/** Instance path → JSON member chain, e.g. Bundle.entry[1].resource.code.coding[0] → [entry,1,resource,code,coding,0]. */
export function pathKeys(path: string): Array<string | number> {
  const p = normPath(path).split(".").slice(1);
  const out: Array<string | number> = [];
  for (const seg of p) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(seg);
    if (!m) {
      out.push(seg);
      continue;
    }
    out.push(m[1]);
    for (const ix of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(ix[1]));
  }
  return out;
}

function exists(root: any, keys: Array<string | number>): boolean {
  let n = root;
  for (const k of keys) {
    if (n === null || typeof n !== "object") return false;
    if (typeof k === "number" && !Array.isArray(n)) {
      if (k !== 0) return false; // a single value addressed as [0]
      continue;
    }
    if (!(k in n)) return false;
    n = n[k as any];
  }
  return true;
}

const same = (i: SimpleIssue, t: Target): boolean =>
  (i.severity === "error" || i.severity === "fatal") && normPath(i.path) === normPath(t.path) && normMessage(i.message) === normMessage(t.message);

/** Every removable location (parent chain + key), deepest last. */
function* locations(node: any, chain: Array<string | number> = []): Generator<Array<string | number>> {
  if (node === null || typeof node !== "object") return;
  const keys: Array<string | number> = Array.isArray(node) ? node.map((_, i) => i).reverse() : Object.keys(node);
  for (const k of keys) {
    const c = [...chain, k];
    yield c;
    yield* locations(node[k as any], c);
  }
}

function without(root: any, loc: Array<string | number>): any {
  const copy = structuredClone(root);
  let n = copy;
  for (const k of loc.slice(0, -1)) n = n?.[k as any];
  if (n === null || typeof n !== "object") return null;
  const last = loc[loc.length - 1];
  if (Array.isArray(n)) n.splice(last as number, 1);
  else delete n[last as string];
  return copy;
}

const isPrefix = (a: Array<string | number>, b: Array<string | number>): boolean => a.length <= b.length && a.every((x, i) => x === b[i]);

export async function minimize(
  instance: Res,
  target: Target,
  validate: (r: Res) => Promise<SimpleIssue[]>,
  opts: { maxSteps?: number } = {},
): Promise<{ instance: Res; steps: number; reproduced: boolean }> {
  const tkeys = pathKeys(target.path);
  const holds = async (r: Res): Promise<boolean> => {
    let issues: SimpleIssue[];
    try {
      issues = await validate(r);
    } catch {
      return false;
    }
    return target.kind === "extra" ? issues.some((i) => same(i, target)) : exists(r, tkeys) && !issues.some((i) => same(i, target));
  };
  if (!(await holds(instance))) return { instance, steps: 0, reproduced: false };
  let cur = instance;
  let steps = 0;
  const max = opts.maxSteps ?? 400;
  let changed = true;
  while (changed && steps < max) {
    changed = false;
    // top-down: try the largest subtrees first; restart after each successful removal (indices shift)
    for (const loc of locations(cur)) {
      if (steps >= max) break;
      const last = loc[loc.length - 1];
      if (typeof last === "string" && KEEP.has(last)) continue;
      if (loc.includes("meta") && loc.includes("profile")) continue;
      if (isPrefix(loc, tkeys)) continue; // on the way to the target location
      const cand = without(cur, loc);
      if (!cand) continue;
      steps++;
      if (await holds(cand)) {
        cur = cand;
        changed = true;
        break;
      }
    }
  }
  return { instance: cur, steps, reproduced: true };
}
