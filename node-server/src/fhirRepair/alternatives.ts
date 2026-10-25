/**
 * Accepted alternative codings (ISSUES_v15.2 R4, rule `alt-coding`): a CodeableConcept Coding whose
 * code the validator rejects ("Unknown code") because the package's copy of the CodeSystem is an
 * excerpt — while another installed copy defines it (TW Core 1.0.0 ships 35 of the ~45k NHI drug
 * codes; 0.3.2 has them all) — and whose concept links to exactly ONE coding of another system
 * that
 *   - the validator accepts (deps.codeAlternatives: the validator's code check / the bundled
 *     terminology-server verdicts — never a guess), and
 *   - a ValueSet bound to the CodeableConcept's `coding` element or one of its slices contains
 *     (membership as the validator decides it, e.g. TW Core medcation-atc-tw → slice atc-medication-code),
 * is replaced by that coding (or dropped when the CodeableConcept already carries it: validator_cli
 * rejects a CodeableConcept while an unknown Coding is in it, whatever else it holds). The name is
 * kept: CodeableConcept.text stays as written, and when there is none the original Coding's display
 * becomes the text — the product-level identification is not lost silently. Several accepted
 * alternatives → nothing is changed; reported with the candidates.
 *
 * v15.2.1: a resource that declares no profile (no meta.profile, no caller profile) has only the
 * core definition's bindings; then the binding is read from the IG's profiles of that resource type
 * (deps.implicitProfiles: the closure package owning the Coding's CodeSystem, else the validated
 * one) — one profile, or several that all bind the coding element the same way; otherwise nothing
 * (fhirSuggestions/implicitProfiles.ts). The change reason names the profile. Validation (the
 * Bundle-level verification included) still uses only what the resource declares.
 */

import { bindingsAgree, declaresProfile, implicitCandidates, implicitNote } from "../fhirSuggestions/implicitProfiles.js";
import type { CodeAlternatives, ImplicitProfiles, RepairChange, RepairIssue } from "./types.js";
import { isObject, walkResource, type Member, type Session, type Site } from "./walk.js";

type El = Record<string, any>;

type Binding = { valueSet: string; element: string; strength: string };

/**
 * ValueSets bound to the `coding` element of a CodeableConcept (its base definition and every slice).
 * `viewUrl`: only the definitions of that StructureDefinition (an implicit profile's own bindings).
 */
function codingBindings(site: Site, viewUrl: string | null = null): Binding[] {
  const out: Binding[] = [];
  const add = (d: El | null | undefined): void => {
    if (!d || !isObject(d.binding) || typeof d.binding.valueSet !== "string") return;
    const vs = d.binding.valueSet;
    if (!out.some((x) => x.valueSet === vs)) out.push({ valueSet: vs, element: String(d.id ?? d.path ?? ""), strength: String(d.binding.strength ?? "") });
  };
  const inView = (m: Member): boolean => viewUrl === null || m.view.url === viewUrl;
  if (viewUrl === null) for (const d of site.defs) add(d);
  else for (const m of site.members.filter(inView)) for (const id of m.ids) add(m.view.sdx.byId.get(id));
  // The slices of `coding` are siblings of its definition: the group under the parent element id.
  for (const m of [...site.members, ...site.ownerMembers].filter(inView)) {
    for (const id of m.ids) {
      const parent = /\.coding(?::[^.]*)?$/.test(id) ? id.replace(/\.coding(?::[^.]*)?$/, "") : id;
      const grp = m.view.sdx.childrenOfId(parent)?.get("coding");
      if (!grp) continue;
      add(grp.base);
      for (const s of grp.slices) add(s);
    }
  }
  return out;
}

/**
 * v15.2.1: the coding element's bindings from the IG profiles of a resource that declares none: the
 * site re-walked with each candidate profile (memoised per resource and profile), that profile's own
 * bindings; null when a profile cannot be read or the profiles disagree.
 */
async function implicitCodingBindings(
  session: Session,
  site: Site,
  system: string,
  walks: Map<string, Promise<Site[]>>,
): Promise<{ imp: ImplicitProfiles; bindings: Binding[] } | null> {
  const deps = session.deps;
  if (!deps.implicitProfiles) return null;
  const rt = String(site.resource.resourceType || "");
  if (!rt) return null;
  const imp = implicitCandidates(await session.memo<ImplicitProfiles | null>(`implicit\0${rt}\0${system}`, () => deps.implicitProfiles!(rt, system), null));
  if (!imp) return null;
  const per: Binding[][] = [];
  for (const p of imp.profiles) {
    const url = p.split("|")[0];
    const view = await session.view(p);
    if (!view || view.sdx.type !== rt) return null;
    const key = `${site.resourcePath}\0${p}`;
    let w = walks.get(key);
    if (!w) {
      w = walkResource(session, site.resource, { profiles: [p] }, site.resourcePath);
      walks.set(key, w);
    }
    const twin = (await w).find((x) => x.path === site.path);
    if (!twin) return null;
    per.push(codingBindings(twin, view.url || url));
  }
  if (!bindingsAgree(per)) return null;
  return { imp, bindings: per[0] };
}

export async function repairAlternativeCodings(
  session: Session,
  sites: Site[],
  rp: (p: string) => string,
  skip: (p: string) => boolean,
  /** Profiles the caller validates `site.resource` against besides its meta.profile (v15.2.1: none + no meta.profile → implicit profiles). */
  callerProfiles: (site: Site) => string[] = () => [],
): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  const deps = session.deps;
  if (!deps.codeAlternatives || !deps.valueSetContains) return { changes, issues };
  const walks = new Map<string, Promise<Site[]>>();
  // Removals are applied last, per array, from the highest index down (indices of later sites stay valid).
  const removals: Array<{ arr: unknown[]; index: number }> = [];
  for (const site of sites) {
    if (site.type !== "Coding" || site.key !== "coding" || site.index === null || site.ownerType !== "CodeableConcept" || skip(site.path)) continue;
    const coding = site.value;
    if (!isObject(coding) || typeof coding.system !== "string" || typeof coding.code !== "string" || !coding.system || !coding.code) continue;
    const system = coding.system;
    const code = coding.code;
    const known = await session.memo<CodeAlternatives | null>(`alt\0${system}\0${code}`, () => deps.codeAlternatives!(system, code), null);
    if (!known || !known.definedIn || known.inValidatedCopy) continue;
    if (deps.codeInSystem && (await session.memo(`in\0${system}\0${code}`, () => deps.codeInSystem!(system, code), undefined)) !== false) continue;
    const accepted = known.alternatives.filter((a) => a.accepted === true && a.system !== system);
    if (!accepted.length) continue;
    const allowedBy = async (bindings: Binding[]): Promise<Array<{ alt: (typeof accepted)[number]; valueSet: string; element: string }>> => {
      const allowed: Array<{ alt: (typeof accepted)[number]; valueSet: string; element: string }> = [];
      for (const alt of accepted) {
        for (const b of bindings) {
          const member = await session.memo(`vsc\0${b.valueSet}\0${alt.system}\0${alt.code}`, () => deps.valueSetContains!(b.valueSet, alt.system, alt.code), undefined);
          if (member === true) {
            allowed.push({ alt, valueSet: b.valueSet, element: b.element });
            break;
          }
        }
      }
      return allowed;
    };
    let allowed = await allowedBy(codingBindings(site));
    // v15.2.1: no declared profile → the coding element's binding in the IG's profile(s) of the type.
    let implicit: ImplicitProfiles | null = null;
    if (!allowed.length && !declaresProfile(site.resource, callerProfiles(site))) {
      const ib = await implicitCodingBindings(session, site, system, walks);
      if (ib) {
        allowed = await allowedBy(ib.bindings);
        implicit = ib.imp;
      }
    }
    if (!allowed.length) continue;
    const bindingNote = implicit ? `; ${implicitNote(implicit)}` : "";
    const name = known.display ?? (typeof coding.display === "string" ? coding.display : null);
    if (allowed.length > 1) {
      issues.push({
        path: rp(site.path),
        rule: "alt-coding",
        severity: "warning",
        message:
          `'${code}' is defined in ${known.definedIn} but not in the copy of ${system} this package validates against; its concept links to ` +
          `${allowed.length} codings the validator accepts — not changed (choose one)${bindingNote}`,
        candidates: allowed.map((a) => ({ system: a.alt.system, code: a.alt.code, ...(a.alt.display ? { display: a.alt.display } : {}) })),
      });
      continue;
    }
    const { alt, valueSet, element } = allowed[0];
    const cc = site.holder;
    const arr = cc[site.key] as unknown[];
    const replacement: Record<string, unknown> = { system: alt.system, code: alt.code, ...(alt.display ? { display: alt.display } : {}) };
    const slice = element.includes(":") ? `, slice ${element.split(":").pop()}` : "";
    const why =
      `'${code}'${name ? ` ('${name}')` : ""} is defined in ${known.definedIn} but not in the copy of ${system} this package validates against (Unknown code); ` +
      `its concept links to ${alt.system}#${alt.code}, the only linked coding the validator accepts and ${valueSet.split("|")[0].split("/").pop()}${slice} contains${bindingNote}`;
    const already = arr.some((c, i) => i !== site.index && isObject(c) && c.system === alt.system && c.code === alt.code);
    if (already) {
      removals.push({ arr, index: site.index });
      changes.push({ path: rp(site.path), from: coding, to: null, rule: "alt-coding", reason: `${why}; the CodeableConcept already carries it — the unknown Coding is dropped` });
    } else {
      arr[site.index] = replacement;
      changes.push({ path: rp(site.path), from: coding, to: replacement, rule: "alt-coding", reason: `${why} — replaced (a product-level code becomes the substance-level one)` });
    }
    // Keep the name: CodeableConcept.text as written, else the original Coding's display.
    if (!(typeof cc.text === "string" && cc.text.trim()) && name) {
      cc.text = name;
      changes.push({ path: rp(`${site.ownerPath}.text`), from: null, to: name, rule: "alt-coding", reason: `the name of '${code}' kept as CodeableConcept.text (the replacement coding names the substance only)` });
    }
  }
  const byArr = new Map<unknown[], number[]>();
  for (const r of removals) byArr.set(r.arr, [...(byArr.get(r.arr) ?? []), r.index]);
  for (const [arr, idx] of byArr) for (const i of idx.sort((a, b) => b - a)) arr.splice(i, 1);
  return { changes, issues };
}
