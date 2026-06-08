"""
TWCore IG package.tgz loader.
The FHIR NPM package structure:
  package/
    CodeSystem-*.json
    StructureDefinition-*.json
    ...

We extract CodeSystem JSON files and bulk-insert concepts into PostgreSQL. The
admin import job additionally indexes the full IG artifact tree for preview.
"""

import json
import os
import tarfile
from typing import Iterator, Tuple

import asyncpg

# Mirror the registry from twcore_service.py so we get category + name
CODESYSTEM_REGISTRY = {
    "icd-10-cm-2023-tw": ("臺灣健保署ICD-10-CM 2023年版", "diagnosis"),
    "icd-10-cm-2021-tw": ("臺灣健保署ICD-10-CM 2021年版", "diagnosis"),
    "icd-10-cm-2014-tw": ("臺灣健保署ICD-10-CM 2014年版", "diagnosis"),
    "icd-10-pcs-2023-tw": ("臺灣健保署ICD-10-PCS 2023年版", "diagnosis"),
    "organization-identifier-tw": ("臺灣醫療機構識別碼", "organization"),
    "practitioner-identifier-tw": ("臺灣醫事人員識別碼", "organization"),
    "department-nhia-tw": ("臺灣健保署就醫科別", "organization"),
    "specialty-nhia-tw": ("臺灣健保署專科醫師代碼", "organization"),
    "postal-code-tw": ("臺灣郵遞區號", "administrative"),
    "marital-status-tw": ("臺灣婚姻狀態", "administrative"),
    "occupation-dhpc-tw": ("臺灣職業代碼", "administrative"),
}


def _parse_package_identity(tgz_path: str) -> dict:
    """Extract IG package identity (package_id / version / canonical /
    fhir_version / title / status / dependencies) from ``package/package.json``,
    falling back to the file name. Mirrors the admin-import parser so the CLI
    loader writes package-scoped ``fhir.*`` rows + a registry entry."""
    pkg: dict = {}
    with tarfile.open(tgz_path, "r:gz") as tf:
        for member in tf.getmembers():
            if os.path.basename(member.name) != "package.json":
                continue
            f = tf.extractfile(member)
            if f is None:
                continue
            try:
                data = json.loads(f.read().decode("utf-8"))
            except Exception:
                data = {}
            if isinstance(data, dict) and "name" in data and "resourceType" not in data:
                pkg = data
                break
    fv = pkg.get("fhirVersions") or pkg.get("fhirVersion")
    fhir_version = str(fv[0]) if isinstance(fv, list) and fv else str(fv or "")
    deps = pkg.get("dependencies")
    deps = deps if isinstance(deps, dict) else {}
    package_id = str(pkg.get("name") or "")
    if not package_id:
        stem = os.path.basename(tgz_path)
        for suffix in (".tgz", ".tar.gz"):
            if stem.endswith(suffix):
                stem = stem[: -len(suffix)]
        package_id = stem or "unknown-package"
    return {
        "package_id": package_id,
        "version": str(pkg.get("version") or "0.0.0"),
        "canonical": str(pkg.get("canonical") or ""),
        "fhir_version": fhir_version,
        "title": str(pkg.get("title") or pkg.get("name") or ""),
        "status": str(pkg.get("status") or ""),
        "dependencies": {str(k): str(v) for k, v in deps.items()},
    }


def _iter_codesystems(tgz_path: str) -> Iterator[Tuple[str, dict]]:
    """Yield (filename_stem, fhir_json) for every CodeSystem in the package."""
    with tarfile.open(tgz_path, "r:gz") as tf:
        for member in tf.getmembers():
            name = member.name
            # package/CodeSystem-*.json
            if not (name.endswith(".json") and "/CodeSystem-" in name):
                continue
            f = tf.extractfile(member)
            if f is None:
                continue
            try:
                data = json.loads(f.read().decode("utf-8"))
            except Exception:
                continue
            if data.get("resourceType") != "CodeSystem":
                continue
            stem = (
                os.path.basename(name).replace("CodeSystem-", "").replace(".json", "")
            )
            yield stem, data


async def load_twcore_package(pool: asyncpg.Pool, tgz_path: str) -> None:
    """Load TWCore IG CodeSystem entries from a FHIR NPM package tarball.

    Args:
        pool: asyncpg connection pool.
        tgz_path: Path to the TWCore ``package.tgz`` file.
    """
    print(f"Parsing {tgz_path} ...")

    codesystems: list[tuple] = []  # (cs_id, name, category, concept_count)
    concepts: list[tuple] = []  # (cs_id, code, display, definition)

    for cs_id, data in _iter_codesystems(tgz_path):
        info = CODESYSTEM_REGISTRY.get(cs_id, (cs_id, "unknown"))
        name, category = info

        raw_concepts = data.get("concept", [])
        codesystems.append((cs_id, name, category, len(raw_concepts)))

        for c in raw_concepts:
            concepts.append(
                (
                    cs_id,
                    c.get("code", ""),
                    c.get("display", ""),
                    c.get("definition", ""),
                )
            )

    if not codesystems:
        print("  WARNING: No CodeSystem files found in package.")
        return

    print(
        f"  Found {len(codesystems)} CodeSystems, {len(concepts)} total concepts. Writing ..."
    )

    identity = _parse_package_identity(tgz_path)
    pid = identity["package_id"]
    pver = identity["version"]

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Register the IG package (default when no other default exists).
            existing_default = await conn.fetchval(
                "SELECT package_id FROM fhir.ig_packages WHERE is_default LIMIT 1"
            )
            is_default = existing_default is None or existing_default == pid
            await conn.execute(
                """INSERT INTO fhir.ig_packages
                       (package_id, version, canonical, fhir_version, title,
                        status, is_default, dependencies, imported_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
                   ON CONFLICT (package_id, version) DO UPDATE SET
                       canonical=EXCLUDED.canonical, fhir_version=EXCLUDED.fhir_version,
                       title=EXCLUDED.title, status=EXCLUDED.status,
                       dependencies=EXCLUDED.dependencies, imported_at=NOW()""",
                pid,
                pver,
                identity["canonical"],
                identity["fhir_version"],
                identity["title"],
                identity["status"],
                is_default,
                json.dumps(identity["dependencies"], ensure_ascii=False),
            )

            # Upsert CodeSystems (package-scoped)
            await conn.executemany(
                """INSERT INTO fhir.codesystems
                       (package_id, package_version, cs_id, name, category, fetched_at, concept_count)
                   VALUES ($1, $2, $3, $4, $5, NOW(), $6)
                   ON CONFLICT (package_id, package_version, cs_id) DO UPDATE
                   SET name=EXCLUDED.name, category=EXCLUDED.category,
                       fetched_at=NOW(), concept_count=EXCLUDED.concept_count""",
                [
                    (pid, pver, cs_id, name, category, cnt)
                    for cs_id, name, category, cnt in codesystems
                ],
            )

            # Replace all concepts for these CodeSystems (package-scoped)
            for cs_id, _, _, _ in codesystems:
                await conn.execute(
                    "DELETE FROM fhir.concepts "
                    "WHERE package_id=$1 AND package_version=$2 AND cs_id=$3",
                    pid,
                    pver,
                    cs_id,
                )

            BATCH = 5000
            scoped_concepts = [
                (pid, pver, cs_id, code, display, definition)
                for cs_id, code, display, definition in concepts
            ]
            for i in range(0, len(scoped_concepts), BATCH):
                await conn.executemany(
                    "INSERT INTO fhir.concepts "
                    "(package_id, package_version, cs_id, code, display, definition) "
                    "VALUES ($1,$2,$3,$4,$5,$6)",
                    scoped_concepts[i : i + BATCH],
                )

    print(
        f"  TWCore loaded: {pid}#{pver} — "
        f"{len(codesystems)} CodeSystems, {len(concepts)} concepts."
    )
