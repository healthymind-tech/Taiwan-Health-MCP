/**
 * "Unrecognized property 'p'": what to do with a property the validator does not know.
 *
 *   rename_property  the closest element name at the same level (case, edit distance,
 *                    choice elements expanded to their typed names), or — weaker — an absent
 *                    sibling whose name / alias / short text means the same thing and whose
 *                    type fits the value (`every: 8` next to `periodUnit` → `period`,
 *                    `upperLimit` in a Range → `high`, `zip` → `postalCode`).
 *   move_property    the level of this resource where an element of that name actually
 *                    lives: ancestors, descendants (≤ 3 levels, datatype children included),
 *                    or a sibling backbone / datatype of an ancestor.
 *   remove_property  nothing plausible anywhere; the reason lists the sibling names (so a
 *                    caller can pick) and the resource types that do carry the name.
 *
 * Confidence bands keep the kinds in order: exact / case rename (0.92–0.95) > move
 * (0.68–0.88, × 0.6 on a value-shape misfit) > evidence rename (≤ 0.66) > remove (0.4 / 0.5);
 * typo renames (0.9 × similarity) interleave with moves by similarity.
 *
 * The level of an issue path is found by walking the instance path through the core
 * StructureDefinitions (base resource → datatype → BackboneElement children ...).
 * Profiles only constrain base elements, so names come from the base definitions.
 */

import type { Suggestion, SuggestionDeps } from "./types.js";
import { editSim, isObject, jaccard, parsePath, textSim, tokens } from "./util.js";

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
  /** ElementDefinition.max ("1" or "*" / a number): absent repeating elements get a `[0]` in move paths. */
  max: string;
  /** ElementDefinition.short / alias (evidence for renames). */
  short: string;
  alias: string[];
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

function aliasesOf(el: Record<string, any>): string[] {
  return Array.isArray(el.alias) ? el.alias.filter((a: unknown): a is string => typeof a === "string" && a !== "") : [];
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
    const short = typeof el.short === "string" ? el.short : "";
    const alias = aliasesOf(el);
    const max = String(el.max ?? "1");
    if (rest.endsWith("[x]")) {
      const stem = rest.slice(0, -3);
      for (const t of typeCodes(el)) {
        const name = stem + upperFirst(t);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, elPath: p, type: t, choice: true, max, short, alias });
      }
    } else if (!seen.has(rest)) {
      seen.add(rest);
      const t = typeCodes(el);
      out.push({ name: rest, elPath: p, type: el.contentReference ? `#${String(el.contentReference).replace(/^[^#]*#/, "")}` : t[0] ?? null, choice: false, max, short, alias });
    }
  }
  return out;
}

function isPrimitive(t: string): boolean {
  return /^[a-z]/.test(t);
}

/** Choice stem of a child (`value` for `valueQuantity`), or its name. */
function stemOf(c: Child): string {
  return c.choice ? c.elPath.split(".").pop()!.replace(/\[x\]$/, "") : c.name;
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
      if (!child && (s.name === "extension" || s.name === "modifierExtension")) child = { name: s.name, elPath: `${cur.prefix}.${s.name}`, type: "Extension", choice: false, max: "*", short: "", alias: [] };
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

// --------------------------------------------------------------------------- //
// Value shape vs element type
// --------------------------------------------------------------------------- //

type ShapeClass = "number" | "boolean" | "string" | "date" | "object";

function valueClass(v: any): ShapeClass | null {
  const x = Array.isArray(v) ? v[0] : v;
  if (typeof x === "number") return "number";
  if (typeof x === "boolean") return "boolean";
  if (typeof x === "string") return /^\d{4}(-\d{2}(-\d{2})?)?(T.*)?$/.test(x) ? "date" : "string";
  if (isObject(x)) return "object";
  return null;
}

function typeClass(t: string | null): ShapeClass | null {
  if (!t) return null;
  if (t.startsWith("#") || !isPrimitive(t)) return "object";
  if (["integer", "decimal", "positiveInt", "unsignedInt"].includes(t)) return "number";
  if (t === "boolean") return "boolean";
  if (["date", "dateTime", "instant"].includes(t)) return "date";
  return "string";
}

/**
 * fit: the value can be stored in an element of this type as is; soft: it needs restructuring
 * (a primitive where a datatype goes, a Quantity where a Range goes); hard: the kinds disagree
 * (a number for a string element); unknown: no value or no type.
 */
function shapeFit(value: any, type: string | null): "fit" | "soft" | "hard" | "unknown" {
  const vc = valueClass(value);
  const tc = typeClass(type);
  if (!vc || !tc) return "unknown";
  if (vc === tc) {
    if (vc !== "object" || !type || type === "BackboneElement" || type === "Element" || type.startsWith("#")) return "fit";
    const st = shapeTypes(Array.isArray(value) ? value[0] : value);
    return !st.length || st.includes(type) ? "fit" : "soft";
  }
  if (vc === "date" && tc === "string") return "fit";
  if (tc === "object") return "soft";
  return "hard";
}

// --------------------------------------------------------------------------- //
// Name evidence: element name / alias / short text + generic FHIR synonyms
// --------------------------------------------------------------------------- //

/** Structural elements of every element (never content): not rename targets, not searched. */
const STRUCTURAL = new Set(["id", "extension", "modifierExtension"]);
/** Resource-level infrastructure (Narrative `text`, `contained` ...): not content either — but `text` of a datatype (Annotation, CodeableConcept, Dosage) is. */
const RESOURCE_INFRA = new Set(["meta", "implicitRules", "language", "text", "contained"]);

function isInfra(level: Level, name: string): boolean {
  return STRUCTURAL.has(name) || (RESOURCE_INFRA.has(name) && level.sd.kind === "resource" && level.prefix === String(level.sd.type || ""));
}

/**
 * Generic naming synonyms (lower-case, separators removed): words that FHIR element names
 * and common client vocabularies use for the same notion. Each group is justified by the
 * FHIR R4 naming it bridges; resource-specific vocabulary is not listed here — it comes from
 * the StructureDefinitions (element name, ElementDefinition.alias, ElementDefinition.short).
 */
const SYNONYMS: string[][] = [
  ["note", "comment", "remark", "annotation", "memo"], // Annotation-typed `note` elements hold comments / remarks
  ["reason", "indication", "justification", "rationale", "why"], // reasonCode / reasonReference (Encounter.reasonCode alias "Indication")
  ["start", "begin", "from", "since", "onset", "effective"], // Period.start, onset[x], effective[x] (the clinically relevant time)
  ["end", "stop", "until", "finish", "abatement"], // Period.end, abatement[x]
  ["date", "datetime", "time", "when", "timestamp", "occurrence", "occurred", "performed"], // occurrence[x] / performed[x] / *Date elements
  ["every", "interval", "period"], // "every N hours" is Timing.repeat.period (frequency is the count per period)
  ["upper", "high", "max", "maximum", "ceiling"], // Range.high, *Max elements
  ["lower", "low", "min", "minimum", "floor"], // Range.low
  ["quantity", "qty", "amount"], // Quantity-typed elements (dispenseRequest.quantity, dose[x])
  ["unit", "uom"], // Quantity.unit, periodUnit / durationUnit
  ["name", "title", "label"], // Patient.name, *.title
  ["description", "detail", "summary"], // description / detail / summary elements
  ["identifier", "number", "num"], // Identifier-typed elements (medical record number ...)
  ["type", "kind", "category", "class"], // type / category / class classifiers
  ["status", "state"],
  ["sex", "gender"], // Patient.gender
  ["dob", "birthdate", "birthday", "dateofbirth"], // Patient.birthDate
  ["phone", "telephone", "tel", "email", "fax", "telecom"], // ContactPoint-typed `telecom`
  ["patient", "subject", "person"], // *.subject references the patient
  ["doctor", "physician", "practitioner", "performer", "clinician", "provider"], // performer / Practitioner references
  ["requester", "prescriber", "orderer", "requestedby", "orderedby"], // MedicationRequest.requester
  ["author", "recorder", "asserter", "enteredby", "recordedby"], // recorder / asserter / author references
  ["dose", "dosage", "dosing"], // dosageInstruction, dose[x]
  ["route", "routeofadministration", "administrationroute"], // Dosage.route
  ["priority", "urgency", "rank"],
  ["manufacturer", "maker", "brand"],
  ["instruction", "sig", "direction"], // Dosage.text (SIG), patientInstruction
  ["result", "value", "finding"], // Observation.value[x] ("Actual result")
];
const GROUP = new Map<string, number>();
SYNONYMS.forEach((g, i) => g.forEach((w) => GROUP.set(w, i)));

/** Type-ish tail words of camelCase element names (`reasonCode`, `birthDate`): weak evidence on their own. */
const TYPEISH = new Set(["code", "reference", "date", "time", "datetime", "string", "quantity", "boolean", "concept", "codeable", "value", "integer", "decimal", "period", "range", "ratio", "uri", "url", "instant", "id"]);

const STOP = new Set(["a", "an", "the", "of", "for", "to", "in", "on", "or", "and", "is", "be", "this", "that", "with", "by", "as", "at", "e", "g", "etc", "its", "it", "who", "what", "which", "not", "if", "any", "was", "are", "has", "may", "per"]);

/** Singular, lower-case token (`notes` → `note`; `status`, `address`, `diagnosis` unchanged). */
function norm(t: string): string {
  const s = t.toLowerCase();
  if (s.length > 4 && s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.length > 4 && s.endsWith("s") && !/(ss|us|is)$/.test(s)) return s.slice(0, -1);
  return s;
}

function words(s: string): string[] {
  return tokens(s).map(norm).filter((t) => !STOP.has(t));
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const g = GROUP.get(a);
  return g !== undefined && g === GROUP.get(b);
}

/**
 * How strongly `key` names the element `c` (0–1): coverage of the key's words by the element's
 * name / alias (weight 1) or short text (weight 0.7), through the synonym groups, scaled by
 * how much of the element name the key accounts for. A whole-name synonym (`dob` ~ `birthDate`,
 * an alias `Zip` ~ `zip`) is full evidence.
 */
function nameEvidence(key: string, c: Child): number {
  const keyWords = words(key);
  if (!keyWords.length) return 0;
  const stem = stemOf(c);
  const joinedKey = keyWords.join("");
  const nameWords = words(stem);
  const aliasForms = c.alias.map((a) => words(a).join(""));
  if (sameWord(joinedKey, nameWords.join("")) || aliasForms.some((a) => a !== "" && sameWord(joinedKey, a))) return 1;
  const strong = new Set<string>([...nameWords, ...c.alias.flatMap(words)]);
  const weak = new Set<string>(words(c.short));
  const hit = (k: string, bag: Set<string>): boolean => {
    for (const t of bag) if (sameWord(k, t)) return true;
    return false;
  };
  let num = 0;
  let den = 0;
  for (const k of keyWords) {
    const w = keyWords.length > 1 && TYPEISH.has(k) ? 0.3 : 1;
    den += w;
    if (hit(k, strong)) num += w;
    else if (hit(k, weak)) num += 0.7 * w;
  }
  const cov = den ? num / den : 0;
  const prec = nameWords.length ? nameWords.filter((t) => keyWords.some((k) => sameWord(k, t))).length / nameWords.length : 0;
  return cov * (0.5 + 0.5 * prec);
}

/** Name similarity for a typo rename: textSim whose containment bonus needs a real fragment (not `age` in `language`). */
function nameSim(a: string, b: string): number {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const shorter = Math.min(x.length, y.length);
  const contain = shorter >= 4 && shorter / Math.max(x.length, y.length) >= 0.5 && (x.includes(y) || y.includes(x)) ? 0.75 : 0;
  return Math.max(editSim(x, y), jaccard(tokens(a), tokens(b)) * 0.95, contain);
}

/** Names of a level's elements for a reason text (choice stems once, infrastructure omitted, capped). */
function elementList(level: Level, children: Child[], cap: number): string {
  const names: string[] = [];
  for (const c of children) {
    const n = c.choice ? stemOf(c) + "[x]" : c.name;
    if (isInfra(level, n) || names.includes(n)) continue;
    names.push(n);
  }
  return names.length > cap ? `${names.slice(0, cap).join(", ")}, … (${names.length - cap} more)` : names.join(", ");
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
  // `_name` (primitive extension holder) is matched by its bare name and renamed with the prefix kept.
  const pre = key.length > 1 && key.startsWith("_") ? "_" : "";
  const bare = key.slice(pre.length);
  const value = isObject(level.node) ? level.node[key] : undefined;
  const out: Suggestion[] = [];
  const lowerKey = bare.toLowerCase();
  const sameLevel: Child[] = level.prefix ? childrenOf(level.sd, level.prefix) : [{ name: "id", elPath: "", type: "string", choice: false, max: "1", short: "", alias: [] }, { name: "extension", elPath: "", type: "Extension", choice: false, max: "*", short: "", alias: [] }];
  const present = new Set(isObject(level.node) ? Object.keys(level.node) : []);
  const rename = (c: Child, conf: number, reason: string): void => {
    out.push({
      value: pre + c.name,
      kind: "rename_property",
      confidence: conf,
      reason,
      patch: { op: "move", from: `${issuePath}.${key}`, path: `${issuePath}.${pre}${c.name}` },
    });
  };
  /**
   * shapeFit, with "soft" kept only when the target type really has a child that takes the
   * value as is (a string into Annotation.text, a Quantity into Range.low) — else "hard".
   */
  const fitOf = async (v: any, c: Child, at: Level): Promise<"fit" | "soft" | "hard" | "unknown"> => {
    const f = shapeFit(v, c.type);
    if (f !== "soft" || !c.type) return f;
    let kids: Child[] = [];
    if (c.type.startsWith("#")) kids = childrenOf(at.sd, c.type.slice(1));
    else if (c.type === "BackboneElement" || c.type === "Element") kids = childrenOf(at.sd, c.elPath);
    else {
      const sd = await walker.sd(c.type);
      if (sd) kids = childrenOf(sd, String(sd.type || c.type));
    }
    if (!kids.length) return "soft";
    const vc = valueClass(v);
    const st = shapeTypes(Array.isArray(v) ? v[0] : v);
    const takes = (k: Child): boolean => (vc === "object" ? !!k.type && st.includes(k.type) : typeClass(k.type) === vc || (vc === "date" && typeClass(k.type) === "string"));
    return kids.some((k) => !STRUCTURAL.has(k.name) && takes(k)) ? "soft" : "hard";
  };
  // (1) Same level: case, choice stem, edit distance.
  const shapes = shapeTypes(value);
  const strongTargets = new Set<string>();
  for (const c of sameLevel) {
    if (present.has(c.name)) continue;
    const lc = c.name.toLowerCase();
    if (lc === lowerKey) {
      rename(c, 0.95, `element names are case-sensitive: '${c.name}'`);
      strongTargets.add(c.name);
      continue;
    }
    if (c.choice) {
      const stem = stemOf(c);
      if (bare === stem || lowerKey === stem.toLowerCase()) {
        const fit = shapes.indexOf(c.type || "");
        if (fit >= 0) rename(c, 0.92 - fit * 0.05, `'${stem}' is a choice element: name it by the value's type ('${c.name}')`);
        else rename(c, 0.4, `'${stem}' is a choice element (${stem}[x]); '${c.name}' is one of its typed names`);
        strongTargets.add(c.name);
        continue;
      }
      if (lowerKey.startsWith(stem.toLowerCase()) && bare.length > stem.length) {
        const sim = textSim(bare.slice(stem.length), c.type || "");
        if (sim >= 0.5) {
          rename(c, 0.55 + 0.35 * sim, `closest typed name of the choice element ${stem}[x]: '${c.name}'`);
          strongTargets.add(c.name);
          continue;
        }
      }
    }
    const sim = nameSim(bare, c.name);
    if (sim >= 0.6) {
      // A value whose shape cannot go into the element as is makes a near name less likely.
      const fit = await fitOf(value, c, level);
      rename(c, 0.9 * sim * (fit === "hard" ? 0.7 : fit === "soft" ? 0.85 : 1), `closest element name at this level: '${c.name}'`);
      strongTargets.add(c.name);
    }
  }
  // (2) Other levels: descendants (three levels down, datatype children included, choice values
  // that are present), ancestors (with their children two levels deep: sibling backbones / datatypes).
  const levelName = (l: Level): string => (l.prefix ? l.prefix : l.path);
  interface Hit {
    level: Level;
    child: Child;
    route: string;
  }
  // Breadth-first, so a type reached by several routes (Period under identifier and under period)
  // counts at its nearest one; `seen` is per type so each is reported once.
  const search = async (from: Level, maxDepth: number, seen: Set<string>): Promise<Hit[]> => {
    const hits: Hit[] = [];
    let frontier: Array<{ level: Level; depth: number }> = [{ level: from, depth: 0 }];
    while (frontier.length) {
      const next: typeof frontier = [];
      for (const { level: cur, depth } of frontier) {
        if (!cur.prefix) continue;
        const key2 = `${cur.sd.url}|${cur.prefix}`;
        if (seen.has(key2)) continue;
        seen.add(key2);
        const kids = childrenOf(cur.sd, cur.prefix);
        const stems = new Set<string>();
        for (const c of kids) {
          if (c.name.toLowerCase() === lowerKey) hits.push({ level: cur, child: c, route: cur.path });
          else if (c.choice && stemOf(c).toLowerCase() === lowerKey && !stems.has(c.elPath)) {
            // A choice stem at another level: the typed name the value fits (else the first).
            const typed = kids.filter((k) => k.elPath === c.elPath);
            const best = typed.find((k) => shapes.includes(k.type || "")) ?? typed[0];
            stems.add(c.elPath);
            hits.push({ level: cur, child: best, route: cur.path });
          }
        }
        if (depth === maxDepth) continue;
        for (const c of kids) {
          if (!c.type || isPrimitive(c.type) || c.type === "Extension" || c.type === "Reference" || c.type === "Resource" || isInfra(cur, c.name)) continue;
          const node = isObject(cur.node) ? cur.node[c.name] : undefined;
          if (c.choice && !isObject(Array.isArray(node) ? node[0] : node)) continue; // a choice type only when that typed value is present
          const indexed = Array.isArray(node) || (node === undefined && c.max !== "1" && c.max !== "0");
          const nl = await walker.descend(cur, c, Array.isArray(node) ? node[0] : node, `${cur.path}.${c.name}${indexed ? "[0]" : ""}`);
          if (nl) next.push({ level: nl, depth: depth + 1 });
        }
      }
      // Routes through values that are present come first (code.coding before an absent category.coding).
      frontier = next.sort((a, b) => Number(a.level.node === undefined) - Number(b.level.node === undefined));
    }
    return hits;
  };
  const moves: Array<{ level: Level; child: Child; dist: number }> = [];
  const seen = new Set<string>([`${level.sd.url}|${level.prefix}`]);
  for (const h of await search(level, 3, new Set())) {
    if (h.level === level || h.route === level.path) continue;
    moves.push({ level: h.level, child: h.child, dist: parsePath(h.route).length - parsePath(level.path).length });
  }
  for (let i = levels.length - 2; i >= 0 && i >= levels.length - 4; i--) {
    for (const h of await search(levels[i], 2, seen)) {
      if (h.route === level.path) continue;
      moves.push({ level: h.level, child: h.child, dist: levels.length - 1 - i + Math.max(0, parsePath(h.route).length - parsePath(levels[i].path).length) });
    }
  }
  const moved = new Set<string>();
  const absent = (l: Level): number => (l.node === undefined ? 1 : 0);
  for (const m of moves.sort((a, b) => a.dist - b.dist || absent(a.level) - absent(b.level) || (a.level.path < b.level.path ? -1 : 1))) {
    const target = `${m.level.path}.${pre}${m.child.name}`;
    if (moved.has(target)) continue;
    moved.add(target);
    const exact = m.child.name === bare;
    // A value whose JSON shape does not fit the target element's type is unlikely to belong there.
    const misfit = shapes.length > 0 && !!m.child.type && !m.child.type.startsWith("#") && !shapes.includes(m.child.type) && !(isPrimitive(m.child.type) && shapes.some(isPrimitive));
    out.push({
      value: target,
      kind: "move_property",
      confidence: ((exact ? 0.88 : 0.8) - 0.04 * Math.min(3, Math.max(0, m.dist - 1))) * (misfit ? 0.6 : 1),
      reason: m.child.choice && m.child.name !== bare ? `'${stemOf(m.child)}' is a choice element of ${levelName(m.level)}, not of ${levelName(level)}: '${m.child.name}' for this value` : `'${m.child.name}' is an element of ${levelName(m.level)}, not of ${levelName(level)}`,
      patch: { op: "move", from: `${issuePath}.${key}`, path: target },
    });
  }
  // (3) Same level, weaker: an absent sibling the name means (alias / short / synonyms) and the value fits.
  for (const c of sameLevel) {
    if (present.has(c.name) || strongTargets.has(c.name) || isInfra(level, c.name)) continue;
    const e = nameEvidence(bare, c);
    if (e < 0.55) continue;
    const fit = await fitOf(value, c, level);
    if (fit === "hard") continue;
    const conf = Math.min(0.66, 0.38 + 0.24 * e + 0.06 * textSim(bare, c.name) - (fit === "soft" ? 0.06 : 0));
    const why = c.alias.length ? `alias ${c.alias.map((a) => `'${a}'`).join(" / ")}` : c.short ? `"${c.short}"` : "its name";
    const how = fit === "fit" ? "the value fits its type" : fit === "soft" ? `the value must be restructured as ${c.type}` : "value shape unknown";
    rename(c, conf, `'${bare}' is not an element of ${levelName(level)}; '${c.name}' (${why}) means the same and ${how}`);
  }
  // (3b) Parent level, weaker (only when nothing exact was found): an absent element of the parent
  // the name means (`comment` under Dosage → MedicationRequest.note).
  const parent = levels.length >= 2 ? levels[levels.length - 2] : null;
  if (parent && parent.prefix && !strongTargets.size && !moved.size) {
    const parentPresent = new Set(isObject(parent.node) ? Object.keys(parent.node) : []);
    for (const c of childrenOf(parent.sd, parent.prefix)) {
      if (parentPresent.has(c.name) || isInfra(parent, c.name)) continue;
      const e = nameEvidence(bare, c);
      if (e < 0.75) continue;
      const fit = await fitOf(value, c, parent);
      if (fit === "hard") continue;
      const target = `${parent.path}.${pre}${c.name}`;
      const why = c.alias.length ? `alias ${c.alias.map((a) => `'${a}'`).join(" / ")}` : c.short ? `"${c.short}"` : "its name";
      out.push({
        value: target,
        kind: "move_property",
        confidence: Math.min(0.6, 0.34 + 0.2 * e + 0.06 * textSim(bare, c.name) - (fit === "soft" ? 0.06 : 0)),
        reason: `'${bare}' is not an element of ${levelName(level)}; '${c.name}' of ${levelName(parent)} (${why}) means the same${fit === "soft" ? ` (the value must be restructured as ${c.type})` : ""}`,
        patch: { op: "move", from: `${issuePath}.${key}`, path: target },
      });
    }
  }
  // (4) Nothing plausible: remove, telling which names exist here and which resources carry the name.
  if (!strongTargets.size && !moved.size) {
    let carriers = "";
    if (deps.resourceElementPaths) {
      const table = (await deps.resourceElementPaths().catch(() => null)) || [];
      const tail = "." + bare;
      const top: string[] = [];
      const nested: string[] = [];
      for (const r of table) {
        if (r.paths.includes(`${r.type}${tail}`)) top.push(r.type);
        else {
          const p = r.paths.find((x) => x.endsWith(tail) && !x.endsWith("[x]"));
          if (p) nested.push(p);
        }
      }
      const list = [...top.sort(), ...nested.sort()];
      if (list.length) carriers = `; '${bare}' is an element of ${list.slice(0, 6).join(", ")}${list.length > 6 ? ` and ${list.length - 6} more` : ""}`;
    }
    out.push({
      value: key,
      kind: "remove_property",
      confidence: out.length ? 0.4 : 0.5,
      reason: `no element named '${bare}' on ${levelName(level)} or its ancestors / descendants${carriers}; the FHIR R4 elements of ${levelName(level)} are: ${elementList(level, sameLevel, 14)}`,
      patch: { op: "remove", path: `${issuePath}.${key}` },
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
