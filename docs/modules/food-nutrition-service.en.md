# Food Nutrition Service

## Overview
The food nutrition service provides comprehensive Taiwan food composition data and food ingredient regulatory information. It supports precise diet planning, nutritional analysis, and food compliance checking, for dietitians, food developers, and anyone paying attention to dietary health.

## Public tools (4)

| Tool | Description |
|------|-------------|
| `query_food_nutrition` | Food nutrition lookup; `detailed=true` returns the full categorised panel |
| `query_food_ingredient` | Food ingredient compliance search; optional `category` filter on the top-level class |
| `search_foods_by_nutrient` | Rank foods from highest to lowest by a nutrient |
| `analyze_meal_nutrition` | Total nutrition analysis for a combination of foods |

## Features

### 1. Food name resolution (hybrid search)
Every tool accepting `food_name` uses **BM25 + semantic embedding Reciprocal Rank Fusion (RRF)**:
- **BM25 (FTS)**: `plainto_tsquery('simple', ...)` against `sample_name`, `common_name`, and `english_name`
- **Vector search**: the `food_embeddings` table stores a `halfvec` embedding, with `embedding <=> $2::halfvec` computing cosine distance
- **RRF merge**: the two rankings are summed as `1/(60+rank)`, and the highest score wins

This lets「白米飯」find「白飯」in the database despite the literal difference.

### 2. Nutrient lookup
- **General search** (`detailed=false`): returns a flat `[{food, category, nutrients}]` list, with an optional `nutrient` filter.
- **Detailed panel** (`detailed=true`): returns all 100+ nutrients grouped by category, covering energy, macronutrients, vitamins, minerals, and fatty acids.

### 3. Food ingredient regulatory lookup
Check the regulatory status of a food ingredient to confirm whether it may be used in food processing:
- **Top-level categories**: `"可供食品使用之原料"` (approved) and `"未確認安全性尚不得使用之原料"` (prohibited)
- **Hybrid search**: supports approximate Chinese and English matching, so a near-miss name still finds the closest ingredient

### 4. Meal analysis
Overall nutritional assessment of a meal composed of several foods:
- **Hybrid per-item resolution**: each food name goes through BM25 + embedding RRF independently; anything not found is marked `"found": false`
- **Totals**: sums the calories and nutrients of every food in the meal (100 g per item by default)
- **pgBouncer compatible**: the embedding HTTP call completes before a DB connection is acquired, satisfying transaction-mode constraints

## Data sources
- **Food composition**: the Taiwan Food Composition Database (FDA).
- **Approved food ingredients**: the integrated food ingredient query platform.

## Use cases
1. **Dietary control**: helps patients with diabetes or kidney disease, and people managing their weight, calculate intake.
2. **Menu design**: lets caterers and institutional food services calculate nutrition labelling for meals.
3. **Product development**: lets R&D staff confirm ingredient legality and assess a product's nutritional value.
