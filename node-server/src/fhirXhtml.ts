/**
 * Narrative XHTML (parity v3, area json-xhtml): ports of the HL7 validator 7.0.1 pieces that read and check
 * Narrative.div.
 *
 *  - parseXhtml(): org.hl7.fhir.utilities.xhtml.XhtmlParser as the JSON element model calls it
 *    (`new XhtmlParser().setXmlMode(true).parse(value, null)`, policy Accept, mustBeWellFormed): the node tree, the
 *    parser's validation issues (XHTML_XHTML_Entity_Illegal in xml mode) or the FHIRFormatError text that the element
 *    model reports as ERROR_PARSING_XHTML_ ("Error parsing XHTML: …"), with Java's line / column bookkeeping;
 *  - validateXhtml(): org.hl7.fhir.validation.instance.type.XhtmlValidator.validate (namespace, root name, element /
 *    attribute names, URLs via UrlUtil.checkValidUrl, structure rules, mixed languages, duplicate ids);
 *  - htmlChecks1() / htmlChecks2(): FHIRPathEngine.funcHtmlChecks1 / 2 (checkHtmlNames / checkForContent) over the
 *    parsed tree — the R4 txt-1 / txt-2 invariants.
 */
import { FHIRLexerError, parseFhirPathJava, type ExprNode } from "./fhirPathJavaParser.js";
import { xhtmlEntity } from "./fhirXhtmlEntities.js";

export const XHTML_NS = "http://www.w3.org/1999/xhtml";

export type XNodeType = "Document" | "Element" | "Text" | "Comment" | "DocType" | "Instruction" | "CData";
export interface XNode {
  type: XNodeType;
  name: string | null;
  attributes: Map<string, string | null>;
  children: XNode[];
  content: string | null;
}

const node = (type: XNodeType, name: string | null = null, content: string | null = null): XNode => ({ type, name, attributes: new Map(), children: [], content });

/** FHIRFormatError (and the runtime exceptions) the parser throws: `message` is Java's getMessage(). */
export class XhtmlFormatError extends Error {}

const END = "￿"; // (char) -1
/** Java Character.isWhitespace. */
function isWhitespace(c: string): boolean {
  if (c === END) return false;
  const n = c.charCodeAt(0);
  if ((n >= 0x09 && n <= 0x0d) || (n >= 0x1c && n <= 0x1f)) return true;
  if (n === 0xa0 || n === 0x2007 || n === 0x202f) return false;
  return /[\p{Zs}\p{Zl}\p{Zp}]/u.test(c);
}
/** Java Character.isLetterOrDigit (BMP char). */
const isLetterOrDigit = (c: string): boolean => c !== END && /[\p{L}\p{Nd}]/u.test(c);
const isNameChar = (c: string): boolean => isLetterOrDigit(c) || c === "_" || c === "-" || c === ":" || c === ".";
/** Java String.trim(): strips chars <= U+0020. */
const javaTrim = (s: string): string => s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");

function parseJavaInt(s: string, radix: 10 | 16): number | null {
  if (!(radix === 10 ? /^[+-]?[0-9]+$/ : /^[+-]?[0-9a-fA-F]+$/).test(s)) return null;
  const v = parseInt(s, radix);
  return v > 2147483647 || v < -2147483648 ? null : v;
}

class NsMap {
  defaultNamespace: string | null = null;
  originalNamespacePrefix: string | null = null;
  map = new Map<string, string>();
  constructor(parent: NsMap | null) {
    if (parent) {
      for (const [k, v] of parent.map) this.map.set(k, v);
      this.defaultNamespace = parent.defaultNamespace;
      this.originalNamespacePrefix = parent.originalNamespacePrefix;
    }
  }
  forPrefix(prefix: string): string {
    if (this.originalNamespacePrefix !== null && this.originalNamespacePrefix === prefix) return this.defaultNamespace as string;
    return this.map.get(prefix) ?? "http://error/undefined-namespace";
  }
}

function elementName(src: string): { ns: string | null; name: string } {
  const i = src.indexOf(":");
  return i >= 0 ? { ns: src.slice(0, i), name: src.slice(i + 1) } : { ns: null, name: src };
}

/** XhtmlParser (xml mode, policy Accept, mustBeWellFormed = true, trimWhitespace = false). */
class Parser {
  private pos = 0;
  private cache = "";
  private line = 1;
  private col = 0;
  private lastChar = "";
  private lastText = "";
  private readonly declaredEntities = new Map<string, string>();
  readonly issues: Array<{ id: "XHTML_XHTML_Entity_Illegal"; param: string }> = [];
  private unwindPoint: XNode | null = null;

  constructor(private readonly src: string) {}

  private descLoc(): string {
    return ` at line ${this.line} column ${this.col}`;
  }

  private peekChar(): string {
    if (this.cache.length > 0) return this.cache.charAt(0);
    if (this.pos >= this.src.length) return END;
    const c = this.src.charAt(this.pos++);
    this.cache = c;
    return c;
  }

  private readChar(): string {
    let c: string;
    if (this.cache.length > 0) {
      c = this.cache.charAt(0);
      this.cache = this.cache.length === 1 ? "" : this.cache.slice(1);
    } else if (this.pos >= this.src.length) c = END;
    else c = this.src.charAt(this.pos++);
    if (c === "\r" || c === "\n") {
      if (c === "\r" || this.lastChar !== "\r") {
        this.line++;
        this.col = 0;
      }
      this.lastChar = c;
    }
    this.col++;
    return c;
  }

  private pushChar(ch: string): void {
    this.cache = ch + this.cache;
  }

  parse(): XNode {
    const result = node("Document");
    this.skipWhiteSpaceAndComments(result);
    if (this.peekChar() !== "<") throw new XhtmlFormatError(`Unable to Parse HTML - does not start with tag. Found '${this.peekChar()}' ${this.descLoc()}`);
    this.readChar();
    const n = elementName(this.readName().toLowerCase());
    const root = node("Element", n.name);
    result.children.push(root);
    this.parseAttributes(root);
    const nsm = this.normalizeNamespaces(n, root, null, true);
    if (this.readChar() === "/") {
      if (this.peekChar() !== ">") throw new XhtmlFormatError(`unexpected non-end of element ${n.ns}::${n.name} ${this.descLoc()}`);
      this.readChar();
    } else {
      this.unwindPoint = null;
      this.parseElementInner(root, [], nsm);
    }
    return result;
  }

  private normalizeNamespaces(en: { ns: string | null; name: string }, n: XNode, parent: NsMap | null, isRoot: boolean): NsMap {
    const map = new NsMap(parent);
    const nsAttrs: string[] = [];
    for (const [an, v] of n.attributes) {
      if (an === "xmlns") {
        map.defaultNamespace = v;
        nsAttrs.push(an);
      }
      if (an.startsWith("xmlns:")) {
        map.map.set(an.slice(6), String(v));
        nsAttrs.push(an);
      }
    }
    for (const a of nsAttrs) n.attributes.delete(a);
    if (en.ns !== null) {
      const ens = map.forPrefix(en.ns);
      if (ens !== map.defaultNamespace) {
        n.attributes.set("xmlns", ens);
        map.defaultNamespace = ens;
        map.originalNamespacePrefix = en.ns;
        map.map.delete(en.ns);
      }
    }
    const addDefault = isRoot ? map.defaultNamespace !== null : map.defaultNamespace !== null && (parent === null || map.defaultNamespace !== parent.defaultNamespace);
    if (addDefault) n.attributes.set("xmlns", map.defaultNamespace);
    for (const [k, v] of map.map) if (isRoot || !parent!.map.has(k)) n.attributes.set(`xmlns:${k}`, v);
    return map;
  }

  private addTextNode(n: XNode, s: string[]): void {
    const t = s.join("");
    if (t.length > 0) {
      this.lastText = t;
      n.children.push(node("Text", null, t));
      s.length = 0;
    }
  }

  private parseElementInner(n: XNode, parents: XNode[], nsm: NsMap): void {
    const s: string[] = [];
    while (this.peekChar() !== END && !parents.includes(this.unwindPoint as XNode) && !(n === this.unwindPoint)) {
      if (this.peekChar() === "<") {
        this.addTextNode(n, s);
        this.readChar();
        if (this.peekChar() === "!") {
          this.readChar();
          if (this.peekChar() === "[") n.children.push(node("CData", null, this.readCData()));
          else {
            this.pushChar("!");
            n.children.push(node("Comment", null, this.readToCommentEnd(true)));
          }
        } else if (this.peekChar() === "?") n.children.push(node("Comment", null, this.readToTagEnd()));
        else if (this.peekChar() === "/") {
          this.readChar();
          const en = elementName(this.readToTagEnd());
          if (n.name === en.name) return;
          throw new XhtmlFormatError(`Malformed XHTML: Found "</${en.name}>" expecting "</${n.name}>"${this.descLoc()}`);
        } else if (isLetterOrDigit(this.peekChar())) this.parseElement(n, parents, nsm);
        else throw new XhtmlFormatError(`Unable to Parse HTML - node '${n.name}' has unexpected content '${this.peekChar()}' (last text = '${this.lastText}'${this.descLoc()}`);
      } else if (this.peekChar() === "&") this.parseLiteral(s);
      else s.push(this.readChar());
    }
    this.addTextNode(n, s);
  }

  private parseRawTextNode(n: XNode): void {
    const end = `</${n.name}>`;
    let s = "";
    while (this.peekChar() !== END && !s.toLowerCase().endsWith(end.toLowerCase())) s += this.readChar();
    if (s.toLowerCase().endsWith(end.toLowerCase())) s = s.slice(0, s.length - end.length);
    if (s.length > 0) {
      this.lastText = s;
      n.children.push(node("Text", null, s));
    }
  }

  private parseElement(parent: XNode, parents: XNode[], nsm: NsMap): void {
    if (parents.length > 500) throw new XhtmlFormatError(`XHTML nesting depth exceeds maximum of 500${this.descLoc()}`);
    const en = elementName(this.readName());
    const n = node("Element", en.name);
    parent.children.push(n);
    const newParents = [...parents, parent];
    this.parseAttributes(n);
    const map = this.normalizeNamespaces(en, n, nsm, false);
    if (this.readChar() === "/") {
      if (this.peekChar() !== ">") throw new XhtmlFormatError(`unexpected non-end of element ${en.ns}::${en.name} ${this.descLoc()}`);
      this.readChar();
    } else if (en.name.toLowerCase() === "script" || en.name.toLowerCase() === "style") this.parseRawTextNode(n);
    else this.parseElementInner(n, newParents, map);
  }

  private parseAttributes(n: XNode): void {
    while (isWhitespace(this.peekChar())) this.readChar();
    while (this.peekChar() !== ">" && this.peekChar() !== "/" && this.peekChar() !== END) {
      const name = this.readName();
      if (name.length === 0) throw new XhtmlFormatError(`Unable to read attribute on <${n.name}>${this.descLoc()}`);
      while (isWhitespace(this.peekChar())) this.readChar();
      if (isNameChar(this.peekChar()) || this.peekChar() === ">" || this.peekChar() === "/") n.attributes.set(name, null);
      else if (this.peekChar() !== "=") throw new XhtmlFormatError(`Unable to read attribute '${name}' value on <${n.name}>${this.descLoc()}`);
      else {
        this.readChar();
        while (isWhitespace(this.peekChar())) this.readChar();
        if (this.peekChar() === '"' || this.peekChar() === "'") n.attributes.set(name, this.parseAttributeValue(this.readChar()));
        else n.attributes.set(name, this.parseAttributeValue(END));
      }
      while (isWhitespace(this.peekChar())) this.readChar();
    }
  }

  private parseAttributeValue(term: string): string {
    const b: string[] = [];
    while (this.peekChar() !== END && this.peekChar() !== ">" && (term !== END || this.peekChar() !== "/") && this.peekChar() !== term) {
      if (this.peekChar() === "&") this.parseLiteral(b);
      else b.push(this.readChar());
    }
    if (this.peekChar() === term) this.readChar();
    return b.join("");
  }

  private skipWhiteSpaceAndComments(focus: XNode): void {
    while (isWhitespace(this.peekChar()) || this.peekChar() === "﻿") this.readChar();
    if (this.peekChar() === "<") {
      const ch = this.readChar();
      if (this.peekChar() === "!") {
        this.readChar();
        if (this.peekChar() === "-") {
          this.readChar();
          if (this.peekChar() === "-") {
            this.readChar();
            if (this.peekChar() === " ") this.readChar();
            focus.children.push(node("Comment", null, this.readToCommentEnd(false)));
          } else throw new XhtmlFormatError(`unrecognised element type <!${this.peekChar()}${this.descLoc()}`);
        } else focus.children.push(node("DocType", null, this.readToDocTypeEnd()));
        this.skipWhiteSpaceAndComments(focus);
      } else if (this.peekChar() === "?") {
        const r = this.readToTagEnd();
        focus.children.push(node("Instruction", null, r.slice(1, r.length - 1)));
        this.skipWhiteSpaceAndComments(focus);
      } else this.pushChar(ch);
    }
  }

  private readToTagEnd(): string {
    let s = "";
    while (this.peekChar() !== ">" && this.peekChar() !== END) s += this.readChar();
    if (this.peekChar() !== END) this.readChar();
    else throw new XhtmlFormatError(`Unexpected termination of html source${this.descLoc()}`);
    return s;
  }

  private readToDocTypeEnd(): string {
    let s = "";
    for (;;) {
      const c = this.peekChar();
      if (c === ">") {
        this.readChar();
        return s;
      } else if (c !== END) s += this.readChar();
      else throw new XhtmlFormatError(`Unexpected termination of html source${this.descLoc()}`);
    }
  }

  private readToCommentEnd(simple: boolean): string {
    if (this.peekChar() === "!") this.readChar();
    let s = "";
    if (this.peekChar() === "-") {
      this.readChar();
      simple = this.peekChar() !== "-";
      if (simple) s += "-";
      else this.readChar();
    }
    let doctypeEntities = false;
    let done = false;
    while (!done) {
      const c = this.peekChar();
      if (c === "-") {
        this.readChar();
        if (this.peekChar() === "-") {
          this.readChar();
          if (this.peekChar() === ">") done = true;
          else {
            this.pushChar("-");
            s += "-";
          }
        } else s += "-";
      } else if (doctypeEntities && c === "]") {
        s += this.readChar();
        if (this.peekChar() === ">") done = true;
      } else if (simple && this.peekChar() === ">" && !doctypeEntities) done = true;
      else if (c === "[" && s.startsWith("DOCTYPE ")) {
        doctypeEntities = true;
        s += this.readChar();
      } else if (c !== END) s += this.readChar();
      else throw new XhtmlFormatError(`Unexpected termination of html source${this.descLoc()}`);
    }
    if (this.peekChar() !== END) this.readChar();
    if (doctypeEntities) this.parseDoctypeEntities(s);
    return s;
  }

  private readCData(): string {
    let b = "";
    for (;;) {
      const c = this.readChar();
      if (c === END) throw new XhtmlFormatError("Stream ended before finding ']]>' terminator");
      b += c;
      if (c === ">" && b.length >= 3 && b.charAt(b.length - 2) === "]" && b.charAt(b.length - 3) === "]") break;
    }
    return b.slice(7, b.length - 3);
  }

  private parseDoctypeEntities(s: string): void {
    while (s.includes("<!ENTITY")) {
      s = s.slice(s.indexOf("<!ENTITY"));
      let e = s.indexOf(">");
      let ed = s.slice(0, e + 1);
      s = s.slice(e + 1);
      ed = javaTrim(ed.slice(8));
      e = ed.indexOf(" ");
      const n = javaTrim(ed.slice(0, e));
      ed = javaTrim(ed.slice(e));
      e = ed.indexOf(" ");
      ed = javaTrim(ed.slice(e));
      this.declaredEntities.set(n, ed.slice(0, ed.length - 1));
    }
  }

  private readName(): string {
    let s = "";
    while (isNameChar(this.peekChar())) s += this.readChar();
    return s;
  }

  /** readUntil(String): consumes the terminator too. */
  private readUntil(sc: string): string {
    let s = "";
    while (this.peekChar() !== END && !sc.includes(this.peekChar())) s += this.readChar();
    this.readChar();
    return s;
  }

  private parseLiteral(s: string[]): void {
    this.readChar();
    const c = this.readUntil(";&'\"><");
    if (c === "") throw new XhtmlFormatError(`Invalid literal declaration following text: ${s.join("")}`);
    if (c.charAt(0) === "#") {
      const cp = (v: number): string => {
        if (v < 0 || v > 0x10ffff) throw new XhtmlFormatError(`Not a valid Unicode code point: 0x${(v >>> 0).toString(16).toUpperCase()}`);
        return String.fromCodePoint(v);
      };
      const dec = parseJavaInt(c.slice(1), 10);
      if (dec !== null) s.push(cp(dec));
      else {
        if (c.length < 2) throw new XhtmlFormatError(`Index 1 out of bounds for length ${c.length}`);
        const hex = c.charAt(1) === "x" ? parseJavaInt(c.slice(2), 16) : null;
        if (hex !== null) s.push(cp(hex));
      }
      return;
    }
    const declared = this.declaredEntities.get(c);
    if (declared !== undefined) {
      s.push(declared);
      return;
    }
    if (!["quot", "amp", "apos", "lt", "gt"].includes(c)) this.issues.push({ id: "XHTML_XHTML_Entity_Illegal", param: `&${c};` });
    const defined = xhtmlEntity(c);
    if (defined !== undefined) s.push(defined);
    else {
      const fallback: Record<string, string> = { apos: "'", quot: '"', nbsp: " ", amp: "&", gt: ">", lt: "<" };
      if (fallback[c] !== undefined) s.push(fallback[c]);
      else throw new XhtmlFormatError(`unable to parse character reference '${c}'' (last text = '${this.lastText}'${this.descLoc()}`);
    }
  }
}

export interface XhtmlParse {
  /** The document element (XhtmlDocument.getDocumentElement), null when the parse failed. */
  div: XNode | null;
  /** The FHIRFormatError message when the parse failed. */
  error: string | null;
  /** Parser validation issues (xml mode): messages in Java's wording. */
  issues: string[];
}

const parseCache = new Map<string, XhtmlParse>();

/** XhtmlParser().setXmlMode(true).parse(source, null) as the JSON element model runs it (cached per source text). */
export function parseXhtml(source: string): XhtmlParse {
  const hit = parseCache.get(source);
  if (hit) return hit;
  let r: XhtmlParse;
  const p = new Parser(source);
  try {
    const doc = p.parse();
    r = { div: doc.children.find((c) => c.type === "Element") ?? null, error: null, issues: p.issues.map((i) => `Invalid entity in the XHTML ('${i.param}')`) };
  } catch (e) {
    if (!(e instanceof XhtmlFormatError)) throw e;
    r = { div: null, error: e.message, issues: [] };
  }
  // a parsed tree is ~10x its source: only narratives up to 32k characters are kept, at most 200 of them
  if (source.length > 32768) return r;
  if (parseCache.size >= 200) parseCache.clear();
  parseCache.set(source, r);
  return r;
}

// ------------------------------------------------------------------------------------------- XhtmlValidator

const HTML_ELEMENTS = new Set([
  "p", "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "a", "span", "b", "em", "i", "strong", "small", "big", "tt", "dfn", "q", "var",
  "abbr", "acronym", "cite", "blockquote", "hr", "address", "bdo", "kbd", "sub", "sup", "ul", "ol", "li", "dl", "dt", "dd", "pre",
  "table", "caption", "colgroup", "col", "thead", "tr", "tfoot", "tbody", "th", "td", "code", "samp", "img", "map", "area",
]);
const HTML_ATTRIBUTES = new Set([
  "title", "style", "class", "id", "lang", "xml:lang", "dir", "accesskey", "tabindex", "span", "width", "align", "valign", "char",
  "charoff", "abbr", "axis", "headers", "scope", "rowspan", "colspan",
]);
const HTML_COMBO_LIST = new Set([
  "a.href", "a.name", "img.src", "img.border", "div.xmlns", "blockquote.cite", "q.cite", "a.charset", "a.type", "a.hreflang", "a.rel",
  "a.rev", "a.shape", "a.coords", "img.alt", "img.longdesc", "img.height", "img.width", "img.usemap", "img.ismap", "map.name",
  "area.shape", "area.coords", "area.href", "area.nohref", "area.alt", "table.summary", "table.width", "table.border", "table.frame",
  "table.rules", "table.cellspacing", "table.cellpadding", "pre.space", "td.nowrap",
]);
const HTML_BLOCK_LIST = new Set(["div", "blockquote", "table", "ol", "ul", "p"]);

export interface XhtmlIssue {
  severity: "error" | "warning" | "information";
  message: string;
  id: string;
}

const hasContent = (n: XNode): boolean =>
  n.type === "Text" ? n.content !== null && javaTrim(n.content).length > 0 : n.type === "Element" ? n.children.some(hasContent) : false;

/** UrlUtil.checkValidUrl (with MimeTypeUtil.checkValidMimeType for data: URLs). */
export function checkValidUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value === "") return "URL is empty";
  if (value.startsWith("data:")) {
    const p = value.slice(5).split(",");
    while (p.length && p[p.length - 1] === "") p.pop(); // Java split drops trailing empty strings
    if (p.length < 2) return "No data found in data: URL";
    if (p.length > 2) return `Comma found in data portion of data URL: ${value}`;
    if (p[0].endsWith(";base64") && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(p[1])) return `The data should be valid base64 content for a data: URL: ${value}`;
    let head = p[0];
    if (head.startsWith(" ")) head = head.trim();
    const mimetype = head.endsWith(";base64") ? head.slice(0, head.lastIndexOf(";")) : head;
    // MimeTypeUtil.checkValidMimeType
    if (mimetype.trim() !== "" && !/^(\w+|\*)\/([\w\-+]+|\*)((;\s*(\w+)=\s*(\S+))?)$/.test(mimetype)) {
      return `The mimetype portion of the data: URL is not valid (Mime type invalid) in URL: ${value}`;
    }
    return null;
  }
  const invalid = new Set<string>();
  let c = 0;
  for (const ch of value) {
    if (!(/[\p{Nd}\p{L}\p{Nl}]/u.test(ch) || ";?:@&=+$.,/%-_~#[]!'()*|".includes(ch))) {
      c++;
      invalid.add(ch);
    }
  }
  if (!invalid.size) return null;
  const list = [...invalid].map((ch) => `'${ch}'`).sort().join(",");
  return c === 1 ? `URL contains Invalid Character: ${list}` : `URL contains ${c} Invalid Characters: ${list}`;
}

/** XhtmlValidator.validate: every issue is reported at the element path (the caller's). */
export function validateXhtml(div: XNode): XhtmlIssue[] {
  const out: XhtmlIssue[] = [];
  const rule = (ok: boolean, id: string, message: string): boolean => {
    if (!ok) out.push({ severity: "error", message, id });
    return ok;
  };
  const nsMsg = (ns: string | null | undefined): string => `Wrong namespace on the XHTML ('${ns ?? "null"}', should be '${XHTML_NS}')`;
  const nsDecl = (n: XNode): string | null => (n.attributes.has("xmlns") ? (n.attributes.get("xmlns") ?? null) : null);
  // the namespace
  const ns = nsDecl(div);
  rule(ns === XHTML_NS, "XHTML_XHTML_NS_InValid", nsMsg(ns));
  const innerNS = (list: XNode[]): void => {
    for (const n of list) {
      if (n.type !== "Element") continue;
      const d = nsDecl(n);
      rule(d === null || d === XHTML_NS, "XHTML_XHTML_NS_InValid", nsMsg(d));
      innerNS(n.children);
    }
  };
  innerNS(div.children);
  rule(div.name === "div", "XHTML_XHTML_Name_Invalid", `Wrong name on the XHTML ('${div.name}') - must start with div`);
  // names
  const innerNames = (list: XNode[], inPara: boolean): void => {
    for (const n of list) {
      if (n.type === "Comment") rule(!String(n.content).startsWith("DOCTYPE"), "XHTML_XHTML_DOCTYPE_ILLEGAL", "Malformed XHTML: Found a DocType declaration, and these are not allowed (XXE security vulnerability protection)");
      if (n.type !== "Element") continue;
      rule(HTML_ELEMENTS.has(String(n.name)), "XHTML_XHTML_Element_Illegal", `Invalid element name in the XHTML ('${n.name}')`);
      for (const an of n.attributes.keys()) {
        if (an.startsWith("xmlns") || HTML_ATTRIBUTES.has(an) || HTML_COMBO_LIST.has(`${n.name}.${an}`)) continue;
        if (an === "xml:space") out.push({ severity: "information", id: "XHTML_XHTML_ATTRIBUTE_XML_SPACE", message: "The attribute 'xml:space' is legal but has a fixed value of 'preserve'. Its use is discouraged" });
        else rule(false, "XHTML_XHTML_Attribute_Illegal", `Invalid attribute name in the XHTML ('${an}' on '${n.name}')`);
      }
      rule(!(inPara && HTML_BLOCK_LIST.has(String(n.name))), "XHTML_XHTML_ELEMENT_ILLEGAL_IN_PARA", `Invalid element name inside a paragraph in the XHTML ('${n.name}')`);
      innerNames(n.children, inPara || n.name === "p");
    }
  };
  innerNames(div.children, false);
  // urls
  const urls = (list: XNode[]): void => {
    for (const n of list) {
      if (n.type !== "Element") continue;
      const attr = n.name === "a" ? "href" : n.name === "img" ? "src" : null;
      if (attr) {
        const v = n.attributes.get(attr);
        const msg = checkValidUrl(v);
        rule(msg === null, "XHTML_URL_INVALID", `The URL is not valid because '(${msg})': ${v ?? null}`);
      }
      urls(n.children);
    }
  };
  urls(div.children);
  // structure
  const findDescendents = (list: string[], path: string, x: XNode, names: Set<string>): void => {
    for (const c of x.children) {
      if (c.type !== "Element") continue;
      const cpath = `${path}/${c.name}`;
      if (names.has(String(c.name))) list.push(cpath);
      if (c.children.length) findDescendents(list, cpath, c, names);
    }
  };
  const pRules = (path: string, x: XNode): boolean => {
    const list: string[] = [];
    findDescendents(list, String(x.name), x, new Set(["div", "pre", "table", "ul", "ol"]));
    return rule(!list.length, "XHTML_XHTML_BLOCK_IN_PARA", `Found block structures inside a paragraph/text element ${x.name} at ${path}: ${list.join(",")}`);
  };
  const noRecursion = (path: string, x: XNode): boolean => {
    const list: string[] = [];
    findDescendents(list, String(x.name), x, new Set([String(x.name)]));
    return rule(!list.length, "XHTML_XHTML_NO_RECURSION", `Elements of type ${x.name} at ${path} cannot contain nested ${x.name} at ${list.join(",")}`);
  };
  const noChildren = (path: string, x: XNode): boolean => rule(!x.children.length, "XHTML_XHTML_NO_CHILDREN", `Elements of type ${x.name} cannot have children`);
  const parent = (path: string, x: XNode, p: XNode, ...names: string[]): boolean =>
    rule(names.includes(String(p.name)), "XHTML_XHTML_OUT_OF_PLACE", `Elements of type ${x.name} must be in a ${names.join("|")}, not a ${p.name} at ${path}`);
  const onlyChildren = (path: string, x: XNode, ...names: string[]): boolean => {
    const list: string[] = [];
    for (const c of x.children) {
      if (c.type === "Text" && hasContent(c)) list.push("@text");
      else if (c.type === "Element" && !names.includes(String(c.name))) list.push(String(c.name));
    }
    return rule(!list.length, "XHTML_XHTML_ILLEGAL_CHILDREN", `Elements of type ${x.name} at ${path} cannot have the following children: ${list.join(",")}`);
  };
  const structure = (path: string, x: XNode): void => {
    for (const c of x.children) {
      if (c.type === "DocType" || c.type === "Instruction") {
        if (x.type !== "Document") rule(false, "XHTML_XHTML_BAD_ELEMENT_TYPE", `Elements of type [${c.type.toLowerCase()}] cannot appear at ${path}`);
        continue;
      }
      if (c.type !== "Element") continue;
      const cpath = `${path}/${c.name}`;
      switch (c.name) {
        case "p": case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": case "pre": case "address":
        case "span":
          pRules(cpath, c);
          break;
        case "br": case "img": case "hr": case "area":
          noChildren(cpath, c);
          break;
        case "a": case "b": case "em": case "i": case "strong": case "small": case "big": case "sub": case "sup": case "code": case "tt":
        case "dfn": case "q": case "var": case "abbr": case "acronym": case "cite": case "bdo": case "kbd": case "samp":
          pRules(cpath, c);
          noRecursion(cpath, c);
          break;
        case "table":
          onlyChildren(cpath, c, "tbody", "tr", "caption", "thead", "tfoot", "col", "colgroup");
          break;
        case "tr":
          parent(cpath, c, x, "table", "thead", "tfoot", "tbody");
          onlyChildren(cpath, c, "td", "th");
          break;
        case "tbody": case "thead": case "tfoot":
          parent(cpath, c, x, "table");
          onlyChildren(cpath, c, "tr");
          break;
        case "ul": case "ol":
          onlyChildren(cpath, c, "li");
          break;
        case "caption": case "colgroup":
          if (c.name === "caption") pRules(cpath, c);
          parent(cpath, c, x, "table");
          break;
        case "col":
          parent(cpath, c, x, "colgroup", "table");
          break;
        case "th": case "td":
          parent(cpath, c, x, "tr", "thead", "tfoot");
          break;
        case "li":
          parent(cpath, c, x, "ul", "ol");
          break;
        case "dl":
          onlyChildren(cpath, c, "dd", "dt");
          break;
        case "dd": case "dt":
          pRules(cpath, c);
          parent(cpath, c, x, "dl");
          break;
        case "map":
          onlyChildren(cpath, c, "area");
          break;
      }
      if (c.children.length) structure(cpath, c);
    }
  };
  structure("div", div);
  // mixed languages (warning)
  const langs: string[] = [];
  let nonLang = false;
  for (const n of div.children) {
    if (n.type === "Element" && n.name === "div" && n.attributes.has("xml:lang")) {
      const l = String(n.attributes.get("xml:lang"));
      if (!langs.includes(l)) langs.push(l);
    } else if (hasContent(n)) nonLang = true;
  }
  if (langs.length && nonLang) out.push({ severity: "warning", id: "XHTML_XHTML_MIXED_LANG", message: `The xhtml has some language sections (${langs.join(", ")}), and also has content that is not in a language section` });
  // duplicate ids (warning)
  const ids = new Set<string>();
  const dups = new Map<string, number>();
  const scan = (list: XNode[]): void => {
    for (const n of list) {
      let id: string | null = null;
      if (n.attributes.has("id")) {
        id = String(n.attributes.get("id"));
        if (!ids.has(id)) ids.add(id);
        else dups.set(id, (dups.get(id) ?? 1) + 1);
      }
      if (n.name === "a" && n.attributes.has("name")) {
        const name = String(n.attributes.get("name"));
        if (name !== id) {
          if (!ids.has(name)) ids.add(name);
          else dups.set(name, (dups.get(name) ?? 1) + 1);
        }
      }
      if (n.children.length) scan(n.children);
    }
  };
  scan(div.children);
  if (dups.size) {
    const summary = [...dups.keys()].sort().map((k) => `${k} (${dups.get(k)}x)`);
    out.push({ severity: "warning", id: "XHTML_XHTML_DUPLICATE_IDS", message: `The XHTML  the resource contains more than one node for each of the following node ids and anchor names: ${summary.join(", ")}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------- FHIRPath htmlChecks

const BLOCK_NAMES = HTML_ELEMENTS;
const INLINE_NAMES = new Set(["a", "span", "b", "em", "i", "strong", "small", "big", "q", "var", "abbr", "acronym", "cite", "kbd", "sub", "sup", "code", "samp", "img", "map", "area"]);
const CHECK_ATTRS = new Set([...HTML_ATTRIBUTES, "xml:space"]);

/** FHIRPathEngine.checkHtmlNames (block stays true: the Java recursion compares "p" with a node). */
export function checkHtmlNames(n: XNode, block = true): boolean {
  if (n.type === "Comment" && String(n.content).startsWith("DOCTYPE")) return false;
  if (n.type === "Element") {
    if (!(block ? BLOCK_NAMES : INLINE_NAMES).has(String(n.name))) return false;
    for (const an of n.attributes.keys()) {
      if (!(an.startsWith("xmlns") || CHECK_ATTRS.has(an) || HTML_COMBO_LIST.has(`${n.name}.${an}`))) return false;
    }
    for (const c of n.children) if (!checkHtmlNames(c, block)) return false;
  }
  return true;
}

/** FHIRPathEngine.checkForContent. */
export function checkForContent(n: XNode): boolean {
  if ((n.type === "Text" && javaTrim(String(n.content ?? "")) !== "") || (n.type === "Element" && n.name === "img")) return true;
  return n.children.some(checkForContent);
}

/** XhtmlNode.allText. */
export function allText(n: XNode): string {
  if (!n.children.length) return n.content ?? "";
  let b = "";
  for (const c of n.children) {
    if (c.type === "Element" && c.name === "li") b += "* ";
    if (c.type === "Text" && c.content !== null) b += c.content;
    if (c.type === "Element") {
      if (c.name !== "img") b += allText(c);
      else if (c.attributes.has("alt")) b += String(c.attributes.get("alt"));
      else b += "[image]";
      if (["p", "div", "tr", "th", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6"].includes(String(c.name))) b += "\r\n";
      else if (c.name === "td") b += " ";
    }
  }
  return b;
}

const stripEoln = (s: string): string => s.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ");
const isToken = (s: string): boolean => /^[A-Za-z][A-Za-z0-9_[\]]*$/.test(s);
/** Utilities.isAbsoluteUrl. */
export function isAbsoluteUrl(ref: string): boolean {
  if (!ref.includes(":")) return false;
  const scheme = ref.slice(0, ref.indexOf(":"));
  const details = ref.slice(ref.indexOf(":") + 1);
  const known = ["http", "https", "urn", "file:"].includes(scheme) || (isToken(scheme) && scheme === scheme.toLowerCase()) || /^urn:(iso|iso-iec|iso-cie|iso-astm|iso-ieee|iec):/.test(ref);
  return known && details.length > 0 && !details.includes(" ");
}

/**
 * InstanceValidator.checkReferences without the fragment resolution (TYPE_SPECIFIC_CHECKS_DT_XHTML_RESOLVE /
 * _MULTIPLE_MATCHES, done by the caller): empty hrefs, active / non-literal / unknown schemes.
 */
export function xhtmlHrefIssues(div: XNode): XhtmlIssue[] {
  const out: XhtmlIssue[] = [];
  const walk = (n: XNode, xpath: string): void => {
    if (n.type === "Element" && n.name === "a" && n.attributes.get("href") != null) {
      const href = String(n.attributes.get("href"));
      const text = stripEoln(allText(n));
      if (href === "") out.push({ severity: "error", id: "TYPE_SPECIFIC_CHECKS_DT_XHTML_EMPTY_HREF", message: `Hyperlink at '${xpath}' for '${text}' is empty` });
      else if (!href.startsWith("#") && isAbsoluteUrl(href)) {
        const scheme = href.slice(0, href.indexOf(":"));
        if (scheme === "javascript" || scheme === "vbscript") {
          out.push({ severity: "error", id: "TYPE_SPECIFIC_CHECKS_DT_XHTML_ACTIVE_HREF", message: `Hyperlink scheme '${scheme}' in '${href}' at '${xpath}' for '${text.trim()}' has active content, which is a security risk and not allowed` });
        } else if (scheme === "urn" || scheme === "cid") {
          out.push({ severity: "error", id: "TYPE_SPECIFIC_CHECKS_DT_XHTML_LITERAL_HREF", message: `Hyperlink scheme '${scheme}' in '${href}' at '${xpath}' for '${text.trim()}' is not a valid hyperlinkable scheme` });
        } else if (!["http", "https", "tel", "mailto", "data"].includes(scheme)) {
          out.push({ severity: "information", id: "TYPE_SPECIFIC_CHECKS_DT_XHTML_UNKNOWN_HREF", message: `Hyperlink scheme '${scheme}' in '${href}' at '${xpath}' for '${allText(n).trim()}' is not a widely supported protocol and should be checked` });
        }
      }
    }
    for (const c of n.children) walk(c, `${xpath}/${c.name}`);
  };
  walk(div, "div");
  return out;
}

/** Iteration order of a small java.util.HashSet<String> (capacity 16, no resize below 13 entries). */
export function javaHashSetOrder(values: Iterable<string>): string[] {
  const uniq = [...new Set(values)];
  const hash = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h ^ (h >>> 16);
  };
  let cap = 16;
  while (uniq.length > cap * 0.75) cap *= 2;
  // a bucket keeps insertion order
  return uniq.map((v, i) => ({ v, i, b: hash(v) & (cap - 1) })).sort((a, b) => a.b - b.b || a.i - b.i).map((x) => x.v);
}

const EXT_NARRATIVE_SOURCE_CONTROL = "http://hl7.org/fhir/StructureDefinition/narrative-source-control";
const EXT_NARRATIVE_LANGUAGE_CONTROL = "http://hl7.org/fhir/StructureDefinition/narrative-language-control";

/**
 * InstanceValidator.checkNarrative (the narrative-source-control / narrative-language-control parts): `definition`
 * is the Narrative element's definition, `profile` its StructureDefinition url (printed as StructureDefinition[url]).
 */
export function narrativeControlIssues(
  narrative: Record<string, any>,
  definition: Record<string, any>,
  resourceLanguage: string | null,
  profileUrl: string,
): XhtmlIssue[] {
  const out: XhtmlIssue[] = [];
  const exts: Array<Record<string, any>> = Array.isArray(definition.extension) ? definition.extension : [];
  const profile = `StructureDefinition[${profileUrl}]`;
  const div = typeof narrative.div === "string" ? parseXhtml(narrative.div).div : null;
  const src = exts.find((e) => e?.url === EXT_NARRATIVE_SOURCE_CONTROL);
  if (src) {
    const level = String(src.valueCode ?? src.valueString ?? "");
    for (const x of div?.children ?? []) {
      if (!hasContent(x)) continue;
      const clss = x.attributes.get("class");
      // (sic) hasClass: Utilities.existsInList(clss, clss.split(" ")) — any single-token class passes
      if (clss != null && clss.split(" ").includes(clss)) continue;
      let t = javaTrim(allText(x));
      if (t.length > 30) t = t.slice(0, 29) + "...";
      const message = `The xhtml node at '${t}' does not have a class attribute to indicate its source (boilerplate, generated, or original) and this is required by the profile ${profile}`;
      // (sic) the Java switch falls through: hint → warning → error
      const levels: Array<XhtmlIssue["severity"]> = level === "hint" || level === "information" ? ["information", "warning", "error"] : level === "warning" ? ["warning", "error"] : level === "error" ? ["error"] : [];
      for (const severity of levels) out.push({ severity, id: "XHTML_CONTROL_NO_SOURCE", message });
    }
  }
  const langExts = exts.filter((e) => e?.url === EXT_NARRATIVE_LANGUAGE_CONTROL);
  if (langExts.length) {
    const found: string[] = [];
    for (const n of div?.children ?? []) if (n.type === "Element" && n.name === "div" && n.attributes.has("xml:lang")) found.push(String(n.attributes.get("xml:lang")));
    const langs = javaHashSetOrder(found);
    const list = langs.join(", ");
    const add = (severity: XhtmlIssue["severity"], ok: boolean, id: string, message: string): void => {
      if (!ok) out.push({ severity, id, message });
    };
    for (const ext of langExts) {
      const code = ext.valueCode ?? ext.valueString;
      if (typeof code !== "string") continue;
      if (code === "_no") add("error", !langs.length, "XHTML_CONTROL_NO_LANGS", `The xhtml has some language sections (${list}), but language sections are prohibited in this context by the profile ${profile}`);
      else if (code === "_yes") add("error", langs.length > 0, "XHTML_CONTROL_LANGS_REQUIRED", `The xhtml has no language sections, but language sections are required in this context by the profile ${profile}`);
      else if (code === "_resource") {
        const rl = resourceLanguage;
        if (!langs.length) {
          if (rl === null) add("warning", false, "XHTML_CONTROL_LANGS_NONE_NO_DEFAULT", `The profile ${profile} requires a section in the narrative for the resource language, but there is no sections and no resource language`);
          else add("warning", false, "XHTML_CONTROL_LANGS_NONE", `The profile ${profile} requires a section in the narrative for the resource language ${rl}, but there is no sections`);
        } else if (rl === null) add("warning", false, "XHTML_CONTROL_LANGS_NO_DEFAULT", `The profile ${profile} requires a section in the narrative for the resource language, but there is no language`);
        else add("error", langs.includes(rl), "XHTML_CONTROL_LANGS_REQUIRED_DEF", `The profile ${profile} requires a section in the narrative for the resource language (${rl}), but it was not found (found ${list})`);
      } else if (!langs.length) add("warning", false, "XHTML_CONTROL_LANGS_NONE2", `The profile ${profile} requires a section in the narrative for the language ${code}, but there is no sections`);
      else add("error", langs.includes(code), "XHTML_CONTROL_LANGS_REQUIRED_LANG", `The profile ${profile} requires a section in the narrative for the language '${code}', but it was not found (found ${list})`);
    }
  }
  return out;
}

/**
 * InstanceValidator.validateResourceRules, Language_XHTML_* warnings: a resource with a language whose text.div
 * (or, when every content child is a language div, the first of them) carries no / another lang / xml:lang.
 */
export function languageXhtmlIssues(language: string | null, divSource: unknown): XhtmlIssue[] {
  if (language === null || typeof divSource !== "string") return [];
  const x = parseXhtml(divSource).div;
  if (!x) return [];
  const isLangDiv = (n: XNode): boolean => n.attributes.has("xml:lang");
  let l = x.attributes.get("lang") ?? null;
  let xl = x.attributes.get("xml:lang") ?? null;
  if (l === null && xl === null && x.children.length > 0 && x.children.every((n) => isLangDiv(n) || !hasContent(n))) {
    const ld = x.children.find(isLangDiv);
    // (sic) Java (IV:7397-7400): no child is a language div (only content-less ones, e.g. a lone <img/>) →
    // firstLangDiv returns null and validator_cli fails the validation with a NullPointerException.
    // NON-OFFICIAL TEXT: the JVM's NullPointerException message, not a Messages.properties entry.
    if (!ld) return [{ severity: "error", id: "exception", message: `Cannot invoke "org.hl7.fhir.utilities.xhtml.XhtmlNode.getAttribute(String)" because "ld" is null` }];
    l = ld.attributes.get("lang") ?? null;
    xl = ld.attributes.get("xml:lang") ?? null;
  }
  const w = (id: string, message: string): XhtmlIssue => ({ severity: "warning", id, message });
  const tail = "see https://www.w3.org/TR/i18n-html-tech-lang/#langvalues)";
  if (l === null && xl === null) return [w("Language_XHTML_Lang_Missing1", `Resource has a language, but the XHTML does not have an lang or an xml:lang tag (needs both - ${tail}`)];
  const out: XhtmlIssue[] = [];
  if (l === null) out.push(w("Language_XHTML_Lang_Missing2", `Resource has a language, but the XHTML does not have a lang tag (needs both lang and xml:lang - ${tail}`));
  else if (l !== language) out.push(w("Language_XHTML_Lang_Different1", `Resource has a language (${language}), and the XHTML has a lang (${l}), but they differ`));
  if (xl === null) out.push(w("Language_XHTML_Lang_Missing3", `Resource has a language, but the XHTML does not have an xml:lang tag (needs both lang and xml:lang - ${tail}`));
  else if (xl !== language && xl !== l) out.push(w("Language_XHTML_Lang_Different2", `Resource has a language (${language}), and the XHTML has an xml:lang (${xl}), but they differ`));
  return out;
}

const EXT_TEXT_LINK ="http://hl7.org/fhir/StructureDefinition/textLink";

/** Elements (objects) with `id` === fragment below `node` (BaseValidator.getFragmentMatches, ELEMENT_ID kind). */
function elementIdMatches(node: unknown, fragment: string, out: unknown[], depth = 0): void {
  if (depth > 60 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) elementIdMatches(x, fragment, out, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  if (depth > 0 && o.id === fragment) out.push(o);
  for (const [k, v] of Object.entries(o)) if (k !== "id") elementIdMatches(v, fragment, out, depth + 1);
}

function divHasAnyId(n: XNode): boolean {
  return n.attributes.has("id") || n.children.some(divHasAnyId);
}

function divHasId(n: XNode, id: string): boolean {
  if (n.attributes.get("id") === id) return true;
  return n.children.some((c) => divHasId(c, id));
}

/**
 * InstanceValidator.checkNarrative, textLink part (TEXT_LINK_*): `narrative` has textLink extensions; `resource` is
 * the resource holding it; `bundleEntries` the entries of the Bundle it sits in (getElementBundle), or null.
 * (sic) the "no div / no id / no data" rules test Narrative.display, which does not exist, so they always fire.
 * TEXT_LINK_SELECTOR_INVALID: fpe.parse here; each selector that parses is handed back in `selectors` with the target
 * the data reference found, for the caller's fpe.check against that target's type.
 */
export interface TextLinkSelector {
  selector: string;
  expr: ExprNode;
  /** The resource or element the data reference found, null when there is none. */
  target: unknown;
}

export function textLinkIssues(
  narrative: Record<string, any>,
  resource: Record<string, any>,
  bundleEntries: Array<Record<string, any>> | null,
  selectors: TextLinkSelector[] = [],
): XhtmlIssue[] {
  const exts = (Array.isArray(narrative.extension) ? narrative.extension : []).filter((e: any) => e?.url === EXT_TEXT_LINK);
  if (!exts.length) return [];
  const out: XhtmlIssue[] = [];
  const err = (id: string, message: string): void => {
    out.push({ severity: "error", id, message });
  };
  const div = typeof narrative.div === "string" ? parseXhtml(narrative.div).div : null;
  if (!div) {
    err("TEXT_LINK_NO_DIV", "A textLink extension was found, but there was no xhtml element present for that targets of the html references");
    return out;
  }
  const sub = (ex: any, url: string): any[] => (Array.isArray(ex?.extension) ? ex.extension : []).filter((e: any) => e?.url === url);
  const str = (e: any): string | null => {
    if (!e) return null;
    for (const [k, v] of Object.entries(e)) if (k.startsWith("value") && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) return String(v);
    return null;
  };
  const entryResources = (bundleEntries ?? []).filter((e) => e && typeof e.resource === "object" && e.resource);
  const fragmentMatches = (from: Record<string, any>, fragment: string, withBundle: boolean): unknown[] => {
    const found: unknown[] = [];
    elementIdMatches(from, fragment, found);
    if (withBundle) for (const e of entryResources) if (e.resource.id === fragment) found.push(e.resource);
    return found;
  };
  for (const ex of exts) {
    for (const h of sub(ex, "htmlid")) {
      const id = str(h);
      // InstanceValidator.divHasId (validation tag 7.0.1:5196-5197): an htmlid without a value is `id.equals(…)` on
      // null at the first xhtml node with an id attribute — the validation fails (official-crash)
      if (id === null) {
        if (divHasAnyId(div)) out.push({ severity: "error", id: "JAVA_NPE", message: 'Cannot invoke "String.equals(Object)" because "id" is null' });
        continue;
      }
      if (!divHasId(div, id)) err("TEXT_LINK_NO_ID", `The html id '${id}' was not found in the xhtml`);
    }
    const data = str(sub(ex, "data")[0]);
    const notFound = (): void => err("TEXT_LINK_DATA_NOT_FOUND", `The target of the textLink data reference '${data}' was not found in the resource`);
    const multiple = (): void => err("TEXT_LINK_DATA_MULTIPLE_MATCHES", `Multiple matching targets for the textLink data reference '${data}' were found in the resource`);
    // the element `type` is taken from (matches.get(0).fhirType()), when one was found
    let target: unknown = null;
    if (data === null) err("TEXT_LINK_NO_DATA", "No data element was found in the textLink extension");
    else if (data.startsWith("#")) {
      const found = fragmentMatches(resource, data.slice(1), bundleEntries !== null);
      if (found.length === 0) notFound();
      else {
        if (found.length > 1) multiple();
        target = found[0];
      }
    } else {
      const hash = data.indexOf("#");
      const url = hash >= 0 ? data.slice(0, hash) : data;
      const fragment = hash >= 0 ? data.slice(hash + 1) : null;
      const matches = entryResources.filter((e) => `${e.resource.resourceType}/${e.resource.id}` === url || e.fullUrl === url).map((e) => e.resource);
      if (!matches.length) notFound();
      else {
        if (matches.length > 1) multiple();
        target = matches[0];
        if (fragment !== null) {
          const found = fragmentMatches(matches[0], fragment, false);
          if (found.length === 0) notFound();
          else {
            if (found.length > 1) multiple();
            target = found[0];
          }
        }
      }
    }
    const selector = str(sub(ex, "selector")[0]);
    if (selector !== null) {
      try {
        selectors.push({ selector, expr: parseFhirPathJava(selector), target });
      } catch (e) {
        if (!(e instanceof FHIRLexerError)) throw e;
        err("TEXT_LINK_SELECTOR_INVALID", `The textLink selector '${selector}' is invalid: ${e.message}`);
      }
    }
  }
  return out;
}

/** FHIRPathEngine.funcHtmlChecks1 on an xhtml-typed value: false when the source does not parse. */
export function htmlChecks1(source: string): boolean {
  const p = parseXhtml(source);
  return p.div !== null && checkHtmlNames(p.div);
}

/** FHIRPathEngine.funcHtmlChecks2 on an xhtml-typed value: false when the source does not parse. */
export function htmlChecks2(source: string): boolean {
  const p = parseXhtml(source);
  return p.div !== null && checkForContent(p.div);
}
