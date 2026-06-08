"""
Tests for the Phase 4 in-process validator:
  - fhir_validator pure checks (structure / slicing / FHIRPath invariants via the
    real fhirpathpy) over synthetic StructureDefinitions.
  - FHIRIGService.validate_resource / validate_bundle (binding membership + bundle
    reference integrity) via a seeded fake pool.
"""

import json

import pytest

import fhir_ig_service
import fhir_validator as fv


def _sd(elements, rtype="Condition"):
    return {
        "resourceType": "StructureDefinition",
        "type": rtype,
        "snapshot": {"element": elements},
    }


# ── structure ────────────────────────────────────────────────────────────────


def test_missing_required_is_error():
    sd = _sd(
        [
            {"path": "Condition"},
            {"path": "Condition.category", "min": 1, "max": "1"},
        ]
    )
    issues = fv.validate_structure(sd, {"resourceType": "Condition"})
    assert any(
        i["code"] == "required" and i["path"] == "Condition.category" for i in issues
    )
    assert fv.is_valid(issues) is False


def test_cardinality_max_violation():
    sd = _sd([{"path": "Condition"}, {"path": "Condition.note", "min": 0, "max": "1"}])
    res = {"resourceType": "Condition", "note": [{"text": "a"}, {"text": "b"}]}
    issues = fv.validate_structure(sd, res)
    assert any(i["code"] == "cardinality" for i in issues)


def test_slice_child_required_not_enforced_as_base():
    """A slice's required/fixed child (id carries ':sliceName') must not be applied
    as a base constraint to every array entry."""
    sd = _sd(
        [
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
        ],
        rtype="Patient",
    )
    res = {"resourceType": "Patient", "identifier": [{"value": "L1"}]}
    issues = fv.validate_structure(sd, res) + fv.validate_slicing(sd, res)
    assert not [i for i in issues if i["severity"] == "error"]


def test_nested_required_skipped_when_parent_absent():
    """A required nested element applies only within an existing parent context."""
    sd = _sd(
        [
            {"id": "Patient", "path": "Patient"},
            {"id": "Patient.contact", "path": "Patient.contact", "min": 0, "max": "*"},
            {
                "id": "Patient.contact.name",
                "path": "Patient.contact.name",
                "min": 1,
                "max": "1",
            },
        ],
        rtype="Patient",
    )
    # parent absent → child not applicable
    no_contact = fv.validate_structure(sd, {"resourceType": "Patient"})
    assert not [i for i in no_contact if i["severity"] == "error"]
    # parent present but required child missing → error
    res = {"resourceType": "Patient", "contact": [{"telecom": [{"value": "x"}]}]}
    issues = fv.validate_structure(sd, res)
    assert any(
        i["code"] == "required" and i["path"] == "Patient.contact.name" for i in issues
    )


def test_choice_only_one_allowed():
    sd = _sd(
        [{"path": "Condition"}, {"path": "Condition.onset[x]", "min": 0, "max": "1"}]
    )
    res = {
        "resourceType": "Condition",
        "onsetDateTime": "2026-01-01",
        "onsetString": "x",
    }
    issues = fv.validate_structure(sd, res)
    assert any(i["code"] == "choice" for i in issues)


def test_fixed_and_pattern_mismatch():
    sd = _sd(
        [
            {"path": "Condition"},
            {
                "path": "Condition.recordedDate",
                "min": 0,
                "max": "1",
                "fixedDateTime": "2026-01-01",
            },
        ]
    )
    bad = fv.validate_structure(
        sd, {"resourceType": "Condition", "recordedDate": "2000-01-01"}
    )
    assert any(i["code"] == "fixed" for i in bad)
    good = fv.validate_structure(
        sd, {"resourceType": "Condition", "recordedDate": "2026-01-01"}
    )
    assert all(i["code"] != "fixed" for i in good)


# ── slicing (value discriminator) ────────────────────────────────────────────


def test_value_slice_min_cardinality():
    sd = _sd(
        [
            {"path": "Patient"},
            {
                "path": "Patient.identifier",
                "min": 0,
                "max": "*",
                "slicing": {
                    "discriminator": [{"type": "value", "path": "system"}],
                    "rules": "open",
                },
            },
            {"path": "Patient.identifier", "sliceName": "nid", "min": 1, "max": "1"},
            {
                "id": "Patient.identifier:nid.system",
                "path": "Patient.identifier.system",
                "sliceName": "nid",
                "fixedUri": "http://nid",
            },
        ],
        rtype="Patient",
    )
    # no identifier with system http://nid → slice 'nid' min 1 violated
    miss = fv.validate_slicing(
        sd,
        {
            "resourceType": "Patient",
            "identifier": [{"system": "http://other", "value": "x"}],
        },
    )
    assert any(i["code"] == "slice-cardinality" for i in miss)
    # present → satisfied
    ok = fv.validate_slicing(
        sd,
        {
            "resourceType": "Patient",
            "identifier": [{"system": "http://nid", "value": "x"}],
        },
    )
    assert all(i["code"] != "slice-cardinality" for i in ok)


# ── invariants (real fhirpathpy) ─────────────────────────────────────────────


def test_invariant_pass_and_fail():
    sd = _sd(
        [
            {
                "path": "Condition",
                "constraint": [
                    {
                        "key": "c1",
                        "severity": "error",
                        "expression": "code.exists()",
                        "human": "code required",
                    }
                ],
            }
        ]
    )
    fail = fv.evaluate_invariants(sd, {"resourceType": "Condition"})
    assert any(i["code"] == "c1" and i["severity"] == "error" for i in fail)
    ok = fv.evaluate_invariants(
        sd, {"resourceType": "Condition", "code": {"text": "x"}}
    )
    assert all(i["code"] != "c1" for i in ok)


def test_unsupported_invariant_degrades_to_information():
    sd = _sd(
        [
            {
                "path": "Condition",
                "constraint": [
                    {
                        "key": "ele-1",
                        "severity": "error",
                        "expression": "hasValue()",
                        "human": "h",
                    }
                ],
            }
        ]
    )
    issues = fv.evaluate_invariants(sd, {"resourceType": "Condition"})
    # fhirpathpy does not implement hasValue → information, NOT a false error
    assert any(
        i["code"] == "invariant-unevaluated" and i["severity"] == "information"
        for i in issues
    )
    assert all(i["severity"] != "error" for i in issues)


# ── service-level (fake pool) ────────────────────────────────────────────────

PKG = {"package_id": "p", "version": "1", "fhir_version": "4.0.1"}

_SD_COND = {
    "resourceType": "StructureDefinition",
    "type": "Condition",
    "snapshot": {
        "element": [
            {"path": "Condition"},
            {
                "path": "Condition.category",
                "min": 1,
                "max": "1",
                "type": [{"code": "CodeableConcept"}],
                "binding": {
                    "strength": "required",
                    "valueSet": "http://x/ValueSet/cat",
                },
            },
        ]
    },
}
_VS_CAT = {
    "resourceType": "ValueSet",
    "url": "http://x/ValueSet/cat",
    "compose": {
        "include": [
            {
                "system": "http://x",
                "concept": [
                    {"code": "encounter-diagnosis"},
                    {"code": "problem-list-item"},
                ],
            }
        ]
    },
}


class _VPool:
    @staticmethod
    def _n(s):
        return " ".join(s.split())

    async def fetchval(self, sql, *a):
        return 1

    async def fetch(self, sql, *a):
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
            ident = a[2]
            if ident == "Condition-twcore":
                return {
                    "resource_type": "StructureDefinition",
                    "artifact_id": "Condition-twcore",
                    "raw_json": json.dumps(_SD_COND),
                }
            if ident == "http://x/ValueSet/cat":
                return {
                    "resource_type": "ValueSet",
                    "artifact_id": "cat",
                    "raw_json": json.dumps(_VS_CAT),
                }
            return None
        if "FROM fhir.artifacts" in s and "canonical_url = $3" in s:
            return None
        return None


def _svc():
    return fhir_ig_service.FHIRIGService(_VPool())


@pytest.mark.asyncio
async def test_validate_resource_valid():
    res = {
        "resourceType": "Condition",
        "category": [
            {"coding": [{"system": "http://x", "code": "encounter-diagnosis"}]}
        ],
    }
    out = json.loads(await _svc().validate_resource(res, profile="Condition-twcore"))
    assert out["ok"] and out["data"]["valid"] is True
    assert out["data"]["source"] == "builtin"


@pytest.mark.asyncio
async def test_validate_resource_missing_required():
    out = json.loads(
        await _svc().validate_resource(
            {"resourceType": "Condition"}, profile="Condition-twcore"
        )
    )
    assert out["data"]["valid"] is False
    assert any(i["code"] == "required" for i in out["data"]["issues"])


@pytest.mark.asyncio
async def test_validate_resource_binding_non_member_is_error():
    res = {
        "resourceType": "Condition",
        "category": [{"coding": [{"system": "http://x", "code": "not-in-vs"}]}],
    }
    out = json.loads(await _svc().validate_resource(res, profile="Condition-twcore"))
    assert out["data"]["valid"] is False
    assert any(i["code"] == "binding" for i in out["data"]["issues"])


@pytest.mark.asyncio
async def test_validate_bundle_reference_integrity():
    bundle = {
        "resourceType": "Bundle",
        "type": "transaction",
        "entry": [
            {"fullUrl": "urn:uuid:pat", "resource": {"resourceType": "Patient"}},
            {
                "fullUrl": "urn:uuid:cond",
                "resource": {
                    "resourceType": "Condition",
                    "subject": {"reference": "urn:uuid:pat"},
                    "asserter": {"reference": "urn:uuid:ghost"},
                },
            },
        ],
    }
    out = json.loads(await _svc().validate_bundle(bundle))
    refs = {r["reference"] for r in out["data"]["referenceIssues"]}
    assert "urn:uuid:ghost" in refs and "urn:uuid:pat" not in refs
    assert out["data"]["valid"] is False
