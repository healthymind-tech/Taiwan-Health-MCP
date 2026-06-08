# 藥品服務模組 (Drug Service)

## 模組概述
藥品服務模組整合台灣 FDA（TFDA）西藥許可證資料，提供藥品搜尋、藥錠外觀辨識、藥品詳情與官方文件資產（仿單 / 外盒標籤 / 外觀圖）下載連結。資料以 TFDA 的標準許可證索引為核心，再透過多階段管線逐步豐富。

## 主要功能

### 1. 藥品搜尋（`search_drug`）
支援四種搜尋模式：

- **`drug_name`**：以中英文藥品名稱搜尋（例如「普拿疼」、「acetaminophen」）。
- **`ingredient`**：以成分文字搜尋。
- **`license_id`**：以許可證字號精確查詢（例如「衛署藥製字第000480號」或數字 ID）。
- **`atc_code`**：以 ATC 分類碼搜尋（例如「N02BE01」）。

可選 `include_cancelled` 以納入已註銷的許可證；`limit` 預設 3，上限 10。

### 2. 藥錠外觀辨識（`identify_unknown_pill`）
以空白分隔的外觀關鍵字（顏色、形狀、刻痕、標記、尺寸、刻字）進行交集比對，協助辨識不明藥錠。英文顏色 / 形狀詞會以內建同義詞表擴展，例如 `"white round"` 或 `"白 圓形"`。

### 3. 藥品詳情（`get_drug_details`）
回傳單一許可證的正規化（normalized）藥品紀錄，內容由儲存在 PostgreSQL 的正規化 JSON 組成，並附上目前各階段（stage）的可用性與文件數量。

### 4. 文件資產連結（`get_drug_asset_links`）
回傳已持久化的資產 metadata，並即時產生 MinIO 的預簽（presigned）下載連結。資產群組（`asset_group`）包含 `insert`（電子仿單）、`label`（外盒標籤）、`shape`（外觀圖）、`analysis`（分析輸出）。

## 資料管線（三階段）
藥物資料以 data-loader 的三個階段建立，也可由 Admin Console 的藥物頁面觸發與監控：

1. **`--drug-index`** — 從 TFDA 標準 `36_2.csv` 載入許可證索引，建立 `drug.licenses` 等基礎表。
2. **`--drug-enrich`** — 爬取 TFDA 取得電子仿單、文件資產與藥錠外觀紀錄，並將檔案存入 MinIO。
3. **`--drug-analysis`** — 對仿單文件執行 OCR（`DRUG_OCR_*`）與 LLM 分析（`DRUG_ANALYSIS_*`），萃取結構化內容寫入 `drug.insert_analysis`。

`--drug` 等同於一次執行 index + enrich。

## 技術架構
- **資料來源**：台灣 FDA 西藥許可證（`mcp.fda.gov.tw`），透過 `DRUG_TFDA_BASE_URL` 設定。
- **資料庫**：`drug` schema，含 `licenses`、`ingredients`、`atc`、`electronic_inserts`、`appearance_records`、`assets`、`insert_analysis`、`normalized_records` 等資料表，以及匯入狀態追蹤表（`import_runs`、`import_license_state`、`enrichment_queue` 等）。
- **物件儲存**：仿單 / 標籤 / 外觀圖檔案存於 MinIO，工具回傳時即時產生有時效的預簽連結。
- **嵌入搜尋**：藥品索引支援語意 / 混合搜尋（需 Ollama 嵌入服務）。

## 依賴關係
- **FHIR Medication Service**：以本模組的藥品資料產生 FHIR Medication / MedicationKnowledge 資源。

## 關鍵限制
- 仿單 OCR + LLM 分析為機器產生，必須由臨床人員覆核。
- `--drug-enrich` 與 `--drug-analysis` 需要可達的 TFDA / OCR / 分析 LLM 端點。
