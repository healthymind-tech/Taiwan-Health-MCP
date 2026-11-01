/**
 * ISSUES_v17.4 — national payer / authority organizations of an IG, derived from the profiles only
 * (IG-agnostic: no organization names, no URLs). An Organization profile is national when
 *   (a) it pins Organization.type (fixed / pattern) to a government / payer kind of the HL7
 *       organization-type CodeSystem (govt, pay, ins) — e.g. TW Core Organization-govt-twcore
 *       (type = govt), or
 *   (b) the IG's own profiles target it from a payer / authority reference element (Coverage.payor,
 *       Claim.insurer, ClaimResponse.insurer, any *.payor / *.insurer / *.payer / *.authority) and
 *       from no other element — a profile that is also the target of custodian / performer /
 *       assigner … references is the IG's generic organization (every hospital), never national.
 *       e.g. TWPAS Coverage-twpas Coverage.payor and ClaimResponse-twpas ClaimResponse.insurer
 *       -> Organization-govt-twcore only, while TW Core Coverage-twcore.payor targets the generic
 *       Organization-twcore (also custodian, performer …) and so does not make it national;
 *   or (c) it derives (baseDefinition, <= 4 levels) from a national profile.
 * Only such organizations may take identity values (name, identifier, telecom, address) from the
 * IG's example instances (fhir_get_minimal_skeleton ig-constant, the grounding exemption); a hospital,
 * clinic, lab or practitioner never does.
 */

import { stripVersion, type BlueprintDeps } from "./common.js";
import type { LoadedProfile } from "../authoring/fields.js";

type Json = Record<string, any>;

/** Reference elements (last path segment) that name the payer / authority of a resource. */
export const PAYER_ELEMENTS = new Set(["payor", "insurer", "payer", "authority"]);
export const ORGANIZATION_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/organization-type";
/** organization-type codes of a government / payer kind. */
export const NATIONAL_ORG_TYPES = new Set(["govt", "pay", "ins"]);
const CORE_SD = "http://hl7.org/fhir/StructureDefinition/";

function codingsOf(v: unknown, out: Json[] = [], depth = 0): Json[] {
  if (depth > 6 || v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    for (const x of v) codingsOf(x, out, depth + 1);
    return out;
  }
  const o = v as Json;
  if (typeof o.code === "string") out.push(o);
  for (const [k, x] of Object.entries(o)) if (k !== "code") codingsOf(x, out, depth + 1);
  return out;
}

/** (a) The profile pins Organization.type to govt / pay / ins (fixed or pattern, any slice). Null when not. */
export function nationalTypeOf(sd: Json | null | undefined): string | null {
  if (!sd || sd.type !== "Organization") return null;
  for (const e of (sd.snapshot?.element || []) as Json[]) {
    const path = String(e.path ?? "");
    if (path !== "Organization.type" && !path.startsWith("Organization.type.")) continue;
    for (const [k, v] of Object.entries(e)) {
      if (!k.startsWith("fixed") && !k.startsWith("pattern")) continue;
      if (path === "Organization.type.coding.code" || path === "Organization.type.coding.code.value") {
        if (typeof v === "string" && NATIONAL_ORG_TYPES.has(v)) return v;
        continue;
      }
      for (const c of codingsOf(v)) if (NATIONAL_ORG_TYPES.has(String(c.code)) && (c.system === undefined || c.system === ORGANIZATION_TYPE_SYSTEM)) return String(c.code);
    }
  }
  return null;
}

/** One reference use: the referring profile + element id. */
export interface PayerUse {
  profile: string;
  element: string;
}

/**
 * (b) Organization-profile canonicals (unversioned) the given profiles target ONLY from payer / authority
 * elements, each with those uses. Core (unprofiled) targets are ignored.
 */
export function payerTargetProfiles(sds: Json[]): Map<string, PayerUse[]> {
  const payer = new Map<string, PayerUse[]>();
  const other = new Set<string>();
  for (const sd of sds) {
    if (sd?.resourceType !== "StructureDefinition" || sd.derivation === "specialization") continue;
    for (const e of (sd.snapshot?.element || []) as Json[]) {
      const last = String(e.path ?? "").split(".").pop() ?? "";
      for (const t of (e.type || []) as Json[]) {
        if (t?.code !== "Reference") continue;
        for (const u of (t.targetProfile || []) as unknown[]) {
          const url = stripVersion(String(u));
          if (!url || url.startsWith(CORE_SD)) continue;
          if (PAYER_ELEMENTS.has(last)) {
            const list = payer.get(url) ?? [];
            list.push({ profile: String(sd.id ?? sd.url ?? ""), element: String(e.id ?? e.path) });
            payer.set(url, list);
          } else other.add(url);
        }
      }
    }
  }
  for (const u of other) payer.delete(u);
  return payer;
}

const payerCache = new WeakMap<object, Map<string, PayerUse[]>>();

/** Why a profile is a national payer / authority organization (a short basis), or null. */
export async function nationalOrganizationBasis(loaded: LoadedProfile, deps: BlueprintDeps): Promise<string | null> {
  const sd = loaded.sd;
  if (!sd || sd.type !== "Organization") return null;
  const t = nationalTypeOf(sd);
  if (t) return `the profile pins Organization.type = ${t}`;
  let targets: Map<string, PayerUse[]> | null = null;
  if (deps.igProfiles) {
    try {
      const sds = await deps.igProfiles(loaded);
      targets = payerCache.get(sds) ?? payerTargetProfiles(sds);
      payerCache.set(sds, targets);
    } catch {
      targets = null;
    }
  }
  let cur: Json | null = sd;
  for (let depth = 0; cur && depth <= 4; depth++) {
    const url = stripVersion(String(cur.url ?? ""));
    if (depth > 0) {
      const ty = nationalTypeOf(cur);
      if (ty) return `derived from ${url.split("/").pop()} (Organization.type = ${ty})`;
    }
    const uses = targets?.get(url);
    if (uses?.length) {
      const u = uses[0];
      return `${depth > 0 ? `derived from ${url.split("/").pop()}, ` : ""}the IG's payer / authority reference ${u.element} (${u.profile}) targets only this profile`;
    }
    const base = typeof cur.baseDefinition === "string" ? cur.baseDefinition : "";
    if (!base || base.startsWith(CORE_SD)) break;
    try {
      cur = await deps.fetchStructureDefinition(loaded, base);
    } catch {
      cur = null;
    }
  }
  return null;
}
