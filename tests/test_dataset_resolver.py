"""Tests for dataset path resolution."""

from pathlib import Path
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "loader"))

from dataset_config import DatasetConfig, DatasetDefaults, DatasetEntry
from dataset_resolver import resolve_dataset, resolve_group


def test_resolve_file_dataset(tmp_path: Path):
    file_path = tmp_path / "icd.zip"
    file_path.write_text("x", encoding="utf-8")
    entry = DatasetEntry(
        key="icd10cm",
        enabled=True,
        required=True,
        source_type="file",
        path=str(file_path),
        pattern=None,
        label="ICD-10-CM",
        version="2025",
    )
    resolved = resolve_dataset(entry, str(tmp_path))
    assert resolved.status == "ok"
    assert resolved.resolved_path == str(file_path)


def test_resolve_glob_dataset_first_match_warns(tmp_path: Path):
    a = tmp_path / "a.zip"
    b = tmp_path / "b.zip"
    a.write_text("a", encoding="utf-8")
    b.write_text("b", encoding="utf-8")
    entry = DatasetEntry(
        key="snomed_ct",
        enabled=True,
        required=False,
        source_type="glob",
        path=None,
        pattern=str(tmp_path / "*.zip"),
        label="SNOMED CT",
        version=None,
    )
    resolved = resolve_dataset(entry, str(tmp_path))
    assert resolved.status == "ok"
    assert resolved.resolved_path == str(a)
    assert resolved.diagnostics


def test_resolve_missing_optional_dataset(tmp_path: Path):
    entry = DatasetEntry(
        key="snomed_ct",
        enabled=True,
        required=False,
        source_type="glob",
        path=None,
        pattern=str(tmp_path / "*.zip"),
        label="SNOMED CT",
        version=None,
    )
    resolved = resolve_dataset(entry, str(tmp_path))
    assert resolved.status == "missing"
    assert resolved.required is False


def test_resolve_drug_group(tmp_path: Path):
    csv_path = tmp_path / "36_2.csv"
    csv_path.write_text("許可證字號\nA001\n", encoding="utf-8")
    config = DatasetConfig(
        version=1,
        defaults=DatasetDefaults(base_dir=str(tmp_path)),
        datasets={
            "drug_index_csv": DatasetEntry(
                key="drug_index_csv",
                enabled=True,
                required=True,
                source_type="file",
                path=str(csv_path),
                pattern=None,
                label="Drug index CSV",
                version=None,
            )
        },
    )
    resolved = resolve_group(config, "drug")
    assert "drug_index_csv" in resolved
    assert resolved["drug_index_csv"].status == "ok"
