/**
 * Minimal FHIR R4 XML → JSON converter for the offline parity runners (fhir-test-cases inputs are partly XML; the
 * builtin validator reads JSON only). Dependency-free: a small XML tokenizer plus the StructureDefinitions of the
 * package cache for cardinality (array or not), primitive JSON types and choice / contentReference elements. Not a
 * conformance parser — unknown elements are kept as best as possible so the validator can report them.
 */

type Json = Record<string, any>;

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** raw inner XML (only kept for xhtml div) */
  raw?: string;
  start: number;
}

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/gu, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

/** Parse an XML document into an element tree (comments / PIs / text outside div dropped). */
export function parseXml(src: string): XNode {
  let i = 0;
  const stack: XNode[] = [];
  let root: XNode | null = null;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const e = src.indexOf("?>", i);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      const e = src.indexOf(">", i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (src[i + 1] === "/") {
      const e = src.indexOf(">", i);
      stack.pop();
      i = e + 1;
      continue;
    }
    // start tag
    const m = /^<([A-Za-z_][\w.:-]*)/u.exec(src.slice(i, i + 200));
    if (!m) {
      i++;
      continue;
    }
    let j = i + m[0].length;
    const attrs: Record<string, string> = {};
    const attrRe = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/uy;
    for (;;) {
      attrRe.lastIndex = j;
      const a = attrRe.exec(src);
      if (!a) break;
      attrs[a[1]] = decode(a[3] ?? a[4] ?? "");
      j = attrRe.lastIndex;
    }
    while (j < n && /\s/u.test(src[j])) j++;
    const selfClose = src[j] === "/";
    const gt = src.indexOf(">", j);
    const local = m[1].includes(":") ? m[1].slice(m[1].indexOf(":") + 1) : m[1];
    const node: XNode = { name: local, attrs, children: [], start: i };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    i = gt + 1;
    if (selfClose) continue;
    if (local === "div" && (attrs.xmlns === "http://www.w3.org/1999/xhtml" || stack.length)) {
      // raw xhtml: find the matching </div> (nested divs counted)
      let depth = 1;
      let k = i;
      const re = /<(\/?)(?:[A-Za-z_][\w.-]*:)?div\b[^>]*?(\/?)>/gu;
      re.lastIndex = i;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(src))) {
        if (mm[1]) depth--;
        else if (!mm[2]) depth++;
        if (depth === 0) {
          k = mm.index;
          break;
        }
      }
      node.raw = src.slice(i, k);
      i = k + src.slice(k).indexOf(">") + 1;
      continue;
    }
    stack.push(node);
  }
  if (!root) throw new Error("no root element");
  return root;
}

export interface SdSource {
  sd(type: string): Json | null;
}

const NUMERIC = new Set(["integer", "decimal", "positiveInt", "unsignedInt"]);

function isPrimitiveType(t: string): boolean {
  return /^[a-z]/u.test(t) || t.startsWith("http://hl7.org/fhirpath/System.");
}

function primitiveJson(t: string, v: string): unknown {
  if (t === "boolean") return v === "true" ? true : v === "false" ? false : v;
  if (NUMERIC.has(t) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(v)) return Number(v);
  return v;
}

interface Located {
  ed: Json | null;
  type: string;
  /** SD + path to resolve the children with */
  sd: Json | null;
  path: string;
}

export class FhirXmlConverter {
  private idx = new Map<Json, Map<string, Json>>();
  constructor(private readonly src: SdSource) {}

  private index(sd: Json): Map<string, Json> {
    let m = this.idx.get(sd);
    if (!m) {
      m = new Map();
      for (const e of sd.snapshot?.element ?? []) if (!e.sliceName && !m.has(e.path)) m.set(e.path, e);
      this.idx.set(sd, m);
    }
    return m;
  }

  private locate(sd: Json | null, path: string, name: string): Located {
    if (!sd) return { ed: null, type: "", sd: null, path: name };
    const m = this.index(sd);
    let ed = m.get(`${path}.${name}`) ?? null;
    let type = "";
    if (ed) {
      type = ed.type?.length === 1 ? String(ed.type[0].code) : "";
    } else {
      for (const [p, e] of m) {
        if (!p.endsWith("[x]")) continue;
        const stem = p.slice(path.length + 1, -3);
        if (p.slice(0, path.length + 1) !== `${path}.` || stem.includes(".") || !name.startsWith(stem) || name.length === stem.length) continue;
        const suffix = name.slice(stem.length);
        const t = (e.type ?? []).map((x: Json) => String(x.code)).find((c: string) => c.toLowerCase() === suffix.toLowerCase());
        if (t) {
          ed = e;
          type = t;
          break;
        }
      }
    }
    if (!ed) return { ed: null, type: "", sd: null, path: `${path}.${name}` };
    if (ed.contentReference) {
      const target = String(ed.contentReference).replace(/^.*#/u, "");
      const ted = m.get(target);
      return { ed, type: ted?.type?.[0]?.code ?? "BackboneElement", sd, path: target };
    }
    if (type === "BackboneElement" || type === "Element" || (!type && ed.type?.length !== 1)) {
      return { ed, type: type || "Element", sd, path: ed.path };
    }
    if (type.startsWith("http://hl7.org/fhirpath/System.")) return { ed, type: "string", sd: null, path: "" };
    if (isPrimitiveType(type)) return { ed, type, sd: null, path: "" };
    return { ed, type, sd: this.src.sd(type), path: type };
  }

  resource(x: XNode): Json {
    const sd = this.src.sd(x.name);
    const out: Json = { resourceType: x.name };
    this.fill(out, x, sd, x.name);
    return out;
  }

  private fill(out: Json, x: XNode, sd: Json | null, path: string): void {
    const groups = new Map<string, XNode[]>();
    for (const c of x.children) {
      const g = groups.get(c.name) ?? [];
      g.push(c);
      groups.set(c.name, g);
    }
    for (const [name, nodes] of groups) {
      const loc = this.locate(sd, path, name);
      const max = loc.ed ? String(loc.ed.base?.max ?? loc.ed.max ?? "*") : nodes.length > 1 ? "*" : "1";
      const isArray = max !== "1" && max !== "0";
      if (name === "div" && nodes[0].raw !== undefined) {
        out.div = this.div(nodes[0]);
        continue;
      }
      if (loc.type && isPrimitiveType(loc.type)) {
        const vals: unknown[] = [];
        const exts: Array<Json | null> = [];
        for (const nd of nodes) {
          vals.push(nd.attrs.value !== undefined ? primitiveJson(loc.type, nd.attrs.value) : null);
          const e: Json = {};
          if (nd.attrs.id !== undefined) e.id = nd.attrs.id;
          if (nd.children.length) this.fill(e, nd, this.src.sd("Element"), "Element");
          exts.push(Object.keys(e).length ? e : null);
        }
        if (isArray) {
          if (vals.some((v) => v !== null)) out[name] = vals;
          if (exts.some((e) => e !== null)) out[`_${name}`] = exts;
        } else {
          if (vals[0] !== null) out[name] = vals[0];
          if (exts[0] !== null) out[`_${name}`] = exts[0];
        }
        continue;
      }
      const items = nodes.map((nd) => this.complex(nd, loc));
      out[name] = isArray ? items : items[0];
    }
  }

  private complex(nd: XNode, loc: Located): Json {
    if (loc.type === "Resource" || (!loc.ed && nd.children.length === 1 && /^[A-Z]/u.test(nd.children[0].name))) {
      const inner = nd.children.find((c) => /^[A-Z]/u.test(c.name));
      return inner ? this.resource(inner) : {};
    }
    const o: Json = {};
    if (nd.attrs.id !== undefined) o.id = nd.attrs.id;
    if (nd.attrs.url !== undefined) o.url = nd.attrs.url;
    this.fill(o, nd, loc.sd, loc.path);
    return o;
  }

  private div(nd: XNode): string {
    const attrs = Object.entries(nd.attrs)
      .map(([k, v]) => ` ${k}="${v.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;")}"`)
      .join("");
    return `<div${attrs}>${nd.raw ?? ""}</div>`;
  }
}

export function xmlToFhirJson(src: string, sds: SdSource): Json {
  return new FhirXmlConverter(sds).resource(parseXml(src));
}
