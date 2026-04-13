# 食品營養服務模組 (Food Nutrition Service)

## 模組概述
食品營養服務模組提供全面性的台灣食品營養成分資料與食品原料法規資訊。此模組旨在支援精確的飲食規劃、營養分析以及食品合規性檢查，適用於營養師、食品開發者及關注飲食健康的民眾。

## 對外工具（4 個）

| 工具 | 說明 |
|------|------|
| `query_food_nutrition` | 食品營養查詢；`detailed=true` 回傳完整分類面板 |
| `query_food_ingredient` | 食品原料合規搜尋；可選 `category` 篩選主分類 |
| `search_foods_by_nutrient` | 依營養素由高至低排名食品 |
| `analyze_meal_nutrition` | 多食物組合的餐點總營養分析 |

## 主要功能

### 1. 食物名稱解析（Hybrid Search）
所有接受 `food_name` 的工具均使用 **BM25 + semantic embedding Reciprocal Rank Fusion (RRF)**：
- **BM25（FTS）**：`plainto_tsquery('simple', ...)` 比對 `sample_name`、`common_name`、`english_name`
- **向量搜尋**：`food_embeddings` 表存 `halfvec` embedding，`embedding <=> $2::halfvec` 計算餘弦距離
- **RRF 合併**：兩路排名以 `1/(60+rank)` 加總，取最高分者

此設計使「白米飯」能跨越字面差異找到資料庫中的「白飯」。

### 2. 營養成分查詢
- **一般搜尋**（`detailed=false`）：返回扁平 `[{food, category, nutrients}]` 列表，支援 `nutrient` 篩選。
- **詳細面板**（`detailed=true`）：按類別分組回傳完整 100+ 項營養素，涵蓋能量、巨量營養素、維生素、礦物質、脂肪酸。

### 3. 食品原料法規查詢
查詢食品原料的法規狀態，確認是否可用於食品加工：
- **主分類**：`"可供食品使用之原料"`（已核准）、`"未確認安全性尚不得使用之原料"`（禁用）
- **Hybrid 搜尋**：支援中英文近似比對，找不到精確名稱時仍能找到相近原料

### 4. 飲食組合分析 (Meal Analysis)
針對多項食物組成的餐點進行總體營養評估：
- **Hybrid 逐項解析**：每個食物名稱獨立走 BM25 + embedding RRF，找不到的標 `"found": false`
- **總量計算**：加總一餐中所有食物的熱量與營養素（每項預設 100 g）
- **pgBouncer 相容**：embedding HTTP 呼叫在取得 DB 連線前完成，符合 transaction mode 限制

## 資料來源
- **食品營養成分**：台灣食品成分資料庫 (FDA)。
- **可供食品使用原料**：食品原料整合查詢平臺。

## 應用場景
1. **飲食控制**：協助糖尿病、腎臟病患或體重管理者計算攝取量。
2. **菜單設計**：餐飲業者與團膳公司計算餐點營養標示。
3. **產品開發**：研發人員確認原料合法性與評估產品營養價值。
