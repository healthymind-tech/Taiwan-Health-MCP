"""
Dataset path resolution for config-driven loader inputs.
"""

from __future__ import annotations

import glob
import os
from dataclasses import dataclass, field
from typing import Literal

from dataset_config import DatasetConfig, DatasetEntry

DatasetStatus = Literal["ok", "missing", "disabled", "internal"]


@dataclass(frozen=True)
class ResolvedDataset:
    key: str
    label: str
    source_type: str
    required: bool
    enabled: bool
    version: str | None
    resolved_path: str | None
    status: DatasetStatus
    diagnostics: list[str] = field(default_factory=list)


DATASET_GROUPS = {
    "icd": ("icd10cm", "icd10pcs", "icd_zh_tw"),
    "loinc": ("loinc", "loinc_taiwan_mapping", "loinc_reference_ranges"),
    "twcore": ("twcore",),
    "guideline": ("guideline_seed",),
    "snomed": ("snomed_ct",),
    "rxnorm": ("rxnorm",),
}


def _normalize_path(path: str, base_dir: str) -> str:
    if os.path.isabs(path):
        return path
    return os.path.abspath(os.path.join(base_dir, path))


def resolve_dataset(
    entry: DatasetEntry, base_dir: str, resolve_mode: str = "first_match"
) -> ResolvedDataset:
    """Resolve a single dataset entry to a concrete filesystem path.

    Args:
        entry: The dataset configuration entry to resolve.
        base_dir: Base directory used to resolve relative paths.
        resolve_mode: How to handle multiple glob matches. Only ``"first_match"``
            is currently supported.

    Returns:
        A ``ResolvedDataset`` with status ``"ok"``, ``"missing"``, ``"disabled"``,
        or ``"internal"``.

    Raises:
        ValueError: If ``resolve_mode`` is unsupported.
    """
    if not entry.enabled:
        return ResolvedDataset(
            key=entry.key,
            label=entry.label,
            source_type=entry.source_type,
            required=entry.required,
            enabled=entry.enabled,
            version=entry.version,
            resolved_path=None,
            status="disabled",
            diagnostics=["dataset disabled"],
        )

    if entry.source_type == "internal":
        return ResolvedDataset(
            key=entry.key,
            label=entry.label,
            source_type=entry.source_type,
            required=entry.required,
            enabled=entry.enabled,
            version=entry.version,
            resolved_path=None,
            status="internal",
            diagnostics=[],
        )

    if entry.source_type == "file":
        path = _normalize_path(entry.path or "", base_dir)
        if os.path.isfile(path) and os.access(path, os.R_OK):
            return ResolvedDataset(
                key=entry.key,
                label=entry.label,
                source_type=entry.source_type,
                required=entry.required,
                enabled=entry.enabled,
                version=entry.version,
                resolved_path=path,
                status="ok",
                diagnostics=[],
            )
        return ResolvedDataset(
            key=entry.key,
            label=entry.label,
            source_type=entry.source_type,
            required=entry.required,
            enabled=entry.enabled,
            version=entry.version,
            resolved_path=path,
            status="missing",
            diagnostics=[f"file not found or unreadable: {path}"],
        )

    pattern = _normalize_path(entry.pattern or "", base_dir)
    matches = sorted(glob.glob(pattern, recursive=True))
    if not matches:
        return ResolvedDataset(
            key=entry.key,
            label=entry.label,
            source_type=entry.source_type,
            required=entry.required,
            enabled=entry.enabled,
            version=entry.version,
            resolved_path=None,
            status="missing",
            diagnostics=[f"no files matched pattern: {pattern}"],
        )

    diagnostics: list[str] = []
    if len(matches) > 1:
        if resolve_mode == "first_match":
            diagnostics.append(
                f"multiple files matched pattern; using first match: {', '.join(matches)}"
            )
        else:
            raise ValueError(f"Unsupported resolve_mode: {resolve_mode}")

    return ResolvedDataset(
        key=entry.key,
        label=entry.label,
        source_type=entry.source_type,
        required=entry.required,
        enabled=entry.enabled,
        version=entry.version,
        resolved_path=matches[0],
        status="ok",
        diagnostics=diagnostics,
    )


def resolve_group(config: DatasetConfig, group: str) -> dict[str, ResolvedDataset]:
    """Resolve all datasets belonging to a named loader group.

    Args:
        config: Loaded dataset configuration.
        group: Group key, e.g. ``"icd"``, ``"loinc"``, ``"snomed"``.

    Returns:
        Mapping of dataset key → ``ResolvedDataset`` for every member of the group.

    Raises:
        KeyError: If ``group`` is unknown or a required dataset key is absent from config.
    """
    if group not in DATASET_GROUPS:
        raise KeyError(f"Unknown dataset group: {group}")

    resolved: dict[str, ResolvedDataset] = {}
    for key in DATASET_GROUPS[group]:
        entry = config.datasets.get(key)
        if entry is None:
            raise KeyError(
                f"Dataset group '{group}' requires missing config entry '{key}'"
            )
        resolved[key] = resolve_dataset(
            entry, config.defaults.base_dir, config.defaults.resolve_mode
        )
    return resolved


def format_resolution_line(result: ResolvedDataset) -> str:
    """Format a single ``ResolvedDataset`` as a human-readable status line.

    Args:
        result: The resolved dataset to format.

    Returns:
        A string like ``"- key: OK -> /path/to/file"`` or ``"- key: SKIPPED (reason)"``.
    """
    if result.status == "ok":
        suffix = result.resolved_path or ""
        if result.diagnostics:
            return f"- {result.key}: OK -> {suffix} ({'; '.join(result.diagnostics)})"
        return f"- {result.key}: OK -> {suffix}"
    if result.status == "internal":
        return f"- {result.key}: INTERNAL"
    if result.status == "disabled":
        return f"- {result.key}: DISABLED"
    reason = "; ".join(result.diagnostics) if result.diagnostics else "missing"
    return f"- {result.key}: SKIPPED ({reason})"
