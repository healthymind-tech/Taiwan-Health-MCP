/**
 * HTML parsing helpers for the TFDA drug information site.
 *
 * Node port of `src/tfda_parser_utils.py`. The Python original parses with
 * BeautifulSoup (lxml); this uses cheerio. The two libraries do NOT agree out of
 * the box on the one thing this module does most — pulling text out of a node —
 * so the BeautifulSoup semantics are reproduced explicitly in `getText` below.
 * Everything else is a faithful transliteration; the field names stay Chinese
 * because they are the TFDA page's own labels and become JSON keys downstream.
 */

import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

export type Soup = cheerio.CheerioAPI;
export type Node = cheerio.Cheerio<AnyNode>;

export const BASE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

export const UI_IMAGE_KEYWORDS = ["/Content/", "/logo", "/AA.", "/VerificationCode", "favicon"];

const UPLOAD_DATE_RE = /(?<!\d)\d{2,4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d)/;
// Python: re.compile(r"^\s*\([一二三四五六七八九十百千]+\)\s*", re.MULTILINE)
const ENUM_RE = /^[ \t]*\([一二三四五六七八九十百千]+\)[ \t]*/m;
const ENUM_RE_G = /^[ \t]*\([一二三四五六七八九十百千]+\)[ \t]*/gm;

export function makeSoup(html: string): Soup {
  return cheerio.load(html);
}

/**
 * BeautifulSoup's `get_text(separator, strip)`, reproduced.
 *
 * BS4 walks every text node in document order. With `strip=true` each string is
 * stripped and the empty ones dropped, then the survivors are joined by
 * `separator`. cheerio's `.text()` merely concatenates raw text, which destroys
 * the word boundaries the TFDA markup relies on ("A</td><td>B" must not become
 * "AB") and keeps the layout whitespace BS4 would have removed. Getting this
 * wrong fails silently: it yields plausible but subtly different strings.
 */
export function getText(node: Node | undefined, separator = "", strip = false): string {
  if (!node || node.length === 0) return "";
  const parts: string[] = [];
  const walk = (n: AnyNode): void => {
    if (n.type === "text") {
      parts.push((n as unknown as { data: string }).data);
      return;
    }
    const children = (n as Element).children;
    if (children) for (const c of children) walk(c as AnyNode);
  };
  for (const el of node.toArray()) walk(el as AnyNode);
  if (!strip) return parts.join(separator);
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .join(separator);
}

/** Python `urllib.parse.quote(value, safe="")`. */
export function encodeLicenseId(licenseId: string): string {
  return encodeURIComponent(licenseId).replace(
    /[!'()*~]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** RFC 3986 §5.2.4 remove_dot_segments, on the raw path. */
function removeDotSegments(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  let joined = out.join("/");
  if (/(^|\/)(\.|\.\.)$/.test(path) && !joined.endsWith("/")) joined += "/";
  return joined;
}

/**
 * Python `urllib.parse.urljoin`, as a string merge.
 *
 * WHATWG `new URL(href, base)` would percent-encode the non-ASCII path — TFDA's
 * shape-detail links carry the Chinese license number verbatim, and encoding it
 * changes `detail_url`, which is persisted and compared downstream.
 */
export function absUrl(baseUrl: string, href: string): string {
  if (href.startsWith("http")) return href;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\//.exec(baseUrl);
  const scheme = schemeMatch ? schemeMatch[1] : "https:";
  const afterScheme = schemeMatch ? baseUrl.slice(schemeMatch[0].length) : baseUrl;
  const slash = afterScheme.indexOf("/");
  const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  const basePathFull = slash === -1 ? "" : afterScheme.slice(slash);
  const basePath = basePathFull.split(/[?#]/)[0] ?? "";
  const origin = `${scheme}//${authority}`;

  if (href === "") return origin + basePathFull;
  if (href.startsWith("//")) return `${scheme}${href}`;
  if (href.startsWith("#")) return origin + basePathFull + href;
  if (href.startsWith("?")) return origin + basePath + href;
  if (href.startsWith("/")) return origin + removeDotSegments(href);

  const parent = basePath.slice(0, basePath.lastIndexOf("/") + 1) || "/";
  return origin + removeDotSegments(parent + href);
}

/** Python `str.strip(chars)` — trims any of `chars` from both ends. */
function stripChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

export function safeFilename(name: string, maxLen = 180): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = stripChars((name || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_"), ". ");
  return cleaned ? cleaned.slice(0, maxLen) : "file";
}

export function normalizeUploadDate(dateText: string): string {
  const m = UPLOAD_DATE_RE.exec(dateText || "");
  if (!m) return "";
  return m[0].replace(/[-/.]/g, "-");
}

export function extractDateFromFilename(filename: string): string {
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  const ad = [...(filename || "").matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)];
  if (ad.length > 0) {
    const [, y, mo, d] = ad[ad.length - 1];
    return `${pad(Number(y), 4)}-${pad(Number(mo), 2)}-${pad(Number(d), 2)}`;
  }
  // Republic-of-China years: 3 digits, offset by 1911.
  const roc = [...(filename || "").matchAll(/(?<!\d)(\d{3})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)];
  if (roc.length > 0) {
    const [, y, mo, d] = roc[roc.length - 1];
    return `${pad(Number(y) + 1911, 4)}-${pad(Number(mo), 2)}-${pad(Number(d), 2)}`;
  }
  return "";
}

/** Python `pathlib.Path(name).stem` / `.suffix`. */
function splitExt(filename: string): { stem: string; suffix: string } {
  const base = filename.split("/").pop() ?? filename;
  const i = base.lastIndexOf(".");
  // A leading dot belongs to the name, not an extension (Path(".x").suffix == "").
  if (i <= 0) return { stem: base, suffix: "" };
  return { stem: base.slice(0, i), suffix: base.slice(i) };
}

export function filenameWithUploadDate(filename: string, uploadDate: string): string {
  const date = normalizeUploadDate(uploadDate);
  if (!date) return filename;
  const { stem, suffix } = splitExt(filename);
  if (stem.replace(/[-/.]/g, "-").includes(date)) return filename;
  return `${stem}-${date}${suffix}`;
}

export function extractUploadDateFromRow(row: Node | null | undefined): string {
  if (!row || row.length === 0) return "";
  const dateCell = row.find('[data-label*="上傳日期"], [data-label*="日期"]').first();
  if (dateCell.length > 0) {
    const date = normalizeUploadDate(getText(dateCell, " ", true));
    if (date) return date;
  }
  return normalizeUploadDate(getText(row, " ", true));
}

/** Python `_clean_text`: newline-joined text, each line stripped, blanks dropped. */
function cleanText(node: Node): string {
  return getText(node, "\n", false)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** A "(一) … (二) …" block becomes a list; anything else stays a string. */
function listifyIfEnumerated(text: string): string | string[] {
  if (!ENUM_RE.test(text)) return text;
  const items = text
    .split(ENUM_RE_G)
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length > 0 ? items : text;
}

export interface PdfLink {
  url: string;
  label?: string;
  filename?: string;
  date: string;
}

export function collectPdfLinks($: Soup, baseUrl: string, pathFragment: string): PdfLink[] {
  const seen = new Set<string>();
  const links: PdfLink[] = [];
  $(`a[href*="${pathFragment}"]`).each((_, el) => {
    const anchor = $(el);
    const href = (anchor.attr("href") ?? "").trim();
    if (!href || seen.has(href)) return;
    seen.add(href);
    const label = getText(anchor, "", true) || stripChars(href, "/").split("/").pop() || "";
    links.push({
      url: absUrl(baseUrl, href),
      label,
      date: extractUploadDateFromRow(anchor.closest("tr")),
    });
  });
  return links;
}

export function popupPdfLinks($: Soup, baseUrl: string, popupName: string): PdfLink[] {
  const popup = $(`div[data_popup='${popupName}']`).first();
  if (popup.length === 0) return [];
  const links: PdfLink[] = [];
  popup.find("tbody tr").each((_, el) => {
    const row = $(el);
    const anchor = row.find("a[href]").first();
    if (anchor.length === 0) return;
    const tds = row.find("td");
    links.push({
      url: absUrl(baseUrl, anchor.attr("href") ?? ""),
      filename: getText(anchor, "", true),
      date: tds.length > 2 ? getText(tds.eq(2), "", true) : "",
    });
  });
  return links;
}

export function parseBasicInfo($: Soup): Record<string, string> {
  const info: Record<string, string> = {};
  $("div.left-block, div.right-block").each((_, block) => {
    $(block)
      .find("div.page_name")
      .each((__, pname) => {
        const label = $(pname).find("label").first();
        const span = $(pname).find("span").first();
        if (label.length > 0 && span.length > 0) {
          const key = getText(label, "", true);
          if (key) info[key] = getText(span, "", true);
        }
      });
  });
  return info;
}

export function parseManufacturers($: Soup): Record<string, string>[] {
  const manufacturers: Record<string, string>[] = [];
  $("ul.page_name_list > li").each((_, item) => {
    $(item)
      .children("div")
      .each((__, div) => {
        const header = $(div).find("h1").first();
        if (header.length === 0) return;
        const manufacturer: Record<string, string> = { 類型: getText(header, "", true) };
        $(div)
          .find("div.page_name")
          .each((___, pname) => {
            const label = $(pname).find("label").first();
            const span = $(pname).find("span").first();
            if (label.length > 0 && span.length > 0) {
              manufacturer[getText(label, "", true)] = getText(span, "", true);
            }
          });
        manufacturers.push(manufacturer);
      });
  });
  return manufacturers;
}

export function parseSections($: Soup): Record<string, unknown> {
  const sections: Record<string, unknown> = {};
  const toggleAll = $("div.toggle-all").first();
  if (toggleAll.length === 0) return sections;

  const stripCode = /^\d+(\.\d+)*\s+/;
  toggleAll.children("div.toggle").each((_, toggleEl) => {
    const toggle = $(toggleEl);
    const titleEl = toggle.find("div.toggle-title span.title-name").first();
    if (titleEl.length === 0) return;
    const title = getText(titleEl, "", true).replace(stripCode, "");

    const inner = toggle.find("div.toggle-inner div.inner").first();
    if (inner.length === 0) {
      sections[title] = "";
      return;
    }

    // Only outermost sub-tables: a nested one is content of its parent's row.
    const directSubTables = inner
      .find("table.sub-table")
      .filter((__, t) => $(t).parents("table.sub-table").length === 0);

    if (directSubTables.length > 0) {
      const subDict: Record<string, unknown> = {};
      directSubTables.each((__, tableEl) => {
        const tbody = $(tableEl).find("tbody").first();
        if (tbody.length === 0) return;
        const rows = tbody.children("tr");
        if (rows.length < 2) return;
        const nameCells = rows.eq(0).find("td.title-name");
        if (nameCells.length === 0) return;
        const subKey = getText(nameCells.eq(nameCells.length - 1), "", true);
        if (!subKey) return;
        const contentTds = rows.eq(1).find("td");
        if (contentTds.length >= 2) {
          const content = cleanText(contentTds.eq(1));
          if (content) subDict[subKey] = listifyIfEnumerated(content);
        }
      });
      sections[title] = Object.keys(subDict).length > 0 ? subDict : "";
    } else {
      sections[title] = listifyIfEnumerated(cleanText(inner));
    }
  });

  return sections;
}

/** Python `_normalize_quantity`: "3.0" -> "3", "2.50" -> "2.5", "abc" -> null. */
function normalizeQuantity(raw: string): string | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value === Math.trunc(value)) return String(Math.trunc(value));
  // Python's f"{value:g}": 6 significant digits, trailing zeros trimmed.
  return String(Number(value.toPrecision(6)));
}

function fixIngredientQuantity(item: Record<string, string>): Record<string, string> {
  if (item["含量"]) return item;
  const normalized = normalizeQuantity(item["含量描述"] ?? "");
  if (normalized !== null) item["含量"] = normalized;
  return item;
}

/** Python `dict(zip(headers, cells))` — stops at the shorter of the two. */
function zipDict(headers: string[], cells: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < Math.min(headers.length, cells.length); i += 1) out[headers[i]] = cells[i];
  return out;
}

/** Python `str(list_of_str)` — the repr the header-less fallback row stores. */
function pyReprList(items: string[]): string {
  return `[${items.map((s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ")}]`;
}

export function parseIngredients($: Soup): { 處方標示: string; 成分: Record<string, string>[] } {
  const result: { 處方標示: string; 成分: Record<string, string>[] } = { 處方標示: "", 成分: [] };
  const popup = $("div[data_popup='popup-element']").first();
  if (popup.length === 0) return result;

  const firstTheadTd = popup.find("table:first-of-type thead tr td").first();
  if (firstTheadTd.length > 0) result["處方標示"] = getText(firstTheadTd, "", true);

  const tables = popup.find("table");
  if (tables.length >= 2) {
    const headers: string[] = [];
    tables
      .eq(1)
      .find("thead th")
      .each((_, th) => {
      headers.push(getText($(th), "", true));
    });
    tables
      .eq(1)
      .find("tbody tr")
      .each((_, tr) => {
        const cells: string[] = [];
        $(tr)
          .find("td")
          .each((__, td) => {
          cells.push(getText($(td), "", true));
        });
        if (cells.length > 0 && cells.length === headers.length) {
          result["成分"].push(fixIngredientQuantity(zipDict(headers, cells)));
        }
      });
  }
  return result;
}

/** Rows of a popup table keyed by its <thead>; shared by ATC and authorizations. */
function popupTableRows(
  $: Soup,
  popupName: string,
  skipRow?: (cells: string[]) => boolean,
): Record<string, string>[] {
  const popup = $(`div[data_popup='${popupName}']`).first();
  if (popup.length === 0) return [];
  const headers: string[] = [];
  popup.find("thead th").each((_, th) => {
      headers.push(getText($(th), "", true));
    });
  const results: Record<string, string>[] = [];
  popup.find("tbody tr").each((_, tr) => {
    const cells: string[] = [];
    $(tr)
      .find("td")
      .each((__, td) => {
          cells.push(getText($(td), "", true));
        });
    if (cells.length === 0) return;
    if (skipRow && skipRow(cells)) return;
    results.push(headers.length > 0 ? zipDict(headers, cells) : { raw: pyReprList(cells) });
  });
  return results;
}

export function parseAtcCodes($: Soup): Record<string, string>[] {
  return popupTableRows($, "popup-1");
}

export function parseAuthorizations($: Soup): Record<string, string>[] {
  return popupTableRows($, "popup-authorization", (cells) =>
    cells.some((cell) => cell.includes("查無資料")),
  );
}

export function hasElectronicInsertContent(data: Record<string, unknown>): boolean {
  const ingredients = data.ingredients;
  let ingredientRows: unknown = [];
  if (ingredients && typeof ingredients === "object") {
    const ing = ingredients as Record<string, unknown>;
    // The mojibake key is deliberate — it mirrors the Python, which tolerates a
    // mis-decoded "成分" seen in some cached payloads.
    ingredientRows = ing["成分"] || ing["æˆåˆ†"] || [];
  }
  const truthy = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.length > 0;
    if (v === null || v === undefined || v === "") return false;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return Boolean(v);
  };

  return [
    data.basic_info,
    data.manufacturers,
    data.sections,
    data.atc_codes,
    ingredientRows,
    data.label_pdfs,
    data.history_pdfs,
    data.public_pdfs,
    data.paper_pdfs,
    data.authorizations,
  ].some(truthy);
}

export function parseShapeDetail(
  $: Soup,
  shapeId: string,
  detailUrl: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = { shape_id: shapeId, detail_url: detailUrl };

  // Python: soup.find(string=re.compile(r"外觀編號")) — the first matching *text node*.
  let numberText: string | null = null;
  const walk = (n: AnyNode): void => {
    if (numberText !== null) return;
    if (n.type === "text") {
      const t = (n as unknown as { data: string }).data;
      if (t.includes("外觀編號")) numberText = t;
      return;
    }
    const children = (n as Element).children;
    if (children) for (const c of children) walk(c as AnyNode);
  };
  walk($.root()[0] as AnyNode);
  if (numberText !== null) {
    data["外觀編號"] = (numberText as string).replace("外觀編號：", "").trim();
  }

  $("div.page_name").each((_, pname) => {
    const label = $(pname).find("label").first();
    const span = $(pname).find("span").first();
    if (label.length > 0 && span.length > 0) {
      const key = getText(label, "", true);
      if (key) data[key] = getText(span, "", true);
    }
  });

  $("table").each((_, tableEl) => {
    if ($(tableEl).parents("noscript").length > 0) return;
    $(tableEl)
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr).find("th, td");
        if (cells.length !== 2) return;
        const key = getText(cells.eq(0), "", true);
        const value = getText(cells.eq(1), "\n", true);
        if (key && !/^\d+$/.test(key) && key.length < 80 && !(key in data)) data[key] = value;
      });
  });

  $(".gridedit .row").each((_, rowEl) => {
    const cols = $(rowEl).children(".col");
    for (let idx = 0; idx + 1 < cols.length; idx += 2) {
      const label = getText(cols.eq(idx), " ", true).replace(/\s+/g, "");
      const value = getText(cols.eq(idx + 1), " ", true);
      if (label && !(label in data)) data[label] = value;
    }
  });

  const appearanceFiles: Record<string, string>[] = [];
  $(".upload_list_table tbody tr").each((_, tr) => {
    const row = $(tr);
    const link = row.find("a[href]").first();
    if (link.length === 0) return;
    const dateCell = row.find('[data-label*="上傳日期"]').first();
    appearanceFiles.push({
      filename: getText(link, " ", true),
      upload_date: dateCell.length > 0 ? getText(dateCell, " ", true) : "",
      source_url: link.attr("href") ?? "",
    });
  });
  data.appearance_files = appearanceFiles;
  return data;
}

export function parseShapeList($: Soup, baseUrl: string): Record<string, string>[] {
  const detailLinks: Record<string, string>[] = [];
  $("a[href*='/im_shape_detail/']").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href") ?? "";
    const match = /\/im_shape_detail\/([^?/]+)/.exec(href);
    const shapeId = match ? match[1] : `shape_${detailLinks.length + 1}`;
    detailLinks.push({
      shape_id: shapeId,
      detail_url: absUrl(baseUrl, href),
      label: getText(anchor, " ", true),
      upload_date: extractUploadDateFromRow(anchor.closest("tr")),
    });
  });
  return detailLinks;
}

export function inferContentType(filename: string, fallback = "application/octet-stream"): string {
  const { suffix } = splitExt(filename);
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".json": "application/json",
    ".md": "text/markdown",
  };
  return map[suffix.toLowerCase()] ?? fallback;
}

/** Python `parse_date`: the first YYYY-M-D in the string, or null if invalid. */
export function parseDate(value: string): Date | null {
  if (!value) return null;
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Python raises ValueError on an out-of-range date; JS would silently roll over.
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return dt;
}
