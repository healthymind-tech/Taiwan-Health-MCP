"""HTTP front for Indra OCR (https://github.com/datalab-to/indra).

    GET  /health  model loaded?, versions, limits, queue depth
    POST /ocr     multipart `file` (PDF or image) + options → per-page markdown/text
                  (+ layout blocks / lines with boxes for format=json) and timings

Documents run on a pool of spawned worker processes (one model copy each); the
event loop only parses uploads and waits. Logs are JSON lines on stderr and never
contain document content — only sizes, page counts, timings and a hash prefix.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sys
import tempfile
import time
import uuid
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import asynccontextmanager
from importlib import metadata
from multiprocessing import get_context
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile

from . import worker
from .config import SERVER_VERSION, OptionError, Settings, parse_options, sniff_kind

# ── logging ──────────────────────────────────────────────────────────────────


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
        }
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            out.update(extra)
        if record.exc_info and record.exc_info[0] is not None:
            out["exc_type"] = record.exc_info[0].__name__
        return json.dumps(out, ensure_ascii=False)


def setup_logging() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
    logging.getLogger("uvicorn.access").disabled = True  # we log requests ourselves


log = logging.getLogger("ocr-indra")


def emit(level: int, event: str, **fields: Any) -> None:
    log.log(level, event, extra={"fields": fields})


# ── state ────────────────────────────────────────────────────────────────────


def _version(pkg: str) -> str:
    try:
        return metadata.version(pkg)
    except metadata.PackageNotFoundError:
        return "unknown"


def _model_revision(model_dir: str) -> str:
    try:
        return open(os.path.join(model_dir, "REVISION")).read().strip()
    except OSError:
        return "unknown"


class State:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.pool: ProcessPoolExecutor | None = None
        self.ready = False
        self.error: str | None = None
        self.active = 0
        self.waiting = 0
        self.slots = asyncio.Semaphore(settings.workers)
        self.started_at = time.time()
        self.lock = asyncio.Lock()

    def _new_pool(self) -> ProcessPoolExecutor:
        s = self.settings
        # Libraries size their thread pools from the environment at import: keep
        # every worker to its share (inherited by the spawned children).
        for k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
            os.environ[k] = str(s.threads_per_worker)
        os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")
        return ProcessPoolExecutor(
            s.workers,
            mp_context=get_context("spawn"),
            initializer=worker.init,
            initargs=(s.model_dir, s.threads_per_worker),
        )

    async def start(self) -> None:
        async with self.lock:
            self.ready = False
            if self.pool is not None:
                self.pool.shutdown(wait=False, cancel_futures=True)
            t0 = time.perf_counter()
            self.pool = self._new_pool()
            loop = asyncio.get_running_loop()
            try:
                # One ping per worker: each one loads its model before it answers.
                results = await asyncio.wait_for(
                    asyncio.gather(*(loop.run_in_executor(self.pool, worker.ping) for _ in range(self.settings.workers))),
                    timeout=180,
                )
                if not all(r.get("loaded") for r in results):
                    raise RuntimeError("a worker started without a loaded model")
                self.ready, self.error = True, None
                emit(logging.INFO, "pool_ready", workers=self.settings.workers,
                     threads_per_worker=self.settings.threads_per_worker,
                     load_ms=round(1000 * (time.perf_counter() - t0)))
            except Exception as e:  # noqa: BLE001 (reported by /health)
                self.error = f"{type(e).__name__}: {e}"[:300]
                emit(logging.ERROR, "pool_start_failed", error=self.error)

    async def restart_in_background(self) -> None:
        if not self.lock.locked():
            asyncio.create_task(self.start())


# ── request body limit (ASGI middleware) ─────────────────────────────────────


class BodyTooLarge(Exception):
    pass


class BodyLimit:
    """413 before parsing when Content-Length is over the limit; otherwise count
    the streamed bytes and abort the parse as soon as the limit is passed."""

    def __init__(self, app: Any, limit: int) -> None:
        self.app, self.limit = app, limit

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or scope.get("path") != "/ocr":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        cl = headers.get(b"content-length")
        # Multipart framing adds a little; allow 64 KiB over the file limit.
        if cl is not None and cl.isdigit() and int(cl) > self.limit + 65536:
            await JSONResponse(error_body("UPLOAD_TOO_LARGE", f"upload exceeds {self.limit // (1024 * 1024)} MB"),
                               status_code=413)(scope, receive, send)
            return
        seen = 0

        async def counted() -> dict:
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > self.limit + 65536:
                    raise BodyTooLarge()
            return msg

        await self.app(scope, counted, send)


def error_body(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message, **extra}}


def error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse(error_body(code, message, **extra), status_code=status)


# ── app ──────────────────────────────────────────────────────────────────────


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    state = State(settings)
    versions = {
        "server": SERVER_VERSION,
        "indra_ocr": _version("indra-ocr"),
        "onnxruntime": _version("onnxruntime"),
        "models": _model_revision(settings.model_dir),
    }

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        emit(logging.INFO, "starting", **versions, workers=settings.workers,
             threads_per_worker=settings.threads_per_worker, max_pages=settings.max_pages,
             max_upload_mb=settings.max_upload_bytes // (1024 * 1024))
        asyncio.create_task(state.start())
        yield
        if state.pool is not None:
            state.pool.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="ocr-indra", version=SERVER_VERSION, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def access_log(request: Request, call_next: Any) -> Any:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        request.state.rid = rid
        t0 = time.perf_counter()
        try:
            response = await call_next(request)
        except BodyTooLarge:
            response = error(413, "UPLOAD_TOO_LARGE", f"upload exceeds {settings.max_upload_bytes // (1024 * 1024)} MB")
        response.headers["x-request-id"] = rid
        if request.url.path != "/health" or response.status_code != 200:
            emit(logging.INFO, "request", request_id=rid, method=request.method, path=request.url.path,
                 status=response.status_code, ms=round(1000 * (time.perf_counter() - t0)))
        return response

    @app.get("/health")
    async def health() -> JSONResponse:
        status = "healthy" if state.ready else ("unhealthy" if state.error else "loading")
        body = {
            "status": status,
            "version": f"indra-ocr {versions['indra_ocr']}",
            "versions": versions,
            "model_loaded": state.ready,
            "error": state.error,
            "workers": settings.workers,
            "threads_per_worker": settings.threads_per_worker,
            "max_concurrent_requests": settings.workers,
            "processing_tasks": state.active,
            "queued_tasks": state.waiting,
            "max_queue": settings.max_queue,
            "limits": {
                "max_upload_mb": settings.max_upload_bytes // (1024 * 1024),
                "max_pages": settings.max_pages,
                "max_timeout_seconds": settings.max_timeout_seconds,
                "default_timeout_seconds": settings.default_timeout_seconds,
                "default_dpi": settings.default_dpi,
            },
            "uptime_seconds": round(time.time() - state.started_at),
        }
        return JSONResponse(body, status_code=200 if state.ready else 503)

    @app.post("/ocr")
    async def ocr(request: Request) -> JSONResponse:
        rid = request.state.rid
        if not state.ready:
            return error(503, "NOT_READY", "the OCR model is still loading" if not state.error else state.error)
        if state.active + state.waiting >= settings.workers + settings.max_queue:
            return error(429, "BUSY", "too many OCR requests in flight; retry later",
                         processing=state.active, queued=state.waiting)
        try:
            form = await request.form(max_files=1, max_fields=20)
        except BodyTooLarge:
            return error(413, "UPLOAD_TOO_LARGE", f"upload exceeds {settings.max_upload_bytes // (1024 * 1024)} MB")
        except Exception as e:  # noqa: BLE001 (malformed multipart)
            return error(400, "BAD_REQUEST", f"could not parse the multipart body ({type(e).__name__})")
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            return error(400, "FILE_MISSING", "multipart field 'file' is required")
        fields = {k: v for k, v in form.items() if isinstance(v, str)}
        try:
            opts = parse_options(fields, settings)
        except OptionError as e:
            return error(422, "BAD_OPTION", str(e))

        t_start = time.perf_counter()
        fd, path = tempfile.mkstemp(prefix="ocr-", dir=os.environ.get("INDRA_TMP_DIR") or None)
        try:
            digest = hashlib.sha256()
            size = 0
            head = b""
            with os.fdopen(fd, "wb") as f:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_upload_bytes:
                        return error(413, "UPLOAD_TOO_LARGE",
                                     f"upload exceeds {settings.max_upload_bytes // (1024 * 1024)} MB")
                    if len(head) < 1024:
                        head += chunk[: 1024 - len(head)]
                    digest.update(chunk)
                    f.write(chunk)
            await upload.close()
            if size == 0:
                return error(400, "FILE_EMPTY", "the uploaded file is empty")
            kind = sniff_kind(head)
            if kind is None:
                return error(415, "UNSUPPORTED_FILE", "not a PDF or a supported image (PNG, JPEG, TIFF, BMP, WebP)")

            deadline = time.time() + opts["timeout_seconds"]
            loop = asyncio.get_running_loop()
            state.waiting += 1
            t_queue = time.perf_counter()
            try:
                try:
                    await asyncio.wait_for(state.slots.acquire(), timeout=opts["timeout_seconds"])
                except TimeoutError:
                    return error(504, "TIMEOUT", "timed out waiting for a free OCR worker")
            finally:
                state.waiting -= 1
            queue_ms = 1000 * (time.perf_counter() - t_queue)
            state.active += 1
            t_ocr = time.perf_counter()
            try:
                assert state.pool is not None
                fut = loop.run_in_executor(state.pool, worker.run, path, opts, deadline)
                # The worker stops between pages at the deadline; the grace covers
                # the page that was in progress.
                result = await asyncio.wait_for(fut, timeout=opts["timeout_seconds"] + 60)
            except TimeoutError:
                emit(logging.WARNING, "ocr_hard_timeout", request_id=rid)
                return error(504, "TIMEOUT", f"OCR did not finish within {opts['timeout_seconds']} s")
            except BrokenProcessPool:
                emit(logging.ERROR, "worker_pool_broken", request_id=rid)
                await state.restart_in_background()
                return error(503, "WORKER_CRASHED",
                             "an OCR worker died (likely out of memory on a very large page); the pool is restarting")
            finally:
                state.active -= 1
                state.slots.release()
            ocr_ms = 1000 * (time.perf_counter() - t_ocr)

            if "error" in result:
                err = result["error"]
                status = 503 if err["code"] == "NOT_READY" else 422
                return error(status, err["code"], err["message"])

            pages = result["pages"]
            errored = sum(1 for p in pages if p["source"] == "error")
            sources: dict[str, int] = {}
            for p in pages:
                sources[p["source"]] = sources.get(p["source"], 0) + 1
            total_ms = 1000 * (time.perf_counter() - t_start)
            emit(logging.INFO, "ocr_done", request_id=rid, kind=kind, bytes=size,
                 sha256_prefix=digest.hexdigest()[:16], total_pages=result["total_pages"],
                 pages=len(pages), page_errors=errored, sources=sources, mode=opts["mode"], dpi=opts["dpi"],
                 truncated=result["truncated"], timed_out=result["timed_out"],
                 queue_ms=round(queue_ms), ocr_ms=round(ocr_ms), total_ms=round(total_ms))

            body: dict[str, Any] = {
                "ok": True,
                "versions": versions,
                "kind": kind,
                "options": {k: v for k, v in opts.items()},
                "total_pages": result["total_pages"],
                "pages_processed": len(pages),
                "page_errors": errored,
                "truncated": result["truncated"],
                "timed_out": result["timed_out"],
                "text": "\n\n".join(p["text"] for p in pages if p["text"]),
                "pages": pages,
                "timings": {"queue_ms": round(queue_ms, 1), "ocr_ms": round(ocr_ms, 1), "total_ms": round(total_ms, 1)},
            }
            if opts["format"] in ("markdown", "json"):
                body["markdown"] = "\n\n".join(p["markdown"] for p in pages if p.get("markdown"))
            return JSONResponse(body)
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    app.add_middleware(BodyLimit, limit=settings.max_upload_bytes)  # type: ignore[arg-type]
    return app


def main() -> None:
    import uvicorn

    setup_logging()
    app = create_app()
    uvicorn.run(
        app,
        host=os.environ.get("INDRA_HOST", "0.0.0.0"),
        port=int(os.environ.get("INDRA_PORT", "8000")),
        log_config=None,
        access_log=False,
        timeout_keep_alive=30,
    )


if __name__ == "__main__":
    main()
