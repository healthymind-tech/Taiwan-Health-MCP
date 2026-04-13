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
    async def test_caps_limit_at_10(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.search_snomed_concept(query="diabetes", limit=500)
        # limit is min(500, 10) = 10
        mock_svc.search_concepts.assert_called_once_with("diabetes", 10, None)

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
            result = json.loads(await server.query_snomed_mapping(mode="icd", keyword="E11.9"))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_icd_code(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.query_snomed_mapping(mode="icd", keyword="E11.9")
        mock_svc.map_icd_to_snomed.assert_called_once_with("E11.9")

    @pytest.mark.asyncio
    async def test_response_uppercases_icd_code(self):
        concepts = [{"concept_id": 44054006, "fsn": "Type 2 diabetes mellitus (disorder)"}]
        mock_svc = _snomed_mock()
        mock_svc.map_icd_to_snomed = AsyncMock(return_value=concepts)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_mapping(mode="icd", keyword="e11.9"))
        assert result["mode"] == "icd"
        assert result["keyword"] == "E11.9"
        assert len(result["snomed_concepts"]) == 1

    @pytest.mark.asyncio
    async def test_response_wraps_in_object(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_mapping(mode="icd", keyword="I10"))
        assert result["mode"] == "icd"
        assert "snomed_concepts" in result


# ── query_snomed_mapping (SNOMED → ICD) ───────────────────────────────────────

class TestQuerySnomedMappingFromSnomed:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "snomed_service", None):
            result = json.loads(await server.query_snomed_mapping(mode="snomed", keyword="44054006"))
        assert "error" in result
        assert "SNOMED CT" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_concept_id(self):
        mock_svc = _snomed_mock()
        with patch.object(server, "snomed_service", mock_svc):
            await server.query_snomed_mapping(mode="snomed", keyword="44054006")
        mock_svc.map_snomed_to_icd.assert_called_once_with(44054006)

    @pytest.mark.asyncio
    async def test_searches_when_keyword_is_text(self):
        mock_svc = _snomed_mock()
        mock_svc.search_concepts = AsyncMock(
            return_value=[{"concept_id": 44054006, "preferred_term": "Diabetes mellitus"}]
        )
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_mapping(mode="snomed", keyword="diabetes"))
        assert result["mode"] == "snomed"
        assert result["keyword"] == 44054006
        mock_svc.search_concepts.assert_called_once_with("diabetes", 1)
        mock_svc.map_snomed_to_icd.assert_called_once_with(44054006)

    @pytest.mark.asyncio
    async def test_response_structure(self):
        mappings = [{"icd10_code": "E11.9", "map_rule": "TRUE"}]
        mock_svc = _snomed_mock()
        mock_svc.map_snomed_to_icd = AsyncMock(return_value=mappings)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(await server.query_snomed_mapping(mode="snomed", keyword="44054006"))
        assert result["mode"] == "snomed"
        assert result["keyword"] == 44054006
        assert len(result["icd10_mappings"]) == 1
        assert result["icd10_mappings"][0]["icd10_code"] == "E11.9"


# ── search_snomed_concept (not-found + fuzzy) ────────────────────────────────

class TestSearchSnomedConceptNotFoundAndFuzzy:
    @pytest.mark.asyncio
    async def test_not_found_returns_empty_list(self):
        mock_svc = _snomed_mock()
        mock_svc.search_concepts = AsyncMock(return_value=[])
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.search_snomed_concept(query="永恆青春綜合症")
            )
        assert result == []

    @pytest.mark.asyncio
    async def test_fuzzy_term_forwarded_returns_semantic_match(self):
        """Embedding search: vague term forwarded; service returns semantically close concept."""
        concepts = [{"concept_id": 73211009, "preferred_term": "Diabetes mellitus"}]
        mock_svc = _snomed_mock()
        mock_svc.search_concepts = AsyncMock(return_value=concepts)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.search_snomed_concept(query="blood sugar disorder")
            )
        mock_svc.search_concepts.assert_called_once_with("blood sugar disorder", 3, None)
        assert result[0]["concept_id"] == 73211009

    @pytest.mark.asyncio
    async def test_hierarchy_filter_with_not_found(self):
        """Hierarchy filter restricts search scope; empty when no match in subtree."""
        mock_svc = _snomed_mock()
        mock_svc.search_concepts = AsyncMock(return_value=[])
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.search_snomed_concept(
                    query="diabetes", limit=5, hierarchy_filter=71388002
                )
            )
        mock_svc.search_concepts.assert_called_once_with("diabetes", 5, 71388002)
        assert result == []


# ── get_snomed_relationships (not-found) ─────────────────────────────────────

class TestGetSnomedRelationshipsNotFound:
    @pytest.mark.asyncio
    async def test_invalid_concept_returns_empty_relationships(self):
        mock_svc = _snomed_mock()
        mock_svc.get_relationships = AsyncMock(return_value=[])
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.get_snomed_relationships(concept_id=123456789012)
            )
        assert result["concept_id"] == 123456789012
        assert result["relationship_count"] == 0
        assert result["relationships"] == []


# ── query_snomed_mapping (not-found per mode) ─────────────────────────────────

class TestQuerySnomedMappingNotFound:
    @pytest.mark.asyncio
    async def test_icd_not_found_returns_empty_concepts(self):
        mock_svc = _snomed_mock()
        mock_svc.map_icd_to_snomed = AsyncMock(return_value=[])
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.query_snomed_mapping(mode="icd", keyword="ZZZ.999")
            )
        assert result["mode"] == "icd"
        assert result["snomed_concepts"] == []

    @pytest.mark.asyncio
    async def test_snomed_numeric_not_found_returns_empty_icd(self):
        mock_svc = _snomed_mock()
        mock_svc.map_snomed_to_icd = AsyncMock(return_value=[])
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.query_snomed_mapping(mode="snomed", keyword="99999999999")
            )
        assert result["mode"] == "snomed"
        assert result["icd10_mappings"] == []

    @pytest.mark.asyncio
    async def test_snomed_text_no_concept_match_returns_error(self):
        """Text keyword with no semantic match from search_concepts returns error."""
        mock_svc = _snomed_mock()
        mock_svc.search_concepts = AsyncMock(return_value=[])
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.query_snomed_mapping(mode="snomed", keyword="永恆青春綜合症")
            )
        assert "error" in result
        mock_svc.map_snomed_to_icd.assert_not_called()

    @pytest.mark.asyncio
    async def test_snomed_fuzzy_text_finds_semantic_match(self):
        """Embedding search: vague text forwarded; service finds concept and maps to ICD."""
        concepts = [{"concept_id": 44054006, "preferred_term": "Type 2 diabetes mellitus"}]
        mappings = [{"icd10_code": "E11.9", "map_rule": "TRUE"}]
        mock_svc = _snomed_mock()
        mock_svc.search_concepts = AsyncMock(return_value=concepts)
        mock_svc.map_snomed_to_icd = AsyncMock(return_value=mappings)
        with patch.object(server, "snomed_service", mock_svc):
            result = json.loads(
                await server.query_snomed_mapping(mode="snomed", keyword="adult onset diabetes")
            )
        mock_svc.search_concepts.assert_called_once_with("adult onset diabetes", 1)
        assert result["keyword"] == 44054006
        assert result["icd10_mappings"][0]["icd10_code"] == "E11.9"
