/**
 * Load-time work-arounds for problems in published packages — a port of
 * org.hl7.fhir.services/src/main/java/org/hl7/fhir/services/utilities/PackageHackerRN.java
 * (validator_cli 7.0.1, hl7-core tag 7.0.1). validator_cli applies these when a resource is registered from a
 * package (BaseWorkerContext.registerResourceFromPackage:424 → fixRegisteredResource), so its verdicts are made
 * against the fixed definitions; ours must be too.
 *
 * Ported (fixRegisteredResource, PHR:46-175):
 *  - v2-0391|2.6, v2-0391|2.4, v2-0360|2.7, v2-0006|2.1, v2-0006|2.4, v2-0360|2.3.1: a CodeSystem whose `url` carries
 *    a `|version` is registered as `<url>-<version>` with that version (PHR:47-71, CanonicalResourceProxy.hack);
 *  - ValueSet/languages: experimental = false (PHR:73-75);
 *  - iso21090-nullFlavor 4.0.1: the binding's `v3-NullFlavor|4.0.1` loses its version (PHR:77-89);
 *  - DeviceUseStatement / ServiceRequest 4.0.1: text-only requirement / binding description fixes (PHR:90-119);
 *  - core R4 vitalsigns and its direct children: Observation.component.value[x] `ucum-vitals-common|4.0.1` is
 *    extensible, not required (PHR:120-135);
 *  - hl7.fhir.r2b.core: Resource.id base max 1 (PHR:137-144);
 *  - hl7.fhir.uv.extensions.r4: integer64 / CodeableReference / RatioRange / Availability / ExtendedContactDetail
 *    removed from every element's types (PHR:147-161);
 *  - quantity-confidenceInterval in hl7.fhir.uv.extensions*: sub-extension slices fix their url (PHR:165-169,
 *    fixSubExtensionUrl PHR:181-212).
 *
 * Not ported, with the reason:
 *  - fixLoadedResource (PHR:217-306): fixSimpleQuantity adds sqty-1 to SimpleQuantity-typed elements — our
 *    validator already checks the SimpleQuantity type profile, whose root carries sqty-1, so adding it here would
 *    report it twice; fixResourceIdType (Resource.id typed `id`) is applied by fhirValidator.checkPrimitive;
 *    the R5 snapshot3 link / binding-definition markdown fixes change no verdict.
 *  - fixBindingDescriptions (PHR:312): rendering only.
 *
 * Like the Java original only package content is fixed — loose resources (test `supporting` files, uploads that
 * are not package members) are not (PackageHackerRN class comment).
 *
 * The fix mutates `res` in place (idempotent) and returns it.
 */

type Json = Record<string, any>;

const CORE_SD = "http://hl7.org/fhir/StructureDefinition/";
const VITALSIGNS = "http://hl7.org/fhir/StructureDefinition/vitalsigns";
const UCUM_VITALS_COMMON_401 = "http://hl7.org/fhir/ValueSet/ucum-vitals-common|4.0.1";
const NULLFLAVOR_401 = "http://terminology.hl7.org/ValueSet/v3-NullFlavor|4.0.1";
const EXT_R4_REMOVED_TYPES = ["integer64", "CodeableReference", "RatioRange", "Availability", "ExtendedContactDetail"];
const SR_BINDING_OLD =
  "Codes for tests or services that can be carried out by a designated individual, organization or healthcare service.  For laboratory, LOINC is  (preferred)[http://build.fhir.org/terminologies.html#preferred] and a valueset using LOINC Order codes is available [here](valueset-diagnostic-requests.html).";
const SR_BINDING_NEW =
  "Codes for tests or services that can be carried out by a designated individual, organization or healthcare service.  For laboratory, LOINC is  (preferred)[http://build.fhir.org/terminologies.html#preferred].";

/** PHR:47-71: CodeSystems published with `|version` in their url. */
const VERSIONED_URL_HACKS: Record<string, [string, string]> = {
  "http://terminology.hl7.org/CodeSystem/v2-0391|2.6": ["http://terminology.hl7.org/CodeSystem/v2-0391-2.6", "2.6"],
  "http://terminology.hl7.org/CodeSystem/v2-0391|2.4": ["http://terminology.hl7.org/CodeSystem/v2-0391-2.4", "2.4"],
  "http://terminology.hl7.org/CodeSystem/v2-0360|2.7": ["http://terminology.hl7.org/CodeSystem/v2-0360-2.7", "2.7"],
  "http://terminology.hl7.org/CodeSystem/v2-0006|2.1": ["http://terminology.hl7.org/CodeSystem/v2-0006-2.1", "2.1"],
  "http://terminology.hl7.org/CodeSystem/v2-0006|2.4": ["http://terminology.hl7.org/CodeSystem/v2-0006-2.4", "2.4"],
  "http://terminology.hl7.org/CodeSystem/v2-0360|2.3.1": ["http://terminology.hl7.org/CodeSystem/v2-0360-2.3.1", "2.3.1"],
};

function elementLists(sd: Json): Json[][] {
  const out: Json[][] = [];
  for (const k of ["snapshot", "differential"]) {
    const els = sd[k]?.element;
    if (Array.isArray(els)) out.push(els.filter((e: unknown) => e !== null && typeof e === "object"));
  }
  return out;
}

/** PHR:181-212: the sub-extension slice Extension.extension:{name} fixes its url to {name} (diff and snapshot). */
export function fixSubExtensionUrl(sd: Json, name: string): void {
  const sliceId = `Extension.extension:${name}`;
  const urlId = `${sliceId}.url`;
  const diff: Json[] | undefined = Array.isArray(sd.differential?.element) ? sd.differential.element : undefined;
  if (diff) {
    let slice = -1;
    let url: Json | null = null;
    for (let i = 0; i < diff.length; i++) {
      if (diff[i]?.id === sliceId) slice = i;
      if (diff[i]?.id === urlId) url = diff[i];
    }
    if (slice > -1) {
      if (url === null) {
        url = { id: urlId, path: "Extension.extension.url" };
        diff.splice(slice + 1, 0, url);
      }
      if (!hasFixed(url)) url.fixedUri = name;
    }
  }
  for (const ed of Array.isArray(sd.snapshot?.element) ? sd.snapshot.element : []) {
    if (ed?.id === urlId && !hasFixed(ed)) ed.fixedUri = name;
  }
}

function hasFixed(ed: Json): boolean {
  return Object.keys(ed).some((k) => k.startsWith("fixed") && k.length > 5);
}

/**
 * PackageHackerRN.fixRegisteredResource: fix `res` (a canonical resource read from package `packageId`) in place.
 * `packageId` null = not package content (loose file): only the url / content checks that do not depend on the
 * package apply — as in Java, which is never called for those, callers should simply not call it.
 */
export function fixPackageResource<T extends Json | null | undefined>(res: T, packageId: string | null): T {
  if (!res || typeof res !== "object") return res;
  const r = res as Json;
  const url = typeof r.url === "string" ? r.url : null;
  const version = typeof r.version === "string" ? r.version : null;
  const rt = r.resourceType;

  if (url !== null && VERSIONED_URL_HACKS[url]) {
    const [u, v] = VERSIONED_URL_HACKS[url];
    r.url = u;
    r.version = v;
    return res;
  }
  if (url === "http://hl7.org/fhir/ValueSet/languages") r.experimental = false;

  if (rt === "StructureDefinition") {
    if (url === "http://hl7.org/fhir/StructureDefinition/iso21090-nullFlavor" && version === "4.0.1") {
      for (const els of elementLists(r)) for (const ed of els) if (ed.binding?.valueSet === NULLFLAVOR_401) ed.binding.valueSet = "http://terminology.hl7.org/ValueSet/v3-NullFlavor";
    }
    if (url === CORE_SD + "DeviceUseStatement" && version === "4.0.1") {
      for (const els of elementLists(r))
        for (const ed of els)
          if (typeof ed.requirements === "string")
            ed.requirements = ed.requirements.split("[http://hl7.org/fhir/StructureDefinition/bodySite](null.html)").join("[http://hl7.org/fhir/StructureDefinition/bodySite](http://hl7.org/fhir/extension-bodysite.html)");
    }
    if (url === CORE_SD + "ServiceRequest" && version === "4.0.1") {
      for (const els of elementLists(r)) for (const ed of els) if (ed.binding?.description === SR_BINDING_OLD) ed.binding.description = SR_BINDING_NEW;
    }
    // PHR:120-135 — "the R4 profile wrongly applies this value set to all types ... back off the binding strength"
    if (url !== null && url.startsWith(CORE_SD) && version === "4.0.1" && r.type === "Observation" && (url === VITALSIGNS || r.baseDefinition === VITALSIGNS)) {
      for (const els of elementLists(r))
        for (const ed of els)
          if (ed.path === "Observation.component.value[x]" && ed.binding && ed.binding.valueSet === UCUM_VITALS_COMMON_401) ed.binding.strength = "extensible";
    }
    if (packageId === "hl7.fhir.r2b.core") {
      for (const ed of Array.isArray(r.snapshot?.element) ? r.snapshot.element : [])
        if (ed?.path === `${r.type}.id`) ed.base = { ...(ed.base ?? {}), max: "1" };
    }
    if (packageId === "hl7.fhir.uv.extensions.r4") {
      for (const els of elementLists(r))
        for (const ed of els) {
          if (!Array.isArray(ed.type)) continue;
          ed.type = ed.type.filter((t: Json) => !EXT_R4_REMOVED_TYPES.includes(t?.code));
          if (!ed.type.length) delete ed.type; // an empty type list is no type (Java hasType() false)
        }
    }
    if (url === CORE_SD + "quantity-confidenceInterval" && packageId !== null && packageId.startsWith("hl7.fhir.uv.extensions")) {
      fixSubExtensionUrl(r, "confidence");
      fixSubExtensionUrl(r, "interval");
    }
  }
  return res;
}
