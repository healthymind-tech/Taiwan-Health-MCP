/**
 * "Unrecognized property 'p'": the closest element name at the same level (datatype
 * children included, choice elements expanded to their typed names), or the level of the
 * resource / datatype tree where an element of that name actually lives (move).
 *
 * The level of an issue path is found by walking the instance path through the core
 * StructureDefinitions (base resource → datatype → BackboneElement children ...).
 * Profiles only constrain base elements, so names come from the base definitions.
 */

import type { Suggestion, SuggestionDeps } from "./types.js";
import { isObject, parsePath, textSim } from "./util.js";

const CORE = "http://hl7.org/fhir/StructureDefinition/";

/** A position in the type tree: a StructureDefinition and the element path inside it. */
interface Level {
  sd: Record<string, any>;
  /** Element path inside `sd` (e.g. `Timing.repeat`), or null for a primitive. */
  prefix: string | null;
  /** The instance path of this level (validator form). */
  path: string;
  /** The instance node at this level (may be undefined for a virtual level). */
  node: any;
}

interface Child {
  name: string;
  /** Element path in the SD (choice: `Observation.value[x]`). */
  elPath: string;
  type: string | null;
  choice: boolean;
}

function elements(sd: Record<string, any>): Array<Record<string, any>> {
  return (sd && sd.snapshot && Array.isArray(sd.snapshot.element) ? sd.snapshot.element : []) as Array<Record<string, any>>;
}

function upperFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function typeCodes(el: Record<string, any>): string[] {
  return (Array.isArray(el.type) ? el.type : []).map((t: any) => String(t && t.code ? t.code : "")).filter((c: string) => c !== "");
}

/** Direct children of `prefix` in `sd` (choice elements expanded). */
function childrenOf(sd: Record<string, any>, prefix: string): Child[] {
  const out: Child[] = [];
  const seen = new Set<string>();
  const head = prefix + ".";
  for (const el of elements(sd)) {
    const p = String(el.path || "");
    if (!p.startsWith(head)) continue;
    const rest = p.slice(head.length);
    if (!rest || rest.includes(".")) continue;
    if (rest.endsWith("[x]")) {
      const stem = rest.slice(0, -3);
      for (const t of typeCodes(el)) {
        const name = stem + upperFirst(t);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, elPath: p, type: t, choice: true });
      }
    } else if (!seen.has(rest)) {
      seen.add(rest);
      const t = typeCodes(el);
      out.push({ name: rest, elPath: p, type: el.contentReference ? `#${String(el.contentReference).replace(/^[^#]*#/, "")}` : t[0] ?? null, choice: false });
    }
  }
  return out;
}

function isPrimitive(t: string): boolean {
  return /^[a-z]/.test(t);
}

class TypeWalker {
  private sdCache = new Map<string, Promise<Record<string, any> | null>>();
  fetches = 0;

  constructor(private readonly deps: SuggestionDeps, private readonly maxFetches = 40) {}

  sd(type: string): Promise<Record<string, any> | null> {
    let p = this.sdCache.get(type);
    if (!p) {
      if (this.fetches >= this.maxFetches) return Promise.resolve(null);
      this.fetches++;
      p = this.deps.fetchStructureDefinition(CORE + type).catch(() => null);
      this.sdCache.set(type, p);
    }
    return p;
  }

  /** The level a child element leads to (null when it is a primitive or cannot be resolved). */
  async descend(level: Level, child: Child, node: any, path: string): Promise<Level | null> {
    if (!level.prefix) return null;
    const t = child.type;
    if (!t) return null;
    if (t.startsWith("#")) return { sd: level.sd, prefix: t.slice(1), path, node };
    const inline = elements(level.sd).some((e) => String(e.path || "").startsWith(child.elPath + "."));
    if (inline && (t === "BackboneElement" || t === "Element")) return { sd: level.sd, prefix: child.elPath, path, node };
    if (t === "Resource" || t === "DomainResource" || (isObject(node) && typeof node.resourceType === "string" && /^[A-Z]/.test(t) && !(await this.isDatatype(t)))) {
      const rt = isObject(node) && typeof node.resourceType === "string" ? node.resourceType : null;
      if (!rt) return null;
      const sd = await this.sd(rt);
      return sd ? { sd, prefix: rt, path, node } : null;
    }
    if (isPrimitive(t)) return { sd: level.sd, prefix: null, path, node };
    const sd = await this.sd(t);
    return sd ? { sd, prefix: String(sd.type || t), path, node } : null;
  }

  private async isDatatype(t: string): Promise<boolean> {
    const sd = await this.sd(t);
    return !!sd && sd.kind !== "resource";
  }

  /** Levels along an instance path (root first). */
  async levels(root: any, path: string): Promise<Level[]> {
    const segs = parsePath(path);
    if (!segs.length || !isObject(root)) return [];
    const rt = String(root.resourceType || segs[0].name);
    const sd = await this.sd(rt);
    if (!sd) return [];
    const out: Level[] = [{ sd, prefix: rt, path: segs[0].name, node: root }];
    let cur = out[0];
    let curPath = segs[0].name;
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i];
      if (!cur.prefix) return out;
      const kids = childrenOf(cur.sd, cur.prefix);
      let child = kids.find((k) => k.name === s.name);
      if (!child && (s.name === "extension" || s.name === "modifierExtension")) child = { name: s.name, elPath: `${cur.prefix}.${s.name}`, type: "Extension", choice: false };
      if (!child) return out;
      let node = isObject(cur.node) ? cur.node[s.name] : undefined;
      curPath += `.${s.name}`;
      if (Array.isArray(node)) {
        node = node[s.index ?? 0];
        curPath += `[${s.index ?? 0}]`;
      } else if (s.index !== null) curPath += `[${s.index}]`;
      const next = await this.descend(cur, child, node, curPath);
      if (!next) return out;
      out.push(next);
      cur = next;
    }
    return out;
  }
}

/** The JSON shape of a value → the FHIR type names it can be (choice-type disambiguation). */
function shapeTypes(v: any): string[] {
  if (typeof v === "boolean") return ["boolean"];
  if (typeof v === "number") return Number.isInteger(v) ? ["integer", "decimal", "positiveInt", "unsignedInt"] : ["decimal"];
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return ["dateTime", "instant"];
    if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) return ["date", "dateTime"];
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(v)) return ["time"];
    return ["string", "code", "markdown", "uri"];
  }
  if (isObject(v)) {
    if ("coding" in v || "text" in v) return ["CodeableConcept"];
    if ("reference" in v || "identifier" in v) return ["Reference"];
    if ("system" in v && "code" in v && !("value" in v)) return ["Coding"];
    if ("value" in v || "unit" in v) return ["Quantity"];
    if ("start" in v || "end" in v) return ["Period"];
    if ("low" in v || "high" in v) return ["Range"];
    if ("numerator" in v || "denominator" in v) return ["Ratio"];
    if ("contentType" in v || "data" in v || "url" in v) return ["Attachment"];
    if ("repeat" in v || "event" in v) return ["Timing"];
  }
  return [];
}

export async function suggestProperty(
  deps: SuggestionDeps,
  root: any,
  issuePath: string,
  key: string,
): Promise<Suggestion[]> {
  const walker = new TypeWalker(deps);
  const levels = await walker.levels(root, issuePath);
  if (!levels.length) return [];
  const level = levels[levels.length - 1];
  // The walk must reach the issue's own level (otherwise a segment was not understood).
  if (levels.length !== parsePath(issuePath).length) return [];
  const value = isObject(level.node) ? level.node[key] : undefined;
  const out: Suggestion[] = [];
  const lowerKey = key.toLowerCase();
  const sameLevel: Child[] = level.prefix ? childrenOf(level.sd, level.prefix) : [{ name: "id", elPath: "", type: "string", choice: false }, { name: "extension", elPath: "", type: "Extension", choice: false }];
  const present = new Set(isObject(level.node) ? Object.keys(level.node) : []);
  const rename = (c: Child, conf: number, reason: string): void => {
    out.push({
      value: c.name,
      kind: "rename_property",
      confidence: conf,
      reason,
      patch: { op: "move", from: `${issuePath}.${key}`, path: `${issuePath}.${c.name}` },
    });
  };
  // (1) Same level: case, choice stem, edit distance.
  const shapes = shapeTypes(value);
  for (const c of sameLevel) {
    if (present.has(c.name)) continue;
    const lc = c.name.toLowerCase();
    if (lc === lowerKey) {
      rename(c, 0.95, `element names are case-sensitive: '${c.name}'`);
      continue;
    }
    if (c.choice) {
      const stem = c.elPath.split(".").pop()!.replace(/\[x\]$/, "");
      if (key === stem || lowerKey === stem.toLowerCase()) {
        const fit = shapes.indexOf(c.type || "");
        if (fit >= 0) rename(c, 0.92 - fit * 0.05, `'${stem}' is a choice element: name it by the value's type ('${c.name}')`);
        else rename(c, 0.4, `'${stem}' is a choice element (${stem}[x]); '${c.name}' is one of its typed names`);
        continue;
      }
      if (lowerKey.startsWith(stem.toLowerCase()) && key.length > stem.length) {
        const sim = textSim(key.slice(stem.length), c.type || "");
        if (sim >= 0.5) {
          rename(c, 0.55 + 0.35 * sim, `closest typed name of the choice element ${stem}[x]: '${c.name}'`);
          continue;
        }
      }
    }
    const sim = textSim(key, c.name);
    if (sim >= 0.6) rename(c, 0.9 * sim, `closest element name at this level: '${c.name}'`);
  }
  // (2) Other levels: descendants (two levels down) and ancestors (with their children).
  const levelName = (l: Level): string => (l.prefix ? l.prefix : l.path);
  const search = async (from: Level, depth: number, seen: Set<string>): Promise<Array<{ level: Level; child: Child; route: string }>> => {
    const hits: Array<{ level: Level; child: Child; route: string }> = [];
    if (!from.prefix || depth < 0) return hits;
    const key2 = `${from.sd.url}|${from.prefix}`;
    if (seen.has(key2)) return hits;
    seen.add(key2);
    for (const c of childrenOf(from.sd, from.prefix)) {
      if (c.name.toLowerCase() === lowerKey) hits.push({ level: from, child: c, route: from.path });
    }
    if (depth === 0) return hits;
    for (const c of childrenOf(from.sd, from.prefix)) {
      if (!c.type || isPrimitive(c.type) || c.type === "Extension" || c.type === "Reference" || c.type === "Resource" || c.choice) continue;
      if (["extension", "modifierExtension", "meta", "text", "contained", "id"].includes(c.name)) continue;
      const node = isObject(from.node) ? from.node[c.name] : undefined;
      const nextPath = `${from.path}.${c.name}${Array.isArray(node) ? "[0]" : ""}`;
      const next = await walker.descend(from, c, Array.isArray(node) ? node[0] : node, nextPath);
      if (next) hits.push(...(await search(next, depth - 1, seen)));
    }
    return hits;
  };
  const moves: Array<{ level: Level; child: Child; dist: number }> = [];
  const seen = new Set<string>([`${level.sd.url}|${level.prefix}`]);
  for (const h of await search(level, 2, new Set())) {
    if (h.level === level || h.route === level.path) continue;
    moves.push({ level: h.level, child: h.child, dist: parsePath(h.route).length - parsePath(level.path).length });
  }
  for (let i = levels.length - 2; i >= 0 && i >= levels.length - 4; i--) {
    for (const h of await search(levels[i], 1, seen)) {
      if (h.route === level.path) continue;
      moves.push({ level: h.level, child: h.child, dist: levels.length - 1 - i + Math.max(0, parsePath(h.route).length - parsePath(levels[i].path).length) });
    }
  }
  const moved = new Set<string>();
  for (const m of moves.sort((a, b) => a.dist - b.dist || (a.level.path < b.level.path ? -1 : 1))) {
    const target = `${m.level.path}.${m.child.name}`;
    if (moved.has(target)) continue;
    moved.add(target);
    const exact = m.child.name === key;
    // A value whose JSON shape does not fit the target element's type is unlikely to belong there.
    const misfit = shapes.length > 0 && !!m.child.type && !m.child.type.startsWith("#") && !shapes.includes(m.child.type) && !(isPrimitive(m.child.type) && shapes.some(isPrimitive));
    out.push({
      value: target,
      kind: "move_property",
      confidence: ((exact ? 0.88 : 0.8) - 0.04 * Math.min(3, Math.max(0, m.dist - 1))) * (misfit ? 0.6 : 1),
      reason: `'${m.child.name}' is an element of ${levelName(m.level)}, not of ${levelName(level)}`,
      patch: { op: "move", from: `${issuePath}.${key}`, path: target },
    });
  }
  return out;
}

/**
 * "The type 'date' is not allowed for Condition.onset[x] (allowed: dateTime, Age, ...)":
 * the typed name of an allowed type that fits the value (onsetDate → onsetDateTime).
 */
export function suggestChoiceType(root: any, issuePath: string, message: string): Suggestion[] {
  const m = /^The type '([^']+)' is not allowed for (\S+?) \(allowed: ([^)]*)\)/.exec(message);
  if (!m) return [];
  const given = m[1];
  const stem = m[2].split(".").pop()!.replace(/\[x\]$/, "");
  const allowed = m[3].split(/,\s*/).filter((t) => t !== "");
  const segs = parsePath(issuePath);
  const key = segs.length ? segs[segs.length - 1].name : "";
  const parentPath = issuePath.slice(0, issuePath.length - key.length - 1);
  const value = (() => {
    let node: any = root;
    for (let i = 1; i < segs.length; i++) {
      if (!isObject(node)) return undefined;
      node = node[segs[i].name];
      if (Array.isArray(node)) node = node[segs[i].index ?? 0];
    }
    return node;
  })();
  const shapes = shapeTypes(value);
  const out: Suggestion[] = [];
  allowed.forEach((t, i) => {
    const fit = shapes.indexOf(t);
    const sim = textSim(given, t);
    const conf = fit >= 0 ? 0.9 - 0.05 * fit : 0.25 + 0.4 * sim - 0.01 * i;
    const name = stem + upperFirst(t);
    out.push({
      value: name,
      kind: "rename_property",
      confidence: conf,
      reason: fit >= 0 ? `${m[2]} allows ${t}, which fits this value: '${name}'` : `${m[2]} allows ${t} ('${name}')`,
      patch: { op: "move", from: issuePath, path: `${parentPath}.${name}` },
    });
  });
  return out;
}
