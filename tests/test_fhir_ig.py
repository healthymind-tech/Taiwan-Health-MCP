"""
Unit tests for the Phase 0 multi-IG foundation:
  - admin_jobs._parse_ig_package_identity / _build_twcore_stage_payload
    (package identity parsing + package-scoped stage payloads)
  - fhir_ig.resolve_package / resolve_canonical / list_packages
    (IG selector + dependency-walking canonical resolver)
"""

import os

import pytest

import admin_jobs
import fhir_ig

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


# ── package identity parsing ─────────────────────────────────────────────────


@_skip_no_tgz
def test_parse_ig_package_identity_from_real_tgz():
    ident = admin_jobs._parse_ig_package_identity(TGZ)
    assert ident["package_id"] == "tw.gov.mohw.twcore"
    assert ident["version"] == "1.0.0"
    assert ident["fhir_version"] == "4.0.1"
    assert ident["canonical"].startswith("https://twcore.mohw.gov.tw")
    # dependencies parsed from package.json into {packageId: version}
    assert ident["dependencies"].get("hl7.fhir.r4.core") == "4.0.1"
    assert ident["dependencies"].get("hl7.terminology.r4")


def test_parse_ig_package_identity_falls_back_to_filename(tmp_path):
    import io
    import json
    import tarfile

    # A package with no package.json and no ImplementationGuide → identity must
    # still be non-empty (PK columns), derived from the file name.
    path = tmp_path / "my.custom.ig-2.3.4.tgz"
    with tarfile.open(path, "w:gz") as tf:
        data = json.dumps({"resourceType": "CodeSystem", "id": "x"}).encode()
        info = tarfile.TarInfo("package/CodeSystem-x.json")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    ident = admin_jobs._parse_ig_package_identity(str(path))
    assert ident["package_id"] == "my.custom.ig-2.3.4"
    assert ident["version"] == "0.0.0"


# ── package-scoped stage payloads ────────────────────────────────────────────


@_skip_no_tgz
def test_build_stage_payload_is_package_scoped():
    identities, codesystems, concepts, artifacts = (
        admin_jobs._build_twcore_stage_payload(TGZ)
    )
    assert [i["package_id"] for i in identities] == ["tw.gov.mohw.twcore"]
    assert codesystems and artifacts
    # every row is prefixed with (package_id, package_version)
    for row in codesystems:
        assert row[0] == "tw.gov.mohw.twcore" and row[1] == "1.0.0"
    for row in artifacts:
        assert row[0] == "tw.gov.mohw.twcore" and row[1] == "1.0.0"
    for row in concepts:
        assert row[0] == "tw.gov.mohw.twcore" and row[1] == "1.0.0"
    # the ImplementationGuide artifact is present
    assert any(r[3] == "ImplementationGuide" for r in artifacts)


# ── fake pool for fhir_ig resolver tests ─────────────────────────────────────


class _FakePool:
    """Minimal asyncpg-pool stand-in that answers fhir_ig's queries from
    in-memory ``packages`` / ``artifacts`` dicts."""

    def __init__(self, packages=None, artifacts=None):
        self.packages = packages or []
        self.artifacts = artifacts or []

    @staticmethod
    def _norm(sql):
        return " ".join(sql.split())

    async def fetchrow(self, sql, *args):
        s = self._norm(sql)
        if (
            "FROM fhir.ig_packages" in s
            and "ORDER BY is_default DESC, imported_at DESC" in s
        ):
            rows = sorted(
                self.packages,
                key=lambda p: (bool(p.get("is_default")), p.get("imported_at", 0)),
                reverse=True,
            )
            return dict(rows[0]) if rows else None
        if (
            "SELECT package_id, version FROM fhir.ig_packages" in s
            and "version = $2" in s
        ):
            for p in self.packages:
                if p["package_id"] == args[0] and p["version"] == args[1]:
                    return {"package_id": p["package_id"], "version": p["version"]}
            return None
        if "SELECT dependencies FROM fhir.ig_packages" in s:
            for p in self.packages:
                if p["package_id"] == args[0] and p["version"] == args[1]:
                    return {"dependencies": p.get("dependencies")}
            return None
        if "FROM fhir.artifacts" in s and "canonical_url = $3" in s:
            for a in self.artifacts:
                if (
                    a["package_id"] == args[0]
                    and a["package_version"] == args[1]
                    and a["canonical_url"] == args[2]
                ):
                    return dict(a)
            return None
        if "SELECT package_id, version, canonical" in s and "version = $2" in s:
            for p in self.packages:
                if p["package_id"] == args[0] and p["version"] == args[1]:
                    return dict(p)
            return None
        raise AssertionError(f"unexpected fetchrow: {s}")

    async def fetch(self, sql, *args):
        s = self._norm(sql)
        if (
            "SELECT version, is_default FROM fhir.ig_packages WHERE package_id = $1"
            in s
        ):
            return [
                {"version": p["version"], "is_default": p.get("is_default", False)}
                for p in self.packages
                if p["package_id"] == args[0]
            ]
        if "ORDER BY is_default DESC, package_id, version" in s:
            return [
                dict(p)
                for p in sorted(
                    self.packages,
                    key=lambda p: (
                        not p.get("is_default"),
                        p["package_id"],
                        p["version"],
                    ),
                )
            ]
        raise AssertionError(f"unexpected fetch: {s}")


def _pkg(package_id, version, **kw):
    base = {
        "package_id": package_id,
        "version": version,
        "canonical": "",
        "fhir_version": "4.0.1",
        "title": package_id,
        "status": "active",
        "is_default": False,
        "dependencies": {},
        "imported_at": 0,
    }
    base.update(kw)
    return base


# ── resolve_package ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_package_default():
    pool = _FakePool(
        packages=[
            _pkg("a.b.c", "1.0.0", is_default=False, imported_at=1),
            _pkg("d.e.f", "2.0.0", is_default=True, imported_at=2),
        ]
    )
    assert await fhir_ig.resolve_package(pool, None) == ("d.e.f", "2.0.0")


@pytest.mark.asyncio
async def test_resolve_package_explicit_version():
    pool = _FakePool(packages=[_pkg("a.b.c", "1.0.0")])
    assert await fhir_ig.resolve_package(
        pool, {"packageId": "a.b.c", "version": "1.0.0"}
    ) == ("a.b.c", "1.0.0")


@pytest.mark.asyncio
async def test_resolve_package_picks_highest_semver_when_no_version():
    pool = _FakePool(
        packages=[
            _pkg("a.b.c", "1.0.0"),
            _pkg("a.b.c", "1.10.0"),
            _pkg("a.b.c", "1.2.0"),
        ]
    )
    # 1.10.0 must beat 1.2.0 (numeric, not lexical)
    assert await fhir_ig.resolve_package(pool, {"packageId": "a.b.c"}) == (
        "a.b.c",
        "1.10.0",
    )


@pytest.mark.asyncio
async def test_resolve_package_missing_raises():
    pool = _FakePool(packages=[])
    with pytest.raises(fhir_ig.IGNotFoundError):
        await fhir_ig.resolve_package(pool, None)
    with pytest.raises(fhir_ig.IGNotFoundError):
        await fhir_ig.resolve_package(pool, {"packageId": "nope"})


@pytest.mark.asyncio
async def test_resolve_default_package_returns_none_when_empty():
    pool = _FakePool(packages=[])
    assert await fhir_ig.resolve_default_package(pool) is None


# ── resolve_canonical (dependency walk) ──────────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_canonical_in_target_package():
    pool = _FakePool(
        packages=[_pkg("primary", "1.0.0")],
        artifacts=[
            {
                "package_id": "primary",
                "package_version": "1.0.0",
                "canonical_url": "http://x/Patient",
                "artifact_id": "Patient",
            }
        ],
    )
    row = await fhir_ig.resolve_canonical(pool, "http://x/Patient", "primary", "1.0.0")
    assert row and row["artifact_id"] == "Patient"


@pytest.mark.asyncio
async def test_resolve_canonical_walks_dependencies():
    pool = _FakePool(
        packages=[
            _pkg("primary", "1.0.0", dependencies={"base.fhir": "4.0.1"}),
            _pkg("base.fhir", "4.0.1"),
        ],
        artifacts=[
            {
                "package_id": "base.fhir",
                "package_version": "4.0.1",
                "canonical_url": "http://hl7.org/fhir/StructureDefinition/Patient",
                "artifact_id": "Patient",
            }
        ],
    )
    # not in primary → resolver follows the declared dependency to base.fhir
    row = await fhir_ig.resolve_canonical(
        pool,
        "http://hl7.org/fhir/StructureDefinition/Patient",
        "primary",
        "1.0.0",
    )
    assert row and row["package_id"] == "base.fhir"


@pytest.mark.asyncio
async def test_resolve_canonical_unresolved_returns_none():
    pool = _FakePool(packages=[_pkg("primary", "1.0.0")], artifacts=[])
    assert (
        await fhir_ig.resolve_canonical(pool, "http://nope", "primary", "1.0.0") is None
    )
