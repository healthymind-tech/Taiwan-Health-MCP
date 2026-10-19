# ocr-indra — CPU OCR service (Indra OCR)

A small HTTP service around [Indra OCR](https://github.com/datalab-to/indra)
(`indra-ocr==0.3.2`, Datalab): line detection, CTC recognition, reading order and
markdown on ONNX Runtime, CPU only, ~18 MB of models. It is the second OCR
provider of the drug-insert pipeline, next to MinerU (admin console → 外部服務 →
OCR → 供應者 `indra`).

This directory is the **only Python in the repository**. It is a separate
container, not backend code: the backend (`node-server/`) stays 100 % Node and
talks to this service over HTTP like it talks to MinerU.

## Licences — read before enabling it in production

| Part | Licence |
|------|---------|
| This directory (server code, Dockerfile) | MIT, like the rest of this repository |
| `indra-ocr` Python package (code) | Apache-2.0 |
| Model weights (`datalab-to/indra-ocr`, baked into the image) | **modified AI Pubs OpenRAIL-M** — copy at `/opt/indra-ocr/models/LICENSE` in the image |

The vendor's summary (indra README): *"our model weights use a modified OpenRAIL-M
license (free for research, personal use, and startups under $20M
funding/revenue, cannot be used competitively with our API)."*

The weight licence, Attachment A ("Use restrictions"), §2 *Commercial*, verbatim:

> You agree not to use, reproduce, modify, create or Distribute the Model,
> Derivatives of the Model, or Output (collectively, "Use") in any of the following ways: […]
>
> 2. Commercial:
> (a) for any purpose if You (your employer, or the entity you are affiliated with) generated more than twenty million US Dollars ($20,000,000) in gross revenue in the prior year, except where Your Use is limited to personal use or research purposes;
> (b) for any purpose if You (your employer, or the entity you are affiliated with) has raised more than twenty million US dollars ($20,000,000) in total equity or debt funding from any source, except where Your Use is limited to personal use or research purposes; or
> (c) for any purpose if You (your employer, or the entity you are affiliated with) provides or otherwise makes available any product or service that competes with any product or service offered by or made available by Licensor or any of its affiliates.
>
> Commercial and broader use licenses may be available from Licensor at the following URL: https://www.datalab.to/

Other clauses that matter for a SaaS deployment: §4 (hosting the model for third
parties requires passing the use restrictions on in your own terms and giving
recipients a copy of the licence), §7 (attribution — credit Datalab, link the
model, provide the licence), §8 (share-alike: the licence is applied to the
Output too). The restrictions cover the **Output** (the OCR text), not only the
weights. Whether the operator qualifies is a legal question for the operator;
the default OCR provider stays MinerU, and nothing uses this service until an
operator selects it.

## API

### `GET /health`

`200` when every worker has loaded the model, `503` while loading or after a
failed start. Field names follow MinerU's `/health` where they overlap.

```json
{"status": "healthy", "version": "indra-ocr 0.3.2", "model_loaded": true,
 "versions": {"server": "1.0.0", "indra_ocr": "0.3.2", "onnxruntime": "1.31.0",
              "models": "datalab-to/indra-ocr@ed345c7… (tag v3.1.1)"},
 "workers": 1, "threads_per_worker": 2, "max_concurrent_requests": 1,
 "processing_tasks": 0, "queued_tasks": 0, "max_queue": 4,
 "limits": {"max_upload_mb": 50, "max_pages": 60, "max_timeout_seconds": 600,
            "default_timeout_seconds": 300, "default_dpi": 200}}
```

### `POST /ocr` (multipart/form-data)

| Field | Default | Meaning |
|-------|---------|---------|
| `file` | — (required) | PDF or image (PNG, JPEG, TIFF, BMP, WebP) — sniffed from the bytes |
| `format` | `markdown` | `markdown` (per-page markdown + text), `text` (text only), `json` (adds layout `blocks` and `lines` with boxes and confidences) |
| `mode` | `auto` | `auto` reads a trustworthy PDF text layer and OCRs the rest; `ocr` always OCRs; `text` always uses the text layer |
| `dpi` | `200` | PDF render resolution, 72–400 |
| `first_page` / `last_page` | `1` / `0` | 1-based inclusive page range (`0` = to the end) |
| `max_pages` | server cap | lower the per-request page cap (never above `INDRA_MAX_PAGES`) |
| `keep_furniture` | `false` | keep page headers / footers in the markdown |
| `timeout_seconds` | `INDRA_DEFAULT_TIMEOUT_SECONDS` | no new page starts after this; partial result has `timed_out: true` |

Response (`200`):

```json
{"ok": true, "kind": "pdf", "total_pages": 2, "pages_processed": 2, "page_errors": 0,
 "truncated": false, "timed_out": false,
 "markdown": "…all pages…", "text": "…",
 "pages": [{"index": 0, "source": "text|ocr|hybrid|error", "markdown": "…", "text": "…",
            "rotation": 0, "skew": 0.0, "note": "…", "timings": {"total_ms": 1134.2, …},
            "blocks": [{"label": "Table", "bbox": [x0, y0, x1, y1], "text": "…"}],
            "lines": [{"box": [x0, y0, x1, y1], "text": "…", "conf": 0.98}]}],
 "timings": {"queue_ms": 0.1, "ocr_ms": 2650.3, "total_ms": 2652.0}}
```

`blocks` / `lines` only with `format=json`; boxes are pixels of the page rendered
at `dpi`. Errors are `{"ok": false, "error": {"code", "message"}}`:
`400 FILE_MISSING | FILE_EMPTY | BAD_REQUEST`, `413 UPLOAD_TOO_LARGE`,
`415 UNSUPPORTED_FILE`, `422 BAD_OPTION | PDF_ENCRYPTED | PDF_UNREADABLE`,
`429 BUSY`, `503 NOT_READY | WORKER_CRASHED`, `504 TIMEOUT`.

## Configuration (environment)

| Variable | Default | |
|----------|---------|---|
| `INDRA_WORKERS` | min(CPUs, memory / 1.5 GB, 4) | worker processes (one model copy and one document at a time each) |
| `INDRA_THREADS_PER_WORKER` | CPUs / workers | ONNX Runtime / OpenCV threads per worker |
| `INDRA_MAX_UPLOAD_MB` | 50 | |
| `INDRA_MAX_PAGES` | 60 | longer documents are cut (`truncated: true`) |
| `INDRA_DEFAULT_TIMEOUT_SECONDS` / `INDRA_MAX_TIMEOUT_SECONDS` | 300 / 600 | |
| `INDRA_MAX_QUEUE` | workers × 4 | requests waiting beyond this get `429` |
| `INDRA_DEFAULT_DPI` | 200 | |
| `INDRA_OCR_MODEL_DIR` | `/opt/indra-ocr/models` | baked at build time |
| `LOG_LEVEL` | `INFO` | JSON lines on stderr |

CPUs honour the cgroup quota (`--cpus`, compose `cpus:`). Logs carry sizes, page
counts, page sources, timings and a SHA-256 prefix — never file names or text.

## Build, run, test

```bash
# build (downloads ~18 MB of weights from a pinned Hugging Face commit, sha256-checked)
docker build -t taiwan-health-mcp-ocr-indra services/ocr-indra

# unit tests (no model needed)
docker run --rm --network none taiwan-health-mcp-ocr-indra python -m unittest discover -s tests

# throwaway instance with no network at all (proves the image is offline-capable)
docker run -d --name indra-test --cpus 2 --memory 2g --network none taiwan-health-mcp-ocr-indra
docker exec indra-test python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())"
docker rm -f indra-test

# with a host port, for curl
docker run -d --name indra-test --cpus 2 --memory 2g -p 127.0.0.1:18081:8000 taiwan-health-mcp-ocr-indra
curl -s -F file=@public/samples/sample-drug-insert.pdf -F format=markdown http://127.0.0.1:18081/ocr | head -c 600
docker rm -f indra-test
```

In compose the service is `ocr-indra` (container `taiwanHealthMcp_ocr_indra`) on
the internal network `ocr`, which has no route out; the app and the admin worker
reach it at `http://ocr-indra:8000`.

## Notes

- ONNX Runtime's Linux wheels include Microsoft 1DS telemetry. The image sets
  `ORT_DISABLE_TELEMETRY=1`, and the compose network is `internal`, so nothing
  can leave the container either way.
- Upstream limitations (indra README): complex tables (merged / spanning cells,
  wrapped cell text, no ruling lines) can land in the wrong rows or columns,
  handwriting and degraded scans read poorly, no vertical text.
- `app/worker.py` calls `Converter._safe` / `pdf_page` (private API of 0.3.2) to
  support page ranges and a cooperative deadline; re-check it when bumping
  `indra-ocr`.
