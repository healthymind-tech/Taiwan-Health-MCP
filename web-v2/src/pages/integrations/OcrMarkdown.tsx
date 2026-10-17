import { IconPhotoOff } from "@tabler/icons-react";
import { Fragment, createElement, useMemo, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import classes from "./Markdown.module.css";

/**
 * Renders MinerU OCR Markdown.
 *
 * Two MinerU quirks are handled here:
 *  - images are inlined by the backend as `data:image/*` URIs, which react-markdown's
 *    default URL sanitiser would strip — we allow exactly that scheme;
 *  - tables are emitted as raw HTML `<table>` blocks. react-markdown drops raw HTML
 *    (no rehype-raw), so table blocks are parsed with DOMParser and rebuilt as React
 *    elements from a strict tag/attribute allow-list (no scripts, no handlers, no styles).
 */
export function OcrMarkdown({ content }: { content: string }) {
  const segments = useMemo(() => splitTables(content), [content]);
  return (
    <div className={classes.prose}>
      {segments.map((seg, i) =>
        seg.kind === "table" ? (
          <div key={i} className={classes.tableWrap}>
            <HtmlTable html={seg.text} />
          </div>
        ) : (
          <Markdown
            key={i}
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => (url.startsWith("data:image/") ? url : defaultUrlTransform(url))}
            components={{
              img: ({ src, alt }) =>
                typeof src === "string" && (src.startsWith("data:image/") || /^https?:\/\//.test(src)) ? (
                  <img src={src} alt={alt ?? ""} loading="lazy" />
                ) : (
                  <span className={classes.brokenImage}>
                    <IconPhotoOff size={14} /> 圖片未內嵌{alt ? `：${alt}` : ""}
                  </span>
                ),
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {children}
                </a>
              ),
              table: ({ children }) => (
                <div className={classes.tableWrap}>
                  <table>{children}</table>
                </div>
              ),
            }}
          >
            {seg.text}
          </Markdown>
        ),
      )}
    </div>
  );
}

type Segment = { kind: "md" | "table"; text: string };

function splitTables(md: string): Segment[] {
  const out: Segment[] = [];
  const re = /<table[\s\S]*?<\/table>/gi;
  let last = 0;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    if (m.index > last) out.push({ kind: "md", text: md.slice(last, m.index) });
    out.push({ kind: "table", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push({ kind: "md", text: md.slice(last) });
  return out.filter((s) => s.text.trim() !== "");
}

const ALLOWED_TAGS = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "br", "b", "strong", "i", "em", "u", "sub", "sup", "span", "p", "div", "ul", "ol", "li", "code",
]);
const VOID_TAGS = new Set(["br", "col"]);

function HtmlTable({ html }: { html: string }) {
  const nodes = useMemo(() => {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    return Array.from(doc.body.childNodes).map((n, i) => toReact(n, String(i)));
  }, [html]);
  return <>{nodes}</>;
}

function toReact(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const children = Array.from(el.childNodes).map((c, i) => toReact(c, `${key}.${i}`));
  if (!ALLOWED_TAGS.has(tag)) return <Fragment key={key}>{children}</Fragment>;
  const props: Record<string, unknown> = { key };
  const rowSpan = Number(el.getAttribute("rowspan"));
  const colSpan = Number(el.getAttribute("colspan"));
  if (rowSpan > 1) props.rowSpan = Math.min(rowSpan, 1000);
  if (colSpan > 1) props.colSpan = Math.min(colSpan, 1000);
  if (VOID_TAGS.has(tag)) return createElement(tag, props);
  return createElement(tag, props, ...children);
}
