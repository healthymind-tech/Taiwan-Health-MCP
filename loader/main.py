"""
Data Loader — populates PostgreSQL from official source files.
Imports are normally triggered from the admin console and executed by the
admin-worker, which invokes these stages (there is no standalone data-loader
container). To run a stage directly during development:
    DATABASE_URL=postgresql://... python loader/main.py [--all] [--icd] [--drug-index] [--drug-enrich] [--drug-analysis] [--loinc] [--twcore] [--guideline] [--snomed]

Source files expected at /app/fhir-code/ (mounted read-only in Docker):
    icd/10/icd10cm/icd10cm-table-index-2025.zip
    icd/10/icd10pcs/icd10pcs_tables_*.zip
    icd/10/*.xlsx          (Taiwan MOHW Chinese names — optional)
    loinc/2.80/Loinc_2.80.zip
    twcoreig/package.tgz
    snomed/SnomedCT_InternationalRF2_PRODUCTION_*.zip
"""

import argparse
import asyncio
import glob
import os
import sys
from pathlib import Path

import asyncpg
from dataset_config import (
    DatasetConfig,
    DatasetDefaults,
    DatasetEntry,
    get_dataset_config_path,
    load_dataset_config,
)
from dataset_resolver import DATASET_GROUPS, format_resolution_line, resolve_group
from dotenv import load_dotenv

load_dotenv()

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

FHIR_CODE_DIR = os.getenv("FHIR_CODE_DIR", "/app/fhir-code")
DATABASE_URL = os.getenv("DATABASE_URL", "")
async def get_pool() -> asyncpg.Pool:
    if not DATABASE_URL:
        print("ERROR: DATABASE_URL is not set", file=sys.stderr)
        sys.exit(1)
    return await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=5)


def _find_file(pattern: str) -> str | None:
    """Return the first file matching a glob pattern, or None."""
    matches = glob.glob(pattern)
    return matches[0] if matches else None


def _legacy_dataset_config() -> DatasetConfig:
    base = FHIR_CODE_DIR
    repo_root = Path(__file__).resolve().parents[1]
    return DatasetConfig(
        version=1,
        defaults=DatasetDefaults(base_dir=base),
        datasets={
            "icd10cm": DatasetEntry(
                key="icd10cm",
                enabled=True,
                required=True,
                source_type="file",
                path=os.path.join(
                    base, "icd", "10", "icd10cm", "icd10cm-table-index-2025.zip"
                ),
                pattern=None,
                label="ICD-10-CM",
                version="2025",
            ),
            "icd10pcs": DatasetEntry(
                key="icd10pcs",
                enabled=True,
                required=False,
                source_type="glob",
                path=None,
                pattern=os.path.join(base, "icd", "10", "icd10pcs", "*.zip"),
                label="ICD-10-PCS",
                version="2025",
            ),
            "icd_zh_tw": DatasetEntry(
                key="icd_zh_tw",
                enabled=True,
                required=False,
                source_type="glob",
                path=None,
                pattern=os.path.join(base, "icd", "10", "*.xlsx"),
                label="Taiwan ICD bilingual names",
            ),
            "loinc": DatasetEntry(
                key="loinc",
                enabled=True,
                required=True,
                source_type="file",
                path=os.path.join(base, "loinc", "2.80", "Loinc_2.80.zip"),
                pattern=None,
                label="LOINC",
                version="2.80",
            ),
            "loinc_taiwan_mapping": DatasetEntry(
                key="loinc_taiwan_mapping",
                enabled=True,
                required=False,
                source_type="file",
                path=os.path.join(base, "loinc", "taiwan_mapping.csv"),
                pattern=None,
                label="LOINC Taiwan mapping",
            ),
            "loinc_reference_ranges": DatasetEntry(
                key="loinc_reference_ranges",
                enabled=True,
                required=False,
                source_type="file",
                path=os.path.join(base, "loinc", "lab_reference_ranges.csv"),
                pattern=None,
                label="LOINC reference ranges",
            ),
            "drug_index_csv": DatasetEntry(
                key="drug_index_csv",
                enabled=True,
                required=True,
                source_type="file",
                path=str(repo_root / "POC" / "36_2.csv"),
                pattern=None,
                label="Taiwan FDA drug index CSV",
            ),
            "twcore": DatasetEntry(
                key="twcore",
                enabled=True,
                required=True,
                source_type="glob",
                path=None,
                pattern=os.path.join(base, "twcoreig", "**", "package.tgz"),
                label="TWCore IG",
                version="1.0.0",
            ),
            "guideline_seed": DatasetEntry(
                key="guideline_seed",
                enabled=True,
                required=True,
                source_type="internal",
                path=None,
                pattern=None,
                label="Clinical guideline seed",
            ),
            "snomed_ct": DatasetEntry(
                key="snomed_ct",
                enabled=True,
                required=False,
                source_type="glob",
                path=None,
                pattern=os.path.join(
                    base, "snomed", "SnomedCT_InternationalRF2_PRODUCTION_*.zip"
                ),
                label="SNOMED CT",
            ),
        },
    )


def get_effective_dataset_config() -> DatasetConfig:
    path = get_dataset_config_path()
    if path:
        return load_dataset_config(path)
    return _legacy_dataset_config()


def _print_resolution_summary(group: str, resolved: dict) -> None:
    print(f"=== Dataset resolution: {group} ===")
    for result in resolved.values():
        print(format_resolution_line(result))


def _ensure_required_datasets(resolved: dict) -> None:
    missing_required = [
        result
        for result in resolved.values()
        if result.required and result.status not in ("ok", "internal", "disabled")
    ]
    if missing_required:
        messages = "; ".join(
            f"{item.key}: {'; '.join(item.diagnostics) or item.status}"
            for item in missing_required
        )
        raise FileNotFoundError(f"Required datasets missing: {messages}")


async def load_icd(pool: asyncpg.Pool) -> None:
    from loaders.icd_loader import load_icd10cm, load_icd10pcs, parse_icd_chinese_xlsx

    resolved = resolve_group(get_effective_dataset_config(), "icd")
    _print_resolution_summary("icd", resolved)
    _ensure_required_datasets(resolved)

    xlsx_match = resolved["icd_zh_tw"].resolved_path
    if xlsx_match:
        cm_zh, pcs_zh = parse_icd_chinese_xlsx(xlsx_match)
    else:
        print("  No Chinese names xlsx configured/found — loading English only")
        cm_zh, pcs_zh = {}, {}

    cm_path = resolved["icd10cm"].resolved_path
    if cm_path is None:
        print("ICD-10-CM ZIP not resolved")
    else:
        await load_icd10cm(pool, cm_path, name_zh_map=cm_zh)

    pcs_path = resolved["icd10pcs"].resolved_path
    if pcs_path is None:
        print("ICD-10-PCS ZIP not resolved — skipping procedure codes")
    else:
        await load_icd10pcs(pool, pcs_path, name_zh_map=pcs_zh)


async def load_loinc(pool: asyncpg.Pool) -> None:
    from loaders.loinc_loader import load_loinc_full

    resolved = resolve_group(get_effective_dataset_config(), "loinc")
    _print_resolution_summary("loinc", resolved)
    _ensure_required_datasets(resolved)

    zip_path = resolved["loinc"].resolved_path
    if zip_path is None:
        print("LOINC ZIP not resolved")
        return
    await load_loinc_full(
        pool,
        zip_path,
        mapping_csv_path=resolved["loinc_taiwan_mapping"].resolved_path or "",
        reference_ranges_csv_path=resolved["loinc_reference_ranges"].resolved_path
        or "",
    )


async def load_drug_index(pool: asyncpg.Pool) -> None:
    from loaders.drug_index_loader import load_drug_index as _load

    resolved = resolve_group(get_effective_dataset_config(), "drug")
    _print_resolution_summary("drug", resolved)
    _ensure_required_datasets(resolved)

    csv_path = resolved["drug_index_csv"].resolved_path
    if csv_path is None:
        print("Drug index CSV not resolved")
        return
    await _load(pool, csv_path)


async def load_drug_enrichment(
    pool: asyncpg.Pool,
    *,
    limit: int | None = None,
    license_ids: list[str] | None = None,
    include_cancelled: bool = False,
    retry_failed: bool = False,
) -> None:
    from loaders.drug_enrichment_loader import load_drug_enrichment as _load

    await _load(
        pool,
        limit=limit,
        license_ids=license_ids,
        include_cancelled=include_cancelled,
        retry_failed=retry_failed,
    )


async def load_drug_analysis(
    pool: asyncpg.Pool,
    *,
    limit: int | None = None,
    license_ids: list[str] | None = None,
    include_cancelled: bool = False,
    retry_failed: bool = False,
    retry_stage: str | None = None,
) -> None:
    from loaders.drug_analysis_loader import load_drug_analysis as _load

    await _load(
        pool,
        limit=limit,
        license_ids=license_ids,
        include_cancelled=include_cancelled,
        retry_failed=retry_failed,
        retry_stage=retry_stage,
    )


async def load_twcore(pool: asyncpg.Pool) -> None:
    from loaders.twcore_loader import load_twcore_package

    resolved = resolve_group(get_effective_dataset_config(), "twcore")
    _print_resolution_summary("twcore", resolved)
    _ensure_required_datasets(resolved)

    tgz_path = resolved["twcore"].resolved_path
    if tgz_path is None:
        print("TWCore package not resolved")
        return
    await load_twcore_package(pool, tgz_path)


async def load_guideline(pool: asyncpg.Pool) -> None:
    from loaders.guideline_seed import seed_guidelines

    resolved = resolve_group(get_effective_dataset_config(), "guideline")
    _print_resolution_summary("guideline", resolved)
    _ensure_required_datasets(resolved)
    await seed_guidelines(pool)


async def load_snomed(pool: asyncpg.Pool) -> None:
    from loaders.snomed_loader import load_snomed as _load

    resolved = resolve_group(get_effective_dataset_config(), "snomed")
    _print_resolution_summary("snomed", resolved)
    _ensure_required_datasets(resolved)

    zip_path = resolved["snomed_ct"].resolved_path
    if zip_path is None:
        print("SNOMED CT zip not resolved")
        return
    await _load(pool, zip_path)


async def load_health_supplements(pool: asyncpg.Pool) -> None:
    from loaders.health_supplements_loader import load_health_supplements as _load

    await _load(pool)


async def load_food_nutrition(pool: asyncpg.Pool) -> None:
    from loaders.food_nutrition_loader import load_food_nutrition as _load

    await _load(pool)


async def generate_embeddings(pool: asyncpg.Pool, services: list[str]) -> None:
    from loaders.embedding_loader import (
        embed_food_nutrition,
        embed_guideline,
        embed_health_supplements,
        embed_icd,
        embed_loinc,
        embed_snomed,
        ensure_dimensions,
    )

    await ensure_dimensions(pool)
    if "food_nutrition" in services:
        await embed_food_nutrition(pool)
    if "health_supplements" in services:
        await embed_health_supplements(pool)
    if "icd" in services:
        await embed_icd(pool)
    if "loinc" in services:
        await embed_loinc(pool)
    if "guideline" in services:
        await embed_guideline(pool)
    if "snomed" in services:
        await embed_snomed(pool)


async def main():
    parser = argparse.ArgumentParser(description="Taiwan Health MCP Data Loader")
    parser.add_argument("--all", action="store_true", help="Load all datasets")
    parser.add_argument("--icd", action="store_true", help="ICD-10-CM 2025")
    parser.add_argument(
        "--drug",
        action="store_true",
        help="Taiwan FDA drug index + TFDA enrichment",
    )
    parser.add_argument(
        "--drug-index",
        action="store_true",
        help="Taiwan FDA drug index CSV (36_2.csv)",
    )
    parser.add_argument(
        "--drug-enrich",
        action="store_true",
        help="TFDA enrichment for queued or selected drug licenses",
    )
    parser.add_argument(
        "--drug-analysis",
        action="store_true",
        help="OCR and structured analysis for latest stored insert PDFs",
    )
    parser.add_argument("--loinc", action="store_true", help="LOINC 2.80")
    parser.add_argument("--twcore", action="store_true", help="TWCore IG CodeSystems")
    parser.add_argument(
        "--guideline", action="store_true", help="Clinical guidelines seed data"
    )
    parser.add_argument(
        "--snomed", action="store_true", help="SNOMED CT International RF2"
    )
    parser.add_argument(
        "--health-supplements", action="store_true", help="Taiwan FDA health supplements dataset"
    )
    parser.add_argument(
        "--food-nutrition",
        action="store_true",
        help="Taiwan FDA food nutrition datasets",
    )
    parser.add_argument(
        "--embed",
        action="store_true",
        help="Generate pgvector embeddings (all datasets)",
    )
    parser.add_argument(
        "--license-id",
        action="append",
        default=[],
        help="Specific drug license ID to process; can be repeated",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit queued drug jobs for enrichment or analysis",
    )
    parser.add_argument(
        "--include-cancelled",
        action="store_true",
        help="Include cancelled drug licenses when processing",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="Retry drug stage jobs currently marked retryable_failed",
    )
    parser.add_argument(
        "--retry-stage",
        choices=["ocr", "analysis", "normalize"],
        default=None,
        help="When running --drug-analysis, retry only the specified stage",
    )
    args = parser.parse_args()

    run_all = args.all or not any(
        [
            args.icd,
            args.drug,
            args.drug_index,
            args.drug_enrich,
            args.drug_analysis,
            args.loinc,
            args.twcore,
            args.guideline,
            args.snomed,
            args.health_supplements,
            args.food_nutrition,
            args.embed,
        ]
    )

    pool = await get_pool()
    try:
        if run_all or args.icd:
            print("=== Loading ICD-10-CM 2025 ===")
            await load_icd(pool)

        if run_all or args.drug or args.drug_index:
            print("=== Loading Taiwan FDA drug index CSV ===")
            await load_drug_index(pool)

        if run_all or args.drug or args.drug_enrich:
            print("=== Running Taiwan FDA TFDA enrichment ===")
            await load_drug_enrichment(
                pool,
                limit=args.limit,
                license_ids=args.license_id,
                include_cancelled=args.include_cancelled,
                retry_failed=args.retry_failed,
            )

        if args.drug_analysis:
            print("=== Running Taiwan FDA OCR / analysis refresh ===")
            await load_drug_analysis(
                pool,
                limit=args.limit,
                license_ids=args.license_id,
                include_cancelled=args.include_cancelled,
                retry_failed=args.retry_failed,
                retry_stage=args.retry_stage,
            )

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

        if run_all or args.health_supplements:
            print("=== Loading Taiwan FDA health supplements dataset ===")
            await load_health_supplements(pool)

        if run_all or args.food_nutrition:
            print("=== Loading Taiwan FDA food nutrition datasets ===")
            await load_food_nutrition(pool)

        # Auto-embed after each dataset load; also runs on explicit --embed
        embed_services: list[str] = []
        if run_all or args.food_nutrition or args.embed:
            embed_services.append("food_nutrition")
        if run_all or args.health_supplements or args.embed:
            embed_services.append("health_supplements")
        if run_all or args.icd or args.embed:
            embed_services.append("icd")
        if run_all or args.loinc or args.embed:
            embed_services.append("loinc")
        if run_all or args.guideline or args.embed:
            embed_services.append("guideline")
        if args.snomed or args.embed:
            # SNOMED embedding is opt-in only (takes 1-2+ hours)
            # Not auto-triggered by --all to avoid unexpected very long runs
            embed_services.append("snomed")

        if embed_services:
            await generate_embeddings(pool, embed_services)

        print("\n=== Data loading complete ===")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
