/**
 * ISSUES_v17.1 R1 / R2 — deterministic completion of a document Bundle (rule `document`) and narrative repair
 * (rule `narrative`), for fhir_finalize_bundle repair="content" and fhir_assemble_bundle. IG-agnostic: every
 * section, code, title and entry rule is read from the Composition profile's snapshot.
 *
 * Document (Bundle.type = document, or the Bundle profile fixes it):
 *   identifier   absent → {system: urn:ietf:rfc:3986, value: urn:uuid:<v5 of the Composition>} (a document id, not a
 *                record fact; the same document gives the same id);
 *   timestamp    absent → Composition.date when it is a full date-time with a UTC offset (an instant); otherwise
 *                reported (the time is never invented);
 *   subject      Composition.subject absent → the one Patient of the Bundle; author absent → the one Practitioner
 *                (else the one Organization); several / none → reported;
 *   sections     the Composition profile's section slices (Composition.section:<name>: code pattern, title / text
 *                minimums, entry target profiles). Every entry not reachable from the Composition (bdl-7 traversal over
 *                all references) is placed into the ONE section slice whose entry accepts it — its profile listed
 *                (else its resource type) — creating the section with its pattern code (display from the pattern or
 *                the terminology), title (the code's display) and a generated text; several fitting sections or none
 *                → reported. A required section slice left without a section is reported with the resource types
 *                its entries take (an empty section needs an emptyReason, a record fact — never invented);
 *   section text a section with entries but without text (required by the slice or created here) gets a generated
 *                list of its entries' names.
 * Narrative (every resource and section): a text without div gets one from a string property it carries (else it is
 * removed when it holds nothing else); a div without the XHTML namespace gains it; an invalid status ('final') with a
 * div → generated.
 * Nothing about the patient is invented; reported problems go to the repair issues.
 */

import { uuidV5 } from "../fhirBundleFinalize.js";
import type { RepairChange, RepairIssue } from "./types.js";

type Json = Record<string, any>;

export interface DocumentDeps {
  fetchStructureDefinition(url: string): Promise<Json | null>;
  lookupDisplay?(system: string, code: string): Promise<string | null>;
  /** ValueSet membership as the validator decides it (undefined = cannot tell). */
  valueSetContains?(url: string, system: string | null, code: string): Promise<boolean | undefined>;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const NS_DOC = "8f1c1b8e-2d5a-5d2e-9a4b-6c0f3e1a7b52";
const NARRATIVE_STATUS = new Set(["generated", "extensions", "additional", "empty"]);
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const strip = (u: string): string => String(u).split("|")[0];

function escapeXhtml(t: string): string {
  return t.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

// ------------------------------------------------------------------------------------------------ narrative

/** Repair one Narrative node in place; the change reason or null. */
export function repairNarrative(holder: Json, key: string): string | null {
  const n = holder[key];
  if (!isObj(n)) return null;
  const why: string[] = [];
  if (typeof n.div !== "string" || !n.div.trim()) {
    const other = Object.entries(n).find(([k, v]) => k !== "status" && k !== "div" && typeof v === "string" && v.trim());
    if (other) {
      n.div = `<div xmlns="${XHTML_NS}">${escapeXhtml(String(other[1]).trim())}</div>`;
      delete n[other[0]];
      why.push(`the text in '${other[0]}' became the XHTML div`);
    } else if (Object.keys(n).every((k) => k === "status" || k === "div")) {
      delete holder[key];
      return "a narrative without div (only a status) is invalid and says nothing: removed";
    } else return null;
  } else {
    const div = n.div.trim();
    if (!/^<div[\s>]/u.test(div)) {
      n.div = `<div xmlns="${XHTML_NS}">${escapeXhtml(div)}</div>`;
      why.push("the div text was wrapped in an XHTML <div>");
    } else if (!/\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/u.test(div.slice(0, div.indexOf(">") + 1))) {
      n.div = div.replace(/^<div/u, `<div xmlns="${XHTML_NS}"`).replace(/^<div xmlns="[^"]*"(\s+xmlns="[^"]*")/u, `<div xmlns="${XHTML_NS}"`);
      why.push("the XHTML namespace was added to the div");
    }
  }
  if (!NARRATIVE_STATUS.has(String(n.status))) {
    why.push(`status '${n.status ?? ""}' is not a Narrative status: generated`);
    n.status = "generated";
  }
  for (const k of Object.keys(n)) if (!["id", "extension", "status", "div"].includes(k)) delete n[k];
  return why.length ? why.join("; ") : null;
}

/** Narratives of every entry resource (text, contained resources' text) and of Composition sections. */
export function repairNarratives(bundle: Json, rp: (p: string) => string = (p) => p): RepairChange[] {
  const changes: RepairChange[] = [];
  const visit = (holder: Json, key: string, path: string): void => {
    const before = holder[key] === undefined ? undefined : JSON.parse(JSON.stringify(holder[key]));
    const why = repairNarrative(holder, key);
    if (why) changes.push({ path: rp(path), from: before, to: holder[key] ?? null, rule: "narrative", reason: why });
  };
  const entries: Json[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  entries.forEach((e, i) => {
    const r = e?.resource;
    if (!isObj(r)) return;
    const base = `Bundle.entry[${i}].resource`;
    if ("text" in r) visit(r, "text", `${base}.text`);
    (Array.isArray(r.contained) ? r.contained : []).forEach((c: Json, j: number) => isObj(c) && "text" in c && visit(c, "text", `${base}.contained[${j}].text`));
    if (r.resourceType === "Composition") {
      const walk = (secs: unknown, p: string): void => {
        (Array.isArray(secs) ? secs : []).forEach((s: Json, j: number) => {
          if (!isObj(s)) return;
          if ("text" in s) visit(s, "text", `${p}[${j}].text`);
          walk(s.section, `${p}[${j}].section`);
        });
      };
      walk(r.section, `${base}.section`);
    }
  });
  return changes;
}

// ------------------------------------------------------------------------------------------------ document

interface SectionSlice {
  name: string;
  min: number;
  code: Json | null;
  titleMin: number;
  textMin: number;
  /** Unversioned target profiles of section.entry (base + entry slices). */
  targets: string[];
}

function sectionSlices(sd: Json): SectionSlice[] {
  const els: Json[] = sd?.snapshot?.element ?? [];
  const byId = new Map(els.map((e) => [String(e.id), e]));
  const out: SectionSlice[] = [];
  for (const e of els) {
    const m = /^Composition\.section:([^.:]+)$/u.exec(String(e.id ?? ""));
    if (!m || e.max === "0") continue;
    const id = String(e.id);
    const codeEl = byId.get(`${id}.code`);
    const code = (codeEl?.patternCodeableConcept ?? codeEl?.fixedCodeableConcept ?? null) as Json | null;
    const targets = new Set<string>();
    for (const x of els) {
      const xid = String(x.id ?? "");
      if (xid !== `${id}.entry` && !(xid.startsWith(`${id}.entry:`) && !xid.slice(`${id}.entry:`.length).includes("."))) continue;
      if (x.max === "0") continue;
      for (const t of x.type ?? []) for (const p of t.targetProfile ?? []) targets.add(strip(String(p)));
    }
    out.push({ name: m[1], min: Number(e.min ?? 0), code, titleMin: Number(byId.get(`${id}.title`)?.min ?? 0), textMin: Number(byId.get(`${id}.text`)?.min ?? 0), targets: [...targets] });
  }
  return out;
}

const codingsOf = (cc: unknown): Json[] => (isObj(cc) && Array.isArray(cc.coding) ? cc.coding.filter(isObj) : []);
const sameCode = (a: unknown, b: unknown): boolean => codingsOf(a).some((x) => codingsOf(b).some((y) => x.code === y.code && (!x.system || !y.system || x.system === y.system)));

/** A short name of a resource for a generated section text. */
function nameOf(r: Json): string {
  for (const k of ["code", "medicationCodeableConcept", "vaccineCode", "type", "class"]) {
    const v = r[k];
    if (isObj(v)) {
      if (typeof v.text === "string" && v.text.trim()) return v.text.trim();
      const c = codingsOf(v).find((x) => typeof x.display === "string" && x.display.trim());
      if (c) return String(c.display).trim();
      const cc = codingsOf(v).find((x) => typeof x.code === "string");
      if (cc) return String(cc.code);
    }
  }
  for (const k of ["title", "name", "description"]) if (typeof r[k] === "string" && r[k].trim()) return r[k].trim();
  return String(r.resourceType ?? "entry");
}

/**
 * Does a resource carry the values its profile REQUIRES by pattern / fixed value on its top-level elements (or
 * their required slices: Observation.category:VSCat → a coding of the pattern)? "no" when one is missing, "yes" when
 * all are there, "unknown" when the profile pins none — this only tells apart profiles that pin different codes.
 */
function meetsPatterns(r: Json, sd: Json): "yes" | "no" | "unknown" {
  const els: Json[] = sd?.snapshot?.element ?? [];
  const byId = new Map(els.map((e) => [String(e.id), e]));
  const rt = String(sd.type);
  const val = (e: Json | undefined, kinds: string[]): unknown => (e ? kinds.map((k) => e[k]).find((v) => v !== undefined) : undefined);
  let judged = 0;
  for (const e of els) {
    const id = String(e.id ?? "");
    const m = new RegExp(`^${rt}\\.([a-zA-Z]+)(?::[^.]+)?$`, "u").exec(id);
    if (!m || Number(e.min ?? 0) < 1) continue;
    let want: Json[] = [];
    const pat = val(e, ["patternCodeableConcept", "fixedCodeableConcept", "patternCoding", "fixedCoding"]);
    if (isObj(pat)) want = Array.isArray(pat.coding) ? pat.coding : [pat];
    else {
      // pinned through the coding's children (core vitalsigns: category:VSCat.coding.code fixed 'vital-signs')
      for (const c of els) {
        const cid = String(c.id ?? "");
        if (!(cid === `${id}.coding.code` || (cid.startsWith(`${id}.coding:`) && cid.endsWith(".code") && Number(byId.get(cid.slice(0, -5))?.min ?? 0) >= 1))) continue;
        const code = val(c, ["fixedCode", "patternCode"]);
        if (typeof code !== "string") continue;
        const sys = val(byId.get(`${cid.slice(0, -5)}.system`), ["fixedUri", "patternUri"]);
        want.push({ code, ...(typeof sys === "string" ? { system: sys } : {}) });
      }
    }
    if (!want.length) continue;
    judged++;
    const have = (Array.isArray(r[m[1]]) ? r[m[1]] : [r[m[1]]]).flatMap((v: Json) => (isObj(v) ? (Array.isArray(v.coding) ? v.coding : [v]) : []));
    if (!want.every((w: Json) => have.some((h: Json) => h.code === w.code && (!w.system || h.system === w.system)))) return "no";
  }
  return judged > 0 ? "yes" : "unknown";
}

/** meetsPatterns + the required binding of a required `code` element (Observation-pregnancy-outcome: code ∈ its ValueSet). */
async function meetsProfile(r: Json, sd: Json, deps: DocumentDeps): Promise<"yes" | "no" | "unknown"> {
  const p = meetsPatterns(r, sd);
  if (p === "no" || !deps.valueSetContains) return p;
  const rt = String(sd.type);
  const el = ((sd.snapshot?.element ?? []) as Json[]).find((e) => e.id === `${rt}.code`);
  const vs = el?.binding?.strength === "required" && typeof el.binding.valueSet === "string" ? el.binding.valueSet : null;
  if (!vs || Number(el?.min ?? 0) < 1) return p;
  const codings = codingsOf(r.code).filter((c) => typeof c.code === "string");
  if (!codings.length) return p;
  let any: boolean | undefined = false;
  for (const c of codings) {
    const m = await deps.valueSetContains(vs, typeof c.system === "string" ? c.system : null, c.code).catch(() => undefined);
    if (m === true) return p === "unknown" ? "yes" : p;
    if (m === undefined) any = undefined;
  }
  return any === false ? "no" : p;
}

function instantOf(date: unknown): string | null {
  if (typeof date !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u.exec(date.trim());
  return m ? `${m[1]}T${m[2]}${m[3] ?? ":00"}${m[4]}` : null;
}

export interface DocumentOptions {
  /** The Bundle profile (canonical) the caller names; its composition entry slice gives the Composition profile. */
  bundleProfile?: string | null;
  /** Force document handling (bundle_type = document). */
  bundleType?: string | null;
}

/** Complete a document Bundle in place (see the module comment). */
export async function completeDocument(bundle: Json, deps: DocumentDeps, opts: DocumentOptions = {}): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  const change = (path: string, from: unknown, to: unknown, reason: string): void => void changes.push({ path, from, to, rule: "document", reason });
  const issue = (path: string, message: string, severity: "error" | "warning" = "error"): void => void issues.push({ path, rule: "document", severity, message });

  // Is it a document?
  const bundleProfiles = [opts.bundleProfile, ...((bundle.meta?.profile as unknown[]) ?? [])].filter((u): u is string => typeof u === "string" && !!u);
  let bsd: Json | null = null;
  for (const u of bundleProfiles) if (!bsd) bsd = await deps.fetchStructureDefinition(u).catch(() => null);
  const fixedType = (bsd?.snapshot?.element as Json[] | undefined)?.find((e) => e.path === "Bundle.type")?.fixedCode ?? (bsd?.snapshot?.element as Json[] | undefined)?.find((e) => e.path === "Bundle.type")?.patternCode;
  const isDocument = bundle.type === "document" || opts.bundleType === "document" || fixedType === "document";
  const entries: Json[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  if (!isDocument) return { changes, issues };
  const ci = entries.findIndex((e) => e?.resource?.resourceType === "Composition");
  if (ci < 0) return { changes, issues }; // bdl-11 is the finalizer's report
  const comp: Json = entries[ci].resource;
  const cpath = `Bundle.entry[${ci}].resource`;
  const refOf = (i: number): string | null => {
    const e = entries[i];
    if (typeof e?.fullUrl === "string" && e.fullUrl) return e.fullUrl;
    const r = e?.resource;
    return r?.resourceType && r?.id ? `${r.resourceType}/${r.id}` : null;
  };

  // identifier / timestamp
  if (!isObj(bundle.identifier) || !bundle.identifier.value) {
    const seed = JSON.stringify([refOf(ci), comp.identifier ?? null, comp.date ?? null, comp.subject ?? null, comp.title ?? null]);
    const id = { system: "urn:ietf:rfc:3986", value: `urn:uuid:${uuidV5(NS_DOC, seed)}` };
    change("Bundle.identifier", bundle.identifier ?? null, id, "a document Bundle needs an identifier (bdl-9); a deterministic document id (UUID v5 of the Composition) — not a record fact");
    bundle.identifier = id;
  }
  if (typeof bundle.timestamp !== "string" || !bundle.timestamp) {
    const inst = instantOf(comp.date);
    if (inst) {
      change("Bundle.timestamp", bundle.timestamp ?? null, inst, "a document Bundle needs a timestamp (bdl-10): the Composition's date-time (when the document was written)");
      bundle.timestamp = inst;
    } else issue("Bundle.timestamp", `a document Bundle needs Bundle.timestamp (an instant, bdl-10); Composition.date ${comp.date ? `'${comp.date}' has no time with a UTC offset` : "is absent"} — give the document's date-time (not invented here)`);
  }

  // subject / author
  const idxOf = (types: string[]): number[] => entries.map((e, i) => (types.includes(String(e?.resource?.resourceType)) ? i : -1)).filter((i) => i >= 0);
  if (!isObj(comp.subject)) {
    const pats = idxOf(["Patient"]);
    const ref = pats.length === 1 ? refOf(pats[0]) : null;
    if (ref) {
      comp.subject = { reference: ref };
      change(`${cpath}.subject`, null, comp.subject, "Composition.subject: the one Patient of the Bundle");
    } else issue(`${cpath}.subject`, `Composition.subject is absent and the Bundle holds ${pats.length} Patient entries — set it to the document's patient`, "warning");
  }
  if (!Array.isArray(comp.author) || !comp.author.length) {
    // an author-type entry nothing else references is the document's author (it would be unreachable otherwise)
    const AUTHOR_TYPES = ["Practitioner", "PractitionerRole", "Organization", "Device", "RelatedPerson"];
    const referenced = new Set<string>();
    const collect = (n: unknown, d: number): void => {
      if (d > 20 || !n || typeof n !== "object") return;
      if (Array.isArray(n)) return void n.forEach((x) => collect(x, d + 1));
      const o = n as Json;
      if (typeof o.reference === "string") referenced.add(o.reference);
      for (const v of Object.values(o)) if (v && typeof v === "object") collect(v, d + 1);
    };
    entries.forEach((e) => collect(e?.resource, 0));
    const orphans = idxOf(AUTHOR_TYPES).filter((i) => !referenced.has(refOf(i) ?? "\u0000"));
    let pick = orphans.length === 1 ? orphans : idxOf(["Practitioner"]);
    if (pick.length !== 1) pick = idxOf(["PractitionerRole"]).length === 1 ? idxOf(["PractitionerRole"]) : idxOf(["Organization"]);
    const ref = pick.length === 1 ? refOf(pick[0]) : null;
    if (ref) {
      comp.author = [{ reference: ref }];
      change(`${cpath}.author`, null, comp.author, `Composition.author: the one ${entries[pick[0]].resource.resourceType} of the Bundle`);
    } else issue(`${cpath}.author`, "Composition.author is required and no single Practitioner / Organization entry can be chosen — author it (the record's author or the facility)");
  }

  // sections (Composition profile)
  const cprofiles = [...((comp.meta?.profile as unknown[]) ?? [])].filter((u): u is string => typeof u === "string");
  if (!cprofiles.length && bsd) {
    const fromSlice: string[] = [];
    for (const e of (bsd.snapshot?.element ?? []) as Json[]) {
      if (/^Bundle\.entry:[^.]+\.resource$/u.test(String(e.id)) && (e.type ?? []).some((t: Json) => t.code === "Composition")) for (const t of e.type) for (const p of t.profile ?? []) fromSlice.push(String(p));
    }
    const uniq = [...new Set(fromSlice)];
    cprofiles.push(...uniq);
    if (uniq.length === 1) {
      // the Bundle profile's composition slice requires this profile: without it no entry matches the slice
      comp.meta = { ...(isObj(comp.meta) ? comp.meta : {}), profile: [uniq[0]] };
      change(`${cpath}.meta.profile`, null, [uniq[0]], `the Composition declares no profile; the Bundle profile's composition entry slice requires ${uniq[0]}`);
    }
  }
  let csd: Json | null = null;
  for (const u of cprofiles) if (!csd) csd = await deps.fetchStructureDefinition(u).catch(() => null);
  const slices = csd ? sectionSlices(csd) : [];
  if (!slices.length) return { changes, issues };
  const typeOfProfile = new Map<string, string | null>();
  const typeOf = async (u: string): Promise<string | null> => {
    if (!typeOfProfile.has(u)) typeOfProfile.set(u, (await deps.fetchStructureDefinition(u).catch(() => null))?.type ?? (/StructureDefinition\/([A-Z][A-Za-z]+)$/u.exec(u)?.[1] ?? null));
    return typeOfProfile.get(u) ?? null;
  };
  if (!Array.isArray(comp.section)) comp.section = comp.section ? [comp.section] : [];
  const sectionFor = (s: SectionSlice): Json | undefined => (comp.section as Json[]).find((x) => isObj(x) && s.code && sameCode(x.code, s.code));

  // reachability from the Composition over every reference
  const index = new Map<string, number>();
  entries.forEach((e, i) => {
    if (typeof e?.fullUrl === "string") index.set(e.fullUrl, i);
    const r = e?.resource;
    if (r?.resourceType && r?.id) index.set(`${r.resourceType}/${r.id}`, i);
  });
  const reachable = (): Set<number> => {
    const seen = new Set<number>([ci]);
    const queue = [ci];
    while (queue.length) {
      const i = queue.shift()!;
      const walk = (n: unknown, d: number): void => {
        if (d > 20 || !n || typeof n !== "object") return;
        if (Array.isArray(n)) return void n.forEach((x) => walk(x, d + 1));
        const o = n as Json;
        if (typeof o.reference === "string") {
          const j = index.get(o.reference);
          if (j !== undefined && !seen.has(j)) {
            seen.add(j);
            queue.push(j);
          }
        }
        for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, d + 1);
      };
      walk(entries[i]?.resource, 0);
    }
    return seen;
  };
  const created = new Set<Json>();
  const addedTo = new Set<Json>();
  const pending = new Map<number, string>(); // entry index -> issue message (reported if still unreachable at the end)
  for (let round = 0; round < 4; round++) {
    const reach = reachable();
    let placed = 0;
    for (let i = 0; i < entries.length; i++) {
      if (reach.has(i)) {
        pending.delete(i);
        continue;
      }
      const r = entries[i]?.resource;
      if (!isObj(r)) continue;
      const ref = refOf(i);
      if (!ref) {
        pending.set(i, "entry is not reachable from the Composition and has no fullUrl / id to reference it from a section");
        continue;
      }
      const declared = ((r.meta?.profile as unknown[]) ?? []).map((u) => strip(String(u)));
      let fit = slices.filter((s) => s.targets.some((t) => declared.includes(t)));
      if (!fit.length) {
        for (const s of slices) {
          const types = await Promise.all(s.targets.map(typeOf));
          if (types.includes(String(r.resourceType))) fit.push(s);
        }
      }
      if (fit.length > 1) {
        // the most specific fitting target decides: a profile the resource meets (its pinned codes, the required
        // binding of its code) > an IG profile that pins nothing against it > the core base type; "no" excludes
        const scored: Array<{ sl: SectionSlice; score: number }> = [];
        for (const sl of fit) {
          let best = 0;
          for (const t of sl.targets) {
            const tsd = await deps.fetchStructureDefinition(t).catch(() => null);
            if (!tsd || tsd.type !== r.resourceType) continue;
            const core = /^http:\/\/hl7\.org\/fhir\/StructureDefinition\/[A-Z][A-Za-z]+$/u.test(t);
            const v = await meetsProfile(r, tsd, deps);
            best = Math.max(best, v === "no" ? 0 : v === "yes" ? 3 : core ? 1 : 2);
          }
          if (best > 0) scored.push({ sl, score: best });
        }
        const top = Math.max(0, ...scored.map((x) => x.score));
        const winners = scored.filter((x) => x.score === top).map((x) => x.sl);
        if (winners.length >= 1 && winners.length < fit.length) fit = winners;
      }
      if (fit.length > 1) {
        // a required section that has no entry yet must take it; an optional one cannot outrank it
        const need = fit.filter((s) => s.min >= 1 && !(sectionFor(s)?.entry ?? []).length);
        if (need.length === 1) fit = need;
      }
      if (fit.length !== 1) {
        pending.set(
          i,
          fit.length
            ? `${r.resourceType} entry is not reachable from the Composition (bdl-7); several sections take it (${fit.map((s) => s.name).join(", ")}) — add it to the right section's entry`
            : `${r.resourceType} entry is not reachable from the Composition (bdl-7) and no section of ${csd?.url ?? "the Composition profile"} takes a ${r.resourceType} — reference it from the resource it belongs to, or leave it out`,
        );
        continue;
      }
      const s = fit[0];
      let sec = sectionFor(s);
      if (!sec) {
        sec = {};
        if (s.code) sec.code = JSON.parse(JSON.stringify(s.code));
        (comp.section as Json[]).push(sec);
        created.add(sec);
      }
      if (!Array.isArray(sec.entry)) sec.entry = [];
      sec.entry.push({ reference: ref });
      addedTo.add(sec);
      pending.delete(i);
      placed++;
      change(`${cpath}.section`, null, { section: s.name, entry: ref }, `the ${r.resourceType} entry was not reachable from the Composition (bdl-7); section slice '${s.name}' is the one section whose entry takes it`);
      // a placed entry makes what it references reachable: the next round sees it
      break;
    }
    if (!placed) break;
    round = placed ? -1 : round; // keep going while entries are placed (bounded by the entry count below)
    if (changes.length > entries.length * 4 + 20) break;
  }
  for (const [i, m] of pending) issue(`Bundle.entry[${i}]`, m);

  // codes / titles / texts of the sections
  for (const s of slices) {
    const sec = sectionFor(s);
    const si = sec ? (comp.section as Json[]).indexOf(sec) : -1;
    const spath = `${cpath}.section[${si}]`;
    if (!sec) {
      if (s.min >= 1) {
        const types = [...new Set((await Promise.all(s.targets.map(typeOf))).filter(Boolean))];
        const code = codingsOf(s.code)[0];
        issue(`${cpath}.section`, `required section '${s.name}'${code ? ` (${code.system ?? ""}|${code.code})` : ""} is missing: add the record's ${types.join(" / ") || "entries"} to it, or — when the record states there are none — write the section with an emptyReason / the IG's 'no known …' entry (not invented here)`);
      }
      continue;
    }
    // the section code's display (pattern / terminology)
    for (const c of codingsOf(sec.code)) {
      if (typeof c.display === "string" && c.display) continue;
      const pat = codingsOf(s.code).find((p) => p.code === c.code && typeof p.display === "string");
      const disp = pat?.display ?? (deps.lookupDisplay && c.system && c.code ? await deps.lookupDisplay(String(c.system), String(c.code)).catch(() => null) : null);
      if (disp) {
        c.display = disp;
        change(`${spath}.code`, null, disp, `section '${s.name}' code display`);
      }
    }
    if ((typeof sec.title !== "string" || !sec.title.trim()) && (s.titleMin >= 1 || created.has(sec))) {
      const t = codingsOf(sec.code).find((c) => typeof c.display === "string" && c.display)?.display ?? (typeof sec.code?.text === "string" ? sec.code.text : null);
      if (t) {
        sec.title = t;
        change(`${spath}.title`, null, t, `section '${s.name}' title: its code's display`);
      } else issue(`${spath}.title`, `section '${s.name}' needs a title`);
    }
    const hasText = isObj(sec.text) && typeof sec.text.div === "string" && sec.text.div.trim();
    if (!hasText && Array.isArray(sec.entry) && sec.entry.length && (s.textMin >= 1 || created.has(sec) || addedTo.has(sec))) {
      const items = (sec.entry as Json[]).map((x) => (typeof x?.reference === "string" && index.has(x.reference) ? nameOf(entries[index.get(x.reference)!].resource ?? {}) : null)).filter((x): x is string => !!x);
      if (items.length) {
        sec.text = { status: "generated", div: `<div xmlns="${XHTML_NS}"><ul>${items.map((x) => `<li>${escapeXhtml(x)}</li>`).join("")}</ul></div>` };
        change(`${spath}.text`, null, sec.text, `section '${s.name}' text: generated from its entries`);
      }
    }
  }
  if (!(comp.section as Json[]).length) delete comp.section;
  return { changes, issues };
}
