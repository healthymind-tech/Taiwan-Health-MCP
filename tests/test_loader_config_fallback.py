"""Tests for loader config fallback behavior."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "loader"))

import main


def test_get_effective_dataset_config_falls_back_to_legacy(monkeypatch):
    monkeypatch.delenv("DATASETS_CONFIG", raising=False)
    monkeypatch.setenv("FHIR_CODE_DIR", "/legacy/data")

    main.FHIR_CODE_DIR = "/legacy/data"
    cfg = main.get_effective_dataset_config()

    assert cfg.datasets["icd10cm"].path == "/legacy/data/icd/10/icd10cm/icd10cm-table-index-2025.zip"
    assert cfg.datasets["twcore"].pattern == "/legacy/data/twcoreig/**/package.tgz"
