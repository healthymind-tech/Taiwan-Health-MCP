/**
 * Minimal FHIR R4 XML → JSON reader for the offline test-case runners (scripts only, never the
 * server). The XML is parsed by a small non-validating parser (elements, attributes, text,
 * comments, CDATA, processing instructions, the five XML entities + numeric references); the
 * JSON shape (arrays, primitive JSON types, `_name` primitive siblings, contained / Bundle
 * resources, xhtml div) is decided from the R4 core StructureDefinition snapshots supplied by
 * `sdOf`.
 */

type Json = Record<string, any>;

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** raw source of the element (for xhtml) */
  raw: string;
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e];
  });
}

export function parseXml(src: string): XNode {
  src = src.replace(/^﻿/, "");
  let i = 0;
  const stack: XNode[] = [];
  const starts: number[] = [];
  let root: XNode | null = null;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (src.startsWith("<!--", lt)) {
      i = src.indexOf("-->", lt) + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      i = src.indexOf("?>", lt) + 2;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      i = src.indexOf("]]>", lt) + 3;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      i = src.indexOf(">", lt) + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const gt = src.indexOf(">", lt);
      const node = stack.pop()!;
      node.raw = src.slice(starts.pop()!, gt + 1);
      i = gt + 1;
      continue;
    }
    // start tag
    let j = lt + 1;
    while (j < src.length && !/[\s/>]/.test(src[j])) j++;
    const tag = src.slice(lt + 1, j);
    const attrs: Record<string, string> = {};
    for (;;) {
      while (/\s/.test(src[j])) j++;
      if (src[j] === "/" || src[j] === ">") break;
      let k = j;
      while (!/[\s=]/.test(src[k])) k++;
      const name = src.slice(j, k);
      while (src[k] !== '"' && src[k] !== "'") k++;
      const q = src[k];
      const end = src.indexOf(q, k + 1);
      attrs[name] = decode(src.slice(k + 1, end));
      j = end + 1;
    }
    const node: XNode = { tag: tag.includes(":") ? tag.split(":")[1] : tag, attrs, children: [], raw: "" };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root ??= node;
    if (src[j] === "/") {
      node.raw = src.slice(lt, j + 2);
      i = j + 2;
    } else {
      stack.push(node);
      starts.push(lt);
      i = j + 1;
    }
  }
  if (!root) throw new Error("no XML root element");
  return root;
}

export type SdLookup = (type: string) => Json | null;

const SYSTEM_TYPES: Record<string, string> = {
  "http://hl7.org/fhirpath/System.String": "string",
  "http://hl7.org/fhirpath/System.Boolean": "boolean",
  "http://hl7.org/fhirpath/System.Integer": "integer",
  "http://hl7.org/fhirpath/System.Decimal": "decimal",
  "http://hl7.org/fhirpath/System.Date": "date",
  "http://hl7.org/fhirpath/System.DateTime": "dateTime",
  "http://hl7.org/fhirpath/System.Time": "time",
};

function typeCode(t: Json): string {
  const ext = (t.extension || []).find((e: Json) => e.url === "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type");
  if (ext) return ext.valueUrl ?? ext.valueUri;
  return SYSTEM_TYPES[t.code] ?? t.code;
}

const isPrimitive = (t: string): boolean => /^[a-z]/.test(t) && t !== "xhtml";

function primitiveValue(t: string, v: string): unknown {
  if (t === "boolean") return v === "true" ? true : v === "false" ? false : v;
  if (t === "integer" || t === "unsignedInt" || t === "positiveInt" || t === "decimal") {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : v;
  }
  return v;
}

export class XmlToJson {
  private idx = new Map<string, Map<string, Json>>();
  constructor(private readonly sdOf: SdLookup) {}

  private elements(type: string): Map<string, Json> | null {
    if (!this.idx.has(type)) {
      const sd = this.sdOf(type);
      const m = new Map<string, Json>();
      for (const e of sd?.snapshot?.element || []) if (!e.sliceName && !String(e.id ?? "").includes(":")) m.set(e.path, e);
      this.idx.set(type, sd ? m : (null as any));
    }
    return this.idx.get(type) ?? null;
  }

  resource(node: XNode): Json {
    const out: Json = { resourceType: node.tag };
    this.complex(node, node.tag, node.tag, out);
    return out;
  }

  private complex(node: XNode, type: string, path: string, out: Json): void {
    const els = this.elements(type);
    for (const c of node.children) {
      const name = c.tag;
      let ed = els?.get(`${path}.${name}`);
      let t: string | null = null;
      if (!ed && els) {
        for (const [p, e] of els) {
          if (!p.endsWith("[x]") || p.lastIndexOf(".") !== path.length || !p.startsWith(path + ".")) continue;
          const base = p.slice(path.length + 1, -3);
          if (!name.startsWith(base)) continue;
          const suffix = name.slice(base.length);
          const tt = (e.type || []).map(typeCode).find((x: string) => x.toLowerCase() === suffix.toLowerCase());
          if (tt) {
            ed = e;
            t = tt;
            break;
          }
        }
      }
      if (name === "extension" || name === "modifierExtension") t = "Extension";
      let ownType = type;
      let ownPath = `${path}.${name}`;
      if (ed?.contentReference) {
        ownPath = String(ed.contentReference).replace(/^.*#/, "");
        ed = els?.get(ownPath) ?? ed;
      }
      if (!t) t = ed?.type?.length ? typeCode(ed.type[0]) : "string";
      const array = name === "extension" || name === "modifierExtension" ? true : ed ? ed.max !== "1" && ed.max !== "0" : false;
      let value: unknown;
      let prim: Json | null = null;
      if (t === "xhtml") {
        value = c.raw;
      } else if (isPrimitive(t!)) {
        value = c.attrs.value !== undefined ? primitiveValue(t!, c.attrs.value) : null;
        const ext: Json = {};
        if (c.attrs.id) ext.id = c.attrs.id;
        if (c.children.length) this.complex(c, "Element", "Element", ext);
        if (Object.keys(ext).length) prim = ext;
      } else if (t === "Resource" || t === "DomainResource" || (ed && /^[A-Z]/.test(t!) && this.isResourceType(t!) && c.children.length === 1 && c.children[0].tag === t)) {
        value = c.children[0] ? this.resource(c.children[0]) : {};
      } else {
        const obj: Json = {};
        if (c.attrs.id) obj.id = c.attrs.id;
        if (c.attrs.url) obj.url = c.attrs.url;
        if (t === "BackboneElement" || t === "Element") this.complex(c, ownType, ownPath, obj);
        else this.complex(c, t!, t!, obj);
        value = obj;
      }
      const key = t && ed && String(ed.path).endsWith("[x]") ? name : name;
      if (array) {
        const arr: unknown[] = (out[key] ??= []);
        arr.push(value);
        if (prim || (isPrimitive(t!) && out[`_${key}`])) {
          const parr: unknown[] = (out[`_${key}`] ??= []);
          while (parr.length < arr.length - 1) parr.push(null);
          parr.push(prim);
        }
      } else {
        if (value !== null) out[key] = value;
        if (prim) out[`_${key}`] = prim;
      }
    }
    for (const k of Object.keys(out)) {
      if (k.startsWith("_") && Array.isArray(out[k])) {
        const base = out[k.slice(1)] as unknown[];
        while ((out[k] as unknown[]).length < base.length) (out[k] as unknown[]).push(null);
      }
      if (Array.isArray(out[k]) && !k.startsWith("_") && out[`_${k}`] === undefined) {
        // primitive arrays without any value-less entry are fine; strip nulls only when no `_` sibling
        if ((out[k] as unknown[]).some((v) => v === null)) out[k] = (out[k] as unknown[]).filter((v) => v !== null);
      }
    }
  }

  private isResourceType(t: string): boolean {
    const sd = this.sdOf(t);
    return !!sd && sd.kind === "resource";
  }
}
