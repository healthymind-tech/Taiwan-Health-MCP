"""
TWCore IG package.tgz loader.
The FHIR NPM package structure:
  package/
    CodeSystem-*.json
    StructureDefinition-*.json
    ...

We extract all CodeSystem JSON files and bulk-insert concepts into PostgreSQL.
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

    async with pool.acquire() as conn:
        # Upsert CodeSystems
        await conn.executemany(
            """INSERT INTO twcore.codesystems (cs_id, name, category, fetched_at, concept_count)
               VALUES ($1, $2, $3, NOW(), $4)
               ON CONFLICT (cs_id) DO UPDATE
               SET name=$2, category=$3, fetched_at=NOW(), concept_count=$4""",
            codesystems,
        )

        # Replace all concepts for these CodeSystems
        for cs_id, _, _, _ in codesystems:
            await conn.execute("DELETE FROM twcore.concepts WHERE cs_id = $1", cs_id)

        BATCH = 5000
        for i in range(0, len(concepts), BATCH):
            await conn.executemany(
                "INSERT INTO twcore.concepts (cs_id, code, display, definition) VALUES ($1,$2,$3,$4)",
                concepts[i : i + BATCH],
            )

    print(f"  TWCore loaded: {len(codesystems)} CodeSystems, {len(concepts)} concepts.")
