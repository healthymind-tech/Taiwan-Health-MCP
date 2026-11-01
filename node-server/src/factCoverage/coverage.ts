/**
 * fhir_check_fact_coverage (ISSUES_v18 R3 = v20 R4): the fact contract between a model's fact list and its Bundle.
 * Deterministic, no LLM. Per fact {item, attribute, value, quote}:
 *   1. the quote must be in source_text (markers.ts findQuote)                       → quote_not_in_record
 *   2. the clause around it must not negate / mark it old, pending, not applicable,
 *      not established, not done (markers.ts clauseMarkers)                          → not_usable
 *   3. the value must be in a STRUCTURED element of an entry of the resource type the
 *      fact belongs to, under terminology equivalence (match.ts findValue); a number / date only in an element
 *      of the class the attribute names (infer.ts attributeClass, v20.1)          → covered | missing
 *   4. a missing fact gets suggested element paths from the authoring fields of the
 *      entry's profile (authoring/fields.ts via deps.fields), else base element names.
 * Generic for every IG: the equivalences are by FHIR datatype and terminology, the type / element vocabulary is base
 * FHIR (infer.ts). Never logs source_text, quotes or values.
 */
import type { FieldSpec } from "../authoring/types.js";
import type { TerminologyNames } from "../grounding/terminologyNames.js";
import { termKey } from "../grounding/terminologyNames.js";
import { findValue, readValue, structuredNodes, type FoundAt, type Node } from "./match.js";
import { clauseMarkers, findQuote, type Marker } from "./markers.js";
import { attributeClass, impliedTypes, suggestFromBase, suggestFromFields, type ValueShape } from "./infer.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

export const FACT_COVERAGE_VERSION = "1.1.0";

export interface Fact {
  item: string;
  attribute?: string | null;
  value: string | number | boolean;
  quote: string;
  /** Optional: the resource type the fact belongs to (else inferred from item / attribute). */
  resource_type?: string | null;
}

export type FactStatus = "covered" | "missing" | "quote_not_in_record" | "not_usable";

export interface FactResult {
  index: number;
  status: FactStatus;
  /** Machine-readable reason: fact-covered | fact-missing | found-in-other-resource | quote-not-in-record | fact-not-usable. */
  reason_code: string;
  reason: string;
  resource_types: string[];
  found_at?: FoundAt[];
  /** missing: where the value IS, in a resource of another type (v20: 放到別的 resource). */
  found_elsewhere?: FoundAt[];
  suggested_paths?: string[];
  /** not_usable: the markers of the clause around the quote. */
  markers?: Marker[];
  clause?: string;
  quote_match?: "exact" | "normalized";
}

export interface FactCoverageSummary {
  total: number;
  covered: number;
  missing: number;
  quote_not_in_record: number;
  not_usable: number;
  /** covered / (total − not_usable); null when nothing is checkable. */
  coverage: number | null;
  /** No missing fact and no fact without a record basis. */
  complete: boolean;
}

export interface FactCoverageResult {
  facts: FactResult[];
  summary: FactCoverageSummary;
}

export interface FactCoverageDeps {
  /** Terminology names (synonyms / Chinese designations) of the Bundle's codings; absent = Coding.display only. */
  terminology?: TerminologyNames | null;
  /** Authoring fields of a profile (fhir_get_authoring_fields' `fields`); absent / failing = base element names. */
  fields?: (profile: string, packageId: string | null, version: string | null) => Promise<readonly FieldSpec[] | null>;
}

export interface FactCoverageInput {
  bundle: Json;
  source_text: string;
  facts: Fact[];
  package_id?: string | null;
  version?: string | null;
}

function codings(bundle: Json): Array<{ system: unknown; code: unknown }> {
  const out: Array<{ system: unknown; code: unknown }> = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x)) {
      if (typeof x.code === "string" && ("system" in x || "display" in x)) out.push({ system: x.system, code: x.code });
      for (const v of Object.values(x)) if (typeof v === "object") walk(v);
    }
  };
  walk(bundle.entry);
  return out;
}

function shapeOf(value: unknown): ValueShape {
  const r = readValue(value);
  if (r.dates.length) return "date";
  if (r.routes.size) return "route";
  if (r.freq.size) return "frequency";
  if (r.numbers.length) return "number";
  return /^[A-Za-z0-9.\-]{1,12}$/u.test(r.raw) ? "code" : "text";
}

/** Match kinds that are equality of the value itself (kept outside the attribute's element class). */
const EXACT_HOW = new Set(["code", "identifier / value", "equal", "name (family + given)", "administrative gender", "coding display / terminology name", "coded concept text", "telecom (digits)"]);

const profileOf = (res: Json): string | null => {
  const p = isObj(res.meta) && Array.isArray(res.meta.profile) ? res.meta.profile[0] : null;
  return typeof p === "string" && p ? p : null;
};

export async function checkFactCoverage(input: FactCoverageInput, deps: FactCoverageDeps = {}): Promise<FactCoverageResult> {
  const bundle = input.bundle;
  const source = String(input.source_text ?? "");
  const nodes = structuredNodes(bundle);
  const entries: Json[] = (Array.isArray(bundle.entry) ? bundle.entry : []).map((e: unknown) => (isObj(e) && isObj(e.resource) ? e.resource : {}));

  // Terminology names of every coding, one batch (fail-open: display only).
  const codeNames = new Map<string, string[]>();
  if (deps.terminology) {
    try {
      const keys = [...new Set(codings(bundle).map((c) => termKey(c.system, c.code)))];
      const got = keys.length ? await deps.terminology.lookup(keys) : new Map();
      for (const [k, r] of got) if (r?.found && r.names.length) codeNames.set(k, [...r.names]);
    } catch {
      // names unavailable: Coding.display only
    }
  }
  const ctx = { codeNames };
  const fieldsMemo = new Map<string, Promise<readonly FieldSpec[] | null>>();
  const fieldsOf = (profile: string): Promise<readonly FieldSpec[] | null> => {
    if (!deps.fields) return Promise.resolve(null);
    let p = fieldsMemo.get(profile);
    if (!p) {
      p = deps.fields(profile, input.package_id ?? null, input.version ?? null).catch(() => null);
      fieldsMemo.set(profile, p);
    }
    return p;
  };

  const out: FactResult[] = [];
  for (let index = 0; index < input.facts.length; index++) {
    const f = input.facts[index] ?? ({} as Fact);
    const item = String(f.item ?? "");
    const attribute = String(f.attribute ?? "");
    const value = f.value;
    const types = impliedTypes(item, attribute, f.resource_type ?? null);
    const hit = typeof f.quote === "string" ? findQuote(source, f.quote) : null;
    if (!hit) {
      out.push({
        index,
        status: "quote_not_in_record",
        reason_code: "quote-not-in-record",
        reason: "The quote is not in source_text (compared after full-width / whitespace / punctuation normalisation): the fact has no basis in the record — drop it, or quote the record text it comes from.",
        resource_types: types,
      });
      continue;
    }
    const inTypes = (n: Node): boolean => !types.length || types.includes(n.resourceType);
    // v20.1 item 4: a numeric / date value counts only in an element of the attribute's class (a dose never matches
    // Dosage.sequence; a reference range never stands for the value)
    // Other values: an element of the attribute's class when the attribute names one; outside it only an exact
    // equality (code, identifier, equal string) still counts — never a lexicon equivalence (encounter class alias,
    // department, route / timing reading, a phrase containing the value).
    const shape = shapeOf(value);
    const strict = shape === "number" || shape === "date";
    const cls = attributeClass(attribute, item);
    const gate = cls ?? (strict ? (p: string): boolean => !/\.referenceRange(?:\.|$)/u.test(p) : null);
    const anyElement = findValue(nodes.filter(inTypes), value, ctx);
    const keep = (x: FoundAt): boolean => !gate || gate(x.path) || (!strict && EXACT_HOW.has(x.how));
    const found = anyElement.filter(keep);
    const otherElement = anyElement.filter((x) => !keep(x));
    const { markers, clause } = clauseMarkers(source, hit, String(value ?? ""), attribute);
    if (markers.length) {
      const what = [...new Set(markers.map((m) => m.cls))].join(", ");
      out.push({
        index,
        status: "not_usable",
        reason_code: "fact-not-usable",
        reason:
          `The record marks this fact as ${what} (${markers.map((m) => `'${m.cue}'`).join(", ")}): it is not a current, established value. ` +
          (found.length
            ? "It is nevertheless written in the Bundle — remove it, or write it as what the record says (e.g. negated / provisional / old)."
            : "Do not write it as a current value; if the conversion target requires it, the case is insufficient_information."),
        resource_types: types,
        markers,
        clause: clause.length > 120 ? `${clause.slice(0, 117)}...` : clause,
        quote_match: hit.match,
        ...(found.length ? { found_at: found.slice(0, 5) } : {}),
      });
      continue;
    }
    if (found.length) {
      out.push({
        index,
        status: "covered",
        reason_code: "fact-covered",
        reason: `Found in ${found.length} structured element(s) (${[...new Set(found.map((x) => x.how))].join(", ")}).`,
        resource_types: types,
        found_at: found.slice(0, 5),
        quote_match: hit.match,
      });
      continue;
    }
    // v20.2 (evaluator decision): a value present in another VALUE element of the fact's own resource is not a missing
    // fact — counts / sequence numbers / reference ranges never stand for a clinical value (the v20.1 false covered)
    // (an element the attribute itself names — e.g. `Observation.referenceRange.high.value` — is never excluded)
    const named = attribute.replace(/\[\d+\]/gu, "");
    const otherValue = otherElement.filter((x) => {
      const m = /\.(sequence|rank|priority|frequency|frequencyMax|period|periodMax|count|countMax|referenceRange)(?=\.|$)/u.exec(x.path);
      return !m || named.includes(m[1]);
    });
    if (otherValue.length) {
      out.push({
        index,
        status: "covered",
        reason_code: "found-in-other-element",
        reason: `In ${[...new Set(otherValue.map((x) => x.path))].join(", ")} of the fact's resource (not the element the attribute names; counted as covered).`,
        resource_types: types,
        found_at: otherValue.slice(0, 5),
        quote_match: hit.match,
      });
      continue;
    }
    const elsewhere = otherElement.length ? [] : types.length ? findValue(nodes.filter((n) => !inTypes(n)), value, ctx).filter((x) => !/\.referenceRange(?:\.|$)/u.test(x.path)) : [];
    // suggested paths: the profile fields of the entries of the fact's type, else base element names
    const suggestions: string[] = [];
    const targetEntries = entries.filter((r) => typeof r.resourceType === "string" && (!types.length || types.includes(r.resourceType)));
    for (const r of targetEntries) {
      const prof = profileOf(r);
      const fields = prof ? await fieldsOf(prof) : null;
      const s = fields ? suggestFromFields(r.resourceType, fields, attribute, item, shape) : suggestFromBase(r.resourceType, attribute, item);
      for (const p of s) if (!suggestions.includes(p)) suggestions.push(p);
      if (suggestions.length >= 5) break;
    }
    if (!targetEntries.length && types.length) for (const p of suggestFromBase(types[0], attribute, item)) suggestions.push(p);
    const noEntry = types.length && !targetEntries.length ? ` The Bundle has no ${types.join(" / ")} entry.` : "";
    out.push({
      index,
      status: "missing",
      reason_code: otherElement.length ? "found-in-other-element" : elsewhere.length ? "found-in-other-resource" : "fact-missing",
      reason: otherElement.length
        ? `The value is only in ${[...new Set(otherElement.map((x) => x.path))].join(", ")}, not in an element of what the attribute names (a count / sequence / reference range is not the fact's value) — write it in the element the attribute denotes.`
        : elsewhere.length
          ? `Not in a structured element of a ${types.join(" / ")} resource; the value is only in ${[...new Set(elsewhere.map((x) => x.path.split(".")[0]))].join(", ")} — move it to the resource the fact belongs to.`
          : `Not in any structured element${types.length ? ` of a ${types.join(" / ")} resource` : ""} (narrative, notes, Reference.display and the text of an uncoded concept do not count).${noEntry}`,
      resource_types: types,
      ...(otherElement.length ? { found_elsewhere: otherElement.slice(0, 5) } : elsewhere.length ? { found_elsewhere: elsewhere.slice(0, 5) } : {}),
      suggested_paths: suggestions.slice(0, 5),
      quote_match: hit.match,
    });
  }
  const count = (s: FactStatus): number => out.filter((x) => x.status === s).length;
  const total = out.length;
  const covered = count("covered");
  const notUsable = count("not_usable");
  const summary: FactCoverageSummary = {
    total,
    covered,
    missing: count("missing"),
    quote_not_in_record: count("quote_not_in_record"),
    not_usable: notUsable,
    coverage: total - notUsable > 0 ? Math.round((covered / (total - notUsable)) * 1000) / 1000 : null,
    complete: count("missing") === 0 && count("quote_not_in_record") === 0,
  };
  return { facts: out, summary };
}
