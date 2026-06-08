"""
Unit tests for the Phase 3 reference-context store + Bundle assembly
(src/fhir_reference.py) — pure, no DB.
"""

import fhir_reference as fr


def setup_function(_):
    fr._CONTEXTS.clear()


# ── mint / context ───────────────────────────────────────────────────────────


def test_mint_is_stable_per_key():
    cid, urn1 = fr.mint(None, "patient-1")
    _, urn2 = fr.mint(cid, "patient-1")
    assert urn1 == urn2
    assert urn1.startswith("urn:uuid:")


def test_mint_different_keys_differ():
    cid, a = fr.mint(None, "a")
    _, b = fr.mint(cid, "b")
    assert a != b


def test_contexts_are_isolated():
    c1, u1 = fr.mint(None, "k")
    c2, u2 = fr.mint(None, "k")
    assert c1 != c2 and u1 != u2


def test_new_context_and_get_map():
    cid = fr.new_context()
    fr.mint(cid, "x")
    assert set(fr.get_map(cid).keys()) == {"x"}
    assert fr.get_map("nope") == {}


def test_ttl_sweep_evicts_stale():
    cid = fr.new_context()
    fr._CONTEXTS[cid]["touched_at"] = fr._now() - (fr._CONTEXT_TTL_SECONDS + 10)
    fr.new_context()  # triggers a sweep
    assert cid not in fr._CONTEXTS


# ── build_bundle ─────────────────────────────────────────────────────────────


def test_build_bundle_assigns_fullurls_and_default_request():
    out = fr.build_bundle(
        [
            {"key": "patient-1", "resource": {"resourceType": "Patient"}},
            {"fullUrl": "urn:uuid:fixed", "resource": {"resourceType": "Encounter"}},
            {"resource": {"resourceType": "Observation"}},
        ],
        bundle_type="transaction",
    )
    entries = out["bundle"]["entry"]
    assert out["bundle"]["resourceType"] == "Bundle"
    assert entries[0]["fullUrl"].startswith("urn:uuid:")
    assert entries[1]["fullUrl"] == "urn:uuid:fixed"
    # transaction → default POST request added
    assert entries[0]["request"] == {"method": "POST", "url": "Patient"}
    assert out["referenceMap"]["patient-1"] == entries[0]["fullUrl"]


def test_build_bundle_rewrites_key_reference():
    out = fr.build_bundle(
        [
            {"key": "pat", "resource": {"resourceType": "Patient"}},
            {
                "key": "cond",
                "resource": {
                    "resourceType": "Condition",
                    "subject": {"reference": "Patient/pat"},
                },
            },
        ]
    )
    pat_urn = out["referenceMap"]["pat"]
    cond = out["bundle"]["entry"][1]["resource"]
    assert cond["subject"]["reference"] == pat_urn
    assert out["unresolved"] == []


def test_build_bundle_reports_unresolved_urn():
    out = fr.build_bundle(
        [
            {
                "key": "cond",
                "resource": {
                    "resourceType": "Condition",
                    "subject": {"reference": "urn:uuid:does-not-exist"},
                },
            }
        ]
    )
    assert out["unresolved"] == [
        {"resourceType": "Condition", "reference": "urn:uuid:does-not-exist"}
    ]


def test_build_bundle_existing_urn_reference_resolves():
    cid, pat_urn = fr.mint(None, "pat")
    out = fr.build_bundle(
        [
            {"key": "pat", "resource": {"resourceType": "Patient"}},
            {
                "resource": {
                    "resourceType": "Condition",
                    "subject": {"reference": pat_urn},
                }
            },
        ],
        context_id=cid,
    )
    # pat entry fullUrl equals the pre-minted urn → the urn reference resolves
    assert out["bundle"]["entry"][0]["fullUrl"] == pat_urn
    assert out["unresolved"] == []
