# Food Nutrition Tools

This group provides nutrient lookup for Taiwan foods, food ingredient compliance lookup, and dietary analysis.
Every food name is resolved with **hybrid BM25 + semantic embedding (RRF)** search, which crosses synonyms and near-synonyms (searching「白米飯」finds「白飯」in the database).

---

## query_food_nutrition

Look up a food's nutrition information (per 100 g). `detailed` switches the output mode.

### Parameters

| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `food_name` | string | Yes | Food name (Chinese or English) | `"白米"`, `"雞胸肉"`, `"salmon"` |
| `nutrient` | string | No | Filter to a specific nutrient (only effective when `detailed=false`) | `"粗蛋白"`, `"維生素C"`, `"鈣"` |
| `limit` | int | No | Maximum rows to return (3 by default, 10 maximum; only effective when `detailed=false`) | `5` |
| `detailed` | bool | No | `false` (default) for a quick lookup; `true` for the full categorised panel | `true` |

### Output modes

**`detailed=false`** (default) — a flat list, for quick lookups:
- Returns at most `limit` foods
- Supports partial-match `nutrient` filtering (ILIKE)
- Output: `[{food, category, nutrients: [{item, value, unit}, ...]}, ...]`

**`detailed=true`** — the full nutrition panel, grouped by category:
- Always returns at most 3 rows; `limit` and `nutrient` are ignored
- Covers energy, macronutrients, vitamins (A / B group / C / D / E / K / niacin / folate),
  minerals (Ca/P/Fe/Na/K/Mg/Zn/Mn/Cu), and fatty acids (SFA/MUFA/PUFA/trans/EPA/DHA)
- Output: `[{sample_name, common_name, food_category, nutrients: {category: [{item, value, unit}]}}]`

---

## query_food_ingredient

Search the regulatory classification of a food ingredient or additive to confirm whether it is approved for use in food.
The optional `category` filter narrows the search to one top-level class.

### Parameters

| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | Yes | Ingredient name (Chinese or English) | `"薑黃"`, `"turmeric"`, `"卡拉膠"`, `"sorbic acid"` |
| `category` | enum | No | Top-level category filter; omit to search everything | `"可供食品使用之原料"` |
| `limit` | int | No | Maximum rows to return (3 by default, 10 maximum) | `5` |

### Allowed category values (`major_category`)

| Value | Meaning |
| :--- | :--- |
| `可供食品使用之原料` | Approved for use in food (roughly 1,170 rows) |
| `未確認安全性尚不得使用之原料` | Safety unconfirmed, currently not permitted (roughly 532 rows) |

### Output

`[{name_zh, name_en, major_category, sub_category, note}, ...]`

---

## search_foods_by_nutrient

Rank Taiwan FDA foods from highest to lowest by a given nutrient (per 100 g).

### Parameters

| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `nutrient` | string | Yes | Nutrient name (Chinese or English aliases both accepted) | `"鈣"`, `"calcium"`, `"蛋白質"`, `"EPA"` |
| `limit` | int | No | Rows to return (20 by default, 50 maximum) | `10` |

### Alias resolution order

1. The built-in alias table (`"蛋白質"` → `"粗蛋白"`, `"vitamin c"` → `"維生素C"`, and so on)
2. Partial ILIKE match against Taiwan FDA column names
3. Semantic embedding search (when neither of the above found anything)

### Output

`{"nutrient", "unit", "foods": [{food_name, food_code, category, value}, ...]}`

---

## analyze_meal_nutrition

Compute the overall nutrition totals for several foods in one meal (100 g per food by default).

Each food name is resolved to the closest database entry through **hybrid BM25 + embedding RRF** search
(for example「白米飯」→「白飯」in the database).

### Parameters

| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `foods` | list[string] | Yes | List of food names | `["白米飯", "雞胸肉", "青花菜", "豆腐"]` |

### Output

```json
{
  "meal_components": {
    "<food_name>": {
      "found": true,
      "food_name": "...",
      "nutrients": {"熱量": ..., "粗蛋白": ..., "...": ...}
    }
  },
  "combined_totals_per_100g_each": {"熱量": ..., "粗蛋白": ..., "...": ...}
}
```

Foods that cannot be found are marked `"found": false`; entries that were recognised but could not be resolved carry an `"error"` explanation.
