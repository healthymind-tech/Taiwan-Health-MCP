"""
Unit tests for Health Supplement + Food Nutrition tool functions in server.py.

Tools covered:
  search_health_supplement,
  search_food_nutrition, get_detailed_nutrition, search_food_ingredient,
  get_ingredients_by_category, search_foods_by_nutrient, analyze_meal_nutrition
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


# ── helpers ───────────────────────────────────────────────────────────────────

def _hf_mock():
    m = MagicMock()
    conn = MagicMock()
    conn.fetchrow = AsyncMock(return_value={
        "permit_no": "H001",
        "name": "靈芝膠囊",
        "applicant": "A公司",
        "benefit_claims": "護肝",
        "ingredients": [],
        "specs": {},
        "status": "approved",
        "source_url": "https://example.com",
    })
    conn.fetch = AsyncMock(return_value=[])
    m.pool = MagicMock()
    m.pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    m.pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    m.search_health_food = AsyncMock(return_value='{"mode":"keyword","keyword":"護肝","results":[{"permit_no":"H001"}]}')
    m.analyze_health_support_for_condition = AsyncMock(
        return_value='{"icd_code":"E11","recommended_benefits":["調節血糖"],"health_foods":[{"permit_no":"H001"}],"disclaimer":"..."}'
    )
    return m


def _fn_mock():
    m = MagicMock()
    m.search_nutrition             = AsyncMock(return_value='[]')
    m.get_detailed_nutrition       = AsyncMock(return_value='[]')
    m.search_food_ingredient       = AsyncMock(return_value='[]')
    m.get_ingredients_by_category  = AsyncMock(return_value='[]')
    m.search_foods_by_nutrient     = AsyncMock(return_value='{"foods":[]}')
    m.analyze_meal_nutrition       = AsyncMock(return_value='{"meal_components":{},"combined_totals_per_100g_each":{}}')
    return m


# ── search_health_supplement ─────────────────────────────────────────────────

class TestSearchHealthSupplement:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "health_food_service", None):
            result = json.loads(await server.search_health_supplement(keyword="靈芝"))
        assert "error" in result
        assert "Health Supplement Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_with_default_limit(self):
        mock_svc = _hf_mock()
        with patch.object(server, "health_food_service", mock_svc):
            await server.search_health_supplement(keyword="護肝")
        mock_svc.search_health_food.assert_called_once_with("護肝", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _hf_mock()
        with patch.object(server, "health_food_service", mock_svc):
            await server.search_health_supplement(keyword="益生菌", limit=7)
        mock_svc.search_health_food.assert_called_once_with("益生菌", limit=7)

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"mode":"keyword","keyword":"靈芝","results":[{"permit_no":"H001","product_name":"靈芝膠囊","company":"A公司","benefits":"護肝","ingredients":[],"specs":{},"status":"approved","source_url":"https://example.com"}]}'
        mock_svc = _hf_mock()
        mock_svc.search_health_food = AsyncMock(return_value='{"mode":"keyword","keyword":"靈芝","results":[{"permit_no":"H001"}]}')
        with patch.object(server, "health_food_service", mock_svc):
            result = await server.search_health_supplement(keyword="靈芝")
        assert json.loads(result) == json.loads(payload)

    @pytest.mark.asyncio
    async def test_permit_no_digits_only(self):
        mock_svc = _hf_mock()
        mock_conn = MagicMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        mock_conn.fetch = AsyncMock(return_value=[
            {
                "permit_no": "衛部健食字第A00022號",
                "name": "產品A",
                "applicant": "A公司",
                "benefit_claims": "調節血脂",
                "ingredients": [],
                "specs": {},
                "status": "approved",
                "source_url": "https://example.com",
            }
        ])
        mock_svc.pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_svc.pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
        with patch.object(server, "health_food_service", mock_svc):
            result = await server.search_health_supplement(mode="permit_no", keyword="A00022")
        parsed = json.loads(result)
        assert parsed["mode"] == "permit_no"
        assert parsed["results"][0]["permit_no"] == "衛部健食字第A00022號"
        assert "icd_code" not in parsed
        assert "recommended_benefits" not in parsed

    @pytest.mark.asyncio
    async def test_condition_includes_icd_and_benefits(self):
        payload = '{"mode":"condition","keyword":"E11","icd_code":"E11","recommended_benefits":["調節血糖"],"results":[{"permit_no":"H001","product_name":"靈芝膠囊","company":"A公司","benefits":"護肝","ingredients":[],"specs":{},"status":"approved","source_url":"https://example.com"}]}'
        mock_svc = _hf_mock()
        mock_conn = MagicMock()
        mock_conn.fetchrow = AsyncMock(return_value={
            "permit_no": "H001",
            "name": "靈芝膠囊",
            "applicant": "A公司",
            "benefit_claims": "護肝",
            "ingredients": [],
            "specs": {},
            "status": "approved",
            "source_url": "https://example.com",
        })
        mock_svc.pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_svc.pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
        with patch.object(server, "health_food_service", mock_svc):
            result = await server.search_health_supplement(mode="condition", keyword="E11")
        assert json.loads(result) == json.loads(payload)


# ── search_food_nutrition ─────────────────────────────────────────────────────

class TestSearchFoodNutrition:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "food_nutrition_service", None):
            result = json.loads(await server.search_food_nutrition(food_name="雞蛋"))
        assert "error" in result
        assert "Food Nutrition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_food_name_no_nutrient_default_limit(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_food_nutrition(food_name="白米")
        mock_svc.search_nutrition.assert_called_once_with("白米", None, limit=3)

    @pytest.mark.asyncio
    async def test_delegates_food_name_with_nutrient_default_limit(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_food_nutrition(food_name="白米", nutrient="粗蛋白")
        mock_svc.search_nutrition.assert_called_once_with("白米", "粗蛋白", limit=3)

    @pytest.mark.asyncio
    async def test_nutrient_partial_name_forwarded(self):
        """Partial nutrient names (ILIKE matching in service) are forwarded unchanged."""
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_food_nutrition(food_name="雞蛋", nutrient="蛋白")
        mock_svc.search_nutrition.assert_called_once_with("雞蛋", "蛋白", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_food_nutrition(food_name="豆腐", limit=5)
        mock_svc.search_nutrition.assert_called_once_with("豆腐", None, limit=5)


# ── get_detailed_nutrition ────────────────────────────────────────────────────

class TestGetDetailedNutrition:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "food_nutrition_service", None):
            result = json.loads(await server.get_detailed_nutrition(food_name="糙米"))
        assert "error" in result
        assert "Food Nutrition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_food_name(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.get_detailed_nutrition(food_name="雞胸肉")
        mock_svc.get_detailed_nutrition.assert_called_once_with("雞胸肉")

    @pytest.mark.asyncio
    async def test_partial_name_accepted(self):
        """ILIKE partial matching means '雞胸' can surface '雞胸肉'."""
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.get_detailed_nutrition(food_name="雞胸")
        mock_svc.get_detailed_nutrition.assert_called_once_with("雞胸")


# ── search_food_ingredient ────────────────────────────────────────────────────

class TestSearchFoodIngredient:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "food_nutrition_service", None):
            result = json.loads(await server.search_food_ingredient(keyword="薑黃"))
        assert "error" in result
        assert "Food Nutrition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_with_default_limit(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_food_ingredient(keyword="turmeric")
        mock_svc.search_food_ingredient.assert_called_once_with("turmeric", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_food_ingredient(keyword="卡拉膠", limit=6)
        mock_svc.search_food_ingredient.assert_called_once_with("卡拉膠", limit=6)


# ── get_ingredients_by_category ───────────────────────────────────────────────

class TestGetIngredientsByCategory:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "food_nutrition_service", None):
            result = json.loads(await server.get_ingredients_by_category(category="香料植物"))
        assert "error" in result
        assert "Food Nutrition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_category(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.get_ingredients_by_category(category="食品添加物")
        mock_svc.get_ingredients_by_category.assert_called_once_with("食品添加物")


# ── search_foods_by_nutrient ──────────────────────────────────────────────────

class TestSearchFoodsByNutrient:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "food_nutrition_service", None):
            result = json.loads(await server.search_foods_by_nutrient(nutrient="鈣"))
        assert "error" in result
        assert "Food Nutrition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_nutrient_and_default_limit(self):
        """Default limit is 20; results ranked by nutrient content DESC."""
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_foods_by_nutrient(nutrient="鐵")
        mock_svc.search_foods_by_nutrient.assert_called_once_with("鐵", 20)

    @pytest.mark.asyncio
    async def test_delegates_custom_limit(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_foods_by_nutrient(nutrient="粗蛋白", limit=30)
        mock_svc.search_foods_by_nutrient.assert_called_once_with("粗蛋白", 30)

    @pytest.mark.asyncio
    async def test_alias_synonym_forwarded_unchanged(self):
        """Alias resolution (蛋白質→粗蛋白) happens inside the service, not the wrapper."""
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_foods_by_nutrient(nutrient="蛋白質")
        mock_svc.search_foods_by_nutrient.assert_called_once_with("蛋白質", 20)

    @pytest.mark.asyncio
    async def test_english_nutrient_name_forwarded(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_foods_by_nutrient(nutrient="calcium")
        mock_svc.search_foods_by_nutrient.assert_called_once_with("calcium", 20)


# ── analyze_meal_nutrition ────────────────────────────────────────────────────

class TestAnalyzeMealNutrition:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "food_nutrition_service", None):
            result = json.loads(await server.analyze_meal_nutrition(foods=["白米", "雞胸肉"]))
        assert "error" in result
        assert "Food Nutrition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_food_list(self):
        mock_svc = _fn_mock()
        foods = ["白米", "雞胸肉", "青花菜"]
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.analyze_meal_nutrition(foods=foods)
        mock_svc.analyze_meal_nutrition.assert_called_once_with(foods)

    @pytest.mark.asyncio
    async def test_partial_food_names_forwarded(self):
        """ILIKE partial matching in service accepts partial names like '雞胸'."""
        mock_svc = _fn_mock()
        foods = ["白米飯", "雞胸", "豆腐"]
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.analyze_meal_nutrition(foods=foods)
        mock_svc.analyze_meal_nutrition.assert_called_once_with(foods)

    @pytest.mark.asyncio
    async def test_empty_list_still_delegates(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.analyze_meal_nutrition(foods=[])
        mock_svc.analyze_meal_nutrition.assert_called_once_with([])
