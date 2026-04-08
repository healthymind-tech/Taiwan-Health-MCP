"""
Unit tests for service-layer query methods.

Tests service methods in isolation using mocked asyncpg pools.
Covers query logic, result formatting, and error/empty-result paths.
"""

import json
import sys
import os
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


# ── shared pool helpers ───────────────────────────────────────────────────────

def _make_conn(fetch_return=None, fetchrow_return=None, fetchval_return=None):
    conn = AsyncMock()
    conn.fetch    = AsyncMock(return_value=fetch_return or [])
    conn.fetchrow = AsyncMock(return_value=fetchrow_return)
    conn.fetchval = AsyncMock(return_value=fetchval_return or 0)
    conn.execute  = AsyncMock()
    conn.executemany = AsyncMock()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__  = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    return conn


def _make_pool(conn):
    pool = MagicMock()
    pool.fetchval = AsyncMock(return_value=0)
    pool.fetchrow = AsyncMock(return_value=None)
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__  = AsyncMock(return_value=False)
    return pool


def _row(**kwargs):
    """Create a mapping-like object that behaves like an asyncpg Record."""
    return dict(**kwargs)


# ── ICDService ────────────────────────────────────────────────────────────────

class TestICDServiceQuery:
    @pytest.mark.asyncio
    async def test_search_codes_returns_diagnoses(self):
        from icd_service import ICDService

        conn = _make_conn(
            fetch_return=[_row(code="E11.9", name_zh="第2型糖尿病", name_en="Type 2 diabetes mellitus")]
        )
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(side_effect=[1, 0])

        svc = ICDService(pool)
        await svc.initialize()

        result = json.loads(await svc.search_codes("E11", "diagnosis"))
        assert len(result["diagnoses"]) == 1
        assert result["diagnoses"][0]["code"] == "E11.9"

    @pytest.mark.asyncio
    async def test_search_codes_no_results_returns_error(self):
        from icd_service import ICDService

        conn = _make_conn(fetch_return=[])
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(side_effect=[1, 0])

        svc = ICDService(pool)
        await svc.initialize()

        result = json.loads(await svc.search_codes("zzz_no_match", "diagnosis"))
        assert "error" in result

    @pytest.mark.asyncio
    async def test_infer_complications_returns_children(self):
        from icd_service import ICDService

        children = [_row(code="E11.1", name_zh="第2型糖尿病，有酮酸中毒")]
        conn = _make_conn(fetch_return=children)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(side_effect=[1, 0])

        svc = ICDService(pool)
        await svc.initialize()

        result = json.loads(await svc.infer_complications("E11"))
        assert result["base_code"] == "E11"
        assert len(result["potential_complications_or_specifics"]) == 1

    @pytest.mark.asyncio
    async def test_browse_category_lists_all_when_none(self):
        from icd_service import ICDService

        rows = [_row(category="E11", name_zh="第2型糖尿病", count=12)]
        conn = _make_conn(fetch_return=rows)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(side_effect=[1, 0])

        svc = ICDService(pool)
        await svc.initialize()

        result = json.loads(await svc.browse_category(None))
        assert "categories" in result
        assert len(result["categories"]) == 1


# ── LabService ────────────────────────────────────────────────────────────────

class TestLabServiceQuery:
    @pytest.mark.asyncio
    async def test_search_loinc_code_returns_results(self):
        from lab_service import LabService

        rows = [_row(
            loinc_num="2345-7",
            long_common_name="Glucose [Mass/volume] in Serum or Plasma",
            shortname="Glucose SerPl-mCnc",
            name_zh="血清血漿葡萄糖",
            common_name_zh="血糖",
            class_="CHEM",
            specimen_type="Ser/Plas",
            unit="mg/dL",
        )]
        conn = _make_conn(fetch_return=rows)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = LabService(pool)
        await svc.initialize()

        result = json.loads(await svc.search_loinc_code("glucose"))
        assert result["total_found"] == 1

    @pytest.mark.asyncio
    async def test_search_loinc_no_results(self):
        from lab_service import LabService

        conn = _make_conn(fetch_return=[])
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = LabService(pool)
        await svc.initialize()

        result = json.loads(await svc.search_loinc_code("zzz_no_match"))
        assert "message" in result

    @pytest.mark.asyncio
    async def test_interpret_lab_result_high(self):
        from lab_service import LabService

        conn = _make_conn()
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = LabService(pool)
        await svc.initialize()

        concept_row = _row(
            loinc_num="2345-7",
            long_common_name="Glucose [Mass/volume] in Serum or Plasma",
            name_zh="血清血漿葡萄糖",
            common_name_zh="血糖",
            unit="mg/dL",
        )
        ref_row = _row(
            range_low=70, range_high=100,
            unit="mg/dL", interpretation="Normal fasting glucose",
            age_min=0, age_max=200, gender="all",
        )

        async def side_fetchrow(query, *args, **kwargs):
            if "reference_ranges" in query:
                return ref_row
            return concept_row

        conn.fetchrow = AsyncMock(side_effect=side_fetchrow)

        result = json.loads(await svc.interpret_lab_result("2345-7", 126.0, 45, "all"))
        assert result["result"]["flag"] == "H"
        assert "偏高" in result["result"]["status"]

    @pytest.mark.asyncio
    async def test_interpret_lab_result_normal(self):
        from lab_service import LabService

        conn = _make_conn()
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = LabService(pool)
        await svc.initialize()

        concept_row = _row(
            loinc_num="2345-7",
            long_common_name="Glucose [Mass/volume] in Serum or Plasma",
            name_zh="血清血漿葡萄糖",
            common_name_zh="血糖",
            unit="mg/dL",
        )
        ref_row = _row(
            range_low=70, range_high=100,
            unit="mg/dL", interpretation="Normal",
            age_min=0, age_max=200, gender="all",
        )

        async def side_fetchrow(query, *args, **kwargs):
            if "reference_ranges" in query:
                return ref_row
            return concept_row

        conn.fetchrow = AsyncMock(side_effect=side_fetchrow)

        result = json.loads(await svc.interpret_lab_result("2345-7", 85.0, 45, "all"))
        assert result["result"]["flag"] == "N"

    @pytest.mark.asyncio
    async def test_interpret_lab_result_low(self):
        from lab_service import LabService

        conn = _make_conn()
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = LabService(pool)
        await svc.initialize()

        concept_row = _row(
            loinc_num="2345-7",
            long_common_name="Glucose",
            name_zh="血糖",
            common_name_zh="血糖",
            unit="mg/dL",
        )
        ref_row = _row(
            range_low=70, range_high=100,
            unit="mg/dL", interpretation="Normal",
            age_min=0, age_max=200, gender="all",
        )

        async def side_fetchrow(query, *args, **kwargs):
            if "reference_ranges" in query:
                return ref_row
            return concept_row

        conn.fetchrow = AsyncMock(side_effect=side_fetchrow)

        result = json.loads(await svc.interpret_lab_result("2345-7", 50.0, 45, "all"))
        assert result["result"]["flag"] == "L"

    @pytest.mark.asyncio
    async def test_batch_interpret_skips_missing_fields(self):
        from lab_service import LabService

        conn = _make_conn()
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = LabService(pool)
        await svc.initialize()

        # Missing loinc_code field
        conn.fetchrow = AsyncMock(return_value=None)

        result = json.loads(await svc.batch_interpret_results(
            [{"value": 5.5}, {"loinc_code": "2345-7"}],   # first missing loinc, second missing value
            age=40,
            gender="all",
        ))
        assert result["total_tests"] == 0


# ── FoodNutritionService ──────────────────────────────────────────────────────

class TestFoodNutritionService:
    @pytest.mark.asyncio
    async def test_search_nutrition_no_results(self):
        from food_nutrition_service import FoodNutritionService

        conn = _make_conn(fetch_return=[])
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = FoodNutritionService(pool)

        result = json.loads(await svc.search_nutrition("zzz_no_food"))
        assert "error" in result

    @pytest.mark.asyncio
    async def test_search_nutrition_groups_by_food(self):
        from food_nutrition_service import FoodNutritionService

        rows = [
            _row(
                sample_name="白米", common_name="", food_category="穀類",
                nutrient_item="熱量", content_per_100g="360", content_unit="kcal",
            ),
            _row(
                sample_name="白米", common_name="", food_category="穀類",
                nutrient_item="粗蛋白", content_per_100g="7.1", content_unit="g",
            ),
        ]
        conn = _make_conn(fetch_return=rows)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = FoodNutritionService(pool)
        result = json.loads(await svc.search_nutrition("白米"))
        assert len(result) == 1
        assert result[0]["food"] == "白米"
        assert len(result[0]["nutrients"]) == 2

    @pytest.mark.asyncio
    async def test_analyze_meal_accumulates_nutrients(self):
        from food_nutrition_service import FoodNutritionService

        # Both foods have protein
        rows = [
            _row(nutrient_item="粗蛋白", content_per_100g="7.1", content_unit="g"),
        ]
        conn = _make_conn(fetch_return=rows)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = FoodNutritionService(pool)
        result = json.loads(await svc.analyze_meal_nutrition(["白米", "糙米"]))
        # Two foods × 7.1 = 14.2
        assert abs(result["combined_totals_per_100g_each"]["粗蛋白"] - 14.2) < 0.01


class TestHealthFoodService:
    @pytest.mark.asyncio
    async def test_analyze_health_support_resolves_text_diagnosis_to_icd(self):
        from health_food_service import HealthFoodService

        conn = _make_conn(fetch_return=[_row(permit_no="A001", name="產品A", benefit_claims="調節血糖")])
        pool = _make_pool(conn)
        svc = HealthFoodService(pool)

        icd_service = MagicMock()
        icd_service.search_codes = AsyncMock(return_value=json.dumps({
            "diagnoses": [
                {"code": "E11.9", "name_zh": "第二型糖尿病", "name_en": "Type 2 diabetes mellitus"}
            ]
        }, ensure_ascii=False))

        result = json.loads(
            await svc.analyze_health_support_for_condition("第二型糖尿病", icd_service=icd_service)
        )

        assert result["icd_code"] == "E11"
        assert "調節血糖" in result["recommended_benefits"]
        assert len(result["health_foods"]) == 1

    @pytest.mark.asyncio
    async def test_analyze_health_support_keeps_free_text_when_no_icd_match(self):
        from health_food_service import HealthFoodService

        conn = _make_conn(fetch_return=[])
        pool = _make_pool(conn)
        svc = HealthFoodService(pool)

        icd_service = MagicMock()
        icd_service.search_codes = AsyncMock(return_value=json.dumps({"diagnoses": []}, ensure_ascii=False))

        result = json.loads(
            await svc.analyze_health_support_for_condition("第二型糖尿病", icd_service=icd_service)
        )

        assert result["icd_code"] is None
        assert result["recommended_benefits"] == ["第二型糖尿病"]


# ── ClinicalGuidelineService ──────────────────────────────────────────────────

class TestClinicalGuidelineService:
    @pytest.mark.asyncio
    async def test_search_guideline_no_results(self):
        from clinical_guideline_service import ClinicalGuidelineService

        conn = _make_conn(fetch_return=[])
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=5)

        svc = ClinicalGuidelineService(pool)
        result = json.loads(await svc.search_guideline("zzz_no_match"))
        assert "message" in result

    @pytest.mark.asyncio
    async def test_search_guideline_returns_results(self):
        from clinical_guideline_service import ClinicalGuidelineService

        rows = [_row(
            id=1,
            icd_code="E11",
            disease_name_zh="第二型糖尿病",
            disease_name_en="Type 2 Diabetes Mellitus",
            guideline_title="糖尿病臨床照護指引",
            guideline_source="中華民國糖尿病學會",
            publication_year=2023,
        )]
        conn = _make_conn(fetch_return=rows)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=5)

        svc = ClinicalGuidelineService(pool)
        result = json.loads(await svc.search_guideline("E11"))
        assert result["total_found"] == 1
        assert result["guidelines"][0]["icd_code"] == "E11"

    @pytest.mark.asyncio
    async def test_get_medication_recommendations_not_found(self):
        from clinical_guideline_service import ClinicalGuidelineService

        conn = _make_conn(fetch_return=[])
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=5)

        svc = ClinicalGuidelineService(pool)
        result = json.loads(await svc.get_medication_recommendations("ZZZ"))
        assert "message" in result

    @pytest.mark.asyncio
    async def test_get_treatment_goals_not_found(self):
        from clinical_guideline_service import ClinicalGuidelineService

        conn = _make_conn(fetch_return=[])
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=5)

        svc = ClinicalGuidelineService(pool)
        result = json.loads(await svc.get_treatment_goals("ZZZ"))
        assert "message" in result


# ── SNOMEDService ─────────────────────────────────────────────────────────────

class TestSNOMEDService:
    @pytest.mark.asyncio
    async def test_search_concepts_deduplicates_by_concept_id(self):
        from snomed_service import SNOMEDService, FSN_TYPE, SYNONYM_TYPE

        # Same concept_id appears twice (once FSN, once synonym) — should be deduplicated
        rows = [
            _row(concept_id=73211009, preferred_term="Diabetes mellitus (disorder)", type_id=FSN_TYPE, active=True),
            _row(concept_id=73211009, preferred_term="DM", type_id=SYNONYM_TYPE, active=True),
        ]
        conn = _make_conn(fetch_return=rows)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=500000)

        svc = SNOMEDService(pool)
        results = await svc.search_concepts("diabetes")
        # Should deduplicate to 1 result, preferring FSN
        assert len(results) == 1
        assert results[0]["term_type"] == "FSN"

    @pytest.mark.asyncio
    async def test_get_concept_returns_none_for_missing(self):
        from snomed_service import SNOMEDService

        conn = _make_conn(fetchrow_return=None)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=500000)

        svc = SNOMEDService(pool)
        result = await svc.get_concept(99999999)
        assert result is None

    @pytest.mark.asyncio
    async def test_map_icd_to_snomed_returns_list(self):
        from snomed_service import SNOMEDService, FSN_TYPE

        rows = [_row(
            concept_id=44054006,
            map_rule="TRUE",
            map_advice="ALWAYS E11.9",
            map_priority=1,
            map_group=1,
            fsn="Type 2 diabetes mellitus (disorder)",
        )]
        conn = _make_conn(fetch_return=rows)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=500000)

        svc = SNOMEDService(pool)
        results = await svc.map_icd_to_snomed("E11.9")
        assert len(results) == 1
        assert results[0]["icd10_code"] == "E11.9"


# ── DrugInteractionService ────────────────────────────────────────────────────

class TestDrugInteractionService:
    @pytest.mark.asyncio
    async def test_resolve_drug_empty(self):
        from drug_interaction_service import DrugInteractionService

        conn = _make_conn(fetch_return=[])
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        svc = DrugInteractionService(pool)
        results = await svc.resolve_drug("zzz_unknown")
        assert results == []

    @pytest.mark.asyncio
    async def test_get_drug_ingredients_unknown_rxcui(self):
        from drug_interaction_service import DrugInteractionService

        conn = _make_conn(fetchval_return=None)
        pool = _make_pool(conn)
        pool.fetchval = AsyncMock(return_value=100)

        # fetchval returns None (concept not found)
        conn.fetchval = AsyncMock(return_value=None)

        svc = DrugInteractionService(pool)
        result = await svc.get_drug_ingredients("NOTEXIST")
        assert result is None
