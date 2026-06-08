"""
Unit tests for the StructureDefinition snapshot projector (src/fhir_snapshot.py),
driven off the real Condition-twcore profile in the TWCore package.tgz plus a few
synthetic edge cases (slicing / fixed / pattern).
"""

import json
import os
import tarfile

import pytest

import fhir_snapshot

TGZ = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "fhir-code",
    "twcoreig",
    "v1.0.0",
    "package.tgz",
)
_HAVE_TGZ = os.path.exists(TGZ)
_skip_no_tgz = pytest.mark.skipif(
    not _HAVE_TGZ, reason="TWCore package.tgz not present"
)


def _load_condition_sd() -> dict:
    with tarfile.open(TGZ, "r:gz") as tf:
        f = tf.extractfile("package/StructureDefinition-Condition-twcore.json")
        return json.loads(f.read().decode("utf-8"))


# ── real-profile projections ─────────────────────────────────────────────────


@_skip_no_tgz
def test_project_elements_counts_full_snapshot():
    sd = _load_condition_sd()
    els = fhir_snapshot.project_elements(sd)
    assert len(els) == 47
    assert all("path" in e and "min" in e and "types" in e for e in els)


@_skip_no_tgz
def test_choices_resolves_onset_x_properties():
    sd = _load_condition_sd()
    choices = fhir_snapshot.get_choices(sd, "Condition.onset[x]")
    props = [c["jsonProperty"] for c in choices["choices"]]
    assert props == [
        "onsetDateTime",
        "onsetAge",
        "onsetPeriod",
        "onsetRange",
        "onsetString",
    ]


@_skip_no_tgz
def test_binding_on_condition_code():
    sd = _load_condition_sd()
    b = fhir_snapshot.get_binding(sd, "Condition.code")
    assert b["binding"]["strength"] == "example"
    assert b["binding"]["valueSet"].endswith("condition-code")


@_skip_no_tgz
def test_element_by_path_required_subject_reference():
    sd = _load_condition_sd()
    el = fhir_snapshot.get_element(sd, "Condition.subject")
    assert el["min"] == 1 and el["max"] == "1"
    assert el["types"][0]["code"] == "Reference"
    assert el["types"][0].get("targetProfile")  # Patient-twcore / Group


@_skip_no_tgz
def test_required_binding_clinical_status():
    sd = _load_condition_sd()
    el = fhir_snapshot.get_element(sd, "Condition.clinicalStatus")
    assert el["binding"]["strength"] == "required"


# ── synthetic edge cases ─────────────────────────────────────────────────────


def _sd(elements):
    return {"resourceType": "StructureDefinition", "snapshot": {"element": elements}}


def test_fixed_and_pattern_detected():
    sd = _sd(
        [
            {"path": "X.a", "fixedUri": "http://sys", "min": 1, "max": "1"},
            {
                "path": "X.b",
                "patternCodeableConcept": {"coding": [{"code": "z"}]},
                "min": 0,
                "max": "1",
            },
        ]
    )
    a = fhir_snapshot.get_element(sd, "X.a")
    b = fhir_snapshot.get_element(sd, "X.b")
    assert a["fixed"] == {"field": "fixedUri", "value": "http://sys"}
    assert b["pattern"]["field"] == "patternCodeableConcept"


def test_slices_returns_rules_and_named_slices():
    sd = _sd(
        [
            {
                "path": "X.identifier",
                "slicing": {
                    "rules": "open",
                    "discriminator": [{"type": "value", "path": "system"}],
                },
                "min": 0,
                "max": "*",
            },
            {"path": "X.identifier", "sliceName": "mrn", "min": 1, "max": "1"},
            {"path": "X.identifier", "sliceName": "nid", "min": 0, "max": "1"},
        ]
    )
    out = fhir_snapshot.get_slices(sd, "X.identifier")
    assert out["slicing"]["rules"] == "open"
    assert {s["sliceName"] for s in out["slices"]} == {"mrn", "nid"}


def test_missing_path_returns_none():
    sd = _sd([{"path": "X.a", "min": 0, "max": "1"}])
    assert fhir_snapshot.get_element(sd, "X.nope") is None
    assert fhir_snapshot.get_choices(sd, "X.nope") is None
    assert fhir_snapshot.get_slices(sd, "X.a") is None  # no slicing on X.a
