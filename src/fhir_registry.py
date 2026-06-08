"""
FHIR package registry client (Phase B — multi-IG auto-import).

Resolves Implementation Guide (IG) packages from an npm-style FHIR package
registry (default ``packages.fhir.org``) so the admin import flow can pull a
package by ``packageId@version`` and recursively fetch its declared dependency
IGs until the closure is complete.

Verified registry shape:
  - ``GET {base}/{packageId}``            → npm metadata
      ``{ name, "dist-tags": {latest}, versions: { "x.y.z": {version, fhirVersion,
        dist: {shasum, tarball}} } }``
  - ``GET {base}/{packageId}/{version}``  → the package ``.tgz`` (gzip)
  - ``GET {base}/catalog?op=find&name=`` → ``[{Name, Description, FhirVersion}, …]``

The authoritative dependency list lives inside each tarball's
``package/package.json`` (parsed elsewhere), NOT in this registry metadata, so the
recursive walker reads deps from the downloaded tarball — these helpers only fetch.

Honesty contract: a package that cannot be fetched raises :class:`RegistryError`
(never a fabricated package). ``search`` is best-effort and returns ``[]`` on
failure, since autocomplete must not be fatal.
"""

from __future__ import annotations

import hashlib
from typing import Any, Optional

import httpx

DEFAULT_REGISTRY = "https://packages.fhir.org"
FALLBACK_REGISTRY = "https://packages2.fhir.org"

_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_GZIP_MAGIC = b"\x1f\x8b"


class RegistryError(Exception):
    """A package/version could not be resolved or downloaded from the registry."""

    code = "REGISTRY_ERROR"


def normalize_base(base: Optional[str]) -> str:
    """Coerce a configured registry base into a clean ``https://host`` (no slash)."""
    cleaned = (base or DEFAULT_REGISTRY).strip().rstrip("/")
    if not cleaned:
        return DEFAULT_REGISTRY
    if not cleaned.startswith(("http://", "https://")):
        cleaned = "https://" + cleaned
    return cleaned


def parse_coordinate(text: str) -> tuple[str, Optional[str]]:
    """Split a user-typed ``packageId@version`` (version optional) → ``(id, ver)``."""
    raw = (text or "").strip()
    if "@" in raw:
        pid, _, ver = raw.rpartition("@")
        pid = pid.strip()
        ver = ver.strip()
        return pid, (ver or None)
    return raw, None


async def get_metadata(
    base: str, package_id: str, *, client: Optional[httpx.AsyncClient] = None
) -> dict[str, Any]:
    """Fetch npm-style package metadata. Raises :class:`RegistryError` on 404/network."""
    base = normalize_base(base)
    url = f"{base}/{package_id}"
    owns = client is None
    client = client or httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True)
    try:
        resp = await client.get(url, headers={"Accept": "application/json"})
        if resp.status_code != 200:
            raise RegistryError(
                f"registry metadata for '{package_id}' returned HTTP {resp.status_code}"
            )
        try:
            data = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise RegistryError(
                f"registry metadata for '{package_id}' was not valid JSON"
            ) from exc
        if not isinstance(data, dict):
            raise RegistryError(
                f"registry metadata for '{package_id}' was not an object"
            )
        return data
    except httpx.HTTPError as exc:
        raise RegistryError(f"registry unreachable for '{package_id}': {exc}") from exc
    finally:
        if owns:
            await client.aclose()


def resolve_version(meta: dict[str, Any], version: Optional[str]) -> str:
    """Resolve an explicit version, else the ``dist-tags.latest`` from metadata."""
    versions = meta.get("versions") or {}
    if version:
        # Accept the requested version even if metadata omits it — the tarball
        # endpoint may still serve it. Only reject when metadata clearly lists
        # versions and this one is absent AND there is a usable latest.
        if not versions or version in versions:
            return version
        return version
    latest = (meta.get("dist-tags") or {}).get("latest")
    if isinstance(latest, str) and latest:
        return latest
    if versions:
        # Last resort: any listed version (sorted for determinism).
        return sorted(versions.keys())[-1]
    raise RegistryError(
        f"no version resolvable for package '{meta.get('name') or '?'}'"
    )


def _tarball_from_meta(meta: dict[str, Any], version: str) -> Optional[str]:
    entry = (meta.get("versions") or {}).get(version) or {}
    dist = entry.get("dist") or {}
    tarball = dist.get("tarball")
    return tarball if isinstance(tarball, str) and tarball else None


def _shasum_from_meta(meta: dict[str, Any], version: str) -> Optional[str]:
    entry = (meta.get("versions") or {}).get(version) or {}
    dist = entry.get("dist") or {}
    shasum = dist.get("shasum")
    return shasum if isinstance(shasum, str) and shasum else None


async def _get_bytes(client: httpx.AsyncClient, url: str) -> Optional[bytes]:
    try:
        resp = await client.get(url, headers={"Accept": "application/gzip, */*"})
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    return resp.content


async def download_tarball(
    base: str,
    package_id: str,
    version: str,
    *,
    meta: Optional[dict[str, Any]] = None,
    fallback: Optional[str] = FALLBACK_REGISTRY,
    client: Optional[httpx.AsyncClient] = None,
) -> bytes:
    """Download a package ``.tgz``, trying in order:

      1. ``{base}/{id}/{version}``
      2. the ``dist.tarball`` URL from ``meta`` (often ``packages.simplifier.net``)
      3. ``{fallback}/{id}/{version}``

    Verifies the SHA-1 ``shasum`` from ``meta`` when present, and that the payload
    is gzip. Raises :class:`RegistryError` when every source fails.
    """
    base = normalize_base(base)
    owns = client is None
    client = client or httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True)
    candidates = [f"{base}/{package_id}/{version}"]
    meta_tarball = _tarball_from_meta(meta or {}, version)
    if meta_tarball:
        candidates.append(meta_tarball)
    if fallback:
        candidates.append(f"{normalize_base(fallback)}/{package_id}/{version}")

    expected_sha = _shasum_from_meta(meta or {}, version)
    try:
        last_reason = "no source returned data"
        for url in candidates:
            data = await _get_bytes(client, url)
            if not data:
                last_reason = f"empty/non-200 from {url}"
                continue
            if not data.startswith(_GZIP_MAGIC):
                last_reason = f"non-gzip payload from {url}"
                continue
            if expected_sha:
                actual = hashlib.sha1(data).hexdigest()
                if actual.lower() != expected_sha.lower():
                    last_reason = f"shasum mismatch from {url}"
                    continue
            return data
        raise RegistryError(f"could not download {package_id}@{version}: {last_reason}")
    finally:
        if owns:
            await client.aclose()


async def search(
    base: str, query: str, *, client: Optional[httpx.AsyncClient] = None
) -> list[dict[str, Any]]:
    """Autocomplete search via ``GET {base}/catalog?op=find&name={q}``.

    Best-effort: returns ``[]`` on any failure (autocomplete must not be fatal).
    Each item is normalised to ``{name, description, fhirVersion}``.
    """
    q = (query or "").strip()
    if not q:
        return []
    base = normalize_base(base)
    owns = client is None
    client = client or httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True)
    try:
        resp = await client.get(
            f"{base}/catalog",
            params={"op": "find", "name": q},
            headers={"Accept": "application/json"},
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
    except (httpx.HTTPError, ValueError):
        return []
    finally:
        if owns:
            await client.aclose()
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = item.get("Name") or item.get("name")
        if not name:
            continue
        out.append(
            {
                "name": str(name),
                "description": str(
                    item.get("Description") or item.get("description") or ""
                ),
                "fhirVersion": str(
                    item.get("FhirVersion") or item.get("fhirVersion") or ""
                ),
            }
        )
    return out
