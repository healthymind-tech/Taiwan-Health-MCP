"""
Tests for Phase 5 schema-guided fill:
  - fhir_authoring pure pinning helpers (set_at_path / ensure_meta_profile /
    pin_fixed_pattern).
  - FHIRIGService.get_resource_skeleton / finalize_resource via a seeded fake pool.
"""

import json

import pytest

import fhir_authoring as fa
import fhir_ig_service
import fhir_reference

# ── pure pinning helpers ─────────────────────────────────────────────────────


def test_ensure_meta_profile_idempotent():
    r = {"resourceType": "Condition"}
    assert fa.ensure_meta_profile(r, "http://c") is True
    assert r["meta"]["profile"] == ["http://c"]
    assert fa.ensure_meta_profile(r, "http://c") is False  # already present


def test_set_at_path_existing_missing_array():
    r = {"resourceType": "X", "obj": {}, "arr": [{"a": 1}]}
    assert fa.set_at_path(r, "obj.system", "http://s") == "set"
    assert r["obj"]["system"] == "http://s"
    assert fa.set_at_path(r, "obj.system", "other") == "exists"  # no overwrite
    assert fa.set_at_path(r, "missing.deep", "v") == "skipped-missing"
    assert fa.set_at_path(r, "arr.system", "v") == "skipped-array"


def test_pin_fixed_pattern_sets_and_merges():
    sd = {
        "type": "Condition",
        "snapshot": {
            "element": [
                {"path": "Condition"},
                {"path": "Condition.recordedDate", "fixedDateTime": "2026-01-01"},
                {
                    "path": "Condition.clinicalStatus",
                    "patternCodeableConcept": {"text": "pinned"},
                },
                {"path": "Condition.deep.system", "fixedUri": "http://u"},
            ]
        },
    }
    r = {
        "resourceType": "Condition",
        "clinicalStatus": {"coding": [{"code": "active"}]},
    }
    trace = fa.pin_fixed_pattern(sd, r)
    assert r["recordedDate"] == "2026-01-01"  # fixed set
    assert r["clinicalStatus"]["text"] == "pinned"  # pattern merged (missing key)
    assert r["clinicalStatus"]["coding"] == [{"code": "active"}]  # existing untouched
    actions = {t["path"]: t["action"] for t in trace}
    assert actions["Condition.recordedDate"] == "set"
    assert actions["Condition.deep.system"] == "skipped-missing"  # no fabrication


# ── slice-aware pinning ──────────────────────────────────────────────────────

_SLICE_SD = {
    "type": "Patient",
    "url": "http://ig/SD/Patient-x",
    "snapshot": {
        "element": [
            {"id": "Patient", "path": "Patient"},
            {
                "id": "Patient.identifier",
                "path": "Patient.identifier",
                "min": 1,
                "max": "*",
                "slicing": {"discriminator": [{"type": "value", "path": "system"}]},
            },
            {
                "id": "Patient.identifier:nid",
                "path": "Patient.identifier",
                "sliceName": "nid",
                "min": 0,
                "max": "1",
            },
            {
                "id": "Patient.identifier:nid.system",
                "path": "Patient.identifier.system",
                "min": 1,
                "max": "1",
                "patternUri": "http://moi",
            },
            {
                "id": "Patient.identifier:nid.type",
                "path": "Patient.identifier.type",
                "min": 1,
                "max": "1",
            },
            {
                "id": "Patient.identifier:nid.type.coding",
                "path": "Patient.identifier.type.coding",
                "min": 1,
                "max": "*",
            },
            {
                "id": "Patient.identifier:nid.type.coding.system",
                "path": "Patient.identifier.type.coding.system",
                "min": 1,
                "max": "1",
                "patternUri": "http://v2-0203",
            },
            {
                "id": "Patient.identifier:nid.type.coding.code",
                "path": "Patient.identifier.type.coding.code",
                "min": 1,
                "max": "1",
                "patternCode": "NNxxx",
            },
            {
                "id": "Patient.identifier:nid.value",
                "path": "Patient.identifier.value",
                "min": 1,
                "max": "1",
            },
        ]
    },
}


def test_pin_slices_assembles_and_fills():
    res = {"resourceType": "Patient", "identifier": [{"value": "L1", "_slice": "nid"}]}
    trace = fa.pin_slices(_SLICE_SD, res)
    ident = res["identifier"][0]
    assert "_slice" not in ident  # tag stripped
    assert ident["value"] == "L1"  # LLM value kept
    assert ident["system"] == "http://moi"  # slice fixed pinned
    assert ident["type"]["coding"][0]["system"] == "http://v2-0203"  # nested array
    assert ident["type"]["coding"][0]["code"] == "NNxxx"
    assert trace[0]["action"] == "pinned"
    assert set(trace[0]["fields"]) == {"system", "type"}


def test_pin_slices_unknown_slice_strips_tag():
    res = {
        "resourceType": "Patient",
        "identifier": [{"value": "L1", "_slice": "bogus"}],
    }
    trace = fa.pin_slices(_SLICE_SD, res)
    assert "_slice" not in res["identifier"][0]  # never leaks
    assert "system" not in res["identifier"][0]  # nothing pinned
    assert trace[0]["action"] == "unknown-slice"


def test_pin_slices_keeps_llm_supplied_coding():
    res = {
        "resourceType": "Patient",
        "identifier": [
            {
                "value": "L1",
                "_slice": "nid",
                "type": {"coding": [{"code": "OVERRIDE"}]},
            }
        ],
    }
    fa.pin_slices(_SLICE_SD, res)
    coding = res["identifier"][0]["type"]["coding"][0]
    assert coding["code"] == "OVERRIDE"  # existing value wins
    assert coding["system"] == "http://v2-0203"  # missing key filled


# ── service-level (fake pool) ────────────────────────────────────────────────

PKG = {"package_id": "p", "version": "1", "fhir_version": "4.0.1"}
CANON = "http://ig/StructureDefinition/Condition-twcore"

_SD = {
    "resourceType": "StructureDefinition",
    "type": "Condition",
    "url": CANON,
    "snapshot": {
        "element": [
            {"path": "Condition"},
            {
                "path": "Condition.clinicalStatus",
                "min": 1,
                "max": "1",
                "mustSupport": True,
                "type": [{"code": "CodeableConcept"}],
                "binding": {
                    "strength": "required",
                    "valueSet": "http://ig/ValueSet/stat",
                },
            },
            {
                "path": "Condition.category",
                "min": 1,
                "max": "1",
                "type": [{"code": "CodeableConcept"}],
                "binding": {
                    "strength": "required",
                    "valueSet": "http://ig/ValueSet/cat",
                },
            },
            {
                "path": "Condition.recordedDate",
                "min": 0,
                "max": "1",
                "fixedDateTime": "2026-01-01",
            },
            {
                "path": "Condition.subject",
                "min": 1,
                "max": "1",
                "type": [{"code": "Reference"}],
            },
            {
                "path": "Condition.onset[x]",
                "min": 0,
                "max": "1",
                "type": [{"code": "dateTime"}, {"code": "Period"}],
            },
        ]
    },
}
_VS_STAT = {
    "resourceType": "ValueSet",
    "url": "http://ig/ValueSet/stat",
    "compose": {
        "include": [
            {
                "system": "http://stat",
                "concept": [{"code": "active"}, {"code": "inactive"}],
            }
        ]
    },
}
_VS_CAT = {
    "resourceType": "ValueSet",
    "url": "http://ig/ValueSet/cat",
    "compose": {
        "include": [
            {"system": "http://cat", "concept": [{"code": "encounter-diagnosis"}]}
        ]
    },
}
_ARTIFACTS = {
    "Condition-twcore": ("StructureDefinition", _SD),
    "http://ig/ValueSet/stat": ("ValueSet", _VS_STAT),
    "http://ig/ValueSet/cat": ("ValueSet", _VS_CAT),
}


class _Pool:
    @staticmethod
    def _n(s):
        return " ".join(s.split())

    async def fetchval(self, sql, *a):
        return 1

    async def fetch(self, sql, *a):
        return []  # examples + any group queries → empty

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
            hit = _ARTIFACTS.get(a[2])
            if hit:
                rtype, raw = hit
                return {
                    "resource_type": rtype,
                    "artifact_id": a[2],
                    "canonical_url": raw.get("url"),
                    "raw_json": json.dumps(raw),
                }
            return None
        if "FROM fhir.artifacts" in s and "canonical_url = $3" in s:
            return None
        return None


def _svc():
    return fhir_ig_service.FHIRIGService(_Pool())


@pytest.mark.asyncio
async def test_skeleton_lists_fields_with_candidates_and_autopin():
    out = json.loads(await _svc().get_resource_skeleton("Condition-twcore"))
    assert out["ok"]
    by_path = {f["path"]: f for f in out["data"]["fields"]}
    # required bound element with candidate codes
    cat = by_path["Condition.category"]
    assert cat["required"] is True
    assert any(
        c["code"] == "encounter-diagnosis" for c in cat["binding"]["candidateCodes"]
    )
    # fixed element flagged auto-pinned
    assert by_path["Condition.recordedDate"]["autoPinned"]["value"] == "2026-01-01"
    # choice element exposes JSON properties
    assert "onsetDateTime" in by_path["Condition.onset[x]"]["choices"]


@pytest.mark.asyncio
async def test_finalize_pins_infers_and_validates_valid():
    cid, pat_urn = fhir_reference.mint(None, "pat")
    draft = {
        "resourceType": "Condition",
        "clinicalStatus": {"coding": [{"code": "active"}]},  # no system → inferred
        "category": [
            {"coding": [{"system": "http://cat", "code": "encounter-diagnosis"}]}
        ],
        "subject": {"reference": "Patient/pat"},  # key ref → urn
    }
    out = json.loads(
        await _svc().finalize_resource(
            "Condition-twcore", draft, context_id=cid, key="cond-1"
        )
    )
    assert out["ok"]
    res = out["data"]["resource"]
    assert CANON in res["meta"]["profile"]  # meta.profile pinned
    assert res["recordedDate"] == "2026-01-01"  # fixed pinned
    assert res["clinicalStatus"]["coding"][0]["system"] == "http://stat"  # inferred
    assert res["subject"]["reference"] == pat_urn  # reference rewritten
    assert out["data"]["validation"]["valid"] is True
    assert out["data"]["reference"].startswith("urn:uuid:")  # this resource registered


@pytest.mark.asyncio
async def test_finalize_reports_validation_errors_without_looping():
    draft = {
        "resourceType": "Condition",
        "clinicalStatus": {"coding": [{"system": "http://stat", "code": "active"}]},
        # category missing → required error
        "subject": {"reference": "Patient/x"},
    }
    out = json.loads(await _svc().finalize_resource("Condition-twcore", draft))
    assert out["ok"]  # the tool ran
    assert out["data"]["validation"]["valid"] is False
    assert any(
        i["code"] == "required" and "category" in i["path"]
        for i in out["data"]["validation"]["issues"]
    )
