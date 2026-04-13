# 營養工具 (Nutrition Tools)

此類別工具提供台灣食品的營養成分查詢、食品原料合規查詢與飲食分析功能。
所有食物名稱解析均使用 **hybrid BM25 + semantic embedding (RRF)** 搜尋，
可跨越同義詞與近義詞（例如搜尋「白米飯」可找到資料庫中的「白飯」）。

---

## query_food_nutrition

查詢食品的營養資訊（per 100 g）。以 `detailed` 切換輸出模式。

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `food_name` | string | 是 | 食物名稱（中文或英文） | `"白米"`, `"雞胸肉"`, `"salmon"` |
| `nutrient` | string | 否 | 特定營養素篩選（僅 `detailed=false` 有效） | `"粗蛋白"`, `"維生素C"`, `"鈣"` |
| `limit` | int | 否 | 最多回傳幾筆（預設 3，最大 10；僅 `detailed=false` 有效） | `5` |
| `detailed` | bool | 否 | `false`（預設）快速查詢；`true` 回傳完整分類面板 | `true` |

### 輸出模式

**`detailed=false`**（預設）— 扁平列表，快速查詢：
- 最多回傳 `limit` 筆食物
- 支援 `nutrient` 部分比對篩選（ILIKE）
- 輸出：`[{food, category, nutrients: [{item, value, unit}, ...]}, ...]`

**`detailed=true`** — 完整營養面板，按類別分組：
- 固定回傳最多 3 筆；`limit` 與 `nutrient` 忽略
- 涵蓋能量、巨量營養素、維生素（A/B群/C/D/E/K/菸鹼素/葉酸）、
  礦物質（Ca/P/Fe/Na/K/Mg/Zn/Mn/Cu）、脂肪酸（SFA/MUFA/PUFA/trans/EPA/DHA）
- 輸出：`[{sample_name, common_name, food_category, nutrients: {類別: [{item, value, unit}]}}]`

---

## query_food_ingredient

搜尋食品原料/添加物的法規分類資訊，確認原料是否核准用於食品。
可選 `category` 下拉篩選，限縮至特定主分類。

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `keyword` | string | 是 | 原料名稱（中文或英文） | `"薑黃"`, `"turmeric"`, `"卡拉膠"`, `"sorbic acid"` |
| `category` | enum | 否 | 主分類篩選，omit 表示搜尋全部 | `"可供食品使用之原料"` |
| `limit` | int | 否 | 最多回傳幾筆（預設 3，最大 10） | `5` |

### 可選分類值（`major_category`）

| 值 | 說明 |
| :--- | :--- |
| `可供食品使用之原料` | 已核准可用於食品（約 1,170 筆） |
| `未確認安全性尚不得使用之原料` | 安全性未確認，目前不得使用（約 532 筆） |

### 輸出

`[{name_zh, name_en, major_category, sub_category, note}, ...]`

---

## search_foods_by_nutrient

依指定營養素由高至低排名台灣 FDA 食品（per 100 g）。

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `nutrient` | string | 是 | 營養素名稱（中、英文別名均可） | `"鈣"`, `"calcium"`, `"蛋白質"`, `"EPA"` |
| `limit` | int | 否 | 回傳筆數（預設 20，最大 50） | `10` |

### 別名解析順序

1. 內建別名表（`"蛋白質"` → `"粗蛋白"`、`"vitamin c"` → `"維生素C"` 等）
2. 部分 ILIKE 比對台灣 FDA 欄位名
3. Semantic embedding 搜尋（上兩步都沒找到時）

### 輸出

`{"nutrient", "unit", "foods": [{food_name, food_code, category, value}, ...]}`

---

## analyze_meal_nutrition

計算一餐中多種食物的整體營養總量（每樣食物預設 100 g）。

每個食物名稱透過 **hybrid BM25 + embedding RRF** 搜尋解析至資料庫最近似項目
（例如「白米飯」→ 資料庫中的「白飯」）。

### 參數

| 參數名 | 型別 | 必填 | 說明 | 範例 |
| :--- | :--- | :--- | :--- | :--- |
| `foods` | list[string] | 是 | 食物名稱列表 | `["白米飯", "雞胸肉", "青花菜", "豆腐"]` |

### 輸出

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

找不到的食物以 `"found": false` 標示；已辨識但無法解析的條目以 `"error"` 說明。
