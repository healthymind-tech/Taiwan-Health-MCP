"""Tests for RxNorm-first guard in data-loader."""

import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "loader"))

import main


def _make_pool_with_rxnorm_count(count: int):
    conn = AsyncMock()
    conn.fetchval = AsyncMock(return_value=count)

    pool = MagicMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool, conn


@pytest.mark.asyncio
async def test_assert_rxnorm_ready_passes_when_threshold_met():
    pool, conn = _make_pool_with_rxnorm_count(10_500)

    await main._assert_rxnorm_ready_for_fda(pool, min_concepts=10_000)

    conn.fetchval.assert_called_once_with("SELECT COUNT(*) FROM drug.rx_concepts")


@pytest.mark.asyncio
async def test_assert_rxnorm_ready_raises_when_missing():
    pool, _ = _make_pool_with_rxnorm_count(0)

    with pytest.raises(RuntimeError, match="RxNorm must be loaded first"):
        await main._assert_rxnorm_ready_for_fda(pool, min_concepts=10_000)


@pytest.mark.asyncio
async def test_load_drug_checks_rxnorm_before_loader_call():
    pool = MagicMock()
    check = AsyncMock()
    load = AsyncMock()

    with (
        patch.object(main, "_assert_rxnorm_ready_for_fda", check),
        patch("loaders.drug_loader.load_drug", load),
    ):
        await main.load_drug(pool)

    check.assert_called_once_with(pool)
    load.assert_called_once_with(pool)


@pytest.mark.asyncio
async def test_load_drug_does_not_run_when_rxnorm_guard_fails():
    pool = MagicMock()
    check = AsyncMock(side_effect=RuntimeError("blocked"))
    load = AsyncMock()

    with (
        patch.object(main, "_assert_rxnorm_ready_for_fda", check),
        patch("loaders.drug_loader.load_drug", load),
    ):
        with pytest.raises(RuntimeError, match="blocked"):
            await main.load_drug(pool)

    load.assert_not_called()
