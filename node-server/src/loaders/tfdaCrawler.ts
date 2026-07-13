/**
 * Async TFDA enrichment scraper.
 *
 * Node port of `src/tfda_crawler_service.py`. Scrapes, for one license:
 * - the electronic insert page
 * - the insert PDF listing
 * - the label PDF listing
 * - appearance records and their images
 */

import { createHash } from "node:crypto";
import { logInfo, logWarning } from "../logger.js";
import {
  BASE_HEADERS,
  UI_IMAGE_KEYWORDS,
  absUrl,
  collectPdfLinks,
  encodeLicenseId,
  extractDateFromFilename,
  filenameWithUploadDate,
  getText,
  hasElectronicInsertContent,
  inferContentType,
  makeSoup,
  normalizeUploadDate,
  parseAtcCodes,
  parseAuthorizations,
  parseBasicInfo,
  parseIngredients,
  parseManufacturers,
  parseSections,
  parseShapeDetail,
  parseShapeList,
  popupPdfLinks,
  safeFilename,
  type PdfLink,
} from "./tfdaParserUtils.js";

export interface ScrapedAsset {
  assetType: string;
  assetGroup: string;
  sourcePage: string;
  sourceUrl: string;
  sourceFilename: string;
  normalizedFilename: string;
  uploadDate: string;
  mimeType: string;
  content: Buffer;
  downloadStatus: string;
  downloadedAt: Date;
  sizeBytes: number;
  sha256: string;
}

export interface AppearanceRecordScrape {
  shapeId: string;
  detailUrl: string;
  rawJson: Record<string, unknown>;
  images: ScrapedAsset[];
}

export interface DrugEnrichmentPayload {
  licenseId: string;
  electronicInsert: Record<string, unknown> | null;
  insertAssets: ScrapedAsset[];
  labelAssets: ScrapedAsset[];
  appearanceRecords: AppearanceRecordScrape[];
  errors: string[];
}

interface FetchResult {
  body: Buffer;
  contentType: string;
}

const IMAGE_SUFFIXES = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);

/** Trailing extension of a path-like name, lower-cased, or "" (Python `Path.suffix`). */
function suffixOf(name: string): string {
  const base = name.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Final path segment, query stripped (Python `Path(url.split("?")[0]).name`). */
function basename(url: string): string {
  return (url.split("?")[0] ?? "").split("/").pop() ?? "";
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TFDACrawlerService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl?: string | null, timeout?: number | null) {
    // Explicit args (from DB settings) take precedence; fall back to env.
    const base = baseUrl || process.env.DRUG_TFDA_BASE_URL || "https://mcp.fda.gov.tw";
    this.baseUrl = base.replace(/\/+$/, "");
    const seconds = Number(timeout || process.env.DRUG_HTTP_TIMEOUT || 30);
    this.timeoutMs = seconds * 1000;
  }

  private get headers(): Record<string, string> {
    // Accept-Encoding is dropped: undici negotiates and decodes it for us, and
    // advertising `br` by hand yields a body we would then have to inflate.
    const { "Accept-Encoding": _drop, ...rest } = BASE_HEADERS;
    return { ...rest, Referer: `${this.baseUrl}/im` };
  }

  /**
   * One GET with the Python retry ladder: 404/403 -> null, other failures retried
   * three times with a 2/4/6s backoff, then rethrown.
   */
  private async fetchUrl(url: string): Promise<FetchResult | null> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: this.headers,
          redirect: "follow",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status === 404 || response.status === 403) return null;
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} for ${url}`);
          if (attempt === 3) throw lastError;
        } else {
          return {
            body: Buffer.from(await response.arrayBuffer()),
            contentType: response.headers.get("content-type") ?? "",
          };
        }
      } catch (err) {
        lastError = err;
        if (attempt === 3) throw err;
      }
      await sleep(Math.min(2 ** attempt, 6) * 1000);
    }
    if (lastError) throw lastError;
    return null;
  }

  private async fetchText(url: string): Promise<string | null> {
    const result = await this.fetchUrl(url);
    return result === null ? null : result.body.toString("utf8");
  }

  private async downloadAsset(opts: {
    assetType: string;
    assetGroup: string;
    sourcePage: string;
    sourceUrl: string;
    sourceFilename: string;
    normalizedFilename: string;
    uploadDate: string;
  }): Promise<ScrapedAsset | null> {
    const response = await this.fetchUrl(opts.sourceUrl);
    if (response === null) return null;

    // TFDA serves some "PDF" links as an HTML viewer page, and answers 200 with
    // a PDF-ish Content-Type either way, so the header cannot be trusted. Storing
    // that HTML as a .pdf asset only defers the failure to OCR, which rejects it
    // ("Unsupported file type: html") — drop it at the source instead.
    if (
      opts.assetType.endsWith("_pdf") &&
      !response.body.subarray(0, 5).equals(Buffer.from("%PDF-"))
    ) {
      logWarning("Skipping non-PDF content served from a PDF link", {
        asset_type: opts.assetType,
        source_url: opts.sourceUrl,
        leading_bytes: JSON.stringify(response.body.subarray(0, 8).toString("latin1")),
      });
      return null;
    }

    const mimeType =
      (response.contentType.split(";")[0] ?? "").trim() || inferContentType(opts.normalizedFilename);

    return {
      assetType: opts.assetType,
      assetGroup: opts.assetGroup,
      sourcePage: opts.sourcePage,
      sourceUrl: opts.sourceUrl,
      sourceFilename: opts.sourceFilename,
      normalizedFilename: opts.normalizedFilename,
      uploadDate:
        normalizeUploadDate(opts.uploadDate) || extractDateFromFilename(opts.normalizedFilename),
      mimeType,
      content: response.body,
      downloadStatus: "success",
      downloadedAt: new Date(),
      sizeBytes: response.body.length,
      sha256: createHash("sha256").update(response.body).digest("hex"),
    };
  }

  private async scrapeElectronicInsert(licenseId: string): Promise<Record<string, unknown> | null> {
    const url = `${this.baseUrl}/im_detail_1/${encodeLicenseId(licenseId)}`;
    const html = await this.fetchText(url);
    if (html === null) return null;
    const $ = makeSoup(html);
    const data: Record<string, unknown> = {
      source_url: url,
      license_no: licenseId,
      basic_info: parseBasicInfo($),
      manufacturers: parseManufacturers($),
      sections: parseSections($),
      atc_codes: parseAtcCodes($),
      ingredients: parseIngredients($),
      label_pdfs: popupPdfLinks($, this.baseUrl, "popup-label"),
      history_pdfs: popupPdfLinks($, this.baseUrl, "popup-history"),
      public_pdfs: popupPdfLinks($, this.baseUrl, "popup-new1"),
      paper_pdfs: popupPdfLinks($, this.baseUrl, "popup-new2"),
      authorizations: parseAuthorizations($),
    };
    return hasElectronicInsertContent(data) ? data : null;
  }

  private async scrapeInsertPageLinks(licenseId: string): Promise<PdfLink[]> {
    const url = `${this.baseUrl}/im_detail_pdf/${encodeLicenseId(licenseId)}`;
    const html = await this.fetchText(url);
    if (html === null) return [];
    const $ = makeSoup(html);
    const links = collectPdfLinks($, this.baseUrl, "/insert/pdfcasefile/");
    if (links.length > 0) return links;
    $("a[href]").each((_, el) => {
      const anchor = $(el);
      const href = anchor.attr("href") ?? "";
      if (href.includes("/insert/") || href.toLowerCase().endsWith(".pdf")) {
        const label = getText(anchor, "", true) || (href.split("/").pop() ?? "");
        links.push({ url: absUrl(this.baseUrl, href), label, date: "" });
      }
    });
    return links;
  }

  private async scrapeLabelPageLinks(licenseId: string): Promise<PdfLink[]> {
    const url = `${this.baseUrl}/im_label/${encodeLicenseId(licenseId)}`;
    const html = await this.fetchText(url);
    if (html === null) return [];
    const $ = makeSoup(html);
    const links = collectPdfLinks($, this.baseUrl, "/insert/lablefiles/");
    const enriched: PdfLink[] = [];
    const table = $("table").first();
    if (table.length > 0) {
      table.find("tr").each((_, tr) => {
        const row = $(tr);
        const cells = row.find("td");
        const anchor = row.find("a[href*='/insert/lablefiles/']").first();
        if (anchor.length === 0) return;
        const href = anchor.attr("href") ?? "";
        let label = cells.length > 1 ? getText(cells.eq(1), "", true) : getText(anchor, "", true);
        if (!label) label = (href.split("/").pop() ?? "").split("?")[0] ?? "";
        enriched.push({ url: absUrl(this.baseUrl, href), label, date: "" });
      });
    }
    return enriched.length > 0 ? enriched : links;
  }

  private async scrapeShapes(licenseId: string): Promise<AppearanceRecordScrape[]> {
    const url = `${this.baseUrl}/im_shape/${encodeLicenseId(licenseId)}`;
    const html = await this.fetchText(url);
    if (html === null) return [];
    const $ = makeSoup(html);
    const detailLinks = parseShapeList($, this.baseUrl);
    const results: AppearanceRecordScrape[] = [];

    for (const item of detailLinks) {
      const detailHtml = await this.fetchText(item.detail_url);
      if (detailHtml === null) continue;
      const detail$ = makeSoup(detailHtml);
      const rawData = parseShapeDetail(detail$, item.shape_id, item.detail_url);

      const appearanceFiles = (rawData.appearance_files ?? []) as Record<string, string>[];
      let imageLinks = appearanceFiles
        .filter((file) => file.source_url)
        .map((file) => absUrl(this.baseUrl, file.source_url));
      if (imageLinks.length === 0) {
        imageLinks = detail$("img[src]")
          .toArray()
          .map((img) => absUrl(this.baseUrl, detail$(img).attr("src") ?? ""));
      }

      const imageAssets: ScrapedAsset[] = [];
      let imageIndex = 0;
      for (const src of imageLinks) {
        if (UI_IMAGE_KEYWORDS.some((keyword) => src.includes(keyword))) continue;
        imageIndex += 1;
        const fileMeta: Record<string, string> = appearanceFiles[imageIndex - 1] ?? {};
        const sourceFilename = fileMeta.filename || basename(src);
        let suffix = suffixOf(sourceFilename);
        if (!IMAGE_SUFFIXES.has(suffix)) suffix = ".jpg";
        const normalizedFilename = safeFilename(
          `${item.shape_id}_image_${String(imageIndex).padStart(2, "0")}${suffix}`,
        );
        const asset = await this.downloadAsset({
          assetType: "shape_image",
          assetGroup: "shape",
          sourcePage: "im_shape",
          sourceUrl: src,
          sourceFilename,
          normalizedFilename,
          uploadDate: fileMeta.upload_date ?? "",
        });
        if (asset !== null) imageAssets.push(asset);
      }

      results.push({
        shapeId: item.shape_id,
        detailUrl: item.detail_url,
        rawJson: rawData,
        images: imageAssets,
      });
    }
    return results;
  }

  private async downloadPdfLinks(opts: {
    links: PdfLink[];
    assetType: string;
    assetGroup: string;
    sourcePage: string;
  }): Promise<ScrapedAsset[]> {
    const saved: ScrapedAsset[] = [];
    const seen = new Set<string>();
    for (const item of opts.links) {
      const sourceUrl = item.url ?? "";
      if (!sourceUrl || seen.has(sourceUrl)) continue;
      seen.add(sourceUrl);

      let sourceFilename = item.filename || item.label || basename(sourceUrl);
      if (!sourceFilename.toLowerCase().endsWith(".pdf")) sourceFilename += ".pdf";
      const normalizedFilename = safeFilename(
        filenameWithUploadDate(sourceFilename, item.date ?? ""),
      );

      const asset = await this.downloadAsset({
        assetType: opts.assetType,
        assetGroup: opts.assetGroup,
        sourcePage: opts.sourcePage,
        sourceUrl,
        sourceFilename,
        normalizedFilename,
        uploadDate: item.date ?? "",
      });
      if (asset !== null) saved.push(asset);
    }
    return saved;
  }

  async scrapeLicense(licenseId: string): Promise<DrugEnrichmentPayload> {
    const payload: DrugEnrichmentPayload = {
      licenseId,
      electronicInsert: null,
      insertAssets: [],
      labelAssets: [],
      appearanceRecords: [],
      errors: [],
    };
    const fail = (stage: string, err: unknown): void => {
      payload.errors.push(`${stage}: ${err instanceof Error ? err.message : String(err)}`);
    };

    try {
      payload.electronicInsert = await this.scrapeElectronicInsert(licenseId);
    } catch (err) {
      fail("electronic_insert", err);
    }

    const insertLinks: PdfLink[] = [];
    const labelLinks: PdfLink[] = [];
    if (payload.electronicInsert !== null) {
      const insert = payload.electronicInsert;
      insertLinks.push(...((insert.history_pdfs ?? []) as PdfLink[]));
      insertLinks.push(...((insert.public_pdfs ?? []) as PdfLink[]));
      insertLinks.push(...((insert.paper_pdfs ?? []) as PdfLink[]));
      labelLinks.push(...((insert.label_pdfs ?? []) as PdfLink[]));
    }

    try {
      insertLinks.push(...(await this.scrapeInsertPageLinks(licenseId)));
    } catch (err) {
      fail("insert_page", err);
    }

    try {
      if (labelLinks.length === 0) {
        labelLinks.push(...(await this.scrapeLabelPageLinks(licenseId)));
      }
    } catch (err) {
      fail("label_page", err);
    }

    try {
      payload.insertAssets = await this.downloadPdfLinks({
        links: insertLinks,
        assetType: "insert_pdf",
        assetGroup: "insert",
        sourcePage: "im_detail_pdf",
      });
    } catch (err) {
      fail("insert_download", err);
    }

    try {
      payload.labelAssets = await this.downloadPdfLinks({
        links: labelLinks,
        assetType: "label_pdf",
        assetGroup: "label",
        sourcePage: "im_label",
      });
    } catch (err) {
      fail("label_download", err);
    }

    try {
      payload.appearanceRecords = await this.scrapeShapes(licenseId);
    } catch (err) {
      fail("shape_scrape", err);
    }

    logInfo("TFDA enrichment scraped", {
      license_id: licenseId,
      has_electronic_insert: payload.electronicInsert !== null,
      insert_assets: payload.insertAssets.length,
      label_assets: payload.labelAssets.length,
      appearance_records: payload.appearanceRecords.length,
      errors: payload.errors.length,
    });
    return payload;
  }
}
