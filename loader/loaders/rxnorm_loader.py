"""
RxNorm Full Release loader.

Expected zip: RxNorm_full_<date>.zip
Key RRF files inside rrf/:
  RXNCONSO.RRF  — concepts and source mappings (pipe-delimited, 18 fields)
  RXNREL.RRF    — relationships (pipe-delimited, 16 fields)

RXNCONSO.RRF columns (0-indexed):
  0  RXCUI   — concept unique identifier
  1  LAT     — language
  2  TS      — term status
  3  LUI     — lexical unique identifier
  4  STT     — string type
  5  SUI     — string unique identifier
  6  ISPREF  — is preferred
  7  RXAUI   — atom unique identifier
  8  SAUI    — source asserted atom identifier
  9  SCUI    — source asserted concept identifier
 10  SDUI    — source asserted descriptor identifier
 11  SAB     — source abbreviation (e.g. RXNORM, MMSL)
 12  TTY     — term type (IN=ingredient, PIN=precise ingredient, BN=brand name, etc.)
 13  CODE    — source code
 14  STR     — string (name)
 15  SRL     — source restriction level
 16  SUPPRESS — suppression flag
 17  CVF     — content view flag

Concept load keeps SAB=RXNORM entries and deduplicates by RXCUI (preferring ISPREF=Y).
ATC mapping load reads SAB=ATC entries from RXNCONSO and stores (RXCUI, ATC code).

RXNREL.RRF columns (0-indexed):
  0  RXCUI1  — first concept
  1  RXAUI1  — atom identifier (unused)
  2  STYPE1  — source type
  3  REL     — relationship type (RO, RB, RN, SY, etc.)
  4  RXCUI2  — second concept
  5  RXAUI2  — atom identifier (unused)
  6  STYPE2  — source type
  7  RELA    — relationship attribute (e.g. has_ingredient, interacts_with)
  8  RUI     — relationship unique identifier
  9  SRUI    — source relationship identifier
 10  SAB     — source
 11  SL      — source of relationship
 12  DIR     — directionality
 13  RG      — relationship group
 14  SUPPRESS
 15  CVF

Relationship load keeps SAB=RXNORM and filters to the relationship types we use.
"""

import io
import re
import zipfile

import asyncpg

BATCH = 10_000
ATC_CODE_RE = re.compile(r"^[A-Z][0-9]{2}[A-Z0-9]{0,4}$")

# TTY values we care about for drug concepts
WANTED_TTY = {"IN", "PIN", "MIN", "BN", "SBD", "SCD", "GPCK", "BPCK"}

# Relationship attributes we care about
WANTED_RELA = {
    "interacts_with",
    "has_ingredient",
    "ingredient_of",
    "has_precise_ingredient",
    "precise_ingredient_of",
    "isa",
    "inverse_isa",
    "constitutes",
    "consists_of",
    "has_tradename",
    "tradename_of",
}


def _normalize_atc_code(raw: str) -> str | None:
    code = (raw or "").strip().upper().replace(" ", "")
    if not code:
        return None
    if not ATC_CODE_RE.match(code):
        return None
    return code


def _find_rrf(zf: zipfile.ZipFile, filename: str) -> str | None:
    """Return zip member path for filename (case-insensitive, inside any subdir)."""
    target = filename.lower()
    for name in zf.namelist():
        if name.lower().endswith(target):
            return name
    return None


def _iter_rrf(zf: zipfile.ZipFile, member: str):
    """Yield pipe-split rows from an RRF file (no header, pipe-delimited)."""
    with zf.open(member) as raw:
        for line in io.TextIOWrapper(raw, encoding="utf-8"):
            line = line.rstrip("\n")
            if line:
                yield line.split("|")


# ── concept loader ──────────────────────────────────────────────────────────


def _load_concepts(zf: zipfile.ZipFile) -> list[tuple]:
    """Return list of (rxcui, name, tty, suppress) — one row per (rxcui, tty) keeping preferred."""
    member = _find_rrf(zf, "RXNCONSO.RRF")
    if member is None:
        raise FileNotFoundError("RXNCONSO.RRF not found in RxNorm zip")

    # Best-row per rxcui: prefer ISPREF=Y, then just last seen
    seen: dict[str, tuple] = {}  # rxcui -> (rxcui, name, tty, suppress)
    for cols in _iter_rrf(zf, member):
        if len(cols) < 17:
            continue
        rxcui = cols[0].strip()
        lat = cols[1].strip()
        ispref = cols[6].strip()
        sab = cols[11].strip()
        tty = cols[12].strip()
        name = cols[14].strip()
        suppress = cols[16].strip()

        if lat != "ENG" or sab != "RXNORM":
            continue
        if tty not in WANTED_TTY:
            continue
        if suppress in ("O", "E"):  # obsolete / excluded
            continue

        key = rxcui
        if key not in seen or ispref == "Y":
            seen[key] = (rxcui, name, tty, suppress or "N")

    return list(seen.values())


# ── relationship loader ─────────────────────────────────────────────────────


def _load_relationships(zf: zipfile.ZipFile, valid_rxcui: set[str]) -> list[tuple]:
    """Return list of (rxcui1, rel, rxcui2, rela)."""
    member = _find_rrf(zf, "RXNREL.RRF")
    if member is None:
        raise FileNotFoundError("RXNREL.RRF not found in RxNorm zip")

    rows = []
    for cols in _iter_rrf(zf, member):
        if len(cols) < 15:
            continue
        rxcui1 = cols[0].strip()
        rel = cols[3].strip()
        rxcui2 = cols[4].strip()
        rela = cols[7].strip()
        sab = cols[10].strip()
        suppress = cols[14].strip()

        if sab != "RXNORM":
            continue
        if suppress in ("O", "E"):
            continue
        if rela and rela not in WANTED_RELA:
            continue
        if rxcui1 not in valid_rxcui or rxcui2 not in valid_rxcui:
            continue

        rows.append((rxcui1, rel, rxcui2, rela or ""))

    return rows


def _load_atc_mappings(zf: zipfile.ZipFile, valid_rxcui: set[str]) -> list[tuple]:
    """Return list of (rxcui, atc_code, atc_name, source_sab, suppress)."""
    member = _find_rrf(zf, "RXNCONSO.RRF")
    if member is None:
        raise FileNotFoundError("RXNCONSO.RRF not found in RxNorm zip")

    seen: dict[tuple[str, str], tuple] = {}
    for cols in _iter_rrf(zf, member):
        if len(cols) < 17:
            continue
        rxcui = cols[0].strip()
        sab = cols[11].strip().upper()
        code = cols[13].strip()
        name = cols[14].strip()
        suppress = cols[16].strip()

        if sab != "ATC":
            continue
        if suppress in ("O", "E"):
            continue
        if rxcui not in valid_rxcui:
            continue

        atc_code = _normalize_atc_code(code)
        if not atc_code:
            continue

        key = (rxcui, atc_code)
        row = (rxcui, atc_code, name or None, sab, suppress or "N")
        # If duplicate pair exists, keep the one with a non-empty ATC name.
        if key not in seen or (not seen[key][2] and row[2]):
            seen[key] = row

    return list(seen.values())


# ── main loader ─────────────────────────────────────────────────────────────


async def _ensure_rxnorm_tables(conn: asyncpg.Connection) -> None:
    """Create drug-domain RxNorm tables/indexes for in-place upgrades."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS drug.rx_concepts (
            rxcui       TEXT PRIMARY KEY,
            name        TEXT,
            tty         TEXT,
            suppress    TEXT
        );
        """
    )
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS drug.rx_relationships (
            rxcui1      TEXT NOT NULL,
            rel         TEXT NOT NULL,
            rxcui2      TEXT NOT NULL,
            rela        TEXT NOT NULL
        );
        """
    )
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS drug.rx_atc_map (
            rxcui       TEXT NOT NULL,
            atc_code    TEXT NOT NULL,
            atc_name    TEXT,
            source_sab  TEXT DEFAULT 'ATC',
            suppress    TEXT,
            PRIMARY KEY (rxcui, atc_code)
        );
        """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_drug_rx_rel_cui1 ON drug.rx_relationships (rxcui1)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_drug_rx_rel_cui2 ON drug.rx_relationships (rxcui2)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_drug_rx_rel_rela ON drug.rx_relationships (rela)"
    )
    await conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uidx_drug_rx_rel_exact
        ON drug.rx_relationships (rxcui1, rel, rxcui2, rela)
        """
    )
    await conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_drug_rx_fts
        ON drug.rx_concepts USING GIN (to_tsvector('english', COALESCE(name, '')))
        """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_drug_rx_atc_code ON drug.rx_atc_map (atc_code)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_drug_rx_atc_cui ON drug.rx_atc_map (rxcui)"
    )


async def load_rxnorm(pool: asyncpg.Pool, zip_path: str) -> None:
    print(f"Parsing {zip_path} ...")

    with zipfile.ZipFile(zip_path) as zf:
        print("  Loading concepts (RXNCONSO.RRF) ...")
        concepts = _load_concepts(zf)
        print(f"  {len(concepts)} RxNorm concepts")

        valid_rxcui = {c[0] for c in concepts}

        print("  Loading relationships (RXNREL.RRF) ...")
        relationships = _load_relationships(zf, valid_rxcui)
        print(f"  {len(relationships)} relationships (filtered)")

        print("  Loading ATC mappings (RXNCONSO SAB=ATC) ...")
        atc_mappings = _load_atc_mappings(zf, valid_rxcui)
        print(f"  {len(atc_mappings)} RxNorm↔ATC mappings")

    print("  Writing to database ...")
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _ensure_rxnorm_tables(conn)
            await conn.execute(
                "TRUNCATE drug.rx_relationships, drug.rx_atc_map, drug.rx_concepts CASCADE"
            )

            print("  Inserting concepts ...")
            for i in range(0, len(concepts), BATCH):
                await conn.executemany(
                    """INSERT INTO drug.rx_concepts (rxcui, name, tty, suppress)
                       VALUES ($1, $2, $3, $4)
                       ON CONFLICT (rxcui) DO UPDATE
                       SET name=$2, tty=$3, suppress=$4""",
                    concepts[i : i + BATCH],
                )

            print("  Inserting relationships ...")
            for i in range(0, len(relationships), BATCH):
                await conn.executemany(
                    """INSERT INTO drug.rx_relationships (rxcui1, rel, rxcui2, rela)
                       VALUES ($1, $2, $3, $4)
                       ON CONFLICT DO NOTHING""",
                    relationships[i : i + BATCH],
                )

            print("  Inserting ATC mappings ...")
            for i in range(0, len(atc_mappings), BATCH):
                await conn.executemany(
                    """INSERT INTO drug.rx_atc_map
                       (rxcui, atc_code, atc_name, source_sab, suppress)
                       VALUES ($1, $2, $3, $4, $5)
                       ON CONFLICT (rxcui, atc_code) DO UPDATE
                       SET atc_name=$3, source_sab=$4, suppress=$5""",
                    atc_mappings[i : i + BATCH],
                )

    print(
        f"  RxNorm loaded: {len(concepts)} concepts, "
        f"{len(relationships)} relationships, "
        f"{len(atc_mappings)} ATC mappings."
    )
