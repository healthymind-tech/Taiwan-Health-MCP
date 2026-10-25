/**
 * v15.2.1: element bindings from an IG's profiles for a resource that declares no profile.
 *
 * The alternative-coding suggestion (bindings.ts suggestAlternativeCoding, R3) and repair
 * (fhirRepair/alternatives.ts, R4) need the binding that allows the other system (TW Core's
 * MedicationRequest coding slice bound to medcation-atc-tw). A resource without meta.profile (and
 * no profile argument) has only the core definition, whose binding allows nothing. Then the IG's
 * profiles of that resource type are consulted (the collaborator `implicitProfiles`): one profile
 * → its binding; several → only when every profile binds the element the same way; otherwise none
 * (never assumed). Validation is not affected — the resource is still validated against what it
 * declares; the profile only informs which alternative coding to propose.
 */

import type { ImplicitProfiles } from "./types.js";

/** More candidate profiles than this are not compared (no alternative). */
export const MAX_IMPLICIT_PROFILES = 8;

/** The resource declares a profile (meta.profile, or a profile the caller validates it against). */
export function declaresProfile(resource: Record<string, any>, callerProfiles: string[] = []): boolean {
  const meta = resource && typeof resource.meta === "object" && resource.meta && Array.isArray(resource.meta.profile) ? resource.meta.profile : [];
  return meta.some((p: unknown) => typeof p === "string" && p.trim() !== "") || callerProfiles.some((p) => typeof p === "string" && p.trim() !== "");
}

/** Usable candidate list (1..MAX profiles), or null. */
export function implicitCandidates(imp: ImplicitProfiles | null | undefined): ImplicitProfiles | null {
  if (!imp || !Array.isArray(imp.profiles) || !imp.profiles.length || imp.profiles.length > MAX_IMPLICIT_PROFILES) return null;
  return imp;
}

/** Order-free identity of an element's bindings (ValueSet canonical without version + strength). */
export function bindingKey(bindings: Array<{ valueSet: string; strength?: string }>): string {
  return [...new Set(bindings.map((b) => `${b.valueSet.split("|")[0]}\t${b.strength ?? ""}`))].sort().join("\n");
}

/** Every profile binds the element the same way (and at all). */
export function bindingsAgree(perProfile: Array<Array<{ valueSet: string; strength?: string }>>): boolean {
  if (!perProfile.length || !perProfile[0].length) return false;
  const k = bindingKey(perProfile[0]);
  return perProfile.every((b) => bindingKey(b) === k);
}

/** Reason clause naming where the binding came from. */
export function implicitNote(imp: ImplicitProfiles): string {
  const quoted = imp.profiles.map((p) => `"${p}"`).join(", ");
  return imp.profiles.length === 1
    ? `the binding is from ${imp.ig}'s profile ${quoted} because the resource declares no profile`
    : `the binding is from ${imp.ig}'s profiles ${quoted} (all ${imp.profiles.length} bind this element the same way) because the resource declares no profile`;
}
