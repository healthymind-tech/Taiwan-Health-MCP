/**
 * ISSUES_v17.2 — the IG-defined values of the profiles an instance declares (grounding/igDefined.ts):
 * fixed[x] / pattern[x] of every snapshot element, string literals of the profiles' invariants, and
 * every ig-constant of fhir_get_minimal_skeleton for the same profile — the same function the skeleton
 * tool runs, so the two cannot disagree. For an administrative entity (Organization …) in the instance,
 * the profiles the IG's own examples of that type declare are read too, so the IG's payer agency is
 * exempt wherever it is written. Since ISSUES_v17.4 the skeleton takes example identity values only for a
 * national payer / authority organization (nationalOrgs.ts), so an example hospital's name / identifier is
 * a record fact here too. IG-agnostic; fail-open per profile.
 */

import { envBudgetBytes } from "../memSize.js";
import { allLeaves, normIgValue, type IgDefinedValues } from "../grounding/igDefined.js";
import { TtlMemo } from "../ttlMemo.js";
import { isObject, stripVersion, type BlueprintDeps } from "./common.js";
import { CONSTANT_ENTITY_TYPES, minimalSkeleton } from "./skeleton.js";

type Json = Record<string, any>;

interface ProfileValues {
  constants: string[];
  literals: string[];
}

const memo = new TtlMemo<ProfileValues>(30 * 60_000, 400, envBudgetBytes("IG_VALUES_CACHE_MB", 64));

/** Invariants of the FHIR core (dom-*, ele-1 …) are not the IG's. */
const CORE_SD = "http://hl7.org/fhir/StructureDefinition/";

const RE_VALUE_EQ = /\bvalue(?:\.ofType\(\s*\w+\s*\)|String|Code)?\s*(?:=|~)\s*'((?:[^'\\]|\\.){1,200})'/gu;
const RE_VALUE_IN = /\bvalue(?:\.ofType\(\s*\w+\s*\)|String|Code)?\s+in\s+\(([^)]{1,2000})\)/gu;
const RE_LITERAL = /'((?:[^'\\]|\\.){1,200})'/gu;

/**
 * Literals an invariant allows for the value itself (`value.ofType(string) = 'class1'`, `value in ('A' | 'B')`) —
 * the IG's own answer list. Literals compared with any other element (gender = 'male' as a guard) are not values
 * the IG defines and are ignored.
 */
export function invariantLiterals(expression: string): string[] {
  const out: string[] = [];
  const unq = (x: string): string => normIgValue(x.replace(/\\(.)/gu, "$1"));
  for (const m of expression.matchAll(RE_VALUE_EQ)) if (m[1].trim()) out.push(unq(m[1]));
  for (const m of expression.matchAll(RE_VALUE_IN)) for (const l of m[1].matchAll(RE_LITERAL)) if (l[1].trim()) out.push(unq(l[1]));
  return out;
}

async function profileValues(url: string, packageId: string | null, version: string | null, deps: BlueprintDeps): Promise<ProfileValues> {
  const constants: string[] = [];
  const literals: string[] = [];
  try {
    const loaded = await deps.loadProfile(url, packageId, version);
    for (const e of (loaded.sd?.snapshot?.element || []) as Json[]) {
      for (const [k, v] of Object.entries(e)) if (k.startsWith("fixed") || k.startsWith("pattern")) allLeaves(v, constants);
      for (const c of (e.constraint || []) as Json[]) if (typeof c?.expression === "string" && !String(c.source ?? "").startsWith(CORE_SD)) literals.push(...invariantLiterals(c.expression));
    }
  } catch {
    return { constants, literals };
  }
  try {
    const sk = await minimalSkeleton({ profile: url, package_id: packageId, version }, deps);
    for (const c of sk.igConstants ?? []) allLeaves(c.value, constants);
  } catch {
    // fail-open: fixed / pattern / literals still apply
  }
  return { constants, literals };
}

/** Declared profiles (unversioned) of a Bundle's entries or of one resource, with their resource types. */
function declared(root: Json): Array<{ url: string; type: string }> {
  const resources: Json[] = root?.resourceType === "Bundle" ? (Array.isArray(root.entry) ? root.entry.map((e: Json) => e?.resource).filter(isObject) : []) : [root];
  const all = [root, ...resources, ...resources.flatMap((r) => (Array.isArray(r.contained) ? r.contained.filter(isObject) : []))];
  const out: Array<{ url: string; type: string }> = [];
  for (const r of all) for (const u of Array.isArray(r?.meta?.profile) ? r.meta.profile : []) if (typeof u === "string") out.push({ url: u, type: String(r.resourceType ?? "") });
  return out;
}

export interface IgValuesOptions {
  packageId: string | null;
  version: string | null;
  /** Profiles the IG's own examples of these resource types declare (entity types only). */
  exampleProfiles?: (types: string[]) => Promise<string[]>;
  /** Cache key of the resolved package (closure). */
  cacheKey?: string;
  maxProfiles?: number;
}

/** IG-defined values for an instance (Bundle or resource). */
export async function igDefinedValues(root: Json, deps: BlueprintDeps, opts: IgValuesOptions): Promise<IgDefinedValues> {
  const decl = declared(root);
  const urls = new Set(decl.map((d) => d.url));
  const resources: Json[] = root?.resourceType === "Bundle" ? (Array.isArray(root.entry) ? root.entry.map((e: Json) => e?.resource).filter(isObject) : []) : [root];
  const entityTypes = [...new Set(resources.map((r) => String(r.resourceType ?? "")).filter((t) => CONSTANT_ENTITY_TYPES.has(t)))];
  if (entityTypes.length && opts.exampleProfiles) {
    try {
      for (const u of await opts.exampleProfiles(entityTypes)) urls.add(u);
    } catch {
      // examples are optional
    }
  }
  const constants = new Set<string>();
  const literals = new Set<string>();
  const seen = new Set<string>();
  for (const url of [...urls].slice(0, opts.maxProfiles ?? 40)) {
    const key = stripVersion(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const v = await memo.get(`${opts.cacheKey ?? `${opts.packageId}#${opts.version}`}|${url}`, () => profileValues(url, opts.packageId, opts.version, deps));
    for (const c of v.constants) constants.add(c);
    for (const l of v.literals) literals.add(l);
  }
  return { constants, literals };
}
