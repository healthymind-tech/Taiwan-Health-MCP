/**
 * File-backed ValidatorResolver for the parity harnesses: the InstanceValidator's definitions and local terminology
 * come from an in-memory ResourceStore (package dirs + loose files), no DB and no terminology server.
 *
 * Resolution mirrors DbValidatorResolver (src/fhirValidationResolver.ts) where it is DB-independent:
 *  - unversioned canonicals → fhirTerminology.rankHl7Current over the store's candidates (other FHIR majors last,
 *    newest hl7.terminology for THO canonicals, highest major.minor resource version, then load order);
 *  - `url|version` → fhirValidator.pickCanonicalVersion (CanonicalResourceManager.getByPackage);
 *  - loose files (test `supporting` resources) win over package copies of the same canonical (last loaded first),
 *    as the HL7 test runner caches them into the context after the packages.
 * Terminology: CodeSystems held in the store are checked locally (complete → Unknown code error, fragment / example →
 * warning, displays with judgeCodeSystemDisplay); systems the HL7 validator would hand to tx.fhir.org (SNOMED, LOINC,
 * UCUM, THO, urn:…) are not decidable offline and stay silent — every such lookup is counted in `txLookups` so a
 * harness can flag results that depend on the terminology server.
 */
import { indexCodeSystem, valueSetContains, type CodeSystemIndex, type TerminologyDeps } from "../../../src/fhirCodeSystem.js";
import { rankHl7Current } from "../../../src/fhirTerminology.js";
import { judgeHeldCodeSystem, judgeSpecialSystem, serverSideSystem } from "../../../src/fhirValidationResolver.js";
import { SnapshotGenerator } from "../../../src/fhirSnapshotGenerator.js";
import { pickCanonicalVersion, splitCanonicalVersion, type CodeCheck, type ValidatorResolver } from "../../../src/fhirValidator.js";
import { packageResources, type PackageRef, type Res } from "./packages.js";

interface Entry {
  res: Res;
  packageId: string;
  packageVersion: string;
  fhirVersion: string | null;
  /** load order within the store chain (lower = earlier = preferred among packages). */
  ord: number;
  loose: boolean;
  version: string | null;
}

/** Canonical resources by URL; a store can sit on a parent (a shared base layer, e.g. R4 core + THO + extensions). */
export class ResourceStore {
  private byUrl = new Map<string, Entry[]>();
  private seq: number;
  readonly packages: string[] = [];

  constructor(readonly parent: ResourceStore | null = null) {
    this.seq = parent ? parent.seq + 1_000_000 : 0;
  }

  private put(res: Res, pkg: { id: string; version: string; fhirVersion: string | null }, loose: boolean): void {
    if (typeof res.url !== "string" || !res.url) return;
    const url = res.url.split("|")[0];
    const e: Entry = { res, packageId: pkg.id, packageVersion: pkg.version, fhirVersion: pkg.fhirVersion, ord: ++this.seq, loose, version: typeof res.version === "string" ? res.version : null };
    const list = this.byUrl.get(url);
    if (list) list.push(e);
    else this.byUrl.set(url, [e]);
  }

  addPackage(ref: PackageRef): void {
    this.packages.push(`${ref.id}#${ref.version}`);
    const fv = ref.fhirVersions[0] ?? null;
    for (const r of packageResources(ref)) {
      this.put(r, { id: ref.id, version: ref.version, fhirVersion: fv }, false);
      // Bundles of definitions (rare in packages) are unpacked
      if (r.resourceType === "Bundle" && Array.isArray(r.entry)) for (const en of r.entry) if (en?.resource) this.put(en.resource, { id: ref.id, version: ref.version, fhirVersion: fv }, false);
    }
  }

  /** A loose resource (test `supporting` file); a Bundle's entries are added one by one. */
  addResource(res: Res, label = "loose"): void {
    if (res.resourceType === "Bundle" && Array.isArray(res.entry)) {
      for (const en of res.entry) if (en?.resource) this.addResource(en.resource, label);
      return;
    }
    this.put(res, { id: label, version: "0", fhirVersion: null }, true);
  }

  candidates(url: string, resourceType?: string): Entry[] {
    const own = this.byUrl.get(url) ?? [];
    const up = this.parent ? this.parent.candidates(url) : [];
    const all = [...own, ...up];
    return resourceType ? all.filter((e) => e.res.resourceType === resourceType) : all;
  }

  /** Best candidate as DbValidatorResolver picks it (see the module comment). */
  resolve(resourceType: string, canonicalWithVersion: string): Res | null {
    const { url, version } = splitCanonicalVersion(canonicalWithVersion);
    const cands = this.candidates(url, resourceType);
    if (!cands.length) return null;
    const loose = cands.filter((c) => c.loose).sort((a, b) => b.ord - a.ord);
    if (version !== null) {
      const pool = [...loose, ...cands.filter((c) => !c.loose)];
      return pickCanonicalVersion(pool.map((c) => ({ json: c.res, version: c.version })), version)?.json ?? null;
    }
    if (loose.length) return loose[0].res;
    return rankHl7Current(url, cands)[0]?.res ?? null;
  }

  has(url: string, version?: string): boolean {
    const c = this.candidates(url.split("|")[0]);
    return version === undefined ? c.length > 0 : c.some((e) => e.version === version);
  }
}

/** Systems the HL7 validator validates on the terminology server (cf. txKnownSystem in fhirValidationResolver.ts). */
export function txServedSystem(system: string): boolean {
  if (system.startsWith("urn:")) return true;
  if (["http://snomed.info/sct", "http://loinc.org", "http://unitsofmeasure.org", "http://www.nlm.nih.gov/research/umls/rxnorm", "http://hl7.org/fhir/sid/icd-10-cm", "http://hl7.org/fhir/sid/icd-10", "http://hl7.org/fhir/sid/cvx", "http://www.whocc.no/atc", "http://www.ama-assn.org/go/cpt", "http://hl7.org/fhir/sid/ndc"].includes(system)) return true;
  return /^https?:\/\/(terminology\.)?hl7\.org\//.test(system) || system.startsWith("http://snomed.info/") || system.startsWith("http://dicom.nema.org/");
}

export class FileValidatorResolver implements ValidatorResolver {
  /** Lookups an offline run cannot decide the way validator_cli does (it asks tx.fhir.org). */
  txLookups = 0;
  /** StructureDefinitions handed to the validator without a snapshot (generation failed; the HL7 validator generates one). */
  readonly snapshotless = new Set<string>();
  /** Differential-only StructureDefinitions whose snapshot was generated (ContextUtilities.generateSnapshot). */
  readonly snapshotGenerated = new Set<string>();
  /** Snapshot generation (ProfileUtilities port) for differential-only definitions, as the HL7 context does on load. */
  readonly snapshots = new SnapshotGenerator({ fetch: (u) => this.store.resolve("StructureDefinition", u) });
  private generatedFor = new Map<object, Res | null>();
  private csIndex = new Map<string, CodeSystemIndex | null>();

  constructor(readonly store: ResourceStore) {}

  private codeSystem(url: string): CodeSystemIndex | null {
    const key = url;
    if (!this.csIndex.has(key)) {
      const cs = this.store.resolve("CodeSystem", url);
      this.csIndex.set(key, cs ? indexCodeSystem(cs) : null);
    }
    return this.csIndex.get(key)!;
  }

  terminologyDeps(): TerminologyDeps {
    return {
      loadValueSet: async (u) => this.store.resolve("ValueSet", u),
      loadCodeSystem: async (u) => this.codeSystem(u),
      lookupExternal: async () => null,
      externalSystemHeld: async () => false,
    };
  }

  async fetchStructureDefinition(url: string): Promise<Res | null> {
    const sd = this.store.resolve("StructureDefinition", url);
    if (sd && !(sd.snapshot && Array.isArray(sd.snapshot.element) && sd.snapshot.element.length) && !process.env.PARITY_NO_SNAPSHOT_GEN) {
      let gen = this.generatedFor.get(sd);
      if (gen === undefined) {
        gen = this.snapshots.ensure(sd);
        this.generatedFor.set(sd, gen);
      }
      if (gen) {
        this.snapshotGenerated.add(String(sd.url));
        return gen;
      }
      this.snapshotless.add(String(sd.url));
    } else if (sd && !(sd.snapshot && Array.isArray(sd.snapshot.element) && sd.snapshot.element.length)) this.snapshotless.add(String(sd.url));
    return sd;
  }

  async fetchValueSet(url: string): Promise<Res | null> {
    return this.store.resolve("ValueSet", url);
  }

  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    const { url: canonical, version } = splitCanonicalVersion(url);
    const deps = this.terminologyDeps();
    const r =
      version === null
        ? await valueSetContains(canonical, system, code, deps)
        : await (async () => {
            const pinned = this.store.resolve("ValueSet", url);
            if (!pinned) return undefined;
            return valueSetContains(canonical, system, code, { ...deps, loadValueSet: async (u) => (u.split("|")[0] === canonical ? pinned : this.store.resolve("ValueSet", u)) });
          })();
    if (r === undefined) this.txLookups++;
    return r;
  }

  /**
   * The code check DbValidatorResolver.checkCodeUncached makes for a CodeSystem held in the closure:
   * fhirValidationResolver.judgeHeldCodeSystem (unknown code by content, inactive / deprecated concepts,
   * displays by language, supplements as Coding.system, v2-0203 NN<country>). `version` (Coding.version)
   * picks that version of the CodeSystem when the store holds it (else the current one, as the DB resolver).
   */
  async checkCode(system: string, code: string, display: string | null, version?: string | null, langs?: string[]): Promise<CodeCheck> {
    let idx = (version ? this.codeSystem(`${system}|${version}`) : null) ?? this.codeSystem(system);
    if (idx && idx.url && idx.url.split("|")[0] !== system) idx = null;
    if (idx) {
      const r = judgeHeldCodeSystem(idx, system, code, display, langs && langs.length ? langs : undefined);
      if (r) return r;
    }
    const special = judgeSpecialSystem(system, code, display);
    if (special) return special;
    if (txServedSystem(system) || serverSideSystem(system)) {
      this.txLookups++;
      return display === null ? { status: "silent", undecided: true } : { status: "display-unchecked", message: `Display not checked: no local terminology for ${system}`, undecided: true };
    }
    return { status: "unknown-system" };
  }

  async codeSystemExists(url: string): Promise<boolean> {
    return this.store.resolve("CodeSystem", url) !== null;
  }

  async codeSystemResolvable(system: string): Promise<boolean> {
    return txServedSystem(system) || this.store.candidates(system, "CodeSystem").length > 0;
  }

  async codeSystemLocal(system: string): Promise<boolean> {
    if (txServedSystem(system)) return false;
    const cs = this.store.resolve("CodeSystem", system);
    return !!cs && (cs.content === "complete" || cs.content === "fragment");
  }

  async definitionExists(url: string): Promise<boolean> {
    return this.store.has(url.split("|")[0]);
  }

  async definitionVersionExists(url: string, version: string): Promise<boolean> {
    return this.store.has(url, version);
  }
}
