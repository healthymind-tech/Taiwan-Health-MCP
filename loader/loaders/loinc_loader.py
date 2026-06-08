"""
LOINC 2.80 full loader.
Reads Loinc_2.80.zip which contains:
  - Loinc.csv              (main LOINC table, ~100k rows)
  - LoincUniversalLabOrdersValueSet.csv  (common lab orders)
  - AccessoryFiles/PanelsAndForms/...    (panels)

Also seeds Taiwan common test Chinese names and reference ranges
from db/seeds/loinc_taiwan_seed.py.
"""

import csv
import io
import zipfile

import asyncpg

# Columns we care about from Loinc.csv
LOINC_COLS = {
    "LOINC_NUM": "loinc_num",
    "COMPONENT": "component",
    "PROPERTY": "property",
    "TIME_ASPCT": "time_aspect",
    "SYSTEM": "system",
    "SCALE_TYP": "scale_type",
    "METHOD_TYP": "method_type",
    "LONG_COMMON_NAME": "long_common_name",
    "SHORTNAME": "shortname",
    "CLASS": "class",
    "CLASSTYPE": "classtype",
    "STATUS": "status",
    "CONSUMER_NAME": "consumer_name",
}


async def load_loinc_full(
    pool: asyncpg.Pool,
    zip_path: str,
    mapping_csv_path: str | None = None,
    reference_ranges_csv_path: str | None = None,
) -> None:
    """Load the full LOINC 2.80 dataset into ``loinc.*`` tables.

    Also applies Taiwan Chinese names and reference ranges via the seed helpers
    when the corresponding CSV paths are provided.

    Args:
        pool: asyncpg connection pool.
        zip_path: Path to ``Loinc_2.80.zip``.
        mapping_csv_path: Optional path to the Taiwan LOINC mapping CSV.
        reference_ranges_csv_path: Optional path to the Taiwan reference ranges CSV.
    """
    print(f"Parsing {zip_path} ...")

    records: list[tuple] = []
    with zipfile.ZipFile(zip_path) as zf:
        all_names = zf.namelist()
        # Prefer root-level Loinc.csv; exclude AccessoryFiles subsets (PanelsAndForms, etc.)
        loinc_files = [
            n
            for n in all_names
            if n.endswith("Loinc.csv") and "AccessoryFiles" not in n
        ]
        # Fallback: any Loinc.csv
        if not loinc_files:
            loinc_files = [n for n in all_names if n.endswith("Loinc.csv")]
        if not loinc_files:
            print(f"  ERROR: Loinc.csv not found. Files: {all_names[:20]}")
            return

        print(f"  Reading {loinc_files[0]} ...")
        with zf.open(loinc_files[0]) as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            for row in reader:
                loinc_num = row.get("LOINC_NUM", "").strip()
                if not loinc_num:
                    continue
                try:
                    classtype = int(row.get("CLASSTYPE", 0))
                except ValueError:
                    classtype = 0
                records.append(
                    (
                        loinc_num,
                        row.get("COMPONENT", "").strip(),
                        row.get("PROPERTY", "").strip(),
                        row.get("TIME_ASPCT", "").strip(),
                        row.get("SYSTEM", "").strip(),
                        row.get("SCALE_TYP", "").strip(),
                        row.get("METHOD_TYP", "").strip(),
                        row.get("LONG_COMMON_NAME", "").strip(),
                        row.get("SHORTNAME", "").strip(),
                        row.get("CLASS", "").strip(),
                        classtype,
                        row.get("STATUS", "").strip(),
                        row.get("CONSUMER_NAME", "").strip(),
                        "",  # name_zh
                        "",  # common_name_zh
                        "",  # specimen_type
                        "",  # unit
                    )
                )

    print(f"  Parsed {len(records)} LOINC concepts. Writing to DB ...")

    BATCH = 5000
    async with pool.acquire() as conn:
        await conn.execute("TRUNCATE loinc.reference_ranges, loinc.concepts CASCADE")
        for i in range(0, len(records), BATCH):
            await conn.executemany(
                """INSERT INTO loinc.concepts
                   (loinc_num, component, property, time_aspect, system, scale_type, method_type,
                    long_common_name, shortname, class, classtype, status, consumer_name,
                    name_zh, common_name_zh, specimen_type, unit)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                   ON CONFLICT (loinc_num) DO UPDATE SET
                     long_common_name=$8, shortname=$9, class=$10, status=$12""",
                records[i : i + BATCH],
            )

    print(f"  LOINC loaded: {len(records)} concepts.")

    # Apply Taiwan-specific Chinese names and reference ranges
    from loaders.loinc_taiwan_seed import apply_taiwan_seed

    await apply_taiwan_seed(
        pool,
        mapping_csv_path=mapping_csv_path,
        reference_ranges_csv_path=reference_ranges_csv_path,
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO admin.module_load_log (module_key, last_loaded_at, row_count)
               VALUES ('loinc', NOW(), $1)
               ON CONFLICT (module_key) DO UPDATE SET last_loaded_at=NOW(), row_count=$1""",
            len(records),
        )
