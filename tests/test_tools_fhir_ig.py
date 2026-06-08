"""
Tests for the Phase 1 FHIR IG toolset:
  - FHIRIGService methods (envelope shape, provenance, default-IG resolution,
    snapshot views, ranker) driven by a seeded fake pool.
  - server.py fhir_* tool wrappers (null-guard + delegation).
"""

import json
from unittest.mock import AsyncMock, patch

import pytest

import fhir_ig_service
import server

# ── seed data ────────────────────────────────────────────────────────────────

_PKG = {
    "package_id": "tw.gov.mohw.twcore",
    "version": "1.0.0",
    "canonical": "https://twcore.mohw.gov.tw/ig/twcore",
    "fhir_version": "4.0.1",
    "title": "TW Core",
    "status": "active",
    "is_default": True,
    "dependencies": {"hl7.fhir.r4.core": "4.0.1"},
    "imported_at": 0,
}

_CONDITION_SD = {
    "resourceType": "StructureDefinition",
    "type": "Condition",
    "baseDefinition": "http://hl7.org/fhir/StructureDefinition/Condition",
    "snapshot": {
        "element": [
            {"path": "Condition", "min": 0, "max": "*"},
            {
                "path": "Condition.code",
                "min": 0,
                "max": "1",
                "type": [{"code": "CodeableConcept"}],
                "binding": {
                    "strength": "example",
                    "valueSet": "http://hl7.org/fhir/ValueSet/condition-code",
                },
            },
            {
                "path": "Condition.onset[x]",
                "min": 0,
                "max": "1",
                "type": [{"code": "dateTime"}, {"code": "Period"}],
            },
            {
                "path": "Condition.subject",
                "min": 1,
                "max": "1",
                "type": [{"code": "Reference"}],
            },
        ]
    },
}

_ARTIFACT = {
    "package_id": "tw.gov.mohw.twcore",
    "package_version": "1.0.0",
    "artifact_key": "StructureDefinition/Condition-twcore",
    "resource_type": "StructureDefinition",
    "artifact_id": "Condition-twcore",
    "canonical_url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Condition-twcore",
    "name": "ConditionTwcore",
    "title": "Condition TWCore",
    "status": "active",
    "kind": "resource",
    "base_type": "Condition",
    "derivation": "constraint",
    "grouping_id": "profiles",
    "grouping_name": "Profiles",
    "child_count": 4,
    "concept_count": 0,
    "raw_json": json.dumps(_CONDITION_SD),
}


class _ServicePool:
    """Fake asyncpg pool answering the FHIRIGService + fhir_ig queries."""

    def __init__(self, packages, artifacts):
        self.packages = packages
        self.artifacts = artifacts

    @staticmethod
    def _n(sql):
        return " ".join(sql.split())

    async def fetchval(self, sql, *a):
        if "COUNT(*) FROM fhir.ig_packages" in self._n(sql):
            return len(self.packages)
        raise AssertionError(sql)

    async def fetchrow(self, sql, *a):
        s = self._n(sql)
        if "ORDER BY is_default DESC, imported_at DESC" in s:
            return dict(self.packages[0]) if self.packages else None
        if (
            "SELECT package_id, version FROM fhir.ig_packages" in s
            and "version = $2" in s
        ):
            for p in self.packages:
                if p["package_id"] == a[0] and p["version"] == a[1]:
                    return {"package_id": p["package_id"], "version": p["version"]}
            return None
        if "SELECT package_id, version, canonical" in s and "version = $2" in s:
            for p in self.packages:
                if p["package_id"] == a[0] and p["version"] == a[1]:
                    return dict(p)
            return None
        if "FROM fhir.artifacts" in s and "artifact_id = $3" in s:
            for art in self.artifacts:
                if (
                    art["package_id"] == a[0]
                    and art["package_version"] == a[1]
                    and (
                        art["artifact_id"] == a[2]
                        or art["canonical_url"] == a[2]
                        or art["artifact_key"] == a[2]
                    )
                ):
                    return dict(art)
            return None
        if "FROM fhir.artifacts" in s and "canonical_url = $3" in s:
            # resolve_canonical fallback (no artifact_id branch)
            for art in self.artifacts:
                if (
                    art["package_id"] == a[0]
                    and art["package_version"] == a[1]
                    and (art["canonical_url"] == a[2])
                ):
                    return dict(art)
            return None
        if "SELECT dependencies FROM fhir.ig_packages" in s:
            return {"dependencies": {}}
        raise AssertionError(s)

    async def fetch(self, sql, *a):
        s = self._n(sql)
        if "ORDER BY is_default DESC, package_id, version" in s:
            return [dict(p) for p in self.packages]
        if "GROUP BY resource_type" in s:
            return [{"resource_type": "StructureDefinition", "n": len(self.artifacts)}]
        if "derivation = 'constraint'" in s and "raw_json" in s:
            return [dict(art) for art in self.artifacts]
        if "derivation = 'constraint'" in s:
            return [
                {
                    "artifact_id": art["artifact_id"],
                    "canonical_url": art["canonical_url"],
                    "name": art["name"],
                    "title": art["title"],
                    "base_type": art["base_type"],
                    "status": art["status"],
                }
                for art in self.artifacts
            ]
        if "grouping_id = 'examples'" in s:
            return []
        raise AssertionError(s)


def _svc():
    return fhir_ig_service.FHIRIGService(_ServicePool([dict(_PKG)], [dict(_ARTIFACT)]))


# ── service-level tests ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_igs_envelope():
    out = json.loads(await _svc().list_igs())
    assert out["ok"] is True
    assert out["data"]["count"] == 1
    ig = out["data"]["igs"][0]
    assert ig["packageId"] == "tw.gov.mohw.twcore" and ig["isDefault"] is True


@pytest.mark.asyncio
async def test_get_ig_default_resolution_and_provenance():
    out = json.loads(await _svc().get_ig())  # no package_id → default
    assert out["ok"] is True
    assert out["provenance"] == {
        "packageId": "tw.gov.mohw.twcore",
        "version": "1.0.0",
        "fhirVersion": "4.0.1",
        "source": "ig",
    }
    assert out["data"]["artifactCounts"]["StructureDefinition"] == 1


@pytest.mark.asyncio
async def test_list_resource_profiles_grouped_by_base_type():
    out = json.loads(await _svc().list_resource_profiles())
    assert out["ok"] is True
    assert "Condition" in out["data"]["byResourceType"]
    assert (
        out["data"]["byResourceType"]["Condition"][0]["profile"] == "Condition-twcore"
    )


@pytest.mark.asyncio
async def test_rank_profiles_scores_and_requires_selection():
    out = json.loads(
        await _svc().rank_resource_profiles(keys=["code", "subject", "bogus"])
    )
    assert out["ok"] is True
    assert out["data"]["selectionRequired"] is True
    top = out["data"]["candidates"][0]
    assert top["profile"] == "Condition-twcore"
    assert set(top["matchedKeys"]) == {"code", "subject"}  # 'bogus' not in snapshot


@pytest.mark.asyncio
async def test_profile_elements_view_choices():
    out = json.loads(
        await _svc().get_profile_elements(
            profile="Condition-twcore", view="choices", path="Condition.onset[x]"
        )
    )
    assert out["ok"] is True
    props = [c["jsonProperty"] for c in out["data"]["result"]["choices"]]
    assert props == ["onsetDateTime", "onsetPeriod"]


@pytest.mark.asyncio
async def test_profile_elements_view_binding():
    out = json.loads(
        await _svc().get_profile_elements(
            profile="Condition-twcore", view="binding", path="Condition.code"
        )
    )
    assert out["data"]["result"]["binding"]["strength"] == "example"


@pytest.mark.asyncio
async def test_profile_elements_path_required():
    out = json.loads(
        await _svc().get_profile_elements(profile="Condition-twcore", view="binding")
    )
    assert out["ok"] is False and out["error"]["code"] == "INVALID_ARGUMENT"


@pytest.mark.asyncio
async def test_profile_not_found():
    out = json.loads(await _svc().get_profile_elements(profile="Nope", view="elements"))
    assert out["ok"] is False and out["error"]["code"] == "ARTIFACT_NOT_FOUND"


@pytest.mark.asyncio
async def test_ig_not_found_when_registry_empty():
    svc = fhir_ig_service.FHIRIGService(_ServicePool([], []))
    out = json.loads(await svc.get_ig())
    assert out["ok"] is False and out["error"]["code"] == "IG_NOT_FOUND"


# ── server-tool wrappers (null-guard + delegation) ───────────────────────────


@pytest.mark.asyncio
async def test_tool_null_guard():
    with patch.object(server, "fhir_ig_service", None):
        out = json.loads(await server.fhir_list_igs())
    assert "error" in out


@pytest.mark.asyncio
async def test_tool_delegates_to_service():
    mock = AsyncMock()
    mock.get_profile_elements = AsyncMock(return_value='{"ok":true}')
    with patch.object(server, "fhir_ig_service", mock), patch.object(
        server, "_ig_maintenance_active", AsyncMock(return_value=False)
    ):
        await server.fhir_get_profile_elements(
            profile="Condition-twcore", view="choices", path="Condition.onset[x]"
        )
    mock.get_profile_elements.assert_awaited_once()
    kwargs = mock.get_profile_elements.await_args.kwargs
    assert kwargs["profile"] == "Condition-twcore" and kwargs["view"] == "choices"


# ── reference / bundle tools (Phase 3, IG-agnostic) ──────────────────────────


@pytest.mark.asyncio
async def test_resolve_reference_stable_and_context():
    with patch.object(
        server, "_ig_maintenance_active", AsyncMock(return_value=False)
    ):
        first = json.loads(
            await server.fhir_resolve_reference(
                key="patient-1", resource_type="Patient"
            )
        )
        cid = first["data"]["contextId"]
        again = json.loads(
            await server.fhir_resolve_reference(key="patient-1", context_id=cid)
        )
    assert first["ok"] and first["data"]["reference"].startswith("urn:uuid:")
    assert again["data"]["reference"] == first["data"]["reference"]


@pytest.mark.asyncio
async def test_build_bundle_tool_assembles_and_flags_unresolved():
    entries = [
        {"key": "pat", "resource": {"resourceType": "Patient"}},
        {
            "key": "cond",
            "resource": {
                "resourceType": "Condition",
                "subject": {"reference": "Patient/pat"},
                "asserter": {"reference": "urn:uuid:missing"},
            },
        },
    ]
    with patch.object(
        server, "_ig_maintenance_active", AsyncMock(return_value=False)
    ):
        out = json.loads(await server.fhir_build_bundle(entries=entries))
    assert out["ok"] and out["data"]["bundle"]["type"] == "transaction"
    cond = out["data"]["bundle"]["entry"][1]["resource"]
    assert cond["subject"]["reference"] == out["data"]["referenceMap"]["pat"]
    assert any(u["reference"] == "urn:uuid:missing" for u in out["data"]["unresolved"])


@pytest.mark.asyncio
async def test_build_bundle_tool_rejects_empty():
    with patch.object(
        server, "_ig_maintenance_active", AsyncMock(return_value=False)
    ):
        out = json.loads(await server.fhir_build_bundle(entries=[]))
    assert out["ok"] is False and out["error"]["code"] == "INVALID_ARGUMENT"
