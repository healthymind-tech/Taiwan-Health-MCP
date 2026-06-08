"""
SNOMED CT International RF2 Full release loader.

Expected zip: SnomedCT_InternationalRF2_PRODUCTION_<date>.zip
Key files inside:
  Snapshot/Terminology/sct2_Concept_Snapshot_INT_*.txt
  Snapshot/Terminology/sct2_Description_Snapshot-en_INT_*.txt
  Snapshot/Terminology/sct2_Relationship_Snapshot_INT_*.txt
  Snapshot/Refset/Map/der2_iisssccRefset_ExtendedMapSnapshot_INT_*.txt
  Snapshot/Refset/Content/der2_cRefset_AssociationSnapshot_INT_*.txt
  Snapshot/Refset/Language/der2_cRefset_LanguageSnapshot-en_INT_*.txt

Falls back to Full/ if Snapshot/ is not present.

Loaded tables:
  snomed.concepts       — active concepts
  snomed.descriptions   — English FSN + synonyms
  snomed.relationships  — active IS-A + attribute relationships
  snomed.icd10_map      — ICD-10 extended map
  snomed.historical_associations — retired concept → successor (REPLACED BY …)
"""

import csv
import io
import re
import sys
import zipfile
from datetime import date
from typing import Iterator

import asyncpg

# SNOMED CT description terms can be very long; lift the default 128 KB limit
csv.field_size_limit(sys.maxsize)

# SNOMED type IDs
_FSN_TYPE = 900000000000003001  # Fully Specified Name
_SYNONYM_TYPE = 900000000000013009  # Synonym
_IS_A_TYPE = 116680003  # Is-a relationship
_STATED_CHAR = 900000000000010007  # Stated relationship
_INFERRED_CHAR = 900000000000011006  # Inferred relationship
_US_EN_REFSET = "900000000000509007"  # US English language reference set
_PREFERRED = "900000000000548007"  # Acceptability: Preferred

BATCH = 5000


def _open_rf2(zf: zipfile.ZipFile, pattern: str) -> io.TextIOWrapper | None:
    """Return a text stream for the first zip member matching *pattern*."""
    for name in zf.namelist():
        if re.search(pattern, name, re.IGNORECASE):
            return io.TextIOWrapper(zf.open(name), encoding="utf-8-sig")
    return None


def _iter_tsv(stream: io.TextIOWrapper) -> Iterator[dict]:
    reader = csv.DictReader(stream, delimiter="\t")
    for row in reader:
        yield row


# ── concept parser ──────────────────────────────────────────────────────────


def _load_concepts_from_zip(zf: zipfile.ZipFile) -> list[tuple]:
    """Return list of (concept_id, effective_time, active, module_id, definition_status_id)."""
    stream = _open_rf2(
        zf, r"Snapshot/Terminology/sct2_Concept_Snapshot_INT"
    ) or _open_rf2(zf, r"Full/Terminology/sct2_Concept_Full_INT")
    if stream is None:
        raise FileNotFoundError("Concept file not found in SNOMED zip")

    # For Full files: deduplicate by keeping latest effectiveTime per id.
    # For Snapshot files: one row per id already.
    latest: dict[int, tuple] = {}
    for row in _iter_tsv(stream):
        cid = int(row["id"])
        etime = row["effectiveTime"]
        active = row["active"] == "1"
        if not (cid in latest) or etime > latest[cid][1]:
            latest[cid] = (
                cid,
                etime,
                active,
                int(row["moduleId"]),
                int(row["definitionStatusId"]),
            )

    # Keep only active concepts
    return [v for v in latest.values() if v[2]]


# ── description parser ──────────────────────────────────────────────────────


def _load_descriptions_from_zip(zf: zipfile.ZipFile) -> list[tuple]:
    """Return list of (description_id, concept_id, type_id, term, active, language_code)."""
    stream = _open_rf2(
        zf, r"Snapshot/Terminology/sct2_Description_Snapshot-en_INT"
    ) or _open_rf2(zf, r"Full/Terminology/sct2_Description_Full-en_INT")
    if stream is None:
        raise FileNotFoundError("Description file not found in SNOMED zip")

    latest: dict[int, tuple] = {}
    for row in _iter_tsv(stream):
        did = int(row["id"])
        etime = row["effectiveTime"]
        lang = row["languageCode"]
        ttype = int(row["typeId"])

        # Only English FSN and synonyms
        if lang != "en":
            continue
        if ttype not in (_FSN_TYPE, _SYNONYM_TYPE):
            continue

        active = row["active"] == "1"
        if not (did in latest) or etime > latest[did][1]:
            latest[did] = (
                did,
                etime,
                int(row["conceptId"]),
                ttype,
                row["term"],
                active,
                lang,
            )

    # Keep only active descriptions
    return [(v[0], v[2], v[3], v[4], v[5], v[6]) for v in latest.values() if v[5]]


# ── language refset parser (preferred terms) ────────────────────────────────


def _load_us_preferred_from_zip(zf: zipfile.ZipFile) -> set[int]:
    """Return the set of description ids the US English Language refset marks
    as Preferred — i.e. the official display term for each concept."""
    stream = _open_rf2(
        zf, r"Snapshot/Refset/Language/der2_cRefset_LanguageSnapshot-en_INT"
    ) or _open_rf2(zf, r"Full/Refset/Language/der2_cRefset_LanguageFull-en_INT")
    if stream is None:
        print("  WARNING: Language refset not found — preferred terms unavailable.")
        return set()

    # Snapshot has one row per (id); for Full, keep the latest effectiveTime.
    latest: dict[str, tuple] = {}
    for row in _iter_tsv(stream):
        rid = row["id"]
        etime = row["effectiveTime"]
        if not (rid in latest) or etime > latest[rid][0]:
            latest[rid] = (
                etime,
                row["active"] == "1",
                row["refsetId"],
                int(row["referencedComponentId"]),
                row["acceptabilityId"],
            )

    return {
        v[3]
        for v in latest.values()
        if v[1] and v[2] == _US_EN_REFSET and v[4] == _PREFERRED
    }


# ── relationship parser ─────────────────────────────────────────────────────


def _load_relationships_from_zip(zf: zipfile.ZipFile) -> list[tuple]:
    """Return list of (relationship_id, source_id, destination_id, type_id, active, characteristic_type_id)."""
    stream = _open_rf2(
        zf, r"Snapshot/Terminology/sct2_Relationship_Snapshot_INT"
    ) or _open_rf2(zf, r"Full/Terminology/sct2_Relationship_Full_INT")
    if stream is None:
        raise FileNotFoundError("Relationship file not found in SNOMED zip")

    latest: dict[int, tuple] = {}
    for row in _iter_tsv(stream):
        rid = int(row["id"])
        etime = row["effectiveTime"]
        active = row["active"] == "1"
        char_type = int(row["characteristicTypeId"])

        # Only inferred relationships (the standard closure); skip stated duplicates
        if char_type not in (_STATED_CHAR, _INFERRED_CHAR):
            continue

        if not (rid in latest) or etime > latest[rid][1]:
            latest[rid] = (
                rid,
                etime,
                int(row["sourceId"]),
                int(row["destinationId"]),
                int(row["typeId"]),
                active,
                char_type,
            )

    return [
        (v[0], v[2], v[3], v[4], v[5], v[6])
        for v in latest.values()
        if v[5]  # active only
    ]


# ── historical association parser ───────────────────────────────────────────


def _load_associations_from_zip(zf: zipfile.ZipFile) -> list[tuple]:
    """Return list of (referenced_component_id, target_component_id, refset_id).

    The Association reference set maps an inactive (retired) concept to its
    successor(s) via REPLACED BY / SAME AS / POSSIBLY EQUIVALENT TO / WAS A /
    ALTERNATIVE associations — used to expand ValueSet filters whose anchor
    concept was retired in this SNOMED edition.
    """
    stream = _open_rf2(
        zf, r"Snapshot/Refset/Content/der2_cRefset_AssociationSnapshot_INT"
    ) or _open_rf2(zf, r"Full/Refset/Content/der2_cRefset_AssociationFull_INT")
    if stream is None:
        print("  WARNING: Association refset not found — skipping historical map.")
        return []

    latest: dict[str, tuple] = {}
    for row in _iter_tsv(stream):
        rid = row["id"]  # UUID string
        etime = row["effectiveTime"]
        if not (rid in latest) or etime > latest[rid][1]:
            latest[rid] = (
                rid,
                etime,
                int(row["referencedComponentId"]),
                int(row["targetComponentId"]),
                int(row["refsetId"]),
                row["active"] == "1",
            )

    return [
        (v[2], v[3], v[4])
        for v in latest.values()
        if v[5]  # active only
    ]


# ── ICD-10 extended map parser ──────────────────────────────────────────────


def _load_icd10_map_from_zip(zf: zipfile.ZipFile) -> list[tuple]:
    """Return list of (referenced_component_id, map_target, map_rule, map_advice, map_priority, map_group, active)."""
    stream = _open_rf2(
        zf, r"Snapshot/Refset/Map/der2_iisssccRefset_ExtendedMapSnapshot_INT"
    ) or _open_rf2(zf, r"Full/Refset/Map/der2_iisssccRefset_ExtendedMapFull_INT")
    if stream is None:
        print("  WARNING: ICD-10 extended map file not found — skipping map load.")
        return []

    # id field is an integer SNOMED ID in older releases but a UUID string in
    # newer releases (2024+). Use it as a string key either way.
    latest: dict[str, tuple] = {}
    for row in _iter_tsv(stream):
        rid = row["id"]  # keep as string — may be UUID or integer
        etime = row["effectiveTime"]
        if not (rid in latest) or etime > latest[rid][1]:
            latest[rid] = (
                rid,
                etime,
                int(row["referencedComponentId"]),
                row.get("mapTarget", ""),
                row.get("mapRule", ""),
                row.get("mapAdvice", ""),
                int(row.get("mapPriority", 1) or 1),
                int(row.get("mapGroup", 1) or 1),
                row["active"] == "1",
            )

    return [
        (v[2], v[3], v[4], v[5], v[6], v[7], v[8])
        for v in latest.values()
        if v[8] and v[3]  # active and has a map target
    ]


# ── main loader ─────────────────────────────────────────────────────────────


async def load_snomed(pool: asyncpg.Pool, zip_path: str) -> None:
    print(f"Parsing {zip_path} ...")
    print("  (This may take several minutes for the International edition)")

    with zipfile.ZipFile(zip_path) as zf:
        # 1. Concepts
        print("  Loading concepts ...")
        concepts = _load_concepts_from_zip(zf)
        print(f"  {len(concepts)} active concepts")

        # 2. Descriptions (English FSN + synonyms)
        print("  Loading descriptions ...")
        descriptions = _load_descriptions_from_zip(zf)
        print(f"  {len(descriptions)} active English descriptions")

        # 2b. Preferred terms (US English Language refset)
        print("  Loading preferred terms (Language refset) ...")
        us_preferred_ids = _load_us_preferred_from_zip(zf)
        print(f"  {len(us_preferred_ids)} US-preferred descriptions")

        # 3. Relationships
        print("  Loading relationships ...")
        relationships = _load_relationships_from_zip(zf)
        print(f"  {len(relationships)} active relationships")

        # 4. ICD-10 map
        print("  Loading ICD-10 extended map ...")
        icd_map = _load_icd10_map_from_zip(zf)
        print(f"  {len(icd_map)} ICD-10 map entries")

        # 5. Historical associations (retired concept → successor)
        print("  Loading historical associations ...")
        associations = _load_associations_from_zip(zf)
        print(f"  {len(associations)} active historical associations")

    print("  Writing to database ...")
    async with pool.acquire() as conn:
        # Ensure newer columns/tables exist on pre-existing databases
        # (schema.sql only runs on first init). Idempotent.
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS snomed.historical_associations (
                referenced_component_id BIGINT NOT NULL,
                target_component_id     BIGINT NOT NULL,
                refset_id               BIGINT NOT NULL,
                PRIMARY KEY (referenced_component_id, target_component_id, refset_id)
            );
            CREATE INDEX IF NOT EXISTS idx_snomed_hist_assoc_ref
                ON snomed.historical_associations (referenced_component_id);
            ALTER TABLE snomed.descriptions
                ADD COLUMN IF NOT EXISTS us_preferred BOOLEAN NOT NULL DEFAULT FALSE;
            """
        )
        async with conn.transaction():
            # Clear existing data
            await conn.execute(
                "TRUNCATE snomed.historical_associations, snomed.icd10_map, "
                "snomed.relationships, snomed.descriptions, snomed.concepts CASCADE"
            )

            # Insert concepts — convert effectiveTime "YYYYMMDD" string to DATE
            print("  Inserting concepts ...")
            concept_rows = []
            for c in concepts:
                etime_str = c[1]
                etime = date(
                    int(etime_str[:4]), int(etime_str[4:6]), int(etime_str[6:8])
                )
                concept_rows.append((c[0], etime, c[2], c[3], c[4]))

            for i in range(0, len(concept_rows), BATCH):
                await conn.executemany(
                    """INSERT INTO snomed.concepts
                       (concept_id, effective_time, active, module_id, definition_status_id)
                       VALUES ($1, $2::date, $3, $4, $5)
                       ON CONFLICT (concept_id) DO UPDATE
                       SET effective_time=$2::date, active=$3, module_id=$4, definition_status_id=$5""",
                    concept_rows[i : i + BATCH],
                )

            # Build set of loaded concept IDs for FK validation
            loaded_concept_ids: set[int] = {c[0] for c in concepts}

            # Insert descriptions (only for concepts we have), tagging each with
            # whether the US English Language refset marks it as the Preferred term.
            print("  Inserting descriptions ...")
            desc_rows = [
                (d[0], d[1], d[2], d[3], d[4], d[5], d[0] in us_preferred_ids)
                for d in descriptions
                if d[1] in loaded_concept_ids
            ]
            for i in range(0, len(desc_rows), BATCH):
                await conn.executemany(
                    """INSERT INTO snomed.descriptions
                       (description_id, concept_id, type_id, term, active, language_code, us_preferred)
                       VALUES ($1, $2, $3, $4, $5, $6, $7)
                       ON CONFLICT (description_id) DO UPDATE
                       SET concept_id=$2, type_id=$3, term=$4, active=$5, us_preferred=$7""",
                    desc_rows[i : i + BATCH],
                )

            # Insert relationships (only where both endpoints exist)
            print("  Inserting relationships ...")
            rel_rows = [
                r
                for r in relationships
                if r[1] in loaded_concept_ids and r[2] in loaded_concept_ids
            ]
            for i in range(0, len(rel_rows), BATCH):
                await conn.executemany(
                    """INSERT INTO snomed.relationships
                       (relationship_id, source_id, destination_id, type_id, active, characteristic_type_id)
                       VALUES ($1, $2, $3, $4, $5, $6)
                       ON CONFLICT (relationship_id) DO UPDATE
                       SET source_id=$2, destination_id=$3, type_id=$4, active=$5""",
                    rel_rows[i : i + BATCH],
                )

            # Insert ICD-10 map (only for concepts we have)
            if icd_map:
                print("  Inserting ICD-10 map ...")
                map_rows = [m for m in icd_map if m[0] in loaded_concept_ids]
                for i in range(0, len(map_rows), BATCH):
                    await conn.executemany(
                        """INSERT INTO snomed.icd10_map
                           (referenced_component_id, map_target, map_rule, map_advice,
                            map_priority, map_group, active)
                           VALUES ($1, $2, $3, $4, $5, $6, $7)""",
                        map_rows[i : i + BATCH],
                    )

            # Insert historical associations (only where the successor is loaded
            # and active — the retired referenced concept is intentionally not).
            if associations:
                print("  Inserting historical associations ...")
                assoc_rows = [
                    a for a in associations if a[1] in loaded_concept_ids
                ]
                # A retired concept may carry duplicate (ref, target, refset) rows
                # across modules; dedupe to satisfy the primary key.
                assoc_rows = list(dict.fromkeys(assoc_rows))
                for i in range(0, len(assoc_rows), BATCH):
                    await conn.executemany(
                        """INSERT INTO snomed.historical_associations
                           (referenced_component_id, target_component_id, refset_id)
                           VALUES ($1, $2, $3)
                           ON CONFLICT DO NOTHING""",
                        assoc_rows[i : i + BATCH],
                    )
            else:
                assoc_rows = []

    print(
        f"  SNOMED CT loaded: {len(concept_rows)} concepts, "
        f"{len(desc_rows)} descriptions, "
        f"{len(rel_rows)} relationships, "
        f"{len(icd_map)} ICD-10 map entries, "
        f"{len(assoc_rows)} historical associations."
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO admin.module_load_log (module_key, last_loaded_at, row_count)
               VALUES ('snomed', NOW(), $1)
               ON CONFLICT (module_key) DO UPDATE SET last_loaded_at=NOW(), row_count=$1""",
            len(concept_rows),
        )
