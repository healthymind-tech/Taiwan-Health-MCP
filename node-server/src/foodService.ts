/**
 * Food Nutrition service — Taiwan FDA food composition database.
 *
 * Faithful port of `src/food_nutrition_service.py`. Covers the MCP-exposed query
 * paths (search_nutrition / get_detailed_nutrition / search_food_ingredient /
 * search_foods_by_nutrient / analyze_meal_nutrition) plus the in-memory
 * nutrient-embedding fallback. The TFDA importer lives in `loaders/foodNutrition.ts`.
 *
 * `content_per_100g` is a TEXT column; pg returns it verbatim as a string,
 * matching Python (no numeric coercion at the row level).
 */

import { query } from "./db.js";
import { logInfo } from "./logger.js";
import type { EmbeddingService } from "./embeddingService.js";
import { vecLiteral } from "./embeddingService.js";

// Common synonym → exact DB nutrient_item name (mirror of `_NUTRIENT_ALIASES`).
const NUTRIENT_ALIASES: Record<string, string> = {
  蛋白質: "粗蛋白",
  蛋白: "粗蛋白",
  protein: "粗蛋白",
  脂肪: "粗脂肪",
  油脂: "粗脂肪",
  fat: "粗脂肪",
  碳水: "總碳水化合物",
  碳水化合物: "總碳水化合物",
  carbohydrate: "總碳水化合物",
  carb: "總碳水化合物",
  纖維: "膳食纖維",
  fiber: "膳食纖維",
  fibre: "膳食纖維",
  卡路里: "熱量",
  calories: "熱量",
  calorie: "熱量",
  kcal: "熱量",
  "維他命a": "維生素A",
  "vitamin a": "維生素A",
  "維他命b1": "維生素B1",
  "vitamin b1": "維生素B1",
  硫胺素: "維生素B1",
  "維他命b2": "維生素B2",
  "vitamin b2": "維生素B2",
  核黃素: "維生素B2",
  "維他命b6": "維生素B6",
  "vitamin b6": "維生素B6",
  "維他命b12": "維生素B12",
  "vitamin b12": "維生素B12",
  "維他命c": "維生素C",
  "vitamin c": "維生素C",
  抗壞血酸: "維生素C",
  "維他命d": "維生素D",
  "vitamin d": "維生素D",
  "維他命e": "維生素E",
  "vitamin e": "維生素E",
  "維他命k": "維生素K",
  "vitamin k": "維生素K",
  sodium: "鈉",
  na: "鈉",
  calcium: "鈣",
  ca: "鈣",
  iron: "鐵",
  fe: "鐵",
  potassium: "鉀",
  k: "鉀",
  magnesium: "鎂",
  mg: "鎂",
  zinc: "鋅",
  zn: "鋅",
  phosphorus: "磷",
  phosphate: "磷",
  膽固醇: "膽固醇",
  cholesterol: "膽固醇",
  糖: "糖質",
  sugar: "糖質",
  水: "水分",
  water: "水分",
  灰: "灰分",
};

interface MeasurementRow {
  sample_name: string;
  common_name: string | null;
  food_category: string | null;
  nutrient_category: string | null;
  nutrient_item: string | null;
  content_per_100g: string | null;
  content_unit: string | null;
}

export class FoodNutritionService {
  private embeddingSvc: EmbeddingService | null;
  // In-memory cache for nutrient_item embeddings (built lazily on fallback).
  private nutrientEmbeddings: Map<string, number[]> | null = null;

  constructor(embeddingSvc: EmbeddingService | null = null) {
    this.embeddingSvc = embeddingSvc;
  }

  async initialize(): Promise<void> {
    const res = await query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM food_nutrition.measurements",
    );
    const count = Number(res.rows[0]?.count ?? 0);
    if (count === 0) {
      logInfo("Food nutrition DB empty — run data-loader --food-nutrition to load data");
    } else {
      logInfo("Food Nutrition Service ready", { measurements: count });
    }
  }

  /** Resolve best-matching sample_names via hybrid RRF (or pure FTS fallback). */
  private async matchSampleNames(foodName: string, vecStr: string | null, limit: number): Promise<string[]> {
    if (vecStr) {
      const r = await query<{ sample_name: string }>(
        `WITH fts AS (
             SELECT DISTINCT m.sample_name,
                    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                        to_tsvector('simple', COALESCE(m.sample_name,'') || ' ' ||
                                              COALESCE(m.common_name,'') || ' ' ||
                                              COALESCE(m.english_name,'')),
                        plainto_tsquery('simple', $1)) DESC) AS rank
             FROM food_nutrition.measurements m
             WHERE to_tsvector('simple',
                     COALESCE(m.sample_name,'') || ' ' ||
                     COALESCE(m.common_name,'') || ' ' ||
                     COALESCE(m.english_name,''))
                   @@ plainto_tsquery('simple', $1)
             LIMIT 20
         ),
         vec AS (
             SELECT sample_name,
                    ROW_NUMBER() OVER (ORDER BY embedding <=> $2::halfvec) AS rank
             FROM food_nutrition.food_embeddings
             ORDER BY embedding <=> $2::halfvec LIMIT 20
         ),
         rrf AS (
             SELECT COALESCE(f.sample_name, v.sample_name) AS sample_name,
                    COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
             FROM fts f FULL OUTER JOIN vec v ON f.sample_name = v.sample_name
         )
         SELECT sample_name FROM rrf ORDER BY score DESC LIMIT $3`,
        [foodName, vecStr, limit],
      );
      return r.rows.map((row) => row.sample_name);
    }
    const r = await query<{ sample_name: string }>(
      `SELECT DISTINCT sample_name FROM food_nutrition.measurements
       WHERE to_tsvector('simple',
               COALESCE(sample_name,'') || ' ' || COALESCE(common_name,'') || ' ' || COALESCE(english_name,''))
             @@ plainto_tsquery('simple', $1)
       LIMIT $2`,
      [foodName, limit],
    );
    return r.rows.map((row) => row.sample_name);
  }

  /** Mirror of `search_nutrition`. */
  async searchNutrition(foodName: string, nutrient: string | null = null, limit = 3): Promise<unknown> {
    limit = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(foodName) : null;
    const vecStr = vecLiteral(vec);

    const names = await this.matchSampleNames(foodName, vecStr, limit);
    if (!names.length) {
      return { error: `找不到 '${foodName}' 的營養資料。` };
    }

    let rows: MeasurementRow[];
    if (nutrient) {
      const r = await query<MeasurementRow>(
        `SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
         FROM food_nutrition.measurements
         WHERE sample_name = ANY($1) AND nutrient_item ILIKE $2`,
        [names, `%${nutrient}%`],
      );
      rows = r.rows;
    } else {
      const r = await query<MeasurementRow>(
        `SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
         FROM food_nutrition.measurements
         WHERE sample_name = ANY($1)`,
        [names],
      );
      rows = r.rows;
    }
    if (!rows.length) {
      return { error: `找不到 '${foodName}' 的營養資料。` };
    }

    const foods = new Map<string, { category: string | null; nutrients: unknown[] }>();
    for (const r of rows) {
      const key = r.common_name ? `${r.sample_name} (${r.common_name})` : r.sample_name;
      if (!foods.has(key)) foods.set(key, { category: r.food_category, nutrients: [] });
      foods.get(key)!.nutrients.push({
        item: r.nutrient_item,
        value: r.content_per_100g,
        unit: r.content_unit,
      });
    }
    return [...foods.entries()].map(([k, v]) => ({ food: k, ...v }));
  }

  /** Mirror of `get_detailed_nutrition`. */
  async getDetailedNutrition(foodName: string): Promise<unknown> {
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(foodName) : null;
    const vecStr = vecLiteral(vec);

    const names = await this.matchSampleNames(foodName, vecStr, 3);
    if (!names.length) {
      return { error: `找不到 '${foodName}' 的詳細營養資料。` };
    }

    const r = await query<MeasurementRow>(
      `SELECT sample_name, common_name, food_category, nutrient_category,
              nutrient_item, content_per_100g, content_unit
       FROM food_nutrition.measurements
       WHERE sample_name = ANY($1)
       ORDER BY sample_name, nutrient_category, nutrient_item`,
      [names],
    );
    if (!r.rows.length) {
      return { error: `找不到 '${foodName}' 的詳細營養資料。` };
    }

    const nameOrder = new Map(names.map((n, i) => [n, i]));
    const foods = new Map<string, {
      sample_name: string;
      common_name: string | null;
      food_category: string | null;
      nutrients: Record<string, unknown[]>;
    }>();
    for (const row of r.rows) {
      const key = row.sample_name;
      if (!foods.has(key)) {
        foods.set(key, {
          sample_name: row.sample_name,
          common_name: row.common_name,
          food_category: row.food_category,
          nutrients: {},
        });
      }
      const cat = row.nutrient_category || "其他";
      const nut = foods.get(key)!.nutrients;
      (nut[cat] ??= []).push({
        item: row.nutrient_item,
        value: row.content_per_100g ? row.content_per_100g.trim() : null,
        unit: row.content_unit,
      });
    }

    return [...foods.values()].sort(
      (a, b) => (nameOrder.get(a.sample_name) ?? 999) - (nameOrder.get(b.sample_name) ?? 999),
    );
  }

  /** Mirror of `search_food_ingredient`. */
  async searchFoodIngredient(keyword: string, limit = 3, category: string | null = null): Promise<unknown> {
    limit = Math.min(Math.max(1, limit), 10);
    const vec = this.embeddingSvc ? await this.embeddingSvc.embed(keyword) : null;
    const vecStr = vecLiteral(vec);

    let rows: Record<string, unknown>[];
    if (vecStr) {
      const ftsCatFilter = category ? "AND i.major_category = $4" : "";
      const vecJoin = category ? "JOIN food_nutrition.ingredients i ON i.id = ie.id" : "";
      const vecWhere = category ? "WHERE i.major_category = $4" : "";
      const params: unknown[] = category ? [keyword, vecStr, limit, category] : [keyword, vecStr, limit];
      const r = await query<Record<string, unknown>>(
        `WITH fts AS (
             SELECT i.id,
                    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                        to_tsvector('simple', COALESCE(i.name_zh,'') || ' ' || COALESCE(i.name_en,'')),
                        plainto_tsquery('simple', $1)) DESC) AS rank
             FROM food_nutrition.ingredients i
             WHERE to_tsvector('simple', COALESCE(i.name_zh,'') || ' ' || COALESCE(i.name_en,''))
                   @@ plainto_tsquery('simple', $1)
             ${ftsCatFilter}
             LIMIT 20
         ),
         vec AS (
             SELECT ie.id,
                    ROW_NUMBER() OVER (ORDER BY ie.embedding <=> $2::halfvec) AS rank
             FROM food_nutrition.ingredient_embeddings ie
             ${vecJoin}
             ${vecWhere}
             ORDER BY ie.embedding <=> $2::halfvec LIMIT 20
         ),
         rrf AS (
             SELECT COALESCE(f.id, v.id) AS id,
                    COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
             FROM fts f FULL OUTER JOIN vec v ON f.id = v.id
         )
         SELECT i.name_zh, i.name_en, i.major_category, i.sub_category, i.note
         FROM rrf JOIN food_nutrition.ingredients i ON i.id = rrf.id
         ORDER BY rrf.score DESC LIMIT $3`,
        params,
      );
      rows = r.rows;
    } else {
      const catFilter = category ? "AND major_category = $3" : "";
      const params: unknown[] = category ? [keyword, limit, category] : [keyword, limit];
      const r = await query<Record<string, unknown>>(
        `SELECT name_zh, name_en, major_category, sub_category, note
         FROM food_nutrition.ingredients
         WHERE to_tsvector('simple', COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
               @@ plainto_tsquery('simple', $1)
         ${catFilter}
         LIMIT $2`,
        params,
      );
      rows = r.rows;
    }
    if (!rows.length) {
      return { error: `找不到與 '${keyword}' 相關的食品原料。` };
    }
    return rows;
  }

  /** In-memory cosine fallback to resolve a nutrient name (mirror of `_find_nutrient_by_embedding`). */
  private async findNutrientByEmbedding(queryText: string): Promise<string | null> {
    if (!this.embeddingSvc) return null;

    if (this.nutrientEmbeddings === null) {
      const items = await query<{ nutrient_item: string }>(
        "SELECT DISTINCT nutrient_item FROM food_nutrition.measurements ORDER BY nutrient_item",
      );
      const names = items.rows.map((r) => r.nutrient_item);
      const map = new Map<string, number[]>();
      const BATCH = 32;
      for (let i = 0; i < names.length; i += BATCH) {
        const vecs = await this.embeddingSvc.embedBatch(names.slice(i, i + BATCH));
        vecs.forEach((v, j) => {
          if (v) map.set(names[i + j], v);
        });
      }
      this.nutrientEmbeddings = map;
    }
    if (!this.nutrientEmbeddings.size) return null;

    const queryVec = await this.embeddingSvc.embed(queryText);
    if (!queryVec) return null;

    const cosine = (a: number[], b: number[]): number => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    };

    let bestName: string | null = null;
    let bestScore = -Infinity;
    for (const [name, vec] of this.nutrientEmbeddings) {
      const score = cosine(queryVec, vec);
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
    return bestScore > 0.85 ? bestName : null;
  }

  /** Mirror of `search_foods_by_nutrient`. */
  async searchFoodsByNutrient(nutrient: string, limit = 20): Promise<unknown> {
    const stripped = nutrient.trim();
    let matched: string | null = NUTRIENT_ALIASES[stripped.toLowerCase()] ?? null;

    if (!matched) {
      const items = await query<{ nutrient_item: string }>(
        `SELECT DISTINCT nutrient_item FROM food_nutrition.measurements
         WHERE nutrient_item ILIKE $1 LIMIT 10`,
        [`%${stripped}%`],
      );
      if (items.rows.length) matched = items.rows[0].nutrient_item;
    }

    if (!matched) {
      matched = await this.findNutrientByEmbedding(stripped);
    }

    if (!matched) {
      return {
        error: `找不到營養素 '${nutrient}'。請嘗試中文名稱，如：粗蛋白、粗脂肪、鈣、鐵、維生素C、熱量、鈉`,
      };
    }

    const rows = await query<MeasurementRow>(
      `SELECT sample_name, common_name, food_category, nutrient_item,
              content_per_100g, content_unit
       FROM food_nutrition.measurements
       WHERE nutrient_item = $1
         AND TRIM(content_per_100g) ~ '^[0-9]+[.]?[0-9]*$'
       ORDER BY CAST(TRIM(content_per_100g) AS FLOAT) DESC
       LIMIT $2`,
      [matched, Math.min(limit, 50)],
    );

    return {
      nutrient: matched,
      unit: rows.rows.length ? rows.rows[0].content_unit : "",
      total: rows.rows.length,
      note: "數值為每 100 克含量",
      foods: rows.rows.map((r) => ({
        name: r.sample_name,
        common_name: r.common_name,
        category: r.food_category,
        content_per_100g: r.content_per_100g ? r.content_per_100g.trim() : null,
        unit: r.content_unit,
      })),
    };
  }

  /** Mirror of `analyze_meal_nutrition`. */
  async analyzeMealNutrition(foods: string[]): Promise<unknown> {
    // Embed all food names first (never hold a DB connection during HTTP calls).
    const vecStrs = new Map<string, string | null>();
    if (this.embeddingSvc) {
      const vecs = await Promise.all(foods.map((f) => this.embeddingSvc!.embed(f)));
      foods.forEach((food, i) => vecStrs.set(food, vecLiteral(vecs[i])));
    }

    const totals: Record<string, number> = {};
    const components: Record<string, unknown> = {};

    for (const food of foods) {
      const vecStr = vecStrs.get(food) ?? null;
      let sampleName: string | null;
      if (vecStr) {
        const r = await query<{ sample_name: string }>(
          `WITH fts AS (
               SELECT DISTINCT m.sample_name,
                      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                          to_tsvector('simple', COALESCE(m.sample_name,'') || ' ' ||
                                                COALESCE(m.common_name,'') || ' ' ||
                                                COALESCE(m.english_name,'')),
                          plainto_tsquery('simple', $1)) DESC) AS rank
               FROM food_nutrition.measurements m
               WHERE to_tsvector('simple',
                       COALESCE(m.sample_name,'') || ' ' ||
                       COALESCE(m.common_name,'') || ' ' ||
                       COALESCE(m.english_name,''))
                     @@ plainto_tsquery('simple', $1)
               LIMIT 20
           ),
           vec AS (
               SELECT sample_name,
                      ROW_NUMBER() OVER (ORDER BY embedding <=> $2::halfvec) AS rank
               FROM food_nutrition.food_embeddings
               ORDER BY embedding <=> $2::halfvec LIMIT 20
           ),
           rrf AS (
               SELECT COALESCE(f.sample_name, v.sample_name) AS sample_name,
                      COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
               FROM fts f FULL OUTER JOIN vec v ON f.sample_name = v.sample_name
           )
           SELECT sample_name FROM rrf ORDER BY score DESC LIMIT 1`,
          [food, vecStr],
        );
        sampleName = r.rows[0]?.sample_name ?? null;
      } else {
        const r = await query<{ sample_name: string }>(
          `SELECT DISTINCT sample_name FROM food_nutrition.measurements
           WHERE to_tsvector('simple',
                   COALESCE(sample_name,'') || ' ' ||
                   COALESCE(common_name,'') || ' ' ||
                   COALESCE(english_name,''))
                 @@ plainto_tsquery('simple', $1)
           LIMIT 1`,
          [food],
        );
        sampleName = r.rows[0]?.sample_name ?? null;
      }

      if (!sampleName) {
        components[food] = { error: `找不到 '${food}' 的資料` };
        continue;
      }

      const rows = await query<MeasurementRow>(
        `SELECT sample_name, common_name, food_category,
                nutrient_category, nutrient_item, content_per_100g, content_unit
         FROM food_nutrition.measurements
         WHERE sample_name = $1
         ORDER BY nutrient_category, nutrient_item`,
        [sampleName],
      );

      const grouped: Record<string, unknown[]> = {};
      for (const r of rows.rows) {
        const cat = r.nutrient_category || "其他";
        const valStr = r.content_per_100g ? r.content_per_100g.trim() : null;
        (grouped[cat] ??= []).push({ item: r.nutrient_item, value: valStr, unit: r.content_unit });
        if (valStr !== null && valStr !== "") {
          const num = Number(valStr);
          if (!Number.isNaN(num)) {
            totals[r.nutrient_item as string] = (totals[r.nutrient_item as string] ?? 0) + num;
          }
        }
      }

      components[food] = {
        matched: sampleName,
        common_name: rows.rows.length ? rows.rows[0].common_name : null,
        food_category: rows.rows.length ? rows.rows[0].food_category : null,
        nutrients: grouped,
      };
    }

    return { meal_components: components, combined_totals_per_100g_each: totals };
  }
}
