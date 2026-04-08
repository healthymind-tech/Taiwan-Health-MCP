"""
Data Loader — run once to populate PostgreSQL from official source files.
Usage:
    docker compose --profile loader run --rm data-loader
    # or locally:
    DATABASE_URL=postgresql://... python loader/main.py [--all] [--icd] [--loinc] [--twcore] [--guideline] [--snomed] [--rxnorm]

Source files expected at /app/fhir-code/ (mounted read-only in Docker):
    icd/10/icd10cm/icd10cm-table-index-2025.zip
    icd/10/icd10pcs/icd10pcs_tables_*.zip
    icd/10/*.xlsx          (Taiwan MOHW Chinese names — optional)
    loinc/2.80/Loinc_2.80.zip
    twcoreig/package.tgz
    snomed/SnomedCT_InternationalRF2_PRODUCTION_*.zip
    rxnorm/RxNorm_full_*.zip
"""

import argparse
import asyncio
import glob
import os
import sys

import asyncpg
from dotenv import load_dotenv

load_dotenv()

FHIR_CODE_DIR = os.getenv("FHIR_CODE_DIR", "/app/fhir-code")
DATABASE_URL  = os.getenv("DATABASE_URL", "")


async def get_pool() -> asyncpg.Pool:
    if not DATABASE_URL:
        print("ERROR: DATABASE_URL is not set", file=sys.stderr)
        sys.exit(1)
    return await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=5)


def _find_file(pattern: str) -> str | None:
    """Return the first file matching a glob pattern, or None."""
    matches = glob.glob(pattern)
    return matches[0] if matches else None


async def load_icd(pool: asyncpg.Pool) -> None:
    from loaders.icd_loader import load_icd10cm, load_icd10pcs, parse_icd_chinese_xlsx

    icd_base = os.path.join(FHIR_CODE_DIR, "icd", "10")

    # Chinese names from Taiwan MOHW Excel (optional but recommended)
    xlsx_match = _find_file(os.path.join(icd_base, "*.xlsx"))
    if xlsx_match:
        cm_zh, pcs_zh = parse_icd_chinese_xlsx(xlsx_match)
    else:
        print(f"  No Chinese names xlsx found under {icd_base}/ — loading English only")
        cm_zh, pcs_zh = {}, {}

    # ICD-10-CM (diagnoses) — required
    cm_path = os.path.join(icd_base, "icd10cm", "icd10cm-table-index-2025.zip")
    if not os.path.exists(cm_path):
        print(f"ICD-10-CM ZIP not found: {cm_path}")
    else:
        await load_icd10cm(pool, cm_path, name_zh_map=cm_zh)

    # ICD-10-PCS (procedures) — optional
    pcs_matches = _find_file(os.path.join(icd_base, "icd10pcs", "*.zip"))
    if pcs_matches is None:
        print(f"ICD-10-PCS ZIP not found under {icd_base}/icd10pcs/ — skipping procedure codes")
    else:
        await load_icd10pcs(pool, pcs_matches, name_zh_map=pcs_zh)


async def load_loinc(pool: asyncpg.Pool) -> None:
    from loaders.loinc_loader import load_loinc_full
    zip_path = os.path.join(FHIR_CODE_DIR, "loinc", "2.80", "Loinc_2.80.zip")
    if not os.path.exists(zip_path):
        print(f"LOINC ZIP not found: {zip_path}")
        return
    await load_loinc_full(pool, zip_path)


async def load_twcore(pool: asyncpg.Pool) -> None:
    from loaders.twcore_loader import load_twcore_package
    # Support both flat and versioned layouts:
    #   twcoreig/package.tgz  (old)
    #   twcoreig/v1.0.0/package.tgz  (new)
    tgz_path = _find_file(os.path.join(FHIR_CODE_DIR, "twcoreig", "package.tgz")) \
            or _find_file(os.path.join(FHIR_CODE_DIR, "twcoreig", "*", "package.tgz"))
    if tgz_path is None:
        print(f"TWCore package not found under {FHIR_CODE_DIR}/twcoreig/")
        return
    await load_twcore_package(pool, tgz_path)


async def load_guideline(pool: asyncpg.Pool) -> None:
    from loaders.guideline_seed import seed_guidelines
    await seed_guidelines(pool)


async def load_snomed(pool: asyncpg.Pool) -> None:
    from loaders.snomed_loader import load_snomed as _load
    zip_path = _find_file(
        os.path.join(FHIR_CODE_DIR, "snomed", "SnomedCT_InternationalRF2_PRODUCTION_*.zip")
    )
    if zip_path is None:
        print(f"SNOMED CT zip not found under {FHIR_CODE_DIR}/snomed/")
        return
    await _load(pool, zip_path)


async def load_rxnorm(pool: asyncpg.Pool) -> None:
    from loaders.rxnorm_loader import load_rxnorm as _load
    zip_path = _find_file(os.path.join(FHIR_CODE_DIR, "rxnorm", "RxNorm_full_*.zip"))
    if zip_path is None:
        print(f"RxNorm zip not found under {FHIR_CODE_DIR}/rxnorm/")
        return
    await _load(pool, zip_path)


async def main():
    parser = argparse.ArgumentParser(description="Taiwan Health MCP Data Loader")
    parser.add_argument("--all",       action="store_true", help="Load all datasets")
    parser.add_argument("--icd",       action="store_true", help="ICD-10-CM 2025")
    parser.add_argument("--loinc",     action="store_true", help="LOINC 2.80")
    parser.add_argument("--twcore",    action="store_true", help="TWCore IG CodeSystems")
    parser.add_argument("--guideline", action="store_true", help="Clinical guidelines seed data")
    parser.add_argument("--snomed",    action="store_true", help="SNOMED CT International RF2")
    parser.add_argument("--rxnorm",    action="store_true", help="RxNorm full release")
    args = parser.parse_args()

    run_all = args.all or not any([
        args.icd, args.loinc, args.twcore, args.guideline, args.snomed, args.rxnorm
    ])

    pool = await get_pool()
    try:
        if run_all or args.icd:
            print("=== Loading ICD-10-CM 2025 ===")
            await load_icd(pool)

        if run_all or args.loinc:
            print("=== Loading LOINC 2.80 ===")
            await load_loinc(pool)

        if run_all or args.twcore:
            print("=== Loading TWCore IG package ===")
            await load_twcore(pool)

        if run_all or args.guideline:
            print("=== Seeding Clinical Guidelines ===")
            await load_guideline(pool)

        if run_all or args.snomed:
            print("=== Loading SNOMED CT International RF2 ===")
            print("    (large dataset — expect 5-15 minutes)")
            await load_snomed(pool)

        if run_all or args.rxnorm:
            print("=== Loading RxNorm ===")
            await load_rxnorm(pool)

        print("\n=== Data loading complete ===")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
