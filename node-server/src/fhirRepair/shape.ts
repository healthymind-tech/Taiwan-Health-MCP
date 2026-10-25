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
 * Anything ambiguous or lossy is left as written and reported with the correct shape and an example.
 */

import { primitiveOk } from "../fhirValidator.js";
import type { RepairChange, RepairIssue } from "./types.js";
import { baseMax, CORE, groupFor, isObject, PRIMITIVES, repeats, replaceKey, type Member, type Session, type Site } from "./walk.js";

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

interface Move {
  where: string;
  apply(): void;
  path: string;
}

export async function repairShapes(session: Session, sites: Site[], rp: (p: string) => string, skip: (p: string) => boolean): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  const touched: string[] = [];
  const under = (p: string): boolean => touched.some((t) => p === t || p.startsWith(`${t}.`) || p.startsWith(`${t}[`));
  const siteOf = new Map<object, Site>();
  for (const s of sites) if (isObject(s.value)) siteOf.set(s.value, s);
  const arraysSeen = new Set<string>();

  for (const site of sites) {
    if (under(site.path) || skip(site.path)) continue;
    const keyPath = `${site.ownerPath}.${site.key}`;
    if (site.unknown) {
      await misplaced(site);
      continue;
    }
    const core = site.defs[0];
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
    // --- Coding given as a CodeableConcept / Coding nested in .code
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

  function setValue(site: Site, value: unknown): void {
    if (site.index === null) site.holder[site.key] = value;
    else (site.holder[site.key] as unknown[])[site.index] = value;
  }

  async function misplaced(site: Site): Promise<void> {
    if (site.index !== null && site.index > 0) return; // the whole property moves once (at its first item)
    const node = site.holder;
    const key = site.key;
    const value = node[key];
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
          if (!t || PRIMITIVES.has(t) || t === "Reference" || t === "Extension" || t === "Narrative" || t === "Meta" || types.length > 1) continue;
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
          if (!(await wellFormed(session, target.type, value))) continue;
          if (moves.some((x) => x.where.startsWith(`${name}.`))) continue;
          const rep = repeats(def);
          moves.push({
            where: `${name}${rep ? "[0]" : ""}.${key}`,
            path: `${site.ownerPath}.${name}${rep ? "[0]" : ""}.${key}`,
            apply: () => {
              if (isObject(container)) container[key] = value;
              else node[name] = rep ? [{ [key]: value }] : { [key]: value };
              delete node[key];
            },
          });
        }
      }
    }
    // Up: the owner's parent defines `key` and lacks it.
    const ownerSite = siteOf.get(node);
    if (ownerSite && isObject(ownerSite.holder) && ownerSite.index === null && !(key in ownerSite.holder)) {
      const target = await definesKey(session, ownerSite.ownerMembers, ownerSite.ownerType, key, ownerSite.holder);
      if (target && (await wellFormed(session, target.type, value))) {
        const parent = ownerSite.holder;
        moves.push({
          where: `${ownerSite.ownerPath}.${key}`,
          path: `${ownerSite.ownerPath}.${key}`,
          apply: () => {
            parent[key] = value;
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

/** A resource without resourceType: the one type its meta.profile StructureDefinitions constrain. */
export async function inferResourceType(session: Session, res: Record<string, any>): Promise<{ type: string; reason: string } | null> {
  if (typeof res.resourceType === "string" && res.resourceType) return null;
  const profiles = isObject(res.meta) && Array.isArray(res.meta.profile) ? res.meta.profile.filter((p: unknown) => typeof p === "string") : [];
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
