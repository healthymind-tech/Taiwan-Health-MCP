/**
 * FHIR R4 XML → JSON reader for the in-process validator: a port of the parse-time behaviour of
 * org.hl7.fhir.r5.elementmodel.XmlParser (HL7 validator_cli 7.0.1, policy EVERYTHING) on top of a small
 * dependency-free, namespace-aware XML reader.
 *
 * The element model (cardinality → arrays, primitive JSON types, choice / contentReference / nested resources,
 * primitive id / extension → `_name`, xhtml div serialisation like XhtmlParser.parseHtmlNode) is driven by the
 * StructureDefinitions the ValidatorResolver serves. Next to the JSON resource it returns the issues Java reports
 * while parsing, with Java's wording and locations (XML paths `/f:Patient/f:name`, the FHIRPath element path for
 * the order check):
 *   - XML well-formedness (fatal, location "(xml)"), DOCTYPE (disallow-doctype-decl), undeclared entities,
 *   - checkHeader (XML_ENCODING_INVALID), processing instructions (No_processing_instructions_allowed_in_resources /
 *     Node_type__is_not_allowed), CDATA (CDATA_is_not_allowed),
 *   - root element namespace / name (This__cannot_be_parsed_as_a_FHIR_object_no_namespace,
 *     This_does_not_appear_to_be_a_FHIR_resource_unknown_namespacename_),
 *   - checkElement: Element_must_have_some_content, Wrong_namespace__expected_, XSI_TYPE_UNNECESSARY / XSI_TYPE_WRONG,
 *   - parseChildren: Text_should_not_be_present, XML_ATTR_VALUE_INVALID, Undefined_attribute__on__for_type__properties__,
 *     Undefined_element_, No_type_found_on_,
 *   - parseResource: Contained_resource_does_not_appear_to_be_a_FHIR_resource_unknown_name_,
 *   - InstanceValidator.checkChildren's XML-only order rule (Validation_VAL_Profile_OutOfOrder, JSON property order is
 *     never checked) — evaluated here against the base definitions (the type that defines the children), since the
 *     JSON handed to the validator no longer carries document order.
 */
import type { Issue } from "./fhirValidator.js";

type Json = Record<string, any>;

export const FHIR_NS = "http://hl7.org/fhir";
export const XHTML_NS = "http://www.w3.org/1999/xhtml";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const SD_BASE = "http://hl7.org/fhir/StructureDefinition/";

// ---------------------------------------------------------------------------------------------- XML reader

export interface XAttr {
  qname: string;
  local: string;
  prefix: string | null;
  ns: string | null;
  value: string;
}

export type XNode =
  | XElement
  | { type: "text"; text: string; line: number; col: number }
  | { type: "cdata"; text: string; line: number; col: number }
  | { type: "comment"; text: string; line: number; col: number }
  | { type: "pi"; target: string; data: string; line: number; col: number }
  | { type: "doctype"; text: string; line: number; col: number };

export interface XElement {
  type: "element";
  qname: string;
  local: string;
  prefix: string | null;
  ns: string | null;
  attrs: XAttr[];
  children: XNode[];
  line: number;
  col: number;
}

export interface XDocument {
  /** Top-level nodes (comments, processing instructions, the root element). */
  children: XNode[];
  root: XElement;
}

export class XmlSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(message);
  }
}

const PREDEF: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const NAME = /[A-Za-z_:À-￿][\w.:\-·À-￿]*/uy;

/**
 * Namespace-aware XML 1.0 reader (no DTD support: a DOCTYPE is an error, as with Xerces' disallow-doctype-decl).
 * Error messages follow Xerces' wording for the common cases.
 */
export function parseXmlDocument(src: string): XDocument {
  let i = 0;
  const n = src.length;
  // line / column tracking (1-based)
  const lineStarts: number[] = [0];
  for (let k = 0; k < n; k++) if (src.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const pos = (at: number): [number, number] => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return [lo + 1, at - lineStarts[lo] + 1];
  };
  const fail = (msg: string, at = i): never => {
    const [l, c] = pos(at);
    throw new XmlSyntaxError(msg, l, c);
  };
  // XML 1.0 Char production
  const xmlChar = (cp: number): boolean => cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
  const decode = (s: string, at: number, attr: string | null, element: string): string => {
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (xmlChar(cp)) continue;
      const hex = cp.toString(16);
      if (attr !== null) fail(`An invalid XML character (Unicode: 0x${hex}) was found in the value of attribute "${attr}" and element is "${element}".`, at);
      fail(`An invalid XML character (Unicode: 0x${hex}) was found in the element content of the document.`, at);
    }
    if (attr !== null) s = s.replace(/\r\n|[\t\n\r]/gu, " ");
    else s = s.replace(/\r\n?/gu, "\n");
    if (!s.includes("&")) return s;
    return s.replace(/&([^;&\s<]*)(;?)/gu, (_m, e: string, semi: string) => {
      if (!semi) fail(`The reference to entity "${e}" must end with the ';' delimiter.`, at);
      let cp: number | null = null;
      if (e.startsWith("#x")) {
        cp = parseInt(e.slice(2), 16);
        if (!/^[0-9a-fA-F]+$/u.test(e.slice(2)) || cp > 0x10ffff) fail(`A hexadecimal representation must immediately follow the "&#x" in a character reference.`, at);
      } else if (e.startsWith("#")) {
        cp = Number(e.slice(1));
        if (!/^\d+$/u.test(e.slice(1)) || cp > 0x10ffff) fail(`A decimal representation must immediately follow the "&#" in a character reference.`, at);
      }
      if (cp !== null) {
        if (!xmlChar(cp)) fail(`Character reference "&${e}" is an invalid XML character.`, at);
        return String.fromCodePoint(cp);
      }
      if (e in PREDEF) return PREDEF[e];
      if (!e) fail("The entity name must immediately follow the '&' in the entity reference.", at);
      return fail(`The entity "${e}" was referenced, but not declared.`, at);
    });
  };
  const readName = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(src);
    if (!m) fail("The markup in the document preceding the root element must be well-formed.");
    i += m![0].length;
    return m![0];
  };
  const skipWs = (): void => {
    while (i < n && /\s/u.test(src[i])) i++;
  };

  interface Frame {
    el: XElement;
    nsMap: Map<string, string>;
    rawAttrs: Array<{ qname: string; value: string }>;
  }
  const top: XNode[] = [];
  const stack: Frame[] = [];
  let root: XElement | null = null;
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  // XML declaration
  if (src.startsWith("<?xml", i) && /\s/u.test(src[i + 5] ?? "")) {
    const e = src.indexOf("?>", i);
    if (e < 0) fail("XML document structures must start and end within the same entity.");
    i = e + 2;
  }
  const resolve = (qname: string, nsMap: Map<string, string>, isAttr: boolean, at: number, elName: string): [string, string | null, string | null] => {
    const k = qname.indexOf(":");
    if (k < 0) return [qname, null, isAttr ? null : nsMap.get("") || null];
    const prefix = qname.slice(0, k);
    const local = qname.slice(k + 1);
    if (prefix === "xml") return [local, prefix, XML_NS];
    if (prefix === "xmlns") return [local, prefix, "http://www.w3.org/2000/xmlns/"];
    const ns = nsMap.get(prefix);
    if (ns === undefined) {
      if (isAttr) fail(`The prefix "${prefix}" for attribute "${qname}" associated with an element type "${elName}" is not bound.`, at);
      fail(`The prefix "${prefix}" for element "${qname}" is not bound.`, at);
    }
    return [local, prefix, ns!];
  };
  const append = (node: XNode): void => {
    if (stack.length) stack[stack.length - 1].el.children.push(node);
    else top.push(node);
  };
  while (i < n) {
    const lt = src.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      const raw = src.slice(i, textEnd);
      if (stack.length) {
        if (raw.includes("]]>")) fail("The character sequence \"]]>\" must not appear in content unless used to mark the end of a CDATA section.", i);
        const [l, c] = pos(i);
        append({ type: "text", text: decode(raw, i, null, stack[stack.length - 1].el.qname), line: l, col: c });
      } else if (/\S/u.test(raw)) {
        fail(root ? "Content is not allowed in trailing section." : "Content is not allowed in prolog.", i);
      }
    }
    if (lt < 0) break;
    i = lt;
    const [line, col] = pos(lt);
    if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i + 4);
      if (e < 0) fail("XML document structures must start and end within the same entity.");
      const text = src.slice(i + 4, e);
      if (text.includes("--")) fail("The string \"--\" is not permitted within comments.", i);
      append({ type: "comment", text, line, col });
      i = e + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      if (!stack.length) fail("The markup in the document following the root element must be well-formed.");
      const e = src.indexOf("]]>", i);
      if (e < 0) fail("The CDATA section must end with ']]>'.");
      append({ type: "cdata", text: src.slice(i + 9, e).replace(/\r\n?/gu, "\n"), line, col });
      i = e + 3;
      continue;
    }
    if (src.startsWith("<!DOCTYPE", i)) {
      fail('DOCTYPE is disallowed when the feature "http://apache.org/xml/features/disallow-doctype-decl" set to true.');
    }
    if (src.startsWith("<?", i)) {
      const e = src.indexOf("?>", i);
      if (e < 0) fail("XML document structures must start and end within the same entity.");
      const body = src.slice(i + 2, e);
      const m = /^([^\s?]+)\s*([\s\S]*)$/u.exec(body);
      const target = m ? m[1] : body;
      if (target.toLowerCase() === "xml") fail('The processing instruction target matching "[xX][mM][lL]" is not allowed.');
      append({ type: "pi", target, data: m ? m[2] : "", line, col });
      i = e + 2;
      continue;
    }
    if (src[i + 1] === "/") {
      i += 2;
      const name = readName();
      skipWs();
      if (src[i] !== ">") fail(`The end-tag for element type "${name}" must end with a '>' delimiter.`);
      const fr = stack.pop();
      if (!fr) fail("The markup in the document following the root element must be well-formed.");
      if (fr!.el.qname !== name) fail(`The element type "${fr!.el.qname}" must be terminated by the matching end-tag "</${fr!.el.qname}>".`, lt);
      i++;
      continue;
    }
    if (root && !stack.length) fail("The markup in the document following the root element must be well-formed.");
    // start tag
    i++;
    const qname = readName();
    const rawAttrs: Array<{ qname: string; value: string; at: number }> = [];
    for (;;) {
      const ws = i;
      skipWs();
      if (src[i] === ">" || src.startsWith("/>", i)) break;
      if (i >= n) fail(`XML document structures must start and end within the same entity.`);
      if (ws === i) fail(`Element type "${qname}" must be followed by either attribute specifications, ">" or "/>".`);
      const at = i;
      const an = readName();
      skipWs();
      if (src[i] !== "=") fail(`Attribute name "${an}" associated with an element type "${qname}" must be followed by the ' = ' character.`);
      i++;
      skipWs();
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`Open quote is expected for attribute "${an}" associated with an  element type  "${qname}".`);
      const e = src.indexOf(q, i + 1);
      if (e < 0) fail("XML document structures must start and end within the same entity.");
      const rawVal = src.slice(i + 1, e);
      if (rawVal.includes("<")) fail(`The value of attribute "${an}" associated with an element type "${qname}" must not contain the '<' character.`);
      if (rawAttrs.some((a) => a.qname === an)) fail(`Attribute "${an}" was already specified for element "${qname}".`);
      rawAttrs.push({ qname: an, value: decode(rawVal, i, an, qname), at });
      i = e + 1;
    }
    const selfClose = src[i] === "/";
    i += selfClose ? 2 : 1;
    const parentNs = stack.length ? stack[stack.length - 1].nsMap : new Map<string, string>();
    const nsMap = new Map(parentNs);
    for (const a of rawAttrs) {
      if (a.qname === "xmlns") nsMap.set("", a.value);
      else if (a.qname.startsWith("xmlns:")) nsMap.set(a.qname.slice(6), a.value);
    }
    const [local, prefix, ns] = resolve(qname, nsMap, false, lt, qname);
    const attrs: XAttr[] = rawAttrs.map((a) => {
      if (a.qname === "xmlns") return { qname: a.qname, local: "xmlns", prefix: null, ns: "http://www.w3.org/2000/xmlns/", value: a.value };
      const [al, ap, ans] = resolve(a.qname, nsMap, true, a.at, qname);
      return { qname: a.qname, local: al, prefix: ap, ns: ans, value: a.value };
    });
    const el: XElement = { type: "element", qname, local, prefix, ns, attrs, children: [], line, col };
    if (!root) {
      if (stack.length) fail("internal");
      root = el;
    }
    append(el);
    if (!selfClose) stack.push({ el, nsMap, rawAttrs });
  }
  if (stack.length) fail(`XML document structures must start and end within the same entity.`, n);
  if (!root) fail("Premature end of file.", n);
  return { children: top, root: root! };
}

// ---------------------------------------------------------------------------------------------- definitions

export interface XmlSdSource {
  fetchStructureDefinition(url: string): Promise<Json | null>;
}

interface Prop {
  /** Element name (the definition's path tail, e.g. `value[x]`). */
  name: string;
  xmlName: string;
  ed: Json;
  sd: Json;
  /** Index among the children definitions (InstanceValidator ElementInfo.index). */
  index: number;
  isList: boolean;
  isChoice: boolean;
  isAttr: boolean;
  isText: boolean;
  types: string[];
}

interface Ctx {
  sd: Json;
  /** Element path whose children are the properties. */
  path: string;
  /** FHIR type name (fhirType of the element). */
  type: string;
}

const EXT_XML_NAME = ["http://hl7.org/fhir/StructureDefinition/elementdefinition-xml-name", "http://hl7.org/fhir/tools/StructureDefinition/xml-name"];

function typeCode(t: Json): string {
  return String(t?.code ?? "");
}

function isSystemType(t: string): boolean {
  return t.startsWith("http://hl7.org/fhirpath/System.");
}

function isPrimitiveTypeName(t: string): boolean {
  return isSystemType(t) || /^[a-z]/u.test(t);
}

function hasRep(ed: Json, rep: string): boolean {
  return Array.isArray(ed.representation) && ed.representation.includes(rep);
}

function tailOf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function versionedUrl(sd: Json): string {
  return sd.version ? `${sd.url}|${sd.version}` : String(sd.url);
}

const NUMERIC = new Set(["integer", "decimal", "positiveInt", "unsignedInt", "integer64"]);
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

function primitiveJson(type: string, v: string): unknown {
  if (type === "boolean") return v === "true" ? true : v === "false" ? false : v;
  if (NUMERIC.has(type) && type !== "integer64" && JSON_NUMBER.test(v)) {
    const num = Number(v);
    if (Number.isFinite(num)) return num;
  }
  return v;
}

// ---------------------------------------------------------------------------------------------- element model

interface EM {
  name: string;
  prop: Prop | null;
  /** FHIR type of the element. */
  type: string;
  value?: string;
  xhtml?: string;
  children: EM[];
  /** Resource name when the element holds a resource (contained / entry.resource / root). */
  resourceType?: string;
}

export interface FhirXmlResult {
  /** The resource in FHIR JSON form, or null when the content could not be parsed. */
  resource: Json | null;
  /** Parse-time issues (Java XmlParser + the XML order rule). */
  issues: Issue[];
}

function makeSingleLine(s: string): string {
  return s.replace(/\r\n|\r|\n/gu, " ").replace(/\s{2,}/gu, " ");
}

/** XhtmlParser.parseHtmlNode + XhtmlComposer: the div element as the JSON xhtml string. */
function serialiseXhtml(el: XElement, defaultNs: string | null, root: boolean): string {
  const escText = (s: string): string => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  const escAttr = (s: string): string => s.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
  let out = `<${el.local}`;
  let ns = defaultNs;
  const attrs: string[] = [];
  if (el.ns && el.ns !== defaultNs) {
    attrs.push(` xmlns="${escAttr(el.ns)}"`);
    ns = el.ns;
  } else if (root && !el.ns) {
    attrs.push(` xmlns="${XHTML_NS}"`);
  }
  for (const a of el.attrs) {
    if (a.local.startsWith("xmlns") || a.qname === "xmlns") continue;
    attrs.push(` ${a.qname}="${escAttr(a.value)}"`);
  }
  out += attrs.join("");
  const kids: string[] = [];
  for (const c of el.children) {
    if (c.type === "text" || c.type === "cdata") kids.push(escText(c.text));
    else if (c.type === "comment") kids.push(`<!--${c.text}-->`);
    else if (c.type === "element") kids.push(serialiseXhtml(c, ns, false));
  }
  if (!kids.length) return `${out}/>`;
  return `${out}>${kids.join("")}</${el.local}>`;
}

function pathPrefix(ns: string | null): string {
  if (!ns) return "";
  if (ns === FHIR_NS) return "f:";
  if (ns === XHTML_NS) return "h:";
  if (ns === "urn:hl7-org:v3") return "v3:";
  if (ns === "urn:hl7-org:sdtc") return "sdtc:";
  if (ns === "urn:ihe:pharm") return "pharm:";
  if (ns === "http://ns.electronichealth.net.au/Ci/Cda/Extensions/3.0") return "ext:";
  return "?:";
}

/**
 * Port of XmlParser (parse / checkElement / parseChildren / parseResource / checkHeader) producing FHIR JSON.
 * One instance per document (it holds the document's issues).
 */
export class FhirXmlParser {
  private readonly issues: Issue[] = [];
  private readonly childCache = new Map<Json, Map<string, Prop[]>>();
  private readonly sdCache = new Map<string, Promise<Json | null>>();
  private version: string | null = null;

  constructor(private readonly src: XmlSdSource) {}

  private issue(severity: Issue["severity"], path: string, code: string, message: string, line?: number, col?: number): void {
    const i: Issue = { severity, path, code, message };
    if (line) (i as Json).line = line;
    if (col) (i as Json).col = col;
    this.issues.push(i);
  }

  private sd(url: string): Promise<Json | null> {
    let p = this.sdCache.get(url);
    if (!p) {
      p = this.src.fetchStructureDefinition(url).then(
        (sd) => (sd && Array.isArray(sd.snapshot?.element) && sd.snapshot.element.length ? sd : null),
        () => null,
      );
      this.sdCache.set(url, p);
    }
    return p;
  }

  private typeSd(type: string): Promise<Json | null> {
    return this.sd(/^https?:/u.test(type) ? type : SD_BASE + type);
  }

  /** Property.getChildProperties: the direct children definitions of `path` in `sd` (slices excluded). */
  private props(ctx: Ctx): Prop[] {
    let bySd = this.childCache.get(ctx.sd);
    if (!bySd) {
      bySd = new Map();
      this.childCache.set(ctx.sd, bySd);
    }
    let list = bySd.get(ctx.path);
    if (list) return list;
    list = [];
    const seen = new Set<string>();
    const prefix = `${ctx.path}.`;
    for (const ed of ctx.sd.snapshot.element as Json[]) {
      const p = String(ed.path ?? "");
      if (!p.startsWith(prefix) || p.slice(prefix.length).includes(".") || ed.sliceName || seen.has(p)) continue;
      seen.add(p);
      const name = tailOf(p);
      let xmlName = name;
      for (const e of ed.extension ?? []) if (EXT_XML_NAME.includes(e?.url) && typeof e.valueString === "string") xmlName = e.valueString;
      const max = String(ed.base?.max ?? ed.max ?? "1");
      list.push({
        name,
        xmlName,
        ed,
        sd: ctx.sd,
        index: list.length,
        isList: max !== "1",
        isChoice: name.endsWith("[x]"),
        isAttr: hasRep(ed, "xmlAttr"),
        isText: hasRep(ed, "xmlText"),
        types: (ed.type ?? []).map(typeCode),
      });
    }
    bySd.set(ctx.path, list);
    return list;
  }

  /** XmlParser.getElementProp (longest name first; namespace-matching pass, then name / choice-prefix pass). */
  private elementProp(props: Prop[], local: string, ns: string | null): Prop | null {
    const sorted = [...props].sort((a, b) => b.name.length - a.name.length);
    for (const p of sorted) if (!p.isAttr && !p.isText && p.xmlName === local && ns === FHIR_NS) return p;
    for (const p of sorted) {
      if (p.isAttr || p.isText) continue;
      if (p.xmlName === local) return p;
      const stem = p.name.slice(0, -3);
      if (p.isChoice && local.length > stem.length && local.startsWith(stem)) return p;
    }
    return null;
  }

  private attrProp(props: Prop[], local: string, ns: string | null): Prop | null {
    for (const p of props) if (p.xmlName === local && p.isAttr && ns === FHIR_NS) return p;
    if (ns === null) for (const p of props) if (p.xmlName === local && p.isAttr) return p;
    return null;
  }

  /** The type of a child element of property p written as `local` (choice suffix). */
  private chosenType(p: Prop, local: string): string | null {
    if (!p.isChoice) {
      if (p.ed.contentReference) return null;
      return p.types.length === 1 ? p.types[0] : p.types[0] ?? null;
    }
    const suffix = local.slice(p.name.length - 3);
    const t = p.types.find((c) => c.charAt(0).toUpperCase() + c.slice(1) === suffix) ?? p.types.find((c) => c.toLowerCase() === suffix.toLowerCase());
    return t ?? null;
  }

  /** Children context of an element of property p with type t. */
  private async childCtx(p: Prop, t: string | null): Promise<Ctx | null> {
    if (p.ed.contentReference) {
      const ref = String(p.ed.contentReference);
      const target = ref.slice(ref.indexOf("#") + 1);
      return { sd: p.sd, path: target, type: "BackboneElement" };
    }
    const own = `${p.ed.path}.`;
    if ((!t || t === "BackboneElement" || t === "Element") && (p.sd.snapshot.element as Json[]).some((e) => String(e.path ?? "").startsWith(own))) {
      return { sd: p.sd, path: String(p.ed.path), type: t || "BackboneElement" };
    }
    if (!t) return null;
    const sd = await this.typeSd(isSystemType(t) ? "string" : t);
    if (!sd) return null;
    return { sd, path: String(sd.snapshot.element[0].path), type: isSystemType(t) ? t : t };
  }

  // ------------------------------------------------------------------------------------------- parse

  async parse(text: string): Promise<FhirXmlResult> {
    this.version = this.checkHeader(text);
    let doc: XDocument;
    try {
      doc = parseXmlDocument(text);
    } catch (e) {
      const err = e as XmlSyntaxError;
      this.issue("fatal", "(xml)", "invalid", err.message, err.line, err.col);
      return { resource: null, issues: this.issues };
    }
    // checkForProcessingInstruction
    if (doc.root.ns === FHIR_NS) {
      for (const c of doc.children) if (c.type === "pi") this.issue("error", "(document)", "invalid", "No processing instructions allowed in resources", doc.root.line, doc.root.col);
    }
    const el = doc.root;
    const name = el.local;
    const path = `/${pathPrefix(el.ns)}${name}`;
    let sd: Json | null = null;
    if (el.ns == null) {
      this.issue("fatal", name, "structure", `This '${name}' cannot be parsed (no namespace on the XML Root element)`, el.line, el.col);
    } else {
      if (el.ns === FHIR_NS) {
        const base = await this.sd(SD_BASE + name);
        if (base && base.derivation === "specialization" && base.kind !== "logical") sd = base;
      }
      if (!sd) this.issue("fatal", name, "structure", `This content cannot be parsed (unknown or unrecognized XML Root element namespace/name '${el.ns}::${name}')`, el.line, el.col);
    }
    if (!sd) return { resource: null, issues: this.issues };
    const root: EM = { name, prop: null, type: name, children: [], resourceType: name };
    const rootCtx: Ctx = { sd, path: String(sd.snapshot.element[0].path), type: name };
    this.checkElement(el, path, rootCtx.type, false);
    await this.parseChildren(path, name, el, root, rootCtx);
    return { resource: this.toJson(root) as Json, issues: this.issues };
  }

  /** XmlParser.checkHeader (stream bytes → here the decoded text: a BOM is U+FEFF). */
  private checkHeader(text: string): string | null {
    const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (text.charCodeAt(0) === 0xfeff && !s.startsWith("<?xml")) return "?xml-p1?";
    if (!s.startsWith("<?x")) {
      if (s.startsWith("<")) return "1.0";
      this.issue("error", "XML", "invalid", "The XML encoding is invalid (must be UTF-8, not '{0}')");
      return "?xml-p2?";
    }
    const end = s.indexOf(">");
    const header = end < 0 ? s : s.slice(0, end);
    let i = header.indexOf('encoding="');
    if (i < 0) i = header.indexOf("encoding='");
    if (i > -1) {
      const e = header.slice(i + 10, i + 15);
      if (e.toUpperCase() !== "UTF-8") this.issue("error", "XML", "invalid", `The XML encoding is invalid (must be UTF-8, not '${e}')`);
    }
    i = header.indexOf('version="');
    if (i < 0) i = header.indexOf("version='");
    if (i > -1) return header.slice(i + 9, i + 12);
    return "?xml-p1?";
  }

  private isEmpty(el: XElement): boolean {
    if (el.attrs.some((a) => a.qname !== "xmlns" && !a.qname.startsWith("xmlns:"))) return false;
    const text = textContent(el);
    if (text.trim() !== "") return false;
    return !el.children.some((c) => c.type === "element");
  }

  /** XmlParser.checkElement. */
  private checkElement(el: XElement, path: string, actualType: string, xsiTypeChecked: boolean): void {
    if (this.isEmpty(el) && el.ns === FHIR_NS) this.issue("error", path, "invalid", "Element must have some content", el.line, el.col);
    const elementNs = el.ns ?? "noNamespace";
    if (elementNs !== FHIR_NS) this.issue("error", path, "invalid", `Wrong namespace - expected '${FHIR_NS}'`, el.line, el.col);
    if (!xsiTypeChecked) {
      const xsi = el.attrs.find((a) => a.ns === XSI_NS && a.local === "type")?.value;
      if (xsi) {
        if (xsi === actualType) this.issue("information", path, "invalid", "xsi:type is unnecessary at this point", el.line, el.col);
        else this.issue("error", path, "invalid", `The xsi:type value '${xsi}' is wrong (should be '${actualType}'). Note that xsi:type is unnecessary at this point`, el.line, el.col);
      }
    }
  }

  private validAttrValue(value: string): boolean {
    if (this.version !== "1.0") return true;
    for (const ch of value) {
      const c = ch.charCodeAt(0);
      if (c <= 0x1f && ch !== "\r" && ch !== "\n" && ch !== "\t") return false;
    }
    return true;
  }

  /**
   * XmlParser.parseChildren. `path` is the XML path used in parse messages, `literal` the element path the
   * validator reports (FHIRPath form) for the order rule.
   */
  private async parseChildren(path: string, literal: string, node: XElement, element: EM, ctx: Ctx): Promise<void> {
    const properties = this.props(ctx);
    // text content
    const direct = node.children.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("").trim();
    if (direct) {
      const tp = properties.find((p) => p.isText);
      if (tp) {
        element.children.push({ name: tp.name, prop: tp, type: tp.types[0] ?? "string", value: direct, children: [] });
      } else {
        for (const c of node.children) {
          if (c.type === "text" && c.text.trim()) this.issue("error", path, "structure", `Text should not be present ('${makeSingleLine(c.text.trim())}')`, c.line, c.col);
        }
      }
    }
    const primitive = isPrimitiveTypeName(ctx.type);
    // attributes
    for (const a of node.attrs) {
      if (!this.validAttrValue(a.value)) this.issue("error", path, "structure", `The XML Attribute ${a.qname} has an invalid character`, node.line, node.col);
      if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) continue;
      const p = this.attrProp(properties, a.local, a.ns);
      if (p) {
        if (p.name === "value" && primitive) element.value = a.value;
        else {
          const vals = p.isList && a.value.includes(" ") ? a.value.split(" ") : [a.value];
          for (const v of vals) element.children.push({ name: p.name, prop: p, type: p.types[0] ?? "string", value: v, children: [] });
        }
      } else {
        let ok = false;
        if (node.ns !== FHIR_NS) ok = a.local === "schemaLocation";
        if (!ok && a.local !== "resourceDefinition") {
          const names = properties.map((x) => x.name).join(", ");
          void names;
          this.issue("error", path, "structure", `Undefined attribute '@${a.qname}' on ${node.qname} for type ${ctx.type}`, node.line, node.col);
        }
      }
    }
    // child nodes
    let last = -1;
    let lastName: string | null = null;
    const counts = new Map<string, number>();
    for (const child of node.children) {
      if (child.type === "element") {
        const p = this.elementProp(properties, child.local, child.ns);
        if (!p) {
          this.issue("error", path, "structure", `Undefined element '${child.local}' at ${path}`, child.line, child.col);
          continue;
        }
        const jsonName = p.isChoice ? child.local : p.name;
        const count = counts.get(jsonName) ?? 0;
        counts.set(jsonName, count + 1);
        const childLiteral = `${literal}.${jsonName}${p.isList ? `[${count}]` : ""}`;
        // InstanceValidator.checkChildren: XML element order (Validation_VAL_Profile_OutOfOrder)
        if (p.index < last && !p.isAttr) {
          this.issue("error", childLiteral, "invalid", `As specified by profile ${versionedUrl(p.sd)}, Element '${jsonName}' is out of order (found after ${lastName ?? "(null)"})`, child.line, child.col);
        }
        last = p.index;
        lastName = jsonName;
        if (!p.isChoice && p.types[0] === "xhtml") {
          element.children.push({ name: p.name, prop: p, type: "xhtml", xhtml: serialiseXhtml(child, null, true), children: [] });
          continue;
        }
        const npath = `${path}/${pathPrefix(child.ns)}${child.local}`;
        let t = this.chosenType(p, child.local);
        if (p.isChoice && !t) t = child.local.slice(p.name.length - 3);
        const n: EM = { name: jsonName, prop: p, type: t ?? "BackboneElement", children: [] };
        this.checkElement(child, npath, t ?? (p.ed.contentReference ? "BackboneElement" : ""), false);
        element.children.push(n);
        if (p.types.includes("Resource") && !p.isChoice) {
          await this.parseResource(npath, childLiteral, child, n);
        } else {
          const cctx = await this.childCtx(p, t);
          if (cctx) await this.parseChildren(npath, childLiteral, child, n, cctx);
          else n.type = t ?? "";
        }
      } else if (child.type === "cdata") {
        this.issue("error", path, "structure", "CDATA is not allowed", child.line, child.col);
      } else if (child.type === "pi") {
        this.issue("error", path, "structure", "Node type 7 is not allowed", child.line, child.col);
      }
    }
  }

  /** XmlParser.parseResource: the first child element is the resource. */
  private async parseResource(path: string, literal: string, container: XElement, parent: EM): Promise<void> {
    const res = container.children.find((c): c is XElement => c.type === "element");
    if (!res) return;
    const name = res.local;
    const sd = await this.sd(SD_BASE + name);
    if (!sd || sd.kind === "logical") {
      this.issue("fatal", path, "structure", `Contained resource does not appear to be a FHIR resource (unknown name '${name}')`, res.line, res.col);
      return;
    }
    parent.type = name;
    parent.resourceType = name;
    await this.parseChildren(name, literal, res, parent, { sd, path: String(sd.snapshot.element[0].path), type: name });
  }

  // ------------------------------------------------------------------------------------------- JSON

  private toJson(em: EM): Json {
    const out: Json = {};
    if (em.resourceType) out.resourceType = em.resourceType;
    const groups = new Map<string, EM[]>();
    for (const c of em.children) {
      const g = groups.get(c.name);
      if (g) g.push(c);
      else groups.set(c.name, [c]);
    }
    for (const [name, items] of groups) {
      const p = items[0].prop;
      const isList = p ? p.isList : items.length > 1;
      const primitive = items.every((c) => c.xhtml !== undefined || (!c.resourceType && isPrimitiveTypeName(c.type)));
      if (primitive) {
        const vals: unknown[] = [];
        const exts: Array<Json | null> = [];
        for (const c of items) {
          if (c.xhtml !== undefined) {
            vals.push(c.xhtml);
            exts.push(null);
            continue;
          }
          vals.push(c.value !== undefined ? primitiveJson(c.type, c.value) : null);
          const e = c.children.length ? this.toJson({ ...c, resourceType: undefined, value: undefined }) : null;
          exts.push(e && Object.keys(e).length ? e : null);
        }
        const anyVal = vals.some((v) => v !== null);
        const anyExt = exts.some((e) => e !== null);
        if (isList) {
          if (anyVal || !anyExt) out[name] = vals;
          if (anyExt) out[`_${name}`] = exts;
        } else {
          if (anyVal || !anyExt) out[name] = vals[0];
          if (anyExt) out[`_${name}`] = exts[0];
        }
        continue;
      }
      const objs = items.map((c) => this.toJson(c));
      out[name] = isList ? objs : objs.length === 1 ? objs[0] : objs;
    }
    return out;
  }
}

function textContent(el: XElement): string {
  let s = "";
  for (const c of el.children) {
    if (c.type === "text" || c.type === "cdata") s += c.text;
    else if (c.type === "element") s += textContent(c);
  }
  return s;
}

/** Does this text look like an XML document (first non-blank character '<')? */
export function looksLikeXml(text: string): boolean {
  return /^﻿?\s*</u.test(text);
}

/** Parse a FHIR XML document into FHIR JSON plus the parse-time issues validator_cli reports. */
export async function parseFhirXml(text: string, src: XmlSdSource): Promise<FhirXmlResult> {
  return new FhirXmlParser(src).parse(text);
}
