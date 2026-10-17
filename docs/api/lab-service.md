# Lab Service API

`LabService`（`node-server/src/labService.ts`）負責 LOINC 搜尋、分類瀏覽、參考值查詢與檢驗結果判讀，
支撐 `search_loinc`、`query_loinc`、`interpret_lab_result`、`batch_interpret_lab_results` 四個工具。
資料庫存取經由 `db.ts` 的共用連線池；方法回傳可序列化成 JSON 的物件。

## class `LabService`

### `constructor(embeddingSvc: EmbeddingService | null = null)`
傳入共用的 `EmbeddingService`；為 `null` 時搜尋只走關鍵字。

### `async searchLoincCode(keyword, category = null, limit = 3)`
以檢驗名稱、縮寫或分析物搜尋候選 LOINC 碼（BM25 + 語意混合），`category` 可限縮到某個 LOINC class。向量不可用時帶 `search_mode: "keyword_only"`。

### `async searchBySpecimen(specimenType, limit = 3)`
依檢體類型搜尋 LOINC 項目。

### `async findRelatedTests(component, limit = 3)`
找出同一分析物的相關 LOINC 檢驗，依 specimen system 分組（`by_system`）。

### `async listCategories()`
列出資料庫中可用的 LOINC 大類。

### `async getPatientFriendlyName(loincNum)`
取得單一 LOINC 的完整概念細節與病患友善名稱（`query_loinc` 的 `detail` 模式）。

### `async getReferenceRange(loincNum, age, gender = "all")`
依年齡與性別（`"M" | "F" | "all"`）取得參考值範圍（`query_loinc` 的 `reference_range` 模式）。

### `async interpretLabResult(loincNum, value, age, gender = "all")`
判讀單一檢驗數值，回傳參考範圍、量測值與 normal / high / low 判定。

### `async batchInterpretResults(results, age, gender = "all")`
批次判讀 `{loinc_code, value}` 陣列，適合整份檢驗報告。

> 參考值僅供一般參考，不取代臨床判斷。
