/**
 * R4 / R5 — Coding.system that is not a usable code system URL. Moved here from the authoring
 * composer (v1.2 / v1.3 rules, compose.ts `correctSystems`) and extended; used by every tool.
 * Only model codings with a code; only when the answer is unique AND the code exists there.
 *
 *   valueset   (v12) the system is a ValueSet URL (or its /CodeSystem/ ↔ /ValueSet/ twin) → the
 *              CodeSystem the code has in that ValueSet (expansion, else valueSetContains per compose
 *              system, else — membership undecidable — the one compose system holding the code);
 *              several → issue with candidates.
 *   unknown    (v12, R5) a URL that resolves to nothing by the validator's URL rules →
 *              a. its CodeSystem twin when that holds the code;
 *              b. the one CodeSystem of the element's bound ValueSets (slices / additional bindings,
 *                 fhirSuggestions/bindings walker) holding the code — exact, else case-insensitive,
 *                 else an exact display;
 *              c. URL shape: the fragment or last path segment names a known CodeSystem (its name /
 *                 title / id / URL tail / identifier, or an external terminology of the FHIR R4
 *                 list below), or is a THO abstract code (`_ActMedicalServiceCode`) of exactly one
 *                 CodeSystem;
 *              a / b / c must agree; candidates must hold the code.
 *   relative   (R4) not an absolute URI (`ICD-10-CM`, `LOINC`, `SNOMED CT`, `loinc.org`, an OID) →
 *              the CodeSystem whose name / title / id / URL tail / identifier is that name (the
 *              external list included; a host/path without scheme as http(s):// URL), else whose
 *              name tokens contain all of the given tokens — filtered to those holding the code;
 *              exactly one → corrected.
 * Anything else is left as written (the validator reports it, with the suggestion layer's candidates).
 */

import { canonicalName, elementBindings } from "../fhirSuggestions/bindings.js";
import type { SuggestionDeps } from "../fhirSuggestions/types.js";
import { UCUM_SYSTEM } from "../fhirUcum.js";
import type { CodeSystemEntry, ExpandedCoding, RepairChange, RepairIssue } from "./types.js";
import { isObject, type Session, type Site } from "./walk.js";

const EXPANSION_LIMIT = 1000;

/**
 * External code systems of the FHIR R4 specification (terminologies-systems.html: URI, name,
 * common abbreviation, OID). A data table of the specification, not of any IG.
 */
export const EXTERNAL_SYSTEMS: CodeSystemEntry[] = [
  { url: "http://snomed.info/sct", names: ["SNOMED CT", "SNOMED", "SNOMEDCT", "SCT", "SNOMED-CT", "2.16.840.1.113883.6.96"] },
  { url: "http://www.nlm.nih.gov/research/umls/rxnorm", names: ["RxNorm", "RXNORM", "2.16.840.1.113883.6.88"] },
  { url: "http://loinc.org", names: ["LOINC", "Logical Observation Identifiers Names and Codes", "2.16.840.1.113883.6.1"] },
  { url: "http://unitsofmeasure.org", names: ["UCUM", "Unified Code for Units of Measure", "2.16.840.1.113883.6.8"] },
  { url: "http://ncimeta.nci.nih.gov", names: ["NCI Metathesaurus", "NCIm", "2.16.840.1.113883.3.26.1.2"] },
  { url: "http://www.ama-assn.org/go/cpt", names: ["CPT", "AMA CPT", "Current Procedural Terminology", "2.16.840.1.113883.6.12"] },
  { url: "http://hl7.org/fhir/ndfrt", names: ["NDF-RT", "NDFRT", "2.16.840.1.113883.6.209"] },
  { url: "http://fdasis.nlm.nih.gov", names: ["UNII", "2.16.840.1.113883.4.9"] },
  { url: "http://hl7.org/fhir/sid/ndc", names: ["NDC", "National Drug Code", "2.16.840.1.113883.6.69"] },
  { url: "http://hl7.org/fhir/sid/cvx", names: ["CVX", "2.16.840.1.113883.12.292"] },
  { url: "urn:iso:std:iso:3166", names: ["ISO 3166", "ISO3166", "1.0.3166.1.2.2"] },
  { url: "http://dicom.nema.org/resources/ontology/DCM", names: ["DICOM", "DCM", "1.2.840.10008.2.16.4"] },
  { url: "http://hl7.org/fhir/sid/icd-9-cm", names: ["ICD-9-CM", "ICD9CM", "2.16.840.1.113883.6.103"] },
  { url: "http://hl7.org/fhir/sid/icd-10", names: ["ICD-10", "ICD10", "2.16.840.1.113883.6.3"] },
  { url: "http://hl7.org/fhir/sid/icd-10-cm", names: ["ICD-10-CM", "ICD10CM", "2.16.840.1.113883.6.90"] },
  { url: "http://www.cms.gov/Medicare/Coding/ICD10", names: ["ICD-10-PCS", "ICD10PCS", "2.16.840.1.113883.6.4"] },
  { url: "http://www.whocc.no/atc", names: ["ATC", "Anatomical Therapeutic Chemical", "2.16.840.1.113883.6.73"] },
  { url: "http://www.genenames.org", names: ["HGNC", "2.16.840.1.113883.6.281"] },
  { url: "http://varnomen.hgvs.org", names: ["HGVS", "2.16.840.1.113883.6.282"] },
  { url: "http://nucc.org/provider-taxonomy", names: ["NUCC", "2.16.840.1.113883.6.101"] },
  { url: "urn:ietf:bcp:47", names: ["BCP-47", "BCP47"] },
  { url: "urn:ietf:bcp:13", names: ["BCP-13", "BCP13", "MIME"] },
  { url: "urn:iso:std:iso:4217", names: ["ISO 4217", "ISO4217"] },
];

/** Comparable form of a system name: NFKC, lower case, letters / digits / CJK only. */
export function nameKey(s: string): string {
  return String(s || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9㐀-鿿]/g, "");
}

function nameTokens(s: string): string[] {
  return String(s || "")
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9㐀-鿿]+/)
    .filter(Boolean);
}

function lastSegment(url: string): string {
  const u = url.split("|")[0].split("#")[0].replace(/\/+$/, "");
  const i = u.lastIndexOf("/");
  return i >= 0 ? u.slice(i + 1) : u;
}

function stripVersion(u: string): string {
  return String(u).split("|")[0];
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

export interface SystemOutcome {
  system: string;
  code: string;
  reason: string;
}

/** Directory of known CodeSystems: name key → URLs (closure CodeSystems + the external list). */
interface Directory {
  byKey: Map<string, Set<string>>;
  entries: Array<{ url: string; tokens: Set<string> }>;
}

export class SystemRepairer {
  private directoryP: Promise<Directory> | null = null;

  constructor(private readonly session: Session) {}

  private get deps() {
    return this.session.deps;
  }

  private expansion(valueSet: string): Promise<{ codings: ExpandedCoding[]; truncated: boolean } | null> {
    return this.session.memo(
      `sysexp\0${valueSet}`,
      async () => {
        if (!this.deps.expandValueSet) return null;
        const r = await this.deps.expandValueSet(valueSet, EXPANSION_LIMIT);
        // a partial expansion (incomplete) is treated like a cut one: it never proves non-membership
        return r ? { codings: r.codings, truncated: r.truncated || r.incomplete === true } : null;
      },
      null,
    );
  }

  resolve(url: string, code: string) {
    return this.session.memo(`resolve\0${url}\0${code}`, async () => (this.deps.resolveSystem ? this.deps.resolveSystem(url, code) : null), null);
  }

  holds(system: string, code: string): Promise<boolean | undefined> {
    return this.session.memo(`holds\0${system}\0${code}`, async () => (this.deps.codeInSystem ? this.deps.codeInSystem(system, code) : undefined), undefined);
  }

  /** CodeSystems a ValueSet draws from: its expansion's systems plus its compose's include systems. */
  private systemsOfValueSet(valueSet: string): Promise<string[]> {
    return this.session.memo(
      `vssys\0${valueSet}`,
      async () => {
        const out = new Set<string>();
        const exp = await this.expansion(valueSet);
        for (const c of exp?.codings ?? []) if (c.system) out.add(c.system);
        if (this.deps.valueSetSystems) {
          try {
            for (const s of await this.deps.valueSetSystems(valueSet)) if (s) out.add(s);
          } catch {
            // compose unavailable
          }
        }
        return [...out];
      },
      [] as string[],
    );
  }

  /**
   * CodeSystem → the ValueSet's coding with `code` under it: exact codes of the expansion, plus —
   * when the expansion is cut, empty or unavailable (e.g. a LOINC property filter) — membership
   * under each of the ValueSet's systems (valueSetContains), and when membership itself cannot be
   * decided locally, the systems that hold the code (`codeInSystem`), marked `uncertain`. Only
   * when no system is certain are the uncertain ones returned. `caseInsensitive` matches the
   * expansion only (never a membership guess).
   */
  async codesInValueSet(valueSet: string, code: string, caseInsensitive = false): Promise<Map<string, ExpandedCoding & { uncertain?: true }>> {
    const out = new Map<string, ExpandedCoding & { uncertain?: true }>();
    const exp = await this.expansion(valueSet);
    const lower = code.toLowerCase();
    const pairs = new Set<string>();
    for (const c of exp?.codings ?? []) {
      if (!c.system) continue;
      if (caseInsensitive ? c.code.toLowerCase() !== lower : c.code !== code) continue;
      pairs.add(`${c.system}|${c.code}`);
      if (!out.has(c.system)) out.set(c.system, c);
    }
    // two different spellings under one system (case-insensitive) is not a unique match
    if (caseInsensitive) {
      for (const s of [...out.keys()]) if ([...pairs].filter((p) => p.startsWith(`${s}|`)).length > 1) out.set(s, { system: s, code: "", display: null });
      return out;
    }
    if (exp && !exp.truncated && exp.codings.length) return out;
    const uncertain = new Map<string, ExpandedCoding & { uncertain: true }>();
    for (const s of (await this.systemsOfValueSet(valueSet)).slice(0, 8)) {
      if (out.has(s)) continue;
      let member: boolean | undefined;
      try {
        member = this.deps.valueSetContains ? await this.deps.valueSetContains(valueSet, s, code) : undefined;
      } catch {
        member = undefined;
      }
      if (member === true) out.set(s, { system: s, code, display: null });
      else if (member === undefined && (await this.holds(s, code)) === true) uncertain.set(s, { system: s, code, display: null, uncertain: true });
    }
    return out.size ? out : uncertain;
  }

  /** (v12) A ValueSet URL as system → the CodeSystem the code has in it. */
  async fromValueSet(system: string, code: string, valueSet: string): Promise<SystemOutcome | { error: string; candidates: unknown[] } | null> {
    const hits = await this.codesInValueSet(valueSet, code);
    const twin = stripVersion(system) !== stripVersion(valueSet) ? ` (its ValueSet twin ${valueSet})` : "";
    if (hits.size === 1) {
      const [[cs, hit]] = [...hits.entries()];
      const how = hit.uncertain ? `membership unverifiable; the code exists only in ${cs} among the ValueSet's systems` : "membership confirmed";
      return { system: cs, code, reason: `'${system}' is a ValueSet${twin}; code '${code}' belongs to ${cs} (${how})` };
    }
    if (hits.size > 1) {
      return {
        error: `'${system}' is a ValueSet${twin}, not a CodeSystem, and code '${code}' is in it under several CodeSystems (${[...hits.keys()].join(", ")}); give the CodeSystem as system`,
        candidates: [...hits.values()].slice(0, 5).map((c) => ({ system: c.system, code: c.code, ...(c.display ? { display: c.display } : {}) })),
      };
    }
    return null;
  }

  /** (v12) An unknown URL → the twin / the element's bound ValueSets. */
  async fromBindings(root: Record<string, any>, ccPath: string, profiles: string[], coding: Record<string, any>, system: string, code: string, twin: string | null): Promise<SystemOutcome | null> {
    if (twin && (await this.holds(twin, code)) === true) {
      return { system: twin, code, reason: `'${system}' is not a known CodeSystem or ValueSet; code '${code}' belongs to ${twin}, its CodeSystem twin` };
    }
    const shim: SuggestionDeps = {
      fetchStructureDefinition: async (u: string) => {
        try {
          return await this.deps.fetchStructureDefinition(u);
        } catch {
          return null;
        }
      },
      checkCode: async () => ({ status: "unknown-system" }),
    };
    let valueSets: Array<{ valueSet: string }> = [];
    try {
      const ctx = await elementBindings(shim, root, ccPath, { profiles });
      valueSets = ctx ? ctx.bindings.slice(0, 6) : [];
    } catch {
      valueSets = [];
    }
    if (!valueSets.length) return null;
    const own = stripVersion(system);
    for (const b of valueSets) if ((await this.systemsOfValueSet(b.valueSet)).includes(own)) return null; // the binding draws from this very URL
    const collect = async (ci: boolean): Promise<Map<string, { coding: ExpandedCoding; valueSet: string }>> => {
      const certain = new Map<string, { coding: ExpandedCoding; valueSet: string }>();
      const loose = new Map<string, { coding: ExpandedCoding; valueSet: string }>();
      for (const b of valueSets) {
        for (const [s, c] of await this.codesInValueSet(b.valueSet, code, ci)) {
          const m = c.uncertain ? loose : certain;
          if (!m.has(s)) m.set(s, { coding: c, valueSet: b.valueSet });
        }
      }
      return certain.size ? certain : loose;
    };
    const via = (v: string): string => `the element's bound ValueSet ${canonicalName(v)}`;
    const exact = await collect(false);
    if (exact.size === 1) {
      const [[cs, hit]] = [...exact.entries()];
      return { system: cs, code, reason: `'${system}' is not a known CodeSystem or ValueSet; code '${code}' belongs to ${cs} (${via(hit.valueSet)})` };
    }
    if (exact.size > 1) return null;
    const ci = await collect(true);
    if (ci.size === 1) {
      const [[cs, hit]] = [...ci.entries()];
      if (!hit.coding.code) return null;
      return { system: cs, code: hit.coding.code, reason: `'${system}' is not a known CodeSystem or ValueSet; code '${code}' is '${hit.coding.code}' of ${cs} (${via(hit.valueSet)})` };
    }
    if (ci.size > 1) return null;
    const display = typeof coding.display === "string" ? coding.display.trim() : "";
    if (!display) return null;
    const byDisplay = new Map<string, { coding: ExpandedCoding; valueSet: string }>();
    for (const b of valueSets) {
      const exp = await this.expansion(b.valueSet);
      for (const c of exp?.codings ?? []) {
        if (!c.system || (c.display ?? "").trim() !== display) continue;
        const k = `${c.system}|${c.code}`;
        if (!byDisplay.has(k)) byDisplay.set(k, { coding: c, valueSet: b.valueSet });
      }
    }
    if (byDisplay.size !== 1) return null;
    const [{ coding: hit, valueSet }] = [...byDisplay.values()];
    return { system: hit.system!, code: hit.code, reason: `'${system}' is not a known CodeSystem or ValueSet; display '${display}' is ${hit.system}#${hit.code} (${via(valueSet)}), code '${code}' replaced` };
  }

  private directory(): Promise<Directory> {
    if (!this.directoryP) {
      this.directoryP = (async () => {
        const entries: CodeSystemEntry[] = [...EXTERNAL_SYSTEMS];
        if (this.deps.codeSystemDirectory) {
          try {
            entries.push(...(await this.deps.codeSystemDirectory()));
          } catch {
            // closure directory unavailable: the external list only
          }
        }
        const byKey = new Map<string, Set<string>>();
        const list: Directory["entries"] = [];
        const tokenMap = new Map<string, Set<string>>();
        for (const e of entries) {
          const url = stripVersion(e.url);
          if (!url) continue;
          const names = [...e.names, lastSegment(url), url];
          let toks = tokenMap.get(url);
          if (!toks) {
            toks = new Set<string>();
            tokenMap.set(url, toks);
            list.push({ url, tokens: toks });
          }
          for (const n of names) {
            if (typeof n !== "string" || !n.trim()) continue;
            const k = nameKey(n.replace(/^urn:oid:/i, ""));
            if (!k) continue;
            const set = byKey.get(k) || new Set<string>();
            set.add(url);
            byKey.set(k, set);
            if (n !== url) for (const t of nameTokens(n)) toks.add(t);
          }
        }
        return { byKey, entries: list };
      })();
    }
    return this.directoryP;
  }

  /** Known CodeSystems a name denotes: exact name key, else (tokens) every system whose name tokens contain all given tokens. */
  async byName(name: string, allowTokens: boolean): Promise<{ urls: string[]; how: "name" | "tokens" }> {
    const dir = await this.directory();
    const exact = dir.byKey.get(nameKey(name.replace(/^urn:oid:/i, "")));
    if (exact && exact.size) return { urls: [...exact].sort(), how: "name" };
    if (!allowTokens) return { urls: [], how: "name" };
    const toks = nameTokens(name);
    if (!toks.length) return { urls: [], how: "tokens" };
    const urls = dir.entries.filter((e) => toks.every((t) => e.tokens.has(t))).map((e) => e.url);
    return { urls: [...new Set(urls)].sort().slice(0, 40), how: "tokens" };
  }

  /** Of `urls`, the CodeSystems that hold `code` (validator code check). */
  private async holding(urls: string[], code: string): Promise<string[]> {
    const out: string[] = [];
    for (const u of urls.slice(0, 40)) if ((await this.holds(u, code)) === true) out.push(u);
    return out;
  }

  /** (R4) A system that is not an absolute URI. */
  async fromName(system: string, code: string): Promise<SystemOutcome | { error: string; candidates: unknown[] } | null> {
    const s = system.trim();
    const candidates: string[] = [];
    const how: string[] = [];
    // A host/path written without its scheme (loinc.org, snomed.info/sct, hl7.org/fhir/sid/icd-10-cm).
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) {
      for (const scheme of ["http://", "https://"]) {
        const u = scheme + s;
        const r = await this.resolve(u, code);
        if (r && r.kind === "codesystem" && !candidates.includes(u)) {
          candidates.push(u);
          how.push(`'${s}' is the URL ${u} without its scheme`);
        }
      }
    }
    let named = await this.byName(s, false);
    if (!named.urls.length) named = await this.byName(s, true);
    for (const u of named.urls) if (!candidates.includes(u)) candidates.push(u);
    if (!candidates.length) return null;
    const holding = await this.holding(candidates, code);
    if (holding.length === 1) {
      const u = holding[0];
      const why = how.find((h) => h.includes(u)) ?? `'${s}' is the ${named.how === "name" ? "name" : "name (all its words)"} of the CodeSystem ${u}`;
      return { system: u, code, reason: `Coding.system must be an absolute URI; ${why} and code '${code}' exists there` };
    }
    const shown = (holding.length ? holding : candidates).slice(0, 5);
    return {
      error:
        holding.length > 1
          ? `Coding.system '${s}' is not an absolute URI and names several CodeSystems that hold code '${code}' (${shown.join(", ")}); give the CodeSystem URL`
          : `Coding.system '${s}' is not an absolute URI; it names ${shown.join(", ")}, but code '${code}' is not a code there — check the system and the code`,
      candidates: shown.map((u) => ({ system: u })),
    };
  }

  /** (R5 shape) An unknown URL whose fragment / last path segment names a known CodeSystem, or is an abstract THO code. */
  async fromUrlShape(system: string, code: string): Promise<SystemOutcome[] | null> {
    const u = stripVersion(system);
    const segs: string[] = [];
    const hash = u.indexOf("#");
    if (hash >= 0 && hash < u.length - 1) segs.push(u.slice(hash + 1));
    const last = lastSegment(u);
    if (last && !segs.includes(last)) segs.push(last);
    const outs: SystemOutcome[] = [];
    for (const seg of segs) {
      if (!seg || /^(codesystem|valueset|fhir|sid|r4|r5)$/i.test(seg)) continue;
      const named = await this.byName(seg, false);
      for (const cs of await this.holding(named.urls.filter((x) => x !== u), code)) {
        if (!outs.some((o) => o.system === cs)) outs.push({ system: cs, code, reason: `'${system}' is not a known CodeSystem or ValueSet; '${seg}' in it names the CodeSystem ${cs}, which holds code '${code}'` });
      }
      if (seg.startsWith("_") && this.deps.codeSystemsWithCode) {
        let owners: string[] = [];
        try {
          owners = await this.session.memo(`withcode\0${seg}`, () => this.deps.codeSystemsWithCode!(seg), [] as string[]);
        } catch {
          owners = [];
        }
        if (owners.length === 1) {
          for (const cs of await this.holding(owners, code)) {
            if (!outs.some((o) => o.system === cs)) outs.push({ system: cs, code, reason: `'${system}' is not a known CodeSystem or ValueSet; '${seg}' is an abstract code of ${cs} (not a CodeSystem), which holds code '${code}'` });
          }
        }
      }
    }
    return outs.length ? outs : null;
  }
}

export async function repairSystems(
  session: Session,
  sites: Site[],
  rp: (p: string) => string,
  skip: (p: string) => boolean,
  profiles: (site: Site) => string[],
): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  const rep = new SystemRepairer(session);
  let jobs = 0;
  for (const site of sites) {
    if (site.type !== "Coding" || !isObject(site.value)) continue;
    const coding = site.value;
    if (typeof coding.system !== "string" || !coding.system.trim() || typeof coding.code !== "string" || !coding.code) continue;
    if (coding.system === UCUM_SYSTEM || skip(site.path) || skip(`${site.path}.system`)) continue;
    if (++jobs > 30) break;
    const system = coding.system.trim();
    const code = coding.code;
    let outcome: SystemOutcome | null = null;
    let error: { error: string; candidates: unknown[] } | null = null;
    if (!ABSOLUTE.test(system)) {
      const r = await rep.fromName(system, code);
      if (r && "error" in r) error = r;
      else outcome = r;
    } else {
      const res = await rep.resolve(system.split("|")[0], code);
      if (!res) continue;
      if (res.kind === "valueset") {
        const r = await rep.fromValueSet(system, code, res.valueSet);
        if (r && "error" in r) error = r;
        else outcome = r;
      } else if (res.kind === "unknown") {
        const ccPath = /\.coding\[\d+\]$/.test(site.path) ? site.path.replace(/\.coding\[\d+\]$/, "") : site.path;
        const rooted = String(site.resource.resourceType) + ccPath.slice(site.resourcePath.length);
        const viaBinding = await rep.fromBindings(site.resource, rooted, profiles(site), coding, system, code, res.codeSystemTwin ?? null);
        const viaShape = await rep.fromUrlShape(system, code);
        const all = [...(viaBinding ? [viaBinding] : []), ...(viaShape ?? [])];
        const distinct = [...new Set(all.map((o) => `${o.system}|${o.code}`))];
        if (distinct.length === 1) outcome = all[0];
        else if (distinct.length > 1) {
          error = {
            error: `'${system}' is not a known CodeSystem or ValueSet and code '${code}' fits several CodeSystems (${all.map((o) => o.system).join(", ")}); give the CodeSystem URL`,
            candidates: all.map((o) => ({ system: o.system, code: o.code })),
          };
        }
      }
    }
    if (error) {
      issues.push({ path: rp(`${site.path}.system`), rule: "system", severity: "error", message: error.error, candidates: error.candidates });
      continue;
    }
    if (!outcome) continue;
    changes.push({ path: rp(`${site.path}.system`), from: coding.system, to: outcome.system, rule: "system", reason: outcome.reason });
    coding.system = outcome.system;
    if (outcome.code && outcome.code !== coding.code) {
      changes.push({ path: rp(`${site.path}.code`), from: coding.code, to: outcome.code, rule: "system", reason: outcome.reason });
      coding.code = outcome.code;
    }
  }
  return { changes, issues };
}
