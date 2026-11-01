/**
 * Minimal XML reader + FHIR XML → JSON converter for the FHIRPath parity runner
 * (the official R4 test suite ships several of its inputs as XML only).
 *
 * The converter is driven by the R4 core StructureDefinitions (snapshot
 * cardinality → arrays, element types → primitive JSON types, contentReference,
 * choice elements, nested resources, primitive id / extension → `_name`).
 * Test tooling only — the validator itself only ever sees JSON.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface XmlEl {
  name: string; // local name (prefix stripped)
  ns: string | null;
  attrs: Record<string, string>;
  children: XmlEl[];
  text: string;
  raw: string; // the element's own source text
}

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

/** Parse an XML document; returns the root element. */
export function parseXml(src: string): XmlEl {
  let i = 0;
  const stack: { el: XmlEl; start: number; nsMap: Record<string, string> }[] = [];
  let root: XmlEl | null = null;
  const nsOf = (qname: string, nsMap: Record<string, string>): [string, string | null] => {
    const k = qname.indexOf(":");
    const prefix = k >= 0 ? qname.slice(0, k) : "";
    return [k >= 0 ? qname.slice(k + 1) : qname, nsMap[prefix] ?? null];
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (stack.length && lt > i) stack[stack.length - 1].el.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      i = src.indexOf("-->", lt) + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      if (stack.length) stack[stack.length - 1].el.text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) {
      i = src.indexOf(">", lt) + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const gt = src.indexOf(">", lt);
      const top = stack.pop()!;
      top.el.raw = src.slice(top.start, gt + 1);
      i = gt + 1;
      continue;
    }
    // start tag: find the closing '>' outside quotes
    let j = lt + 1;
    let q: string | null = null;
    while (j < src.length) {
      const c = src[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
      j++;
    }
    const body = src.slice(lt + 1, j);
    const selfClose = body.endsWith("/");
    const inner = selfClose ? body.slice(0, -1) : body;
    const m = /^([^\s/>]+)/.exec(inner)!;
    const qname = m[1];
    const rawAttrs: Record<string, string> = {};
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = inner.slice(qname.length);
    while ((a = re.exec(rest))) rawAttrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? "");
    const parentNs = stack.length ? stack[stack.length - 1].nsMap : {};
    const nsMap = { ...parentNs };
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (k === "xmlns") nsMap[""] = v;
      else if (k.startsWith("xmlns:")) nsMap[k.slice(6)] = v;
    }
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawAttrs)) if (k !== "xmlns" && !k.startsWith("xmlns:")) attrs[k.includes(":") ? k.slice(k.indexOf(":") + 1) : k] = v;
    const [name, ns] = nsOf(qname, nsMap);
    const el: XmlEl = { name, ns, attrs, children: [], text: "", raw: "" };
    if (stack.length) stack[stack.length - 1].el.children.push(el);
    else root = el;
    if (selfClose) el.raw = src.slice(lt, j + 1);
    else stack.push({ el, start: lt, nsMap });
    i = j + 1;
  }
  if (!root) throw new Error("no root element");
  return root;
}

// ---------------------------------------------------------------- FHIR XML → JSON

const NUMERIC = new Set(["integer", "decimal", "positiveInt", "unsignedInt", "integer64"]);

export class FhirXmlConverter {
  private sds = new Map<string, any>();
  constructor(private readonly packageDir: string) {}

  private sd(type: string): any {
    if (!this.sds.has(type)) {
      const f = join(this.packageDir, `StructureDefinition-${type}.json`);
      this.sds.set(type, existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
    }
    return this.sds.get(type);
  }

  private element(sd: any, path: string): any {
    return (sd.snapshot.element as any[]).find((e) => e.path === path);
  }

  /** Locate the definition of child `name` under `path` of `sd`; returns [ed, typeCode]. */
  private child(sd: any, path: string, name: string): [any, string] | null {
    const direct = this.element(sd, `${path}.${name}`);
    if (direct) return [direct, direct.contentReference ? "#" : typeCodeOf(direct.type?.[0])];
    for (const e of sd.snapshot.element as any[]) {
      if (!e.path.endsWith("[x]")) continue;
      const stem = e.path.slice(0, -3);
      if (!stem.startsWith(path + ".") || stem.slice(path.length + 1).includes(".")) continue;
      const short = stem.slice(path.length + 1);
      if (!name.startsWith(short)) continue;
      const suffix = name.slice(short.length);
      const t = (e.type as any[]).find((t) => t.code[0].toUpperCase() + t.code.slice(1) === suffix);
      if (t) return [e, typeCodeOf(t)];
    }
    return null;
  }

  convertResource(el: XmlEl): Record<string, any> {
    const out: Record<string, any> = { resourceType: el.name };
    const sd = this.sd(el.name);
    if (!sd) throw new Error(`unknown resource type ${el.name}`);
    this.fill(out, el, sd, el.name);
    return out;
  }

  private fill(out: Record<string, any>, el: XmlEl, sd: any, path: string): void {
    // attributes that are elements in JSON (Element.id, Extension.url)
    if (el.attrs.id !== undefined) out.id = el.attrs.id;
    if (el.attrs.url !== undefined) out.url = el.attrs.url;
    for (const c of el.children) {
      const found = this.child(sd, path, c.name);
      if (!found) throw new Error(`unknown element ${path}.${c.name}`);
      let [ed, code] = found;
      const isArray = ed.max !== "1" && ed.max !== "0";
      let value: any;
      let primExt: any = null;
      if (code === "#") {
        const target = ed.contentReference.replace(/^.*#/, "");
        value = {};
        this.fill(value, c, sd, target);
      } else if (code === "xhtml") {
        value = c.raw;
      } else if (code === "Resource" || code === "DomainResource" || this.isResourceType(code)) {
        const r = c.children[0];
        value = this.convertResource(r);
      } else if (/^[a-z]/.test(code)) {
        if (c.attrs.value !== undefined) value = primitiveJson(code, c.attrs.value);
        else value = null;
        if (c.attrs.id !== undefined || c.children.length) {
          primExt = {};
          if (c.attrs.id !== undefined) primExt.id = c.attrs.id;
          const ext = c.children.filter((x) => x.name === "extension").map((x) => this.complex(x, "Extension"));
          if (ext.length) primExt.extension = ext;
        }
      } else if (code === "BackboneElement" || code === "Element") {
        value = {};
        this.fill(value, c, sd, ed.path.replace(/\[x\]$/, ""));
      } else {
        value = this.complex(c, code);
      }
      const key = c.name;
      if (isArray) {
        const arr = (out[key] ??= []);
        const idx = arr.length;
        arr.push(value);
        if (primExt) {
          const parr = (out["_" + key] ??= []);
          while (parr.length < idx) parr.push(null);
          parr[idx] = primExt;
        }
      } else {
        if (value !== null) out[key] = value;
        if (primExt) out["_" + key] = primExt;
      }
    }
    // pad primitive-extension arrays and drop all-null value arrays
    for (const k of Object.keys(out)) {
      if (!k.startsWith("_") || !Array.isArray(out[k])) continue;
      const base = k.slice(1);
      while (out[k].length < (out[base]?.length ?? 0)) out[k].push(null);
      if (Array.isArray(out[base]) && out[base].every((v: any) => v === null)) delete out[base];
    }
  }

  private complex(el: XmlEl, type: string): Record<string, any> {
    const sd = this.sd(type);
    if (!sd) throw new Error(`unknown type ${type}`);
    const out: Record<string, any> = {};
    this.fill(out, el, sd, type);
    return out;
  }

  private isResourceType(code: string): boolean {
    const sd = /^[A-Z]/.test(code) ? this.sd(code) : null;
    return !!sd && sd.kind === "resource";
  }
}

function typeCodeOf(t: any): string {
  const code: string = t?.code ?? "string";
  if (code.startsWith("http://hl7.org/fhirpath/System.")) {
    const ext = (t.extension ?? []).find((e: any) => e.url?.endsWith("structuredefinition-fhir-type"));
    return ext?.valueUrl ?? ext?.valueUri ?? "string";
  }
  return code;
}

function primitiveJson(code: string, v: string): any {
  if (code === "boolean") return v === "true";
  if (NUMERIC.has(code)) return Number(v);
  return v;
}
