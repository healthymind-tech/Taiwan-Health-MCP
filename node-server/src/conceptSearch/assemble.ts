/**
 * Turn a CodeSystem resource (+ its supplements) into searchable concepts (pure, no I/O).
 *
 * - walks nested `concept.concept` (fhir.concepts keeps only part of some systems);
 * - display + every designation, any language (TW Core ships English designations that
 *   fhir.concepts drops);
 * - FHIR R4 supplements (`content = supplement`, `supplements = url[|version]`): their
 *   displays/designations become designations of the base concept, their properties merge;
 * - string properties become low-weight `property` terms (e.g. an ingredient list);
 * - Coding-valued properties are returned as links for the caller to resolve into names
 *   (LOINC component, SNOMED term, the coding's own display);
 * - short definitions become low-weight `definition` terms;
 * - `info.category` from a declared categorical property, else the parent concept's display.
 */

import { guessLang, normalizeText } from "./text.js";
import type { TermInput } from "./engine.js";

export interface LinkCoding {
  system: string | null;
  code: string;
  display: string | null;
  via: string; // property code or "conceptmap:<url>"
}

export interface AssembledConcept {
  code: string;
  display: string | null;
  terms: TermInput[];
  info: Record<string, unknown>;
  links: LinkCoding[];
}

export interface SupplementRef {
  url: string;
  version: string | null;
  resource: Record<string, any>;
}

const DEFINITION_MAX = 120;
const PROPERTY_MAX = 200;
const SKIP_PROPERTIES = /^(status|effectivedate|retirementdate|deprecated|deprecationdate|inactive|notselectable|parent|child|subsumedby|itemweight|order|comment|comments|use)$/i;
const CATEGORY_PROP = /categor|class|group|kind|type|section|chapter|分類|類別|類型|章|節/i;

/** Does a supplement apply to this CodeSystem (canonical, optional "|version")? */
export function supplementApplies(supplements: string | null | undefined, csUrl: string, csVersion: string | null): boolean {
  if (!supplements) return false;
  const [url, ver] = String(supplements).split("|");
  if (url !== csUrl) return false;
  return !ver || !csVersion || ver === csVersion;
}

function propValue(p: Record<string, any>): { kind: "string" | "coding" | "other"; value: any } {
  for (const [k, v] of Object.entries(p)) {
    if (!k.startsWith("value")) continue;
    if (k === "valueCoding" && v && typeof v === "object") return { kind: "coding", value: v };
    if (k === "valueString" || k === "valueCode") return { kind: "string", value: v };
    return { kind: "other", value: v };
  }
  return { kind: "other", value: null };
}

interface Flat {
  code: string;
  display: string | null;
  definition: string | null;
  designations: Array<{ language: string | null; value: string }>;
  properties: Array<Record<string, any>>;
  parents: string[];
}

function flatten(cs: Record<string, any>): Map<string, Flat> {
  const out = new Map<string, Flat>();
  const visit = (list: any[], parent: string | null): void => {
    for (const raw of list || []) {
      if (!raw || typeof raw !== "object" || raw.code === undefined || raw.code === null) continue;
      const code = String(raw.code);
      let f = out.get(code);
      if (!f) {
        f = { code, display: null, definition: null, designations: [], properties: [], parents: [] };
        out.set(code, f);
      }
      if (raw.display != null && f.display === null) f.display = String(raw.display);
      if (raw.definition != null && f.definition === null) f.definition = String(raw.definition);
      for (const d of raw.designation || []) {
        if (d && d.value != null) f.designations.push({ language: typeof d.language === "string" ? d.language : null, value: String(d.value) });
      }
      for (const p of raw.property || []) if (p && p.code) f.properties.push(p);
      if (parent && !f.parents.includes(parent)) f.parents.push(parent);
      if (Array.isArray(raw.concept)) visit(raw.concept, code);
    }
  };
  visit(cs.concept || [], null);
  // Explicit `parent` properties (flat hierarchies).
  for (const f of out.values()) {
    for (const p of f.properties) {
      if (p.code === "parent") {
        const v = propValue(p).value;
        const pc = typeof v === "object" && v ? v.code : v;
        if (pc != null && !f.parents.includes(String(pc))) f.parents.push(String(pc));
      }
    }
  }
  return out;
}

function declaredProps(cs: Record<string, any>): Map<string, { type: string | null; description: string; uri: string }> {
  const m = new Map<string, { type: string | null; description: string; uri: string }>();
  for (const p of cs.property || []) {
    if (p && p.code) m.set(String(p.code), { type: p.type ? String(p.type) : null, description: String(p.description || ""), uri: String(p.uri || "") });
  }
  return m;
}

function looksLikeValue(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > PROPERTY_MAX) return false;
  if (/^[\d\s.:/-]+$/.test(t)) return false; // numbers, dates
  if (/^(true|false|active|inactive|retired|draft)$/i.test(t)) return false;
  return /[\p{L}]/u.test(t);
}

/** Assemble searchable concepts from a CodeSystem and the supplements that apply to it. */
export function assembleCodeSystem(cs: Record<string, any>, supplements: SupplementRef[] = []): AssembledConcept[] {
  const base = flatten(cs);
  const csLang = typeof cs.language === "string" ? cs.language : null;
  const props = declaredProps(cs);
  const sups = supplements.map((s) => ({
    ref: s,
    lang: typeof s.resource.language === "string" ? s.resource.language : null,
    flat: flatten(s.resource),
    props: declaredProps(s.resource),
  }));
  for (const s of sups) for (const [k, v] of s.props) if (!props.has(k)) props.set(k, v);

  const out: AssembledConcept[] = [];
  for (const f of base.values()) {
    const terms: TermInput[] = [];
    const links: LinkCoding[] = [];
    const info: Record<string, unknown> = {};
    const seen = new Set<string>();
    const addTerm = (text: string | null | undefined, lang: string | null, kind: TermInput["kind"], source: string): void => {
      if (!text) return;
      const key = `${kind === "display" ? "designation" : kind}|${normalizeText(text)}`;
      if (!normalizeText(text) || seen.has(key)) return;
      seen.add(key);
      terms.push({ text: String(text), lang: lang || guessLang(String(text)), kind, source });
    };
    addTerm(f.display, csLang, "display", "codesystem");
    for (const d of f.designations) addTerm(d.value, d.language, "designation", "codesystem");
    const allProps: Array<{ p: Record<string, any>; source: string }> = f.properties.map((p) => ({ p, source: "codesystem" }));
    for (const s of sups) {
      const sf = s.flat.get(f.code);
      if (!sf) continue;
      const src = `supplement:${s.ref.url}${s.ref.version ? `|${s.ref.version}` : ""}`;
      addTerm(sf.display, s.lang, "designation", src);
      for (const d of sf.designations) addTerm(d.value, d.language || s.lang, "designation", src);
      for (const p of sf.properties) allProps.push({ p, source: src });
    }
    for (const { p, source } of allProps) {
      const code = String(p.code);
      if (SKIP_PROPERTIES.test(code)) continue;
      const decl = props.get(code);
      const v = propValue(p);
      const categorical = CATEGORY_PROP.test(code) || CATEGORY_PROP.test(decl?.description || "");
      if (v.kind === "coding") {
        const c = v.value as Record<string, any>;
        if (c.code == null) continue;
        links.push({ system: c.system ? String(c.system) : null, code: String(c.code), display: c.display ? String(c.display) : null, via: code });
        if (categorical && info.category === undefined) info.category = c.display || c.code;
      } else if (v.kind === "string" && typeof v.value === "string") {
        const sv = v.value;
        // A code-typed value that names a LOINC code (e.g. property "loinc" valueCode).
        if (/^\d{1,7}-\d$/.test(sv.trim()) && /loinc/i.test(`${code} ${decl?.uri || ""}`)) {
          links.push({ system: "http://loinc.org", code: sv.trim(), display: null, via: code });
          continue;
        }
        if (categorical && info.category === undefined && looksLikeValue(sv)) info.category = sv;
        if ((decl?.type ?? "string") === "string" && looksLikeValue(sv)) addTerm(sv, null, "property", `${source}#${code}`);
      }
    }
    if (f.definition && f.definition.length <= DEFINITION_MAX) {
      const nd = normalizeText(f.definition);
      if (nd && nd !== normalizeText(f.display)) addTerm(f.definition, csLang, "definition", "codesystem");
    }
    if (f.parents.length) {
      info.parents = f.parents.slice(0, 5);
      if (info.category === undefined) {
        const pd = base.get(f.parents[0])?.display;
        if (pd) info.category = pd;
      }
    }
    out.push({ code: f.code, display: f.display ?? terms.find((t) => t.kind === "designation")?.text ?? null, terms, info, links });
  }
  return out;
}

/**
 * ConceptMap links: for every group whose `source` is `csUrl`, element.code → target codings.
 */
export function conceptMapLinks(conceptMaps: Iterable<Record<string, any>>, csUrl: string): Map<string, LinkCoding[]> {
  const out = new Map<string, LinkCoding[]>();
  for (const cm of conceptMaps) {
    for (const g of cm.group || []) {
      if (String(g.source || "").split("|")[0] !== csUrl) continue;
      for (const el of g.element || []) {
        if (el?.code == null) continue;
        for (const t of el.target || []) {
          if (t?.code == null) continue;
          if (t.equivalence === "unmatched" || t.equivalence === "disjoint") continue;
          const list = out.get(String(el.code)) || [];
          if (list.length >= 12) continue;
          list.push({ system: g.target ? String(g.target) : null, code: String(t.code), display: t.display ? String(t.display) : null, via: `conceptmap:${cm.url || cm.id || ""}` });
          out.set(String(el.code), list);
        }
      }
    }
  }
  return out;
}
