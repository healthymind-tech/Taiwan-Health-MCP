"""
Unit tests for Clinical Guideline tool functions in server.py.

Tools covered:
  search_clinical_guideline, get_complete_guideline, get_medication_recommendations,
  get_test_recommendations, get_treatment_goals, check_medication_contraindications,
  link_guideline_to_drugs, suggest_clinical_pathway
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


# ── helpers ───────────────────────────────────────────────────────────────────

def _guideline_mock():
    m = MagicMock()
    m.search_guideline                   = AsyncMock(return_value='{"guidelines":[]}')
    m.get_complete_guideline             = AsyncMock(return_value='{"guideline_info":{}}')
    m.get_medication_recommendations     = AsyncMock(return_value='{"medications":[]}')
    m.get_test_recommendations           = AsyncMock(return_value='{"tests":[]}')
    m.get_treatment_goals                = AsyncMock(return_value='{"goals":[]}')
    m.check_medication_contraindications = AsyncMock(return_value='{"matched_recommendations":[]}')
    m.link_guideline_to_drugs            = AsyncMock(return_value='{"medications":[]}')
    m.suggest_clinical_pathway           = AsyncMock(return_value='{"pathway":{}}')
    return m


# ── search_clinical_guideline ─────────────────────────────────────────────────

class TestSearchClinicalGuideline:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.search_clinical_guideline(keyword="糖尿病"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_with_default_limit(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.search_clinical_guideline(keyword="E11")
        mock_svc.search_guideline.assert_called_once_with("E11", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.search_clinical_guideline(keyword="高血壓", limit=5)
        mock_svc.search_guideline.assert_called_once_with("高血壓", limit=5)

    @pytest.mark.asyncio
    async def test_english_keyword_forwarded(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.search_clinical_guideline(keyword="dyslipidaemia")
        mock_svc.search_guideline.assert_called_once_with("dyslipidaemia", limit=3)

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"keyword":"E11","total_found":1,"guidelines":[{"icd_code":"E11"}]}'
        mock_svc = _guideline_mock()
        mock_svc.search_guideline = AsyncMock(return_value=payload)
        with patch.object(server, "guideline_service", mock_svc):
            result = await server.search_clinical_guideline(keyword="E11")
        assert result == payload


# ── get_complete_guideline ────────────────────────────────────────────────────

class TestGetCompleteGuideline:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.get_complete_guideline(icd_code="E11"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.get_complete_guideline(icd_code="I10")
        mock_svc.get_complete_guideline.assert_called_once_with("I10")


# ── get_medication_recommendations ────────────────────────────────────────────

class TestGetMedicationRecommendations:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.get_medication_recommendations(icd_code="I10"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.get_medication_recommendations(icd_code="E78")
        mock_svc.get_medication_recommendations.assert_called_once_with("E78")


# ── get_test_recommendations ──────────────────────────────────────────────────

class TestGetTestRecommendations:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.get_test_recommendations(icd_code="N18"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.get_test_recommendations(icd_code="N18")
        mock_svc.get_test_recommendations.assert_called_once_with("N18")


# ── get_treatment_goals ───────────────────────────────────────────────────────

class TestGetTreatmentGoals:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.get_treatment_goals(icd_code="E11"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.get_treatment_goals(icd_code="E11")
        mock_svc.get_treatment_goals.assert_called_once_with("E11")


# ── check_medication_contraindications ───────────────────────────────────────

class TestCheckMedicationContraindications:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(
                await server.check_medication_contraindications(icd_code="E11", medication_class="Metformin")
            )
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_both_params(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.check_medication_contraindications(
                icd_code="E11", medication_class="SGLT2抑制劑"
            )
        mock_svc.check_medication_contraindications.assert_called_once_with("E11", "SGLT2抑制劑")

    @pytest.mark.asyncio
    async def test_english_medication_class_forwarded(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.check_medication_contraindications(
                icd_code="N18", medication_class="NSAIDs"
            )
        mock_svc.check_medication_contraindications.assert_called_once_with("N18", "NSAIDs")


# ── link_guideline_to_drugs ───────────────────────────────────────────────────

class TestLinkGuidelineToDrugs:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.link_guideline_to_drugs(icd_code="E11"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.link_guideline_to_drugs(icd_code="I10")
        mock_svc.link_guideline_to_drugs.assert_called_once_with("I10")


# ── suggest_clinical_pathway ──────────────────────────────────────────────────

class TestSuggestClinicalPathway:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.suggest_clinical_pathway(icd_code="E11"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_no_context(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.suggest_clinical_pathway(icd_code="I10")
        mock_svc.suggest_clinical_pathway.assert_called_once_with("I10", None)

    @pytest.mark.asyncio
    async def test_parses_context_json(self):
        mock_svc = _guideline_mock()
        ctx = {"age": 55, "comorbidities": ["CKD"]}
        with patch.object(server, "guideline_service", mock_svc):
            await server.suggest_clinical_pathway(
                icd_code="E11", patient_context_json=json.dumps(ctx)
            )
        mock_svc.suggest_clinical_pathway.assert_called_once_with("E11", ctx)

    @pytest.mark.asyncio
    async def test_invalid_context_json_passes_none(self):
        """Bad JSON in patient_context_json is silently ignored and None is passed."""
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.suggest_clinical_pathway(
                icd_code="E11", patient_context_json="{bad json"
            )
        mock_svc.suggest_clinical_pathway.assert_called_once_with("E11", None)

    @pytest.mark.asyncio
    async def test_empty_context_json_passes_none(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.suggest_clinical_pathway(icd_code="E11", patient_context_json=None)
        mock_svc.suggest_clinical_pathway.assert_called_once_with("E11", None)

    @pytest.mark.asyncio
    async def test_full_patient_context_forwarded(self):
        mock_svc = _guideline_mock()
        ctx = {
            "age": 65, "gender": "M",
            "comorbidities": ["CKD", "心衰竭"],
            "current_medications": ["metformin"],
            "allergies": ["sulfonamides"],
        }
        with patch.object(server, "guideline_service", mock_svc):
            await server.suggest_clinical_pathway(
                icd_code="E11", patient_context_json=json.dumps(ctx)
            )
        mock_svc.suggest_clinical_pathway.assert_called_once_with("E11", ctx)
