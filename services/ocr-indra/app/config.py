"""Service limits and request-option validation (pure: no model, no I/O beyond /sys)."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Any

SERVER_VERSION = "1.0.0"
# Bytes a worker can reach on a large scan (indra_ocr.parallel.WORKER_MEMORY).
WORKER_MEMORY = 1.5e9

FORMATS = ("markdown", "text", "json")
MODES = ("auto", "ocr", "text")
MIN_DPI, MAX_DPI = 72, 400

# Leading bytes of the image formats OpenCV reads; PDFs are recognised by "%PDF-"
# anywhere in the first KiB (the same rule as indra_ocr.pipeline.is_pdf).
IMAGE_MAGIC = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",  # JPEG
    b"II*\x00",  # TIFF little-endian
    b"MM\x00*",  # TIFF big-endian
    b"BM",  # BMP
)


def sniff_kind(head: bytes) -> str | None:
    """'pdf', 'image' or None from the first KiB of an upload."""
    if b"%PDF-" in head[:1024]:
        return "pdf"
    if any(head.startswith(m) for m in IMAGE_MAGIC):
        return "image"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image"
    return None


def cgroup_cpu_limit() -> float | None:
    """CPUs granted by the cgroup v2 quota (docker --cpus), or None if unlimited."""
    try:
        quota, period = open("/sys/fs/cgroup/cpu.max").read().split()[:2]
        if quota == "max":
            return None
        return int(quota) / int(period)
    except (OSError, ValueError):
        return None


def cgroup_memory_limit() -> int | None:
    try:
        raw = open("/sys/fs/cgroup/memory.max").read().strip()
        return None if raw == "max" else int(raw)
    except (OSError, ValueError):
        return None


def usable_cores() -> int:
    try:
        n = len(os.sched_getaffinity(0))
    except AttributeError:
        n = os.cpu_count() or 1
    quota = cgroup_cpu_limit()
    if quota is not None:
        n = min(n, max(1, math.floor(quota)))
    return max(1, n)


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as e:
        raise SystemExit(f"{name}={raw!r} is not an integer") from e
    return max(lo, min(hi, value))


@dataclass(frozen=True)
class Settings:
    model_dir: str
    workers: int
    threads_per_worker: int
    max_upload_bytes: int
    max_pages: int
    max_timeout_seconds: int
    default_timeout_seconds: int
    max_queue: int
    default_dpi: int

    @classmethod
    def from_env(cls) -> "Settings":
        cores = usable_cores()
        mem = cgroup_memory_limit()
        by_mem = max(1, int(mem // WORKER_MEMORY)) if mem else cores
        workers = _env_int("INDRA_WORKERS", max(1, min(cores, by_mem, 4)), 1, 32)
        threads = _env_int("INDRA_THREADS_PER_WORKER", max(1, cores // workers), 1, 32)
        max_timeout = _env_int("INDRA_MAX_TIMEOUT_SECONDS", 600, 10, 3600)
        return cls(
            model_dir=os.environ.get("INDRA_OCR_MODEL_DIR", "/opt/indra-ocr/models"),
            workers=workers,
            threads_per_worker=threads,
            max_upload_bytes=_env_int("INDRA_MAX_UPLOAD_MB", 50, 1, 1024) * 1024 * 1024,
            max_pages=_env_int("INDRA_MAX_PAGES", 60, 1, 2000),
            max_timeout_seconds=max_timeout,
            default_timeout_seconds=min(max_timeout, _env_int("INDRA_DEFAULT_TIMEOUT_SECONDS", 300, 10, 3600)),
            max_queue=_env_int("INDRA_MAX_QUEUE", workers * 4, 0, 1000),
            default_dpi=_env_int("INDRA_DEFAULT_DPI", 200, MIN_DPI, MAX_DPI),
        )


class OptionError(ValueError):
    """A request option is missing or out of range (→ HTTP 422)."""


def _int(fields: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    raw = fields.get(key)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        value = int(str(raw).strip())
    except ValueError as e:
        raise OptionError(f"{key} must be an integer") from e
    if value < lo or value > hi:
        raise OptionError(f"{key} must be between {lo} and {hi}")
    return value


def _bool(fields: dict[str, Any], key: str, default: bool) -> bool:
    raw = fields.get(key)
    if raw is None or str(raw).strip() == "":
        return default
    s = str(raw).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    raise OptionError(f"{key} must be true or false")


def _choice(fields: dict[str, Any], key: str, default: str, allowed: tuple[str, ...]) -> str:
    raw = fields.get(key)
    if raw is None or str(raw).strip() == "":
        return default
    s = str(raw).strip().lower()
    if s == "md":
        s = "markdown"
    if s not in allowed:
        raise OptionError(f"{key} must be one of {', '.join(allowed)}")
    return s


def parse_options(fields: dict[str, Any], s: Settings) -> dict[str, Any]:
    """Validated per-request options from the multipart form fields."""
    first = _int(fields, "first_page", 1, 1, 100000)
    last = _int(fields, "last_page", 0, 0, 100000)
    if last and last < first:
        raise OptionError("last_page must be >= first_page (or 0 for the last page)")
    return {
        "format": _choice(fields, "format", "markdown", FORMATS),
        "mode": _choice(fields, "mode", "auto", MODES),
        "dpi": _int(fields, "dpi", s.default_dpi, MIN_DPI, MAX_DPI),
        "first_page": first,
        "last_page": last,
        "max_pages": _int(fields, "max_pages", s.max_pages, 1, s.max_pages),
        "keep_furniture": _bool(fields, "keep_furniture", False),
        "timeout_seconds": _int(fields, "timeout_seconds", s.default_timeout_seconds, 1, s.max_timeout_seconds),
    }
