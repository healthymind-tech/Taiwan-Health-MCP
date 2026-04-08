"""
Unit tests for Health Food + Food Nutrition tool functions in server.py.

Tools covered:
  search_health_food, get_health_food_details,
  search_food_nutrition, get_detailed_nutrition, search_food_ingredient,
  get_ingredients_by_category, search_foods_by_nutrient, analyze_meal_nutrition,
  analyze_health_support_for_condition
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


# ── helpers ───────────────────────────────────────────────────────────────────

def _hf_mock():
    m = MagicMock()
    m.search_health_food               = AsyncMock(return_value='{"results":[]}')
    m.get_health_food_details          = AsyncMock(return_value='{"permit_no":"H001"}')
    m.analyze_health_support_for_condition = AsyncMock(return_value='{"health_foods":[]}')
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


# ── search_health_food ────────────────────────────────────────────────────────

class TestSearchHealthFood:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "health_food_service", None):
            result = json.loads(await server.search_health_food(keyword="靈芝"))
        assert "error" in result
        assert "Health Food Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword(self):
        mock_svc = _hf_mock()
        with patch.object(server, "health_food_service", mock_svc):
            await server.search_health_food(keyword="護肝")
        mock_svc.search_health_food.assert_called_once_with("護肝")

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"results":[{"product_name":"靈芝膠囊"}]}'
        mock_svc = _hf_mock()
        mock_svc.search_health_food = AsyncMock(return_value=payload)
        with patch.object(server, "health_food_service", mock_svc):
            result = await server.search_health_food(keyword="靈芝")
        assert result == payload


# ── get_health_food_details ───────────────────────────────────────────────────

class TestGetHealthFoodDetails:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "health_food_service", None):
            result = json.loads(await server.get_health_food_details(permit_no="衛部健食字第A00001號"))
        assert "error" in result
        assert "Health Food Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_permit_no(self):
        mock_svc = _hf_mock()
        with patch.object(server, "health_food_service", mock_svc):
            await server.get_health_food_details(permit_no="衛部健食字第A00001號")
        mock_svc.get_health_food_details.assert_called_once_with("衛部健食字第A00001號")


# ── search_food_nutrition ─────────────────────────────────────────────────────

class TestSearchFoodNutrition:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "food_nutrition_service", None):
            result = json.loads(await server.search_food_nutrition(food_name="雞蛋"))
        assert "error" in result
        assert "Food Nutrition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_food_name_no_nutrient(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_food_nutrition(food_name="白米")
        mock_svc.search_nutrition.assert_called_once_with("白米", None)

    @pytest.mark.asyncio
    async def test_delegates_food_name_with_nutrient(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_food_nutrition(food_name="白米", nutrient="粗蛋白")
        mock_svc.search_nutrition.assert_called_once_with("白米", "粗蛋白")


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


# ── search_food_ingredient ────────────────────────────────────────────────────

class TestSearchFoodIngredient:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "food_nutrition_service", None):
            result = json.loads(await server.search_food_ingredient(keyword="薑黃"))
        assert "error" in result
        assert "Food Nutrition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.search_food_ingredient(keyword="turmeric")
        mock_svc.search_food_ingredient.assert_called_once_with("turmeric")


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
    async def test_empty_list_still_delegates(self):
        mock_svc = _fn_mock()
        with patch.object(server, "food_nutrition_service", mock_svc):
            await server.analyze_meal_nutrition(foods=[])
        mock_svc.analyze_meal_nutrition.assert_called_once_with([])


# ── analyze_health_support_for_condition ─────────────────────────────────────

class TestAnalyzeHealthSupportForCondition:
    @pytest.mark.asyncio
    async def test_null_guard_health_food_none(self):
        with patch.object(server, "health_food_service", None):
            result = json.loads(
                await server.analyze_health_support_for_condition(diagnosis_keyword="E11")
            )
        assert "error" in result
        assert "Health Food Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_with_icd_service(self):
        mock_hf = _hf_mock()
        mock_icd = MagicMock()
        with patch.object(server, "health_food_service", mock_hf), \
             patch.object(server, "icd_service", mock_icd):
            await server.analyze_health_support_for_condition(diagnosis_keyword="糖尿病")
        mock_hf.analyze_health_support_for_condition.assert_called_once_with(
            "糖尿病", icd_service=mock_icd
        )

    @pytest.mark.asyncio
    async def test_passes_none_icd_service_when_unavailable(self):
        """ICD service may be None; tool still calls health food service."""
        mock_hf = _hf_mock()
        with patch.object(server, "health_food_service", mock_hf), \
             patch.object(server, "icd_service", None):
            await server.analyze_health_support_for_condition(diagnosis_keyword="I10")
        mock_hf.analyze_health_support_for_condition.assert_called_once_with(
            "I10", icd_service=None
        )
