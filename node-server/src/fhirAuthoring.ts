/**
 * Schema-guided fill helpers — pure, DB-free mechanical pinning. Port of
 * `src/fhir_authoring.py`, extended with slice-aware pinning. Sets `fixed[x]` /
 * `pattern[x]` values, `meta.profile`, narrative, and slice-mandated values over a
 * draft resource:
 *   - pinFixedPattern: fixed / pattern values of unsliced elements;
 *   - pinSlices: items tagged `_slice: <name>` (any depth) get the slice's pinned fragment;
 *   - pinSliceMembers: items that the slicing discriminators already identify as members
 *     of a slice (e.g. a component whose code is the systolic LOINC) get the slice's
 *     fixed / pattern values (unit system / code, identifier system, ...). Membership is
 *     decided from the discriminators only — an undecidable slice is never pinned on a guess.
 * Nothing here invents content: values are only written where the draft has the parent node.
 */

import { choiceProperty, fixedPattern, isSliceMember, projectElement } from "./fhirSnapshot.js";
import { patternMatches, projectForRequired, valuesAt, type ProjectedElement } from "./fhirRequiredElements.js";

type SD = Record<string, any>;
type El = Record<string, any>;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Ensure `canonical` is present in `resource.meta.profile`. Returns true when added. */
export function ensureMetaProfile(resource: Record<string, any>, canonical: string): boolean {
  if (!canonical) return false;
  if (!resource.meta) resource.meta = {};
  const meta = resource.meta;
  if (!meta.profile) meta.profile = [];
  const profiles = meta.profile;
  if (profiles.includes(canonical)) return false;
  profiles.push(canonical);
  return true;
}

function maxIsArray(maxCard: any): boolean {
  return maxCard === "*" || (/^\d+$/.test(String(maxCard)) && parseInt(String(maxCard), 10) > 1);
}

/** Wrap bare values into single-element arrays where the base def repeats. */
export function coerceArrayCardinality(sd: SD, resource: Record<string, any>): any[] {
  const root = sd.type || resource.resourceType || "";
  const arrayPaths = new Set<string>();
  for (const el of (sd.snapshot || {}).element || []) {
    if (isSliceMember(el)) continue;
    const path = el.path || "";
    if (path === root || !path.startsWith(root + ".")) continue;
    const maxCard = (el.base || {}).max !== undefined ? (el.base || {}).max : el.max;
    if (maxIsArray(maxCard)) arrayPaths.add(path.slice(root.length + 1));
  }
  const trace: any[] = [];
  coerceWalk(resource, "", root, arrayPaths, trace);
  return trace;
}

function coerceWalk(node: any, relPath: string, root: string, arrayPaths: Set<string>, trace: any[]): void {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const key of Object.keys(node)) {
      if (key.startsWith("_")) continue;
      const child = relPath ? `${relPath}.${key}` : key;
      const value = node[key];
      if (value !== null && value !== undefined && !Array.isArray(value) && arrayPaths.has(child)) {
        node[key] = [value];
        trace.push({ path: `${root}.${child}`, action: "wrapped-in-array" });
      }
      coerceWalk(node[key], child, root, arrayPaths, trace);
    }
  } else if (Array.isArray(node)) {
    for (const item of node) coerceWalk(item, relPath, root, arrayPaths, trace);
  }
}

// --- Narrative ------------------------------------------------------------- //

const NARRATIVE_SKIP = new Set([
  "resourceType", "id", "meta", "implicitRules", "language", "text",
  "contained", "extension", "modifierExtension",
]);
const NON_DOMAIN_RESOURCES = new Set(["Bundle", "Parameters", "Binary"]);

function humanize(value: any): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const text = value.text;
    if (typeof text === "string" && text.trim()) return text;
    const codings = value.coding;
    if (Array.isArray(codings) && codings.length) {
      const parts = codings
        .filter((c: any) => c && typeof c === "object")
        .map((c: any) => c.display || c.code);
      const joined = parts.filter((p: any) => p).join(", ");
      if (joined) return joined;
    }
    if ("display" in value || "code" in value) return value.display || value.code;
    if ("reference" in value) return value.display || value.reference;
    if ("value" in value && !(value.value && typeof value.value === "object")) {
      const unit = value.unit || value.code || "";
      return `${value.value} ${unit}`.trim();
    }
    if ("start" in value || "end" in value) {
      return `${value.start ?? ""} – ${value.end ?? ""}`.replace(/^[\s–]+|[\s–]+$/g, "");
    }
    return null;
  }
  if (Array.isArray(value)) {
    const rendered = value.map((v) => humanize(v)).filter((r) => r);
    return rendered.length ? rendered.join("; ") : null;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

export function buildNarrativeDiv(resource: Record<string, any>): string {
  const rtype = resource.resourceType || "Resource";
  const rows: string[] = [];
  for (const [key, value] of Object.entries(resource)) {
    if (NARRATIVE_SKIP.has(key)) continue;
    const rendered = humanize(value);
    if (!rendered) continue;
    rows.push(`<p><b>${escapeHtml(key)}</b>: ${escapeHtml(rendered)}</p>`);
  }
  const body = rows.join("") || "<p>(no narrative content)</p>";
  return `<div xmlns="http://www.w3.org/1999/xhtml"><p><b>${escapeHtml(rtype)}</b></p>${body}</div>`;
}

/** Generate `text` narrative when DomainResource lacks a real div. */
export function ensureNarrative(resource: Record<string, any>): boolean {
  if (NON_DOMAIN_RESOURCES.has(resource.resourceType)) return false;
  const text = resource.text;
  if (text && typeof text === "object" && !Array.isArray(text)) {
    const div = text.div;
    if (typeof div === "string" && div.trim() && div.includes("<")) return false;
  }
  resource.text = { status: "generated", div: buildNarrativeDiv(resource) };
  return true;
}

// --- fixed/pattern pinning ------------------------------------------------- //

export function setAtPath(
  resource: Record<string, any>,
  relPath: string,
  value: any,
  overwrite = false,
): string {
  if (!relPath) return "skipped-missing";
  const segments = relPath.split(".");
  let node: any = resource;
  for (const seg of segments.slice(0, -1)) {
    const nxt = node[seg];
    if (Array.isArray(nxt)) return "skipped-array";
    if (nxt === null || nxt === undefined) return "skipped-missing";
    if (typeof nxt !== "object") return "skipped-missing";
    node = nxt;
  }
  const leaf = segments[segments.length - 1];
  if (Array.isArray(node[leaf])) return "skipped-array";
  if (leaf in node && node[leaf] !== null && node[leaf] !== undefined && !overwrite) return "exists";
  node[leaf] = value;
  return "set";
}

function mergePattern(node: Record<string, any>, leaf: string, pattern: any): string {
  const current = node[leaf];
  if (Array.isArray(current)) return "skipped-array";
  if (current === null || current === undefined) {
    node[leaf] = pattern && typeof pattern === "object" && !Array.isArray(pattern) ? { ...pattern } : pattern;
    return "set";
  }
  if (current && typeof current === "object" && !Array.isArray(current) && pattern && typeof pattern === "object" && !Array.isArray(pattern)) {
    let changed = false;
    for (const [k, v] of Object.entries(pattern)) {
      if (!(k in current) || current[k] === null || current[k] === undefined) {
        current[k] = v;
        changed = true;
      }
    }
    return changed ? "set" : "exists";
  }
  return "exists";
}

/** Pin every fixed[x]/pattern[x] from the profile snapshot onto the draft where absent. */
export function pinFixedPattern(sd: SD, resource: Record<string, any>): any[] {
  const root = sd.type || resource.resourceType || "";
  const prefix = root + ".";
  const trace: any[] = [];
  for (const el of (sd.snapshot || {}).element || []) {
    if (isSliceMember(el)) continue;
    const path = el.path || "";
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    const [fixed, pattern] = fixedPattern(el);
    if (fixed !== null) {
      const action = setAtPath(resource, rel, fixed.value);
      trace.push({ path, field: fixed.field, action });
    } else if (pattern !== null) {
      const segments = rel.split(".");
      let node: any = resource;
      let action = "set";
      for (const seg of segments.slice(0, -1)) {
        const nxt = node[seg];
        if (Array.isArray(nxt)) {
          action = "skipped-array";
          break;
        }
        if (nxt === null || nxt === undefined || typeof nxt !== "object") {
          action = "skipped-missing";
          break;
        }
        node = nxt;
      }
      if (action === "skipped-array" || action === "skipped-missing") {
        trace.push({ path, field: pattern.field, action });
        continue;
      }
      action = mergePattern(node, segments[segments.length - 1], pattern.value);
      trace.push({ path, field: pattern.field, action });
    }
  }
  return trace;
}

// --- Slice-aware pinning --------------------------------------------------- //

function isPlainObject(v: unknown): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function shortType(code: string): string {
  const parts = String(code).split(".");
  return parts[parts.length - 1].split("/").pop() || "";
}

function stripSlices(id: string): string {
  return id.replace(/:[^.]+/g, "");
}

function fixedOrPattern(el: ProjectedElement | undefined): unknown {
  if (!el) return undefined;
  if (el.fixed) return el.fixed.value;
  if (el.pattern) return el.pattern.value;
  return undefined;
}

function repeatsIn(el: ProjectedElement | undefined, seg: string): boolean {
  if (seg.includes(":") && !seg.split(":")[0].endsWith("[x]")) return true; // only repeating elements are sliced
  const m = el?.baseMax ?? el?.max;
  return m !== null && m !== undefined && m !== "1" && m !== "0";
}

/** Type codes a choice element still allows (type slices with max 0 remove theirs). */
function allowedTypes(el: ProjectedElement, E: Map<string, ProjectedElement>): string[] {
  const types = [...new Set((el.types || []).map((t) => shortType(t.code)).filter(Boolean))];
  if (!(el.id.split(".").pop() || "").endsWith("[x]")) return types;
  const forbidden = new Set<string>();
  for (const [id, s] of E) {
    if (!id.startsWith(`${el.id}:`) || id.slice(el.id.length + 1).includes(".")) continue;
    if (s.max === "0") for (const t of (s.types || []).map((x) => shortType(x.code))) forbidden.add(t);
  }
  return types.filter((t) => !forbidden.has(t));
}

/** Projected snapshot (with slicing / base.max), by element id. */
export function projectedById(sd: SD): Map<string, ProjectedElement> {
  const els = projectForRequired((sd.snapshot || {}).element || [], projectElement);
  return new Map(els.map((e) => [e.id, e]));
}

/**
 * The JSON fragment the profile pins under an element id: fixed / pattern values of the
 * element and its descendants, nested slices as array items, single-type choices written
 * as their JSON property (`value[x]` + Quantity -> `valueQuantity`). FHIR JSON shape
 * relative to the element; undefined when nothing is pinned. Shared with the authoring
 * field list (`fields.ts`, `pins`).
 */
export function pinnedFragment(elementId: string, E: Map<string, ProjectedElement>): Record<string, any> | undefined {
  const root: Record<string, any> = {};
  const own = fixedOrPattern(E.get(elementId));
  if (isPlainObject(own)) deepMergeFill(root, own);
  const sliceItems = new Map<string, Record<string, any>>();
  const prefix = `${elementId}.`;
  // Descendants of a type slice of a choice (`value[x]:valueQuantity.system`) belong to the
  // choice itself: the fragment is the value, so the slice segment adds no nesting.
  const choice = elementId.endsWith("[x]");
  const under = (id: string): string | null => {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
    if (!choice || !id.startsWith(`${elementId}:`)) return null;
    const dot = id.indexOf(".", elementId.length);
    return dot < 0 ? null : id.slice(dot + 1);
  };
  const ids = [...E.keys()].filter((id) => under(id) !== null).sort((a, b) => a.split(".").length - b.split(".").length || a.localeCompare(b));
  for (const id of ids) {
    const e = E.get(id)!;
    const v = fixedOrPattern(e);
    if (v === undefined || e.max === "0") continue;
    const rel = under(id)!.split(".");
    let node: Record<string, any> = root;
    let cur = id.startsWith(prefix) ? elementId : id.slice(0, id.indexOf(".", elementId.length));
    if (E.get(cur)?.max === "0") continue;
    let ok = true;
    for (let i = 0; i < rel.length; i++) {
      const seg = rel[i];
      cur = `${cur}.${seg}`;
      const el = E.get(cur);
      if (el?.max === "0") {
        ok = false;
        break;
      }
      let name = seg.split(":")[0];
      if (name.endsWith("[x]")) {
        const types = el ? allowedTypes(el, E) : [];
        if (types.length !== 1) {
          ok = false;
          break;
        }
        name = choiceProperty(name, types[0]);
      }
      const last = i === rel.length - 1;
      const repeats = repeatsIn(el, seg);
      if (last) {
        if (repeats) {
          const list: any[] = Array.isArray(node[name]) ? node[name] : [];
          if (isPlainObject(v) && list.length && isPlainObject(list[0]) && !seg.includes(":")) deepMergeFill(list[0], v);
          else if (!list.some((x) => JSON.stringify(x) === JSON.stringify(v))) list.push(deepClone(v));
          node[name] = list;
        } else if (isPlainObject(v) && isPlainObject(node[name])) deepMergeFill(node[name], v);
        else if (!(name in node)) node[name] = deepClone(v);
        continue;
      }
      if (repeats) {
        if (!Array.isArray(node[name])) node[name] = [];
        const list: any[] = node[name];
        if (seg.includes(":")) {
          let item = sliceItems.get(cur);
          if (!item) {
            item = list.length === 1 && isPlainObject(list[0]) && Object.keys(list[0]).length === 0 ? list[0] : {};
            if (!list.includes(item)) list.push(item);
            sliceItems.set(cur, item);
          }
          node = item;
        } else {
          if (!list.length) list.push({});
          if (!isPlainObject(list[0])) {
            ok = false;
            break;
          }
          node = list[0];
        }
      } else {
        if (!(name in node)) node[name] = {};
        if (!isPlainObject(node[name])) {
          ok = false;
          break;
        }
        node = node[name];
      }
    }
    if (!ok) continue;
  }
  return Object.keys(root).length ? root : undefined;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function deepMergeFill(target: Record<string, any>, template: any): void {
  if (!(template && typeof template === "object" && !Array.isArray(template))) return;
  for (const [k, v] of Object.entries(template)) {
    if (!(k in target) || target[k] === null || target[k] === undefined) {
      target[k] = deepClone(v);
    } else if (target[k] && typeof target[k] === "object" && !Array.isArray(target[k]) && v && typeof v === "object" && !Array.isArray(v)) {
      deepMergeFill(target[k], v);
    } else if (Array.isArray(target[k]) && Array.isArray(v)) {
      if (target[k].length === 0) {
        target[k] = deepClone(v);
      } else {
        for (let i = 0; i < v.length; i++) {
          if (i < target[k].length && target[k][i] && typeof target[k][i] === "object") {
            deepMergeFill(target[k][i], v[i]);
          } else if (i >= target[k].length) {
            target[k].push(deepClone(v[i]));
          }
        }
      }
    }
  }
}

/**
 * Pin slice-mandated fixed / pattern values onto entries tagged with `_slice: <sliceName>`
 * (at any depth — `code.coding`, `component`, nested backbones); the tag is always removed,
 * also when it names no slice (reported as `unknown-slice`), so a draft never fails
 * validation on the tag itself.
 */
export function pinSlices(sd: SD, resource: Record<string, any>): any[] {
  const E = projectedById(sd);
  const root = sd.type || resource.resourceType || "";
  const trace: any[] = [];
  const childId = (elementId: string, key: string): string => {
    const plain = `${elementId}.${key}`;
    if (E.has(plain)) return plain;
    const base = stripSlices(elementId);
    for (const id of E.keys()) {
      if (!id.startsWith(`${base}.`) || !id.endsWith("[x]") || id.slice(base.length + 1).includes(".")) continue;
      const stem = id.slice(base.length + 1, -3);
      if (key.startsWith(stem) && key.length > stem.length && /[A-Z]/.test(key[stem.length])) return id;
    }
    return plain;
  };
  const walk = (node: any, elementId: string, depth: number): void => {
    if (depth > 16) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, elementId, depth);
      return;
    }
    if (!isPlainObject(node)) return;
    if ("_slice" in node) {
      const hint = node._slice;
      delete node._slice;
      if (hint) {
        const sliceId = `${elementId}:${hint}`;
        if (E.has(sliceId)) {
          const template = pinnedFragment(sliceId, E) || {};
          deepMergeFill(node, template);
          trace.push({ path: elementId, slice: hint, action: "pinned", fields: Object.keys(template).sort() });
        } else trace.push({ path: elementId, slice: hint, action: "unknown-slice" });
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("_") || k === "resourceType") continue;
      if (v && typeof v === "object") walk(v, childId(elementId, k), depth + 1);
    }
  };
  walk(resource, root, 0);
  return trace;
}

// --- Discriminator-decided slice pinning ---------------------------------- //

/** Expected discriminator values for `path` under a slice (own fixed/pattern, extension url, or through nested slices). */
function expectedAt(sliceId: string, path: string, E: Map<string, ProjectedElement>): unknown[] {
  if (path === "$this") {
    const v = fixedOrPattern(E.get(sliceId));
    return v === undefined ? [] : [v];
  }
  const direct = fixedOrPattern(E.get(`${sliceId}.${path}`));
  if (direct !== undefined) return [direct];
  if (path === "url") {
    const prof = E.get(sliceId)?.types?.find((t) => shortType(t.code) === "Extension")?.profile?.[0];
    if (prof) return [String(prof).split("|")[0]];
  }
  const want = stripSlices(`${sliceId}.${path}`);
  const out: unknown[] = [];
  for (const [id, e] of E) {
    if (!id.startsWith(`${sliceId}.`) || stripSlices(id) !== want) continue;
    const v = fixedOrPattern(e);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * Slice membership decided from the slicing discriminators alone: true only when at least
 * one discriminator could be evaluated locally and every evaluable one matched.
 */
export function decidedSliceMatch(item: unknown, jsonKey: string, sliceId: string, E: Map<string, ProjectedElement>): boolean {
  const colon = sliceId.lastIndexOf(":");
  if (colon < 0) return false;
  const baseId = sliceId.slice(0, colon);
  const sliceName = sliceId.slice(colon + 1);
  const slice = E.get(sliceId);
  if (baseId.endsWith("[x]")) {
    if (jsonKey === sliceName) return true;
    const t = slice?.types?.length === 1 ? shortType(slice.types[0].code) : null;
    return t ? jsonKey === choiceProperty(baseId, t) : false;
  }
  let discs = E.get(baseId)?.slicing?.discriminator ?? null;
  if (!discs && /\.(extension|modifierExtension)$/.test(baseId)) discs = [{ type: "value", path: "url" }];
  if (!discs || !discs.length) return false;
  let decided = false;
  for (const d of discs) {
    const p = String(d.path || "$this");
    if (p.includes("(")) continue;
    if (d.type === "value" || d.type === "pattern") {
      const expected = expectedAt(sliceId, p, E);
      if (!expected.length) continue;
      decided = true;
      const vals = p === "$this" ? [item] : valuesAt(item, p);
      if (!vals.some((v) => expected.some((exp) => patternMatches(v, exp)))) return false;
    } else if (d.type === "type") {
      const el = p === "$this" ? slice : E.get(`${sliceId}.${p}`);
      const types = (el?.types || []).map((t) => shortType(t.code));
      const vals = p === "$this" ? [item] : valuesAt(item, p);
      const rts = vals.map((v) => (isPlainObject(v) ? v.resourceType : undefined)).filter(Boolean);
      if (!types.length || !rts.length) continue;
      decided = true;
      if (!rts.some((r) => types.includes(String(r)))) return false;
    }
  }
  return decided;
}

/** Instance nodes at an element id; sliced segments keep only decided slice members. */
function decidedNodesAt(instance: unknown, eid: string, E: Map<string, ProjectedElement>): unknown[] {
  const segs = eid.split(".");
  let nodes: unknown[] = [instance];
  let idSoFar = segs[0];
  for (const seg of segs.slice(1)) {
    idSoFar = `${idSoFar}.${seg}`;
    const colon = seg.indexOf(":");
    const p = colon >= 0 ? seg.slice(0, colon) : seg;
    const next: unknown[] = [];
    for (const n of nodes) {
      if (!isPlainObject(n)) continue;
      const keys: string[] = [];
      if (p.endsWith("[x]")) {
        const stem = p.slice(0, -3);
        for (const k of Object.keys(n)) if (k.startsWith(stem) && k.length > stem.length && /[A-Z]/.test(k[stem.length])) keys.push(k);
      } else if (p in n) keys.push(p);
      for (const k of keys) {
        const v = n[k];
        const items = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
        for (const it of items) {
          if (colon >= 0 && !decidedSliceMatch(it, k, idSoFar, E)) continue;
          next.push(it);
        }
      }
    }
    nodes = next;
  }
  return nodes;
}

/**
 * Pin the fixed / pattern values of slice members onto the draft items that the slicing
 * discriminators identify as members of the slice (the LOINC-coded systolic component gets
 * its UCUM system / code, an identifier whose type says MR gets the slice's `use`, ...).
 * Only existing parent nodes are written; no item is created.
 */
export function pinSliceMembers(sd: SD, resource: Record<string, any>): any[] {
  const E = projectedById(sd);
  const trace: any[] = [];
  for (const e of E.values()) {
    if (!e.id.includes(":") || e.max === "0") continue;
    const pin = e.fixed ?? e.pattern;
    if (!pin) continue;
    const last = e.id.split(".").pop() || "";
    if (last.includes(":")) {
      // value on the slice root itself: fill the pattern's missing keys into each member
      if (!isPlainObject(pin.value)) continue;
      for (const it of decidedNodesAt(resource, e.id, E)) {
        if (!isPlainObject(it)) continue;
        const before = JSON.stringify(it);
        deepMergeFill(it, pin.value);
        trace.push({ path: e.id, field: pin.field, action: JSON.stringify(it) === before ? "exists" : "set" });
      }
      continue;
    }
    const parentId = e.id.slice(0, e.id.lastIndexOf("."));
    const parents = decidedNodesAt(resource, parentId, E);
    if (!parents.length) continue;
    let name = last;
    if (name.endsWith("[x]")) {
      const types = allowedTypes(e, E);
      if (types.length !== 1) continue;
      name = choiceProperty(name, types[0]);
    }
    const repeats = repeatsIn(e, last);
    for (const parent of parents) {
      if (!isPlainObject(parent)) continue;
      const cur = parent[name];
      let action: string;
      if (cur === null || cur === undefined) {
        const v = deepClone(pin.value);
        parent[name] = repeats ? [v] : v;
        action = "set";
      } else if (e.fixed) action = "exists";
      else if (Array.isArray(cur)) action = "skipped-array";
      else if (isPlainObject(cur) && isPlainObject(pin.value)) action = mergePattern(parent, name, pin.value);
      else action = "exists";
      trace.push({ path: e.id, field: pin.field, action });
    }
  }
  return trace;
}
