/**
 * R6 — datatype / structure shape, lossless reshapes only (rule `shape`). Every rule is decided by
 * the element definitions (core definition of the resource type + datatypes, R4):
 *
 *   array      an element with base max 1 given a one-item array → the item; a repeating element
 *              given a single value → a one-item array; an empty array → removed (FHIR forbids it).
 *              Several items for a single element → reported (which one is meant is not decidable);
 *   Coding     an element of type Coding given a CodeableConcept `{coding: [one Coding]}` (Encounter.class)
 *              → that Coding, when `text` is absent, equals the display, or fills an absent display;
 *              a Coding whose `code` holds a whole Coding / CodeableConcept (`class: {code: {system, code}}`)
 *              → that Coding, when nothing else is lost;
 *   CodeableConcept  an element of type CodeableConcept given a bare Coding `{system, code, display}`
 *              → `{coding: [it]}`;
 *   misplaced  a property the element does not define (Unrecognized property) that exactly ONE
 *              neighbour defines — a child container one level down (Dosage.doseQuantity →
 *              Dosage.doseAndRate[0].doseQuantity, entry.meta → entry.resource.meta) or the parent
 *              element (Timing.route → Dosage.route) — and where it would be well-formed (primitive
 *              lexical rule; object keys all known to the target type) and not overwrite anything → moved;
 *   resourceType  a resource without resourceType whose meta.profile names StructureDefinitions of one
 *              resource type → that type (index.ts, before the walk).
 * v14.1:
 *   empty      (rule `empty`, ele-1) an element whose value is {}, [], "" or null (no `_x` sibling
 *              carrying its extensions) → removed (repeated passes remove what becomes empty);
 *   Coding     also a Coding wrapped in one other property (`class: {type: {…}}`, `{valueCoding: {…}}`)
 *              → that Coding, under the same no-loss conditions;
 *   code       a `code` element with a required binding given as a CodeableConcept with one coding /
 *              a Coding (`reaction.severity: {coding: [{code: "moderate"}]}`) → the code, when the
 *              ValueSet holds it (under that system, if one is written) and no other text is lost
 *              (display / text absent or the code's own display);
 *   misplaced  also into the one present choice-type value that defines the property
 *              (Dosage.doseAndRate.unit → doseAndRate.doseQuantity.unit) and up out of the only
 *              item of a repeating element (doseAndRate[0].timing → Dosage.timing).
 * Anything ambiguous or lossy is left as written and reported with the correct shape and an example.
 */

import { r3Rename } from "../fhirR3Renames.js";
import { primitiveOk } from "../fhirValidator.js";
import type { RepairChange, RepairIssue } from "./types.js";
import type { Group } from "../fhirBundleFinalize.js";
import { baseMax, CORE, groupFor, isObject, PRIMITIVES, QUANTITY_TYPES, repeats, replaceKey, typeCodes, type Member, type Session, type Site } from "./walk.js";

const CODING_KEYS = new Set(["id", "extension", "system", "version", "code", "display", "userSelected"]);

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (isObject(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  return JSON.stringify(v) ?? "null";
}

function same(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function norm(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().toLowerCase() : "";
}

function isCodingShape(v: unknown): v is Record<string, any> {
  return isObject(v) && Object.keys(v).every((k) => CODING_KEYS.has(k) || k.startsWith("_")) && (typeof v.code === "string" || typeof v.system === "string");
}

/** A CodeableConcept-shaped value reduced to its one Coding without losing anything; null when lossy / ambiguous. */
function singleCoding(v: Record<string, any>): { coding: Record<string, any>; note: string } | { error: string } | null {
  if (!("coding" in v)) return null;
  if (Object.keys(v).some((k) => k !== "coding" && k !== "text")) return { error: "it carries other properties besides coding / text" };
  const list = Array.isArray(v.coding) ? v.coding : [v.coding];
  if (list.length !== 1 || !isCodingShape(list[0])) return { error: list.length > 1 ? `it has ${list.length} codings (a Coding holds one)` : "its coding is not a Coding" };
  const c = { ...list[0] };
  const text = typeof v.text === "string" ? v.text.trim() : "";
  if (text) {
    if (c.display === undefined) {
      c.display = text;
      return { coding: c, note: "its text became the display" };
    }
    if (norm(c.display) !== norm(text)) return { error: `its text '${text}' differs from the coding's display '${c.display}' (one of them would be lost)` };
  }
  return { coding: c, note: "" };
}

const EXAMPLES: Record<string, string> = {
  Coding: '{"system": "<CodeSystem URL>", "code": "<code>", "display": "<display>"}',
  CodeableConcept: '{"coding": [{"system": "<CodeSystem URL>", "code": "<code>", "display": "<display>"}], "text": "<text>"}',
};

/** Child definitions of `key` under a member set (inline children, else the datatype's definition). */
async function definesKey(session: Session, members: Member[], type: string, key: string, node: unknown): Promise<{ type: string; repeats: boolean } | null> {
  for (const m of members) {
    for (const id of m.ids) {
      const groups = m.view.sdx.childrenOfId(id);
      if (groups && groups.size) {
        const hit = groupFor(groups, key);
        if (hit) return { type: hit.type, repeats: repeats(hit.grp.base || hit.grp.slices[0]) };
      }
    }
  }
  let t = type;
  if (t === "Resource" || t === "DomainResource") t = isObject(node) && typeof node.resourceType === "string" ? node.resourceType : "";
  if (!t || PRIMITIVES.has(t) || t === "BackboneElement" || t === "Element") return null;
  const dt = await session.view(CORE + t);
  if (!dt) return null;
  const groups = dt.sdx.childrenOfId(String(dt.sdx.root.id || t));
  const hit = groups ? groupFor(groups, key) : null;
  return hit ? { type: hit.type, repeats: repeats(hit.grp.base || hit.grp.slices[0]) } : null;
}

/** Is `value` well-formed for an element of `type` (one level: primitive rule / object keys known to the type)? */
async function wellFormed(session: Session, type: string, value: unknown): Promise<boolean> {
  const items = Array.isArray(value) ? value : [value];
  if (!items.length) return false;
  for (const v of items) {
    if (PRIMITIVES.has(type)) {
      if (!primitiveOk(type, v)) return false;
      continue;
    }
    if (!isObject(v)) return false;
    if (type === "Resource" || type === "DomainResource" || type === "BackboneElement" || type === "Element" || !type) continue;
    const dt = await session.view(CORE + type);
    if (!dt) return false;
    const groups = dt.sdx.childrenOfId(String(dt.sdx.root.id || type));
    if (!groups) return false;
    for (const k of Object.keys(v)) {
      if (k.startsWith("_") || k === "resourceType") continue;
      if (!groupFor(groups, k)) return false;
    }
  }
  return true;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function escapeXhtml(t: string): string {
  return t.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

/**
 * (v17.3) A plain string written for a complex element whose datatype carries the string as one element, the only
 * lossless reading: Narrative → {status: generated, div: <div xmlns=XHTML>escaped</div>} (a string that already is a
 * <div> keeps its markup and gains the namespace); a datatype with a string / markdown `text` child (Dosage,
 * Annotation, CodeableConcept, HumanName, Address …) → {text}. null when the type has no such reading.
 */
async function stringAsComplex(session: Session, type: string, value: string): Promise<Record<string, any> | null> {
  const t = value.trim();
  if (!t || !type || PRIMITIVES.has(type)) return null;
  if (type === "Narrative") {
    const div = /^<div[\s>]/u.test(t) ? (/\bxmlns\s*=/u.test(t.slice(0, t.indexOf(">") + 1)) ? t : t.replace(/^<div/u, `<div xmlns="${XHTML_NS}"`)) : `<div xmlns="${XHTML_NS}">${escapeXhtml(t)}</div>`;
    return { status: "generated", div };
  }
  if (["Reference", "Extension", "Meta", "Resource", "DomainResource", "BackboneElement", "Element", "Quantity", "Coding"].includes(type)) return null;
  const dt = await session.view(CORE + type);
  if (!dt) return null;
  const groups = dt.sdx.childrenOfId(String(dt.sdx.root.id || type));
  const hit = groups ? groupFor(groups, "text") : null;
  return hit && (hit.type === "string" || hit.type === "markdown") ? { text: value } : null;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return isObject(v) && Object.keys(v).length === 0;
}

/** A Coding wrapped in one non-Coding property (`{type: Coding | CodeableConcept}`); null when not that shape. */
function wrappedCoding(v: Record<string, any>): { key: string; coding: Record<string, any>; note: string } | { error: string } | null {
  const own = Object.keys(v).filter((k) => !k.startsWith("_"));
  const foreign = own.filter((k) => !CODING_KEYS.has(k) && k !== "text" && k !== "coding");
  if (foreign.length !== 1 || own.some((k) => CODING_KEYS.has(k) && k !== "display")) return null;
  const key = foreign[0];
  const inner = v[key];
  if (!isObject(inner)) return null;
  let c: Record<string, any> | null = null;
  let note = "";
  if ("coding" in inner) {
    const r = singleCoding(inner);
    if (!r) return null;
    if ("error" in r) return { error: `its '${key}' is a CodeableConcept and ${r.error}` };
    c = r.coding;
    note = r.note;
  } else if (isCodingShape(inner)) c = { ...inner };
  if (!c || typeof c.code !== "string") return null;
  for (const extra of ["display", "text"]) {
    const t = typeof v[extra] === "string" ? v[extra].trim() : "";
    if (!t) continue;
    if (c.display === undefined) c.display = t;
    else if (norm(c.display) !== norm(t)) return { error: `its ${extra} '${t}' differs from the wrapped coding's display '${c.display}'` };
  }
  return { key, coding: c, note };
}

interface Move {
  where: string;
  apply(): void;
  path: string;
}

export async function repairShapes(
  session: Session,
  sites: Site[],
  rp: (p: string) => string,
  skip: (p: string) => boolean,
  skipEmpty: (p: string) => boolean = skip,
): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  const touched: string[] = [];
  const under = (p: string): boolean => touched.some((t) => p === t || p.startsWith(`${t}.`) || p.startsWith(`${t}[`));
  const siteOf = new Map<object, Site>();
  for (const s of sites) if (isObject(s.value)) siteOf.set(s.value, s);
  const arraysSeen = new Set<string>();

  // --- empty elements (ele-1): removed; an array losing items is not reshaped further in this pass.
  const emptied = new Map<unknown[], number[]>();
  for (const site of sites) {
    if (under(site.path) || skipEmpty(site.path) || !isEmptyValue(site.value) || `_${site.key}` in site.holder) continue;
    const keyPath = `${site.ownerPath}.${site.key}`;
    const raw = site.holder[site.key];
    if (site.index === null || (Array.isArray(raw) && raw.length === 1)) {
      delete site.holder[site.key];
      changes.push({ path: rp(keyPath), from: raw, to: null, rule: "empty", reason: `${keyPath.split(".").pop()} is empty (${JSON.stringify(raw)}); FHIR elements must have a value or children (ele-1): removed` });
      touched.push(keyPath);
      continue;
    }
    const list = emptied.get(raw) || [];
    list.push(site.index);
    emptied.set(raw, list);
    changes.push({ path: rp(site.path), from: site.value, to: null, rule: "empty", reason: `${keyPath.split(".").pop()}[${site.index}] is empty (${JSON.stringify(site.value)}); FHIR elements must have a value or children (ele-1): removed` });
    touched.push(keyPath);
  }
  for (const [arr, idx] of emptied) for (const i of idx.sort((a, b) => b - a)) arr.splice(i, 1);

  for (const site of sites) {
    if (under(site.path) || skip(site.path)) continue;
    const keyPath = `${site.ownerPath}.${site.key}`;
    if (site.unknown) {
      await misplaced(site);
      continue;
    }
    const core = site.defs[0];
    // --- (v17.3) a string for a complex element (dosageInstruction: "500 mg BID", text: "…", note: "…")
    if (typeof site.value === "string" && site.type && !PRIMITIVES.has(site.type)) {
      const coerced = await stringAsComplex(session, site.type, site.value);
      if (coerced) {
        const from = site.holder[site.key];
        setValue(site, coerced);
        if (site.index === null && repeats(core) && !Array.isArray(site.holder[site.key])) site.holder[site.key] = [site.holder[site.key]];
        changes.push({
          path: rp(site.index === null ? keyPath : site.path), from, to: site.holder[site.key], rule: "shape",
          reason: `${keyPath.split(".").pop()} is a ${site.type}, not a string: the text was written as its ${site.type === "Narrative" ? "generated XHTML div (status generated, XHTML namespace)" : "text"}${site.index === null && repeats(core) ? " (in an array: it repeats)" : ""}`,
        });
        touched.push(keyPath);
        continue;
      }
    }
    // --- arrays vs single values
    const raw = site.holder[site.key];
    if (Array.isArray(raw) && !arraysSeen.has(keyPath)) {
      arraysSeen.add(keyPath);
      if (baseMax(core) === "1") {
        if (raw.length === 1) {
          site.holder[site.key] = raw[0];
          changes.push({ path: rp(keyPath), from: raw, to: raw[0], rule: "shape", reason: `${keyPath.split(".").pop()} holds a single value (max 1): the one-item array was unwrapped` });
          touched.push(keyPath);
          continue;
        }
        if (raw.length > 1) {
          issues.push({ path: rp(keyPath), rule: "shape", severity: "error", message: `${keyPath} holds a single ${site.type || "value"} (max 1) but ${raw.length} were given; keep the one that is meant (not decidable here)` });
          touched.push(keyPath);
          continue;
        }
      }
    } else if (!Array.isArray(raw) && repeats(core) && raw !== null && raw !== undefined && site.index === null) {
      site.holder[site.key] = [raw];
      changes.push({ path: rp(keyPath), from: raw, to: [raw], rule: "shape", reason: `${keyPath.split(".").pop()} repeats (max ${baseMax(core)}): the single value was wrapped into an array` });
      touched.push(keyPath);
      continue;
    }
    const v = site.value;
    if (!isObject(v)) continue;
    // --- a code element given as a CodeableConcept / Coding
    if (site.type === "code" && !QUANTITY_TYPES.has(site.ownerType) && site.ownerType !== "Coding") {
      // (Quantity.code / Coding.code objects are the unit and Coding rules' business.)
      await codeFromCoding(site, v);
      continue;
    }
    // --- Coding given as a CodeableConcept / Coding nested in .code
    if (site.type === "Coding" && !("coding" in v) && !isCodingShape(v)) {
      const w = wrappedCoding(v);
      if (w && "coding" in w) {
        setValue(site, w.coding);
        changes.push({ path: rp(site.path), from: v, to: w.coding, rule: "shape", reason: `${site.path} is a Coding: the Coding written inside its '${w.key}' is the Coding itself${w.note ? ` (${w.note})` : ""}` });
        touched.push(site.path);
        continue;
      }
      if (w && "error" in w) {
        issues.push({ path: rp(site.path), rule: "shape", severity: "error", message: `${site.path} is a Coding (one code), but a wrapped value was given and ${w.error}; write it as ${EXAMPLES.Coding}` });
        continue;
      }
    }
    if (site.type === "Coding") {
      if ("coding" in v) {
        const r = singleCoding(v);
        if (r && "coding" in r) {
          setValue(site, r.coding);
          changes.push({ path: rp(site.path), from: v, to: r.coding, rule: "shape", reason: `${site.path} is a Coding, not a CodeableConcept: the one coding was unwrapped${r.note ? ` (${r.note})` : ""}` });
          touched.push(site.path);
        } else if (r && "error" in r) {
          issues.push({ path: rp(site.path), rule: "shape", severity: "error", message: `${site.path} is a Coding (one code), but a CodeableConcept was given and ${r.error}; write it as ${EXAMPLES.Coding}` });
        }
        continue;
      }
      if (isObject(v.code) && Object.keys(v).every((k) => k === "code" || k === "display")) {
        const inner = v.code;
        let c: Record<string, any> | null = null;
        let note = "";
        if ("coding" in inner) {
          const r = singleCoding(inner);
          if (r && "coding" in r) {
            c = r.coding;
            note = r.note;
          }
        } else if (isCodingShape(inner)) c = { ...inner };
        if (c && typeof v.display === "string") {
          if (c.display === undefined) c.display = v.display;
          else if (norm(c.display) !== norm(v.display)) c = null;
        }
        if (c && typeof c.code === "string") {
          setValue(site, c);
          changes.push({ path: rp(site.path), from: v, to: c, rule: "shape", reason: `${site.path}.code must be a code string; the Coding written inside it is the Coding itself${note ? ` (${note})` : ""}` });
          touched.push(site.path);
        } else {
          issues.push({ path: rp(`${site.path}.code`), rule: "shape", severity: "error", message: `${site.path}.code must be a code string, not an object; write ${site.path} as ${EXAMPLES.Coding}` });
        }
        continue;
      }
    }
    // --- CodeableConcept given as a bare Coding
    if (site.type === "CodeableConcept" && !("coding" in v) && !("text" in v) && isCodingShape(v) && typeof v.code === "string") {
      const cc = { coding: [{ ...v }] };
      setValue(site, cc);
      changes.push({ path: rp(site.path), from: v, to: cc, rule: "shape", reason: `${site.path} is a CodeableConcept: the Coding was wrapped as its coding[0]` });
      touched.push(site.path);
      continue;
    }
  }
  return { changes, issues };

  /** A required-bound code element written as a CodeableConcept / Coding → its code (when lossless and in the ValueSet). */
  async function codeFromCoding(site: Site, v: Record<string, any>): Promise<void> {
    let coding: Record<string, any> | null = null;
    let text = "";
    if ("coding" in v) {
      const r = singleCoding(v);
      if (!r || "error" in r) {
        issues.push({ path: rp(site.path), rule: "shape", severity: "error", message: `${site.path} is a code (a plain string such as "moderate"), not a CodeableConcept${r && "error" in r ? `, and ${r.error}` : ""}; write the code itself` });
        return;
      }
      coding = r.coding;
      text = typeof v.text === "string" ? v.text.trim() : "";
    } else if (isCodingShape(v)) coding = v;
    if (!coding || typeof coding.code !== "string" || !coding.code.trim()) {
      issues.push({ path: rp(site.path), rule: "shape", severity: "error", message: `${site.path} is a code (a plain string), not an object; write the code itself` });
      return;
    }
    const code = coding.code.trim();
    const vsUrls = [...new Set(site.defs.map((d) => (isObject(d.binding) && d.binding.strength === "required" && typeof d.binding.valueSet === "string" ? d.binding.valueSet : null)).filter((x): x is string => !!x))];
    const bad = (why: string): void => {
      issues.push({ path: rp(site.path), rule: "shape", severity: "error", message: `${site.path} is a code (a plain string), not a ${"coding" in v ? "CodeableConcept" : "Coding"}; '${code}' was not written as the code because ${why} — write "${code}" if that is the code meant` });
    };
    if (vsUrls.length !== 1) return bad(vsUrls.length ? "several required ValueSets apply" : "no required ValueSet confirms it");
    const vs = vsUrls[0];
    const sys = typeof coding.system === "string" && coding.system.trim() ? coding.system.trim() : null;
    let display: string | null = null;
    let member: boolean | undefined;
    const exp = session.deps.expandValueSet ? await session.memo(`exp\0${vs}`, () => session.deps.expandValueSet!(vs, 500), null) : null;
    if (exp && exp.codings.length) {
      // v19 R1 round 2: the code element carries no system — one written as the THO / core twin of the ValueSet's
      // CodeSystem (…/CodeSystem/allergy-intolerance-category for http://hl7.org/fhir/allergy-intolerance-category) names it
      const twin = (a: string, b: string): boolean => /^http:\/\/(?:terminology\.)?hl7\.org\//u.test(a) && /^http:\/\/(?:terminology\.)?hl7\.org\//u.test(b) && a.split("/").pop() === b.split("/").pop();
      const hits = exp.codings.filter((c) => c.code === code && (!sys || !c.system || c.system === sys || twin(c.system, sys)));
      if (hits.length) {
        member = true;
        display = hits[0].display ?? null;
      } else if (!exp.truncated && !exp.incomplete) member = false;
    }
    if (member === undefined && session.deps.valueSetContains) {
      try {
        member = await session.deps.valueSetContains(vs, sys, code);
      } catch {
        member = undefined;
      }
    }
    if (member !== true) return bad(member === false ? `it is not in the required ValueSet ${vs.split("|")[0]}${sys ? ` under ${sys}` : ""}` : `its membership in ${vs.split("|")[0]} cannot be decided here`);
    for (const t of [typeof coding.display === "string" ? coding.display.trim() : "", text]) {
      if (t && norm(t) !== norm(code) && (!display || norm(t) !== norm(display))) return bad(`its text '${t}' would be lost (it is not the code's display${display ? ` '${display}'` : ""})`);
    }
    setValue(site, code);
    changes.push({ path: rp(site.path), from: v, to: code, rule: "shape", reason: `${site.path} is a code, not a ${"coding" in v ? "CodeableConcept" : "Coding"}: '${code}' is a code of the required ValueSet ${vs.split("|")[0]} (nothing else is lost)` });
    touched.push(site.path);
  }

  function setValue(site: Site, value: unknown): void {
    if (site.index === null) site.holder[site.key] = value;
    else (site.holder[site.key] as unknown[])[site.index] = value;
  }

  /** The value as it would be written at a target of `type`: as is when well-formed, a string as its complex reading (v17.3); undefined otherwise. */
  async function movable(type: string, value: unknown): Promise<unknown> {
    if (await wellFormed(session, type, value)) return value;
    const items = Array.isArray(value) ? value : [value];
    if (!items.length || !items.every((x) => typeof x === "string")) return undefined;
    const out: unknown[] = [];
    for (const x of items) {
      const c = await stringAsComplex(session, type, x as string);
      if (!c) return undefined;
      out.push(c);
    }
    return Array.isArray(value) ? out : out[0];
  }

  async function misplaced(site: Site): Promise<void> {
    if (site.index !== null && site.index > 0) return; // the whole property moves once (at its first item)
    const node = site.holder;
    const key = site.key;
    const value = node[key];
    // v17.1 R4: an STU3 element R4 renamed (fhirR3Renames.ts) → renamed in place; one R4 removed → reported, kept
    // v19 R1: the owner's path from its resource root (a nested backbone too: Immunization.protocolApplied)
    const rtype = String((isObject(site.resource) && site.resource.resourceType) || node.resourceType || site.ownerType);
    const owner = (site.ownerPath.startsWith(site.resourcePath) ? rtype + site.ownerPath.slice(site.resourcePath.length) : site.ownerPath.replace(/^Bundle\.entry\[\d+\]\.resource/u, rtype)).replace(/\[\d+\]/gu, "");
    const r3 = r3Rename(owner.includes(".") ? owner : rtype, key);
    if (r3?.removed) {
      issues.push({ path: rp(`${site.ownerPath}.${key}`), rule: "shape", severity: "error", message: `'${key}' is STU3 and does not exist in R4: ${r3.removed} (not removed here)` });
      return;
    }
    if (r3?.to && !(r3.to in node)) {
      const target = await definesKey(session, site.ownerMembers, site.ownerType, r3.to, node);
      if (target) {
        const conv = (x: unknown): unknown => {
          if (r3.annotation && typeof x === "string") return { text: x };
          if (r3.inner && isObject(x)) {
            const o: Record<string, any> = {};
            for (const [k, v] of Object.entries(x)) o[r3.inner[k] ?? k] = v; // children R4 removed stay (reported by the validator)
            return o;
          }
          return x;
        };
        let v = Array.isArray(value) ? value.map(conv) : conv(value);
        // v19 R1: a primitive written in another JSON form of the same lexical value ("1" for a positiveInt)
        if (PRIMITIVES.has(target.type) && !Array.isArray(v)) {
          const fit = fitPrimitive(target.type, v);
          if (fit !== undefined) v = fit;
        }
        node[r3.to] = target.repeats && !Array.isArray(v) ? [v] : !target.repeats && Array.isArray(v) && v.length === 1 ? v[0] : v;
        delete node[key];
        changes.push({ path: rp(`${site.ownerPath}.${r3.to}`), from: { path: rp(`${site.ownerPath}.${key}`), value }, to: node[r3.to], rule: "shape", reason: `'${key}' is the STU3 name of R4 '${r3.to}' (FHIR R4 version change): renamed` });
        touched.push(site.ownerPath);
        return;
      }
    }
    // v19 R1: a name one legal element away (choice-type suffix, bare choice stem, singular / plural, STU3 base + suffix)
    if (!(`_${key}` in node)) {
      const near = await nearNames(session, site, node, key, value, owner.includes(".") ? owner : rtype);
      if (near.length === 1 && near[0].duplicate) {
        const n = near[0];
        delete node[key];
        changes.push({ path: rp(`${site.ownerPath}.${n.name}`), from: { path: rp(`${site.ownerPath}.${key}`), value }, to: node[n.name], rule: "shape", reason: `'${key}' is not an element here; ${n.why}: the duplicate is removed` });
        touched.push(site.ownerPath);
        return;
      }
      if (near.length === 1) {
        const n = near[0];
        replaceKey(node, key, n.name, n.value);
        changes.push({ path: rp(`${site.ownerPath}.${n.name}`), from: { path: rp(`${site.ownerPath}.${key}`), value }, to: n.value, rule: "shape", reason: `'${key}' is not an element here; ${n.why}: renamed to '${n.name}'` });
        touched.push(site.ownerPath);
        return;
      }
      if (near.length > 1) {
        issues.push({ path: rp(`${site.ownerPath}.${key}`), rule: "shape", severity: "error", message: `'${key}' is not an element here; it could be ${near.map((n) => `'${n.name}'`).join(" or ")} — not renamed (ambiguous)`, candidates: near.map((n) => ({ name: n.name, value: n.value, reason: n.why })) });
        return;
      }
    }
    const moves: Move[] = [];
    // Down: a child container of the owner that defines `key`.
    for (const m of site.ownerMembers) {
      for (const id of m.ids) {
        const groups = m.view.sdx.childrenOfId(id);
        if (!groups) continue;
        for (const grp of groups.values()) {
          const def = grp.base || grp.slices[0];
          if (!def || grp.name.endsWith("[x]")) continue;
          const types = (def.type || []).map((t: any) => String(t.code || ""));
          const t = types[0] || (def.contentReference ? "BackboneElement" : "");
          // v19 R1 round 2: a Reference child takes only a `reference` string (performer.reference → performer.actor.reference)
          if (!t || PRIMITIVES.has(t) || (t === "Reference" && key !== "reference") || t === "Extension" || t === "Narrative" || t === "Meta" || types.length > 1) continue;
          const name = grp.name;
          if (name === key) continue;
          const cur = node[name];
          const container = Array.isArray(cur) ? (cur.length === 1 && isObject(cur[0]) ? cur[0] : undefined) : cur;
          if (cur !== undefined && !isObject(container)) continue;
          const childMembers: Member[] = [{ view: m.view, ids: [String(def.id || def.path)] }];
          if (def.contentReference) childMembers[0].ids = [String(def.contentReference).replace(/^.*#/, "")];
          const target = await definesKey(session, childMembers, t, key, container);
          if (!target) continue;
          if (isObject(container) && key in container) {
            if (same(container[key], value)) moves.push({ where: `${name}.${key} (already there)`, path: `${site.ownerPath}.${name}`, apply: () => void delete node[key] });
            continue;
          }
          const v1 = await movable(target.type, value);
          if (v1 === undefined) continue;
          if (moves.some((x) => x.where.startsWith(`${name}.`))) continue;
          const rep = repeats(def);
          moves.push({
            where: `${name}${rep ? "[0]" : ""}.${key}`,
            path: `${site.ownerPath}.${name}${rep ? "[0]" : ""}.${key}`,
            apply: () => {
              const w = target.repeats && !Array.isArray(v1) ? [v1] : v1;
              if (isObject(container)) container[key] = w;
              else node[name] = rep ? [{ [key]: w }] : { [key]: w };
              delete node[key];
            },
          });
        }
      }
    }
    // Down into a choice-type value present on the owner (doseAndRate.unit → doseAndRate.doseQuantity.unit).
    for (const m of site.ownerMembers) {
      for (const id of m.ids) {
        const groups = m.view.sdx.childrenOfId(id);
        if (!groups) continue;
        for (const grp of groups.values()) {
          if (!grp.name.endsWith("[x]")) continue;
          const present = Object.keys(node).map((k) => ({ k, hit: groupFor(groups, k) })).filter((x) => x.hit && x.hit.grp === grp && x.k !== key);
          if (present.length !== 1) continue;
          const { k: name, hit } = present[0];
          const t = hit!.type;
          const container = node[name];
          if (!t || PRIMITIVES.has(t) || !isObject(container)) continue;
          const target = await definesKey(session, [], t, key, container);
          if (!target || moves.some((x) => x.path === `${site.ownerPath}.${name}.${key}`)) continue;
          if (key in container) {
            if (same(container[key], value)) moves.push({ where: `${name}.${key} (already there)`, path: `${site.ownerPath}.${name}`, apply: () => void delete node[key] });
            continue;
          }
          const v2 = await movable(target.type, value);
          if (v2 === undefined) continue;
          moves.push({
            where: `${name}.${key}`,
            path: `${site.ownerPath}.${name}.${key}`,
            apply: () => {
              container[key] = target.repeats && !Array.isArray(v2) ? [v2] : v2;
              delete node[key];
            },
          });
        }
      }
    }
    // Up: the owner's parent defines `key` and lacks it (the owner a single value or the only item of its array).
    const ownerSite = siteOf.get(node);
    const ownerArr = ownerSite ? ownerSite.holder[ownerSite.key] : undefined;
    const ownerSingle = !!ownerSite && (ownerSite.index === null || (Array.isArray(ownerArr) && ownerArr.length === 1));
    if (ownerSite && isObject(ownerSite.holder) && ownerSingle) {
      const parent = ownerSite.holder;
      const target = await definesKey(session, ownerSite.ownerMembers, ownerSite.ownerType, key, parent);
      if (target && key in parent) {
        if (same(parent[key], value)) moves.push({ where: `${ownerSite.ownerPath}.${key} (already there)`, path: `${ownerSite.ownerPath}.${key}`, apply: () => void delete node[key] });
      } else if (target) {
        const v3 = await movable(target.type, value);
        if (v3 !== undefined)
          moves.push({
            where: `${ownerSite.ownerPath}.${key}`,
            path: `${ownerSite.ownerPath}.${key}`,
            apply: () => {
              parent[key] = target.repeats && !Array.isArray(v3) ? [v3] : v3;
              delete node[key];
            },
          });
      }
    }
    const from = `${site.ownerPath}.${key}`;
    if (moves.length === 1) {
      const mv = moves[0];
      mv.apply();
      changes.push({ path: rp(mv.path), from: { path: rp(from), value }, to: value, rule: "shape", reason: `'${key}' is not a property of ${site.ownerPath.split(".").pop()} (${site.ownerType || "element"}); ${mv.where} is the one place nearby that defines it` });
      touched.push(site.ownerPath);
      return;
    }
    if (moves.length > 1) {
      issues.push({ path: rp(from), rule: "shape", severity: "error", message: `'${key}' is not a property here; it could belong to ${moves.map((m) => m.where).join(" or ")} — not moved (ambiguous)` });
    }
  }
}

const INTEGER_TYPES = new Set(["integer", "positiveInt", "unsignedInt"]);

/**
 * v19 R1: a primitive value written in another JSON form of the same lexical value, as the element's type wants it
 * ("1" → 1 for a positiveInt, "true" → true for a boolean); the value itself when already well-formed; undefined when
 * there is no lossless reading.
 */
export function fitPrimitive(type: string, v: unknown): unknown {
  if (primitiveOk(type, v)) return v;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (INTEGER_TYPES.has(type) && /^[+-]?\d{1,15}$/u.test(t) && String(Number(t)) === t.replace(/^\+/u, "")) {
    const n = Number(t);
    return primitiveOk(type, n) ? n : undefined;
  }
  if (type === "boolean" && (t === "true" || t === "false")) return t === "true";
  return undefined;
}

const jsonSuffix = (t: string): string => (t === "SimpleQuantity" || t === "MoneyQuantity" ? "Quantity" : t[0].toUpperCase() + t.slice(1));

/** Child groups of the object holding a site (inline children of every member, else its datatype's / resource's root). */
async function ownerGroups(session: Session, site: Site, node: Record<string, any>): Promise<Map<string, Group>[]> {
  const out: Map<string, Group>[] = [];
  for (const m of site.ownerMembers) {
    for (const id of m.ids) {
      const g = m.view.sdx.childrenOfId(id);
      if (g && g.size) out.push(g);
    }
  }
  if (out.length) return out;
  let t = site.ownerType;
  if (t === "Resource" || t === "DomainResource") t = typeof node.resourceType === "string" ? node.resourceType : "";
  if (!t || PRIMITIVES.has(t) || t === "BackboneElement" || t === "Element") return out;
  const dt = await session.view(CORE + t);
  const g = dt ? dt.sdx.childrenOfId(String(dt.sdx.root.id || t)) : null;
  if (g && g.size) out.push(g);
  return out;
}

/**
 * v19 R1: legal element names an unknown property `key` is one step away from, with the value as that element takes
 * it — only lossless readings, never a value change:
 *   choice suffix   `<stem><Suffix>` where `<stem>[x]` exists but Suffix is not an allowed type: the ONE allowed type
 *                   whose JSON suffix Suffix starts with / is a prefix of (doseNumberPositiveInteger → doseNumberPositiveInt,
 *                   effectiveDate → effectiveDateTime), the value fitting it;
 *   bare stem       `<stem>` of a choice element (`item` for item[x]): the ONE allowed type the value's JSON shape fits
 *                   (primitive lexical rule / object keys all known to the type);
 *   STU3 base       `<STU3 name><Suffix>` whose STU3 name R4 renamed to a choice element (fhirR3Renames.ts), then as above;
 *   singular/plural `<name>s` / `<name>` minus a trailing s naming a defined element (periodUnits → periodUnit).
 * Allowed types are those every view (core + profiles) permits. Targets already present are never overwritten.
 */
export async function nearNames(session: Session, site: Site, node: Record<string, any>, key: string, value: unknown, owner: string): Promise<Array<{ name: string; value: unknown; why: string; duplicate?: boolean }>> {
  const groupsList = await ownerGroups(session, site, node);
  if (!groupsList.length) return [];
  const out = new Map<string, { name: string; value: unknown; why: string; duplicate?: boolean }>();
  const fits = async (type: string, v: unknown, coerce: boolean): Promise<{ v: unknown } | null> => {
    if (Array.isArray(v)) return null;
    if (PRIMITIVES.has(type)) {
      const f = coerce ? fitPrimitive(type, v) : primitiveOk(type, v) ? v : undefined;
      return f === undefined ? null : { v: f };
    }
    return isObject(v) && Object.keys(v).length && (await wellFormed(session, type, v)) ? { v } : null;
  };
  const choiceStems = new Map<string, string[]>(); // stem → types every view allows
  for (const groups of groupsList) {
    for (const grp of groups.values()) {
      if (!grp.name.endsWith("[x]")) continue;
      const stem = grp.name.slice(0, -3);
      const types = typeCodes(grp.base || grp.slices[0]);
      const prev = choiceStems.get(stem);
      choiceStems.set(stem, prev ? prev.filter((t) => types.includes(t)) : types);
    }
  }
  const defined = (name: string): boolean => groupsList.some((g) => !!groupFor(g, name));
  const bySuffix = async (stem: string, suffix: string, why: string): Promise<void> => {
    const types = choiceStems.get(stem) ?? [];
    const s = suffix.toLowerCase();
    const hits = types.filter((t) => {
      const j = jsonSuffix(t).toLowerCase();
      return s.startsWith(j) || j.startsWith(s);
    });
    const uniq = [...new Set(hits.map(jsonSuffix))];
    if (uniq.length !== 1) return;
    const t = hits[0];
    const name = stem + jsonSuffix(t);
    if (name === key) return;
    const f = await fits(t, value, true);
    if (!f) return;
    // v19 R1 round 2: the one legal element already holds exactly this value (doseNumberPositiveInteger and the STU3
    // doseSequencePositiveInteger both written as 1) → the misplaced copy is a duplicate
    if (name in node) {
      if (same(node[name], f.v)) out.set(name, { name, value: f.v, why: `${stem}[x] allows ${types.join(" | ")}; '${suffix}' can only be ${t}${why}, and ${name} already holds the same value`, duplicate: true });
      return;
    }
    out.set(name, { name, value: f.v, why: `${stem}[x] allows ${types.join(" | ")}; '${suffix}' can only be ${t}${why}` });
  };
  for (const [stem, types] of choiceStems) {
    if (key === stem) {
      const ok: Array<{ t: string; v: unknown }> = [];
      for (const t of types) {
        const f = await fits(t, value, false);
        if (f) ok.push({ t, v: f.v });
      }
      const names = [...new Set(ok.map((x) => stem + jsonSuffix(x.t)))];
      if (names.length === 1 && !(names[0] in node)) out.set(names[0], { name: names[0], value: ok[0].v, why: `${stem}[x] needs its type in the name; of ${types.join(" | ")} only ${ok[0].t} fits the value` });
    } else if (key.startsWith(stem) && key.length > stem.length && /[A-Z]/u.test(key[stem.length]) && !defined(key)) {
      await bySuffix(stem, key.slice(stem.length), "");
    }
  }
  for (let i = 1; i < key.length; i++) {
    if (!/[A-Z]/u.test(key[i])) continue;
    const r3 = r3Rename(owner, key.slice(0, i));
    const to = r3?.to;
    if (!to) continue;
    const stem = [...choiceStems.keys()].find((st) => to === st || (to.startsWith(st) && /[A-Z]/u.test(to[st.length] ?? "")));
    if (stem) await bySuffix(stem, key.slice(i), ` ('${key.slice(0, i)}' is the STU3 name of R4 ${stem}[x])`);
  }
  for (const name of [`${key}s`, key.endsWith("s") ? key.slice(0, -1) : ""]) {
    if (!name || name in node || choiceStems.has(name)) continue;
    for (const groups of groupsList) {
      const grp = groups.get(name);
      if (!grp || grp.name.endsWith("[x]")) continue;
      const def = grp.base || grp.slices[0];
      const t = typeCodes(def)[0] || "";
      const many = repeats(def);
      const items = Array.isArray(value) ? value : [value];
      if (!many && items.length !== 1) break;
      const conv: unknown[] = [];
      for (const it of items) {
        const f = t ? await fits(t, it, true) : null;
        if (!f) break;
        conv.push(f.v);
      }
      if (conv.length !== items.length) break;
      out.set(name, { name, value: many ? conv : conv[0], why: `'${name}' is the defined element (${key.endsWith("s") ? "singular" : "plural"} of '${key}')` });
      break;
    }
  }
  return [...out.values()];
}

/** A resource without resourceType: the one type its meta.profile StructureDefinitions constrain. */
export async function inferResourceType(session: Session, res: Record<string, any>): Promise<{ type: string; reason: string } | null> {
  if (typeof res.resourceType === "string" && res.resourceType) return null;
  // meta.profile written as one string (v16 R4) names the profile too; the shape rule makes it an array.
  const raw = isObject(res.meta) ? res.meta.profile : undefined;
  const profiles: string[] = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter((p: unknown): p is string => typeof p === "string");
  const types = new Set<string>();
  for (const p of profiles.slice(0, 3)) {
    const v = (await session.view(p)) ?? (p.includes("|") ? await session.view(p.split("|")[0]) : null);
    if (v && v.sdx.kind === "resource" && v.sdx.type) types.add(v.sdx.type);
  }
  if (types.size !== 1) return null;
  const [type] = [...types];
  return { type, reason: `meta.profile ${profiles[0]} is a profile of ${type}` };
}

export { replaceKey };
