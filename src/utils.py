"""
Structured JSON logging.
All output goes to stderr so it never interferes with the MCP stdio transport on stdout.
"""

import json
import logging
import sys
from typing import Any


class _JsonFormatter(logging.Formatter):
    """Emit one JSON object per log record."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        # Any extra fields attached via `extra=`
        for key, val in record.__dict__.items():
            if key not in (
                "msg",
                "args",
                "levelname",
                "levelno",
                "pathname",
                "filename",
                "module",
                "exc_info",
                "exc_text",
                "stack_info",
                "lineno",
                "funcName",
                "created",
                "msecs",
                "relativeCreated",
                "thread",
                "threadName",
                "processName",
                "process",
                "name",
                "message",
            ):
                payload[key] = val
        return json.dumps(payload, ensure_ascii=False, default=str)


def _build_logger() -> logging.Logger:
    logger = logging.getLogger("taiwan_health_mcp")
    if logger.handlers:  # already configured (e.g. module re-imported)
        return logger

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_JsonFormatter())
    logger.addHandler(handler)
    logger.propagate = False
    return logger


_logger = _build_logger()


def configure_log_level(level: str) -> None:
    """Set the logger level from a string name.

    Args:
        level: Log level name (e.g. "INFO", "DEBUG", "WARNING").
            Defaults to INFO if the name is unrecognised.
    """
    _logger.setLevel(getattr(logging, level.upper(), logging.INFO))


def log_info(message: str, **extra: Any) -> None:
    """Emit an INFO-level structured log entry.

    Args:
        message: Human-readable log message.
        **extra: Additional key-value pairs appended to the JSON payload.
    """
    _logger.info(message, extra=extra)


def log_warning(message: str, **extra: Any) -> None:
    """Emit a WARNING-level structured log entry.

    Args:
        message: Human-readable log message.
        **extra: Additional key-value pairs appended to the JSON payload.
    """
    _logger.warning(message, extra=extra)


def log_error(message: str, **extra: Any) -> None:
    """Emit an ERROR-level structured log entry.

    Args:
        message: Human-readable log message.
        **extra: Additional key-value pairs appended to the JSON payload.
    """
    _logger.error(message, extra=extra)


def log_debug(message: str, **extra: Any) -> None:
    """Emit a DEBUG-level structured log entry.

    Args:
        message: Human-readable log message.
        **extra: Additional key-value pairs appended to the JSON payload.
    """
    _logger.debug(message, extra=extra)
