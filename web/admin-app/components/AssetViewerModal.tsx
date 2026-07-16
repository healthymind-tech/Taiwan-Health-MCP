// Floating, tabbed PDF/OCR/JSON asset viewer — same visual/interaction pattern
// as the Drug Explorer's asset viewer (web/admin-app/routes/modules/drug/DrugExplorerPage.tsx),
// generalized to take pre-built URLs instead of drug-specific asset IDs so any
// module can reuse it. Reuses the same CSS classes as the Drug viewer
// (drug-asset-viewer-modal / drug-asset-modal / drug-paired-preview / ...) so
// it renders pixel-identical without duplicating styles.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, ExternalLink, ZoomIn, ZoomOut } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Document as PdfDocument, Page as PdfPage, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Modal } from "./Modal";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export type AssetPreviewKind = "pdf" | "markdown" | "json" | "text" | "image";

export interface AssetViewerTab {
  /** Stable key within one viewer instance — not necessarily a backend asset ID. */
  id: string;
  kind: AssetPreviewKind;
  label: string;
  url: string;
  downloadUrl?: string;
}

export interface AssetViewerState {
  title: string;
  tabs: AssetViewerTab[];
  initialId: string;
}

/** Two tabs are shown side by side (Drug's "PDF + OCR" pattern) when both a `pdf` and a `markdown` tab are present. */
export function AssetViewerModal({
  viewer,
  onClose,
}: {
  viewer: AssetViewerState;
  onClose: () => void;
}): JSX.Element {
  const [activeId, setActiveId] = useState(viewer.initialId);
  const active = viewer.tabs.find((tab) => tab.id === activeId) ?? viewer.tabs[0];
  const pdf = viewer.tabs.find((tab) => tab.kind === "pdf");
  const paired = viewer.tabs.find((tab) => tab.kind === "markdown");
  const showPaired = Boolean(pdf && paired && (active.id === pdf.id || active.id === paired.id));
  const standaloneTabs = viewer.tabs.filter((tab) => tab.id !== pdf?.id && tab.id !== paired?.id);

  return (
    <Modal title={viewer.title} onClose={onClose} workspace panelClassName="drug-asset-viewer-modal">
      <div className="drug-asset-modal">
        <div className="drug-asset-modal__toolbar">
          <div className="segmented" role="tablist" aria-label="Available file formats">
            {pdf && paired && (
              <button
                type="button"
                role="tab"
                aria-selected={showPaired}
                className={showPaired ? "is-active" : ""}
                onClick={() => setActiveId(pdf.id)}
              >
                {pdf.label} + {paired.label}
              </button>
            )}
            {(pdf && !paired ? [pdf] : paired && !pdf ? [paired] : [])
              .concat(standaloneTabs)
              .map((tab) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active.id === tab.id}
                  className={active.id === tab.id ? "is-active" : ""}
                  key={tab.id}
                  onClick={() => setActiveId(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
          </div>
          <div className="drug-asset-modal__actions">
            {showPaired && pdf && paired ? (
              <>
                <a className="btn btn--sm" href={pdf.url} target="_blank" rel="noreferrer" title={`Open ${pdf.label} in a new tab`}>
                  <ExternalLink size={16} />
                  <span>{pdf.label}</span>
                </a>
                <a className="btn btn--sm" href={pdf.downloadUrl ?? pdf.url} title={`Download ${pdf.label}`}>
                  <Download size={16} />
                  <span>{pdf.label}</span>
                </a>
                <a className="btn btn--sm" href={paired.downloadUrl ?? paired.url} title={`Download ${paired.label}`}>
                  <Download size={16} />
                  <span>{paired.label}</span>
                </a>
              </>
            ) : (
              <>
                <a className="icon-btn" href={active.url} target="_blank" rel="noreferrer" aria-label="Open file in a new tab" title="Open file in a new tab">
                  <ExternalLink size={17} />
                </a>
                <a className="icon-btn" href={active.downloadUrl ?? active.url} aria-label="Download file" title="Download file">
                  <Download size={17} />
                </a>
              </>
            )}
          </div>
        </div>
        <div className="drug-asset-modal__preview">
          {showPaired && pdf && paired ? (
            <div className="drug-paired-preview">
              <section>
                <header>{pdf.label}</header>
                <PdfPreview url={pdf.url} cacheKey={pdf.id} />
              </section>
              <section>
                <header>{paired.label}</header>
                <MarkdownPreview url={paired.url} cacheKey={paired.id} />
              </section>
            </div>
          ) : (
            <AssetPreview tab={active} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function AssetPreview({ tab }: { tab: AssetViewerTab }): JSX.Element {
  if (tab.kind === "pdf") return <PdfPreview url={tab.url} cacheKey={tab.id} />;
  if (tab.kind === "markdown") return <MarkdownPreview url={tab.url} cacheKey={tab.id} />;
  if (tab.kind === "json" || tab.kind === "text") {
    return <TextPreview url={tab.url} cacheKey={tab.id} json={tab.kind === "json"} />;
  }
  if (tab.kind === "image") {
    return (
      <div className="drug-image-preview">
        <img src={tab.url} alt={tab.label} />
      </div>
    );
  }
  return <div className="drug-document-loading">This file type cannot be previewed. Open it in a new tab or download the original file.</div>;
}

function TextPreview({ url, cacheKey, json }: { url: string; cacheKey: string; json: boolean }): JSX.Element {
  const textQ = useQuery({
    queryKey: [json ? "asset-viewer-json" : "asset-viewer-text", cacheKey],
    queryFn: async ({ signal }) => {
      const response = await fetch(url, { credentials: "same-origin", signal });
      if (!response.ok) throw new Error(`Unable to load file (${response.status})`);
      const text = await response.text();
      if (!json) return text;
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    },
    staleTime: 5 * 60_000,
  });
  if (textQ.isPending) return <div className="drug-document-loading">Loading file...</div>;
  if (textQ.isError) return <div className="drug-document-error">{String(textQ.error)}</div>;
  return <pre className="drug-text-preview">{textQ.data}</pre>;
}

function PdfPreview({ url, cacheKey }: { url: string; cacheKey: string }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const source = useMemo(() => ({ url, withCredentials: true }), [url]);

  useEffect(() => {
    setPageNumber(1);
    setPageCount(0);
    setZoom(1);
  }, [cacheKey]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = (): void => setViewportWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fittedWidth = Math.max(220, viewportWidth - 28);
  return (
    <div className="drug-pdf-viewer">
      <div className="drug-pdf-toolbar">
        <button type="button" className="icon-btn" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)} aria-label="Previous PDF page">
          <ChevronLeft size={16} />
        </button>
        <span>
          Page <strong>{pageNumber}</strong> / {pageCount || "-"}
        </span>
        <button type="button" className="icon-btn" disabled={!pageCount || pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)} aria-label="Next PDF page">
          <ChevronRight size={16} />
        </button>
        <span className="drug-pdf-toolbar__spacer" />
        <button type="button" className="icon-btn" disabled={zoom <= 0.75} onClick={() => setZoom((value) => Math.max(0.75, value - 0.25))} aria-label="Zoom out">
          <ZoomOut size={16} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" className="icon-btn" disabled={zoom >= 2} onClick={() => setZoom((value) => Math.min(2, value + 0.25))} aria-label="Zoom in">
          <ZoomIn size={16} />
        </button>
      </div>
      <div className="drug-pdf-canvas" ref={viewportRef}>
        <PdfDocument
          file={source}
          loading={<div className="drug-document-loading">Loading PDF...</div>}
          error={<div className="drug-document-error">Unable to display this PDF. Use the download button to open the original.</div>}
          onLoadSuccess={({ numPages }: { numPages: number }) => {
            setPageCount(numPages);
            setPageNumber((page) => Math.min(page, numPages));
          }}
        >
          <PdfPage pageNumber={pageNumber} width={Math.round(fittedWidth * zoom)} />
        </PdfDocument>
      </div>
    </div>
  );
}

function MarkdownPreview({ url, cacheKey }: { url: string; cacheKey: string }): JSX.Element {
  const markdownQ = useQuery({
    queryKey: ["asset-viewer-markdown", cacheKey],
    queryFn: async ({ signal }) => {
      const response = await fetch(url, { credentials: "same-origin", signal });
      if (response.status === 401) {
        window.location.href = "/admin/login";
        throw new Error("Authentication required");
      }
      if (!response.ok) throw new Error(`Unable to load file (${response.status})`);
      return response.text();
    },
    staleTime: 5 * 60_000,
  });
  if (markdownQ.isPending) return <div className="drug-markdown-state">Loading...</div>;
  if (markdownQ.isError) return <div className="drug-markdown-state drug-markdown-state--error">{String(markdownQ.error)}</div>;
  if (!markdownQ.data.trim()) return <div className="drug-markdown-state">Output is empty.</div>;
  return (
    <div className="drug-markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {markdownQ.data}
      </ReactMarkdown>
    </div>
  );
}
