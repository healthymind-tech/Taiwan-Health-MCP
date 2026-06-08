"""RxNorm Full Release RRF parsing — concept-only, for IG ValueSet expansion.

Reads ``RXNCONSO.RRF`` from a ``RxNorm_full_<date>.zip`` and returns one concept
row per RXCUI (SAB=RXNORM, preferring the ISPREF=Y atom). Relationships
(``RXNREL.RRF``) are intentionally ignored — this terminology is loaded purely
so that admin previews can expand ValueSet filters like
``TTY in (SCD,SBD,GPCK,BPCK)`` into real codes.

RXNCONSO.RRF columns (0-indexed, pipe-delimited, no header):
   0  RXCUI    — concept unique identifier
   6  ISPREF   — Y when this atom is the preferred one for the RXCUI
  11  SAB      — source abbreviation (we keep SAB=RXNORM)
  12  TTY      — term type (IN, PIN, BN, SBD, SCD, GPCK, BPCK, …)
  14  STR      — string (concept name)
  16  SUPPRESS — suppression flag (N/O/Y/E)
"""

from __future__ import annotations

import io
import zipfile

# RXNCONSO column indices we read.
_RXCUI, _ISPREF, _SAB, _TTY, _STR, _SUPPRESS = 0, 6, 11, 12, 14, 16
_MIN_COLS = 17

RxnormConceptRow = tuple[int, str, str, str | None]  # (rxcui, name, tty, suppress)


def _find_rrf(zf: zipfile.ZipFile, filename: str) -> str | None:
    """Return the zip member path ending in ``filename`` (case-insensitive)."""
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


def load_rxnorm_concepts(zip_path: str) -> list[RxnormConceptRow]:
    """Parse RXNCONSO.RRF and return one row per RXCUI (SAB=RXNORM).

    For each RXCUI the preferred atom (ISPREF=Y) wins; otherwise the first atom
    seen is kept. Returns ``(rxcui, name, tty, suppress)`` tuples.
    """
    with zipfile.ZipFile(zip_path) as zf:
        member = _find_rrf(zf, "RXNCONSO.RRF")
        if member is None:
            raise FileNotFoundError("RXNCONSO.RRF not found in RxNorm zip")

        # rxcui -> (row, is_preferred). A preferred atom replaces a non-preferred one.
        best: dict[int, tuple[RxnormConceptRow, bool]] = {}
        for cols in _iter_rrf(zf, member):
            if len(cols) < _MIN_COLS:
                continue
            if cols[_SAB] != "RXNORM":
                continue
            name = (cols[_STR] or "").strip()
            if not name:
                continue
            try:
                rxcui = int(cols[_RXCUI])
            except (TypeError, ValueError):
                continue
            is_pref = cols[_ISPREF] == "Y"
            row: RxnormConceptRow = (
                rxcui,
                name,
                (cols[_TTY] or "").strip(),
                (cols[_SUPPRESS] or "").strip() or None,
            )
            existing = best.get(rxcui)
            if existing is None or (is_pref and not existing[1]):
                best[rxcui] = (row, is_pref)

    return [row for row, _ in best.values()]
