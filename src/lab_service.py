"""
Lab Service — LOINC code lookup and lab result interpretation.
Phase 1: Taiwan common tests (~30 items) seeded via db/seeds/loinc_taiwan_seed.sql
Phase 2: Full LOINC 2.80 loaded via data-loader.
"""

import json
from typing import Dict, List, Literal, Optional

import asyncpg

from cache import cached
from utils import log_error, log_info


class LabService:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM loinc.concepts")
        if count == 0:
            log_error("LOINC table is empty — run data-loader (Phase 2) or seed script first")
        else:
            log_info(f"Lab Service ready ({count} LOINC concepts)")

    # ------------------------------------------------------------------ #
    #  LOINC search                                                         #
    # ------------------------------------------------------------------ #

    @cached(ttl=86400, prefix="lab.search")
    async def search_loinc_code(self, keyword: str, category: Optional[str] = None) -> str:
        async with self.pool.acquire() as conn:
            if category:
                rows = await conn.fetch(
                    """SELECT loinc_num, long_common_name, shortname, name_zh, common_name_zh,
                              class, specimen_type, unit
                       FROM loinc.concepts
                       WHERE to_tsvector('simple',
                               COALESCE(loinc_num,'') || ' ' || COALESCE(long_common_name,'') || ' ' ||
                               COALESCE(shortname,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(common_name_zh,''))
                             @@ plainto_tsquery('simple', $1)
                         AND class ILIKE $2
                       ORDER BY loinc_num LIMIT 20""",
                    keyword, f"%{category}%",
                )
            else:
                rows = await conn.fetch(
                    """SELECT loinc_num, long_common_name, shortname, name_zh, common_name_zh,
                              class, specimen_type, unit
                       FROM loinc.concepts
                       WHERE to_tsvector('simple',
                               COALESCE(loinc_num,'') || ' ' || COALESCE(long_common_name,'') || ' ' ||
                               COALESCE(shortname,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(common_name_zh,''))
                             @@ plainto_tsquery('simple', $1)
                          OR loinc_num ILIKE $2
                       ORDER BY loinc_num LIMIT 20""",
                    keyword, f"%{keyword}%",
                )

        if not rows:
            return json.dumps(
                {"message": f"找不到符合 '{keyword}' 的檢驗項目",
                 "suggestion": "請嘗試使用中文名稱、英文名稱或常用縮寫"},
                ensure_ascii=False,
            )
        return json.dumps(
            {"keyword": keyword, "total_found": len(rows), "results": [dict(r) for r in rows]},
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="lab.categories")
    async def list_categories(self) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT class FROM loinc.concepts WHERE class IS NOT NULL ORDER BY class"
            )
        categories = [r["class"] for r in rows]
        return json.dumps(
            {"total_categories": len(categories), "categories": categories},
            ensure_ascii=False,
        )

    # ------------------------------------------------------------------ #
    #  Reference ranges                                                    #
    # ------------------------------------------------------------------ #

    @cached(ttl=86400, prefix="lab.refrange")
    async def get_reference_range(
        self, loinc_num: str, age: int, gender: Literal["M", "F", "all"] = "all"
    ) -> str:
        async with self.pool.acquire() as conn:
            concept = await conn.fetchrow(
                "SELECT loinc_num, long_common_name, name_zh, common_name_zh, unit FROM loinc.concepts WHERE loinc_num = $1",
                loinc_num,
            )
            if not concept:
                return json.dumps({"error": f"找不到 LOINC 碼: {loinc_num}"}, ensure_ascii=False)

            ref = await conn.fetchrow(
                """SELECT range_low, range_high, unit, interpretation, age_min, age_max, gender
                   FROM loinc.reference_ranges
                   WHERE loinc_num = $1 AND age_min <= $2 AND age_max >= $2
                     AND (gender = $3 OR gender = 'all')
                   ORDER BY CASE gender WHEN $3 THEN 1 ELSE 2 END, age_min DESC
                   LIMIT 1""",
                loinc_num, age, gender,
            )

        if not ref:
            return json.dumps(
                {
                    "loinc_num": loinc_num,
                    "test_name_zh": concept["name_zh"],
                    "message": f"找不到適用於年齡 {age} 歲、性別 {gender} 的參考值",
                    "unit": concept["unit"],
                },
                ensure_ascii=False,
            )

        return json.dumps(
            {
                "loinc_num": loinc_num,
                "test_name_zh": concept["name_zh"],
                "test_name_en": concept["long_common_name"],
                "common_name": concept["common_name_zh"],
                "reference_range": {
                    "low": float(ref["range_low"]) if ref["range_low"] is not None else None,
                    "high": float(ref["range_high"]) if ref["range_high"] is not None else None,
                    "unit": ref["unit"],
                    "interpretation": ref["interpretation"],
                },
                "applicable_to": {
                    "age_range": f"{ref['age_min']}-{ref['age_max']} 歲",
                    "gender": "男性" if ref["gender"] == "M" else "女性" if ref["gender"] == "F" else "不分性別",
                },
            },
            ensure_ascii=False,
        )

    # ------------------------------------------------------------------ #
    #  Interpretation                                                       #
    # ------------------------------------------------------------------ #

    async def interpret_lab_result(
        self, loinc_num: str, value: float, age: int, gender: Literal["M", "F", "all"] = "all"
    ) -> str:
        ref_data = json.loads(await self.get_reference_range(loinc_num, age, gender))
        if "error" in ref_data or "message" in ref_data:
            return json.dumps(ref_data, ensure_ascii=False)

        ref_range = ref_data["reference_range"]
        low, high = ref_range["low"], ref_range["high"]

        if low is not None and value < low:
            status, flag, note = "偏低 (Low)", "L", "低於正常參考值，建議進一步評估"
        elif high is not None and value > high:
            status, flag, note = "偏高 (High)", "H", "高於正常參考值，建議進一步評估"
        else:
            status, flag, note = "正常 (Normal)", "N", "數值在正常範圍內"

        return json.dumps(
            {
                "loinc_num": loinc_num,
                "test_name_zh": ref_data["test_name_zh"],
                "test_name_en": ref_data["test_name_en"],
                "result": {"value": value, "unit": ref_range["unit"], "status": status, "flag": flag},
                "reference_range": {"low": low, "high": high, "unit": ref_range["unit"]},
                "interpretation": note,
                "applicable_to": ref_data["applicable_to"],
            },
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="lab.specimen")
    async def search_by_specimen(self, specimen_type: str) -> str:
        """Find LOINC tests by specimen type (e.g., 血清/血漿, 全血, Urine, Ser/Plas)."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT loinc_num, long_common_name, name_zh, common_name_zh,
                          specimen_type, component, class, unit
                   FROM loinc.concepts
                   WHERE specimen_type ILIKE $1
                     AND status = 'ACTIVE'
                   ORDER BY class, loinc_num
                   LIMIT 50""",
                f"%{specimen_type}%",
            )
        if not rows:
            return json.dumps(
                {"message": f"找不到檢體類型 '{specimen_type}' 的檢驗項目",
                 "hint": "常見值: 血清/血漿, 全血, Urine, Ser/Plas, Bld"},
                ensure_ascii=False,
            )
        return json.dumps(
            {"specimen_type": specimen_type, "total_found": len(rows),
             "results": [dict(r) for r in rows]},
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="lab.related")
    async def find_related_tests(self, component: str) -> str:
        """Find all LOINC tests sharing the same component (analyte), grouped by system."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT loinc_num, component, property, time_aspect, system,
                          scale_type, method_type, long_common_name, name_zh, unit
                   FROM loinc.concepts
                   WHERE component ILIKE $1
                   ORDER BY system, time_aspect, method_type
                   LIMIT 60""",
                f"%{component}%",
            )
        if not rows:
            return json.dumps(
                {"message": f"找不到含有 '{component}' 的 LOINC 檢驗項目"},
                ensure_ascii=False,
            )
        # Group by system
        by_system: dict[str, list] = {}
        for r in rows:
            sys = r["system"] or "Unknown"
            by_system.setdefault(sys, []).append({
                "loinc_num": r["loinc_num"],
                "long_common_name": r["long_common_name"],
                "name_zh": r["name_zh"],
                "property": r["property"],
                "time_aspect": r["time_aspect"],
                "method_type": r["method_type"],
                "scale_type": r["scale_type"],
                "unit": r["unit"],
            })
        return json.dumps(
            {"component": component, "total_found": len(rows), "by_system": by_system},
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="lab.friendly")
    async def get_patient_friendly_name(self, loinc_num: str) -> str:
        """Return patient-friendly test name, LOINC axes, and consumer name if available."""
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT loinc_num, long_common_name, shortname, name_zh, common_name_zh,
                          consumer_name, component, property, time_aspect, system,
                          scale_type, method_type, specimen_type, unit, class, status
                   FROM loinc.concepts WHERE loinc_num = $1""",
                loinc_num,
            )
        if not row:
            return json.dumps({"error": f"找不到 LOINC 碼: {loinc_num}"}, ensure_ascii=False)
        d = dict(row)
        # consumer_name is empty in current dataset; fall back to common_name_zh or shortname
        d["display_name"] = (
            d.get("consumer_name") or d.get("common_name_zh") or
            d.get("shortname") or d.get("long_common_name")
        )
        return json.dumps(d, ensure_ascii=False)

    async def batch_interpret_results(
        self,
        results: List[Dict],
        age: int,
        gender: Literal["M", "F", "all"] = "all",
    ) -> str:
        interpretations = []
        abnormal_count = 0

        for item in results:
            loinc_num = item.get("loinc_code") or item.get("loinc_num")
            value = item.get("value")
            if not loinc_num or value is None:
                continue
            interp = json.loads(await self.interpret_lab_result(loinc_num, float(value), age, gender))
            if "error" not in interp and "message" not in interp:
                interpretations.append(interp)
                if interp["result"]["flag"] != "N":
                    abnormal_count += 1

        return json.dumps(
            {
                "total_tests": len(interpretations),
                "abnormal_count": abnormal_count,
                "normal_count": len(interpretations) - abnormal_count,
                "patient_info": {"age": age, "gender": "男性" if gender == "M" else "女性" if gender == "F" else "不分性別"},
                "results": interpretations,
            },
            ensure_ascii=False,
        )
