/**
 * Schema-guided fill helpers — pure, DB-free mechanical pinning. Faithful port
 * of `src/fhir_authoring.py`. Sets `fixed[x]`/`pattern[x]` values, `meta.profile`,
 * narrative, and slice-mandated values over a draft resource.
 */

import { fixedPattern, isSliceMember } from "./fhirSnapshot.js";

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

function sliceTemplate(els: El[], basePath: string, sliceName: string): Record<string, any> {
  const prefix = `${basePath}:${sliceName}.`;
  const maxMap: Record<string, any> = {};
  for (const el of els) {
    const eid = el.id || "";
    if (eid.startsWith(prefix)) maxMap[eid.slice(prefix.length)] = el.max;
  }
  const template: Record<string, any> = {};
  for (const el of els) {
    const eid = el.id || "";
    if (!eid.startsWith(prefix)) continue;
    const [fixed, pattern] = fixedPattern(el);
    let value = fixed !== null ? fixed.value : null;
    if (value === null && pattern !== null) value = pattern.value;
    if (value === null) continue;
    insertTemplate(template, eid.slice(prefix.length).split("."), value, maxMap, "");
  }
  return template;
}

function insertTemplate(node: Record<string, any>, segs: string[], value: any, maxMap: Record<string, any>, subPrefix: string): void {
  const seg = segs[0];
  const sub = subPrefix ? `${subPrefix}.${seg}` : seg;
  const isArray = maxIsArray(maxMap[sub]);
  if (segs.length === 1) {
    if (!(seg in node)) node[seg] = isArray ? [value] : value;
    return;
  }
  if (isArray) {
    if (!(seg in node)) node[seg] = [{}];
    const arr = node[seg];
    if (arr.length === 0) arr.push({});
    if (arr[0] && typeof arr[0] === "object") insertTemplate(arr[0], segs.slice(1), value, maxMap, sub);
  } else {
    if (!(seg in node)) node[seg] = {};
    const child = node[seg];
    if (child && typeof child === "object") insertTemplate(child, segs.slice(1), value, maxMap, sub);
  }
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

/** Pin slice-mandated fixed/pattern onto entries tagged with `_slice`; strip the tag. */
export function pinSlices(sd: SD, resource: Record<string, any>): any[] {
  const els = (sd.snapshot || {}).element || [];
  const root = sd.type || resource.resourceType || "";
  const prefix = root + ".";
  const sliceRootIds = new Set(els.filter((e: El) => e.sliceName).map((e: El) => e.id));
  const trace: any[] = [];
  for (const head of els) {
    if (isSliceMember(head) || !head.slicing) continue;
    const path = head.path || "";
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (rel.includes(".")) continue;
    const entries = resource[rel];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!(entry && typeof entry === "object")) continue;
      const hint = entry._slice;
      if (hint !== undefined) delete entry._slice;
      if (!hint) continue;
      if (!sliceRootIds.has(`${path}:${hint}`)) {
        trace.push({ path, slice: hint, action: "unknown-slice" });
        continue;
      }
      const template = sliceTemplate(els, path, String(hint));
      deepMergeFill(entry, template);
      trace.push({ path, slice: hint, action: "pinned", fields: Object.keys(template).sort() });
    }
  }
  return trace;
}
