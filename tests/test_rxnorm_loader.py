"""Unit tests for RxNorm loader parsing and write targets."""

import os
import sys
import zipfile
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "loader"))

from loaders import rxnorm_loader


def _rrf_line(cols: list[str]) -> str:
    return "|".join(cols) + "|\n"


def _write_rxnorm_zip(path: str, conso_lines: list[str], rel_lines: list[str]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("rrf/RXNCONSO.RRF", "".join(conso_lines))
        zf.writestr("rrf/RXNREL.RRF", "".join(rel_lines))


def _make_pool(conn):
    pool = MagicMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool


def _make_conn():
    conn = AsyncMock()
    conn.execute = AsyncMock()
    conn.executemany = AsyncMock()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    return conn


def test_load_atc_mappings_extracts_and_filters(tmp_path):
    zip_path = tmp_path / "rxnorm.zip"
    conso = [
        # RxNorm concept row
        _rrf_line(
            [
                "123",
                "ENG",
                "P",
                "L1",
                "PF",
                "S1",
                "Y",
                "A1",
                "",
                "",
                "",
                "RXNORM",
                "IN",
                "123",
                "Metformin",
                "0",
                "N",
                "",
            ]
        ),
        # Valid ATC mapping row
        _rrf_line(
            [
                "123",
                "ENG",
                "P",
                "L2",
                "PF",
                "S2",
                "Y",
                "A2",
                "",
                "",
                "",
                "ATC",
                "PT",
                "A10BA02",
                "Biguanides",
                "0",
                "N",
                "",
            ]
        ),
        # Unknown rxcui should be skipped
        _rrf_line(
            [
                "999",
                "ENG",
                "P",
                "L3",
                "PF",
                "S3",
                "Y",
                "A3",
                "",
                "",
                "",
                "ATC",
                "PT",
                "C09AA05",
                "ACE inhibitors",
                "0",
                "N",
                "",
            ]
        ),
        # Suppressed row should be skipped
        _rrf_line(
            [
                "123",
                "ENG",
                "P",
                "L4",
                "PF",
                "S4",
                "Y",
                "A4",
                "",
                "",
                "",
                "ATC",
                "PT",
                "A10BX01",
                "Suppressed",
                "0",
                "O",
                "",
            ]
        ),
    ]
    rel = [
        _rrf_line(
            [
                "123",
                "",
                "CUI",
                "RO",
                "123",
                "",
                "CUI",
                "interacts_with",
                "1",
                "",
                "RXNORM",
                "",
                "",
                "",
                "N",
                "",
            ]
        )
    ]
    _write_rxnorm_zip(str(zip_path), conso, rel)

    with zipfile.ZipFile(zip_path) as zf:
        rows = rxnorm_loader._load_atc_mappings(zf, valid_rxcui={"123"})

    assert rows == [("123", "A10BA02", "Biguanides", "ATC", "N")]


@pytest.mark.asyncio
async def test_load_rxnorm_writes_into_drug_rx_tables(tmp_path):
    zip_path = tmp_path / "rxnorm.zip"
    conso = [
        _rrf_line(
            [
                "123",
                "ENG",
                "P",
                "L1",
                "PF",
                "S1",
                "Y",
                "A1",
                "",
                "",
                "",
                "RXNORM",
                "IN",
                "123",
                "Metformin",
                "0",
                "N",
                "",
            ]
        ),
        _rrf_line(
            [
                "123",
                "ENG",
                "P",
                "L2",
                "PF",
                "S2",
                "Y",
                "A2",
                "",
                "",
                "",
                "ATC",
                "PT",
                "A10BA02",
                "Biguanides",
                "0",
                "N",
                "",
            ]
        ),
    ]
    rel = [
        _rrf_line(
            [
                "123",
                "",
                "CUI",
                "RO",
                "123",
                "",
                "CUI",
                "interacts_with",
                "1",
                "",
                "RXNORM",
                "",
                "",
                "",
                "N",
                "",
            ]
        )
    ]
    _write_rxnorm_zip(str(zip_path), conso, rel)

    conn = _make_conn()
    pool = _make_pool(conn)

    await rxnorm_loader.load_rxnorm(pool, str(zip_path))

    assert any(
        c.args
        and c.args[0]
        == "TRUNCATE drug.rx_relationships, drug.rx_atc_map, drug.rx_concepts CASCADE"
        for c in conn.execute.call_args_list
    )

    sqls = [c.args[0] for c in conn.executemany.call_args_list]
    assert any("INSERT INTO drug.rx_concepts" in s for s in sqls)
    assert any("INSERT INTO drug.rx_relationships" in s for s in sqls)
    assert any("INSERT INTO drug.rx_atc_map" in s for s in sqls)
