/**
 * R2 — Quantity units (any element of a Quantity type: valueQuantity, component[].valueQuantity,
 * doseQuantity, Duration, Age …). A Quantity whose UCUM code is missing, not valid UCUM, not a
 * unit at all (a LOINC code written into Quantity.code) or not one the profile allows is given
 * the UCUM code its own text determines — and only when that is unique:
 *
 *   evidence   the unit text and the code text, each read by ucumUnits.resolveUnit (a valid UCUM
 *              expression; UCUM names / synonyms / print symbols; the `<count>/<time>` rate
 *              grammar; cheap spelling repairs). A LOINC-shaped code is not unit evidence.
 *   profile    fixed / pattern code and system of the element (slices the discriminators decide
 *              included) and required bindings on the Quantity or its code (ucum-bodytemp …):
 *              a derived code must be allowed. A bare time unit read in an element whose allowed
 *              codes are its per-time rate (`min` where the profile fixes `/min`) is that rate.
 *   unique     every piece of evidence must give the same allowed code; otherwise nothing is
 *              changed and an issue lists the candidates (and the allowed codes).
 * system is set to http://unitsofmeasure.org with the code; a Quantity.system naming another real
 * CodeSystem (not UCUM, not a ValueSet / unknown URL, not LOINC) is never touched.
 */

import { fixedPattern } from "../fhirSnapshot.js";
import { checkUcumCode, UCUM_SYSTEM } from "../fhirUcum.js";
import type { RepairChange, RepairIssue } from "./types.js";
import { resolveUnit } from "./ucumUnits.js";
import { childDefs, isObject, QUANTITY_TYPES, type Session, type Site } from "./walk.js";

const LOINC_SHAPE = /^(LA|LP|LL|LG)?\d{1,7}-\d$/;
const TIME_CODES = new Set(["s", "min", "h", "d", "wk", "mo", "a"]);
const LOINC = "http://loinc.org";

type El = Record<string, any>;

function ucumValid(c: string): boolean {
  return checkUcumCode(c) === "valid";
}

/** fixed / pattern value of a definition (either), else undefined. */
function pinOf(el: El): unknown {
  const [f, p] = fixedPattern(el);
  return f ? f.value : p ? p.value : undefined;
}

interface Constraints {
  /** Codes the element pins (fixed / pattern on .code, or the Quantity's own fixed / pattern). */
  fixed: Set<string>;
  fixedSystem: Set<string>;
  /** Required ValueSets on the Quantity or its code. */
  valueSets: Set<string>;
}

function constraintsOf(site: Site): Constraints {
  const c: Constraints = { fixed: new Set(), fixedSystem: new Set(), valueSets: new Set() };
  for (const d of site.defs) {
    const v = pinOf(d);
    if (isObject(v)) {
      if (typeof v.code === "string") c.fixed.add(v.code);
      if (typeof v.system === "string") c.fixedSystem.add(v.system);
    }
    const b = isObject(d.binding) ? d.binding : null;
    if (b && b.strength === "required" && typeof b.valueSet === "string") c.valueSets.add(b.valueSet);
  }
  for (const d of childDefs(site.members, "code")) {
    const v = pinOf(d);
    if (typeof v === "string") c.fixed.add(v);
    const b = isObject(d.binding) ? d.binding : null;
    if (b && b.strength === "required" && typeof b.valueSet === "string") c.valueSets.add(b.valueSet);
  }
  for (const d of childDefs(site.members, "system")) {
    const v = pinOf(d);
    if (typeof v === "string") c.fixedSystem.add(v);
  }
  return c;
}

/** Allowed UCUM codes (null = unconstrained; empty set = constrained but unknown → never decided). */
async function allowedCodes(session: Session, c: Constraints): Promise<{ allowed: Set<string> | null; undecidable: boolean; label: string[] }> {
  let allowed: Set<string> | null = null;
  const label: string[] = [];
  const meet = (s: Set<string>): void => {
    allowed = allowed === null ? new Set(s) : new Set([...allowed].filter((x) => s.has(x)));
  };
  if (c.fixed.size) {
    meet(c.fixed);
    label.push(`fixed by the profile: ${[...c.fixed].join(", ")}`);
  }
  let undecidable = false;
  for (const vs of c.valueSets) {
    const exp = session.deps.expandValueSet ? await session.memo(`exp\0${vs}`, () => session.deps.expandValueSet!(vs, 500), null) : null;
    if (!exp || exp.truncated || exp.incomplete || !exp.codings.length) {
      undecidable = true;
      continue;
    }
    const codes = new Set(exp.codings.filter((x) => !x.system || x.system === UCUM_SYSTEM).map((x) => x.code));
    meet(codes);
    label.push(`required ValueSet ${vs.split("|")[0]}: ${[...codes].slice(0, 8).join(", ")}${codes.size > 8 ? " …" : ""}`);
  }
  return { allowed, undecidable, label };
}

/** A derived code fitted to the allowed set (null = not allowed). */
function fit(code: string, allowed: Set<string> | null): { code: string; rate: boolean } | null {
  if (allowed === null || allowed.has(code)) return { code, rate: false };
  if (TIME_CODES.has(code) && allowed.has(`/${code}`)) return { code: `/${code}`, rate: true };
  return null;
}

/** May the Quantity's system be (re)set to UCUM? */
async function systemReplaceable(session: Session, system: unknown, code: string | null, c: Constraints): Promise<boolean> {
  if (system === undefined || system === null || system === "" || system === UCUM_SYSTEM) return true;
  if (typeof system !== "string") return true;
  if (c.fixedSystem.has(UCUM_SYSTEM)) return true;
  if (system === LOINC) return true; // LOINC is never a unit system (LOINC units are UCUM)
  if (code && LOINC_SHAPE.test(code)) return true;
  if (!session.deps.resolveSystem) return false;
  const res = await session.memo(`sys\0${system}\0${code ?? ""}`, () => session.deps.resolveSystem!(system.split("|")[0], code ?? ""), null);
  return !!res && (res.kind === "valueset" || res.kind === "unknown");
}

/** The code strings a non-string Quantity.code carries ({code} / {coding: [{code}]}). */
function innerCodes(v: unknown): string[] {
  if (!isObject(v)) return [];
  const out: string[] = [];
  if (typeof v.code === "string") out.push(v.code);
  if (Array.isArray(v.coding)) for (const c of v.coding) if (isObject(c) && typeof c.code === "string") out.push(c.code);
  return out;
}

export async function repairUnits(session: Session, sites: Site[], rp: (p: string) => string, skip: (p: string) => boolean): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  for (const site of sites) {
    if (!QUANTITY_TYPES.has(site.type) || !isObject(site.value) || site.unknown) continue;
    const q = site.value;
    if (skip(`${site.path}.code`)) continue;
    const unit = typeof q.unit === "string" && q.unit.trim() ? q.unit.trim() : null;
    const rawCode = q.code;
    const cur = typeof rawCode === "string" && rawCode.trim() ? rawCode.trim() : null;
    if (rawCode === undefined && !unit) continue;
    const c = constraintsOf(site);
    const { allowed, undecidable, label } = await allowedCodes(session, c);
    const sysOk = q.system === UCUM_SYSTEM || ((q.system === undefined || q.system === null) && !cur);
    const curState =
      cur !== null && ucumValid(cur) && !LOINC_SHAPE.test(cur) && (allowed === null || allowed.has(cur)) && (q.system === UCUM_SYSTEM || q.system === undefined);
    // Valid UCUM, allowed, system UCUM → nothing to do. A valid code without a system: only when the
    // profile pins the system or the unit text names the same code (the code is then UCUM, uniquely).
    if (curState && q.system === UCUM_SYSTEM) continue;
    if (curState && q.system === undefined) {
      const unitCode = unit ? resolveUnit(unit)?.code : null;
      if (c.fixedSystem.has(UCUM_SYSTEM) || unitCode === cur) {
        q.system = UCUM_SYSTEM;
        changes.push({ path: rp(`${site.path}.system`), from: null, to: UCUM_SYSTEM, rule: "ucum", reason: `'${cur}' is a valid UCUM code${unitCode === cur ? ` matching unit '${unit}'` : " and the profile pins the UCUM system"}` });
      }
      continue;
    }
    if (rawCode === undefined && sysOk && q.system === UCUM_SYSTEM && !unit) continue;
    if (typeof q.system === "string" && q.system !== UCUM_SYSTEM && !(await systemReplaceable(session, q.system, cur, c))) continue;
    if (undecidable && allowed === null && c.fixed.size === 0) {
      // A required binding we cannot expand: the allowed codes are unknown — decide nothing.
      continue;
    }
    // Evidence.
    const ev: Array<{ code: string; why: string }> = [];
    const codeTexts = cur !== null ? [cur] : innerCodes(rawCode);
    for (const t of codeTexts) {
      if (LOINC_SHAPE.test(t)) continue;
      if (ucumValid(t)) ev.push({ code: t, why: `code '${t}'` });
      else {
        const r = resolveUnit(t);
        if (r) ev.push({ code: r.code, why: `code '${t}' is not UCUM; UCUM writes it '${r.code}'` });
      }
    }
    if (unit) {
      const r = resolveUnit(unit);
      if (r) ev.push({ code: r.code, why: r.code === unit ? `unit '${unit}' is UCUM` : `unit '${unit}' is UCUM '${r.code}'` });
    }
    const fitted = ev.map((e) => ({ ...e, fit: fit(e.code, allowed) }));
    const distinct = [...new Set(fitted.map((f) => (f.fit ? f.fit.code : `!${f.code}`)))];
    const path = rp(site.path);
    const allowedList = allowed ? [...(allowed as Set<string>)].slice(0, 10) : [];
    if (!ev.length) {
      const what = cur !== null ? `code '${cur}'` : rawCode !== undefined ? "the code given" : "no code";
      issues.push({
        path: rp(`${site.path}.code`), rule: "ucum", severity: "error",
        message: `${site.type} at ${path}: ${what}${unit ? ` and unit '${unit}'` : ""} determine no UCUM code${allowedList.length ? ` (allowed: ${allowedList.join(", ")})` : ""}; give a UCUM code (system ${UCUM_SYSTEM})`,
        ...(allowedList.length ? { candidates: allowedList } : {}),
      });
      continue;
    }
    if (distinct.length !== 1 || distinct[0].startsWith("!")) {
      const cands = [...new Set([...fitted.filter((f) => f.fit).map((f) => f.fit!.code), ...allowedList])].slice(0, 10);
      issues.push({
        path: rp(`${site.path}.code`), rule: "ucum", severity: "error",
        message:
          `${site.type} at ${path}: the UCUM code is not uniquely determined — ${fitted.map((f) => `${f.why}${f.fit ? "" : allowed ? " (not allowed here)" : ""}`).join("; ")}` +
          `${label.length ? ` [${label.join("; ")}]` : ""}; not changed`,
        ...(cands.length ? { candidates: cands } : {}),
      });
      continue;
    }
    const target = fitted[0].fit!.code;
    const rate = fitted.some((f) => f.fit?.rate);
    const reason =
      `${fitted.map((f) => f.why).join("; ")}${rate ? `; read as the rate '${target}' the element allows` : ""}` + `${label.length ? ` (${label.join("; ")})` : ""}`;
    if (rawCode !== target) {
      changes.push({ path: rp(`${site.path}.code`), from: rawCode === undefined ? null : rawCode, to: target, rule: "ucum", reason });
      q.code = target;
    }
    if (q.system !== UCUM_SYSTEM) {
      changes.push({ path: rp(`${site.path}.system`), from: q.system === undefined ? null : q.system, to: UCUM_SYSTEM, rule: "ucum", reason: `the code '${target}' is UCUM` });
      if ("system" in q) q.system = UCUM_SYSTEM;
      else {
        // keep FHIR's conventional order: value, comparator, unit, system, code
        const entries = Object.entries(q);
        for (const k of Object.keys(q)) delete q[k];
        let placed = false;
        for (const [k, v] of entries) {
          if (k === "code" && !placed) {
            q.system = UCUM_SYSTEM;
            placed = true;
          }
          q[k] = v;
        }
        if (!placed) q.system = UCUM_SYSTEM;
      }
    }
  }
  return { changes, issues };
}
