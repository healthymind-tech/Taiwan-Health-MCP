"""Localize the fhir.artifacts parity diff between the Python IG builder and the
Node-written DB rows. Downloads the same dependency tarballs, runs the
authoritative `_build_twcore_artifact_payload`, canonicalizes each raw_json
through Postgres jsonb (matching the fingerprint), and reports the first
mismatching artifact_keys per package with a focused char diff.
Run:  python scripts/ig_artifact_diff.py
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import asyncpg  # noqa: E402
import fhir_registry  # noqa: E402
from admin_jobs import (  # noqa: E402
    _build_twcore_artifact_payload,
    _parse_ig_package_identity,
)

DB = "postgresql://mcp:mcpdev2024@127.0.0.1:5432/taiwan_health"
ROOT = os.path.join(
    os.path.dirname(__file__), "..", "fhir-code", "twcoreig", "v1.0.0", "package.tgz"
)
DEPS = [
    ("hl7.fhir.r4.core", "4.0.1"),
    ("hl7.terminology.r4", "7.0.0"),
    ("hl7.fhir.uv.extensions.r4", "5.2.0"),
    ("hl7.fhir.uv.ips", "1.1.0"),
    ("hl7.fhir.uv.sdc", "3.0.0"),
    ("hl7.terminology.r4", "5.0.0"),
    ("fhir.dicom", "2022.4.20221006"),
    ("hl7.fhir.r4.examples", "4.0.1"),
]


def first_diff(a: str, b: str) -> str:
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            lo = max(0, i - 30)
            return f"@{i}: py=...{a[lo:i+30]!r}  db=...{b[lo:i+30]!r}"
    return f"len py={len(a)} db={len(b)} tail py={a[n:n+40]!r} db={b[n:n+40]!r}"


async def check_pkg(conn, path):
    ident = _parse_ig_package_identity(path)
    pid, pver = ident["package_id"], ident["version"]
    rows = _build_twcore_artifact_payload(path)
    keys = [r[0] for r in rows]
    pyjson = [r[16] for r in rows]
    canon = await conn.fetch(
        "SELECT k, v::jsonb::text AS t FROM unnest($1::text[], $2::text[]) AS u(k, v)",
        keys,
        pyjson,
    )
    py_map = {}
    for i, rec in enumerate(canon):
        py_map[keys[i]] = rec["t"]
    db = await conn.fetch(
        "SELECT artifact_key, raw_json::text AS t FROM fhir.artifacts "
        "WHERE package_id=$1 AND package_version=$2",
        pid,
        pver,
    )
    db_map = {r["artifact_key"]: r["t"] for r in db}
    mismatches = []
    for k, v in py_map.items():
        if db_map.get(k) != v:
            mismatches.append(k)
    print(f"{pid}@{pver}: {len(mismatches)} mismatched / {len(py_map)} artifacts")
    for k in mismatches[:3]:
        print(f"   key={k}\n     {first_diff(py_map[k], db_map.get(k) or '')}")


async def main():
    conn = await asyncpg.connect(DB)
    base, fallback = fhir_registry.DEFAULT_REGISTRY, fhir_registry.FALLBACK_REGISTRY
    with tempfile.TemporaryDirectory() as tmp:
        paths = [os.path.abspath(ROOT)]
        for pid, ver in DEPS:
            meta = await fhir_registry.get_metadata(base, pid)
            resolved = fhir_registry.resolve_version(meta, ver)
            data = await fhir_registry.download_tarball(
                base, pid, resolved, meta=meta, fallback=fallback
            )
            p = os.path.join(tmp, f"{pid}-{ver}.tgz")
            with open(p, "wb") as fh:
                fh.write(data)
            paths.append(p)
        for p in paths:
            await check_pkg(conn, p)
    await conn.close()


asyncio.run(main())
