/**
 * Suggestions for a document / message Bundle that has no Composition / MessageHeader at all
 * (bdl-11 / bdl-12 and the document-only invariants bdl-9 / bdl-10 that follow from the wrong
 * Bundle.type). The finalizer can only note this; here the model gets the two ways out:
 *   1. `replace_value` Bundle.type → a type the entries' shape supports (collection; transaction /
 *      batch when they carry `request`; searchset …), confidence by that evidence;
 *   2. `add_resource` the missing head resource as the first entry, with what it requires.
 * Nothing is changed automatically; the issues' wording and severity stay as the validator wrote
 * them. A Bundle.type fixed by the resolved profile is never suggested away (only 2 then).
 * Rules come from the FHIR R4 Bundle definition and the core StructureDefinitions — nothing
 * IG-specific.
 */

import { bundleRules, suggestBundleType } from "../fhirBundleFinalize.js";
import type { Suggestion } from "./types.js";

const CORE = "http://hl7.org/fhir/StructureDefinition/";
const RE_DOCUMENT = /^Constraint failed: bdl-(9|10|11):|^The first entry in a document must be a composition/;
const RE_MESSAGE = /^Constraint failed: bdl-12:|^The first entry in a message must be a MessageHeader/;
const RE_HEAD_ONLY = /^Constraint failed: bdl-(11|12):|^The first entry in a (document|message) must be a/;

/** R4 core required direct children, used when the StructureDefinition is not available. */
const REQUIRED_FALLBACK: Record<string, string[]> = {
  Composition: ["status", "type", "date", "author", "title"],
  MessageHeader: ["event[x]", "source"],
};

export interface BundleTypeSuggestionDeps {
  /** StructureDefinition lookup: the Bundle's own meta.profile (a fixed Bundle.type is never suggested away) and the head resource's core definition. */
  fetchStructureDefinition(url: string): Promise<Record<string, any> | null>;
}

function isObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Is this a validator issue about a document / message Bundle lacking its head resource (or the invariants that follow)? */
export function isBundleHeadIssue(issue: Record<string, any>): boolean {
  const m = String(issue?.message || "");
  return RE_DOCUMENT.test(m) || RE_MESSAGE.test(m);
}

/** Bundle.type fixed (fixed / pattern) by the first resolvable Bundle profile in meta.profile, else null. */
async function fixedTypeOf(bundle: Record<string, any>, deps: BundleTypeSuggestionDeps): Promise<string | null> {
  const metas: unknown[] = isObject(bundle.meta) && Array.isArray(bundle.meta.profile) ? bundle.meta.profile : [];
  for (const m of metas.slice(0, 2)) {
    if (typeof m !== "string" || !m) continue;
    try {
      const sd = (await deps.fetchStructureDefinition(m)) ?? (m.includes("|") ? await deps.fetchStructureDefinition(m.split("|")[0]) : null);
      if (isObject(sd) && sd.type === "Bundle") return bundleRules(sd).fixed_type;
    } catch {
      // unresolved profile: not fixed as far as we can tell
    }
  }
  return null;
}

async function requiredChildren(type: string, deps: BundleTypeSuggestionDeps): Promise<string[]> {
  try {
    const sd = await deps.fetchStructureDefinition(CORE + type);
    const els: Array<Record<string, any>> = isObject(sd) && isObject(sd.snapshot) && Array.isArray(sd.snapshot.element) ? sd.snapshot.element : [];
    const re = new RegExp(`^${type}\\.([A-Za-z]+(?:\\[x\\])?)$`);
    const out: string[] = [];
    for (const el of els) {
      const m = re.exec(String(el.id || el.path || ""));
      if (m && typeof el.min === "number" && el.min >= 1 && !out.includes(m[1])) out.push(m[1]);
    }
    if (out.length) return out;
  } catch {
    // fall through to the R4 list
  }
  return REQUIRED_FALLBACK[type] ?? [];
}

/**
 * Attach the suggestions (in place; existing suggestions are kept after ours, duplicates by
 * kind + value dropped). Returns how many issues got one. Does nothing unless Bundle.type is
 * document / message and no entry holds the head resource type at all. Never throws.
 */
export async function attachBundleTypeSuggestions(issues: Array<Record<string, any>>, bundle: Record<string, any>, deps: BundleTypeSuggestionDeps): Promise<number> {
  try {
    return await attach(issues, bundle, deps);
  } catch {
    return 0; // decoration only: a failure here never touches the verdict
  }
}

async function attach(issues: Array<Record<string, any>>, bundle: Record<string, any>, deps: BundleTypeSuggestionDeps): Promise<number> {
  if (!isObject(bundle)) return 0;
  const type = bundle.type;
  if (type !== "document" && type !== "message") return 0;
  const head = type === "document" ? "Composition" : "MessageHeader";
  const rule = type === "document" ? "bdl-11" : "bdl-12";
  const entries: unknown[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  if (entries.some((e) => isObject(e) && isObject(e.resource) && e.resource.resourceType === head)) return 0;
  const re = type === "document" ? RE_DOCUMENT : RE_MESSAGE;
  const targets = issues.filter((i) => isObject(i) && re.test(String(i.message || "")));
  if (!targets.length) return 0;
  const fixedType = await fixedTypeOf(bundle, deps);

  const typeCandidates: Suggestion[] = fixedType
    ? []
    : suggestBundleType(bundle)
        .filter((c) => c.type !== type)
        .map((c) => ({
          value: c.type,
          kind: "replace_value" as const,
          confidence: c.confidence,
          reason: `Bundle.type '${type}' requires a ${head} as the first entry (${rule}) and none is present; ${c.reason}, which fits '${c.type}'`,
          patch: { op: (typeof type === "string" ? "replace" : "add") as "replace" | "add", path: "Bundle.type", value: c.type },
        }));
  const required = await requiredChildren(head, deps);
  const addHead: Suggestion = {
    value: head,
    kind: "add_resource",
    confidence: 0.35,
    reason:
      `a ${type} Bundle's first entry must be a ${head} (${rule})${fixedType ? `, and Bundle.type is fixed to '${type}' by the profile` : ""}; ` +
      `it needs ${required.join(", ")}` +
      (type === "document" ? ", and the other entries must be reachable from it (subject, author, section.entry)" : ", and names the data entries in focus") +
      "; then call fhir_finalize_bundle to mint its fullUrl",
    patch: { op: "add", path: "Bundle.entry[0]", value: { resource: { resourceType: head } } },
  };

  let attached = 0;
  for (const issue of targets) {
    const msg = String(issue.message || "");
    const out: Suggestion[] = RE_HEAD_ONLY.test(msg) ? [...typeCandidates, addHead] : [...typeCandidates];
    if (!out.length) continue;
    const existing: Suggestion[] = Array.isArray(issue.suggestions) ? issue.suggestions : [];
    issue.suggestions = [...out, ...existing.filter((e) => !out.some((o) => o.kind === e.kind && o.value === e.value))];
    attached++;
  }
  return attached;
}
