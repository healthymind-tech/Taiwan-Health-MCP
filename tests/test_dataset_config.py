"""Tests for dataset configuration parsing."""

from pathlib import Path
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "loader"))

from dataset_config import load_dataset_config, parse_dataset_config


def test_parse_dataset_config_basic_yaml():
    text = """
version: 1
defaults:
  base_dir: /tmp/data
  missing_policy: warn
  resolve_mode: first_match
datasets:
  icd10cm:
    enabled: true
    required: true
    source_type: file
    path: /tmp/data/icd.zip
    label: ICD-10-CM
    version: "2025"
  guideline_seed:
    enabled: true
    required: true
    source_type: internal
    label: Guideline
"""
    cfg = parse_dataset_config(text)
    assert cfg.version == 1
    assert cfg.defaults.base_dir == "/tmp/data"
    assert cfg.datasets["icd10cm"].path == "/tmp/data/icd.zip"
    assert cfg.datasets["guideline_seed"].source_type == "internal"


def test_parse_dataset_config_invalid_version():
    with pytest.raises(ValueError, match="Unsupported dataset config version"):
        parse_dataset_config("version: 2\ndatasets:\n  a:\n    enabled: true\n    required: true\n    source_type: internal\n    label: A\n")


def test_load_dataset_config_from_file(tmp_path: Path):
    path = tmp_path / "datasets.yaml"
    path.write_text(
        """
version: 1
defaults:
  base_dir: /var/lib/data
datasets:
  loinc:
    enabled: true
    required: true
    source_type: file
    path: loinc/Loinc.zip
    label: LOINC
""",
        encoding="utf-8",
    )
    cfg = load_dataset_config(str(path))
    assert cfg.defaults.base_dir == "/var/lib/data"
    assert cfg.datasets["loinc"].path == "loinc/Loinc.zip"
