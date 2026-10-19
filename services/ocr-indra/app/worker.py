"""Code that runs inside the OCR worker processes.

Each worker loads one indra-ocr ``Converter`` at start-up and then reads whole
documents, one page after another. pdfium is not thread-safe, so the pool is
made of processes (spawn), never threads. Everything here must stay importable
and picklable by module path (``app.worker.<fn>``).

Nothing in this module logs or returns anything but OCR output to the caller:
document text never reaches a log line.
"""

from __future__ import annotations

import os
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

_conv = None


def init(model_dir: str, threads: int) -> None:
    """Pool initializer: load the models once per worker process."""
    global _conv
    # ONNX Runtime's Linux wheels carry 1DS telemetry; the env var must be set
    # before the import (the image sets it too — this covers a bare `python -m app`).
    os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")
    import cv2

    cv2.setNumThreads(threads)
    import indra_ocr

    _conv = indra_ocr.load(path=model_dir, threads=threads)


def ping() -> dict[str, Any]:
    """Proves a worker started and holds a loaded converter."""
    return {"pid": os.getpid(), "loaded": _conv is not None}


def page_range(total: int, first_page: int, last_page: int, max_pages: int) -> tuple[list[int], bool]:
    """0-based page indices for a 1-based inclusive [first_page, last_page]
    (last_page 0 = to the end), capped at max_pages. Returns (indices, truncated)."""
    start = max(1, first_page) - 1
    end = total if last_page <= 0 else min(last_page, total)
    indices = list(range(start, end))
    truncated = len(indices) > max_pages
    return indices[:max_pages], truncated


def serialize_page(index: int, page: Any, fmt: str) -> dict[str, Any]:
    """One indra ``Page`` as JSON. ``fmt``: markdown | text | json."""
    out: dict[str, Any] = {
        "index": index,
        "source": page.source,
        "note": page.note,
        "rotation": page.rotation,
        "skew": round(float(page.skew), 3),
        "timings": {k: round(float(v), 1) for k, v in (page.timings or {}).items()},
        "text": page.text,
    }
    if fmt in ("markdown", "json"):
        out["markdown"] = page.markdown or ""
    if fmt == "json":
        out["blocks"] = [
            {"label": b.get("label"), "bbox": [round(float(x), 1) for x in b.get("bbox", [])], "text": b.get("text", "")}
            for b in page.blocks
        ]
        out["lines"] = [
            {"box": [round(float(x), 1) for x in ln["box"]], "text": ln["text"], "conf": round(float(ln["conf"]), 4)}
            for ln in (asdict(line) for line in page.lines)
        ]
    return out


def run(path: str, opts: dict[str, Any], deadline: float) -> dict[str, Any]:
    """OCR one file. ``deadline`` is a ``time.time()`` value: no new page starts
    after it (cooperative timeout — the page in progress always finishes).

    Returns {"total_pages", "pages", "truncated", "timed_out"} or {"error": {...}}."""
    conv = _conv
    if conv is None:
        return {"error": {"code": "NOT_READY", "message": "worker has no loaded model"}}
    from indra_ocr.pipeline import InputError, is_pdf, read_images

    # Per-request options live on plain attributes; a worker runs one task at a time.
    conv.dpi = float(opts["dpi"])
    conv.mode = str(opts["mode"])
    conv.ocr.furniture = bool(opts["keep_furniture"])
    fmt = str(opts["format"])
    pages: list[dict[str, Any]] = []
    timed_out = False
    try:
        if is_pdf(Path(path)):
            import pypdfium2 as pdfium

            try:
                doc = pdfium.PdfDocument(path)
            except pdfium.PdfiumError as e:
                locked = "password" in str(e).lower()
                code = "PDF_ENCRYPTED" if locked else "PDF_UNREADABLE"
                msg = "password-protected PDF" if locked else f"cannot open the PDF ({e})"
                return {"error": {"code": code, "message": msg}}
            try:
                total = len(doc)
                indices, truncated = page_range(total, opts["first_page"], opts["last_page"], opts["max_pages"])
                for i in indices:
                    if time.time() > deadline:
                        timed_out = True
                        break
                    page = conv._safe(lambda: conv.pdf_page(path, doc, i))  # noqa: B023 (called at once)
                    pages.append(serialize_page(i, page, fmt))
            finally:
                doc.close()
        else:
            frames = read_images(Path(path))
            total = len(frames)
            indices, truncated = page_range(total, opts["first_page"], opts["last_page"], opts["max_pages"])
            for i in indices:
                if time.time() > deadline:
                    timed_out = True
                    break
                gray = frames[i]
                page = conv._safe(lambda: conv.ocr(gray))  # noqa: B023
                pages.append(serialize_page(i, page, fmt))
    except InputError:
        return {"error": {"code": "UNSUPPORTED_FILE", "message": "not a PDF or a readable image"}}
    return {"total_pages": total, "pages": pages, "truncated": truncated, "timed_out": timed_out}
