/**
 * The StructureDefinition rules of validator_cli 7.0.1 — a partial port of
 * org.hl7.fhir.validation/.../instance/type/StructureDefinitionValidator.java (InstanceValidator.checkSpecials on a
 * StructureDefinition) plus the `StructureDefinition.type` rule of InstanceValidator.checkPrimitive (l. 3896-3925).
 *
 * Ported: validateStructureDefinition's snapshot generation of a constraint (ERROR_GENERATING_SNAPSHOT, l. 141-194),
 * SD_SPECIALIZED_TYPE_MATCHES, and of validateElementDefinition: SD_PATH_TYPE_MISMATCH, SD_NO_SLICING_ON_ROOT, the
 * binding characteristics (SD_ILLEGAL_CHARACTERISTICS, SD_ED_BIND_NO_BINDABLE), type profiles
 * (validateTypeProfile: SD_ED_TYPE_PROFILE_WRONG) and fixed values against the base.
 * Not ported: the rest of the element rules (invariants, obligations, mappings, context invariants, compliesWith).
 */
import { NeedDefinition, SnapshotError, SnapshotGenerator } from "./fhirSnapshotGenerator.js";

type Json = Record<string, any>;

export interface SdIssue {
  severity: "error" | "warning";
  path: string;
  code: string;
  message: string;
}

export interface SdValidatorDeps {
  fetch(url: string): Promise<Json | null>;
  /** java.util.HashSet.toString of the type codes. */
  hashSet(values: string[]): string;
}

const CORE = "http://hl7.org/fhir/StructureDefinition/";
const EXT_FHIR_TYPE = "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type";
const EXT_TYPE_CHARACTERISTICS = "http://hl7.org/fhir/StructureDefinition/structuredefinition-type-characteristics";
const DISCRIMINATOR_TYPES = ["value", "exists", "pattern", "type", "profile", "position"];

/** ProfileUtilities.addKnownTypeCharacteristics: the core types that `can-bind`. */
const CAN_BIND = new Set(["string", "uri", "code", "oid", "url", "uuid", "Age", "CodeableConcept", "CodeableReference", "Coding", "Distance", "Duration", "Quantity", "Range"]);

const typeName = (sd: Json): string => {
  const t = String(sd.type ?? "");
  return t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t;
};
const versioned = (sd: Json): string => (sd.version ? `${sd.url}|${sd.version}` : String(sd.url));
const fixedKey = (ed: Json): string | undefined => Object.keys(ed).find((k) => /^fixed[A-Z]/.test(k));

function workingCode(t: Json): string {
  const ext = (t?.extension || []).find((e: Json) => e?.url === EXT_FHIR_TYPE);
  return String(ext ? (ext.valueUrl ?? ext.valueUri ?? ext.valueString ?? t.code) : (t?.code ?? ""));
}

/** ContextUtilities.generateSnapshot over the async resolver: the failure message and the error-level messages. */
async function snapshotProblems(sd: Json, deps: SdValidatorDeps): Promise<{ failure: string | null; messages: string[] }> {
  const cache = new Map<string, Json | null>();
  const derived: Json = { ...sd };
  delete derived.snapshot;
  for (let round = 0; round < 200; round++) {
    // R4+ snapshot in a StructureDefinitionValidator: pu.setNewSlicingProcessing(true), l. 153
    const gen = new SnapshotGenerator({
      newSlicingProcessing: true,
      fetch: (url) => {
        if (!cache.has(url)) throw new NeedDefinition(url);
        return cache.get(url) ?? null;
      },
    });
    try {
      gen.generate(derived);
      return { failure: null, messages: gen.messages.filter((m) => m.level === "error").map((m) => m.message) };
    } catch (e) {
      if (e instanceof NeedDefinition) {
        cache.set(e.url, await deps.fetch(e.url).catch(() => null));
        continue;
      }
      if (e instanceof SnapshotError) return { failure: e.message, messages: [] };
      throw e;
    }
  }
  return { failure: null, messages: [] };
}

async function isInstanceOf(start: Json, code: string, deps: SdValidatorDeps): Promise<boolean> {
  let sd: Json | null = start;
  const seen = new Set<Json>();
  while (sd && !seen.has(sd)) {
    seen.add(sd);
    if (sd.type === code || sd.url === code) return true;
    sd = sd.baseDefinition ? await deps.fetch(String(sd.baseDefinition)) : null;
    if (sd && !sd.abstract && sd.kind !== "logical") sd = null;
  }
  return false;
}

async function determineBaseType(start: Json, deps: SdValidatorDeps): Promise<Json | null> {
  let sd: Json | null = start;
  const seen = new Set<Json>();
  while (sd && sd.derivation === "constraint" && !seen.has(sd)) {
    seen.add(sd);
    sd = await deps.fetch(String(sd.baseDefinition));
  }
  return sd;
}

/** bindableType (l. 1644-1667). */
async function bindable(typeCodes: Set<string>, deps: SdValidatorDeps): Promise<boolean> {
  for (const tc of typeCodes) {
    if (["code", "Coding", "CodeableConcept", "Quantity", "CodeableReference"].includes(tc) || CAN_BIND.has(tc)) return true;
    let sd = await deps.fetch(tc.includes(":") ? tc : CORE + tc);
    const seen = new Set<Json>();
    while (sd && !seen.has(sd)) {
      seen.add(sd);
      if ((sd.extension || []).some((x: Json) => x?.url === EXT_TYPE_CHARACTERISTICS && x.valueCode === "can-bind")) return true;
      if (["string", "uri", "CodeableConcept", "Quantity", "CodeableReference"].includes(sd.type)) return true;
      sd = sd.baseDefinition ? await deps.fetch(String(sd.baseDefinition)) : null;
    }
  }
  return false;
}

async function elementRules(
  out: SdIssue[],
  sd: Json,
  name: string,
  listPath: string,
  list: Json[],
  snapshot: boolean,
  base: Json,
  diffById: Map<string, Json> | null,
  deps: SdValidatorDeps,
): Promise<void> {
  const tn = typeName(sd);
  for (let i = 0; i < list.length; i++) {
    const ed = list[i];
    const path = typeof ed?.path === "string" ? ed.path : null;
    if (path === null) continue;
    const at = `${listPath}.element[${i}]`;
    if (tn && path !== tn && !path.startsWith(`${tn}.`)) out.push({ severity: "error", path: at, code: "not-found", message: `The path ${path} must start with the type of the structure ${tn}` });
    if (!snapshot && !path.includes(".") && ed.slicing) out.push({ severity: "error", path: at, code: "invalid", message: "Slicing is not allowed at the root of a profile" });

    const typeCodes = new Set<string>();
    let characteristicsValid = false;
    let canBind = false;
    if (!path.includes(".")) {
      typeCodes.add(path);
      characteristicsValid = true;
      canBind = CAN_BIND.has(path);
    }
    const types: Json[] = Array.isArray(ed.type) ? ed.type : [];
    for (let t = 0; t < types.length; t++) {
      const tc = workingCode(types[t]);
      if (!tc) continue;
      typeCodes.add(tc);
      const tsd = await deps.fetch(tc.includes(":") ? tc : CORE + tc);
      if (tsd) {
        characteristicsValid = true;
        const stated = (tsd.extension || []).filter((x: Json) => x?.url === EXT_TYPE_CHARACTERISTICS);
        canBind = canBind || (stated.length ? stated.some((x: Json) => x.valueCode === "can-bind") : CAN_BIND.has(tc));
      }
      const profiles: unknown[] = Array.isArray(types[t].profile) ? types[t].profile : [];
      for (let p = 0; p < profiles.length; p++) {
        const u = String(profiles[p]);
        const psd = await deps.fetch(u);
        if (!psd) continue; // SD_ED_TYPE_PROFILE_UNKNOWN: a warning
        const bt = await determineBaseType(psd, deps);
        if (bt && !(await isInstanceOf(bt, tc, deps))) {
          out.push({
            severity: "error",
            path: `${at}.type[${t}].profile[${p}]`,
            code: "exception",
            message: `Profile ${u} is for type StructureDefinition[${versioned(bt)}], but the ${path} element has type ${tc}`,
          });
        }
      }
    }
    if (ed.binding) {
      // on a type slice the rule only applies to what the differential states on the slice (l. 822-826)
      const typeSlice = snapshot && diffById !== null && !!ed.sliceName && path.endsWith("[x]");
      const stated = !typeSlice || !!diffById?.get(String(ed.id))?.binding;
      const shown = deps.hashSet([...typeCodes]);
      if (typeCodes.size && characteristicsValid && stated && !canBind) {
        out.push({ severity: "error", path: at, code: "business-rule", message: `This element has a Binding but the types ${shown} do not make this kind of constraint relevant` });
      }
      if (stated && snapshot && !(await bindable(typeCodes, deps))) {
        out.push({ severity: "error", path: `${at}.binding`, code: "business-rule", message: `The element ${path} has a binding, but no bindable types are present ${shown}` });
      }
    }
    // l. 740-756: a fixed value must keep the one the base fixes
    if (!snapshot) {
      const k = fixedKey(ed);
      const bed = k ? (base.snapshot?.element || []).find((b: Json) => b.id === ed.id || b.path === path) : null;
      const bk = bed ? fixedKey(bed) : undefined;
      if (k && bk && typeof ed[k] !== "object" && typeof bed[bk] !== "object" && String(ed[k]) !== String(bed[bk])) {
        out.push({
          severity: "error",
          path: name,
          code: "invalid",
          message: `The fixed value at ${path} (${ed[k]}) is not consistent with the fixed value inherited from the base profile (${bed[bk]}), so instances that meet this profile would not meet the base profile`,
        });
        out.push({
          severity: "error",
          path,
          code: "value",
          message: `Value is '${ed[k]}' but is fixed to '${bed[bk]}' in the profile , because the value must match the fixed value define in '${versioned(base)}'`,
        });
      }
    }
  }
}

/** StructureDefinitionValidator.validateStructureDefinition at `path`. */
export async function validateStructureDefinition(sd: Json, path: string, deps: SdValidatorDeps): Promise<SdIssue[]> {
  const out: SdIssue[] = [];
  // InstanceValidator.checkPrimitive, StructureDefinition.type (l. 3896-3925)
  const type = typeof sd.type === "string" ? sd.type : null;
  if (type && !/^[a-z][a-z0-9+.-]*:/i.test(type) && !(await deps.fetch(CORE + type))) {
    out.push({ severity: "error", path: `${path}.type`, code: "invalid", message: `The type ${type} is not legal because it is not defined in the FHIR specification. Other types must have a namespace on them` });
  }
  const lists = [...(sd.differential?.element || []), ...(sd.snapshot?.element || [])] as Json[];
  // loadAsSD: the discriminator type is an enumeration of the model
  const badDisc = lists.flatMap((e) => (e?.slicing?.discriminator || []) as Json[]).find((d) => typeof d?.type === "string" && !DISCRIMINATOR_TYPES.includes(d.type));
  if (badDisc) {
    out.push({ severity: "error", path, code: "exception", message: `Error generating Snapshot: Unknown DiscriminatorType code '${badDisc.type}' (this usually arises from a problem in the differential)` });
    return out;
  }
  const base = typeof sd.baseDefinition === "string" ? await deps.fetch(sd.baseDefinition) : null;
  if (!base) return out; // UNABLE_TO_FIND_BASE__FOR_: a warning
  if (sd.derivation === "constraint") {
    const r = await snapshotProblems(sd, deps);
    if (r.failure !== null) {
      out.push({ severity: "error", path, code: "exception", message: `Error generating Snapshot: ${r.failure} (this usually arises from a problem in the differential)` });
    }
  } else if (sd.derivation === "specialization" && sd.type === base.type) {
    out.push({ severity: "error", path, code: "not-found", message: `The type ${sd.type} must not be the same as the type in the base structure ${base.type} that is being specialised` });
  }
  const diff: Json[] = Array.isArray(sd.differential?.element) ? sd.differential.element : [];
  const snap: Json[] = Array.isArray(sd.snapshot?.element) ? sd.snapshot.element : [];
  const diffById = new Map<string, Json>(diff.filter((e) => typeof e?.id === "string").map((e) => [e.id, e]));
  await elementRules(out, sd, path, `${path}.differential`, diff, false, base, null, deps);
  await elementRules(out, sd, path, `${path}.snapshot`, snap, true, base, diffById, deps);
  return out;
}
