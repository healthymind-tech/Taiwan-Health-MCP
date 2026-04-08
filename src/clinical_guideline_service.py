"""
Clinical Guideline Service — Taiwan Medical Society clinical practice guidelines.
Data seeded via data-loader from db/seeds/guideline_seed.py.
"""

import json
import re
from typing import Dict, Optional

import asyncpg

from cache import cached
from utils import log_error, log_info


class ClinicalGuidelineService:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM guideline.disease_guidelines")
        if count == 0:
            log_error("Clinical guideline table is empty — run data-loader seed script first")
        else:
            log_info(f"Clinical Guideline Service ready ({count} guidelines)")

    @cached(ttl=86400, prefix="gl.search")
    async def search_guideline(self, keyword: str) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT id, icd_code, disease_name_zh, disease_name_en,
                          guideline_title, guideline_source, publication_year
                   FROM guideline.disease_guidelines
                   WHERE icd_code ILIKE $1
                      OR to_tsvector('simple', COALESCE(disease_name_zh,'') || ' ' || COALESCE(disease_name_en,''))
                         @@ plainto_tsquery('simple', $2)
                   ORDER BY publication_year DESC""",
                f"%{keyword}%", keyword,
            )
        if not rows:
            return json.dumps(
                {"message": f"找不到符合 '{keyword}' 的診療指引",
                 "suggestion": "請使用疾病中文名稱或 ICD-10 編碼搜尋"},
                ensure_ascii=False,
            )
        return json.dumps(
            {"keyword": keyword, "total_found": len(rows), "guidelines": [dict(r) for r in rows]},
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="gl.full")
    async def get_complete_guideline(self, icd_code: str) -> str:
        async with self.pool.acquire() as conn:
            guideline = await conn.fetchrow(
                "SELECT * FROM guideline.disease_guidelines WHERE icd_code = $1 OR icd_code ILIKE $2",
                icd_code, f"{icd_code}%",
            )
            if not guideline:
                return json.dumps({"error": f"找不到 ICD 碼 '{icd_code}' 的診療指引"}, ensure_ascii=False)

            gid = guideline["id"]
            diagnostics = await conn.fetch(
                "SELECT * FROM guideline.diagnostic_recommendations WHERE guideline_id = $1 ORDER BY step_order", gid
            )
            medications = await conn.fetch(
                "SELECT * FROM guideline.medication_recommendations WHERE guideline_id = $1 ORDER BY line_of_therapy", gid
            )
            tests = await conn.fetch(
                "SELECT * FROM guideline.test_recommendations WHERE guideline_id = $1 ORDER BY test_category", gid
            )
            goals = await conn.fetch(
                "SELECT * FROM guideline.treatment_goals WHERE guideline_id = $1 ORDER BY goal_type", gid
            )

        return json.dumps(
            {
                "guideline_info": {
                    "icd_code": guideline["icd_code"],
                    "disease_name_zh": guideline["disease_name_zh"],
                    "disease_name_en": guideline["disease_name_en"],
                    "title": guideline["guideline_title"],
                    "source": guideline["guideline_source"],
                    "year": guideline["publication_year"],
                    "summary": guideline["guideline_summary"],
                },
                "diagnostic_recommendations": [dict(r) for r in diagnostics],
                "medication_recommendations": [dict(r) for r in medications],
                "test_recommendations": [dict(r) for r in tests],
                "treatment_goals": [dict(r) for r in goals],
            },
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="gl.meds")
    async def get_medication_recommendations(self, icd_code: str) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT mr.* FROM guideline.medication_recommendations mr
                   JOIN guideline.disease_guidelines dg ON mr.guideline_id = dg.id
                   WHERE dg.icd_code = $1 OR dg.icd_code ILIKE $2
                   ORDER BY mr.line_of_therapy""",
                icd_code, f"{icd_code}%",
            )
        if not rows:
            return json.dumps({"message": f"找不到 ICD 碼 '{icd_code}' 的用藥建議"}, ensure_ascii=False)
        return json.dumps(
            {"icd_code": icd_code, "total_recommendations": len(rows), "medications": [dict(r) for r in rows]},
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="gl.tests")
    async def get_test_recommendations(self, icd_code: str) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT tr.* FROM guideline.test_recommendations tr
                   JOIN guideline.disease_guidelines dg ON tr.guideline_id = dg.id
                   WHERE dg.icd_code = $1 OR dg.icd_code ILIKE $2
                   ORDER BY tr.test_category""",
                icd_code, f"{icd_code}%",
            )
        if not rows:
            return json.dumps({"message": f"找不到 ICD 碼 '{icd_code}' 的檢查建議"}, ensure_ascii=False)
        return json.dumps(
            {"icd_code": icd_code, "total_recommendations": len(rows), "tests": [dict(r) for r in rows]},
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="gl.goals")
    async def get_treatment_goals(self, icd_code: str) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT tg.* FROM guideline.treatment_goals tg
                   JOIN guideline.disease_guidelines dg ON tg.guideline_id = dg.id
                   WHERE dg.icd_code = $1 OR dg.icd_code ILIKE $2
                   ORDER BY tg.goal_type""",
                icd_code, f"{icd_code}%",
            )
        if not rows:
            return json.dumps({"message": f"找不到 ICD 碼 '{icd_code}' 的治療目標"}, ensure_ascii=False)
        return json.dumps(
            {"icd_code": icd_code, "total_goals": len(rows), "goals": [dict(r) for r in rows]},
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="gl.contraind")
    async def check_medication_contraindications(
        self, icd_code: str, medication_class: str
    ) -> str:
        """
        Given a diagnosis ICD code and a medication class, return all matching
        guideline recommendations and flag any contraindications.
        """
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT mr.line_of_therapy, mr.medication_class, mr.medication_examples,
                          mr.dosage_guidance, mr.contraindications, mr.evidence_level
                   FROM guideline.medication_recommendations mr
                   JOIN guideline.disease_guidelines dg ON mr.guideline_id = dg.id
                   WHERE (dg.icd_code = $1 OR dg.icd_code ILIKE $2)
                     AND (mr.medication_class ILIKE $3 OR mr.medication_examples ILIKE $3)
                   ORDER BY mr.line_of_therapy""",
                icd_code, f"{icd_code}%", f"%{medication_class}%",
            )
            # Also get all meds for that ICD to show broader context
            all_meds = await conn.fetch(
                """SELECT mr.line_of_therapy, mr.medication_class, mr.contraindications
                   FROM guideline.medication_recommendations mr
                   JOIN guideline.disease_guidelines dg ON mr.guideline_id = dg.id
                   WHERE dg.icd_code = $1 OR dg.icd_code ILIKE $2
                   ORDER BY mr.line_of_therapy""",
                icd_code, f"{icd_code}%",
            )

        matched = [dict(r) for r in rows]
        all_contraindications = [
            {"medication_class": r["medication_class"], "contraindications": r["contraindications"]}
            for r in all_meds if r["contraindications"]
        ]

        return json.dumps(
            {
                "icd_code": icd_code,
                "queried_medication": medication_class,
                "matched_recommendations": matched,
                "all_contraindications_for_diagnosis": all_contraindications,
                "warning": "請由醫師或藥師依個別病患情況判斷用藥禁忌",
            },
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="gl.linkdrugs")
    async def link_guideline_to_drugs(self, icd_code: str) -> str:
        """
        Cross-reference guideline medication examples with Taiwan FDA approved drugs.
        Returns guideline-recommended drug classes matched to actual licensed products.
        """
        async with self.pool.acquire() as conn:
            med_rows = await conn.fetch(
                """SELECT mr.line_of_therapy, mr.medication_class,
                          mr.medication_examples, mr.evidence_level
                   FROM guideline.medication_recommendations mr
                   JOIN guideline.disease_guidelines dg ON mr.guideline_id = dg.id
                   WHERE dg.icd_code = $1 OR dg.icd_code ILIKE $2
                   ORDER BY mr.line_of_therapy""",
                icd_code, f"{icd_code}%",
            )
            if not med_rows:
                return json.dumps(
                    {"error": f"找不到 ICD 碼 '{icd_code}' 的診療指引"}, ensure_ascii=False
                )

            results = []
            for med in med_rows:
                # Split medication_examples by comma/space and search each
                examples_raw = med["medication_examples"] or ""
                # Extract individual drug names (comma/slash/space separated)
                names = [n.strip() for n in re.split(r"[,、/；;]", examples_raw) if n.strip()]

                fda_matches = []
                for name in names[:5]:  # limit to first 5 per row
                    if len(name) < 2:
                        continue
                    drug_rows = await conn.fetch(
                        """SELECT license_id, name_zh, name_en, indication
                           FROM drug.licenses
                           WHERE to_tsvector('simple',
                                   COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                                 @@ plainto_tsquery('simple', $1)
                           LIMIT 3""",
                        name,
                    )
                    if drug_rows:
                        fda_matches.extend([{**dict(r), "matched_from": name} for r in drug_rows])

                results.append({
                    "line_of_therapy": med["line_of_therapy"],
                    "medication_class": med["medication_class"],
                    "medication_examples": examples_raw,
                    "evidence_level": med["evidence_level"],
                    "fda_approved_matches": fda_matches,
                })

        return json.dumps(
            {"icd_code": icd_code, "medications": results,
             "note": "以衛福部核准藥品許可證資料庫比對，結果僅供參考"},
            ensure_ascii=False,
        )

    async def suggest_clinical_pathway(
        self, icd_code: str, patient_context: Optional[Dict] = None
    ) -> str:
        guideline_data = json.loads(await self.get_complete_guideline(icd_code))
        if "error" in guideline_data:
            return json.dumps(guideline_data, ensure_ascii=False)

        clinical_pathway = {
            "disease": guideline_data["guideline_info"]["disease_name_zh"],
            "icd_code": icd_code,
            "pathway": {
                "step1_diagnosis": {
                    "phase": "診斷確認階段",
                    "actions": [r["description"] for r in guideline_data["diagnostic_recommendations"]],
                },
                "step2_baseline_tests": {
                    "phase": "基礎檢查階段",
                    "actions": [
                        f"{t['test_name']} ({t['indication']})"
                        for t in guideline_data["test_recommendations"]
                        if "診斷" in (t.get("indication") or "") or "基礎" in (t.get("indication") or "")
                    ],
                },
                "step3_treatment_initiation": {
                    "phase": "治療啟始階段",
                    "actions": [
                        f"第一線用藥: {m['medication_class']} (例如: {m['medication_examples']})"
                        for m in guideline_data["medication_recommendations"]
                        if "第一線" in (m.get("line_of_therapy") or "")
                    ],
                },
                "step4_monitoring": {
                    "phase": "追蹤監測階段",
                    "actions": [
                        f"{t['test_name']} - {t['frequency']}"
                        for t in guideline_data["test_recommendations"]
                        if "追蹤" in (t.get("indication") or "") or "監測" in (t.get("indication") or "")
                    ],
                },
                "step5_treatment_goals": {
                    "phase": "治療目標",
                    "targets": [
                        f"{g['target_parameter']}: {g['target_value']}"
                        for g in guideline_data["treatment_goals"]
                    ],
                },
            },
            "guideline_source": guideline_data["guideline_info"]["source"],
            "guideline_year": guideline_data["guideline_info"]["year"],
        }

        if patient_context:
            clinical_pathway["patient_context"] = patient_context
            clinical_pathway["note"] = "臨床路徑應根據個別患者情況調整"

        return json.dumps(clinical_pathway, ensure_ascii=False)
