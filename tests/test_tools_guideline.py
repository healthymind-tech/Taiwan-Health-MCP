"""
Unit tests for Clinical Guideline tool functions in server.py.

Tools covered:
  search_clinical_guideline, query_guideline
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


# ── query_guideline (complete) ───────────────────────────────────────────────

class TestQueryGuidelineComplete:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.query_guideline(icd_code="E11", section="complete"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.query_guideline(icd_code="I10", section="complete")
        mock_svc.get_complete_guideline.assert_called_once_with("I10")


# ── query_guideline (medication) ─────────────────────────────────────────────

class TestQueryGuidelineMedication:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.query_guideline(icd_code="I10", section="medication"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.query_guideline(icd_code="E78", section="medication")
        mock_svc.get_medication_recommendations.assert_called_once_with("E78")


# ── query_guideline (test) ───────────────────────────────────────────────────

class TestQueryGuidelineTest:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.query_guideline(icd_code="N18", section="test"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.query_guideline(icd_code="N18", section="test")
        mock_svc.get_test_recommendations.assert_called_once_with("N18")


# ── query_guideline (goals) ──────────────────────────────────────────────────

class TestQueryGuidelineGoals:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.query_guideline(icd_code="E11", section="goals"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.query_guideline(icd_code="E11", section="goals")
        mock_svc.get_treatment_goals.assert_called_once_with("E11")


# ── query_guideline (pathway) ────────────────────────────────────────────────

class TestQueryGuidelinePathway:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "guideline_service", None):
            result = json.loads(await server.query_guideline(icd_code="E11", section="pathway"))
        assert "error" in result
        assert "Clinical Guideline Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_without_context(self):
        """No patient_context_json → suggest_clinical_pathway called with None."""
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.query_guideline(icd_code="E11", section="pathway")
        mock_svc.suggest_clinical_pathway.assert_called_once_with("E11", None)

    @pytest.mark.asyncio
    async def test_delegates_with_valid_context(self):
        """Valid patient_context_json is parsed and forwarded as a dict."""
        mock_svc = _guideline_mock()
        ctx = {"age": 65, "comorbidities": ["CKD"]}
        with patch.object(server, "guideline_service", mock_svc):
            await server.query_guideline(
                icd_code="E11",
                section="pathway",
                patient_context_json=json.dumps(ctx),
            )
        mock_svc.suggest_clinical_pathway.assert_called_once_with("E11", ctx)

    @pytest.mark.asyncio
    async def test_invalid_context_json_returns_error(self):
        """Malformed patient_context_json returns an error without calling the service."""
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            result = json.loads(
                await server.query_guideline(
                    icd_code="E11",
                    section="pathway",
                    patient_context_json="not valid json",
                )
            )
        assert "error" in result
        mock_svc.suggest_clinical_pathway.assert_not_called()

    @pytest.mark.asyncio
    async def test_context_ignored_for_non_pathway_sections(self):
        """patient_context_json is silently ignored for non-pathway sections."""
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            await server.query_guideline(
                icd_code="E11",
                section="medication",
                patient_context_json='{"age": 65}',
            )
        mock_svc.get_medication_recommendations.assert_called_once_with("E11")
        mock_svc.suggest_clinical_pathway.assert_not_called()


# ── query_guideline (unknown section) ────────────────────────────────────────

class TestQueryGuidelineUnknownSection:
    @pytest.mark.asyncio
    async def test_unknown_section_returns_error(self):
        mock_svc = _guideline_mock()
        with patch.object(server, "guideline_service", mock_svc):
            result = json.loads(
                await server.query_guideline(icd_code="E11", section="nonexistent")  # type: ignore[arg-type]
            )
        assert "error" in result


# ── search_clinical_guideline (not-found + fuzzy) ────────────────────────────

class TestSearchClinicalGuidelineNotFoundAndFuzzy:
    @pytest.mark.asyncio
    async def test_not_found_returns_empty_results(self):
        mock_svc = _guideline_mock()
        mock_svc.search_guideline = AsyncMock(
            return_value='{"keyword":"水晶療法","total_found":0,"guidelines":[]}'
        )
        with patch.object(server, "guideline_service", mock_svc):
            result = json.loads(
                await server.search_clinical_guideline(keyword="水晶療法")
            )
        assert result["total_found"] == 0
        assert result["guidelines"] == []

    @pytest.mark.asyncio
    async def test_fuzzy_keyword_forwarded_to_service(self):
        """Embedding search: vague term forwarded; service returns semantically close guideline."""
        payload = '{"keyword":"sugar disease management","total_found":1,"guidelines":[{"icd_code":"E11"}]}'
        mock_svc = _guideline_mock()
        mock_svc.search_guideline = AsyncMock(return_value=payload)
        with patch.object(server, "guideline_service", mock_svc):
            result = json.loads(
                await server.search_clinical_guideline(keyword="sugar disease management")
            )
        mock_svc.search_guideline.assert_called_once_with("sugar disease management", limit=3)
        assert result["guidelines"][0]["icd_code"] == "E11"


# ── query_guideline (not-found per section) ───────────────────────────────────

class TestQueryGuidelineNotFound:
    @pytest.mark.asyncio
    async def test_complete_not_found(self):
        mock_svc = _guideline_mock()
        mock_svc.get_complete_guideline = AsyncMock(
            return_value='{"error":"No guideline found for Z00.00"}'
        )
        with patch.object(server, "guideline_service", mock_svc):
            result = json.loads(
                await server.query_guideline(icd_code="Z00.00", section="complete")
            )
        assert "error" in result

    @pytest.mark.asyncio
    async def test_medication_not_found(self):
        mock_svc = _guideline_mock()
        mock_svc.get_medication_recommendations = AsyncMock(
            return_value='{"error":"No medication guideline for Z00.00"}'
        )
        with patch.object(server, "guideline_service", mock_svc):
            result = json.loads(
                await server.query_guideline(icd_code="Z00.00", section="medication")
            )
        assert "error" in result

    @pytest.mark.asyncio
    async def test_pathway_not_found(self):
        mock_svc = _guideline_mock()
        mock_svc.suggest_clinical_pathway = AsyncMock(
            return_value='{"error":"No pathway for Z00.00"}'
        )
        with patch.object(server, "guideline_service", mock_svc):
            result = json.loads(
                await server.query_guideline(icd_code="Z00.00", section="pathway")
            )
        assert "error" in result
