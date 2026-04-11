"""
Unit tests for SNOMED CT tool functions in server.py.

Tools covered:
  search_snomed_concept, query_snomed_concept, get_snomed_relationships,
  query_snomed_mapping
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


# ── helpers ───────────────────────────────────────────────────────────────────

def _snomed_mock():
    m = MagicMock()
    m.search_concepts    = AsyncMock(return_value=[{"concept_id": 73211009, "preferred_term": "Diabetes mellitus"}])
    m.get_concept        = AsyncMock(return_value={"concept_id": 73211009, "fsn": "Diabetes mellitus (disorder)"})
    m.get_children       = AsyncMock(return_value=[])
    m.get_ancestors      = AsyncMock(return_value=[])
    m.get_relationships  = AsyncMock(return_value=[])
    m.map_icd_to_snomed  = AsyncMock(return_value=[])
    m.map_snomed_to_icd  = AsyncMock(return_value=[])
    return m


# ── search_snomed_concept ─────────────────────────────────────────────────────

class TestSearchSnomedConcept:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.search_snomed_concept(query="diabetes"))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_query_with_default_limit(self):
        """Default limit is 3; passed positionally as min(3, 100) = 3."""
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.search_snomed_concept(query="myocardial infarction")
        mock_svc.search_concepts.assert_called_once_with("myocardial infarction", 3, None)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.search_snomed_concept(query="diabetes", limit=7)
        mock_svc.search_concepts.assert_called_once_with("diabetes", 7, None)

    @pytest.mark.asyncio
    async def test_caps_limit_at_100(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.search_snomed_concept(query="diabetes", limit=500)
        # limit is min(500, 100) = 100
        mock_svc.search_concepts.assert_called_once_with("diabetes", 100, None)

    @pytest.mark.asyncio
    async def test_passes_hierarchy_filter(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.search_snomed_concept(
                query="diabetes", limit=5, hierarchy_filter=404684003
            )
        mock_svc.search_concepts.assert_called_once_with("diabetes", 5, 404684003)

    @pytest.mark.asyncio
    async def test_result_is_json_string(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            result = await server.search_snomed_concept(query="diabetes")
        parsed = json.loads(result)
        assert isinstance(parsed, list)
        assert parsed[0]["concept_id"] == 73211009

    @pytest.mark.asyncio
    async def test_already_json_string_returned_verbatim(self):
        """If service returns a cached JSON string, it must be passed through unchanged."""
        cached = '[{"concept_id":73211009,"preferred_term":"Diabetes mellitus"}]'
        mock_svc = _snomed_mock()
        mock_svc.search_concepts = AsyncMock(return_value=cached)
        with patch.object(server, "snomed_service", mock_svc):
            result = await server.search_snomed_concept(query="diabetes")
        assert result == cached


# ── query_snomed_concept ─────────────────────────────────────────────────────

class TestQuerySnomedConcept:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.query_snomed_concept(concept_id=73211009))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_concept_id(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.query_snomed_concept(concept_id=73211009)
        mock_svc.get_concept.assert_called_once_with(73211009)

    @pytest.mark.asyncio
    async def test_not_found_returns_error(self):
        mock_svc = _snomed_mock()
        mock_svc.get_concept = AsyncMock(return_value=None)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_concept(concept_id=99999999))
        assert "error" in result
        assert "99999999" in result["error"]

    @pytest.mark.asyncio
    async def test_found_returns_concept_data(self):
        concept = {"concept_id": 73211009, "fsn": "Diabetes mellitus (disorder)", "synonyms": []}
        mock_svc = _snomed_mock()
        mock_svc.get_concept = AsyncMock(return_value=concept)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_concept(concept_id=73211009))
        assert result["concept_id"] == 73211009
        assert result["concept"]["fsn"] == "Diabetes mellitus (disorder)"
        assert "ancestors" in result
        assert "children" in result

    @pytest.mark.asyncio
    async def test_cached_string_returned_verbatim(self):
        cached = '{"concept_id":73211009,"fsn":"Diabetes mellitus (disorder)"}'
        mock_svc = _snomed_mock()
        mock_svc.get_concept = AsyncMock(return_value=cached)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_concept(concept_id=73211009))
        assert result["concept"]["concept_id"] == 73211009


# ── query_snomed_concept variants ────────────────────────────────────────────

class TestQuerySnomedConceptVariants:
    @pytest.mark.asyncio
    async def test_children_only(self):
        children = [{"concept_id": 44054006, "fsn": "Type 2 diabetes mellitus (disorder)"}]
        mock_svc = _snomed_mock()
        mock_svc.get_concept = AsyncMock(return_value={"concept_id": 73211009})
        mock_svc.get_children = AsyncMock(return_value=children)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.query_snomed_concept(
                    concept_id=73211009, include_parents=False, include_children=True
                )
            )
        assert result["children_count"] == 1
        assert "ancestors" not in result

    @pytest.mark.asyncio
    async def test_parents_only(self):
        ancestors = [{"concept_id": 404684003, "fsn": "Clinical finding (finding)", "depth": 5}]
        mock_svc = _snomed_mock()
        mock_svc.get_concept = AsyncMock(return_value={"concept_id": 44054006})
        mock_svc.get_ancestors = AsyncMock(return_value=ancestors)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.query_snomed_concept(
                    concept_id=44054006, include_parents=True, include_children=False
                )
            )
        assert result["ancestor_count"] == 1
        assert "children" not in result


# ── get_snomed_relationships ──────────────────────────────────────────────────

class TestGetSnomedRelationships:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.get_snomed_relationships(concept_id=73211009))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_with_no_type_filter(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.get_snomed_relationships(concept_id=73211009)
        mock_svc.get_relationships.assert_called_once_with(73211009, None)

    @pytest.mark.asyncio
    async def test_delegates_with_type_filter(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.get_snomed_relationships(
                concept_id=73211009, relationship_type_id=246075003
            )
        mock_svc.get_relationships.assert_called_once_with(73211009, 246075003)

    @pytest.mark.asyncio
    async def test_response_counts_targets(self):
        rels = [
            {"relationship_type": "Finding site", "type_concept_id": 363698007,
             "targets": [{"concept_id": 113331007}, {"concept_id": 66019005}]},
            {"relationship_type": "Associated morphology", "type_concept_id": 116676008,
             "targets": [{"concept_id": 7895008}]},
        ]
        mock_svc = _snomed_mock()
        mock_svc.get_relationships = AsyncMock(return_value=rels)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.get_snomed_relationships(concept_id=73211009))
        assert result["concept_id"] == 73211009
        assert result["relationship_count"] == 3   # 2 + 1
        assert len(result["relationships"]) == 2


# ── query_snomed_mapping (ICD → SNOMED) ───────────────────────────────────────

class TestQuerySnomedMappingFromIcd:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.query_snomed_mapping(icd_code="E11.9"))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.query_snomed_mapping(icd_code="E11.9")
        mock_svc.map_icd_to_snomed.assert_called_once_with("E11.9")

    @pytest.mark.asyncio
    async def test_response_uppercases_icd_code(self):
        concepts = [{"concept_id": 44054006, "fsn": "Type 2 diabetes mellitus (disorder)"}]
        mock_svc = _snomed_mock()
        mock_svc.map_icd_to_snomed = AsyncMock(return_value=concepts)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_mapping(icd_code="e11.9"))
        assert result["icd_code"] == "E11.9"
        assert len(result["snomed_concepts"]) == 1

    @pytest.mark.asyncio
    async def test_response_wraps_in_object(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_mapping(icd_code="I10"))
        assert "icd_code" in result
        assert "snomed_concepts" in result


# ── query_snomed_mapping (SNOMED → ICD) ───────────────────────────────────────

class TestQuerySnomedMappingFromSnomed:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.query_snomed_mapping(concept_id=44054006))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_concept_id(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.query_snomed_mapping(concept_id=44054006)
        mock_svc.map_snomed_to_icd.assert_called_once_with(44054006)

    @pytest.mark.asyncio
    async def test_response_structure(self):
        mappings = [{"icd10_code": "E11.9", "map_rule": "TRUE"}]
        mock_svc = _snomed_mock()
        mock_svc.map_snomed_to_icd = AsyncMock(return_value=mappings)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_mapping(concept_id=44054006))
        assert result["concept_id"] == 44054006
        assert len(result["icd10_mappings"]) == 1
        assert result["icd10_mappings"][0]["icd10_code"] == "E11.9"
