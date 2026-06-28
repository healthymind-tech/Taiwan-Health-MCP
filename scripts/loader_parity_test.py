#!/usr/bin/env python3
"""Loader golden-output diff harness (D3 skeleton, L3 core).

L3 loader stages have no outbound HTTP contract — their contract is the *rows
they write to PostgreSQL*. This harness compares the rows produced by the Python
loader against the Node loader for the same source-file fixture:

    Python loader -> schema A  (search_path = py_<schema>)
    Node   loader -> schema B  (search_path = nd_<schema>)
    per table: SELECT ... ORDER BY <pk> -> normalize (drop serial id, created_at)
               -> row-by-row diff.

Phase-0 deliverable: it must *run* and produce a golden baseline from the
*current* live schemas (Python-written). The Node side is wired but optional
(skeleton — no Node loader exists yet).

Usage:
    # Golden mode: dump current (Python-written) tables to a baseline.
    python scripts/loader_parity_test.py \
        --database-url postgresql://mcp:***@127.0.0.1:5432/taiwan_health \
        --golden loader-golden.json

    # Compare mode: diff two schema prefixes written by two loaders.
    python scripts/loader_parity_test.py \
        --database-url postgresql://... \
        --left-prefix py_ --right-prefix nd_ \
        --report loader-parity-report.json

Embedding tables (pgvector) are compared structurally only here (dim + non-null
rate); cosine >= 0.99 belongs to a dedicated vector check (see plan §2.3).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import asyncpg


# --------------------------------------------------------------------------- #
# Table registry: schema.table -> (order-by columns, columns to ignore)
# --------------------------------------------------------------------------- #
# `ignore` strips non-deterministic / serial columns so two independent loader
# runs can be compared. Keep this in sync with db/schema.sql as stages are
# ported. Embedding tables are listed separately (vector compare).
@dataclass(frozen=True)
class TableSpec:
    schema: str
    table: str
    order_by: tuple[str, ...]
    ignore: tuple[str, ...] = ()
    is_vector: bool = False


# Order-by / ignore columns verified against the live schema (db/schema.sql).
TABLE_REGISTRY: list[TableSpec] = [
    # --- file-based deterministic stages (Phase 3.1) ---
    TableSpec("icd", "diagnoses", ("code",), ("id", "created_at")),
    TableSpec("icd", "procedures", ("code",), ("id", "created_at")),
    TableSpec("loinc", "concepts", ("loinc_num",), ("id", "created_at")),
    TableSpec("loinc", "reference_ranges", ("loinc_num", "id"), ("created_at",)),
    TableSpec("snomed", "concepts", ("concept_id",), ("created_at",)),
    TableSpec("snomed", "descriptions", ("description_id",), ("created_at",)),
    TableSpec("snomed", "relationships", ("relationship_id",), ("created_at",)),
    TableSpec("fhir", "ig_packages", ("package_id",), ("id", "created_at")),
    TableSpec("fhir", "codesystems", ("package_id", "package_version", "cs_id"), ("fetched_at",)),
    TableSpec("fhir", "concepts", ("package_id", "package_version", "cs_id", "code"), ("id",)),
    TableSpec("fhir", "artifacts", ("package_id", "package_version", "artifact_key"), ("imported_at",)),
    # --- API-based stages (Phase 3.2) ---
    TableSpec("health_supplements", "items", ("permit_no",), ()),
    TableSpec("food_nutrition", "ingredients", ("name_zh",), ("id",)),
    TableSpec("food_nutrition", "measurements", ("sample_name", "nutrient_item"), ("id",)),
    TableSpec("drug", "licenses", ("license_id",), ("created_at", "updated_at")),
    TableSpec("drug", "normalized_records", ("license_id",), ("normalized_at",)),
    TableSpec("guideline", "disease_guidelines", ("icd_code",), ("id",)),
    # --- embedding backfill (Phase 3.3) — structural compare only ---
    TableSpec("icd", "diagnosis_embeddings", ("code",), ("embedded_at",), is_vector=True),
    TableSpec("loinc", "concept_embeddings", ("loinc_num",), ("embedded_at",), is_vector=True),
    TableSpec("snomed", "concept_embeddings", ("concept_id",), ("embedded_at",), is_vector=True),
    TableSpec("food_nutrition", "food_embeddings", ("sample_name",), ("embedded_at",), is_vector=True),
    TableSpec("health_supplements", "item_embeddings", ("permit_no",), ("embedded_at",), is_vector=True),
    TableSpec("guideline", "guideline_embeddings", ("source_hash",), ("id", "embedded_at"), is_vector=True),
]


@dataclass
class TableResult:
    table: str
    status: str  # PASS | FAIL | SKIP | GOLDEN
    message: str = ""
    row_count: int | None = None
    differences: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Row dump + normalize
# --------------------------------------------------------------------------- #
def normalize_value(v: Any) -> Any:
    """asyncpg returns native types; coerce to JSON-stable representations.

    BIGINT is rendered as string (SNOMED ids exceed JS safe-int — a known
    cross-runtime hazard, plan §4 risk #4). Vectors become (dim, non_null).
    """
    if isinstance(v, (bytes, memoryview)):
        return f"<bytes:{len(bytes(v))}>"
    if isinstance(v, int) and abs(v) > 2**53:
        return str(v)
    return v


async def dump_table(
    conn: asyncpg.Connection, schema: str, spec: TableSpec
) -> list[dict[str, Any]] | None:
    qname = f'"{schema}"."{spec.table}"'
    exists = await conn.fetchval(
        "SELECT to_regclass($1)", f"{schema}.{spec.table}"
    )
    if exists is None:
        return None
    order = ", ".join(f'"{c}"' for c in spec.order_by)
    rows = await conn.fetch(f"SELECT * FROM {qname} ORDER BY {order}")
    out: list[dict[str, Any]] = []
    for row in rows:
        record = {
            k: normalize_value(v)
            for k, v in dict(row).items()
            if k not in spec.ignore
        }
        if spec.is_vector:
            # Structural-only: replace any vector/array col with a fingerprint.
            for k, v in list(record.items()):
                if k in ("embedding", "vector") and v is not None:
                    record[k] = {"dim": _vector_dim(v), "null": False}
        out.append(record)
    return out


def _vector_dim(v: Any) -> int | None:
    try:
        if isinstance(v, str):
            return v.count(",") + 1 if v.strip("[]") else 0
        return len(v)
    except Exception:  # noqa: BLE001
        return None


def diff_rows(left: list[dict], right: list[dict], table: str) -> list[str]:
    diffs: list[str] = []
    if len(left) != len(right):
        diffs.append(f"{table}: row count {len(left)} != {len(right)}")
    for i, (lr, rr) in enumerate(zip(left, right)):
        if lr != rr:
            keys = sorted(set(lr) | set(rr))
            for k in keys:
                if lr.get(k) != rr.get(k):
                    diffs.append(f"{table}[{i}].{k}: {lr.get(k)!r} != {rr.get(k)!r}")
            if len([d for d in diffs if d.startswith(f"{table}[{i}]")]) == 0:
                diffs.append(f"{table}[{i}]: differs")
    return diffs


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #
async def run(args: argparse.Namespace) -> int:
    dsn = args.database_url or os.environ.get("DATABASE_URL")
    if not dsn:
        print("FAIL: --database-url or DATABASE_URL required")
        return 2

    # statement_cache_size=0 to stay pgBouncer-transaction-mode compatible
    # (matches src/database.py). We connect direct, but keep parity of behavior.
    conn = await asyncpg.connect(dsn, statement_cache_size=0)
    print(f"PASS connected ({dsn.split('@')[-1]})")

    results: list[TableResult] = []
    golden: dict[str, Any] = {}

    for spec in TABLE_REGISTRY:
        name = f"{spec.schema}.{spec.table}"
        left_schema = f"{args.left_prefix}{spec.schema}" if args.left_prefix else spec.schema
        try:
            left = await dump_table(conn, left_schema, spec)
        except Exception as exc:  # noqa: BLE001
            results.append(TableResult(name, "FAIL", f"left dump error: {exc}"))
            print(f"FAIL {name}: left dump error: {exc}")
            continue

        if left is None:
            results.append(TableResult(name, "SKIP", "left table absent"))
            print(f"SKIP {name}: left table absent")
            continue

        golden[name] = left

        if not args.right_prefix:
            results.append(TableResult(name, "GOLDEN", "captured", len(left)))
            print(f"GOLDEN {name}: {len(left)} rows")
            continue

        right_schema = f"{args.right_prefix}{spec.schema}"
        try:
            right = await dump_table(conn, right_schema, spec)
        except Exception as exc:  # noqa: BLE001
            results.append(TableResult(name, "SKIP", f"right dump error: {exc}", len(left)))
            print(f"SKIP {name}: right dump error (allowed): {exc}")
            continue
        if right is None:
            results.append(TableResult(name, "SKIP", "right table absent", len(left)))
            print(f"SKIP {name}: right table absent (allowed)")
            continue

        diffs = diff_rows(left, right, name)
        status = "PASS" if not diffs else "FAIL"
        results.append(TableResult(name, status, "", len(left), diffs))
        print(f"{status} {name}: {len(left)} rows" + (f", {len(diffs)} diff(s)" if diffs else ""))
        for d in diffs[:10]:
            print(f"    - {d}")

    await conn.close()

    if args.golden:
        Path(args.golden).write_text(json.dumps(golden, indent=2, ensure_ascii=False, default=str))
        print(f"\nGolden baseline written: {args.golden} ({len(golden)} tables)")
    if args.report:
        Path(args.report).write_text(
            json.dumps([r.__dict__ for r in results], indent=2, ensure_ascii=False)
        )
        print(f"Report written: {args.report}")

    failed = [r for r in results if r.status == "FAIL"]
    print(f"\n{len(results)} tables, {len(failed)} failed")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--left-prefix", default="", help="schema prefix for left/Python loader")
    parser.add_argument("--right-prefix", default="", help="schema prefix for right/Node loader")
    parser.add_argument("--golden", type=Path)
    parser.add_argument("--report", type=Path)
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
