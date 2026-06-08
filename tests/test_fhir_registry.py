"""
Tests for fhir_registry — the FHIR package registry client (Phase B).

Pure helpers (normalize_base / parse_coordinate / resolve_version / dist parsing)
plus the async fetchers driven through an httpx MockTransport so no network is
touched. Covers the tarball fallback chain, shasum verification, gzip-guard, and
the best-effort (never-fatal) search.
"""

import hashlib

import httpx
import pytest

import fhir_registry as r

GZIP = b"\x1f\x8b\x08\x00rest-of-a-fake-tarball"


# ── pure helpers ─────────────────────────────────────────────────────────────


def test_normalize_base():
    assert r.normalize_base(None) == "https://packages.fhir.org"
    assert r.normalize_base("") == "https://packages.fhir.org"
    assert r.normalize_base("packages.fhir.org/") == "https://packages.fhir.org"
    assert r.normalize_base("https://x/") == "https://x"
    assert r.normalize_base("http://mirror:8080") == "http://mirror:8080"


def test_parse_coordinate():
    assert r.parse_coordinate("hl7.fhir.us.core@6.1.0") == ("hl7.fhir.us.core", "6.1.0")
    assert r.parse_coordinate("hl7.fhir.r4.core") == ("hl7.fhir.r4.core", None)
    assert r.parse_coordinate("  a.b@1.0  ") == ("a.b", "1.0")


def _meta():
    return {
        "name": "pkg",
        "dist-tags": {"latest": "7.1.0"},
        "versions": {
            "7.0.0": {"version": "7.0.0", "dist": {"tarball": "https://s/pkg/7.0.0"}},
            "7.1.0": {
                "version": "7.1.0",
                "fhirVersion": "R4",
                "dist": {"tarball": "https://s/pkg/7.1.0", "shasum": "deadbeef"},
            },
        },
    }


def test_resolve_version():
    m = _meta()
    assert r.resolve_version(m, None) == "7.1.0"  # dist-tags.latest
    assert r.resolve_version(m, "7.0.0") == "7.0.0"  # explicit, present
    assert r.resolve_version(m, "9.9.9") == "9.9.9"  # explicit, absent → trust caller
    # version present only in `versions` map, no dist-tags → still resolvable
    assert (
        r.resolve_version({"versions": {"2.0.0": {}}, "dist-tags": {}}, None) == "2.0.0"
    )


def test_resolve_version_no_latest_raises():
    with pytest.raises(r.RegistryError):
        r.resolve_version({"versions": {}, "dist-tags": {}}, None)


def test_dist_parsing():
    m = _meta()
    assert r._tarball_from_meta(m, "7.1.0") == "https://s/pkg/7.1.0"
    assert r._shasum_from_meta(m, "7.1.0") == "deadbeef"
    assert r._shasum_from_meta(m, "7.0.0") is None


# ── async fetchers via MockTransport ─────────────────────────────────────────


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_get_metadata_ok_and_404():
    def handler(request):
        if request.url.path == "/good":
            return httpx.Response(200, json={"name": "good", "versions": {}})
        return httpx.Response(404, text="nope")

    async with _client(handler) as c:
        meta = await r.get_metadata("https://reg", "good", client=c)
        assert meta["name"] == "good"
        with pytest.raises(r.RegistryError):
            await r.get_metadata("https://reg", "missing", client=c)


@pytest.mark.asyncio
async def test_download_tarball_primary():
    def handler(request):
        if request.url.path == "/pkg/1.0.0":
            return httpx.Response(200, content=GZIP)
        return httpx.Response(404)

    async with _client(handler) as c:
        data = await r.download_tarball("https://reg", "pkg", "1.0.0", client=c)
        assert data == GZIP


@pytest.mark.asyncio
async def test_download_tarball_falls_back_to_dist_then_fallback():
    # Primary {base}/{id}/{ver} 404s; dist.tarball serves it.
    meta = {"versions": {"1.0.0": {"dist": {"tarball": "https://cdn/dl"}}}}

    def handler(request):
        if str(request.url) == "https://cdn/dl":
            return httpx.Response(200, content=GZIP)
        return httpx.Response(404)

    async with _client(handler) as c:
        data = await r.download_tarball(
            "https://reg", "pkg", "1.0.0", meta=meta, client=c
        )
        assert data == GZIP


@pytest.mark.asyncio
async def test_download_tarball_shasum_mismatch_rejected():
    good_sha = hashlib.sha1(GZIP).hexdigest()
    meta = {"versions": {"1.0.0": {"dist": {"shasum": "0" * 40}}}}  # wrong sha

    def handler(request):
        return httpx.Response(200, content=GZIP)

    async with _client(handler) as c:
        with pytest.raises(r.RegistryError):
            await r.download_tarball(
                "https://reg", "pkg", "1.0.0", meta=meta, fallback=None, client=c
            )
    # sanity: the bytes themselves hash to good_sha (the test's premise)
    assert hashlib.sha1(GZIP).hexdigest() == good_sha


@pytest.mark.asyncio
async def test_download_tarball_rejects_non_gzip():
    def handler(request):
        return httpx.Response(200, content=b"<html>not a tarball</html>")

    async with _client(handler) as c:
        with pytest.raises(r.RegistryError):
            await r.download_tarball(
                "https://reg", "pkg", "1.0.0", fallback=None, client=c
            )


@pytest.mark.asyncio
async def test_search_parses_and_is_best_effort():
    def handler(request):
        if request.url.params.get("name") == "boom":
            return httpx.Response(500)
        return httpx.Response(
            200,
            json=[
                {"Name": "hl7.fhir.us.core", "Description": "d", "FhirVersion": "R4"},
                {"NotName": "ignored"},
            ],
        )

    async with _client(handler) as c:
        hits = await r.search("https://reg", "core", client=c)
        assert len(hits) == 1
        assert hits[0]["name"] == "hl7.fhir.us.core"
        assert hits[0]["fhirVersion"] == "R4"
        # server error → [] (autocomplete must never be fatal)
        assert await r.search("https://reg", "boom", client=c) == []
        # empty query short-circuits
        assert await r.search("https://reg", "", client=c) == []
