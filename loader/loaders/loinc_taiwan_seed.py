"""
Taiwan common lab tests: Chinese names + reference ranges.
Applied after full LOINC load.

Data is read from two CSV files co-located with the other LOINC source files:
  fhir-code/loinc/taiwan_mapping.csv      — Chinese names, specimen type, unit
  fhir-code/loinc/lab_reference_ranges.csv — reference ranges per age/gender
"""

import csv
import os
from pathlib import Path

import asyncpg

# In Docker, FHIR_CODE_DIR defaults to /app/fhir-code (same as other loaders).
# Locally it resolves relative to the repo root.
_REPO_ROOT = Path(__file__).parent.parent.parent
LOINC_DIR = Path(os.getenv("FHIR_CODE_DIR", str(_REPO_ROOT / "fhir-code"))) / "loinc"


def _load_mapping_csv(path: str | Path | None = None) -> list[tuple]:
    """Return list of (loinc_num, name_zh, common_name_zh, specimen_type, unit)."""
    path = Path(path) if path is not None else (LOINC_DIR / "taiwan_mapping.csv")
    if not path.exists():
        raise FileNotFoundError(f"LOINC mapping CSV not found: {path}")
    rows = []
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append(
                (
                    row["loinc_code"],
                    row["name_zh"],
                    row["common_name_zh"],
                    row["specimen_type"],
                    row["unit"],
                )
            )
    return rows


def _load_ranges_csv(path: str | Path | None = None) -> list[tuple]:
    """Return list of (loinc_num, age_min, age_max, gender, range_low, range_high, unit, interpretation)."""
    path = Path(path) if path is not None else (LOINC_DIR / "lab_reference_ranges.csv")
    if not path.exists():
        raise FileNotFoundError(f"Reference ranges CSV not found: {path}")
    rows = []
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append(
                (
                    row["loinc_code"],
                    int(row["age_min"]),
                    int(row["age_max"]),
                    row["gender"],
                    float(row["range_low"]),
                    float(row["range_high"]),
                    row["unit"],
                    row["interpretation"],
                )
            )
    return rows


async def apply_taiwan_seed(
    pool: asyncpg.Pool,
    mapping_csv_path: str | None = None,
    reference_ranges_csv_path: str | None = None,
) -> None:
    """Apply Taiwan-specific LOINC Chinese names and reference ranges to the DB.

    Pass an empty string for either path to skip that step entirely.

    Args:
        pool: asyncpg connection pool.
        mapping_csv_path: Path to ``taiwan_mapping.csv``, or ``None`` to use the
            default location, or ``""`` to skip.
        reference_ranges_csv_path: Path to ``lab_reference_ranges.csv``, or
            ``None`` to use the default, or ``""`` to skip.
    """
    print("  Applying Taiwan LOINC Chinese names ...")
    if mapping_csv_path == "":
        print("  Taiwan mapping CSV not configured/resolved — skipping Chinese names")
        taiwan_tests = []
    else:
        taiwan_tests = _load_mapping_csv(mapping_csv_path)

    if reference_ranges_csv_path == "":
        print(
            "  Taiwan reference ranges CSV not configured/resolved — skipping reference ranges"
        )
        reference_ranges = []
    else:
        reference_ranges = _load_ranges_csv(reference_ranges_csv_path)

    async with pool.acquire() as conn:
        for loinc_num, name_zh, common_name_zh, specimen_type, unit in taiwan_tests:
            await conn.execute(
                """UPDATE loinc.concepts
                   SET name_zh=$2, common_name_zh=$3, specimen_type=$4, unit=$5
                   WHERE loinc_num=$1""",
                loinc_num,
                name_zh,
                common_name_zh,
                specimen_type,
                unit,
            )

        print("  Inserting Taiwan reference ranges ...")
        await conn.execute("TRUNCATE loinc.reference_ranges")
        # Only insert ranges for codes that exist in concepts (FK safety)
        existing = {
            r["loinc_num"]
            for r in await conn.fetch("SELECT loinc_num FROM loinc.concepts")
        }
        ranges_to_insert = [r for r in reference_ranges if r[0] in existing]
        skipped = len(reference_ranges) - len(ranges_to_insert)
        if skipped:
            missing = {r[0] for r in reference_ranges} - existing
            print(
                f"  WARNING: skipping {skipped} range rows — LOINC codes not in concepts: {missing}"
            )
        if ranges_to_insert:
            await conn.executemany(
                """INSERT INTO loinc.reference_ranges
                   (loinc_num, age_min, age_max, gender, range_low, range_high, unit, interpretation)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
                ranges_to_insert,
            )
    print(
        f"  Taiwan seed applied: {len(taiwan_tests)} names, {len(ranges_to_insert)} ranges."
    )
