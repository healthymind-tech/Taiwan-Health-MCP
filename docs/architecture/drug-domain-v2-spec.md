# Drug Domain V2 實作規格（RxNorm-First）

本規格定義藥品領域重構方向：以 RxNorm 作為術語骨幹，再整合台灣 FDA 產品資料，並在 loader 階段加入防呆，避免使用者先匯入 FDA。

## 目標

- 以 RxNorm 建立標準化藥物語義層（concept / relationship）。
- 將 FDA 藥證資料視為產品層（product layer），透過 crosswalk 連到 RxNorm。
- 收斂 `drug.*` schema 結構，減少 1:1 附表分散。
- 保證匯入順序：`RxNorm -> FDA drug`。

## V2 邏輯模型（目前狀態）

- `drug.product`
  - 由 `licenses + appearance + documents(insert)` 合併而成。
  - 保留產品欄位：`license_id`, `name_zh`, `name_en`, `manufacturer`, `indication`, `usage`, `form`, `package`, `valid_date`, `appearance_*`, `insert_url`。
- `drug.product_ingredient`
  - 1:N，保留成分與含量（不扁平化到 product）。
- `drug.product_atc`
  - 1:N，保留 ATC code，新增 `source`（`fda` / `rxnorm`）以便稽核。
- `drug.rx_concepts`, `drug.rx_relationships`
  - RxNorm 概念與關聯已併入 `drug` schema（不再使用獨立 `rxnorm.*` schema）。
- `drug.rx_atc_map`
  - 由 RxNorm `SAB=ATC` 行抽取，保留 `atc_code` 以支持與 `drug.atc.atc_code` 關聯。
- `drug.product_rxcui_map`
  - `license_id <-> rxcui` crosswalk，含 `match_method`、`confidence`、`matched_at`。

## 匯入順序（強制）

1. 載入 RxNorm（術語層）
2. 建立/更新 RxNorm 衍生映射（如 ATC 對應）
3. 載入 FDA drug（產品層）
4. 建立 product ↔ rxcui crosswalk
5. 重建 cache（embedding 只針對 `drug.ingredient_name_embeddings`）

> **注意**：`drug.license_embeddings` 與 `drug.atc_embeddings` 已移除（曾存在但從未被查詢）。`drug_name` 模式現改用 PostgreSQL 原生 `ts_rank_cd + setweight` 全文搜尋，無需 embedding。

## 防呆（本次已實作）

- `loader/main.py` 在 `load_drug()` 前執行 `_assert_rxnorm_ready_for_fda()`：
  - 查 `drug.rx_concepts` 筆數。
  - 低於門檻（預設 `10,000`）即中止 FDA drug 匯入並提示先跑 `--rxnorm`。
- 目的：防止使用者直接 `--drug` / `--fda` 造成資料基礎不一致。

## 相容性與遷移策略

- 已完成 RxNorm 併入 `drug` schema，包含 `rx_concepts`、`rx_relationships`、`rx_atc_map`。
- 對外工具入口改為 `search_drug` 單一模式化查詢：
  - `rxnorm_resolve` 取代舊 RxNorm 名稱解析入口
  - `rxnorm_ingredients` 取代舊 RXCUI 成分入口
  - `interaction` 取代舊交互作用入口
- 已提供無資料遺失遷移腳本：`db/migrations/2026-04-12_drug_schema_no_loss.sql`。
  - 會先把需要移除/正規化的列備份到 `migration_backup.*`。
  - 會將舊 `rxnorm.concepts / rxnorm.relationships` 併入 `drug.rx_*`。
  - 會補齊 `drug` 子表 FK、`documents.doc_type='insert'` 約束、`NOT NULL` 與去重索引。
- 額外遷移腳本：`db/migrations/2026-04-12_drop_unused_drug_embeddings.sql`
  - 移除 `drug.license_embeddings` 與 `drug.atc_embeddings`（兩表從未被查詢）。
- 下一階段聚焦 `product_rxcui_map` 與 FDA 產品層 crosswalk 回填。
