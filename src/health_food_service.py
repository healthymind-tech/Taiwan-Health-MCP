"""
Health Food Service — Taiwan FDA approved health foods.
Data is loaded via data-loader (--health-food or --fda flag). No auto-sync.

Sync strategy: fetch data first, then write in one transaction.
"""

import asyncio
import json
import re
from datetime import datetime, timezone

import asyncpg
import httpx

from cache import cached
from embedding_service import EmbeddingService
from utils import log_error, log_info

API_SOURCE = "https://data.fda.gov.tw/data/opendata/export/19/json"

DISEASE_BENEFIT_MAPPING = {
    "E11": ["調節血糖", "延緩血糖上升"],
    "E10": ["調節血糖", "延緩血糖上升"],
    "E78": ["調節血脂", "不易形成體脂肪"],
    "E66": ["不易形成體脂肪", "調節血脂"],
    "E79": ["調節尿酸"],
    "I10": ["調節血脂", "心血管保健"],
    "I25": ["調節血脂", "心血管保健"],
    "I21": ["調節血脂", "心血管保健"],
    "K70": ["護肝"],
    "K71": ["護肝"],
    "K72": ["護肝"],
    "K73": ["護肝"],
    "K74": ["護肝"],
    "K76": ["護肝"],
    "M80": ["骨質保健", "促進鈣吸收"],
    "M81": ["骨質保健", "促進鈣吸收"],
    "M15": ["關節保健"],
    "M17": ["關節保健"],
    "K59": ["胃腸功能改善", "促進腸道有益菌增生"],
    "K29": ["胃腸功能改善"],
    "K21": ["胃腸功能改善"],
    "D84": ["免疫調節"],
    "J06": ["免疫調節"],
    "H52": ["護眼保健", "調節視覺"],
    "H53": ["護眼保健"],
    "N40": ["促進泌尿道保健"],
    "N39": ["促進泌尿道保健"],
    "K02": ["牙齒保健", "促進釋放齒垢"],
    "K05": ["牙齒保健"],
    "L70": ["調節免疫", "皮膚保健"],
}


class HealthFoodService:
    def __init__(
        self, pool: asyncpg.Pool, embedding_svc: EmbeddingService | None = None
    ):
        self.pool = pool
        self._embedding_svc = embedding_svc
        self._sync_lock = asyncio.Lock()

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM health_food.items")
        if count == 0:
            log_info(
                "Health food DB empty — run data-loader --health-food to load data"
            )
        else:
            log_info("Health Food Service ready", items=count)

    async def shutdown(self) -> None:
        """Gracefully stop the service. No-op; provided for lifecycle symmetry."""
        pass

    async def _sync(self) -> None:
        if self._sync_lock.locked():
            log_info("Health food sync already in progress — skipping duplicate run")
            return
        async with self._sync_lock:
            await self._do_sync()

    async def _do_sync(self) -> None:
        log_info("Health food sync started")
        try:
            # Step 1: fetch data
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.get(API_SOURCE)
                resp.raise_for_status()
                ct = resp.headers.get("content-type", "")
                if "zip" in ct:
                    import io
                    import zipfile

                    zf = zipfile.ZipFile(io.BytesIO(resp.content))
                    names = [n for n in zf.namelist() if n.endswith(".json")]
                    data = json.loads(zf.read(names[0])) if names else []
                else:
                    data = resp.json()

            # Step 2: write atomically
            rows = [
                (
                    r.get("許可證字號", ""),
                    r.get("中文品名", ""),
                    r.get("申請商", ""),
                    r.get("保健功效", ""),
                    r.get("核可日期", ""),
                    "",
                    r.get("類別", ""),
                )
                for r in data
            ]

            BATCH = 2000
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute("TRUNCATE health_food.items")
                    for i in range(0, len(rows), BATCH):
                        await conn.executemany(
                            """INSERT INTO health_food.items
                               (permit_no, name, applicant, benefit_claims, valid_from, valid_to, category)
                               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
                            rows[i : i + BATCH],
                        )
                    await conn.execute(
                        """INSERT INTO health_food.sync_meta (key, value, updated_at)
                           VALUES ('last_updated', $1, NOW())
                           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()""",
                        datetime.now(tz=timezone.utc).isoformat(),
                    )
            log_info("Health food sync completed", items=len(rows))
            if self._embedding_svc and self._embedding_svc.enabled:
                asyncio.create_task(self._generate_embeddings())
        except Exception as e:
            log_error("Health food sync failed", error=str(e))

    async def _generate_embeddings(self) -> None:
        """Embed all health food items into pgvector table (background task)."""
        if not self._embedding_svc:
            return
        svc = self._embedding_svc
        try:
            async with self.pool.acquire() as conn:
                items = await conn.fetch(
                    "SELECT permit_no, name, benefit_claims FROM health_food.items"
                )
            log_info("Health food: embedding items", count=len(items))
            from embedding_service import BATCH_SIZE

            for i in range(0, len(items), BATCH_SIZE):
                batch = items[i : i + BATCH_SIZE]
                texts = [
                    " ".join(filter(None, [r["name"], r["benefit_claims"]]))
                    for r in batch
                ]
                vecs = await svc.embed_batch(texts)
                rows = [
                    (batch[j]["permit_no"], f"[{','.join(str(x) for x in vecs[j])}]")
                    for j in range(len(batch))
                    if vecs[j] is not None
                ]
                if rows:
                    async with self.pool.acquire() as conn:
                        await conn.executemany(
                            """INSERT INTO health_food.item_embeddings (permit_no, embedding)
                               VALUES ($1, $2::halfvec)
                               ON CONFLICT (permit_no) DO UPDATE
                               SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                            rows,
                        )
            log_info("Health food: embeddings done", total=len(items))
        except Exception as exc:
            log_error("Health food embedding generation failed", error=str(exc))

    # ── query methods ────────────────────────────────────────────────────────

    @cached(ttl=3600, prefix="hf.search")
    async def search_health_food(self, keyword: str, limit: int = 3) -> str:
        """Search Taiwan FDA approved health foods by name or claimed benefit.

        Args:
            keyword: Product name or benefit keyword
                (e.g. ``"魚油"``, ``"調節血脂"``).
            limit: Maximum number of results to return (default 3, max 10).
                   Returns the top *limit* closest matches ranked by hybrid
                   BM25 + semantic similarity — not just keyword matches.

        Returns:
            JSON string with a ``results`` list of the closest matching health food records.
        """
        limit = min(max(1, limit), 10)
        vec = await self._embedding_svc.embed(keyword) if self._embedding_svc else None
        vec_str = f"[{','.join(str(x) for x in vec)}]" if vec else None

        async with self.pool.acquire() as conn:
            if vec_str:
                rows = await conn.fetch(
                    """WITH fts AS (
                           SELECT i.permit_no,
                                  ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                                      to_tsvector('simple', COALESCE(i.name,'') || ' ' || COALESCE(i.benefit_claims,'')),
                                      plainto_tsquery('simple', $1)) DESC) AS rank
                           FROM health_food.items i
                           WHERE to_tsvector('simple', COALESCE(i.name,'') || ' ' || COALESCE(i.benefit_claims,''))
                                 @@ plainto_tsquery('simple', $1)
                           LIMIT 20
                       ),
                       vec AS (
                           SELECT permit_no,
                                  ROW_NUMBER() OVER (ORDER BY embedding <=> $2::halfvec) AS rank
                           FROM health_food.item_embeddings
                           ORDER BY embedding <=> $2::halfvec LIMIT 20
                       ),
                       rrf AS (
                           SELECT COALESCE(f.permit_no, v.permit_no) AS permit_no,
                                  COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                           FROM fts f FULL OUTER JOIN vec v ON f.permit_no = v.permit_no
                       )
                       SELECT i.permit_no, i.name, i.category, i.benefit_claims, i.applicant, i.valid_from
                       FROM rrf JOIN health_food.items i ON i.permit_no = rrf.permit_no
                       ORDER BY rrf.score DESC LIMIT $3""",
                    keyword,
                    vec_str,
                    limit,
                )
            else:
                rows = await conn.fetch(
                    """SELECT permit_no, name, category, benefit_claims, applicant, valid_from
                       FROM health_food.items
                       WHERE to_tsvector('simple', COALESCE(name,'') || ' ' || COALESCE(benefit_claims,''))
                             @@ plainto_tsquery('simple', $1)
                       LIMIT $2""",
                    keyword,
                    limit,
                )
        if not rows:
            return json.dumps(
                {"error": f"找不到與 '{keyword}' 相關的健康食品。", "results": []},
                ensure_ascii=False,
            )
        return json.dumps({"results": [dict(r) for r in rows]}, ensure_ascii=False)

    @cached(ttl=3600, prefix="hf.details")
    async def get_health_food_details(self, permit_no: str) -> str:
        """Return full details for a Taiwan FDA approved health food by permit number.

        Args:
            permit_no: FDA health food permit number
                (e.g. ``"衛部健食字第A00001號"``).

        Returns:
            JSON string with all fields from ``health_food.items``,
            or ``{"error": ...}`` if not found.
        """
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM health_food.items WHERE permit_no = $1", permit_no
            )
        if not row:
            return json.dumps(
                {"error": f"找不到許可證字號: {permit_no}"}, ensure_ascii=False
            )
        return json.dumps(dict(row), ensure_ascii=False)

    async def _resolve_icd_code(
        self, diagnosis_keyword: str, icd_service: "ICDService | None" = None  # type: ignore[name-defined]
    ) -> str | None:
        keyword = diagnosis_keyword.strip() if diagnosis_keyword else ""
        if not keyword:
            return None

        # Direct ICD inputs such as E11 or E11.9
        if re.match(r"^[A-Z][0-9][0-9](?:\.[A-Z0-9]+)?$", keyword.upper()):
            return keyword.upper().split(".")[0]

        if icd_service is None:
            return None

        try:
            raw = await icd_service.search_codes(keyword, "diagnosis")
            payload = json.loads(raw)
            diagnoses = payload.get("diagnoses", [])
            if not diagnoses:
                return None

            normalized = keyword.casefold()
            for row in diagnoses:
                name_zh = str(row.get("name_zh", "")).casefold()
                name_en = str(row.get("name_en", "")).casefold()
                if normalized in (name_zh, name_en):
                    code = row.get("code")
                    if code:
                        return str(code).upper().split(".")[0]

            first_code = diagnoses[0].get("code")
            if first_code:
                return str(first_code).upper().split(".")[0]
        except Exception:
            return None

        return None

    async def analyze_health_support_for_condition(
        self, diagnosis_keyword: str, icd_service: "ICDService | None" = None  # type: ignore[name-defined]
    ) -> str:
        """Recommend FDA-approved health foods relevant to a given diagnosis.

        Resolves *diagnosis_keyword* to an ICD prefix, maps it to relevant
        health benefit categories via ``DISEASE_BENEFIT_MAPPING``, then
        searches ``health_food.items`` for matching products.

        Args:
            diagnosis_keyword: Chinese/English disease name or ICD-10 code
                (e.g. ``"糖尿病"``, ``"E11"``).
            icd_service: Optional :class:`ICDService` instance used to resolve
                keyword to an ICD code.  If ``None``, only direct code inputs
                work.

        Returns:
            JSON string with ``diagnosis_keyword``, ``resolved_icd_code``,
            ``recommended_benefits``, ``total_products``, ``products`` list,
            and a developer-curated ``disclaimer``.
        """
        icd_code = await self._resolve_icd_code(
            diagnosis_keyword, icd_service=icd_service
        )
        recommended_benefits = DISEASE_BENEFIT_MAPPING.get(
            icd_code, [diagnosis_keyword]
        )

        foods: list[dict] = []
        async with self.pool.acquire() as conn:
            for benefit in recommended_benefits:
                rows = await conn.fetch(
                    """SELECT permit_no, name, benefit_claims FROM health_food.items
                       WHERE to_tsvector('simple', COALESCE(benefit_claims,''))
                             @@ plainto_tsquery('simple', $1)
                       LIMIT 5""",
                    benefit,
                )
                foods.extend([dict(r) for r in rows])

        # Deduplicate by permit_no
        seen: set[str] = set()
        unique_foods = []
        for f in foods:
            if f["permit_no"] not in seen:
                seen.add(f["permit_no"])
                unique_foods.append(f)

        return json.dumps(
            {
                "icd_code": icd_code,
                "recommended_benefits": recommended_benefits,
                "health_foods": unique_foods,
                "disclaimer": "健康食品僅供輔助保健，不可取代醫療。使用前請諮詢醫師。",
            },
            ensure_ascii=False,
        )
