"""
Drug Interaction Service — RxNorm-based drug-drug interaction lookup.
Data pre-loaded into PostgreSQL from RxNorm full release by data-loader.

Interaction detection strategy:
  1. Resolve each drug name → RxNorm ingredient RXCUIs
  2. Query rxnorm.relationships for rela='interacts_with' between the ingredients
  3. Return matched pairs with context from the relationship data
"""

from typing import Any

import asyncpg

from cache import cached
from utils import log_error, log_info

# RxNorm term type constants
TTY_IN = "IN"  # Ingredient
TTY_PIN = "PIN"  # Precise Ingredient
TTY_MIN = "MIN"  # Multiple Ingredients
TTY_BN = "BN"  # Brand Name

# TTY hierarchy for ingredient resolution: IN > PIN > others
INGREDIENT_TTY = {"IN", "PIN", "MIN"}


class DrugInteractionService:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM rxnorm.concepts")
        if count == 0:
            log_error("RxNorm table empty — run data-loader (--rxnorm) first")
        else:
            inter_count = await self.pool.fetchval(
                "SELECT COUNT(*) FROM rxnorm.relationships WHERE rela = 'interacts_with'"
            )
            log_info(f"DrugInteractionService ready — {count:,} concepts, {inter_count:,} interactions")

    # ── name → RXCUI resolution ────────────────────────────────────────────

    @cached(ttl=3600, prefix="rxn:resolve")
    async def resolve_drug(self, drug_name: str) -> list[dict[str, Any]]:
        """Resolve a drug name to RxNorm concepts (prioritizes IN/PIN/MIN)."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT rxcui, name, tty
                FROM rxnorm.concepts
                WHERE to_tsvector('english', name) @@ plainto_tsquery('english', $1)
                ORDER BY
                    CASE tty
                        WHEN 'IN'  THEN 0
                        WHEN 'PIN' THEN 1
                        WHEN 'MIN' THEN 2
                        WHEN 'BN'  THEN 3
                        ELSE 9
                    END,
                    length(name)
                LIMIT 10
                """,
                drug_name,
            )
        return [{"rxcui": r["rxcui"], "name": r["name"], "tty": r["tty"]} for r in rows]

    async def _get_ingredient_rxcuis(self, rxcui: str) -> set[str]:
        """
        Given a drug RXCUI, return its ingredient-level RXCUIs.
        If the concept is already an ingredient, returns {rxcui}.
        Otherwise follows has_ingredient relationships.
        """
        async with self.pool.acquire() as conn:
            tty = await conn.fetchval(
                "SELECT tty FROM rxnorm.concepts WHERE rxcui = $1", rxcui
            )
            if tty in INGREDIENT_TTY:
                return {rxcui}

            # Traverse has_ingredient relationships
            rows = await conn.fetch(
                """
                SELECT rxcui2 FROM rxnorm.relationships
                WHERE rxcui1 = $1 AND rela = 'has_ingredient'
                """,
                rxcui,
            )
            if rows:
                return {r["rxcui2"] for r in rows}
            return {rxcui}

    # ── interaction check ──────────────────────────────────────────────────

    @cached(ttl=3600, prefix="rxn:interactions")
    async def check_interactions(
        self,
        drug_names: list[str],
    ) -> dict[str, Any]:
        """
        Check for drug-drug interactions among a list of drug names.
        Returns resolved drugs, any interactions found, and drugs that couldn't be resolved.
        """
        resolved: list[dict] = []
        unresolved: list[str] = []

        # Step 1: resolve each drug name
        for name in drug_names:
            candidates = await self.resolve_drug(name)
            if candidates:
                # Take the first (best) match
                resolved.append({"input": name, **candidates[0]})
            else:
                unresolved.append(name)

        if len(resolved) < 2:
            return {
                "resolved_drugs": resolved,
                "unresolved_drugs": unresolved,
                "interactions": [],
                "note": "Need at least 2 resolvable drugs to check interactions",
            }

        # Step 2: for each resolved drug, get its ingredient RXCUIs
        drug_ingredients: dict[str, set[str]] = {}
        for drug in resolved:
            ing_set = await self._get_ingredient_rxcuis(drug["rxcui"])
            drug_ingredients[drug["rxcui"]] = ing_set

        # Step 3: check all pairs for interacts_with
        interactions: list[dict] = []
        drug_list = resolved[:]
        async with self.pool.acquire() as conn:
            for i in range(len(drug_list)):
                for j in range(i + 1, len(drug_list)):
                    drug_a = drug_list[i]
                    drug_b = drug_list[j]
                    ings_a = drug_ingredients[drug_a["rxcui"]]
                    ings_b = drug_ingredients[drug_b["rxcui"]]

                    for ing_a in ings_a:
                        for ing_b in ings_b:
                            rows = await conn.fetch(
                                """
                                SELECT rxcui1, rxcui2, rel, rela
                                FROM rxnorm.relationships
                                WHERE rela = 'interacts_with'
                                  AND ((rxcui1 = $1 AND rxcui2 = $2)
                                    OR (rxcui1 = $2 AND rxcui2 = $1))
                                LIMIT 1
                                """,
                                ing_a, ing_b,
                            )
                            if rows:
                                # Get names for the ingredient RXCUIs
                                name_a = await conn.fetchval(
                                    "SELECT name FROM rxnorm.concepts WHERE rxcui = $1", ing_a
                                )
                                name_b = await conn.fetchval(
                                    "SELECT name FROM rxnorm.concepts WHERE rxcui = $1", ing_b
                                )
                                interactions.append({
                                    "drug_a": {
                                        "input": drug_a["input"],
                                        "rxcui": drug_a["rxcui"],
                                        "name": drug_a["name"],
                                        "ingredient": {"rxcui": ing_a, "name": name_a},
                                    },
                                    "drug_b": {
                                        "input": drug_b["input"],
                                        "rxcui": drug_b["rxcui"],
                                        "name": drug_b["name"],
                                        "ingredient": {"rxcui": ing_b, "name": name_b},
                                    },
                                    "interaction_type": "interacts_with",
                                    "severity": "unknown",
                                    "source": "RxNorm",
                                })

        return {
            "resolved_drugs": resolved,
            "unresolved_drugs": unresolved,
            "interaction_count": len(interactions),
            "interactions": interactions,
        }

    # ── ingredient lookup ──────────────────────────────────────────────────

    @cached(ttl=3600, prefix="rxn:ingredients")
    async def get_drug_ingredients(self, rxcui: str) -> dict[str, Any] | None:
        """Return a drug concept and all its ingredient relationships."""
        async with self.pool.acquire() as conn:
            concept = await conn.fetchrow(
                "SELECT rxcui, name, tty FROM rxnorm.concepts WHERE rxcui = $1", rxcui
            )
            if not concept:
                return None

            ingredients = await conn.fetch(
                """
                SELECT c.rxcui, c.name, c.tty
                FROM rxnorm.relationships r
                JOIN rxnorm.concepts c ON c.rxcui = r.rxcui2
                WHERE r.rxcui1 = $1 AND r.rela = 'has_ingredient'
                """,
                rxcui,
            )

        return {
            "rxcui":       concept["rxcui"],
            "name":        concept["name"],
            "tty":         concept["tty"],
            "ingredients": [
                {"rxcui": r["rxcui"], "name": r["name"], "tty": r["tty"]}
                for r in ingredients
            ],
        }
