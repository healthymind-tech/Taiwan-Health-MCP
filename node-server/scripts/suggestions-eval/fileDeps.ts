/**
 * File-backed package closure for the suggestion evaluation: FHIR NPM packages from a local
 * package cache (~/.fhir/packages layout), a ValidatorResolver over them (the real
 * InstanceValidator runs on it), and SuggestionDeps with in-memory stand-ins for
 * fhir_normalize_code (lexical) and near codes. External terminologies (LOINC / SNOMED CT /
 * ICD-10-CM) are a tiny synthetic table — no licensed content.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composeContains, expandComposeWith, findConcept, indexCodeSystem, type CodeSystemIndex, type TerminologyDeps } from "../../src/fhirCodeSystem.js";
import { judgeDisplay } from "../../src/fhirValidationResolver.js";
import { InstanceValidator, type CodeCheck, type ValidatorResolver } from "../../src/fhirValidator.js";
import type { NormalizeCandidate, SuggestionDeps } from "../../src/fhirSuggestions/types.js";
import { editSim, textSim } from "../../src/fhirSuggestions/util.js";

export const PACKAGES = ["tw.gov.mohw.twcore#1.0.0", "hl7.fhir.uv.extensions.r4#5.2.0", "hl7.terminology.r4#7.0.0", "hl7.fhir.r4.core#4.0.1"];

/** Synthetic external terminology rows (public, well-known codes; displays as tx.fhir.org lists them). */
export const EXTERNAL: Record<string, Record<string, string[]>> = {
  "http://loinc.org": {
    "8867-4": ["Heart rate"],
    "8310-5": ["Body temperature"],
    "29463-7": ["Body weight"],
    "8302-2": ["Body height"],
    "2339-0": ["Glucose [Mass/volume] in Blood"],
    "4548-4": ["Hemoglobin A1c/Hemoglobin.total in Blood"],
  },
  "http://snomed.info/sct": {
    "44054006": ["Diabetes mellitus type 2", "Type 2 diabetes mellitus"],
    "38341003": ["Hypertensive disorder, systemic arterial", "Hypertension"],
    "195967001": ["Asthma"],
    "386661006": ["Fever"],
  },
  "http://hl7.org/fhir/sid/icd-10-cm": {
    "E11.9": ["Type 2 diabetes mellitus without complications"],
    "I10": ["Essential (primary) hypertension"],
    "J45.909": ["Unspecified asthma, uncomplicated"],
    "R50.9": ["Fever, unspecified"],
  },
};

export class FilePackages {
  readonly byUrl = new Map<string, Record<string, any>>();
  readonly urls: Array<{ url: string; type: string }> = [];
  private csIdx = new Map<string, CodeSystemIndex | null>();

  constructor(cacheDir: string, packages: string[] = PACKAGES) {
    for (const p of packages) {
      const dir = join(cacheDir, p, "package");
      if (!existsSync(dir)) throw new Error(`package not in cache: ${dir}`);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json") || f === "package.json" || f.startsWith(".")) continue;
        if (!/^(StructureDefinition|ValueSet|CodeSystem|NamingSystem)-/.test(f)) continue;
        let j: any;
        try {
          j = JSON.parse(readFileSync(join(dir, f), "utf8"));
        } catch {
          continue;
        }
        if (!j || typeof j.url !== "string" || this.byUrl.has(j.url)) continue;
        this.byUrl.set(j.url, j);
        this.urls.push({ url: j.url, type: j.resourceType });
      }
    }
  }

  get(url: string, type?: string): Record<string, any> | null {
    const r = this.byUrl.get(url.split("|")[0]);
    return r && (!type || r.resourceType === type) ? r : null;
  }

  cs(url: string): CodeSystemIndex | null {
    const u = url.split("|")[0];
    if (!this.csIdx.has(u)) {
      const raw = this.get(u, "CodeSystem");
      this.csIdx.set(u, raw && raw.content !== "not-present" && raw.content !== "supplement" ? indexCodeSystem(raw) : null);
    }
    return this.csIdx.get(u)!;
  }

  termDeps(): TerminologyDeps {
    return {
      loadValueSet: async (url) => this.get(url, "ValueSet"),
      loadCodeSystem: async (url) => this.cs(url),
      lookupExternal: async (system, code) => {
        const row = EXTERNAL[system]?.[code];
        return row ? { display: row[0] } : null;
      },
      externalSystemHeld: async (system) => system in EXTERNAL,
    };
  }

  async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
    const ext = EXTERNAL[system];
    if (ext) {
      const row = ext[code];
      if (!row) return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}'` };
      return (display && judgeDisplay(system, code, display, row, "error")) || { status: "ok" };
    }
    if (system === "http://unitsofmeasure.org") return { status: "silent" };
    const idx = this.cs(system);
    if (!idx) return { status: "unknown-system" };
    const c = findConcept(idx, code);
    if (!c) return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}'${idx.version ? ` version '${idx.version}'` : ""}` };
    if (display) {
      const valid = [c.display, ...c.designations].filter((d): d is string => typeof d === "string");
      const j = judgeDisplay(system, code, display, valid, "error");
      if (j) return j;
    }
    return { status: "ok" };
  }

  resolver(): ValidatorResolver {
    return {
      fetchStructureDefinition: async (url) => this.get(url, "StructureDefinition"),
      fetchValueSet: async (url) => this.get(url, "ValueSet"),
      valueSetContains: async (url, system, code) => {
        const vs = this.get(url, "ValueSet");
        return vs ? composeContains(vs.compose || {}, system, code, this.termDeps()) : undefined;
      },
      checkCode: (s, c, d) => this.checkCode(s, c, d),
      codeSystemResolvable: async (s) => s in EXTERNAL || !!this.get(s, "CodeSystem") || s === "http://unitsofmeasure.org",
      definitionExists: async (url) => this.byUrl.has(url.split("|")[0]),
    };
  }

  /** Codes of a system (file CodeSystem or the synthetic external table). */
  private conceptsOf(system: string): Array<{ code: string; display: string | null; names: string[] }> {
    const ext = EXTERNAL[system];
    if (ext) return Object.entries(ext).map(([code, names]) => ({ code, display: names[0], names }));
    const idx = this.cs(system);
    if (!idx) return [];
    return [...idx.concepts.values()].map((c) => ({ code: c.code, display: c.display, names: [c.display ?? "", ...c.designations].filter((x) => x) }));
  }

  suggestionDeps(): SuggestionDeps {
    const resolver = this.resolver();
    const td = this.termDeps();
    return {
      fetchStructureDefinition: (u) => resolver.fetchStructureDefinition(u),
      checkCode: (s, c, d) => this.checkCode(s, c, d),
      loadValueSet: async (u) => this.get(u, "ValueSet"),
      valueSetContains: (u, s, c) => resolver.valueSetContains(u, s, c),
      expandValueSet: async (u, limit) => {
        const vs = this.get(u, "ValueSet");
        if (!vs) return null;
        const e = await expandComposeWith(vs.compose || {}, td, limit);
        return { codings: e.codings, total: e.total, truncated: e.truncated };
      },
      // Lexical stand-in for fhir_normalize_code (no embeddings): best name similarity.
      normalize: async (text, target, limit) => {
        let pool: Array<{ system: string | null; code: string; display: string | null; names: string[] }> = [];
        if (target.system) pool = this.conceptsOf(target.system).map((c) => ({ ...c, system: target.system! }));
        else if (target.valueSet) {
          const vs = this.get(target.valueSet, "ValueSet");
          if (vs) pool = (await expandComposeWith(vs.compose || {}, td, 2000)).codings.map((c) => ({ ...c, names: [c.display ?? ""] }));
        }
        return pool
          .map((c) => ({ c, s: Math.max(...c.names.map((n) => textSim(text, n)), 0) }))
          .filter((x) => x.s >= 0.5)
          .sort((a, b) => b.s - a.s || (a.c.code < b.c.code ? -1 : 1))
          .slice(0, limit)
          .map((x): NormalizeCandidate => ({ system: x.c.system, code: x.c.code, display: x.c.display, ...(x.s >= 0.999 ? { exact: true } : {}) }));
      },
      nearCodes: async (system, code, limit) =>
        this.conceptsOf(system)
          .map((c) => ({ c, s: editSim(code.toLowerCase(), c.code.toLowerCase()) }))
          .filter((x) => x.s >= 0.5)
          .sort((a, b) => b.s - a.s || (a.c.code < b.c.code ? -1 : 1))
          .slice(0, limit)
          .map((x) => ({ code: x.c.code, display: x.c.display })),
      canonicalsUnder: async (prefix, types) => this.urls.filter((u) => types.includes(u.type) && u.url.startsWith(prefix)).map((u) => u.url).sort(),
      validateAgainst: async (resource, profile) => (await new InstanceValidator(resolver).validate(resource, { profiles: [profile] })) as Array<Record<string, any>>,
      resourceElementPaths: async () => this.resourceElementPaths(),
    };
  }

  private resourceElements: Array<{ type: string; paths: string[] }> | null = null;

  /** Element paths of the base resource StructureDefinitions (the core package), as dbDeps reads them. */
  resourceElementPaths(): Array<{ type: string; paths: string[] }> {
    if (!this.resourceElements) {
      this.resourceElements = [];
      for (const { url, type } of this.urls) {
        if (type !== "StructureDefinition" || !url.startsWith("http://hl7.org/fhir/StructureDefinition/")) continue;
        const j = this.byUrl.get(url)!;
        if (j.kind !== "resource" || j.derivation !== "specialization" || typeof j.type !== "string") continue;
        const paths = (Array.isArray(j.snapshot?.element) ? j.snapshot.element : []).map((e: any) => String(e.path || "")).filter((p: string) => p !== "");
        this.resourceElements.push({ type: j.type, paths });
      }
      this.resourceElements.sort((a, b) => (a.type < b.type ? -1 : 1));
    }
    return this.resourceElements;
  }
}
