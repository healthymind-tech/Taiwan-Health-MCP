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
藥物資料以三個匯入階段建立，於 Admin Console 的藥物頁面觸發與監控（由 `admin-worker` 背景執行）：

1. **`drug_index_import`** — 從 TFDA 標準 `36_2.csv` 載入許可證索引，建立 `drug.licenses` 等基礎表。
2. **`drug_enrichment`** — 爬取 TFDA 取得電子仿單、文件資產與藥錠外觀紀錄，並將檔案存入 MinIO。
3. **`drug_analysis`** — 對仿單文件執行 OCR（MinerU 或 Indra，見下方「[OCR 供應者](#ocr-providers)」）與分析 LLM，萃取結構化內容寫入 `drug.insert_analysis`。OCR 在管理後台 **整合 → 外部服務 → OCR Server** 設定（存於 `admin.app_settings` 的 `ocr` 群組）；分析 LLM 在 **整合 → 模型端點** 設定（provider 帳號 + 路由：`admin.llm_providers` / `admin.llm_routes` / `admin.llm_route_members` / `admin.llm_role_routes`）。兩者都**不從環境變數讀取**。

另有 `drug_pipeline` 工作型別，在同一個工作內對每張許可證依序跑完三個階段。三者也會自動串接：每個自動串接的工作以 `DRUG_AUTOCHAIN_BATCH_LIMIT`（預設 200）為上限；**手動排入且未指定 `limit` 的 `drug_enrichment` 不受此限**，會爬完整個待處理佇列。

## OCR 供應者 { #ocr-providers }

`drug_analysis` 把仿單 PDF 交給 OCR 取得 Markdown，再交給分析 LLM；分析 LLM 那一段與 OCR 供應者無關。
在「外部服務 → OCR」選擇：

| 供應者 | 執行位置 | 說明 |
|--------|----------|------|
| `mineru`（預設） | 外部 HTTP 服務（`POST {base_url}/file_parse`），通常在 GPU 機器上 | 複雜表格與版面最穩定。設定：Base URL、backend、effort、parse method、語言、逾時。 |
| `indra` | compose 內建的 `ocr-indra` 容器（`POST http://ocr-indra:8000/ocr`），只用 CPU | [Indra OCR](https://github.com/datalab-to/indra)（`indra-ocr` 0.3.2，ONNX Runtime，模型約 18 MB 已打包進映像，執行時不需連網）。數位 PDF 直接讀文字層，掃描頁才做影像辨識。設定：Indra Base URL、逾時、DPI（72–400）、模式（`auto` / `ocr` / `text`）。 |

- **備援供應者**（`fallback_provider`：`none` / `mineru` / `indra`）：主要供應者無法連線、HTTP 錯誤、逾時或輸出為空時改用備援重試一次；
  檔案本身無法讀取（加密、損毀、非 PDF）時不重試。`drug.insert_analysis.ocr_provider` 記錄實際產出 Markdown 的供應者。
- **服務健康**：設定了備援時兩者都會探測；只有一邊失敗為「受限」（不阻擋工作），兩邊都失敗才是「錯誤」。
- **測試連線**：Indra 除了 `/health` 還會辨識一次內建範例 PDF，確認真的能回傳 Markdown。
- **Indra 的限制**：繁體中文掃描頁偶有罕用字誤認；合併儲存格、沒有格線的欄位表可能錯欄。
- **Indra 模型授權**：程式碼 Apache-2.0，模型權重為**修改版 OpenRAIL-M**——前一年營收或累計募資超過 2,000 萬美元的單位
  （研究與個人用途除外），或提供與 Datalab 競爭之產品者不得使用，且限制延伸到 OCR 輸出。啟用前請閱讀
  `services/ocr-indra/README.md` 的授權一節。

## 技術架構
- **資料來源**：台灣 FDA 西藥許可證（`mcp.fda.gov.tw`），透過 `DRUG_TFDA_BASE_URL` 設定。
- **資料庫**：`drug` schema，含 `licenses`、`ingredients`、`atc`、`electronic_inserts`、`appearance_records`、`assets`、`asset_variants`、`insert_analysis`、`normalized_records` 等資料表，以及匯入狀態追蹤表（`import_runs`、`import_license_state`、`enrichment_queue` 等）。
- **物件儲存**：仿單 / 標籤 / 外觀圖檔案存於 MinIO，工具回傳時即時產生有時效的預簽連結。
- **搜尋方式**：藥品搜尋為關鍵字比對（`ILIKE` 子字串 + `simple` 全文檢索），**沒有**向量 / 語意搜尋，也沒有 `drug_embed` 工作。
- **管理介面**：管理後台 **資料 → 藥品** 顯示管線概況、上傳 `36_2.csv`、排程與觸發工作；**藥品瀏覽器**（`/admin/drug/explorer`）可檢視單張許可證的仿單、外觀、檔案、歷程與 LLM 呼叫紀錄。

## 依賴關係
- **FHIR Medication Service**：以本模組的藥品資料產生 FHIR Medication / MedicationKnowledge 資源。

## 關鍵限制
- 仿單 OCR + LLM 分析為機器產生，必須由臨床人員覆核。
- `drug_enrichment` 與 `drug_analysis` 需要可達的 TFDA / OCR（MinerU 或 ocr-indra）/ 分析 LLM 端點。
