"""
Unit tests for SNOMED CT tool functions in server.py.

Tools covered:
  search_snomed_concept, get_snomed_concept, get_snomed_children,
  get_snomed_ancestors, get_snomed_relationships,
  map_icd_to_snomed, map_snomed_to_icd
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
    async def test_delegates_query_and_default_limit(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.search_snomed_concept(query="myocardial infarction")
        mock_svc.search_concepts.assert_called_once_with("myocardial infarction", 20, None)

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
                query="diabetes", limit=10, hierarchy_filter=404684003
            )
        mock_svc.search_concepts.assert_called_once_with("diabetes", 10, 404684003)

    @pytest.mark.asyncio
    async def test_result_is_json_string(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            result = await server.search_snomed_concept(query="diabetes")
        parsed = json.loads(result)
        assert isinstance(parsed, list)
        assert parsed[0]["concept_id"] == 73211009


# ── get_snomed_concept ────────────────────────────────────────────────────────

class TestGetSnomedConcept:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.get_snomed_concept(concept_id=73211009))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_concept_id(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.get_snomed_concept(concept_id=73211009)
        mock_svc.get_concept.assert_called_once_with(73211009)

    @pytest.mark.asyncio
    async def test_not_found_returns_error(self):
        mock_svc = _snomed_mock()
        mock_svc.get_concept = AsyncMock(return_value=None)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.get_snomed_concept(concept_id=99999999))
        assert "error" in result
        assert "99999999" in result["error"]

    @pytest.mark.asyncio
    async def test_found_returns_concept_data(self):
        concept = {"concept_id": 73211009, "fsn": "Diabetes mellitus (disorder)", "synonyms": []}
        mock_svc = _snomed_mock()
        mock_svc.get_concept = AsyncMock(return_value=concept)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.get_snomed_concept(concept_id=73211009))
        assert result["concept_id"] == 73211009
        assert result["fsn"] == "Diabetes mellitus (disorder)"


# ── get_snomed_children ───────────────────────────────────────────────────────

class TestGetSnomedChildren:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.get_snomed_children(concept_id=73211009))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_with_default_limit(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.get_snomed_children(concept_id=73211009)
        mock_svc.get_children.assert_called_once_with(73211009, 50)

    @pytest.mark.asyncio
    async def test_caps_limit_at_200(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.get_snomed_children(concept_id=73211009, limit=999)
        mock_svc.get_children.assert_called_once_with(73211009, 200)

    @pytest.mark.asyncio
    async def test_response_structure(self):
        children = [{"concept_id": 44054006, "fsn": "Type 2 diabetes mellitus (disorder)"}]
        mock_svc = _snomed_mock()
        mock_svc.get_children = AsyncMock(return_value=children)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.get_snomed_children(concept_id=73211009))
        assert result["concept_id"] == 73211009
        assert result["children_count"] == 1
        assert len(result["children"]) == 1


# ── get_snomed_ancestors ──────────────────────────────────────────────────────

class TestGetSnomedAncestors:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.get_snomed_ancestors(concept_id=44054006))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_with_default_depth(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.get_snomed_ancestors(concept_id=44054006)
        mock_svc.get_ancestors.assert_called_once_with(44054006, 10)

    @pytest.mark.asyncio
    async def test_caps_max_depth_at_20(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.get_snomed_ancestors(concept_id=44054006, max_depth=100)
        mock_svc.get_ancestors.assert_called_once_with(44054006, 20)

    @pytest.mark.asyncio
    async def test_response_structure(self):
        ancestors = [
            {"concept_id": 73211009, "fsn": "Diabetes mellitus (disorder)", "depth": 1},
            {"concept_id": 404684003, "fsn": "Clinical finding (finding)", "depth": 5},
        ]
        mock_svc = _snomed_mock()
        mock_svc.get_ancestors = AsyncMock(return_value=ancestors)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.get_snomed_ancestors(concept_id=44054006))
        assert result["concept_id"] == 44054006
        assert result["ancestor_count"] == 2
        assert result["ancestors"][0]["depth"] == 1


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


# ── map_icd_to_snomed ─────────────────────────────────────────────────────────

class TestMapIcdToSnomed:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.map_icd_to_snomed(icd_code="E11.9"))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.map_icd_to_snomed(icd_code="E11.9")
        mock_svc.map_icd_to_snomed.assert_called_once_with("E11.9")

    @pytest.mark.asyncio
    async def test_response_wraps_in_object(self):
        concepts = [{"concept_id": 44054006, "fsn": "Type 2 diabetes mellitus (disorder)"}]
        mock_svc = _snomed_mock()
        mock_svc.map_icd_to_snomed = AsyncMock(return_value=concepts)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.map_icd_to_snomed(icd_code="e11.9"))
        # Tool uppercases the code in the response
        assert result["icd_code"] == "E11.9"
        assert len(result["snomed_concepts"]) == 1


# ── map_snomed_to_icd ─────────────────────────────────────────────────────────

class TestMapSnomedToIcd:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.map_snomed_to_icd(concept_id=44054006))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_concept_id(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.map_snomed_to_icd(concept_id=44054006)
        mock_svc.map_snomed_to_icd.assert_called_once_with(44054006)

    @pytest.mark.asyncio
    async def test_response_structure(self):
        mappings = [{"icd10_code": "E11.9", "map_rule": "TRUE"}]
        mock_svc = _snomed_mock()
        mock_svc.map_snomed_to_icd = AsyncMock(return_value=mappings)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.map_snomed_to_icd(concept_id=44054006))
        assert result["concept_id"] == 44054006
        assert len(result["icd10_mappings"]) == 1
        assert result["icd10_mappings"][0]["icd10_code"] == "E11.9"
