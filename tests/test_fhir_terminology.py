"""
Tests for the Phase 2 terminology layer:
  - fhir_terminology.route_system / expand_compose (tiered resolver, pure helpers)
  - FHIRIGService terminology methods (get/expand/lookup/validate/normalize) via a
    seeded fake pool — embeddings absent (fail-open path).
"""

import json

import pytest

import fhir_ig_service
import fhir_terminology as ft

SNOMED = ft.SNOMED_SYSTEM
PKG = {"package_id": "p", "version": "1", "fhir_version": "4.0.1"}


# ── route_system ─────────────────────────────────────────────────────────────


def test_route_system_mapping():
    assert ft.route_system(SNOMED) == "snomed"
    assert ft.route_system("http://loinc.org") == "loinc"
    assert ft.route_system("https://x/CodeSystem/icd-10-cm-2023-tw") == "icd_dx"
    assert ft.route_system("https://x/CodeSystem/icd-10-pcs-2023-tw") == "icd_pcs"
    assert ft.route_system("https://twcore/CodeSystem/marital-status-tw") == "ig"
    assert ft.route_system("http://dicom.nema.org/resources/ontology/DCM") == "external"


# ── expand_compose ───────────────────────────────────────────────────────────


class _ExpandPool:
    def __init__(self, tree, terms, ig_concepts, valuesets):
        self.tree = tree
        self.terms = terms
        self.ig_concepts = ig_concepts
        self.valuesets = valuesets

    @staticmethod
    def _n(s):
        return " ".join(s.split())

    async def fetch(self, sql, *a):
        s = self._n(sql)
        if "WITH RECURSIVE descendants" in s:
            ids = self.tree.get(str(a[0]), [])
            return [{"concept_id": i} for i in ids[: a[2]]]
        if "DISTINCT ON (concept_id) concept_id, term" in s:
            return [
                {"concept_id": i, "term": self.terms[i]}
                for i in a[0]
                if i in self.terms
            ]
        if "c.code, c.display FROM fhir.concepts" in s:  # closure whole-system
            return [
                {"code": c, "display": d} for c, d in self.ig_concepts.get(a[2], [])
            ]
        raise AssertionError(s)

    async def fetchrow(self, sql, *a):
        s = self._n(sql)
        if "FROM fhir.artifacts" in s and "resource_type = 'ValueSet'" in s:
            vs = self.valuesets.get(a[2]) or self.valuesets.get(a[3])
            return {"raw_json": json.dumps(vs)} if vs else None
        if "c.display, c.definition FROM fhir.concepts" in s:  # closure lookup
            for code, disp in self.ig_concepts.get(a[2], []):
                if code == a[3]:
                    return {"display": disp, "definition": None}
            return None
        raise AssertionError(s)


@pytest.mark.asyncio
async def test_expand_compose_tiers():
    compose = {
        "include": [
            {
                "system": "http://x",
                "concept": [{"code": "a", "display": "A"}, {"code": "b"}],
            },
            {
                "system": SNOMED,
                "filter": [{"op": "is-a", "property": "concept", "value": "100"}],
            },
            {"system": "https://ig/CodeSystem/cs1"},
            {"valueSet": ["vsB"]},
            {"system": "http://loinc.org"},
        ],
        "exclude": [{"system": "http://x", "concept": [{"code": "a"}]}],
    }
    pool = _ExpandPool(
        tree={"100": [100, 101, 102]},
        terms={100: "T100", 101: "T101", 102: "T102"},
        ig_concepts={"cs1": [("c1", "C1")]},
        valuesets={
            "vsB": {
                "resourceType": "ValueSet",
                "compose": {
                    "include": [
                        {
                            "system": "http://y",
                            "concept": [{"code": "y1", "display": "Y1"}],
                        }
                    ]
                },
            }
        },
    )
    exp = await ft.expand_compose(pool, compose, PKG, limit=500)
    codes = {(c["system"], c["code"]) for c in exp["codings"]}
    # 'a' excluded; 'b' inline (no display); snomed descendants; ig system; import VS
    assert ("http://x", "a") not in codes
    assert ("http://x", "b") in codes
    assert ("http://snomed.info/sct", "101") in codes
    assert ("https://ig/CodeSystem/cs1", "c1") in codes
    assert ("http://y", "y1") in codes
    # whole LOINC system → TOO_BROAD, not enumerated
    assert any(u.get("reason") == "TOO_BROAD" for u in exp["unresolved"])
    assert any("TOO_BROAD" in w for w in exp["warnings"])


@pytest.mark.asyncio
async def test_expand_whole_system_external_but_held_in_dependency():
    """A base-FHIR CodeSystem URL routes as 'external' (no '/CodeSystem/'), but its
    concepts are held in a dependency package — must enumerate, not TOO_BROAD."""
    assert ft.route_system("http://hl7.org/fhir/administrative-gender") == "external"
    compose = {"include": [{"system": "http://hl7.org/fhir/administrative-gender"}]}
    pool = _ExpandPool(
        tree={},
        terms={},
        ig_concepts={"administrative-gender": [("male", "Male"), ("female", "Female")]},
        valuesets={},
    )
    pkg = {
        "package_id": "tw.gov.mohw.twcore",
        "version": "1.0.0",
        "_closure": [("tw.gov.mohw.twcore", "1.0.0"), ("hl7.fhir.r4.core", "4.0.1")],
    }
    exp = await ft.expand_compose(pool, compose, pkg, limit=500)
    assert {c["code"] for c in exp["codings"]} == {"male", "female"}
    assert not any(u.get("reason") == "TOO_BROAD" for u in exp["unresolved"])


@pytest.mark.asyncio
async def test_expand_compose_truncates_with_cap():
    compose = {
        "include": [
            {
                "system": SNOMED,
                "filter": [{"op": "is-a", "property": "concept", "value": "1"}],
            }
        ]
    }
    pool = _ExpandPool(
        tree={"1": [1, 2, 3, 4, 5]},
        terms={i: f"T{i}" for i in range(1, 6)},
        ig_concepts={},
        valuesets={},
    )
    exp = await ft.expand_compose(pool, compose, PKG, limit=3)
    assert exp["total"] == 3
    assert exp["truncated"] is True


# ── service-level terminology (fake pool, embeddings absent) ─────────────────

_VS = {
    "resourceType": "ValueSet",
    "id": "vs-test",
    "url": "https://ig/ValueSet/vs-test",
    "compose": {
        "include": [
            {"system": SNOMED, "concept": [{"code": "6142004", "display": "Influenza"}]}
        ]
    },
}
_CM = {
    "resourceType": "ConceptMap",
    "id": "cm1",
    "group": [
        {
            "source": "https://ig/CodeSystem/dx",
            "target": SNOMED,
            "element": [
                {
                    "code": "1",
                    "display": "流行性感冒",
                    "target": [{"code": "6142004", "display": "Influenza"}],
                }
            ],
        }
    ],
}


class _SvcPool:
    @staticmethod
    def _n(s):
        return " ".join(s.split())

    async def fetchval(self, sql, *a):
        return 1

    async def fetch(self, sql, *a):
        s = self._n(sql)
        if "resource_type = 'ConceptMap'" in s:
            return [{"raw_json": json.dumps(_CM)}]
        if "term ILIKE" in s:  # lexical snomed — English terms, no Chinese hit
            return []
        return []

    async def fetchrow(self, sql, *a):
        s = self._n(sql)
        if "ORDER BY is_default DESC, imported_at DESC" in s:
            return {"package_id": "p", "version": "1"}
        if "SELECT package_id, version, canonical" in s and "version = $2" in s:
            return dict(PKG)
        if (
            "SELECT package_id, version FROM fhir.ig_packages" in s
            and "version = $2" in s
        ):
            return {"package_id": "p", "version": "1"}
        if "FROM fhir.artifacts" in s and "artifact_id = $3" in s:
            if a[2] in ("vs-test", _VS["url"]):
                return {"resource_type": "ValueSet", "raw_json": json.dumps(_VS)}
            return None
        if "FROM fhir.artifacts" in s and "canonical_url = $3" in s:
            return None
        if "SELECT term FROM snomed.descriptions" in s:
            return {"term": "Influenza"} if str(a[0]) == "6142004" else None
        return None


def _svc():
    return fhir_ig_service.FHIRIGService(_SvcPool())  # embedding_svc=None


@pytest.mark.asyncio
async def test_get_valueset():
    out = json.loads(await _svc().get_valueset("vs-test"))
    assert out["ok"] and out["data"]["compose"]["include"][0]["system"] == SNOMED


@pytest.mark.asyncio
async def test_expand_valueset_inline():
    out = json.loads(await _svc().expand_valueset("vs-test"))
    assert out["ok"]
    assert {c["code"] for c in out["data"]["codings"]} == {"6142004"}


@pytest.mark.asyncio
async def test_lookup_code_snomed_and_missing():
    found = json.loads(await _svc().lookup_code(SNOMED, "6142004"))
    assert found["data"]["found"] is True and found["data"]["display"] == "Influenza"
    missing = json.loads(await _svc().lookup_code("http://external", "z"))
    assert missing["data"]["found"] is False and missing["data"]["display"] is None


@pytest.mark.asyncio
async def test_validate_code_member_and_invalid():
    ok = json.loads(await _svc().validate_code(SNOMED, "6142004", "vs-test"))
    assert ok["data"]["result"] == "valid" and ok["data"]["valid"] is True
    bad = json.loads(await _svc().validate_code(SNOMED, "999", "vs-test"))
    assert bad["data"]["result"] == "invalid" and bad["data"]["valid"] is False


@pytest.mark.asyncio
async def test_normalize_code_conceptmap_failopen():
    out = json.loads(
        await _svc().normalize_code(text="流行性感冒", value_set="vs-test")
    )
    assert out["ok"]
    codes = {(c["code"], c["source"]) for c in out["data"]["candidates"]}
    assert ("6142004", "conceptmap") in codes
    # embeddings absent → a warning, but still returns candidates (fail-open)
    assert any("semantic" in w for w in out["warnings"])


@pytest.mark.asyncio
async def test_normalize_requires_target():
    out = json.loads(await _svc().normalize_code(text="x"))
    assert out["ok"] is False and out["error"]["code"] == "INVALID_ARGUMENT"
