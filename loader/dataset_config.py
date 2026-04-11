"""
Dataset configuration loading and validation.

This module supports a small YAML subset sufficient for datasets.example.yaml:

- nested mappings by indentation
- scalar values
- quoted and unquoted strings
- integers
- booleans

The first implementation intentionally avoids external YAML dependencies so the
loader can ship with the current runtime environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

SUPPORTED_CONFIG_VERSION = 1


@dataclass(frozen=True)
class DatasetEntry:
    key: str
    enabled: bool
    required: bool
    source_type: str
    path: str | None
    pattern: str | None
    label: str
    version: str | None = None


@dataclass(frozen=True)
class DatasetDefaults:
    base_dir: str
    missing_policy: str = "warn"
    resolve_mode: str = "first_match"


@dataclass(frozen=True)
class DatasetConfig:
    version: int
    defaults: DatasetDefaults
    datasets: dict[str, DatasetEntry]


def _parse_scalar(raw: str):
    value = raw.strip()
    if not value:
        return ""
    if value[0] == value[-1] and value[0] in ("'", '"') and len(value) >= 2:
        return value[1:-1]
    lower = value.lower()
    if lower == "true":
        return True
    if lower == "false":
        return False
    if lower in ("null", "none"):
        return None
    if value.isdigit():
        return int(value)
    return value


def _strip_comment(line: str) -> str:
    in_quote: str | None = None
    result: list[str] = []
    for ch in line:
        if ch in ("'", '"'):
            if in_quote == ch:
                in_quote = None
            elif in_quote is None:
                in_quote = ch
        if ch == "#" and in_quote is None:
            break
        result.append(ch)
    return "".join(result).rstrip()


def _parse_simple_yaml(text: str) -> dict:
    root: dict = {}
    stack: list[tuple[int, dict]] = [(-1, root)]

    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue

        line = _strip_comment(raw_line)
        if not line.strip():
            continue

        indent = len(line) - len(line.lstrip(" "))
        if indent % 2 != 0:
            raise ValueError(f"Invalid indentation on line {lineno}: {raw_line}")

        stripped = line.strip()
        if ":" not in stripped:
            raise ValueError(f"Expected 'key: value' on line {lineno}: {raw_line}")

        key, value = stripped.split(":", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"Empty key on line {lineno}")

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()

        parent = stack[-1][1]
        if value.strip() == "":
            new_obj: dict = {}
            parent[key] = new_obj
            stack.append((indent, new_obj))
        else:
            parent[key] = _parse_scalar(value)

    return root


def _coerce_bool(value, field_name: str, dataset_key: str) -> bool:
    if isinstance(value, bool):
        return value
    raise ValueError(f"Dataset '{dataset_key}' field '{field_name}' must be boolean")


def _coerce_str(value, field_name: str, dataset_key: str) -> str:
    if isinstance(value, str) and value.strip():
        return value
    raise ValueError(
        f"Dataset '{dataset_key}' field '{field_name}' must be a non-empty string"
    )


def _build_defaults(raw: dict) -> DatasetDefaults:
    base_dir = raw.get("base_dir", "/app/fhir-code")
    missing_policy = raw.get("missing_policy", "warn")
    resolve_mode = raw.get("resolve_mode", "first_match")
    if not isinstance(base_dir, str) or not base_dir:
        raise ValueError("defaults.base_dir must be a non-empty string")
    if missing_policy not in ("warn", "error"):
        raise ValueError("defaults.missing_policy must be 'warn' or 'error'")
    if resolve_mode not in ("first_match",):
        raise ValueError("defaults.resolve_mode must be 'first_match'")
    return DatasetDefaults(
        base_dir=base_dir,
        missing_policy=missing_policy,
        resolve_mode=resolve_mode,
    )


def _build_dataset_entry(key: str, raw: dict) -> DatasetEntry:
    if not isinstance(raw, dict):
        raise ValueError(f"Dataset '{key}' must be a mapping")

    enabled = _coerce_bool(raw.get("enabled", True), "enabled", key)
    required = _coerce_bool(raw.get("required", False), "required", key)
    source_type = _coerce_str(raw.get("source_type"), "source_type", key)
    if source_type not in ("file", "glob", "internal"):
        raise ValueError(f"Dataset '{key}' has unsupported source_type '{source_type}'")

    label = _coerce_str(raw.get("label", key), "label", key)
    path = raw.get("path")
    pattern = raw.get("pattern")
    version = raw.get("version")

    if source_type == "file":
        path = _coerce_str(path, "path", key)
        pattern = None
    elif source_type == "glob":
        pattern = _coerce_str(pattern, "pattern", key)
        path = None
    else:
        path = None
        pattern = None

    if version is not None and not isinstance(version, (str, int)):
        raise ValueError(f"Dataset '{key}' field 'version' must be a string or integer")

    return DatasetEntry(
        key=key,
        enabled=enabled,
        required=required,
        source_type=source_type,
        path=path,
        pattern=pattern,
        label=label,
        version=str(version) if version is not None else None,
    )


def parse_dataset_config(text: str) -> DatasetConfig:
    """Parse a YAML-subset dataset config string into a ``DatasetConfig``.

    Args:
        text: Raw YAML content as a string.

    Returns:
        Validated ``DatasetConfig`` instance.

    Raises:
        ValueError: If the version is unsupported or any required field is invalid.
    """
    raw = _parse_simple_yaml(text)
    version = raw.get("version")
    if version != SUPPORTED_CONFIG_VERSION:
        raise ValueError(f"Unsupported dataset config version: {version}")

    defaults = _build_defaults(raw.get("defaults", {}))
    raw_datasets = raw.get("datasets")
    if not isinstance(raw_datasets, dict) or not raw_datasets:
        raise ValueError("datasets must be a non-empty mapping")

    datasets = {
        key: _build_dataset_entry(key, value) for key, value in raw_datasets.items()
    }
    return DatasetConfig(version=version, defaults=defaults, datasets=datasets)


def load_dataset_config(path: str) -> DatasetConfig:
    """Load and parse a dataset config file from disk.

    Args:
        path: Filesystem path to the YAML config file.

    Returns:
        Validated ``DatasetConfig`` instance.
    """
    with open(path, encoding="utf-8") as f:
        return parse_dataset_config(f.read())


def get_dataset_config_path() -> str | None:
    """Return the dataset config file path from the ``DATASETS_CONFIG`` env var.

    Returns:
        Path string, or ``None`` if the variable is unset.
    """
    return os.getenv("DATASETS_CONFIG")
