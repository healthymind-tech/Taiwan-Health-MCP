/**
 * The errors of ConceptMapValidator (validation/instance/type/ConceptMapValidator.java, 7.0.1, R4 branch) that need no
 * terminology server: scope references that are not value sets (readVSReference), and source / target codes checked
 * against a held, usable CodeSystem and the group's scope value set (validateGroupElement / validateGroupElementTarget,
 * options.withCheckValueSetOnly().withNoServer()).
 * Not reproduced: the server batch for systems not held (addToBatch), the R5 property / attribute checks, the
 * warnings about groups and duplicate mappings, and the publication-only checkShareableConceptMap.
 */
import type { Issue } from "./fhirValidator.js";

type Json = Record<string, any>;

export interface ConceptMapResourceDeps {
  fetchCodeSystem(url: string): Promise<Json | null>;
  fetchValueSet(url: string): Promise<Json | null>;
  /** undefined = the value set cannot be decided here (BLOCKED_BY_OPTIONS in Java: a warning at most). */
  member(valueSet: string, system: string, code: string): Promise<boolean | undefined>;
}

const SERVER_SIDE = new Set(["http://snomed.info/sct", "http://loinc.org"]);

const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === "object") : []);
const has = (v: unknown): v is string => typeof v === "string" && v !== "";
const versioned = (r: Json): string => (has(r.version) ? `${r.url}|${r.version}` : String(r.url));

/** CodeSystemUtilities.getCode: the concept tree, exact code. */
function holdsCode(concepts: unknown, code: string): boolean {
  return asList(concepts).some((c) => c.code === code || holdsCode(c.concept, code));
}

/** readCSReference + isServerSideOnly + isOkCodeSystem: the CodeSystem codes are judged against, or null (validateGroup). */
async function readCodeSystem(url: unknown, version: unknown, vs: Json | null, deps: ConceptMapResourceDeps): Promise<Json | null> {
  if (!has(url)) return null;
  const bar = url.indexOf("|");
  const base = bar >= 0 ? url.slice(0, bar) : url;
  let ver: string | null = has(version) ? version : bar >= 0 ? url.slice(bar + 1) : null;
  if (ver === null && vs) {
    for (const inc of asList(vs.compose?.include)) if (inc.system === base && has(inc.version)) ver = inc.version;
  }
  const cs = await deps.fetchCodeSystem(ver === null ? base : `${base}|${ver}`);
  if (!cs || SERVER_SIDE.has(base)) return null;
  return cs.content === "not-present" || cs.content === "example" || cs.content === "fragment" ? null : cs;
}

export async function validateConceptMapResource(cm: Json, path: string, deps: ConceptMapResourceDeps): Promise<Issue[]> {
  const issues: Issue[] = [];
  const scope = async (name: string, ref: unknown): Promise<Json | null> => {
    if (!has(ref)) return null;
    const vs = await deps.fetchValueSet(ref);
    if (vs) return vs;
    if (await deps.fetchCodeSystem(ref)) {
      issues.push({ severity: "error", path: `${path}.${name}`, code: "invalid", message: "Reference must be to a ValueSet, but found a CodeSystem instead" });
    }
    return null;
  };
  const sourceVs = await scope("source", cm.sourceUri ?? cm.sourceCanonical);
  const targetVs = await scope("target", cm.targetUri ?? cm.targetCanonical);

  const checkCode = async (side: "source" | "target", at: string, code: unknown, cs: Json | null, vs: Json | null): Promise<void> => {
    if (!has(code) || !cs) return;
    const severity = cs.content === "complete" ? "error" : "warning";
    if (!holdsCode(cs.concept, code)) {
      issues.push({ severity, path: at, code: "required", message: `The ${side} code '${code}' is not valid in the code system ${versioned(cs)}` });
      return;
    }
    if (vs && (await deps.member(versioned(vs), String(cs.url), code)) === false) {
      issues.push({ severity, path: at, code: "required", message: `The ${side} code '${code}' is not valid in the value set ${versioned(vs)}` });
    }
  };

  for (const [g, group] of asList(cm.group).entries()) {
    const sourceCs = await readCodeSystem(group.source, group.sourceVersion, sourceVs, deps);
    const targetCs = await readCodeSystem(group.target, group.targetVersion, targetVs, deps);
    for (const [e, element] of asList(group.element).entries()) {
      const ep = `${path}.group[${g}].element[${e}]`;
      await checkCode("source", `${ep}.code`, element.code, sourceCs, sourceVs);
      for (const [t, target] of asList(element.target).entries()) {
        await checkCode("target", `${ep}.target[${t}].code`, target.code, targetCs, targetVs);
      }
    }
  }
  return issues;
}
