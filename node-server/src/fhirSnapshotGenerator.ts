/**
 * StructureDefinition snapshot generation — a port of the HL7 Java core
 * (org.hl7.fhir.r5.conformance.profile.ProfileUtilities.generateSnapshot + ProfilePathProcessor.processPaths,
 * the version shipped with validator_cli 7.x), over plain JSON StructureDefinitions.
 *
 * What is ported (method names refer to the Java source):
 *  - ProfilePathProcessor.processPaths and its cases: processSimplePath (WithEmptyDiffMatches,
 *    WithOneMatchingElementInDifferential, WhereDiffsConstrainTypes, Default) and processPathWithSlicedBase
 *    (AndEmptyDiffMatches, WhereDiffsConstrainTypes, Default) — base walk, diff matching by path, slicing set-up,
 *    new / inherited / re-slices, type slices (implied slices for uncovered types), walking into data types,
 *    content references, slice templates (findSliceTemplate).
 *  - ProfileUtilities.updateFromDefinition (the differential → snapshot merge: short / definition / comment /
 *    label / requirements / alias / min / max / fixed / pattern / example / maxLength / minValue / maxValue /
 *    mustSupport / mustHaveValue / isModifier (extensions) / binding / isSummary / type / constraints (cumulative,
 *    source stamped) / condition), updateFromBase (ElementDefinition.base), updateFromSlicing, fillOutFromBase,
 *    checkExtensionDoco, removeInapplicableTypeConstraints (binding only), getDiffMatches, hasInnerDiffMatches,
 *    diffsConstrainTypes, determineFixedType, findBaseSlices, fixedPathSource / fixedPathDest, generateIds,
 *    checkSliceCardinalitySums (auto-added slicing min), the post-pass removing types of prohibited type slices,
 *    and the relative constraint-source fix-up.
 *  - ContextUtilities.generateSnapshot: base resolved by baseDefinition, generated recursively when it has no
 *    snapshot (derived-from-derived), profiles referenced by types generated on demand.
 *
 * Not ported (no effect on validation verdicts, or newer than what our oracles use): mapping merge, markdown
 * relative-URL processing, extension-source marking, obligation profiles, TypeProfileRootMerger (root constraints of
 * data type profiles), sortDifferential, additional-base pre-processing, the profile-consistency messages that only
 * the IG publisher reports.
 *
 * Pure and synchronous over a `fetch(url)` resolver; `generateSnapshotAsync` wraps it for async resolvers (it reruns
 * the generation after loading whatever definition the previous attempt missed).
 */

type Json = Record<string, any>;
type ED = Json;

export interface SnapshotMessage {
  level: "error" | "warning" | "information";
  path: string;
  message: string;
}

export interface SnapshotGeneratorOptions {
  /** Canonical → StructureDefinition (with or without snapshot); `url|version` allowed. */
  fetch: (url: string) => Json | null;
  /**
   * ProfileUtilities.newSlicingProcessing: false in the validator (ContextUtilities never sets it — the inserted type
   * slicer lists the types of the type slices, so `valueQuantity` restricts value[x]); the IG publisher sets it true.
   */
  newSlicingProcessing?: boolean;
  /** Called with every generated SD (url → SD with snapshot), e.g. to cache it. */
  onGenerated?: (sd: Json) => void;
}

const CORE = "http://hl7.org/fhir/StructureDefinition/";
const EXT_FHIR_TYPE = "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type";
const EXT_IMPLIED_TYPE_SLICE = "http://hl7.org/fhir/tools/StructureDefinition/implied-type-slice";
const PRIMITIVES = ["base64Binary", "boolean", "canonical", "code", "date", "dateTime", "decimal", "id", "instant", "integer", "integer64", "markdown", "oid", "positiveInt", "string", "time", "unsignedInt", "uri", "url", "uuid", "xhtml"];
const DATATYPES = ["Address", "Age", "Annotation", "Attachment", "CodeableConcept", "Coding", "ContactPoint", "Count", "Distance", "Duration", "HumanName", "Identifier", "Money", "Period", "Quantity", "Range", "Ratio", "Reference", "SampledData", "Signature", "Timing", "ContactDetail", "Contributor", "DataRequirement", "Expression", "ParameterDefinition", "RelatedArtifact", "TriggerDefinition", "UsageContext"];
const NON_INHERITED_ED_URLS = [
  "http://hl7.org/fhir/tools/StructureDefinition/binding-definition",
  "http://hl7.org/fhir/tools/StructureDefinition/no-binding",
  "http://hl7.org/fhir/StructureDefinition/elementdefinition-isCommonBinding",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-category",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-fmm",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-implements",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-explicit-type-name",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-security-category",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-wg",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-normative-version",
  "http://hl7.org/fhir/tools/StructureDefinition/obligation-profile",
  "http://hl7.org/fhir/StructureDefinition/obligation-profile",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status-reason",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-summary",
];
const DEFAULT_INHERITED_ED_URLS = [
  "http://hl7.org/fhir/StructureDefinition/questionnaire-optionRestriction",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-referenceProfile",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-referenceResource",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-unitOption",
  "http://hl7.org/fhir/StructureDefinition/mimeType",
];
const NON_OVERRIDING_ED_URLS = [
  "http://hl7.org/fhir/StructureDefinition/elementdefinition-translatable",
  "http://hl7.org/fhir/tools/StructureDefinition/json-name",
  "http://hl7.org/fhir/StructureDefinition/elementdefinition-json-name",
  "http://hl7.org/fhir/tools/StructureDefinition/implied-string-prefix",
  "http://hl7.org/fhir/tools/StructureDefinition/json-empty-behavior",
  "http://hl7.org/fhir/tools/StructureDefinition/json-nullable",
  "http://hl7.org/fhir/tools/StructureDefinition/json-primitive-choice",
  "http://hl7.org/fhir/tools/StructureDefinition/json-property-key",
  "http://hl7.org/fhir/tools/StructureDefinition/type-specifier",
  "http://hl7.org/fhir/tools/StructureDefinition/xml-choice-group",
  "http://hl7.org/fhir/tools/StructureDefinition/xml-namespace",
  "http://hl7.org/fhir/StructureDefinition/elementdefinition-namespace",
  "http://hl7.org/fhir/tools/StructureDefinition/xml-name",
  "http://hl7.org/fhir/StructureDefinition/elementdefinition-xml-name",
  "http://hl7.org/fhir/StructureDefinition/elementdefinition-defaulttype",
];
const OVERRIDING_ED_URLS = [
  "http://hl7.org/fhir/tools/StructureDefinition/elementdefinition-date-format",
  "http://hl7.org/fhir/StructureDefinition/elementdefinition-date-rules",
  "http://hl7.org/fhir/StructureDefinition/designNote",
  "http://hl7.org/fhir/StructureDefinition/elementdefinition-allowedUnits",
  "http://hl7.org/fhir/StructureDefinition/elementdefinition-question",
  "http://hl7.org/fhir/StructureDefinition/entryFormat",
  "http://hl7.org/fhir/StructureDefinition/maxDecimalPlaces",
  "http://hl7.org/fhir/StructureDefinition/maxSize",
  "http://hl7.org/fhir/StructureDefinition/minLength",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-choiceOrientation",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-displayCategory",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-hidden",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-itemControl",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-signatureRequired",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-sliderStepValue",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-supportLink",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-unit",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-unitValueSet",
  "http://hl7.org/fhir/StructureDefinition/questionnaire-usageMode",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-display-hint",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-explicit-type-name",
];

export class SnapshotError extends Error {}

/** Thrown by a fetch callback to ask the async wrapper to load `url` and retry. */
export class NeedDefinition extends Error {
  constructor(readonly url: string) {
    super(`definition needed: ${url}`);
  }
}

// ----------------------------------------------------------------------------------------------- JSON helpers

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

const types = (ed: ED): Json[] => (Array.isArray(ed.type) ? ed.type : []);
const hasType = (ed: ED): boolean => types(ed).length > 0;
const hasSlicing = (ed: ED | null | undefined): boolean => !!ed && !!ed.slicing;
const hasSliceName = (ed: ED | null | undefined): boolean => !!ed && typeof ed.sliceName === "string" && ed.sliceName !== "";
const getMin = (ed: ED): number => (typeof ed.min === "number" ? ed.min : 0);
const hasMin = (ed: ED): boolean => typeof ed.min === "number";
const hasMax = (ed: ED): boolean => typeof ed.max === "string";
const maxAsInt = (ed: ED): number => (ed.max === "*" ? Number.MAX_SAFE_INTEGER : hasMax(ed) ? parseInt(ed.max, 10) : -1);
const hasContentReference = (ed: ED): boolean => typeof ed.contentReference === "string" && ed.contentReference !== "";

export function workingCode(t: Json): string {
  const ext = (t?.extension || []).find((e: Json) => e?.url === EXT_FHIR_TYPE);
  if (ext) return String(ext.valueUrl ?? ext.valueUri ?? ext.valueString ?? t.code);
  return String(t?.code ?? "");
}

function valueKey(ed: ED, prefix: "fixed" | "pattern"): string | null {
  for (const k of Object.keys(ed)) if (k.startsWith(prefix) && k.length > prefix.length && /[A-Z]/.test(k[prefix.length])) return k;
  return null;
}
const hasFixed = (ed: ED): boolean => valueKey(ed, "fixed") !== null;
const hasPattern = (ed: ED): boolean => valueKey(ed, "pattern") !== null;
function getValue(ed: ED, prefix: "fixed" | "pattern" | "minValue" | "maxValue"): { key: string; value: any; ext: any } | null {
  for (const k of Object.keys(ed)) {
    if (k.startsWith(prefix) && k.length > prefix.length && /[A-Z]/.test(k[prefix.length])) return { key: k, value: ed[k], ext: ed["_" + k] };
  }
  for (const k of Object.keys(ed)) {
    if (k.startsWith("_" + prefix) && k.length > prefix.length + 1 && /[A-Z]/.test(k[prefix.length + 1])) return { key: k.slice(1), value: undefined, ext: ed[k] };
  }
  return null;
}
function clearValue(ed: ED, prefix: "fixed" | "pattern" | "minValue" | "maxValue"): void {
  for (const k of Object.keys(ed)) {
    if ((k.startsWith(prefix) || k.startsWith("_" + prefix)) && /[A-Z]/.test(k[(k.startsWith("_") ? 1 : 0) + prefix.length] || "")) delete ed[k];
  }
}
function setValue(ed: ED, prefix: "fixed" | "pattern" | "minValue" | "maxValue", v: { key: string; value: any; ext: any }): void {
  clearValue(ed, prefix);
  if (v.value !== undefined) ed[v.key] = clone(v.value);
  if (v.ext !== undefined) ed["_" + v.key] = clone(v.ext);
}
/** A primitive element with its `_x` sibling (value + extensions), compared as Java's compareDeep would. */
const prim = (ed: ED, k: string): any => (ed[k] === undefined && ed["_" + k] === undefined ? undefined : [ed[k], ed["_" + k]]);
function copyPrim(dst: ED, src: ED, k: string): void {
  if (src[k] !== undefined) dst[k] = clone(src[k]);
  else delete dst[k];
  if (src["_" + k] !== undefined) dst["_" + k] = clone(src["_" + k]);
  else delete dst["_" + k];
}
const hasPrim = (ed: ED, k: string): boolean => ed[k] !== undefined || ed["_" + k] !== undefined;

function tail(path: string | null | undefined): string {
  if (path == null) return "";
  return path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : path;
}
const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const uncapitalize = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);
const charCount = (s: string, c: string): number => s.split(c).length - 1;

// ----------------------------------------------------------------------------------------------- state

interface Redirection {
  element: ED;
  path: string;
}

interface Slicing {
  done: boolean;
  elementDefinition: ED | null;
  path: string | null;
  slices: ED[];
}
const noSlicing = (): Slicing => ({ done: false, elementDefinition: null, path: null, slices: [] });
const slicingP = (done: boolean, ed: ED | null, path: string | null, diffs?: ED[]): Slicing => ({ done, elementDefinition: ed, path, slices: diffs ? diffs.slice(1) : [] });

interface Cursors {
  baseSource: Json;
  base: ED[];
  baseCursor: number;
  diffCursor: number;
  contextName: string | null;
  resultPathBase: string | null;
}

interface PP {
  result: ED[];
  differential: ED[];
  baseLimit: number;
  diffLimit: number;
  url: string;
  profileName: string;
  contextPathSource: string | null;
  contextPathTarget: string | null;
  trimDifferential: boolean;
  redirector: Redirection[];
  sourceSD: Json;
  derived: Json;
  slicing: Slicing;
}

interface BaseTypeSlice {
  defn: ED;
  type: string | null;
  start: number;
  end: number;
  handled: boolean;
}

// ----------------------------------------------------------------------------------------------- generator

export class SnapshotGenerator {
  readonly messages: SnapshotMessage[] = [];
  private readonly generating = new Set<string>();
  private readonly generated = new Map<string, Json>();
  /** diff element → snapshot element it was merged into (UserDataNames.SNAPSHOT_GENERATED_IN_SNAPSHOT). */
  private readonly generatedIn = new WeakMap<ED, ED>();
  /** snapshot elements whose slicing was added implicitly (UserDataNames.SNAPSHOT_auto_added_slicing). */
  private readonly autoAddedSlicing = new WeakSet<ED>();
  /** elements constraining an inherited inline extension slice (SNAPSHOT_INHERITED_INLINE_EXTENSION). */
  private readonly inheritedInlineExtension = new WeakSet<ED>();

  constructor(private readonly opts: SnapshotGeneratorOptions) {}

  private addMessage(level: SnapshotMessage["level"], path: string, message: string): void {
    this.messages.push({ level, path, message });
  }

  // ------------------------------------------------------------------------- context

  private hasSnapshot(sd: Json | null | undefined): boolean {
    return !!sd && Array.isArray(sd.snapshot?.element) && sd.snapshot.element.length > 0;
  }

  /** The SD for `url` with a snapshot (generated when needed); null when it can't be resolved / generated. */
  fetchWithSnapshot(url: string): Json | null {
    const sd = this.opts.fetch(url);
    if (!sd) return null;
    return this.ensure(sd);
  }

  private fetchTypeDefinition(type: string): Json | null {
    if (!type) return null;
    return this.fetchWithSnapshot(type.includes(":") ? type : CORE + type);
  }

  private findProfile(url: string | null | undefined): Json | null {
    if (!url) return null;
    return this.fetchWithSnapshot(url);
  }

  /** `sd` itself when it has a snapshot, else a copy with a generated snapshot (cached); null on failure. */
  ensure(sd: Json): Json | null {
    if (this.hasSnapshot(sd)) return sd;
    const key = String(sd.url ?? "") + "|" + String(sd.version ?? "");
    if (this.generated.has(key)) return this.generated.get(key)!;
    if (this.generating.has(key)) return null;
    try {
      const out = this.generate(sd);
      return out;
    } catch (e) {
      if (e instanceof NeedDefinition) throw e;
      this.addMessage("error", String(sd.url), `Unable to generate snapshot: ${(e as Error).message}`);
      return null;
    }
  }

  private isDataTypeName(value: string): boolean {
    const sd = this.opts.fetch(CORE + value);
    if (!sd) return DATATYPES.includes(value);
    return sd.kind === "complex-type" && sd.derivation === "specialization";
  }

  private isConstrainedDataType(value: string): boolean {
    const sd = this.opts.fetch(CORE + value);
    if (!sd) return ["SimpleQuantity", "MoneyQuantity"].includes(value);
    return sd.kind === "complex-type" && sd.derivation === "constraint";
  }

  private baseType(value: string): string {
    const sd = this.opts.fetch(CORE + value);
    if (sd) return String(sd.type);
    if (["SimpleQuantity", "MoneyQuantity"].includes(value)) return "Quantity";
    throw new SnapshotError(`Internal error - type not known ${value}`);
  }

  private isPrimitive(value: string): boolean {
    const sd = value ? this.opts.fetch(CORE + value) : null;
    if (!sd) return PRIMITIVES.includes(value);
    return sd.kind === "primitive-type";
  }

  private isDataTypeList(ts: Json[]): boolean {
    if (!ts.length) return false;
    for (const t of ts) {
      const c = workingCode(t);
      if (!this.isDataTypeName(c) && !this.isPrimitive(c)) return false;
    }
    return true;
  }

  private isBaseResource(ts: Json[]): boolean {
    if (!ts.length) return false;
    for (const t of ts) if (workingCode(t) === "Resource") return false;
    return true;
  }

  private getProfileForDataType(t: Json): Json | null {
    let sd: Json | null = null;
    const p = Array.isArray(t.profile) && t.profile.length ? t.profile[0] : null;
    if (p) sd = this.findProfile(p);
    if (!sd) sd = this.fetchTypeDefinition(workingCode(t));
    return sd;
  }

  // ------------------------------------------------------------------------- generateSnapshot

  /** ContextUtilities.generateSnapshot + ProfileUtilities.generateSnapshot: a copy of `derived` with a snapshot. */
  generate(derived0: Json): Json {
    const baseUrl = String(derived0.baseDefinition || "");
    if (!baseUrl) throw new SnapshotError(`Profile ${derived0.url} has no base and no snapshot`);
    const base = this.fetchWithSnapshot(baseUrl);
    if (!base) throw new SnapshotError(`Profile ${derived0.url} base ${baseUrl} could not be resolved`);
    if (!derived0.type) throw new SnapshotError(`Derived profile ${derived0.url} has no type`);
    if (!derived0.derivation) throw new SnapshotError(`Derived profile ${derived0.url} has no derivation value and so can't be processed`);
    if (base.type !== derived0.type && derived0.derivation === "constraint") throw new SnapshotError(`Base & Derived profiles have different types (${base.url} = ${base.type} vs ${derived0.url} = ${derived0.type})`);
    const key = String(derived0.url ?? "") + "|" + String(derived0.version ?? "");
    this.generating.add(key);
    try {
      const derived: Json = { ...derived0, snapshot: { element: [] as ED[] } };
      const diffEls: ED[] = clone(derived0.differential?.element || []);
      this.checkDifferential(diffEls, String(derived.type), String(derived.url));
      let baseSnapshot: ED[] = base.snapshot.element;
      if (derived.derivation === "specialization") {
        baseSnapshot = baseSnapshot.map((e: ED) => {
          const t = clone(e);
          t.id = String(t.id).replace(String(base.type), String(derived.type));
          t.path = String(t.path).replace(String(base.type), String(derived.type));
          return t;
        });
      }
      const url = String(derived.url);
      const pp: PP = {
        result: derived.snapshot.element,
        differential: diffEls,
        baseLimit: baseSnapshot.length - 1,
        diffLimit: diffEls.length ? diffEls.length - 1 : -1,
        url,
        profileName: String(derived.name ?? derived.id ?? ""),
        contextPathSource: null,
        contextPathTarget: null,
        trimDifferential: false,
        redirector: [],
        sourceSD: base,
        derived,
        slicing: noSlicing(),
      };
      this.processPaths(pp, { baseSource: base, base: baseSnapshot, baseCursor: 0, diffCursor: 0, contextName: String(base.url), resultPathBase: null }, null);

      const snap: ED[] = derived.snapshot.element;
      if (derived.derivation === "specialization") {
        for (const e of diffEls) {
          if (!this.generatedIn.has(e) && String(e.path).includes(".")) {
            const existing = snap.find((x) => x.path === e.path) ?? null;
            if (existing) this.updateFromDefinition(existing, e, pp.profileName, false, url, base, derived, false);
            else {
              const parent = String(e.path).slice(0, String(e.path).lastIndexOf("."));
              let idx = snap.findIndex((x) => x.path === parent);
              if (idx < 0) throw new SnapshotError(`Unable to find parent path ${parent} for element ${e.path} (internal code error)`);
              while (idx < snap.length && String(snap[idx].path).startsWith(parent)) idx++;
              const outcome = clone(e);
              this.generatedIn.set(e, outcome);
              snap.splice(idx, 0, outcome);
            }
          }
        }
      }
      // types of type slices that are prohibited are removed from the slicer
      for (let i = 0; i < snap.length; i++) {
        const ed = snap[i];
        if (types(ed).length > 1) {
          ed.type = types(ed).filter((tr) => {
            const ts = this.findTypeSlice(snap, i, String(ed.path), workingCode(tr));
            return !(ts && ts.max === "0");
          });
        }
      }
      if (derived.kind !== "logical" && snap.length && hasType(snap[0])) {
        throw new SnapshotError(`type on first snapshot element for ${snap[0].path} in ${derived.url} from ${base.url}`);
      }
      this.generateIds(snap, String(derived.type), derived);
      // fixTypeOfResourceId (R4+ resources): Resource.id is typed System.String with fhir-type 'id'
      if (derived.kind === "resource") {
        for (const ed of snap) {
          if (ed.base?.path !== "Resource.id") continue;
          for (const tr of types(ed)) {
            tr.code = "http://hl7.org/fhirpath/System.String";
            tr.extension = [...(tr.extension || []).filter((x: Json) => x?.url !== EXT_FHIR_TYPE), { url: EXT_FHIR_TYPE, valueUrl: "id" }];
          }
        }
      }

      let unmatched = 0;
      for (const e of diffEls) if (!this.generatedIn.has(e)) unmatched++;
      if (unmatched) {
        this.addMessage("error", url, `The profile ${url} has ${unmatched} element${unmatched === 1 ? "" : "s"} in the differential that don't have a matching element in the snapshot`);
      }
      for (const ed of snap) {
        for (const c of ed.constraint || []) {
          if (typeof c.source === "string" && c.source && !/^[a-z]+:/i.test(c.source)) {
            c.source = c.source.includes(".") ? CORE + c.source.slice(0, c.source.indexOf(".")) + "#" + c.source : CORE + c.source;
          }
        }
      }
      if (derived.derivation === "specialization") {
        for (const ed of snap) if (!ed.base) ed.base = { path: ed.path, min: ed.min, max: ed.max };
      }
      this.checkSliceCardinalitySums(derived);
      this.generated.set(key, derived);
      this.opts.onGenerated?.(derived);
      return derived;
    } finally {
      this.generating.delete(key);
    }
  }

  private findTypeSlice(list: ED[], i: number, path: string, typeCode: string): ED | null {
    for (let j = i + 1; j < list.length; j++) {
      const ed = list[j];
      const p = String(ed.path);
      let pm = path === p;
      if (!pm && path.endsWith("[x]")) {
        const pfx = path.slice(0, -3);
        pm = p.startsWith(pfx) && p.length > pfx.length && !p.slice(pfx.length).includes(".");
      }
      if (pm && types(ed).length === 1 && workingCode(types(ed)[0]) === typeCode) return ed;
    }
    return null;
  }

  private checkDifferential(elements: ED[], type: string, url: string): void {
    const t = type.includes("/") ? type.slice(type.lastIndexOf("/") + 1) : type;
    let first = true;
    for (const ed of elements) {
      const p = ed.path;
      if (typeof p !== "string") throw new SnapshotError(`No path on element in differential in ${url}`);
      if (!((first && t === p) || p.startsWith(t + "."))) throw new SnapshotError(`Illegal path '${p}' in differential in ${url}: must start with ${t}.`);
      first = false;
    }
  }

  private checkSliceCardinalitySums(derived: Json): void {
    interface Counter {
      focus: ED;
      countMin: number;
      countMax: number;
      names: Set<string>;
    }
    const max = (m: string | undefined): number => (m === "*" ? Number.MAX_SAFE_INTEGER : parseInt(String(m ?? "0"), 10));
    const check = (c: Counter): void => {
      const repeats = (c.focus.base?.max ?? c.focus.max) !== "1";
      if (c.countMin > getMin(c.focus) && repeats && this.autoAddedSlicing.has(c.focus)) c.focus.min = c.countMin;
    };
    const slices = new Map<string, Counter>();
    for (const ed of derived.snapshot.element as ED[]) {
      const path = String(ed.path);
      if (hasSlicing(ed)) slices.set(path, { focus: ed, countMin: 0, countMax: 0, names: new Set() });
      else {
        for (const s of [...slices.keys()]) {
          if (charCount(s, ".") >= charCount(path, ".") && s !== path) {
            check(slices.get(s)!);
            slices.delete(s);
          }
        }
      }
      if (hasSliceName(ed) && slices.has(path)) {
        const c = slices.get(path)!;
        c.countMin += getMin(ed);
        if (c.countMax < Number.MAX_SAFE_INTEGER) {
          const m = max(ed.max);
          c.countMax = m === Number.MAX_SAFE_INTEGER ? m : c.countMax + m;
        }
        c.names.add(ed.sliceName);
      }
    }
    for (const c of slices.values()) check(c);
  }

  /** ProfileUtilities.generateIds (path + slice names of the enclosing slices, '_' → '-'). */
  generateIds(list: ED[], _type: string, _sd: Json): void {
    const slices = new Map<string, string>();
    for (const ed of list) {
      const path = String(ed.path);
      for (const k of [...slices.keys()]) if (k.length > path.length || k === path) slices.delete(k);
      if (hasSliceName(ed)) slices.set(path, ed.sliceName);
      const pl = path.split(".");
      let s = pl[0];
      let b = pl[0];
      for (let i = 1; i < pl.length; i++) {
        s = s + "." + pl[i];
        b += "." + pl[i].replace(/_/g, "-");
        const sn = slices.get(s);
        if (sn != null) b += ":" + sn;
      }
      ed.id = b;
    }
  }

  // ------------------------------------------------------------------------- processPaths

  private processPaths(pp: PP, cursors: Cursors, slicerElement: ED | null): ED | null {
    let res: ED | null = null;
    const typeList: Array<{ defn: ED; type: string | null }> = [];
    let first = true;
    let guard = 0;
    while (cursors.baseCursor <= pp.baseLimit && cursors.baseCursor < cursors.base.length) {
      if (++guard > 100000) throw new SnapshotError("snapshot generation did not terminate");
      const currentBase = cursors.base[cursors.baseCursor];
      const currentBasePath = this.fixedPathSource(pp.contextPathSource, String(currentBase.path), pp.redirector);
      const diffMatches = this.getDiffMatches(pp.differential, currentBasePath, cursors.diffCursor, pp.diffLimit);
      const dc = cursors.diffCursor;
      if (!hasSlicing(currentBase) || currentBasePath === pp.slicing.path) {
        const r = this.processSimplePath(pp, currentBase, currentBasePath, diffMatches, typeList, cursors, first ? slicerElement : null, first);
        if (res == null) res = r;
      } else {
        this.processPathWithSlicedBase(pp, currentBase, currentBasePath, diffMatches, typeList, cursors);
      }
      if (diffMatches.length > 0 && dc === cursors.diffCursor) cursors.diffCursor += diffMatches.length;
      first = false;
    }
    return res;
  }

  private processSimplePath(pp: PP, currentBase: ED, currentBasePath: string, diffMatches: ED[], typeList: Array<{ defn: ED; type: string | null }>, cursors: Cursors, slicerElement: ED | null, first: boolean): ED | null {
    if (diffMatches.length === 0) {
      this.processSimplePathWithEmptyDiffMatches(pp, currentBase, currentBasePath, diffMatches, cursors);
      return null;
    }
    if (this.oneMatchingElementInDifferential(pp.slicing.done && first, currentBasePath, diffMatches)) {
      return this.processSimplePathWithOneMatchingElementInDifferential(pp, currentBase, currentBasePath, diffMatches, cursors, slicerElement);
    }
    if (this.diffsConstrainTypes(diffMatches, currentBasePath, typeList)) {
      this.processSimplePathWhereDiffsConstrainTypes(pp, currentBasePath, diffMatches, typeList, cursors);
      return null;
    }
    this.processSimplePathDefault(pp, currentBase, currentBasePath, diffMatches, cursors);
    return null;
  }

  private oneMatchingElementInDifferential(slicingDone: boolean, path: string, diffMatches: ED[]): boolean {
    if (diffMatches.length !== 1) return false;
    if (slicingDone) return true;
    if (this.isImplicitSlicing(diffMatches[0], path)) return false;
    return !(hasSlicing(diffMatches[0]) || (this.isExtension(diffMatches[0]) && hasSliceName(diffMatches[0])));
  }

  private sub(pp: PP, over: Partial<PP>): PP {
    return { ...pp, ...over };
  }

  private processSimplePathDefault(pp: PP, currentBase: ED, currentBasePath: string, diffMatches: ED[], cursors: Cursors): void {
    if (!this.unbounded(currentBase) && !(this.isSlicedToOneOnly(diffMatches[0]) || this.isTypeSlicing(diffMatches[0]))) {
      throw new SnapshotError(`Attempt to a slice an element that does not repeat: ${currentBase.path}/${currentBase.path} from ${cursors.contextName} in ${diffMatches[0].id ?? diffMatches[0].path}`);
    }
    if (!hasSlicing(diffMatches[0]) && !this.isExtension(currentBase)) {
      throw new SnapshotError(`Differential does not have a slice: ${currentBase.path} in profile ${pp.url}`);
    }
    let start = 0;
    const newBaseLimit = this.findEndOfElement(cursors.base, cursors.baseCursor);
    let slicerElement: ED;
    if (
      diffMatches.length > 1 &&
      hasSlicing(diffMatches[0]) &&
      (newBaseLimit > cursors.baseCursor || pp.differential.indexOf(diffMatches[1]) > pp.differential.indexOf(diffMatches[0]) + 1)
    ) {
      const newDiffCursor = pp.differential.indexOf(diffMatches[0]);
      const newDiffLimit = this.findEndOfElement(pp.differential, newDiffCursor);
      const nc: Cursors = { ...cursors, diffCursor: newDiffCursor };
      const e = this.processPaths(this.sub(pp, { baseLimit: newBaseLimit, diffLimit: newDiffLimit, slicing: slicingP(true, null, null) }), nc, null);
      if (e == null) throw new SnapshotError(`Did not find single slice: ${diffMatches[0].path}`);
      e.slicing = clone(diffMatches[0].slicing);
      slicerElement = e;
      start++;
    } else {
      const outcome = clone(currentBase);
      outcome.path = this.fixedPathDest(pp.contextPathTarget, String(outcome.path), pp.redirector, pp.contextPathSource);
      this.updateFromBase(outcome, currentBase);
      if (!hasSlicing(diffMatches[0])) {
        outcome.slicing = this.makeExtensionSlicing();
        this.autoAddedSlicing.add(outcome);
      } else {
        outcome.slicing = clone(diffMatches[0].slicing);
      }
      if (cursors.resultPathBase != null && !String(outcome.path).startsWith(cursors.resultPathBase)) throw new SnapshotError("Adding wrong path");
      pp.result.push(outcome);
      slicerElement = outcome;
      if (!hasSliceName(diffMatches[0])) {
        this.updateFromDefinition(outcome, diffMatches[0], pp.profileName, pp.trimDifferential, pp.url, pp.sourceSD, pp.derived, false);
        if (!hasContentReference(outcome) && !hasType(outcome) && String(outcome.path).includes(".")) throw new SnapshotError("Not done yet");
        if (this.hasInnerDiffMatches(pp.differential, currentBasePath, cursors.diffCursor, pp.diffLimit, false)) {
          if (this.baseHasChildren(cursors.base, currentBase)) {
            if (cursors.diffCursor === 0) throw new SnapshotError(`The profile has slicing at the root ('${currentBase.path}'), which is illegal`);
            throw new SnapshotError(`This situation is not yet handled (constrain slicing to 1..1 and fix base slice for inline structure) @ ${currentBasePath}`);
          }
          const dt = this.getTypeForElement(pp.differential, cursors.diffCursor, diffMatches, outcome);
          cursors.contextName = String(dt.url);
          cursors.diffCursor++;
          start = cursors.diffCursor;
          while (pp.differential.length > cursors.diffCursor && this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), currentBasePath + ".")) cursors.diffCursor++;
          cursors.diffCursor--;
          this.processPaths(
            this.sub(pp, { baseLimit: dt.snapshot.element.length - 1, diffLimit: cursors.diffCursor, contextPathSource: currentBasePath, contextPathTarget: String(outcome.path), slicing: noSlicing() }),
            { baseSource: dt, base: dt.snapshot.element, baseCursor: 1, diffCursor: start, contextName: cursors.contextName, resultPathBase: cursors.resultPathBase },
            slicerElement,
          );
        } else if (hasContentReference(currentBase) && !this.baseHasChildren(cursors.base, currentBase)) {
          const bstart = this.resolveContentReference(cursors.base, currentBase);
          const bend = this.findEndOfElementNoSlices(cursors.base, bstart);
          const redirect = String(currentBase.contentReference).slice(String(currentBase.contentReference).indexOf("#") + 1);
          for (let i = bstart + 1; i <= bend; i++) {
            const src = cursors.base[i];
            const o = clone(src);
            delete o.id;
            const path = String(o.path).replace(redirect, String(currentBase.path));
            o.path = this.fixedPathDest(pp.contextPathTarget, path, pp.redirector, pp.contextPathSource);
            this.updateFromBase(o, src);
            pp.result.push(o);
          }
        }
        start++;
      } else {
        this.checkExtensionDoco(outcome);
      }
    }
    let newDiffCursor = cursors.diffCursor;
    let newDiffLimit = cursors.diffCursor;
    for (let i = start; i < diffMatches.length; i++) {
      newDiffCursor = pp.differential.indexOf(diffMatches[i]);
      newDiffLimit = this.findEndOfElement(pp.differential, newDiffCursor);
      const nc: Cursors = { ...cursors, diffCursor: newDiffCursor };
      this.processPaths(this.sub(pp, { baseLimit: newBaseLimit, diffLimit: newDiffLimit, slicing: slicingP(true, slicerElement, null, diffMatches) }), nc, slicerElement);
    }
    cursors.baseCursor = newBaseLimit + 1;
    cursors.diffCursor = newDiffLimit + 1;
  }

  private resolveContentReference(base: ED[], currentBase: ED): number {
    const path = String(currentBase.contentReference).slice(String(currentBase.contentReference).indexOf("#") + 1);
    let res = base.indexOf(currentBase) - 1;
    while (res >= 0) {
      const ed = base[res];
      if (path === ed.path && !hasSliceName(ed)) return res;
      res--;
    }
    return -1;
  }

  private processSimplePathWhereDiffsConstrainTypes(pp: PP, currentBasePath: string, diffMatches: ED[], typeList: Array<{ defn: ED; type: string | null }>, cursors: Cursors): void {
    const impliedSliceBase = cursors.base[cursors.baseCursor];
    let start = 0;
    const newBaseLimit = this.findEndOfElement(cursors.base, cursors.baseCursor);
    let newDiffCursor = pp.differential.indexOf(diffMatches[0]);
    let elementToRemove: ED | null = null;
    const shortCut = typeList.length > 0 && typeList[0].type != null;
    const path = String(diffMatches[0].path);
    if (shortCut) {
      // ProfileUtilities.newSlicingProcessing is false in the validator's context (ContextUtilities never sets it), so
      // the inserted slicer lists the types of the type slices (the R3 / "unpatched R4" branch)
      const ed: ED = { path: this.determineTypeSlicePath(path, currentBasePath), ...(this.opts.newSlicingProcessing ? {} : { type: typeList.map((ts) => ({ code: ts.type })) }), slicing: { discriminator: [{ type: "type", path: "$this" }], ordered: false, rules: "closed" } };
      diffMatches.unshift(ed);
      pp.differential.splice(newDiffCursor, 0, ed);
      elementToRemove = ed;
    } else {
      const t1 = currentBasePath.slice(currentBasePath.lastIndexOf(".") + 1);
      const t2 = path.slice(path.lastIndexOf(".") + 1);
      if (t1 !== t2) throw new SnapshotError(`Error in path: expected ${path.replace(t2, t1)} but found ${path}`);
    }
    let newDiffLimit = this.findEndOfElement(pp.differential, newDiffCursor);
    this.checkTypeSlicing(diffMatches[0], currentBasePath, pp.url);
    for (const ts of typeList) {
      if (ts.type != null) {
        const tn = this.rootName(currentBasePath) + capitalize(ts.type);
        if (!hasSliceName(ts.defn)) ts.defn.sliceName = tn;
        else if (ts.defn.sliceName !== tn) ts.defn.sliceName = tn; // autoFixSliceNames (ContextUtilities sets it)
        if (!hasType(ts.defn)) ts.defn.type = [{ code: ts.type }];
        else if (types(ts.defn).length > 1) throw new SnapshotError(`Error at path ${currentBasePath}: Slice for type '${tn}' has more than one type`);
        else if (types(ts.defn)[0].code !== ts.type) throw new SnapshotError(`Error at path ${currentBasePath}: Slice for type '${tn}' has wrong type`);
      }
    }
    const nc: Cursors = { ...cursors, diffCursor: newDiffCursor };
    const elementDefinition = this.processPaths(this.sub(pp, { baseLimit: newBaseLimit, diffLimit: newDiffLimit, slicing: slicingP(true, null, null) }), nc, null);
    if (elementDefinition == null) throw new SnapshotError(`Did not find type root: ${path}`);
    elementDefinition.slicing = { discriminator: [{ type: "type", path: "$this" }], ordered: false, rules: "closed" };
    const slicerElement = clone(elementDefinition);
    if (types(elementDefinition).length > 1) slicerElement.min = 0;
    start++;
    let fixedType: string | null = null;
    for (let i = start; i < diffMatches.length; i++) {
      if (getMin(diffMatches[i]) > 0) {
        if (diffMatches.length > i + 1) throw new SnapshotError(`Invalid slicing: there is more than one type slice at ${diffMatches[i].path}, but one of them (${diffMatches[i].sliceName}) has min = 1, so the other slices cannot exist`);
        elementDefinition.min = 1;
        fixedType = this.determineFixedType(diffMatches, fixedType, i);
      }
      newDiffCursor = pp.differential.indexOf(diffMatches[i]);
      newDiffLimit = this.findEndOfElement(pp.differential, newDiffCursor);
      const nc2: Cursors = { ...cursors, diffCursor: newDiffCursor };
      const typeSliceElement = this.processPaths(this.sub(pp, { baseLimit: newBaseLimit, diffLimit: newDiffLimit, slicing: slicingP(true, elementDefinition, null, diffMatches) }), nc2, slicerElement);
      if (typeList.length > start + 1 && typeSliceElement) typeSliceElement.min = 0;
    }
    if (elementToRemove != null) {
      pp.differential.splice(pp.differential.indexOf(elementToRemove), 1);
      newDiffLimit--;
    }
    if (fixedType != null) elementDefinition.type = types(elementDefinition).filter((tr) => tr.code === fixedType);
    if (elementDefinition.max !== "0") {
      const allowedTypes = new Set(types(elementDefinition).map((t) => String(t.code)));
      for (const t of typeList) {
        if (t.type != null) allowedTypes.delete(t.type);
        else if (hasSliceName(t.defn) && types(t.defn).length === 1) allowedTypes.delete(String(types(t.defn)[0].code));
      }
      if (allowedTypes.size) {
        if (currentBasePath.includes("xtension.value") && shortCut) {
          elementDefinition.type = types(elementDefinition).filter((tr) => !allowedTypes.has(String(tr.code)));
        } else {
          this.addImpliedTypeSlices(pp, elementDefinition, impliedSliceBase, currentBasePath, allowedTypes);
        }
      }
    }
    cursors.baseCursor = newBaseLimit + 1;
    cursors.diffCursor = newDiffLimit + 1;
  }

  private checkTypeSlicing(ed: ED, currentBasePath: string, url: string): void {
    const s = ed.slicing || {};
    if (s.ordered === true) throw new SnapshotError(`Error at path ${currentBasePath} in ${url}: Type slicing with slicing.ordered = true`);
    if (Array.isArray(s.discriminator) && s.discriminator.length) {
      if (s.discriminator.length !== 1) throw new SnapshotError(`Error at path ${currentBasePath} in ${url}: Type slicing with slicing.discriminator.count() > 1`);
      if (s.discriminator[0].type !== "type") throw new SnapshotError(`Error at path ${currentBasePath} in ${url}: Type slicing with slicing.discriminator.type != 'type'`);
      if (s.discriminator[0].path !== "$this") throw new SnapshotError(`Error at path ${currentBasePath} in ${url}: Type slicing with slicing.discriminator.path != '$this'`);
    }
  }

  private addImpliedTypeSlices(pp: PP, slicer: ED, base: ED, currentBasePath: string, missingTypes: Set<string>): void {
    for (const tr of types(slicer)) {
      if (!missingTypes.has(String(tr.code))) continue;
      const slice = clone(base);
      this.updateFromBase(slice, base);
      slice.path = slicer.path;
      delete slice.slicing;
      slice.sliceName = this.rootName(currentBasePath) + capitalize(String(tr.code));
      if (slicer.id) slice.id = slicer.id + ":" + slice.sliceName;
      slice.min = 0;
      slice.type = [clone(tr)];
      this.removeInapplicableTypeConstraints(slice);
      slice.extension = [...(slice.extension || []), { url: EXT_IMPLIED_TYPE_SLICE, valueBoolean: true }];
      pp.result.push(slice);
    }
  }

  private processSimplePathWithOneMatchingElementInDifferential(pp: PP, currentBase: ED, currentBasePath: string, diffMatches: ED[], cursors: Cursors, slicerElement: ED | null): ED {
    const fromSlicer = slicerElement != null;
    const d0 = diffMatches[0];
    let template: ED | null = null;
    let templateSD: Json | null = null;
    const id = typeof d0.id === "string" ? d0.id : null;
    const lid = tail(id);
    const d0t = types(d0);
    if (lid.includes("/")) {
      this.generateIds(pp.result, String(pp.sourceSD.type), pp.sourceSD);
      const baseId = id!.slice(0, id!.length - lid.length) + lid.slice(0, lid.indexOf("/"));
      template = pp.result.find((e) => e.id === baseId) ?? null;
      templateSD = pp.sourceSD;
    } else if (
      d0t.length === 1 &&
      Array.isArray(d0t[0].profile) &&
      d0t[0].profile.length &&
      workingCode(d0t[0]) !== "Reference" &&
      !(hasType(currentBase) && Array.isArray(types(currentBase)[0].profile) && types(currentBase)[0].profile.length && types(currentBase)[0].profile[0] === d0t[0].profile[0])
    ) {
      const firstTypeProfile: string = d0t[0].profile[0];
      const firstTypeSD = this.findProfile(firstTypeProfile);
      if (firstTypeSD) {
        let src: ED | null = null;
        const elementExt = (d0t[0]._profile?.[0]?.extension || []).find((x: Json) => x?.url === "http://hl7.org/fhir/StructureDefinition/elementdefinition-profile-element");
        if (elementExt) {
          src = (firstTypeSD.snapshot.element as ED[]).find((t) => t.id === elementExt.valueString) ?? null;
          if (!src && ["Extension", "Resource"].includes(this.typeSummary(currentBase))) throw new SnapshotError(`Unable to find element ${elementExt.valueString} in ${firstTypeProfile}`);
        } else {
          src = clone(firstTypeSD.snapshot.element[0]);
          if (!String(src!.path).includes(".") && firstTypeSD.kind === "resource") src!.constraint = [];
        }
        if (src && ["Extension", "Resource"].includes(this.typeSummary(currentBase))) {
          template = clone(src);
          template.path = currentBase.path;
          templateSD = firstTypeSD;
          delete template.sliceName;
          if (d0t[0].code !== "Extension") {
            if (hasMin(currentBase)) template.min = currentBase.min;
            if (hasMax(currentBase)) template.max = currentBase.max;
          }
        }
      }
    }
    if (template == null) {
      template = clone(currentBase);
      templateSD = cursors.baseSource;
    } else {
      template = this.fillOutFromBase(template, currentBase);
    }
    void templateSD;
    const outcome = template;
    outcome.path = this.fixedPathDest(pp.contextPathTarget, String(outcome.path), pp.redirector, pp.contextPathSource);
    const res = outcome;
    this.updateFromBase(outcome, currentBase);
    if (hasSliceName(d0)) {
      const tmpl = clone(currentBase);
      tmpl.path = this.fixedPathDest(pp.contextPathTarget, String(tmpl.path), pp.redirector, pp.contextPathSource);
      this.checkToSeeIfSlicingExists(pp, d0, tmpl);
      outcome.sliceName = d0.sliceName;
      if (!hasMin(d0)) {
        if ((pp.slicing.elementDefinition == null || pp.slicing.elementDefinition.slicing?.rules !== "closed") && !hasSliceName(currentBase)) {
          if (!currentBasePath.endsWith("xtension.value[x]")) outcome.min = 0;
        } else if (pp.slicing.elementDefinition != null && pp.slicing.elementDefinition.slicing?.rules === "closed" && pp.slicing.slices.length > 1) {
          outcome.min = 0;
        }
      }
    }
    if (hasSliceName(currentBase) && currentBase.sliceName === d0.sliceName) this.inheritedInlineExtension.add(outcome);
    this.updateFromDefinition(outcome, d0, pp.profileName, pp.trimDifferential, pp.url, pp.sourceSD, pp.derived, fromSlicer);
    this.inheritedInlineExtension.delete(outcome);
    if (slicerElement != null && maxAsInt(outcome) > maxAsInt(slicerElement) && hasMax(slicerElement)) outcome.max = slicerElement.max;
    delete outcome.slicing;
    if (cursors.resultPathBase == null) cursors.resultPathBase = String(outcome.path);
    else if (!String(outcome.path).startsWith(cursors.resultPathBase)) throw new SnapshotError("Adding wrong path");
    pp.result.push(outcome);
    cursors.baseCursor++;
    cursors.diffCursor = pp.differential.indexOf(d0) + 1;
    if (
      pp.diffLimit >= cursors.diffCursor &&
      String(outcome.path).includes(".") &&
      (this.isDataTypeList(types(outcome)) || this.isBaseResource(types(outcome)) || hasContentReference(outcome))
    ) {
      if (cursors.diffCursor < pp.differential.length && this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), String(d0.path) + ".") && !this.baseWalksInto(cursors.base, cursors.baseCursor)) {
        if (types(outcome).length > 1) {
          if (String(outcome.path).endsWith("[x]") && !String(d0.path).endsWith("[x]")) {
            const en = tail(String(outcome.path));
            const tn = tail(String(d0.path));
            let t = tn.slice(en.length - 3);
            if (this.isPrimitive(uncapitalize(t))) t = uncapitalize(t);
            let ntr = types(outcome).filter((x) => workingCode(x) === t);
            if (!ntr.length) ntr = [{ code: t }];
            outcome.type = ntr;
          }
          if (types(outcome).length > 1) {
            for (const t of types(outcome)) {
              if (t.code !== "Reference") {
                let nonExtension = false;
                for (const ed of diffMatches) if (ed !== d0 && !String(ed.path).endsWith(".extension")) nonExtension = true;
                if (nonExtension) throw new SnapshotError(`${d0.path} has children (${pp.differential[cursors.diffCursor].path}) and multiple types (${this.typeSummary(outcome)}) in profile ${pp.profileName}`);
              }
            }
          }
        }
        const start = cursors.diffCursor;
        while (cursors.diffCursor <= pp.diffLimit && pp.differential.length > cursors.diffCursor && this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), String(d0.path) + ".")) cursors.diffCursor++;
        if (hasContentReference(outcome)) {
          const target = this.getElementById(pp.sourceSD, cursors.base, String(outcome.contentReference));
          if (target == null) throw new SnapshotError(`Unable to resolve reference to ${outcome.contentReference}`);
          this.replaceFromContentReference(outcome, target.element);
          const base: ED[] = target.source !== pp.sourceSD ? target.source.snapshot.element : cursors.base;
          const newBaseCursor = base.indexOf(target.element) + 1;
          let newBaseLimit = newBaseCursor;
          while (newBaseLimit < base.length && String(base[newBaseLimit].path).startsWith(String(target.element.path) + ".")) newBaseLimit++;
          this.processPaths(
            this.sub(pp, {
              baseLimit: newBaseLimit - 1,
              diffLimit: cursors.diffCursor - 1,
              contextPathSource: String(target.element.path),
              contextPathTarget: String(d0.path),
              redirector: [...pp.redirector, { element: outcome, path: currentBasePath }],
              sourceSD: target.source !== pp.sourceSD ? target.source : pp.sourceSD,
              slicing: noSlicing(),
            }),
            { baseSource: target.source !== pp.sourceSD ? target.source : cursors.baseSource, base, baseCursor: newBaseCursor, diffCursor: start - 1, contextName: cursors.contextName, resultPathBase: cursors.resultPathBase },
            null,
          );
        } else {
          let dt: Json | null = null;
          let tr: Json | null = null;
          if (types(outcome).length > 1) {
            const set = new Set(types(outcome).map((t) => t.code));
            if (set.size === 1) tr = types(outcome)[0];
            else dt = this.fetchTypeDefinition("Element");
          } else tr = types(outcome)[0];
          if (dt == null && tr) dt = Array.isArray(tr.profile) && tr.profile.length > 1 ? this.fetchTypeDefinition(workingCode(tr)) : this.getProfileForDataType(tr);
          if (dt == null) throw new SnapshotError(`${d0.path} has children (${pp.differential[cursors.diffCursor - 1]?.path}) for type ${this.typeSummary(outcome)} in profile ${pp.profileName}, but can't find type`);
          cursors.contextName = String(dt.url);
          this.processPaths(
            this.sub(pp, { baseLimit: dt.snapshot.element.length - 1, diffLimit: cursors.diffCursor - 1, contextPathSource: String(d0.path), contextPathTarget: String(outcome.path), redirector: [], slicing: noSlicing() }),
            { baseSource: dt, base: dt.snapshot.element, baseCursor: 1, diffCursor: start, contextName: cursors.contextName, resultPathBase: cursors.resultPathBase },
            null,
          );
        }
      }
    }
    return res;
  }

  private checkToSeeIfSlicingExists(pp: PP, ed: ED, template: ED): void {
    const ss = pp.result;
    let i = ss.length - 1;
    let m: ED | null = null;
    while (i >= 0) {
      const t = ss[i];
      if (this.pathsMatch(String(t.path), String(ed.path))) {
        if (hasSlicing(t) || hasSliceName(t) || String(t.path).endsWith("[x]")) {
          m = t;
          break;
        }
      }
      if (String(t.path).length < String(ed.path).length) break;
      i--;
    }
    if (m == null) {
      if (String(template.path).endsWith(".extension")) {
        template.slicing = { ...(template.slicing || {}), rules: "open", ordered: false, discriminator: [...(template.slicing?.discriminator || []), { type: "value", path: "url" }] };
        pp.result.push(template);
      } else if (String(template.path).endsWith("[x]") && !hasSliceName(template) && !hasSlicing(template) && hasSliceName(ed) && hasType(ed)) {
        template.slicing = { ...(template.slicing || {}), rules: "closed", ordered: false, discriminator: [...(template.slicing?.discriminator || []), { type: "type", path: "$this" }] };
        pp.result.push(template);
      }
    }
  }

  private pathsMatch(path1: string, path2: string): boolean {
    const p1 = path1.split(".");
    const p2 = path2.split(".");
    if (p1.length !== p2.length) return false;
    for (let i = 0; i < p1.length; i++) {
      const a = p1[i];
      const b = p2[i];
      if (a !== b) {
        if (a.endsWith("[x]")) {
          if (!b.startsWith(a.slice(0, -3))) return false;
        } else if (b.endsWith("[x]")) {
          if (!a.startsWith(b.slice(0, -3))) return false;
        } else return false;
      }
    }
    return true;
  }

  private baseHasChildren(base: ED[], ed: ED): boolean {
    const index = base.indexOf(ed);
    if (index === -1 || index >= base.length - 1) return false;
    const p = String(base[index + 1].path);
    const focus = String(ed.path);
    if (focus.endsWith("[x]")) return p.startsWith(focus.slice(0, -3));
    return p.startsWith(focus + ".");
  }

  private indexOfFirstNonChild(base: ED[], currentBase: ED, baseLimit: number): number {
    let index = base.indexOf(currentBase);
    if (index === -1) return baseLimit + 1;
    if (index === baseLimit - 1) return baseLimit + 1;
    index++;
    while (index < baseLimit && index < base.length) {
      const path = String(base[index].path);
      if (!path.startsWith(String(currentBase.path) + ".")) return index + 1;
      index++;
    }
    return baseLimit + 1;
  }

  private processSimplePathWithEmptyDiffMatches(pp: PP, currentBase: ED, currentBasePath: string, diffMatches: ED[], cursors: Cursors): void {
    const outcome = clone(currentBase);
    outcome.path = this.fixedPathDest(pp.contextPathTarget, String(outcome.path), pp.redirector, pp.contextPathSource);
    this.updateFromBase(outcome, currentBase);
    this.updateConstraintSources(outcome, String(pp.sourceSD.url));
    if (cursors.resultPathBase == null) cursors.resultPathBase = String(outcome.path);
    else if (!String(outcome.path).startsWith(cursors.resultPathBase)) throw new SnapshotError(`Adding wrong path (outcome.getPath() = ${outcome.path}, resultPathBase = ${cursors.resultPathBase})`);
    pp.result.push(outcome);
    if (this.hasInnerDiffMatches(pp.differential, currentBasePath, cursors.diffCursor, pp.diffLimit, true)) {
      if (this.baseHasChildren(cursors.base, currentBase)) {
        let newBaseLimit = cursors.baseCursor + 1;
        while (newBaseLimit < cursors.base.length && String(cursors.base[newBaseLimit].path).startsWith(String(cursors.base[cursors.baseCursor].path) + ".")) newBaseLimit++;
        const nc: Cursors = { ...cursors, baseCursor: cursors.baseCursor + 1 };
        this.processPaths(this.sub(pp, { slicing: noSlicing(), baseLimit: newBaseLimit - 1 }), nc, null);
        cursors.baseCursor = newBaseLimit - 1;
        cursors.diffCursor = nc.diffCursor;
      } else {
        if (types(outcome).length === 0 && !hasContentReference(outcome)) {
          throw new SnapshotError(`${currentBasePath} has no children (${pp.differential[cursors.diffCursor]?.path}) and no types in profile ${pp.profileName}`);
        }
        let nonExtension = false;
        if (types(outcome).length > 1) {
          for (const t of types(outcome)) {
            if (workingCode(t) !== "Reference") for (const ed of diffMatches) if (ed !== diffMatches[0] && !String(ed.path).endsWith(".extension")) nonExtension = true;
          }
        }
        if (!this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), currentBasePath + ".")) cursors.diffCursor++;
        const start = cursors.diffCursor;
        while (pp.differential.length > cursors.diffCursor && this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), currentBasePath + ".")) cursors.diffCursor++;
        if (nonExtension) throw new SnapshotError(`${currentBasePath} has children and multiple types (${this.typeSummary(outcome)}) in profile ${pp.profileName}`);
        if (hasContentReference(outcome)) {
          const tgt = this.getElementById(pp.sourceSD, cursors.base, String(outcome.contentReference));
          if (tgt == null) throw new SnapshotError(`Unable to resolve reference to ${outcome.contentReference}`);
          this.replaceFromContentReference(outcome, tgt.element);
          if (tgt.source !== pp.sourceSD) {
            cursors.base = tgt.source.snapshot.element;
            const newBaseCursor = cursors.base.indexOf(tgt.element) + 1;
            let newBaseLimit = newBaseCursor;
            while (newBaseLimit < cursors.base.length && String(cursors.base[newBaseLimit].path).startsWith(String(tgt.element.path) + ".")) newBaseLimit++;
            this.processPaths(
              this.sub(pp, {
                baseLimit: newBaseLimit - 1,
                diffLimit: cursors.diffCursor - 1,
                contextPathSource: String(tgt.element.path),
                contextPathTarget: String(diffMatches[0]?.path ?? outcome.path),
                redirector: [...pp.redirector, { element: outcome, path: currentBasePath }],
                sourceSD: tgt.source,
                slicing: noSlicing(),
              }),
              { ...cursors, baseCursor: newBaseCursor, diffCursor: start - 1 },
              null,
            );
          } else {
            const newBaseCursor = cursors.base.indexOf(tgt.element) + 1;
            let newBaseLimit = newBaseCursor;
            while (newBaseLimit < cursors.base.length && String(cursors.base[newBaseLimit].path).startsWith(String(tgt.element.path) + ".")) newBaseLimit++;
            this.processPaths(
              this.sub(pp, {
                baseLimit: newBaseLimit - 1,
                diffLimit: cursors.diffCursor - 1,
                contextPathSource: String(tgt.element.path),
                contextPathTarget: String(outcome.path),
                redirector: [...pp.redirector, { element: outcome, path: currentBasePath }],
                slicing: noSlicing(),
              }),
              { ...cursors, baseCursor: newBaseCursor, diffCursor: start },
              null,
            );
          }
        } else {
          const dt = types(outcome).length > 1 ? this.fetchTypeDefinition("Element") : this.getProfileForDataType(types(outcome)[0]);
          if (dt == null) throw new SnapshotError(`Unknown type ${this.typeSummary(outcome)} at ${currentBasePath}`);
          cursors.contextName = String(dt.url);
          const redirector = pp.redirector.length ? [...pp.redirector, { element: currentBase, path: currentBasePath }] : pp.redirector;
          this.processPaths(
            this.sub(pp, { baseLimit: dt.snapshot.element.length - 1, diffLimit: cursors.diffCursor - 1, contextPathSource: currentBasePath, contextPathTarget: String(outcome.path), redirector, slicing: noSlicing() }),
            { baseSource: dt, base: dt.snapshot.element, baseCursor: 1, diffCursor: start, contextName: cursors.contextName, resultPathBase: cursors.resultPathBase },
            null,
          );
        }
      }
    }
    cursors.baseCursor++;
  }

  private processPathWithSlicedBase(pp: PP, currentBase: ED, currentBasePath: string, diffMatches: ED[], typeList: Array<{ defn: ED; type: string | null }>, cursors: Cursors): void {
    const path = String(currentBase.path);
    if (diffMatches.length === 0) this.processPathWithSlicedBaseAndEmptyDiffMatches(pp, currentBase, currentBasePath, diffMatches, cursors, path);
    else if (this.diffsConstrainTypes(diffMatches, currentBasePath, typeList)) this.processPathWithSlicedBaseWhereDiffsConstrainTypes(pp, currentBasePath, diffMatches, typeList, cursors);
    else this.processPathWithSlicedBaseDefault(pp, currentBase, currentBasePath, diffMatches, cursors, path);
  }

  private processPathWithSlicedBaseDefault(pp: PP, currentBase: ED, currentBasePath: string, diffMatches: ED[], cursors: Cursors, path: string): void {
    const closed = currentBase.slicing?.rules === "closed";
    let diffpos = 0;
    const d0 = diffMatches[0];
    if (hasSlicing(d0)) {
      const dS = d0.slicing;
      const bS = currentBase.slicing;
      if (typeof dS.ordered === "boolean" && typeof bS.ordered === "boolean" && dS.ordered !== bS.ordered) throw new SnapshotError(`Slicing rules on differential do not match those on base (order) @ ${path}`);
      if (!this.discriminatorMatches(dS.discriminator || [], bS.discriminator || [])) throw new SnapshotError(`Slicing rules on differential do not match those on base (discriminator) @ ${path}`);
      if (!path.endsWith("[x]") && !this.ruleMatches(dS.rules, bS.rules)) throw new SnapshotError(`Slicing rules on differential do not match those on base (rule) @ ${path}`);
    }
    let outcome = clone(currentBase);
    outcome.path = this.fixedPathDest(pp.contextPathTarget, String(outcome.path), pp.redirector, pp.contextPathSource);
    this.updateFromBase(outcome, currentBase);
    if (hasSlicing(d0) || !hasSliceName(d0)) {
      this.updateFromSlicing(outcome.slicing, d0.slicing);
      this.updateFromDefinition(outcome, d0, pp.profileName, closed, pp.url, pp.sourceSD, pp.derived, false);
    } else {
      this.autoAddedSlicing.add(outcome);
    }
    pp.result.push(outcome);
    if (!hasSliceName(d0)) diffpos++;
    if (this.hasInnerDiffMatches(pp.differential, currentBasePath, cursors.diffCursor, pp.diffLimit, false)) {
      const newBaseLimit = this.findEndOfElement(cursors.base, cursors.baseCursor);
      const ndx = pp.differential.indexOf(d0);
      const newDiffCursor = ndx + (hasSlicing(d0) ? 1 : 0);
      const newDiffLimit = this.findEndOfElement(pp.differential, ndx);
      if (newBaseLimit === cursors.baseCursor) {
        const bt = types(cursors.base[cursors.baseCursor]);
        if (bt.length !== 1) throw new SnapshotError(`Differential walks into '${currentBasePath}' but the base does not, and there is not a single fixed type`);
        const dt = this.getProfileForDataType(bt[0]);
        if (dt == null) throw new SnapshotError(`Unknown type ${workingCode(bt[0])} at ${d0.path}`);
        cursors.contextName = String(dt.url);
        while (pp.differential.length > cursors.diffCursor && this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), currentBasePath + ".")) cursors.diffCursor++;
        this.processPaths(
          this.sub(pp, { baseLimit: dt.snapshot.element.length - 1, diffLimit: newDiffLimit, contextPathSource: currentBasePath, contextPathTarget: String(outcome.path), slicing: noSlicing() }),
          { baseSource: dt, base: dt.snapshot.element, baseCursor: 1, diffCursor: newDiffCursor, contextName: cursors.contextName, resultPathBase: cursors.resultPathBase },
          null,
        );
      } else {
        this.processPaths(this.sub(pp, { baseLimit: newBaseLimit, diffLimit: newDiffLimit, slicing: noSlicing() }), { ...cursors, baseCursor: cursors.baseCursor + 1, diffCursor: newDiffCursor }, null);
      }
    } else if (hasType(currentBase) && types(currentBase)[0].code === "BackboneElement") {
      const newBaseLimit = this.findEndOfElement(cursors.base, cursors.baseCursor);
      for (let i = cursors.baseCursor + 1; i <= newBaseLimit; i++) {
        const o = clone(cursors.base[i]);
        o.path = this.fixedPathDest(pp.contextPathTarget, String(o.path), pp.redirector, pp.contextPathSource);
        pp.result.push(o);
      }
    }

    const baseMatches = this.getSiblings(cursors.base, currentBase);
    for (const baseItem of baseMatches) {
      cursors.baseCursor = cursors.base.indexOf(baseItem);
      outcome = clone(baseItem);
      this.updateFromBase(outcome, currentBase);
      outcome.path = this.fixedPathDest(pp.contextPathTarget, String(outcome.path), pp.redirector, pp.contextPathSource);
      delete outcome.slicing;
      if (cursors.resultPathBase != null && !String(outcome.path).startsWith(cursors.resultPathBase)) throw new SnapshotError("Adding wrong path");
      if (diffpos < diffMatches.length && hasSliceName(diffMatches[diffpos]) && diffMatches[diffpos].sliceName === outcome.sliceName) {
        const newBaseLimit = this.findEndOfElement(cursors.base, cursors.baseCursor);
        const newDiffCursor = pp.differential.indexOf(diffMatches[diffpos]);
        const newDiffLimit = this.findEndOfElement(pp.differential, newDiffCursor);
        this.processPaths(this.sub(pp, { baseLimit: newBaseLimit, diffLimit: newDiffLimit, trimDifferential: closed, slicing: slicingP(true, null, null) }), { ...cursors, diffCursor: newDiffCursor }, null);
        cursors.baseCursor = newBaseLimit;
        cursors.diffCursor = newDiffLimit + 1;
        diffpos++;
      } else {
        pp.result.push(outcome);
        cursors.baseCursor++;
        while (cursors.baseCursor < cursors.base.length && String(cursors.base[cursors.baseCursor].path).startsWith(path) && cursors.base[cursors.baseCursor].path !== path) {
          const o = clone(cursors.base[cursors.baseCursor]);
          o.path = this.fixedPathDest(pp.contextPathTarget, String(o.path), pp.redirector, pp.contextPathSource);
          if (cursors.resultPathBase != null && !String(o.path).startsWith(cursors.resultPathBase)) throw new SnapshotError("Adding wrong path");
          pp.result.push(o);
          cursors.baseCursor++;
        }
        cursors.baseCursor--;
      }
    }
    if (closed && diffpos < diffMatches.length && !String(currentBase.path).endsWith("[x]")) {
      throw new SnapshotError(`The base snapshot marks a slicing as closed, but the differential tries to extend it in ${pp.profileName} at ${path} (${currentBasePath})`);
    }
    while (diffpos < diffMatches.length) {
      const diffItem = diffMatches[diffpos];
      for (const baseItem of baseMatches) if (baseItem.sliceName === diffItem.sliceName) throw new SnapshotError("Named items are out of order in the slice");
      const id = typeof diffItem.id === "string" ? diffItem.id : "";
      const lid = tail(id);
      let template: ED | null = currentBase;
      let sliceTemplate: { sd: Json; ed: ED } | null = null;
      if (lid.includes("/")) {
        this.generateIds(pp.result, String(pp.sourceSD.type), pp.sourceSD);
        const baseId = id.slice(0, id.length - lid.length) + lid.slice(0, lid.indexOf("/"));
        template = pp.result.find((e) => e.id === baseId) ?? null;
        if (!template) throw new SnapshotError(`Unable to find the slice being re-sliced: ${baseId}`);
      } else {
        sliceTemplate = this.findSliceTemplate(cursors.baseSource, cursors.base, currentBase);
        if (sliceTemplate != null) template = sliceTemplate.ed;
      }
      outcome = clone(template);
      if (sliceTemplate != null) {
        outcome.path = currentBase.path;
        outcome.id = currentBase.id;
        delete outcome.sliceName;
      }
      outcome.path = this.fixedPathDest(pp.contextPathTarget, String(outcome.path), pp.redirector, pp.contextPathSource);
      this.updateFromBase(outcome, currentBase);
      delete outcome.slicing;
      outcome.min = 0;
      if (cursors.resultPathBase != null && !String(outcome.path).startsWith(cursors.resultPathBase)) throw new SnapshotError("Adding wrong path");
      pp.result.push(outcome);
      this.updateFromDefinition(outcome, diffItem, pp.profileName, pp.trimDifferential, pp.url, pp.sourceSD, pp.derived, false);
      const profiles: string[] = [];
      for (const tr of types(outcome)) for (const ct of tr.profile || []) profiles.push(ct);
      if (profiles.length === 1) {
        const sdt = this.findProfile(profiles[0]);
        if (sdt && !this.isDataTypeProfile(sdt)) {
          const edt = sdt.snapshot.element[0];
          if (getMin(edt) > 0 && !(getMin(outcome) > 0)) outcome.min = edt.min;
          if (edt.max === "1" && outcome.max !== "1" && outcome.max !== "0") outcome.max = edt.max;
        }
      }
      cursors.diffCursor = pp.differential.indexOf(diffItem) + 1;
      if (hasType(outcome) && pp.differential.length > cursors.diffCursor && String(outcome.path).includes(".")) {
        if (!this.baseWalksInto(cursors.base, cursors.baseCursor)) {
          if (pp.differential.length > cursors.diffCursor && this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), String(d0.path) + ".")) {
            if (types(outcome).length > 1) {
              for (const t of types(outcome)) if (t.code !== "Reference") throw new SnapshotError(`${d0.path} has children and multiple types (${this.typeSummary(outcome)}) in profile ${pp.profileName}`);
            }
            const t = types(outcome)[0];
            if (["Base", "Element", "BackboneElement"].includes(String(t.code))) {
              let childSource: Json = cursors.baseSource;
              let childBase: ED[] = cursors.base;
              let childParent: ED = currentBase;
              let contextPathSource = String(cursors.base[0].path);
              let contextPathTarget = contextPathSource;
              let viaContentReference = false;
              if (sliceTemplate != null && sliceTemplate.ed.path === currentBase.path) {
                const tl: ED[] = sliceTemplate.sd.snapshot.element;
                const ti = tl.indexOf(sliceTemplate.ed);
                const hasChildren = ti + 1 < tl.length && String(tl[ti + 1].path).startsWith(String(sliceTemplate.ed.path) + ".");
                if (!hasChildren && hasContentReference(sliceTemplate.ed)) {
                  const target = this.getElementById(sliceTemplate.sd, tl, String(sliceTemplate.ed.contentReference));
                  if (target != null) {
                    childSource = target.source;
                    childBase = target.source.snapshot.element;
                    childParent = target.element;
                    contextPathSource = String(target.element.path);
                    contextPathTarget = String(currentBase.path);
                    viaContentReference = true;
                  }
                } else {
                  childSource = sliceTemplate.sd;
                  childBase = sliceTemplate.sd.snapshot.element;
                  childParent = sliceTemplate.ed;
                }
              }
              const baseStart = childBase.indexOf(childParent) + 1;
              let baseMax = baseStart + 1;
              while (baseMax < childBase.length && String(childBase[baseMax].path).startsWith(String(childParent.path) + ".")) baseMax++;
              const start = cursors.diffCursor;
              while (pp.differential.length > cursors.diffCursor && this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), String(d0.path) + ".")) cursors.diffCursor++;
              const over: Partial<PP> = { baseLimit: baseMax - 1, diffLimit: cursors.diffCursor - 1, contextPathSource, contextPathTarget, slicing: noSlicing() };
              if (viaContentReference) over.redirector = [...pp.redirector, { element: outcome, path: currentBasePath }];
              if (childSource !== pp.sourceSD) over.sourceSD = childSource;
              this.processPaths(this.sub(pp, over), { baseSource: childSource, base: childBase, baseCursor: baseStart, diffCursor: start - 1, contextName: cursors.contextName, resultPathBase: cursors.resultPathBase }, null);
            } else {
              const dt = this.getProfileForDataType(types(outcome)[0]);
              if (dt == null) throw new SnapshotError(`${d0.path} has children for type ${this.typeSummary(outcome)} in profile ${pp.profileName}, but can't find type`);
              cursors.contextName = String(dt.url);
              const start = cursors.diffCursor;
              while (pp.differential.length > cursors.diffCursor && this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), String(d0.path) + ".")) cursors.diffCursor++;
              this.processPaths(
                this.sub(pp, { baseLimit: dt.snapshot.element.length - 1, diffLimit: cursors.diffCursor - 1, contextPathSource: String(d0.path), contextPathTarget: String(outcome.path), slicing: noSlicing() }),
                { baseSource: dt, base: dt.snapshot.element, baseCursor: 1, diffCursor: start - 1, contextName: cursors.contextName, resultPathBase: cursors.resultPathBase },
                null,
              );
            }
          }
        }
      }
      diffpos++;
    }
    if (hasContentReference(outcome) && hasType(outcome)) outcome.type = [];
    cursors.baseCursor++;
  }

  /** ProfilePathProcessor.findSliceTemplate: what the base's slices were built from (walking back through bases). */
  private findSliceTemplate(sd: Json, baseList: ED[], slicer: ED): { sd: Json; ed: ED } | null {
    if (!sd || !this.hasSnapshot(sd) || sd.snapshot.element !== baseList || !baseList.includes(slicer) || !slicer.id) return null;
    let csd = sd;
    let ced = slicer;
    let depth = 0;
    while (hasSlicing(ced)) {
      if (csd.derivation !== "constraint") return { sd: csd, ed: ced };
      if (!csd.baseDefinition || depth++ > 50) return null;
      const psd = this.findProfile(csd.baseDefinition);
      const st = this.findElementById(psd, String(ced.id), 0);
      if (st == null) return null;
      csd = st.sd;
      ced = st.ed;
    }
    return { sd: csd, ed: ced };
  }

  private findElementById(sd: Json | null, id: string, depth: number): { sd: Json; ed: ED } | null {
    if (!sd || !this.hasSnapshot(sd) || depth > 10) return null;
    const list: ED[] = sd.snapshot.element;
    let ed = list.find((e) => e.id === id);
    if (ed) return { sd, ed };
    const uid = id
      .split(".")
      .map((p) => (p.includes(":") ? p.slice(0, p.indexOf(":")) : p))
      .join(".");
    ed = list.find((e) => e.id === uid);
    if (ed) return { sd, ed };
    const parts = uid.split(".");
    for (let i = parts.length - 1; i > 0; i--) {
      const ped = list.find((e) => e.id === parts.slice(0, i).join("."));
      if (ped) {
        if (types(ped).length !== 1 || (types(ped)[0].profile || []).length > 1 || hasContentReference(ped)) return null;
        const tr = types(ped)[0];
        const tsd = (tr.profile || []).length ? this.findProfile(tr.profile[0]) : this.fetchTypeDefinition(workingCode(tr));
        if (!tsd) return null;
        return this.findElementById(tsd, tsd.type + "." + parts.slice(i).join("."), depth + 1);
      }
    }
    return null;
  }

  private isDataTypeProfile(sd: Json): boolean {
    return (sd.kind === "complex-type" || sd.kind === "primitive-type") && sd.derivation === "constraint" && sd.type !== "Extension";
  }

  private processPathWithSlicedBaseWhereDiffsConstrainTypes(pp: PP, currentBasePath: string, diffMatches: ED[], typeList: Array<{ defn: ED; type: string | null }>, cursors: Cursors): void {
    let impliedSliceBase = cursors.base[cursors.baseCursor];
    const impliedSliceTemplate = this.findSliceTemplate(cursors.baseSource, cursors.base, impliedSliceBase);
    if (impliedSliceTemplate != null) impliedSliceBase = impliedSliceTemplate.ed;
    let start = 0;
    const newBaseLimit = this.findEndOfElement(cursors.base, cursors.baseCursor);
    let newDiffCursor = pp.differential.indexOf(diffMatches[0]);
    let elementToRemove: ED | null = null;
    const shortCut = (typeList.length > 0 && typeList[0].type != null) || (hasSliceName(diffMatches[0]) && !hasSlicing(diffMatches[0]));
    if (shortCut) {
      // newSlicingProcessing = false (see processSimplePathWhereDiffsConstrainTypes)
      const ed: ED = { path: this.determineTypeSlicePath(String(diffMatches[0].path), currentBasePath), ...(this.opts.newSlicingProcessing ? {} : { type: typeList.map((ts) => ({ code: ts.type })) }), slicing: { discriminator: [{ type: "type", path: "$this" }], ordered: false, rules: "closed" } };
      diffMatches.unshift(ed);
      pp.differential.splice(newDiffCursor, 0, ed);
      elementToRemove = ed;
    }
    let newDiffLimit = this.findEndOfElement(pp.differential, newDiffCursor);
    this.checkTypeSlicing(diffMatches[0], currentBasePath, pp.url);
    for (const ts of typeList) {
      if (ts.type != null) {
        const tn = this.rootName(currentBasePath) + capitalize(ts.type);
        if (!hasSliceName(ts.defn)) ts.defn.sliceName = tn;
        else if (ts.defn.sliceName !== tn) throw new SnapshotError(`Error at path ${currentBasePath}: slice name must be '${tn}' but is '${ts.defn.sliceName}'`);
        if (!hasType(ts.defn)) ts.defn.type = [{ code: ts.type }];
        else if (types(ts.defn).length > 1) throw new SnapshotError(`Error at path ${currentBasePath}: Slice for type '${tn}' has more than one type`);
        else if (types(ts.defn)[0].code !== ts.type) throw new SnapshotError(`Error at path ${currentBasePath}: Slice for type '${tn}' has wrong type`);
      }
    }
    const e = this.processPaths(this.sub(pp, { baseLimit: newBaseLimit, diffLimit: newDiffLimit, slicing: slicingP(true, null, currentBasePath) }), { ...cursors, diffCursor: newDiffCursor }, null);
    if (e == null) throw new SnapshotError(`Did not find type root: ${diffMatches[0].path}`);
    e.slicing = { discriminator: [{ type: "type", path: "$this" }], ordered: false, rules: "closed" };
    start++;
    let fixedType: string | null = null;
    const baseSlices = this.findBaseSlices(cursors.base, cursors.baseCursor);
    const realSlices: BaseTypeSlice[] = [];
    const coveredTypes = new Set<string>();
    for (const bs of baseSlices) {
      if (!(bs.defn.extension || []).some((x: Json) => x?.url === EXT_IMPLIED_TYPE_SLICE)) {
        realSlices.push(bs);
        if (bs.type != null) coveredTypes.add(bs.type);
      }
    }
    for (let i = start; i < diffMatches.length; i++) {
      const type = this.determineFixedType(diffMatches, fixedType, i);
      if (getMin(diffMatches[i]) > 0) {
        if (diffMatches.length > i + 1) throw new SnapshotError(`Invalid slicing: there is more than one type slice at ${diffMatches[i].path}, but one of them (${diffMatches[i].sliceName}) has min = 1, so the other slices cannot exist`);
        fixedType = type;
      }
      newDiffCursor = pp.differential.indexOf(diffMatches[i]);
      newDiffLimit = this.findEndOfElement(pp.differential, newDiffCursor);
      let sStart = cursors.baseCursor;
      let sEnd = newBaseLimit;
      if (type != null) coveredTypes.add(type);
      const bs = realSlices.find((b) => type != null && type === b.type) ?? null;
      if (bs != null) {
        sStart = bs.start;
        sEnd = bs.end;
        bs.handled = true;
      }
      let nc2: Cursors = { ...cursors, baseCursor: sStart, diffCursor: newDiffCursor };
      let sliceSource: Json | null = null;
      if (bs == null && impliedSliceTemplate != null && impliedSliceTemplate.ed.path === cursors.base[cursors.baseCursor].path) {
        const tl: ED[] = impliedSliceTemplate.sd.snapshot.element;
        const ti = tl.indexOf(impliedSliceTemplate.ed);
        nc2 = { baseSource: impliedSliceTemplate.sd, base: tl, baseCursor: ti, diffCursor: newDiffCursor, contextName: cursors.contextName, resultPathBase: cursors.resultPathBase };
        sEnd = this.findEndOfElement(tl, ti);
        sliceSource = impliedSliceTemplate.sd;
      }
      const over: Partial<PP> = { baseLimit: sEnd, diffLimit: newDiffLimit, slicing: slicingP(true, e, currentBasePath) };
      if (sliceSource != null && sliceSource !== pp.sourceSD) over.sourceSD = sliceSource;
      this.processPaths(this.sub(pp, over), nc2, null);
    }
    if (elementToRemove != null) {
      pp.differential.splice(pp.differential.indexOf(elementToRemove), 1);
      newDiffLimit--;
    }
    if (fixedType != null) e.type = types(e).filter((tr) => tr.code === fixedType);
    for (const bs of realSlices) {
      if (!bs.handled) {
        const fakeDiff: ED[] = [{ path: bs.defn.path }];
        this.processPaths(this.sub(pp, { differential: fakeDiff, baseLimit: bs.end, diffLimit: 0, slicing: slicingP(true, e, currentBasePath) }), { ...cursors, baseCursor: bs.start, diffCursor: 0 }, null);
      }
    }
    if (e.max !== "0") {
      const missing = new Set(types(e).map((t) => String(t.code)));
      for (const c of coveredTypes) missing.delete(c);
      this.addImpliedTypeSlices(pp, e, impliedSliceBase, currentBasePath, missing);
    }
    cursors.baseCursor = baseSlices.length === 0 ? newBaseLimit + 1 : baseSlices[baseSlices.length - 1].end + 1;
    cursors.diffCursor = newDiffLimit + 1;
  }

  private processPathWithSlicedBaseAndEmptyDiffMatches(pp: PP, currentBase: ED, currentBasePath: string, diffMatches: ED[], cursors: Cursors, path: string): void {
    if (this.hasInnerDiffMatches(pp.differential, path, cursors.diffCursor, pp.diffLimit, true)) {
      const outcome = clone(currentBase);
      outcome.path = this.fixedPathDest(pp.contextPathTarget, String(outcome.path), pp.redirector, pp.contextPathSource);
      this.updateFromBase(outcome, currentBase);
      if (cursors.resultPathBase == null) cursors.resultPathBase = String(outcome.path);
      else if (!String(outcome.path).startsWith(cursors.resultPathBase)) throw new SnapshotError("Adding wrong path");
      pp.result.push(outcome);
      if (this.baseHasChildren(cursors.base, currentBase)) {
        const nc: Cursors = { ...cursors, baseCursor: cursors.baseCursor + 1 };
        this.processPaths(this.sub(pp, { slicing: noSlicing() }), nc, null);
        cursors.baseCursor = this.indexOfFirstNonChild(cursors.base, currentBase, pp.baseLimit);
      } else {
        const dt = this.getTypeForElement(pp.differential, cursors.diffCursor, diffMatches, outcome);
        cursors.contextName = String(dt.url);
        const start = cursors.diffCursor;
        if (pp.differential[cursors.diffCursor].path === currentBasePath) cursors.diffCursor++;
        while (pp.differential.length > cursors.diffCursor && this.pathStartsWith(String(pp.differential[cursors.diffCursor].path), currentBasePath + ".")) cursors.diffCursor++;
        if (cursors.diffCursor > start) {
          this.processPaths(
            this.sub(pp, { baseLimit: dt.snapshot.element.length - 1, diffLimit: cursors.diffCursor - 1, contextPathSource: currentBasePath, contextPathTarget: String(outcome.path), slicing: noSlicing() }),
            { baseSource: dt, base: dt.snapshot.element, baseCursor: 1, diffCursor: start, contextName: cursors.contextName, resultPathBase: cursors.resultPathBase },
            null,
          );
        }
      }
      cursors.baseCursor++;
    } else {
      while (cursors.baseCursor < cursors.base.length && String(cursors.base[cursors.baseCursor].path).startsWith(path)) {
        const outcome = clone(cursors.base[cursors.baseCursor]);
        outcome.path = this.fixedPathDest(pp.contextPathTarget, String(outcome.path), pp.redirector, pp.contextPathSource);
        if (cursors.resultPathBase != null && !String(outcome.path).startsWith(cursors.resultPathBase)) throw new SnapshotError(`Adding wrong path in profile ${pp.profileName}: ${outcome.path} vs ${cursors.resultPathBase}`);
        pp.result.push(outcome);
        cursors.baseCursor++;
      }
    }
  }

  // ------------------------------------------------------------------------- ProfileUtilities helpers

  private getTypeForElement(differential: ED[], diffCursor: number, diffMatches: ED[], outcome: ED): Json {
    if (types(outcome).length === 0) {
      if (hasContentReference(outcome)) throw new SnapshotError(`Unable to resolve content reference ${outcome.contentReference} in this context (${outcome.id ?? outcome.path})`);
      throw new SnapshotError(`${diffMatches[0]?.path ?? outcome.path} has no children (${differential[diffCursor]?.path}) and no types`);
    }
    if (types(outcome).length > 1) {
      for (const t of types(outcome)) if (workingCode(t) !== "Reference") throw new SnapshotError(`${outcome.path} has children (${differential[diffCursor]?.path}) and multiple types (${this.typeSummary(outcome)})`);
    }
    const dt = this.getProfileForDataType(types(outcome)[0]);
    if (dt == null) throw new SnapshotError(`Unknown type ${workingCode(types(outcome)[0])} at ${outcome.path}`);
    return dt;
  }

  private getDiffMatches(context: ED[], path: string, start: number, end: number): ED[] {
    const result: ED[] = [];
    const p = path.split(".");
    for (let i = Math.max(0, start); i <= end && i < context.length; i++) {
      const sp = String(context[i].path).split(".");
      let ok = sp.length === p.length;
      for (let j = 0; ok && j < p.length; j++) ok = sp.length > j && (p[j] === sp[j] || this.isSameBase(p[j], sp[j]));
      if (ok) result.push(context[i]);
    }
    return result;
  }

  private isSameBase(p: string, sp: string): boolean {
    return (p.endsWith("[x]") && sp.startsWith(p.slice(0, -3))) || (sp.endsWith("[x]") && p.startsWith(sp.slice(0, -3)));
  }

  private hasInnerDiffMatches(context: ED[], path: string, start: number, end: number, allowSlices: boolean): boolean {
    end = Math.min(context.length, end);
    start = Math.max(0, start);
    for (let i = start; i <= end && i < context.length; i++) {
      const ed = context[i];
      const statedPath = String(ed.path);
      if (!allowSlices && statedPath === path && hasSliceName(ed)) return false;
      else if (statedPath.startsWith(path + ".")) return true;
      else if (path.endsWith("[x]") && statedPath.startsWith(path.slice(0, -3))) return true;
      else if (i !== start && !allowSlices && !statedPath.startsWith(path + ".")) return false;
      else if (i !== start && allowSlices && !statedPath.startsWith(path)) return false;
    }
    return false;
  }

  private findEndOfElement(context: ED[], cursor: number): number {
    let result = cursor;
    if (cursor >= context.length) return result;
    const path = String(context[cursor].path) + ".";
    while (result < context.length - 1 && String(context[result + 1].path).startsWith(path)) result++;
    return result;
  }

  private findEndOfElementNoSlices(context: ED[], cursor: number): number {
    let result = cursor;
    const path = String(context[cursor].path) + ".";
    while (result < context.length - 1 && String(context[result + 1].path).startsWith(path) && !hasSliceName(context[result + 1])) result++;
    return result;
  }

  private getSiblings(list: ED[], current: ED): ED[] {
    const result: ED[] = [];
    const path = String(current.path);
    let cursor = list.indexOf(current) + 1;
    while (cursor < list.length && String(list[cursor].path).length >= path.length) {
      const p1 = String(list[cursor].path);
      if (p1 === path || (path.endsWith("[x]") && p1.startsWith(path.slice(0, -3)) && !p1.slice(path.length - 3).includes("."))) result.push(list[cursor]);
      cursor++;
    }
    return result;
  }

  private findBaseSlices(list: ED[], start: number): BaseTypeSlice[] {
    const res: BaseTypeSlice[] = [];
    const base = list[start];
    const bp = String(base.path);
    let i = start + 1;
    while (i < list.length && String(list[i].path).startsWith(bp + ".")) i++;
    while (i < list.length && list[i].path === bp && hasSliceName(list[i])) {
      const s = i;
      i++;
      while (i < list.length && String(list[i].path).startsWith(bp + ".")) i++;
      const slice = list[s];
      res.push({ defn: slice, type: hasType(slice) ? String(types(slice)[0].code) : null, start: s, end: i - 1, handled: false });
    }
    return res;
  }

  private diffsConstrainTypes(diffMatches: ED[], cPath: string, typeList: Array<{ defn: ED; type: string | null }>): boolean {
    const p = String(diffMatches[0].path);
    if (!p.endsWith("[x]") && !cPath.endsWith("[x]")) return false;
    typeList.length = 0;
    let rn = tail(cPath);
    rn = rn.slice(0, rn.length - 3);
    for (const ed of diffMatches) {
      const n = tail(String(ed.path));
      if (!n.startsWith(rn)) return false;
      const s = n.slice(rn.length);
      if (s.includes(".")) continue;
      if (hasSliceName(ed) && types(ed).length === 1) typeList.push({ defn: ed, type: workingCode(types(ed)[0]) });
      else if (hasSliceName(ed) && types(ed).length === 0) {
        if (this.isDataTypeName(s)) typeList.push({ defn: ed, type: s });
        else if (this.isPrimitive(uncapitalize(s))) typeList.push({ defn: ed, type: uncapitalize(s) });
        else {
          const tn = String(ed.sliceName).slice(n.length);
          if (this.isDataTypeName(tn)) typeList.push({ defn: ed, type: tn });
          else if (this.isPrimitive(uncapitalize(tn))) typeList.push({ defn: ed, type: uncapitalize(tn) });
        }
      } else if (!hasSliceName(ed) && s !== "[x]") {
        if (this.isDataTypeName(s)) typeList.push({ defn: ed, type: s });
        else if (this.isConstrainedDataType(s)) typeList.push({ defn: ed, type: this.baseType(s) });
        else if (this.isPrimitive(uncapitalize(s))) typeList.push({ defn: ed, type: uncapitalize(s) });
      } else if (!hasSliceName(ed) && s === "[x]") typeList.push({ defn: ed, type: null });
    }
    return true;
  }

  private determineFixedType(diffMatches: ED[], fixedType: string | null, i: number): string | null {
    const d = diffMatches[i];
    if (types(d).length === 0 && hasSliceName(d)) {
      const n = tail(String(d.path)).replace("[x]", "");
      const t = String(d.sliceName).slice(n.length);
      if (this.isDataTypeName(t)) return t;
      if (this.isPrimitive(uncapitalize(t))) return uncapitalize(t);
      throw new SnapshotError(`Unexpected condition in differential (implicit slice name does not contain a valid type '${t}' at ${d.path}/${d.sliceName})`);
    }
    if (types(d).length === 1) return String(types(d)[0].code);
    throw new SnapshotError(`Unexpected condition in differential (typeslice.type.size() != 1 at ${d.path}/${d.sliceName})`);
  }

  private determineTypeSlicePath(path: string, cpath: string): string {
    return path.slice(0, path.lastIndexOf(".")) + "." + cpath.slice(cpath.lastIndexOf(".") + 1);
  }

  private rootName(cpath: string): string {
    return tail(cpath).replace("[x]", "");
  }

  private isImplicitSlicing(ed: ED, path: string): boolean {
    if (!ed || !ed.path || path == null) return false;
    if (path === ed.path) return false;
    return path.endsWith("[x]") && String(ed.path).startsWith(path.slice(0, -3));
  }

  private isExtension(ed: ED): boolean {
    const p = String(ed.path);
    return p.endsWith(".extension") || p.endsWith(".modifierExtension");
  }

  private unbounded(ed: ED): boolean {
    if (!hasMax(ed)) return false;
    return ed.max !== "1" && ed.max !== "0";
  }

  private isSlicedToOneOnly(e: ED): boolean {
    return hasSlicing(e) && e.max === "1";
  }

  private isTypeSlicing(e: ED): boolean {
    const d = e.slicing?.discriminator;
    return hasSlicing(e) && Array.isArray(d) && d.length === 1 && d[0].type === "type" && d[0].path === "$this";
  }

  private makeExtensionSlicing(): Json {
    return { discriminator: [{ type: "value", path: "url" }], ordered: false, rules: "open" };
  }

  private pathStartsWith(p1: string, p2: string): boolean {
    return p1.startsWith(p2) || (p2.endsWith("[x].") && p1.startsWith(p2.slice(0, -4)));
  }

  private baseWalksInto(elements: ED[], cursor: number): boolean {
    if (cursor >= elements.length) return false;
    return String(elements[cursor].path).startsWith(String(elements[cursor - 1].path) + ".");
  }

  private fixedPathSource(contextPath: string | null, pathSimple: string, redirector: Redirection[]): string {
    if (contextPath == null) return pathSimple;
    if (redirector.length) {
      const ptail = contextPath.length >= pathSimple.length ? pathSimple.slice(pathSimple.indexOf(".") + 1) : pathSimple.slice(contextPath.length + 1);
      return redirector[redirector.length - 1].path + "." + ptail;
    }
    return contextPath + "." + pathSimple.slice(pathSimple.indexOf(".") + 1);
  }

  private fixedPathDest(contextPath: string | null, pathSimple: string, redirector: Redirection[], redirectSource: string | null): string {
    if (contextPath == null) return pathSimple;
    if (redirector.length) {
      const rs = redirectSource ?? "";
      const ptail = rs.length >= pathSimple.length ? pathSimple.slice(pathSimple.indexOf(".") + 1) : pathSimple.slice(rs.length + 1);
      return contextPath + "." + ptail;
    }
    return contextPath + "." + pathSimple.slice(pathSimple.indexOf(".") + 1);
  }

  private getElementById(source: Json, elements: ED[], contentReference: string): { source: Json; element: ED } | null {
    let ref = contentReference;
    if (!ref.startsWith("#") && ref.includes("#")) {
      const url = ref.slice(0, ref.indexOf("#"));
      ref = ref.slice(ref.indexOf("#"));
      if (url !== source.url) {
        const s = this.findProfile(url);
        if (!s) return null;
        source = s;
        elements = s.snapshot.element;
      }
    }
    for (const ed of elements) if (ed.id && "#" + ed.id === ref) return { source, element: ed };
    return null;
  }

  private replaceFromContentReference(outcome: ED, tgt: ED): void {
    delete outcome.contentReference;
    outcome.type = clone(types(tgt));
  }

  private typeSummary(ed: ED): string {
    return types(ed)
      .map((t) => workingCode(t))
      .join(", ");
  }

  private updateFromBase(derived: ED, base: ED): void {
    if (base.base) derived.base = { path: base.base.path, min: base.base.min, max: base.base.max };
    else derived.base = { path: base.path, min: base.min, max: base.max };
  }

  private updateConstraintSources(ed: ED, url: string): void {
    for (const c of ed.constraint || []) if (!c.source) c.source = url;
  }

  private updateFromSlicing(dst: Json, src: Json | undefined): void {
    if (!src) return;
    if (typeof src.ordered === "boolean") dst.ordered = src.ordered;
    if (Array.isArray(src.discriminator)) {
      dst.discriminator = Array.isArray(dst.discriminator) ? dst.discriminator : [];
      for (const s of src.discriminator) if (!dst.discriminator.some((d: Json) => d.type === s.type && d.path === s.path)) dst.discriminator.push(clone(s));
    }
    if (src.rules) dst.rules = src.rules;
  }

  private discriminatorMatches(diff: Json[], base: Json[]): boolean {
    if (!diff.length || !base.length) return true;
    if (diff.length < base.length) return false;
    for (let i = 0; i < base.length; i++) if (!(diff[i].type === base[i].type && diff[i].path === base[i].path)) return false;
    return true;
  }

  private ruleMatches(diff: string | undefined, base: string | undefined): boolean {
    return diff == null || base == null || diff === base || base === "open" || (diff === "openAtEnd" && base === "closed");
  }

  private fillOutFromBase(profile: ED, usage: ED): ED {
    const res = clone(profile);
    if (!hasSliceName(res) && usage.sliceName) res.sliceName = usage.sliceName;
    if (!res.label && usage.label) res.label = usage.label;
    for (const c of usage.code || []) if (!(res.code || []).some((x: Json) => deepEqual(x, c))) (res.code = res.code || []).push(clone(c));
    if (!res.definition && usage.definition) res.definition = usage.definition;
    if (!res.short && usage.short) res.short = usage.short;
    if (!res.comment && usage.comment) res.comment = usage.comment;
    if (!res.requirements && usage.requirements) res.requirements = usage.requirements;
    for (const a of usage.alias || []) if (!(res.alias || []).includes(a)) (res.alias = res.alias || []).push(a);
    if (!hasMin(res) && hasMin(usage)) res.min = usage.min;
    if (!hasMax(res) && hasMax(usage)) res.max = usage.max;
    for (const pfx of ["fixed", "pattern", "minValue", "maxValue"] as const) {
      if (!getValue(res, pfx)) {
        const v = getValue(usage, pfx);
        if (v) setValue(res, pfx, v);
      }
    }
    if (!res.example && usage.example) res.example = clone(usage.example);
    if (res.maxLength === undefined && usage.maxLength !== undefined) res.maxLength = usage.maxLength;
    for (const k of ["mustSupport", "isSummary", "isModifier", "isModifierReason", "mustHaveValue"]) if (res[k] === undefined && usage[k] !== undefined) res[k] = usage[k];
    if (!res.binding && usage.binding) res.binding = clone(usage.binding);
    for (const c of usage.constraint || []) if (!(res.constraint || []).some((x: Json) => x.key === c.key)) (res.constraint = res.constraint || []).push(clone(c));
    for (const e of usage.extension || []) if (!(res.extension || []).some((x: Json) => x.url === e.url)) (res.extension = res.extension || []).push(clone(e));
    return res;
  }

  private checkExtensionDoco(base: ED): boolean {
    const p = String(base.path);
    const isExtension = (p === "Extension" || p.endsWith(".extension") || p.endsWith(".modifierExtension")) && !(base.base && base.base.path === "II.extension");
    const hasTypeProfile = types(base).some((t) => Array.isArray(t.profile) && t.profile.length > 0);
    if (isExtension && !(this.inheritedInlineExtension.has(base) && !hasTypeProfile)) {
      base.definition = "An Extension";
      base.short = "Extension";
      delete base.comment;
      delete base._comment;
      delete base.requirements;
      delete base._requirements;
      delete base.alias;
      delete base.mapping;
    }
    return isExtension;
  }

  private removeInapplicableTypeConstraints(ed: ED): void {
    if (ed.binding && !this.hasBindableType(ed)) delete ed.binding;
  }

  private hasBindableType(ed: ED): boolean {
    const codes = types(ed).map((t) => workingCode(t));
    if (!codes.length && ed.path && !String(ed.path).includes(".")) codes.push(String(ed.path));
    for (const code of codes) {
      if (["Coding", "CodeableConcept", "Quantity", "uri", "string", "code", "CodeableReference"].includes(code)) return true;
      const sd = this.opts.fetch(code.includes(":") ? code : CORE + code);
      if (sd && (sd.extension || []).some((x: Json) => x?.url === "http://hl7.org/fhir/StructureDefinition/elementdefinition-bindingStyle" || x?.url === "http://hl7.org/fhir/tools/StructureDefinition/binding-style")) return true;
      if (sd && (sd.extension || []).some((x: Json) => x?.url === "http://hl7.org/fhir/tools/StructureDefinition/type-characteristics" && x.valueCode === "can-bind")) return true;
      if (["canonical", "url", "uuid", "oid", "id", "markdown"].includes(code)) return true;
    }
    return false;
  }

  private updateExtensionsFromDefinition(dest: Json, source: Json): void {
    const srcExt: Json[] = Array.isArray(source?.extension) ? source.extension : [];
    let dExt: Json[] = Array.isArray(dest.extension) ? dest.extension : [];
    dExt = dExt.filter((ext) => !(NON_INHERITED_ED_URLS.includes(ext.url) || (DEFAULT_INHERITED_ED_URLS.includes(ext.url) && srcExt.some((s) => s.url === ext.url))));
    for (const ext of srcExt) {
      const existing = dExt.find((x) => x.url === ext.url);
      if (!existing) dExt.push(clone(ext));
      else if (NON_OVERRIDING_ED_URLS.includes(ext.url)) {
        // nothing
      } else if (OVERRIDING_ED_URLS.includes(ext.url)) {
        for (const k of Object.keys(existing)) if (k.startsWith("value")) delete existing[k];
        for (const k of Object.keys(ext)) if (k.startsWith("value")) existing[k] = clone(ext[k]);
      } else dExt.push(clone(ext));
    }
    if (dExt.length) dest.extension = dExt;
    else delete dest.extension;
  }

  /** ProfileUtilities.updateFromDefinition: the differential element `source` over its snapshot copy `dest`. */
  private updateFromDefinition(dest: ED, source: ED, pn: string, trimDifferential: boolean, purl: string, srcSD: Json, derivedSrc: Json, fromSlicer: boolean): void {
    void trimDifferential;
    void purl;
    void derivedSrc;
    this.generatedIn.set(source, dest);
    const base = dest;
    const derived = source;
    const baseTypeCount = types(base).length;
    const isExtension = this.checkExtensionDoco(base);
    this.updateExtensionsFromDefinition(dest, source);

    let profile: Json | null = null;
    let msg = true;
    if (hasSliceName(base)) {
      profile = types(base).length === 1 && (types(base)[0].profile || []).length ? this.findProfile(types(base)[0].profile[0]) : null;
    }
    const sft = types(source)[0];
    if (profile == null && sft && (sft.profile || []).length) {
      profile = this.findProfile(sft.profile[0]);
      if (profile != null && profile.type !== "Extension" && profile.kind !== "resource" && profile.kind !== "logical") {
        profile = null;
        msg = false;
      }
    }
    void msg;
    if (profile != null && (profile.kind === "resource" || profile.type === "Extension")) {
      const e = profile.snapshot.element[0];
      if (e.definition) base.definition = e.definition;
      if (e.binding?.description) {
        base.binding = base.binding || {};
        base.binding.description = e.binding.description;
      }
      if (e.short !== undefined) base.short = e.short;
      else delete base.short;
      if (hasPrim(e, "comment")) copyPrim(base, e, "comment");
      if (hasPrim(e, "requirements")) copyPrim(base, e, "requirements");
      if (e.alias) base.alias = clone(e.alias);
      else delete base.alias;
      if (e.mapping) base.mapping = clone(e.mapping);
      else delete base.mapping;
    }
    if (derived.sliceName) base.sliceName = derived.sliceName;
    for (const k of ["short", "definition", "comment", "label", "requirements"]) {
      if (hasPrim(derived, k) && !deepEqual(prim(derived, k), prim(base, k))) {
        if (k === "definition" || k === "comment" || k === "requirements") this.mergeMarkdown(base, derived, k);
        else copyPrim(base, derived, k);
      }
    }
    if (!String(base.path).includes(".")) {
      delete base.requirements;
      delete base._requirements;
    }
    if (Array.isArray(derived.alias) && derived.alias.length && !deepEqual(derived.alias, base.alias)) {
      base.alias = Array.isArray(base.alias) ? base.alias : [];
      for (const a of derived.alias) if (!base.alias.includes(a)) base.alias.push(a);
    }
    if (hasMin(derived) && derived.min !== base.min) {
      if (getMin(derived) < getMin(base) && !hasSliceName(derived)) {
        this.addMessage("error", pn + "." + source.path, `Element ${base.path}: derived min (${derived.min}) cannot be less than the base min (${base.min}) in ${srcSD.url}`);
      }
      base.min = derived.min;
    }
    if (hasMax(derived) && derived.max !== base.max) {
      if (this.isLargerMax(derived.max, base.max)) this.addMessage("error", pn + "." + source.path, `Element ${base.path}: derived max (${derived.max}) cannot be greater than the base max (${base.max})`);
      base.max = derived.max;
    }
    for (const pfx of ["fixed", "pattern"] as const) {
      const v = getValue(derived, pfx);
      if (v && !deepEqual([v.key, v.value, v.ext], (() => { const b = getValue(base, pfx); return b ? [b.key, b.value, b.ext] : undefined; })())) setValue(base, pfx, v);
    }
    if (Array.isArray(derived.example)) {
      for (const ex of derived.example) {
        if (!(base.example || []).some((x: Json) => deepEqual(x, ex))) (base.example = base.example || []).push(clone(ex));
      }
    }
    if (derived.maxLength !== undefined) {
      if (base.maxLength !== undefined && derived.maxLength > base.maxLength) {
        // the tightest bound wins
      } else base.maxLength = derived.maxLength;
    }
    for (const pfx of ["maxValue", "minValue"] as const) {
      const v = getValue(derived, pfx);
      if (!v) continue;
      const b = getValue(base, pfx);
      if (b && b.value !== undefined && v.value !== undefined && typeof b.value !== "object" && typeof v.value !== "object") {
        const c = this.compareValues(v.value, b.value);
        if (c != null && (pfx === "maxValue" ? c > 0 : c < 0)) continue; // a profile can't loosen what it inherits
      }
      if (!b || !deepEqual([v.key, v.value], [b.key, b.value])) setValue(base, pfx, v);
    }
    if (derived.mustSupport !== undefined) {
      if (!(base.mustSupport !== undefined && base.mustSupport === derived.mustSupport)) {
        if (base.mustSupport === true && derived.mustSupport === false && !fromSlicer) {
          this.addMessage("error", pn + "." + derived.path, "Illegal constraint [must-support = false] when [must-support = true] in the base profile");
        }
        base.mustSupport = derived.mustSupport;
        if (derived._mustSupport) base._mustSupport = clone(derived._mustSupport);
      }
    }
    if (derived.mustHaveValue !== undefined && base.mustHaveValue !== derived.mustHaveValue) base.mustHaveValue = derived.mustHaveValue;
    if (Array.isArray(derived.valueAlternatives)) {
      base.valueAlternatives = Array.isArray(base.valueAlternatives) ? base.valueAlternatives : [];
      for (const s of derived.valueAlternatives) if (!base.valueAlternatives.includes(s)) base.valueAlternatives.push(s);
    }
    if (isExtension) {
      if (derived.isModifier !== undefined) base.isModifier = derived.isModifier;
      if (derived.isModifierReason !== undefined) base.isModifierReason = derived.isModifierReason;
      if (base.isModifier === true && !base.isModifierReason) {
        base.isModifierReason = "Modifier extensions are labelled as such because they modify the meaning or interpretation of the resource or element that contains them";
      }
    }
    if (derived.binding) {
      const db = derived.binding;
      if (!base.binding || !deepEqual(db, base.binding)) {
        if (base.binding && base.binding.strength === "required" && db.strength && db.strength !== "required") {
          this.addMessage("error", pn + "." + derived.path, `illegal attempt to change the binding on ${derived.path} from ${base.binding.strength} to ${db.strength}`);
        }
        const nb: Json = clone(base.binding || {});
        delete nb.extension; // !COPY_BINDING_EXTENSIONS
        delete nb.description;
        if (Array.isArray(db.extension) && db.extension.length) nb.extension = clone(db.extension);
        if (db.strength) nb.strength = db.strength;
        if (db.description) nb.description = db.description;
        if (db.valueSet) nb.valueSet = db.valueSet;
        if (db._valueSet) nb._valueSet = clone(db._valueSet);
        if (Array.isArray(db.additional)) nb.additional = [...(nb.additional || []), ...clone(db.additional)];
        base.binding = nb;
      }
    } else if (base.binding && Array.isArray(base.binding.extension)) {
      base.binding.extension = base.binding.extension.filter((x: Json) => !NON_INHERITED_ED_URLS.includes(x.url));
      if (!base.binding.extension.length) delete base.binding.extension;
    }
    if (derived.isSummary !== undefined && derived.isSummary !== base.isSummary) {
      if (base.isSummary !== undefined) throw new SnapshotError(`Error in profile ${purl} at ${derived.path}: Base isSummary = ${base.isSummary}, derived isSummary = ${derived.isSummary}`);
      base.isSummary = derived.isSummary;
    }
    if (hasType(derived)) {
      if (!deepEqual(derived.type, base.type)) {
        if (hasType(base)) for (const ts of types(derived)) this.checkTypeDerivation(base, derived, ts);
        base.type = clone(derived.type);
      }
    }
    // constraints are cumulative: inherited ones get their source, new keys are added
    for (const s of base.constraint || []) if (!s.source) s.source = srcSD.url;
    if (Array.isArray(derived.constraint)) {
      base.constraint = Array.isArray(base.constraint) ? base.constraint : [];
      for (const s of derived.constraint) {
        if (!base.constraint.some((c: Json) => c.key === s.key)) base.constraint.push(clone(s));
        else {
          for (const bc of base.constraint) {
            if (s.key === bc.key && s.expression && bc.expression && String(s.expression).trim() !== String(bc.expression).trim()) {
              this.addMessage("error", pn + "." + derived.path, `The constraint key '${s.key}' at ${derived.path} has a different expression (${s.expression}) to the one in the base (${bc.expression})`);
            }
          }
        }
      }
    }
    if (Array.isArray(derived.condition)) {
      base.condition = Array.isArray(base.condition) ? base.condition : [];
      for (const c of derived.condition) if (!base.condition.includes(c)) base.condition.push(c);
    }
    if (hasType(derived) && types(dest).length < baseTypeCount) this.removeInapplicableTypeConstraints(dest);
  }

  private compareValues(a: any, b: any): number | null {
    if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a > b ? 1 : -1;
    if (typeof a === "string" && typeof b === "string") return a === b ? 0 : a > b ? 1 : -1;
    return null;
  }

  private mergeMarkdown(base: ED, derived: ED, k: string): void {
    const dv = derived[k];
    const bv = base[k];
    let v = dv;
    if (dv === undefined && bv !== undefined) v = bv;
    else if (typeof dv === "string" && typeof bv === "string" && dv.startsWith("...")) v = bv + "\r\n" + dv.slice(3).trimStart();
    if (v !== undefined) base[k] = v;
    if (derived["_" + k] !== undefined) base["_" + k] = clone(derived["_" + k]);
  }

  private isLargerMax(derived: string, base: string | undefined): boolean {
    if (base === "*" || base === undefined) return false;
    if (derived === "*") return true;
    return parseInt(derived, 10) > parseInt(base, 10);
  }

  /** checkTypeDerivation's snapshot effect: the type keeps the base type's type-must-support / pattern extensions. */
  private checkTypeDerivation(base: ED, _derived: ED, ts: Json): void {
    const t = workingCode(ts);
    for (const td of types(base)) {
      if (td.code && workingCode(td) === t) {
        for (const ext of td.extension || []) {
          if (ext.url === "http://hl7.org/fhir/StructureDefinition/elementdefinition-type-must-support" && !(ts.extension || []).some((x: Json) => x.url === ext.url)) {
            ts.extension = [...(ts.extension || []), clone(ext)];
          }
        }
      }
    }
  }
}

/** Generate (or return) a snapshot over an async resolver: reruns the synchronous generator after loading misses. */
export async function generateSnapshotAsync(sd: Json, fetch: (url: string) => Promise<Json | null>, cache: Map<string, Json | null> = new Map(), maxRounds = 200): Promise<Json | null> {
  if (Array.isArray(sd?.snapshot?.element) && sd.snapshot.element.length) return sd;
  for (let round = 0; round < maxRounds; round++) {
    const gen = new SnapshotGenerator({
      fetch: (url) => {
        if (!cache.has(url)) throw new NeedDefinition(url);
        return cache.get(url) ?? null;
      },
    });
    try {
      return gen.ensure(sd);
    } catch (e) {
      if (!(e instanceof NeedDefinition)) return null;
      cache.set(e.url, await fetch(e.url).catch(() => null));
    }
  }
  return null;
}
