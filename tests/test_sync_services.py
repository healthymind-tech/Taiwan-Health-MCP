"""
Tests for drug / health food / food nutrition sync logic.
Verifies that a network failure during sync does NOT corrupt the DB
(all writes are in one transaction, so a failed fetch = no DB change).
"""

import asyncio
import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


# ── Shared fixtures ──────────────────────────────────────────────────────────

def _make_conn_mock():
    conn = AsyncMock()
    conn.execute = AsyncMock()
    conn.executemany = AsyncMock()
    conn.fetchval = AsyncMock(return_value=5)
    conn.fetchrow = AsyncMock(return_value=None)
    # Support async context manager for conn.transaction()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    return conn


def _make_pool_mock(conn):
    pool = MagicMock()
    pool.fetchval = AsyncMock(return_value=5)
    pool.fetchrow = AsyncMock(return_value=None)
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool


# ── DrugService ──────────────────────────────────────────────────────────────

class TestDrugServiceSync:
    @pytest.mark.asyncio
    async def test_successful_sync_calls_transaction(self):
        from drug_service import DrugService

        conn = _make_conn_mock()
        pool = _make_pool_mock(conn)

        sample_license = {"許可證字號": "L001", "中文品名": "藥A", "英文品名": "DrugA",
                          "適應症": "ind", "劑型": "tab", "包裝": "pkg",
                          "藥品類別": "cat", "申請商名稱": "mfg", "有效日期": "2030",
                          "用法用量": "QD"}

        svc = DrugService(pool)

        with patch.object(svc, "_fetch_json", new=AsyncMock(return_value=[sample_license])):
            await svc._sync_all()

        # Transaction must have been started
        conn.transaction.assert_called()
        # TRUNCATE must have been issued
        truncate_calls = [c for c in conn.execute.call_args_list
                          if "TRUNCATE" in str(c)]
        assert len(truncate_calls) >= 1
        # Child-table inserts should be duplicate-safe under unique indexes
        child_sqls = [c.args[0] for c in conn.executemany.call_args_list if c.args]
        assert any(
            "INSERT INTO drug.appearance" in s and "ON CONFLICT DO NOTHING" in s
            for s in child_sqls
        )
        assert any(
            "INSERT INTO drug.ingredients" in s and "ON CONFLICT DO NOTHING" in s
            for s in child_sqls
        )
        assert any(
            "INSERT INTO drug.atc" in s and "ON CONFLICT DO NOTHING" in s
            for s in child_sqls
        )
        assert any(
            "INSERT INTO drug.documents" in s and "ON CONFLICT DO NOTHING" in s
            for s in child_sqls
        )

    @pytest.mark.asyncio
    async def test_fetch_failure_prevents_db_write(self):
        """If any fetch raises, executemany (i.e. DB write) must not be called."""
        from drug_service import DrugService

        conn = _make_conn_mock()
        pool = _make_pool_mock(conn)
        svc = DrugService(pool)

        async def fail_on_third(client, url):
            if "43" in url:   # ingredients endpoint
                raise ConnectionError("network error")
            return [{"許可證字號": "L001", "中文品名": "X", "英文品名": "X",
                     "適應症": "", "劑型": "", "包裝": "", "藥品類別": "",
                     "申請商名稱": "", "有效日期": "", "用法用量": ""}]

        with patch.object(svc, "_fetch_json", new=fail_on_third):
            await svc._sync_all()   # must not raise

        # executemany (insert rows) must NOT have been called
        conn.executemany.assert_not_called()


class TestDrugServiceIdentifyPill:
    @pytest.mark.asyncio
    async def test_expands_english_feature_keywords(self):
        from drug_service import DrugService

        conn = _make_conn_mock()
        conn.fetch = AsyncMock(
            return_value=[
                {
                    "name_zh": "測試藥",
                    "name_en": "TestDrug",
                    "shape": "圓形",
                    "color": "白色",
                    "marking": "YP",
                    "image_url": "",
                    "license_id": "L001",
                }
            ]
        )
        pool = _make_pool_mock(conn)
        svc = DrugService(pool)

        result = json.loads(await svc.identify_pill("white round"))
        assert isinstance(result, list)
        assert result[0]["license_id"] == "L001"

        fetch_args = conn.fetch.await_args.args
        params = fetch_args[1:]
        assert any(p == "%white%" for p in params)
        assert any(p == "%白%" for p in params)
        assert any(p == "%round%" for p in params)
        assert any(p == "%圓形%" for p in params)

    @pytest.mark.asyncio
    async def test_retries_without_digit_token_when_strict_match_empty(self):
        from drug_service import DrugService

        conn = _make_conn_mock()
        conn.fetch = AsyncMock(
            side_effect=[
                [],
                [
                    {
                        "name_zh": "測試藥",
                        "name_en": "TestDrug",
                        "shape": "圓形",
                        "color": "白色",
                        "marking": "YP",
                        "image_url": "",
                        "license_id": "L001",
                    }
                ],
            ]
        )
        pool = _make_pool_mock(conn)
        svc = DrugService(pool)

        result = json.loads(await svc.identify_pill("white round M500"))
        assert isinstance(result, list)
        assert result[0]["license_id"] == "L001"
        assert conn.fetch.await_count == 2

        strict_params = conn.fetch.await_args_list[0].args[1:]
        relaxed_params = conn.fetch.await_args_list[1].args[1:]
        assert any(p == "%M500%" for p in strict_params)
        assert not any(p == "%M500%" for p in relaxed_params)


# ── HealthFoodService ────────────────────────────────────────────────────────

class TestHealthFoodSync:
    @pytest.mark.asyncio
    async def test_successful_sync_writes_data(self):
        from health_food_service import HealthFoodService

        conn = _make_conn_mock()
        pool = _make_pool_mock(conn)
        svc = HealthFoodService(pool)

        sample = {"許可證字號": "H001", "中文品名": "健食A", "申請商": "公司",
                  "保健功效": "調節血糖", "核可日期": "20230101", "類別": "A"}

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_resp = AsyncMock()
            mock_resp.raise_for_status = MagicMock()
            mock_resp.headers = {"content-type": "application/json"}
            mock_resp.json = MagicMock(return_value=[sample])
            mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=MagicMock(
                get=AsyncMock(return_value=mock_resp)
            ))
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            await svc._sync()

        conn.executemany.assert_called()

    @pytest.mark.asyncio
    async def test_network_failure_prevents_db_write(self):
        from health_food_service import HealthFoodService

        conn = _make_conn_mock()
        pool = _make_pool_mock(conn)
        svc = HealthFoodService(pool)

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=MagicMock(
                get=AsyncMock(side_effect=ConnectionError("down"))
            ))
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            await svc._sync()   # must not raise

        conn.executemany.assert_not_called()


# ── ICDService PCS fallback ──────────────────────────────────────────────────

class TestICDServicePCS:
    @pytest.mark.asyncio
    async def test_search_returns_pcs_note_when_not_loaded(self):
        from icd_service import ICDService

        conn = _make_conn_mock()
        # diagnoses = 100, procedures = 0
        conn.fetchval = AsyncMock(side_effect=[100, 0])
        conn.fetch = AsyncMock(return_value=[])
        pool = _make_pool_mock(conn)
        pool.fetchval = AsyncMock(side_effect=[100, 0])

        svc = ICDService(pool)
        await svc.initialize()

        assert svc._pcs_available is False

        result = json.loads(await svc.search_codes("appendectomy", "procedure"))
        assert "procedures_note" in result
        assert result["procedures"] == []


# ── DrugService fuzzy license lookup ─────────────────────────────────────────

class TestDrugServiceFuzzyLicenseLookup:
    """Unit tests for _fuzzy_license_lookup and get_drug_details_by_license."""

    def _make_license_row(self, license_id="衛部藥製字第058774號", name_zh="測試藥品", name_en="TestDrug"):
        row = MagicMock()
        row.__getitem__ = lambda self, k: {
            "license_id": license_id, "name_zh": name_zh, "name_en": name_en,
            "indication": "ind", "usage": "use", "form": "tablet",
            "package": "30 tabs", "category": "cat", "manufacturer": "mfg",
            "valid_date": "2030-12-31",
        }[k]
        row.keys = MagicMock(return_value=[
            "license_id","name_zh","name_en","indication","usage",
            "form","package","category","manufacturer","valid_date",
        ])
        # Make dict(row) work
        def items():
            return {
                "license_id": license_id, "name_zh": name_zh, "name_en": name_en,
                "indication": "ind", "usage": "use", "form": "tablet",
                "package": "30 tabs", "category": "cat", "manufacturer": "mfg",
                "valid_date": "2030-12-31",
            }.items()
        row.items = items
        return row

    @pytest.mark.asyncio
    async def test_exact_match_succeeds(self):
        from drug_service import DrugService

        license_row = self._make_license_row()

        conn = _make_conn_mock()
        # fetchrow is called for: (1) exact match, (2) appearance, (3) doc insert
        # Return the license row only for the exact-match query; None for the rest
        async def fetchrow_side(query, *args):
            if "drug.licenses" in query:
                return license_row
            return None  # appearance / doc queries

        conn.fetchrow = AsyncMock(side_effect=fetchrow_side)
        conn.fetch = AsyncMock(return_value=[])
        pool = _make_pool_mock(conn)
        pool.fetchval = AsyncMock(return_value=10)

        svc = DrugService(pool)
        result = json.loads(await svc.get_drug_details_by_license("衛部藥製字第058774號"))
        assert result["license_id"] == "衛部藥製字第058774號"

    @pytest.mark.asyncio
    async def test_fuzzy_single_hit_resolves(self):
        """Exact miss → ILIKE returns exactly 1 row → auto-resolved."""
        from drug_service import DrugService

        license_row = self._make_license_row(license_id="衛部藥製字第058774號")
        conn = _make_conn_mock()
        call_count = 0

        async def fetchrow_side(query, *args):
            nonlocal call_count
            call_count += 1
            # exact match fails; subsequent detail queries return None
            if call_count == 1:
                return None
            return None

        async def fetch_side(query, *args):
            # First fetch call = ILIKE fuzzy → return 1 candidate
            if "ILIKE" in query:
                return [license_row]
            return []

        conn.fetchrow = AsyncMock(side_effect=fetchrow_side)
        conn.fetch = AsyncMock(side_effect=fetch_side)
        pool = _make_pool_mock(conn)
        pool.fetchval = AsyncMock(return_value=10)

        svc = DrugService(pool)
        result = json.loads(await svc.get_drug_details_by_license("058774"))
        # Should succeed via fuzzy lookup
        assert "error" not in result or "candidates" not in result

    @pytest.mark.asyncio
    async def test_fuzzy_multiple_hits_autoresolves_bare_digits(self):
        """Bare digits should auto-resolve to one best candidate."""
        from drug_service import DrugService

        row1 = self._make_license_row(license_id="衛部藥製字第058774號", name_zh="藥品A")
        row2 = self._make_license_row(license_id="衛署藥製字第058774號", name_zh="藥品B")

        conn = _make_conn_mock()

        async def fetchrow_side(query, *args):
            return None  # exact always misses

        async def fetch_side(query, *args):
            if "ILIKE" in query:
                return [row1, row2]
            return []

        conn.fetchrow = AsyncMock(side_effect=fetchrow_side)
        conn.fetch = AsyncMock(side_effect=fetch_side)
        pool = _make_pool_mock(conn)
        pool.fetchval = AsyncMock(return_value=10)

        svc = DrugService(pool)
        result = json.loads(await svc.get_drug_details_by_license("058774"))
        assert "candidates" not in result
        assert result["license_id"] == "衛部藥製字第058774號"

    @pytest.mark.asyncio
    async def test_search_by_license_id_bare_digits_autoresolves(self):
        """Bare digit license lookup should resolve through search_by_license_id."""
        from drug_service import DrugService

        row = self._make_license_row(license_id="內衛成製字第000029號", name_zh="藥品C")
        ingredient_row = MagicMock()
        ingredient_row.__getitem__.side_effect = lambda k: {
            "license_id": "內衛成製字第000029號",
            "ingredient_name": "acetaminophen",
            "ingredient_qty": "500",
            "ingredient_unit": "mg",
        }[k]
        conn = _make_conn_mock()

        async def fetchrow_side(query, *args):
            return None

        async def fetch_side(query, *args):
            if "FROM drug.licenses" in query:
                return [row]
            if "FROM drug.ingredients" in query:
                return [ingredient_row]
            if "FROM drug.appearance" in query:
                return []
            if "FROM drug.atc" in query:
                return []
            if "FROM drug.documents" in query:
                return []
            return []

        conn.fetchrow = AsyncMock(side_effect=fetchrow_side)
        conn.fetch = AsyncMock(side_effect=fetch_side)
        pool = _make_pool_mock(conn)
        pool.fetchval = AsyncMock(return_value=10)

        svc = DrugService(pool)
        result = json.loads(await svc.search_by_license_id("000029"))
        assert result["mode"] == "license_id"
        assert result["keyword"] == "000029"
        assert result["results"][0]["license_id"] == "內衛成製字第000029號"

    @pytest.mark.asyncio
    async def test_no_match_returns_error(self):
        """All three tiers miss → error message."""
        from drug_service import DrugService

        conn = _make_conn_mock()
        conn.fetchrow = AsyncMock(return_value=None)
        conn.fetch = AsyncMock(return_value=[])
        pool = _make_pool_mock(conn)
        pool.fetchval = AsyncMock(return_value=10)

        svc = DrugService(pool)
        result = json.loads(await svc.get_drug_details_by_license("NOTEXIST999"))
        assert "error" in result
        assert "candidates" not in result
