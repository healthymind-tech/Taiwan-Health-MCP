/**
 * Bound `code` primitives (rule `code`): a value of an element with a REQUIRED binding that is
 * not a code of the ValueSet, but is — in a complete local expansion of at most 200 codes — the
 * case-different spelling of exactly one code, or exactly one code's display (same words after
 * normalisation): `hour` in Timing.repeat.periodUnit (units-of-time) is code `h`, display 'hour'.
 * Several / none → left as written (the validator's binding error and its suggestions stand).
 */

import type { RepairChange, RepairIssue } from "./types.js";
import { isObject, type Session, type Site } from "./walk.js";

function bag(s: string): string {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9㐀-鿿]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

export async function repairCodes(session: Session, sites: Site[], rp: (p: string) => string, skip: (p: string) => boolean): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  if (!session.deps.expandValueSet) return { changes, issues };
  for (const site of sites) {
    if (site.type !== "code" || typeof site.value !== "string" || !site.value.trim() || skip(site.path)) continue;
    // Coding.code / Quantity.code are judged with their system (other rules).
    if (["Coding", "Quantity", "SimpleQuantity", "Age", "Duration", "Count", "Distance", "MoneyQuantity"].includes(site.ownerType)) continue;
    const vsUrls = [...new Set(site.defs.map((d) => (isObject(d.binding) && d.binding.strength === "required" && typeof d.binding.valueSet === "string" ? d.binding.valueSet : null)).filter((x): x is string => !!x))];
    if (vsUrls.length !== 1) continue;
    const vs = vsUrls[0];
    const value = site.value;
    const exp = await session.memo(`exp\0${vs}`, () => session.deps.expandValueSet!(vs, 500), null);
    if (!exp || exp.truncated || exp.incomplete || !exp.codings.length || exp.codings.length > 200) continue;
    if (exp.codings.some((c) => c.code === value)) continue;
    const lower = value.trim().toLowerCase();
    const b = bag(value);
    const hits = new Map<string, { code: string; why: string }>();
    for (const c of exp.codings) {
      if (c.code.toLowerCase() === lower) hits.set(c.code, { code: c.code, why: `'${value}' is code '${c.code}' written in another case` });
      else if (c.display && b && bag(c.display) === b) hits.set(c.code, { code: c.code, why: `'${value}' is the display of code '${c.code}'` });
    }
    if (hits.size !== 1) continue;
    const [hit] = [...hits.values()];
    if (site.index === null) site.holder[site.key] = hit.code;
    else (site.holder[site.key] as unknown[])[site.index] = hit.code;
    changes.push({ path: rp(site.path), from: value, to: hit.code, rule: "code", reason: `${hit.why} in the required ValueSet ${vs.split("|")[0]}` });
  }
  return { changes, issues };
}

/**
 * (v17.3) Coding.code that is not a code of its CodeSystem (the validator's "Unknown code" — a wrong check digit
 * 4548-5, a retired / mistyped code) while its display names EXACTLY one code of that system (same words after
 * normalisation, the terminology's own name): the code is replaced by that one (rule `code`). No display, several
 * exact names or only near ones → left as written (the validator's error and its replace_code suggestions stand).
 */
export async function repairUnknownCodings(session: Session, sites: Site[], rp: (p: string) => string, skip: (p: string) => boolean): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  const { codeInSystem, normalize } = session.deps;
  if (!codeInSystem || !normalize) return { changes, issues };
  for (const site of sites) {
    if (site.type !== "Coding" || !isObject(site.value) || skip(site.path)) continue;
    const c = site.value;
    const system = typeof c.system === "string" ? c.system.trim() : "";
    const code = typeof c.code === "string" ? c.code.trim() : "";
    const display = typeof c.display === "string" ? c.display.trim() : "";
    if (!system || !code || !display || system === "http://unitsofmeasure.org") continue;
    const known = await session.memo(`cis\0${system}\0${code}`, () => codeInSystem(system, code), undefined);
    if (known !== false) continue;
    const cands = await session.memo(`norm\0${system}\0${display}`, () => normalize(display, { system }, 5), [] as Awaited<ReturnType<typeof normalize>>);
    const want = bag(display);
    const exact = [...new Map(cands.filter((x) => x.code && x.code !== code && (!x.system || x.system === system) && x.display && bag(x.display) === want && x.accepted !== false).map((x) => [x.code, x])).values()];
    if (exact.length !== 1) continue;
    const to = exact[0];
    const from = { ...c };
    c.code = to.code;
    if (to.display && to.display !== display) c.display = to.display;
    changes.push({
      path: rp(`${site.path}.code`), from: from.code, to: to.code, rule: "code",
      reason: `'${from.code}' is not a code of ${system}; its display '${display}' is exactly the name of one code there, '${to.code}' — the code was corrected (the display is kept)`,
    });
  }
  return { changes, issues };
}
